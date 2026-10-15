import { Controller, Get, Inject, Res } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import type { Response } from "express";
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
  constructor(@Inject(TOKENS.orm) private readonly orm: MikroORM) {}

  /** Liveness: o processo responde. Não toca dependências, para não reiniciar por causa delas. */
  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Readiness: só recebe tráfego se as dependências respondem. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, CheckStatus> = {
      postgres: await check(() => this.orm.em.getConnection().execute("select 1")),
      // sqs: entra junto com o consumer
    };
    const ok = Object.values(checks).every((s) => s === "up");
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks };
  }
}
