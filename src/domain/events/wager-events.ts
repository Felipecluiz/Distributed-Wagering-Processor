import { MoneyProps } from '../money/money';
import { WagerTransaction } from '../wager/wager-transaction';
import { FailureCode } from '../shared/errors';
import { EventContext, IntegrationEvent } from './integration-event';

export interface WagerEventData {
  transactionId: string; walletId: string; providerId: string; externalTransactionId: string;
  roundId: string; kind: string; money: MoneyProps; balance: MoneyProps; status: string;
}
const base = (tx: WagerTransaction, balance: MoneyProps): WagerEventData => ({
  transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId, roundId: tx.roundId, kind: tx.kind,
  money: tx.money.toJSON(), balance, status: tx.status,
});

export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(tx: WagerTransaction, balance: MoneyProps, ctx: EventContext) {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.walletId, data: base(tx, balance) });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerEventData & { failureCode: FailureCode }> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(tx: WagerTransaction, balance: MoneyProps, ctx: EventContext) {
    return new WagerTransactionRejected({
      ...ctx, aggregateId: tx.walletId, data: { ...base(tx, balance), failureCode: tx.failureCode! },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData & { referenceExternalTransactionId: string }> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(tx: WagerTransaction, balance: MoneyProps, ctx: EventContext) {
    return new WagerTransactionPendingReference({
      ...ctx, aggregateId: tx.walletId,
      data: { ...base(tx, balance), referenceExternalTransactionId: tx.referenceExternalTransactionId! },
    });
  }
}