import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { loadConfig } from "./config";
import { createApp } from "./http/app";

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  new Logger("Bootstrap").log({
    msg: "listening",
    port: config.port,
    pendingReferenceWorker: config.pendingReference.enabled,
    sqsConsumer: config.sqs.consumer.enabled,
    outboxPublisher: config.sqs.publisher.enabled,
  });
}

main().catch((err) => {
  console.error(JSON.stringify({ time: new Date().toISOString(), level: "fatal", msg: "boot failed", err: String(err) }));
  process.exit(1);
});
