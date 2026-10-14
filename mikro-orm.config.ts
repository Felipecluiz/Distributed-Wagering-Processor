import "reflect-metadata";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import {
  InboxMessageEntity,
  LedgerEntryEntity,
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
} from "./src/infrastructure/persistence/entities";

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/wagering",
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    LedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: "./migrations",
    pathTs: "./migrations",
    glob: "!(*.d).{js,ts}",
    transactional: true, // cada migration roda em uma transação
    allOrNothing: true, // se uma falhar, desfaz o lote inteiro
    snapshot: false, // as migrations são escritas à mão, sem snapshot
  },
});
