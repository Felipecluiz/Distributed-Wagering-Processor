import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import { ResolvePendingReferencesUseCase } from "../application/resolve-pending-references";
import type { AppConfig } from "../config";
import { TOKENS } from "./tokens";

/**
 * Roda o worker de PENDING_REFERENCE em loop. Cada instância roda o seu: a reivindicação
 * com lease e SKIP LOCKED garante que duas instâncias não resolvam a mesma pendente.
 */
@Injectable()
export class PendingReferenceScheduler
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger("PendingReferenceWorker");
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    @Inject(TOKENS.resolvePending) private readonly worker: ResolvePendingReferencesUseCase,
    @Inject(TOKENS.config) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.pendingReference.enabled) return;
    this.schedule(0);
  }

  /** SIGTERM: para de agendar e espera a rodada em andamento terminar. */
  async beforeApplicationShutdown(): Promise<void> {
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
      const stats = await this.worker.runOnce();
      if (stats.claimed > 0) this.logger.log(JSON.stringify(stats));
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : String(e));
    } finally {
      this.inFlight = undefined;
      if (!this.stopped) this.schedule(this.config.pendingReference.pollMs);
    }
  }
}

/** Fecha o pool do banco por último, depois que HTTP e workers pararam. */
@Injectable()
export class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(TOKENS.orm) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
