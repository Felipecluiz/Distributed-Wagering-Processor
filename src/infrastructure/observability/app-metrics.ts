import { CollectedGauge, Counter, Histogram, MetricsRegistry } from "./metrics";

/** Leituras do banco feitas na hora da coleta do /metrics. */
export interface BacklogReader {
  outboxPending(): Promise<{ count: number; oldestAgeSeconds: number }>;
  pendingReferences(): Promise<number>;
}

/**
 * Catálogo de métricas do serviço. Os nomes seguem a convenção do Prometheus
 * (sufixo _total em contadores, unidade no nome). Labels de baixa cardinalidade apenas.
 */
export class AppMetrics {
  readonly registry = new MetricsRegistry();

  // ───── transações ─────
  readonly wagerTransactions = this.registry.register(
    new Counter("wager_transactions_total", "Transações tratadas, por origem, status e replay.", [
      "source",
      "status",
      "replay",
    ] as const),
  );
  readonly duplicatesDetected = this.registry.register(
    new Counter(
      "wager_duplicates_detected_total",
      "Submissões repetidas resolvidas como replay idempotente (HTTP ou redelivery SQS).",
      ["source"] as const,
    ),
  );
  readonly wagerFailures = this.registry.register(
    new Counter("wager_requests_failed_total", "Submissões que não viraram transação, por código de erro.", [
      "source",
      "code",
    ] as const),
  );
  readonly processingSeconds = this.registry.register(
    new Histogram("wager_processing_duration_seconds", "Latência do processamento de uma transação.", [
      "source",
    ] as const),
  );

  // ───── concorrência ─────
  readonly lockConflicts = this.registry.register(
    new Counter("db_lock_conflicts_total", "Deadlocks e esperas de lock que estouraram o lock_timeout."),
  );

  // ───── mensageria ─────
  readonly sqsMessages = this.registry.register(
    new Counter("sqs_messages_total", "Mensagens da fila de entrada, por destino.", ["outcome"] as const),
  );
  readonly deadLettered = this.registry.register(
    new Counter("sqs_dead_lettered_total", "Mensagens enviadas para a DLQ, por motivo.", ["reason"] as const),
  );
  readonly retries = this.registry.register(
    new Counter("retries_total", "Novas tentativas agendadas, por componente.", ["component"] as const),
  );
  readonly outboxPublished = this.registry.register(
    new Counter("outbox_events_published_total", "Eventos aceitos pelo broker."),
  );
  readonly outboxPublishLagSeconds = this.registry.register(
    new Histogram(
      "outbox_publish_lag_seconds",
      "Tempo entre o commit do evento e a publicação.",
      [],
      [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    ),
  );

  // ───── worker de PENDING_REFERENCE ─────
  readonly pendingResolutions = this.registry.register(
    new Counter("pending_reference_resolutions_total", "Resultado de cada tentativa do worker.", [
      "outcome",
    ] as const),
  );

  // ───── reconciliação ─────
  readonly reconciliationDivergences = this.registry.register(
    new Counter("reconciliation_divergences_total", "Reconciliações que encontraram saldo diferente do ledger."),
  );

  // ───── HTTP ─────
  readonly httpRequests = this.registry.register(
    new Counter("http_requests_total", "Requisições HTTP, por rota e status.", ["method", "route", "status"] as const),
  );
  readonly httpDurationSeconds = this.registry.register(
    new Histogram("http_request_duration_seconds", "Latência das requisições HTTP.", ["method", "route"] as const),
  );

  /** Gauges que dependem do banco são registrados quando o leitor existe. */
  registerBacklog(reader: BacklogReader): void {
    this.registry.register(
      new CollectedGauge("outbox_pending_events", "Eventos commitados ainda não publicados.", async () =>
        (await reader.outboxPending()).count,
      ),
    );
    this.registry.register(
      new CollectedGauge(
        "outbox_oldest_pending_age_seconds",
        "Idade do evento pendente mais antigo (lag da outbox).",
        async () => (await reader.outboxPending()).oldestAgeSeconds,
      ),
    );
    this.registry.register(
      new CollectedGauge("pending_reference_transactions", "Transações aguardando a referência.", () =>
        reader.pendingReferences(),
      ),
    );
  }
}
