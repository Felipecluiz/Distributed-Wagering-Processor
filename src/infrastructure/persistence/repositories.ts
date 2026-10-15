import { EntityManager, LockMode } from "@mikro-orm/core";
import { Money } from "../../domain/money/money";
import { Wallet } from "../../domain/wallet/wallet";
import { WagerTransaction } from "../../domain/wager/wager-transaction";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  InboxRepository,
  LedgerRepository,
  LockedPendingWager,
  OutboxRepository,
  PendingReferenceClaim,
  StoredWager,
  WagerRepository,
  WalletRepository,
} from "../../application/ports";
import {
  LedgerEntryEntity,
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
} from "./entities";
import {
  applyWager,
  applyWallet,
  walletToDomain,
  wagerToDomain,
} from "./mappers";

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    // FOR UPDATE: bloqueia só ESTA linha. Wallets diferentes seguem em paralelo.
    const e = await this.em.findOne(
      WalletEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return e ? walletToDomain(e) : undefined;
  }

  async save(wallet: Wallet): Promise<void> {
    const e = await this.em.findOneOrFail(WalletEntity, { id: wallet.id }); // vem do identity map (sem query)
    applyWallet(e, wallet);
    await this.em.flush();
  }
  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }
}

export class MikroWagerRepository implements WagerRepository {
  constructor(private readonly em: EntityManager) {}

  findByIdempotencyKey(providerId: string, key: string) {
    return this.find({ providerId, idempotencyKey: key });
  }
  findByExternalId(providerId: string, externalId: string) {
    return this.find({ providerId, externalTransactionId: externalId });
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const n = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId: transactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: "PROCESSED",
    });
    return n > 0; // o índice parcial wt_single_reversal_uq é a barreira final
  }

  async insert(
    tx: WagerTransaction,
    balanceObserved: Money,
    nextReferenceAttemptAt?: Date,
  ): Promise<void> {
    await this.em.insert(WagerTransactionEntity, {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toString(),
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      status: tx.status,
      failureCode: tx.failureCode,
      referenceAttempts: 0,
      nextReferenceAttemptAt,
      processedAt: tx.processedAt,
      balanceObserved: balanceObserved.toString(),
      createdAt: tx.createdAt,
      updatedAt: tx.createdAt,
    });
  }

  // ───── worker de PENDING_REFERENCE ─────

  async claimDuePendingReferences(
    limit: number,
    now: Date,
    leaseUntil: Date,
  ): Promise<PendingReferenceClaim[]> {
    // Só toca linhas de wager_transactions e nunca espera lock (SKIP LOCKED):
    // não entra em ciclo com quem trava a wallet.
    const rows: any[] = await this.em.getConnection().execute(
      `update wager_transactions
          set next_reference_attempt_at = ?, updated_at = ?
        where id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
           order by next_reference_attempt_at
           limit ?
           for update skip locked)
        returning id, wallet_id, reference_attempts`,
      [leaseUntil, now, now, limit],
      "all",
      this.em.getTransactionContext(),
    );
    return rows.map((r) => ({
      id: r.id,
      walletId: r.wallet_id,
      attempts: Number(r.reference_attempts),
    }));
  }

  async lockPendingById(id: string): Promise<LockedPendingWager | undefined> {
    const e = await this.em.findOne(
      WagerTransactionEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return e
      ? {
          transaction: wagerToDomain(e),
          balanceObserved: Money.fromPersisted(e.balanceObserved, e.currency),
          attempts: e.referenceAttempts,
        }
      : undefined;
  }

  async saveResolution(
    tx: WagerTransaction,
    balanceObserved: Money,
    attempts: number,
    nextAttemptAt?: Date,
  ): Promise<void> {
    const e = await this.em.findOneOrFail(WagerTransactionEntity, {
      id: tx.id,
    }); // identity map: já carregada por lockPendingById
    applyWager(e, tx);
    e.balanceObserved = balanceObserved.toString();
    e.referenceAttempts = attempts;
    // Em estado terminal o valor antigo fica: o índice de vencidas filtra por status.
    if (nextAttemptAt) e.nextReferenceAttemptAt = nextAttemptAt;
    await this.em.flush();
  }

  private async find(
    where: Partial<WagerTransactionEntity>,
  ): Promise<StoredWager | undefined> {
    const e = await this.em.findOne(WagerTransactionEntity, where);
    return e
      ? {
          transaction: wagerToDomain(e),
          balanceObserved: Money.fromPersisted(e.balanceObserved, e.currency),
        }
      : undefined;
  }
}

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(e: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryEntity, {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.toString(),
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.toString(),
      balanceAfter: e.balanceAfter.toString(),
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    });
  }

  /** Cursor opaco = base64url(seq). Ordem decrescente por seq (estável, sem duplicar nem pular linhas). */
  async list(walletId: string, cursor: string | undefined, limit: number) {
    const after = cursor
      ? BigInt(Buffer.from(cursor, "base64url").toString("utf8"))
      : null;
    const rows: any[] = await this.em.getConnection().execute(
      `select seq, id, transaction_id, direction, amount, currency,
              balance_before, balance_after, wallet_version, created_at
         from wallet_ledger_entries
        where wallet_id = ? and (?::bigint is null or seq < ?::bigint)
        order by seq desc limit ?`,
      [
        walletId,
        after?.toString() ?? null,
        after?.toString() ?? null,
        limit + 1,
      ],
      "all",
      this.em.getTransactionContext(),
    );
    const page = rows.slice(0, limit);
    const next =
      rows.length > limit
        ? Buffer.from(String(page.at(-1).seq)).toString("base64url")
        : undefined;
    return { items: page, nextCursor: next };
  }
}

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(p: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
    at: Date;
  }) {
    const ctx = this.em.getTransactionContext();
    const conn = this.em.getConnection();
    // processed_at = now: a linha só fica visível junto com o efeito (mesmo COMMIT).
    const inserted: any[] = await conn.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [p.consumerName, p.messageId, p.payloadHash, p.at, p.at],
      "all",
      ctx,
    );
    if (inserted.length > 0) return { created: true as const };
    const rows: any[] = await conn.execute(
      `select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`,
      [p.consumerName, p.messageId],
      "all",
      ctx,
    );
    return {
      created: false as const,
      payloadHash: String(rows[0].payload_hash).trim(),
    };
  }
}

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(m: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageEntity, {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      payload: JSON.parse(JSON.stringify(m.payload)) as Record<string, unknown>,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
    });
  }
  /** Para o publisher: FOR UPDATE SKIP LOCKED. Publishers concorrentes não pegam a mesma linha. */
  async claimDue(limit: number, now: Date): Promise<OutboxMessageEntity[]> {
    return this.em.find(
      OutboxMessageEntity,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: "asc" },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
  }
}
