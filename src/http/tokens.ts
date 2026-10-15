/** Tokens de injeção. Todo provider é injetado por token explícito (sem depender de reflection). */
export const TOKENS = {
  config: "AppConfig",
  orm: "MikroORM",
  clock: "Clock",
  ids: "IdGenerator",
  uow: "UnitOfWork",
  queries: "WagerQueries",
  providerIdentity: "ProviderIdentityPort",
  processWager: "ProcessWagerTransactionUseCase",
  createWallet: "CreateWalletUseCase",
  resolvePending: "ResolvePendingReferencesUseCase",
  reconcile: "ReconcileWalletUseCase",
} as const;
