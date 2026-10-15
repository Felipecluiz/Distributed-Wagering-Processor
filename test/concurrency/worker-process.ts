import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { ProcessWagerTransactionUseCase } from "../../src/application/process-wager-transaction";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work";
import { systemClock, uuidGenerator } from "../../src/infrastructure/system";

const [walletId, playerId, prefix, count, startAt] = process.argv.slice(
  2,
) as string[];
const orm = await MikroORM.init({ ...config, pool: { min: 2, max: 10 } });
const useCase = new ProcessWagerTransactionUseCase(
  new MikroOrmUnitOfWork(orm),
  systemClock,
  uuidGenerator,
);

await Bun.sleep(Math.max(0, Number(startAt) - Date.now())); // barreira entre processos

const results = await Promise.all(
  Array.from({ length: Number(count) }, (_, i) => {
    const key = `${prefix}-${i}`;
    return useCase.execute(
      {
        idempotencyKey: key,
        providerId: "provider-a",
        externalTransactionId: key,
        playerId: playerId!,
        walletId: walletId!,
        roundId: `round-${key}`,
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      },
      { correlationId: key },
    );
  }),
);

console.log(JSON.stringify(results.map((r) => r.status)));
await orm.close(true);
