/*
  Lógica do Kanban de diagramação do GGE.

  Responsável por:
  - Buscar as configurações (núcleos, diagramadores, anos, módulos, frentes, status, prioridades)
    direto da planilha (aba LISTAS), via Apps Script, com fallback local de emergência
  - Buscar as demandas direto da planilha (aba BASE_DEMANDAS), via Apps Script - a
    planilha é SEMPRE a fonte de verdade; o localStorage só serve como cache/fallback
    da sessão atual, nunca sobrescrevendo os dados vindos do Apps Script
  - Alternar entre as três telas do sistema: Resumo dos núcleos, Tabela operacional e Kanban Visual
  - Renderizar a tabela operacional do núcleo selecionado (blocos fixos de 6 linhas por diagramador)
  - Renderizar o Kanban Visual (quadro por status/prioridade) do núcleo selecionado
  - Criar/editar demandas pelo formulário, encaixando-as no slot correto da tabela
  - Enviar demandas ao Google Apps Script (Web App)
  - Aplicar filtros (diagramador, status, prioridade, busca)
  - Calcular e destacar demandas atrasadas
*/

// ===================== CONFIGURAÇÃO ===================== //

// URL do Web App do Google Apps Script (backend de integração com a planilha)
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzIkG3InaDqrmyrzQfuy1hsYi9lQx8DTZmI6QjJI_ilLuZZMwWofc_-sAcwFphbUKtjPw/exec";

// Chave usada para salvar as demandas no localStorage
const CHAVE_LOCALSTORAGE = "kanban_diagramacao_gge_demandas";

// Links das planilhas auxiliares abertos pelos botões da barra operacional.
// Para trocar o link de algum dos dois, basta editar o valor aqui.
const LINK_SOLICITACAO_IMAGENS =
  "https://docs.google.com/spreadsheets/d/1vwpLInIPtZ7QYBwX23sVcm0rxsIoiG__eWgcshHgjUU/edit?gid=640961194#gid=640961194";
const LINK_SOLICITACAO_QRS =
  "https://docs.google.com/spreadsheets/d/1lMo6Y1Jfrnkuw4BiBSHSa0C4opPstDmSlr5XpP-Dk4A/edit?gid=0#gid=0";
const LINK_SOLICITACAO_ILUSTRACAO =
  "https://docs.google.com/spreadsheets/d/1LXwP1zowUQ7dvZ0w4CVRrXFZ5ky-R7-tqX_ML_5kr6w/edit?gid=2007281234#gid=2007281234";

// Quantidade MÍNIMA de linhas exibidas por bloco de diagramador, em cada núcleo.
// Se o diagramador tiver menos demandas que isso, o bloco é completado com linhas vazias.
// Se tiver mais, todas as demandas reais são exibidas (o bloco cresce além deste mínimo).
const LINHAS_POR_DIAGRAMADOR = 6;

// Prioridades consideradas para o bloco "PRIORIDADE" do Kanban Visual
const PRIORIDADES_ALTA = ["Alta", "Urgente"];

// Ordem fixa de exibição dos núcleos no Kanban Visual Geral. Núcleos desta lista que não
// existirem em configuracoes.diagramadoresPorNucleo ainda assim aparecem (com 0 demandas);
// núcleos que existirem na planilha mas não estiverem nesta lista não são exibidos ali
// (a tabela operacional e os demais painéis continuam mostrando todos os núcleos).
const ORDEM_NUCLEOS_KANBAN_GERAL = [
  "Núcleo 1",
  "Núcleo 2",
  "Núcleo 3",
  "Núcleo 4",
  "Núcleo 5",
  "Núcleo 6",
];

// Ordem dos grupos exibidos no quadro "Diagramadores livres" (Resumo dos núcleos)
// Núcleos que existem na planilha e no Resumo dos núcleos, mas cujos botões não devem
// aparecer no cabeçalho principal. Alterar apenas aqui para mostrar/ocultar um setor.
const NUCLEOS_OCULTOS_CABECALHO = [
  "Automatização",
  "Arte-Finalização",
  "Ilustração",
];

// Setores ocultados nos quadros "Diagramadores livres" e "Diagramadores com atividade"
// da seção "Resumo dos núcleos". Os dados permanecem intactos na planilha.
const NUCLEOS_OCULTOS_RESUMO = [
  "Automatização",
  "Arte-Finalização",
  "Ilustração",
];

const ORDEM_NUCLEOS_RESUMO = [
  "Núcleo 1",
  "Núcleo 2",
  "Núcleo 3",
  "Núcleo 4",
  "Núcleo 5",
  "Núcleo 6",
  "Automatização",
  "Ilustração",
  "Arte-Finalização",
];

// Abreviação de cada núcleo, usada nos itens compactos do Kanban Visual (ex: "N1 - Taína | ...").
// Núcleos que não estiverem neste mapa simplesmente exibem o próprio nome do núcleo.
const NUCLEO_ABREVIACAO = {
  "Núcleo 1": "N1",
  "Núcleo 2": "N2",
  "Núcleo 3": "N3",
  "Núcleo 4": "N4",
  "Núcleo 5": "N5",
  "Núcleo 6": "N6",
  "Ilustração": "IL",
};

// Configuração local de emergência: usada enquanto a planilha não respondeu e também
// como fallback caso a busca em buscarConfiguracoes() falhe, para a tela nunca quebrar.
const CONFIGURACOES_EMERGENCIA = {
  anosEscolares: [],
  modulos: [],
  frentes: [],
  status: ["A iniciar", "Em processo", "Pausado", "Atrasado", "Finalizado"],
  prioridades: ["Baixa", "Média", "Alta", "Urgente"],
  diagramadoresPorNucleo: {
    "Núcleo 1": ["Taína", "Danielly", "Claudênio", "Leandro"],
    "Núcleo 2": ["Alessandro", "Mayck", "Nayara"],
    "Núcleo 3": ["Diagramador 1", "Diagramador 2", "Diagramador 3"],
    "Núcleo 4": ["Diagramador 1", "Diagramador 2", "Diagramador 3"],
    "Núcleo 5": ["Diagramador 1", "Diagramador 2", "Diagramador 3"],
    "Núcleo 6": ["Diagramador 1", "Diagramador 2", "Diagramador 3"],
    "Ilustração": ["Ilustrador 1", "Ilustrador 2", "Ilustrador 3"],
  },
  // Mapa "Nome do diagramador" -> "link da foto" (coluna I da aba LISTAS). Vazio por padrão:
  // sem foto cadastrada, o avatar simplesmente cai para o círculo com as iniciais do nome.
  fotosDiagramadores: {},
};

// Fallbacks discretos para os selects editáveis da tabela operacional, usados apenas
// quando a lista correspondente vier vazia de configuracoes (ex: planilha sem dados
// na aba LISTAS ainda). Não há fallback para "Frente": a lista é grande e variada
// demais para fixar no código - se vier vazia, o select de Frente fica só com a opção vazia.
const FALLBACK_ANOS_ESCOLARES = ["1º", "2º", "3º", "4º", "5º", "6º", "7º", "8º", "9º"];
const FALLBACK_MODULOS = ["M1", "M2", "M3", "M4", "ANUAL"];
const FALLBACK_PRIORIDADES = ["Baixa", "Média", "Alta", "Urgente"];

// Fallback da lista de atividades da tabela operacional. Em produção, os valores vêm de
// configuracoes.prioridades (coluna "Prioridades" da aba LISTAS), que foi reaproveitada
// para transportar a lista de atividades sem precisar alterar o Apps Script.
const FALLBACK_ATIVIDADES_TABELA = [
  "Diagramação",
  "Troca de Layout",
  "Ajuste de Revisão",
  "Ajuste de Autoria",
  "Inserção de Imagens",
  "Finalização",
  "Conferência",
  "QR Code",
];

// Opções da coluna "Pausa/Prioridade" da TABELA OPERACIONAL - são fixas, independentes
// de configuracoes.prioridades (que agora é usada como lista de atividades na tabela).
const OPCOES_PAUSA_PRIORIDADE_TABELA = ["Pausado", "Prioridade"];

// Retorna a lista vinda da planilha, ou o fallback se ela vier vazia/ausente
function obterOpcoesComFallback(listaDaPlanilha, listaFallback) {
  return listaDaPlanilha && listaDaPlanilha.length > 0 ? listaDaPlanilha : listaFallback;
}

// ===================== ESTADO ===================== //

// Array local de demandas (em memória), carregado do localStorage ao iniciar
let demandas = [];

// Configurações vindas da planilha (aba LISTAS), via buscarConfiguracoes() no Apps Script.
// Inicia com a configuração de emergência e é substituída pelos dados reais após o carregamento.
let configuracoes = JSON.parse(JSON.stringify(CONFIGURACOES_EMERGENCIA));

// Núcleo atualmente selecionado na navegação do cabeçalho.
// Inicia no Núcleo 1 — tela padrão ao abrir o Kanban.
let nucleoSelecionado = "Núcleo 1";

// Tela atualmente visível: "resumo" (Resumo dos núcleos), "tabela" (tabela operacional)
// ou "kanban" (Kanban Visual do núcleo selecionado).
// Inicia em "tabela" — o Núcleo 1 é selecionado na inicialização.
let telaAtual = "tabela";

// Visualização ativa DENTRO da tela "Resumo dos núcleos".
// Três estados possíveis:
//   "equipe"              → Visão da equipe (livres + com atividade + demandas críticas)
//   "kanban-geral"        → Kanban Visual Geral (todos os núcleos ao mesmo tempo)
//   "equipe-diagramacao"  → Carrossel premium da Equipe de Diagramação
// Independente de `telaAtual` e do botão "Kanban Visual" da barra operacional.
let visualizacaoResumoAtiva = "equipe";

// Núcleo selecionado no filtro interno do Kanban Visual Geral.
// "todos" = exibir todos os núcleos de ORDEM_NUCLEOS_KANBAN_GERAL.
let filtroNucleoKanbanGeral = "todos";

// Dados temporários das linhas da tabela operacional que o usuário já começou a
// preencher (ex: selecionou Ano Escolar/Módulo/Frente), mas que ainda NÃO geraram uma
// demanda real na BASE_DEMANDAS. Chave: "nucleo::diagramador::slot" -> { campos... }.
// Existe só em memória (não vai para o localStorage) e nunca é sobrescrita por
// carregarDemandas(); é apagada apenas quando a linha correspondente se torna uma
// demanda real (ver criarDemandaApartirDaLinhaTemporaria).
let linhasTemporariasTabela = {};

// ===================== INICIALIZAÇÃO ===================== //

// Oculta a splash screen com fade-out e depois remove do fluxo visual.
// Chamada no finally do DOMContentLoaded para garantir que sempre desaparece,
// mesmo em caso de erro de carregamento.
function esconderSplashScreen() {
  const splash = document.getElementById("splashScreen");
  if (!splash) return;
  splash.classList.add("splash-hidden");
  setTimeout(function () {
    splash.style.display = "none";
  }, 650);
}

document.addEventListener("DOMContentLoaded", async () => {
  // LOG TEMPORÁRIO: confirma qual Web App está sendo usado nesta sessão
  console.log("WEB_APP_URL em uso:", WEB_APP_URL);

  try {
    // Remove qualquer cache antigo do Kanban guardado no navegador ANTES de buscar
    // qualquer dado, para nunca exibir/ressuscitar demandas que não existem mais na planilha
    limparCacheLocalKanban();

    // A planilha é sempre a fonte principal de demandas; o localStorage só é usado
    // como fallback dentro de carregarDemandas(), se a busca na planilha falhar
    await carregarDemandas();

    // Busca as configurações da planilha antes de montar a navegação e a tabela,
    // para que núcleos, diagramadores e listas dos selects já venham corretos
    await carregarConfiguracoes();
    aplicarConfiguracoesNaInterface();

    configurarEventos();
    configurarNavegacaoNucleos();
    configurarSelectNucleoDoFormulario();
    renderizarTela();
  } catch (erro) {
    console.error("Erro durante a inicialização do Kanban:", erro);
  } finally {
    esconderSplashScreen();
  }
});

// ===================== PERSISTÊNCIA LOCAL ===================== //

// Remove do localStorage qualquer chave relacionada ao Kanban (inclusive a chave
// específica das demandas), garantindo que nenhum dado antigo de uma sessão anterior
// sobreviva e seja confundido com os dados atuais vindos da planilha.
function limparCacheLocalKanban() {
  Object.keys(localStorage).forEach(function (chave) {
    if (chave.toLowerCase().includes("kanban")) {
      localStorage.removeItem(chave);
    }
  });

  // Reforço explícito: remove também a chave específica das demandas, mesmo que,
  // por algum motivo, o nome dela não contivesse "kanban"
  localStorage.removeItem(CHAVE_LOCALSTORAGE);

  console.log("Cache local do Kanban limpo.");
}

// Fallback local: só é usado quando a busca de demandas na planilha falha
// (rede indisponível, resposta inválida, etc.) - nunca como fonte principal.
function carregarDemandasDoLocalStorage() {
  const dados = localStorage.getItem(CHAVE_LOCALSTORAGE);
  demandas = dados ? JSON.parse(dados) : [];
}

// ===================== NÚCLEO DA DEMANDA (COLUNA "NUCLEO" DA BASE_DEMANDAS) ===================== //

// Remove acentos/maiúsculas para comparar nomes de diagramador com tolerância a
// pequenas diferenças de escrita
function normalizarNome(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Descobre a qual núcleo um diagramador pertence, procurando em
// configuracoes.diagramadoresPorNucleo. Usado apenas como fallback, para demandas
// antigas que não tenham o campo Nucleo preenchido. Retorna "" se não encontrar -
// NUNCA retorna um núcleo fixo "adivinhado" (ex: não joga para "Núcleo 2").
function obterNucleoPorDiagramador(nomeDiagramador) {
  const grupos = configuracoes.diagramadoresPorNucleo || {};
  const nomeNormalizado = normalizarNome(nomeDiagramador);

  for (const nucleo in grupos) {
    const lista = grupos[nucleo] || [];

    const encontrado = lista.some((nome) => normalizarNome(nome) === nomeNormalizado);

    if (encontrado) {
      return nucleo;
    }
  }

  return "";
}

// Obtém o núcleo de uma demanda: usa o campo Nucleo (vindo da BASE_DEMANDAS) quando
// existir; senão, cai para o fallback por diagramador. Esta é a função que deve ser
// usada em toda a tabela operacional/Kanban Visual/Kanban Visual Geral para descobrir
// o núcleo de uma demanda - nunca comparar `demanda.nucleo` diretamente.
function obterNucleoDaDemanda(demanda) {
  // Tolera as duas grafias: a aba BASE_DEMANDAS/Apps Script usa "Nucleo" (PascalCase,
  // confirmado em ?acao=buscarDemandas), enquanto demandas criadas localmente nesta
  // sessão (antes de confirmadas pelo servidor) usam "nucleo" (camelCase interno).
  const nucleo = demanda.Nucleo || demanda.nucleo;

  if (nucleo) {
    return String(nucleo).trim();
  }

  return obterNucleoPorDiagramador(demanda.Diagramador || demanda.diagramador);
}

function salvarDemandasNoLocalStorage() {
  localStorage.setItem(CHAVE_LOCALSTORAGE, JSON.stringify(demandas));
}

// ===================== MAPEAMENTO DOS CAMPOS DA BASE_DEMANDAS ===================== //

// CAUSA RAIZ do desaparecimento das demandas após recarregar: ?acao=buscarDemandas
// devolve cada demanda com as colunas exatamente como estão na planilha (PascalCase/
// underscore: ID, Diagramador, Nucleo, Ano_Escolar, Modulo, Frente, Atividade, Inicio,
// Previsto, Fim, Status, Prioridade, Pausa...), mas TODA a lógica da tabela operacional
// (agrupar por diagramador, calcular status, decidir se a linha aparece) usa os nomes
// internos em camelCase (diagramador, anoEscolar, inicio, fim, status...). Sem esta
// conversão, comparações como `d.diagramador === nomeDiagramador` (usada para agrupar
// a tabela por diagramador) e `demanda.fim` (usada para decidir se a linha some)
// SEMPRE falhavam para demandas vindas do servidor - cada uma delas não batia com
// nenhum diagramador e, por isso, nunca era desenhada em linha alguma.
function mapearDemandaDoServidor(demandaBruta) {
  return {
    id: demandaBruta.ID ?? demandaBruta.id ?? "",
    dataCriacao: demandaBruta.Data_Criacao ?? demandaBruta.dataCriacao ?? "",
    diagramador: demandaBruta.Diagramador ?? demandaBruta.diagramador ?? "",
    nucleo: demandaBruta.Nucleo ?? demandaBruta.nucleo ?? "",
    anoEscolar: demandaBruta.Ano_Escolar ?? demandaBruta.anoEscolar ?? "",
    modulo: demandaBruta.Modulo ?? demandaBruta.modulo ?? "",
    frente: demandaBruta.Frente ?? demandaBruta.frente ?? "",
    atividade: demandaBruta.Atividade ?? demandaBruta.atividade ?? "",
    inicio: demandaBruta.Inicio ?? demandaBruta.inicio ?? "",
    previsto: demandaBruta.Previsto ?? demandaBruta.previsto ?? "",
    fim: demandaBruta.Fim ?? demandaBruta.fim ?? "",
    status: demandaBruta.Status ?? demandaBruta.status ?? "",
    prioridade: demandaBruta.Prioridade ?? demandaBruta.Pausa ?? demandaBruta.prioridade ?? "",
    observacoes: demandaBruta.Observacoes ?? demandaBruta.observacoes ?? "",
    linkArquivo: demandaBruta.Link_Arquivo ?? demandaBruta.linkArquivo ?? "",
    // `slot` não existe na planilha - é só um detalhe visual de posicionamento dentro
    // do bloco de 6 linhas do diagramador, então é mantido se já vier de algum lugar
    // (ex: cache local) e fica undefined para demandas recém-carregadas do servidor
    // (o que não afeta a exibição: toda demanda real é sempre desenhada).
    slot: demandaBruta.slot,
  };
}

// ===================== DEMANDAS (ABA BASE_DEMANDAS) ===================== //

// Busca as demandas direto na planilha, via GET com a ação "buscarDemandas" do Apps
// Script, e SUBSTITUI completamente a lista local por elas - nunca mescla com o que
// já estava em `demandas`/localStorage. Essa é a única fonte de verdade do sistema.
// Se a busca falhar por qualquer motivo, cai para o fallback do localStorage (que,
// nesse ponto, só pode conter dados desta mesma sessão, já que o cache de sessões
// anteriores foi removido por limparCacheLocalKanban() na inicialização).
async function carregarDemandas() {
  try {
    const resposta = await fetch(WEB_APP_URL + "?acao=buscarDemandas");
    const dados = await resposta.json();

    if (!dados.sucesso) {
      throw new Error(dados.mensagem || "A planilha respondeu com sucesso=false ao buscar demandas");
    }

    // Converte cada demanda do formato bruto da planilha (Diagramador, Nucleo, Fim,
    // Status...) para o formato interno camelCase usado em toda a aplicação
    demandas = (dados.demandas || []).map(mapearDemandaDoServidor);

    // Mantém uma cópia no localStorage apenas como cache de exibição/fallback da
    // sessão atual - o localStorage nunca é usado para sobrescrever a planilha
    salvarDemandasNoLocalStorage();

    console.log("Demandas carregadas da planilha:", demandas);
    console.log("Demandas carregadas:", demandas);
    demandas.forEach((demanda) => {
      console.log("Núcleo da demanda:", demanda.id, obterNucleoDaDemanda(demanda));
    });
  } catch (erro) {
    console.warn("Falha ao buscar demandas da planilha, usando fallback do localStorage:", erro);
    carregarDemandasDoLocalStorage();
  }
}

// ===================== CONFIGURAÇÕES DA PLANILHA (ABA LISTAS) ===================== //

// Busca as configurações (núcleos/diagramadores, anos escolares, módulos, frentes,
// status e prioridades) na planilha, via GET com a ação "buscarConfiguracoes" do Apps Script.
// Diferente do envio de demandas, esta chamada PRECISA ler a resposta JSON, então
// não pode usar mode: "no-cors" (que torna a resposta opaca/ilegível).
// Se a busca falhar por qualquer motivo (rede, JSON inválido, dados.sucesso === false),
// mantém a configuração local de emergência, já carregada em `configuracoes`,
// para a tela nunca quebrar - nomes provisórios como "Diagramador 1" só aparecem aqui.
async function carregarConfiguracoes() {
  try {
    const resposta = await fetch(WEB_APP_URL + "?acao=buscarConfiguracoes");
    const dados = await resposta.json();

    if (!dados.sucesso) {
      throw new Error("A planilha respondeu com sucesso=false ao buscar configurações");
    }

    const configuracoesDaPlanilha = dados.configuracoes || {};

    // Mescla com a configuração de emergência: qualquer campo ausente na resposta
    // da planilha continua usando o valor local padrão, em vez de ficar vazio/undefined
    configuracoes = {
      anosEscolares: configuracoesDaPlanilha.anosEscolares || CONFIGURACOES_EMERGENCIA.anosEscolares,
      modulos: configuracoesDaPlanilha.modulos || CONFIGURACOES_EMERGENCIA.modulos,
      frentes: configuracoesDaPlanilha.frentes || CONFIGURACOES_EMERGENCIA.frentes,
      status: configuracoesDaPlanilha.status || CONFIGURACOES_EMERGENCIA.status,
      prioridades: configuracoesDaPlanilha.prioridades || CONFIGURACOES_EMERGENCIA.prioridades,
      diagramadoresPorNucleo:
        configuracoesDaPlanilha.diagramadoresPorNucleo || CONFIGURACOES_EMERGENCIA.diagramadoresPorNucleo,
      fotosDiagramadores:
        configuracoesDaPlanilha.fotosDiagramadores || CONFIGURACOES_EMERGENCIA.fotosDiagramadores,
    };
  } catch (erro) {
    // Sem conexão, CORS bloqueado, JSON inválido, sucesso=false, etc: segue com a configuração de emergência
    console.warn("Falha ao buscar configurações da planilha, usando configuração local de emergência:", erro);
  }
}

// Aplica as configurações carregadas na interface: reconstrói os botões de núcleo do
// cabeçalho, o select de núcleo do formulário e preenche os selects/filtros dependentes
// das listas da planilha (ano escolar, módulo, frente, status, prioridade).
function aplicarConfiguracoesNaInterface() {
  reconstruirBotoesDeNucleo();
  popularSelectsDeListaDoFormulario();
  popularFiltrosDeStatusEPrioridade();
}

// Recria os botões de núcleo do cabeçalho e as opções do select "Núcleo" do formulário,
// a partir das chaves de configuracoes.diagramadoresPorNucleo (não mais fixos no código)
function reconstruirBotoesDeNucleo() {
  const nucleos = Object.keys(configuracoes.diagramadoresPorNucleo);

  const nav = document.getElementById("nav-nucleos");
  nav.querySelectorAll(".btn-nucleo[data-nucleo]").forEach((botao) => botao.remove());

  nucleos
    .filter((nucleo) => !NUCLEOS_OCULTOS_CABECALHO.includes(nucleo))
    .forEach((nucleo) => {
      const botao = document.createElement("button");
      botao.className = "btn-nucleo";
      botao.dataset.nucleo = nucleo;
      botao.textContent = nucleo;
      nav.appendChild(botao);
    });

  const selectNucleo = document.getElementById("campo-nucleo");
  selectNucleo.innerHTML = "";
  nucleos.forEach((nucleo) => {
    const option = document.createElement("option");
    option.value = nucleo;
    option.textContent = nucleo;
    selectNucleo.appendChild(option);
  });

  // Garante que o núcleo selecionado continue válido, mesmo se a planilha
  // tiver renomeado ou removido o núcleo que estava selecionado por padrão
  if (!configuracoes.diagramadoresPorNucleo[nucleoSelecionado]) {
    nucleoSelecionado = nucleos[0] || nucleoSelecionado;
  }
}

// Preenche os selects do formulário de demanda que vêm das listas da planilha:
// Ano escolar, Módulo, Frente, Status e Prioridade
function popularSelectsDeListaDoFormulario() {
  popularSelectComOpcoes("campo-ano-escolar", configuracoes.anosEscolares, "Selecione...");
  popularSelectComOpcoes("campo-modulo", configuracoes.modulos, "Selecione...");
  popularSelectComOpcoes("campo-frente", configuracoes.frentes, "Selecione...");
  popularSelectComOpcoes("campo-status", configuracoes.status, null);
  popularSelectComOpcoes("campo-prioridade", configuracoes.prioridades, null);
}

// Preenche o filtro de Status da barra operacional, que também depende da planilha
// (o filtro "Prioridade" foi removido da interface)
function popularFiltrosDeStatusEPrioridade() {
  popularSelectComOpcoes("filtro-status", configuracoes.status, "Status (todos)");
}

// Função utilitária: preenche um <select> com uma lista de valores, opcionalmente
// com uma primeira opção fixa (ex: "Selecione..." ou "Status (todos)")
function popularSelectComOpcoes(idSelect, valores, textoOpcaoPadrao) {
  const select = document.getElementById(idSelect);
  const valorAtual = select.value;
  select.innerHTML = "";

  if (textoOpcaoPadrao !== null) {
    const opcaoPadrao = document.createElement("option");
    opcaoPadrao.value = "";
    opcaoPadrao.textContent = textoOpcaoPadrao;
    select.appendChild(opcaoPadrao);
  }

  (valores || []).forEach((valor) => {
    const option = document.createElement("option");
    option.value = valor;
    option.textContent = valor;
    select.appendChild(option);
  });

  // Mantém o valor previamente selecionado, se ele ainda existir na nova lista
  if ([...select.options].some((opcao) => opcao.value === valorAtual)) {
    select.value = valorAtual;
  }
}

// ===================== UTILITÁRIOS ===================== //

// Gera um ID simples baseado em timestamp + número aleatório
function gerarId() {
  return "D" + Date.now() + Math.floor(Math.random() * 1000);
}

// Transforma um status em uma classe CSS (ex: "Em processo" -> "status-em-processo")
function statusParaClasse(status) {
  return "status-" + status
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // remove acentos
    .replace(/\s+/g, "-");
}

// Normaliza um status para comparação: remove espaços nas pontas, baixa para minúsculas,
// remove acentos e troca "_"/"-" por espaço. Assim "EM PROCESSO", "em_processo" e
// "Em-Processo" são todos reconhecidos como a mesma coisa.
function normalizarStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Funções de comparação por categoria de status, já considerando variações de
// escrita/gênero (ex: "Finalizado"/"Finalizada", "Atrasado"/"Atrasada")
function statusEhAIniciar(status) {
  const normalizado = normalizarStatus(status);
  return normalizado === "a iniciar" || normalizado === "fila";
}

function statusEhEmProcesso(status) {
  return normalizarStatus(status) === "em processo";
}

function statusEhPausado(status) {
  const normalizado = normalizarStatus(status);
  return normalizado === "pausado" || normalizado === "pausada";
}

function statusEhPrioridade(status) {
  return normalizarStatus(status) === "prioridade";
}

function statusEhAtrasado(status) {
  const normalizado = normalizarStatus(status);
  return normalizado === "atrasado" || normalizado === "atrasada";
}

function statusEhFinalizado(status) {
  const normalizado = normalizarStatus(status);
  return normalizado === "finalizado" || normalizado === "finalizada";
}

// Um status é considerado "ativo" (demanda em aberto) se não estiver finalizado
function statusEhAtivo(status) {
  return (
    statusEhAIniciar(status) ||
    statusEhEmProcesso(status) ||
    statusEhPausado(status) ||
    statusEhAtrasado(status)
  );
}

// Verifica se uma demanda está atrasada:
// previsto é anterior ao momento atual e o status não é Finalizado
function estaAtrasada(demanda) {
  if (!demanda.previsto || statusEhFinalizado(demanda.status)) {
    return false;
  }
  return new Date(demanda.previsto) < new Date();
}

// Evita injeção de HTML simples ao exibir textos digitados pelo usuário
function escaparTexto(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}

// Formata um valor datetime-local (ex: 2026-06-26T14:30) para exibição dd/mm/aaaa hh:mm
function formatarDataHora(valor) {
  if (!valor) return "-";
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return "-";
  const dia = String(data.getDate()).padStart(2, "0");
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const hora = String(data.getHours()).padStart(2, "0");
  const minuto = String(data.getMinutes()).padStart(2, "0");
  return `${dia}/${mes}/${data.getFullYear()} ${hora}:${minuto}`;
}

// Converte um valor de data (ISO, com segundos/timezone, ou já em datetime-local) para
// o formato exato que o input <input type="datetime-local"> aceita: "yyyy-MM-ddTHH:mm".
// Necessário porque o valor pode voltar da planilha/Apps Script num formato diferente
// do que o próprio input já produz quando editado direto no frontend.
function converterParaDatetimeLocal(valor) {
  if (!valor) return "";

  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return "";

  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  const hora = String(data.getHours()).padStart(2, "0");
  const minuto = String(data.getMinutes()).padStart(2, "0");
  return `${ano}-${mes}-${dia}T${hora}:${minuto}`;
}

// ===================== PERMANÊNCIA NA TABELA OPERACIONAL ===================== //

// Decide se uma demanda tem o campo Fim preenchido - é essa, e SOMENTE essa, a
// condição que tira uma demanda da tabela operacional (nunca o Status). Tolera as
// duas grafias do campo (Fim/fim), pelo mesmo motivo do Nucleo: a BASE_DEMANDAS/Apps
// Script pode devolver "Fim" (PascalCase, igual ao cabeçalho da planilha) em vez do
// "fim" (camelCase) usado internamente para demandas ainda não confirmadas pelo servidor.
function demandaTemFimPreenchido(demanda) {
  return String(demanda.Fim || demanda.fim || "").trim() !== "";
}

// Retorna true se o diagramador tiver ao menos uma demanda sem Fim preenchido.
// Tolera as duas grafias dos campos (PascalCase do servidor e camelCase interno)
// e usa normalizarNome para comparar com tolerância a acentos e capitalização.
function diagramadorTemDemandaAtiva(nomeDiagramador) {
  const nomeNorm = normalizarNome(nomeDiagramador);
  return demandas.some(function (demanda) {
    const nomeDemanda = demanda.Diagramador || demanda.diagramador || "";
    const mesmoDiagramador = normalizarNome(nomeDemanda) === nomeNorm;
    const semFim = !String(demanda.Fim || demanda.fim || "").trim();
    return mesmoDiagramador && semFim;
  });
}

// ===================== STATUS AUTOMÁTICO (TABELA OPERACIONAL) ===================== //

// Calcula o status de uma demanda automaticamente a partir do que já foi preenchido,
// seguindo a lógica original do Kanban:
//   Fim preenchido        -> FINALIZADO
//   Pausa/Prioridade      -> PAUSADO ou PRIORIDADE
//   Início preenchido     -> EM PROCESSO
//   Atividade preenchida  -> FILA
//   nada preenchido ainda -> vazio
// statusEhAIniciar() reconhece tanto "FILA" (valor atual) quanto o antigo "A iniciar"
// (demandas criadas antes deste ajuste), então toda a lógica de agrupamento por status
// (Kanban Visual, Resumo dos núcleos, contadores) continua funcionando para os dois.
function calcularStatusAutomatico(demanda) {
  const pausaPrioridade = String(demanda.prioridade || "").trim().toLowerCase();
  const atividade = String(demanda.atividade || "").trim();
  const inicio = String(demanda.inicio || "").trim();
  const fim = String(demanda.fim || "").trim();

  // Fim tem prioridade máxima: uma demanda finalizada nunca volta a ser Pausado/Prioridade
  if (fim) {
    return "Finalizado";
  }

  // PAUSA/PRIORIDADE é considerada antes da regra normal (Fila/Em processo)
  if (pausaPrioridade === "pausado") {
    return "Pausado";
  }

  if (pausaPrioridade === "prioridade") {
    return "Prioridade";
  }

  if (inicio) {
    return "Em processo";
  }

  if (atividade) {
    return "FILA";
  }

  return "";
}

// Converte qualquer variação de escrita de status ("A iniciar", "a iniciar", "FILA",
// "em_processo", etc.) no texto exibido no selo da tabela operacional. Não altera o
// valor armazenado em demanda.status - é só para exibição.
function obterTextoStatus(status) {
  const statusNormalizado = normalizarStatus(status);

  if (statusNormalizado === "a iniciar" || statusNormalizado === "fila") {
    return "FILA";
  }

  if (statusNormalizado === "em processo") {
    return "EM PROCESSO";
  }

  if (statusNormalizado === "pausado" || statusNormalizado === "pausada") {
    return "PAUSADO";
  }

  if (statusNormalizado === "prioridade") {
    return "PRIORIDADE";
  }

  if (statusNormalizado === "finalizado" || statusNormalizado === "finalizada") {
    return "FINALIZADO";
  }

  if (statusNormalizado === "atrasado" || statusNormalizado === "atrasada") {
    return "ATRASADO";
  }

  return status ? String(status).toUpperCase() : "-";
}

// ===================== CAMPOS EDITÁVEIS DA TABELA OPERACIONAL ===================== //

// Cria um <select> editável de célula da tabela. Se o valor atual não estiver entre as
// opções (ex: dado antigo/diferente da lista atual), ele é incluído mesmo assim, para
// não "sumir" silenciosamente o valor já salvo da demanda.
function criarSelectTabela(valorAtual, opcoes, aoAlterar) {
  const select = document.createElement("select");
  select.className = "campo-tabela campo-tabela-select";

  const valoresParaExibir = [...opcoes];
  if (valorAtual && !valoresParaExibir.includes(valorAtual)) {
    valoresParaExibir.unshift(valorAtual);
  }

  const opcaoVazia = document.createElement("option");
  opcaoVazia.value = "";
  select.appendChild(opcaoVazia);

  valoresParaExibir.forEach((valor) => {
    const option = document.createElement("option");
    option.value = valor;
    option.textContent = valor;
    select.appendChild(option);
  });

  select.value = valorAtual || "";
  select.addEventListener("change", () => aoAlterar(select.value));

  return select;
}

// Cria um <input type="text"> editável de célula da tabela (ex: Atividade).
// Usa o evento "change" (confirma ao saber do campo), não "input", para não disparar
// uma atualização/recarregamento a cada tecla digitada.
function criarInputTabela(valorAtual, aoAlterar) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "campo-tabela campo-tabela-texto";
  input.value = valorAtual || "";
  input.addEventListener("change", () => aoAlterar(input.value));
  return input;
}

// Cria um <input type="datetime-local"> editável de célula da tabela
// (Início, Previsto, Fim), convertendo o valor salvo para o formato aceito pelo input.
function criarInputDataTabela(valorAtual, aoAlterar) {
  const input = document.createElement("input");
  input.type = "datetime-local";
  input.className = "campo-tabela campo-tabela-data";
  input.value = converterParaDatetimeLocal(valorAtual);
  input.addEventListener("change", () => aoAlterar(input.value));
  return input;
}

// Lê o valor atual de um campo no contexto da linha: prioriza a demanda real (com ID);
// se ainda não existir, usa a linha temporária (preenchimento ainda não salvo na base)
function obterValorCampoContexto(contexto, campo) {
  if (contexto.demanda) {
    return contexto.demanda[campo] || "";
  }
  if (contexto.linhaTemporaria) {
    return contexto.linhaTemporaria[campo] || "";
  }
  return "";
}

// Monta uma <td> com um select editável, ligado ao campo informado da demanda do contexto
function criarCelulaComSelect(contexto, campo, opcoes) {
  const celula = document.createElement("td");
  const valorAtual = obterValorCampoContexto(contexto, campo);
  celula.appendChild(
    criarSelectTabela(valorAtual, opcoes, (novoValor) => salvarCampoDemanda(contexto, campo, novoValor))
  );
  return celula;
}

// Célula da coluna ATIVIDADE: select com largura total e title mostrando o valor
// completo ao passar o mouse (útil para textos longos que o select trunca).
function criarCelulaAtividadeTabela(contexto, opcoes) {
  const celula = document.createElement("td");
  celula.className = "col-atividade";

  const valorAtual = obterValorCampoContexto(contexto, "atividade");

  const select = criarSelectTabela(valorAtual, opcoes, (novoValor) => {
    select.title = novoValor;
    salvarCampoDemanda(contexto, "atividade", novoValor);
  });
  select.className += " select-atividade";
  select.title = valorAtual || "";
  celula.appendChild(select);

  return celula;
}

// Monta uma <td> com um input de texto editável, ligado ao campo informado da demanda
function criarCelulaComInputTexto(contexto, campo) {
  const celula = document.createElement("td");
  const valorAtual = obterValorCampoContexto(contexto, campo);
  celula.appendChild(
    criarInputTabela(valorAtual, (novoValor) => salvarCampoDemanda(contexto, campo, novoValor))
  );
  return celula;
}

// Monta uma <td> com um input de data/hora editável, ligado ao campo informado da demanda
function criarCelulaComInputData(contexto, campo) {
  const celula = document.createElement("td");
  const valorAtual = obterValorCampoContexto(contexto, campo);
  celula.appendChild(
    criarInputDataTabela(valorAtual, (novoValor) => salvarCampoDemanda(contexto, campo, novoValor))
  );
  return celula;
}

// ===================== LINHAS TEMPORÁRIAS (PREENCHIMENTO AINDA NÃO SALVO) ===================== //

// Chave única de uma linha temporária: núcleo + diagramador + slot visual da linha
function obterChaveLinhaTemporaria(nucleo, diagramador, slot) {
  return `${nucleo}::${diagramador}::${slot}`;
}

// Retorna a linha temporária já existente para este contexto, ou cria uma vazia
function obterOuCriarLinhaTemporaria(contexto) {
  const chave = obterChaveLinhaTemporaria(contexto.nucleo, contexto.diagramador, contexto.slot);

  if (!linhasTemporariasTabela[chave]) {
    linhasTemporariasTabela[chave] = {
      anoEscolar: "",
      modulo: "",
      frente: "",
      atividade: "",
      inicio: "",
      previsto: "",
      fim: "",
      prioridade: "",
    };
  }

  return linhasTemporariasTabela[chave];
}

// Remove a linha temporária de uma linha que acabou de se tornar uma demanda real
function removerLinhaTemporaria(nucleo, diagramador, slot) {
  delete linhasTemporariasTabela[obterChaveLinhaTemporaria(nucleo, diagramador, slot)];
}

// Converte os campos internos da demanda para o formato de colunas esperado pelo
// Apps Script/planilha (Diagramador, Nucleo, Ano_Escolar, Modulo, Frente, Atividade,
// Inicio, Previsto, Fim, Status, Prioridade)
function montarDadosDemandaParaAppsScript(demanda) {
  // LOGS TEMPORÁRIOS: confirmar o núcleo identificado/enviado para cada demanda
  console.log("Núcleo identificado da demanda:", obterNucleoDaDemanda(demanda));
  console.log("Núcleo selecionado:", nucleoSelecionado);

  const dados = {
    Diagramador: demanda.diagramador || "",
    Nucleo: obterNucleoDaDemanda(demanda) || nucleoSelecionado,
    Ano_Escolar: demanda.anoEscolar || "",
    Modulo: demanda.modulo || "",
    Frente: demanda.frente || "",
    Atividade: demanda.atividade || "",
    Inicio: demanda.inicio || "",
    Previsto: demanda.previsto || "",
    Fim: demanda.fim || "",
    Status: demanda.status || "",
    Prioridade: demanda.prioridade || "",
  };

  console.log("Demanda enviada com núcleo:", dados);
  return dados;
}

// Cria a demanda na BASE_DEMANDAS. Diferente do envio "no-cors" usado pelo modal,
// esta chamada PRECISA ler a resposta JSON para saber o ID que o Apps Script gerou.
async function criarDemandaNoAppsScript(demanda) {
  const resposta = await fetch(WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      acao: "criarDemanda",
      dados: montarDadosDemandaParaAppsScript(demanda),
    }),
  });
  return resposta.json();
}

// Atualiza uma demanda já existente na BASE_DEMANDAS, pelo ID
async function atualizarDemandaNoAppsScript(demanda) {
  const resposta = await fetch(WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      acao: "atualizarDemanda",
      dados: {
        ID: demanda.id,
        ...montarDadosDemandaParaAppsScript(demanda),
      },
    }),
  });
  return resposta.json();
}

// Extrai o ID retornado pelo Apps Script após criar uma demanda, tolerando algumas
// variações de formato de resposta ({id}, {ID} ou {demanda: {ID/id}})
function obterIdDoResultadoCriacao(resultado) {
  if (!resultado) return "";
  if (resultado.id) return resultado.id;
  if (resultado.ID) return resultado.ID;
  if (resultado.demanda) return resultado.demanda.ID || resultado.demanda.id || "";
  return "";
}

// Campos que, ao serem preenchidos numa linha ainda sem demanda, disparam a criação
// dela na BASE_DEMANDAS. Os demais campos (Ano Escolar, Módulo, Frente, Previsto,
// Pausa/Prioridade, Fim) só ficam guardados na linha temporária até esse momento.
const CAMPOS_QUE_CRIAM_DEMANDA = ["atividade", "inicio"];

// Chamada sempre que um campo editável de uma linha da tabela é alterado.
// - Se a linha já é uma demanda real (tem ID): sempre atualiza essa mesma demanda.
// - Se a linha ainda não existe na base: guarda o valor na linha temporária e só
//   cria a demanda quando Atividade ou Início forem preenchidos (nunca por causa de
//   Ano Escolar/Módulo/Frente/Previsto/Pausa-Prioridade isolados).
async function salvarCampoDemanda(contexto, campo, novoValor) {
  // Serializa os salvamentos desta MESMA linha: se já existe um salvamento em
  // andamento (ex: o usuário preencheu a Atividade e, antes de terminar, já alterou
  // o Início também), espera o primeiro terminar antes do segundo decidir o que fazer.
  if (contexto.promessaSalvando) {
    await contexto.promessaSalvando;
  }

  const execucao = executarSalvamentoCampoDemanda(contexto, campo, novoValor);
  contexto.promessaSalvando = execucao;
  await execucao;
  contexto.promessaSalvando = null;
}

async function executarSalvamentoCampoDemanda(contexto, campo, novoValor) {
  console.log("Salvando campo da tabela:", campo, novoValor);

  // Caso 1: a linha já é uma demanda real (tem ID confirmado pelo Apps Script) ->
  // qualquer campo, de qualquer coluna, sempre atualiza essa mesma demanda
  if (contexto.demanda && contexto.demanda.id) {
    await atualizarCampoDeDemandaExistente(contexto, campo, novoValor);
    return;
  }

  // Caso 2: a linha ainda não existe na base - guarda o valor na linha temporária
  const linhaTemporaria = obterOuCriarLinhaTemporaria(contexto);
  linhaTemporaria[campo] = novoValor;
  console.log("Linha temporária atualizada:", linhaTemporaria);

  const podeCriarDemanda = CAMPOS_QUE_CRIAM_DEMANDA.includes(campo) && novoValor;

  if (!podeCriarDemanda) {
    // Ainda não há Atividade nem Início preenchidos: só mantém o valor visual na
    // linha (linha temporária) e re-renderiza para refletir a seleção/digitação,
    // sem criar nada na BASE_DEMANDAS ainda
    renderizarTela();
    return;
  }

  await criarDemandaApartirDaLinhaTemporaria(contexto, linhaTemporaria);
}

// Atualiza uma demanda que já existe na base (já tem ID) - usada tanto para o campo
// que disparou a chamada quanto para qualquer edição seguinte da mesma linha
async function atualizarCampoDeDemandaExistente(contexto, campo, novoValor) {
  const demanda = contexto.demanda;
  demanda[campo] = novoValor;
  demanda.status = calcularStatusAutomatico(demanda);

  console.log("Atualizando demanda com núcleo:", demanda);
  console.log("Status calculado:", demanda.status);

  try {
    const resultado = await atualizarDemandaNoAppsScript(demanda);
    console.log("Resultado salvar demanda:", resultado);

    if (!resultado || !resultado.sucesso) {
      throw new Error((resultado && resultado.mensagem) || "Falha ao salvar a demanda.");
    }

    if (campo === "inicio") {
      console.log("Demanda após salvar início:", demanda);
    }

    salvarDemandasNoLocalStorage();

    // IMPORTANTE: NÃO busca novamente as demandas na planilha aqui. `demanda` é o mesmo
    // objeto que já está em `demandas` (por referência) e o Apps Script CONFIRMOU o
    // salvamento (resultado.sucesso) - re-renderiza a partir do estado local, que já é
    // exatamente o que acabou de ser salvo. Buscar de novo bem nesse instante é o que
    // fazia a linha "sumir": o Apps Script/Sheets pode levar um instante para propagar
    // a escrita, e um re-fetch imediato podia trazer a versão ainda antiga da linha.
    renderizarTela();
  } catch (erro) {
    // Não recarrega nem re-renderiza em caso de erro: o valor que o usuário já
    // selecionou/digitou continua visível na linha (nada é apagado)
    console.error("Falha ao atualizar demanda:", erro);
  }
}

// Cria a demanda definitiva na BASE_DEMANDAS a partir dos valores já acumulados na
// linha temporária (Ano Escolar, Módulo, Frente, Previsto, Pausa/Prioridade, e agora
// também Atividade ou Início, que foi o campo que disparou a criação)
async function criarDemandaApartirDaLinhaTemporaria(contexto, linhaTemporaria) {
  const demanda = {
    id: "",
    dataCriacao: new Date().toISOString(),
    nucleo: contexto.nucleo,
    diagramador: contexto.diagramador,
    slot: contexto.slot,
    anoEscolar: linhaTemporaria.anoEscolar || "",
    modulo: linhaTemporaria.modulo || "",
    frente: linhaTemporaria.frente || "",
    atividade: linhaTemporaria.atividade || "",
    inicio: linhaTemporaria.inicio || "",
    previsto: linhaTemporaria.previsto || "",
    fim: linhaTemporaria.fim || "",
    prioridade: linhaTemporaria.prioridade || "",
    status: "",
  };
  demanda.status = calcularStatusAutomatico(demanda);

  console.log("Criando demanda com núcleo:", demanda);
  console.log("Status calculado:", demanda.status);

  try {
    const resultado = await criarDemandaNoAppsScript(demanda);
    console.log("Resultado salvar demanda:", resultado);

    if (!resultado || !resultado.sucesso) {
      throw new Error((resultado && resultado.mensagem) || "Falha ao salvar a demanda.");
    }

    const idRetornado = obterIdDoResultadoCriacao(resultado);
    if (!idRetornado) {
      throw new Error("O Apps Script não retornou o ID da demanda criada.");
    }

    // Associa o ID definitivo: a partir de agora esta linha é uma demanda real, e a
    // linha temporária correspondente deixa de existir (próximas edições atualizam)
    demanda.id = idRetornado;
    demandas.push(demanda);
    removerLinhaTemporaria(contexto.nucleo, contexto.diagramador, contexto.slot);
    contexto.demanda = demanda;

    if (demanda.inicio) {
      console.log("Demanda após salvar início:", demanda);
    }

    salvarDemandasNoLocalStorage();

    // Mesmo raciocínio de atualizarCampoDeDemandaExistente: não busca de novo na
    // planilha agora - `demanda` já foi inserida em `demandas` com o ID confirmado
    // pelo Apps Script, então re-renderiza direto a partir do estado local
    renderizarTela();
  } catch (erro) {
    // Mantém a linha temporária como estava (nenhum valor é apagado) para o
    // usuário poder tentar novamente alterando algum campo
    console.error("Falha ao criar demanda a partir da linha temporária:", erro);
  }
}

// ===================== RENDERIZAÇÃO DA TABELA ===================== //

function renderizarTabela() {
  const corpo = document.getElementById("corpo-tabela-nucleo");
  corpo.innerHTML = "";

  let diagramadores = configuracoes.diagramadoresPorNucleo[nucleoSelecionado] || [];

  // Filtra a lista de seções de diagramador pelo filtro superior.
  // normalizarNome garante tolerância a acentos e espaços.
  const filtroDiagramador = document.getElementById("filtro-diagramador").value;
  console.log("Filtro diagramador selecionado:", filtroDiagramador);
  if (filtroDiagramador) {
    diagramadores = diagramadores.filter(
      (nome) => normalizarNome(nome) === normalizarNome(filtroDiagramador)
    );
  }
  console.log("Diagramadores renderizados na tabela:", diagramadores);

  // demandasDoNucleo: TODAS as demandas do núcleo selecionado (inclusive finalizadas) -
  // é a partir desta lista que os cards superiores (atualizarContadores) contam tudo.
  const demandasDoNucleo = demandas.filter((d) => obterNucleoDaDemanda(d) === nucleoSelecionado);
  console.log("Demandas do núcleo:", demandasDoNucleo);

  // demandasParaTabela: só as demandas ATIVAS (sem Fim preenchido). A tabela operacional
  // NUNCA esconde uma linha por causa do Status (Fila, Em processo, Pausado, Prioridade
  // e até Atrasado sempre aparecem) - a única condição para sair da tabela é ter Fim
  // preenchido. Isso é essencial: um diagramador pode preencher Início hoje e só
  // preencher Fim dias depois: a demanda precisa continuar visível até esse momento.
  // Exceção: se o usuário filtrar explicitamente por Status = Finalizado, mostramos
  // as finalizadas também, para permitir localizá-las/corrigi-las.
  const statusFiltroSelecionado = document.getElementById("filtro-status").value;
  const demandasParaTabela = statusEhFinalizado(statusFiltroSelecionado)
    ? aplicarFiltros(demandasDoNucleo)
    : aplicarFiltros(demandasDoNucleo.filter((d) => !demandaTemFimPreenchido(d)));

  console.log("Demandas para tabela:", demandasParaTabela);
  console.log(
    "Demandas ocultadas por Fim preenchido:",
    demandasDoNucleo.filter((d) => demandaTemFimPreenchido(d))
  );
  console.log(
    "Demandas EM PROCESSO:",
    demandasDoNucleo.filter((d) => String(d.status || "").toUpperCase().includes("PROCESSO"))
  );
  console.log(
    "Demandas com Fim preenchido:",
    demandasDoNucleo.filter((d) => String(d.fim || "").trim())
  );

  const demandasVisiveisDoNucleo = demandasParaTabela;

  const opcoesAnoEscolar = obterOpcoesComFallback(configuracoes.anosEscolares, FALLBACK_ANOS_ESCOLARES);
  const opcoesModulo = obterOpcoesComFallback(configuracoes.modulos, FALLBACK_MODULOS);
  const opcoesFrente = configuracoes.frentes || [];
  // Coluna ATIVIDADE: usa configuracoes.prioridades (coluna "Prioridades" da aba LISTAS,
  // reaproveitada para transportar a lista de atividades sem alterar o Apps Script).
  const opcoesAtividade = obterOpcoesComFallback(configuracoes.prioridades, FALLBACK_ATIVIDADES_TABELA);
  // Coluna "Pausa/Prioridade": fixas — apenas Pausado/Prioridade, independentes da lista acima.
  const opcoesPausaPrioridade = OPCOES_PAUSA_PRIORIDADE_TABELA;

  diagramadores.forEach((nomeDiagramador, indiceDiagramador) => {
    // Demandas reais do diagramador, ordenadas pelo slot (posição) em que foram cadastradas
    const demandasDoDiagramador = demandasVisiveisDoNucleo
      .filter((d) => d.diagramador === nomeDiagramador)
      .sort((a, b) => a.slot - b.slot);

    // Linhas vazias necessárias para completar o mínimo de LINHAS_POR_DIAGRAMADOR.
    // Se já houver demandas reais suficientes (ou mais), nenhuma linha vazia é adicionada.
    const vaziosNecessarios = Math.max(0, LINHAS_POR_DIAGRAMADOR - demandasDoDiagramador.length);

    // Total de linhas do bloco: usado pelo rowspan da célula do diagramador
    const totalLinhasBloco = demandasDoDiagramador.length + vaziosNecessarios;

    // Próximo slot livre disponível para as linhas vazias deste bloco
    let proximoSlotLivre = encontrarPrimeiroSlotVazio(nucleoSelecionado, nomeDiagramador, null);

    let primeiraLinhaDoBloco = true;

    const adicionarLinha = (demanda, slotDaLinhaVazia) => {
      const linha = document.createElement("tr");

      // Primeira linha de cada bloco: recebe classe de início de grupo (todos os blocos)
      if (primeiraLinhaDoBloco) {
        linha.classList.add("inicio-bloco");
      }

      const ehPrimeiraLinha = primeiraLinhaDoBloco;
      primeiraLinhaDoBloco = false;

      // Se a linha ainda não tem demanda real, verifica se já existe um preenchimento
      // temporário (ainda não salvo na base) guardado para este slot
      const chaveTemporaria = demanda
        ? null
        : obterChaveLinhaTemporaria(nucleoSelecionado, nomeDiagramador, slotDaLinhaVazia);
      const linhaTemporaria = chaveTemporaria ? linhasTemporariasTabela[chaveTemporaria] || null : null;

      if (demanda) {
        linha.classList.add("linha-preenchida");
      } else if (linhaTemporaria) {
        linha.classList.add("linha-temporaria");
      } else {
        linha.classList.add("linha-vazia");
      }

      if (demanda && estaAtrasada(demanda)) {
        linha.classList.add("linha-atrasada");
      }

      // Contexto da linha: usado pelos campos editáveis para saber qual demanda
      // atualizar (se já existir), qual linha temporária usar enquanto não existir
      // demanda real, ou onde encaixar uma nova (núcleo/diagramador/slot)
      const contexto = {
        demanda: demanda || null,
        linhaTemporaria,
        nucleo: nucleoSelecionado,
        diagramador: nomeDiagramador,
        slot: demanda ? demanda.slot : slotDaLinhaVazia,
      };

      // Diagramador: apenas na primeira linha do bloco, com rowspan cobrindo todas as
      // linhas do diagramador — elimina bordas pontilhadas internas nessa coluna.
      // Nas demais linhas do bloco, a <td> não é criada (o rowspan ocupa o espaço).
      if (ehPrimeiraLinha) {
        const celulaDiagramador = document.createElement("td");
        celulaDiagramador.className = "coluna-diagramador td-diagramador";
        celulaDiagramador.rowSpan = totalLinhasBloco;
        celulaDiagramador.appendChild(criarCelulaDiagramadorTabela(nomeDiagramador));
        linha.appendChild(celulaDiagramador);
      }

      linha.appendChild(criarCelulaComSelect(contexto, "anoEscolar", opcoesAnoEscolar));
      linha.appendChild(criarCelulaComSelect(contexto, "modulo", opcoesModulo));
      linha.appendChild(criarCelulaComSelect(contexto, "frente", opcoesFrente));
      linha.appendChild(criarCelulaAtividadeTabela(contexto, opcoesAtividade));
      linha.appendChild(criarCelulaComInputData(contexto, "inicio"));
      linha.appendChild(criarCelulaComInputData(contexto, "previsto"));
      linha.appendChild(criarCelulaComSelect(contexto, "prioridade", opcoesPausaPrioridade));
      linha.appendChild(criarCelulaComInputData(contexto, "fim"));

      // Status: somente leitura, calculado automaticamente (não editável nesta etapa).
      // Linhas temporárias (sem demanda real ainda) não têm status calculado.
      const celulaStatus = document.createElement("td");
      if (demanda) {
        const classeStatus = statusParaClasse(demanda.status);
        celulaStatus.innerHTML = `<span class="etiqueta-status ${classeStatus}">${escaparTexto(obterTextoStatus(demanda.status))}</span>`;
      } else {
        celulaStatus.textContent = "-";
      }
      linha.appendChild(celulaStatus);

      // Ações: o botão Excluir só aparece para demandas reais que já tenham ID
      // (nunca em linhas temporárias ou vazias)
      const celulaAcoes = document.createElement("td");
      celulaAcoes.className = "coluna-acoes";
      if (demanda && demanda.id) {
        const botaoExcluir = document.createElement("button");
        botaoExcluir.type = "button";
        botaoExcluir.className = "btn-excluir-demanda";
        botaoExcluir.textContent = "Excluir";
        botaoExcluir.addEventListener("click", () => excluirDemanda(demanda.id));
        celulaAcoes.appendChild(botaoExcluir);
      } else {
        celulaAcoes.textContent = "-";
      }
      linha.appendChild(celulaAcoes);

      corpo.appendChild(linha);
    };

    // Primeiro exibe todas as demandas reais (mesmo que sejam mais do que o mínimo)
    demandasDoDiagramador.forEach((demanda) => adicionarLinha(demanda, null));

    // Depois completa com linhas vazias (ou temporárias, se já houver preenchimento
    // ainda não salvo) até atingir o mínimo de linhas do bloco
    for (let i = 0; i < vaziosNecessarios; i++) {
      adicionarLinha(null, proximoSlotLivre);
      proximoSlotLivre += 1;
    }

    // Marca a última linha do bloco para aplicar borda inferior de fechamento
    const ultimaLinha = corpo.lastElementChild;
    if (ultimaLinha) ultimaLinha.classList.add("fim-bloco");
  });

  atualizarContadores();
}

// ===================== ALTERNÂNCIA ENTRE TELAS ===================== //

// Mostra a tela correspondente a `telaAtual` ("resumo", "tabela" ou "kanban") e recalcula
// o conteúdo das três telas, garantindo que tudo fique atualizado independente de qual
// tela está visível no momento (ex: criar uma demanda atualiza o resumo mesmo estando na tabela).
function renderizarTela() {
  document.getElementById("tela-resumo-nucleos").classList.toggle("oculto", telaAtual !== "resumo");
  document.getElementById("tela-operacional").classList.toggle("oculto", telaAtual !== "tabela");
  document.getElementById("tela-kanban-visual").classList.toggle("oculto", telaAtual !== "kanban");

  // O filtro "Diagramador" depende do núcleo selecionado, então é repopulado
  // a cada troca de tela/núcleo, antes de renderizar a tabela com os filtros aplicados
  popularFiltroDiagramadores();

  renderizarTabela();
  atualizarResumoNucleos();
  renderizarKanbanVisual();

  atualizarBotaoNucleoAtivo();
}

// ===================== RESUMO DOS NÚCLEOS (RESUMO GERAL DOS DIAGRAMADORES) ===================== //

// ===================== CARROSSEL: EQUIPE DE DIAGRAMAÇÃO ===================== //

// Monta os cards do carrossel "Equipe de Diagramação" usando os dados já carregados em
// configuracoes.diagramadoresPorNucleo e configuracoes.fotosDiagramadores.
// Ordem: ORDEM_NUCLEOS_RESUMO primeiro, depois quaisquer outros núcleos em ordem alfabética.
// Todos os profissionais são exibidos (sem filtragem por NUCLEOS_OCULTOS_RESUMO).
function renderizarCarrosselEquipe() {
  const carousel = document.getElementById("equipeCarousel");
  if (!carousel) return;

  const grupos = configuracoes.diagramadoresPorNucleo || {};
  const fotos = configuracoes.fotosDiagramadores || {};

  // Ordena os núcleos: primeiro os da ORDEM_NUCLEOS_RESUMO, depois os extras
  const todosNucleos = Object.keys(grupos);
  const extras = todosNucleos
    .filter((n) => !ORDEM_NUCLEOS_RESUMO.includes(n))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const ordemFinal = [...ORDEM_NUCLEOS_RESUMO, ...extras].filter((n) => grupos[n] && grupos[n].length > 0);

  carousel.innerHTML = "";

  let totalMembros = 0;
  ordemFinal.forEach(function (nucleo) {
    totalMembros += (grupos[nucleo] || []).length;
  });
  const countEl = document.getElementById("team-carousel-count");
  if (countEl) countEl.textContent = totalMembros + (totalMembros !== 1 ? " profissionais" : " profissional");

  ordemFinal.forEach(function (nucleo) {
    const membros = grupos[nucleo] || [];
    membros.forEach(function (nome) {
      const fotoUrl = fotos[nome] || "";
      carousel.appendChild(criarCardEquipeDiagramacao(nome, nucleo, fotoUrl));
    });
  });

  // Configura os botões de navegação (reconecta após cada render)
  const prev = document.querySelector(".equipe-carousel-prev");
  const next = document.querySelector(".equipe-carousel-next");
  if (prev) {
    prev.onclick = function () {
      carousel.scrollBy({ left: -340, behavior: "smooth" });
    };
  }
  if (next) {
    next.onclick = function () {
      carousel.scrollBy({ left: 340, behavior: "smooth" });
    };
  }
}

// Cria e retorna o elemento <div> de um card individual do carrossel.
function criarCardEquipeDiagramacao(nome, nucleo, fotoUrl) {
  const card = document.createElement("div");
  card.className = "equipe-card";

  const iniciais = obterIniciaisNome(nome);

  // Bloco da foto: construído via DOM para evitar problemas de escape de HTML
  const fotoDiv = document.createElement("div");
  fotoDiv.className = "equipe-card-foto";

  if (fotoUrl) {
    const img = document.createElement("img");
    img.src = fotoUrl;
    img.alt = nome;
    img.loading = "lazy";
    img.addEventListener("error", function () {
      const fallback = document.createElement("div");
      fallback.className = "equipe-card-foto-fallback";
      fallback.textContent = iniciais;
      fotoDiv.replaceChildren(fallback);
    });
    fotoDiv.appendChild(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "equipe-card-foto-fallback";
    fallback.textContent = iniciais;
    fotoDiv.appendChild(fallback);
  }

  // Bloco de informações
  const infoDiv = document.createElement("div");
  infoDiv.className = "equipe-card-info";
  infoDiv.innerHTML =
    '<p class="equipe-card-nome">' + nome + "</p>" +
    '<p class="equipe-card-nucleo">' + nucleo + "</p>";

  card.appendChild(fotoDiv);
  card.appendChild(infoDiv);

  return card;
}

// Atualiza a tela "Resumo dos núcleos": duas listas (livres / com atividade) considerando
// TODOS os diagramadores cadastrados, de TODOS os núcleos/setores ao mesmo tempo -
// não depende do núcleo selecionado na navegação.
function atualizarResumoNucleos() {
  atualizarCardsGeraisResumo();
  atualizarVisualizacaoResumoAtiva();
  atualizarDemandasCriticas();

  console.log("Renderizando livres agrupados por núcleo");
  console.log("Config diagramadoresPorNucleo:", configuracoes.diagramadoresPorNucleo);

  // Ordem dos grupos: ORDEM_NUCLEOS_RESUMO primeiro, depois extras em ordem alfabética.
  // Setores em NUCLEOS_OCULTOS_RESUMO são excluídos visualmente (dados da planilha intactos).
  const todosNucleos = Object.keys(configuracoes.diagramadoresPorNucleo || {});
  const nucleosExtras = todosNucleos
    .filter((n) => !ORDEM_NUCLEOS_RESUMO.includes(n) && !NUCLEOS_OCULTOS_RESUMO.includes(n))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const ordemFinal = [...ORDEM_NUCLEOS_RESUMO, ...nucleosExtras]
    .filter((n) => !NUCLEOS_OCULTOS_RESUMO.includes(n));

  const gruposLivres = [];
  // Mapa temporário para acumular diagramadores com atividade por núcleo
  const mapaAtividade = {};

  ordemFinal.forEach(function (nucleo) {
    const membros = configuracoes.diagramadoresPorNucleo[nucleo];
    if (!membros || membros.length === 0) return;

    const livresDoGrupo = [];

    membros.forEach(function (nome) {
      if (diagramadorTemDemandaAtiva(nome)) {
        // Coleta as demandas ativas; usa demanda.Nucleo/demanda.nucleo como fonte primária
        // e cai no núcleo do cadastro (configuracoes.diagramadoresPorNucleo) como fallback
        const demandasDele = demandas.filter(function (d) {
          const nomeDemanda = d.Diagramador || d.diagramador || "";
          return normalizarNome(nomeDemanda) === normalizarNome(nome) && !demandaTemFimPreenchido(d);
        });
        demandasDele.forEach(function (demanda) {
          const nucleoDemanda = demanda.Nucleo || demanda.nucleo || nucleo;
          if (!mapaAtividade[nucleoDemanda]) mapaAtividade[nucleoDemanda] = [];
          // Evita duplicar o mesmo diagramador no mesmo grupo
          const jaExiste = mapaAtividade[nucleoDemanda].some((r) => normalizarNome(r.nome) === normalizarNome(nome));
          if (!jaExiste) {
            mapaAtividade[nucleoDemanda].push({ nome: nome, nucleo: nucleoDemanda, demandasAtivas: demandasDele });
          }
        });
      } else {
        livresDoGrupo.push({ nome: nome, nucleo: nucleo });
      }
    });

    if (livresDoGrupo.length > 0) {
      gruposLivres.push({ nucleo: nucleo, diagramadores: livresDoGrupo });
    }
  });

  // Monta gruposAtividade respeitando ordemFinal; núcleos que vieram só via demanda.Nucleo
  // (não estão em configuracoes.diagramadoresPorNucleo) são incluídos ao final
  const nucleosComAtividade = Object.keys(mapaAtividade);
  const nucleosExtrasAtividade = nucleosComAtividade
    .filter((n) => !ordemFinal.includes(n))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const ordemAtividade = [...ordemFinal, ...nucleosExtrasAtividade];

  const gruposAtividade = [];
  ordemAtividade.forEach(function (nucleo) {
    if (mapaAtividade[nucleo] && mapaAtividade[nucleo].length > 0) {
      gruposAtividade.push({ nucleo: nucleo, diagramadores: mapaAtividade[nucleo] });
    }
  });

  console.log("Grupos livres:", gruposLivres.map(function (g) { return g.nucleo + " (" + g.diagramadores.length + ")"; }));
  console.log("Demandas ativas por núcleo:", gruposAtividade);
  console.log("Renderizando diagramadores com atividade agrupados");

  renderizarDiagramadoresLivresPorGrupo("lista-diagramadores-livres", gruposLivres);
  renderizarDiagramadoresAtivoPorGrupo("lista-diagramadores-ocupados", gruposAtividade);
}

// Cards gerais do topo da tela "Resumo dos núcleos": somam as demandas de TODOS
// os núcleos/setores, sem depender do núcleo atualmente selecionado na navegação.
function atualizarCardsGeraisResumo() {
  const total = demandas.length;
  const emProcesso = demandas.filter((d) => statusEhEmProcesso(d.status)).length;
  const finalizadas = demandas.filter((d) => statusEhFinalizado(d.status)).length;
  const atrasadas = demandas.filter((d) => statusEhAtrasado(d.status) || estaAtrasada(d)).length;

  document.getElementById("resumo-geral-total").textContent = total;
  document.getElementById("resumo-geral-processo").textContent = emProcesso;
  document.getElementById("resumo-geral-finalizadas").textContent = finalizadas;
  document.getElementById("resumo-geral-atrasadas").textContent = atrasadas;
}

// ===================== ALTERNÂNCIA DE ABAS DO RESUMO DOS NÚCLEOS ===================== //

// Troca a aba ativa dentro do "Resumo dos núcleos" e atualiza a interface.
function irParaVisualizacaoResumo(nomeDaVisualizacao) {
  visualizacaoResumoAtiva = nomeDaVisualizacao;
  atualizarVisualizacaoResumoAtiva();
}

// Exibe a aba ativa (equipe | kanban-geral | equipe-diagramacao), oculta as outras
// e marca o botão correspondente como ativo. Ao entrar em cada aba, executa a
// renderização necessária para aquela visão.
function atualizarVisualizacaoResumoAtiva() {
  const aba = visualizacaoResumoAtiva;
  const ehEquipeDiagramacao = aba === "equipe-diagramacao";

  // Abas de conteúdo
  document.getElementById("resumo-visao-equipe")
    .classList.toggle("oculto", aba !== "equipe");
  document.getElementById("resumo-visao-kanban-geral")
    .classList.toggle("oculto", aba !== "kanban-geral");
  document.getElementById("resumo-visao-equipe-diagramacao")
    .classList.toggle("oculto", !ehEquipeDiagramacao);

  // Botões ativos
  document.getElementById("btn-visao-equipe")
    .classList.toggle("ativo", aba === "equipe");
  document.getElementById("btn-kanban-visual-geral")
    .classList.toggle("ativo", aba === "kanban-geral");
  document.getElementById("btn-equipe-diagramacao")
    .classList.toggle("ativo", ehEquipeDiagramacao);

  // Modo imersivo: a classe body.modo-equipe-diagramacao controla via CSS o
  // ocultamento do header, remoção de margens e expansão da seção para 100vh.
  // Os elementos internos abaixo são ocultados via JS (.oculto) pois estão
  // dentro do mesmo container e precisam sumir independente do CSS do body.
  document.body.classList.toggle("modo-equipe-diagramacao", ehEquipeDiagramacao);

  const cardsGerais = document.querySelector(".resumo-geral-cards");
  const tituloResumo = document.querySelector(".tela-resumo-titulo");
  const abasBotoes = document.querySelector(".resumo-acoes-secundarias");

  if (cardsGerais) cardsGerais.classList.toggle("oculto", ehEquipeDiagramacao);
  if (tituloResumo) tituloResumo.classList.toggle("oculto", ehEquipeDiagramacao);
  if (abasBotoes) abasBotoes.classList.toggle("oculto", ehEquipeDiagramacao);

  if (aba === "kanban-geral") {
    renderizarKanbanVisualGeral();
  }

  if (ehEquipeDiagramacao) {
    renderizarCarrosselEquipe();
  }
}

// ===================== KANBAN VISUAL GERAL (TODOS OS NÚCLEOS AO MESMO TEMPO) ===================== //

// Renderiza o Kanban Visual Geral: um bloco por núcleo, sempre na ordem fixa de
// ORDEM_NUCLEOS_KANBAN_GERAL, cada um com seu próprio mini-kanban (FILA / EM PROCESSO /
// PAUSADO / PRIORIDADE / FINALIZADO). Demandas sem núcleo identificável são ignoradas
// aqui (não criam bloco "Sem núcleo"), mas continuam existindo normalmente na base/tabela.
function renderizarKanbanVisualGeral() {
  const container = document.getElementById("kanban-geral-nucleos");
  container.innerHTML = "";

  // Aplica filtro: exibe todos os núcleos permitidos ou apenas o selecionado
  const nucleosVisiveis =
    filtroNucleoKanbanGeral === "todos"
      ? ORDEM_NUCLEOS_KANBAN_GERAL
      : ORDEM_NUCLEOS_KANBAN_GERAL.filter((n) => n === filtroNucleoKanbanGeral);

  const demandasPorNucleo = agruparDemandasPorNucleo(nucleosVisiveis);

  nucleosVisiveis.forEach((nucleo) => {
    container.appendChild(criarBlocoNucleoKanbanGeral(nucleo, demandasPorNucleo[nucleo] || []));
  });
}

// Agrupa as demandas dos núcleos informados, descobrindo o núcleo de cada uma a partir
// do diagramador (procurado em configuracoes.diagramadoresPorNucleo). Demandas cujo
// diagramador não pertence a nenhum dos núcleos informados são simplesmente ignoradas
// (sem criar um bloco "Sem núcleo") - elas continuam intactas na base e na tabela.
function agruparDemandasPorNucleo(nucleos) {
  const demandasPorNucleo = {};
  nucleos.forEach((nucleo) => {
    demandasPorNucleo[nucleo] = [];
  });

  // Usa o campo Nucleo da própria demanda (vindo da BASE_DEMANDAS); só cai para o
  // fallback por diagramador se a demanda não tiver Nucleo preenchido. Demandas cujo
  // núcleo (real ou por fallback) não está entre os `nucleos` informados são apenas
  // ignoradas aqui - nunca criam um bloco "Sem núcleo" nem caem num núcleo fixo.
  demandas.forEach((demanda) => {
    const nucleo = obterNucleoDaDemanda(demanda);
    if (nucleo && demandasPorNucleo[nucleo]) {
      demandasPorNucleo[nucleo].push(demanda);
    }
  });

  return demandasPorNucleo;
}

// Bloco de um núcleo: cabeçalho com indicadores + mini-kanban de 5 colunas
function criarBlocoNucleoKanbanGeral(nucleo, demandasDoNucleo) {
  const bloco = document.createElement("div");
  bloco.className = "kanban-geral-nucleo";

  const emProcesso = demandasDoNucleo.filter((d) => statusEhEmProcesso(d.status)).length;
  const atrasadas = demandasDoNucleo.filter((d) => statusEhAtrasado(d.status) || estaAtrasada(d)).length;
  const finalizadas = demandasDoNucleo.filter((d) => statusEhFinalizado(d.status)).length;

  const cabecalho = document.createElement("div");
  cabecalho.className = "kanban-geral-nucleo-cabecalho";
  cabecalho.innerHTML = `
    <h4 class="kanban-geral-nucleo-titulo">${escaparTexto(nucleo)}</h4>
    <div class="kanban-geral-nucleo-indicadores">
      <span class="indicador-mini">Total: ${demandasDoNucleo.length}</span>
      <span class="indicador-mini indicador-mini-processo">Em processo: ${emProcesso}</span>
      <span class="indicador-mini indicador-mini-atrasado">Atrasadas: ${atrasadas}</span>
      <span class="indicador-mini indicador-mini-finalizado">Finalizadas: ${finalizadas}</span>
    </div>
  `;
  bloco.appendChild(cabecalho);

  // O mini-kanban (5 colunas) é sempre exibido, mesmo sem nenhuma demanda no núcleo -
  // cada coluna mostra "Sem demandas." individualmente, mantendo o painel padronizado.
  const colunas = document.createElement("div");
  colunas.className = "kanban-geral-colunas";

  const definicoesColunas = [
    { chave: "fila", titulo: "FILA", filtro: (d) => classificarColunaKanbanGeral(d) === "fila" },
    { chave: "em-processo", titulo: "EM PROCESSO", filtro: (d) => classificarColunaKanbanGeral(d) === "em-processo" },
    { chave: "pausado", titulo: "PAUSADO", filtro: (d) => classificarColunaKanbanGeral(d) === "pausado" },
    { chave: "prioridade", titulo: "PRIORIDADE", filtro: pertenceColunaPrioridadeGeral },
    { chave: "finalizado", titulo: "FINALIZADO", filtro: (d) => classificarColunaKanbanGeral(d) === "finalizado" },
  ];

  definicoesColunas.forEach((definicao) => {
    const demandasDaColuna = demandasDoNucleo.filter(definicao.filtro);
    colunas.appendChild(criarColunaKanbanGeral(definicao.titulo, definicao.chave, demandasDaColuna));
  });

  bloco.appendChild(colunas);
  return bloco;
}

// Classifica a demanda na coluna primária (mutuamente exclusiva): Finalizado > Em processo
// > Pausado > Fila. "Fila" é o padrão para qualquer status não reconhecido (A iniciar,
// Backlog, vazio, Atrasado, etc.) - garante que toda demanda em aberto apareça em algum lugar.
function classificarColunaKanbanGeral(demanda) {
  if (statusEhFinalizado(demanda.status)) return "finalizado";
  if (statusEhEmProcesso(demanda.status)) return "em-processo";
  if (statusEhPausado(demanda.status)) return "pausado";
  return "fila";
}

// A coluna "Prioridade" é um recorte adicional (não exclusivo): mostra também aqui
// qualquer demanda não finalizada com prioridade Alta/Urgente ou status "Prioridade"
function pertenceColunaPrioridadeGeral(demanda) {
  if (statusEhFinalizado(demanda.status)) return false;
  if (normalizarStatus(demanda.status) === "prioridade") return true;
  return PRIORIDADES_ALTA.includes(demanda.prioridade);
}

// Coluna do mini-kanban: título + lista de cards (ou "Sem demandas.")
function criarColunaKanbanGeral(titulo, chave, listaDemandas) {
  const coluna = document.createElement("div");
  coluna.className = `kanban-geral-coluna kanban-geral-coluna-${chave}`;

  const tituloEl = document.createElement("h5");
  tituloEl.className = "kanban-geral-coluna-titulo";
  tituloEl.textContent = titulo;
  coluna.appendChild(tituloEl);

  const corpo = document.createElement("div");
  corpo.className = "kanban-geral-coluna-corpo";

  if (listaDemandas.length === 0) {
    corpo.innerHTML = `<p class="kanban-geral-coluna-vazio">Sem demandas.</p>`;
  } else {
    listaDemandas.forEach((demanda) => corpo.appendChild(criarCardKanbanGeral(demanda)));
  }

  coluna.appendChild(corpo);
  return coluna;
}

// Card de uma demanda dentro do Kanban Visual Geral: diagramador, ano/módulo/frente,
// atividade, início, previsto, status (selo) e prioridade (se existir). Demandas
// atrasadas (por status ou prazo vencido) recebem destaque visual em vermelho.
function criarCardKanbanGeral(demanda) {
  const card = document.createElement("div");
  card.className = "kanban-geral-card";

  if (statusEhAtrasado(demanda.status) || estaAtrasada(demanda)) {
    card.classList.add("kanban-geral-card-atrasada");
  }

  const selo = obterSeloStatus(demanda.status);

  card.innerHTML = `
    <div class="kanban-geral-card-linha kanban-geral-card-diagramador">${escaparTexto(demanda.diagramador || "-")}</div>
    <div class="kanban-geral-card-linha kanban-geral-card-meta">${escaparTexto(demanda.anoEscolar || "-")} • ${escaparTexto(demanda.modulo || "-")} • ${escaparTexto(demanda.frente || "-")}</div>
    <div class="kanban-geral-card-linha"><strong>Atividade:</strong> ${escaparTexto(demanda.atividade || "-")}</div>
    <div class="kanban-geral-card-linha">Início: ${formatarDataHora(demanda.inicio)}</div>
    <div class="kanban-geral-card-linha">Previsto: ${formatarDataHora(demanda.previsto)}</div>
    <div class="kanban-geral-card-linha"><span class="selo ${selo.classe}">${escaparTexto(selo.texto)}</span></div>
    ${demanda.prioridade ? `<div class="kanban-geral-card-linha kanban-geral-card-prioridade">Prioridade: ${escaparTexto(demanda.prioridade)}</div>` : ""}
  `;

  return card;
}

// ===================== SELOS DE STATUS (PAINEL "RESUMO DOS NÚCLEOS") ===================== //

// Traduz um status (já tolerando maiúsculas/minúsculas, acentos e espaços, via as funções
// statusEh*) no texto e na classe CSS do selo exibido no painel "Resumo dos núcleos".
// Esse sistema de selos é próprio deste painel e não afeta a tabela operacional nem o
// Kanban Visual, que continuam usando a etiqueta-status já existente.
function obterSeloStatus(status) {
  if (statusEhFinalizado(status)) return { texto: "FINALIZADO", classe: "selo-finalizado" };
  if (statusEhAtrasado(status)) return { texto: "ATRASADO", classe: "selo-atrasado" };
  if (statusEhEmProcesso(status)) return { texto: "EM PROCESSO", classe: "selo-em-processo" };
  if (statusEhPausado(status)) return { texto: "PAUSADO", classe: "selo-pausado" };
  if (statusEhPrioridade(status)) return { texto: "PRIORIDADE", classe: "selo-prioridade" };
  if (statusEhAIniciar(status)) return { texto: "FILA", classe: "selo-fila" };
  return { texto: String(status || "-").toUpperCase(), classe: "selo-generico" };
}

// ===================== DEMANDAS CRÍTICAS ===================== //

// Reúne as demandas que merecem atenção imediata da gestão: atrasadas (por status
// ou por data Previsto vencida) e, opcionalmente, as que vencem nas próximas 24h.
// Demandas finalizadas nunca entram nesta lista. Ordenadas pelo prazo mais urgente primeiro.
// Considera atrasada apenas quem realmente está atrasada: status explicitamente
// ATRASADO, OU Previsto já vencido E ainda sem Fim preenchido. Não inclui demandas
// "em dia" (Em processo dentro do prazo) nem demandas futuras (Previsto ainda não
// chegou) - só quem já passou do prazo e ainda não foi concluído.
function obterDemandasCriticas() {
  const agora = new Date();

  return demandas
    .filter((demanda) => {
      // Fim preenchido: a demanda já foi concluída, não é mais uma pendência atrasada
      if (demandaTemFimPreenchido(demanda)) return false;

      // Status explicitamente ATRASADO
      if (statusEhAtrasado(demanda.status)) return true;

      // Previsto vencido (e ainda sem Fim, já garantido acima)
      if (demanda.previsto) {
        const previsto = new Date(demanda.previsto);
        if (!Number.isNaN(previsto.getTime()) && previsto < agora) return true;
      }

      return false;
    })
    .sort((a, b) => new Date(a.previsto || 0) - new Date(b.previsto || 0));
}

// Atualiza a área "Atividades atrasadas" do painel "Resumo dos núcleos"
function atualizarDemandasCriticas() {
  const container = document.getElementById("lista-demandas-criticas");
  const atrasadas = obterDemandasCriticas();

  container.innerHTML = "";

  if (atrasadas.length === 0) {
    container.innerHTML = `<p class="demandas-criticas-vazio">Nenhuma atividade atrasada no momento.</p>`;
    return;
  }

  atrasadas.forEach((demanda) => container.appendChild(criarItemDemandaCritica(demanda)));
}

// Card de uma atividade atrasada: atividade, diagramador, frente/ano/módulo, previsto
// e selo "ATRASADA" (sempre - esta área só lista demandas já filtradas como atrasadas)
function criarItemDemandaCritica(demanda) {
  const item = document.createElement("div");
  item.className = "item-demanda-critica critica-vencida";

  item.innerHTML = `
    <div class="critica-info">
      <span class="critica-atividade">${escaparTexto(demanda.atividade || "-")}</span>
      <span class="critica-detalhes">
        ${escaparTexto(demanda.diagramador || "-")} •
        Frente: ${escaparTexto(demanda.frente || "-")} •
        Ano: ${escaparTexto(demanda.anoEscolar || "-")} •
        Módulo: ${escaparTexto(demanda.modulo || "-")}
      </span>
      <span class="critica-previsto">Previsto: ${formatarDataHora(demanda.previsto)}</span>
    </div>
    <span class="selo selo-atrasado">ATRASADA</span>
  `;

  return item;
}

// Renderiza os diagramadores livres agrupados por núcleo/setor.
// Cada grupo gera uma tarjeta de título + os cards dos diagramadores daquele grupo.
// Grupos vazios já foram filtrados em atualizarResumoNucleos.
function renderizarDiagramadoresLivresPorGrupo(idContainer, grupos) {
  const container = document.getElementById(idContainer);
  if (!container) {
    console.warn("renderizarDiagramadoresLivresPorGrupo: container não encontrado:", idContainer);
    return;
  }

  container.innerHTML = "";
  console.log("renderizarDiagramadoresLivresPorGrupo chamada com", grupos.length, "grupos:", grupos.map((g) => g.nucleo));

  if (grupos.length === 0) {
    const aviso = document.createElement("span");
    aviso.className = "lista-diagramadores-vazio";
    aviso.textContent = "Nenhum diagramador livre no momento.";
    container.appendChild(aviso);
    return;
  }

  grupos.forEach(({ nucleo, diagramadores }) => {
    // Bloco do grupo: tarjeta de título + cards
    const blocoGrupo = document.createElement("div");
    blocoGrupo.className = "grupo-livres";

    // Tarjeta: faixa azul com borda lateral
    const tarjeta = document.createElement("div");
    tarjeta.className = "grupo-livres-titulo";
    tarjeta.textContent = nucleo;
    blocoGrupo.appendChild(tarjeta);

    // Cards dos diagramadores livres deste grupo
    const listaCards = document.createElement("div");
    listaCards.className = "grupo-livres-cards";
    diagramadores.forEach((reg) => listaCards.appendChild(criarItemDiagramadorLivre(reg)));
    blocoGrupo.appendChild(listaCards);

    container.appendChild(blocoGrupo);
  });
}

// Renderiza os diagramadores com atividade agrupados por núcleo/setor.
// Mesmo padrão visual de renderizarDiagramadoresLivresPorGrupo.
// grupos = [{ nucleo, diagramadores: [{ nome, nucleo, demandasAtivas }] }]
function renderizarDiagramadoresAtivoPorGrupo(idContainer, grupos) {
  const container = document.getElementById(idContainer);
  if (!container) {
    console.warn("renderizarDiagramadoresAtivoPorGrupo: container não encontrado:", idContainer);
    return;
  }

  container.innerHTML = "";

  if (grupos.length === 0) {
    const aviso = document.createElement("span");
    aviso.className = "lista-diagramadores-vazio";
    aviso.textContent = "Nenhum diagramador com atividade no momento.";
    container.appendChild(aviso);
    return;
  }

  grupos.forEach(({ nucleo, diagramadores }) => {
    const blocoGrupo = document.createElement("div");
    blocoGrupo.className = "grupo-atividade";

    const tarjeta = document.createElement("div");
    tarjeta.className = "grupo-atividade-titulo";
    tarjeta.textContent = nucleo;
    blocoGrupo.appendChild(tarjeta);

    const listaCards = document.createElement("div");
    listaCards.className = "grupo-atividade-cards";
    diagramadores.forEach((reg) => listaCards.appendChild(criarItemDiagramadorOcupado(reg)));
    blocoGrupo.appendChild(listaCards);

    container.appendChild(blocoGrupo);
  });
}

// Renderiza a lista vertical de cards de diagramadores no container informado.
// Para "ocupado", cada registro deve trazer `demandasAtivas`; para "livre" não é necessário.
// Se a lista estiver vazia, exibe "Nenhum".
function renderizarListaDiagramadores(idContainer, registros, classeVariante) {
  const container = document.getElementById(idContainer);
  container.innerHTML = "";

  if (registros.length === 0) {
    container.innerHTML = `<span class="lista-diagramadores-vazio">Nenhum</span>`;
    return;
  }

  registros.forEach((registro) => {
    const item =
      classeVariante === "ocupado"
        ? criarItemDiagramadorOcupado(registro)
        : criarItemDiagramadorLivre(registro);
    container.appendChild(item);
  });
}

// Card de um diagramador livre: avatar + nome + núcleo + selo "LIVRE"
function criarItemDiagramadorLivre({ nome, nucleo }) {
  const item = document.createElement("div");
  item.className = "item-diagramador item-diagramador-livre";
  item.appendChild(criarAvatarDiagramador(nome, "livre"));

  const info = document.createElement("div");
  info.className = "item-diagramador-info";
  info.innerHTML = `
    <div class="item-diagramador-cabecalho">
      <div>
        <span class="item-diagramador-nome">${escaparTexto(nome)}</span><br>
        <span class="item-diagramador-nucleo">${escaparTexto(nucleo)}</span>
      </div>
      <span class="selo selo-livre">LIVRE</span>
    </div>
  `;
  item.appendChild(info);

  return item;
}

// Card de um diagramador com atividade: avatar + nome + núcleo + cada demanda ativa
// (atividade, frente/ano/módulo quando existirem, e o selo de status em destaque)
function criarItemDiagramadorOcupado({ nome, nucleo, demandasAtivas }) {
  const item = document.createElement("div");
  item.className = "item-diagramador item-diagramador-ocupado";
  item.appendChild(criarAvatarDiagramador(nome, "ocupado"));

  const info = document.createElement("div");
  info.className = "item-diagramador-info";
  info.innerHTML = `
    <span class="item-diagramador-nome">${escaparTexto(nome)}</span>
    <span class="item-diagramador-nucleo">${escaparTexto(nucleo)}</span>
  `;

  const listaAtividades = document.createElement("div");
  listaAtividades.className = "item-diagramador-atividades";
  demandasAtivas.forEach((demanda) => {
    listaAtividades.appendChild(criarBlocoAtividade(demanda));
  });
  info.appendChild(listaAtividades);

  item.appendChild(info);
  return item;
}

// Bloco com os detalhes de uma demanda ativa, dentro do card "com atividade".
// Campos vazios (frente/ano/módulo) são simplesmente omitidos, sem quebrar o layout.
function criarBlocoAtividade(demanda) {
  const bloco = document.createElement("div");
  bloco.className = "atividade-resumo";

  const detalhes = [];
  if (demanda.frente) detalhes.push(`Frente: ${escaparTexto(demanda.frente)}`);
  if (demanda.anoEscolar) detalhes.push(`Ano: ${escaparTexto(demanda.anoEscolar)}`);
  if (demanda.modulo) detalhes.push(`Módulo: ${escaparTexto(demanda.modulo)}`);

  const selo = obterSeloStatus(demanda.status);

  bloco.innerHTML = `
    <div class="atividade-resumo-linha"><strong>Atividade:</strong> ${escaparTexto(demanda.atividade || "-")}</div>
    ${detalhes.length ? `<div class="atividade-resumo-linha atividade-resumo-detalhes">${detalhes.join(" • ")}</div>` : ""}
    <div class="atividade-resumo-linha"><span class="selo ${selo.classe}">${escaparTexto(selo.texto)}</span></div>
  `;

  return bloco;
}

// ===================== CÉLULA DIAGRAMADOR NA TABELA OPERACIONAL ===================== //

// Monta o conteúdo visual da célula "Diagramador" na tabela operacional:
// avatar circular (foto ou iniciais) + nome abaixo. Somente visual — o valor
// enviado à planilha continua sendo apenas o nome em texto puro.
function criarCelulaDiagramadorTabela(nomeDiagramador) {
  const wrapper = document.createElement("div");
  wrapper.className = "tabela-diagramador";

  // Avatar: reutiliza criarAvatarDiagramador com variante específica da tabela
  const avatar = criarAvatarDiagramadorTabela(nomeDiagramador);
  wrapper.appendChild(avatar);

  const nomeEl = document.createElement("div");
  nomeEl.className = "tabela-diagramador-nome";
  nomeEl.textContent = nomeDiagramador;
  wrapper.appendChild(nomeEl);

  return wrapper;
}

// Cria o avatar circular para a coluna Diagramador da tabela: foto com fallback
// para iniciais, usando as mesmas fontes de dados (obterFotoDiagramador /
// obterIniciaisNome) já usadas no Resumo dos núcleos.
function criarAvatarDiagramadorTabela(nome) {
  const url = obterFotoDiagramador(nome);
  const iniciais = obterIniciaisNome(nome);

  const div = document.createElement("div");
  div.className = "tabela-diagramador-avatar";

  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = nome;
    img.addEventListener("error", function () {
      // Imagem falhou: substitui pelo fallback de iniciais
      div.textContent = iniciais;
      div.classList.add("sem-foto");
    });
    div.appendChild(img);
  } else {
    div.textContent = iniciais;
    div.classList.add("sem-foto");
  }

  return div;
}

// ===================== AVATAR DOS DIAGRAMADORES (FOTO OU INICIAIS) ===================== //

// Busca a foto de um diagramador em configuracoes.fotosDiagramadores. Tenta primeiro a
// chave exata (mesmo nome vindo da coluna "Diagramador" da aba LISTAS); se não encontrar,
// tenta de novo ignorando espaços nas pontas e maiúsculas/minúsculas, para tolerar pequenas
// inconsistências entre a coluna "Diagramador" e a coluna "link" da planilha.
function obterFotoDiagramador(nome) {
  const fotos = configuracoes.fotosDiagramadores || {};

  if (fotos[nome]) {
    return fotos[nome];
  }

  const nomeNormalizado = String(nome || "").trim().toLowerCase();
  const chaveEquivalente = Object.keys(fotos).find(
    (chave) => chave.trim().toLowerCase() === nomeNormalizado
  );

  return chaveEquivalente ? fotos[chaveEquivalente] : undefined;
}

// Cria o avatar de um diagramador: usa a foto vinda de configuracoes.fotosDiagramadores
// quando existir; caso contrário (ou se a imagem falhar ao carregar), cai para um
// círculo colorido com as iniciais do nome. Os elementos <img> e <span> são criados
// via DOM (não via innerHTML), evitando qualquer risco de quebra de atributo com a URL.
function criarAvatarDiagramador(nome, classeVariante) {
  const url = obterFotoDiagramador(nome);
  const iniciais = obterIniciaisNome(nome);

  if (!url) {
    return criarAvatarFallback(iniciais, classeVariante);
  }

  const img = document.createElement("img");
  img.className = "item-diagramador-avatar designer-avatar-img";
  img.src = url;
  img.alt = nome;
  img.referrerPolicy = "no-referrer";
  img.addEventListener(
    "error",
    () => {
      img.replaceWith(criarAvatarFallback(iniciais, classeVariante));
    },
    { once: true }
  );

  return img;
}

// Cria o círculo de fallback com as iniciais do diagramador (ex: "Danielly Chagas" -> "DC")
function criarAvatarFallback(iniciais, classeVariante) {
  const span = document.createElement("span");
  span.className = `item-diagramador-avatar item-diagramador-avatar-fallback avatar-fallback ${classeVariante}`;
  span.textContent = iniciais;
  return span;
}

// Extrai as iniciais de um nome: primeira letra do primeiro e do último nome
function obterIniciaisNome(nome) {
  const partes = String(nome || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();

  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

// ===================== KANBAN VISUAL (QUADRO POR STATUS DO NÚCLEO SELECIONADO) ===================== //

// Renderiza o Kanban Visual: quadro com blocos por status (e por prioridade),
// considerando apenas as demandas do núcleo atualmente selecionado.
function renderizarKanbanVisual() {
  document.getElementById("kanban-visual-subtitulo").textContent = nucleoSelecionado;

  const demandasDoNucleo = demandas.filter((d) => obterNucleoDaDemanda(d) === nucleoSelecionado);

  const backlog = demandasDoNucleo.filter((d) => statusEhAIniciar(d.status));
  const emProcesso = demandasDoNucleo.filter((d) => statusEhEmProcesso(d.status));
  const pausado = demandasDoNucleo.filter((d) => statusEhPausado(d.status));
  const finalizado = demandasDoNucleo.filter((d) => statusEhFinalizado(d.status));
  const prioridade = demandasDoNucleo.filter(
    (d) =>
      !statusEhFinalizado(d.status) &&
      (statusEhPrioridade(d.status) || PRIORIDADES_ALTA.includes(d.prioridade))
  );

  preencherColunaKanban("kanban-coluna-backlog", backlog);
  preencherColunaKanban("kanban-coluna-emprocesso", emProcesso);
  preencherColunaKanban("kanban-coluna-pausado", pausado);
  preencherColunaKanban("kanban-coluna-finalizado", finalizado);
  preencherColunaKanban("kanban-coluna-prioridade", prioridade);
}

// Preenche uma coluna do Kanban Visual com os itens compactos das demandas informadas
function preencherColunaKanban(idColuna, listaDemandas) {
  const coluna = document.getElementById(idColuna);
  coluna.innerHTML = "";

  if (listaDemandas.length === 0) {
    coluna.innerHTML = `<div class="kanban-coluna-vazio">Nenhuma demanda</div>`;
    return;
  }

  listaDemandas.forEach((demanda) => {
    const item = document.createElement("div");
    item.className = "kanban-item";
    item.textContent = montarTextoCompactoDemanda(demanda);
    coluna.appendChild(item);
  });
}

// Monta o texto compacto de uma demanda no formato: "N1 - Taína | 6º | M4 | MAT | Atividade"
function montarTextoCompactoDemanda(demanda) {
  const nucleoDaDemanda = obterNucleoDaDemanda(demanda);
  const abreviacaoNucleo = NUCLEO_ABREVIACAO[nucleoDaDemanda] || nucleoDaDemanda;
  const partes = [
    `${abreviacaoNucleo} - ${demanda.diagramador || "-"}`,
    demanda.anoEscolar || "-",
    demanda.modulo || "-",
    demanda.frente || "-",
    demanda.atividade || "-",
  ];
  return partes.join(" | ");
}

// ===================== CONTADORES DO TOPO ===================== //

function atualizarContadores() {
  // Contadores consideram apenas as demandas do núcleo selecionado
  const demandasDoNucleo = demandas.filter((d) => obterNucleoDaDemanda(d) === nucleoSelecionado);

  const total = demandasDoNucleo.length;
  const emProcesso = demandasDoNucleo.filter((d) => statusEhEmProcesso(d.status)).length;
  const finalizadas = demandasDoNucleo.filter((d) => statusEhFinalizado(d.status)).length;
  const atrasadas = demandasDoNucleo.filter((d) => estaAtrasada(d) || statusEhAtrasado(d.status)).length;

  document.getElementById("resumo-total").textContent = total;
  document.getElementById("resumo-processo").textContent = emProcesso;
  document.getElementById("resumo-finalizadas").textContent = finalizadas;
  document.getElementById("resumo-atrasadas").textContent = atrasadas;
}

// ===================== FILTROS ===================== //

// Preenche o filtro "Diagramador" apenas com os diagramadores do núcleo/setor
// atualmente selecionado (não com todos os diagramadores do sistema)
function popularFiltroDiagramadores() {
  const select = document.getElementById("filtro-diagramador");
  const valorAtual = select.value;
  select.innerHTML = '<option value="">Diagramador (todos)</option>';

  const nomesDoNucleo = configuracoes.diagramadoresPorNucleo[nucleoSelecionado] || [];
  nomesDoNucleo.forEach((nome) => {
    const option = document.createElement("option");
    option.value = nome;
    option.textContent = nome;
    select.appendChild(option);
  });

  // Mantém o diagramador selecionado, se ele ainda pertencer ao núcleo atual
  if ([...select.options].some((opcao) => opcao.value === valorAtual)) {
    select.value = valorAtual;
  } else {
    select.value = "";
  }
}

function aplicarFiltros(listaDemandas) {
  const diagramador = document.getElementById("filtro-diagramador").value;
  const status = document.getElementById("filtro-status").value;
  const busca = document.getElementById("filtro-busca").value.trim().toLowerCase();

  return listaDemandas.filter((demanda) => {
    if (diagramador && demanda.diagramador !== diagramador) return false;
    if (status && demanda.status !== status) return false;
    if (busca && !(demanda.atividade || "").toLowerCase().includes(busca)) return false;
    return true;
  });
}

// ===================== EVENTOS ===================== //

function configurarEventos() {
  // O botão "+ Nova demanda" foi removido da barra operacional. O modal "Nova demanda"
  // e abrirModalNovaDemanda() continuam no código (não foram removidos), só deixaram
  // de ter um botão na interface que os acione.
  document.getElementById("btn-fechar-modal").addEventListener("click", fecharModal);
  document.getElementById("btn-cancelar").addEventListener("click", fecharModal);

  // Botão "Kanban Visual" (barra operacional): troca para o quadro visual do núcleo selecionado
  document.getElementById("btn-kanban-visual").addEventListener("click", () => irParaTela("kanban"));

  // Botões de acesso às planilhas auxiliares: abrem o link em uma nova aba
  document.getElementById("btn-solicitacao-imagens").addEventListener("click", () => {
    window.open(LINK_SOLICITACAO_IMAGENS, "_blank");
  });
  document.getElementById("btn-solicitacao-qrs").addEventListener("click", () => {
    window.open(LINK_SOLICITACAO_QRS, "_blank");
  });
  document.getElementById("btn-solicitacao-ilustracao").addEventListener("click", () => {
    window.open(LINK_SOLICITACAO_ILUSTRACAO, "_blank");
  });

  // Botões internos do "Resumo dos núcleos": alternam entre a visão da equipe e o
  // Kanban Visual Geral (todos os núcleos), sem afetar o botão "Kanban Visual" acima
  document.getElementById("btn-visao-equipe").addEventListener("click", () => irParaVisualizacaoResumo("equipe"));
  document.getElementById("btn-kanban-visual-geral").addEventListener("click", () => irParaVisualizacaoResumo("kanban-geral"));
  document.getElementById("btn-equipe-diagramacao").addEventListener("click", () => irParaVisualizacaoResumo("equipe-diagramacao"));
  document.getElementById("btn-voltar-resumo-equipe").addEventListener("click", () => irParaVisualizacaoResumo("equipe"));

  // Filtro de núcleo dentro do Kanban Visual Geral
  document.getElementById("select-filtro-nucleo-kanban-geral").addEventListener("change", function () {
    filtroNucleoKanbanGeral = this.value;
    renderizarKanbanVisualGeral();
  });

  // Botão "Voltar para tabela" (dentro do Kanban Visual): volta para a tabela operacional
  document.getElementById("btn-voltar-tabela").addEventListener("click", () => irParaTela("tabela"));

  // Envio do formulário de nova demanda / edição
  document.getElementById("form-demanda").addEventListener("submit", aoSubmeterFormulario);

  // O campo Núcleo do formulário define quais diagramadores aparecem no campo Diagramador
  document.getElementById("campo-nucleo").addEventListener("change", (evento) => {
    popularSelectDiagramadorDoFormulario(evento.target.value);
  });

  // Filtros: qualquer alteração re-renderiza a tabela
  document.getElementById("filtro-diagramador").addEventListener("change", renderizarTabela);
  document.getElementById("filtro-status").addEventListener("change", renderizarTabela);
  document.getElementById("filtro-busca").addEventListener("input", renderizarTabela);
}

// ===================== NAVEGAÇÃO DO CABEÇALHO (TELAS E NÚCLEOS) ===================== //

// Senha que protege o acesso ao Resumo dos núcleos.
const SENHA_RESUMO_NUCLEOS = "sgge@diaragação@1234";

// Exibe o modal de senha e resolve a Promise com true (acesso liberado) ou false (cancelado).
function solicitarSenhaResumoNucleos() {
  return new Promise(function (resolver) {
    const overlay = document.getElementById("modal-senha-resumo");
    const input   = document.getElementById("input-senha-resumo");
    const erro    = document.getElementById("modal-senha-erro");
    const btnEntrar   = document.getElementById("btn-senha-entrar");
    const btnCancelar = document.getElementById("btn-senha-cancelar");

    // Limpa estado anterior
    input.value = "";
    erro.classList.add("oculto");
    overlay.classList.remove("oculto");
    setTimeout(function () { input.focus(); }, 60);

    function fechar(resultado) {
      overlay.classList.add("oculto");
      btnEntrar.removeEventListener("click", onEntrar);
      btnCancelar.removeEventListener("click", onCancelar);
      input.removeEventListener("keydown", onKeydown);
      resolver(resultado);
    }

    function onEntrar() {
      if (validarSenhaResumoNucleos(input.value)) {
        fechar(true);
      } else {
        erro.classList.remove("oculto");
        input.value = "";
        input.focus();
      }
    }

    function onCancelar() { fechar(false); }

    function onKeydown(e) {
      if (e.key === "Enter")  onEntrar();
      if (e.key === "Escape") onCancelar();
    }

    btnEntrar.addEventListener("click", onEntrar);
    btnCancelar.addEventListener("click", onCancelar);
    input.addEventListener("keydown", onKeydown);
  });
}

// Compara a senha digitada com a constante (case-sensitive, incluindo acentos).
function validarSenhaResumoNucleos(digitada) {
  return digitada === SENHA_RESUMO_NUCLEOS;
}

// Configura os botões do cabeçalho: o botão "Resumo dos núcleos" troca para a tela de
// gestão geral; cada botão de núcleo seleciona o núcleo e troca para a tabela operacional.
function configurarNavegacaoNucleos() {
  document.getElementById("btn-resumo-nucleos").addEventListener("click", async () => {
    const liberado = await solicitarSenhaResumoNucleos();
    if (liberado) irParaTela("resumo");
  });

  document.querySelectorAll(".btn-nucleo[data-nucleo]").forEach((botao) => {
    botao.addEventListener("click", () => {
      nucleoSelecionado = botao.dataset.nucleo;
      irParaTela("tabela");
    });
  });

  atualizarBotaoNucleoAtivo();
}

// Troca a tela atual e re-renderiza tudo (tabela, resumo e Kanban Visual)
function irParaTela(nomeDaTela) {
  telaAtual = nomeDaTela;
  renderizarTela();
}

// Aplica a classe "ativo" no botão de navegação correspondente à tela/núcleo atual:
// - o botão "Resumo dos núcleos" fica ativo quando a tela de resumo está visível;
// - o botão do núcleo selecionado fica ativo nas telas "tabela" e "kanban" (ambas pertencem ao núcleo).
function atualizarBotaoNucleoAtivo() {
  document.getElementById("btn-resumo-nucleos").classList.toggle("ativo", telaAtual === "resumo");

  document.querySelectorAll(".btn-nucleo[data-nucleo]").forEach((botao) => {
    const ativo = telaAtual !== "resumo" && botao.dataset.nucleo === nucleoSelecionado;
    botao.classList.toggle("ativo", ativo);
  });
}

// ===================== FORMULÁRIO: NÚCLEO -> DIAGRAMADOR ===================== //

function configurarSelectNucleoDoFormulario() {
  popularSelectDiagramadorDoFormulario(document.getElementById("campo-nucleo").value);
}

// Preenche o select de diagramadores do modal de acordo com o núcleo escolhido
function popularSelectDiagramadorDoFormulario(nucleo) {
  const select = document.getElementById("campo-diagramador");
  select.innerHTML = "";

  (configuracoes.diagramadoresPorNucleo[nucleo] || []).forEach((nome) => {
    const option = document.createElement("option");
    option.value = nome;
    option.textContent = nome;
    select.appendChild(option);
  });
}

// ===================== MODAL ===================== //

function abrirModal() {
  document.getElementById("modal-overlay").classList.remove("oculto");
}

function fecharModal() {
  document.getElementById("modal-overlay").classList.add("oculto");
  document.getElementById("form-demanda").reset();
  document.getElementById("campo-id-edicao").value = "";
  document.getElementById("campo-slot").value = "";
  popularSelectDiagramadorDoFormulario(document.getElementById("campo-nucleo").value);
}

// Abre o modal para criar uma demanda nova no núcleo/diagramador atualmente selecionados,
// encaixando-a automaticamente no primeiro slot vazio disponível
function abrirModalNovaDemanda() {
  document.getElementById("modal-titulo").textContent = "Nova demanda";
  document.getElementById("form-demanda").reset();
  document.getElementById("campo-id-edicao").value = "";
  document.getElementById("campo-slot").value = "";

  document.getElementById("campo-nucleo").value = nucleoSelecionado;
  popularSelectDiagramadorDoFormulario(nucleoSelecionado);

  abrirModal();
}

// ===================== CRIAÇÃO / EDIÇÃO DE DEMANDA (MODAL "+ NOVA DEMANDA") ===================== //
//
// abrirModalNovoSlot() e abrirModalEdicao() foram removidas: agora a tabela operacional é
// editada diretamente célula a célula (ver salvarCampoDemanda), então clicar numa linha
// não abre mais o modal. O modal continua existindo apenas para o botão "+ Nova demanda".

// Procura o primeiro slot ainda não ocupado para o diagramador no núcleo informado.
// Não há limite máximo de slots: se o bloco já tiver mais demandas que o mínimo
// de LINHAS_POR_DIAGRAMADOR, a busca simplesmente continua até achar um número livre.
function encontrarPrimeiroSlotVazio(nucleo, diagramador, idIgnorado) {
  const ocupados = new Set(
    demandas
      .filter((d) => obterNucleoDaDemanda(d) === nucleo && d.diagramador === diagramador && d.id !== idIgnorado)
      .map((d) => d.slot)
  );

  let slot = 0;
  while (ocupados.has(slot)) {
    slot += 1;
  }
  return slot;
}

async function aoSubmeterFormulario(evento) {
  evento.preventDefault();

  const idEdicao = document.getElementById("campo-id-edicao").value;
  const nucleo = document.getElementById("campo-nucleo").value;
  const diagramador = document.getElementById("campo-diagramador").value;
  const slotInformado = document.getElementById("campo-slot").value;

  let slot = slotInformado !== "" ? Number(slotInformado) : null;
  if (slot === null) {
    // Sem limite máximo: encontra o próximo slot livre, mesmo que o bloco já
    // tenha mais demandas do que o mínimo de LINHAS_POR_DIAGRAMADOR
    slot = encontrarPrimeiroSlotVazio(nucleo, diagramador, idEdicao);
  }

  const dadosFormulario = {
    nucleo,
    diagramador,
    slot,
    anoEscolar: document.getElementById("campo-ano-escolar").value.trim(),
    modulo: document.getElementById("campo-modulo").value.trim(),
    frente: document.getElementById("campo-frente").value.trim(),
    atividade: document.getElementById("campo-atividade").value.trim(),
    inicio: document.getElementById("campo-inicio").value,
    previsto: document.getElementById("campo-previsto").value,
    fim: document.getElementById("campo-fim").value,
    status: document.getElementById("campo-status").value,
    prioridade: document.getElementById("campo-prioridade").value,
    pausa: document.getElementById("campo-pausa").checked,
    motivoPausa: document.getElementById("campo-motivo-pausa").value.trim(),
    observacoes: document.getElementById("campo-observacoes").value.trim(),
    linkArquivo: document.getElementById("campo-link-arquivo").value.trim(),
  };

  let demanda;
  let acao;

  if (idEdicao) {
    demanda = demandas.find((d) => d.id === idEdicao);
    Object.assign(demanda, dadosFormulario);
    acao = "atualizar";
  } else {
    demanda = {
      id: gerarId(),
      dataCriacao: new Date().toISOString(),
      ...dadosFormulario,
    };
    demandas.push(demanda);
    acao = "criar";
  }

  // Atualização otimista local: feedback imediato enquanto a planilha confirma o envio
  salvarDemandasNoLocalStorage();
  renderizarTela();
  fecharModal();

  await enviarDemandaParaAppsScript(demanda, acao);

  // A planilha é a fonte de verdade: depois do envio, busca novamente todas as
  // demandas nela e re-renderiza tabela, cards, resumo dos núcleos e Kanban Visual Geral
  await carregarDemandas();
  renderizarTela();
}

// ===================== EXCLUSÃO DE DEMANDA ===================== //

// Exclui uma demanda (pelo ID) tanto na planilha (via Apps Script) quanto localmente.
// Diferente do envio de criação/edição, esta chamada PRECISA ler a resposta JSON para
// saber se a exclusão realmente aconteceu - por isso não usa mode: "no-cors" aqui.
// Só remove a demanda da tela (e do localStorage) se o Apps Script confirmar sucesso;
// em caso de erro, a demanda permanece intacta e a mensagem real do erro é exibida
// (em vez de um texto genérico), tanto no alerta quanto no console.
async function excluirDemanda(idDemanda) {
  if (!idDemanda) {
    alert("Esta demanda não possui ID e não pode ser excluída.");
    return;
  }

  const confirmou = confirm("Tem certeza que deseja excluir esta demanda?");
  if (!confirmou) {
    return;
  }

  try {
    const resposta = await fetch(WEB_APP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify({
        acao: "excluirDemanda",
        dados: { ID: idDemanda },
      }),
    });

    const resultado = await resposta.json();
    console.log("Resultado exclusão:", resultado);

    if (!resultado.sucesso) {
      // Caso típico de dado antigo no navegador: a demanda já não existe mais na
      // planilha (foi excluída por outra via, ou é resíduo de cache antigo). Remove
      // da visualização local e resincroniza tudo com a planilha, com uma mensagem clara.
      if (resultado.mensagem === "Demanda não encontrada para exclusão.") {
        demandas = demandas.filter((demanda) => demanda.id !== idDemanda);
        salvarDemandasNoLocalStorage();

        await carregarDemandas();
        renderizarTela();

        alert("Essa demanda não existe mais na base e foi removida da visualização.");
        return;
      }

      // Mostra a mensagem real devolvida pelo Apps Script, sem mascará-la
      alert(resultado.mensagem || "Não foi possível excluir a demanda.");
      return;
    }

    // A planilha é a fonte de verdade: depois da exclusão confirmada, busca novamente
    // todas as demandas nela e re-renderiza tudo (cards, tabela, resumo e Kanban Visual Geral)
    await carregarDemandas();
    renderizarTela();

    alert(resultado.mensagem || "Demanda excluída com sucesso.");
  } catch (erro) {
    // Erro de rede, CORS ou resposta que não é JSON válido (ex: a ação ainda não foi
    // publicada no Apps Script) - o detalhe completo fica disponível no console
    console.error("Erro ao excluir demanda:", erro);
    alert("Não foi possível excluir a demanda. Verifique o console para mais detalhes.");
  }
}

// ===================== INTEGRAÇÃO COM GOOGLE APPS SCRIPT ===================== //

// Envia a demanda para o Web App do Apps Script.
// Usa mode: 'no-cors' nesta primeira versão para evitar bloqueio de CORS.
// Como consequência, não é possível ler a resposta do servidor aqui - mas a função é
// async/aguardável, para que quem a chama possa esperar o envio terminar antes de
// buscar novamente as demandas na planilha (carregarDemandas), que é a fonte de verdade.
async function enviarDemandaParaAppsScript(demanda, acao) {
  try {
    await fetch(WEB_APP_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify({
        acao: acao,
        demanda: demanda,
      }),
    });
  } catch (erro) {
    // Em caso de falha de rede, a atualização otimista local permanece até o
    // próximo carregarDemandas() resincronizar com a planilha
    console.warn("Falha ao enviar demanda para o Apps Script:", erro);
  }
}
