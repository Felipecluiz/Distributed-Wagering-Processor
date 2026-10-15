import { DynamicModule, Logger, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import ormConfig from "../../mikro-orm.config";
import { CreateWalletUseCase } from "../application/create-wallet";
import { ProcessWagerTransactionUseCase } from "../application/process-wager-transaction";
import { NoAuthProviderIdentity } from "../application/provider-identity";
import { ReconcileWalletUseCase } from "../application/reconcile-wallet";
import { ResolvePendingReferencesUseCase } from "../application/resolve-pending-references";
import type { Clock, IdGenerator, UnitOfWork } from "../application/ports";
import type { AppConfig } from "../config";
import { MikroOrmUnitOfWork } from "../infrastructure/persistence/mikro-orm-unit-of-work";
import { MikroReadModels } from "../infrastructure/persistence/read-models";
import { systemClock, uuidGenerator } from "../infrastructure/system";
import { AuthGuard } from "./auth.guard";
import { HealthController } from "./health.controller";
import { HttpErrorFilter } from "./http-error";
import { OrmLifecycle, PendingReferenceScheduler } from "./lifecycle";
import { TOKENS } from "./tokens";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

const useCaseDeps = [TOKENS.uow, TOKENS.clock, TOKENS.ids];

/**
 * Composição da aplicação. O domínio e os use cases não conhecem o Nest: aqui eles são
 * montados com as implementações de infraestrutura e expostos como providers.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const logger = new Logger("App");
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: TOKENS.config, useValue: config },
        {
          provide: TOKENS.orm,
          useFactory: () => MikroORM.init({ ...ormConfig, clientUrl: config.databaseUrl }),
        },
        { provide: TOKENS.clock, useValue: systemClock },
        { provide: TOKENS.ids, useValue: uuidGenerator },
        {
          provide: TOKENS.uow,
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
          inject: [TOKENS.orm],
        },
        {
          provide: TOKENS.queries,
          useFactory: (orm: MikroORM) => new MikroReadModels(orm),
          inject: [TOKENS.orm],
        },
        {
          provide: TOKENS.processWager,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new ProcessWagerTransactionUseCase(uow, clock, ids),
          inject: useCaseDeps,
        },
        {
          provide: TOKENS.createWallet,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new CreateWalletUseCase(uow, clock, ids),
          inject: useCaseDeps,
        },
        {
          provide: TOKENS.resolvePending,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new ResolvePendingReferencesUseCase(
              uow,
              clock,
              ids,
              config.pendingReference.options,
              Math.random,
              (error, claim) =>
                logger.error(
                  `pending reference ${claim.id} failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
            ),
          inject: useCaseDeps,
        },
        {
          provide: TOKENS.reconcile,
          useFactory: (reader: MikroReadModels) =>
            new ReconcileWalletUseCase(reader, (r) =>
              logger.warn(
                `reconciliation divergence wallet=${r.walletId} difference=${r.difference.amount} ${r.difference.currency}`,
              ),
            ),
          inject: [TOKENS.queries],
        },
        { provide: TOKENS.providerIdentity, useValue: new NoAuthProviderIdentity() },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        PendingReferenceScheduler,
        OrmLifecycle,
      ],
    };
  }
}
