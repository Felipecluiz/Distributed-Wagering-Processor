import type { NextFunction, Request, Response } from "express";
import { InvalidPayloadError } from "../application/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CORRELATION_HEADER = "x-correlation-id";
const MAX_LEDGER_PAGE = 200;

/** Id malformado é 400, não 500 (o Postgres rejeitaria o cast para uuid). */
export function assertUuid(value: string, name: string): string {
  if (!UUID.test(value)) throw new InvalidPayloadError(`${name} must be a UUID`);
  return value;
}

export function parseLimit(raw: string | undefined, fallback = 50): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LEDGER_PAGE) {
    throw new InvalidPayloadError(`limit must be an integer between 1 and ${MAX_LEDGER_PAGE}`);
  }
  return n;
}

export function asObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * Garante um correlationId em toda requisição: usa o do chamador ou gera um.
 * Ele volta no header da resposta e acompanha a operação até os eventos da outbox.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_HEADER];
  const id = typeof incoming === "string" && incoming.trim() !== "" ? incoming : crypto.randomUUID();
  req.headers[CORRELATION_HEADER] = id;
  res.setHeader(CORRELATION_HEADER, id);
  next();
}
