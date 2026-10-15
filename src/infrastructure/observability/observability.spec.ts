import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
} from '../../application/errors';
import type { ProcessWagerResult } from '../../application/process-wager-transaction';
import type { ProcessWager } from '../../application/wager-message-handler';
import { WagerTransactionStatus as S } from '../../domain/wager/wager-transaction';
import { AppMetrics } from './app-metrics';
import { InstrumentedProcessWager } from './instrumented-process-wager';
import { JsonLogger } from './json-logger';
import { CollectedGauge, Counter, Histogram, MetricsRegistry } from './metrics';

describe('MetricsRegistry (formato Prometheus)', () => {
  test('contador com labels, escapando aspas e quebras de linha', async () => {
    const registry = new MetricsRegistry();
    const c = registry.register(new Counter('x_total', 'ajuda', ['kind'] as const));
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' }, 2);
    c.inc({ kind: 'b"\n' });

    const text = await registry.render();
    expect(text).toContain('# TYPE x_total counter');
    expect(text).toContain('x_total{kind="a"} 3');
    expect(text).toContain('x_total{kind="b\\"\\n"} 1');
  });

  test('histograma é cumulativo, com +Inf, _sum e _count', async () => {
    const registry = new MetricsRegistry();
    const h = registry.register(new Histogram('lat_seconds', 'ajuda', [], [0.1, 1]));
    h.observe({}, 0.05);
    h.observe({}, 0.5);
    h.observe({}, 3);

    const text = await registry.render();
    expect(text).toContain('lat_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('lat_seconds_bucket{le="1"} 2');
    expect(text).toContain('lat_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('lat_seconds_sum 3.55');
    expect(text).toContain('lat_seconds_count 3');
  });

  test('gauge coletado que falha não derruba o /metrics', async () => {
    const registry = new MetricsRegistry();
    registry.register(new CollectedGauge('ok_gauge', 'ajuda', async () => 7));
    registry.register(new CollectedGauge('broken_gauge', 'ajuda', async () => { throw new Error('db down'); }));

    const text = await registry.render();
    expect(text).toContain('ok_gauge 7');
    expect(text).not.toMatch(/^broken_gauge \S+$/m); // cabeçalho sim, amostra não
  });
});

describe('JsonLogger', () => {
  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    return { lines, logger: new JsonLogger('log', (l) => lines.push(JSON.parse(l))) };
  };

  test('uma linha JSON com nível, contexto e campos de correlação', () => {
    const { lines, logger } = capture();
    logger.log({ msg: 'ok', correlationId: 'c1', walletId: 'w1', transactionId: 't1' }, 'Wagering');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', context: 'Wagering', msg: 'ok', correlationId: 'c1', walletId: 'w1', transactionId: 't1' });
    expect(typeof lines[0]!.time).toBe('string');
  });

  test('nunca registra valores monetários nem corpos de requisição', () => {
    const { lines, logger } = capture();
    logger.log({ msg: 'x', amount: '10.00', money: {}, balance: {}, balanceAfter: {}, payload: {}, body: {}, walletId: 'w1' });

    expect(Object.keys(lines[0]!).sort()).toEqual(['level', 'msg', 'time', 'walletId']);
  });

  test('error separa stack e contexto', () => {
    const { lines, logger } = capture();
    logger.error({ msg: 'falhou' }, 'Error: x\n    at f (a.ts:1:1)', 'Http');

    expect(lines[0]).toMatchObject({ level: 'error', context: 'Http', msg: 'falhou' });
    expect(String(lines[0]!.stack)).toContain('at f');
  });

  test('respeita o nível mínimo', () => {
    const lines: string[] = [];
    const logger = new JsonLogger('warn', (l) => lines.push(l));
    logger.log('ignorado');
    logger.debug('ignorado');
    logger.warn('registrado');
    expect(lines).toHaveLength(1);
  });
});

describe('InstrumentedProcessWager', () => {
  const result = (over: Partial<ProcessWagerResult> = {}): ProcessWagerResult => ({
    transactionId: 't1',
    status: S.Processed,
    balance: { amount: '90.00', currency: 'BRL' },
    idempotentReplay: false,
    ...over,
  });
  const cmd = {
    idempotencyKey: 'k', providerId: 'p', externalTransactionId: 'e', playerId: 'pl', walletId: 'w',
    roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '10.00', currency: 'BRL' },
  };
  const silent = new JsonLogger('fatal', () => {});
  const wrap = (inner: ProcessWager) => {
    const metrics = new AppMetrics();
    return { metrics, uc: new InstrumentedProcessWager(inner, metrics, silent) };
  };

  test('conta status por origem, replays como duplicatas e mede a latência', async () => {
    const outcomes = [result(), result({ idempotentReplay: true }), result({ status: S.Rejected })];
    const { metrics, uc } = wrap({ execute: async () => outcomes.shift()! });

    await uc.execute(cmd, { correlationId: 'c' });
    await uc.execute(cmd, { correlationId: 'c' });
    await uc.execute(cmd, { correlationId: 'c', inbox: { consumerName: 'q', messageId: 'm' } });

    expect(metrics.wagerTransactions.get({ source: 'http', status: 'PROCESSED', replay: 'false' })).toBe(1);
    expect(metrics.wagerTransactions.get({ source: 'http', status: 'PROCESSED', replay: 'true' })).toBe(1);
    expect(metrics.wagerTransactions.get({ source: 'sqs', status: 'REJECTED', replay: 'false' })).toBe(1);
    expect(metrics.duplicatesDetected.get({ source: 'http' })).toBe(1);
    expect(await metrics.registry.render()).toContain('wager_processing_duration_seconds_count{source="http"} 2');
  });

  test('falhas são contadas por código e o erro é repassado intacto', async () => {
    const errors = [
      new InvalidPayloadError('x'),
      new IdempotencyConflictError('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'x'),
      new TransientInfrastructureError(),
    ];
    const { metrics, uc } = wrap({ execute: async () => { throw errors.shift(); } });

    await expect(uc.execute(cmd, { correlationId: 'c' })).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(uc.execute(cmd, { correlationId: 'c' })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(uc.execute(cmd, { correlationId: 'c' })).rejects.toBeInstanceOf(TransientInfrastructureError);

    expect(metrics.wagerFailures.get({ source: 'http', code: 'INVALID_PAYLOAD' })).toBe(1);
    expect(metrics.wagerFailures.get({ source: 'http', code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' })).toBe(1);
    expect(metrics.wagerFailures.get({ source: 'http', code: 'TRANSIENT_FAILURE' })).toBe(1);
  });
});
