import { Money, MoneyProps } from "../domain/money/money";
import { Wallet } from "../domain/wallet/wallet";
import {
  INTERNAL_PROVIDER,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../domain/wager/wager-transaction";
import { FailureCode } from "../domain/shared/errors";
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
import { Decision, WagerDecider } from "./wager-decider";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTABLE = [K.Bet, K.Win, K.Loss, K.Refund, K.Rollback];
export const PENDING_RETRY_FIRST_MS = 5_000;

export class ProcessWagerTransactionUseCase {
  private readonly decider: WagerDecider;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    this.decider = new WagerDecider(ids);
  }

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

    // Caminho rápido do replay, sem lock: a transação gravada é a fonte da verdade e seus campos
    // de negócio são imutáveis (trigger), então ler o que já foi commitado é seguro. Um reenvio
    // não entra na fila do lock da wallet só para devolver o resultado (relevante na hot wallet).
    const known = await c.wagers.findByIdempotencyKey(
      input.providerId,
      input.idempotencyKey,
    );
    if (known) return this.replay(known, input);

    const wallet = await c.wallets.lockById(input.walletId); // lock por wallet, nunca global
    if (!wallet) throw new WalletNotFoundError(input.walletId);

    // Rechecagem sob o lock: uma requisição concorrente com a mesma key pode ter commitado entre
    // a leitura acima e o lock. Daqui em diante a wallet está serializada e o replay é determinístico.
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
    const decision = await this.decider.decide(c, wallet, tx, now);
    return this.persist(c, wallet, tx, decision, now, ctx);
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
    await this.decider.enqueueOutcomeEvents(c, tx, wallet, d, {
      correlationId: ctx.correlationId,
      now,
    }); // 4. outbox

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
