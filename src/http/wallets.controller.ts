import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { CreateWalletUseCase } from "../application/create-wallet";
import type { CreateWalletCommand } from "../application/create-wallet";
import { ResourceNotFoundError } from "../application/queries";
import type { WagerQueries } from "../application/queries";
import { ReconcileWalletUseCase } from "../application/reconcile-wallet";
import { asObject, assertUuid, parseLimit } from "./request";
import { TOKENS } from "./tokens";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(TOKENS.createWallet) private readonly createWallet: CreateWalletUseCase,
    @Inject(TOKENS.queries) private readonly queries: WagerQueries,
    @Inject(TOKENS.reconcile) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  /** 201; wallet duplicada para o mesmo player e moeda é 409 WALLET_ALREADY_EXISTS. */
  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    const b = asObject(body);
    return this.createWallet.execute({
      playerId: b.playerId,
      initialBalance: b.initialBalance,
    } as CreateWalletCommand);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    const wallet = await this.queries.getWallet(assertUuid(walletId, "walletId"));
    if (!wallet) throw new ResourceNotFoundError("wallet", walletId);
    return wallet;
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    const id = assertUuid(walletId, "walletId");
    const pageSize = parseLimit(limit);
    if (!(await this.queries.getWallet(id))) throw new ResourceNotFoundError("wallet", id);
    return this.queries.getLedger(id, cursor || undefined, pageSize);
  }

  /** Divergência não é corrigida: volta com consistent=false e vai para log e métrica. */
  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string) {
    return this.reconcileWallet.execute(assertUuid(walletId, "walletId"));
  }
}
