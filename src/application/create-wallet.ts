import { Money, MoneyProps } from '../domain/money/money';
import { Wallet } from '../domain/wallet/wallet';
import {
  INTERNAL_PROVIDER, WagerTransaction, WagerTransactionKind,
} from '../domain/wager/wager-transaction';
import { sha256Canonical } from './canonical-json';
import { ConcurrentInsertError, InvalidPayloadError, WalletAlreadyExistsError } from './errors';
import { Clock, IdGenerator, UnitOfWork } from './ports';

export interface CreateWalletCommand { playerId: string; initialBalance: MoneyProps }
export interface CreateWalletResult { id: string; playerId: string; balance: MoneyProps; version: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletResult> {
    if (typeof cmd?.playerId !== 'string' || !UUID.test(cmd.playerId)) {
      throw new InvalidPayloadError('playerId must be a UUID');
    }
    let initial: Money;
    try { initial = Money.from(cmd.initialBalance); }
    catch (e) { throw new InvalidPayloadError((e as Error).message); }

    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingTxId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId, playerId: cmd.playerId, initialBalance: initial, now,
      openingTransactionId: openingTxId, openingEntryId: this.ids.next(),
    });

    try {
      return await this.uow.run(async (c) => {
        await c.wallets.insert(wallet);                       // 1. wallet (FK de tx e ledger)
        if (openingEntry) {
          const tx = WagerTransaction.create({
            id: openingTxId, providerId: INTERNAL_PROVIDER,
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `${INTERNAL_PROVIDER}:opening:${walletId}`,
            payloadHash: sha256Canonical({ walletId, kind: 'OPENING', money: initial.toJSON() }),
            walletId, playerId: cmd.playerId, roundId: 'opening', gameId: 'opening',
            kind: WagerTransactionKind.Opening, money: initial, createdAt: now, allowInternal: true,
          });
          tx.markProcessed(undefined, now);
          await c.wagers.insert(tx, wallet.balance);          // 2. transação OPENING
          await c.ledger.insert(openingEntry);                // 3. CREDIT de abertura
        }
        return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
      });
    } catch (e) {
      // UNIQUE (player_id, currency)
      if (e instanceof ConcurrentInsertError) throw new WalletAlreadyExistsError(cmd.playerId, initial.currency);
      throw e;
    }
  }
}