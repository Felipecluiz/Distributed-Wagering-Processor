import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { tap } from "rxjs";
import type { AppMetrics } from "../infrastructure/observability/app-metrics";
import { Public } from "./auth.guard";
import { CORRELATION_HEADER } from "./request";
import { TOKENS } from "./tokens";

/** Prometheus. Aberto como os health checks: quem coleta é a infraestrutura. */
@Public()
@Controller()
export class MetricsController {
  constructor(@Inject(TOKENS.metrics) private readonly metrics: AppMetrics) {}

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  render(): Promise<string> {
    return this.metrics.registry.render();
  }
}

/**
 * Guarda, para o log de acesso, a rota casada, os parâmetros e o transactionId devolvido.
 * Roda antes do handler, então os campos existem mesmo quando o handler lança erro.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    res.locals.route = req.route?.path;
    res.locals.params = { ...req.params };
    return next.handle().pipe(
      tap((result: unknown) => {
        if (result && typeof result === "object" && "transactionId" in result) {
          res.locals.transactionId = (result as { transactionId: unknown }).transactionId;
        }
      }),
    );
  }
}

const QUIET_ROUTES = new Set(["/health/live", "/health/ready", "/metrics"]);
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * Uma linha de log JSON e uma amostra de métrica por requisição. Só identificadores:
 * nenhum valor monetário ou corpo de requisição vai para o log.
 */
export function accessLogMiddleware(metrics: AppMetrics) {
  const logger = new Logger("Http");
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    res.on("finish", () => {
      // Só rotas casadas viram label: URLs arbitrárias (404) não explodem a cardinalidade.
      const route: string = res.locals.route ?? "unmatched";
      const seconds = (performance.now() - started) / 1000;
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      metrics.httpDurationSeconds.observe({ method: req.method, route }, seconds);
      if (QUIET_ROUTES.has(route)) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const params = (res.locals.params ?? {}) as Record<string, unknown>;
      const entry = {
        msg: "http request",
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1000),
        correlationId: str(req.headers[CORRELATION_HEADER]),
        providerId: str(params.providerId) ?? str(body.providerId),
        walletId: str(params.walletId) ?? str(body.walletId),
        transactionId: str(params.transactionId) ?? str(res.locals.transactionId),
      };
      if (res.statusCode >= 500) logger.error(entry);
      else if (res.statusCode >= 400) logger.warn(entry);
      else logger.log(entry);
    });
    next();
  };
}
