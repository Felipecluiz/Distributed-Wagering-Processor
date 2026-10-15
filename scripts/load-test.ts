/**
 * Teste de carga contra as réplicas do docker compose (bun run up).
 *
 *   bun run test:load
 *
 * Variáveis (todas opcionais):
 *   TARGETS          http://localhost:3001,http://localhost:3002,http://localhost:3003
 *   DURATION_S       30     duração da carga, em segundos
 *   CONCURRENCY      50     requisições em voo ao mesmo tempo
 *   WALLETS          200    wallets "normais" (a carga se espalha entre elas)
 *   HOT_FRACTION     0.2    fração das requisições numa única wallet (hot wallet)
 *   REPLAY_FRACTION  0.1    fração de reenvios idênticos (mesma Idempotency-Key)
 *
 * O que mede: throughput, latência p50/p95/p99 por tipo de operação, distribuição de status,
 * conflitos de lock, duplicatas, retries e lag da outbox (pelo /metrics das réplicas).
 *
 * O que prova no fim: o saldo de cada wallet é exatamente o esperado pelas operações aceitas,
 * a reconciliação (saldo x ledger) fecha em todas, e nenhum reenvio gerou efeito novo.
 * Sai com código 1 se qualquer verificação falhar.
 */
import os from "node:os";

// ───────────────────────── configuração ─────────────────────────

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const TARGETS = env("TARGETS", "http://localhost:3001,http://localhost:3002,http://localhost:3003")
  .split(",")
  .map((t) => t.trim().replace(/\/$/, ""));
const DURATION_S = Number(env("DURATION_S", "30"));
const CONCURRENCY = Number(env("CONCURRENCY", "50"));
const WALLETS = Number(env("WALLETS", "200"));
const HOT_FRACTION = Number(env("HOT_FRACTION", "0.2"));
const REPLAY_FRACTION = Number(env("REPLAY_FRACTION", "0.1"));

const RUN = crypto.randomUUID().slice(0, 8);
const NORMAL_INITIAL_CENTS = 100_000_000n; // 1.000.000,00: BETs nunca ficam sem saldo
const HOT_INITIAL_CENTS = 1_000_000_000n; // 10.000.000,00

// ───────────────────────── utilitários ─────────────────────────

/** Dinheiro sempre em centavos inteiros (bigint) e string com 2 casas: nada de float. */
const fmt = (cents: bigint) => {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
};
const parseCents = (amount: string) => {
  const [int, frac = "00"] = amount.split(".");
  const sign = int!.startsWith("-") ? -1n : 1n;
  return sign * (BigInt(int!.replace("-", "")) * 100n + BigInt(frac.padEnd(2, "0")));
};
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
let rr = 0;
const nextTarget = () => TARGETS[rr++ % TARGETS.length]!;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

// ───────────────────────── métricas das réplicas ─────────────────────────

type Series = Map<string, number>;

async function scrape(target: string): Promise<Series> {
  const text = await (await fetch(`${target}/metrics`)).text();
  const series: Series = new Map();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.lastIndexOf(" ");
    series.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return series;
}

/** Soma os contadores de todas as réplicas (gauges do banco se repetem: use uma réplica só). */
async function scrapeAll(): Promise<Series> {
  const total: Series = new Map();
  for (const s of await Promise.all(TARGETS.map(scrape))) {
    for (const [k, v] of s) total.set(k, (total.get(k) ?? 0) + v);
  }
  return total;
}

function delta(before: Series, after: Series, prefix: string): Array<[string, number]> {
  return [...after]
    .filter(([k]) => k.startsWith(prefix) && !k.includes("_bucket"))
    .map(([k, v]) => [k, v - (before.get(k) ?? 0)] as [string, number])
    .filter(([, v]) => v !== 0)
    .sort();
}

const sumDelta = (before: Series, after: Series, prefix: string) =>
  delta(before, after, prefix).reduce((acc, [, v]) => acc + v, 0);

// ───────────────────────── carga ─────────────────────────

type Wallet = { id: string; playerId: string; expectedCents: bigint; uncertain: boolean };
type Category = "normal" | "hot" | "replay";
type Sent = { key: string; body: Record<string, unknown>; transactionId: string; status: number };

const latencies: Record<Category, number[]> = { normal: [], hot: [], replay: [] };
const statuses = new Map<string, number>();
const sent: Sent[] = [];
let networkErrors = 0;
let replayViolations = 0;
let seq = 0;

async function createWallet(initialCents: bigint): Promise<Wallet> {
  const r = await post(`${nextTarget()}/wallets`, {
    playerId: crypto.randomUUID(),
    initialBalance: { amount: fmt(initialCents), currency: "BRL" },
  });
  if (r.status !== 201) throw new Error(`wallet creation failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id, playerId: r.body.playerId, expectedCents: initialCents, uncertain: false };
}

async function submit(category: Category, key: string, body: Record<string, unknown>) {
  const started = performance.now();
  try {
    const r = await post(`${nextTarget()}/wagering/transactions`, body, { "idempotency-key": key });
    latencies[category].push(performance.now() - started);
    const label = `${r.status} ${r.body?.status ?? r.body?.code ?? ""}`.trim();
    statuses.set(label, (statuses.get(label) ?? 0) + 1);
    return r;
  } catch {
    networkErrors++;
    return undefined;
  }
}

async function newWager(category: "normal" | "hot", w: Wallet) {
  const kind = category === "hot" || Math.random() < 0.7 ? "BET" : "WIN";
  const cents = category === "hot" ? 100n : BigInt(100 + Math.floor(Math.random() * 4_900));
  const ext = `${RUN}-${++seq}`;
  const body = {
    providerId: "load-test",
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.id,
    roundId: `${RUN}-round-${seq}`,
    gameId: "load-test",
    kind,
    money: { amount: fmt(cents), currency: "BRL" },
  };
  const key = `load-test:${ext}`;
  const r = await submit(category, key, body);
  if (!r) {
    w.uncertain = true; // resultado desconhecido: só a reconciliação decide
    return;
  }
  if (r.status === 200 && r.body.status === "PROCESSED") {
    w.expectedCents += kind === "BET" ? -cents : cents;
  }
  if (sent.length < 5_000) sent.push({ key, body, transactionId: r.body?.transactionId, status: r.status });
}

async function replay() {
  if (sent.length === 0) return;
  const original = pick(sent);
  const r = await submit("replay", original.key, original.body);
  if (!r) return;
  // Reenvio idêntico tem de ser replay da mesma transação, com o mesmo status: nunca efeito novo.
  if (!r.body?.idempotentReplay || r.body.transactionId !== original.transactionId || r.status !== original.status) {
    replayViolations++;
  }
}

// ───────────────────────── execução ─────────────────────────

async function main() {
  console.log(`alvos: ${TARGETS.join(", ")}`);
  for (const t of TARGETS) {
    const r = await fetch(`${t}/health/ready`).catch(() => undefined);
    if (r?.status !== 200) throw new Error(`${t} não está pronto (rode "bun run up")`);
  }

  console.log(`criando ${WALLETS} wallets + 1 hot wallet...`);
  const wallets: Wallet[] = [];
  for (let i = 0; i < WALLETS; i += 20) {
    wallets.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, () => createWallet(NORMAL_INITIAL_CENTS)))));
  }
  const hot = await createWallet(HOT_INITIAL_CENTS);

  const before = await scrapeAll();
  console.log(`carga: ${DURATION_S}s, ${CONCURRENCY} em paralelo, hot ${HOT_FRACTION * 100}%, replay ${REPLAY_FRACTION * 100}%...`);

  const started = performance.now();
  const deadline = started + DURATION_S * 1_000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < deadline) {
        const roll = Math.random();
        if (roll < REPLAY_FRACTION) await replay();
        else if (roll < REPLAY_FRACTION + HOT_FRACTION) await newWager("hot", hot);
        else await newWager("normal", pick(wallets));
      }
    }),
  );
  const elapsedS = (performance.now() - started) / 1_000;

  // Lag da outbox: quanto tempo depois do fim da carga até não sobrar evento pendente.
  const drainStarted = performance.now();
  let pendingAtEnd = (await scrape(TARGETS[0]!)).get("outbox_pending_events") ?? 0;
  let pending = pendingAtEnd;
  while (pending > 0 && performance.now() - drainStarted < 120_000) {
    await Bun.sleep(250);
    pending = (await scrape(TARGETS[0]!)).get("outbox_pending_events") ?? 0;
  }
  const drainS = (performance.now() - drainStarted) / 1_000;
  const after = await scrapeAll();

  // ───── verificação de consistência ─────
  console.log("verificando saldos e reconciliação...");
  let balanceMismatches = 0;
  let reconciliationFailures = 0;
  for (const w of [...wallets, hot]) {
    const rec = await post(`${nextTarget()}/wallets/${w.id}/reconciliation`, undefined);
    if (!rec.body?.consistent) reconciliationFailures++;
    if (!w.uncertain && parseCents(rec.body.storedBalance.amount) !== w.expectedCents) balanceMismatches++;
  }

  // ───── relatório ─────
  const all = [...latencies.normal, ...latencies.hot, ...latencies.replay];
  const total = all.length;
  const row = (name: string, xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return `| ${name} | ${s.length} | ${percentile(s, 50).toFixed(1)} | ${percentile(s, 95).toFixed(1)} | ${percentile(s, 99).toFixed(1)} | ${(s.at(-1) ?? 0).toFixed(1)} |`;
  };
  const non2xx = [...statuses].filter(([k]) => !k.startsWith("200")).reduce((a, [, v]) => a + v, 0);
  const lagCount = sumDelta(before, after, "outbox_publish_lag_seconds_count");
  const lagSum = sumDelta(before, after, "outbox_publish_lag_seconds_sum");

  const report = `# Resultado do teste de carga (${new Date().toISOString()})

## Ambiente

- Máquina: ${os.cpus()[0]?.model ?? "?"} (${os.cpus().length} núcleos), ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB de RAM, ${os.platform()} ${os.release()}
- Bun ${Bun.version}; alvos: ${TARGETS.length} réplicas (${TARGETS.join(", ")}), mesmo Postgres e mesmo LocalStack, tudo na mesma máquina
- Gerador de carga na mesma máquina que o serviço (compete por CPU com ele)

## Parâmetros

| Duração | Concorrência | Wallets | Hot wallet | Reenvios |
| ------- | ------------ | ------- | ---------- | -------- |
| ${DURATION_S}s | ${CONCURRENCY} | ${WALLETS} + 1 | ${HOT_FRACTION * 100}% das requisições | ${REPLAY_FRACTION * 100}% das requisições |

## Throughput

- Requisições: **${total}** em ${elapsedS.toFixed(1)}s → **${(total / elapsedS).toFixed(0)} req/s**
- Transações novas (sem contar reenvios): ${latencies.normal.length + latencies.hot.length} → ${((latencies.normal.length + latencies.hot.length) / elapsedS).toFixed(0)}/s

## Latência (ms, medida no cliente)

| Operação | n | p50 | p95 | p99 | máx |
| -------- | - | --- | --- | --- | --- |
${row("wallets distribuídas", latencies.normal)}
${row("hot wallet", latencies.hot)}
${row("reenvio idêntico", latencies.replay)}
${row("todas", all)}

## Status

| Resposta | Quantidade |
| -------- | ---------- |
${[...statuses].sort().map(([k, v]) => `| ${k} | ${v} |`).join("\n")}
| erro de rede | ${networkErrors} |

- Taxa de erro (respostas não-200 + erros de rede): **${(((non2xx + networkErrors) / Math.max(1, total + networkErrors)) * 100).toFixed(2)}%**

## Métricas do serviço (diferença antes/depois, somando as réplicas)

| Métrica | Valor |
| ------- | ----- |
| conflitos de lock (\`db_lock_conflicts_total\`) | ${sumDelta(before, after, "db_lock_conflicts_total")} |
| duplicatas detectadas (\`wager_duplicates_detected_total\`) | ${sumDelta(before, after, "wager_duplicates_detected_total")} |
| falhas (\`wager_requests_failed_total\`) | ${sumDelta(before, after, "wager_requests_failed_total")} |
| retries (\`retries_total\`) | ${sumDelta(before, after, "retries_total")} |
| eventos publicados (\`outbox_events_published_total\`) | ${sumDelta(before, after, "outbox_events_published_total")} |
| lag médio de publicação (\`outbox_publish_lag_seconds\`) | ${lagCount > 0 ? ((lagSum / lagCount) * 1000).toFixed(0) + " ms" : "n/a"} |
| eventos pendentes ao fim da carga | ${pendingAtEnd} |
| tempo para zerar a outbox após a carga | ${drainS.toFixed(1)}s${pending > 0 ? " (não zerou em 120s)" : ""} |

## Consistência após a carga

| Verificação | Resultado |
| ----------- | --------- |
| saldo de cada wallet = esperado pelas operações aceitas | ${balanceMismatches === 0 ? "ok" : `**${balanceMismatches} divergências**`} (${[...wallets, hot].filter((w) => w.uncertain).length} wallets com resultado incerto por erro de rede, checadas só pela reconciliação) |
| reconciliação (saldo == ledger) em ${wallets.length + 1} wallets | ${reconciliationFailures === 0 ? "ok" : `**${reconciliationFailures} falhas**`} |
| reenvios idênticos devolveram a mesma transação, sem efeito novo | ${replayViolations === 0 ? "ok" : `**${replayViolations} violações**`} |
`;

  console.log("\n" + report);
  const file = `load-test-results/${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  await Bun.write(file, report);
  console.log(`relatório salvo em ${file}`);

  if (balanceMismatches + reconciliationFailures + replayViolations > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
