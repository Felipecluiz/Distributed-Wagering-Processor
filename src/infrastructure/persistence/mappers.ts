import { Money } from '../../domain/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import { FailureCode } from '../../domain/shared/errors';
import { WalletEntity, WagerTransactionEntity } from './entities';

export const walletToDomain = (e: WalletEntity): Wallet =>
  Wallet.rehydrate({
    id: e.id, playerId: e.playerId, currency: e.currency,
    balance: Money.fromPersisted(e.balance, e.currency),
    version: e.version, createdAt: e.createdAt, updatedAt: e.updatedAt,
  });

/** Copia o estado do agregado para a entidade gerenciada (o UoW gera o UPDATE). */
export const applyWallet = (e: WalletEntity, w: Wallet): void => {
  e.balance = w.balance.toString();
  e.version = w.version;
  e.updatedAt = w.updatedAt;
};

export const wagerToDomain = (e: WagerTransactionEntity): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: e.id, providerId: e.providerId, externalTransactionId: e.externalTransactionId,
    idempotencyKey: e.idempotencyKey, payloadHash: e.payloadHash.trim(),
    walletId: e.walletId, playerId: e.playerId, roundId: e.roundId, gameId: e.gameId,
    kind: e.kind as WagerTransactionKind, money: Money.fromPersisted(e.amount, e.currency),
    referenceExternalTransactionId: e.referenceExternalTransactionId ?? undefined,
    createdAt: e.createdAt, status: e.status as WagerTransactionStatus,
    referenceTransactionId: e.referenceTransactionId ?? undefined,
    failureCode: (e.failureCode as FailureCode | null) ?? undefined,
    processedAt: e.processedAt ?? undefined,
  });

export const applyWager = (e: WagerTransactionEntity, t: WagerTransaction): void => {
  e.status = t.status;
  e.failureCode = t.failureCode;
  e.referenceTransactionId = t.referenceTransactionId;
  e.processedAt = t.processedAt;
};