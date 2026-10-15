import {
  Entity,
  PrimaryKey,
  PrimaryKeyProp,
  Property,
  Index,
} from "@mikro-orm/core";

@Entity({ tableName: "wallets" })
export class WalletEntity {
  @PrimaryKey({ type: "uuid" }) id!: string;
  @Property({ type: "uuid", fieldName: "player_id" }) playerId!: string;
  @Property({ columnType: "char(3)" }) currency!: string;
  @Property({ type: "string", columnType: "numeric(20,2)" }) balance!: string;
  @Property({ type: "integer" }) version!: number;
  @Property({
    type: "Date",
    fieldName: "created_at",
    columnType: "timestamptz",
  })
  createdAt!: Date;
  @Property({
    type: "Date",
    fieldName: "updated_at",
    columnType: "timestamptz",
  })
  updatedAt!: Date;
}

@Entity({ tableName: "wager_transactions" })
export class WagerTransactionEntity {
  @PrimaryKey({ type: "uuid" }) id!: string;
  @Property({ fieldName: "provider_id" }) providerId!: string;
  @Property({ fieldName: "external_transaction_id" })
  externalTransactionId!: string;
  @Property({ fieldName: "idempotency_key" }) idempotencyKey!: string;
  @Property({ fieldName: "payload_hash", columnType: "char(64)" })
  payloadHash!: string;
  @Property({ type: "uuid", fieldName: "wallet_id" }) walletId!: string;
  @Property({ type: "uuid", fieldName: "player_id" }) playerId!: string;
  @Property({ fieldName: "round_id" }) roundId!: string;
  @Property({ fieldName: "game_id" }) gameId!: string;
  @Property() kind!: string;
  @Property({ type: "string", columnType: "numeric(20,2)" }) amount!: string;
  @Property({ columnType: "char(3)" }) currency!: string;
  @Property({ fieldName: "reference_external_transaction_id", nullable: true })
  referenceExternalTransactionId?: string;
  @Property({
    type: "uuid",
    fieldName: "reference_transaction_id",
    nullable: true,
  })
  referenceTransactionId?: string;
  @Property() status!: string;
  @Property({ fieldName: "failure_code", nullable: true }) failureCode?: string;
  @Property({ type: "integer", fieldName: "reference_attempts" })
  referenceAttempts: number = 0;
  @Property({
    type: "Date",
    fieldName: "next_reference_attempt_at",
    columnType: "timestamptz",
    nullable: true,
  })
  nextReferenceAttemptAt?: Date;
  @Property({
    type: "Date",
    fieldName: "processed_at",
    columnType: "timestamptz",
    nullable: true,
  })
  processedAt?: Date;
  @Property({
    type: "Date",
    fieldName: "created_at",
    columnType: "timestamptz",
  })
  createdAt!: Date;
  @Property({
    type: "Date",
    fieldName: "updated_at",
    columnType: "timestamptz",
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
  @Property({
    type: "string",
    fieldName: "balance_observed",
    columnType: "numeric(20,2)",
  })
  balanceObserved!: string;
}

/** `seq` (identity) é gerado pelo banco e lido só via query para o cursor da paginação. */
@Entity({ tableName: "wallet_ledger_entries" })
export class LedgerEntryEntity {
  @PrimaryKey({ type: "uuid" }) id!: string;
  @Property({ type: "uuid", fieldName: "wallet_id" }) walletId!: string;
  @Property({ type: "uuid", fieldName: "transaction_id" })
  transactionId!: string;
  @Property() direction!: string;
  @Property({ type: "string", columnType: "numeric(20,2)" }) amount!: string;
  @Property({ columnType: "char(3)" }) currency!: string;
  @Property({
    type: "string",
    fieldName: "balance_before",
    columnType: "numeric(20,2)",
  })
  balanceBefore!: string;
  @Property({
    type: "string",
    fieldName: "balance_after",
    columnType: "numeric(20,2)",
  })
  balanceAfter!: string;
  @Property({ type: "integer", fieldName: "wallet_version" })
  walletVersion!: number;
  @Property({
    type: "Date",
    fieldName: "created_at",
    columnType: "timestamptz",
  })
  createdAt!: Date;
}

@Entity({ tableName: "inbox_messages" })
export class InboxMessageEntity {
  @PrimaryKey({ fieldName: "consumer_name" }) consumerName!: string;
  @PrimaryKey({ fieldName: "message_id" }) messageId!: string;
  [PrimaryKeyProp]?: ["consumerName", "messageId"];
  @Property({ fieldName: "payload_hash", columnType: "char(64)" })
  payloadHash!: string;
  @Property({
    type: "Date",
    fieldName: "received_at",
    columnType: "timestamptz",
  })
  receivedAt!: Date;
  @Property({
    type: "Date",
    fieldName: "processed_at",
    columnType: "timestamptz",
    nullable: true,
  })
  processedAt?: Date;
}

@Entity({ tableName: "outbox_messages" })
export class OutboxMessageEntity {
  @PrimaryKey({ type: "uuid" }) id!: string;
  @Property({ fieldName: "aggregate_id" }) aggregateId!: string;
  @Property({ fieldName: "event_type" }) eventType!: string;
  @Property({ type: "json" }) payload!: Record<string, unknown>;
  @Property({
    type: "Date",
    fieldName: "occurred_at",
    columnType: "timestamptz",
  })
  occurredAt!: Date;
  @Property({ type: "integer" }) attempts: number = 0;
  @Property({
    type: "Date",
    fieldName: "next_attempt_at",
    columnType: "timestamptz",
  })
  nextAttemptAt!: Date;
  @Property({
    type: "Date",
    fieldName: "published_at",
    columnType: "timestamptz",
    nullable: true,
  })
  publishedAt?: Date;
  @Property({ fieldName: "last_error", type: "text", nullable: true })
  lastError?: string;
}
