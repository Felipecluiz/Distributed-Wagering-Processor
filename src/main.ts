import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { loadConfig } from "./config";
import { createApp } from "./http/app";

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  new Logger("Bootstrap").log(
    `listening on :${config.port} (pending-reference worker ${config.pendingReference.enabled ? "on" : "off"})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
