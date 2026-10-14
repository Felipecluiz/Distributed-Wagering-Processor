import { Money, MoneyProps } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Wallet } from '../wallet/wallet';

export interface IntegrationEventProps<T> {
  eventId: string; aggregateId: string; correlationId: string;
  causationId?: string; occurredAt: Date; data: T;
}
export type EventContext = Omit<IntegrationEventProps<never>, 'data' | 'aggregateId'>;

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(p: IntegrationEventProps<T>) {
    this.eventId = p.eventId; this.aggregateId = p.aggregateId;
    this.correlationId = p.correlationId; this.causationId = p.causationId;
    this.occurredAt = p.occurredAt; this.data = Object.freeze({ ...p.data });
  }

  toJSON() {
    return {
      eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId,
      correlationId: this.correlationId, causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(), version: this.version, data: this.data,
    };
  }
}

export interface WalletBalanceChangedData {
  walletId: string; transactionId: string; direction: LedgerDirection; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx, aggregateId: wallet.id,
      data: {
        walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
        money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
      },
    });
  }
}
// Os outros 3 eventos (WagerTransactionProcessed, ...Rejected, ...PendingReference)
// seguem o mesmo padrão: subclasse com eventType/version fixos e um data tipado.