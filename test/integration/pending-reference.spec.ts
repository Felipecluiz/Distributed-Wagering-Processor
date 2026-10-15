import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { CreateWalletUseCase } from '../../src/application/create-wallet';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import {
  PendingReferenceRunStats,
  ResolvePendingReferencesUseCase,
} from '../../src/application/resolve-pending-references';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { uuidGenerator } from '../../src/infrastructure/system';
import { WagerTransactionStatus as S } from '../../src/domain/wager/wager-transaction';

// ───────────────────────── relógio controlável ─────────────────────────
// O worker e o use case recebem o Clock por porta: o teste avança o tempo sem sleep.

const SEC = 1_000;
const MIN = 60 * SEC;
let current = new Date();
const clock = { now: () => new Date(current.getTime()) };
const advance = (ms: number) => {
  current = new Date(current.getTime() + ms);
};

// ───────────────────────── duas instâncias ─────────────────────────

let ormA: MikroORM;
let ormB: MikroORM;
let uowA: MikroOrmUnitOfWork;
let processUC: ProcessWagerTransactionUseCase;
let createUC: CreateWalletUseCase;
let workerA: ResolvePendingReferencesUseCase;
let workerB: ResolvePendingReferencesUseCase;

beforeAll(async () => {
  ormA = await MikroORM.init(config);
  ormB = await MikroORM.init(config);
  uowA = new MikroOrmUnitOfWork(ormA);
  const uowB = new MikroOrmUnitOfWork(ormB);
  processUC = new ProcessWagerTransactionUseCase(uowA, clock, uuidGenerator);
  createUC = new CreateWalletUseCase(uowA, clock, uuidGenerator);
  workerA = new ResolvePendingReferencesUseCase(uowA, clock, uuidGenerator);
  workerB = new ResolvePendingReferencesUseCase(uowB, clock, uuidGenerator);
});
afterAll(async () => {
  await ormA.close(true);
  await ormB.close(true);
});

// ───────────────────────── helpers ─────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);

type W = { id: string; playerId: string };

const newWallet = (initial: string): Promise<W> =>
  createUC.execute({ playerId: crypto.randomUUID(), initialBalance: { amount: initial, currency: 'BRL' } });

interface Op { key: string; kind: string; amount: string; ref?: string }

const scoped = (w: W, key: string) => `${RUN}:${w.id.slice(0, 8)}:${key}`;

function submit(w: W, op: Op) {
  const id = scoped(w, op.key);
  return processUC.execute(
    {
      idempotencyKey: id,
      providerId: 'provider-a',
      externalTransactionId: id,
      playerId: w.playerId,
      walletId: w.id,
      roundId: scoped(w, 'round-1'),
      gameId: 'fortune-chimp',
      kind: op.kind,
      money: { amount: op.amount, currency: 'BRL' },
      referenceExternalTransactionId: op.ref ? scoped(w, op.ref) : undefined,
    },
    { correlationId: id },
  );
}

const sql = (q: string, p: unknown[] = []): Promise<any[]> => ormA.em.getConnection().execute(q, p);

async function txRow(id: string) {
  const [r] = await sql(
    `select status, failure_code, reference_attempts, balance_observed::text as balance_observed
       from wager_transactions where id = ?`,
    [id],
  );
  return r as { status: string; failure_code: string | null; reference_attempts: number; balance_observed: string };
}

async function ledger(walletId: string): Promise<string[]> {
  const rows = await sql(
    `select direction, amount::text as amount
       from wallet_ledger_entries where wallet_id = ? order by wallet_version`,
    [walletId],
  );
  return rows.map((r) => `${r.direction} ${r.amount}`);
}

async function eventsFor(transactionId: string): Promise<string[]> {
  const rows = await sql(`select event_type from outbox_messages where payload::text like ?`, [`%${transactionId}%`]);
  return rows.map((r) => r.event_type as string).sort();
}

async function expectConsistent(walletId: string): Promise<string> {
  const [r] = await sql(
    `select w.balance::text as balance, w.version,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger,
            count(l.id)::int as entries
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  expect(r.balance).toBe(r.ledger);
  expect(r.version).toBe(r.entries);
  return r.balance;
}

/**
 * Roda o worker até não sobrar nada vencido. O banco é compartilhado com outras suítes,
 * então pode haver pendentes antigas: as asserções olham só as linhas deste teste.
 */
async function drain(worker: ResolvePendingReferencesUseCase): Promise<PendingReferenceRunStats> {
  const total: PendingReferenceRunStats = { claimed: 0, processed: 0, rejected: 0, rescheduled: 0, skipped: 0, errors: 0 };
  for (;;) {
    const s = await worker.runOnce();
    for (const k of Object.keys(total) as (keyof PendingReferenceRunStats)[]) total[k] += s[k];
    if (s.claimed === 0) return total;
  }
}

// ───────────────────────── testes ─────────────────────────

describe('worker de PENDING_REFERENCE (Postgres real)', () => {
  test('REFUND antes da BET: a BET chega e o worker credita uma única vez', async () => {
    const w = await newWallet('100.00');
    const refund = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet' });
    expect(refund.status).toBe(S.PendingReference);

    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    advance(6 * SEC); // primeira tentativa vence 5s após a criação
    const stats = await drain(workerA);

    expect(stats.errors).toBe(0);
    const row = await txRow(refund.transactionId);
    expect(row.status).toBe('PROCESSED');
    expect(row.balance_observed).toBe('100.00');
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'DEBIT 30.00', 'CREDIT 30.00']);
    expect(await eventsFor(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);

    // Replay depois da resolução devolve o estado resolvido, sem efeito novo.
    const replay = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet' });
    expect(replay).toMatchObject({
      transactionId: refund.transactionId,
      status: S.Processed,
      idempotentReplay: true,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('ROLLBACK antes do WIN: o WIN chega e o worker debita', async () => {
    const w = await newWallet('100.00');
    const rollback = await submit(w, { key: 'rb', kind: 'ROLLBACK', amount: '50.00', ref: 'win' });
    expect(rollback.status).toBe(S.PendingReference);

    await submit(w, { key: 'win', kind: 'WIN', amount: '50.00' });
    advance(6 * SEC);
    expect((await drain(workerA)).errors).toBe(0);

    expect((await txRow(rollback.transactionId)).status).toBe('PROCESSED');
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'CREDIT 50.00', 'DEBIT 50.00']);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('pendente que ainda não venceu não é tocada', async () => {
    const w = await newWallet('100.00');
    const refund = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet' });
    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });

    await drain(workerA); // sem avançar o relógio: o primeiro retry é só daqui a 5s

    const row = await txRow(refund.transactionId);
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.reference_attempts).toBe(0);
    expect(await expectConsistent(w.id)).toBe('70.00');
  });

  test('referência que nunca chega: backoff a cada tentativa e REJECTED ao esgotar o limite', async () => {
    const limited = new ResolvePendingReferencesUseCase(uowA, clock, uuidGenerator, {
      maxAttempts: 3,
      ttlMs: 24 * 60 * MIN, // isola o limite de tentativas do TTL
    });
    const w = await newWallet('100.00');
    const refund = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'nunca-chega' });

    for (const expected of [1, 2]) {
      advance(7 * MIN); // maior que o backoff máximo (5 min + 20% de jitter)
      await drain(limited);
      const row = await txRow(refund.transactionId);
      expect(row.status).toBe('PENDING_REFERENCE');
      expect(row.reference_attempts).toBe(expected);
    }

    advance(7 * MIN);
    await drain(limited);
    const row = await txRow(refund.transactionId);
    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(row.reference_attempts).toBe(3);
    expect(await eventsFor(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference', 'WagerTransactionRejected',
    ]);
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00']);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('referência que nunca chega: REJECTED ao passar do TTL', async () => {
    const w = await newWallet('100.00');
    const refund = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'nunca-chega' });

    advance(16 * MIN); // TTL padrão: 15 min
    await drain(workerA);

    const row = await txRow(refund.transactionId);
    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('worker morre depois de reivindicar: o lease expira e outra instância resolve', async () => {
    const w = await newWallet('100.00');
    const refund = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet' });
    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    advance(6 * SEC);

    // A instância A reivindica e "morre" antes de resolver.
    const now = clock.now();
    await uowA.run((c) => c.wagers.claimDuePendingReferences(1_000, now, new Date(now.getTime() + 30 * SEC)));

    await drain(workerB);
    expect((await txRow(refund.transactionId)).status).toBe('PENDING_REFERENCE'); // ainda sob o lease de A

    advance(31 * SEC);
    expect((await drain(workerB)).errors).toBe(0);
    expect((await txRow(refund.transactionId)).status).toBe('PROCESSED');
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'DEBIT 30.00', 'CREDIT 30.00']);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('dois workers concorrentes: cada pendente é resolvida exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => newWallet('100.00')));
    const refunds: string[] = [];
    for (const w of wallets) {
      refunds.push((await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet' })).transactionId);
      await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    }
    advance(6 * SEC);

    const [a, b] = await Promise.all([drain(workerA), drain(workerB)]);

    expect(a.errors + b.errors).toBe(0);
    for (const [i, w] of wallets.entries()) {
      expect((await txRow(refunds[i]!)).status).toBe('PROCESSED');
      expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'DEBIT 30.00', 'CREDIT 30.00']);
      expect(await expectConsistent(w.id)).toBe('100.00');
    }
  });
});
