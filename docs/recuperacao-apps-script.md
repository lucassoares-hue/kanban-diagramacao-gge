# Recuperação do Apps Script de produção

Este documento orienta a cópia do código do Apps Script que está em produção para o repositório, **antes** de qualquer integração nova (por exemplo, as férias). Esta etapa é só de backup: não publica nada, não altera a planilha e não faz nenhuma escrita.

## Situação em 09/11/2026

**O código completo de produção não foi recuperado.** Não há acesso ao código-fonte a partir deste ambiente: o `clasp` não está instalado nem autenticado, o projeto local não está vinculado a um `scriptId` e não há integração com o Google Drive ou com o Apps Script. A URL pública do Web App executa o código, mas não entrega o fonte.

### O que já está no repositório (`apps-script/`)

| Arquivo | Conteúdo | Situação |
|---|---|---|
| `Code.gs` | `doPost` (só a ação `excluirDemanda`) e `respostaJson` | **Parcial.** Não pode ser publicado. |
| `Config.gs` | `ABA_BASE_DEMANDAS` e `abrirPlanilha` | Provavelmente igual à produção (a confirmar) |
| `Demandas.gs` | `excluirDemanda` | **Parcial.** Faltam criar, atualizar e buscar. |
| `Logs.gs` | Só um comentário | **Vazio.** `registrarLog` existe só em produção. |
| `Ferias.gs` | Funções de férias | **Novo**, ainda não está em produção. Manter separado. |

### Funções que existem só em produção (exigidas pelo frontend)

| Função ou ação | Como o frontend usa | Resposta esperada |
|---|---|---|
| `doGet` | GET `?acao=...` | Sem ação conhecida, responde `{"sucesso":true,"mensagem":"Kanban Diagramação GGE - Apps Script online"}` (comportamento observado) |
| `buscarDemandas` | GET `?acao=buscarDemandas` | `{ sucesso, demandas: [ { ID, Data_Criacao, Ultima_Atualizacao, Diagramador, Nucleo, Ano_Escolar, Modulo, Frente, Atividade, Inicio, Previsto, Fim, Status, Prioridade, Pausa, Motivo_Pausa, Observacoes, Link_Arquivo, Tempo_Previsto_Horas, Tempo_Realizado_Horas, Atrasado, Tempo_Atraso_Horas } ] }` |
| `buscarConfiguracoes` | GET `?acao=buscarConfiguracoes` | `{ sucesso, configuracoes: { anosEscolares, modulos, frentes, status, prioridades, diagramadoresPorNucleo, fotosDiagramadores } }` |
| `criarDemanda` | POST `{ acao: "criarDemanda", dados }` | `{ sucesso, id }` (o frontend também aceita `ID` ou `demanda.ID`) |
| `atualizarDemanda` | POST `{ acao: "atualizarDemanda", dados: { ID, ... } }` | `{ sucesso, mensagem }` |
| `registrarLog` | Chamada interna (por exemplo, por `excluirDemanda`) | Grava em `LOG_MOVIMENTACOES` |
| `doPost` completo | Todas as ações POST acima, mais `excluirDemanda` | — |

- **Campos enviados em `criarDemanda` e `atualizarDemanda`:** `Diagramador`, `Nucleo`, `Ano_Escolar`, `Modulo`, `Frente`, `Atividade`, `Inicio`, `Previsto`, `Fim`, `Status` e `Prioridade` (mais o `ID` na atualização).
- **Ações legadas** (`criar` e `atualizar`, com o corpo `{ acao, demanda }`, enviadas em modo no-cors pelo modal antigo, que não é mais acessível): verificar se ainda existem no `doPost` de produção e documentar.

## Como copiar os arquivos (somente leitura)

1. Abra a planilha `KANBAN_DIAGRAMACAO_GGE_BASE` → **Extensões → Apps Script**. Se o script não for vinculado à planilha, abra o projeto pelo [script.google.com](https://script.google.com) (Meus projetos).
2. **Confirme que é o projeto certo:** em **Implantar → Gerenciar implantações**, a URL do Web App ativo deve ser igual à constante `WEB_APP_URL` do `script.js`. Anote **qual versão** está ativa. **Não edite nem crie implantações.**
3. Para **cada arquivo** listado à esquerda do editor (`.gs` e `.html`, se houver):
   1. abra o arquivo e selecione todo o conteúdo (Ctrl+A) → copiar (Ctrl+C);
   2. no repositório, crie o arquivo com **o mesmo nome** dentro de uma pasta nova: `apps-script/producao-AAAA-MM-DD/` (por exemplo, `apps-script/producao-2026-11-09/Code.gs`);
   3. **não sobrescreva** os arquivos de `apps-script/`: a pasta nova é o backup fiel.
4. Copie também o **manifesto**: em **Configurações do projeto**, ative "Mostrar arquivo de manifesto `appsscript.json`" e copie esse arquivo para a mesma pasta.
5. Anote numa linha do commit ou do relatório: data, versão da implantação ativa e se o script é vinculado à planilha (container-bound) ou independente (standalone).
6. **Não execute nenhuma função no editor** (nem com "Executar"): algumas gravam na planilha.

**Sobre dados sensíveis:** antes do commit, verifique se algum arquivo tem IDs de planilha, tokens, chaves ou e-mails pessoais. Se tiver, substitua por um marcador (por exemplo `'<ID_DA_PLANILHA>'`) e guarde o valor real fora do repositório.

### Alternativa (opcional): clasp

O `clasp` (CLI oficial do Google) baixa o projeto inteiro com `clasp clone <scriptId>`, só lendo o código. Ele exige instalar o pacote `@google/clasp` e autenticar com a sua conta Google (`clasp login`). Só use se você autorizar a instalação e o acesso. Nunca rode `clasp push` ou `clasp deploy` nesta etapa: esses comandos alteram a produção.

## Conferência depois da cópia

Com os arquivos em `apps-script/producao-AAAA-MM-DD/`, verificar:

- [ ] Existem `doGet`, `doPost`, `buscarDemandas`, `buscarConfiguracoes`, `criarDemanda`, `atualizarDemanda`, `excluirDemanda`, `registrarLog`, `abrirPlanilha` e `respostaJson`.
- [ ] O `doGet` trata `buscarDemandas` e `buscarConfiguracoes`.
- [ ] O `doPost` trata `criarDemanda`, `atualizarDemanda` e `excluirDemanda` (e, se existirem, as legadas `criar` e `atualizar`).
- [ ] As respostas seguem o contrato da tabela acima.
- [ ] Nenhuma função tem o mesmo nome de outra (ex.: duas `doPost` em arquivos diferentes geram conflito). **Atenção:** o `Code.gs` do repositório também declara `doPost` e não pode coexistir com o de produção.
- [ ] Dependências entre arquivos: `abrirPlanilha` (Config), `ABA_BASE_DEMANDAS`, `registrarLog` (Logs) e as abas `BASE_DEMANDAS`, `LOG_MOVIMENTACOES` e `LISTAS`.
- [ ] Diferenças em relação aos arquivos atuais de `apps-script/` registradas (o `excluirDemanda` do repositório foi escrito depois; confirmar se é o mesmo que está em produção).

## Riscos

- **Publicar o `apps-script/` atual** quebraria o sistema: não tem `doGet`, buscas, criação nem atualização.
- **Funções com o mesmo nome** em arquivos diferentes: o Apps Script usa a última carregada, sem avisar. Por exemplo, os `doPost` do repositório e da produção.
- **Executar funções no editor** pode gravar na planilha de produção.
- **Sem backup da versão ativa,** não é possível reverter com segurança.

## Próximos passos para integrar o `Ferias.gs` (depois da recuperação)

1. Fazer commit da pasta `apps-script/producao-AAAA-MM-DD/` sem alterações (é o backup).
2. Criar a homologação: cópia da planilha, com o Apps Script vinculado, e um **novo** Web App.
3. No Apps Script da cópia: adicionar o `Ferias.gs` e **somar** ao `doGet`/`doPost` as linhas de roteamento descritas no topo do `Ferias.gs`.
4. Validar seguindo [implantacao-ferias.md](implantacao-ferias.md). O botão "Salvar férias" se libera sozinho quando o servidor responde a `buscarFerias`.
5. Só então aplicar em produção (nova versão da mesma implantação).
