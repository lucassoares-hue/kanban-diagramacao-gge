# Estrutura da Planilha (Google Sheets)

Este documento descreve a estrutura da planilha do Google Sheets utilizada
como banco de dados do Kanban de diagramação do GGE. A planilha é a fonte
única de verdade para as demandas da equipe e para a medição de
produtividade, sendo acessada e atualizada pelo backend em Google Apps
Script.

## Planilha

- **Nome da planilha**: `KANBAN_DIAGRAMACAO_GGE_BASE`

## Abas

A planilha é composta por 4 abas, cada uma com uma responsabilidade
específica:

| Aba | Função |
|---|---|
| `BASE_DEMANDAS` | Armazena os dados de cada demanda de diagramação (cards do Kanban). É a tabela principal do sistema. |
| `LOG_MOVIMENTACOES` | Registra o histórico de ações e alterações feitas em cada demanda, servindo de auditoria e base para cálculo de métricas. |
| `LISTAS` | Armazena as listas de valores fixos (diagramadores, status, prioridades, etc.) usadas para preencher menus e validações no Kanban e na planilha. |
| `DASHBOARD` | Reservada para exibição futura dos indicadores de produtividade da equipe. |

---

### 1. BASE_DEMANDAS

Tabela principal do sistema. Cada linha representa uma demanda de
diagramação (um card do Kanban).

| Coluna | Descrição |
|---|---|
| `ID` | Identificador único da demanda. |
| `Data_Criacao` | Data e hora em que a demanda foi criada. |
| `Ultima_Atualizacao` | Data e hora da última alteração registrada na demanda. |
| `Diagramador` | Nome do diagramador responsável pela demanda. |
| `Ano_Escolar` | Ano escolar ao qual o material pertence. |
| `Modulo` | Módulo do material relacionado à demanda. |
| `Frente` | Frente/disciplina relacionada à demanda. |
| `Atividade` | Descrição da atividade/material a ser diagramado. |
| `Inicio` | Data e hora em que a execução da demanda foi iniciada. |
| `Previsto` | Data e hora prevista para conclusão da demanda. |
| `Fim` | Data e hora em que a demanda foi efetivamente concluída. |
| `Status` | Situação atual da demanda (ex: A Fazer, Em Andamento, Pausado, Concluído). |
| `Prioridade` | Nível de prioridade da demanda (ex: Alta, Média, Baixa). |
| `Pausa` | Indica se a demanda está atualmente pausada. |
| `Motivo_Pausa` | Motivo da pausa, quando aplicável. |
| `Observacoes` | Campo livre para anotações sobre a demanda. |
| `Link_Arquivo` | Link para o arquivo/material em diagramação. |
| `Tempo_Previsto_Horas` | Tempo estimado, em horas, para execução da demanda. |
| `Tempo_Realizado_Horas` | Tempo efetivamente gasto, em horas, na execução da demanda. |
| `Atrasado` | Indica se a demanda está/ficou atrasada em relação ao previsto. |
| `Tempo_Atraso_Horas` | Quantidade de horas de atraso, quando houver. |

---

### 2. LOG_MOVIMENTACOES

Histórico de todas as ações realizadas sobre as demandas. Cada alteração
relevante em `BASE_DEMANDAS` gera uma linha aqui, permitindo auditoria e
cálculo de métricas de produtividade ao longo do tempo.

| Coluna | Descrição |
|---|---|
| `ID_Log` | Identificador único do registro de log. |
| `ID_Demanda` | ID da demanda à qual o log se refere (referência à aba `BASE_DEMANDAS`). |
| `Data_Hora_Acao` | Data e hora em que a ação foi realizada. |
| `Usuario` | Usuário responsável pela ação registrada. |
| `Acao` | Tipo de ação realizada (ex: criação, atualização, mudança de status, pausa). |
| `Campo_Alterado` | Nome do campo que sofreu alteração. |
| `Valor_Anterior` | Valor do campo antes da alteração. |
| `Valor_Novo` | Valor do campo após a alteração. |
| `Status_Anterior` | Status da demanda antes da ação. |
| `Status_Novo` | Status da demanda após a ação. |
| `Observacao_Log` | Campo livre para detalhes adicionais sobre a ação registrada. |

---

### 3. LISTAS

Aba de apoio contendo listas de valores fixos, usadas para preencher
menus suspensos (dropdowns) no Kanban e validações de dados na planilha.
Cada coluna representa uma lista independente.

| Coluna | Descrição |
|---|---|
| `Diagramadores` | Lista de diagramadores da equipe. |
| `Anos_Escolares` | Lista de anos escolares disponíveis. |
| `Modulos` | Lista de módulos disponíveis. |
| `Frentes` | Lista de frentes/disciplinas disponíveis. |
| `Status` | Lista de status possíveis para uma demanda. |
| `Prioridades` | Lista de níveis de prioridade possíveis. |

---

### 4. DASHBOARD

Aba reservada para uso futuro. Será utilizada para exibir, de forma
visual e consolidada, os indicadores de produtividade da equipe de
diagramação, calculados a partir dos dados de `BASE_DEMANDAS` e
`LOG_MOVIMENTACOES`. Nesta fase do projeto, a aba ainda não possui
estrutura definida.

## Indicadores planejados

Indicadores que futuramente serão exibidos na aba `DASHBOARD`:

- Total de demandas
- Demandas finalizadas
- Demandas em processo
- Demandas atrasadas
- Demandas finalizadas por diagramador
- Tempo médio de execução
- Taxa de atraso
- Volume por semana
- Volume por mês
- Tempo em pausa
