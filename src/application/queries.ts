import { MoneyProps } from "../domain/money/money";

/** Recurso consultado não existe. HTTP 404. */
export class ResourceNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
    this.name = "ResourceNotFoundError";
  }
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: "DEBIT" | "CREDIT";
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Ausente na última página. */
  nextCursor?: string;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  /** Saldo da wallet no momento da decisão (o mesmo devolvido em replays). */
  balanceObserved: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

/** Lado de leitura. Consultas não passam pelo Unit of Work nem travam nada. */
export interface WagerQueries {
  getWallet(walletId: string): Promise<WalletView | undefined>;
  /** Cursor opaco; ordem decrescente (mais recente primeiro). */
  getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;
  getTransaction(transactionId: string): Promise<WagerTransactionView | undefined>;
  getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView | undefined>;
}
