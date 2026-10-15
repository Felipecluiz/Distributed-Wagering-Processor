import {
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient, ensureQueues, QueueNames } from '../../src/infrastructure/messaging/sqs';

/**
 * Filas isoladas por suíte (nome com um id aleatório), criadas no LocalStack real e apagadas
 * no fim. Uma suíte não enxerga mensagens de outra.
 */
export async function isolatedQueues(prefix: string, opts = { visibilityTimeoutSeconds: 30, maxReceiveCount: 10 }) {
  const client = createSqsClient({
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
  const run = crypto.randomUUID().slice(0, 8);
  const names: QueueNames = {
    requests: `${prefix}-${run}-requests.fifo`,
    deadLetter: `${prefix}-${run}-dlq.fifo`,
    events: `${prefix}-${run}-events.fifo`,
  };
  await ensureQueues(client, names, opts);
  const url = async (name: string) => (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  const urls = { requests: await url(names.requests), deadLetter: await url(names.deadLetter), events: await url(names.events) };

  return {
    client,
    names,
    urls,

    /** Publica um WagerTransactionRequested como um provedor faria. */
    async send(envelope: unknown, opts: { groupId: string; dedupId?: string }) {
      const r = await client.send(
        new SendMessageCommand({
          QueueUrl: urls.requests,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: opts.groupId,
          MessageDeduplicationId: opts.dedupId ?? crypto.randomUUID(),
        }),
      );
      return r.MessageId!;
    },

    /**
     * Lê e apaga tudo o que houver numa fila, até ela parecer vazia.
     *
     * Precisa apagar: numa fila FIFO, enquanto uma mensagem de um grupo está em leitura,
     * as seguintes do mesmo grupo não são entregues. Uma leitura sem apagar veria só a
     * primeira mensagem de cada grupo.
     */
    async drain(queue: 'requests' | 'deadLetter' | 'events', maxRounds = 50) {
      const all: Array<{ body: string; attributes: Record<string, string> }> = [];
      for (let i = 0; i < maxRounds; i++) {
        const r = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: urls[queue],
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            VisibilityTimeout: 60,
            MessageAttributeNames: ['All'],
          }),
        );
        const batch = r.Messages ?? [];
        if (batch.length === 0) break;
        for (const m of batch) {
          const attributes: Record<string, string> = {};
          for (const [k, v] of Object.entries(m.MessageAttributes ?? {})) attributes[k] = v.StringValue ?? '';
          all.push({ body: m.Body ?? '', attributes });
        }
        await client.send(
          new DeleteMessageBatchCommand({
            QueueUrl: urls[queue],
            Entries: batch.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
          }),
        );
      }
      return all;
    },

    async destroy() {
      await Promise.all(Object.values(urls).map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl })).catch(() => {})));
      client.destroy();
    },
  };
}

export type IsolatedQueues = Awaited<ReturnType<typeof isolatedQueues>>;
