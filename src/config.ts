import type { LogLevel } from "@nestjs/common";
import type { PendingReferenceOptions } from "./application/resolve-pending-references";
import { parseLogLevel } from "./infrastructure/observability/json-logger";

export interface AppConfig {
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  pendingReference: {
    /** Liga o worker de PENDING_REFERENCE nesta instância. */
    enabled: boolean;
    /** Intervalo entre rodadas do worker. */
    pollMs: number;
    options: Partial<PendingReferenceOptions>;
  };
  sqs: {
    endpoint?: string;
    region: string;
    queues: { requests: string; deadLetter: string; events: string };
    /** Cria as filas no boot se não existirem (LocalStack/dev). */
    createQueues: boolean;
    visibilityTimeoutSeconds: number;
    /** Rede de segurança da redrive policy; a aplicação manda para a DLQ antes. */
    redriveMaxReceiveCount: number;
    consumer: { enabled: boolean; maxAttempts: number };
    publisher: { enabled: boolean; pollMs: number; leaseMs: number };
  };
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback?: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return value;
}

const on = (env: Env, name: string, fallback: "on" | "off" = "on") =>
  (env[name] ?? fallback) !== "off";

/** Lê a configuração do ambiente e falha cedo se algo estiver inválido. */
export function loadConfig(env: Env = process.env): AppConfig {
  const options: Partial<PendingReferenceOptions> = {};
  const maxAttempts = int(env, "PENDING_REFERENCE_MAX_ATTEMPTS");
  const ttlMs = int(env, "PENDING_REFERENCE_TTL_MS");
  const leaseMs = int(env, "PENDING_REFERENCE_LEASE_MS");
  const batchSize = int(env, "PENDING_REFERENCE_BATCH_SIZE");
  if (maxAttempts !== undefined) options.maxAttempts = maxAttempts;
  if (ttlMs !== undefined) options.ttlMs = ttlMs;
  if (leaseMs !== undefined) options.leaseMs = leaseMs;
  if (batchSize !== undefined) options.batchSize = batchSize;

  const consumerMaxAttempts = int(env, "SQS_MAX_ATTEMPTS", 5)!;

  return {
    port: int(env, "PORT", 3000)!,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    databaseUrl:
      env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/wagering",
    pendingReference: {
      enabled: on(env, "PENDING_REFERENCE_WORKER"),
      pollMs: int(env, "PENDING_REFERENCE_POLL_MS", 1_000)!,
      options,
    },
    sqs: {
      endpoint: env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
      region: env.AWS_REGION ?? "us-east-1",
      queues: {
        requests: env.SQS_REQUESTS_QUEUE ?? "wager-transactions.fifo",
        deadLetter: env.SQS_DLQ ?? "wager-transactions-dlq.fifo",
        events: env.SQS_EVENTS_QUEUE ?? "wager-events.fifo",
      },
      createQueues: on(env, "SQS_CREATE_QUEUES"),
      visibilityTimeoutSeconds: int(env, "SQS_VISIBILITY_TIMEOUT_SECONDS", 30)!,
      redriveMaxReceiveCount: consumerMaxAttempts + 3,
      consumer: { enabled: on(env, "SQS_CONSUMER"), maxAttempts: consumerMaxAttempts },
      publisher: {
        enabled: on(env, "OUTBOX_PUBLISHER"),
        pollMs: int(env, "OUTBOX_POLL_MS", 500)!,
        leaseMs: int(env, "OUTBOX_LEASE_MS", 30_000)!,
      },
    },
  };
}
