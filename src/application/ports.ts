import { Money } from "../domain/money/money";
import { Wallet } from "../domain/wallet/wallet";
import { WagerTransaction } from "../domain/wager/wager-transaction";
import { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../domain/messaging/outbox-message";

export interface StoredWager {
  transaction: WagerTransaction;
  balanceObserved: Money;
}

/** Pendente reivindicada pelo worker (com lease). */
export interface PendingReferenceClaim {
  id: string;
  walletId: string;
  /** reference_attempts no momento da reivindicação: detecta se outro worker já mexeu nela. */
  attempts: number;
}

export interface LockedPendingWager extends StoredWager {
  attempts: number;
}

export interface WalletRepository {
  /** SELECT ... FOR UPDATE. Deve ser o PRIMEIRO lock da transação. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Persiste saldo/version de uma wallet já travada. */
  save(wallet: Wallet): Promise<void>;
  /** Insere uma wallet nova (usado só na criação). */
  insert(wallet: Wallet): Promise<void>;
}

export interface WagerRepository {
  findByIdempotencyKey(
    providerId: string,
    key: string,
  ): Promise<StoredWager | undefined>;
  findByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<StoredWager | undefined>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  isReversed(transactionId: string): Promise<boolean>;
  /** A transação nasce já no estado final decidido (append-only, sem UPDATE posterior). */
  insert(
    tx: WagerTransaction,
    balanceObserved: Money,
    nextReferenceAttemptAt?: Date,
  ): Promise<void>;

  // ───── worker de PENDING_REFERENCE ─────
  /**
   * Reivindica até `limit` pendentes vencidas, empurrando o próximo horário para `leaseUntil`.
   * FOR UPDATE SKIP LOCKED: instâncias concorrentes nunca reivindicam a mesma linha.
   */
  claimDuePendingReferences(
    limit: number,
    now: Date,
    leaseUntil: Date,
  ): Promise<PendingReferenceClaim[]>;
  /** SELECT ... FOR UPDATE da transação. Chamar só depois de travar a wallet. */
  lockPendingById(id: string): Promise<LockedPendingWager | undefined>;
  /** Grava o novo estado da pendente (resolvida, rejeitada ou reagendada). */
  saveResolution(
    tx: WagerTransaction,
    balanceObserved: Money,
    attempts: number,
    nextAttemptAt?: Date,
  ): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. Se já existia, devolve o hash gravado. */
  tryReceive(p: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
    at: Date;
  }): Promise<{ created: true } | { created: false; payloadHash: string }>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;

  // ───── publisher ─────
  /**
   * Reivindica até `limit` eventos pendentes e vencidos, empurrando o próximo horário para
   * `leaseUntil`. FOR UPDATE SKIP LOCKED: publishers concorrentes nunca pegam o mesmo evento.
   */
  claimDue(limit: number, now: Date, leaseUntil: Date): Promise<OutboxMessage[]>;
  markPublished(ids: string[], at: Date): Promise<void>;
  /** Grava attempts/nextAttemptAt (já calculados por scheduleRetry) e o último erro. */
  saveRetry(message: OutboxMessage, error: string): Promise<void>;
}

export interface TxContext {
  wallets: WalletRepository;
  wagers: WagerRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/** Fronteira transacional: tudo dentro de `run` é um único COMMIT, ou nada. */
export interface UnitOfWork {
  run<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  next(): string;
}
