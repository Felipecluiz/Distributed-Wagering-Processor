import { Money } from '../domain/money/money';
import { Wallet } from '../domain/wallet/wallet';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../domain/messaging/outbox-message';

export interface StoredWager { transaction: WagerTransaction; balanceObserved: Money }

export interface WalletRepository {
  /** SELECT ... FOR UPDATE. Deve ser o PRIMEIRO lock da transação. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Persiste saldo/version de uma wallet já travada. */
  save(wallet: Wallet): Promise<void>;
}

export interface WagerRepository {
  findByIdempotencyKey(providerId: string, key: string): Promise<StoredWager | undefined>;
  findByExternalId(providerId: string, externalId: string): Promise<StoredWager | undefined>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  isReversed(transactionId: string): Promise<boolean>;
  /** A transação nasce já no estado final decidido (append-only, sem UPDATE posterior). */
  insert(tx: WagerTransaction, balanceObserved: Money, nextReferenceAttemptAt?: Date): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. Se já existia, devolve o hash gravado. */
  tryReceive(p: { consumerName: string; messageId: string; payloadHash: string; at: Date }):
    Promise<{ created: true } | { created: false; payloadHash: string }>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
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

export interface Clock { now(): Date }
export interface IdGenerator { next(): string }