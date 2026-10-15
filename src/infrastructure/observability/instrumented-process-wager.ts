import type { LoggerService } from "@nestjs/common";
import {
  ConcurrentInsertError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "../../application/errors";
import type { ProcessWagerCommand, ProcessWagerResult } from "../../application/process-wager-transaction";
import type { ProcessWager } from "../../application/wager-message-handler";
import type { AppMetrics } from "./app-metrics";

/** Código de baixa cardinalidade para métrica e log. */
export function errorCode(e: unknown): string {
  if (e instanceof InvalidPayloadError) return "INVALID_PAYLOAD";
  if (e instanceof IdempotencyConflictError) return e.code;
  if (e instanceof WalletNotFoundError) return e.failureCode;
  if (e instanceof TransientInfrastructureError || e instanceof ConcurrentInsertError) return "TRANSIENT_FAILURE";
  return "INTERNAL_ERROR";
}

/**
 * Decorador do use case de processamento: mede latência, conta status, replays e falhas,
 * e escreve uma linha de log por transação. É o mesmo para HTTP e SQS, então toda
 * transação tem exatamente um log com os campos de correlação, venha de onde vier.
 */
export class InstrumentedProcessWager implements ProcessWager {
  constructor(
    private readonly inner: ProcessWager,
    private readonly metrics: AppMetrics,
    private readonly logger: LoggerService,
  ) {}

  async execute(
    cmd: ProcessWagerCommand,
    ctx: { correlationId: string; inbox?: { consumerName: string; messageId: string } },
  ): Promise<ProcessWagerResult> {
    const source = ctx.inbox ? "sqs" : "http";
    const started = performance.now();
    const base = {
      source,
      correlationId: ctx.correlationId,
      messageId: ctx.inbox?.messageId,
      walletId: cmd?.walletId,
      providerId: cmd?.providerId,
      kind: cmd?.kind,
    };
    try {
      const r = await this.inner.execute(cmd, ctx);
      const seconds = (performance.now() - started) / 1000;
      this.metrics.processingSeconds.observe({ source }, seconds);
      this.metrics.wagerTransactions.inc({ source, status: r.status, replay: String(r.idempotentReplay) });
      if (r.idempotentReplay) this.metrics.duplicatesDetected.inc({ source });
      this.logger.log({
        msg: r.idempotentReplay ? "wager transaction replayed" : "wager transaction handled",
        ...base,
        transactionId: r.transactionId,
        status: r.status,
        failureCode: r.failureCode,
        idempotentReplay: r.idempotentReplay,
        durationMs: Math.round(seconds * 1000),
      }, "Wagering");
      return r;
    } catch (e) {
      const code = errorCode(e);
      this.metrics.wagerFailures.inc({ source, code });
      const entry = {
        msg: "wager transaction not processed",
        ...base,
        code,
        durationMs: Math.round(performance.now() - started),
      };
      if (code === "INTERNAL_ERROR") {
        this.logger.error({ ...entry, err: e instanceof Error ? e.message : String(e) }, e instanceof Error ? e.stack : undefined, "Wagering");
      } else {
        this.logger.warn(entry, "Wagering");
      }
      throw e;
    }
  }
}
