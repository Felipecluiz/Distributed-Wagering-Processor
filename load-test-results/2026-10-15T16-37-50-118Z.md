# Resultado do teste de carga (2026-10-15T16:37:50.118Z)

## Ambiente

- Máquina: Intel(R) Core(TM) i5-10400F CPU @ 2.90GHz (12 núcleos), 31.2 GiB de RAM, linux 7.0.0-38-generic
- Bun 1.2.15; alvos: 3 réplicas (http://localhost:3001, http://localhost:3002, http://localhost:3003), mesmo Postgres e mesmo LocalStack, tudo na mesma máquina
- Gerador de carga na mesma máquina que o serviço (compete por CPU com ele)

## Parâmetros

| Duração | Concorrência | Wallets | Hot wallet | Reenvios |
| ------- | ------------ | ------- | ---------- | -------- |
| 30s | 50 | 200 + 1 | 20% das requisições | 10% das requisições |

## Throughput

- Requisições: **12474** em 30.2s → **414 req/s**
- Transações novas (sem contar reenvios): 11243 → 373/s

## Latência (ms, medida no cliente)

| Operação | n | p50 | p95 | p99 | máx |
| -------- | - | --- | --- | --- | --- |
| wallets distribuídas | 8852 | 52.5 | 176.7 | 239.1 | 357.4 |
| hot wallet | 2391 | 339.8 | 553.1 | 681.9 | 826.3 |
| reenvio idêntico | 1231 | 62.4 | 416.3 | 530.9 | 744.6 |
| todas | 12474 | 72.9 | 429.7 | 554.0 | 826.3 |

## Status

| Resposta | Quantidade |
| -------- | ---------- |
| 200 PROCESSED | 12474 |
| erro de rede | 0 |

- Taxa de erro (respostas não-200 + erros de rede): **0.00%**

## Métricas do serviço (diferença antes/depois, somando as réplicas)

| Métrica | Valor |
| ------- | ----- |
| conflitos de lock (`db_lock_conflicts_total`) | 0 |
| duplicatas detectadas (`wager_duplicates_detected_total`) | 1231 |
| falhas (`wager_requests_failed_total`) | 0 |
| retries (`retries_total`) | 0 |
| eventos publicados (`outbox_events_published_total`) | 22486 |
| lag médio de publicação (`outbox_publish_lag_seconds`) | 29052 ms |
| eventos pendentes ao fim da carga | 15420 |
| tempo para zerar a outbox após a carga | 56.9s |

## Consistência após a carga

| Verificação | Resultado |
| ----------- | --------- |
| saldo de cada wallet = esperado pelas operações aceitas | ok (0 wallets com resultado incerto por erro de rede, checadas só pela reconciliação) |
| reconciliação (saldo == ledger) em 201 wallets | ok |
| reenvios idênticos devolveram a mesma transação, sem efeito novo | ok |
