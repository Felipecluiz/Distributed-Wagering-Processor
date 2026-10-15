import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { CreateWalletUseCase } from '../../src/application/create-wallet';
import { IdempotencyConflictError } from '../../src/application/errors';
import {
  ProcessWagerCommand, ProcessWagerTransactionUseCase,
} from '../../src/application/process-wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidGenerator } from '../../src/infrastructure/system';

interface Instance { orm: MikroORM; process: ProcessWagerTransactionUseCase; create: CreateWalletUseCase }
const INSTANCES = 3;
const instances: Instance[] = [];

beforeAll(async () => {
  for (let i = 0; i < INSTANCES; i++) {
    const orm = await MikroORM.init({ ...config, pool: { min: 2, max: 20 } });
    const uow = new MikroOrmUnitOfWork(orm);
    instances.push({
      orm,
      process: new ProcessWagerTransactionUseCase(uow, systemClock, uuidGenerator),
      create: new CreateWalletUseCase(uow, systemClock, uuidGenerator),
    });
  }
});
afterAll(async () => { await Promise.all(instances.map((i) => i.orm.close(true))); });

const pick = (n: number) => instances[n % INSTANCES]!;
const money = (amount: string) => ({ amount, currency: 'BRL' });

async function newWallet(initial: string) {
  return pick(0).create.execute({ playerId: crypto.randomUUID(), initialBalance: money(initial) });
}

function betCmd(w: { id: string; playerId: string }, key: string, amount: string): ProcessWagerCommand {
  return {
    idempotencyKey: key, providerId: 'provider-a', externalTransactionId: key,
    playerId: w.playerId, walletId: w.id, roundId: `round-${key}`, gameId: 'fortune-chimp',
    kind: 'BET', money: money(amount),
  };
}

const rows = async (sql: string, params: unknown[]): Promise<any[]> =>
  instances[0]!.orm.em.getConnection().execute(sql, params);

async function debitCount(walletId: string): Promise<number> {
  const r = await rows(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);
  return r[0].n;
}

/** Invariante final: wallet.balance == saldo reconstruído pelo ledger. */
async function expectLedgerConsistent(walletId: string): Promise<string> {
  const r = await rows(
    `select w.balance::text as balance,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.balance`, [walletId]);
  expect(r[0].balance).toBe(r[0].ledger);
  return r[0].balance;
}

describe('concorrência real (Postgres), 3 instâncias', () => {
  test('cenário obrigatório: 100.00 e duas BETs de 80.00 simultâneas', async () => {
    const w = await newWallet('100.00');
    const results = await Promise.all([
      pick(0).process.execute(betCmd(w, 'bet-a', '80.00'), { correlationId: 'c1' }),
      pick(1).process.execute(betCmd(w, 'bet-b', '80.00'), { correlationId: 'c2' }),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')!.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await debitCount(w.id)).toBe(1);
    expect(await expectLedgerConsistent(w.id)).toBe('20.00');
  });

  test('a mesma BET enviada 50 vezes em paralelo gera um único débito', async () => {
    const w = await newWallet('1000.00');
    const cmd = betCmd(w, 'same-bet', '80.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => pick(i).process.execute(cmd, { correlationId: `c${i}` })),
    );

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
    expect(await debitCount(w.id)).toBe(1);
    expect(await expectLedgerConsistent(w.id)).toBe('920.00');
  });

  test('hot wallet: 30 BETs distintas de 10.00 sobre 100.00 → 10 processadas, 20 rejeitadas', async () => {
    const w = await newWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => pick(i).process.execute(betCmd(w, `hot-${i}`, '10.00'), { correlationId: `h${i}` })),
    );

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(20);
    expect(await debitCount(w.id)).toBe(10);
    expect(await expectLedgerConsistent(w.id)).toBe('0.00');
  });

  test('wallets distintas em paralelo não interferem entre si', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));
    await Promise.all(
      wallets.flatMap((w, wi) => [0, 1].map((n) =>
        pick(wi + n).process.execute(betCmd(w, `multi-${wi}-${n}`, '30.00'), { correlationId: `m${wi}${n}` }))),
    );
    for (const w of wallets) {
      expect(await debitCount(w.id)).toBe(2);
      expect(await expectLedgerConsistent(w.id)).toBe('40.00');
    }
  });

  test('mesma Idempotency-Key com payload diferente é conflito, não replay', async () => {
    const w = await newWallet('100.00');
    await pick(0).process.execute(betCmd(w, 'k1', '10.00'), { correlationId: 'x' });
    await expect(
      pick(1).process.execute(betCmd(w, 'k1', '11.00'), { correlationId: 'y' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await debitCount(w.id)).toBe(1);
    expect(await expectLedgerConsistent(w.id)).toBe('90.00');
  });

  test('criar wallet duplicada (mesmo player e moeda) falha como conflito', async () => {
    const playerId = crypto.randomUUID();
    await pick(0).create.execute({ playerId, initialBalance: money('10.00') });
    await expect(
      pick(1).create.execute({ playerId, initialBalance: money('10.00') }),
    ).rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
  });
});