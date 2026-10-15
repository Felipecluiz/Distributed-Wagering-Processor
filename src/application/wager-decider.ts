import { Wallet } from "../domain/wallet/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../domain/ledger/wallet-ledger-entry";
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../domain/wager/wager-transaction";
import { BusinessRuleError, FailureCode } from "../domain/shared/errors";
import {
  EventContext,
  WalletBalanceChanged,
} from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../domain/events/wager-events";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { IdGenerator, TxContext } from "./ports";

export type Decision =
  | { type: "applied"; entry?: WalletLedgerEntry; referenceId?: string }
  /** referenceExists: a referência existe, mas ainda não está PROCESSED (cadeia pendente). */
  | { type: "pendingReference"; referenceExists: boolean }
  | { type: "rejected"; code: FailureCode };

export const reject = (code: FailureCode): Decision => ({
  type: "rejected",
  code,
});

/**
 * Regras de negócio de uma transação de aposta. Compartilhadas pela entrada (HTTP/SQS)
 * e pelo worker de PENDING_REFERENCE, para que as duas portas decidam exatamente igual.
 * Sempre roda dentro da transação SQL, com a wallet já travada (FOR UPDATE).
 */
export class WagerDecider {
  constructor(private readonly ids: IdGenerator) {}

  /** Nunca lança BusinessRuleError: devolve a decisão. Só muta a wallet se aplicar. */
  async decide(
    c: TxContext,
    wallet: Wallet,
    tx: WagerTransaction,
    now: Date,
  ): Promise<Decision> {
    if (tx.playerId !== wallet.playerId)
      return reject(FailureCode.PlayerWalletMismatch);
    if (tx.money.currency !== wallet.currency)
      return reject(FailureCode.CurrencyMismatch);

    let reference: WagerTransaction | undefined;
    if (tx.requiresReference()) {
      const stored = await c.wagers.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId!,
      );
      if (!stored) return { type: "pendingReference", referenceExists: false };
      reference = stored.transaction;
      const verdict = this.checkReference(tx, reference);
      if (verdict === "pending")
        return { type: "pendingReference", referenceExists: true };
      if (verdict) return reject(verdict);
      if (await c.wagers.isReversed(reference.id))
        return reject(FailureCode.AlreadyReversed);
    }

    if (!tx.affectsBalance())
      return { type: "applied", referenceId: reference?.id }; // LOSS

    const movement = {
      entryId: this.ids.next(),
      transactionId: tx.id,
      money: tx.money,
      at: now,
      insufficientCode:
        tx.kind === K.Bet ? undefined : FailureCode.ReversalWouldOverdraw,
    };
    try {
      const entry =
        tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
      return { type: "applied", entry, referenceId: reference?.id };
    } catch (e) {
      if (e instanceof BusinessRuleError) return reject(e.failureCode);
      throw e;
    }
  }

  /** Grava na outbox os eventos do resultado, na mesma transação SQL do efeito. */
  async enqueueOutcomeEvents(
    c: TxContext,
    tx: WagerTransaction,
    wallet: Wallet,
    d: Decision,
    meta: { correlationId: string; now: Date },
  ): Promise<void> {
    const balance = wallet.balance.toJSON();
    const evCtx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: meta.correlationId,
      causationId: tx.id,
      occurredAt: meta.now,
    });
    const enqueue = (e: Parameters<typeof OutboxMessage.enqueue>[0]) =>
      c.outbox.insert(OutboxMessage.enqueue(e));

    if (d.type === "applied") {
      await enqueue(WagerTransactionProcessed.from(tx, balance, evCtx()));
      if (d.entry)
        await enqueue(WalletBalanceChanged.from(wallet, d.entry, evCtx()));
    } else if (d.type === "rejected") {
      await enqueue(WagerTransactionRejected.from(tx, balance, evCtx()));
    } else {
      await enqueue(
        WagerTransactionPendingReference.from(tx, balance, evCtx()),
      );
    }
  }

  private checkReference(
    tx: WagerTransaction,
    ref: WagerTransaction,
  ): FailureCode | "pending" | undefined {
    if (
      ref.playerId !== tx.playerId ||
      ref.walletId !== tx.walletId ||
      ref.roundId !== tx.roundId ||
      ref.money.currency !== tx.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    const allowed = tx.kind === K.Refund ? [K.Bet] : [K.Bet, K.Win, K.Refund];
    if (!allowed.includes(ref.kind)) return FailureCode.InvalidReferenceKind;
    if (ref.status === S.Pending || ref.status === S.PendingReference)
      return "pending"; // a referência também espera
    if (ref.status !== S.Processed) return FailureCode.ReferenceNotProcessed;
    if (!ref.money.equals(tx.money)) return FailureCode.AmountMismatch;
    return undefined;
  }
}
