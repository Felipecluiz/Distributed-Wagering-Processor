import { Money } from '../money/money';
import { DomainError } from '../shared/errors';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface LedgerEntryState {
  id: string; walletId: string; transactionId: string; direction: LedgerDirection;
  money: Money; balanceBefore: Money; balanceAfter: Money; createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Valida a aritmética: before ± money === after. */
  static create(p: LedgerEntryState): WalletLedgerEntry {
    if (!p.money.isPositive()) throw new DomainError('INVALID_LEDGER_ENTRY', 'amount must be positive');
    const entry = WalletLedgerEntry.build(p);
    if (!entry.isBalanced()) throw new DomainError('INVALID_LEDGER_ENTRY', 'unbalanced ledger entry');
    return entry;
  }

  /** Reconstrói estado persistido, sem revalidar. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(s);
  }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(s.id, s.walletId, s.transactionId, s.direction,
      s.money, s.balanceBefore, s.balanceAfter, s.createdAt);
  }
}