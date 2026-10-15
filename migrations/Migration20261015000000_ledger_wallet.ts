import { Migration } from '@mikro-orm/migrations';

/**
 * Vincula cada lançamento do ledger à versão da wallet que ele produziu.
 *
 * Antes: o encadeamento (balance_before = balance_after anterior) dependia do lock da wallet.
 * Duas transações sem lock podiam ler o mesmo "anterior" e gravar lançamentos paralelos (fork).
 *
 * Agora: UNIQUE (wallet_id, wallet_version) torna o fork impossível no schema. A segunda
 * transação que tentar gravar a mesma versão espera a primeira e falha com unique_violation,
 * com ou sem lock na aplicação.
 *
 * Regras impostas:
 *   - wallet_version >= 1 e única por wallet;
 *   - cada lançamento tem wallet_version = versão anterior + 1, sem buracos;
 *   - balance_before = balance_after do lançamento de versão anterior;
 *   - primeiro lançamento: balance_before = 0 e versão 1 (OPENING) ou 2 (wallet aberta com 0);
 *   - no COMMIT: wallets.balance e wallets.version batem com o último lançamento
 *     (ou balance = 0 e version = 1 quando não há lançamentos).
 */
export class Migration20261015000000_ledger_wallet_version extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE wallet_ledger_entries ADD COLUMN wallet_version integer;`);

    // Backfill: o último lançamento corresponde à versão atual da wallet; cada lançamento
    // anterior é uma versão abaixo. Funciona para wallets abertas com e sem saldo inicial.
    // O ledger é imutável, então o trigger é desligado só durante o backfill.
    this.addSql(`ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_no_update_delete_trg;`);
    this.addSql(`
      UPDATE wallet_ledger_entries l
         SET wallet_version = w.version - (
               SELECT count(*) FROM wallet_ledger_entries l2
                WHERE l2.wallet_id = l.wallet_id AND l2.seq > l.seq
             )
        FROM wallets w
       WHERE w.id = l.wallet_id;
    `);
    this.addSql(`ALTER TABLE wallet_ledger_entries ENABLE TRIGGER ledger_no_update_delete_trg;`);

    this.addSql(`ALTER TABLE wallet_ledger_entries ALTER COLUMN wallet_version SET NOT NULL;`);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT wle_wallet_version_positive CHECK (wallet_version >= 1),
        ADD CONSTRAINT wle_wallet_version_uq UNIQUE (wallet_id, wallet_version);
    `);

    // Encadeamento por versão (não mais por seq).
    this.addSql(`
      CREATE OR REPLACE FUNCTION ledger_chain_check() RETURNS trigger AS $$
      DECLARE
        prev_balance numeric(20,2);
        prev_version integer;
      BEGIN
        SELECT balance_after, wallet_version INTO prev_balance, prev_version
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 OR NEW.wallet_version NOT IN (1, 2) THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: first entry must start at 0 with version 1 or 2 (got before %, version %)',
              NEW.wallet_id, NEW.balance_before, NEW.wallet_version
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW.wallet_version <> prev_version + 1 THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: expected version %, got %',
            NEW.wallet_id, prev_version + 1, NEW.wallet_version
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance_before <> prev_balance THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: expected balance_before %, got %',
            NEW.wallet_id, prev_balance, NEW.balance_before
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Consistência no COMMIT: saldo E versão da wallet batem com o último lançamento.
    this.addSql(`
      CREATE OR REPLACE FUNCTION wallet_balance_matches_ledger() RETURNS trigger AS $$
      DECLARE
        w_id uuid;
        w_balance numeric(20,2);
        w_version integer;
        last_balance numeric(20,2);
        last_version integer;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN w_id := NEW.id; ELSE w_id := NEW.wallet_id; END IF;

        SELECT balance, version INTO w_balance, w_version FROM wallets WHERE id = w_id;
        SELECT balance_after, wallet_version INTO last_balance, last_version
          FROM wallet_ledger_entries
         WHERE wallet_id = w_id
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF NOT FOUND THEN
          last_balance := 0;
          last_version := 1;
        END IF;

        IF w_balance <> last_balance OR w_version <> last_version THEN
          RAISE EXCEPTION 'wallet % (balance %, version %) diverges from ledger (balance %, version %)',
            w_id, w_balance, w_version, last_balance, last_version
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // O trigger deferido da wallet também precisa disparar quando só a versão muda.
    this.addSql(`DROP TRIGGER wallets_ledger_consistency_trg ON wallets;`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency_trg
        AFTER INSERT OR UPDATE OF balance, version ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_balance_matches_ledger();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER wallets_ledger_consistency_trg ON wallets;`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency_trg
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_balance_matches_ledger();
    `);

    // Restaura as funções originais da migration inicial.
    this.addSql(`
      CREATE OR REPLACE FUNCTION wallet_balance_matches_ledger() RETURNS trigger AS $$
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
      CREATE OR REPLACE FUNCTION ledger_chain_check() RETURNS trigger AS $$
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

    // DROP COLUMN remove junto o CHECK e o UNIQUE.
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP COLUMN wallet_version;`);
  }
}
