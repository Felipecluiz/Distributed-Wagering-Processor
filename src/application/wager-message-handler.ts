import {
  ConcurrentInsertError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "./errors";
import type { QueueMessage } from "./messaging";
import type {
  ProcessWagerCommand,
  ProcessWagerResult,
} from "./process-wager-transaction";

/** O que fazer com a mensagem depois de tentar processá-la. */
export type MessageOutcome =
  | { action: "ack"; status: string }
  | { action: "retry"; delaySeconds: number; reason: string }
  | { action: "dead-letter"; reason: string };

export interface WagerMessageHandlerOptions {
  consumerName: string;
  /** Entregas antes de desistir de um erro transitório/inesperado e mandar para a DLQ. */
  maxAttempts: number;
  /** Backoff de visibilidade: min(base × 2^(entrega-1), max), em segundos. */
  baseDelaySeconds: number;
  maxDelaySeconds: number;
}

export const DEFAULT_MESSAGE_HANDLER_OPTIONS: WagerMessageHandlerOptions = {
  consumerName: "wager-transactions",
  maxAttempts: 5,
  baseDelaySeconds: 2,
  maxDelaySeconds: 60,
};

/** O mesmo use case da entrada HTTP; só a porta muda. */
export interface ProcessWager {
  execute(
    cmd: ProcessWagerCommand,
    ctx: { correlationId: string; inbox?: { consumerName: string; messageId: string } },
  ): Promise<ProcessWagerResult>;
}

/**
 * Decide o destino de uma mensagem de WagerTransactionRequested:
 *
 * | Situação                                                       | Destino            |
 * | -------------------------------------------------------------- | ------------------ |
 * | processada, rejeitada por regra de negócio ou pendente         | ack                |
 * | envelope/payload inválido, conflito de idempotência, sem wallet | DLQ (permanente)   |
 * | banco indisponível, deadlock, lock timeout, erro inesperado    | retry com backoff  |
 * | retry esgotado (maxAttempts)                                   | DLQ                |
 *
 * A deduplicação de redelivery é do inbox, dentro da transação do efeito financeiro.
 */
export class WagerMessageHandler {
  private readonly opts: WagerMessageHandlerOptions;

  constructor(
    private readonly processWager: ProcessWager,
    opts: Partial<WagerMessageHandlerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_MESSAGE_HANDLER_OPTIONS, ...opts };
  }

  get consumerName(): string {
    return this.opts.consumerName;
  }

  async handle(message: QueueMessage): Promise<MessageOutcome> {
    const envelope = parseEnvelope(message.body);
    if ("error" in envelope) return { action: "dead-letter", reason: `INVALID_MESSAGE: ${envelope.error}` };

    try {
      const result = await this.processWager.execute(envelope.command, {
        correlationId: envelope.correlationId,
        inbox: { consumerName: this.opts.consumerName, messageId: envelope.messageId },
      });
      return { action: "ack", status: result.status };
    } catch (e) {
      const permanent = permanentReason(e);
      if (permanent) return { action: "dead-letter", reason: permanent };

      const reason =
        e instanceof TransientInfrastructureError || e instanceof ConcurrentInsertError
          ? "TRANSIENT_FAILURE"
          : `UNEXPECTED_ERROR: ${e instanceof Error ? e.message : String(e)}`;
      if (message.receiveCount >= this.opts.maxAttempts) {
        return { action: "dead-letter", reason: `MAX_ATTEMPTS_EXCEEDED: ${reason}` };
      }
      return { action: "retry", delaySeconds: this.delayFor(message.receiveCount), reason };
    }
  }

  private delayFor(receiveCount: number): number {
    return Math.min(
      this.opts.baseDelaySeconds * 2 ** Math.max(0, receiveCount - 1),
      this.opts.maxDelaySeconds,
    );
  }
}

function permanentReason(e: unknown): string | undefined {
  if (e instanceof InvalidPayloadError) return `INVALID_PAYLOAD: ${e.message}`;
  if (e instanceof IdempotencyConflictError) return e.code;
  if (e instanceof WalletNotFoundError) return e.failureCode;
  return undefined;
}

type Envelope =
  | { messageId: string; correlationId: string; command: ProcessWagerCommand }
  | { error: string };

function parseEnvelope(body: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { error: "body is not JSON" };
  }
  if (raw === null || typeof raw !== "object") return { error: "body is not an object" };
  const env = raw as Record<string, unknown>;
  if (env.type !== "WagerTransactionRequested") return { error: `unsupported type ${String(env.type)}` };
  if (typeof env.messageId !== "string" || env.messageId.trim() === "") return { error: "messageId is required" };
  if (env.data === null || typeof env.data !== "object") return { error: "data is required" };

  const d = env.data as Record<string, unknown>;
  const command = {
    idempotencyKey: d.idempotencyKey,
    providerId: d.providerId,
    externalTransactionId: d.externalTransactionId,
    playerId: d.playerId,
    walletId: d.walletId,
    roundId: d.roundId,
    gameId: d.gameId,
    kind: d.kind,
    money: d.money,
    referenceExternalTransactionId: d.referenceExternalTransactionId,
  } as ProcessWagerCommand;

  const correlationId =
    typeof env.correlationId === "string" && env.correlationId.trim() !== ""
      ? env.correlationId
      : `msg:${env.messageId}`;
  return { messageId: env.messageId, correlationId, command };
}
