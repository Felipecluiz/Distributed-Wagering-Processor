/**
 * Registro de métricas no formato de texto do Prometheus (exposition format 0.0.4).
 * Implementação mínima e sem dependências: contadores, histogramas e gauges calculados
 * na hora da coleta. Os nomes de label são fixos por métrica, para manter a cardinalidade
 * sob controle (nunca ids de wallet ou transação como label).
 */

type Labels = Record<string, string>;

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

function renderLabels(names: readonly string[], labels: Labels, extra?: [string, string]): string {
  const pairs = names.map((n) => `${n}="${escapeLabel(labels[n] ?? "")}"`);
  if (extra) pairs.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return pairs.length ? `{${pairs.join(",")}}` : "";
}

const keyOf = (names: readonly string[], labels: Labels) => names.map((n) => labels[n] ?? "").join("\u0000");

interface Metric {
  render(): Promise<string[]>;
}

export class Counter<L extends string = never> implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(readonly name: string, readonly help: string, readonly labelNames: readonly L[] = []) {}

  inc(labels: Partial<Record<L, string>> = {}, by = 1): void {
    if (by <= 0) return;
    const l = labels as Labels;
    const key = keyOf(this.labelNames, l);
    const current = this.values.get(key);
    if (current) current.value += by;
    else this.values.set(key, { labels: { ...l }, value: by });
  }

  /** Valor atual (para testes). */
  get(labels: Partial<Record<L, string>> = {}): number {
    return this.values.get(keyOf(this.labelNames, labels as Labels))?.value ?? 0;
  }

  async render(): Promise<string[]> {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, labels)} ${value}`);
    }
    return lines;
  }
}

export class Histogram<L extends string = never> implements Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly L[] = [],
    readonly buckets: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {}

  observe(labels: Partial<Record<L, string>>, value: number): void {
    const l = labels as Labels;
    const key = keyOf(this.labelNames, l);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: { ...l }, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }

  async render(): Promise<string[]> {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => {
        lines.push(`${this.name}_bucket${renderLabels(this.labelNames, s.labels, ["le", String(b)])} ${s.counts[i]}`);
      });
      lines.push(`${this.name}_bucket${renderLabels(this.labelNames, s.labels, ["le", "+Inf"])} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(this.labelNames, s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(this.labelNames, s.labels)} ${s.count}`);
    }
    return lines;
  }
}

/** Gauge calculado na coleta (ex.: lag da outbox lido do banco). */
export class CollectedGauge implements Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly collect: () => Promise<number>,
  ) {}

  async render(): Promise<string[]> {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    try {
      lines.push(`${this.name} ${await this.collect()}`);
    } catch {
      // Dependência fora do ar: a série some nesta coleta, mas o /metrics continua respondendo.
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics: Metric[] = [];

  register<M extends Metric>(metric: M): M {
    this.metrics.push(metric);
    return metric;
  }

  async render(): Promise<string> {
    const parts = await Promise.all(this.metrics.map((m) => m.render()));
    return parts.flat().join("\n") + "\n";
  }
}
