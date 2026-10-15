import type { QueueMessage, WagerRequestQueue } from "./messaging";
import type { MessageOutcome, WagerMessageHandler } from "./wager-message-handler";

export interface ConsumerHooks {
  onOutcome?: (message: QueueMessage, outcome: MessageOutcome) => void;
  onError?: (error: unknown, message?: QueueMessage) => void;
}

/**
 * Loop de consumo da fila de entrada.
 *
 * - Mensagens de grupos diferentes (wallets diferentes) rodam em paralelo; dentro do mesmo
 *   grupo, em ordem. Se uma mensagem do grupo volta para retry, as seguintes do mesmo grupo
 *   são devolvidas à fila, para não passarem na frente dela.
 * - Ack só depois que o use case commitou. Se o processo morrer antes do ack, a mensagem é
 *   reentregue e o inbox devolve o resultado gravado, sem efeito novo.
 * - stop() (SIGTERM): interrompe o long polling, termina as mensagens em andamento e devolve
 *   à fila as que ainda não começaram.
 */
export class WagerQueueConsumer {
  private stopped = false;
  private abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly queue: WagerRequestQueue,
    private readonly handler: WagerMessageHandler,
    private readonly opts: { batchSize: number; waitSeconds: number; idleBackoffMs: number } = {
      batchSize: 10,
      waitSeconds: 20,
      idleBackoffMs: 1_000,
    },
    private readonly hooks: ConsumerHooks = {},
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.loop;
    this.loop = undefined;
  }

  /** Uma rodada: recebe um lote e processa. Exposto para os testes. */
  async pollOnce(waitSeconds = this.opts.waitSeconds): Promise<number> {
    const messages = await this.queue.receive({
      max: this.opts.batchSize,
      waitSeconds,
      signal: this.abort.signal,
    });
    if (this.stopped) {
      await Promise.all(messages.map((m) => this.safely(() => this.queue.release(m), m)));
      return 0;
    }
    await this.processBatch(messages);
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (e) {
        if (this.stopped) break; // long polling abortado pelo stop()
        this.hooks.onError?.(e);
        await new Promise((r) => setTimeout(r, this.opts.idleBackoffMs));
      }
    }
  }

  private async processBatch(messages: QueueMessage[]): Promise<void> {
    const groups = new Map<string, QueueMessage[]>();
    for (const m of messages) {
      const key = m.groupId ?? m.brokerMessageId;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async processGroup(group: QueueMessage[]): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      const message = group[i]!;
      if (this.stopped) {
        await Promise.all(group.slice(i).map((m) => this.safely(() => this.queue.release(m), m)));
        return;
      }
      const outcome = await this.dispatch(message);
      if (outcome?.action === "retry") {
        // Preserva a ordem do grupo: as seguintes esperam a que voltou para retry.
        await Promise.all(group.slice(i + 1).map((m) => this.safely(() => this.queue.release(m), m)));
        return;
      }
    }
  }

  private async dispatch(message: QueueMessage): Promise<MessageOutcome | undefined> {
    return this.safely(async () => {
      const outcome = await this.handler.handle(message);
      if (outcome.action === "ack") await this.queue.ack(message);
      else if (outcome.action === "retry") await this.queue.retryLater(message, outcome.delaySeconds);
      else await this.queue.deadLetter(message, outcome.reason);
      this.hooks.onOutcome?.(message, outcome);
      return outcome;
    }, message);
  }

  /** Falha ao falar com a fila não derruba o loop: a visibilidade expira e a mensagem volta. */
  private async safely<T>(fn: () => Promise<T>, message: QueueMessage): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      this.hooks.onError?.(e, message);
      return undefined;
    }
  }
}
