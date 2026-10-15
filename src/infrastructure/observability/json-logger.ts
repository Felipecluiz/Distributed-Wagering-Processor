import type { LoggerService, LogLevel } from "@nestjs/common";

const LEVELS: Record<LogLevel, number> = { verbose: 10, debug: 20, log: 30, warn: 40, error: 50, fatal: 60 };
const NAMES: Record<LogLevel, string> = {
  verbose: "trace",
  debug: "debug",
  log: "info",
  warn: "warn",
  error: "error",
  fatal: "fatal",
};

/**
 * Chaves que nunca vão para o log, mesmo se alguém passar por engano: o desafio proíbe
 * payloads financeiros e dados sensíveis nos logs.
 */
const REDACTED = /^(amount|money|balance.*|payload|body|initialBalance|authorization|token|password)$/i;

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || REDACTED.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Logger do Nest que escreve uma linha JSON por evento:
 * { time, level, context, msg, ...campos }.
 *
 * Uso: `logger.log({ msg: "...", correlationId, transactionId, walletId, providerId })`.
 * Campos de correlação esperados: correlationId, messageId, transactionId, walletId, providerId.
 */
export class JsonLogger implements LoggerService {
  private readonly min: number;

  constructor(
    level: LogLevel = "log",
    private readonly write: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  ) {
    this.min = LEVELS[level];
  }

  log(message: unknown, ...rest: unknown[]) {
    this.emit("log", message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.emit("warn", message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.emit("debug", message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.emit("verbose", message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.emit("fatal", message, rest);
  }
  /** O Nest chama error(message, stack?, context?). */
  error(message: unknown, ...rest: unknown[]) {
    this.emit("error", message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]) {
    if (LEVELS[level] < this.min) return;

    // Parâmetros extras do Nest: um stack (multilinha) e/ou o contexto (nome do Logger).
    const strings = rest.filter((r): r is string => typeof r === "string");
    const stack = strings.find((s) => s.includes("\n"));
    const context = strings.filter((s) => s !== stack).at(-1);

    let fields: Record<string, unknown>;
    if (message instanceof Error) {
      fields = { msg: message.message, err: message.name, stack: message.stack };
    } else if (message !== null && typeof message === "object") {
      fields = sanitize(message as Record<string, unknown>);
    } else {
      fields = { msg: String(message) };
    }

    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: NAMES[level],
      ...(context ? { context } : {}),
      ...fields,
      ...(stack ? { stack } : {}),
    };
    this.write(JSON.stringify(line));
  }
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "log").toLowerCase();
  if (v === "info") return "log";
  if (v in LEVELS) return v as LogLevel;
  throw new Error(`LOG_LEVEL must be one of ${Object.keys(LEVELS).join(", ")} (got "${raw}")`);
}
