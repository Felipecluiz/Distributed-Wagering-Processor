import { describe, expect, test } from 'bun:test';
import {
  ReconcileWalletUseCase, ReconciliationReader, ReconciliationResult, ReconciliationSnapshot,
} from './reconcile-wallet';
import { ResourceNotFoundError } from './queries';

// Os triggers do banco impedem criar uma divergência de verdade, então o caminho de
// divergência é testado aqui com um leitor falso. O caminho consistente é testado contra
// o Postgres em test/http/api.spec.ts.
const reader = (s?: ReconciliationSnapshot): ReconciliationReader => ({ snapshot: async () => s });

describe('ReconcileWalletUseCase', () => {
  test('saldo igual ao ledger é consistente e não sinaliza divergência', async () => {
    const seen: ReconciliationResult[] = [];
    const uc = new ReconcileWalletUseCase(
      reader({ walletId: 'w1', currency: 'BRL', storedBalance: '975.00', calculatedBalance: '975.00', entries: 42 }),
      (r) => seen.push(r),
    );

    const r = await uc.execute('w1');

    expect(r).toEqual({
      walletId: 'w1',
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 42,
    });
    expect(seen).toHaveLength(0);
  });

  test('divergência é sinalizada na resposta e repassada ao hook, sem corrigir nada', async () => {
    const seen: ReconciliationResult[] = [];
    const uc = new ReconcileWalletUseCase(
      reader({ walletId: 'w1', currency: 'BRL', storedBalance: '100.00', calculatedBalance: '90.00', entries: 3 }),
      (r) => seen.push(r),
    );

    const r = await uc.execute('w1');

    expect(r.consistent).toBe(false);
    expect(r.difference).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(seen).toEqual([r]);
  });

  test('wallet inexistente é ResourceNotFoundError', async () => {
    const uc = new ReconcileWalletUseCase(reader(undefined));
    await expect(uc.execute('nope')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
