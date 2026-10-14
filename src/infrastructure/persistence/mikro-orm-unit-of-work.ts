import {
  ConnectionException, DeadlockException, EntityManager, LockWaitTimeoutException,
  MikroORM, UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { ConcurrentInsertError, TransientInfrastructureError } from '../../application/errors';
import { TxContext, UnitOfWork } from '../../application/ports';
import {
  MikroInboxRepository, MikroLedgerRepository, MikroOutboxRepository, MikroWagerRepository, MikroWalletRepository,
} from './repositories';

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly onLockConflict: () => void = () => {}, // hook da métrica "conflitos de lock"
  ) {}

  async run<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    try {
      // fork por execução: identity map isolado, sem estado compartilhado entre requisições.
      return await this.orm.em.fork().transactional(async (em: EntityManager) => {
        // Espera limitada pelo lock da wallet, em vez de ficar pendurado.
        await em.getConnection().execute(`set local lock_timeout = '5s'`, [], 'run', em.getTransactionContext());
        return fn({
          wallets: new MikroWalletRepository(em), wagers: new MikroWagerRepository(em),
          ledger: new MikroLedgerRepository(em), inbox: new MikroInboxRepository(em),
          outbox: new MikroOutboxRepository(em),
        });
      });
    } catch (e) {
      if (e instanceof UniqueConstraintViolationException) throw new ConcurrentInsertError(e);
      if (e instanceof DeadlockException || e instanceof LockWaitTimeoutException) {
        this.onLockConflict();
        throw new TransientInfrastructureError(e);
      }
      if (e instanceof ConnectionException) throw new TransientInfrastructureError(e);
      throw e; // erros de negócio/aplicação e de programação passam intactos (CHECK violado = bug → 500/DLQ)
    }
  }
}