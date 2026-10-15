/**
 * Publica um WagerTransactionRequested na fila de entrada, como um provedor faria.
 *
 *   bun scripts/send-wager.ts <walletId> <playerId> [kind] [amount] [referenceExternalTransactionId]
 *
 * Exemplo: bun scripts/send-wager.ts 0192f291-... 0192f28f-... BET 25.00
 */
import { GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../src/infrastructure/messaging/sqs";

const [walletId, playerId, kind = "BET", amount = "10.00", reference] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error("uso: bun scripts/send-wager.ts <walletId> <playerId> [kind] [amount] [referenceExternalTransactionId]");
  process.exit(1);
}

const client = createSqsClient({
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
});
const queue = process.env.SQS_REQUESTS_QUEUE ?? "wager-transactions.fifo";
const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queue }));

const externalTransactionId = `tx-${crypto.randomUUID()}`;
const envelope = {
  messageId: `msg-${crypto.randomUUID()}`,
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  },
};

await client.send(
  new SendMessageCommand({
    QueueUrl,
    MessageBody: JSON.stringify(envelope),
    MessageGroupId: walletId,
    MessageDeduplicationId: envelope.messageId,
  }),
);
console.log(JSON.stringify({ sent: envelope.messageId, externalTransactionId }));
client.destroy();
