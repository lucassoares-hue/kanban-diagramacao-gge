# Relatório de Continuidade do Projeto — Kanban Diagramação GGE

> Auditoria técnica somente leitura, de 05/11/2026. Nenhum arquivo do sistema foi alterado.
> Legenda: **[COMPROVADO]** = evidência no código/git · **[HIPÓTESE]** = inferência não confirmada.
> Dados sensíveis (senha, ID completo do Web App) foram omitidos de propósito.

---

## 1. Resumo executivo

O projeto é um **painel Kanban/tabela operacional web** ("KANBAN - SGGE") para a equipe de diagramação do Sistema GGE de Ensino. O frontend é **HTML/CSS/JS puro (sem build nem dependências)** e usa como banco de dados uma **planilha Google Sheets**, acessada por meio de um **Web App do Google Apps Script**.

O frontend está maduro (cerca de 2.500 linhas de JS e 2.200 de CSS), com tabela editável por núcleo, Kanban visual, resumo gerencial protegido por senha, Kanban geral e carrossel da equipe.

**O backend versionado no repositório está incompleto.** As ações `buscarDemandas`, `buscarConfiguracoes`, `criarDemanda` e `atualizarDemanda` e a função `registrarLog` **não existem no repositório** e só estão no Apps Script publicado em produção. Não há `doGet` versionado. Esse é o principal risco do projeto: se alguém publicar o `apps-script/` atual por cima do de produção, o sistema para de funcionar.

## 2. Finalidade do sistema

- Organizar as demandas diárias de diagramação por **núcleo** (Núcleo 1–6 e Ilustração) e **diagramador**.
- Registrar Início, Previsto e Fim para medir produtividade e atrasos (`docs/estrutura-planilha.md`).
- Dar à gestão uma visão consolidada: atrasadas, diagramadores livres/ocupados e Kanban geral.
- Dar acesso rápido a planilhas auxiliares (imagens, QRs, ilustração).

## 3. Tecnologias utilizadas

| Camada | Tecnologia | Evidência |
|---|---|---|
| Frontend | HTML5, CSS3 (com media queries), JavaScript ES2017+ (async/await, fetch) | `index.html`, `styles.css`, `script.js` |
| Backend | Google Apps Script (Web App: `doPost`/`doGet`) | `apps-script/*.gs` |
| Banco de dados | Google Sheets `KANBAN_DIAGRAMACAO_GGE_BASE` | `docs/estrutura-planilha.md` |
| Cache | `localStorage` do navegador | `script.js:25`, `script.js:237-310` |
| Servidor local | `python -m http.server` | `.claude/launch.json` |
| Hospedagem | **[HIPÓTESE]** GitHub Pages (arquivos movidos de `frontend/` para a raiz no commit `8b08e0c`, "Atualiza arquivos publicados") | git log |

Não há `package.json`, bibliotecas externas, CDN, framework nem testes automatizados.

## 4. Arquitetura

```
Navegador (index.html + script.js + styles.css)
   │  GET  ?acao=buscarDemandas / ?acao=buscarConfiguracoes   (lê JSON)
   │  POST text/plain {acao, dados}  criarDemanda / atualizarDemanda / excluirDemanda (lê JSON)
   │  POST no-cors {acao, demanda}   criar / atualizar  (legado, modal — resposta opaca)
   ▼
Google Apps Script Web App (WEB_APP_URL em script.js:22)
   ▼
Google Sheets: BASE_DEMANDAS · LOG_MOVIMENTACOES · LISTAS · DASHBOARD (vazia)
```

- Estado global em memória: `demandas`, `configuracoes`, `nucleoSelecionado`, `telaAtual`, `visualizacaoResumoAtiva` e `linhasTemporariasTabela` (`script.js:150-190`).
- Renderização imperativa: `renderizarTela()` (`script.js:1283`) recalcula **todas** as telas a cada alteração.
- A planilha é a fonte de verdade. O `localStorage` deveria servir só como fallback (veja o problema P5).

## 5. Estrutura de arquivos

| Caminho | Papel |
|---|---|
| `index.html` | Todas as telas (SPA de uma página): cabeçalho, resumo, tabela, Kanban, modal de demanda, splash e modal de senha |
| `script.js` | Toda a lógica do frontend |
| `styles.css` | Estilos e responsividade (breakpoints em 900, 600 e 480 px) |
| `assets/logo-gge.png` | Logo |
| `apps-script/Code.gs` | `doPost` **parcial** (só `excluirDemanda`) e `respostaJson` |
| `apps-script/Config.gs` | `ABA_BASE_DEMANDAS` e `abrirPlanilha()` (`getActiveSpreadsheet`) |
| `apps-script/Demandas.gs` | Somente `excluirDemanda()` |
| `apps-script/Logs.gs` | **Vazio**: só o comentário dizendo que `registrarLog` existe em produção |
| `docs/estrutura-planilha.md` | Esquema das 4 abas e indicadores planejados |
| `docs/fluxo-operacional.md` | Placeholder ("a ser detalhado") |
| `README.md` | **Desatualizado** (cita `frontend/` e "ainda não implementado") |
| `.claude/launch.json` | Servidor local apontando para `--directory frontend` (pasta que não existe mais) |

## 6. Mapeamento das páginas e funcionalidades

### 6.1 Navegação

O cabeçalho tem o botão **Resumo dos núcleos** (protegido por senha) e botões de núcleo, que `reconstruirBotoesDeNucleo()` (`script.js:435`) recria a partir da planilha. A tela inicial é **Núcleo 1, tabela** (`script.js:162-168`). As telas são alternadas pela classe `.oculto` em `renderizarTela()`.

```
Cabeçalho ─┬─ Resumo dos núcleos (senha) ─┬─ Visão da equipe (atrasadas + livres/ocupados)
           │                              ├─ Kanban Visual Geral (filtro por núcleo)
           │                              └─ Equipe de Diagramação (carrossel) ── "← Resumo"
           └─ Núcleo N ── Tabela operacional ── [Kanban Visual] ── "Voltar para tabela"
                                └─ botões para as planilhas auxiliares (nova aba)
```

### 6.2 Funcionalidades

| # | Funcionalidade | Arquivos / funções | Como funciona | Estado |
|---|---|---|---|---|
| F1 | Splash de abertura | `index.html:406`, `esconderSplashScreen` | Fade-out no `finally` da inicialização | IMPLEMENTADA |
| F2 | Carregamento das configurações (aba LISTAS) | `carregarConfiguracoes` `script.js:394` | GET `?acao=buscarConfiguracoes`, mesclado com `CONFIGURACOES_EMERGENCIA` | IMPLEMENTADA no frontend · backend **não versionado** (NÃO VERIFICADA) |
| F3 | Carregamento das demandas | `carregarDemandas` `script.js:357`, `mapearDemandaDoServidor` `:324` | GET `?acao=buscarDemandas` → converte para camelCase | IMPLEMENTADA no frontend · backend **não versionado** · o fallback não funciona (P5) |
| F4 | Tabela operacional editável por núcleo | `renderizarTabela` `:1092`, `criarCelula*` `:730-840` | Blocos de no mínimo 6 linhas por diagramador; cada célula salva sozinha. Oculta as demandas com Fim preenchido, exceto quando o filtro é "Finalizado" | IMPLEMENTADA |
| F5 | Criação por linha temporária | `salvarCampoDemanda` `:948`, `criarDemandaApartirDaLinhaTemporaria` `:1031` | Os campos ficam em memória até Atividade ou Início serem preenchidos; aí é feito o POST `criarDemanda`, que precisa devolver o ID | IMPLEMENTADA (depende do backend não versionado) |
| F6 | Atualização por célula | `atualizarCampoDeDemandaExistente` `:992` | POST `atualizarDemanda` com o ID; salvamentos da mesma linha são serializados | IMPLEMENTADA · em caso de erro, só registra no console (sem aviso ao usuário) |
| F7 | Status automático | `calcularStatusAutomatico` `:661` | Fim → Finalizado; Pausado/Prioridade; Início → Em processo; Atividade → FILA | IMPLEMENTADA · "Atrasado" nunca é gravado como status (é calculado por `estaAtrasada`) |
| F8 | Exclusão de demanda | `excluirDemanda` `script.js:2476` + `Demandas.gs` | Confirmação → POST `excluirDemanda` → remove a linha por ID e registra log | IMPLEMENTADA (é a única ação com código versionado) |
| F9 | Filtros (diagramador, status, busca) | `aplicarFiltros` `:2176`, `popularFiltroDiagramadores` `:2155` | Re-renderiza a tabela | IMPLEMENTADA · o filtro "A iniciar" × o status "FILA" depende de `normalizarStatus` (NÃO VERIFICADA) |
| F10 | Cards de contadores do núcleo | `atualizarContadores` `:2136` | Total, em processo, atrasadas, finalizadas | IMPLEMENTADA |
| F11 | Kanban Visual do núcleo | `renderizarKanbanVisual` `:2080` | Colunas Backlog, Em processo, Pausado, Prioridade e Finalizado (somente leitura, sem arrastar) | IMPLEMENTADA |
| F12 | Resumo dos núcleos protegido por senha | `solicitarSenhaResumoNucleos` `:2248` | Senha comparada **no próprio JS do cliente** | IMPLEMENTADA · COM PROBLEMAS (P3) |
| F13 | Visão da equipe | `atualizarDemandasCriticas` `:1750`, `renderizarDiagramadores*` `:1790-1935` | Lista de atrasadas e diagramadores livres/ocupados por grupo | IMPLEMENTADA |
| F14 | Kanban Visual Geral | `renderizarKanbanVisualGeral` `:1550` | Blocos por núcleo com filtro | IMPLEMENTADA |
| F15 | Carrossel Equipe de Diagramação | `renderizarCarrosselEquipe` `:1307` | Cards com foto (coluna I da aba LISTAS) ou iniciais; ativa `body.modo-equipe-diagramacao` | IMPLEMENTADA |
| F16 | Links das planilhas auxiliares | `configurarEventos` `:2202-2210` | `window.open` | IMPLEMENTADA |
| F17 | Modal "Nova demanda" | `abrirModalNovaDemanda` `:2369`, `aoSubmeterFormulario` `:2404`, `enviarDemandaParaAppsScript` `:2543` | **Nenhum botão abre o modal** (o botão foi removido, `script.js:2192`). Usa as ações legadas `criar`/`atualizar` com `no-cors` e o formato `{demanda}` | PARCIAL / código morto |
| F18 | Campos Pausa, Motivo da pausa, Observações e Link do arquivo | modal e `montarDadosDemandaParaAppsScript` `:875` | Existem no modal e na planilha, mas **não são enviados** pela tabela | PARCIAL |
| F19 | Log de movimentações | `registrarLog` (produção) | Chamado em `Demandas.gs`; não está implementado no repositório | NÃO VERIFICADA |
| F20 | Aba DASHBOARD / indicadores de produtividade | `docs/estrutura-planilha.md` ("Indicadores planejados") | Tempo médio, taxa de atraso, volume semanal/mensal, tempo em pausa | NÃO IMPLEMENTADA (prevista) |
| F21 | Documento de fluxo operacional | `docs/fluxo-operacional.md` | Placeholder | NÃO IMPLEMENTADA (prevista) |

Observação: nada foi executado no navegador nem contra o Web App, para evitar escrita na planilha. "IMPLEMENTADA" significa que há código coerente, não que foi testado. `node --check script.js` passou sem erros de sintaxe.

### 6.3 Interface

- **Identidade visual:** logo GGE, título "KANBAN - SGGE", selos coloridos por status, hero institucional com orbes e anéis decorativos no carrossel e crédito na splash.
- **Responsividade:** media queries em 900, 600 e 480 px; a tabela usa o wrapper `quadro-scroll` para rolagem horizontal com cabeçalho fixo. **[NÃO VERIFICADA visualmente]**
- **Inconsistências:**
  - o modal de demanda é inalcançável;
  - os selects de status do HTML (`A iniciar`, `Atrasado`) diferem dos valores calculados (`FILA`, `Prioridade`);
  - o select de núcleo do modal é fixo no HTML, e os botões do cabeçalho são reconstruídos pela planilha;
  - a ação "Excluir" usa `confirm`/`alert` nativos.

## 7. Fluxo de dados e integrações

1. **Inicialização** (`script.js:206`): `limparCacheLocalKanban()` → `carregarDemandas()` (GET) → `carregarConfiguracoes()` (GET) → monta a interface.
2. **Leitura:** a planilha devolve os campos `ID`, `Diagramador`, `Nucleo` etc. `mapearDemandaDoServidor` converte para o formato interno. O núcleo vem do campo `Nucleo` ou é deduzido pelo diagramador (`obterNucleoDaDemanda`).
3. **Escrita pela tabela:** a célula é alterada → linha temporária (em memória) → `criarDemanda` (devolve o ID) → as edições seguintes usam `atualizarDemanda` com o ID → re-renderização local, sem refetch.
4. **Exclusão:** `excluirDemanda` → o Apps Script localiza o ID na coluna A, faz `deleteRow` e chama `registrarLog`.
5. **Integrações externas:**
   - Web App do Apps Script;
   - 3 planilhas auxiliares (somente links);
   - fotos dos diagramadores por URL (aba LISTAS).
6. **Autenticação/autorização:**
   - o Web App não tem nenhuma autenticação: qualquer pessoa com a URL pode ler, criar, alterar e excluir;
   - a senha do resumo só existe no cliente;
   - o usuário registrado no log costuma ser "Usuário não identificado".
7. **Validação:** mínima. O backend só valida o ID na exclusão; o frontend só verifica `required` no modal.
8. **Campos enviados** (`montarDadosDemandaParaAppsScript`): Diagramador, Nucleo, Ano_Escolar, Modulo, Frente, Atividade, Inicio, Previsto, Fim, Status, Prioridade. **Não são enviados:** Pausa, Motivo_Pausa, Observacoes, Link_Arquivo, tempos e o `slot` (a ordem da linha na tabela não é persistida).
9. **Divergência de esquema:** a planilha real tem a coluna `Nucleo`, que não aparece em `docs/estrutura-planilha.md`. `Demandas.gs` assume que o Status está no índice 11 (`demandaAntes[11]`), o que depende da ordem real das colunas.

## 8. Estado atual do desenvolvimento

**Comprovado (git):**

- `548b76f` (07/07/2026): commit inicial, já com o frontend completo em `frontend/`.
- `35df7e6`: upload pelo GitHub com os arquivos na raiz.
- `8b08e0c` (08/07/2026): "Atualiza arquivos publicados do dashboard". Moveu `frontend/` para a raiz e adicionou o **modal de senha do resumo** e a **tela inicial no Núcleo 1** (antes, a tela inicial era o resumo).
- `cee98da` (08/07/2026): merge "Resolve conflitos mantendo versão local do dashboard". Working tree limpo.

**Indícios no código:**

- vários comentários "LOG TEMPORÁRIO" (32 chamadas `console.log`);
- comentários extensos em `Code.gs` alertando que o `doPost` de produção não está versionado.

**Hipótese sobre o ponto de interrupção:** a última tarefa foi **proteger o Resumo dos núcleos com senha, definir o Núcleo 1 como tela inicial e publicar os arquivos na raiz** (provavelmente no GitHub Pages). Antes disso, houve uma rodada de correções de persistência ("linha sumindo", cache ressuscitando demandas excluídas e a implementação da exclusão), como mostram os comentários em `script.js:314-355` e `:1006-1013`. **Não é possível confirmar qual era a próxima tarefa planejada.**

## 9. Problemas e riscos identificados

| ID | Prioridade | Arquivo | Evidência | Impacto | Correção recomendada |
|---|---|---|---|---|---|
| P1 | **CRÍTICA** | `apps-script/*.gs` | `Code.gs` só trata `excluirDemanda`; não há `doGet`, `buscarDemandas`, `buscarConfiguracoes`, `criarDemanda`, `atualizarDemanda` nem `registrarLog` | O backend real existe só no editor do Apps Script: sem backup nem histórico, e publicar o repositório quebra o sistema | Copiar o código de produção para o repositório (somente leitura no editor do GAS e depois commit) |
| P2 | **ALTA** | Web App | Nenhuma verificação de identidade ou token nas ações | Qualquer pessoa com a URL (visível no JS público) pode excluir ou alterar a base | Adicionar um token compartilhado ou restringir o acesso ao domínio Google Workspace; validar as entradas |
| P3 | **ALTA** | `script.js:2245` | Senha em texto puro no JS público | A proteção é só cosmética; a senha fica exposta | Tratar como "cortina visual" ou validar no Apps Script; trocar a senha atual, que já foi publicada |
| P4 | **ALTA** | `Demandas.gs` (e provavelmente as demais ações) | `deleteRow` sem `LockService`; a exclusão é feita por varredura | Uso simultâneo pode excluir ou atualizar a linha errada | Usar `LockService.getScriptLock()` nas escritas |
| P5 | MÉDIA | `script.js:211-217`, `:380` | O cache é apagado **antes** de buscar; o fallback lê o cache vazio | Se a planilha falhar, a tela aparece vazia sem nenhum aviso | Decidir: remover o fallback ou só limpar o cache depois de um carregamento bem-sucedido; mostrar um aviso de erro |
| P6 | MÉDIA | `script.js:992-1088` | Falhas de salvamento só aparecem no `console.error` | O usuário acha que salvou, mas não salvou | Mostrar um aviso visual (toast) de erro ou sucesso |
| P7 | MÉDIA | `script.js:2369-2560` | O modal não tem gatilho e usa as ações legadas `criar`/`atualizar` com `no-cors` | Código morto e confuso; a ação `criar` pode não existir no backend | Remover ou reconectar às ações `criarDemanda`/`atualizarDemanda` |
| P8 | MÉDIA | `montarDadosDemandaParaAppsScript` | Pausa, motivo, observações, link e `slot` não são enviados | Campos da planilha nunca são preenchidos; a ordem das linhas não persiste | Definir o escopo e incluir os campos no envio |
| P9 | MÉDIA | `docs/estrutura-planilha.md`, `Demandas.gs:96` | Coluna `Nucleo` não documentada; `demandaAntes[11]` fixo | O log pode gravar o status errado | Localizar as colunas pelo cabeçalho |
| P10 | BAIXA | `.claude/launch.json` | `--directory frontend` | O servidor local não abre o projeto | Trocar para `.` |
| P11 | BAIXA | `README.md` | Estrutura e status desatualizados | Confunde quem retoma o projeto | Atualizar |
| P12 | BAIXA | `script.js` | 32 `console.log`, vários marcados como temporários | Ruído e exposição de dados no console | Remover ou condicionar a uma flag `DEBUG` |
| P13 | BAIXA | `script.js` (26 usos de `innerHTML`) | Usa `escaparTexto`, mas nem todos os pontos foram auditados | Risco de XSS com dados da planilha | Auditar cada template |
| P14 | BAIXA | `renderizarTela` | Re-renderiza as 3 telas a cada edição | Pode ficar lento com muitas demandas | Renderizar só a tela visível |
| P15 | BAIXA | `index.html` | Status e núcleos fixos no HTML × lista dinâmica | Divergências quando a planilha mudar | Popular todos os selects pela configuração |

## 10. Pendências

- Versionar o backend de produção (P1).
- Documentar o fluxo operacional (`docs/fluxo-operacional.md`).
- Atualizar o esquema real da planilha (coluna `Nucleo`, ordem das colunas).
- Aba DASHBOARD e indicadores planejados.
- Definir o destino do modal e dos campos não enviados (P7, P8).
- Corrigir `launch.json` e `README.md`.

## 11. Plano de continuidade priorizado

### ETAPA 1 — Recuperação e estabilização

| Atividade | Objetivo | Arquivos | Prioridade | Depende de | Critério de conclusão |
|---|---|---|---|---|---|
| 1.1 Versionar o Apps Script de produção | Ter backup e fonte única | `apps-script/*.gs` | CRÍTICA | Acesso ao editor do GAS | Todas as ações chamadas pelo frontend têm código no repositório, idêntico ao publicado |
| 1.2 Documentar o esquema real da planilha | Alinhar documentação e código | `docs/estrutura-planilha.md` | ALTA | 1.1 | Colunas e ordem conferidas com a planilha |
| 1.3 Corrigir o ambiente local | Conseguir rodar e testar | `.claude/launch.json`, `README.md` | BAIXA | — | `http://localhost:3000` abre o painel |
| 1.4 Teste manual guiado em uma cópia da planilha/Web App de homologação | Validar F2–F8 sem risco | — | ALTA | 1.1 | Checklist de criar, editar, excluir e filtrar aprovado |

### ETAPA 2 — Conclusão das funcionalidades existentes

| Atividade | Objetivo | Arquivos | Prioridade | Depende de | Critério de conclusão |
|---|---|---|---|---|---|
| 2.1 Feedback de erro e sucesso | O usuário saber se salvou | `script.js`, `styles.css` | ALTA | 1.4 | Toast visível nas falhas de criar, atualizar e excluir |
| 2.2 Corrigir o fallback de cache | Comportamento previsível em caso de falha | `script.js:206-260, 357` | MÉDIA | — | Falha de rede mostra um aviso e não uma tela vazia silenciosa |
| 2.3 Decidir o destino do modal | Remover o código morto ou reativar | `index.html`, `script.js:2355-2560` | MÉDIA | 1.1 | Sem chamadas às ações legadas |
| 2.4 Enviar campos ausentes (observações, link, motivo da pausa, slot) | Completar o modelo de dados | `script.js:875`, Apps Script | MÉDIA | 1.1, 1.2 | Campos gravados e relidos corretamente |
| 2.5 `registrarLog` em todas as ações | Auditoria completa | `Logs.gs` | MÉDIA | 1.1 | LOG_MOVIMENTACOES recebe criação, edição e exclusão |

### ETAPA 3 — Melhorias técnicas e visuais

- **3.1 Segurança (ALTA):** token nas chamadas ao Web App, `LockService`, validação de entradas e senha validada no servidor (P2–P4).
- **3.2 Limpeza (BAIXA):** remover os logs temporários e unificar os selects dinâmicos (P12, P15).
- **3.3 Desempenho (BAIXA):** renderizar só a tela ativa (P14).
- **3.4 Segurança de exibição (BAIXA):** auditoria de `innerHTML` (P13).
- **3.5 Organização (BAIXA, opcional):** dividir `script.js` em módulos (dados, tabela, Kanban, resumo), sem mudar o comportamento.

### ETAPA 4 — Evolução do sistema

**Previstas na documentação:**

- aba DASHBOARD com os indicadores listados em `docs/estrutura-planilha.md` (total, finalizadas, em processo, atrasadas, por diagramador, tempo médio, taxa de atraso, volume semanal/mensal, tempo em pausa);
- cálculo de `Tempo_Realizado_Horas`, `Atrasado` e `Tempo_Atraso_Horas`;
- documento de fluxo operacional.

**Sugestões novas (sem evidência de que estavam planejadas):**

- arrastar e soltar no Kanban Visual;
- atualização automática periódica (polling);
- login por conta Google Workspace;
- exportação de relatórios.

## 12. Próxima tarefa recomendada

**Versionar no repositório o código do Apps Script que está publicado em produção (atividade 1.1).** O trabalho é só de leitura e cópia, sem nenhuma alteração no comportamento.

## 13. Informações necessárias para retomar o projeto

- Acesso de leitura ao **editor do Apps Script** vinculado ao Web App usado em `script.js:22` e confirmação de qual implantação (versão) está ativa.
- Se o script é *container-bound* ou standalone (`Config.gs:abrirPlanilha`).
- Acesso à planilha `KANBAN_DIAGRAMACAO_GGE_BASE` (cabeçalhos reais das abas).
- Onde o frontend está publicado (GitHub Pages? qual repositório ou branch?).
- Se existe um ambiente de homologação (cópia da planilha e outro Web App) para testes seguros.
- Decisões de produto: manter ou remover o modal; nível de segurança desejado; prioridade do DASHBOARD.
