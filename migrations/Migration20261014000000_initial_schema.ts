import { Migration } from '@mikro-orm/migrations';

export class Migration20261014000000_initial_schema extends Migration {
  async up(): Promise<void> {
    // ───────────────────────── WALLETS ─────────────────────────
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(20,2) NOT NULL,
        version     integer       NOT NULL DEFAULT 1,
        created_at  timestamptz   NOT NULL DEFAULT now(),
        updated_at  timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1),
        CONSTRAINT wallets_currency_format      CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency),
        -- alvo da FK composta do ledger (garante moeda do lançamento = moeda da wallet)
        CONSTRAINT wallets_id_currency_uq       UNIQUE (id, currency)
      );
    `);

    // ───────────────────── WAGER TRANSACTIONS ─────────────────────
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                  uuid          PRIMARY KEY,
        provider_id                         text          NOT NULL,
        external_transaction_id             text          NOT NULL,
        idempotency_key                     text          NOT NULL,
        payload_hash                        char(64)      NOT NULL,
        wallet_id                           uuid          NOT NULL REFERENCES wallets(id),
        player_id                           uuid          NOT NULL,
        round_id                            text          NOT NULL,
        game_id                             text          NOT NULL,
        kind                                text          NOT NULL,
        amount                              numeric(20,2) NOT NULL,
        currency                            char(3)       NOT NULL,
        reference_external_transaction_id   text,
        reference_transaction_id            uuid          REFERENCES wager_transactions(id),
        status                              text          NOT NULL DEFAULT 'PENDING',
        failure_code                        text,
        -- controle do worker de PENDING_REFERENCE
        reference_attempts                  integer       NOT NULL DEFAULT 0,
        next_reference_attempt_at           timestamptz,
        processed_at                        timestamptz,
        created_at                          timestamptz   NOT NULL DEFAULT now(),
        updated_at                          timestamptz   NOT NULL DEFAULT now(),

        CONSTRAINT wt_kind_valid CHECK (kind IN
          ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wt_status_valid CHECK (status IN
          ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wt_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wt_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        -- OPENING é interno e sempre positivo
        CONSTRAINT wt_opening_internal CHECK (
          kind <> 'OPENING' OR (provider_id = 'internal' AND amount > 0)
        ),
        -- REFUND/ROLLBACK exigem referência; os demais não podem ter
        CONSTRAINT wt_reference_required CHECK (
          (kind IN ('REFUND','ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)
        ),
        -- coerência status x campos
        CONSTRAINT wt_failure_code_consistency CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wt_processed_at_consistency CHECK (
          (status = 'PROCESSED') = (processed_at IS NOT NULL)
        ),
        CONSTRAINT wt_reference_id_only_when_processed CHECK (
          reference_transaction_id IS NULL OR status = 'PROCESSED'
        ),

        -- IDEMPOTÊNCIA PERSISTENTE
        CONSTRAINT wt_idempotency_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wt_external_id_uq UNIQUE (provider_id, external_transaction_id)
      );
    `);

    // Uma referência só pode ser revertida UMA vez (REFUND ou ROLLBACK, o que vier primeiro).
    // Interpretação mais estrita que "mesmo tipo": impede REFUND + ROLLBACK da mesma BET
    // creditando duas vezes. Documentar no ARCHITECTURE.md.
    this.addSql(`
      CREATE UNIQUE INDEX wt_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK')
          AND status = 'PROCESSED'
          AND reference_transaction_id IS NOT NULL;
    `);

    // Worker de PENDING_REFERENCE (busca de vencidos)
    this.addSql(`
      CREATE INDEX wt_pending_reference_due_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    // Resolução da referência por (provider, externalId do alvo) já coberta por wt_external_id_uq.
    this.addSql(`CREATE INDEX wt_wallet_created_idx ON wager_transactions (wallet_id, created_at);`);
    this.addSql(`CREATE INDEX wt_round_idx ON wager_transactions (provider_id, round_id);`);

    // Transições válidas + imutabilidade de campos de negócio + sem DELETE
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions are append-only: DELETE not allowed'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        -- campos de negócio imutáveis
        IF NEW.id                    IS DISTINCT FROM OLD.id
        OR NEW.provider_id           IS DISTINCT FROM OLD.provider_id
        OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
        OR NEW.idempotency_key       IS DISTINCT FROM OLD.idempotency_key
        OR NEW.payload_hash          IS DISTINCT FROM OLD.payload_hash
        OR NEW.wallet_id             IS DISTINCT FROM OLD.wallet_id
        OR NEW.player_id             IS DISTINCT FROM OLD.player_id
        OR NEW.round_id              IS DISTINCT FROM OLD.round_id
        OR NEW.game_id               IS DISTINCT FROM OLD.game_id
        OR NEW.kind                  IS DISTINCT FROM OLD.kind
        OR NEW.amount                IS DISTINCT FROM OLD.amount
        OR NEW.currency              IS DISTINCT FROM OLD.currency
        OR NEW.reference_external_transaction_id
                                     IS DISTINCT FROM OLD.reference_external_transaction_id
        OR NEW.created_at            IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wager_transactions business columns are immutable'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        -- estados terminais não mudam
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        -- PENDING -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
        -- PENDING_REFERENCE -> PENDING_REFERENCE (retry) | PROCESSED | REJECTED | FAILED
        IF OLD.status = 'PENDING' AND NEW.status = 'PENDING' THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'invalid transition PENDING_REFERENCE -> PENDING'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_trg
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();
    `);

    // ───────────────────────── LEDGER ─────────────────────────
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq             bigint GENERATED ALWAYS AS IDENTITY,   -- cursor estável
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL REFERENCES wager_transactions(id),
        direction       text          NOT NULL,
        amount          numeric(20,2) NOT NULL,
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL,
        balance_after   numeric(20,2) NOT NULL,
        created_at      timestamptz   NOT NULL DEFAULT now(),

        CONSTRAINT wle_seq_uq UNIQUE (seq),
        CONSTRAINT wle_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT wle_amount_positive CHECK (amount > 0),
        CONSTRAINT wle_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wle_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        ),
        -- no máximo um lançamento por wallet por transação
        CONSTRAINT wle_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        -- moeda do lançamento = moeda da wallet
        CONSTRAINT wle_wallet_currency_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency)
      );
    `);
    this.addSql(`CREATE INDEX wle_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq);`);
    this.addSql(`CREATE INDEX wle_transaction_idx ON wallet_ledger_entries (transaction_id);`);

    // Imutabilidade: sem UPDATE, DELETE nem TRUNCATE
    this.addSql(`
      CREATE FUNCTION ledger_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable (% not allowed)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete_trg
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate_trg
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
    `);

    // Encadeamento: balance_before deve ser o balance_after do lançamento anterior
    // (ou 0 se for o primeiro). Serializado pelo lock da linha da wallet.
    this.addSql(`
      CREATE FUNCTION ledger_chain_check() RETURNS trigger AS $$
      DECLARE prev numeric(20,2);
      BEGIN
        SELECT balance_after INTO prev
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY seq DESC LIMIT 1;
        IF NOT FOUND THEN prev := 0; END IF;
        IF prev <> NEW.balance_before THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: expected balance_before %, got %',
            NEW.wallet_id, prev, NEW.balance_before
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_chain_check_trg
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_chain_check();
    `);

    // ─────── Consistência saldo materializado x ledger (no COMMIT) ───────
    this.addSql(`
      CREATE FUNCTION wallet_balance_matches_ledger() RETURNS trigger AS $$
      DECLARE
        w_id uuid;
        w_balance numeric(20,2);
        last_balance numeric(20,2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN w_id := NEW.id; ELSE w_id := NEW.wallet_id; END IF;

        SELECT balance INTO w_balance FROM wallets WHERE id = w_id;
        SELECT balance_after INTO last_balance
          FROM wallet_ledger_entries
         WHERE wallet_id = w_id
         ORDER BY seq DESC LIMIT 1;
        IF NOT FOUND THEN last_balance := 0; END IF;

        IF w_balance <> last_balance THEN
          RAISE EXCEPTION 'wallet % balance % diverges from ledger %', w_id, w_balance, last_balance
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency_trg
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_balance_matches_ledger();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency_trg
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_balance_matches_ledger();
    `);

    // Regras da wallet: campos imutáveis; version +1 se (e só se) o saldo mudou; sem DELETE
    this.addSql(`
      CREATE FUNCTION wallets_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
           OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet identity columns are immutable'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance <> OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet version must increment by 1 when balance changes'
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet version must not change when balance is unchanged'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wallets_guard_trg
        BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard();
    `);

    // ───────────────────────── INBOX ─────────────────────────
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  char(64)    NOT NULL,
        received_at   timestamptz NOT NULL DEFAULT now(),
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // ───────────────────────── OUTBOX ─────────────────────────
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,           -- = eventId
        aggregate_id    text        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        published_at    timestamptz,
        last_error      text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      );
    `);
    // Publishers: SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now()
    //             ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED
    this.addSql(`
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);
    this.addSql(`CREATE INDEX outbox_aggregate_idx ON outbox_messages (aggregate_id, occurred_at);`);

    // Outbox: payload imutável, sem DELETE (retenção via job de arquivamento, se necessário)
    this.addSql(`
      CREATE FUNCTION outbox_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'outbox_messages cannot be deleted'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.aggregate_id <> OLD.aggregate_id
           OR NEW.event_type <> OLD.event_type OR NEW.payload <> OLD.payload
           OR NEW.occurred_at <> OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox event content is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'outbox message already published'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER outbox_guard_trg
        BEFORE UPDATE OR DELETE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS outbox_guard_trg ON outbox_messages;`);
    this.addSql(`DROP FUNCTION IF EXISTS outbox_guard();`);
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);

    this.addSql(`DROP TRIGGER IF EXISTS wallets_guard_trg ON wallets;`);
    this.addSql(`DROP TRIGGER IF EXISTS wallets_ledger_consistency_trg ON wallets;`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_wallet_consistency_trg ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_chain_check_trg ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_no_update_delete_trg ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_no_truncate_trg ON wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_balance_matches_ledger();`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_guard();`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_chain_check();`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_immutable();`);

    this.addSql(`DROP TRIGGER IF EXISTS wager_transactions_guard_trg ON wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_transactions_guard();`);

    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}