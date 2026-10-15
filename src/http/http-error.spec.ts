import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ConcurrentInsertError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../application/errors';
import { ResourceNotFoundError } from '../application/queries';
import { toHttpError } from './http-error';

// Cada situação que o provedor precisa distinguir tem um status próprio e um code estável.
const cases: Array<{ name: string; error: () => unknown; status: number; code: string }> = [
  { name: 'payload inválido', error: () => new InvalidPayloadError('x'), status: 400, code: 'INVALID_PAYLOAD' },
  { name: 'JSON malformado (Nest)', error: () => new BadRequestException(), status: 400, code: 'INVALID_PAYLOAD' },
  { name: 'recurso inexistente', error: () => new ResourceNotFoundError('wallet', 'w1'), status: 404, code: 'NOT_FOUND' },
  { name: 'rota inexistente (Nest)', error: () => new NotFoundException(), status: 404, code: 'NOT_FOUND' },
  {
    name: 'mesma key, payload diferente',
    error: () => new IdempotencyConflictError('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'x'),
    status: 409,
    code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
  },
  {
    name: 'id externo reutilizado',
    error: () => new IdempotencyConflictError('EXTERNAL_ID_REUSED', 'x'),
    status: 409,
    code: 'EXTERNAL_ID_REUSED',
  },
  { name: 'wallet duplicada', error: () => new WalletAlreadyExistsError('p1', 'BRL'), status: 409, code: 'WALLET_ALREADY_EXISTS' },
  { name: 'wallet inexistente na submissão', error: () => new WalletNotFoundError('w1'), status: 422, code: 'WALLET_NOT_FOUND' },
  { name: 'erro inesperado', error: () => new Error('bug'), status: 500, code: 'INTERNAL_ERROR' },
];

describe('mapeamento de erros para HTTP', () => {
  for (const c of cases) {
    test(`${c.name} → ${c.status} ${c.code}`, () => {
      const r = toHttpError(c.error());
      expect(r.status).toBe(c.status);
      expect(r.body.code).toBe(c.code);
      expect(r.retryAfter).toBeUndefined();
    });
  }

  test('falha transitória → 503 TRANSIENT_FAILURE com Retry-After', () => {
    for (const e of [new TransientInfrastructureError(), new ConcurrentInsertError()]) {
      const r = toHttpError(e);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('TRANSIENT_FAILURE');
      expect(r.retryAfter).toBeGreaterThan(0);
    }
  });

  test('500 não vaza a mensagem interna', () => {
    expect(toHttpError(new Error('detalhe interno da falha')).body.message).toBe('internal error');
  });
});
