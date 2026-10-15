# ARCHITECTURE

Serviço distribuído de processamento de apostas (BET/WIN/LOSS/REFUND/ROLLBACK).
Princípio central: **o banco é o responsável final pelas invariantes**. O código de
aplicação as respeita, mas o schema as impõe mesmo que o código tenha bug.

## 1. Stack e justificativas

- **Bun + TypeScript strict + NestJS**, conforme o desafio.
- **PostgreSQL**: transações ACID, `SELECT ... FOR UPDATE [SKIP LOCKED]`, CHECK, triggers,
  índices parciais e constraint triggers deferidos.
- **MikroORM** (preferencial): `EntityManager.transactional()` deixa a fronteira de
  transação explícita, e `LockMode.PESSIMISTIC_WRITE` mapeia para `FOR UPDATE`.
  O Unit of Work agrupa wallet, transação, ledger, inbox e outbox em um único commit.
- **SQS (LocalStack)**: entrega at-least-once. FIFO é otimização, não garantia: o banco
  continua responsável por idempotência e ordem de efeitos.

## 2. Money

- No domínio: `bigint` em centavos (escala fixa 2). Nenhum `number`/float em dinheiro.
  Não depende de ORM nem de decorators do NestJS.
- Entrada: exige **exatamente 2 casas decimais** (`"25.00"`). Rejeita `"25"`, `"25.5"`,
  vazio, NaN, Infinity, notação científica, sinal, mais de 2 casas e valores negativos.
  Não há arredondamento nem normalização (ver seção 18).
- Saída: sempre string com 2 casas (`"25.00"`).
- Persistência: `numeric(20,2)` + `currency char(3)` em colunas separadas. A reidratação usa
  `Money.fromPersisted`, e o MikroORM lê `numeric` como string (sem passar por `number`).
- `Money.from` rejeita negativos (contratos de entrada). `fromPersisted` e `subtract`
  admitem negativos, usados em diferenças de reconciliação.
- Multi-moeda no modelo; operações entre moedas distintas lançam `CurrencyMismatchError`.
  O conflito de moeda é testado em unidade (Money) e em integração (`CURRENCY_MISMATCH`).

## 3. Schema e garantias no banco

| Garantia                               | Mecanismo                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Saldo não negativo                     | `CHECK (balance >= 0)` em `wallets` e `CHECK (balance_before >= 0 AND balance_after >= 0)` no ledger                     |
| Uma wallet por player+moeda            | `UNIQUE (player_id, currency)`                                                                                           |
| Idempotência persistente               | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`                                |
| Replay vs conflito                     | `payload_hash` (SHA-256, ver seção 5) comparado após colisão de unicidade                                                |
| Saldo observado em replay              | `balance_observed numeric(20,2) NOT NULL CHECK (>= 0)` em `wager_transactions`                                           |
| OPENING interno                        | `CHECK`: `provider_id = 'internal'` e `amount > 0`                                                                       |
| Referência exigida por kind            | `CHECK`: `kind IN ('REFUND','ROLLBACK')` ⇔ referência presente                                                           |
| Coerência de status                    | `CHECK`s: `failure_code` ⇔ REJECTED/FAILED; `processed_at` ⇔ PROCESSED; `reference_transaction_id` só em PROCESSED      |
| Estados terminais imutáveis            | Trigger `wager_transactions_guard` (bloqueia UPDATE em PROCESSED/REJECTED/FAILED, mudança de campos de negócio e DELETE) |
| Reversão única                         | Índice único parcial `wt_single_reversal_uq` sobre `reference_transaction_id` (REFUND/ROLLBACK PROCESSED)                |
| Ledger imutável                        | Triggers que bloqueiam UPDATE, DELETE e TRUNCATE                                                                         |
| Aritmética do lançamento               | `CHECK`: `balance_after = balance_before ± amount`                                                                       |
| Um lançamento por wallet por transação | `UNIQUE (wallet_id, transaction_id)`                                                                                     |
| Moeda do lançamento = moeda da wallet  | FK composta `(wallet_id, currency) → wallets(id, currency)`                                                              |
| Ledger sem fork                        | `wallet_version` em cada lançamento, com `UNIQUE (wallet_id, wallet_version)`                                            |
| Encadeamento do ledger                 | Trigger `ledger_chain_check`: versão = anterior + 1 e `balance_before` = `balance_after` anterior                        |
| Saldo e versão == ledger               | Constraint triggers `DEFERRABLE INITIALLY DEFERRED`: no COMMIT, `wallets.balance` e `wallets.version` batem com o último lançamento |
| `version`                              | Trigger `wallets_guard`: +1 se e somente se o saldo mudou                                                                |
| Inbox dedup                            | `PRIMARY KEY (consumer_name, message_id)`                                                                                |
| Outbox                                 | Conteúdo imutável; sem UPDATE após publicado; sem DELETE                                                                 |

### Ledger à prova de fork

Cada lançamento grava a versão da wallet que ele produziu (`wallet_version`). Como
`UNIQUE (wallet_id, wallet_version)` impede duas linhas com a mesma versão, duas
transações que lessem o mesmo saldo anterior **sem lock** não conseguem gravar lançamentos
paralelos: a segunda espera a primeira no índice único e falha com `unique_violation`.
Isso vale mesmo que a aplicação esqueça o `FOR UPDATE`. O encadeamento (versão anterior + 1,
`balance_before` igual ao `balance_after` anterior) e a checagem deferida de saldo e versão
completam a garantia: o ledger é uma cadeia contínua, sem buracos nem bifurcações, e a
wallet é sempre a ponta dessa cadeia.

Uma wallet aberta com saldo tem o lançamento de abertura na versão 1. Uma wallet aberta com
zero não tem lançamento de abertura, e o primeiro movimento vira a versão 2.

### Migrations

Três migrations versionadas, todas com `down` que desfaz exatamente o `up`:

1. `initial_schema`: tabelas, constraints, índices e triggers.
2. `wager_balance_observed`: coluna `balance_observed` para o replay.
3. `ledger_wallet_version`: coluna `wallet_version`, unicidade, encadeamento por versão e
   checagem deferida de versão. Faz backfill das linhas existentes (o trigger de
   imutabilidade é desligado só durante o backfill, dentro da mesma transação).

Comandos: `bun run migration:up`, `bun run migration:down`, `bun run migration:list`.

## 4. Máquina de estados de WagerTransaction

```
PENDING            -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE  -> PENDING_REFERENCE (retry) | PROCESSED | REJECTED | FAILED
PROCESSED | REJECTED | FAILED  -> (terminais, sem transições)
```

Transicionar um estado terminal é erro de programação (`InvalidTransactionStateError`)
e o trigger do banco é a segunda barreira. `PENDING_REFERENCE -> PENDING` é proibido.

O trigger `wager_transactions_guard` congela os campos de negócio (provider, ids externos,
key, hash, wallet, player, rodada, jogo, kind, valor, moeda, referência externa, `created_at`).
Permanecem mutáveis apenas os campos de resolução, usados pelo worker de `PENDING_REFERENCE`:
`status`, `failure_code`, `reference_transaction_id`, `processed_at`, `balance_observed`,
`reference_attempts`, `next_reference_attempt_at` e `updated_at`.

## 5. Idempotência

- `Idempotency-Key` é obrigatório e é a fonte da verdade. Default: `{providerId}:{externalTransactionId}`.
  A unicidade é por provedor: `(provider_id, idempotency_key)`.
- `payloadHash` = SHA-256 (hex) do JSON canônico (chaves ordenadas recursivamente, sem
  espaços, `undefined` omitido) dos campos de negócio: `providerId, externalTransactionId,
  playerId, walletId, roundId, gameId, kind, money{amount,currency},
  referenceExternalTransactionId`. O `Money` entra normalizado. Header e metadados de
  transporte ficam fora do hash.
- Fluxo: consulta por key e por `externalTransactionId` sob o lock da wallet; o `UNIQUE`
  é a barreira final. Hash igual → replay (resultado gravado, `idempotentReplay: true`).
  Hash diferente → conflito.
- Nenhum cache em memória participa da garantia.

## 6. Concorrência

- **Unidade: `walletId`**. Estratégia: **lock pessimista por linha** (`SELECT ... FOR UPDATE`
  na wallet dentro da transação), seguido de validação de saldo e update.
- Sem lock global. Wallets diferentes processam em paralelo. Na mesma wallet as operações
  serializam, e o tempo de lock é curto (uma transação).
- **Por que não otimista:** em hot wallet o optimistic locking gera tempestade de retries.
  O pessimista tem custo previsível e é mais simples de provar correto.
- **Defesa em profundidade:** se o lock for esquecido, `UNIQUE (wallet_id, wallet_version)`
  barra o fork do ledger, `CHECK (balance >= 0)` barra saldo negativo e a checagem deferida
  barra divergência entre saldo e ledger.
- Cenário obrigatório (100.00, 2 × 80.00): a primeira trava, debita (20.00); a segunda lê
  20.00 e é REJECTED com `INSUFFICIENT_FUNDS`. Um débito no ledger, e retries não duplicam
  por causa da idempotência.

### Ordem dos locks (única em todo o sistema)

| Caminho                      | Ordem                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Entrada HTTP                 | wallet (`FOR UPDATE`) → leituras → escritas                                                   |
| Entrada SQS                  | inbox (`INSERT ... ON CONFLICT`) → wallet (`FOR UPDATE`) → leituras → escritas                |
| Worker: reivindicação        | só linhas de `wager_transactions`, com `SKIP LOCKED` (nunca espera, nunca toca a wallet)      |
| Worker: resolução            | wallet (`FOR UPDATE`) → linha da transação pendente (`FOR UPDATE`) → escritas                 |
| Publisher da outbox          | só linhas de `outbox_messages`, com `SKIP LOCKED`, em transação curta; publica fora dela      |

O inbox vem antes da wallet porque é ele que serializa redeliveries do mesmo `messageId`.
Nenhum caminho pega a wallet depois de esperar por outra linha financeira, o que elimina
ciclos de espera (deadlock) entre instâncias.

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
Direção do ROLLBACK: de BET credita, de WIN debita, de REFUND debita.

## 8. Taxonomia de failureCode

| Código                    | Quando                                                              | Provedor deve                        |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| `INSUFFICIENT_FUNDS`      | BET sem saldo                                                       | desistir ou reenviar com outro valor |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria saldo negativo                                    | não reenviar; tratar manualmente     |
| `REFERENCE_NOT_FOUND`     | referência nunca apareceu dentro do limite da seção 9               | corrigir/reenviar a referência       |
| `REFERENCE_NOT_PROCESSED` | referência terminal mas não PROCESSED, ou ainda pendente ao esgotar o limite | desistir                    |
| `REFERENCE_MISMATCH`      | referência de outro player, wallet, moeda ou rodada                 | corrigir o payload                   |
| `INVALID_REFERENCE_KIND`  | REFUND sobre não-BET; ROLLBACK sobre tipo inválido                  | corrigir o payload                   |
| `ALREADY_REVERSED`        | referência já revertida (por REFUND ou ROLLBACK)                    | desistir                             |
| `AMOUNT_MISMATCH`         | valor da reversão ≠ valor da referência                             | corrigir o payload                   |
| `CURRENCY_MISMATCH`       | moeda da operação ≠ moeda da wallet                                 | corrigir o payload                   |
| `PLAYER_WALLET_MISMATCH`  | `playerId` do payload ≠ dono da wallet                              | corrigir o payload                   |
| `WALLET_NOT_FOUND`        | wallet inexistente (**não persistida**, ver seção 21)               | corrigir o payload                   |
| `INTERNAL_ERROR`          | `FAILED`: erro permanente de infraestrutura                         | contatar suporte                     |

Rejeição de negócio é um **resultado**, não uma exceção: a transação é gravada como
`REJECTED`, o evento é publicado e o SQL **commita**. Só erros de programação ou de
infraestrutura causam rollback.

## 9. Referências fora de ordem (PENDING_REFERENCE)

- Persistida como `PENDING_REFERENCE` com `next_reference_attempt_at = createdAt + 5s`;
  evento `WagerTransactionPendingReference`. Se a referência existe mas também está pendente,
  a nova transação espera junto (a cadeia resolve em ordem).
- **Worker** (`ResolvePendingReferencesUseCase`), em duas fases:
  1. **Reivindicação** numa transação curta: `UPDATE ... SET next_reference_attempt_at = now + lease
     WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. Duas instâncias nunca reivindicam a
     mesma linha. Lease padrão: 30s.
  2. **Resolução** de cada pendente numa transação própria: trava a wallet, depois a linha
     da transação, e revalida `status` e `reference_attempts` contra o valor reivindicado.
     Se outro worker já mexeu nela (lease expirado), não faz nada.
- **Crash entre as fases:** o lease expira e outra instância assume. Erro durante a
  resolução faz rollback e a pendente volta na rodada seguinte, pelo mesmo mecanismo.
- **Mesma regra da entrada:** a decisão usa o `WagerDecider` (seção 15), o mesmo código da
  entrada HTTP/SQS. Resolver uma pendente é idêntico a recebê-la naquele momento.
- **Backoff exponencial:** `min(5s × 2^tentativas, 5min)` + jitter de até 20%.
- **Limite: 8 tentativas ou 15 minutos** desde a criação, o que vier primeiro. Justificativa:
  cobre atraso normal de entrega e reordenação do broker (segundos a poucos minutos); depois
  disso a referência provavelmente não virá, e manter crédito/débito em suspenso por mais
  tempo prejudica a conciliação com o provedor. Ao esgotar:
  - referência inexistente → `REJECTED` com `REFERENCE_NOT_FOUND`;
  - referência existente, mas ainda pendente → `REJECTED` com `REFERENCE_NOT_PROCESSED`;
  - em ambos os casos, evento `WagerTransactionRejected` na outbox.
- Ao resolver, `balance_observed` é atualizado com o saldo daquele momento: um replay
  posterior devolve o estado resolvido e o saldo correspondente.
- Limites, backoff, lease e tamanho do lote são opções do worker, configuradas por variável
  de ambiente no bootstrap.

## 10. API HTTP

| Situação                                                | Status                                                |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Payload inválido                                        | 400                                                   |
| Recurso consultado inexistente (`GET`)                  | 404                                                   |
| Conflito de idempotência (mesma key, payload diferente) | 409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`                |
| `externalTransactionId` já usado com outra key          | 409 `EXTERNAL_ID_REUSED`                              |
| Wallet duplicada                                        | 409 `WALLET_ALREADY_EXISTS`                           |
| Rejeição de negócio                                     | 422 (com `failureCode`)                               |
| Wallet inexistente na submissão                         | 422 `WALLET_NOT_FOUND`                                |
| Aceito, processamento pendente (`PENDING_REFERENCE`)    | 202                                                   |
| Processado                                              | 200 (criação de wallet: 201)                          |
| Infra indisponível / falha transitória                  | 503 + `Retry-After`                                   |
| Erro inesperado                                         | 500                                                   |

- **Replay espelha o resultado gravado:** replay de PROCESSED → 200, de REJECTED → 422,
  de PENDING_REFERENCE → 202. Sempre com `idempotentReplay: true`. Se a pendente já foi
  resolvida pelo worker, o replay devolve o estado atual.
- O mapeamento é o mesmo em todos os endpoints. Erros trazem `code` estável legível por
  máquina. O provedor decide pelo status, sem interpretar mensagem: 4xx não se reenvia
  igual; 503 se reenvia com a mesma `Idempotency-Key`.

## 11. Mensageria

Três filas FIFO: `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ) e
`wager-events.fifo` (eventos de integração publicados pela outbox; o desafio não nomeia a fila
de saída). São criadas no boot se não existirem (`SQS_CREATE_QUEUES`), DLQ primeiro, porque a
redrive policy da fila de entrada referencia o ARN dela.

### Consumer SQS

- Reutiliza o mesmo use case da API HTTP (`WagerMessageHandler` → `ProcessWagerTransactionUseCase`).
- Dedup por inbox `(consumerName, messageId)` **na mesma transação** do efeito financeiro.
  O `messageId` é o do envelope (`WagerTransactionRequested`), não o id do broker.
- Ack (`DeleteMessage`) somente após o commit.
- `MessageGroupId = walletId`. Dentro de um lote, grupos diferentes rodam em paralelo e
  mensagens do mesmo grupo rodam em ordem. Se uma volta para retry, as seguintes do mesmo
  grupo são devolvidas à fila para não passarem na frente dela. É otimização de contenção e
  de ordem: a correção não depende disso.
- Classificação de erros:

| Situação                                                          | Ação                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Processada, rejeitada por regra de negócio ou `PENDING_REFERENCE` | terminal: ack (a rejeição fica gravada e auditável)                     |
| Envelope inválido, payload inválido, conflito de idempotência, `WALLET_NOT_FOUND` | permanente: DLQ explícita, com o motivo no atributo `reason` |
| Banco indisponível, deadlock, lock timeout                        | transitório: sem ack; `ChangeMessageVisibility` com backoff `min(2s × 2^(n-1), 60s)` |
| Erro inesperado                                                   | tratado como transitório (pode ser um bug intermitente)                 |
| Retry esgotado (`SQS_MAX_ATTEMPTS`, padrão 5 entregas)            | DLQ explícita com `MAX_ATTEMPTS_EXCEEDED: <motivo>`                     |

- **DLQ explícita.** A redrive policy só move uma mensagem quando `maxReceiveCount` estoura, e
  não diz por quê. Por isso a aplicação manda para a DLQ ela mesma (`SendMessage` na DLQ com o
  motivo, depois `DeleteMessage` na original). A redrive policy fica configurada com
  `maxAttempts + 3` como rede de segurança. Se o processo morrer entre o envio e o delete, a
  mensagem volta e vai de novo para a DLQ; o `MessageDeduplicationId` (id original) evita a cópia.
- **Backoff no FIFO.** Uma mensagem em backoff segura o grupo daquela wallet até ser processada.
  É o comportamento desejado (preserva a ordem por wallet) e não afeta outras wallets.
- **SIGTERM.** Aborta o long polling na hora, conclui as mensagens em andamento e devolve à fila
  (`ChangeMessageVisibility` para 0) as recebidas que ainda não começaram.
- **Crash entre commit e ack.** A mensagem é reentregue; o inbox devolve o resultado gravado,
  sem efeito novo.

### Transactional Outbox

- O evento é gravado na mesma transação da mudança financeira. Nunca se publica antes do commit.
- Publisher (`PublishOutboxUseCase`), em três passos:
  1. **Reivindica** um lote com lease numa transação curta:
     `UPDATE ... SET next_attempt_at = now + lease WHERE id IN (SELECT ... WHERE published_at IS NULL
     AND next_attempt_at <= now FOR UPDATE SKIP LOCKED)`. Publishers concorrentes nunca pegam o
     mesmo evento.
  2. **Publica fora da transação.** Nenhuma conexão nem lock fica preso esperando o broker.
  3. **Marca** os publicados e agenda retry dos que falharam (`scheduleRetry`: attempts + 1,
     backoff `min(1s × 2^n, 5min)` + jitter, `last_error`).
- `MessageDeduplicationId = eventId`, `MessageGroupId = aggregateId`.
- **Crash entre publicar e marcar:** o lease expira (`OUTBOX_LEASE_MS`, padrão 30s) e outra
  instância publica de novo. Garantia: **at-least-once**; o consumidor deduplica por `eventId`
  (= `outbox_messages.id`), e o FIFO já descarta repetições dentro da janela de 5 minutos.
- Eventos: `WagerTransactionProcessed` (inclui LOSS), `WagerTransactionRejected`,
  `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference`.
  `data` carrega `MoneyProps` (string), nunca a instância de `Money`. Todo evento traz
  `correlationId` e `causationId` (o id da transação que o originou).

## 12. Autenticação (decisão: não implementada)

Não vale pontos e não deve competir com correção financeira. **Desenho adotado:**
IdP externo (Keycloak/OIDC), validação de JWT via JWKS e `ProviderIdentityPort`, que
mapeia o `client_id` do token ao `providerId` autorizado. Isso impede um provedor de
submeter transações como outro. **Ponto de extensão no código:** `AuthGuard` registrado
globalmente (`APP_GUARD`), que delega ao `ProviderIdentityPort`; a implementação atual
(`NoAuthProviderIdentity`) aceita todos. Trocar a implementação liga a autenticação sem tocar em
controllers nem use cases. Health e `/metrics` são marcados `@Public()`. A fila é canal interno
confiável, mas a identidade do provedor na mensagem passa pelas mesmas validações de domínio.

## 13. Observabilidade

### Logs

- Uma linha JSON por evento (`JsonLogger`, inclusive os logs internos do Nest):
  `{ time, level, context, msg, ...campos }`. Nível por `LOG_LEVEL`.
- **Uma linha por transação**, venha de HTTP ou SQS, com `correlationId`, `messageId` (quando
  SQS), `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`,
  `idempotentReplay` e `durationMs`. Vem de um decorador do use case
  (`InstrumentedProcessWager`), então nenhuma porta de entrada esquece de logar.
- Uma linha por requisição HTTP (rota, status, duração e os mesmos ids). Health e `/metrics`
  ficam de fora para não fazer ruído.
- `x-correlation-id`: usa o do chamador ou gera um; volta na resposta e segue até os eventos
  da outbox. Na fila, vem do envelope (ou `msg:<messageId>`).
- **Sem payload financeiro.** O logger descarta as chaves `amount`, `money`, `balance*`,
  `payload`, `body`, `authorization`, `token` e `password` mesmo que alguém as passe por engano:
  a regra é imposta pelo logger, não só por disciplina.

### Métricas (`GET /metrics`, formato Prometheus)

| Pedido no desafio       | Métrica                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| transações por status   | `wager_transactions_total{source,status,replay}`                                                  |
| duplicatas detectadas   | `wager_duplicates_detected_total{source}` (replays idempotentes, HTTP ou redelivery SQS)          |
| retries                 | `retries_total{component}` (`sqs_consumer`, `outbox_publisher`, `pending_reference`)              |
| mensagens em DLQ        | `sqs_dead_lettered_total{reason}`                                                                 |
| conflitos de lock       | `db_lock_conflicts_total` (deadlock e `lock_timeout`, via hook do Unit of Work)                   |
| outbox lag              | `outbox_pending_events`, `outbox_oldest_pending_age_seconds` (lidos do banco na coleta) e `outbox_publish_lag_seconds` |
| latência                | `wager_processing_duration_seconds{source}`, `http_request_duration_seconds{method,route}`        |

Também: `wager_requests_failed_total{source,code}`, `sqs_messages_total{outcome}`,
`outbox_events_published_total`, `pending_reference_resolutions_total{outcome}`,
`pending_reference_transactions`, `reconciliation_divergences_total` e
`http_requests_total{method,route,status}`.

- Labels de baixa cardinalidade apenas: nunca ids de wallet ou transação; a rota HTTP é o padrão
  casado (`/wallets/:walletId`), e URLs que não casam viram `unmatched`.
- Registro próprio, sem dependência (~150 linhas): contadores, histogramas e gauges calculados na
  coleta. Um gauge cuja dependência está fora do ar some daquela coleta sem derrubar o endpoint.
- As métricas são por processo: com 3 réplicas, o Prometheus coleta cada uma e agrega.

### Health checks

`GET /health/live` responde sem tocar dependências (não reinicia o processo por causa do banco).
`GET /health/ready` checa PostgreSQL e SQS com timeout de 2s e devolve 503 se algum falhar.
Ambos sem autenticação.

## 14. Reconciliação

`POST /wallets/:id/reconciliation` compara `wallets.balance` com a soma do ledger
(CREDIT − DEBIT). Divergência não é corrigida: é logada, contabilizada em métrica e
sinalizada na resposta (`consistent: false`). Os triggers da seção 3 tornam a divergência
improvável, e a reconciliação é a verificação independente: ela soma o ledger inteiro, em vez
de confiar no encadeamento que os triggers mantêm.

## 15. Camada de aplicação e fluxo do use case

`ProcessWagerTransactionUseCase` é compartilhado por HTTP e SQS. Depende só de portas
(`UnitOfWork`, `WalletRepository`, `WagerRepository`, `LedgerRepository`, `InboxRepository`,
`OutboxRepository`, `Clock`, `IdGenerator`). Não conhece MikroORM.

As regras de negócio ficam no `WagerDecider`, usado pela entrada e pelo worker de
`PENDING_REFERENCE`. Ele recebe a wallet já travada e a transação, e devolve uma decisão
(`applied`, `rejected` ou `pendingReference`) sem lançar exceção de negócio. Também emite os
eventos do resultado na outbox. Assim existe um único lugar que decide o que acontece com
uma aposta, qualquer que seja a porta de entrada.

### Ordem dentro da transação

1. **Inbox** (`INSERT ... ON CONFLICT DO NOTHING`), somente quando a origem é SQS.
2. **Lock da wallet** (`SELECT ... FOR UPDATE`). É o primeiro lock sobre dados financeiros.
3. Consulta de idempotência (por key e por `externalTransactionId`), já serializada pelo lock.
4. Decisão das regras de negócio, **sem mutar** a wallet em memória antes de validar.
5. Escritas: `wager_transactions` → ledger → wallet → outbox.

A ordem de escrita respeita as FKs (transação antes do ledger).

### Transação nasce no estado final

Na entrada, a linha de `wager_transactions` é inserida já como `PROCESSED`, `REJECTED` ou
`PENDING_REFERENCE`, sem `INSERT` seguido de `UPDATE`. O único `UPDATE` é o do worker de
`PENDING_REFERENCE`, que trava a wallet antes.

### Idempotência: casos

| Situação                                    | Resultado                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| mesma key, mesmo hash                       | replay: resultado gravado, `balance_observed`, `idempotentReplay: true`     |
| mesma key, hash diferente                   | 409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`                                      |
| key nova, `externalTransactionId` já usado  | 409 `EXTERNAL_ID_REUSED`                                                    |
| mesma key em wallets diferentes, simultâneo | `UNIQUE` barra; `ConcurrentInsertError` → até 2 retries, que caem no replay |
| SQS: `messageId` repetido, mesmo hash       | efeito já commitado (inbox e efeito são atômicos); devolve o replay         |
| SQS: `messageId` repetido, hash diferente   | conflito                                                                    |

### Saldo observado

`balance_observed` guarda o saldo da wallet logo após a decisão. É necessário porque LOSS,
REJECTED e PENDING_REFERENCE não têm lançamento no ledger, e sem isso o replay não
conseguiria devolver "o saldo observado naquele momento". O worker o atualiza ao resolver
uma pendente.

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
  (identity do banco), estável sem duplicar nem pular linhas. Cada item traz `wallet_version`.
- **Outbox**: `claimDue` reivindica com lease (`FOR UPDATE SKIP LOCKED` numa transação curta);
  a publicação acontece fora da transação (seção 11).
- **Lado de leitura** (`MikroReadModels`): SQL direto, sem identity map e sem lock, com todo
  `numeric` lido como texto. As consultas não passam pelo Unit of Work.

## 17. Domínio: decisões de modelagem

- Construtores privados; `create` valida, `rehydrate` apenas reconstrói.
- `Wallet.open` devolve também o lançamento CREDIT de abertura (before = 0, versão 1) quando
  o saldo inicial é maior que zero, na mesma transação SQL. `version` inicia em 1.
- `Wallet.debit`/`credit` devolvem o `WalletLedgerEntry` com a versão seguinte, calculada
  antes de mutar: se o lançamento for inválido, a wallet fica intacta. Incrementam `version`
  somente quando o saldo muda. Rejeitam valor não positivo e moeda divergente.
- `WalletLedgerEntry.create` valida `before ± money === after` e `walletVersion >= 1`; sem setters.
- `OutboxMessage.scheduleRetry`: atraso `min(1s × 2^attempts, 5min)` + jitter de até 20%.
- `InboxMessage.markProcessed` é idempotente. No fluxo SQS a linha é gravada já com
  `processed_at`, e só fica visível junto com o efeito (mesmo COMMIT).
- `number` aparece apenas em tempo, contadores e versões, nunca em dinheiro.

## 18. Interpretações adotadas

O desafio pede que interpretações adicionais sejam documentadas. Estas são as nossas:

- **Reversão única, mais estrita que o enunciado.** O desafio diz que uma referência não pode
  ser revertida duas vezes "pelo mesmo tipo". Adotamos: uma referência só pode ter **uma**
  reversão PROCESSED (REFUND _ou_ ROLLBACK). Sem isso, REFUND + ROLLBACK da mesma BET
  creditariam duas vezes. Falha: `ALREADY_REVERSED`. Imposto pelo índice `wt_single_reversal_uq`.
- **OPENING** usa `provider_id = 'internal'` e `external_transaction_id = 'opening:<walletId>'`.
  Não pode ser submetido pela API nem pela fila (validado na entrada, no domínio e pelo CHECK
  `wt_opening_internal`; `internal` é um provedor reservado).
- **Money sem normalização.** Entradas fora da escala fixa (`"25"`, `"25.5"`) são erro de
  validação, nunca completadas ou arredondadas. Arredondar dinheiro em silêncio esconde bugs
  do provedor.
- **LOSS aceita valor `0.00`.** LOSS não move saldo; o valor é informativo. Os demais kinds
  exigem valor maior que zero.
- **WIN sem referência.** O desafio diz que o WIN *pode* referenciar a BET. Nesta versão a
  referência só é aceita em REFUND e ROLLBACK (validação de entrada e CHECK
  `wt_reference_required`). WIN com `referenceExternalTransactionId` é payload inválido (400).
  O vínculo com a BET fica implícito pela rodada (`roundId`).
- **Esgotamento de referência em cadeia.** Se a referência existe mas continua pendente ao fim
  do limite, a falha é `REFERENCE_NOT_PROCESSED`, e não `REFERENCE_NOT_FOUND`. O provedor
  precisa saber que a referência chegou, mas não se resolveu.
- **Replay espelha o status HTTP original** (seção 10), em vez de devolver sempre 200.

## 19. Testes

Todos os testes de integração usam PostgreSQL e LocalStack reais, em containers. Nenhum mock de
banco ou de fila. Toda suíte que move saldo termina no invariante
`wallet.balance == saldo reconstruído pelo ledger` e, quando aplicável,
`wallets.version == número de lançamentos`.

| Suíte                                              | O que prova                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/domain/money/money.spec.ts`                   | escala fixa, entradas inválidas, aritmética exata, imutabilidade, conflito de moeda               |
| `src/http/http-error.spec.ts`                      | tabela de erro → HTTP: cada situação com status e `code` próprios; 500 sem vazar detalhes         |
| `src/application/reconcile-wallet.spec.ts`         | divergência sinalizada e repassada ao hook, sem correção (os triggers impedem criá-la no banco)   |
| `src/infrastructure/observability/*.spec.ts`       | formato Prometheus, logger JSON com redação, métricas do processamento                           |
| `test/integration/schema.constraints.spec.ts`      | CHECKs, unicidades, checagem deferida no COMMIT, fork do ledger barrado pelo índice, buraco de versão |
| `test/integration/wager-rules.spec.ts`             | WIN, LOSS, REFUND, ROLLBACK nas três direções, reversão única, todos os failureCodes, replay de REJECTED com o saldo da época |
| `test/integration/pending-reference.spec.ts`       | REFUND/ROLLBACK antes da referência, backoff, limite por tentativas e por TTL, crash após reivindicar, dois workers concorrentes |
| `test/concurrency/hot-wallet.spec.ts`              | cenário obrigatório (2 × 80.00), mesma BET 50× em paralelo, hot wallet, wallets distintas em paralelo, **3 processos reais** (`Bun.spawn`) |
| `test/http/api.spec.ts`                            | a aplicação Nest de verdade: cada status HTTP, replay espelhando 422, paginação do ledger, consultas, reconciliação, health, `/metrics` |
| `test/messaging/consumer.spec.ts`                  | inbox e ack, redelivery sem débito duplicado, **worker morto depois do commit e antes do ack**, rejeição sem DLQ, erros permanentes na DLQ com motivo, retry com backoff, retry esgotado, SIGTERM |
| `test/messaging/outbox-publisher.spec.ts`          | publicação e marcação, **dois publishers sem nenhum envio duplicado**, **publisher morto após reivindicar**, broker fora do ar com retry e `last_error` |
| `test/recovery/restart.spec.ts`                    | **reinício do serviço**: a aplicação real é morta com SIGKILL no meio da carga (fila + HTTP), outra instância termina; nenhum débito perdido ou duplicado, inbox completo, outbox toda publicada, SIGTERM encerra limpo |

Mapa dos testes obrigatórios de concorrência do desafio (seção 13):

| Exigido                                         | Onde                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| mesma aposta 50× em paralelo                    | `hot-wallet.spec.ts`                                                 |
| operações disputando o saldo (100 / 2 × 80)     | `hot-wallet.spec.ts`                                                 |
| wallets distintas em paralelo                   | `hot-wallet.spec.ts`                                                 |
| ≥ 3 processos/instâncias                        | `hot-wallet.spec.ts` (3 processos), `restart.spec.ts`, compose com 3 réplicas |
| worker morto depois do commit e antes do ack    | `consumer.spec.ts`, `restart.spec.ts`                                |
| dois publishers sobre a mesma outbox            | `outbox-publisher.spec.ts`                                           |
| ROLLBACK ou REFUND antes da referência          | `pending-reference.spec.ts`, `wager-rules.spec.ts`                   |
| reinício com comprovação da consistência final  | `restart.spec.ts`                                                    |

Decisões para que os testes sejam determinísticos:

- **Banco próprio:** os testes usam `wagering_test` (`test/setup.ts`), separado do banco do
  servidor de desenvolvimento, cujos workers disputariam pendentes e eventos.
- **Filas próprias:** cada suíte de mensageria cria filas com nome aleatório no LocalStack e as
  apaga no fim.
- **Keys únicas por execução:** cada suíte prefixa as keys com um id aleatório, então a suíte
  roda várias vezes sem recriar o banco (o ledger proíbe TRUNCATE).
- **Relógio controlável:** o `Clock` é uma porta. Worker e publisher avançam o tempo sem `sleep`.
- **Races provadas, não presumidas:** o teste de fork espera, via `pg_stat_activity`, a segunda
  conexão estar de fato bloqueada no índice único antes de commitar a primeira. O teste de
  3 processos sincroniza o início por um horário combinado.

## 20. Execução e implantação

- `Dockerfile` com Bun (sem etapa de build: o Bun executa TypeScript direto).
- `docker-compose.yml`:
  - `postgres` e `localstack` (sobem sozinhos com `bun run db:up`, para desenvolvimento e testes);
  - perfil `app`: um serviço `migrate` que aplica as migrations e termina, e **3 réplicas** da
    aplicação (`localhost:3001-3003`) que só sobem depois que a migração conclui e o LocalStack
    fica saudável. Todas rodam API, consumer, publisher e worker: a coordenação entre elas é
    feita só pelo banco (locks por linha, `SKIP LOCKED`, leases e unicidade).
  - healthcheck pelo `/health/ready`; `stop_grace_period: 30s` para o encerramento limpo.
- Configuração por variáveis de ambiente, validada no boot (`src/config.ts`): `DATABASE_URL`,
  `AWS_ENDPOINT_URL`, nomes das filas, `SQS_MAX_ATTEMPTS`, leases, intervalos, `LOG_LEVEL` e
  liga/desliga de cada worker.

## 21. Limitações conhecidas

- **Retenção da outbox:** o trigger proíbe DELETE e a tabela cresce sem limite. Em
  produção, usar arquivamento/particionamento com uma exceção controlada (ex.: permitir
  DELETE de mensagens publicadas há mais de N dias). O mesmo vale para o inbox.
- **Hot wallet:** o lock pessimista serializa as operações da mesma wallet, e o throughput
  por wallet é limitado ao tempo de uma transação.
- **Triggers por lançamento:** o encadeamento lê o último lançamento a cada insert, e a
  checagem deferida faz o mesmo no COMMIT. É uma consulta por índice
  (`UNIQUE (wallet_id, wallet_version)`), de custo constante por operação.
- **`WALLET_NOT_FOUND` não é persistida**: `wager_transactions.wallet_id` tem FK para
  `wallets`, então não há onde gravar. A API devolve 422 e a fila manda a mensagem para a
  DLQ (com o motivo), que é o registro auditável desse caso. Não há evento de integração.
- **At-least-once na saída:** um evento pode ser publicado mais de uma vez (crash entre publicar
  e marcar). O consumidor precisa deduplicar por `eventId`.
- **Workers por intervalo:** consumer, publisher e worker de pendentes rodam em todas as
  réplicas. É simples e seguro (SKIP LOCKED e leases), mas cada réplica consulta o banco a cada
  intervalo mesmo sem trabalho. Em escala maior, separar workers em processos próprios.
- **Métricas em memória por processo:** zeram no reinício e precisam ser coletadas de cada
  réplica (o normal no Prometheus).
- **CorrelationId do worker:** o `correlationId` da requisição original não é persistido.
  Eventos emitidos ao resolver uma pendente usam `pending-reference:<transactionId>` como
  correlação e o id da transação como `causationId`.
- **Reversão parcial** e **ledger de partidas dobradas** estão fora de escopo.
- Autenticação não implementada (ver seção 12).
