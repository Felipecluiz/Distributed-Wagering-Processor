import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { CreateWalletUseCase } from '../../src/application/create-wallet';
import { EventBus, OutboundEvent } from '../../src/application/messaging';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { OutboxRunStats, PublishOutboxUseCase } from '../../src/application/publish-outbox';
import { SqsEventBus } from '../../src/infrastructure/messaging/sqs';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidGenerator } from '../../src/infrastructure/system';
import { isolatedQueues, IsolatedQueues } from '../support/sqs';

// PostgreSQL e LocalStack reais. O relógio do publisher é controlável para testar o lease.

// Relógio real deslocado: os eventos nascem com o horário real e o publisher enxerga o "futuro".
const SEC = 1_000;
let offset = 0;
const clock = { now: () => new Date(Date.now() + offset) };
const advance = (ms: number) => {
  offset += ms;
};

let ormA: MikroORM;
let ormB: MikroORM;
let uowA: MikroOrmUnitOfWork;
let uowB: MikroOrmUnitOfWork;
let processUC: ProcessWagerTransactionUseCase;
let createUC: CreateWalletUseCase;
let sqs: IsolatedQueues;
let bus: SqsEventBus;

beforeAll(async () => {
  ormA = await MikroORM.init(config);
  ormB = await MikroORM.init(config);
  uowA = new MikroOrmUnitOfWork(ormA);
  uowB = new MikroOrmUnitOfWork(ormB);
  processUC = new ProcessWagerTransactionUseCase(uowA, systemClock, uuidGenerator);
  createUC = new CreateWalletUseCase(uowA, systemClock, uuidGenerator);
  sqs = await isolatedQueues('publisher');
  bus = new SqsEventBus(sqs.client, sqs.names.events);
});
afterAll(async () => {
  await sqs.destroy();
  await ormA.close(true);
  await ormB.close(true);
});

// ───────────────────────── helpers ─────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);

/** Registra cada evento enviado ao broker, para provar que nenhum foi enviado duas vezes. */
class RecordingBus implements EventBus {
  readonly sent: string[] = [];
  constructor(private readonly inner: EventBus, private failNext = 0) {}
  async publish(events: OutboundEvent[]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker indisponível');
    }
    this.sent.push(...events.map((e) => e.eventId));
    return this.inner.publish(events);
  }
}

/** Cria uma wallet e uma BET: gera 2 eventos (Processed + BalanceChanged) na outbox. */
async function betEvents(): Promise<string[]> {
  const w = await createUC.execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
  const ext = `${RUN}:${w.id.slice(0, 8)}:bet`;
  const r = await processUC.execute(
    {
      idempotencyKey: `provider-a:${ext}`, providerId: 'provider-a', externalTransactionId: ext,
      playerId: w.playerId, walletId: w.id, roundId: 'r1', gameId: 'g1', kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
    { correlationId: ext },
  );
  const rows = await sql(`select id from outbox_messages where payload::text like ?`, [`%${r.transactionId}%`]);
  return rows.map((x) => x.id as string);
}

const sql = (q: string, p: unknown[] = []): Promise<any[]> => ormA.em.getConnection().execute(q, p);

async function outboxRow(id: string) {
  const [r] = await sql(`select published_at, attempts, next_attempt_at, last_error from outbox_messages where id = ?`, [id]);
  return r as { published_at: Date | null; attempts: number; next_attempt_at: Date; last_error: string | null };
}

/**
 * Publica até não sobrar nada vencido. O banco é compartilhado: pode haver eventos antigos de
 * outras suítes, então as asserções olham só os eventos criados aqui.
 */
async function drain(publisher: PublishOutboxUseCase): Promise<OutboxRunStats> {
  const total = { claimed: 0, published: 0, failed: 0 };
  for (;;) {
    const s = await publisher.runOnce();
    total.claimed += s.claimed;
    total.published += s.published;
    total.failed += s.failed;
    if (s.claimed === 0) return total;
  }
}

// ───────────────────────── testes ─────────────────────────

describe('publisher da outbox (LocalStack + Postgres reais)', () => {
  test('publica os eventos commitados, com eventId como deduplicação, e marca como publicados', async () => {
    const ids = await betEvents();
    expect(ids).toHaveLength(2);

    await drain(new PublishOutboxUseCase(uowA, bus, clock, { batchSize: 100 }));

    for (const id of ids) expect((await outboxRow(id)).published_at).not.toBeNull();
    const published = (await sqs.drain('events')).map((m) => JSON.parse(m.body));
    const ours = published.filter((e) => ids.includes(e.eventId));
    expect(ours.map((e) => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(ours.every((e) => typeof e.correlationId === 'string' && e.version === 1)).toBe(true);
  });

  test('dois publishers concorrentes: nenhum evento é enviado duas vezes', async () => {
    const ids = (await Promise.all(Array.from({ length: 15 }, () => betEvents()))).flat();
    const a = new RecordingBus(bus);
    const b = new RecordingBus(bus);

    await Promise.all([
      drain(new PublishOutboxUseCase(uowA, a, clock, { batchSize: 5 })),
      drain(new PublishOutboxUseCase(uowB, b, clock, { batchSize: 5 })),
    ]);

    const sent = [...a.sent, ...b.sent].filter((id) => ids.includes(id));
    expect(sent).toHaveLength(ids.length); // cada um exatamente uma vez
    expect(new Set(sent).size).toBe(ids.length);
    for (const id of ids) expect((await outboxRow(id)).published_at).not.toBeNull();
  });

  test('publisher morre depois de reivindicar: o lease expira e outra instância publica', async () => {
    const ids = await betEvents();
    const now = clock.now();
    // Instância A reivindica tudo o que está vencido e "morre" antes de publicar.
    await uowA.run((c) => c.outbox.claimDue(1_000, now, new Date(now.getTime() + 30 * SEC)));

    const b = new RecordingBus(bus);
    const publisherB = new PublishOutboxUseCase(uowB, b, clock, { batchSize: 100 });
    await drain(publisherB);
    expect(b.sent.filter((id) => ids.includes(id))).toHaveLength(0); // ainda sob o lease de A

    advance(31 * SEC);
    await drain(publisherB);
    expect(b.sent.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await outboxRow(id)).published_at).not.toBeNull();
  });

  test('falha no broker: retry com backoff e last_error; publica quando o broker volta', async () => {
    advance(60 * SEC); // tudo o que sobrou de antes já está vencido e é escoado aqui
    await drain(new PublishOutboxUseCase(uowA, bus, clock, { batchSize: 100 }));

    const ids = await betEvents();
    const flaky = new RecordingBus(bus, 1);
    const publisher = new PublishOutboxUseCase(uowA, flaky, clock, { batchSize: 100 });

    await publisher.runOnce(); // broker fora
    for (const id of ids) {
      const row = await outboxRow(id);
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('broker indisponível');
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(clock.now().getTime());
    }

    advance(5 * SEC); // > backoff da 1ª tentativa (1s + jitter)
    await drain(publisher);
    for (const id of ids) expect((await outboxRow(id)).published_at).not.toBeNull();
  });
});
