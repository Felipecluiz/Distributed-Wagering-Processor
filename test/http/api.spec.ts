import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { loadConfig } from '../../src/config';
import { createApp } from '../../src/http/app';

// A aplicação Nest de verdade, numa porta aleatória, contra o Postgres real.
// Workers (PENDING_REFERENCE, consumer SQS e publisher) ficam desligados: o teste é determinístico.

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await createApp(loadConfig({
      ...process.env,
      PENDING_REFERENCE_WORKER: 'off',
      SQS_CONSUMER: 'off',
      OUTBOX_PUBLISHER: 'off',
      SQS_CREATE_QUEUES: 'off',
    }), { logger: false });
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
});

// ───────────────────────── helpers ─────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

type W = { id: string; playerId: string };

async function newWallet(amount = '100.00'): Promise<W> {
  const r = await call('POST', '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(r.status).toBe(201);
  return r.body;
}

interface Op { key: string; kind: string; amount: string; ref?: string }

function wager(w: W, op: Op, overrides: Record<string, unknown> = {}) {
  const ext = `${RUN}:${w.id.slice(0, 8)}:${op.key}`;
  const ref = op.ref ? `${RUN}:${w.id.slice(0, 8)}:${op.ref}` : undefined;
  return call(
    'POST',
    '/wagering/transactions',
    {
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.id,
      roundId: `${RUN}:round-1`,
      gameId: 'fortune-chimp',
      kind: op.kind,
      money: { amount: op.amount, currency: 'BRL' },
      ...(ref ? { referenceExternalTransactionId: ref } : {}),
      ...overrides,
    },
    { 'Idempotency-Key': `provider-a:${ext}` },
  );
}

// ───────────────────────── wallets ─────────────────────────

describe('POST /wallets', () => {
  test('201 com saldo inicial e version 1', async () => {
    const playerId = crypto.randomUUID();
    const r = await call('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });

    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
  });

  test('duplicada para o mesmo player e moeda é 409 WALLET_ALREADY_EXISTS', async () => {
    const playerId = crypto.randomUUID();
    const body = { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } };
    await call('POST', '/wallets', body);
    const r = await call('POST', '/wallets', body);

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('valor fora da escala fixa é 400', async () => {
    const r = await call('POST', '/wallets', {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '10.5', currency: 'BRL' },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PAYLOAD');
  });
});

// ───────────────────────── transações ─────────────────────────

describe('POST /wagering/transactions: cada situação tem seu status', () => {
  test('sem Idempotency-Key é 400', async () => {
    const w = await newWallet();
    const r = await call('POST', '/wagering/transactions', {
      providerId: 'provider-a', externalTransactionId: `${RUN}:no-key`, playerId: w.playerId, walletId: w.id,
      roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
    });
    expect(r.status).toBe(400);
  });

  test('processada é 200; replay idêntico também é 200, com idempotentReplay', async () => {
    const w = await newWallet();
    const first = await wager(w, { key: 'bet', kind: 'BET', amount: '25.00' });
    const replay = await wager(w, { key: 'bet', kind: 'BET', amount: '25.00' });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' }, idempotentReplay: false });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('mesma key com payload diferente é 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', async () => {
    const w = await newWallet();
    await wager(w, { key: 'bet', kind: 'BET', amount: '25.00' });
    const r = await wager(w, { key: 'bet', kind: 'BET', amount: '26.00' });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
  });

  test('rejeição de negócio é 422 com failureCode; o replay continua 422', async () => {
    const w = await newWallet('10.00');
    const first = await wager(w, { key: 'bet', kind: 'BET', amount: '50.00' });
    const replay = await wager(w, { key: 'bet', kind: 'BET', amount: '50.00' });

    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('referência ausente é 202 PENDING_REFERENCE', async () => {
    const w = await newWallet();
    const r = await wager(w, { key: 'refund', kind: 'REFUND', amount: '10.00', ref: 'bet-que-nao-chegou' });

    expect(r.status).toBe(202);
    expect(r.body.status).toBe('PENDING_REFERENCE');
  });

  test('wallet inexistente é 422 WALLET_NOT_FOUND', async () => {
    const ghost = { id: crypto.randomUUID(), playerId: crypto.randomUUID() };
    const r = await wager(ghost, { key: 'bet', kind: 'BET', amount: '1.00' });

    expect(r.status).toBe(422);
    expect(r.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('OPENING não pode ser submetido', async () => {
    const w = await newWallet();
    const r = await wager(w, { key: 'open', kind: 'OPENING', amount: '1.00' });
    expect(r.status).toBe(400);
  });

  test('correlationId do chamador volta na resposta', async () => {
    const r = await call('GET', '/health/live', undefined, { 'x-correlation-id': 'corr-123' });
    expect(r.headers.get('x-correlation-id')).toBe('corr-123');
  });
});

// ───────────────────────── consultas ─────────────────────────

describe('consultas', () => {
  test('GET /wallets/:id: 200, 404 para inexistente e 400 para id malformado', async () => {
    const w = await newWallet('42.00');
    const ok = await call('GET', `/wallets/${w.id}`);
    const missing = await call('GET', `/wallets/${crypto.randomUUID()}`);
    const malformed = await call('GET', '/wallets/nao-e-uuid');

    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: w.id, balance: { amount: '42.00', currency: 'BRL' }, version: 1 });
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(400);
  });

  test('ledger paginado por cursor: sem repetir, sem pular, mais recente primeiro', async () => {
    const w = await newWallet('100.00');
    for (let i = 0; i < 5; i++) await wager(w, { key: `bet-${i}`, kind: 'BET', amount: '1.00' });

    const versions: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const q = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const r = await call('GET', `/wallets/${w.id}/ledger${q}`);
      expect(r.status).toBe(200);
      versions.push(...r.body.items.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);

    expect(versions).toEqual([6, 5, 4, 3, 2, 1]); // OPENING + 5 BETs
    expect(pages).toBe(3);
  });

  test('ledger com cursor ou limit inválido é 400', async () => {
    const w = await newWallet();
    expect((await call('GET', `/wallets/${w.id}/ledger?cursor=lixo!`)).status).toBe(400);
    expect((await call('GET', `/wallets/${w.id}/ledger?limit=0`)).status).toBe(400);
    expect((await call('GET', `/wallets/${w.id}/ledger?limit=1000`)).status).toBe(400);
  });

  test('transação por id interno e por (provider, id externo)', async () => {
    const w = await newWallet();
    const sent = await wager(w, { key: 'bet', kind: 'BET', amount: '5.00' });
    const ext = `${RUN}:${w.id.slice(0, 8)}:bet`;

    const byId = await call('GET', `/wagering/transactions/${sent.body.transactionId}`);
    const byExternal = await call('GET', `/providers/provider-a/wagering/transactions/${encodeURIComponent(ext)}`);
    const missing = await call('GET', `/providers/provider-a/wagering/transactions/nao-existe-${RUN}`);

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: sent.body.transactionId,
      externalTransactionId: ext,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '5.00', currency: 'BRL' },
      balanceObserved: { amount: '95.00', currency: 'BRL' },
    });
    expect(byExternal.body).toEqual(byId.body);
    expect(missing.status).toBe(404);
  });

  test('reconciliação de uma wallet movimentada é consistente', async () => {
    const w = await newWallet('100.00');
    await wager(w, { key: 'bet', kind: 'BET', amount: '30.00' });
    await wager(w, { key: 'win', kind: 'WIN', amount: '5.00' });

    const r = await call('POST', `/wallets/${w.id}/reconciliation`);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      walletId: w.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });
});

describe('health', () => {
  test('live responde sem tocar dependências', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
  });

  test('ready reporta cada dependência e só é 200 se todas estão de pé', async () => {
    const ready = await call('GET', '/health/ready');
    expect(ready.body.checks.postgres).toBe('up');
    const allUp = Object.values(ready.body.checks).every((s) => s === 'up');
    expect(ready.status).toBe(allUp ? 200 : 503);
  });
});

describe('métricas', () => {
  test('GET /metrics expõe as métricas do processamento em formato Prometheus', async () => {
    const w = await newWallet();
    await wager(w, { key: 'bet', kind: 'BET', amount: '1.00' });
    await wager(w, { key: 'bet', kind: 'BET', amount: '1.00' }); // replay

    const res = await fetch(`${base}/metrics`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(text).toMatch(/^wager_transactions_total\{source="http",status="PROCESSED",replay="false"\} \d+$/m);
    expect(text).toMatch(/^wager_duplicates_detected_total\{source="http"\} \d+$/m);
    expect(text).toMatch(/^wager_processing_duration_seconds_count\{source="http"\} \d+$/m);
    expect(text).toMatch(/^http_requests_total\{method="POST",route="\/wagering\/transactions",status="200"\} \d+$/m);
    expect(text).toMatch(/^outbox_pending_events \d+$/m);
    expect(text).toMatch(/^outbox_oldest_pending_age_seconds [\d.]+$/m);
  });
});
