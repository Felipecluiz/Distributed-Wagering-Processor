import { Migration } from '@mikro-orm/migrations';

export class Migration20261014000100_wager_balance_observed extends Migration {
  async up(): Promise<void> {
    // Saldo da wallet logo após a decisão. Permite devolver o "saldo observado" em replays.
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN balance_observed numeric(20,2) NOT NULL DEFAULT 0;`);
    this.addSql(`ALTER TABLE wager_transactions ALTER COLUMN balance_observed DROP DEFAULT;`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT wt_balance_observed_non_negative CHECK (balance_observed >= 0);`);
  }
  async down(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN balance_observed;`);
  }
}