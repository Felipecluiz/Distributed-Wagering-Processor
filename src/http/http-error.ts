import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { ConnectionException } from "@mikro-orm/core";
import type { Response } from "express";
import {
  ConcurrentInsertError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../application/errors";
import { ResourceNotFoundError } from "../application/queries";

export interface HttpErrorBody {
  /** Estável e legível por máquina: o provedor decide por ele, nunca pela mensagem. */
  code: string;
  message: string;
  failureCode?: string;
}

export interface HttpError {
  status: number;
  body: HttpErrorBody;
  /** Segundos para o header Retry-After (só em falha transitória). */
  retryAfter?: number;
}

const RETRY_AFTER_SECONDS = 1;

/**
 * Tabela única de mapeamento erro → HTTP (ARCHITECTURE.md, seção 10). Todas as rotas passam
 * por aqui, então o mesmo erro tem o mesmo status em qualquer endpoint.
 */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof InvalidPayloadError) {
    return { status: 400, body: { code: "INVALID_PAYLOAD", message: e.message } };
  }
  if (e instanceof ResourceNotFoundError) {
    return { status: 404, body: { code: e.code, message: e.message } };
  }
  if (e instanceof IdempotencyConflictError) {
    return { status: 409, body: { code: e.code, message: e.message } };
  }
  if (e instanceof WalletAlreadyExistsError) {
    return { status: 409, body: { code: e.code, message: e.message } };
  }
  if (e instanceof WalletNotFoundError) {
    return {
      status: 422,
      body: { code: e.failureCode, failureCode: e.failureCode, message: e.message },
    };
  }
  if (
    e instanceof TransientInfrastructureError ||
    e instanceof ConcurrentInsertError || // retries internos esgotados: reenviar é seguro
    e instanceof ConnectionException // leituras fora do Unit of Work
  ) {
    return {
      status: 503,
      body: { code: "TRANSIENT_FAILURE", message: "temporarily unavailable, retry with the same Idempotency-Key" },
      retryAfter: RETRY_AFTER_SECONDS,
    };
  }
  if (e instanceof HttpException) {
    // Erros do próprio Nest/Express: JSON malformado (400), rota inexistente (404) etc.
    const status = e.getStatus();
    const code = status === 400 ? "INVALID_PAYLOAD" : status === 404 ? "NOT_FOUND" : `HTTP_${status}`;
    return { status, body: { code, message: e.message } };
  }
  return { status: 500, body: { code: "INTERNAL_ERROR", message: "internal error" } };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpError");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, retryAfter } = toHttpError(exception);
    if (status >= 500) {
      // Sem payload no log: só o erro. Detalhes internos nunca vão para a resposta de um 500.
      this.logger.error(
        {
          msg: "unhandled error",
          code: body.code,
          err: exception instanceof Error ? exception.message : String(exception),
          correlationId: host.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers["x-correlation-id"],
        },
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    if (retryAfter !== undefined) res.setHeader("Retry-After", String(retryAfter));
    res.status(status).json(body);
  }
}
