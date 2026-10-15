import { PendingReferenceOptions } from "./application/resolve-pending-references";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  pendingReference: {
    /** Liga o worker de PENDING_REFERENCE nesta instância. */
    enabled: boolean;
    /** Intervalo entre rodadas do worker. */
    pollMs: number;
    options: Partial<PendingReferenceOptions>;
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

  return {
    port: int(env, "PORT", 3000)!,
    databaseUrl:
      env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/wagering",
    pendingReference: {
      enabled: (env.PENDING_REFERENCE_WORKER ?? "on") !== "off",
      pollMs: int(env, "PENDING_REFERENCE_POLL_MS", 1_000)!,
      options,
    },
  };
}
