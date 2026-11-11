# Implantação do cadastro de férias

Roteiro para ativar a gravação real de férias na aba `FERIAS_DIAGRAMADORES` sem colocar em risco a base de produção.

## Situação atual

- **Backend preparado:** [`apps-script/Ferias.gs`](../apps-script/Ferias.gs), com as funções `buscarFerias`, `criarFerias`, `atualizarFerias`, `excluirFerias` e `atualizarSituacaoFerias`.
- **Frontend preparado:** [`script.js`](../script.js), com `carregarFerias` e `salvarFeriasNoBackend`. A integração é **detectada automaticamente**: ao abrir, o sistema consulta `?acao=buscarFerias` (só leitura) e libera o "Salvar férias" apenas se a resposta trouxer `sucesso: true` **e** a lista `ferias`. A resposta genérica do `doGet` atual (`{"sucesso":true,"mensagem":"...Apps Script online"}`) **não** libera o botão. A chave `FERIAS_INTEGRACAO_HABILITADA` (padrão `true`) serve para desligar tudo numa emergência.
- **Web App em uso, verificado em 09/11/2026:** responde `?acao=buscarFerias` com a mensagem genérica "online", ou seja, **as ações de férias não estão publicadas**.
- **Bloqueio:** o `doGet`/`doPost` completo de produção **não está versionado** no repositório. O [`apps-script/Code.gs`](../apps-script/Code.gs) do repositório tem só um `doPost` parcial e **não pode ser publicado** como está.

## Estrutura da aba

A linha 1 da aba `FERIAS_DIAGRAMADORES` precisa ter estes cabeçalhos. As colunas são localizadas pelo nome, então a ordem não importa.

| Cabeçalho | Conteúdo |
|---|---|
| `ID` | Gerado pelo backend: `FER-AAAAMMDDhhmmss-NNNN` |
| `Diagramador` | Nome como está cadastrado na aba LISTAS |
| `Data_Inicio` | Data (inclusiva) |
| `Data_Fim` | Data (inclusiva), maior ou igual a `Data_Inicio` |
| `Observacoes` | Opcional, até 500 caracteres |
| `Data_Registro` | Data e hora da gravação |
| `Situacao` | `Programadas`, `Em férias` ou `Encerradas` |

**Sobre a coluna `Situacao`:** o sistema **não** a usa. A situação é recalculada pelas datas a cada carregamento. O backend grava o valor no momento da escrita. Para mantê-lo atualizado para quem consulta a planilha direto, crie um acionador diário para `atualizarSituacaoFerias()` (passo 4). Essa função altera só as células cuja situação mudou.

## Regras do backend

- **Datas:** no formato `AAAA-MM-DD`. Datas inexistentes ou com ano fora de 2020–2100 são rejeitadas, assim como término anterior ao início.
- **Sobreposição:** um período não pode se sobrepor a outro do mesmo profissional. O nome é comparado sem diferenciar espaços, maiúsculas e acentos, e as datas são inclusivas. Um período que começa no dia seguinte ao fim de outro é permitido.
- **Concorrência:** todas as escritas usam `LockService`, com espera de até 15 segundos.
- **Atualização:** altera só as células do período, e não a linha inteira.
- **Respostas:** em JSON, no formato `{ sucesso: true, ... }` ou `{ sucesso: false, mensagem }`.

## Procedimento de implantação

1. **Recuperar o backend de produção.** Copie todos os arquivos do projeto Apps Script de produção para `apps-script/` e faça commit sem alterações. Esse é o backup e o ponto de comparação.
2. **Criar a homologação.**
   1. No Google Drive, faça uma cópia da planilha `KANBAN_DIAGRAMACAO_GGE_BASE` (Arquivo → Fazer uma cópia). A cópia leva junto o Apps Script vinculado.
   2. Na cópia, confirme a aba `FERIAS_DIAGRAMADORES` com os cabeçalhos acima.
   3. No Apps Script da cópia, crie o arquivo `Ferias.gs` com o conteúdo do repositório.
   4. Acrescente o roteamento descrito no topo do `Ferias.gs` ao `doGet`/`doPost` **da cópia**, mantendo todas as ações existentes.
   5. Implante a cópia como um **novo** Web App, de homologação, e anote a URL.
3. **Testar em homologação.**
   1. Copie `index.html`, `script.js`, `styles.css` e `assets/` para a pasta `homologacao/` (ignorada pelo git). Na cópia, troque `AMBIENTE_SISTEMA` para `"homologacao"` e preencha `WEB_APP_URLS.homologacao` com a URL de homologação. O cabeçalho passa a mostrar o selo **HOMOLOGAÇÃO**. Se a URL ficar vazia, nenhuma chamada é feita: **não há fallback para produção**. O botão "Salvar férias" se libera sozinho se a homologação responder a `buscarFerias`. Se continuar desabilitado, a mensagem do modal indica o motivo.
   2. Teste: cadastrar um período; tentar sobrepor (deve recusar); fim antes do início (deve recusar); recarregar e ver "Férias programadas" ou "Em férias"; criar, editar e excluir demandas normalmente, para confirmar que nada mudou nas demandas.
   3. Confira as linhas gravadas na aba da cópia.
4. **Acionador diário (opcional).** No Apps Script, vá em Acionadores → Adicionar acionador → função `atualizarSituacaoFerias` → baseado em tempo → diário.
5. **Produção.** Só depois da homologação aprovada:
   1. faça backup da planilha de produção (uma cópia datada);
   2. aplique no Apps Script de produção **as mesmas** alterações validadas: o arquivo `Ferias.gs` e as linhas de roteamento;
   3. publique uma **nova versão** da implantação existente (Gerenciar implantações → editar → nova versão), mantendo a URL;
   4. o frontend de produção não precisa de alteração: ao recarregar, ele detecta a ação `buscarFerias` e libera o botão. Valide com uma leitura (o modal sem aviso e a lista de períodos vazia ou correta) antes de liberar o uso para a equipe.
6. **Reverter, se necessário.** Selecione a versão anterior da implantação no Apps Script; o botão volta a ficar desabilitado sozinho. Para desligar sem mexer no Apps Script, troque `FERIAS_INTEGRACAO_HABILITADA` para `false` no frontend. As demandas não são afetadas, porque o cadastro de férias usa só a própria aba.

## Pendências para ativar a gravação real

- [ ] Recuperar e versionar o `doGet`/`doPost` completo de produção (passo 1).
- [ ] Homologação configurada e testada (passos 2 e 3).
- [ ] Acionador diário de `atualizarSituacaoFerias` (opcional, passo 4).
- [ ] Implantação em produção (passo 5). O frontend libera o botão sozinho.
- [ ] Opcional: editar e excluir férias pela interface. O backend já tem `atualizarFerias` e `excluirFerias`; hoje o modal só lista os períodos e cadastra novos.
