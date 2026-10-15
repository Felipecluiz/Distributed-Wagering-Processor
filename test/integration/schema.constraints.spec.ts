import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/wagering";
const client = new Client({ connectionString });
const other = new Client({ connectionString }); // segunda conexão para as races
const observer = new Client({ connectionString }); // só observa o pg_stat_activity
const uuid = () => crypto.randomUUID();
const HASH = "a".repeat(64);

beforeAll(async () => {
  await client.connect();
  await other.connect();
  await observer.connect();
});
afterAll(async () => {
  await client.end();
  await other.end();
  await observer.end();
});
async function insertTx(
  c: Client,
  p: {
    walletId: string;
    playerId: string;
    kind: string;
    provider: string;
    amount: string;
    observed: string;
  },
): Promise<string> {
  const id = uuid();
  const ext = `ext-${id}`;
  await c.query(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, status, processed_at, balance_observed)
     values ($1, $2, $3, $3, $4, $5, $6, 'round-1', 'game-1', $7, $8, 'BRL', 'PROCESSED', now(), $9)`,
    [
      id,
      p.provider,
      ext,
      HASH,
      p.walletId,
      p.playerId,
      p.kind,
      p.amount,
      p.observed,
    ],
  );
  return id;
}

/** Wallet com OPENING + lançamento CREDIT versão 1, já commitada. */
async function seedWallet(balance = "100.00") {
  const walletId = uuid();
  const playerId = uuid();
  await client.query("begin");
  await client.query(
    `insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', $3)`,
    [walletId, playerId, balance],
  );
  const openingId = await insertTx(client, {
    walletId,
    playerId,
    kind: "OPENING",
    provider: "internal",
    amount: balance,
    observed: balance,
  });
  await client.query(
    `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version)
     values ($1, $2, $3, 'CREDIT', $4, 'BRL', 0, $4, 1)`,
    [uuid(), walletId, openingId, balance],
  );
  await client.query("commit");
  return { walletId, playerId };
}

const debitV2 = (c: Client, walletId: string, txId: string) =>
  c.query(
    `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version)
   values ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, 2)`,
    [uuid(), walletId, txId],
  );
/** Espera até o backend estar parado esperando um lock (prova de que a race aconteceu). */
async function waitUntilBlocked(pid: number) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await observer.query(
      `select wait_event_type from pg_stat_activity where pid = $1`,
      [pid],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await Bun.sleep(20);
  }
  throw new Error(`backend ${pid} nunca bloqueou em lock`);
}
describe("constraints do schema", () => {
  test("saldo negativo é barrado pelo CHECK", async () => {
    await expect(
      client.query(
        `insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', -1.00)`,
        [uuid(), uuid()],
      ),
    ).rejects.toThrow(/wallets_balance_non_negative/);
  });

  test("wallet duplicada por player+moeda é barrada", async () => {
    const player = uuid();
    await client.query(
      `insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', 0)`,
      [uuid(), player],
    );
    await expect(
      client.query(
        `insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', 0)`,
        [uuid(), player],
      ),
    ).rejects.toThrow(/wallets_player_currency_uq/);
  });

  test("wallet com saldo sem ledger falha no COMMIT (saldo != ledger)", async () => {
    await client.query("begin");
    await client.query(
      `insert into wallets (id, player_id, currency, balance) values ($1, $2, 'BRL', 10.00)`,
      [uuid(), uuid()],
    );
    await expect(client.query("commit")).rejects.toThrow(
      /diverges from ledger/,
    );
    await client.query("rollback").catch(() => {});
  });
  test("fork do ledger: duas conexões sem lock gravando a mesma versão → unique_violation", async () => {
    const { walletId, playerId } = await seedWallet("100.00");
    const bet = {
      walletId,
      playerId,
      kind: "BET",
      provider: "provider-a",
      amount: "10.00",
      observed: "90.00",
    };
    const txA = await insertTx(client, bet);
    const txB = await insertTx(client, bet);

    // A grava a versão 2 e atualiza a wallet, mas ainda não commitou
    await client.query("begin");
    await debitV2(client, walletId, txA);
    await client.query(
      `update wallets set balance = 90.00, version = 2 where id = $1`,
      [walletId],
    );

    // B lê o mesmo "anterior" (versão 1), passa no chain check e bloqueia no índice único
    const {
      rows: [{ pid }],
    } = await other.query("select pg_backend_pid() as pid");
    await other.query("begin");
    const forkAttempt = debitV2(other, walletId, txB);
    forkAttempt.catch(() => {}); // evita "unhandled rejection" enquanto esperamos

    await waitUntilBlocked(pid); // garante que B está esperando A antes do commit
    await client.query("commit");
    await expect(forkAttempt).rejects.toThrow(/wle_wallet_version_uq/);
    await other.query("rollback");

    const { rows } = await client.query(
      `select count(*)::int as n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`,
      [walletId],
    );
    expect(rows[0].n).toBe(1);
  });
  test("buraco na versão do ledger é barrado pelo encadeamento", async () => {
    const { walletId, playerId } = await seedWallet("100.00");
    const txId = await insertTx(client, {
      walletId,
      playerId,
      kind: "BET",
      provider: "provider-a",
      amount: "10.00",
      observed: "90.00",
    });
    await expect(
      client.query(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version)
       values ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, 3)`,
        [uuid(), walletId, txId],
      ),
    ).rejects.toThrow(/expected version 2/);
  });
});
