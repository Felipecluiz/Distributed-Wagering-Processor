import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { PublishOutboxUseCase } from "../application/publish-outbox";
import { ResolvePendingReferencesUseCase } from "../application/resolve-pending-references";
import { WagerQueueConsumer } from "../application/wager-queue-consumer";
import type { AppConfig } from "../config";
import { ensureQueues } from "../infrastructure/messaging/sqs";
import type { AppMetrics } from "../infrastructure/observability/app-metrics";
import { TOKENS } from "./tokens";

/**
 * Executa `task` em loop com intervalo fixo entre rodadas. stop() para de agendar e espera
 * a rodada em andamento terminar.
 */
class IntervalLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.task();
    } catch (e) {
      this.logger.error({ msg: "worker round failed", err: e instanceof Error ? e.message : String(e) });
    } finally {
      this.inFlight = undefined;
      if (!this.stopped) this.schedule(this.intervalMs);
    }
  }
}

/**
 * Workers em segundo plano: worker de PENDING_REFERENCE, consumer SQS e publisher da outbox.
 * Cada instância roda os seus; reivindicação com lease e SKIP LOCKED evita trabalho duplicado.
 *
 * SIGTERM: para de receber e de reivindicar, termina o que está em andamento e devolve à fila
 * as mensagens recebidas que ainda não começaram.
 */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("Workers");
  private readonly pendingLoop: IntervalLoop;
  private readonly publisherLoop: IntervalLoop;

  constructor(
    @Inject(TOKENS.config) private readonly config: AppConfig,
    @Inject(TOKENS.sqsClient) private readonly sqs: SQSClient,
    @Inject(TOKENS.resolvePending) pending: ResolvePendingReferencesUseCase,
    @Inject(TOKENS.publisher) publisher: PublishOutboxUseCase,
    @Inject(TOKENS.consumer) private readonly consumer: WagerQueueConsumer,
    @Inject(TOKENS.metrics) metrics: AppMetrics,
  ) {
    const pendingLogger = new Logger("PendingReferenceWorker");
    this.pendingLoop = new IntervalLoop(
      async () => {
        const stats = await pending.runOnce();
        for (const outcome of ["processed", "rejected", "rescheduled", "skipped"] as const) {
          metrics.pendingResolutions.inc({ outcome }, stats[outcome]);
        }
        metrics.pendingResolutions.inc({ outcome: "error" }, stats.errors);
        metrics.retries.inc({ component: "pending_reference" }, stats.rescheduled);
        if (stats.claimed > 0) pendingLogger.log({ msg: "pending references round", ...stats });
      },
      config.pendingReference.pollMs,
      pendingLogger,
    );
    const publisherLogger = new Logger("OutboxPublisher");
    this.publisherLoop = new IntervalLoop(
      async () => {
        const stats = await publisher.runOnce();
        if (stats.failed > 0) {
          metrics.retries.inc({ component: "outbox_publisher" }, stats.failed);
          publisherLogger.warn({ msg: "outbox publish failures", ...stats });
        }
      },
      config.sqs.publisher.pollMs,
      publisherLogger,
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    const { sqs, pendingReference } = this.config;
    if (sqs.createQueues) {
      try {
        await ensureQueues(this.sqs, sqs.queues, {
          visibilityTimeoutSeconds: sqs.visibilityTimeoutSeconds,
          maxReceiveCount: sqs.redriveMaxReceiveCount,
        });
      } catch (e) {
        // Não derruba o boot: o /health/ready fica "down" e o consumer tenta de novo sozinho.
        this.logger.error({ msg: "could not ensure SQS queues", err: e instanceof Error ? e.message : String(e) });
      }
    }
    if (pendingReference.enabled) this.pendingLoop.start();
    if (sqs.publisher.enabled) this.publisherLoop.start();
    if (sqs.consumer.enabled) this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer.stop(), this.pendingLoop.stop(), this.publisherLoop.stop()]);
  }
}

/** Fecha conexões por último, depois que HTTP e workers pararam. */
@Injectable()
export class ConnectionsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(TOKENS.orm) private readonly orm: MikroORM,
    @Inject(TOKENS.sqsClient) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}
