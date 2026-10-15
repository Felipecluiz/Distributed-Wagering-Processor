import { MikroORM } from "@mikro-orm/core";
import { InvalidPayloadError } from "../../application/errors";
import {
  LedgerEntryView,
  LedgerPage,
  WagerQueries,
  WagerTransactionView,
  WalletView,
} from "../../application/queries";
import {
  ReconciliationReader,
  ReconciliationSnapshot,
} from "../../application/reconcile-wallet";

const money = (amount: string, currency: string) => ({
  amount,
  currency: currency.trim(),
});
const iso = (d: Date | string) => new Date(d).toISOString();
const optional = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

/**
 * Lado de leitura em SQL direto: sem identity map, sem lock e sem passar valores
 * monetários por `number` (todo `numeric` sai como texto).
 */
export class MikroReadModels implements WagerQueries, ReconciliationReader {
  constructor(private readonly orm: MikroORM) {}

  private query(sql: string, params: unknown[]): Promise<any[]> {
    return this.orm.em.getConnection().execute(sql, params);
  }

  async getWallet(walletId: string): Promise<WalletView | undefined> {
    const [r] = await this.query(
      `select id, player_id, currency, balance::text as balance, version, created_at, updated_at
         from wallets where id = ?`,
      [walletId],
    );
    if (!r) return undefined;
    return {
      id: r.id,
      playerId: r.player_id,
      balance: money(r.balance, r.currency),
      version: Number(r.version),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async getLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPage> {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await this.query(
      `select seq, id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after,
              wallet_version, created_at
         from wallet_ledger_entries
        where wallet_id = ? and (?::bigint is null or seq < ?::bigint)
        order by seq desc
        limit ?`,
      [walletId, after, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    const items: LedgerEntryView[] = page.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      direction: r.direction,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balance_before, r.currency),
      balanceAfter: money(r.balance_after, r.currency),
      walletVersion: Number(r.wallet_version),
      createdAt: iso(r.created_at),
    }));
    return {
      items,
      nextCursor:
        rows.length > limit ? encodeCursor(String(page.at(-1).seq)) : undefined,
    };
  }

  async getTransaction(id: string): Promise<WagerTransactionView | undefined> {
    const [r] = await this.query(`${TX_SELECT} where id = ?`, [id]);
    return r ? toTransactionView(r) : undefined;
  }

  async getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView | undefined> {
    const [r] = await this.query(
      `${TX_SELECT} where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return r ? toTransactionView(r) : undefined;
  }

  /** Um único SELECT: saldo gravado e soma do ledger saem do mesmo snapshot. */
  async snapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    const [r] = await this.query(
      `select w.id, w.currency, w.balance::text as stored,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)
                ::numeric(20,2)::text as calculated,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!r) return undefined;
    return {
      walletId: r.id,
      currency: r.currency.trim(),
      storedBalance: r.stored,
      calculatedBalance: r.calculated,
      entries: Number(r.entries),
    };
  }
}

const TX_SELECT = `
  select id, provider_id, external_transaction_id, wallet_id, player_id, round_id, game_id, kind,
         amount::text as amount, currency, status, failure_code,
         reference_external_transaction_id, reference_transaction_id,
         balance_observed::text as balance_observed, created_at, processed_at
    from wager_transactions`;

function toTransactionView(r: any): WagerTransactionView {
  return {
    transactionId: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind,
    money: money(r.amount, r.currency),
    status: r.status,
    failureCode: optional(r.failure_code),
    referenceExternalTransactionId: optional(r.reference_external_transaction_id),
    referenceTransactionId: optional(r.reference_transaction_id),
    balanceObserved: money(r.balance_observed, r.currency),
    createdAt: iso(r.created_at),
    processedAt: r.processed_at ? iso(r.processed_at) : undefined,
  };
}

/** Cursor opaco = base64url(seq). Estável: seq é identity e nunca muda. */
function encodeCursor(seq: string): string {
  return Buffer.from(seq, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  const seq = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d{1,19}$/.test(seq)) throw new InvalidPayloadError("invalid cursor");
  return seq;
}

/** Leituras para os gauges do /metrics (lag da outbox e pendentes). */
export class MikroBacklogReader {
  constructor(private readonly orm: MikroORM) {}

  async outboxPending(): Promise<{ count: number; oldestAgeSeconds: number }> {
    const [r] = await this.orm.em.getConnection().execute(
      `select count(*)::int as count,
              coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as age
         from outbox_messages
        where published_at is null`,
    );
    return { count: Number(r.count), oldestAgeSeconds: Math.max(0, Number(r.age)) };
  }

  async pendingReferences(): Promise<number> {
    const [r] = await this.orm.em.getConnection().execute(
      `select count(*)::int as count from wager_transactions where status = 'PENDING_REFERENCE'`,
    );
    return Number(r.count);
  }
}
