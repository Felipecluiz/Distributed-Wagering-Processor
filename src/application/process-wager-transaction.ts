import { Money, MoneyProps } from "../domain/money/money";
import { Wallet } from "../domain/wallet/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../domain/ledger/wallet-ledger-entry";
import {
  INTERNAL_PROVIDER,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../domain/wager/wager-transaction";
import { BusinessRuleError, FailureCode } from "../domain/shared/errors";
import {
  EventContext,
  WalletBalanceChanged,
} from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../domain/events/wager-events";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { sha256Canonical } from "./canonical-json";
import {
  ConcurrentInsertError,
  IdempotencyConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from "./errors";
import {
  Clock,
  IdGenerator,
  StoredWager,
  TxContext,
  UnitOfWork,
} from "./ports";

export interface ProcessWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface ProcessContext {
  correlationId: string;
  /** Presente quando a origem é SQS. O registro entra na MESMA transação do efeito financeiro. */
  inbox?: { consumerName: string; messageId: string };
}
export interface ProcessWagerResult {
  transactionId: string;
  status: S;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

interface Parsed extends Omit<ProcessWagerCommand, "kind" | "money"> {
  kind: K;
  money: Money;
  payloadHash: string;
}
type Decision =
  | { type: "applied"; entry?: WalletLedgerEntry; referenceId?: string }
  | { type: "pendingReference" }
  | { type: "rejected"; code: FailureCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTABLE = [K.Bet, K.Win, K.Loss, K.Refund, K.Rollback];
const PENDING_RETRY_FIRST_MS = 5_000;

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    cmd: ProcessWagerCommand,
    ctx: ProcessContext,
  ): Promise<ProcessWagerResult> {
    const input = this.parse(cmd);
    // Corrida entre instâncias na mesma key: o UNIQUE barra, e a 2ª tentativa cai no replay.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.uow.run((c) => this.handle(c, input, ctx));
      } catch (e) {
        if (e instanceof ConcurrentInsertError && attempt < 2) continue;
        throw e;
      }
    }
  }

  // ───────────────────────── transação ─────────────────────────
  private async handle(
    c: TxContext,
    input: Parsed,
    ctx: ProcessContext,
  ): Promise<ProcessWagerResult> {
    const now = this.clock.now();

    if (ctx.inbox) {
      const r = await c.inbox.tryReceive({
        ...ctx.inbox,
        payloadHash: input.payloadHash,
        at: now,
      });
      if (!r.created) {
        // Inbox e efeito são atômicos: se a linha existe, o efeito já foi commitado.
        if (r.payloadHash !== input.payloadHash) {
          throw new IdempotencyConflictError(
            "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
            "messageId reused with another payload",
          );
        }
        const stored = await c.wagers.findByIdempotencyKey(
          input.providerId,
          input.idempotencyKey,
        );
        if (stored) return this.replay(stored, input);
        // inbox sem transação: só ocorre se a wallet não existia (rollback) — segue o fluxo normal
      }
    }

    const wallet = await c.wallets.lockById(input.walletId); // lock por wallet, nunca global
    if (!wallet) throw new WalletNotFoundError(input.walletId);

    // Sob o lock da wallet as requisições da mesma wallet estão serializadas: o replay é determinístico.
    const byKey = await c.wagers.findByIdempotencyKey(
      input.providerId,
      input.idempotencyKey,
    );
    if (byKey) return this.replay(byKey, input);
    const byExternal = await c.wagers.findByExternalId(
      input.providerId,
      input.externalTransactionId,
    );
    if (byExternal) {
      throw new IdempotencyConflictError(
        "EXTERNAL_ID_REUSED",
        "externalTransactionId already used with a different Idempotency-Key",
      );
    }

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });

    // Todas as validações acontecem ANTES de mutar a wallet em memória.
    const decision = await this.decide(c, wallet, tx, now);
    return this.persist(c, wallet, tx, decision, now, ctx);
  }

  /** Regras de negócio. Nunca lança BusinessRuleError: devolve a decisão. */
  private async decide(
    c: TxContext,
    wallet: Wallet,
    tx: WagerTransaction,
    now: Date,
  ): Promise<Decision> {
    if (tx.playerId !== wallet.playerId)
      return reject(FailureCode.PlayerWalletMismatch);
    if (tx.money.currency !== wallet.currency)
      return reject(FailureCode.CurrencyMismatch);

    let reference: WagerTransaction | undefined;
    if (tx.requiresReference()) {
      const stored = await c.wagers.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId!,
      );
      if (!stored) return { type: "pendingReference" };
      reference = stored.transaction;
      const verdict = this.checkReference(tx, reference);
      if (verdict === "pending") return { type: "pendingReference" };
      if (verdict) return reject(verdict);
      if (await c.wagers.isReversed(reference.id))
        return reject(FailureCode.AlreadyReversed);
    }

    if (!tx.affectsBalance())
      return { type: "applied", referenceId: reference?.id }; // LOSS

    const movement = {
      entryId: this.ids.next(),
      transactionId: tx.id,
      money: tx.money,
      at: now,
      insufficientCode:
        tx.kind === K.Bet ? undefined : FailureCode.ReversalWouldOverdraw,
    };
    try {
      const entry =
        tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
      return { type: "applied", entry, referenceId: reference?.id };
    } catch (e) {
      if (e instanceof BusinessRuleError) return reject(e.failureCode);
      throw e;
    }
  }

  private checkReference(
    tx: WagerTransaction,
    ref: WagerTransaction,
  ): FailureCode | "pending" | undefined {
    if (
      ref.playerId !== tx.playerId ||
      ref.walletId !== tx.walletId ||
      ref.roundId !== tx.roundId ||
      ref.money.currency !== tx.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    const allowed = tx.kind === K.Refund ? [K.Bet] : [K.Bet, K.Win, K.Refund];
    if (!allowed.includes(ref.kind)) return FailureCode.InvalidReferenceKind;
    if (ref.status === S.Pending || ref.status === S.PendingReference)
      return "pending"; // a referência também espera
    if (ref.status !== S.Processed) return FailureCode.ReferenceNotProcessed;
    if (!ref.money.equals(tx.money)) return FailureCode.AmountMismatch;
    return undefined;
  }

  /** Aplica o estado final no agregado e grava tudo, na ordem exigida pelas FKs. */
  private async persist(
    c: TxContext,
    wallet: Wallet,
    tx: WagerTransaction,
    d: Decision,
    now: Date,
    ctx: ProcessContext,
  ): Promise<ProcessWagerResult> {
    let nextReferenceAttemptAt: Date | undefined;
    if (d.type === "applied") tx.markProcessed(d.referenceId, now);
    else if (d.type === "rejected") tx.reject(d.code);
    else {
      tx.markPendingReference();
      nextReferenceAttemptAt = new Date(now.getTime() + PENDING_RETRY_FIRST_MS);
    }

    const balance = wallet.balance;
    await c.wagers.insert(tx, balance, nextReferenceAttemptAt); // 1. transação (FK do ledger)
    if (d.type === "applied" && d.entry) {
      await c.ledger.insert(d.entry); // 2. ledger
      await c.wallets.save(wallet); // 3. saldo + version
    }

    const evCtx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: tx.id,
      occurredAt: now,
    });
    const enqueue = (e: Parameters<typeof OutboxMessage.enqueue>[0]) =>
      c.outbox.insert(OutboxMessage.enqueue(e));
    if (d.type === "applied") {
      await enqueue(
        WagerTransactionProcessed.from(tx, balance.toJSON(), evCtx()),
      );
      if (d.entry)
        await enqueue(WalletBalanceChanged.from(wallet, d.entry, evCtx()));
    } else if (d.type === "rejected") {
      await enqueue(
        WagerTransactionRejected.from(tx, balance.toJSON(), evCtx()),
      );
    } else {
      await enqueue(
        WagerTransactionPendingReference.from(tx, balance.toJSON(), evCtx()),
      );
    }

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: balance.toJSON(),
      failureCode: tx.failureCode,
      idempotentReplay: false,
    };
  }

  private replay(stored: StoredWager, input: Parsed): ProcessWagerResult {
    const tx = stored.transaction;
    if (!tx.matchesPayload(input.payloadHash)) {
      throw new IdempotencyConflictError(
        "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
        "same Idempotency-Key with a different payload",
      );
    }
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: stored.balanceObserved.toJSON(),
      failureCode: tx.failureCode,
      idempotentReplay: true,
    };
  }

  // ───────────────────────── validação de entrada ─────────────────────────
  private parse(cmd: ProcessWagerCommand): Parsed {
    const str = (v: unknown, name: string): string => {
      if (typeof v !== "string" || v.trim() === "")
        throw new InvalidPayloadError(`${name} is required`);
      return v;
    };
    const idempotencyKey = str(cmd?.idempotencyKey, "Idempotency-Key");
    const providerId = str(cmd.providerId, "providerId");
    if (providerId === INTERNAL_PROVIDER)
      throw new InvalidPayloadError('providerId "internal" is reserved');
    const externalTransactionId = str(
      cmd.externalTransactionId,
      "externalTransactionId",
    );
    const playerId = str(cmd.playerId, "playerId");
    const walletId = str(cmd.walletId, "walletId");
    if (!UUID.test(playerId) || !UUID.test(walletId))
      throw new InvalidPayloadError("playerId/walletId must be UUIDs");
    const roundId = str(cmd.roundId, "roundId");
    const gameId = str(cmd.gameId, "gameId");

    const kind = cmd.kind as K;
    if (!SUBMITTABLE.includes(kind))
      throw new InvalidPayloadError(
        `kind must be one of ${SUBMITTABLE.join(", ")}`,
      );

    let money: Money;
    try {
      money = Money.from(cmd.money);
    } catch (e) {
      throw new InvalidPayloadError((e as Error).message);
    }
    if (kind !== K.Loss && !money.isPositive())
      throw new InvalidPayloadError("amount must be greater than zero");

    const needsRef = kind === K.Refund || kind === K.Rollback;
    const ref = cmd.referenceExternalTransactionId;
    if (needsRef && !ref)
      throw new InvalidPayloadError(
        `${kind} requires referenceExternalTransactionId`,
      );
    if (!needsRef && ref)
      throw new InvalidPayloadError(
        `${kind} must not carry referenceExternalTransactionId`,
      );

    // Hash só dos campos de negócio (sem header nem metadados). Money normalizado.
    const payloadHash = sha256Canonical({
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: ref,
    });
    return {
      ...cmd,
      idempotencyKey,
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money,
      referenceExternalTransactionId: ref,
      payloadHash,
    };
  }
}

const reject = (code: FailureCode): Decision => ({ type: "rejected", code });
