# ARCHITECTURE

Serviço distribuído de processamento de apostas (BET/WIN/LOSS/REFUND/ROLLBACK).
Princípio central: **o banco é o responsável final pelas invariantes**. O código de
aplicação as respeita, mas o schema as impõe mesmo que o código tenha bug.

## 1. Stack e justificativas

- **Bun + TypeScript strict + NestJS**, conforme o desafio.
- **PostgreSQL**: transações ACID, `SELECT ... FOR UPDATE [SKIP LOCKED]`, CHECK, triggers,
  índices parciais.
- **MikroORM** (preferencial): `EntityManager.transactional()` deixa a fronteira de
  transação explícita, e `LockMode.PESSIMISTIC_WRITE` mapeia para `FOR UPDATE`.
  O Unit of Work agrupa wallet, transação, ledger, inbox e outbox em um único commit.
- **SQS (LocalStack)**: entrega at-least-once. FIFO é otimização, não garantia.

## 2. Money

- No domínio: `bigint` em centavos (escala fixa 2). Nenhum `number`/float em dinheiro.
  Não depende de ORM nem de decorators do NestJS.
- Entrada: exige **exatamente 2 casas decimais** (`"25.00"`). Rejeita `"25"`, `"25.5"`,
  vazio, NaN, Infinity, notação científica, sinal, mais de 2 casas e valores negativos.
  **Interpretação adotada:** não há arredondamento nem normalização; qualquer valor fora
  da escala fixa é erro de validação (HTTP 400), nunca é truncado ou completado.
- Saída: sempre string com 2 casas (`"25.00"`).
- Persistência: `numeric(20,2)` + `currency char(3)` em colunas separadas. A reidratação usa
  `Money.fromPersisted`, e o MikroORM lê `numeric` como string (sem passar por `number`).
- `Money.from` rejeita negativos (contratos de entrada). `fromPersisted` e `subtract`
  admitem negativos, usados em diferenças de reconciliação.
- Multi-moeda no modelo; operações entre moedas distintas lançam `CurrencyMismatchError`.

## 3. Schema e garantias no banco

| Garantia                               | Mecanismo                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Saldo não negativo                     | `CHECK (balance >= 0)` em `wallets`                                                                                      |
| Uma wallet por player+moeda            | `UNIQUE (player_id, currency)`                                                                                           |
| Idempotência persistente               | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`                                |
| Replay vs conflito                     | `payload_hash` (SHA-256, ver seção 5) comparado após colisão de unicidade                                                |
| Saldo observado em replay              | Coluna `balance_observed numeric(20,2) NOT NULL CHECK (>= 0)` em `wager_transactions` (migration 2)                      |
| OPENING interno                        | `CHECK`: `provider_id = 'internal'` e `amount > 0`                                                                       |
| Referência exigida por kind            | `CHECK`: `kind IN ('REFUND','ROLLBACK')` ⇔ referência presente                                                           |
| Coerência de status                    | `CHECK`s: `failure_code` ⇔ REJECTED/FAILED; `processed_at` ⇔ PROCESSED                                                   |
| Estados terminais imutáveis            | Trigger `wager_transactions_guard` (bloqueia UPDATE em PROCESSED/REJECTED/FAILED, mudança de campos de negócio e DELETE) |
| Reversão única                         | Índice único parcial `wt_single_reversal_uq` sobre `reference_transaction_id` (REFUND/ROLLBACK PROCESSED)                |
| Ledger imutável                        | Triggers que bloqueiam UPDATE, DELETE e TRUNCATE                                                                         |
| Aritmética do lançamento               | `CHECK`: `balance_after = balance_before ± amount`                                                                       |
| Um lançamento por wallet por transação | `UNIQUE (wallet_id, transaction_id)`                                                                                     |
| Moeda do lançamento = moeda da wallet  | FK composta `(wallet_id, currency) → wallets(id, currency)`                                                              |
| Encadeamento do ledger                 | Trigger `ledger_chain_check`: `balance_before` = `balance_after` anterior (ou 0)                                         |
| Saldo == ledger                        | Constraint triggers `DEFERRABLE INITIALLY DEFERRED`, validados no COMMIT                                                 |
| `version`                              | Trigger `wallets_guard`: +1 se e somente se o saldo mudou                                                                |
| Inbox dedup                            | `PRIMARY KEY (consumer_name, message_id)`                                                                                |
| Outbox                                 | Conteúdo imutável; sem UPDATE após publicado; sem DELETE                                                                 |

### Interpretação: reversão única

O desafio diz "uma referência não pode ser revertida duas vezes **pelo mesmo tipo**".
Adotamos regra **mais estrita**: uma referência só pode ter **uma** reversão PROCESSED
(REFUND _ou_ ROLLBACK). Sem isso, REFUND + ROLLBACK da mesma BET creditariam duas vezes.
Falha: `ALREADY_REVERSED`.

### OPENING

Usa `provider_id = 'internal'` e `external_transaction_id = 'opening:<walletId>'`.
Não pode ser submetido pela API nem pela fila (validado no DTO e no domínio, e o
`provider_id = 'internal'` é reservado).

## 4. Máquina de estados de WagerTransaction

```
PENDING            -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE  -> PENDING_REFERENCE (retry) | PROCESSED | REJECTED | FAILED
PROCESSED | REJECTED | FAILED  -> (terminais, sem transições)
```

Transicionar um estado terminal é erro de programação (`InvalidTransactionStateError`)
e o trigger do banco é a segunda barreira. `PENDING_REFERENCE -> PENDING` é proibido.

## 5. Idempotência

- `Idempotency-Key` é obrigatório e é a fonte da verdade. Default: `{providerId}:{externalTransactionId}`.
- `payloadHash` = SHA-256 (hex) do JSON canônico (chaves ordenadas recursivamente, sem
  espaços, `undefined` omitido) dos campos de negócio: `providerId, externalTransactionId,
playerId, walletId, roundId, gameId, kind, money{amount,currency},
referenceExternalTransactionId`. O `Money` entra normalizado. Header e metadados de
  transporte ficam fora do hash.
- Fluxo: consulta por key e por `externalTransactionId` sob o lock da wallet; o `UNIQUE`
  é a barreira final. Hash igual → replay (resultado original, `idempotentReplay: true`).
  Hash diferente → conflito.
- Nenhum cache em memória participa da garantia.

## 6. Concorrência

- **Unidade: `walletId`**. Estratégia: **lock pessimista por linha** (`SELECT ... FOR UPDATE`
  na wallet dentro da transação), seguido de validação de saldo e update.
- Sem lock global. Wallets diferentes processam em paralelo. Na mesma wallet as operações
  serializam, e o tempo de lock é curto (uma transação).
- **Por que não otimista:** em hot wallet o optimistic locking gera tempestade de retries.
  O pessimista tem custo previsível e é mais simples de provar correto.
- `CHECK (balance >= 0)` e os triggers são a última barreira caso o lock seja esquecido.
- Cenário obrigatório (100.00, 2 × 80.00): a primeira trava, debita (20.00); a segunda lê
  20.00 e é REJECTED com `INSUFFICIENT_FUNDS`. Um débito no ledger, e retries não duplicam
  por causa da idempotência.
- **Ordem dos locks:** a transação trava a wallet primeiro e só depois escreve a transação,
  o ledger, o inbox e o outbox. Evita deadlock entre instâncias.

## 7. Regras de negócio (resumo)

| Operação | Saldo                                      | Ledger    |
| -------- | ------------------------------------------ | --------- |
| BET      | débito; rejeita se insuficiente            | DEBIT     |
| WIN      | crédito                                    | CREDIT    |
| LOSS     | nenhum                                     | nenhum    |
| REFUND   | crédito; só referencia BET PROCESSED       | CREDIT    |
| ROLLBACK | inverso da referência (BET, WIN ou REFUND) | invertido |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve ter o
mesmo provider, player, wallet, moeda e rodada. O valor da reversão deve ser igual ao da
referência (parcial fora de escopo). REJECTED não altera saldo nem gera ledger.

## 8. Taxonomia de failureCode

| Código                    | Quando                                                | Provedor deve                        |
| ------------------------- | ----------------------------------------------------- | ------------------------------------ |
| `INSUFFICIENT_FUNDS`      | BET sem saldo                                         | desistir ou reenviar com outro valor |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria saldo negativo                      | não reenviar; tratar manualmente     |
| `REFERENCE_NOT_FOUND`     | referência não apareceu após o limite da seção 9      | corrigir/reenviar a referência       |
| `REFERENCE_MISMATCH`      | referência de outro player, wallet, moeda ou rodada   | corrigir o payload                   |
| `INVALID_REFERENCE_KIND`  | REFUND sobre não-BET; ROLLBACK sobre tipo inválido    | corrigir o payload                   |
| `REFERENCE_NOT_PROCESSED` | referência terminal, mas não PROCESSED                | desistir                             |
| `ALREADY_REVERSED`        | referência já revertida                               | desistir                             |
| `AMOUNT_MISMATCH`         | valor da reversão ≠ valor da referência               | corrigir o payload                   |
| `CURRENCY_MISMATCH`       | moeda da operação ≠ moeda da wallet                   | corrigir o payload                   |
| `PLAYER_WALLET_MISMATCH`  | `playerId` do payload ≠ dono da wallet                | corrigir o payload                   |
| `WALLET_NOT_FOUND`        | wallet inexistente (**não persistida**, ver seção 18) | corrigir o payload                   |
| `INTERNAL_ERROR`          | `FAILED`: erro permanente de infraestrutura           | contatar suporte                     |

Rejeição de negócio é um **resultado**, não uma exceção: a transação é gravada como
`REJECTED`, o evento é publicado e o SQL **commita**. Só erros de programação ou de
infraestrutura causam rollback.

## 9. Referências fora de ordem (PENDING_REFERENCE)

- Persistida como `PENDING_REFERENCE` com `next_reference_attempt_at`; evento
  `WagerTransactionPendingReference`.
- Worker agendado busca vencidas com `FOR UPDATE SKIP LOCKED` (multi-instância seguro).
- Backoff exponencial: `min(2^n × 5s, 5min)` com jitter.
- **Limite proposto: 8 tentativas ou 15 minutos** (o que vier primeiro). Justificativa:
  cobre atraso normal de entrega e reordenação do broker; depois disso a referência
  provavelmente não virá. Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
- Os valores são configuráveis por variável de ambiente.

## 10. API HTTP

| Situação                                                | Status                                                |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Payload inválido                                        | 400                                                   |
| Conflito de idempotência (mesma key, payload diferente) | 409                                                   |
| Wallet duplicada                                        | 409 (com `code` distinto de conflito de idempotência) |
| Rejeição de negócio                                     | 422 (com `failureCode`)                               |
| Aceito, processamento pendente (`PENDING_REFERENCE`)    | 202                                                   |
| Processado / replay                                     | 200 (criação de wallet: 201)                          |
| Infra indisponível / falha transitória                  | 503 + `Retry-After`                                   |

O mapeamento é o mesmo em todos os endpoints. Erros trazem `code` estável legível por máquina.

## 11. Mensageria

### Consumer SQS

- Reutiliza o mesmo use case da API HTTP.
- Dedup por inbox `(consumerName, messageId)` **na mesma transação** do efeito financeiro.
- Ack somente após o commit.
- Erro de negócio → terminal, ack (a transação fica REJECTED e auditável).
- Erro transitório → sem ack; `ChangeMessageVisibility` com backoff.
- Erro permanente ou `maxReceiveCount` excedido → DLQ (`wager-transactions-dlq.fifo`).
- SIGTERM: para o polling, conclui as mensagens em andamento e devolve a visibilidade das restantes.
- Crash entre commit e ack: a mensagem é reentregue, e o inbox/idempotência evitam efeito duplicado.

### Transactional Outbox

- O evento é gravado na mesma transação da mudança financeira. Nunca se publica antes do commit.
- Publisher: `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now()
ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED`. Vários publishers não se bloqueiam.
- Falha na publicação: `scheduleRetry` (attempts+1, backoff exponencial, `last_error`).
- Garantia: **at-least-once**. O consumidor deduplica por `eventId` (= `outbox_messages.id`).
- Crash após o commit e antes de publicar: outra instância pega a linha e publica.
- Eventos: `WagerTransactionProcessed` (inclui LOSS), `WagerTransactionRejected`,
  `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference`.
  `data` carrega `MoneyProps` (string), nunca a instância de `Money`.

## 12. Autenticação (decisão: não implementada)

Não vale pontos e não deve competir com correção financeira. **Desenho adotado:**
IdP externo (Keycloak/OIDC), validação de JWT via JWKS e `ProviderIdentityPort`, que
mapeia o `client_id` do token ao `providerId` autorizado. Isso impede um provedor de
submeter transações como outro. **Ponto de extensão:** `AuthGuard` no-op registrado
globalmente e o port `ProviderIdentityPort`. Health abertos; a fila é canal interno
confiável, mas a identidade do provedor na mensagem passa pelas mesmas validações de domínio.

## 13. Observabilidade

- Logs JSON estruturados com `correlationId, messageId, transactionId, walletId, providerId`.
  Sem payloads financeiros completos.
- Métricas: transações por status, duplicatas detectadas, retries, DLQ, conflitos de lock,
  outbox lag, latência, divergências de reconciliação.
- `GET /health/live` (processo) e `GET /health/ready` (PostgreSQL e SQS), sem autenticação.

## 14. Reconciliação

`POST /wallets/:id/reconciliation` compara `wallets.balance` com a soma do ledger
(CREDIT − DEBIT). Divergência não é corrigida: é logada, contabilizada em métrica e
sinalizada na resposta (`consistent: false`). Os triggers da seção 3 tornam a divergência
improvável, e a reconciliação é a verificação independente.

## 15. Camada de aplicação e fluxo do use case

`ProcessWagerTransactionUseCase` é compartilhado por HTTP e SQS. Depende só de portas
(`UnitOfWork`, `WalletRepository`, `WagerRepository`, `LedgerRepository`, `InboxRepository`,
`OutboxRepository`, `Clock`, `IdGenerator`). Não conhece MikroORM.

### Ordem dentro da transação (única e fixa)

1. **Inbox** (`INSERT ... ON CONFLICT DO NOTHING`), somente quando a origem é SQS.
2. **Lock da wallet** (`SELECT ... FOR UPDATE`). É o primeiro lock sobre dados financeiros.
3. Consulta de idempotência (por key e por `externalTransactionId`), já serializada pelo lock.
4. Decisão das regras de negócio, **sem mutar** a wallet em memória antes de validar.
5. Escritas: `wager_transactions` → ledger → wallet → outbox.

Todas as instâncias adquirem locks nessa ordem, o que evita deadlock. A ordem de escrita
respeita as FKs (transação antes do ledger).

### Transação nasce no estado final

A linha de `wager_transactions` é inserida já como `PROCESSED`, `REJECTED` ou
`PENDING_REFERENCE`, sem `INSERT` seguido de `UPDATE`. O trigger de transições só é
exercitado pelo worker de `PENDING_REFERENCE` (que faz `UPDATE`, travando a wallet antes).

### Idempotência: casos

| Situação                                    | Resultado                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| mesma key, mesmo hash                       | replay: resultado original, `balance_observed`, `idempotentReplay: true`    |
| mesma key, hash diferente                   | 409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`                                      |
| key nova, `externalTransactionId` já usado  | 409 `EXTERNAL_ID_REUSED`                                                    |
| mesma key em wallets diferentes, simultâneo | `UNIQUE` barra; `ConcurrentInsertError` → até 2 retries, que caem no replay |
| SQS: `messageId` repetido, mesmo hash       | efeito já commitado (inbox e efeito são atômicos); devolve o replay         |
| SQS: `messageId` repetido, hash diferente   | conflito                                                                    |

### Saldo observado

`balance_observed` guarda o saldo da wallet logo após a decisão. É necessário porque LOSS,
REJECTED e PENDING_REFERENCE não têm lançamento no ledger, e sem isso o replay não
conseguiria devolver "o saldo observado naquele momento".

### Referências

- Resolvidas por `(providerId, referenceExternalTransactionId)`.
- Validação: mesmo player, wallet, moeda e rodada (`REFERENCE_MISMATCH`); kind permitido
  (REFUND→BET; ROLLBACK→BET/WIN/REFUND); referência `PROCESSED`; valor igual; não revertida.
- Se a referência existe mas está `PENDING`/`PENDING_REFERENCE`, a nova transação também
  fica `PENDING_REFERENCE` (espera a cadeia resolver).
- Direção do ROLLBACK = inverso da direção da referência (ROLLBACK de REFUND = DEBIT).
- Reversão (REFUND/ROLLBACK) sem saldo usa `REVERSAL_WOULD_OVERDRAW`, distinto de
  `INSUFFICIENT_FUNDS` da BET.

### Validação de entrada (HTTP 400 / DLQ na fila)

`Idempotency-Key` obrigatório; `providerId` ≠ `internal`; `playerId` e `walletId` UUID;
`kind` ∈ {BET, WIN, LOSS, REFUND, ROLLBACK} (OPENING barrado); Money com exatamente 2 casas;
valor > 0 exceto LOSS; referência exigida para REFUND/ROLLBACK e proibida nos demais.

## 16. Persistência (MikroORM)

- **Domínio puro**: agregados sem decorators. Entidades MikroORM só na infraestrutura;
  mappers usam `rehydrate` (sem revalidar transições).
- **Sem `@Version` do MikroORM**: o trigger exige `version + 1` apenas quando o saldo muda,
  e `@Version` incrementaria em todo UPDATE. Concorrência vem do `FOR UPDATE`.
- **`numeric` mapeado como `string`**: nunca passa por `number`.
- **Um `fork()` do EntityManager por execução** no `UnitOfWork`: identity map isolado.
- **`SET LOCAL lock_timeout = '5s'`** por transação: espera limitada pelo lock da wallet.
- **Classificação de erros** no `UnitOfWork`:
  - `UniqueConstraintViolation` → `ConcurrentInsertError` (retry interno).
  - `Deadlock`, `LockWaitTimeout`, `Connection` → `TransientInfrastructureError`
    (HTTP 503 + `Retry-After`; na fila, retry com backoff). Deadlock/timeout incrementam a
    métrica de conflitos de lock.
  - Demais (incluindo CHECK violado = bug) propagam: 500 / DLQ.
- **Paginação do ledger**: cursor opaco = `base64url(seq)`, ordem decrescente por `seq`
  (identity do banco), estável sem duplicar nem pular linhas.
- **Outbox**: `claimDue` usa `FOR UPDATE SKIP LOCKED`. As linhas ficam travadas durante a
  publicação; se o processo morrer, voltam e outra instância publica (possível duplicata,
  tratada pelo `eventId` no consumidor).

## 17. Domínio: decisões de modelagem

- Construtores privados; `create` valida, `rehydrate` apenas reconstrói.
- `Wallet.open` devolve também o lançamento CREDIT de abertura (before = 0) quando o saldo
  inicial é maior que zero, na mesma transação SQL. `version` inicia em 1.
- `Wallet.debit`/`credit` devolvem o `WalletLedgerEntry` e incrementam `version` somente
  quando o saldo muda. Rejeitam valor não positivo e moeda divergente.
- `WalletLedgerEntry.create` valida `before ± money === after`; sem setters.
- `OutboxMessage.scheduleRetry`: atraso `min(1s × 2^attempts, 5min)` + jitter de até 20%.
- `InboxMessage.markProcessed` é idempotente. No fluxo SQS a linha é gravada já com
  `processed_at`, e só fica visível junto com o efeito (mesmo COMMIT).
- `number` aparece apenas em tempo e contadores, nunca em dinheiro.

## 18. Limitações conhecidas

- **Retenção da outbox:** o trigger proíbe DELETE e a tabela cresce sem limite. Em
  produção, usar arquivamento/particionamento com uma exceção controlada (ex.: permitir
  DELETE de mensagens publicadas há mais de N dias).
- **Hot wallet:** o lock pessimista serializa as operações da mesma wallet, e o throughput
  por wallet é limitado ao tempo de uma transação.
- **Trigger de encadeamento do ledger:** lê o último lançamento a cada insert e depende
  do lock da wallet. Tem custo aceitável nesta escala; em escala maior avaliar alternativas.
- **`WALLET_NOT_FOUND` não é persistida**: `wager_transactions.wallet_id` tem FK para
  `wallets`, então não há onde gravar. O use case lança `WalletNotFoundError`; a API devolve
  422 e a fila dá ack (terminal). Sem registro auditável nem evento para esse caso.
- **Publisher mantém locks durante a publicação**: simples e correto, mas gera transações
  longas se o SQS estiver lento. Mitigação: lotes pequenos e timeout de publicação.
- **Reversão parcial** e **ledger de partidas dobradas** estão fora de escopo.
- **Duas migrations** (schema inicial e `balance_observed`), por simplicidade de timebox.
  Para produção, consolidar.
- Autenticação não implementada (ver seção 12).
