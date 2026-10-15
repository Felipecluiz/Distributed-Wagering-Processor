# Teste de carga

Um experimento com objetivo definido: medir o serviço com 3 réplicas sob carga mista, descobrir
onde ele satura e confirmar que a correção financeira se mantém sob pressão. O experimento
encontrou dois gargalos, ambos foram corrigidos, e a segunda execução mede o efeito.

Como reproduzir: `bun run up` e depois `bun run test:load` (o script é `scripts/load-test.ts`;
os relatórios brutos ficam em `load-test-results/`).

## Metodologia

**Ambiente.** Intel Core i5-10400F (6 núcleos / 12 threads), 31 GiB de RAM, Linux. Tudo na mesma
máquina: 3 réplicas da aplicação (Bun 1.2.15), PostgreSQL 16 com configuração padrão, LocalStack
4.4 e o próprio gerador de carga, que compete por CPU com o serviço.

**Carga.** Malha fechada: 50 clientes concorrentes, cada um envia a próxima requisição assim que
recebe a resposta, durante 30 segundos, em rodízio entre as 3 réplicas. A mistura:

| Fatia | Operação                                                                 |
| ----- | ------------------------------------------------------------------------ |
| 70%   | BET (70%) ou WIN (30%) de 1,00 a 50,00 numa de 200 wallets distribuídas  |
| 20%   | BET de 1,00 numa única **hot wallet**                                    |
| 10%   | **reenvio idêntico** de uma requisição já feita (mesma `Idempotency-Key`) |

As wallets começam com saldo suficiente para que nenhuma BET seja rejeitada: o objetivo é medir
o caminho de sucesso. Latência medida no cliente, por tipo de operação. Métricas do serviço
lidas do `/metrics` das réplicas antes e depois da carga.

**Verificação ao fim de cada execução.** O script soma, em centavos inteiros, o efeito de cada
operação aceita e compara com o saldo de cada wallet; roda a reconciliação (saldo x ledger) nas
201 wallets; e confere que cada reenvio devolveu a mesma transação e o mesmo status. Qualquer
divergência faz o script sair com código 1.

## Resultados

Mesmos parâmetros nas duas execuções. A primeira é o código como estava; a segunda, após as duas
correções descritas na próxima seção.

### Correção

| Verificação                                             | Execução 1 | Execução 2 |
| ------------------------------------------------------- | ---------- | ---------- |
| requisições                                             | 12.474     | 12.454     |
| erros (não-200 ou rede)                                 | 0          | 0          |
| saldo de cada wallet = esperado                         | ok         | ok         |
| reconciliação (saldo == ledger), 201 wallets            | ok         | ok         |
| reenvios que geraram efeito novo                        | 0 de 1.231 | 0 de 1.232 |
| duplicatas contadas pelo serviço                        | 1.231      | 1.232      |
| conflitos de lock (`lock_timeout` estourado)            | 0          | 0          |

As duplicatas contadas pelo servidor batem exatamente com os reenvios feitos pelo cliente: duas
medições independentes do mesmo fenômeno concordam.

### Throughput e latência

| | Execução 1 | Execução 2 |
| --- | --- | --- |
| throughput total | 414 req/s | 412 req/s |
| transações novas | 373/s | 371/s |
| hot wallet | 79 tx/s | 82 tx/s |

Latência em ms (p50 / p95 / p99):

| Operação             | Execução 1            | Execução 2            |
| -------------------- | --------------------- | --------------------- |
| wallets distribuídas | 52,5 / 176,7 / 239,1  | 44,5 / 197,9 / 301,0  |
| hot wallet           | 339,8 / 553,1 / 681,9 | 349,6 / 628,1 / 779,6 |
| reenvio idêntico     | 62,4 / 416,3 / 530,9  | **34,2 / 179,7 / 305,7** |

### Outbox

| | Execução 1 | Execução 2 |
| --- | --- | --- |
| lag médio de publicação | 29.052 ms | **380 ms** |
| eventos pendentes ao fim da carga | 15.420 | **44** |
| tempo para zerar a outbox depois da carga | 56,9 s | **0,5 s** |

## Análise

### Gargalo 1: o publisher da outbox tinha um teto fixo

Cada transação gera dois eventos (`WagerTransactionProcessed` e `WalletBalanceChanged`), então
373 transações/s produzem cerca de 750 eventos/s. O publisher reivindicava 50 eventos e depois
**esperava 500 ms**, mesmo com o lote cheio: um teto de 100 eventos/s por réplica, 300/s no total.
A outbox acumulou 15 mil eventos e o lag médio chegou a 29 segundos.

A correção não está no SQS nem no banco, e sim no laço do worker: lote de 200 e, quando o lote
vem cheio, a próxima rodada começa na hora. Sem backlog, o comportamento é o mesmo de antes
(consulta a cada 500 ms). Resultado: o lag médio caiu de 29 s para 380 ms (76 vezes menor) e a
outbox termina a carga praticamente vazia.

A correção financeira nunca esteve em risco: os eventos são duráveis e seriam todos publicados.
O que mudou é o quanto os consumidores dos eventos ficam atrasados em relação ao saldo real.

### Gargalo 2: o reenvio entrava na fila do lock

Um reenvio idêntico só precisa devolver o resultado gravado, mas o use case travava a wallet
antes de consultar a idempotência. Um reenvio de uma transação da hot wallet esperava na mesma
fila das apostas novas. Na primeira execução o p95 do reenvio (416 ms) estava muito mais perto da
hot wallet do que das wallets distribuídas.

A correção consulta a `Idempotency-Key` antes do lock. É seguro porque a transação gravada tem os
campos de negócio imutáveis (trigger), e a rechecagem sob o lock continua lá para a corrida em
que outra requisição com a mesma key commita entre a leitura e o lock. O p95 do reenvio caiu de
416 para 180 ms (−57%), e o reenvio passou a se comportar como uma leitura, não como uma escrita.
Todas as suítes de teste continuaram verdes, incluindo a de 50 submissões idênticas em paralelo.

### O que não mudou, e por quê: o teto serial da hot wallet

A hot wallet ficou em ~80 transações/s nas duas execuções, com p50 de ~350 ms. É o custo
assumido do lock pessimista por wallet (ARCHITECTURE, seção 6): operações da mesma wallet são
serializadas, então o throughput dela é o inverso do tempo da seção crítica, cerca de
1/80 s ≈ 12 ms por transação (lock, inserts de transação, ledger e outbox, update da wallet,
triggers e commit).

Pela Lei de Little, 80 tx/s × 0,35 s ≈ 28 clientes esperando na fila dessa única wallet, mais da
metade dos 50. Como a carga é em malha fechada, isso também limita o throughput total: o número de
414 req/s diz mais sobre "metade dos clientes presos numa wallet" do que sobre a capacidade do
serviço. As correções acima não mexeram nisso, e nem deveriam: é o comportamento correto do
desenho escolhido.

Caminhos para subir esse teto, não implementados:
- **Encurtar a seção crítica:** juntar os inserts (transação, ledger, outbox) em menos idas ao
  banco. Cada ida evitada dentro do lock vale direto em throughput da hot wallet.
- **Agrupar por wallet (group commit):** uma instância pega o lock uma vez e aplica várias
  operações enfileiradas da mesma wallet na mesma transação. Exige rotear a mesma wallet para a
  mesma instância, o que o `MessageGroupId = walletId` da fila FIFO já favorece.

Locking otimista não resolveria: na hot wallet quase toda tentativa conflita, e o retry soma
latência em vez de removê-la.

### Efeito colateral nas wallets distribuídas

A cauda das wallets distribuídas piorou na segunda execução (p99 de 239 para 301 ms), enquanto o
p50 melhorou (52 para 44 ms). A explicação mais provável: o publisher agora drena **durante** a
carga, em vez de acumular para depois, e disputa CPU e banco com as requisições na mesma máquina.
É o custo esperado de publicar em tempo real. Não dá para afirmar mais do que isso: foi uma
execução de cada lado, e variações de 10% a 20% na cauda estão dentro do que se espera entre
execuções repetidas, que não foram medidas.

## Limites do experimento

- **Tudo na mesma máquina.** O gerador de carga, as 3 réplicas, o Postgres e o LocalStack
  disputam os mesmos 6 núcleos. Os números absolutos dizem pouco sobre um ambiente de produção;
  as comparações entre execuções e entre tipos de operação são o que importa.
- **Malha fechada.** O cliente só envia a próxima requisição depois da resposta. Perto da
  saturação, isso esconde latência (*coordinated omission*): com chegadas independentes, a fila da
  hot wallet cresceria sem limite acima de ~80 tx/s.
- **Uma execução por configuração**, sem aquecimento e sem repetição: não há intervalo de
  confiança.
- **LocalStack não é o SQS.** A latência e os limites de throughput do broker real são outros.
- **Postgres com configuração padrão**, num banco que já tinha dados de execuções anteriores.
