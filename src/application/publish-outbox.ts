import type { EventBus } from "./messaging";
import type { Clock, UnitOfWork } from "./ports";

export interface OutboxPublisherOptions {
  /** Eventos reivindicados por rodada. */
  batchSize: number;
  /** Validade da reivindicação. Se o publisher morrer, outro assume depois disso. */
  leaseMs: number;
}

export const DEFAULT_OUTBOX_PUBLISHER_OPTIONS: OutboxPublisherOptions = {
  batchSize: 50,
  leaseMs: 30_000,
};

export interface OutboxRunStats {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publica os eventos pendentes da outbox. Seguro com vários publishers:
 *
 * 1. Reivindica um lote com lease (FOR UPDATE SKIP LOCKED, transação curta).
 * 2. Publica FORA da transação: nenhuma conexão fica presa esperando o broker.
 * 3. Marca os publicados; os que falharam ganham retry com backoff e last_error.
 *
 * Se o processo morrer entre 2 e 3, o lease expira e o evento é publicado de novo.
 * A garantia é at-least-once: o eventId vai como MessageDeduplicationId e o consumidor
 * deduplica por ele.
 */
export class PublishOutboxUseCase {
  private readonly opts: OutboxPublisherOptions;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    opts: Partial<OutboxPublisherOptions> = {},
    /** Chamado após marcar os publicados: occurredAt de cada evento, para medir o lag. */
    private readonly onPublished?: (occurredAt: Date[], publishedAt: Date) => void,
  ) {
    this.opts = { ...DEFAULT_OUTBOX_PUBLISHER_OPTIONS, ...opts };
  }

  async runOnce(): Promise<OutboxRunStats> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.opts.leaseMs);
    const claimed = await this.uow.run((c) =>
      c.outbox.claimDue(this.opts.batchSize, now, leaseUntil),
    );
    if (claimed.length === 0) return { claimed: 0, published: 0, failed: 0 };

    let failed: Map<string, string>;
    try {
      const result = await this.bus.publish(
        claimed.map((m) => ({
          eventId: m.id,
          groupId: m.aggregateId,
          body: JSON.stringify(m.payload),
        })),
      );
      failed = new Map(result.failed.map((f) => [f.eventId, f.error]));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed = new Map(claimed.map((m) => [m.id, error]));
    }

    const done = this.clock.now();
    const published = claimed.filter((m) => !failed.has(m.id));
    await this.uow.run(async (c) => {
      await c.outbox.markPublished(
        published.map((m) => m.id),
        done,
      );
      for (const m of claimed.filter((m) => failed.has(m.id))) {
        m.scheduleRetry(done);
        await c.outbox.saveRetry(m, failed.get(m.id)!);
      }
    });
    this.onPublished?.(published.map((m) => m.occurredAt), done);
    return { claimed: claimed.length, published: published.length, failed: failed.size };
  }
}
