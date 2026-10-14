import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';

const client = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wagering' });
const uuid = () => crypto.randomUUID();

beforeAll(() => client.connect());
afterAll(() => client.end());

describe('constraints do schema', () => {
  test('saldo negativo é barrado pelo CHECK', async () => {
    await expect(
      client.query(`insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', -1.00)`, [uuid(), uuid()]),
    ).rejects.toThrow(/wallets_balance_non_negative/);
  });

  test('wallet duplicada por player+moeda é barrada', async () => {
    const player = uuid();
    await client.query(`insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', 0)`, [uuid(), player]);
    await expect(
      client.query(`insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', 0)`, [uuid(), player]),
    ).rejects.toThrow(/wallets_player_currency_uq/);
  });

  test('wallet com saldo sem ledger falha no COMMIT (saldo != ledger)', async () => {
    await client.query('begin');
    await client.query(`insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', 10.00)`, [uuid(), uuid()]);
    await expect(client.query('commit')).rejects.toThrow(/diverges from ledger/);
    await client.query('rollback').catch(() => {});
  });
});