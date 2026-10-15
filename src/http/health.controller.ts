import { Controller, Get, Inject, Res } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import type { Response } from "express";
import type { BrokerHealthCheck } from "../application/messaging";
import { Public } from "./auth.guard";
import { TOKENS } from "./tokens";

type CheckStatus = "up" | "down";
const READINESS_TIMEOUT_MS = 2_000;

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), READINESS_TIMEOUT_MS);
      }),
    ]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/** Abertos por definição: orquestradores não autenticam. */
@Public()
@Controller("health")
export class HealthController {
  constructor(
    @Inject(TOKENS.orm) private readonly orm: MikroORM,
    @Inject(TOKENS.requestQueue) private readonly broker: BrokerHealthCheck,
  ) {}

  /** Liveness: o processo responde. Não toca dependências, para não reiniciar por causa delas. */
  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Readiness: só recebe tráfego se PostgreSQL e SQS respondem. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.orm.em.getConnection().execute("select 1")),
      check(() => this.broker.ping()),
    ]);
    const checks = { postgres, sqs };
    const ok = postgres === "up" && sqs === "up";
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks };
  }
}
