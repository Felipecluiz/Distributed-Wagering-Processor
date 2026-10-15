import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { CreateWalletUseCase } from '../../src/application/create-wallet';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidGenerator } from '../../src/infrastructure/system';
import { WagerTransactionStatus as S } from '../../src/domain/wager/wager-transaction';
import { FailureCode as F } from '../../src/domain/shared/errors';

let orm: MikroORM;
let processUC: ProcessWagerTransactionUseCase;
let createUC: CreateWalletUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  const uow = new MikroOrmUnitOfWork(orm);
  processUC = new ProcessWagerTransactionUseCase(uow, systemClock, uuidGenerator);
  createUC = new CreateWalletUseCase(uow, systemClock, uuidGenerator);
});
afterAll(() => orm.close(true));

// ───────────────────────── helpers ─────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);

type W = { id: string; playerId: string };

const newWallet = (initial: string): Promise<W> =>
  createUC.execute({ playerId: crypto.randomUUID(), initialBalance: { amount: initial, currency: 'BRL' } });

interface Op {
  key: string;
  kind: string;
  amount: string;
  round?: string;
  ref?: string;
  currency?: string;
  playerId?: string;
}

/** Keys únicas por execução e por wallet: a suíte pode rodar várias vezes sem recriar o banco. */
const scoped = (w: W, key: string) => `${RUN}:${w.id.slice(0, 8)}:${key}`;

function submit(w: W, op: Op) {
  const id = scoped(w, op.key);
  return processUC.execute(
    {
      idempotencyKey: id,
      providerId: 'provider-a',
      externalTransactionId: id,
      playerId: op.playerId ?? w.playerId,
      walletId: w.id,
      roundId: scoped(w, op.round ?? 'round-1'),
      gameId: 'fortune-chimp',
      kind: op.kind,
      money: { amount: op.amount, currency: op.currency ?? 'BRL' },
      referenceExternalTransactionId: op.ref ? scoped(w, op.ref) : undefined,
    },
    { correlationId: id },
  );
}

const sql = (q: string, p: unknown[] = []): Promise<any[]> => orm.em.getConnection().execute(q, p);

/** Ledger da wallet em ordem de versão, no formato "DIREÇÃO valor". */
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

/**
 * Invariante final: wallet.balance == saldo reconstruído pelo ledger.
 * Como todas as wallets daqui abrem com saldo > 0, version == número de lançamentos.
 */
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

// ───────────────────────── testes ─────────────────────────

describe('regras de negócio (Postgres real)', () => {
  test('WIN credita e gera um lançamento CREDIT', async () => {
    const w = await newWallet('100.00');
    const r = await submit(w, { key: 'win', kind: 'WIN', amount: '50.00' });

    expect(r.status).toBe(S.Processed);
    expect(r.balance.amount).toBe('150.00');
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'CREDIT 50.00']);
    expect(await expectConsistent(w.id)).toBe('150.00');
  });

  test('LOSS é PROCESSED sem mover saldo, sem lançamento e sem WalletBalanceChanged', async () => {
    const w = await newWallet('100.00');
    await submit(w, { key: 'bet', kind: 'BET', amount: '20.00' });
    const r = await submit(w, { key: 'loss', kind: 'LOSS', amount: '0.00' });

    expect(r.status).toBe(S.Processed);
    expect(r.balance.amount).toBe('80.00');
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'DEBIT 20.00']);
    expect(await eventsFor(r.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await expectConsistent(w.id)).toBe('80.00');
  });

  test('REFUND de BET PROCESSED devolve o valor', async () => {
    const w = await newWallet('100.00');
    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    const r = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet' });

    expect(r.status).toBe(S.Processed);
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'DEBIT 30.00', 'CREDIT 30.00']);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('referência é revertida uma única vez: 2º REFUND e ROLLBACK após REFUND são ALREADY_REVERSED', async () => {
    const w = await newWallet('100.00');
    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    await submit(w, { key: 'refund-1', kind: 'REFUND', amount: '30.00', ref: 'bet' });
    const again = await submit(w, { key: 'refund-2', kind: 'REFUND', amount: '30.00', ref: 'bet' });
    const rollback = await submit(w, { key: 'rollback', kind: 'ROLLBACK', amount: '30.00', ref: 'bet' });

    expect([again.status, again.failureCode]).toEqual([S.Rejected, F.AlreadyReversed]);
    expect([rollback.status, rollback.failureCode]).toEqual([S.Rejected, F.AlreadyReversed]);
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'DEBIT 30.00', 'CREDIT 30.00']);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('ROLLBACK inverte a referência: de BET credita, de WIN debita', async () => {
    const w = await newWallet('100.00');
    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    const rbBet = await submit(w, { key: 'rb-bet', kind: 'ROLLBACK', amount: '30.00', ref: 'bet' });
    await submit(w, { key: 'win', kind: 'WIN', amount: '50.00', round: 'round-2' });
    const rbWin = await submit(w, { key: 'rb-win', kind: 'ROLLBACK', amount: '50.00', ref: 'win', round: 'round-2' });

    expect(rbBet.status).toBe(S.Processed);
    expect(rbWin.status).toBe(S.Processed);
    expect(await ledger(w.id)).toEqual([
      'CREDIT 100.00', 'DEBIT 30.00', 'CREDIT 30.00', 'CREDIT 50.00', 'DEBIT 50.00',
    ]);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('ROLLBACK de REFUND debita de novo', async () => {
    const w = await newWallet('100.00');
    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet' });
    const r = await submit(w, { key: 'rb-refund', kind: 'ROLLBACK', amount: '30.00', ref: 'refund' });

    expect(r.status).toBe(S.Processed);
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00', 'DEBIT 30.00', 'CREDIT 30.00', 'DEBIT 30.00']);
    expect(await expectConsistent(w.id)).toBe('70.00');
  });

  test('REFUND só referencia BET: REFUND de WIN é INVALID_REFERENCE_KIND', async () => {
    const w = await newWallet('100.00');
    await submit(w, { key: 'win', kind: 'WIN', amount: '50.00' });
    const r = await submit(w, { key: 'refund', kind: 'REFUND', amount: '50.00', ref: 'win' });

    expect([r.status, r.failureCode]).toEqual([S.Rejected, F.InvalidReferenceKind]);
    expect(await expectConsistent(w.id)).toBe('150.00');
  });

  test('valor da reversão diferente da referência é AMOUNT_MISMATCH', async () => {
    const w = await newWallet('100.00');
    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    const r = await submit(w, { key: 'refund', kind: 'REFUND', amount: '29.99', ref: 'bet' });

    expect([r.status, r.failureCode]).toEqual([S.Rejected, F.AmountMismatch]);
    expect(await expectConsistent(w.id)).toBe('70.00');
  });

  test('referência de outra rodada é REFERENCE_MISMATCH', async () => {
    const w = await newWallet('100.00');
    await submit(w, { key: 'bet', kind: 'BET', amount: '30.00', round: 'round-1' });
    const r = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet', round: 'round-2' });

    expect([r.status, r.failureCode]).toEqual([S.Rejected, F.ReferenceMismatch]);
    expect(await expectConsistent(w.id)).toBe('70.00');
  });

  test('referência REJECTED é REFERENCE_NOT_PROCESSED', async () => {
    const w = await newWallet('10.00');
    const bet = await submit(w, { key: 'bet', kind: 'BET', amount: '50.00' });
    const r = await submit(w, { key: 'refund', kind: 'REFUND', amount: '50.00', ref: 'bet' });

    expect(bet.status).toBe(S.Rejected);
    expect([r.status, r.failureCode]).toEqual([S.Rejected, F.ReferenceNotProcessed]);
    expect(await expectConsistent(w.id)).toBe('10.00');
  });

  test('reversão sem saldo é REVERSAL_WOULD_OVERDRAW, distinto de INSUFFICIENT_FUNDS', async () => {
    const w = await newWallet('10.00');
    await submit(w, { key: 'win', kind: 'WIN', amount: '50.00' });          // 60.00
    await submit(w, { key: 'bet', kind: 'BET', amount: '60.00' });          // 0.00
    const rb = await submit(w, { key: 'rb-win', kind: 'ROLLBACK', amount: '50.00', ref: 'win' });
    const bet = await submit(w, { key: 'bet-2', kind: 'BET', amount: '1.00' });

    expect([rb.status, rb.failureCode]).toEqual([S.Rejected, F.ReversalWouldOverdraw]);
    expect([bet.status, bet.failureCode]).toEqual([S.Rejected, F.InsufficientFunds]);
    expect(await ledger(w.id)).toEqual(['CREDIT 10.00', 'CREDIT 50.00', 'DEBIT 60.00']);
    expect(await expectConsistent(w.id)).toBe('0.00');
  });

  test('REFUND antes da BET fica PENDING_REFERENCE, sem lançamento e com retry agendado', async () => {
    const w = await newWallet('100.00');
    const r = await submit(w, { key: 'refund', kind: 'REFUND', amount: '30.00', ref: 'bet-que-ainda-nao-chegou' });

    expect(r.status).toBe(S.PendingReference);
    expect(r.balance.amount).toBe('100.00');
    const [row] = await sql(
      `select status, next_reference_attempt_at from wager_transactions where id = ?`, [r.transactionId],
    );
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.next_reference_attempt_at).not.toBeNull();
    expect(await eventsFor(r.transactionId)).toEqual(['WagerTransactionPendingReference']);
    expect(await ledger(w.id)).toEqual(['CREDIT 100.00']);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('replay de REJECTED devolve o resultado original com o saldo observado naquele momento', async () => {
    const w = await newWallet('10.00');
    const first = await submit(w, { key: 'bet', kind: 'BET', amount: '50.00' }); // rejeitada com 10.00
    await submit(w, { key: 'win', kind: 'WIN', amount: '100.00' });              // saldo vai a 110.00
    const replay = await submit(w, { key: 'bet', kind: 'BET', amount: '50.00' });

    expect(first.status).toBe(S.Rejected);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance.amount).toBe('10.00');
    expect(await expectConsistent(w.id)).toBe('110.00');
  });

  test('moeda da operação diferente da wallet é CURRENCY_MISMATCH', async () => {
    const w = await newWallet('100.00');
    const r = await submit(w, { key: 'bet', kind: 'BET', amount: '10.00', currency: 'USD' });

    expect([r.status, r.failureCode]).toEqual([S.Rejected, F.CurrencyMismatch]);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });

  test('playerId diferente do dono da wallet é PLAYER_WALLET_MISMATCH', async () => {
    const w = await newWallet('100.00');
    const r = await submit(w, { key: 'bet', kind: 'BET', amount: '10.00', playerId: crypto.randomUUID() });

    expect([r.status, r.failureCode]).toEqual([S.Rejected, F.PlayerWalletMismatch]);
    expect(await expectConsistent(w.id)).toBe('100.00');
  });
});
