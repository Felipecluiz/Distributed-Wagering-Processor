import { WagerTransactionStatus as S } from "../domain/wager/wager-transaction";
import { FailureCode } from "../domain/shared/errors";
import {
  Clock,
  IdGenerator,
  PendingReferenceClaim,
  TxContext,
  UnitOfWork,
} from "./ports";
import { WagerDecider } from "./wager-decider";

export interface PendingReferenceOptions {
  /** Tentativas do worker antes de desistir (REJECTED). */
  maxAttempts: number;
  /** Idade máxima da transação pendente, contada do createdAt. */
  ttlMs: number;
  /** Backoff exponencial: min(baseDelayMs × 2^tentativas, maxDelayMs) + jitter de até 20%. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Quanto tempo uma reivindicação vale. Se o worker morrer, outro assume depois disso. */
  leaseMs: number;
  /** Quantas pendentes reivindicar por rodada. */
  batchSize: number;
}

/** 8 tentativas ou 15 minutos, o que vier primeiro (justificativa no ARCHITECTURE.md). */
export const DEFAULT_PENDING_REFERENCE_OPTIONS: PendingReferenceOptions = {
  maxAttempts: 8,
  ttlMs: 15 * 60_000,
  baseDelayMs: 5_000,
  maxDelayMs: 5 * 60_000,
  leaseMs: 30_000,
  batchSize: 50,
};

export type PendingReferenceOutcome =
  | "processed"
  | "rejected"
  | "rescheduled"
  | "skipped";

export interface PendingReferenceRunStats {
  claimed: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
  errors: number;
}

/**
 * Reprocessa transações PENDING_REFERENCE vencidas. Seguro com várias instâncias:
 *
 * 1. Reivindicação: numa transação curta, marca as vencidas com um lease
 *    (FOR UPDATE SKIP LOCKED). Duas instâncias nunca reivindicam a mesma linha.
 * 2. Resolução: cada pendente numa transação própria, travando a wallet ANTES da linha
 *    da transação (mesma ordem de locks da entrada, sem deadlock). Revalida status e
 *    tentativas: se outro worker já mexeu nela (lease expirado), não faz nada.
 * 3. Se o processo morrer entre 1 e 2, o lease expira e outra instância assume.
 *
 * A decisão de negócio é a mesma da entrada (WagerDecider).
 */
export class ResolvePendingReferencesUseCase {
  private readonly decider: WagerDecider;
  private readonly opts: PendingReferenceOptions;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    ids: IdGenerator,
    opts: Partial<PendingReferenceOptions> = {},
    private readonly random: () => number = Math.random,
    private readonly onError?: (
      error: unknown,
      claim: PendingReferenceClaim,
    ) => void,
  ) {
    this.decider = new WagerDecider(ids);
    this.opts = { ...DEFAULT_PENDING_REFERENCE_OPTIONS, ...opts };
  }

  async runOnce(): Promise<PendingReferenceRunStats> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.opts.leaseMs);
    const claims = await this.uow.run((c) =>
      c.wagers.claimDuePendingReferences(this.opts.batchSize, now, leaseUntil),
    );

    const stats: PendingReferenceRunStats = {
      claimed: claims.length,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
      errors: 0,
    };
    for (const claim of claims) {
      try {
        const outcome = await this.uow.run((c) => this.resolveOne(c, claim));
        stats[outcome]++;
      } catch (e) {
        // A transação deu rollback; o lease expira e a pendente volta na próxima rodada.
        stats.errors++;
        this.onError?.(e, claim);
      }
    }
    return stats;
  }

  private async resolveOne(
    c: TxContext,
    claim: PendingReferenceClaim,
  ): Promise<PendingReferenceOutcome> {
    // Mesma ordem de locks da entrada: wallet primeiro, depois a linha da transação.
    const wallet = await c.wallets.lockById(claim.walletId);
    if (!wallet) return "skipped";
    const pending = await c.wagers.lockPendingById(claim.id);
    if (
      !pending ||
      pending.transaction.status !== S.PendingReference ||
      pending.attempts !== claim.attempts
    ) {
      return "skipped"; // outro worker já resolveu ou reagendou esta pendente
    }

    const tx = pending.transaction;
    const now = this.clock.now();
    const attempts = claim.attempts + 1;
    const meta = { correlationId: `pending-reference:${tx.id}`, now };
    const d = await this.decider.decide(c, wallet, tx, now);

    if (d.type === "pendingReference") {
      const expired =
        attempts >= this.opts.maxAttempts ||
        now.getTime() - tx.createdAt.getTime() >= this.opts.ttlMs;
      if (!expired) {
        await c.wagers.saveResolution(
          tx,
          wallet.balance,
          attempts,
          this.nextAttemptAt(now, attempts),
        );
        return "rescheduled";
      }
      const code = d.referenceExists
        ? FailureCode.ReferenceNotProcessed
        : FailureCode.ReferenceNotFound;
      tx.reject(code);
      await c.wagers.saveResolution(tx, wallet.balance, attempts);
      await this.decider.enqueueOutcomeEvents(
        c,
        tx,
        wallet,
        { type: "rejected", code },
        meta,
      );
      return "rejected";
    }

    if (d.type === "applied") {
      tx.markProcessed(d.referenceId, now);
      if (d.entry) {
        await c.ledger.insert(d.entry);
        await c.wallets.save(wallet);
      }
    } else {
      tx.reject(d.code);
    }
    await c.wagers.saveResolution(tx, wallet.balance, attempts);
    await this.decider.enqueueOutcomeEvents(c, tx, wallet, d, meta);
    return d.type === "applied" ? "processed" : "rejected";
  }

  private nextAttemptAt(now: Date, attempts: number): Date {
    const delay = Math.min(
      this.opts.baseDelayMs * 2 ** attempts,
      this.opts.maxDelayMs,
    );
    const jitter = delay * 0.2 * this.random();
    return new Date(now.getTime() + delay + jitter);
  }
}
