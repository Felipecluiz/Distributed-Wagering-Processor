import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppConfig, loadConfig } from "../config";
import type { AppMetrics } from "../infrastructure/observability/app-metrics";
import { JsonLogger } from "../infrastructure/observability/json-logger";
import { AppModule } from "./app.module";
import { accessLogMiddleware } from "./observability";
import { correlationIdMiddleware } from "./request";
import { TOKENS } from "./tokens";

/** Monta a aplicação sem abrir porta: o main.ts e os testes HTTP usam a mesma montagem. */
export async function createApp(
  config: AppConfig = loadConfig(),
  options: { logger?: boolean } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    // Uma linha JSON por evento, inclusive os logs internos do Nest.
    logger: options.logger === false ? false : new JsonLogger(config.logLevel),
  });
  app.use(correlationIdMiddleware);
  app.use(accessLogMiddleware(app.get<AppMetrics>(TOKENS.metrics)));
  // SIGTERM/SIGINT: para de aceitar conexões, encerra os workers e fecha as conexões (lifecycle.ts).
  app.enableShutdownHooks();
  return app;
}
