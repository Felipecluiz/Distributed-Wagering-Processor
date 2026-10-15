import { DynamicModule, Logger, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";
import ormConfig from "../../mikro-orm.config";
import { CreateWalletUseCase } from "../application/create-wallet";
import type { EventBus, WagerRequestQueue } from "../application/messaging";
import type { Clock, IdGenerator, UnitOfWork } from "../application/ports";
import { ProcessWagerTransactionUseCase } from "../application/process-wager-transaction";
import { NoAuthProviderIdentity } from "../application/provider-identity";
import { PublishOutboxUseCase } from "../application/publish-outbox";
import { ReconcileWalletUseCase } from "../application/reconcile-wallet";
import { ResolvePendingReferencesUseCase } from "../application/resolve-pending-references";
import { WagerMessageHandler } from "../application/wager-message-handler";
import type { ProcessWager } from "../application/wager-message-handler";
import { WagerQueueConsumer } from "../application/wager-queue-consumer";
import type { AppConfig } from "../config";
import { createSqsClient, SqsEventBus, SqsWagerRequestQueue } from "../infrastructure/messaging/sqs";
import { AppMetrics } from "../infrastructure/observability/app-metrics";
import { InstrumentedProcessWager } from "../infrastructure/observability/instrumented-process-wager";
import { MikroOrmUnitOfWork } from "../infrastructure/persistence/mikro-orm-unit-of-work";
import { MikroBacklogReader, MikroReadModels } from "../infrastructure/persistence/read-models";
import { systemClock, uuidGenerator } from "../infrastructure/system";
import { AuthGuard } from "./auth.guard";
import { HealthController } from "./health.controller";
import { HttpErrorFilter } from "./http-error";
import { BackgroundWorkers, ConnectionsLifecycle } from "./lifecycle";
import { MetricsController, RequestContextInterceptor } from "./observability";
import { TOKENS } from "./tokens";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

const useCaseDeps = [TOKENS.uow, TOKENS.clock, TOKENS.ids];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Primeiro segmento do motivo (ex.: "INVALID_PAYLOAD: ..." → "INVALID_PAYLOAD"): label de baixa cardinalidade. */
const reasonCode = (reason: string) => reason.split(":")[0]!.trim();

/**
 * Composição da aplicação. O domínio e os use cases não conhecem o Nest: aqui eles são
 * montados com as implementações de infraestrutura e expostos como providers.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: TOKENS.config, useValue: config },
        {
          provide: TOKENS.orm,
          useFactory: () => MikroORM.init({ ...ormConfig, clientUrl: config.databaseUrl }),
        },
        {
          provide: TOKENS.metrics,
          useFactory: (orm: MikroORM) => {
            const metrics = new AppMetrics();
            metrics.registerBacklog(new MikroBacklogReader(orm));
            return metrics;
          },
          inject: [TOKENS.orm],
        },
        { provide: TOKENS.clock, useValue: systemClock },
        { provide: TOKENS.ids, useValue: uuidGenerator },
        {
          provide: TOKENS.uow,
          // Deadlock e lock timeout viram métrica de conflito de lock.
          useFactory: (orm: MikroORM, metrics: AppMetrics) =>
            new MikroOrmUnitOfWork(orm, () => metrics.lockConflicts.inc()),
          inject: [TOKENS.orm, TOKENS.metrics],
        },
        {
          provide: TOKENS.queries,
          useFactory: (orm: MikroORM) => new MikroReadModels(orm),
          inject: [TOKENS.orm],
        },

        // ───── use cases ─────
        {
          // O mesmo processador instrumentado atende HTTP e SQS.
          provide: TOKENS.processWager,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: AppMetrics) =>
            new InstrumentedProcessWager(
              new ProcessWagerTransactionUseCase(uow, clock, ids),
              metrics,
              new Logger("Wagering"),
            ),
          inject: [...useCaseDeps, TOKENS.metrics],
        },
        {
          provide: TOKENS.createWallet,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new CreateWalletUseCase(uow, clock, ids),
          inject: useCaseDeps,
        },
        {
          provide: TOKENS.resolvePending,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => {
            const logger = new Logger("PendingReferenceWorker");
            return new ResolvePendingReferencesUseCase(
              uow, clock, ids, config.pendingReference.options, Math.random,
              (error, claim) =>
                logger.error({
                  msg: "pending reference resolution failed",
                  transactionId: claim.id,
                  walletId: claim.walletId,
                  err: message(error),
                }),
            );
          },
          inject: useCaseDeps,
        },
        {
          provide: TOKENS.reconcile,
          useFactory: (reader: MikroReadModels, metrics: AppMetrics) => {
            const logger = new Logger("Reconciliation");
            return new ReconcileWalletUseCase(reader, (r) => {
              metrics.reconciliationDivergences.inc();
              logger.warn({ msg: "reconciliation divergence", walletId: r.walletId, checkedEntries: r.checkedEntries });
            });
          },
          inject: [TOKENS.queries, TOKENS.metrics],
        },

        // ───── mensageria ─────
        { provide: TOKENS.sqsClient, useFactory: () => createSqsClient(config.sqs) },
        {
          provide: TOKENS.requestQueue,
          useFactory: (client: SQSClient) => new SqsWagerRequestQueue(client, config.sqs.queues),
          inject: [TOKENS.sqsClient],
        },
        {
          provide: TOKENS.eventBus,
          useFactory: (client: SQSClient) => new SqsEventBus(client, config.sqs.queues.events),
          inject: [TOKENS.sqsClient],
        },
        {
          provide: TOKENS.consumer,
          useFactory: (queue: WagerRequestQueue, processWager: ProcessWager, metrics: AppMetrics) => {
            const logger = new Logger("SqsConsumer");
            return new WagerQueueConsumer(
              queue,
              new WagerMessageHandler(processWager, { maxAttempts: config.sqs.consumer.maxAttempts }),
              { batchSize: 10, waitSeconds: 20, idleBackoffMs: 1_000 },
              {
                onOutcome: (m, outcome) => {
                  metrics.sqsMessages.inc({ outcome: outcome.action });
                  if (outcome.action === "ack") return;
                  if (outcome.action === "retry") metrics.retries.inc({ component: "sqs_consumer" });
                  else metrics.deadLettered.inc({ reason: reasonCode(outcome.reason) });
                  logger.warn({
                    msg: outcome.action === "retry" ? "message scheduled for retry" : "message sent to DLQ",
                    brokerMessageId: m.brokerMessageId,
                    receiveCount: m.receiveCount,
                    walletId: m.groupId,
                    reason: outcome.reason,
                  });
                },
                onError: (e, m) =>
                  logger.error({ msg: "consumer error", brokerMessageId: m?.brokerMessageId, err: message(e) }),
              },
            );
          },
          inject: [TOKENS.requestQueue, TOKENS.processWager, TOKENS.metrics],
        },
        {
          provide: TOKENS.publisher,
          useFactory: (uow: UnitOfWork, bus: EventBus, clock: Clock, metrics: AppMetrics) =>
            new PublishOutboxUseCase(uow, bus, clock, { leaseMs: config.sqs.publisher.leaseMs }, (occurredAt, publishedAt) => {
              metrics.outboxPublished.inc({}, occurredAt.length);
              for (const at of occurredAt) {
                metrics.outboxPublishLagSeconds.observe({}, Math.max(0, publishedAt.getTime() - at.getTime()) / 1000);
              }
            }),
          inject: [TOKENS.uow, TOKENS.eventBus, TOKENS.clock, TOKENS.metrics],
        },

        // ───── HTTP transversal ─────
        { provide: TOKENS.providerIdentity, useValue: new NoAuthProviderIdentity() },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },

        BackgroundWorkers,
        ConnectionsLifecycle,
      ],
    };
  }
}
