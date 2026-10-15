import { Money, MoneyProps } from "../domain/money/money";
import { ResourceNotFoundError } from "./queries";

/** Saldo gravado e saldo recalculado do ledger, lidos num único snapshot. */
export interface ReconciliationSnapshot {
  walletId: string;
  currency: string;
  storedBalance: string;
  /** Soma independente do ledger inteiro: CREDIT − DEBIT. */
  calculatedBalance: string;
  entries: number;
}

export interface ReconciliationReader {
  snapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo materializado com o ledger. Divergência NUNCA é corrigida aqui:
 * é sinalizada na resposta e repassada a `onDivergence` (log + métrica).
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly onDivergence: (result: ReconciliationResult) => void = () => {},
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const s = await this.reader.snapshot(walletId);
    if (!s) throw new ResourceNotFoundError("wallet", walletId);

    const stored = Money.fromPersisted(s.storedBalance, s.currency);
    const calculated = Money.fromPersisted(s.calculatedBalance, s.currency);
    const difference = stored.subtract(calculated);

    const result: ReconciliationResult = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: s.entries,
    };
    if (!result.consistent) this.onDivergence(result);
    return result;
  }
}
