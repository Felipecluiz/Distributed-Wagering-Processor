# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND,
ROLLBACK) vindas de vários provedores, por HTTP e por SQS. Ele continua correto com mensagens
duplicadas, fora de ordem e processadas ao mesmo tempo por várias instâncias.

**Stack:** Bun 1.2 · TypeScript strict · NestJS 11 · PostgreSQL 16 · MikroORM 6 · SQS (LocalStack) · Docker Compose

As decisões de projeto, os trade-offs e as limitações estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Em resumo

- **O banco é o guardião das invariantes.** Saldo não negativo, idempotência, reversão única,
  ledger imutável e sem bifurcação, saldo igual ao ledger: tudo imposto por constraints e
  triggers, mesmo se o código tiver bug.
- **Concorrência por wallet:** `SELECT ... FOR UPDATE` na linha da wallet. Sem lock global;
  wallets diferentes processam em paralelo.
- **Uma transação SQL por operação:** inbox, transação, ledger, saldo e outbox commitam juntos.
- **Idempotência persistente:** `Idempotency-Key` + hash do payload. Repetição devolve o
  resultado original (inclusive o saldo daquele momento); payload diferente é conflito.
- **Mensageria resiliente:** consumer com inbox e ack após o commit, DLQ explícita com motivo,
  outbox com lease e publishers concorrentes, worker de referências fora de ordem.

## Pré-requisitos

- [Bun](https://bun.sh) 1.2 ou superior
- Docker com Docker Compose v2 (o usuário precisa ter acesso ao Docker sem `sudo`, ou rode os
  comandos `docker compose` com `sudo`)

## Subir tudo em containers (3 instâncias)

```bash
bun install
bun run up        # Postgres, LocalStack, migrations e 3 réplicas da aplicação
```

As réplicas ficam em `http://localhost:3001`, `3002` e `3003`, todas contra o mesmo banco e as
mesmas filas.

```bash
docker compose --profile app ps        # migrate "exited (0)" e 3 réplicas "healthy"
curl localhost:3001/health/ready       # {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
bun run logs                           # logs JSON das 3 réplicas
bun run down                           # derruba tudo
```

## Desenvolvimento local

```bash
bun install
bun run db:up             # só Postgres e LocalStack
bun run migration:up      # aplica as migrations no banco "wagering"
bun run start             # API em http://localhost:3000, com consumer, publisher e worker
```

## Testes

Os testes usam PostgreSQL e LocalStack reais, num banco separado (`wagering_test`), para não
disputar trabalho com o servidor de desenvolvimento. Preparação, uma vez só:

```bash
bun run db:up
bun run db:test:create      # cria o banco wagering_test (o volume novo já o cria sozinho)
bun run db:test:migrate     # aplica as migrations nele
```

Depois:

| Comando                    | O que roda                                                                  |
| -------------------------- | --------------------------------------------------------------------------- |
| `bun test`                 | tudo                                                                        |
| `bun run test:unit`        | domínio, mapeamento de erros HTTP, observabilidade                          |
| `bun run test:integration` | constraints do schema, regras de negócio, worker de PENDING_REFERENCE       |
| `bun run test:concurrency` | hot wallet, 50 submissões idênticas em paralelo, 3 processos reais          |
| `bun run test:http`        | a aplicação Nest de verdade: status HTTP, consultas, reconciliação, métricas |
| `bun run test:messaging`   | consumer SQS (redelivery, crash antes do ack, DLQ, retry) e publisher da outbox |
| `bun run test:recovery`    | SIGKILL da aplicação no meio da carga e consistência final após o reinício  |
| `bun run test:load`        | teste de carga contra as 3 réplicas (requer `bun run up`); ver abaixo       |
| `bun run typecheck`        | `tsc --noEmit`                                                              |

O mapa de cada teste obrigatório do desafio para a suíte que o cobre está no
[ARCHITECTURE.md, seção 19](./ARCHITECTURE.md#19-testes).

### Teste de carga

Com o compose de pé (`bun run up`):

```bash
bun run test:load                                  # 30s, 50 em paralelo, 20% hot wallet, 10% reenvios
DURATION_S=60 CONCURRENCY=100 bun run test:load    # parâmetros por variável de ambiente
```

Mede throughput, latência p50/p95/p99 por tipo de operação, status, conflitos de lock e lag da
outbox. No fim confere que o saldo de cada wallet é exatamente o esperado, que a reconciliação
fecha em todas e que nenhum reenvio gerou efeito novo (sai com código 1 se algo falhar). O
relatório fica em `load-test-results/`. Metodologia e análise: [LOAD_TEST.md](./LOAD_TEST.md).

### Migrations

```bash
bun run migration:list      # aplicadas e pendentes
bun run migration:up
bun run migration:down      # desfaz a última (todas têm down)
```

## Usando a API

Os exemplos usam a porta 3000 (`bun run start`). Com o compose, troque por 3001, 3002 ou 3003.

```bash
# Criar wallet (201; duplicada para o mesmo player e moeda é 409)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'

# Submeter uma aposta (Idempotency-Key obrigatório)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<id da wallet>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
# Repetir o mesmo comando devolve o mesmo resultado com "idempotentReplay": true.

# Consultas
curl -s localhost:3000/wallets/<walletId>
curl -s 'localhost:3000/wallets/<walletId>/ledger?limit=50'          # nextCursor para a próxima página
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123

# Reconciliação (saldo gravado x soma do ledger; divergência é sinalizada, nunca corrigida)
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation

# Saúde e métricas
curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics
```

### Status HTTP

| Situação                                                 | Status                                     |
| -------------------------------------------------------- | ------------------------------------------ |
| Processada                                               | 200 (criação de wallet: 201)               |
| Aceita, aguardando a referência (`PENDING_REFERENCE`)    | 202                                        |
| Payload inválido                                         | 400 `INVALID_PAYLOAD`                      |
| Recurso inexistente                                      | 404 `NOT_FOUND`                            |
| Mesma key com payload diferente / id externo reutilizado | 409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` / `EXTERNAL_ID_REUSED` |
| Wallet duplicada                                         | 409 `WALLET_ALREADY_EXISTS`                |
| Rejeição de regra de negócio                             | 422 com `failureCode`                      |
| Falha transitória de infraestrutura                      | 503 com `Retry-After` (reenvie com a mesma key) |

Um replay devolve o mesmo status do resultado original (um replay de rejeição continua 422).
A taxonomia completa de `failureCode` está no [ARCHITECTURE.md, seção 8](./ARCHITECTURE.md#8-taxonomia-de-failurecode).

### Enviando pela fila

```bash
bun scripts/send-wager.ts <walletId> <playerId> BET 25.00
bun scripts/send-wager.ts <walletId> <playerId> REFUND 25.00 <externalTransactionId da BET>
```

O script publica um `WagerTransactionRequested` em `wager-transactions.fifo`. Os eventos de
integração saem em `wager-events.fifo`; mensagens que não podem ser processadas vão para
`wager-transactions-dlq.fifo` com o motivo no atributo `reason`.

## Configuração

Todas por variável de ambiente, validadas no boot (`src/config.ts`).

| Variável                          | Padrão                                                   |
| --------------------------------- | -------------------------------------------------------- |
| `PORT`                            | `3000`                                                   |
| `DATABASE_URL`                    | `postgresql://postgres:postgres@localhost:5432/wagering` |
| `LOG_LEVEL`                       | `log` (`verbose`, `debug`, `log`, `warn`, `error`, `fatal`) |
| `AWS_ENDPOINT_URL` / `AWS_REGION` | `http://localhost:4566` / `us-east-1`                    |
| `SQS_REQUESTS_QUEUE`              | `wager-transactions.fifo`                                |
| `SQS_DLQ`                         | `wager-transactions-dlq.fifo`                            |
| `SQS_EVENTS_QUEUE`                | `wager-events.fifo`                                      |
| `SQS_CREATE_QUEUES`               | `on` (cria as filas no boot se não existirem)            |
| `SQS_CONSUMER`                    | `on`                                                     |
| `SQS_MAX_ATTEMPTS`                | `5` (entregas antes da DLQ em erro transitório)          |
| `SQS_VISIBILITY_TIMEOUT_SECONDS`  | `30`                                                     |
| `OUTBOX_PUBLISHER`                | `on`                                                     |
| `OUTBOX_POLL_MS` / `OUTBOX_LEASE_MS` | `500` / `30000`                                       |
| `OUTBOX_BATCH_SIZE`               | `200` (lote cheio: a próxima rodada começa na hora)      |
| `PENDING_REFERENCE_WORKER`        | `on`                                                     |
| `PENDING_REFERENCE_POLL_MS`       | `1000`                                                   |
| `PENDING_REFERENCE_MAX_ATTEMPTS`  | `8`                                                      |
| `PENDING_REFERENCE_TTL_MS`        | `900000` (15 min)                                        |
| `PENDING_REFERENCE_LEASE_MS`      | `30000`                                                  |
| `PENDING_REFERENCE_BATCH_SIZE`    | `50`                                                     |

## Estrutura

```
migrations/                    migrations versionadas e reversíveis (schema, constraints, triggers)
src/
  domain/                      Money, Wallet, WagerTransaction, WalletLedgerEntry, eventos, inbox/outbox
  application/                 use cases e portas (sem Nest nem MikroORM)
    process-wager-transaction  entrada única de HTTP e SQS
    wager-decider              regras de negócio, compartilhadas com o worker
    resolve-pending-references worker de referências fora de ordem
    wager-message-handler      destino de cada mensagem (ack, retry, DLQ)
    wager-queue-consumer       loop de consumo, ordem por grupo, shutdown
    publish-outbox             publisher com lease
  infrastructure/
    persistence/               MikroORM: Unit of Work, repositórios, leitura
    messaging/                 SQS
    observability/             logger JSON, métricas Prometheus
  http/                        Nest: controllers, filtro de erros, guard, workers
test/
  integration/  concurrency/  http/  messaging/  recovery/
scripts/send-wager.ts          publica uma mensagem na fila de entrada
```

## Autenticação

Não implementada, por decisão de escopo (não pontua no desafio). O desenho proposto (IdP externo
com OIDC) e o ponto de extensão no código (`AuthGuard` global e `ProviderIdentityPort`) estão no
[ARCHITECTURE.md, seção 12](./ARCHITECTURE.md#12-autenticação-decisão-não-implementada).
