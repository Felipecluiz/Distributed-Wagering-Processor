import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { isolatedQueues, IsolatedQueues } from '../support/sqs';

/**
 * Reinício do serviço com prova de consistência final.
 *
 * Sobe a aplicação de verdade (bun src/main.ts) como processo filho, contra Postgres e
 * LocalStack reais, e mata o processo com SIGKILL no meio do trabalho: mensagens recebidas
 * e não confirmadas, requisições HTTP em voo e eventos reivindicados e não publicados.
 * Outra instância sobe e termina o serviço. No fim, nada pode ter sido perdido nem duplicado.
 */

const ROOT = `${import.meta.dir}/../../`;
const RUN = crypto.randomUUID().slice(0, 8);
const WALLETS = 8;
const SQS_BETS_PER_WALLET = 15;
const HTTP_BETS_PER_WALLET = 5;
const BET = '1.00';
const INITIAL = '100.00';

let sqs: IsolatedQueues;
const db = new Client({ connectionString: process.env.DATABASE_URL });
/** Todo processo da aplicação que o teste sobe. Morre no fim, mesmo se o teste falhar. */
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];

beforeAll(async () => {
  await db.connect();
  sqs = await isolatedQueues('restart', { visibilityTimeoutSeconds: 3, maxReceiveCount: 10 });
});
afterAll(async () => {
  // Sem isto, uma falha no meio deixaria a aplicação viva, disputando a outbox do banco de
  // testes com as próximas execuções.
  for (const p of spawned) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  await Promise.all(spawned.map((p) => p.exited));
  await sqs.destroy();
  await db.end();
});

// ───────────────────────── processo da aplicação ─────────────────────────

type App = { proc: ReturnType<typeof Bun.spawn>; base: string };
let nextPort = 39_000 + Math.floor(Math.random() * 1_000);

async function startApp(): Promise<App> {
  const port = nextPort++;
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: 'error',
      SQS_REQUESTS_QUEUE: sqs.names.requests,
      SQS_DLQ: sqs.names.deadLetter,
      SQS_EVENTS_QUEUE: sqs.names.events,
      SQS_CREATE_QUEUES: 'off',
      PENDING_REFERENCE_WORKER: 'off',
      OUTBOX_LEASE_MS: '2000',
      OUTBOX_POLL_MS: '20',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  spawned.push(proc);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${base}/health/ready`).catch(() => undefined))?.status === 200, 20_000, 'app ready');
  return { proc, base };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
}

// ───────────────────────── carga ─────────────────────────

type W = { id: string; playerId: string };

async function createWallet(app: App): Promise<W> {
  const res = await fetch(`${app.base}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: INITIAL, currency: 'BRL' } }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<W>;
}

const ext = (w: W, key: string) => `${RUN}:${w.id.slice(0, 8)}:${key}`;

function betBody(w: W, key: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId: ext(w, key),
    playerId: w.playerId,
    walletId: w.id,
    roundId: `${RUN}:round`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: BET, currency: 'BRL' },
  };
}

/** POST com a mesma Idempotency-Key; devolve undefined se a conexão caiu. */
async function httpBet(app: App, w: W, key: string) {
  try {
    const res = await fetch(`${app.base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `provider-a:${ext(w, key)}` },
      body: JSON.stringify(betBody(w, key)),
    });
    return { status: res.status, body: (await res.json()) as { transactionId: string; idempotentReplay: boolean } };
  } catch {
    return undefined;
  }
}

async function enqueueBets(wallets: W[]): Promise<string[]> {
  const messageIds: string[] = [];
  for (const w of wallets) {
    for (let i = 0; i < SQS_BETS_PER_WALLET; i++) {
      const key = `sqs-${i}`;
      const envelope = {
        messageId: `msg-${ext(w, key)}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...betBody(w, key), idempotencyKey: `provider-a:${ext(w, key)}` },
      };
      messageIds.push(envelope.messageId);
      // Cada mensagem vai duas vezes, com ids de deduplicação diferentes: redelivery garantido.
      await sqs.send(envelope, { groupId: w.id });
      await sqs.send(envelope, { groupId: w.id });
    }
  }
  return messageIds;
}

// ───────────────────────── leitura do estado ─────────────────────────

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return Number(rows[0].n);
}

const ourTransactions = () =>
  count(`select count(*) as n from wager_transactions where external_transaction_id like $1`, [`${RUN}:%`]);

const ourUnpublishedEvents = () =>
  count(
    `select count(*) as n
       from outbox_messages o
       join wager_transactions t on o.payload->>'causationId' = t.id::text
      where t.external_transaction_id like $1 and o.published_at is null`,
    [`${RUN}:%`],
  );

// ───────────────────────── teste ─────────────────────────

describe('reinício do serviço', () => {
  test('SIGKILL no meio do trabalho: outra instância termina, sem perda nem duplicidade', async () => {
    const total = WALLETS * (SQS_BETS_PER_WALLET + HTTP_BETS_PER_WALLET);

    // 1. Instância A recebe carga pela fila e por HTTP ao mesmo tempo.
    const a = await startApp();
    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => createWallet(a)));
    const messageIds = await enqueueBets(wallets);
    const httpCalls = wallets.flatMap((w) =>
      Array.from({ length: HTTP_BETS_PER_WALLET }, (_, i) => ({ w, key: `http-${i}` })),
    );
    const inFlight = httpCalls.map((c) => httpBet(a, c.w, c.key));

    // 2. Mata A sem aviso assim que parte do trabalho foi commitada.
    await waitFor(async () => (await ourTransactions()) >= 20, 20_000, 'first commits');
    a.proc.kill('SIGKILL');
    await a.proc.exited;
    const firstAttempt = await Promise.all(inFlight);

    // 3. Instância B sobe. O cliente HTTP reenvia o que não teve resposta, com a mesma key.
    const b = await startApp();
    const finalHttp = await Promise.all(
      httpCalls.map(async (c, i) => firstAttempt[i] ?? (await httpBet(b, c.w, c.key))),
    );
    expect(finalHttp.every((r) => r?.status === 200)).toBe(true);

    // Reenviar algo que A já tinha confirmado é replay em B: idempotência sobrevive ao reinício.
    const confirmedByA = httpCalls.findIndex((_, i) => firstAttempt[i]?.status === 200);
    if (confirmedByA >= 0) {
      const again = await httpBet(b, httpCalls[confirmedByA]!.w, httpCalls[confirmedByA]!.key);
      expect(again?.body.idempotentReplay).toBe(true);
      expect(again?.body.transactionId).toBe(firstAttempt[confirmedByA]!.body.transactionId);
    }

    // 4. B escoa a fila (inclusive o que A recebeu e não confirmou) e publica a outbox.
    await waitFor(async () => (await ourTransactions()) === total, 60_000, 'all transactions');
    await waitFor(async () => (await ourUnpublishedEvents()) === 0, 60_000, 'outbox drained');

    // 5. Consistência final.
    expect(await ourTransactions()).toBe(total);
    expect(
      await count(`select count(*) as n from inbox_messages where message_id = any($1)`, [messageIds]),
    ).toBe(messageIds.length);

    for (const w of wallets) {
      const { rows } = await db.query(
        `select w.balance::text as balance, w.version,
                coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger,
                count(l.id) filter (where l.direction = 'DEBIT')::int as debits,
                count(l.id)::int as entries
           from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
          where w.id = $1 group by w.id`,
        [w.id],
      );
      const r = rows[0];
      expect(r.debits).toBe(SQS_BETS_PER_WALLET + HTTP_BETS_PER_WALLET); // nenhum débito perdido ou duplicado
      expect(r.balance).toBe('80.00');
      expect(r.balance).toBe(r.ledger); // invariante: saldo == ledger
      expect(r.version).toBe(r.entries);
    }

    // Cada evento das nossas transações chegou ao broker (pelo menos uma vez; o id deduplica).
    const { rows: events } = await db.query(
      `select o.id::text as id
         from outbox_messages o
         join wager_transactions t on o.payload->>'causationId' = t.id::text
        where t.external_transaction_id like $1`,
      [`${RUN}:%`],
    );
    // A fila de eventos é desta suíte, mas recebe também eventos antigos que ainda estavam
    // pendentes no banco de testes: lê tudo e filtra os nossos.
    const delivered = new Set((await sqs.drain('events', 5_000)).map((m) => JSON.parse(m.body).eventId as string));
    expect(events.filter((e) => !delivered.has(e.id))).toEqual([]);
    expect(await sqs.drain('deadLetter')).toHaveLength(0);

    // 6. Encerramento de B por SIGTERM: termina o que está em andamento e sai sozinho, sem travar.
    b.proc.kill('SIGTERM');
    const exited = await Promise.race([b.proc.exited.then(() => true), Bun.sleep(25_000).then(() => false)]);
    if (!exited) b.proc.kill('SIGKILL');
    expect(exited).toBe(true);
  }, 180_000);
});
