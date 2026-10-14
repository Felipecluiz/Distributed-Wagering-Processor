import { Money } from '../money/money';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { FailureCode, InvalidTransactionError, InvalidTransactionStateError } from '../shared/errors';

export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}
export enum WagerTransactionStatus {
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED',
}

export const INTERNAL_PROVIDER = 'internal';

export interface CreateWagerTransactionProps {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  payloadHash: string; walletId: string; playerId: string; roundId: string; gameId: string;
  kind: WagerTransactionKind; money: Money; referenceExternalTransactionId?: string;
  createdAt: Date; allowInternal?: boolean; // true somente para OPENING criado pelo sistema
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'allowInternal'> {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(p: CreateWagerTransactionProps): WagerTransaction {
    if (p.kind === WagerTransactionKind.Opening && !p.allowInternal) {
      throw new InvalidTransactionError('OPENING is internal and cannot be submitted');
    }
    if (p.providerId === INTERNAL_PROVIDER && !p.allowInternal) {
      throw new InvalidTransactionError('provider "internal" is reserved');
    }
    const needsRef = p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
    if (needsRef && !p.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${p.kind} requires referenceExternalTransactionId`);
    }
    if (!needsRef && p.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${p.kind} must not carry a reference`);
    }
    if (p.money.isNegative()) throw new InvalidTransactionError('amount cannot be negative');
    return WagerTransaction.build({ ...p, status: WagerTransactionStatus.Pending });
  }

  /** Reconstrói estado persistido, sem revalidar transições. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return WagerTransaction.build(s);
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }

  // PENDING -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
  // PENDING_REFERENCE -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]
      .includes(this._status);
  }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }

  /** Direção do lançamento. Em ROLLBACK, é o inverso da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet: return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening: return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionError('ROLLBACK needs the reference to define direction');
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      default: throw new InvalidTransactionError(`${this.kind} has no ledger direction`);
    }
  }

  private assertNotTerminal(op: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${op} on terminal transaction ${this.id} (${this._status})`);
    }
  }

  private static build(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(s.id, s.providerId, s.externalTransactionId, s.idempotencyKey,
      s.payloadHash, s.walletId, s.playerId, s.roundId, s.gameId, s.kind, s.money,
      s.referenceExternalTransactionId, s.createdAt, s.status,
      s.referenceTransactionId, s.failureCode, s.processedAt);
  }
}