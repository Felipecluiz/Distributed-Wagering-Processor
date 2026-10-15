import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { InvalidPayloadError } from "../application/errors";
import type {
  ProcessWagerCommand,
  ProcessWagerResult,
} from "../application/process-wager-transaction";
import type { ProcessWager } from "../application/wager-message-handler";
import { ResourceNotFoundError } from "../application/queries";
import type { WagerQueries } from "../application/queries";
import { WagerTransactionStatus as S } from "../domain/wager/wager-transaction";
import { asObject, assertUuid, CORRELATION_HEADER } from "./request";
import { TOKENS } from "./tokens";

/**
 * O status HTTP sai do resultado gravado, inclusive em replays: um replay de REJECTED
 * continua 422 e um de PENDING_REFERENCE continua 202 (ARCHITECTURE.md, seção 10).
 */
const HTTP_STATUS: Record<S, number> = {
  [S.Processed]: 200,
  [S.Rejected]: 422,
  [S.PendingReference]: 202,
  [S.Pending]: 202,
  [S.Failed]: 500,
};

@Controller()
export class WageringController {
  constructor(
    @Inject(TOKENS.processWager) private readonly processWager: ProcessWager,
    @Inject(TOKENS.queries) private readonly queries: WagerQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers(CORRELATION_HEADER) correlationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessWagerResult> {
    if (!idempotencyKey?.trim()) {
      throw new InvalidPayloadError("Idempotency-Key header is required");
    }
    const b = asObject(body);
    // O header é a fonte da verdade: um idempotencyKey no corpo é ignorado.
    const command = {
      idempotencyKey,
      providerId: b.providerId,
      externalTransactionId: b.externalTransactionId,
      playerId: b.playerId,
      walletId: b.walletId,
      roundId: b.roundId,
      gameId: b.gameId,
      kind: b.kind,
      money: b.money,
      referenceExternalTransactionId: b.referenceExternalTransactionId,
    } as ProcessWagerCommand;

    const result = await this.processWager.execute(command, { correlationId });
    res.status(HTTP_STATUS[result.status]);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") transactionId: string) {
    const tx = await this.queries.getTransaction(assertUuid(transactionId, "transactionId"));
    if (!tx) throw new ResourceNotFoundError("transaction", transactionId);
    return tx;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const tx = await this.queries.getTransactionByExternalId(providerId, externalTransactionId);
    if (!tx) throw new ResourceNotFoundError("transaction", `${providerId}/${externalTransactionId}`);
    return tx;
  }
}
