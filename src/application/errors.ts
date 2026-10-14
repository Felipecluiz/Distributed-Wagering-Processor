export class InvalidPayloadError extends Error {          // HTTP 400
  constructor(message: string) { super(message); this.name = 'InvalidPayloadError'; }
}
export class IdempotencyConflictError extends Error {     // HTTP 409
  constructor(public readonly code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' | 'EXTERNAL_ID_REUSED', message: string) {
    super(message); this.name = 'IdempotencyConflictError';
  }
}
/** Wallet inexistente: não dá para persistir (FK), então é devolvida sem registro. HTTP 422 / ack na fila. */
export class WalletNotFoundError extends Error {
  readonly failureCode = 'WALLET_NOT_FOUND';
  constructor(walletId: string) { super(`wallet ${walletId} not found`); this.name = 'WalletNotFoundError'; }
}
/** Violação de unicidade por corrida entre instâncias: o use case refaz a operação (agora cai no replay). */
export class ConcurrentInsertError extends Error {
  constructor(cause?: unknown) { super('concurrent insert'); this.name = 'ConcurrentInsertError'; this.cause = cause; }
}
/** Deadlock, lock timeout, conexão caída: HTTP 503 + Retry-After; na fila, retry com backoff. */
export class TransientInfrastructureError extends Error {
  constructor(cause?: unknown) { super('transient infrastructure failure'); this.name = 'TransientInfrastructureError'; this.cause = cause; }
}