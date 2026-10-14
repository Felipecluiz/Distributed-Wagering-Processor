export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
/** Erro de programação: transição em estado terminal ou inválida. */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super("INVALID_TRANSACTION_STATE", message);
  }
}
export class InvalidTransactionError extends DomainError {
  constructor(message: string) {
    super("INVALID_TRANSACTION", message);
  }
}
/** Violação de regra de negócio, vira REJECTED com failureCode. */
export class BusinessRuleError extends DomainError {
  constructor(
    public readonly failureCode: FailureCode,
    message: string,
  ) {
    super(failureCode, message);
  }
}
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  AlreadyReversed = "ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  InternalError = "INTERNAL_ERROR",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH", // playerId do payload ≠ dono da wallet
}
