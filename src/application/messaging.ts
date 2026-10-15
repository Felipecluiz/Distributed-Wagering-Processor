/** Portas de mensageria. A aplicação não conhece o SDK da AWS. */

export interface QueueMessage {
  /** Id da mensagem no broker (não confundir com o messageId do envelope). */
  brokerMessageId: string;
  receiptHandle: string;
  body: string;
  /** Quantas vezes o broker já entregou esta mensagem (1 na primeira entrega). */
  receiveCount: number;
  groupId?: string;
}

/** Fila de entrada: wager-transactions.fifo, com a DLQ ao lado. */
export interface WagerRequestQueue {
  receive(opts: { max: number; waitSeconds: number; signal?: AbortSignal }): Promise<QueueMessage[]>;
  /** Confirma o processamento (remove da fila). Só depois do commit. */
  ack(message: QueueMessage): Promise<void>;
  /** Devolve à fila daqui a `delaySeconds` (backoff de visibilidade). */
  retryLater(message: QueueMessage, delaySeconds: number): Promise<void>;
  /** Devolve à fila imediatamente (shutdown com mensagem não iniciada). */
  release(message: QueueMessage): Promise<void>;
  /** Envia para a DLQ com o motivo e remove da fila original. */
  deadLetter(message: QueueMessage, reason: string): Promise<void>;
}

export interface OutboundEvent {
  /** Também é o MessageDeduplicationId: republicar o mesmo evento é seguro. */
  eventId: string;
  /** Ordenação por agregado no FIFO. */
  groupId: string;
  body: string;
}

export interface EventBus {
  /** Publica e devolve os que falharam (os demais foram aceitos pelo broker). */
  publish(events: OutboundEvent[]): Promise<{ failed: Array<{ eventId: string; error: string }> }>;
}

export interface BrokerHealthCheck {
  /** Lança se o broker não responde. */
  ping(): Promise<void>;
}
