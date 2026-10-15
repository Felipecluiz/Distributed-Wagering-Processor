import { Money } from "../money/money";
import { DomainError } from "../shared/errors";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Versão da wallet produzida por este lançamento. Única por wallet. */
  walletVersion: number;
  createdAt: Date;
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
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  /** Valida a aritmética (before ± money === after) e a versão. */
  static create(p: LedgerEntryState): WalletLedgerEntry {
    if (!p.money.isPositive())
      throw new DomainError("INVALID_LEDGER_ENTRY", "amount must be positive");
    if (!Number.isInteger(p.walletVersion) || p.walletVersion < 1) {
      throw new DomainError(
        "INVALID_LEDGER_ENTRY",
        "walletVersion must be an integer >= 1",
      );
    }
    const entry = WalletLedgerEntry.build(p);
    if (!entry.isBalanced())
      throw new DomainError("INVALID_LEDGER_ENTRY", "unbalanced ledger entry");
    return entry;
  }

  /** Reconstrói estado persistido, sem revalidar. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(s);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id,
      s.walletId,
      s.transactionId,
      s.direction,
      s.money,
      s.balanceBefore,
      s.balanceAfter,
      s.walletVersion,
      s.createdAt,
    );
  }
}
