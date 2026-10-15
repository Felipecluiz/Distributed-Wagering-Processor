import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { CreateWalletUseCase } from '../../src/application/create-wallet';
import { TransientInfrastructureError } from '../../src/application/errors';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { MessageOutcome, ProcessWager, WagerMessageHandler } from '../../src/application/wager-message-handler';
import { WagerQueueConsumer } from '../../src/application/wager-queue-consumer';
import { SqsWagerRequestQueue } from '../../src/infrastructure/messaging/sqs';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidGenerator } from '../../src/infrastructure/system';
import { isolatedQueues, IsolatedQueues } from '../support/sqs';

// PostgreSQL e LocalStack reais. Cada suíte usa filas próprias, criadas e apagadas aqui.

let orm: MikroORM;
let processUC: ProcessWagerTransactionUseCase;
let createUC: CreateWalletUseCase;
let sqs: IsolatedQueues;
let queue: SqsWagerRequestQueue;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  const uow = new MikroOrmUnitOfWork(orm);
  processUC = new ProcessWagerTransactionUseCase(uow, systemClock, uuidGenerator);
  createUC = new CreateWalletUseCase(uow, systemClock, uuidGenerator);
  sqs = await isolatedQueues('consumer');
  queue = new SqsWagerRequestQueue(sqs.client, sqs.names);
});
afterAll(async () => {
  await sqs.destroy();
  await orm.close(true);
});

// ───────────────────────── helpers ─────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);
type W = { id: string; playerId: string };

const newWallet = (amount = '100.00'): Promise<W> =>
  createUC.execute({ playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });

function envelope(w: W, op: { key: string; kind?: string; amount?: string; messageId?: string; walletId?: string }) {
  const ext = `${RUN}:${w.id.slice(0, 8)}:${op.key}`;
  return {
    messageId: op.messageId ?? `msg-${ext}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId: w.playerId,
      walletId: op.walletId ?? w.id,
      roundId: `${RUN}:round-1`,
      gameId: 'fortune-chimp',
      kind: op.kind ?? 'BET',
      money: { amount: op.amount ?? '10.00', currency: 'BRL' },
    },
  };
}

function consumerWith(processWager: ProcessWager = processUC, opts: { maxAttempts?: number } = {}) {
  const outcomes: MessageOutcome[] = [];
  const handler = new WagerMessageHandler(processWager, {
    maxAttempts: opts.maxAttempts ?? 5,
    baseDelaySeconds: 1,
    maxDelaySeconds: 1,
  });
  const consumer = new WagerQueueConsumer(
    queue,
    handler,
    { batchSize: 10, waitSeconds: 1, idleBackoffMs: 100 },
    { onOutcome: (_, o) => outcomes.push(o) },
  );
  return { consumer, handler, outcomes };
}

/** Consome até a fila parecer vazia. */
async function drain(consumer: WagerQueueConsumer) {
  while ((await consumer.pollOnce(1)) > 0) {}
}

const sql = (q: string, p: unknown[] = []): Promise<any[]> => orm.em.getConnection().execute(q, p);

async function debits(walletId: string): Promise<number> {
  const [r] = await sql(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);
  return r.n;
}

async function txStatus(externalId: string): Promise<string | undefined> {
  const [r] = await sql(`select status from wager_transactions where provider_id = 'provider-a' and external_transaction_id = ?`, [externalId]);
  return r?.status;
}

async function expectConsistent(walletId: string): Promise<string> {
  const [r] = await sql(
    `select w.balance::text as balance,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  expect(r.balance).toBe(r.ledger);
  return r.balance;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── testes ─────────────────────────

describe('consumer SQS (LocalStack + Postgres reais)', () => {
  test('processa, grava o inbox e faz ack', async () => {
    const w = await newWallet();
    const env = envelope(w, { key: 'bet' });
    await sqs.send(env, { groupId: w.id });

    const { consumer, outcomes } = consumerWith();
    await drain(consumer);

    expect(outcomes).toEqual([{ action: 'ack', status: 'PROCESSED' }]);
    expect(await txStatus(env.data.externalTransactionId)).toBe('PROCESSED');
    const [inbox] = await sql(`select count(*)::int as n from inbox_messages where message_id = ?`, [env.messageId]);
    expect(inbox.n).toBe(1);
    expect(await sqs.drain('requests')).toHaveLength(0);
    expect(await expectConsistent(w.id)).toBe('90.00');
  });

  test('redelivery da mesma mensagem não duplica o débito', async () => {
    const w = await newWallet();
    const env = envelope(w, { key: 'bet' });
    // Duas entregas do mesmo envelope (dedup do broker contornado de propósito).
    await sqs.send(env, { groupId: w.id });
    await sqs.send(env, { groupId: w.id });

    const { consumer, outcomes } = consumerWith();
    await drain(consumer);

    expect(outcomes).toEqual([
      { action: 'ack', status: 'PROCESSED' },
      { action: 'ack', status: 'PROCESSED' },
    ]);
    expect(await debits(w.id)).toBe(1);
    expect(await expectConsistent(w.id)).toBe('90.00');
  });

  test('worker morto depois do commit e antes do ack: a reentrega não repete o efeito', async () => {
    const w = await newWallet();
    await sqs.send(envelope(w, { key: 'bet' }), { groupId: w.id });
    const { consumer, handler } = consumerWith();

    // Instância A: recebe, commita e "morre" sem ack.
    const [m] = await queue.receive({ max: 1, waitSeconds: 1 });
    expect(await handler.handle(m!)).toEqual({ action: 'ack', status: 'PROCESSED' });
    await queue.release(m!); // equivalente à visibilidade expirar

    // Instância B: recebe de novo; o inbox devolve o resultado gravado.
    await drain(consumer);

    expect(await debits(w.id)).toBe(1);
    expect(await sqs.drain('requests')).toHaveLength(0);
    expect(await expectConsistent(w.id)).toBe('90.00');
  });

  test('rejeição de negócio é terminal: ack, sem DLQ', async () => {
    const w = await newWallet('5.00');
    const env = envelope(w, { key: 'bet', amount: '50.00' });
    await sqs.send(env, { groupId: w.id });

    const { consumer, outcomes } = consumerWith();
    await drain(consumer);

    expect(outcomes).toEqual([{ action: 'ack', status: 'REJECTED' }]);
    expect(await txStatus(env.data.externalTransactionId)).toBe('REJECTED');
    expect(await expectConsistent(w.id)).toBe('5.00');
  });

  test('erros permanentes vão direto para a DLQ, com o motivo', async () => {
    const w = await newWallet();
    const invalid = envelope(w, { key: 'invalid', amount: '10.5' });
    const ghost = envelope(w, { key: 'ghost', walletId: crypto.randomUUID() });
    await sqs.send(invalid, { groupId: w.id });
    await sqs.send(ghost, { groupId: crypto.randomUUID() });
    await sqs.send({ not: 'an envelope' }, { groupId: crypto.randomUUID() });

    const { consumer } = consumerWith();
    await drain(consumer);

    const dead = await sqs.drain('deadLetter');
    const reasons = dead.map((d) => d.attributes.reason!.split(':')[0]).sort();
    expect(reasons).toEqual(['INVALID_MESSAGE', 'INVALID_PAYLOAD', 'WALLET_NOT_FOUND']);
    expect(await sqs.drain('requests')).toHaveLength(0);
    expect(await txStatus(invalid.data.externalTransactionId)).toBeUndefined();
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('falha transitória volta para a fila com backoff e é processada na entrega seguinte', async () => {
    const w = await newWallet();
    await sqs.send(envelope(w, { key: 'bet' }), { groupId: w.id });
    let calls = 0;
    const flaky: ProcessWager = {
      execute: (cmd, ctx) => {
        calls++;
        if (calls === 1) return Promise.reject(new TransientInfrastructureError());
        return processUC.execute(cmd, ctx);
      },
    };
    const { consumer, outcomes } = consumerWith(flaky);

    await consumer.pollOnce(1);
    expect(outcomes).toEqual([{ action: 'retry', delaySeconds: 1, reason: 'TRANSIENT_FAILURE' }]);

    await sleep(1_500); // backoff de visibilidade
    await drain(consumer);

    expect(outcomes.at(-1)).toEqual({ action: 'ack', status: 'PROCESSED' });
    expect(await debits(w.id)).toBe(1);
    expect(await expectConsistent(w.id)).toBe('90.00');
  });

  test('retry esgotado vai para a DLQ com MAX_ATTEMPTS_EXCEEDED', async () => {
    const w = await newWallet();
    await sqs.send(envelope(w, { key: 'bet' }), { groupId: w.id });
    const broken: ProcessWager = { execute: () => Promise.reject(new TransientInfrastructureError()) };
    const { consumer, outcomes } = consumerWith(broken, { maxAttempts: 2 });

    await consumer.pollOnce(1);
    await sleep(1_500);
    await drain(consumer);

    expect(outcomes.map((o) => o.action)).toEqual(['retry', 'dead-letter']);
    const [dead] = await sqs.drain('deadLetter');
    expect(dead!.attributes.reason).toStartWith('MAX_ATTEMPTS_EXCEEDED');
    expect(await debits(w.id)).toBe(0);
  });

  test('stop() interrompe o long polling na hora (SIGTERM)', async () => {
    const consumer = new WagerQueueConsumer(queue, new WagerMessageHandler(processUC), {
      batchSize: 10,
      waitSeconds: 20,
      idleBackoffMs: 100,
    });
    consumer.start();
    await sleep(300); // já está esperando no long polling

    const started = Date.now();
    await consumer.stop();

    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
