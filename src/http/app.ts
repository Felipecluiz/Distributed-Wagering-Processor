import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppConfig, loadConfig } from "../config";
import { AppModule } from "./app.module";
import { correlationIdMiddleware } from "./request";

/** Monta a aplicação sem abrir porta: o main.ts e os testes HTTP usam a mesma montagem. */
export async function createApp(
  config: AppConfig = loadConfig(),
  options: { logger?: boolean } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: options.logger === false ? false : undefined,
  });
  app.use(correlationIdMiddleware);
  // SIGTERM/SIGINT: para de aceitar conexões, espera o worker e fecha o pool (ver lifecycle.ts).
  app.enableShutdownHooks();
  return app;
}
