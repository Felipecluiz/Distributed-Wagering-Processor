import { Money } from '../money/money';
import { BusinessRuleError, DomainError, FailureCode } from '../shared/errors';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';

export interface WalletState {
  id: string; playerId: string; currency: string; balance: Money;
  version: number; createdAt: Date; updatedAt: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
  /** Em reversões, o código de saldo insuficiente é outro (REVERSAL_WOULD_OVERDRAW). */
  insufficientCode?: FailureCode;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com version = 1. Se houver saldo inicial, devolve também o
   * lançamento CREDIT de abertura (before = 0), que deve ser persistido na mesma transação.
   */
  static open(p: {
    id: string; playerId: string; initialBalance: Money; now: Date;
    openingTransactionId: string; openingEntryId: string;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (p.initialBalance.isNegative()) throw new DomainError('INVALID_WALLET', 'initial balance cannot be negative');
    const wallet = new Wallet(p.id, p.playerId, p.initialBalance.currency, p.initialBalance, 1, p.now, p.now);
    if (p.initialBalance.isZero()) return { wallet };
    const openingEntry = WalletLedgerEntry.create({
      id: p.openingEntryId, walletId: p.id, transactionId: p.openingTransactionId,
      direction: LedgerDirection.Credit, money: p.initialBalance,
      balanceBefore: Money.zero(p.initialBalance.currency), balanceAfter: p.initialBalance, createdAt: p.now,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  debit(p: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(p.money);
    this.assertPositive(p.money);
    if (this._balance.isLessThan(p.money)) {
      throw new BusinessRuleError(p.insufficientCode ?? FailureCode.InsufficientFunds,
        `balance ${this._balance} < ${p.money}`);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(p.money), p);
  }

  credit(p: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(p.money);
    this.assertPositive(p.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(p.money), p);
  }

  private apply(direction: LedgerDirection, after: Money, p: MovementProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: p.entryId, walletId: this.id, transactionId: p.transactionId, direction,
      money: p.money, balanceBefore: this._balance, balanceAfter: after, createdAt: p.at,
    });
    this._balance = after;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = p.at;
    return entry;
  }

  private assertPositive(m: Money): void {
    if (!m.isPositive()) throw new DomainError('INVALID_AMOUNT', 'movement amount must be positive');
  }

  private assertSameCurrency(m: Money): void {
    if (m.currency !== this.currency) {
      throw new BusinessRuleError(FailureCode.CurrencyMismatch,
        `wallet is ${this.currency}, operation is ${m.currency}`);
    }
  }
}