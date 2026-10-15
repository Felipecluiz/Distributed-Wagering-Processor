import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  BrokerHealthCheck,
  EventBus,
  OutboundEvent,
  QueueMessage,
  WagerRequestQueue,
} from "../../application/messaging";

export interface SqsSettings {
  endpoint?: string;
  region: string;
}

export interface QueueNames {
  requests: string;
  deadLetter: string;
  events: string;
}

export function createSqsClient(s: SqsSettings): SQSClient {
  return new SQSClient({
    region: s.region,
    endpoint: s.endpoint,
    // LocalStack aceita qualquer credencial; em produção vêm do ambiente/IAM.
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}

/** Resolve e guarda a URL de uma fila pelo nome. Se falhar, tenta de novo na próxima chamada. */
class QueueUrl {
  private cached: Promise<string> | undefined;
  constructor(private readonly client: SQSClient, private readonly name: string) {}

  get(): Promise<string> {
    this.cached ??= this.client
      .send(new GetQueueUrlCommand({ QueueName: this.name }))
      .then((r) => r.QueueUrl!)
      .catch((e) => {
        this.cached = undefined;
        throw e;
      });
    return this.cached;
  }
}

/**
 * Cria as filas se não existirem (idempotente). DLQ primeiro, porque a fila principal
 * referencia o ARN dela na redrive policy.
 *
 * `maxReceiveCount` da redrive policy é a rede de segurança: a aplicação já manda para a
 * DLQ antes disso (WagerMessageHandler.maxAttempts), com o motivo anotado.
 */
export async function ensureQueues(
  client: SQSClient,
  names: QueueNames,
  opts: { visibilityTimeoutSeconds: number; maxReceiveCount: number },
): Promise<void> {
  const fifo = { FifoQueue: "true", ContentBasedDeduplication: "false" };
  const dlq = await client.send(new CreateQueueCommand({ QueueName: names.deadLetter, Attributes: fifo }));
  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }),
  );
  await client.send(
    new CreateQueueCommand({
      QueueName: names.requests,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(opts.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttrs.Attributes!.QueueArn,
          maxReceiveCount: String(opts.maxReceiveCount),
        }),
      },
    }),
  );
  await client.send(new CreateQueueCommand({ QueueName: names.events, Attributes: fifo }));
}

export class SqsWagerRequestQueue implements WagerRequestQueue, BrokerHealthCheck {
  private readonly queue: QueueUrl;
  private readonly dlq: QueueUrl;

  constructor(private readonly client: SQSClient, names: Pick<QueueNames, "requests" | "deadLetter">) {
    this.queue = new QueueUrl(client, names.requests);
    this.dlq = new QueueUrl(client, names.deadLetter);
  }

  async ping(): Promise<void> {
    const url = await this.queue.get();
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }));
  }

  async receive(opts: { max: number; waitSeconds: number; signal?: AbortSignal }): Promise<QueueMessage[]> {
    const r = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queue.get(),
        MaxNumberOfMessages: opts.max,
        WaitTimeSeconds: opts.waitSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
      { abortSignal: opts.signal },
    );
    return (r.Messages ?? []).map((m) => ({
      brokerMessageId: m.MessageId!,
      receiptHandle: m.ReceiptHandle!,
      body: m.Body ?? "",
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? "1"),
      groupId: m.Attributes?.MessageGroupId,
    }));
  }

  async ack(m: QueueMessage): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: await this.queue.get(), ReceiptHandle: m.receiptHandle }),
    );
  }

  async retryLater(m: QueueMessage, delaySeconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queue.get(),
        ReceiptHandle: m.receiptHandle,
        VisibilityTimeout: Math.max(0, Math.min(Math.round(delaySeconds), 43_200)),
      }),
    );
  }

  async release(m: QueueMessage): Promise<void> {
    await this.retryLater(m, 0);
  }

  /**
   * SendMessage na DLQ e depois DeleteMessage na original. Se o processo morrer entre os dois,
   * a mensagem volta, vai de novo para a DLQ e o MessageDeduplicationId (id original) evita a cópia.
   */
  async deadLetter(m: QueueMessage, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.dlq.get(),
        MessageBody: m.body,
        MessageGroupId: m.groupId ?? "dead-letter",
        MessageDeduplicationId: m.brokerMessageId,
        MessageAttributes: {
          reason: { DataType: "String", StringValue: reason.slice(0, 1_000) },
          originalMessageId: { DataType: "String", StringValue: m.brokerMessageId },
        },
      }),
    );
    await this.ack(m);
  }
}

const SQS_BATCH_LIMIT = 10;

export class SqsEventBus implements EventBus {
  private readonly queue: QueueUrl;

  constructor(private readonly client: SQSClient, eventsQueue: string) {
    this.queue = new QueueUrl(client, eventsQueue);
  }

  async publish(events: OutboundEvent[]): Promise<{ failed: Array<{ eventId: string; error: string }> }> {
    const url = await this.queue.get();
    const failed: Array<{ eventId: string; error: string }> = [];
    for (let i = 0; i < events.length; i += SQS_BATCH_LIMIT) {
      const chunk = events.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const r = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: url,
            Entries: chunk.map((e, j) => ({
              Id: String(j),
              MessageBody: e.body,
              MessageGroupId: e.groupId,
              MessageDeduplicationId: e.eventId,
            })),
          }),
        );
        for (const f of r.Failed ?? []) {
          failed.push({ eventId: chunk[Number(f.Id)]!.eventId, error: `${f.Code}: ${f.Message ?? ""}` });
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        failed.push(...chunk.map((c) => ({ eventId: c.eventId, error })));
      }
    }
    return { failed };
  }
}
