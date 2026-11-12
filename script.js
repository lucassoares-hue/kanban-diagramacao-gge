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

// Ambiente do sistema: "producao" (padrão deste repositório) ou "homologacao".
// A HOMOLOGAÇÃO é usada só numa CÓPIA LOCAL do frontend (pasta homologacao/, ignorada
// pelo git): lá se troca AMBIENTE_SISTEMA para "homologacao" e se preenche a URL do Web
// App de homologação. NUNCA há fallback para produção: se o ambiente for homologação e a
// URL estiver vazia, as chamadas falham (e a tela avisa) em vez de cair na produção.
const AMBIENTE_SISTEMA = "producao";
const WEB_APP_URLS = {
  producao: "https://script.google.com/macros/s/AKfycbzIkG3InaDqrmyrzQfuy1hsYi9lQx8DTZmI6QjJI_ilLuZZMwWofc_-sAcwFphbUKtjPw/exec",
  homologacao: "", // preencher apenas na cópia local de homologação (não commitar)
};

function resolverUrlWebApp(ambiente, urls) {
  const url = String((urls && urls[ambiente]) || "").trim();
  if (!url) {
    console.error(`URL do Web App não configurada para o ambiente "${ambiente}". Nenhuma chamada será feita (sem fallback para produção).`);
    // esquema inválido: qualquer fetch falha imediatamente, sem tocar em servidor algum
    return "invalido://web-app-nao-configurado";
  }
  return url;
}

// URL do Web App do Google Apps Script (backend de integração com a planilha)
const WEB_APP_URL = resolverUrlWebApp(AMBIENTE_SISTEMA, WEB_APP_URLS);

// Serviço INDEPENDENTE de férias (projeto Apps Script "KANBAN SGGE - Controle de Ferias",
// planilha KANBAN_SGGE_FERIAS - apps-script/independente-ferias/Codigo.gs).
// Usado SOMENTE pelas ações de férias; as demandas continuam em WEB_APP_URL.
// Sem fallback: se a URL do ambiente estiver vazia, nenhuma chamada de férias é feita e
// nunca se cai no servidor de demandas.
const FERIAS_WEB_APP_URLS = {
  producao: "https://script.google.com/a/macros/sistemaggedeensino.com.br/s/AKfycbywnB1xR60MJCB5NDr4ysLNfYapES0tOgVezRnCBChDF6kcutnpL1ogmbRCSZmJKn4D/exec",
  homologacao: "", // preencher apenas na cópia local de homologação (não commitar)
};
const FERIAS_WEB_APP_URL = resolverUrlWebApp(AMBIENTE_SISTEMA, FERIAS_WEB_APP_URLS);

// Chave usada para salvar as demandas no localStorage
const CHAVE_LOCALSTORAGE = "kanban_diagramacao_gge_demandas";

// Links das planilhas auxiliares abertos pelos botões da barra operacional.
// Para trocar o link de algum dos dois, basta editar o valor aqui.
const LINK_SOLICITACAO_IMAGENS =
  "https://docs.google.com/spreadsheets/d/1bxLIF3UiqSFw3loEufYQ_E-lDQjCUY4_yFGNdzz43uY/edit?gid=640961194#gid=640961194";
const LINK_SOLICITACAO_QRS =
  "https://docs.google.com/spreadsheets/d/1M2ABcoKyFKqyyl2syjI_DaFKiYnsJ9afmWYaEOcxJD4/edit?gid=275196966#gid=275196966";
const LINK_SOLICITACAO_ILUSTRACAO =
  "https://docs.google.com/spreadsheets/d/1LXwP1zowUQ7dvZ0w4CVRrXFZ5ky-R7-tqX_ML_5kr6w/edit?gid=2007281234#gid=2007281234";

// Quantidade MÍNIMA de linhas exibidas por bloco de diagramador, em cada núcleo.
// Se o diagramador tiver menos demandas que isso, o bloco é completado com linhas vazias.
// Se tiver mais, todas as demandas reais são exibidas (o bloco cresce além deste mínimo).
const LINHAS_POR_DIAGRAMADOR = 6;

// Preferência de interface "Linhas por diagramador" (mínimo de linhas de cada bloco),
// escolhida pelo usuário entre 6 e 10 e salva só neste navegador.
// ATENÇÃO: a chave NÃO pode conter "kanban" - limparCacheLocalKanban() apaga na
// inicialização todas as chaves com essa palavra. Também não se mistura com o cache
// de demandas (CHAVE_LOCALSTORAGE).
const CHAVE_PREFERENCIA_LINHAS = "sgge_pref_linhas_por_diagramador";
const OPCOES_LINHAS_POR_DIAGRAMADOR = [6, 7, 8, 9, 10];

// Lê a preferência salva; aceita só inteiros de 6 a 10, senão usa o padrão (6)
function lerPreferenciaLinhasPorDiagramador() {
  try {
    const valor = Number(localStorage.getItem(CHAVE_PREFERENCIA_LINHAS));
    if (Number.isInteger(valor) && OPCOES_LINHAS_POR_DIAGRAMADOR.includes(valor)) {
      return valor;
    }
  } catch (erro) {
    // localStorage indisponível (ex: modo privado restrito): segue com o padrão
  }
  return LINHAS_POR_DIAGRAMADOR;
}

function salvarPreferenciaLinhasPorDiagramador(valor) {
  try {
    localStorage.setItem(CHAVE_PREFERENCIA_LINHAS, String(valor));
  } catch (erro) {
    // Sem persistência disponível: a escolha vale só para esta sessão
  }
}

// Mínimo de linhas atualmente aplicado a cada bloco de diagramador
let linhasMinimasPorDiagramador = lerPreferenciaLinhasPorDiagramador();

// Indica se existe uma linha temporária (preenchida e ainda não salva) neste bloco,
// em uma posição >= slotInicial - usada para nunca esconder dados em edição quando o
// usuário reduz a quantidade de linhas (ex: de 10 para 6)
function existeLinhaTemporariaPreenchidaAPartirDe(nucleo, diagramador, slotInicial) {
  const prefixo = `${nucleo}::${diagramador}::`;
  return Object.keys(linhasTemporariasTabela).some((chave) => {
    if (!chave.startsWith(prefixo)) return false;
    const slot = Number(chave.slice(prefixo.length));
    if (!(slot >= slotInicial)) return false;
    return Object.values(linhasTemporariasTabela[chave]).some((v) => String(v || "").trim());
  });
}

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

// true somente depois que ?acao=buscarDemandas respondeu com sucesso. Usado para não
// exibir "0 diagramadores" quando, na verdade, os dados não foram carregados.
let demandasCarregadasDaPlanilha = false;

// Configurações vindas da planilha (aba LISTAS), via buscarConfiguracoes() no Apps Script.
// Inicia com a configuração de emergência e é substituída pelos dados reais após o carregamento.
let configuracoes = JSON.parse(JSON.stringify(CONFIGURACOES_EMERGENCIA));

// Núcleo atualmente selecionado na navegação do cabeçalho.
// Inicia no Núcleo 1 — tela padrão ao abrir o Kanban.
let nucleoSelecionado = "Núcleo 1";

// Tela atualmente visível: "inicio" (portal Bem-vindo), "resumo" (Resumo dos núcleos),
// "tabela" (tabela operacional) ou "kanban" (Kanban Visual do núcleo selecionado).
// Inicia em "inicio" — o portal é a primeira tela após a splash.
let telaAtual = "inicio";

// De onde a "Equipe de Diagramação" foi aberta: "inicio" (portal, sem senha) ou "resumo".
// Define para onde o botão de retorno da equipe leva - quem veio do portal volta ao portal,
// sem cair no Resumo dos núcleos (que exige senha).
let origemEquipeDiagramacao = "resumo";

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

  // Fora de produção, identifica o ambiente de forma visível (evita testar no lugar errado)
  if (AMBIENTE_SISTEMA !== "producao") {
    document.body.classList.add("ambiente-homologacao");
    const selo = document.createElement("span");
    selo.className = "selo-ambiente";
    selo.textContent = AMBIENTE_SISTEMA === "homologacao" ? "HOMOLOGAÇÃO" : AMBIENTE_SISTEMA.toUpperCase();
    document.querySelector(".topbar")?.appendChild(selo);
    document.title = `[${selo.textContent}] ${document.title}`;
  }

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
    // Férias: consulta somente leitura que também detecta se a integração está operacional
    await carregarFerias();
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
    .replace(/\s+/g, " ")
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
    demandasCarregadasDaPlanilha = true;

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
// true só quando diagramadoresPorNucleo veio da aba LISTAS (não da configuração de emergência)
let configuracoesCarregadasDaPlanilha = false;

async function carregarConfiguracoes() {
  try {
    const resposta = await fetch(WEB_APP_URL + "?acao=buscarConfiguracoes");
    const dados = await resposta.json();

    if (!dados.sucesso) {
      throw new Error("A planilha respondeu com sucesso=false ao buscar configurações");
    }

    const configuracoesDaPlanilha = dados.configuracoes || {};
    const mapaListas = configuracoesDaPlanilha.diagramadoresPorNucleo;
    configuracoesCarregadasDaPlanilha = !!mapaListas && typeof mapaListas === "object" && !Array.isArray(mapaListas);

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
  renderizarCardsNucleosInicio();
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

// ===================== COLUNA ATIVIDADE: SELEÇÃO MÚLTIPLA ===================== //
// Uma demanda (uma linha da BASE_DEMANDAS) pode ter várias atividades. Elas ficam na MESMA
// célula ATIVIDADE, em texto: "Atividade 1 : Atividade 2" (ordem de seleção, sem repetir).
// Separador " : " escolhido porque nenhum nome oficial da LISTAS contém ":" (auditado);
// "/" e "+" aparecem em nomes oficiais e por isso não servem. Registros antigos com uma
// atividade continuam idênticos (uma atividade = o próprio nome, sem separador).
// Indicadores contam LINHAS: várias atividades não viram várias demandas.
const SEPARADOR_ATIVIDADES = " : ";

function separarAtividades(valor) {
  const vistas = new Set();
  return String(valor || "").split(":").map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => {
    const chave = normalizarNome(t);
    if (!chave || vistas.has(chave)) return false;
    vistas.add(chave);
    return true;
  });
}

function juntarAtividades(lista) {
  return separarAtividades((lista || []).join(":")).join(SEPARADOR_ATIVIDADES);
}

// ── Modal "Selecionar atividades" (um só, reaproveitado por todas as células) ──
// A seleção fica numa cópia TEMPORÁRIA: só "Concluir" grava (pelo salvarCampoDemanda já
// existente, e só se o valor mudou). X, Cancelar, Escape e clique fora descartam.
let estadoModalAtividades = null; // { opcoes, selecionadas, valorOriginal, aoConcluir, origem }

function obterFocaveisModalAtividades() {
  const modal = document.getElementById("modal-atividades");
  return [...modal.querySelectorAll("button, input")].filter((el) => !el.disabled && el.offsetParent !== null);
}

function atualizarRodapeModalAtividades() {
  const n = estadoModalAtividades.selecionadas.length;
  document.getElementById("modal-atividades-contador").textContent =
    n === 1 ? "1 atividade selecionada" : `${n} atividades selecionadas`;
}

function montarListaModalAtividades() {
  const estado = estadoModalAtividades;
  const lista = document.getElementById("modal-atividades-lista");
  const filtro = normalizarNome(document.getElementById("modal-atividades-busca").value);
  lista.textContent = "";
  // valor antigo fora da LISTAS continua visível (marcado), mas nenhuma opção nova é criada
  const extras = estado.selecionadas.filter((a) => !estado.opcoes.some((o) => normalizarNome(o) === normalizarNome(a)));
  [...extras, ...estado.opcoes].filter((op) => !filtro || normalizarNome(op).includes(filtro)).forEach((op) => {
    const rotulo = document.createElement("label");
    rotulo.className = "modal-atividades-opcao";
    const caixa = document.createElement("input");
    caixa.type = "checkbox";
    caixa.checked = estado.selecionadas.some((a) => normalizarNome(a) === normalizarNome(op));
    caixa.addEventListener("change", () => {
      if (caixa.checked) estado.selecionadas = separarAtividades([...estado.selecionadas, op].join(":"));
      else estado.selecionadas = estado.selecionadas.filter((a) => normalizarNome(a) !== normalizarNome(op));
      rotulo.classList.toggle("marcada", caixa.checked);
      atualizarRodapeModalAtividades();
    });
    rotulo.classList.toggle("marcada", caixa.checked);
    const marca = document.createElement("span");
    marca.className = "modal-atividades-caixa";
    marca.setAttribute("aria-hidden", "true");
    const nome = document.createElement("span");
    nome.className = "modal-atividades-nome";
    nome.textContent = op;
    rotulo.append(caixa, marca, nome);
    if (extras.includes(op)) {
      const aviso = document.createElement("small");
      aviso.textContent = "fora da lista oficial";
      rotulo.appendChild(aviso);
    }
    lista.appendChild(rotulo);
  });
  if (!lista.childElementCount) {
    const vazio = document.createElement("p");
    vazio.className = "modal-atividades-vazio";
    vazio.textContent = "Nenhuma atividade encontrada.";
    lista.appendChild(vazio);
  }
}

function abrirModalAtividades({ opcoes, valorAtual, aoConcluir, origem }) {
  const modal = document.getElementById("modal-atividades");
  if (!modal || estadoModalAtividades) return; // nunca dois ao mesmo tempo
  estadoModalAtividades = { opcoes: [...opcoes], selecionadas: separarAtividades(valorAtual), valorOriginal: juntarAtividades(separarAtividades(valorAtual)), aoConcluir, origem };
  document.getElementById("modal-atividades-busca").value = "";
  montarListaModalAtividades();
  atualizarRodapeModalAtividades();
  modal.classList.remove("oculto");
  document.getElementById("modal-atividades-lista").scrollTop = 0;
  document.getElementById("modal-atividades-busca").focus();
}

function fecharModalAtividades(confirmar) {
  const estado = estadoModalAtividades;
  if (!estado) return;
  estadoModalAtividades = null;
  document.getElementById("modal-atividades").classList.add("oculto");
  if (confirmar) {
    const novoValor = juntarAtividades(estado.selecionadas);
    if (novoValor !== estado.valorOriginal) estado.aoConcluir(novoValor);
  }
  if (estado.origem && document.body.contains(estado.origem)) estado.origem.focus();
}

function configurarModalAtividades() {
  const modal = document.getElementById("modal-atividades");
  if (!modal) return;
  document.getElementById("modal-atividades-busca").addEventListener("input", montarListaModalAtividades);
  document.getElementById("btn-fechar-atividades").addEventListener("click", () => fecharModalAtividades(false));
  document.getElementById("btn-cancelar-atividades").addEventListener("click", () => fecharModalAtividades(false));
  document.getElementById("btn-concluir-atividades").addEventListener("click", () => fecharModalAtividades(true));
  document.getElementById("btn-limpar-atividades").addEventListener("click", () => {
    estadoModalAtividades.selecionadas = []; // só a seleção temporária; nada é gravado aqui
    montarListaModalAtividades();
    atualizarRodapeModalAtividades();
  });
  modal.addEventListener("click", (e) => { if (e.target === modal) fecharModalAtividades(false); });
  modal.addEventListener("keydown", (e) => {
    if (!estadoModalAtividades) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      fecharModalAtividades(false);
      return;
    }
    if (e.key === "Tab") { // foco preso dentro do modal
      const focaveis = obterFocaveisModalAtividades();
      if (!focaveis.length) return;
      const primeiro = focaveis[0], ultimo = focaveis[focaveis.length - 1];
      if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
    }
  });
}

// Célula ATIVIDADE: botão com o texto (multilinha, define a altura da célula) que abre o
// modal "Selecionar atividades"
function criarCelulaAtividadeTabela(contexto, opcoes) {
  const celula = document.createElement("td");
  celula.className = "col-atividade";

  const valorInicial = obterValorCampoContexto(contexto, "atividade");

  const wrapper = document.createElement("div");
  wrapper.className = "atividade-select-wrap atividade-multi-wrap";

  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "atividade-multi-botao";
  botao.setAttribute("aria-haspopup", "dialog");

  const texto = document.createElement("span");
  texto.className = "atividade-select-texto";
  botao.appendChild(texto);

  let valorExibido = juntarAtividades(separarAtividades(valorInicial));
  const atualizarTexto = () => {
    texto.textContent = valorExibido;
    botao.title = valorExibido;
    botao.setAttribute("aria-label", valorExibido ? `Atividade: ${separarAtividades(valorExibido).join(", ")}. Clique para alterar.` : "Atividade: nenhuma selecionada. Clique para selecionar.");
  };
  atualizarTexto();

  botao.addEventListener("click", () => {
    abrirModalAtividades({
      opcoes,
      valorAtual: valorExibido,
      origem: botao,
      aoConcluir: (novoValor) => {
        valorExibido = novoValor;
        atualizarTexto();
        salvarCampoDemanda(contexto, "atividade", novoValor);
      },
    });
  });

  wrapper.appendChild(botao);
  celula.appendChild(wrapper);
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
  if (campo === "fim") {
    // FIM NÃO usa o salvamento automático: toda alteração passa pela confirmação
    // explícita (interceptarAlteracaoFim). O input é criado aqui para termos a referência
    // e poder restaurar o valor persistido em caso de cancelamento.
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.className = "campo-tabela campo-tabela-data";
    input.value = converterParaDatetimeLocal(valorAtual);
    input.addEventListener("change", () => interceptarAlteracaoFim(contexto, input));
    celula.appendChild(input);
    return celula;
  }
  celula.appendChild(
    criarInputDataTabela(valorAtual, (novoValor) => salvarCampoDemanda(contexto, campo, novoValor))
  );
  return celula;
}

// ===================== CONFIRMAÇÃO OBRIGATÓRIA DA DATA FIM ===================== //
//
// Nenhuma data FIM (nova, alterada ou apagada) é enviada à base sem confirmação explícita:
//  · o "change" do input de FIM só abre o modal - não grava nada;
//  · linhas temporárias (sem ID) não aceitam FIM e não guardam o valor (assim ele também
//    não "pega carona" na criação da demanda);
//  · ao confirmar, é enviada uma CÓPIA da demanda com o novo FIM (sem salvamento
//    otimista); o objeto local só é atualizado depois do { sucesso: true } do backend;
//  · a gravação respeita a fila da linha (contexto.promessaSalvando) e usa os valores mais
//    recentes da demanda no momento da confirmação, sem sobrescrever outras edições.

let confirmacaoFimPendente = null; // { contexto, input, valorAnterior, valorNovo, tipo }
let confirmacaoFimEnviando = false;

const ROTULOS_CAMPOS_CONCLUSAO = {
  diagramador: "Diagramador",
  anoEscolar: "Ano escolar",
  modulo: "Módulo",
  frente: "Frente",
  atividade: "Atividade",
};

function dataHoraValidaParaConclusao(valor) {
  const r = obterDataPlausivelDemanda(valor);
  return r.data;
}

function formatarDataHoraConclusao(valor) {
  const data = dataHoraValidaParaConclusao(valor);
  if (!data) return valor ? "Data inválida" : "–";
  return data.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Lista de pendências que impedem registrar a conclusão (vazia = pode concluir)
function validarDemandaParaConclusao(demanda, valorFim) {
  const pendencias = [];
  if (!demanda || !demanda.id) {
    pendencias.push("A linha ainda não é uma demanda salva na base (sem ID).");
    return pendencias;
  }
  Object.entries(ROTULOS_CAMPOS_CONCLUSAO).forEach(([campo, rotulo]) => {
    if (!String(demanda[campo] || "").trim()) pendencias.push(`${rotulo} não preenchido.`);
  });
  const inicio = dataHoraValidaParaConclusao(demanda.inicio);
  const previsto = dataHoraValidaParaConclusao(demanda.previsto);
  const fim = dataHoraValidaParaConclusao(valorFim);
  if (!inicio) pendencias.push("Data de início ausente ou inválida.");
  if (!previsto) pendencias.push("Data prevista ausente ou inválida.");
  if (!fim) pendencias.push("Data de conclusão inválida.");
  if (inicio && fim && fim < inicio) pendencias.push("A data de conclusão não pode ser anterior à data de início.");
  return pendencias;
}

function interceptarAlteracaoFim(contexto, input) {
  const valorAnterior = converterParaDatetimeLocal(obterValorCampoContexto(contexto, "fim"));
  // data digitada pela metade: o navegador entrega "" com badInput - não é "apagar"
  if (input.validity && input.validity.badInput) {
    input.value = valorAnterior;
    abrirModalConclusao({ tipo: "pendencias", contexto, input, valorAnterior, valorNovo: "",
      pendencias: ["Data de conclusão inválida ou incompleta."] });
    return;
  }
  const valorNovo = input.value;
  if (valorNovo === valorAnterior) return;

  // linha temporária / vazia: não é concluível e o valor não é guardado
  if (!contexto.demanda || !contexto.demanda.id) {
    input.value = valorAnterior;
    abrirModalConclusao({ tipo: "pendencias", contexto, input, valorAnterior, valorNovo,
      pendencias: ["Esta linha ainda não é uma demanda salva. Preencha a atividade e o início primeiro."] });
    return;
  }

  // apagar um FIM já salvo = reabrir a atividade (confirmação específica)
  if (!valorNovo) {
    abrirModalConclusao({ tipo: "reabrir", contexto, input, valorAnterior, valorNovo: "" });
    return;
  }

  const pendencias = validarDemandaParaConclusao(contexto.demanda, valorNovo);
  if (pendencias.length) {
    abrirModalConclusao({ tipo: "pendencias", contexto, input, valorAnterior, valorNovo, pendencias });
    return;
  }
  abrirModalConclusao({ tipo: valorAnterior ? "alterar" : "concluir", contexto, input, valorAnterior, valorNovo });
}

function abrirModalConclusao(pendente) {
  confirmacaoFimPendente = pendente;
  const { tipo, contexto, valorAnterior, valorNovo, pendencias } = pendente;
  const demanda = contexto.demanda || contexto.linhaTemporaria || {};
  const titulo = document.getElementById("modal-conclusao-titulo");
  const subtitulo = document.getElementById("modal-conclusao-subtitulo");
  const lista = document.getElementById("conclusao-detalhes");
  const destaque = document.getElementById("conclusao-destaque");
  const blocoPendencias = document.getElementById("conclusao-pendencias");
  const confirmar = document.getElementById("btn-confirmar-conclusao");
  const erro = document.getElementById("conclusao-erro");

  erro.hidden = true;
  erro.textContent = "";

  if (tipo === "reabrir") {
    titulo.textContent = "Reabrir atividade";
    subtitulo.textContent = "A data de conclusão será removida e a atividade voltará a ficar em aberto.";
    confirmar.textContent = "Confirmar reabertura";
  } else if (tipo === "pendencias") {
    titulo.textContent = "Não é possível concluir a atividade";
    subtitulo.textContent = "Corrija os itens abaixo antes de registrar a conclusão. Nada foi enviado à base de dados.";
  } else {
    titulo.textContent = "Confirmar conclusão da atividade";
    subtitulo.textContent = "Confira as informações antes de registrar a conclusão na base de dados.";
    confirmar.textContent = "Confirmar conclusão";
  }

  // Dados reais da linha (textContent, nunca innerHTML com dados)
  lista.textContent = "";
  const itens = [
    ["Diagramador", demanda.diagramador || contexto.diagramador],
    ["Núcleo", obterNucleoDaDemanda(demanda) || contexto.nucleo],
    ["Ano escolar", demanda.anoEscolar],
    ["Módulo", demanda.modulo],
    ["Frente", demanda.frente],
    ["Atividade", demanda.atividade],
    ["Data de início", formatarDataHoraConclusao(demanda.inicio)],
    ["Prazo previsto", formatarDataHoraConclusao(demanda.previsto)],
  ];
  itens.forEach(([rotulo, valor]) => {
    const dt = document.createElement("dt");
    dt.textContent = rotulo;
    const dd = document.createElement("dd");
    dd.textContent = String(valor || "").trim() || "–";
    lista.append(dt, dd);
  });

  // Destaque: data informada (e a anterior, em edições/reaberturas)
  destaque.textContent = "";
  const linhaDestaque = (rotulo, valor, classe) => {
    const p = document.createElement("p");
    p.className = classe;
    const r = document.createElement("span");
    r.textContent = rotulo;
    const v = document.createElement("strong");
    v.textContent = valor;
    p.append(r, v);
    destaque.appendChild(p);
  };
  if (valorAnterior) linhaDestaque("Data de conclusão atual", formatarDataHoraConclusao(valorAnterior), "conclusao-anterior");
  if (tipo === "reabrir") linhaDestaque("Nova data de conclusão", "(sem data — atividade reaberta)", "conclusao-nova");
  else if (valorNovo) linhaDestaque(valorAnterior ? "Nova data de conclusão" : "Data de conclusão informada", formatarDataHoraConclusao(valorNovo), "conclusao-nova");
  destaque.hidden = !destaque.childElementCount;

  blocoPendencias.textContent = "";
  blocoPendencias.hidden = !(pendencias && pendencias.length);
  (pendencias || []).forEach((texto) => {
    const li = document.createElement("li");
    li.textContent = texto;
    blocoPendencias.appendChild(li);
  });
  confirmar.hidden = tipo === "pendencias";
  confirmar.disabled = false;
  document.getElementById("btn-voltar-conclusao").disabled = false;

  document.getElementById("modal-conclusao").classList.remove("oculto");
  setTimeout(() => (confirmar.hidden ? document.getElementById("btn-voltar-conclusao") : confirmar).focus(), 30);
}

// Voltar e corrigir / X / Escape / clique fora: nada é enviado e o FIM persistido volta ao input
function cancelarConclusao() {
  if (confirmacaoFimEnviando) return; // não interrompe uma gravação em andamento
  const pendente = confirmacaoFimPendente;
  confirmacaoFimPendente = null;
  document.getElementById("modal-conclusao").classList.add("oculto");
  if (pendente && pendente.input) {
    pendente.input.value = pendente.valorAnterior;
    pendente.input.focus();
  }
}

async function confirmarConclusao() {
  const pendente = confirmacaoFimPendente;
  if (!pendente || confirmacaoFimEnviando || pendente.tipo === "pendencias") return;
  const { contexto, valorNovo, tipo } = pendente;
  const demanda = contexto.demanda;
  const botaoConfirmar = document.getElementById("btn-confirmar-conclusao");
  const botaoVoltar = document.getElementById("btn-voltar-conclusao");
  const erro = document.getElementById("conclusao-erro");

  // revalida com os dados mais recentes da demanda (podem ter mudado com o modal aberto)
  if (tipo !== "reabrir") {
    const pendencias = validarDemandaParaConclusao(demanda, valorNovo);
    if (pendencias.length) {
      erro.textContent = pendencias.join(" ");
      erro.hidden = false;
      return;
    }
  }

  confirmacaoFimEnviando = true;
  botaoConfirmar.disabled = true;
  botaoVoltar.disabled = true;
  const textoOriginal = botaoConfirmar.textContent;
  botaoConfirmar.textContent = "Registrando…";
  erro.hidden = true;

  const executar = async () => {
    // aguarda salvamentos anteriores da mesma linha (fila existente)
    if (contexto.promessaSalvando) await contexto.promessaSalvando;
    // cópia com os valores ATUAIS da demanda + o novo FIM (sem alterar o objeto local)
    const copia = { ...demanda, fim: valorNovo };
    copia.status = calcularStatusAutomatico(copia);
    const resultado = await atualizarDemandaNoAppsScript(copia);
    if (!resultado || resultado.sucesso !== true) {
      throw new Error((resultado && resultado.mensagem) || "O servidor não confirmou a gravação.");
    }
    // backend confirmou: só agora o FIM (e o status derivado) passam a valer localmente
    demanda.fim = copia.fim;
    demanda.status = copia.status;
    return true;
  };

  const execucao = executar();
  contexto.promessaSalvando = execucao.catch(() => {}); // próximas edições da linha esperam
  try {
    await execucao;
    confirmacaoFimPendente = null;
    confirmacaoFimEnviando = false;
    document.getElementById("modal-conclusao").classList.add("oculto");
    salvarDemandasNoLocalStorage();
    renderizarTela(); // status e indicadores recalculados pelas rotinas existentes
    mostrarAvisoDiscreto(tipo === "reabrir" ? "Atividade reaberta." : "Conclusão registrada.");
  } catch (falha) {
    console.error("Falha ao registrar a data de conclusão:", falha);
    confirmacaoFimEnviando = false;
    botaoConfirmar.disabled = false;
    botaoVoltar.disabled = false;
    botaoConfirmar.textContent = textoOriginal;
    erro.textContent = `Não foi possível registrar: ${falha.message}. Nada foi alterado na base; você pode tentar novamente.`;
    erro.hidden = false;
  } finally {
    contexto.promessaSalvando = null;
  }
}

// Aviso discreto (sem alert nativo)
function mostrarAvisoDiscreto(texto) {
  let aviso = document.getElementById("aviso-discreto");
  if (!aviso) {
    aviso = document.createElement("div");
    aviso.id = "aviso-discreto";
    aviso.className = "aviso-discreto";
    aviso.setAttribute("role", "status");
    aviso.setAttribute("aria-live", "polite");
    document.body.appendChild(aviso);
  }
  aviso.textContent = texto;
  aviso.classList.add("visivel");
  clearTimeout(mostrarAvisoDiscreto._timer);
  mostrarAvisoDiscreto._timer = setTimeout(() => aviso.classList.remove("visivel"), 3500);
}

function configurarModalConclusao() {
  const modal = document.getElementById("modal-conclusao");
  if (!modal) return;
  document.getElementById("btn-confirmar-conclusao").addEventListener("click", confirmarConclusao);
  document.getElementById("btn-voltar-conclusao").addEventListener("click", cancelarConclusao);
  document.getElementById("btn-fechar-conclusao").addEventListener("click", cancelarConclusao);
  modal.addEventListener("click", (e) => { if (e.target === modal) cancelarConclusao(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("oculto")) cancelarConclusao();
  });
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
    // FIM nunca vai na criação: a conclusão só é registrada pela confirmação explícita
    // (interceptarAlteracaoFim/confirmarConclusao), depois que a demanda já tem ID
    fim: "",
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

    // Linhas vazias necessárias para completar o mínimo escolhido em "Linhas por
    // diagramador" (6 a 10). É um MÍNIMO: se já houver demandas reais suficientes (ou
    // mais), nenhuma linha vazia é adicionada e todas as demandas continuam visíveis.
    const vaziosNecessarios = Math.max(0, linhasMinimasPorDiagramador - demandasDoDiagramador.length);

    // Slots das linhas vazias/temporárias, a partir do primeiro slot livre (mesma
    // sequência de antes). Além do mínimo, continua enquanto houver linha temporária
    // PREENCHIDA mais adiante, para que reduzir a quantidade nunca esconda dados em edição.
    const slotsLinhasVazias = [];
    let slotCandidato = encontrarPrimeiroSlotVazio(nucleoSelecionado, nomeDiagramador, null);
    while (
      slotsLinhasVazias.length < vaziosNecessarios ||
      existeLinhaTemporariaPreenchidaAPartirDe(nucleoSelecionado, nomeDiagramador, slotCandidato)
    ) {
      slotsLinhasVazias.push(slotCandidato);
      slotCandidato += 1;
    }

    // Total de linhas do bloco: usado pelo rowspan da célula do diagramador
    const totalLinhasBloco = demandasDoDiagramador.length + slotsLinhasVazias.length;

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
    slotsLinhasVazias.forEach((slot) => adicionarLinha(null, slot));

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
// ===================== TEMA CLARO/ESCURO (área operacional) ===================== //
// Só visual: troca o atributo data-tema do <html> (o CSS escuro vale apenas com
// body.modo-operacional). Não re-renderiza a tabela, não toca nos campos em edição e não
// grava nada na planilha. localStorage guarda SÓ "claro"/"escuro" (chave sem "kanban",
// para não ser apagada pela limpeza do cache local na inicialização).
const CHAVE_TEMA_OPERACIONAL = "sgge-tema-operacional";

function temaOperacionalAtual() {
  return document.documentElement.getAttribute("data-tema") === "escuro" ? "escuro" : "claro";
}

function aplicarTemaOperacional(tema) {
  if (tema === "escuro") document.documentElement.setAttribute("data-tema", "escuro");
  else document.documentElement.removeAttribute("data-tema");
  const botao = document.getElementById("btn-tema-operacional");
  if (botao) {
    const rotulo = tema === "escuro" ? "Ativar modo claro" : "Ativar modo escuro";
    botao.setAttribute("aria-label", rotulo);
    botao.title = rotulo;
    botao.setAttribute("aria-pressed", String(tema === "escuro"));
  }
}

// Telas que usam o tema (mesma preferência para todas): tabela operacional, Kanban Visual,
// Resumo dos Núcleos e Performance. A Equipe de Diagramação continua no tema claro.
function telaUsaTemaOperacional() {
  if (telaAtual === "tabela" || telaAtual === "kanban") return true;
  return telaAtual === "resumo" && visualizacaoResumoAtiva !== "equipe-diagramacao";
}

function atualizarEscopoTemaOperacional() {
  const ativo = telaUsaTemaOperacional();
  document.body.classList.toggle("modo-operacional", ativo);
  const botao = document.getElementById("btn-tema-operacional");
  if (!botao) return;
  botao.hidden = !ativo;
  aplicarTemaOperacional(temaOperacionalAtual()); // rótulo/ícone sempre sincronizados
}

function configurarTemaOperacional() {
  const botao = document.getElementById("btn-tema-operacional");
  if (!botao) return;
  aplicarTemaOperacional(temaOperacionalAtual()); // sincroniza o botão com o que o <head> aplicou
  botao.addEventListener("click", () => {
    const novo = temaOperacionalAtual() === "escuro" ? "claro" : "escuro";
    aplicarTemaOperacional(novo);
    try { localStorage.setItem(CHAVE_TEMA_OPERACIONAL, novo); } catch (erro) { /* preferência só nesta sessão */ }
  });
}

function renderizarTela() {
  document.getElementById("tela-inicio").classList.toggle("oculto", telaAtual !== "inicio");
  // No portal, os botões de navegação do cabeçalho ficam ocultos (as opções estão nos cards)
  document.body.classList.toggle("modo-inicio", telaAtual === "inicio");
  document.getElementById("tela-resumo-nucleos").classList.toggle("oculto", telaAtual !== "resumo");
  // Botão "Performance" do cabeçalho: existe apenas dentro da área gerencial (Resumo)
  document.getElementById("btn-performance").hidden = telaAtual !== "resumo";
  // Relatórios: mesma regra do botão Performance (só na área gerencial); fecha o menu ao sair
  const wrapRelatorios = document.getElementById("relatorios-menu-wrap");
  if (wrapRelatorios) {
    wrapRelatorios.hidden = telaAtual !== "resumo";
    if (telaAtual !== "resumo") abrirMenuRelatorios(false);
  }
  document.getElementById("tela-operacional").classList.toggle("oculto", telaAtual !== "tabela");
  atualizarEscopoTemaOperacional();
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

// Profissionais da aba LISTAS (configuracoes.diagramadoresPorNucleo), um card por pessoa
// (nomes comparados sem acento/maiúsculas), com o(s) núcleo(s) oficial(is) e a foto de
// configuracoes.fotosDiagramadores. Ordem: núcleos de ORDEM_NUCLEOS_RESUMO, depois os demais.
function obterProfissionaisEquipe() {
  const grupos = configuracoes.diagramadoresPorNucleo || {};
  const fotos = configuracoes.fotosDiagramadores || {};
  const todosNucleos = Object.keys(grupos);
  const extras = todosNucleos.filter((n) => !ORDEM_NUCLEOS_RESUMO.includes(n)).sort((a, b) => a.localeCompare(b, "pt-BR"));
  const ordem = [...ORDEM_NUCLEOS_RESUMO.filter((n) => todosNucleos.includes(n)), ...extras];
  const porNome = new Map();
  ordem.forEach((nucleo) => {
    (grupos[nucleo] || []).forEach((nomeBruto) => {
      const nome = String(nomeBruto || "").replace(/\s+/g, " ").trim();
      const chave = normalizarNome(nome);
      if (!chave) return;
      if (!porNome.has(chave)) porNome.set(chave, { nome, nucleos: [], foto: fotos[nomeBruto] || fotos[nome] || "" });
      const p = porNome.get(chave);
      if (!p.nucleos.some((n) => obterChaveNucleoMapa(n) === obterChaveNucleoMapa(nucleo))) p.nucleos.push(nucleo);
    });
  });
  return [...porNome.values()];
}

// Filtros: "Todos", cada núcleo 2–6 que tenha profissionais e "Produção Especializada"
// (Automatização, Arte-Final, Ilustração). Usa os mesmos mapeamentos do portal inicial.
function obterFiltrosEquipe(profissionais) {
  const pertence = (p, nomesSetor) => p.nucleos.some((n) => nomesSetor.some((x) => obterChaveNucleoMapa(x) === obterChaveNucleoMapa(n)));
  const filtros = [{ id: "todos", rotulo: "Todos", aceita: () => true }];
  AREAS_INICIO_NUCLEOS.forEach((area) => {
    filtros.push({ id: area.rotulo, rotulo: area.rotulo, aceita: (p) => pertence(p, area.nomes) });
  });
  const nomesEspecializada = AREAS_INICIO_ESPECIALIZADA.flatMap((a) => a.nomes);
  filtros.push({ id: "especializada", rotulo: "Produção Especializada", aceita: (p) => pertence(p, nomesEspecializada) });
  return filtros.filter((f) => f.id === "todos" || profissionais.some(f.aceita));
}

let filtroEquipeAtivo = "todos";

function renderizarCarrosselEquipe() {
  const carousel = document.getElementById("equipeCarousel");
  if (!carousel) return;

  const profissionais = obterProfissionaisEquipe();
  const filtros = obterFiltrosEquipe(profissionais);
  if (!filtros.some((f) => f.id === filtroEquipeAtivo)) filtroEquipeAtivo = "todos";
  const filtro = filtros.find((f) => f.id === filtroEquipeAtivo);
  const visiveis = profissionais.filter(filtro.aceita);

  // Barra de filtros (botões com aria-pressed); trocar o filtro volta o carrossel ao início
  const barra = document.getElementById("team-filtros");
  if (barra) {
    barra.textContent = "";
    filtros.forEach((f) => {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "team-filtro";
      botao.textContent = f.rotulo;
      botao.setAttribute("aria-pressed", String(f.id === filtroEquipeAtivo));
      botao.addEventListener("click", () => {
        if (filtroEquipeAtivo === f.id) return;
        filtroEquipeAtivo = f.id;
        renderizarCarrosselEquipe();
        const ativo = document.querySelector(".team-filtro[aria-pressed='true']");
        if (ativo) ativo.focus();
      });
      barra.appendChild(botao);
    });
  }

  const countEl = document.getElementById("team-carousel-count");
  if (countEl) countEl.textContent = visiveis.length + (visiveis.length !== 1 ? " profissionais" : " profissional");

  carousel.textContent = "";
  visiveis.forEach((p) => carousel.appendChild(criarCardEquipeDiagramacao(p.nome, p.nucleos.join(" · "), p.foto)));
  if (!visiveis.length) {
    const vazio = document.createElement("p");
    vazio.className = "equipe-carousel-vazio";
    vazio.textContent = "Nenhum profissional cadastrado nesta categoria.";
    carousel.appendChild(vazio);
  }
  carousel.scrollLeft = 0;
  configurarNavegacaoCarrosselEquipe(carousel);
  atualizarControlesCarrosselEquipe();
}

// Navegação por PÁGINA (a largura visível): como cada card ocupa exatamente 1/N da largura
// (CSS), uma página nunca deixa card cortado. Setas, teclado, toque (rolagem nativa) e pontos.
function configurarNavegacaoCarrosselEquipe(carousel) {
  if (carousel.dataset.navegacaoConfigurada) return;
  carousel.dataset.navegacaoConfigurada = "1";
  const mover = (direcao) => {
    const gap = parseFloat(getComputedStyle(carousel).columnGap) || 0;
    carousel.scrollBy({ left: direcao * (carousel.clientWidth + gap), behavior: preferirMovimentoReduzido() ? "auto" : "smooth" });
  };
  const prev = document.querySelector(".equipe-carousel-prev");
  const next = document.querySelector(".equipe-carousel-next");
  if (prev) prev.addEventListener("click", () => mover(-1));
  if (next) next.addEventListener("click", () => mover(1));
  carousel.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); mover(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); mover(-1); }
  });
  let quadro = 0;
  carousel.addEventListener("scroll", () => {
    cancelAnimationFrame(quadro);
    quadro = requestAnimationFrame(atualizarControlesCarrosselEquipe);
  }, { passive: true });
  window.addEventListener("resize", () => {
    cancelAnimationFrame(quadro);
    quadro = requestAnimationFrame(atualizarControlesCarrosselEquipe);
  });
}

function preferirMovimentoReduzido() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// Setas desabilitadas nas pontas + indicador "Página X de Y" com pontos clicáveis
function atualizarControlesCarrosselEquipe() {
  const carousel = document.getElementById("equipeCarousel");
  if (!carousel) return;
  const gap = parseFloat(getComputedStyle(carousel).columnGap) || 0;
  const passo = carousel.clientWidth + gap;
  const maxScroll = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
  // última página pode ser parcial (ex.: 7 cards com 6 por página = 2 páginas)
  const paginas = passo > 0 && maxScroll > 2 ? Math.ceil((maxScroll - 2) / passo) + 1 : 1;
  const atual = carousel.scrollLeft >= maxScroll - 2 ? paginas : Math.min(paginas, Math.floor(carousel.scrollLeft / passo + 0.5) + 1);
  const prev = document.querySelector(".equipe-carousel-prev");
  const next = document.querySelector(".equipe-carousel-next");
  if (prev) prev.disabled = carousel.scrollLeft <= 2;
  if (next) next.disabled = carousel.scrollLeft >= maxScroll - 2;
  const indicador = document.getElementById("equipe-carousel-indicador");
  if (!indicador) return;
  indicador.textContent = "";
  indicador.hidden = paginas <= 1;
  if (paginas <= 1) return;
  for (let i = 1; i <= paginas; i++) {
    const ponto = document.createElement("button");
    ponto.type = "button";
    ponto.className = "equipe-carousel-ponto";
    ponto.setAttribute("aria-label", `Ir para a página ${i} de ${paginas}`);
    if (i === atual) ponto.setAttribute("aria-current", "true");
    ponto.addEventListener("click", () => carousel.scrollTo({ left: (i - 1) * passo, behavior: preferirMovimentoReduzido() ? "auto" : "smooth" }));
    indicador.appendChild(ponto);
  }
  const texto = document.createElement("span");
  texto.className = "equipe-carousel-pagina";
  texto.textContent = `Página ${atual} de ${paginas}`;
  indicador.appendChild(texto);
}

// Card: foto (ou iniciais) + nome + núcleo, montado só com textContent
function criarCardEquipeDiagramacao(nome, nucleo, fotoUrl) {
  const card = document.createElement("div");
  card.className = "equipe-card";

  const iniciais = obterIniciaisNome(nome);
  const fotoDiv = document.createElement("div");
  fotoDiv.className = "equipe-card-foto";
  const criarFallback = () => {
    const fallback = document.createElement("div");
    fallback.className = "equipe-card-foto-fallback";
    fallback.setAttribute("role", "img");
    fallback.setAttribute("aria-label", `Iniciais de ${nome}`);
    fallback.textContent = iniciais;
    return fallback;
  };
  if (fotoUrl) {
    const img = document.createElement("img");
    img.src = fotoUrl;
    img.alt = `Foto de ${nome}`;
    img.loading = "lazy";
    img.addEventListener("error", () => fotoDiv.replaceChildren(criarFallback()));
    fotoDiv.appendChild(img);
  } else {
    fotoDiv.appendChild(criarFallback());
  }

  const infoDiv = document.createElement("div");
  infoDiv.className = "equipe-card-info";
  const elNome = document.createElement("p");
  elNome.className = "equipe-card-nome";
  elNome.textContent = nome;
  elNome.title = nome;
  const elNucleo = document.createElement("p");
  elNucleo.className = "equipe-card-nucleo";
  elNucleo.textContent = nucleo;
  elNucleo.title = nucleo;
  infoDiv.append(elNome, elNucleo);

  card.append(fotoDiv, infoDiv);
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
    .filter((n) => !ORDEM_NUCLEOS_RESUMO.includes(n))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  // Todos os setores de LISTAS entram (inclusive Automatização/Ilustração), para que
  // livres + com atividade + férias cubram exatamente o Total de Diagramadores
  const ordemFinal = [...ORDEM_NUCLEOS_RESUMO, ...nucleosExtras]
    .filter((n) => todosNucleos.includes(n));

  const gruposLivres = [];
  // Mapa temporário para acumular diagramadores com atividade por núcleo
  const mapaAtividade = {};

  // Férias em curso (início <= hoje <= fim, America/Recife). Se a consulta falhou, ninguém
  // é marcado como de férias e o card/seção mostram "indisponível" (nunca 0).
  const feriasDisponiveis = feriasOperacional();
  const hojeResumo = obterDiaOperacional(new Date());
  const gruposFerias = [];
  const jaListadosFerias = new Set();

  ordemFinal.forEach(function (nucleo) {
    const membros = configuracoes.diagramadoresPorNucleo[nucleo];
    if (!membros || membros.length === 0) return;

    const livresDoGrupo = [];
    const feriasDoGrupo = [];

    membros.forEach(function (nome) {
      const ferias = feriasDisponiveis ? obterFeriasEmCursoDoDiagramador(nome, hojeResumo) : null;
      if (ferias) {
        // De férias: nunca é "livre". Aparece só na seção de férias (uma vez, no primeiro
        // núcleo em que está cadastrado), com as demandas em aberto sinalizadas no item.
        const chave = normalizarNome(nome);
        if (!jaListadosFerias.has(chave)) {
          jaListadosFerias.add(chave);
          const demandasAbertas = demandasCarregadasDaPlanilha
            ? demandas.filter((d) => normalizarNome(d.Diagramador || d.diagramador || "") === chave && !demandaTemFimPreenchido(d))
            : [];
          feriasDoGrupo.push({ nome: nome, nucleo: nucleo, ferias: ferias, demandasAbertas: demandasAbertas });
        }
        return;
      }
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
    if (feriasDoGrupo.length > 0) {
      gruposFerias.push({ nucleo: nucleo, diagramadores: feriasDoGrupo });
    }
  });

  // Férias também valem para os setores ocultos no Resumo (Automatização, Ilustração...):
  // a tabela operacional mostra "Em férias" para qualquer profissional de LISTAS, então o
  // quadro de férias precisa listar os mesmos. Esses setores não entram em livres/atividade.
  if (feriasDisponiveis) {
    const nucleosRestantes = [
      ...ORDEM_NUCLEOS_RESUMO.filter((n) => todosNucleos.includes(n) && !ordemFinal.includes(n)),
      ...todosNucleos.filter((n) => !ORDEM_NUCLEOS_RESUMO.includes(n) && !ordemFinal.includes(n)).sort((a, b) => a.localeCompare(b, "pt-BR")),
    ];
    nucleosRestantes.forEach(function (nucleo) {
      const feriasDoGrupo = [];
      (configuracoes.diagramadoresPorNucleo[nucleo] || []).forEach(function (nome) {
        const chave = normalizarNome(nome);
        if (!chave || jaListadosFerias.has(chave)) return;
        const ferias = obterFeriasEmCursoDoDiagramador(nome, hojeResumo);
        if (!ferias) return;
        jaListadosFerias.add(chave);
        const demandasAbertas = demandasCarregadasDaPlanilha
          ? demandas.filter((d) => normalizarNome(d.Diagramador || d.diagramador || "") === chave && !demandaTemFimPreenchido(d))
          : [];
        feriasDoGrupo.push({ nome: nome, nucleo: nucleo, ferias: ferias, demandasAbertas: demandasAbertas });
      });
      if (feriasDoGrupo.length > 0) gruposFerias.push({ nucleo: nucleo, diagramadores: feriasDoGrupo });
    });
  }

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
  renderizarDiagramadoresFeriasPorGrupo("lista-diagramadores-ferias", gruposFerias, feriasDisponiveis);
  atualizarCardsEquipeResumo(gruposLivres, gruposAtividade, gruposFerias, feriasDisponiveis);
}

// Período de férias em curso do diagramador (ou null). Datas em ms UTC de calendário.
function obterFeriasEmCursoDoDiagramador(nome, hoje) {
  const resumo = calcularResumoFerias(obterPeriodosFeriasDoDiagramador(nome), hoje);
  return resumo && resumo.estado === "em-ferias" ? resumo : null;
}

function renderizarDiagramadoresFeriasPorGrupo(idContainer, grupos, feriasDisponiveis) {
  const container = document.getElementById(idContainer);
  if (!container) return;
  container.textContent = "";

  if (!feriasDisponiveis || grupos.length === 0) {
    const aviso = document.createElement("span");
    aviso.className = "lista-diagramadores-vazio";
    aviso.textContent = feriasDisponiveis
      ? "Nenhum diagramador de férias no momento."
      : "Informação de férias indisponível no momento.";
    container.appendChild(aviso);
    return;
  }

  grupos.forEach(({ nucleo, diagramadores }) => {
    const blocoGrupo = document.createElement("div");
    blocoGrupo.className = "grupo-atividade";
    const titulo = document.createElement("div");
    titulo.className = "grupo-atividade-titulo";
    titulo.textContent = nucleo;
    blocoGrupo.appendChild(titulo);
    const listaCards = document.createElement("div");
    listaCards.className = "grupo-atividade-cards";
    diagramadores.forEach((reg) => listaCards.appendChild(criarItemDiagramadorFerias(reg)));
    blocoGrupo.appendChild(listaCards);
    container.appendChild(blocoGrupo);
  });
}

// Montado só com textContent (sem innerHTML com dados da planilha)
function criarItemDiagramadorFerias({ nome, nucleo, ferias, demandasAbertas }) {
  const item = document.createElement("div");
  item.className = "item-diagramador item-diagramador-ferias";
  item.appendChild(criarAvatarDiagramador(nome, "ferias"));

  const info = document.createElement("div");
  info.className = "item-diagramador-info";

  const cabecalho = document.createElement("div");
  cabecalho.className = "item-diagramador-cabecalho";
  const textos = document.createElement("div");
  const elNome = document.createElement("span");
  elNome.className = "item-diagramador-nome";
  elNome.textContent = nome;
  const elNucleo = document.createElement("span");
  elNucleo.className = "item-diagramador-nucleo";
  elNucleo.textContent = nucleo;
  textos.append(elNome, document.createElement("br"), elNucleo);
  const selo = document.createElement("span");
  selo.className = "selo selo-ferias";
  selo.textContent = "EM FÉRIAS";
  cabecalho.append(textos, selo);
  info.appendChild(cabecalho);

  const datas = document.createElement("dl");
  datas.className = "ferias-resumo-datas";
  [
    ["Início", formatarDiaMes(ferias.inicio, true)],
    ["Fim", formatarDiaMes(ferias.fim, true)],
    ["Dias restantes", ferias.restantes + (ferias.restantes === 1 ? " dia" : " dias")],
    ["Retorno", formatarDiaMes(ferias.retorno, true)],
  ].forEach(([rotulo, valor]) => {
    const dt = document.createElement("dt");
    dt.textContent = rotulo;
    const dd = document.createElement("dd");
    dd.textContent = valor;
    datas.append(dt, dd);
  });
  info.appendChild(datas);

  if (demandasAbertas.length > 0) {
    const elDemandas = document.createElement("div");
    elDemandas.className = "ferias-resumo-demandas";
    elDemandas.textContent = demandasAbertas.length === 1
      ? "Possui 1 demanda em aberto durante as férias:"
      : "Possui " + demandasAbertas.length + " demandas em aberto durante as férias:";
    info.appendChild(elDemandas);
    const lista = document.createElement("div");
    lista.className = "item-diagramador-atividades";
    demandasAbertas.forEach((demanda) => lista.appendChild(criarBlocoAtividade(demanda)));
    info.appendChild(lista);
  }

  item.appendChild(info);
  return item;
}

// Cards "Diagramadores com atividade" / "Diagramadores livres" do Resumo.
// Contam diagramadores DISTINTOS a partir dos MESMOS grupos que alimentam as listas
// acima (regra de diagramadorTemDemandaAtiva), para os números sempre baterem com as
// listas. Um nome repetido em mais de um núcleo/grupo conta uma única vez.
// Se as demandas não vieram da planilha, mostra "–" e um aviso em vez de zero.
function atualizarCardsEquipeResumo(gruposLivres, gruposAtividade, gruposFerias = [], feriasDisponiveis = false) {
  const elAtivos = document.getElementById("resumo-diag-ativos");
  const elLivres = document.getElementById("resumo-diag-livres");
  const elTotal = document.getElementById("resumo-diag-total");
  const aviso = document.getElementById("resumo-equipe-aviso");
  if (!elAtivos || !elLivres) return;

  // Total de Diagramadores: todos os nomes da coluna DIAGRAMADOR da aba LISTAS (todos os
  // setores), contando nomes distintos e ignorando vazios. Demandas não entram aqui.
  // Não depende das demandas, então é exibido mesmo se a busca de demandas falhar.
  const populacao = new Set();
  Object.keys(configuracoes.diagramadoresPorNucleo || {})
    .forEach((nucleo) => {
      (configuracoes.diagramadoresPorNucleo[nucleo] || []).forEach((nome) => {
        const chave = normalizarNome(nome);
        if (chave) populacao.add(chave);
      });
    });
  if (elTotal) elTotal.textContent = populacao.size;

  // LISTAS não foi lida: nada de total "confirmado" vindo da lista local de emergência
  const avisoListas = document.getElementById("resumo-listas-aviso");
  if (avisoListas) avisoListas.classList.toggle("oculto", configuracoesCarregadasDaPlanilha);
  if (!configuracoesCarregadasDaPlanilha) {
    ["resumo-diag-total", "resumo-diag-ativos", "resumo-diag-livres", "resumo-diag-ferias"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "–";
    });
    return;
  }

  // Diagramadores de férias: independe das demandas; falha na consulta = "–" + aviso (nunca 0)
  const elFerias = document.getElementById("resumo-diag-ferias");
  const avisoFerias = document.getElementById("resumo-ferias-aviso");
  const emFerias = new Set(
    gruposFerias.flatMap((grupo) => grupo.diagramadores.map((registro) => normalizarNome(registro.nome))).filter(Boolean)
  );
  if (elFerias) elFerias.textContent = feriasDisponiveis ? emFerias.size : "–";
  if (avisoFerias) avisoFerias.classList.toggle("oculto", feriasDisponiveis);

  if (!demandasCarregadasDaPlanilha) {
    elAtivos.textContent = "–";
    elLivres.textContent = "–";
    if (aviso) aviso.classList.remove("oculto");
    return;
  }
  if (aviso) aviso.classList.add("oculto");

  const nomesDistintos = (grupos) =>
    new Set(
      grupos
        .flatMap((grupo) => grupo.diagramadores.map((registro) => normalizarNome(registro.nome)))
        .filter(Boolean)
    );

  const ativos = nomesDistintos(gruposAtividade);
  const livres = nomesDistintos(gruposLivres);
  elAtivos.textContent = ativos.size;
  elLivres.textContent = livres.size;

  // Conferência (só console): ninguém pode ser livre e estar com atividade ou de férias
  // ao mesmo tempo, e todo cadastrado deve cair em alguma categoria. O Total NÃO é tratado
  // como soma dos cards (um profissional pode estar em mais de um núcleo, e o card de férias
  // inclui setores ocultos no Resumo).
  const conflitos = [...livres].filter((n) => ativos.has(n) || emFerias.has(n));
  const semClassificacao = [...populacao].filter((n) => !ativos.has(n) && !livres.has(n) && !emFerias.has(n));
  if (conflitos.length || semClassificacao.length) {
    console.warn("Resumo: classificação inconsistente de diagramadores.", { conflitos, semClassificacao });
  }
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
  // O card "Finalizadas" saiu da Performance (deu lugar ao Tempo médio); o ?. mantém a
  // função segura caso o elemento não exista
  document.getElementById("resumo-geral-finalizadas")?.replaceChildren(String(finalizadas));
  document.getElementById("resumo-geral-atrasadas").textContent = atrasadas;
}

// ===================== ALTERNÂNCIA DE ABAS DO RESUMO DOS NÚCLEOS ===================== //

// Troca a aba ativa dentro do "Resumo dos núcleos" e atualiza a interface.
// ===================== PERFORMANCE: MÉTRICAS, GRÁFICOS E TABELA ===================== //
//
// Tudo é calculado a partir de `demandas` (já carregadas da planilha), reutilizando as
// mesmas regras de status do restante do sistema:
//   concluída     -> statusEhFinalizado(status)   (mesma regra do antigo card Finalizadas)
//   em andamento  -> statusEhEmProcesso(status)   (mesma regra do card Em processo)
//   pendente      -> não concluída e não em andamento (FILA/A iniciar, Pausado,
//                    Prioridade, Atrasado...)
//   duração       -> Fim - Início (tempo corrido), só concluídas com as duas datas válidas
//   no prazo      -> concluída com Fim <= Previsto; com atraso -> Fim > Previsto
//                    (concluídas sem Previsto válido ficam fora da comparação de prazo)
// Nenhuma requisição nova é feita e nada é gravado na planilha.

const MS_POR_HORA = 3600000;

// ===================== JORNADA DE TRABALHO (TEMPO ÚTIL) ===================== //
//
// Parâmetros centralizados da jornada, usados SÓ no tempo médio de atividade
// (card "Tempo médio de atividade" e coluna "Média das atividades").
//
// - Expediente 07:00-16:30 (570 min brutos), segunda a sexta (hipótese operacional
//   inicial, a confirmar). Feriados e dias excepcionais NÃO são considerados.
// - Almoço (60 min) e intervalo (15 min): os HORÁRIOS ainda não estão definidos
//   (inicio: null). Enquanto isso:
//     · dia em que a atividade cobre o expediente INTEIRO -> desconta os 75 min
//       (exato: as pausas acontecem em algum momento dentro do expediente);
//     · dia PARCIAL -> não desconta nada (não dá para saber se a pausa caiu dentro
//       do trecho) e o resultado é marcado como aproximado (limite superior).
//   Ao preencher "inicio" (ex: "12:00"), o desconto passa a ser exato também nos
//   dias parciais, pela sobreposição real com a pausa.
// - Dia útil líquido = 570 - 60 - 15 = 495 min (8h15). Atenção: 5 x 8h15 = 41h15,
//   e não as 42h semanais declaradas - a diferença NÃO é compensada artificialmente.
const JORNADA_TRABALHO = {
  inicioExpediente: "07:00",
  fimExpediente: "16:30",
  diasUteis: [1, 2, 3, 4, 5], // 0 = domingo ... 6 = sábado
  pausas: [
    { nome: "Almoço", duracaoMin: 60, inicio: null },
    { nome: "Intervalo", duracaoMin: 15, inicio: null },
  ],
  cargaSemanalDeclaradaHoras: 42, // apenas informativo (ver observação acima)
};

function converterHorarioEmMinutos(horario) {
  const [h, m] = String(horario).split(":").map(Number);
  return h * 60 + m;
}

// Minutos líquidos de um dia útil completo (495 com os parâmetros atuais)
function obterMinutosDiaUtil() {
  const bruto =
    converterHorarioEmMinutos(JORNADA_TRABALHO.fimExpediente) -
    converterHorarioEmMinutos(JORNADA_TRABALHO.inicioExpediente);
  const pausas = JORNADA_TRABALHO.pausas.reduce((soma, p) => soma + p.duracaoMin, 0);
  return bruto - pausas;
}

// Tempo útil entre dois instantes, em MINUTOS, somando só o que cai dentro do
// expediente dos dias úteis. Retorna:
//   { valido: false, motivo }                 -> sem data válida ou Fim antes do Início
//   { valido: true, minutos, aproximado }     -> minutos >= 0
function calcularMinutosUteis(inicio, fim) {
  if (!inicio || !fim) return { valido: false, motivo: "sem-datas" };
  if (fim < inicio) return { valido: false, motivo: "fim-antes-do-inicio" };

  const primeiroDia = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate());
  const ultimoDia = new Date(fim.getFullYear(), fim.getMonth(), fim.getDate());

  // Mesmo dia: só o trecho daquele dia
  if (primeiroDia.getTime() === ultimoDia.getTime()) {
    const r = calcularMinutosUteisNoDia(primeiroDia, inicio, fim);
    return { valido: true, minutos: r.minutos, aproximado: r.aproximado };
  }

  // OTIMIZAÇÃO (resultado idêntico ao percurso dia a dia): só o primeiro e o último dia
  // podem ser parciais; todos os dias entre eles são cobertos por inteiro e valem
  // sempre o mesmo tempo útil. Em vez de percorrer cada dia (um Fim digitado com ano
  // errado gerava milhões de iterações), conta os dias úteis intermediários por aritmética.
  const rPrimeiro = calcularMinutosUteisNoDia(primeiroDia, inicio, fim);
  const rUltimo = calcularMinutosUteisNoDia(ultimoDia, inicio, fim);

  const MS_POR_DIA = 86400000;
  const diasIntermediarios =
    Math.round(
      (Date.UTC(ultimoDia.getFullYear(), ultimoDia.getMonth(), ultimoDia.getDate()) -
        Date.UTC(primeiroDia.getFullYear(), primeiroDia.getMonth(), primeiroDia.getDate())) / MS_POR_DIA
    ) - 1;

  let minutosIntermediarios = 0;
  if (diasIntermediarios > 0) {
    const semanasCompletas = Math.floor(diasIntermediarios / 7);
    let diasUteisIntermediarios = semanasCompletas * JORNADA_TRABALHO.diasUteis.length;
    const primeiroDiaSemana = (primeiroDia.getDay() + 1) % 7;
    for (let i = 0; i < diasIntermediarios % 7; i++) {
      if (JORNADA_TRABALHO.diasUteis.includes((primeiroDiaSemana + i) % 7)) diasUteisIntermediarios += 1;
    }

    // Tempo útil de um dia inteiramente coberto (495 min com os parâmetros atuais),
    // calculado pela mesma rotina diária, usando o dia seguinte ao Início como modelo
    const diaModelo = new Date(primeiroDia.getFullYear(), primeiroDia.getMonth(), primeiroDia.getDate() + 1);
    const minutosDiaCompleto = calcularMinutosUteisNoDia(
      diaModelo,
      diaModelo,
      new Date(diaModelo.getFullYear(), diaModelo.getMonth(), diaModelo.getDate() + 1),
      true
    ).minutos;

    minutosIntermediarios = diasUteisIntermediarios * minutosDiaCompleto;
  }

  return {
    valido: true,
    minutos: rPrimeiro.minutos + minutosIntermediarios + rUltimo.minutos,
    aproximado: rPrimeiro.aproximado || rUltimo.aproximado, // dias inteiros nunca são aproximados
  };
}

// Tempo útil de UM dia (horário local) dentro do intervalo [inicio, fim]: recorta o
// expediente e desconta as pausas (regra original, sem alterações).
// ignorarDiaDaSemana = true só para calcular o valor de um dia útil completo modelo.
function calcularMinutosUteisNoDia(dia, inicio, fim, ignorarDiaDaSemana) {
  if (!ignorarDiaDaSemana && !JORNADA_TRABALHO.diasUteis.includes(dia.getDay())) {
    return { minutos: 0, aproximado: false };
  }

  const inicioExp = converterHorarioEmMinutos(JORNADA_TRABALHO.inicioExpediente);
  const fimExp = converterHorarioEmMinutos(JORNADA_TRABALHO.fimExpediente);
  const abertura = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 0, inicioExp);
  const fechamento = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 0, fimExp);
  const trechoIni = inicio > abertura ? inicio : abertura;
  const trechoFim = fim < fechamento ? fim : fechamento;

  if (!(trechoFim > trechoIni)) return { minutos: 0, aproximado: false };

  let minutosDoDia = (trechoFim - trechoIni) / 60000;
  let aproximado = false;
  const diaCompleto = trechoIni <= abertura && trechoFim >= fechamento;

  JORNADA_TRABALHO.pausas.forEach((pausa) => {
    if (pausa.inicio) {
      // Horário conhecido: desconta só a sobreposição real com o trecho
      const pIni = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 0,
        converterHorarioEmMinutos(pausa.inicio));
      const pFim = new Date(pIni.getTime() + pausa.duracaoMin * 60000);
      const sobreposicao = (Math.min(trechoFim, pFim) - Math.max(trechoIni, pIni)) / 60000;
      if (sobreposicao > 0) minutosDoDia -= sobreposicao;
    } else if (diaCompleto) {
      minutosDoDia -= pausa.duracaoMin;
    } else {
      aproximado = true; // dia parcial com horário de pausa desconhecido
    }
  });

  return { minutos: Math.max(0, minutosDoDia), aproximado };
}

// Estado da ordenação da Tabela de Performance
let ordenacaoTabelaPerformance = { coluna: "total", direcao: "desc" };

function obterDataValidaDemanda(valor) {
  if (!valor) return null;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

// Faixa de anos aceita para fins ESTATÍSTICOS (Média das atividades e Atraso médio).
// Datas fora dela (ex: ano 20026 ou 2029 digitados por engano) são desconsideradas
// nessas duas médias e contadas como inconsistência - a planilha não é alterada.
// Obs.: "Total no prazo" / "Total atrasada" continuam usando obterDataValidaDemanda,
// sem esse filtro, para não alterar esses indicadores.
const ANO_MINIMO_PLAUSIVEL = 2020;
function obterAnoMaximoPlausivel() {
  return new Date().getFullYear() + 1;
}

// Retorna { data } quando a data existe, é interpretável e tem ano plausível;
// { data: null, implausivel: true } quando existe mas é inválida/implausível;
// { data: null } quando está vazia.
function obterDataPlausivelDemanda(valor) {
  if (!valor) return { data: null, implausivel: false };
  const data = obterDataValidaDemanda(valor);
  if (!data) return { data: null, implausivel: true };
  const ano = data.getFullYear();
  if (ano < ANO_MINIMO_PLAUSIVEL || ano > obterAnoMaximoPlausivel()) {
    return { data: null, implausivel: true };
  }
  return { data, implausivel: false };
}

// Métricas de uma lista de demandas (usada no geral e por diagramador)
function calcularMetricasPerformance(lista) {
  const m = {
    total: lista.length,
    concluidas: 0,
    emAndamento: 0,
    pendentes: 0,
    noPrazo: 0,
    atrasadas: 0,
    duracoesUteisMin: [],   // tempo útil (minutos) das concluídas com duração válida
    duracoesAproximadas: 0, // quantas delas tiveram dia parcial sem horário de pausa
    duracoesInvalidas: 0,   // concluídas com Fim anterior ao Início (fora da média)
    duracoesSemTempoUtil: 0, // concluídas inteiramente fora do expediente (fora da média)
    duracoesDataImplausivel: 0, // concluídas com Início/Fim inválido ou de ano implausível
    // Atraso de INÍCIO (Início − Previsto, em minutos úteis), só os positivos
    atrasosInicioMin: [],
    atrasosInicioAproximados: 0,
    atrasosDataImplausivel: 0, // Início/Previsto inválido ou de ano implausível
  };

  lista.forEach((demanda) => {
    // ── Atraso médio: Início − Previsto (qualquer status; só Início e Previsto) ──
    const inicioP = obterDataPlausivelDemanda(demanda.inicio);
    const previstoP = obterDataPlausivelDemanda(demanda.previsto);
    if (inicioP.implausivel || previstoP.implausivel) {
      m.atrasosDataImplausivel += 1;
    } else if (inicioP.data && previstoP.data && inicioP.data > previstoP.data) {
      // Atraso em tempo útil entre o Previsto e o Início efetivo. Se o intervalo cair
      // inteiro fora do expediente (ex: previsto sex 17h, início sáb), não há atraso útil.
      const atraso = calcularMinutosUteis(previstoP.data, inicioP.data);
      if (atraso.valido && atraso.minutos > 0) {
        m.atrasosInicioMin.push(atraso.minutos);
        if (atraso.aproximado) m.atrasosInicioAproximados += 1;
      }
    }

    if (statusEhFinalizado(demanda.status)) {
      m.concluidas += 1;

      // ── Média das atividades: Fim − Início (só concluídas; só Início e Fim) ──
      const fimP = obterDataPlausivelDemanda(demanda.fim);
      if (inicioP.implausivel || fimP.implausivel) {
        m.duracoesDataImplausivel += 1;
      } else {
        // Tempo útil (jornada), mesma função para o geral e para cada diagramador
        const duracao = calcularMinutosUteis(inicioP.data, fimP.data);
        if (duracao.valido && duracao.minutos > 0) {
          m.duracoesUteisMin.push(duracao.minutos);
          if (duracao.aproximado) m.duracoesAproximadas += 1;
        } else if (duracao.valido) {
          m.duracoesSemTempoUtil += 1;
        } else if (duracao.motivo === "fim-antes-do-inicio") {
          m.duracoesInvalidas += 1;
        }
      }

      // ── Total no prazo / Total atrasada: inalterados (Fim x Previsto) ──
      const fim = obterDataValidaDemanda(demanda.fim);
      const previsto = obterDataValidaDemanda(demanda.previsto);
      if (fim && previsto) {
        if (fim <= previsto) {
          m.noPrazo += 1;
        } else {
          m.atrasadas += 1;
        }
      }
    } else if (statusEhEmProcesso(demanda.status)) {
      m.emAndamento += 1;
    } else {
      m.pendentes += 1;
    }
  });

  return m;
}

function calcularMedia(valores) {
  if (!valores.length) return null;
  return valores.reduce((soma, v) => soma + v, 0) / valores.length;
}

function calcularPercentual(parte, todo) {
  return todo > 0 ? (parte / todo) * 100 : null;
}

const FORMATO_UMA_CASA = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Menos de 24h em horas ("14,2 h"); a partir disso em dias ("1,8 d"). null -> "–"
// Tempo ÚTIL em minutos: abaixo de 1 dia útil em horas ("3,4 h"); a partir disso em
// dias úteis, onde 1 d útil = duração líquida diária da jornada (8h15), e não 24h.
// "≈" indica que alguma atividade teve dia parcial sem horário de pausa definido.
function formatarDuracaoUtil(minutos, aproximado) {
  if (minutos === null || minutos === undefined) return "–";
  const prefixo = aproximado ? "≈ " : "";
  const minutosDia = obterMinutosDiaUtil();
  return minutos < minutosDia
    ? `${prefixo}${FORMATO_UMA_CASA.format(minutos / 60)} h`
    : `${prefixo}${FORMATO_UMA_CASA.format(minutos / minutosDia)} d úteis`;
}

function descreverEquivalenciaDiaUtil() {
  const min = obterMinutosDiaUtil();
  const h = Math.floor(min / 60);
  const resto = String(min % 60).padStart(2, "0");
  return `Tempo útil: ${JORNADA_TRABALHO.inicioExpediente}–${JORNADA_TRABALHO.fimExpediente}, seg–sex, ` +
    `descontando almoço e intervalo. 1 d útil = ${h}h${resto}.`;
}

// Tempo CORRIDO em horas (usado no "Atraso médio", que não foi alterado)
function formatarDuracaoHoras(horas) {
  if (horas === null || horas === undefined) return "–";
  return horas < 24 ? `${FORMATO_UMA_CASA.format(horas)} h` : `${FORMATO_UMA_CASA.format(horas / 24)} d`;
}

function formatarPercentual(valor) {
  if (valor === null || valor === undefined) return "–";
  return `${FORMATO_UMA_CASA.format(valor)}%`;
}

// ── Cache das métricas da Performance (só em memória) ──────────────────────
// A chave é uma "assinatura" dos campos que afetam as métricas. Qualquer criação,
// edição, exclusão ou recarga da planilha muda a assinatura e invalida o cache
// automaticamente - sem depender de cada ponto de alteração lembrar de avisar.
let cacheMetricasPerformance = { chave: null, geral: null, porDiagramador: null };

function gerarChaveMetricasPerformance() {
  const SEP_CAMPO = "\u0001";
  const SEP_REG = "\u0002";
  return demandas
    // nucleo incluído: o filtro por núcleo do mapa de calor depende dele
    .map((d) => [d.id, d.status, d.inicio, d.fim, d.previsto, d.diagramador, d.nucleo].join(SEP_CAMPO))
    .join(SEP_REG);
}

// ── Diagramadores oficiais da Performance: coluna A (DIAGRAMADOR) da aba LISTAS ──
// buscarConfiguracoes entrega essa coluna agrupada por núcleo (configuracoes.diagramadoresPorNucleo).
// Nomes únicos (sem diferenciar maiúsculas/acentos/espaços), grafia original da LISTAS.
// Retorna null se a LISTAS não foi lida: nesse caso NÃO se usam os nomes das demandas.
function obterDiagramadoresListas() {
  if (!configuracoesCarregadasDaPlanilha) return null;
  const oficiais = new Map();
  Object.values(configuracoes.diagramadoresPorNucleo || {}).forEach((membros) => {
    (membros || []).forEach((nome) => {
      const texto = String(nome || "").replace(/\s+/g, " ").trim();
      const chave = normalizarNome(texto);
      if (chave && !oficiais.has(chave)) oficiais.set(chave, texto);
    });
  });
  return oficiais;
}

// Ranking e tabela: só quem está na LISTAS (métricas das demandas reais de cada um);
// cadastrados sem demandas entram zerados. Profissionais só do histórico ficam de fora.
// A participação (%) continua sobre o total GERAL de atividades (mesma base dos cards).
function obterDesempenhoDiagramadoresListas(porDiagramador, totalGeral) {
  const oficiais = obterDiagramadoresListas();
  if (!oficiais) return null;
  const porChave = new Map(porDiagramador.map((d) => [normalizarNome(d.nome), d]));
  const vazio = calcularMetricasPerformance([]);
  return [...oficiais.entries()].map(([chave, nome]) => {
    const d = porChave.get(chave);
    return d ? { ...d, nome } : {
      nome, total: 0, concluidas: 0, emAndamento: 0, pendentes: 0, noPrazo: 0, atrasadas: 0,
      pctNoPrazo: calcularPercentual(0, 0), pctAtrasado: calcularPercentual(0, 0),
      mediaHoras: calcularMedia(vazio.duracoesUteisMin), mediaAproximada: false,
      atrasoMedioHoras: calcularMedia(vazio.atrasosInicioMin), atrasoAproximado: false,
      pctParticipacao: calcularPercentual(0, totalGeral),
    };
  });
}

const MSG_LISTAS_INDISPONIVEL = "Lista oficial de diagramadores (aba LISTAS) indisponível no momento. Recarregue a página para tentar novamente.";

// Métricas gerais + por diagramador, reaproveitadas pelos cards, gráficos, ranking e
// tabela. Recalcula só quando os dados mudaram.
function obterMetricasPerformance() {
  const chave = gerarChaveMetricasPerformance();
  if (cacheMetricasPerformance.chave !== chave) {
    const geral = calcularMetricasPerformance(demandas);
    cacheMetricasPerformance = {
      chave,
      geral,
      porDiagramador: agruparMetricasPorDiagramador(geral.total),
      // a chave já cobre status, fim e diagramador - os campos que o mapa usa
      mapaCalor: calcularMapaCalorConclusoes(demandas),
    };
  }
  return cacheMetricasPerformance;
}

// Abre/atualiza a Performance sem travar o clique: mostra a seção (título) na hora,
// marca o conteúdo como "calculando" e faz o cálculo no próximo ciclo. Chamadas
// repetidas enquanto há uma renderização pendente são ignoradas (sem concorrência).
let renderizacaoPerformancePendente = false;

function agendarRenderizacaoPerformance() {
  if (renderizacaoPerformancePendente) return;
  renderizacaoPerformancePendente = true;

  const visao = document.getElementById("resumo-visao-performance");
  const status = document.getElementById("perf-status");
  if (visao) {
    visao.classList.add("perf-carregando");
    visao.setAttribute("aria-busy", "true");
  }
  if (status) {
    status.textContent = "Calculando indicadores…";
    status.classList.remove("perf-status-erro");
    status.hidden = false;
  }

  // requestAnimationFrame + setTimeout: garante que o navegador pinte o título e o
  // indicador antes do cálculo começar
  requestAnimationFrame(() => {
    setTimeout(() => {
      let falhou = false;
      try {
        renderizarPerformance();
      } catch (erro) {
        falhou = true;
        console.error("Falha ao calcular a Performance:", erro);
        if (status) {
          status.textContent = "Não foi possível calcular os indicadores. Recarregue a página e tente novamente.";
          status.classList.add("perf-status-erro");
        }
      } finally {
        renderizacaoPerformancePendente = false;
        if (visao) visao.removeAttribute("aria-busy");
        // em caso de erro, o conteúdo antigo continua esmaecido (não é apresentado
        // como resultado definitivo) e a mensagem fica visível
        if (!falhou) {
          if (visao) visao.classList.remove("perf-carregando");
          if (status) status.hidden = true;
        }
      }
    }, 0);
  });
}

// ── Mapa de calor: conclusões por DIA (data de Fim) e diagramador ──
//
// Regras: só demandas Finalizadas, com diagramador e Fim válido de ano plausível
// (obterDataPlausivelDemanda - descarta ano 20026, textos corrompidos etc.). O dia é
// calculado no fuso operacional America/Recife (UTC−3, sem horário de verão), para que
// um Fim gravado em UTC perto da meia-noite não caia no dia anterior/seguinte.
// Uma única passagem sobre as demandas; o resultado fica no cache das métricas.
const FUSO_OPERACIONAL = "America/Recife";
const FORMATADOR_DATA_FUSO = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO_OPERACIONAL, year: "numeric", month: "2-digit", day: "2-digit",
});
const MS_DIA = 86400000;
const NOMES_DIA_SEMANA = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
const ABREV_DIA_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

// Dia de calendário (ms UTC "puro", 00:00) da data, no fuso operacional.
// A chave inclui ano, mês e dia - nunca mistura anos.
function obterDiaOperacional(data) {
  const [ano, mes, dia] = FORMATADOR_DATA_FUSO.format(data).split("-").map(Number);
  return Date.UTC(ano, mes - 1, dia);
}

function formatarDiaMes(msUtc, comAno) {
  const d = new Date(msUtc);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return comAno ? `${dd}/${mm}/${d.getUTCFullYear()}` : `${dd}/${mm}`;
}

// Mapa completo (toda a base), calculado UMA vez por versão dos dados (cache):
//  · dias: Map(dia -> conclusões) - Finalizadas com Fim válido naquele dia (regra anterior)
//  · intervalos: períodos de execução [Início, Fim] de TODAS as demandas do diagramador
//    (qualquer status: vale a data/hora real). Sem Fim -> aberto (fim = null), resolvido
//    com a hora atual só na hora de desenhar. Fim inválido/implausível ou anterior ao
//    Início -> o intervalo não é usado para marcar dias em execução.
// Dia de conclusão de uma demanda no mapa (azul): Finalizada, com diagramador e Fim válido.
// Retorna o dia (ms UTC de calendário, fuso operacional) ou null. Regra única do mapa.
function obterDiaConclusaoMapa(demanda) {
  if (!statusEhFinalizado(demanda.status) || !String(demanda.diagramador || "").trim()) return null;
  const fim = obterDataPlausivelDemanda(demanda.fim);
  return fim.data ? obterDiaOperacional(fim.data) : null;
}

// Período de execução de uma demanda no mapa (verde): Início válido -> Fim (ou aberto).
// { inicio, fim (null = aberto), diaInicio, diaFim } | { descartado: true } | null (sem Início)
function obterIntervaloExecucaoMapa(demanda) {
  const inicio = obterDataPlausivelDemanda(demanda.inicio);
  if (!inicio.data) return inicio.implausivel ? { descartado: true } : null;
  let fimMs = null;
  if (String(demanda.fim || "").trim()) {
    const fim = obterDataPlausivelDemanda(demanda.fim);
    if (!fim.data || fim.data < inicio.data) return { descartado: true }; // Fim inválido ou antes do Início
    fimMs = fim.data.getTime();
  }
  const inicioMs = inicio.data.getTime();
  return {
    inicio: inicioMs,
    fim: fimMs,
    diaInicio: obterDiaOperacional(inicio.data),
    // Fim exatamente às 00:00 não marca o dia seguinte
    diaFim: fimMs === null ? null : obterDiaOperacional(new Date(fimMs > inicioMs ? fimMs - 1 : fimMs)),
  };
}

// O intervalo cobre o dia? (mesma regra de filtrarMapaCalorPorMes: aberto vai até hoje e
// Início no futuro ainda não conta)
function intervaloCobreDiaMapa(intervalo, dia, agoraMs) {
  if (intervalo.fim === null && agoraMs < intervalo.inicio) return false;
  const diaFim = intervalo.fim === null ? obterDiaOperacional(new Date(agoraMs)) : intervalo.diaFim;
  return intervalo.diaInicio <= dia && dia <= diaFim;
}

function calcularMapaCalorConclusoes(listaDemandas) {
  const porDiagramador = new Map(); // chave do nome -> { nome, total, dias, intervalos }
  let desconsideradas = 0;          // conclusões descartadas (regra anterior)
  let intervalosDescartados = 0;    // períodos de execução não utilizáveis

  const obterRegistro = (nome) => {
    const chaveNome = normalizarNome(nome);
    if (!porDiagramador.has(chaveNome)) {
      porDiagramador.set(chaveNome, { nome, total: 0, dias: new Map(), intervalos: [] });
    }
    return porDiagramador.get(chaveNome);
  };

  listaDemandas.forEach((demanda) => {
    const nome = String(demanda.diagramador || "").trim();

    // Conclusões (regra em obterDiaConclusaoMapa)
    if (statusEhFinalizado(demanda.status)) {
      const dia = obterDiaConclusaoMapa(demanda);
      if (dia === null) {
        desconsideradas += 1;
      } else {
        const registro = obterRegistro(nome);
        registro.total += 1;
        registro.dias.set(dia, (registro.dias.get(dia) || 0) + 1);
      }
    }

    // Período de execução (regra em obterIntervaloExecucaoMapa)
    if (!nome) return;
    const intervalo = obterIntervaloExecucaoMapa(demanda);
    if (!intervalo) return;
    if (intervalo.descartado) {
      intervalosDescartados += 1;
      return;
    }
    obterRegistro(nome).intervalos.push(intervalo);
  });

  return { linhas: [...porDiagramador.values()], desconsideradas, intervalosDescartados };
}

// Escala sequencial de um só matiz (azul), do claro ao escuro, proporcional ao máximo.
// Em dois trechos para garantir contraste AA (>= 4,5:1) dos números: a metade clara
// usa texto escuro (pior caso 6,3:1 em #86b4de) e a metade escura usa texto branco
// (pior caso 5,9:1 em #2a68a0). A faixa de azuis "do meio", onde nenhuma das duas
// cores de texto alcança 4,5:1, é pulada. A luminosidade continua sempre decrescente.
const COR_MAPA_MIN = [232, 241, 250];       // #e8f1fa
const COR_MAPA_CLARO_FIM = [134, 180, 222]; // #86b4de
const COR_MAPA_ESCURO_INI = [42, 104, 160]; // #2a68a0
const COR_MAPA_MAX = [11, 61, 107];         // #0b3d6b
function obterCorMapaCalor(valor, maximo) {
  const t = maximo > 0 ? valor / maximo : 0;
  const misturar = (a, b, p) => a.map((c, i) => Math.round(c + (b[i] - c) * p));
  const escuro = t > 0.5;
  const rgb = escuro
    ? misturar(COR_MAPA_ESCURO_INI, COR_MAPA_MAX, (t - 0.5) / 0.5)
    : misturar(COR_MAPA_MIN, COR_MAPA_CLARO_FIM, t / 0.5);
  return { fundo: `rgb(${rgb.join(",")})`, textoClaro: escuro };
}

// ── Filtro mensal do mapa ──
// O ano de referência é o atual (fuso operacional) e fica guardado junto com o mês.
function obterMesAnoAtualOperacional() {
  const [ano, mes] = FORMATADOR_DATA_FUSO.format(new Date()).split("-").map(Number);
  return { ano, mes }; // mes: 1..12
}

let mesMapaCalor = obterMesAnoAtualOperacional();

// Todos os dias do mês (28, 29, 30 ou 31), como ms UTC de calendário
function obterDiasDoMes(ano, mes) {
  const quantidade = new Date(Date.UTC(ano, mes, 0)).getUTCDate(); // dia 0 do mês seguinte
  return Array.from({ length: quantidade }, (_, i) => Date.UTC(ano, mes - 1, i + 1));
}

// Recorta o mapa completo (cache) para os dias do mês:
//  · conclusões por dia e total do mês (ordenação e escala de azul pelo máximo do mês);
//  · "em execução" por dia: cada intervalo marca só os dias do mês que ele cobre
//    (Início < fim do dia e Fim > início do dia). Intervalos abertos terminam em
//    agoraMs - nunca há execução projetada no futuro.
// Custo: proporcional a (intervalos x dias do mês que cada um cobre), sem busca por célula.
function filtrarMapaCalorPorMes(mapaCompleto, ano, mes, agoraMs = Date.now()) {
  const dias = obterDiasDoMes(ano, mes);
  const primeiroDia = dias[0];
  const ultimoDia = dias[dias.length - 1];
  const diaHoje = obterDiaOperacional(new Date(agoraMs));

  const linhas = mapaCompleto.linhas
    .map((linha) => {
      const contagens = new Map();
      let total = 0;
      dias.forEach((d) => {
        const qtd = linha.dias.get(d) || 0;
        if (qtd) contagens.set(d, qtd);
        total += qtd;
      });

      const execucao = new Map();
      (linha.intervalos || []).forEach(({ inicio, fim, diaInicio, diaFim: diaFimFechado }) => {
        if (fim === null && agoraMs < inicio) return; // Início no futuro: ainda não há execução
        // Intervalo aberto termina "agora" (dia operacional de hoje); fechado usa o dia do Fim
        const diaFim = fim === null ? diaHoje : diaFimFechado;
        const de = Math.max(diaInicio, primeiroDia);
        const ate = Math.min(diaFim, ultimoDia);
        for (let d = de; d <= ate; d += MS_DIA) execucao.set(d, (execucao.get(d) || 0) + 1);
      });

      return { nome: linha.nome, total, dias: contagens, execucao };
    })
    .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, "pt-BR"));

  const maximo = linhas.reduce((max, l) => Math.max(max, ...l.dias.values()), 0);
  const totalMes = linhas.reduce((soma, l) => soma + l.total, 0);
  const temExecucao = linhas.some((l) => l.execucao.size > 0);
  return { dias, linhas, maximo, totalMes, temExecucao, hoje: diaHoje };
}

// Situação visual da célula, na prioridade: azul (conclusões) > verde (em execução) >
// cinza (fim de semana ou dia futuro sem registros) > vermelho (sem registros)
// Prioridade: 1) entregas (azul, qualquer dia) -> 2) sábado/domingo sem entregas (cinza,
// sem olhar execução: uma demanda aberta desde sexta não "pinta" o fim de semana de verde)
// -> 3) dias úteis: em execução (verde), futuro (cinza) ou sem registros (vermelho).
// O dia da semana vem da data da COLUNA (calendário no fuso operacional), não de hoje.
// Feriado (nacional/PE) sem entrega entra antes do fim de semana: cinza, sem verde/vermelho.
function classificarDiaMapaCalor(conclusoes, emExecucao, dia, hoje) {
  if (conclusoes > 0) return "concluidas";
  if (obterFeriadoPernambuco(dia)) return "feriado";
  if (ehFimDeSemana(dia)) return "fim-de-semana";
  if (emExecucao > 0) return "execucao";
  if (dia > hoje) return "futuro";
  return "sem-registro";
}

// ── Férias nos mapas de calor (Performance, Relatório Individual e por Coleção) ──
// Fonte: configuracoes.feriasDiagramadores (serviço independente KANBAN_SGGE_FERIAS, já
// carregado por carregarFerias). Datas inclusivas, dias de calendário America/Recife (mesma
// chave dos mapas). Vale para períodos passados, atuais e futuros - não usa a coluna Situacao.
// Férias são só disponibilidade: nunca contam como entrega, execução ou "sem registro".
function criarConsultaFeriasMapa() {
  const disponivel = feriasOperacional();
  const cache = new Map();
  return {
    disponivel,
    // período de férias que contém o dia (ou null); sem dados confirmados -> sempre null
    periodo(nome, dia) {
      if (!disponivel) return null;
      const chave = normalizarNome(nome);
      if (!cache.has(chave)) cache.set(chave, obterPeriodosFeriasDoDiagramador(nome));
      return cache.get(chave).find((p) => p.inicio <= dia && dia <= p.fim) || null;
    },
  };
}

// Situação exibida: entrega real tem prioridade (azul + marca "FÉR"); sem entrega, as férias
// prevalecem sobre execução, feriado, fim de semana, futuro e "sem registro"
function classificarDiaMapaCalorComFerias(conclusoes, emExecucao, dia, hoje, emFerias) {
  if (conclusoes > 0) return "concluidas";
  if (emFerias) return "ferias";
  return classificarDiaMapaCalor(conclusoes, emExecucao, dia, hoje);
}

const ROTULO_SITUACAO_MAPA = {
  "ferias": "Férias",
  "concluidas": "Atividades concluídas",
  "execucao": "Em atividade",
  "sem-registro": "Sem registros de atividade",
  "fim-de-semana": "Fim de semana",
  "feriado": "FERIADO",
  "futuro": "Dia futuro",
};

function ehFimDeSemana(msUtc) {
  const diaSemana = new Date(msUtc).getUTCDay();
  return diaSemana === 0 || diaSemana === 6;
}

// ── Calendário de feriados (nacionais + estadual de Pernambuco) ─────────────
// Configuração centralizada e reutilizável. Uso EXCLUSIVAMENTE visual no mapa de calor.
// Fontes: Lei 662/1949 (nacionais), Lei 6.802/1980 (N. Sra. Aparecida), Lei 14.759/2023
// (Zumbi e Consciência Negra). Data Magna de Pernambuco (06/03): feriado estadual -
// confirmar a lei estadual vigente. NÃO incluídos de propósito: Carnaval, Quarta-feira de
// Cinzas, Corpus Christi, São João, pontos facultativos e feriados municipais (podem ser
// acrescentados aqui quando houver um calendário de trabalho oficial da empresa).
const CALENDARIO_FERIADOS = {
  fixos: [
    { mes: 1, dia: 1, nome: "Confraternização Universal", tipo: "nacional" },
    { mes: 3, dia: 6, nome: "Data Magna de Pernambuco", tipo: "estadual" },
    { mes: 4, dia: 21, nome: "Tiradentes", tipo: "nacional" },
    { mes: 5, dia: 1, nome: "Dia do Trabalho", tipo: "nacional" },
    { mes: 9, dia: 7, nome: "Independência do Brasil", tipo: "nacional" },
    { mes: 10, dia: 12, nome: "Nossa Senhora Aparecida", tipo: "nacional" },
    { mes: 11, dia: 2, nome: "Finados", tipo: "nacional" },
    { mes: 11, dia: 15, nome: "Proclamação da República", tipo: "nacional" },
    { mes: 11, dia: 20, nome: "Dia Nacional de Zumbi e da Consciência Negra", tipo: "nacional" },
    { mes: 12, dia: 25, nome: "Natal", tipo: "nacional" },
  ],
  // Móveis: dias em relação ao Domingo de Páscoa do próprio ano
  moveis: [
    { deslocamentoPascoa: -2, nome: "Sexta-feira da Paixão", tipo: "nacional" },
  ],
};

// Domingo de Páscoa (calendário gregoriano, algoritmo de Meeus/Jones/Butcher),
// devolvido como ms UTC "de calendário" (00:00), no mesmo formato dos dias do mapa
function calcularDomingoDePascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes - 1, dia);
}

// Feriados de um ano, montados uma vez e reaproveitados: Map(dia -> { nome, tipo })
const cacheFeriadosPorAno = new Map();
function obterFeriadosDoAno(ano) {
  if (!cacheFeriadosPorAno.has(ano)) {
    const feriados = new Map();
    CALENDARIO_FERIADOS.fixos.forEach(({ mes, dia, nome, tipo }) => {
      feriados.set(Date.UTC(ano, mes - 1, dia), { nome, tipo });
    });
    const pascoa = calcularDomingoDePascoa(ano);
    CALENDARIO_FERIADOS.moveis.forEach(({ deslocamentoPascoa, nome, tipo }) => {
      feriados.set(pascoa + deslocamentoPascoa * MS_DIA, { nome, tipo });
    });
    cacheFeriadosPorAno.set(ano, feriados);
  }
  return cacheFeriadosPorAno.get(ano);
}

// Consulta centralizada: recebe o dia do mapa (ms UTC de calendário) ou um Date (que é
// convertido para o dia local de America/Recife). Retorna { nome, tipo } ou null.
function obterFeriadoPernambuco(data) {
  const dia = data instanceof Date ? obterDiaOperacional(data) : data;
  const ano = new Date(dia).getUTCFullYear();
  return obterFeriadosDoAno(ano).get(dia) || null;
}

// Classes da COLUNA (aplicadas ao <th> do cabeçalho e a cada <td>), puramente visuais:
//  · perf-mapa-fds + perf-mapa-sab / perf-mapa-dom -> destaque de sábado/domingo
//  · heatmap-dia-atual -> barra vertical do dia de hoje. Só existe quando o mês exibido
//    contém hoje (fuso America/Recife), ou seja, mês e ano atuais.
// A barra é desenhada por pseudo-elemento dentro de cada célula da coluna, então rola
// junto com a tabela e nunca altera a largura das colunas.
function aplicarClassesColunaMapaCalor(elemento, dia, hoje) {
  const diaSemana = new Date(dia).getUTCDay();
  if (diaSemana === 6 || diaSemana === 0) {
    elemento.classList.add("perf-mapa-fds", diaSemana === 6 ? "perf-mapa-sab" : "perf-mapa-dom");
  }
  if (dia === hoje) elemento.classList.add("heatmap-dia-atual");
}

// ── Filtro por núcleo do mapa ──
// Regras: o núcleo de cada DEMANDA vem de obterNucleoDaDemanda() (campo Nucleo da
// planilha, com fallback pelo cadastro do diagramador). Um diagramador com demandas em
// mais de um núcleo aparece em cada núcleo só com as demandas daquele núcleo.
// As opções vêm do cadastro (configuracoes.diagramadoresPorNucleo, aba LISTAS) somado aos
// núcleos que aparecem nas demandas - nenhuma lista fixa.
// Equivalências de nome: a planilha grava "Arte-Final" nas demandas e o cadastro usa
// "Arte-Finalização" - são tratados como o mesmo núcleo.
const NUCLEO_MAPA_TODOS = "";
const NUCLEOS_EQUIVALENTES_MAPA = [["Arte-Finalização", "Arte-Final", "Arte Final"]];
let nucleoMapaCalor = NUCLEO_MAPA_TODOS; // chave normalizada; "" = todos os núcleos

function obterChaveNucleoMapa(nome) {
  const chave = normalizarNome(nome);
  const grupo = NUCLEOS_EQUIVALENTES_MAPA.find((nomes) => nomes.some((n) => normalizarNome(n) === chave));
  return grupo ? normalizarNome(grupo[0]) : chave;
}

// [{ chave, rotulo }] na ordem do cadastro, depois núcleos extras das demandas (A→Z)
function obterOpcoesNucleoMapa() {
  const opcoes = new Map();
  Object.keys(configuracoes.diagramadoresPorNucleo || {}).forEach((nome) => {
    const chave = obterChaveNucleoMapa(nome);
    if (chave && !opcoes.has(chave)) opcoes.set(chave, nome);
  });
  const extras = new Map();
  demandas.forEach((d) => {
    const nome = obterNucleoDaDemanda(d);
    const chave = obterChaveNucleoMapa(nome);
    if (chave && !opcoes.has(chave) && !extras.has(chave)) extras.set(chave, nome);
  });
  [...extras.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "pt-BR"))
    .forEach(([chave, nome]) => opcoes.set(chave, nome));
  return [...opcoes.entries()].map(([chave, rotulo]) => ({ chave, rotulo }));
}

// Equipe ATUAL do núcleo, conforme o cadastro carregado da aba LISTAS
// (configuracoes.diagramadoresPorNucleo). Nomes comparados por normalizarNome (espaços,
// maiúsculas e acentos), sem fundir nomes apenas "parecidos". Map(nomeNormalizado -> nome).
function obterEquipeAtualDoNucleo(chaveNucleo) {
  const equipe = new Map();
  Object.entries(configuracoes.diagramadoresPorNucleo || {}).forEach(([nucleo, membros]) => {
    if (obterChaveNucleoMapa(nucleo) !== chaveNucleo) return;
    (membros || []).forEach((nome) => {
      const n = String(nome || "").trim();
      if (n && !equipe.has(normalizarNome(n))) equipe.set(normalizarNome(n), n);
    });
  });
  return equipe;
}

// Mapa completo do núcleo (todas as datas), em cache por versão dos dados e da equipe.
// "Todos" usa o mapa geral já existente (todos os profissionais elegíveis).
//
// Regra (núcleo específico):
//  · LINHAS = equipe ATUAL do núcleo no cadastro (aba LISTAS). Quem foi transferido
//    não aparece mais no núcleo antigo, mesmo tendo demandas antigas gravadas nele.
//  · CÉLULAS = demandas desses profissionais cujo campo Nucleo é o núcleo selecionado
//    (regra anterior, inalterada). O histórico não é "transferido": as demandas antigas
//    de outro núcleo não passam a contar no núcleo atual da pessoa.
//  · Núcleo que existe nas demandas mas não tem equipe no cadastro: mantém a regra
//    anterior (profissionais das próprias demandas), para não esconder registros.
function obterMapaCalorDoNucleo(cache, chaveNucleo) {
  if (!cache.mapaCalorPorNucleo) cache.mapaCalorPorNucleo = new Map();
  const oficiais = obterDiagramadoresListas() || new Map();

  // "Todos os núcleos": todos os diagramadores da LISTAS (com ou sem atividades),
  // cada um com TODAS as suas demandas; quem está só no histórico não aparece
  if (!chaveNucleo) {
    const chaveTodos = `*|${[...oficiais.keys()].sort().join(",")}`;
    if (!cache.mapaCalorPorNucleo.has(chaveTodos)) {
      const linhas = cache.mapaCalor.linhas.filter((l) => oficiais.has(normalizarNome(l.nome)))
        .map((l) => ({ ...l, nome: oficiais.get(normalizarNome(l.nome)) }));
      const presentes = new Set(linhas.map((l) => normalizarNome(l.nome)));
      oficiais.forEach((nome, chave) => {
        if (!presentes.has(chave)) linhas.push({ nome, total: 0, dias: new Map(), intervalos: [] });
      });
      cache.mapaCalorPorNucleo.set(chaveTodos, { ...cache.mapaCalor, linhas });
    }
    return cache.mapaCalorPorNucleo.get(chaveTodos);
  }

  const equipe = obterEquipeAtualDoNucleo(chaveNucleo);
  // a equipe faz parte da chave: se o cadastro mudar, o recorte é refeito
  const chaveCache = `${chaveNucleo}|${[...equipe.keys()].sort().join(",")}|${[...oficiais.keys()].sort().join(",")}`;

  if (!cache.mapaCalorPorNucleo.has(chaveCache)) {
    const lista = demandas.filter((d) => obterChaveNucleoMapa(obterNucleoDaDemanda(d)) === chaveNucleo);
    const mapa = calcularMapaCalorConclusoes(lista);

    if (equipe.size) {
      mapa.linhas = mapa.linhas.filter((l) => equipe.has(normalizarNome(l.nome)))
        .map((l) => ({ ...l, nome: equipe.get(normalizarNome(l.nome)) }));
      const presentes = new Set(mapa.linhas.map((l) => normalizarNome(l.nome)));
      equipe.forEach((nome, chave) => {
        if (!presentes.has(chave)) mapa.linhas.push({ nome, total: 0, dias: new Map(), intervalos: [] });
      });
    } else {
      // núcleo sem equipe cadastrada: só quem está na LISTAS (em qualquer núcleo)
      mapa.linhas = mapa.linhas.filter((l) => oficiais.has(normalizarNome(l.nome)))
        .map((l) => ({ ...l, nome: oficiais.get(normalizarNome(l.nome)) }));
    }
    cache.mapaCalorPorNucleo.set(chaveCache, mapa);
  }
  return cache.mapaCalorPorNucleo.get(chaveCache);
}

// Preenche o seletor de núcleo preservando a escolha; se o núcleo escolhido deixou de
// existir, volta para "Todos os núcleos"
function popularSeletorNucleoMapa() {
  const seletor = document.getElementById("perf-mapa-nucleo");
  if (!seletor) return;
  const opcoes = obterOpcoesNucleoMapa();
  if (nucleoMapaCalor && !opcoes.some((o) => o.chave === nucleoMapaCalor)) nucleoMapaCalor = NUCLEO_MAPA_TODOS;
  seletor.innerHTML = "";
  const todos = document.createElement("option");
  todos.value = NUCLEO_MAPA_TODOS;
  todos.textContent = "Todos os núcleos";
  seletor.appendChild(todos);
  opcoes.forEach(({ chave, rotulo }) => {
    const option = document.createElement("option");
    option.value = chave;
    option.textContent = rotulo;
    seletor.appendChild(option);
  });
  seletor.value = nucleoMapaCalor;
}

// Só reconstrói o mapa quando os dados, o mês, o núcleo ou o dia atual mudaram
let chaveMapaCalorRenderizado = null;

function renderizarMapaCalorPerformance(cache) {
  const container = document.getElementById("perf-mapa-calor");
  const agoraMs = Date.now();
  const hojeChave = obterDiaOperacional(new Date(agoraMs));
  popularSeletorNucleoMapa(); // pode voltar para "Todos" se o núcleo deixou de existir
  const consultaFerias = criarConsultaFeriasMapa();
  // muda quando as férias carregam/falham ou um período é cadastrado -> o mapa é redesenhado
  const versaoFerias = `${estadoIntegracaoFerias}:${(configuracoes.feriasDiagramadores || []).length}`;
  const versaoListas = configuracoesCarregadasDaPlanilha ? JSON.stringify(configuracoes.diagramadoresPorNucleo || {}) : "indisponivel";
  const chave = `${cache.chave}|${mesMapaCalor.ano}-${mesMapaCalor.mes}|${nucleoMapaCalor}|${hojeChave}|${versaoFerias}|${versaoListas}`;
  if (!container || chaveMapaCalorRenderizado === chave) return;
  chaveMapaCalorRenderizado = chave;

  const seletorMes = document.getElementById("perf-mapa-mes");
  if (seletorMes) seletorMes.value = String(mesMapaCalor.mes);

  const { dias, linhas, maximo, totalMes, temExecucao, hoje } = filtrarMapaCalorPorMes(
    obterMapaCalorDoNucleo(cache, nucleoMapaCalor), mesMapaCalor.ano, mesMapaCalor.mes, agoraMs
  );
  container.innerHTML = "";
  const avisoFerias = document.getElementById("perf-mapa-ferias-aviso");
  if (avisoFerias) avisoFerias.hidden = consultaFerias.disponivel || estadoIntegracaoFerias === "desligada";
  if (!configuracoesCarregadasDaPlanilha) {
    const aviso = document.createElement("p");
    aviso.className = "perf-vazio";
    aviso.textContent = MSG_LISTAS_INDISPONIVEL;
    container.appendChild(aviso);
    return;
  }

  if (!linhas.length || (totalMes === 0 && !temExecucao)) {
    const vazio = document.createElement("p");
    vazio.className = "perf-vazio";
    vazio.textContent = "Não há atividades concluídas para o período selecionado.";
    container.appendChild(vazio);
    return;
  }

  const tabela = document.createElement("table");
  tabela.className = "perf-mapa-tabela";

  const thead = document.createElement("thead");
  const linhaCab = document.createElement("tr");
  const canto = document.createElement("th");
  canto.scope = "col";
  canto.className = "perf-mapa-canto";
  canto.textContent = "Diagramador";
  linhaCab.appendChild(canto);
  dias.forEach((d) => {
    const data = new Date(d);
    const th = document.createElement("th");
    th.scope = "col";
    aplicarClassesColunaMapaCalor(th, d, hoje);
    const feriadoCab = obterFeriadoPernambuco(d);
    if (feriadoCab) th.classList.add("perf-mapa-cab-feriado");
    const numero = document.createElement("span");
    numero.className = "perf-mapa-dia-numero";
    numero.textContent = String(data.getUTCDate()).padStart(2, "0");
    const semana = document.createElement("span");
    semana.className = "perf-mapa-dia-semana";
    semana.textContent = ABREV_DIA_SEMANA[data.getUTCDay()];
    th.append(numero, semana);
    th.title = `${formatarDiaMes(d, true)} — ${NOMES_DIA_SEMANA[data.getUTCDay()]}` +
      (feriadoCab ? ` · FERIADO — ${feriadoCab.nome}` : "");
    linhaCab.appendChild(th);
  });
  thead.appendChild(linhaCab);
  tabela.appendChild(thead);

  const tbody = document.createElement("tbody");
  linhas.forEach((linha) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.className = "perf-mapa-nome";
    th.textContent = linha.nome;
    th.title = `${linha.nome}: ${linha.total} concluída(s) no mês`;
    tr.appendChild(th);

    dias.forEach((d) => {
      const qtd = linha.dias.get(d) || 0;
      const emExecucao = linha.execucao.get(d) || 0;
      const ferias = consultaFerias.periodo(linha.nome, d);
      const situacao = classificarDiaMapaCalorComFerias(qtd, emExecucao, d, hoje, !!ferias);

      const td = document.createElement("td");
      aplicarClassesColunaMapaCalor(td, d, hoje);
      const celula = document.createElement("span");
      celula.className = `perf-mapa-celula perf-mapa-${situacao}`;

      if (situacao === "concluidas") {
        const cor = obterCorMapaCalor(qtd, maximo);
        celula.style.backgroundColor = cor.fundo;
        if (cor.textoClaro) celula.classList.add("perf-mapa-celula-escura");
        celula.textContent = qtd;
      }
      // azul e verde recebem foco (tooltip por teclado); vermelho/cinza seguem acessíveis
      // pelo aria-label durante a navegação da tabela, sem centenas de paradas no Tab
      if (situacao === "concluidas" || situacao === "execucao" || situacao === "ferias") celula.tabIndex = 0;
      if (situacao === "concluidas" || situacao === "execucao") {
        // clique / Enter / Espaço abrem a lista das atividades do dia (configurarDetalheMapaCalor)
        celula.classList.add("perf-mapa-celula-interativa");
        celula.setAttribute("role", "button");
        celula.dataset.nome = linha.nome;
        celula.dataset.dia = String(d);
        celula.dataset.qtd = String(situacao === "concluidas" ? qtd : emExecucao);
      }
      if (situacao === "ferias") {
        const textoFerias = document.createElement("span");
        textoFerias.className = "perf-mapa-texto-ferias";
        textoFerias.setAttribute("aria-hidden", "true");
        textoFerias.textContent = "FÉRIAS";
        celula.appendChild(textoFerias);
      } else if (ferias && situacao === "concluidas") {
        const marca = document.createElement("span");
        marca.className = "perf-mapa-marca-ferias";
        marca.setAttribute("aria-hidden", "true");
        marca.textContent = "FÉR";
        celula.appendChild(marca);
      }

      const dataTexto = `${formatarDiaMes(d, true)} — ${NOMES_DIA_SEMANA[new Date(d).getUTCDay()]}`;
      const feriado = obterFeriadoPernambuco(d);
      if (feriado) {
        // Identificação dentro da célula: selo "FER" centralizado quando não há entrega;
        // com entrega, só um marcador discreto no canto (o número continua visível)
        if (qtd > 0) {
          celula.classList.add("perf-mapa-celula-feriado");
        } else {
          const selo = document.createElement("span");
          selo.className = "perf-mapa-selo-fer";
          selo.setAttribute("aria-hidden", "true");
          selo.textContent = "FER";
          celula.appendChild(selo);
        }
        // Tooltip: sem "Em atividade" (execução não colore o dia de feriado)
        const situacaoFeriado = qtd > 0 ? "Entrega em feriado" : "Feriado";
        celula.dataset.dica =
          `Diagramador: ${linha.nome}\nData: ${dataTexto}\nFeriado: ${feriado.nome}\n` +
          `Conclusões: ${qtd}\nSituação: ${situacaoFeriado}`;
        celula.setAttribute(
          "aria-label",
          `${linha.nome}, ${dataTexto}: feriado, ${feriado.nome}. Conclusões: ${qtd}. Situação: ${situacaoFeriado}.`
        );
      } else if (ehFimDeSemana(d)) {
        // Sábado/domingo: sem "Em atividade" nem contagem de execução no tooltip
        const rotuloFds = qtd > 0 ? "Entregas realizadas no fim de semana" : "Fim de semana";
        celula.dataset.dica =
          `Diagramador: ${linha.nome}\nData: ${dataTexto}\nSituação: ${rotuloFds}\nConclusões: ${qtd}`;
        celula.setAttribute("aria-label", `${linha.nome}, ${dataTexto}: ${rotuloFds}. Conclusões: ${qtd}.`);
      } else {
        const rotulo = ROTULO_SITUACAO_MAPA[situacao];
        celula.dataset.dica =
          `Diagramador: ${linha.nome}\nData: ${dataTexto}\nConclusões: ${qtd}\n` +
          `Em execução: ${emExecucao}\nSituação: ${rotulo}`;
        celula.setAttribute(
          "aria-label",
          `${linha.nome}, ${dataTexto}: ${rotulo}. Conclusões: ${qtd}. Em execução: ${emExecucao}.`
        );
      }
      // Férias: período no tooltip; a atividade em andamento continua informada (não é apagada)
      if (ferias) {
        const periodoTexto = `${formatarDiaMes(ferias.inicio, true)} a ${formatarDiaMes(ferias.fim, true)}`;
        celula.dataset.dica = celula.dataset.dica.replace(/Situação: [^\n]*/, situacao === "ferias" ? "Situação: Férias" : "$&") +
          `\nFérias: ${periodoTexto}` + (situacao === "ferias" && emExecucao ? `\nAtividade em andamento: ${emExecucao}` : "");
        celula.setAttribute("aria-label", `${celula.getAttribute("aria-label")} Férias de ${periodoTexto}.` +
          (situacao === "ferias" && emExecucao ? ` Atividade em andamento: ${emExecucao}.` : ""));
      }
      // Dia atual: informação adicional no tooltip (a classificação não muda)
      if (d === hoje) {
        celula.dataset.dica = celula.dataset.dica.replace(/(Data: [^\n]*)/, "$1\nHoje");
        celula.setAttribute("aria-label", `${celula.getAttribute("aria-label")} Hoje.`);
      }
      td.appendChild(celula);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tabela.appendChild(tbody);
  container.appendChild(tabela);
}

// ===================== MAPA DE CALOR: DETALHAMENTO POR CÉLULA ===================== //
// Clique (ou Enter/Espaço) numa célula azul ou verde abre a lista das demandas REAIS daquele
// diagramador e dia, com as MESMAS regras do mapa (obterDiaConclusaoMapa / intervalo). Usa as
// demandas em memória; o índice por diagramador é montado uma vez por recorte e guardado
// no cache da Performance (refeito só quando os dados mudam).
function obterIndiceDetalheMapa(cache, chaveNucleo) {
  if (!cache.indiceDetalheMapa) cache.indiceDetalheMapa = new Map();
  if (!cache.indiceDetalheMapa.has(chaveNucleo)) {
    const indice = new Map(); // nome normalizado -> demandas (mesmo recorte de núcleo do mapa)
    demandas.forEach((d) => {
      if (chaveNucleo && obterChaveNucleoMapa(obterNucleoDaDemanda(d)) !== chaveNucleo) return;
      const chave = normalizarNome(d.diagramador);
      if (!chave) return;
      if (!indice.has(chave)) indice.set(chave, []);
      indice.get(chave).push(d);
    });
    cache.indiceDetalheMapa.set(chaveNucleo, indice);
  }
  return cache.indiceDetalheMapa.get(chaveNucleo);
}

// { concluidas, emProcesso } do diagramador no dia. emProcesso exclui as concluídas no
// próprio dia (já listadas em "concluídas"). Sem deduplicar: cada registro da base conta
// uma vez, exatamente como na célula; IDs repetidos são sinalizados.
function obterAtividadesDetalheMapa(cache, chaveNucleo, nome, dia, agoraMs = Date.now()) {
  const lista = obterIndiceDetalheMapa(cache, chaveNucleo).get(normalizarNome(nome)) || [];
  const porInicio = (a, b) => (obterDataPlausivelDemanda(a.inicio).data?.getTime() || 0) - (obterDataPlausivelDemanda(b.inicio).data?.getTime() || 0);
  const concluidas = lista.filter((d) => obterDiaConclusaoMapa(d) === dia).sort(porInicio);
  const jaListadas = new Set(concluidas);
  const emProcesso = lista.filter((d) => {
    if (jaListadas.has(d)) return false;
    const intervalo = obterIntervaloExecucaoMapa(d);
    return !!intervalo && !intervalo.descartado && intervaloCobreDiaMapa(intervalo, dia, agoraMs);
  }).sort(porInicio);
  // execução total do dia (como na célula) = em processo + concluídas que estavam no intervalo
  const execucaoDia = emProcesso.length + concluidas.filter((d) => {
    const intervalo = obterIntervaloExecucaoMapa(d);
    return !!intervalo && !intervalo.descartado && intervaloCobreDiaMapa(intervalo, dia, agoraMs);
  }).length;
  const ids = [...concluidas, ...emProcesso].map((d) => String(d.id || "").trim()).filter(Boolean);
  const idsRepetidos = ids.length - new Set(ids).size;
  return { concluidas, emProcesso, execucaoDia, idsRepetidos };
}

function textoCampoDetalhe(valor) {
  const t = String(valor === undefined || valor === null ? "" : valor).trim();
  return t || "—";
}

function textoDataDetalhe(valor) {
  if (!String(valor || "").trim()) return "—";
  const t = formatarDataHoraRelatorio(valor);
  return t === "inválida" ? "Data inválida" : t.replace(", ", " ");
}

// Card compacto de uma atividade (só textContent)
function criarCardAtividadeMapa(d, emProcessoNaData) {
  const card = document.createElement("article");
  card.className = "mapa-detalhe-card";
  const titulo = document.createElement("h4");
  titulo.textContent = textoCampoDetalhe(d.atividade);
  card.appendChild(titulo);
  const lista = document.createElement("dl");
  [["Ano", textoCampoDetalhe(d.anoEscolar)], ["Módulo", textoCampoDetalhe(d.modulo)], ["Frente", textoCampoDetalhe(d.frente)],
    ["Núcleo", textoCampoDetalhe(obterNucleoDaDemanda(d))], ["Início", textoDataDetalhe(d.inicio)], ["Previsto", textoDataDetalhe(d.previsto)],
    ["Fim", textoDataDetalhe(d.fim)], ["Situação", textoCampoDetalhe(d.status)]].forEach(([rotulo, valor]) => {
    const dt = document.createElement("dt");
    dt.textContent = rotulo;
    const dd = document.createElement("dd");
    dd.textContent = valor;
    lista.append(dt, dd);
  });
  card.appendChild(lista);
  if (emProcessoNaData) {
    const nota = document.createElement("p");
    nota.className = "mapa-detalhe-nota";
    nota.textContent = "Em execução na data selecionada.";
    card.appendChild(nota);
  }
  return card;
}

// Núcleo(s) ATUAL(is) do diagramador conforme a aba LISTAS (configuracoes.diagramadoresPorNucleo),
// com a grafia oficial do núcleo e sem duplicar. Não usa o histórico das demandas nem o
// filtro da tela. Sem associação (ou LISTAS indisponível): "Não identificado".
function obterNucleosOficiaisDoDiagramador(nome) {
  const chave = normalizarNome(nome);
  const nucleos = [];
  if (chave && configuracoesCarregadasDaPlanilha) {
    Object.entries(configuracoes.diagramadoresPorNucleo || {}).forEach(([nucleo, membros]) => {
      const pertence = (membros || []).some((m) => normalizarNome(m) === chave);
      if (pertence && !nucleos.some((n) => obterChaveNucleoMapa(n) === obterChaveNucleoMapa(nucleo))) nucleos.push(nucleo);
    });
  }
  return nucleos.length ? nucleos.join(", ") : "Não identificado";
}

let origemFocoDetalheMapa = null;

function abrirDetalheMapaCalor(celula) {
  const modal = document.getElementById("modal-mapa-detalhe");
  if (!modal || !modal.classList.contains("oculto")) return; // nunca dois ao mesmo tempo
  const nome = celula.dataset.nome;
  const dia = Number(celula.dataset.dia);
  const azul = celula.classList.contains("perf-mapa-concluidas");
  const qtdCelula = Number(celula.dataset.qtd || 0);
  const { concluidas, emProcesso, idsRepetidos } = obterAtividadesDetalheMapa(obterMetricasPerformance(), nucleoMapaCalor, nome, dia);

  // Núcleo do PROFISSIONAL (aba LISTAS), não o texto do filtro; os cards mantêm o núcleo de cada demanda
  const rotuloNucleo = obterNucleosOficiaisDoDiagramador(nome);
  document.getElementById("modal-mapa-detalhe-titulo").textContent = azul ? "Atividades concluídas" : "Atividades em processo no dia";
  const resumo = document.getElementById("mapa-detalhe-resumo");
  resumo.textContent = "";
  const qtdPrincipal = azul ? concluidas.length : emProcesso.length;
  [["Diagramador", nome], ["Data", `${formatarDiaMes(dia, true)} — ${NOMES_DIA_SEMANA[new Date(dia).getUTCDay()]}`], ["Núcleo", rotuloNucleo],
    [azul ? "Concluídas no dia" : "Em execução no dia", String(qtdPrincipal)]].forEach(([rotulo, valor]) => {
    const item = document.createElement("div");
    const r = document.createElement("span");
    r.textContent = rotulo;
    const v = document.createElement("strong");
    v.textContent = valor;
    item.append(r, v);
    resumo.appendChild(item);
  });

  const corpo = document.getElementById("mapa-detalhe-lista");
  corpo.textContent = "";
  const secao = (titulo, itens, emProcessoNaData) => {
    if (titulo) {
      const h = document.createElement("h3");
      h.className = "mapa-detalhe-secao";
      h.textContent = `${titulo} (${itens.length})`;
      corpo.appendChild(h);
    }
    itens.forEach((d) => corpo.appendChild(criarCardAtividadeMapa(d, emProcessoNaData)));
  };
  if (azul) {
    secao("", concluidas, false);
    if (emProcesso.length) secao("Também em processo nesta data", emProcesso, true);
  } else {
    secao("", emProcesso, true);
  }
  if (!qtdPrincipal) {
    const vazio = document.createElement("p");
    vazio.className = "perf-vazio";
    vazio.textContent = "Nenhuma atividade encontrada para este dia.";
    corpo.prepend(vazio);
  }
  const aviso = document.getElementById("mapa-detalhe-aviso");
  const divergente = azul && qtdCelula && qtdCelula !== concluidas.length;
  aviso.hidden = !idsRepetidos && !divergente;
  aviso.textContent = idsRepetidos ? `Atenção: ${idsRepetidos} registro(s) com ID repetido na base; cada registro aparece como está na planilha.` :
    divergente ? `A célula indica ${qtdCelula} e foram encontradas ${concluidas.length} atividade(s).` : "";

  origemFocoDetalheMapa = celula;
  modal.classList.remove("oculto");
  document.getElementById("modal-mapa-detalhe-conteudo").scrollTop = 0;
  document.getElementById("btn-fechar-mapa-detalhe").focus();
}

function fecharDetalheMapaCalor() {
  const modal = document.getElementById("modal-mapa-detalhe");
  if (!modal || modal.classList.contains("oculto")) return;
  modal.classList.add("oculto");
  if (origemFocoDetalheMapa && document.body.contains(origemFocoDetalheMapa)) origemFocoDetalheMapa.focus();
  origemFocoDetalheMapa = null;
}

function configurarDetalheMapaCalor() {
  const container = document.getElementById("perf-mapa-calor");
  const modal = document.getElementById("modal-mapa-detalhe");
  if (!container || !modal) return;
  const celulaInterativa = (alvo) => {
    const celula = alvo && alvo.closest ? alvo.closest(".perf-mapa-celula") : null;
    return celula && celula.classList.contains("perf-mapa-celula-interativa") ? celula : null;
  };
  container.addEventListener("click", (e) => {
    const celula = celulaInterativa(e.target);
    if (celula) abrirDetalheMapaCalor(celula);
  });
  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const celula = celulaInterativa(e.target);
    if (!celula) return;
    e.preventDefault();
    abrirDetalheMapaCalor(celula);
  });
  document.getElementById("btn-fechar-mapa-detalhe").addEventListener("click", fecharDetalheMapaCalor);
  modal.addEventListener("click", (e) => { if (e.target === modal) fecharDetalheMapaCalor(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharDetalheMapaCalor(); });
}

// Tooltip único do mapa (mouse e teclado), com delegação de eventos: os listeners são
// ligados uma única vez, não a cada renderização
function configurarTooltipMapaCalor() {
  const container = document.getElementById("perf-mapa-calor");
  const dica = document.getElementById("perf-mapa-dica");
  if (!container || !dica) return;

  const mostrar = (alvo) => {
    const celula = alvo && alvo.closest ? alvo.closest(".perf-mapa-celula") : null;
    if (!celula) return;
    dica.textContent = celula.dataset.dica;
    dica.hidden = false;
    const r = celula.getBoundingClientRect();
    const largura = dica.offsetWidth;
    const esquerda = Math.min(Math.max(8, r.left + r.width / 2 - largura / 2), window.innerWidth - largura - 8);
    dica.style.left = `${esquerda}px`;
    dica.style.top = `${Math.max(8, r.top - dica.offsetHeight - 8)}px`;
  };
  const esconder = () => { dica.hidden = true; };

  // Seletor de núcleo: troca só o recorte do mapa (mantém o mês; sem nova consulta e
  // sem redesenhar os demais componentes da Performance)
  const seletorNucleo = document.getElementById("perf-mapa-nucleo");
  if (seletorNucleo) {
    seletorNucleo.addEventListener("change", () => {
      nucleoMapaCalor = seletorNucleo.value;
      esconder();
      renderizarMapaCalorPerformance(obterMetricasPerformance());
    });
  }

  // Seletor de mês: troca só o recorte do mapa (dados já carregados, sem nova consulta)
  const seletorMes = document.getElementById("perf-mapa-mes");
  if (seletorMes) {
    seletorMes.value = String(mesMapaCalor.mes);
    seletorMes.addEventListener("change", () => {
      const mes = Number(seletorMes.value);
      if (!(mes >= 1 && mes <= 12)) return;
      mesMapaCalor = { ano: obterMesAnoAtualOperacional().ano, mes };
      esconder();
      renderizarMapaCalorPerformance(obterMetricasPerformance());
    });
  }

  container.addEventListener("mouseover", (e) => mostrar(e.target));
  container.addEventListener("mouseleave", esconder);
  container.addEventListener("focusin", (e) => mostrar(e.target));
  container.addEventListener("focusout", esconder);
  container.addEventListener("scroll", esconder, { passive: true });
  window.addEventListener("scroll", esconder, { passive: true });
}

function renderizarPerformance() {
  const cacheMetricas = obterMetricasPerformance();
  const { geral, porDiagramador } = cacheMetricas;

  // Card 4 - Tempo médio de atividade
  const elTempo = document.getElementById("resumo-geral-tempo-medio");
  if (elTempo) {
    const media = calcularMedia(geral.duracoesUteisMin);
    elTempo.textContent = formatarDuracaoUtil(media, geral.duracoesAproximadas > 0);
    const detalhes = [];
    if (geral.duracoesAproximadas) detalhes.push(`${geral.duracoesAproximadas} com valor aproximado (horário das pausas não definido)`);
    if (geral.duracoesInvalidas) detalhes.push(`${geral.duracoesInvalidas} ignorada(s) por Fim anterior ao Início`);
    if (geral.duracoesDataImplausivel) detalhes.push(`${geral.duracoesDataImplausivel} ignorada(s) por data inválida ou com ano fora de ${ANO_MINIMO_PLAUSIVEL}–${obterAnoMaximoPlausivel()}`);
    if (geral.duracoesSemTempoUtil) detalhes.push(`${geral.duracoesSemTempoUtil} ignorada(s) por estarem fora do expediente`);
    elTempo.title = media === null
      ? `Sem atividades concluídas com Início e Fim válidos. ${descreverEquivalenciaDiaUtil()}`
      : `Média de ${geral.duracoesUteisMin.length} atividade(s) concluída(s). ${descreverEquivalenciaDiaUtil()}` +
        (detalhes.length ? ` (${detalhes.join("; ")})` : "");
  }

  renderizarGraficoNucleosPerformance();
  renderizarGraficoPrazoPerformance(geral);
  renderizarMapaCalorPerformance(cacheMetricas);

  // Cards e gráficos de núcleo/prazo: TODAS as demandas do período (abrangência geral).
  // Ranking, tabela e mapa: só os diagramadores ativos da aba LISTAS.
  const desempenho = obterDesempenhoDiagramadoresListas(porDiagramador, geral.total);
  renderizarRankingPerformance(desempenho);
  renderizarTabelaPerformance(desempenho);
}

// Barras horizontais genéricas: [{rotulo, valor, dica}] já ordenadas
function renderizarBarrasHorizontais(container, itens, textoVazio) {
  container.innerHTML = "";
  const maximo = Math.max(0, ...itens.map((i) => i.valor));

  if (!itens.length || maximo === 0) {
    const vazio = document.createElement("p");
    vazio.className = "perf-vazio";
    vazio.textContent = textoVazio;
    container.appendChild(vazio);
    return;
  }

  itens.forEach((item) => {
    const linha = document.createElement("div");
    linha.className = "perf-barra-linha";
    linha.title = item.dica;

    const rotulo = document.createElement("span");
    rotulo.className = "perf-barra-rotulo";
    rotulo.textContent = item.rotulo;

    const trilho = document.createElement("div");
    trilho.className = "perf-barra-trilho";
    const barra = document.createElement("div");
    barra.className = "perf-barra";
    barra.style.width = `${(item.valor / maximo) * 100}%`;
    trilho.appendChild(barra);

    const valor = document.createElement("span");
    valor.className = "perf-barra-valor";
    valor.textContent = item.valor;

    linha.append(rotulo, trilho, valor);
    container.appendChild(linha);
  });
}

// Gráfico 1 - volume total de atividades por núcleo (todos os núcleos cadastrados +
// qualquer outro que apareça nas demandas), do maior para o menor
function renderizarGraficoNucleosPerformance() {
  const container = document.getElementById("perf-grafico-nucleos");
  if (!container) return;

  const contagem = {};
  Object.keys(configuracoes.diagramadoresPorNucleo || {}).forEach((n) => (contagem[n] = 0));
  demandas.forEach((demanda) => {
    const nucleo = obterNucleoDaDemanda(demanda) || "Sem núcleo";
    contagem[nucleo] = (contagem[nucleo] || 0) + 1;
  });

  const itens = Object.entries(contagem)
    .map(([nucleo, valor]) => ({ rotulo: nucleo, valor, dica: `${nucleo}: ${valor} atividade(s)` }))
    .sort((a, b) => b.valor - a.valor || a.rotulo.localeCompare(b.rotulo, "pt-BR"));

  renderizarBarrasHorizontais(container, itens, "Nenhuma atividade cadastrada.");
}

// Gráfico 2 - pizza 2.5D "No prazo x Com atraso" (concluídas com Previsto válido)
//
// Integridade estatística: o topo é uma ELIPSE obtida achatando o círculo no eixo
// vertical (transformação afim), o que preserva a proporção entre as áreas das fatias.
// A inclinação é leve e a profundidade pequena para que a lateral visível não "engorde"
// as fatias da frente; os valores exatos ficam sempre escritos na legenda e no painel.
// Dados: geral.noPrazo / geral.atrasadas (calcularMetricasPerformance) - inalterados.

// Fatia selecionada (sobrevive às re-renderizações enquanto existir no conjunto atual)
let fatiaPrazoSelecionada = null; // "prazo" | "atraso" | null

const PIZZA_3D = { cx: 120, cy: 70, rx: 104, ry: 58, profundidade: 16, deslocamento: 11 };

function pontoElipsePizza(angulo, dy = 0) {
  return [
    PIZZA_3D.cx + PIZZA_3D.rx * Math.cos(angulo),
    PIZZA_3D.cy + PIZZA_3D.ry * Math.sin(angulo) + dy,
  ];
}

// Topo da fatia (setor elíptico) de a0 a a1 (radianos, sentido horário na tela)
function caminhoTopoFatia(a0, a1) {
  if (a1 - a0 >= 2 * Math.PI - 1e-9) {
    const { cx, cy, rx, ry } = PIZZA_3D;
    return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`;
  }
  const [x0, y0] = pontoElipsePizza(a0);
  const [x1, y1] = pontoElipsePizza(a1);
  const grande = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${PIZZA_3D.cx} ${PIZZA_3D.cy} L ${x0} ${y0} A ${PIZZA_3D.rx} ${PIZZA_3D.ry} 0 ${grande} 1 ${x1} ${y1} Z`;
}

// Lateral visível (parte da borda voltada para o observador: seno > 0, ou seja, de 0 a π
// em cada volta). Retorna os caminhos da faixa curva entre a borda de cima e a de baixo.
function caminhosLateralFatia(a0, a1) {
  const caminhos = [];
  const h = PIZZA_3D.profundidade;
  // percorre as "meias-voltas da frente" [2kπ, 2kπ+π] que cruzam [a0, a1]
  for (let k = Math.floor(a0 / (2 * Math.PI)) - 1; k <= Math.ceil(a1 / (2 * Math.PI)); k++) {
    const ini = Math.max(a0, 2 * k * Math.PI);
    const fim = Math.min(a1, 2 * k * Math.PI + Math.PI);
    if (fim - ini <= 1e-6) continue;
    const [x0, y0] = pontoElipsePizza(ini);
    const [x1, y1] = pontoElipsePizza(fim);
    const { rx, ry } = PIZZA_3D;
    caminhos.push(
      `M ${x0} ${y0} A ${rx} ${ry} 0 0 1 ${x1} ${y1} L ${x1} ${y1 + h} ` +
      `A ${rx} ${ry} 0 0 0 ${x0} ${y0 + h} Z`
    );
  }
  return caminhos;
}

function renderizarGraficoPrazoPerformance(geral) {
  const container = document.getElementById("perf-grafico-prazo");
  if (!container) return;
  container.innerHTML = "";

  const total = geral.noPrazo + geral.atrasadas;
  if (total === 0) {
    fatiaPrazoSelecionada = null;
    const vazio = document.createElement("p");
    vazio.className = "perf-vazio";
    vazio.textContent = "Ainda não há atividades concluídas com prazo previsto para comparar.";
    container.appendChild(vazio);
    return;
  }

  const fatias = [
    { id: "prazo", rotulo: "No prazo", valor: geral.noPrazo, classe: "perf-fatia-prazo" },
    { id: "atraso", rotulo: "Com atraso", valor: geral.atrasadas, classe: "perf-fatia-atraso" },
  ];
  const visiveis = fatias.filter((f) => f.valor > 0);
  if (!visiveis.some((f) => f.id === fatiaPrazoSelecionada)) fatiaPrazoSelecionada = null;

  const formatarQtd = (n) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "atividade" : "atividades"}`;
  const pct = (f) => formatarPercentual(calcularPercentual(f.valor, total));

  const NS = "http://www.w3.org/2000/svg";
  const criar = (tag, attrs = {}) => {
    const el = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };

  // ── SVG ──
  const svg = criar("svg", {
    viewBox: "0 0 240 160",
    class: "perf-pizza-svg perf-pizza-3d",
    role: "group",
    "aria-label": `No prazo: ${geral.noPrazo} (${pct(fatias[0])}); Com atraso: ${geral.atrasadas} (${pct(fatias[1])})`,
  });

  // sombra discreta sob a pizza
  const defs = criar("defs");
  const filtro = criar("filter", { id: "perf-pizza-sombra", x: "-20%", y: "-20%", width: "140%", height: "160%" });
  filtro.appendChild(criar("feGaussianBlur", { stdDeviation: "5" }));
  defs.appendChild(filtro);
  svg.appendChild(defs);
  svg.appendChild(criar("ellipse", {
    class: "perf-pizza-sombra", cx: PIZZA_3D.cx, cy: PIZZA_3D.cy + PIZZA_3D.profundidade + 8,
    rx: PIZZA_3D.rx * 0.92, ry: PIZZA_3D.ry * 0.55, filter: "url(#perf-pizza-sombra)",
  }));

  // geometria: começa no topo (-90°), sentido horário
  let angulo = -Math.PI / 2;
  const grupos = visiveis.map((fatia) => {
    const a0 = angulo;
    const a1 = angulo + (fatia.valor / total) * 2 * Math.PI;
    angulo = a1;
    const meio = (a0 + a1) / 2;
    // deslocamento para fora do centro, na direção do meio da fatia (projetado na elipse)
    const dx = visiveis.length > 1 ? Math.cos(meio) * PIZZA_3D.deslocamento : 0;
    const dy = visiveis.length > 1 ? Math.sin(meio) * PIZZA_3D.deslocamento * (PIZZA_3D.ry / PIZZA_3D.rx) : 0;

    const g = criar("g", {
      class: `perf-pizza-fatia ${fatia.classe}`,
      "data-fatia": fatia.id,
      tabindex: "0",
      role: "button",
      "aria-pressed": fatia.id === fatiaPrazoSelecionada ? "true" : "false",
      "aria-label": `${fatia.rotulo}: ${formatarQtd(fatia.valor)}, ${pct(fatia)}`,
    });
    g.style.setProperty("--perf-dx", `${dx}px`);
    g.style.setProperty("--perf-dy", `${dy}px`);
    caminhosLateralFatia(a0 + 2 * Math.PI, a1 + 2 * Math.PI).forEach((d) => {
      g.appendChild(criar("path", { d, class: "perf-pizza-lateral" }));
    });
    const topo = criar("path", { d: caminhoTopoFatia(a0, a1), class: "perf-pizza-topo" });
    const dica = criar("title");
    dica.textContent = `${fatia.rotulo}: ${formatarQtd(fatia.valor)} (${pct(fatia)})`;
    topo.appendChild(dica);
    g.appendChild(topo);
    return g;
  });

  // ordem de desenho: a fatia selecionada por último (fica por cima ao se deslocar)
  const ordenados = [...grupos].sort(
    (a, b) => (a.dataset.fatia === fatiaPrazoSelecionada) - (b.dataset.fatia === fatiaPrazoSelecionada)
  );
  ordenados.forEach((g) => svg.appendChild(g));

  // ── Painel com os indicadores da fatia selecionada ──
  const painel = document.createElement("div");
  painel.className = "perf-pizza-painel";
  painel.setAttribute("aria-live", "polite");

  // ── Legenda interativa ──
  const legenda = document.createElement("ul");
  legenda.className = "perf-legenda perf-legenda-interativa";
  fatias.forEach((fatia) => {
    const item = document.createElement("li");
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "perf-legenda-item";
    botao.dataset.fatia = fatia.id;
    botao.disabled = fatia.valor === 0;
    botao.setAttribute("aria-pressed", fatia.id === fatiaPrazoSelecionada ? "true" : "false");
    const marcador = document.createElement("span");
    marcador.className = `perf-legenda-marcador ${fatia.classe}`;
    marcador.setAttribute("aria-hidden", "true");
    const rotulo = document.createElement("span");
    rotulo.className = "perf-legenda-rotulo";
    rotulo.textContent = fatia.rotulo;
    const valor = document.createElement("span");
    valor.className = "perf-legenda-valor";
    valor.textContent = `${pct(fatia)} · ${fatia.valor.toLocaleString("pt-BR")}`;
    botao.append(marcador, rotulo, valor);
    item.appendChild(botao);
    legenda.appendChild(item);
  });

  const lateral = document.createElement("div");
  lateral.className = "perf-pizza-lateral-info";
  lateral.append(legenda, painel);

  // ── Seleção (clique, toque, Enter/Espaço; pela fatia ou pela legenda) ──
  const atualizarSelecao = () => {
    grupos.forEach((g) => {
      const ativo = g.dataset.fatia === fatiaPrazoSelecionada;
      g.classList.toggle("perf-pizza-fatia-ativa", ativo);
      g.setAttribute("aria-pressed", ativo ? "true" : "false");
      if (ativo) svg.appendChild(g); // traz para frente sem recriar
    });
    legenda.querySelectorAll(".perf-legenda-item").forEach((b) => {
      const ativo = b.dataset.fatia === fatiaPrazoSelecionada;
      b.classList.toggle("ativo", ativo);
      b.setAttribute("aria-pressed", ativo ? "true" : "false");
    });

    painel.innerHTML = "";
    const sel = fatias.find((f) => f.id === fatiaPrazoSelecionada);
    if (sel) {
      painel.classList.add(`perf-pizza-painel-${sel.id}`);
      painel.classList.remove(`perf-pizza-painel-${sel.id === "prazo" ? "atraso" : "prazo"}`);
      const nome = document.createElement("strong");
      nome.className = "perf-pizza-painel-nome";
      nome.textContent = sel.rotulo;
      const qtd = document.createElement("span");
      qtd.textContent = formatarQtd(sel.valor);
      const p = document.createElement("span");
      p.className = "perf-pizza-painel-pct";
      p.textContent = pct(sel);
      painel.append(nome, qtd, p);
    } else {
      painel.classList.remove("perf-pizza-painel-prazo", "perf-pizza-painel-atraso");
      const dica = document.createElement("span");
      dica.className = "perf-pizza-painel-dica";
      dica.textContent = `${formatarQtd(total)} comparadas · selecione uma fatia`;
      painel.appendChild(dica);
    }
  };

  const alternar = (id) => {
    fatiaPrazoSelecionada = fatiaPrazoSelecionada === id ? null : id;
    atualizarSelecao();
  };

  grupos.forEach((g) => {
    g.addEventListener("click", () => alternar(g.dataset.fatia));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        alternar(g.dataset.fatia);
      }
    });
  });
  legenda.querySelectorAll(".perf-legenda-item").forEach((b) => {
    b.addEventListener("click", () => alternar(b.dataset.fatia));
  });

  container.append(svg, lateral);
  atualizarSelecao();
}

// Agrupa as demandas por diagramador (nome normalizado) e calcula as colunas da tabela
function agruparMetricasPorDiagramador(totalGeral) {
  const grupos = new Map();
  demandas.forEach((demanda) => {
    const nome = String(demanda.diagramador || "").trim() || "(sem diagramador)";
    const chave = normalizarNome(nome);
    if (!grupos.has(chave)) grupos.set(chave, { nome, lista: [] });
    grupos.get(chave).lista.push(demanda);
  });

  return [...grupos.values()].map(({ nome, lista }) => {
    const m = calcularMetricasPerformance(lista);
    return {
      nome,
      total: m.total,
      concluidas: m.concluidas,
      emAndamento: m.emAndamento,
      pendentes: m.pendentes,
      noPrazo: m.noPrazo,
      atrasadas: m.atrasadas,
      // Fórmulas pedidas: Total no prazo / Concluídas e Total atrasada / Concluídas.
      // Concluídas sem Previsto válido não entram em nenhuma das duas, então a soma
      // dos dois percentuais pode ficar abaixo de 100%.
      pctNoPrazo: calcularPercentual(m.noPrazo, m.concluidas),
      pctAtrasado: calcularPercentual(m.atrasadas, m.concluidas),
      // nome mantido por compatibilidade com a ordenação (data-coluna="mediaHoras"),
      // mas o valor agora é em MINUTOS ÚTEIS
      mediaHoras: calcularMedia(m.duracoesUteisMin),
      mediaAproximada: m.duracoesAproximadas > 0,
      // Atraso médio de INÍCIO em minutos úteis (nome mantido pela ordenação da tabela)
      atrasoMedioHoras: calcularMedia(m.atrasosInicioMin),
      atrasoAproximado: m.atrasosInicioAproximados > 0,
      pctParticipacao: calcularPercentual(m.total, totalGeral),
    };
  });
}

function renderizarRankingPerformance(porDiagramador) {
  const container = document.getElementById("perf-ranking");
  if (!container) return;
  if (!porDiagramador) {
    renderizarBarrasHorizontais(container, [], MSG_LISTAS_INDISPONIVEL);
    return;
  }

  const itens = porDiagramador
    .filter((d) => d.concluidas > 0)
    .sort((a, b) => b.concluidas - a.concluidas || a.nome.localeCompare(b.nome, "pt-BR"))
    .map((d, indice) => ({
      rotulo: `${indice + 1}º  ${d.nome}`,
      valor: d.concluidas,
      dica: `${d.nome}: ${d.concluidas} atividade(s) concluída(s)`,
    }));

  renderizarBarrasHorizontais(container, itens, "Nenhuma atividade concluída até o momento.");
}

function renderizarTabelaPerformance(porDiagramador) {
  const corpo = document.getElementById("perf-tabela-corpo");
  if (!corpo) return;
  corpo.innerHTML = "";

  if (!porDiagramador || !porDiagramador.length) {
    const linha = document.createElement("tr");
    const celula = document.createElement("td");
    celula.colSpan = 10;
    celula.className = "perf-vazio";
    celula.textContent = porDiagramador ? "Nenhum diagramador cadastrado na aba LISTAS." : MSG_LISTAS_INDISPONIVEL;
    linha.appendChild(celula);
    corpo.appendChild(linha);
    return;
  }

  const { coluna, direcao } = ordenacaoTabelaPerformance;
  const fator = direcao === "asc" ? 1 : -1;
  const ordenadas = [...porDiagramador].sort((a, b) => {
    if (coluna === "nome") return fator * a.nome.localeCompare(b.nome, "pt-BR");
    // valores sem dado ("–") sempre no fim, em qualquer direção
    const va = a[coluna], vb = b[coluna];
    if (va === null && vb === null) return a.nome.localeCompare(b.nome, "pt-BR");
    if (va === null) return 1;
    if (vb === null) return -1;
    return fator * (va - vb) || a.nome.localeCompare(b.nome, "pt-BR");
  });

  const chip = (texto, classe) => {
    const span = document.createElement("span");
    span.className = `perf-chip ${classe}`;
    span.textContent = texto;
    return span;
  };

  ordenadas.forEach((d) => {
    const linha = document.createElement("tr");
    const celulas = [
      { conteudo: d.nome, classe: "perf-col-texto perf-col-nome" },
      { conteudo: d.total },
      { conteudo: d.concluidas },
      { conteudo: d.emAndamento },
      { conteudo: d.pendentes },
      { conteudo: d.noPrazo },
      { conteudo: d.atrasadas },
      { conteudo: d.pctNoPrazo === null ? "–" : chip(formatarPercentual(d.pctNoPrazo), "perf-chip-prazo") },
      { conteudo: d.pctAtrasado === null ? "–" : chip(formatarPercentual(d.pctAtrasado), "perf-chip-atraso") },
      { conteudo: formatarPercentual(d.pctParticipacao) },
    ];
    celulas.forEach(({ conteudo, classe }) => {
      const td = document.createElement("td");
      if (classe) td.className = classe;
      if (conteudo instanceof Node) td.appendChild(conteudo);
      else td.textContent = conteudo;
      linha.appendChild(td);
    });
    corpo.appendChild(linha);
  });

  // Indica a coluna ordenada para leitores de tela
  document.querySelectorAll("#perf-tabela thead th").forEach((th) => {
    const ativa = th.dataset.coluna === coluna;
    th.setAttribute("aria-sort", ativa ? (direcao === "asc" ? "ascending" : "descending") : "none");
  });
}

// Cabeçalhos clicáveis (botões, acessíveis por teclado) para ordenar a tabela
function configurarOrdenacaoTabelaPerformance() {
  document.querySelectorAll("#perf-tabela thead th[data-coluna]").forEach((th) => {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "perf-ordenar";
    botao.textContent = th.textContent;
    th.textContent = "";
    th.appendChild(botao);

    botao.addEventListener("click", () => {
      const coluna = th.dataset.coluna;
      if (ordenacaoTabelaPerformance.coluna === coluna) {
        ordenacaoTabelaPerformance.direcao = ordenacaoTabelaPerformance.direcao === "asc" ? "desc" : "asc";
      } else {
        // texto começa em A→Z; números começam do maior para o menor
        ordenacaoTabelaPerformance = { coluna, direcao: coluna === "nome" ? "asc" : "desc" };
      }
      // Ordenar só reorganiza a tabela, sobre as métricas já agregadas (cache)
      const metricas = obterMetricasPerformance();
      renderizarTabelaPerformance(obterDesempenhoDiagramadoresListas(metricas.porDiagramador, metricas.geral.total));
    });
  });
}

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

  document.getElementById("resumo-visao-performance")
    ?.classList.toggle("oculto", aba !== "performance");

  // Botões ativos ("Visão da equipe" saiu do Resumo: a visão operacional abre direto)
  document.getElementById("btn-visao-equipe")
    ?.classList.toggle("ativo", aba === "equipe");
  document.getElementById("btn-performance")
    ?.classList.toggle("ativo", aba === "performance");
  const botaoPerformance = document.getElementById("btn-performance");
  if (botaoPerformance) {
    if (aba === "performance") botaoPerformance.setAttribute("aria-current", "page");
    else botaoPerformance.removeAttribute("aria-current");
  }
  // Os botões "Kanban Visual Geral" e "Equipe de Diagramação" saíram do Resumo; as
  // visões continuam existindo (a Equipe é aberta pelo portal), por isso o ?.
  document.getElementById("btn-kanban-visual-geral")
    ?.classList.toggle("ativo", aba === "kanban-geral");
  document.getElementById("btn-equipe-diagramacao")
    ?.classList.toggle("ativo", ehEquipeDiagramacao);

  // Modo imersivo: a classe body.modo-equipe-diagramacao controla via CSS o
  // ocultamento do header, remoção de margens e expansão da seção para 100vh.
  // Os elementos internos abaixo são ocultados via JS (.oculto) pois estão
  // dentro do mesmo container e precisam sumir independente do CSS do body.
  document.body.classList.toggle("modo-equipe-diagramacao", ehEquipeDiagramacao);
  atualizarEscopoTemaOperacional(); // Performance/Equipe ficam no tema claro

  // Título + cards de diagramadores do Resumo: ocultos na Equipe e na Performance
  // (a Performance tem título e cards próprios)
  document.getElementById("resumo-cabecalho-operacional")
    ?.classList.toggle("oculto", ehEquipeDiagramacao || aba === "performance");

  if (aba === "kanban-geral") {
    renderizarKanbanVisualGeral();
  }

  if (aba === "performance") {
    agendarRenderizacaoPerformance();
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

  wrapper.appendChild(criarBotaoFeriasDiagramador(nomeDiagramador));

  const painelFerias = criarPainelFeriasDiagramador(nomeDiagramador);
  if (painelFerias) wrapper.appendChild(painelFerias);

  return wrapper;
}

// ===================== FÉRIAS DOS DIAGRAMADORES ===================== //
//
// Backend preparado em apps-script/Ferias.gs (aba FERIAS_DIAGRAMADORES), ações:
//   GET  ?acao=buscarFerias                      -> { sucesso, ferias: [...] }
//   POST { acao: "criarFerias", dados: {...} }   -> { sucesso, mensagem, ferias }
//
// ATIVAÇÃO AUTOMÁTICA: o "Salvar férias" só é liberado quando o Web App em uso responde
// de verdade à ação buscarFerias, ou seja, quando o Ferias.gs já foi implantado (depois da
// validação em homologação; ver docs/implantacao-ferias.md). Sem isso, nada é gravado
// (nem na planilha, nem no localStorage) e o modal explica o motivo.
// ATENÇÃO: um doGet que não conhece a ação devolve { sucesso: true, mensagem: "...online" }
// sem a lista "ferias" - isso NÃO conta como integração operacional.
// FERIAS_INTEGRACAO_HABILITADA = false funciona como chave de emergência (desliga tudo,
// inclusive a consulta), útil para reverter sem mexer no Apps Script.
//
// Estados (pelas DATAS, início e fim inclusivos, fuso America/Recife; nunca pelo status
// das demandas): Programadas -> "Férias programadas" | Em férias -> "Em férias" |
// Encerradas ou sem férias -> botão normal "Férias".
const FERIAS_INTEGRACAO_HABILITADA = true;

// Estado detectado: "verificando" | "operacional" | "indisponivel" | "erro" | "desligada"
let estadoIntegracaoFerias = FERIAS_INTEGRACAO_HABILITADA ? "verificando" : "desligada";

function feriasOperacional() {
  return estadoIntegracaoFerias === "operacional";
}

const MENSAGEM_ESTADO_FERIAS = {
  "verificando": "Verificando a conexão com o cadastro de férias…",
  "indisponivel": "O cadastro de férias ainda não está ativo: o servidor (Apps Script) em uso ainda não tem as ações de férias publicadas. Por isso o botão \"Salvar férias\" está desabilitado e nada é registrado.",
  "erro": "Não foi possível ler o serviço de férias a partir do Kanban (o serviço pode exigir login do Google ou a conexão falhou). O botão \"Salvar férias\" fica desabilitado e nada é registrado.",
  "desligada": "O cadastro de férias está desligado nesta versão do sistema. Nada é registrado.",
};

// Lê os períodos da aba FERIAS_DIAGRAMADORES (somente leitura). Falha não quebra a tela:
// os botões ficam no estado normal e um aviso vai para o console.
async function carregarFerias() {
  if (!FERIAS_INTEGRACAO_HABILITADA) {
    estadoIntegracaoFerias = "desligada";
    return;
  }
  try {
    // Serviço independente de férias; sem cookies (credentials: "omit") e seguindo os
    // redirecionamentos do Apps Script. Uma página de login (HTML) ou bloqueio de CORS
    // cai no catch -> estado "erro" (botão desabilitado).
    const resposta = await fetch(FERIAS_WEB_APP_URL + "?acao=buscarFerias", { credentials: "omit", redirect: "follow" });
    const dados = await resposta.json();
    // Só é operacional se a AÇÃO respondeu: sucesso + lista "ferias"
    if (dados && dados.sucesso === true && Array.isArray(dados.ferias)) {
      configuracoes.feriasDiagramadores = dados.ferias;
      estadoIntegracaoFerias = "operacional";
    } else if (dados && dados.sucesso === false) {
      // a ação existe, mas falhou (ex.: aba ou cabeçalhos ausentes)
      console.warn("buscarFerias respondeu com erro:", dados.mensagem);
      estadoIntegracaoFerias = "erro";
    } else {
      estadoIntegracaoFerias = "indisponivel"; // doGet não conhece buscarFerias
    }
  } catch (erro) {
    console.warn("Não foi possível carregar as férias:", erro);
    estadoIntegracaoFerias = "erro";
  }
}

// Envia o período ao backend e só considera salvo com { sucesso: true } (resposta JSON
// lida - nunca no-cors/opaca)
async function salvarFeriasNoBackend(periodo) {
  const resposta = await fetch(FERIAS_WEB_APP_URL, {
    method: "POST",
    credentials: "omit",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ acao: "criarFerias", dados: periodo }),
  });
  const resultado = await resposta.json();
  if (!resultado || !resultado.sucesso) {
    throw new Error((resultado && resultado.mensagem) || "O servidor não confirmou a gravação.");
  }
  return resultado;
}

function obterPeriodosFeriasDoDiagramador(nome) {
  const lista = Array.isArray(configuracoes.feriasDiagramadores) ? configuracoes.feriasDiagramadores : [];
  return lista
    .filter((p) => normalizarNome(p.diagramador) === normalizarNome(nome))
    .map((p) => ({ inicio: converterDataInputEmDia(p.inicio), fim: converterDataInputEmDia(p.fim), observacoes: p.observacoes || "" }))
    .filter((p) => p.inicio !== null && p.fim !== null && p.fim >= p.inicio);
}

// "normal" | "programadas" | "em-ferias" (hoje no fuso operacional)
function obterEstadoFeriasDiagramador(nome) {
  const hoje = obterDiaOperacional(new Date());
  const periodos = obterPeriodosFeriasDoDiagramador(nome);
  if (periodos.some((p) => p.inicio <= hoje && hoje <= p.fim)) return "em-ferias";
  if (periodos.some((p) => p.inicio > hoje)) return "programadas";
  return "normal";
}

// ── Resumo das férias para o painel da coluna DIAGRAMADOR ──
// Usa SOMENTE as datas do serviço de férias (já carregadas em configuracoes.feriasDiagramadores).
// Dias são "dias de calendário" em ms UTC (converterDataInputEmDia + obterDiaOperacional no
// fuso America/Recife), então não há deslocamento de um dia por UTC. Contagens em dias
// CORRIDOS; início e término inclusivos; o dia de hoje conta como dia restante.
// Retorno = dia seguinte ao término (não se presume dia útil).
// Encerradas não geram resumo (null). Calculado a cada renderização (sem timers).
function calcularResumoFerias(periodos, hoje) {
  const atual = periodos.find((p) => p.inicio <= hoje && hoje <= p.fim);
  if (atual) {
    const total = Math.round((atual.fim - atual.inicio) / MS_DIA) + 1;
    const restantes = Math.round((atual.fim - hoje) / MS_DIA) + 1; // hoje incluso
    return {
      estado: "em-ferias",
      inicio: atual.inicio,
      fim: atual.fim,
      total,
      restantes,
      progresso: (total - restantes) / total, // fração já usufruída antes de hoje
      retorno: atual.fim + MS_DIA,
    };
  }
  const futuros = periodos.filter((p) => p.inicio > hoje).sort((a, b) => a.inicio - b.inicio);
  if (futuros.length) {
    const proximo = futuros[0];
    return {
      estado: "programadas",
      inicio: proximo.inicio,
      fim: proximo.fim,
      total: Math.round((proximo.fim - proximo.inicio) / MS_DIA) + 1,
      faltam: Math.round((proximo.inicio - hoje) / MS_DIA),
    };
  }
  return null;
}

// "DD/MM a DD/MM/AAAA"; se o período atravessa o ano, os dois lados levam o ano
function formatarPeriodoFerias(inicio, fim) {
  const mesmoAno = new Date(inicio).getUTCFullYear() === new Date(fim).getUTCFullYear();
  return `${formatarDiaMes(inicio, !mesmoAno)} a ${formatarDiaMes(fim, true)}`;
}

function criarPainelFeriasDiagramador(nome) {
  const resumo = calcularResumoFerias(obterPeriodosFeriasDoDiagramador(nome), obterDiaOperacional(new Date()));
  if (!resumo) return null;

  const painel = document.createElement("div");
  painel.className = `painel-ferias painel-ferias-${resumo.estado}`;
  const linha = (classe, texto) => {
    const el = document.createElement("span");
    el.className = classe;
    el.textContent = texto;
    painel.appendChild(el);
    return el;
  };

  const periodo = formatarPeriodoFerias(resumo.inicio, resumo.fim);
  linha("painel-ferias-periodo", periodo);

  if (resumo.estado === "em-ferias") {
    linha("painel-ferias-destaque", `${resumo.restantes} ${resumo.restantes === 1 ? "dia restante" : "dias restantes"}`);
    const trilho = document.createElement("span");
    trilho.className = "painel-ferias-trilho";
    trilho.setAttribute("role", "progressbar");
    trilho.setAttribute("aria-valuemin", "0");
    trilho.setAttribute("aria-valuemax", String(resumo.total));
    trilho.setAttribute("aria-valuenow", String(resumo.total - resumo.restantes));
    trilho.setAttribute("aria-label", `Dia ${resumo.total - resumo.restantes + 1} de ${resumo.total} das férias`);
    const barra = document.createElement("span");
    barra.className = "painel-ferias-barra";
    barra.style.width = `${Math.round(resumo.progresso * 100)}%`;
    trilho.appendChild(barra);
    painel.appendChild(trilho);
    linha("painel-ferias-detalhe", `Retorno: ${formatarDiaMes(resumo.retorno, true)}`);
    painel.title = `Em férias de ${formatarDiaMes(resumo.inicio, true)} a ${formatarDiaMes(resumo.fim, true)} ` +
      `(${resumo.total} dias corridos). Retorno previsto: ${formatarDiaMes(resumo.retorno, true)}.`;
  } else {
    linha("painel-ferias-destaque", resumo.faltam === 1 ? "Falta 1 dia" : `Faltam ${resumo.faltam} dias`);
    linha("painel-ferias-detalhe", `Início: ${formatarDiaMes(resumo.inicio, true)}`);
    painel.title = `Férias programadas de ${formatarDiaMes(resumo.inicio, true)} a ${formatarDiaMes(resumo.fim, true)} ` +
      `(${resumo.total} dias corridos).`;
  }
  return painel;
}

const ROTULO_ESTADO_FERIAS = { "normal": "Férias", "programadas": "Férias programadas", "em-ferias": "Em férias" };

function criarBotaoFeriasDiagramador(nome) {
  const estado = obterEstadoFeriasDiagramador(nome);
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = `btn-ferias btn-ferias-${estado}`;
  botao.setAttribute("aria-label", `${ROTULO_ESTADO_FERIAS[estado]} — ${nome}`);
  botao.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  const texto = document.createElement("span");
  texto.textContent = ROTULO_ESTADO_FERIAS[estado];
  botao.appendChild(texto);
  // não propaga para a linha/células da tabela (não interfere na edição de demandas)
  botao.addEventListener("click", (e) => {
    e.stopPropagation();
    abrirModalFerias(nome);
  });
  return botao;
}

function abrirModalFerias(nome) {
  const modal = document.getElementById("modal-ferias");
  if (!modal) return;
  document.getElementById("ferias-diagramador").value = nome;
  document.getElementById("ferias-inicio").value = "";
  document.getElementById("ferias-fim").value = "";
  document.getElementById("ferias-observacoes").value = "";
  document.getElementById("ferias-erro").hidden = true;
  const salvar = document.getElementById("btn-salvar-ferias");
  const operacional = feriasOperacional();
  salvar.disabled = !operacional;
  const aviso = document.getElementById("ferias-aviso-persistencia");
  aviso.hidden = operacional;
  if (!operacional) aviso.textContent = MENSAGEM_ESTADO_FERIAS[estadoIntegracaoFerias] || MENSAGEM_ESTADO_FERIAS.indisponivel;
  modal.dataset.origem = nome;
  renderizarListaFeriasModal(nome);
  modal.classList.remove("oculto");
  setTimeout(() => document.getElementById("ferias-inicio").focus(), 30);
}

// Períodos já cadastrados do diagramador, com a situação calculada pelas datas
function renderizarListaFeriasModal(nome) {
  const lista = document.getElementById("ferias-lista");
  if (!lista) return;
  lista.innerHTML = "";
  const hoje = obterDiaOperacional(new Date());
  const periodos = obterPeriodosFeriasDoDiagramador(nome).sort((a, b) => b.inicio - a.inicio);
  lista.hidden = periodos.length === 0;
  periodos.forEach((p) => {
    const situacao = p.inicio > hoje ? "Programadas" : p.fim < hoje ? "Encerradas" : "Em férias";
    const item = document.createElement("li");
    item.textContent = `${formatarDiaMes(p.inicio, true)} a ${formatarDiaMes(p.fim, true)} · ${situacao}` +
      (p.observacoes ? ` · ${p.observacoes}` : "");
    lista.appendChild(item);
  });
}

function fecharModalFerias() {
  document.getElementById("modal-ferias").classList.add("oculto");
}

// Validação das datas (fim não pode ser anterior ao início). Usada ao alterar os campos
// e, no futuro, antes de salvar.
function validarPeriodoFerias() {
  const inicio = converterDataInputEmDia(document.getElementById("ferias-inicio").value);
  const fim = converterDataInputEmDia(document.getElementById("ferias-fim").value);
  const erro = document.getElementById("ferias-erro");
  let mensagem = "";
  if (inicio !== null && fim !== null && fim < inicio) {
    mensagem = "A data de término não pode ser anterior à data de início.";
  }
  erro.textContent = mensagem;
  erro.hidden = !mensagem;
  return { valido: !mensagem && inicio !== null && fim !== null, inicio, fim };
}

function configurarModalFerias() {
  const modal = document.getElementById("modal-ferias");
  if (!modal) return;
  document.getElementById("ferias-inicio").addEventListener("change", validarPeriodoFerias);
  document.getElementById("ferias-fim").addEventListener("change", validarPeriodoFerias);
  document.getElementById("btn-fechar-ferias").addEventListener("click", fecharModalFerias);
  document.getElementById("btn-cancelar-ferias").addEventListener("click", fecharModalFerias);
  modal.addEventListener("click", (e) => { if (e.target === modal) fecharModalFerias(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("oculto")) fecharModalFerias();
  });
  document.getElementById("btn-salvar-ferias").addEventListener("click", async () => {
    // Sem integração operacional não há gravação (nem fictícia, nem em localStorage)
    if (!feriasOperacional()) return;
    const botao = document.getElementById("btn-salvar-ferias");
    const erro = document.getElementById("ferias-erro");
    const { valido, inicio, fim } = validarPeriodoFerias();
    if (!valido) {
      if (erro.hidden) {
        erro.textContent = "Informe a data de início e a data de término.";
        erro.hidden = false;
      }
      return;
    }
    const nome = document.getElementById("ferias-diagramador").value.trim();
    // Pré-verificação local de sobreposição (o backend verifica de novo, com lock)
    const conflito = obterPeriodosFeriasDoDiagramador(nome).find((p) => p.inicio <= fim && inicio <= p.fim);
    if (conflito) {
      erro.textContent = `Já existe férias de ${nome} entre ${formatarDiaMes(conflito.inicio, true)} e ${formatarDiaMes(conflito.fim, true)}.`;
      erro.hidden = false;
      return;
    }

    botao.disabled = true;
    botao.textContent = "Salvando…";
    try {
      const resultado = await salvarFeriasNoBackend({
        diagramador: nome,
        inicio: formatarDiaInput(inicio),
        fim: formatarDiaInput(fim),
        observacoes: document.getElementById("ferias-observacoes").value.trim(),
      });
      // Gravação confirmada pelo servidor: atualiza a lista local e a tabela
      if (!Array.isArray(configuracoes.feriasDiagramadores)) configuracoes.feriasDiagramadores = [];
      configuracoes.feriasDiagramadores.push(resultado.ferias);
      fecharModalFerias();
      renderizarTabela();
      atualizarResumoNucleos(); // card e quadro "Diagramadores de férias" usam a mesma lista
    } catch (falha) {
      console.error("Falha ao salvar férias:", falha);
      erro.textContent = `Não foi possível salvar: ${falha.message}`;
      erro.hidden = false;
    } finally {
      botao.disabled = false;
      botao.textContent = "Salvar férias";
    }
  });
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

  // Ao trocar de núcleo, o filtro de diagramador volta para "Todos"
  if (nucleoDoFiltroKanbanVisual !== nucleoSelecionado) {
    nucleoDoFiltroKanbanVisual = nucleoSelecionado;
    filtroDiagramadorKanbanVisual = "";
  }
  renderizarFiltroDiagramadoresKanbanVisual();

  // Filtro visual: só restringe a exibição, não altera nenhuma demanda
  const demandasDoNucleo = demandas.filter(
    (d) =>
      obterNucleoDaDemanda(d) === nucleoSelecionado &&
      (!filtroDiagramadorKanbanVisual ||
        normalizarNome(d.diagramador) === normalizarNome(filtroDiagramadorKanbanVisual))
  );

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

// ===================== FILTRO VISUAL POR DIAGRAMADOR (KANBAN VISUAL DO NÚCLEO) ===================== //

// Diagramador selecionado no filtro ("" = Todos) e o núcleo a que esse filtro pertence
let filtroDiagramadorKanbanVisual = "";
let nucleoDoFiltroKanbanVisual = "";

// Monta os botões do filtro: "Todos" + um avatar por diagramador do núcleo selecionado,
// reutilizando configuracoes.diagramadoresPorNucleo e obterFotoDiagramador()
function renderizarFiltroDiagramadoresKanbanVisual() {
  const container = document.getElementById("kanban-filtro-diagramadores");
  if (!container) return;
  container.innerHTML = "";

  const diagramadores = configuracoes.diagramadoresPorNucleo[nucleoSelecionado] || [];

  const criarBotao = (valor, rotulo, conteudo) => {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "kanban-filtro-opcao";
    botao.title = rotulo;
    botao.setAttribute("aria-label", rotulo);
    const ativo = normalizarNome(valor) === normalizarNome(filtroDiagramadorKanbanVisual);
    botao.setAttribute("aria-pressed", ativo ? "true" : "false");
    if (ativo) botao.classList.add("ativo");
    botao.appendChild(conteudo);
    botao.addEventListener("click", () => {
      filtroDiagramadorKanbanVisual = valor;
      renderizarKanbanVisual();
    });
    container.appendChild(botao);
  };

  const iconeTodos = document.createElement("span");
  iconeTodos.className = "kanban-filtro-todos";
  iconeTodos.setAttribute("aria-hidden", "true");
  iconeTodos.textContent = "👥 Todos";
  criarBotao("", "Todos os diagramadores", iconeTodos);

  diagramadores.forEach((nome) => {
    criarBotao(nome, nome, criarAvatarFiltroKanban(nome));
  });
}

// Avatar circular de 36px: foto da aba LISTAS ou, sem foto/erro ao carregar, as iniciais
function criarAvatarFiltroKanban(nome) {
  const iniciais = document.createElement("span");
  iniciais.className = "kanban-filtro-avatar kanban-filtro-iniciais";
  iniciais.setAttribute("aria-hidden", "true");
  iniciais.textContent = obterIniciaisNome(nome);

  const url = obterFotoDiagramador(nome);
  if (!url) return iniciais;

  const img = document.createElement("img");
  img.className = "kanban-filtro-avatar";
  img.src = url;
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => img.replaceWith(iniciais), { once: true });
  return img;
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

  return listaDemandas.filter((demanda) => {
    if (diagramador && demanda.diagramador !== diagramador) return false;
    if (status && demanda.status !== status) return false;
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
  // "Performance" (cabeçalho azul, só visível na tela do Resumo, que já exigiu senha)
  // e "Voltar ao Resumo": alternam visões internas do Resumo, sem recarregar a página
  document.getElementById("btn-performance").addEventListener("click", () => {
    if (telaAtual !== "resumo") return;
    if (visualizacaoResumoAtiva === "performance") return; // já está na Performance: nada a refazer (filtros intactos)
    irParaVisualizacaoResumo("performance");
    window.scrollTo(0, 0);
  });
  configurarOrdenacaoTabelaPerformance();
  configurarRelatorios();
  configurarModalFerias();
  configurarModalConclusao();
  configurarTooltipMapaCalor();
  configurarDetalheMapaCalor();
  configurarModalAtividades();
  configurarTemaOperacional();

  document.getElementById("btn-voltar-resumo").addEventListener("click", () => {
    irParaVisualizacaoResumo("equipe");
    window.scrollTo(0, 0);
  });
  // Retorno da Equipe de Diagramação: volta ao portal se veio de lá; senão, ao Resumo
  document.getElementById("btn-voltar-resumo-equipe").addEventListener("click", () => {
    if (origemEquipeDiagramacao === "inicio") {
      transicionarTela(voltarParaInicio);
    } else {
      irParaVisualizacaoResumo("equipe");
    }
  });

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
  // "Linhas por diagramador": só muda a apresentação (mínimo de linhas de cada bloco).
  // Não envia nada ao Apps Script nem cria demandas - apenas salva a preferência e
  // re-renderiza a tabela a partir do estado local.
  const seletorLinhas = document.getElementById("seletor-linhas-diagramador");
  seletorLinhas.value = String(linhasMinimasPorDiagramador);
  seletorLinhas.addEventListener("change", () => {
    const valor = Number(seletorLinhas.value);
    if (!OPCOES_LINHAS_POR_DIAGRAMADOR.includes(valor)) return;
    linhasMinimasPorDiagramador = valor;
    salvarPreferenciaLinhasPorDiagramador(valor);
    renderizarTabela();
  });
}

// ===================== NAVEGAÇÃO DO CABEÇALHO (TELAS E NÚCLEOS) ===================== //

// Senha que protege o acesso ao Resumo dos núcleos.
const SENHA_RESUMO_NUCLEOS = "sgge@kanban@123";

// Exibe o modal de senha e resolve a Promise com true (acesso liberado) ou false (cancelado).
function solicitarSenhaResumoNucleos() {
  return new Promise(function (resolver) {
    const overlay = document.getElementById("modal-senha-resumo");
    const input   = document.getElementById("input-senha-resumo");
    const erro    = document.getElementById("modal-senha-erro");
    const btnEntrar   = document.getElementById("btn-senha-entrar");
    const btnCancelar = document.getElementById("btn-senha-cancelar");

    // Limpa estado anterior (a senha sempre começa oculta ao abrir o modal)
    definirVisibilidadeSenhaResumo(false);
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

// Mostra (type="text") ou oculta (type="password") a senha do modal, sem alterar o
// valor digitado, e sincroniza ícone, aria-label e aria-pressed do botão de olho.
function definirVisibilidadeSenhaResumo(visivel) {
  const input = document.getElementById("input-senha-resumo");
  const botao = document.getElementById("btn-mostrar-senha");
  if (!input || !botao) return;

  input.type = visivel ? "text" : "password";
  botao.classList.toggle("senha-visivel", visivel);
  botao.setAttribute("aria-label", visivel ? "Ocultar senha" : "Mostrar senha");
  botao.setAttribute("aria-pressed", visivel ? "true" : "false");
}

// Botão de olho: alterna a visibilidade mantendo o foco/cursor no campo de senha.
// mousedown com preventDefault evita que o clique do mouse tire o foco do input;
// pelo teclado (Tab até o botão + Enter/Espaço) o foco fica no próprio botão.
(function configurarBotaoMostrarSenha() {
  const input = document.getElementById("input-senha-resumo");
  const botao = document.getElementById("btn-mostrar-senha");
  if (!input || !botao) return;

  botao.addEventListener("mousedown", (evento) => evento.preventDefault());
  botao.addEventListener("click", () => {
    definirVisibilidadeSenhaResumo(input.type === "password");
  });
})();

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

  configurarNavegacaoInicio();

  document.querySelectorAll(".btn-nucleo[data-nucleo]").forEach((botao) => {
    botao.addEventListener("click", () => {
      nucleoSelecionado = botao.dataset.nucleo;
      irParaTela("tabela");
    });
  });

  atualizarBotaoNucleoAtivo();
}

// ===================== TELA INICIAL (PORTAL "BEM-VINDO") ===================== //

// Áreas exibidas no portal, na ordem definida pela tela de referência. O texto exibido
// (rotulo) pode diferir do nome do setor na planilha (ex: "Arte-Final" = "Arte-Finalização").
// Um item só fica clicável se o setor existir em configuracoes.diagramadoresPorNucleo, que
// é o que faz a tabela operacional dele funcionar; caso contrário aparece desabilitado,
// com o selo "Em desenvolvimento" - nunca é redirecionado para outro núcleo.
// "subtitulo" é só apresentação no portal - não altera o cadastro na planilha.
const AREAS_INICIO_NUCLEOS = [
  { rotulo: "Núcleo 2", nomes: ["Núcleo 2"], subtitulo: "Ludus · 1º ao 5º ano · Ensino Fundamental I" },
  { rotulo: "Núcleo 3", nomes: ["Núcleo 3"], subtitulo: "Basis · 6º ao 9º ano · Ensino Fundamental II" },
  { rotulo: "Núcleo 4", nomes: ["Núcleo 4"], subtitulo: "Mundus · 1º ao 3º ano · Ensino Médio" },
  { rotulo: "Núcleo 5", nomes: ["Núcleo 5"], subtitulo: "Avaliações · EVA · Simulados" },
  { rotulo: "Núcleo 6", nomes: ["Núcleo 6"], subtitulo: "Projetos Extras" },
];
const AREAS_INICIO_ESPECIALIZADA = [
  { rotulo: "Automatização", nomes: ["Automatização"] },
  { rotulo: "Arte-Final", nomes: ["Arte-Finalização", "Arte-Final", "Arte Final"] },
  { rotulo: "Ilustração", nomes: ["Ilustração"] },
];

// Seta diagonal discreta (↗) usada em cada linha das listas
const SVG_SETA_DIAGONAL_INICIO =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/></svg>';

// Procura em configuracoes.diagramadoresPorNucleo o setor real correspondente à área,
// tolerando acentos/maiúsculas (normalizarNome). Retorna o nome exato da planilha ou "".
function encontrarSetorConfigurado(nomesPossiveis) {
  const setores = Object.keys(configuracoes.diagramadoresPorNucleo || {});
  for (const nome of nomesPossiveis) {
    const encontrado = setores.find((setor) => normalizarNome(setor) === normalizarNome(nome));
    if (encontrado) return encontrado;
  }
  return "";
}

// Preenche as duas listas do portal (Diagramação dos Núcleos e Produção Especializada)
function renderizarCardsNucleosInicio() {
  preencherListaAreasInicio("inicio-lista-nucleos", AREAS_INICIO_NUCLEOS);
  preencherListaAreasInicio("inicio-lista-especializada", AREAS_INICIO_ESPECIALIZADA);
}

function preencherListaAreasInicio(idLista, areas) {
  const lista = document.getElementById(idLista);
  if (!lista) return;
  lista.innerHTML = "";

  areas.forEach((area) => {
    const setor = encontrarSetorConfigurado(area.nomes);

    const item = document.createElement("li");
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "inicio-lista-item";

    const nome = document.createElement("span");
    if (area.subtitulo) {
      // Nome em destaque + subtítulo logo abaixo (só nos itens que têm subtítulo)
      botao.classList.add("inicio-lista-item-com-subtitulo");
      nome.className = "inicio-lista-textos";
      const nomeDestaque = document.createElement("span");
      nomeDestaque.className = "inicio-lista-nome";
      nomeDestaque.textContent = area.rotulo;
      const subtitulo = document.createElement("span");
      subtitulo.className = "inicio-lista-subtitulo";
      subtitulo.textContent = area.subtitulo;
      nome.append(nomeDestaque, subtitulo);
    } else {
      nome.textContent = area.rotulo;
    }
    botao.appendChild(nome);

    if (setor) {
      botao.setAttribute("aria-label", `Abrir o quadro de demandas: ${area.rotulo}`);
      const seta = document.createElement("span");
      seta.className = "inicio-lista-seta";
      seta.setAttribute("aria-hidden", "true");
      // Indicador visual "Acessar ↗" (não é um botão: a linha inteira é o único controle)
      seta.innerHTML = '<span class="inicio-lista-acessar">Acessar</span>' + SVG_SETA_DIAGONAL_INICIO;
      botao.appendChild(seta);
      botao.addEventListener("click", () => {
        transicionarTela(() => {
          nucleoSelecionado = setor;
          irParaTela("tabela");
          window.scrollTo(0, 0);
        });
      });
    } else {
      // Sem tela operacional: visível, porém desabilitado
      botao.disabled = true;
      botao.setAttribute("aria-label", `${area.rotulo} — em desenvolvimento`);
      const selo = document.createElement("span");
      selo.className = "inicio-selo-dev";
      selo.setAttribute("aria-hidden", "true");
      selo.textContent = "Em desenvolvimento";
      botao.appendChild(selo);
    }

    item.appendChild(botao);
    lista.appendChild(item);
  });
}

// Volta ao portal a partir de qualquer tela, sem recarregar a página. Se estava no modo
// imersivo da Equipe de Diagramação, restaura a visão padrão do Resumo (remove a classe
// body.modo-equipe-diagramacao, que oculta o cabeçalho).
function voltarParaInicio() {
  origemEquipeDiagramacao = "resumo";
  atualizarRotuloVoltarEquipe();
  if (visualizacaoResumoAtiva !== "equipe") {
    visualizacaoResumoAtiva = "equipe";
    atualizarVisualizacaoResumoAtiva();
  }
  irParaTela("inicio");
  window.scrollTo(0, 0);
}

// Eventos do portal: identidade do cabeçalho, card da Equipe e card do Resumo (com senha)
function configurarNavegacaoInicio() {
  document.getElementById("btn-ir-inicio").addEventListener("click", () => {
    // Já no portal: nada a animar
    if (telaAtual === "inicio") return;
    transicionarTela(voltarParaInicio);
  });

  document.getElementById("btn-inicio-equipe").addEventListener("click", () => {
    transicionarTela(() => {
      origemEquipeDiagramacao = "inicio";
      atualizarRotuloVoltarEquipe();
      irParaTela("resumo");
      irParaVisualizacaoResumo("equipe-diagramacao");
      window.scrollTo(0, 0);
    });
  });

  document.getElementById("btn-inicio-resumo").addEventListener("click", async () => {
    if (transicaoEmAndamento) return;
    // Modal de senha abre imediatamente, com a mesma validação do botão do cabeçalho;
    // a transição só acontece depois da autenticação bem-sucedida
    const liberado = await solicitarSenhaResumoNucleos();
    if (!liberado) return;
    transicionarTela(() => {
      origemEquipeDiagramacao = "resumo";
      atualizarRotuloVoltarEquipe();
      visualizacaoResumoAtiva = "equipe";
      atualizarVisualizacaoResumoAtiva();
      irParaTela("resumo");
      window.scrollTo(0, 0);
    });
  });
}

// ===================== TRANSIÇÃO ENTRE PORTAL E SEÇÕES INTERNAS ===================== //
//
// Usada SOMENTE na navegação portal <-> seções (núcleos, Equipe, Resumo, retorno ao
// portal). renderizarTela() continua sem animação, então as re-renderizações após
// salvar demandas e a troca tabela <-> Kanban Visual não são afetadas.

const DURACAO_SAIDA_TRANSICAO_MS = 150;
const DURACAO_ENTRADA_TRANSICAO_MS = 250;

// Trava contra cliques repetidos enquanto uma transição está em curso
let transicaoEmAndamento = false;

// Elemento visível de cada valor de telaAtual
function obterElementoDaTela(tela) {
  const ids = {
    inicio: "tela-inicio",
    tabela: "tela-operacional",
    kanban: "tela-kanban-visual",
    resumo: "tela-resumo-nucleos",
  };
  return document.getElementById(ids[tela]);
}

// Título que recebe o foco ao chegar na tela de destino (quando houver um título claro)
function obterTituloParaFoco() {
  if (telaAtual === "inicio") return document.querySelector(".inicio-titulo");
  if (telaAtual === "resumo") {
    return visualizacaoResumoAtiva === "equipe-diagramacao"
      ? document.querySelector(".team-hero-titulo")
      : document.querySelector(".tela-resumo-titulo");
  }
  return null; // tabela: o foco fica no fluxo normal da página
}

function deveReduzirMovimento() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Executa `navegar` (a mesma função de navegação de antes) envolvida por uma saída
// em fade + leve subida da tela atual e uma entrada em fade + leve descida da nova.
// A navegação em si é SEMPRE executada, mesmo que a animação falhe ou esteja desligada.
function transicionarTela(navegar) {
  if (transicaoEmAndamento) return;

  const executarNavegacao = () => {
    navegar();
    const titulo = obterTituloParaFoco();
    if (titulo) {
      if (!titulo.hasAttribute("tabindex")) titulo.setAttribute("tabindex", "-1");
      titulo.focus({ preventScroll: true });
    }
  };

  if (deveReduzirMovimento()) {
    executarNavegacao();
    return;
  }

  transicaoEmAndamento = true;
  const telaOrigem = obterElementoDaTela(telaAtual);
  if (telaOrigem) telaOrigem.classList.add("transicao-saindo");

  setTimeout(() => {
    let telaDestino = null;
    try {
      if (telaOrigem) telaOrigem.classList.remove("transicao-saindo");
      executarNavegacao();

      telaDestino = obterElementoDaTela(telaAtual);
      // Saindo do portal o cabeçalho reaparece; entra junto com a tela de destino
      const topbar = document.querySelector(".topbar");
      [telaDestino, topbar].forEach((el) => el && el.classList.add("transicao-entrando"));
    } finally {
      // Libera a navegação logo após a troca; a entrada é só visual
      transicaoEmAndamento = false;
    }

    setTimeout(() => {
      document
        .querySelectorAll(".transicao-entrando")
        .forEach((el) => el.classList.remove("transicao-entrando"));
    }, DURACAO_ENTRADA_TRANSICAO_MS + 50);
  }, DURACAO_SAIDA_TRANSICAO_MS);
}

// O botão de retorno da Equipe mostra o destino real: "Início" ou "Resumo dos núcleos"
// O texto visível é sempre "Voltar" (botão animado); só o nome acessível acompanha o destino
// real do retorno, que continua sendo decidido pelo clique (origemEquipeDiagramacao)
function atualizarRotuloVoltarEquipe() {
  const botao = document.getElementById("btn-voltar-resumo-equipe");
  if (!botao) return;
  const destino = origemEquipeDiagramacao === "inicio" ? "Voltar ao início" : "Voltar ao Resumo dos núcleos";
  botao.setAttribute("aria-label", destino);
  botao.title = destino;
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

// ===================== RELATÓRIOS DE PERFORMANCE (PDF) ===================== //
//
// Área gerencial: o botão só aparece na tela do Resumo (que já passou pelo modal de
// senha). Obs.: essa senha é validada no próprio navegador - não é autenticação de
// servidor; o comportamento atual foi preservado.
//
// Geração do PDF: SEM bibliotecas externas e SEM enviar dados a terceiros. O relatório
// é montado em HTML/SVG num iframe oculto e impresso pelo navegador ("Salvar como PDF"),
// com CSS de impressão (@page, quebras de página controladas, paginação).
//
// Regras temporais (exibidas no próprio relatório):
//  · Atividades atribuídas no período: Início dentro do período (sem Início válido:
//    data de criação). Concluídas / Em andamento / Pendentes = situação ATUAL dessas
//    mesmas atividades (somam o total) -> Taxa de conclusão = concluídas ÷ atribuídas.
//  · Entregas no período: atividades Finalizadas com Fim dentro do período (qualquer data
//    de atribuição). No prazo = Fim ≤ Previsto; com atraso = Fim > Previsto; sem Previsto
//    válido = não classificadas. % no prazo = no prazo ÷ entregas com Previsto.
//  · Datas validadas por obterDataPlausivelDemanda; dias no fuso America/Recife.

let tipoRelatorioAberto = null; // "colecao" | "individual"
let relatorioEmGeracao = false;

// ── Cadastro de coleções (reaproveita o cadastro do portal: AREAS_INICIO_*) ──
// Coleção = 1º trecho do subtítulo do núcleo (ex.: "Ludus · 1º ao 5º ano..." -> Ludus).
// Núcleo real = nome do setor no cadastro da planilha (encontrarSetorConfigurado).
function obterColecoesRelatorio() {
  const colecoes = AREAS_INICIO_NUCLEOS.map((area) => ({
    tipo: "colecao",
    nome: String(area.subtitulo || area.rotulo).split(" · ")[0],
    rotulo: `${String(area.subtitulo || area.rotulo).split(" · ")[0]} — ${area.rotulo}`,
    nucleo: encontrarSetorConfigurado(area.nomes) || area.nomes[0],
  }));
  // Unidades operacionais (não são coleções): só as que existem no cadastro ou nas demandas
  const nucleosExistentes = new Set(obterOpcoesNucleoMapa().map((o) => o.chave));
  const unidades = AREAS_INICIO_ESPECIALIZADA
    .map((area) => ({ tipo: "unidade", nome: area.rotulo, rotulo: area.rotulo, nucleo: encontrarSetorConfigurado(area.nomes) || area.nomes[0] }))
    .filter((u) => nucleosExistentes.has(obterChaveNucleoMapa(u.nucleo)));
  return { colecoes, unidades };
}

// ── Datas do período ──
function converterDataInputEmDia(valor) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor || ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function formatarDiaInput(msUtc) {
  const d = new Date(msUtc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function obterDiaDaData(valor) {
  const r = obterDataPlausivelDemanda(valor);
  return r.data ? obterDiaOperacional(r.data) : null;
}

// ── Cálculo do relatório (uma passagem pela lista recebida) ──
function calcularRelatorioPerformance(lista, diaInicio, diaFim) {
  const noPeriodo = (dia) => dia !== null && dia >= diaInicio && dia <= diaFim;
  const r = {
    atribuidas: [], concluidas: 0, emAndamento: 0, pendentes: 0,
    entregas: [], noPrazo: 0, comAtraso: 0, semPrevisto: 0,
    entregasPorDia: new Map(), porDiagramador: new Map(),
  };
  const linhaDiag = (nome) => {
    const chave = normalizarNome(nome) || "(sem diagramador)";
    if (!r.porDiagramador.has(chave)) {
      r.porDiagramador.set(chave, { nome: nome || "(sem diagramador)", atribuidas: 0, concluidas: 0, emAndamento: 0, pendentes: 0, entregas: 0, noPrazo: 0, comAtraso: 0 });
    }
    return r.porDiagramador.get(chave);
  };

  lista.forEach((d) => {
    const nome = String(d.diagramador || "").trim();
    const diaRef = obterDiaDaData(d.inicio) ?? obterDiaDaData(d.dataCriacao);
    if (noPeriodo(diaRef)) {
      r.atribuidas.push(d);
      const l = linhaDiag(nome);
      l.atribuidas += 1;
      if (statusEhFinalizado(d.status)) { r.concluidas += 1; l.concluidas += 1; }
      else if (statusEhEmProcesso(d.status)) { r.emAndamento += 1; l.emAndamento += 1; }
      else { r.pendentes += 1; l.pendentes += 1; }
    }

    if (statusEhFinalizado(d.status)) {
      const fim = obterDataPlausivelDemanda(d.fim).data;
      const diaFimDemanda = fim ? obterDiaOperacional(fim) : null;
      if (noPeriodo(diaFimDemanda)) {
        r.entregas.push(d);
        r.entregasPorDia.set(diaFimDemanda, (r.entregasPorDia.get(diaFimDemanda) || 0) + 1);
        const l = linhaDiag(nome);
        l.entregas += 1;
        const previsto = obterDataPlausivelDemanda(d.previsto).data;
        if (!previsto) r.semPrevisto += 1;
        else if (fim <= previsto) { r.noPrazo += 1; l.noPrazo += 1; }
        else { r.comAtraso += 1; l.comAtraso += 1; }
      }
    }
  });
  return r;
}

// Série de evolução: diária até 62 dias; acima disso, semanal (semana seg–dom)
// opcoes.diasOperacionais (só o Relatório Individual usa), na série DIÁRIA:
//  · sábado/domingo sem entrega não entram no eixo (sem espaço vazio);
//  · sábado/domingo com entrega e todos os feriados (mesmo sem entrega, valor 0) entram;
//  · feriados vêm de obterFeriadoPernambuco (mesma fonte do mapa de calor) e são marcados.
// opcoes.ocultarFimDeSemanaSemEntrega (relatório de Coleção), na série DIÁRIA: sábado/domingo
// sem entrega saem do eixo; seg-sex e fins de semana com entrega ficam. Feriados sem marcação.
// Sem opções, a série é a de sempre: todos os dias do período.
function montarSerieEvolucao(entregasPorDia, diaInicio, diaFim, opcoes = {}) {
  const dias = Math.round((diaFim - diaInicio) / MS_DIA) + 1;
  if (dias <= 62) {
    const serie = [];
    for (let d = diaInicio; d <= diaFim; d += MS_DIA) {
      const valor = entregasPorDia.get(d) || 0;
      if (!opcoes.diasOperacionais) {
        if (opcoes.ocultarFimDeSemanaSemEntrega && ehFimDeSemana(d) && !valor) continue;
        serie.push({ rotulo: formatarDiaMes(d, false), valor });
        continue;
      }
      const feriado = obterFeriadoPernambuco(d);
      if (!feriado && ehFimDeSemana(d) && !valor) continue;
      serie.push({ rotulo: formatarDiaMes(d, false), valor, feriado: feriado ? feriado.nome : null });
    }
    return { serie, granularidade: "diária" };
  }
  const porSemana = new Map();
  for (let d = diaInicio; d <= diaFim; d += MS_DIA) {
    const segunda = d - ((new Date(d).getUTCDay() + 6) % 7) * MS_DIA;
    porSemana.set(segunda, (porSemana.get(segunda) || 0) + (entregasPorDia.get(d) || 0));
  }
  return { serie: [...porSemana.entries()].map(([s, v]) => ({ rotulo: formatarDiaMes(s, false), valor: v })), granularidade: "semanal (semana iniciada em)" };
}

// ── Gráficos em SVG (strings) para o relatório ──
const COR_REL = { marinho: "#0b2e4f", azul: "#1e6495", verde: "#2e9e5b", vermelho: "#c0392b", cinza: "#c4cdd8", semPrevisao: "#7d8fa3", texto: "#4a5260" };

function svgBarrasHorizontaisRelatorio(itens, cor) {
  if (!itens.length || itens.every((i) => i.valor === 0)) return `<p class="vazio">Sem dados no período.</p>`;
  const max = Math.max(...itens.map((i) => i.valor));
  const alturaLinha = 22;
  const altura = itens.length * alturaLinha + 4;
  const linhas = itens.map((i, k) => {
    const y = k * alturaLinha + 4;
    const largura = max ? (i.valor / max) * 360 : 0;
    return `<text x="0" y="${y + 13}" font-size="10" fill="${COR_REL.texto}">${escaparTexto(i.rotulo)}</text>` +
      `<rect x="150" y="${y + 3}" width="${Math.max(largura, i.valor ? 2 : 0)}" height="13" rx="3" fill="${i.cor || cor}"/>` +
      `<text x="${156 + largura}" y="${y + 13}" font-size="10" font-weight="700" fill="${COR_REL.marinho}">${i.valor}</text>`;
  }).join("");
  return `<svg class="grafico" viewBox="0 0 560 ${altura}" width="100%" role="img">${linhas}</svg>`;
}

function svgColunasRelatorio(serie) {
  if (!serie.length || serie.every((p) => p.valor === 0)) return `<p class="vazio">Nenhuma entrega no período.</p>`;
  const max = Math.max(...serie.map((p) => p.valor));
  const temFeriado = serie.some((p) => p.feriado);
  const largura = 560, altura = temFeriado ? 182 : 170, base = 140, topo = 14, margem = 16;
  const passo = (largura - 2 * margem) / serie.length;
  const barra = Math.max(2, Math.min(18, passo * 0.7));
  // feriado sempre mostra a data (o FER fica sob ela); as datas vizinhas cedem o espaço
  const mostrarRotulo = (k) => serie[k].feriado ||
    ((serie.length <= 16 || k % Math.ceil(serie.length / 16) === 0) && !serie[k - 1]?.feriado && !serie[k + 1]?.feriado);
  const elementos = serie.map((p, k) => {
    const h = max ? ((p.valor / max) * (base - topo)) : 0;
    const x = margem + k * passo + (passo - barra) / 2;
    return `<rect x="${x}" y="${base - h}" width="${barra}" height="${h}" rx="2" fill="${COR_REL.azul}"/>` +
      (p.valor && serie.length <= 31 ? `<text x="${x + barra / 2}" y="${base - h - 3}" font-size="8" text-anchor="middle" fill="${COR_REL.marinho}">${p.valor}</text>` : "") +
      (mostrarRotulo(k) ? `<text x="${x + barra / 2}" y="${base + 12}" font-size="8" text-anchor="middle" fill="${COR_REL.texto}">${escaparTexto(p.rotulo)}</text>` : "") +
      // feriado: marcador discreto "FER" abaixo da data (linha própria, não colide com as datas)
      (p.feriado ? `<text x="${x + barra / 2}" y="${base + 23}" font-size="7" font-weight="700" text-anchor="middle" fill="#6b4fb0"><title>${escaparTexto(p.rotulo + " — Feriado: " + p.feriado)}</title>FER</text>` : "");
  }).join("");
  return `<svg class="grafico" viewBox="0 0 ${largura} ${altura}" width="100%" role="img">` +
    `<line x1="0" y1="${base}" x2="${largura}" y2="${base}" stroke="${COR_REL.cinza}" stroke-width="1"/>${elementos}</svg>` +
    `<p class="nota">Pico: ${max} entrega(s).${temFeriado ? " FER = feriado (nacional ou de Pernambuco). Sábados e domingos sem entrega não são exibidos." : ""}</p>`;
}

// Barra empilhada (100%) com legenda de valores - a cor nunca é a única pista
function svgDistribuicaoRelatorio(partes) {
  const total = partes.reduce((s, p) => s + p.valor, 0);
  if (!total) return `<p class="vazio">Sem dados no período.</p>`;
  let x = 0;
  const segmentos = partes.filter((p) => p.valor).map((p) => {
    const w = (p.valor / total) * 560;
    const s = `<rect x="${x}" y="0" width="${Math.max(w - 2, 1)}" height="22" fill="${p.cor}"/>`;
    x += w;
    return s;
  }).join("");
  const legenda = partes.map((p) =>
    `<span class="leg"><i style="background:${p.cor}"></i>${escaparTexto(p.rotulo)}: <b>${p.valor}</b> (${formatarPercentual(calcularPercentual(p.valor, total))})</span>`
  ).join("");
  return `<svg class="grafico" viewBox="0 0 560 22" width="100%" role="img">${segmentos}</svg><div class="legenda">${legenda}</div>`;
}

// ── Montagem do HTML do relatório ──
function cardRelatorio(rotulo, valor, regra, classe = "") {
  return `<div class="card ${classe}"><span class="valor">${escaparTexto(String(valor))}</span><span class="rotulo">${escaparTexto(rotulo)}</span><span class="regra">${escaparTexto(regra)}</span></div>`;
}

// Indicadores do relatório de Coleção: uma linha com 4 cards de mesma altura
// (atribuídas/concluídas/em andamento/pendentes/taxa seguem calculadas para os gráficos e a tabela)
function blocoIndicadoresRelatorio(r) {
  const comPrevisto = r.noPrazo + r.comAtraso;
  return `<div class="cards cards-4">` +
    cardRelatorio("Entregas no período", r.entregas.length, "Finalizadas com Fim no período") +
    cardRelatorio("No prazo", r.noPrazo, "Fim ≤ Previsto", "verde") +
    cardRelatorio("Com atraso", r.comAtraso, "Fim > Previsto", "vermelho") +
    cardRelatorio("% no prazo", formatarPercentual(calcularPercentual(r.noPrazo, comPrevisto)), `no prazo ÷ entregas com Previsto (${r.semPrevisto} sem Previsto)`) +
    `</div>`;
}

function documentoRelatorioHTML({ titulo, alvo, periodoTexto, corpo }) {
  const agora = new Date();
  const geradoEm = agora.toLocaleString("pt-BR", { timeZone: FUSO_OPERACIONAL, dateStyle: "short", timeStyle: "short" });
  const logo = new URL("assets/logo.png", window.location.href).href;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escaparTexto(titulo)} — ${escaparTexto(alvo)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; @bottom-right { content: "Página " counter(page) " de " counter(pages); font: 9px "Segoe UI", Arial, sans-serif; color: #8a94a3; } @bottom-left { content: "Sistema GGE de Ensino · KANBAN - SGGE"; font: 9px "Segoe UI", Arial, sans-serif; color: #8a94a3; } }
  @page capa { margin: 0; @bottom-right { content: none; } @bottom-left { content: none; } }
  @page contracapa { margin: 0; @bottom-right { content: none; } @bottom-left { content: none; } }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #1f2933; font-size: 11px; }
  .capa, .contracapa { height: 296mm; overflow: hidden; display: flex; flex-direction: column; justify-content: center; padding: 0 22mm; break-after: page; }
  .capa { page: capa; background: linear-gradient(160deg, #0b2e4f 0%, #103a60 60%, #1e6495 100%); color: #fff; }
  .capa .logo { background: #fff; border-radius: 10px; padding: 10px 14px; width: max-content; margin-bottom: 40px; }
  .capa .logo img { height: 46px; display: block; }
  .capa h1 { font-size: 30px; margin: 0 0 8px; } .capa h2 { font-size: 20px; font-weight: 500; margin: 0 0 28px; opacity: .95; }
  .capa p { margin: 4px 0; font-size: 12px; opacity: .9; }
  .contracapa { page: contracapa; break-after: auto; break-before: page; align-items: center; text-align: center; color: #0b2e4f; }
  .contracapa img { height: 52px; margin-bottom: 18px; } .contracapa p { color: #4a5260; margin: 4px 0; }
  .cabecalho { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0b2e4f; padding-bottom: 6px; margin-bottom: 14px; }
  .cabecalho img { height: 26px; } .cabecalho span { font-size: 10px; color: #4a5260; text-align: right; }
  h3 { color: #0b2e4f; font-size: 14px; margin: 18px 0 8px; break-after: avoid; }
  .secao { break-inside: avoid; margin-bottom: 10px; }
  .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 8px; break-inside: avoid; }
  .cards.cards-4 { grid-template-columns: repeat(4, 1fr); }
  .card { border: 1px solid #dde3ea; border-left: 4px solid #0b2e4f; border-radius: 6px; padding: 8px; background: #f7f9fc; display: flex; flex-direction: column; gap: 2px; }
  .card.verde { border-left-color: #2e9e5b; } .card.vermelho { border-left-color: #c0392b; }
  .card .valor { font-size: 18px; font-weight: 800; color: #0b2e4f; } .card .rotulo { font-weight: 600; } .card .regra { font-size: 8.5px; color: #6b7385; }
  .grafico { display: block; max-height: 230px; }
  .legenda { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; } .leg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5px; } thead { display: table-header-group; }
  th { background: #0b2e4f; color: #fff; text-align: left; padding: 5px 6px; font-weight: 600; } td { padding: 4px 6px; border-bottom: 1px solid #e3e7ee; vertical-align: top; }
  tr { break-inside: avoid; } tbody tr:nth-child(even) td { background: #f7f9fc; } td.num, th.num { text-align: right; }
  .ok { color: #1e7a45; font-weight: 600; } .atraso { color: #c0392b; font-weight: 600; } .neutro { color: #6b7385; }
  .vazio, .nota { color: #6b7385; font-size: 10px; margin: 4px 0; }
  .regras { border: 1px solid #dde3ea; border-radius: 6px; padding: 8px 10px; background: #fbfcfd; font-size: 9.5px; color: #4a5260; break-inside: avoid; }
  .regras { padding-left: 24px; } .regras li { margin: 2px 0; }
  .tabela-individual { table-layout: fixed; font-size: 8.5px; }
  .tabela-individual th, .tabela-individual td { padding: 4px 4px; overflow-wrap: anywhere; border-left: 0; border-right: 0; }
  .tabela-individual th { vertical-align: bottom; }
  .mapa-rel-secao { break-after: avoid; margin-bottom: 4px; }
  .mr-grade { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 14px; margin-bottom: 10px; }
  .mr-mes { break-inside: avoid; border: 1px solid #dde3ea; border-radius: 6px; padding: 6px; }
  .mr-titulo { display: flex; justify-content: space-between; font-weight: 700; color: #0b2e4f; font-size: 10.5px; margin-bottom: 4px; }
  .mr-titulo span { font-weight: 600; color: #4a5260; font-size: 9px; }
  .mr-tabela { width: 100%; border-collapse: separate; border-spacing: 2px; table-layout: fixed; font-size: 9px; }
  .mr-tabela th { background: #0b2e4f; color: #fff; padding: 2px 0; text-align: center; font-size: 8px; font-weight: 600; border-radius: 2px; }
  .mr-tabela td { position: relative; height: 26px; padding: 0; border: 0; border-radius: 3px; text-align: center; vertical-align: middle; background: transparent; }
  .mr-tabela tbody tr:nth-child(even) td.mr-vazia { background: transparent; }
  .mr-dia { position: absolute; top: 1px; left: 3px; font-size: 7px; color: #4a5260; }
  .mr-escura .mr-dia, .mr-escura .mr-qtd { color: #fff; }
  .mr-qtd { font-weight: 800; font-size: 10.5px; color: #0b3d6b; }
  .mr-ponto { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #217847; }
  .mr-fer { position: absolute; bottom: 1px; right: 2px; padding: 0 2px; border-radius: 2px; background: #ede7fb; color: #4c2f91; font-size: 6.5px; font-weight: 700; }
  .mr-tabela td.mr-execucao, .mr-amostra.mr-execucao { background: #dcede2; box-shadow: inset 0 0 0 1px rgba(33,120,71,.35); }
  .mr-tabela td.mr-sem-registro, .mr-amostra.mr-sem-registro { background: #f8dddf; box-shadow: inset 0 0 0 1px rgba(157,52,52,.25); }
  .mr-tabela td.mr-fim-de-semana, .mr-tabela td.mr-feriado, .mr-tabela td.mr-futuro, .mr-amostra.mr-fim-de-semana { background: #eceff3; }
  .mr-tabela td.mr-nao-operacional { box-shadow: inset 0 0 0 2px #c4cdd8; }
  .mr-legenda { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 9.5px; color: #4a5260; margin: 2px 0 2px; }
  .mr-legenda span { display: inline-flex; align-items: center; gap: 5px; }
  .mr-amostra { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 11px; border-radius: 2px; }
  .mr-amostra .mr-ponto { width: 4px; height: 4px; }
  .mr-concluidas-amostra { background: linear-gradient(90deg, #b8d3ec, #0b3d6b); }
  .mr-fer-legenda { position: static; font-size: 7px; }
  .mr-fer-topo { top: 1px; bottom: auto; }
  .mc-mes { break-inside: avoid; margin: 0 0 12px; }
  .mc-titulo { font-weight: 700; color: #0b2e4f; font-size: 11px; margin: 0 0 4px; }
  .mc-tabela { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 1.5px; font-size: 7.5px; }
  .mc-tabela col.mc-col-nome { width: 25mm; }
  .mc-tabela th, .mc-tabela td { padding: 0; border: 0; text-align: center; vertical-align: middle; }
  .mc-tabela thead th { background: #0b2e4f; color: #fff; font-weight: 600; border-radius: 2px; height: 20px; line-height: 1.05; }
  .mc-tabela thead th span { display: block; font-size: 7.5px; } .mc-tabela thead th small { display: block; font-size: 6px; opacity: .85; }
  .mc-tabela thead th.mc-canto { text-align: left; padding-left: 4px; font-size: 8px; }
  .mc-tabela thead th.mc-fds { background: #33506d; } .mc-tabela thead th.mc-cab-feriado { background: #5b4a8a; }
  .mc-tabela thead th.mc-hoje { box-shadow: inset 0 -2.5px 0 #dc3545; }
  .mc-tabela thead th.mc-vazia, .mc-tabela td.mc-vazia { background: transparent !important; }
  .mc-tabela tbody th.mc-nome { background: #f7f9fc !important; text-align: left; padding: 2px 4px; font-weight: 600; font-size: 8px; color: #1f2933; border-radius: 2px; }
  .mc-tabela tbody th.mc-nome small { display: block; font-weight: 400; font-size: 6.5px; color: #6b7385; }
  .mc-tabela tbody td { height: 18px; line-height: 1.1; border-radius: 2px; font-weight: 800; font-size: 8px; color: #0b3d6b; }
  .mc-tabela tbody tr td.mc-execucao { background: #dcede2 !important; box-shadow: inset 0 0 0 1px rgba(33,120,71,.35); }
  .mc-tabela tbody tr td.mc-sem-registro { background: #f8dddf !important; box-shadow: inset 0 0 0 1px rgba(157,52,52,.25); }
  .mc-tabela tbody tr td.mc-fim-de-semana, .mc-tabela tbody tr td.mc-feriado, .mc-tabela tbody tr td.mc-futuro { background: #eceff3 !important; }
  .mc-tabela tbody td.mc-escura { color: #fff; }
  .mc-tabela tbody td.mc-nao-operacional { box-shadow: inset 0 0 0 1.5px #c4cdd8; }
  .mc-tabela tbody td.mc-hoje { outline: 1.5px solid #dc3545; outline-offset: -1px; }
  .mc-qtd { display: block; }
  .mc-ponto { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #217847; }
  .mc-fer { display: block; width: max-content; margin: 0 auto; font-size: 4.5px; font-weight: 700; color: #4c2f91; background: #ede7fb; padding: 0 1px; border-radius: 1px; line-height: 1.25; }
  .mc-hoje-amostra { background: #fff; outline: 1.5px solid #dc3545; outline-offset: -1px; }
  .pizza-rel { display: flex; align-items: center; gap: 28px; break-inside: avoid; }
  .pizza-rel svg { flex: none; }
  .pizza-rel-legenda { display: flex; flex-direction: column; gap: 6px; font-size: 11px; }
  .pizza-leg { display: grid; grid-template-columns: 12px 140px 36px 50px; align-items: center; gap: 6px; }
  .pizza-leg i { width: 11px; height: 11px; border-radius: 2px; } .pizza-leg b { text-align: right; color: #0b2e4f; } .pizza-leg .pct { text-align: right; color: #4a5260; }
  .tabela-individual .c-atividade { width: 19%; } .tabela-individual .c-ano { width: 6%; } .tabela-individual .c-modulo { width: 6.5%; }
  .tabela-individual .c-frente { width: 9%; } .tabela-individual .c-data { width: 9.5%; } .tabela-individual .c-to { width: 9.5%; }
  .tabela-individual .c-status { width: 9%; } .tabela-individual .c-condicao { width: 12.5%; }
  .tabela-individual td.num, .tabela-individual th.num { text-align: right; white-space: nowrap; }
  .tabela-individual td.num.atraso { white-space: normal; overflow-wrap: normal; font-size: 7.5px; }
  .tabela-individual thead tr { background: #0b2e4f; }
  .tabela-individual th { border: 0; box-shadow: 0 0 0 0.5px #0b2e4f; }
  .tabela-individual td.num, .tabela-individual th.num { padding-right: 8px; }
</style></head><body>
<section class="capa">
  <div class="logo"><img src="${logo}" alt="GGE"></div>
  <h1>${escaparTexto(titulo)}</h1>
  <h2>${escaparTexto(alvo)}</h2>
  <p>Período analisado: ${escaparTexto(periodoTexto)}</p>
  <p>Gerado em: ${escaparTexto(geradoEm)}</p>
  <p>KANBAN - SGGE · Performance dos Núcleos</p>
</section>
<main>
  <div class="cabecalho"><img src="${logo}" alt="GGE"><span>${escaparTexto(titulo)} · ${escaparTexto(alvo)}<br>${escaparTexto(periodoTexto)}</span></div>
  ${corpo}
  <div class="secao"><h3>Regras de cálculo</h3><ul class="regras">
    <li><b>Atividades atribuídas:</b> Início dentro do período (sem Início válido: data de criação). Concluídas, em andamento e pendentes referem-se à situação atual dessas atividades.</li>
    <li><b>Entregas no período:</b> atividades Finalizadas com data de Fim dentro do período, independentemente de quando foram atribuídas.</li>
    <li><b>No prazo / com atraso:</b> comparação entre Fim e Previsto das entregas do período; entregas sem Previsto válido não são classificadas.</li>
    <li>Datas inválidas ou com ano implausível são desconsideradas; os dias seguem o fuso America/Recife. Nenhum dado da planilha é alterado.</li>
  </ul></div>
</main>
<section class="contracapa">
  <img src="${logo}" alt="GGE">
  <p><b>Sistema GGE de Ensino</b></p>
  <p>Equipe de Diagramação · Relatório gerado pelo KANBAN - SGGE</p>
</section>
</body></html>`;
}

function formatarDataHoraRelatorio(valor) {
  const r = obterDataPlausivelDemanda(valor);
  if (!r.data) return valor ? "inválida" : "–";
  return r.data.toLocaleString("pt-BR", { timeZone: FUSO_OPERACIONAL, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// T.O. (Tempo de Operação ÚTIL) = minutos de INÍCIO a FIM que caem dentro do expediente
// configurado em JORNADA_TRABALHO (07:00-16:30, seg-sex, menos almoço e intervalo), pela
// mesma rotina do tempo médio da Performance (calcularMinutosUteis). Sem feriados.
// Enquanto os HORÁRIOS das pausas não forem configurados, dias parciais não têm desconto
// de pausa e o valor sai marcado como aproximado ("≈", limite superior) - nunca como exato.
// Sábados/domingos com entrega do profissional: dias (ms UTC de calendário, fuso operacional)
// em que ELE tem ao menos uma atividade Finalizada com FIM válido - mesma regra das
// conclusões (azul) do mapa de calor. Entregas de outros diagramadores não contam.
function obterFinsDeSemanaComEntrega(listaDoProfissional, nome) {
  const chave = normalizarNome(nome);
  const dias = new Set();
  listaDoProfissional.forEach((d) => {
    if (normalizarNome(d.diagramador) !== chave || !statusEhFinalizado(d.status)) return;
    const fim = obterDataPlausivelDemanda(d.fim).data;
    if (!fim) return;
    const dia = obterDiaOperacional(fim);
    if (ehFimDeSemana(dia)) dias.add(dia);
  });
  return dias;
}

// T.O. de fim de semana (regra automática do Relatório Individual):
//  · seg-sex: cálculo normal da jornada (calcularMinutosUteis, inalterado);
//  · sáb/dom: só entra o dia em que o profissional tem entrega registrada E em que a
//    PRÓPRIA atividade começa ou termina; conta só o trecho dela dentro do expediente
//    (07:00-16:30, mesmas pausas). Um fim de semana inteiro atravessado pela atividade
//    (sem Início nem Fim nele) não ganha horas, mesmo que haja entrega de outra tarefa.
function calcularMinutosFimDeSemanaComprovados(dInicio, dFim, finsDeSemanaComEntrega) {
  let minutos = 0, aproximado = false;
  const diasVistos = new Set();
  [dInicio, dFim].forEach((data) => {
    const dia = obterDiaOperacional(data);
    if (diasVistos.has(dia) || !ehFimDeSemana(dia) || !finsDeSemanaComEntrega.has(dia)) return;
    diasVistos.add(dia);
    const diaLocal = new Date(data.getFullYear(), data.getMonth(), data.getDate());
    const r = calcularMinutosUteisNoDia(diaLocal, dInicio, dFim, true);
    minutos += r.minutos;
    aproximado = aproximado || r.aproximado;
  });
  return { minutos, aproximado };
}

function calcularTempoOperacao(inicio, fim, finsDeSemanaComEntrega = new Set()) {
  if (!String(inicio || "").trim() || !String(fim || "").trim()) return { minutos: null, texto: "—" };
  const dInicio = obterDataPlausivelDemanda(inicio).data;
  const dFim = obterDataPlausivelDemanda(fim).data;
  if (!dInicio || !dFim) return { minutos: null, texto: "Data inconsistente" };
  const r = calcularMinutosUteis(dInicio, dFim);
  if (!r.valido) return { minutos: null, texto: "Data inconsistente" };
  const fds = calcularMinutosFimDeSemanaComprovados(dInicio, dFim, finsDeSemanaComEntrega);
  const minutos = Math.round(r.minutos + fds.minutos);
  const aproximado = r.aproximado || fds.aproximado;
  return { minutos, aproximado, minutosFimDeSemana: Math.round(fds.minutos), texto: (aproximado ? "≈ " : "") + formatarDuracaoOperacao(minutos) };
}

// 25 -> "25min" | 90 -> "1h30min" | 495 -> "8h15min" | 990 -> "16h30min" | 120 -> "2h"
function formatarDuracaoOperacao(minutos) {
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  if (horas && resto) return `${horas}h${String(resto).padStart(2, "0")}min`;
  if (horas) return `${horas}h`;
  return `${resto}min`;
}

// Participação no Núcleo: atribuídas do profissional no núcleo ÷ atribuídas no núcleo
// (todos os diagramadores), mesmo critério de atribuição do card "Atividades atribuídas"
// (calcularRelatorioPerformance) e sem repetir IDs. Denominador zero -> null ("—").
function calcularParticipacaoNoNucleo(todas, nome, nucleo, diaInicio, diaFim) {
  const chave = obterChaveNucleoMapa(nucleo);
  const vistos = new Set();
  const doNucleo = todas.filter((d) => {
    if (obterChaveNucleoMapa(obterNucleoDaDemanda(d)) !== chave) return false;
    const id = String(d.id || "").trim();
    if (id) { if (vistos.has(id)) return false; vistos.add(id); }
    return true;
  });
  const noNucleo = calcularRelatorioPerformance(doNucleo, diaInicio, diaFim).atribuidas;
  const doProfissional = noNucleo.filter((d) => normalizarNome(d.diagramador) === normalizarNome(nome)).length;
  return {
    nucleo,
    numerador: doProfissional,
    denominador: noNucleo.length,
    percentual: noNucleo.length ? calcularPercentual(doProfissional, noNucleo.length) : null,
  };
}

// Pizza das entregas do período (Finalizadas com Fim válido; classificação feita em
// calcularRelatorioPerformance, cada entrega em UMA categoria):
//   No prazo (Fim <= Previsto) | Com atraso (Fim > Previsto) | Sem previsão (Previsto ausente/inválido)
// Percentuais sobre o total das três categorias.
function svgPizzaPrazoRelatorio(noPrazo, comAtraso, semPrevisto) {
  const partes = [
    { rotulo: "No prazo", valor: noPrazo, cor: COR_REL.verde },
    { rotulo: "Com atraso", valor: comAtraso, cor: COR_REL.vermelho },
    { rotulo: "Entregas sem previsão", valor: semPrevisto, cor: COR_REL.semPrevisao },
  ];
  const total = noPrazo + comAtraso + semPrevisto;
  if (!total) return `<p class="vazio">Nenhuma entrega concluída no período.</p>`;
  const cx = 80, cy = 80, raio = 72;
  const ponto = (a, r) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const fmt = (xy) => `${xy[0].toFixed(2)} ${xy[1].toFixed(2)}`;
  let angulo = -Math.PI / 2;
  const fatias = partes.filter((p) => p.valor).map((p) => {
    const fracao = p.valor / total;
    const pct = formatarPercentual(calcularPercentual(p.valor, total));
    if (fracao >= 1) {
      return `<circle cx="${cx}" cy="${cy}" r="${raio}" fill="${p.cor}"/>` +
        `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">${pct}</text>`;
    }
    const a0 = angulo, a1 = angulo + fracao * 2 * Math.PI;
    angulo = a1;
    const [tx, ty] = ponto((a0 + a1) / 2, raio * 0.62);
    // percentual dentro da fatia só quando há espaço (fatias a partir de 8%)
    const rotulo = fracao >= 0.08
      ? `<text x="${tx.toFixed(2)}" y="${(ty + 4).toFixed(2)}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${pct}</text>`
      : "";
    return `<path d="M ${cx} ${cy} L ${fmt(ponto(a0, raio))} A ${raio} ${raio} 0 ${fracao > 0.5 ? 1 : 0} 1 ${fmt(ponto(a1, raio))} Z" fill="${p.cor}" stroke="#fff" stroke-width="1.5"/>${rotulo}`;
  }).join("");
  const legenda = partes.map((p) =>
    `<div class="pizza-leg"><i style="background:${p.cor}"></i><span>${escaparTexto(p.rotulo)}</span><b>${p.valor}</b><span class="pct">${formatarPercentual(calcularPercentual(p.valor, total))}</span></div>`
  ).join("");
  const descricao = partes.map((p) => `${p.rotulo} ${p.valor}`).join(", ");
  return `<div class="pizza-rel"><svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="${escaparTexto(descricao)}">${fatias}</svg>` +
    `<div class="pizza-rel-legenda">${legenda}</div></div>`;
}

function condicaoPrazoRelatorio(d, agoraMs) {
  const previsto = obterDataPlausivelDemanda(d.previsto).data;
  if (statusEhFinalizado(d.status)) {
    const fim = obterDataPlausivelDemanda(d.fim).data;
    if (!fim || !previsto) return `<span class="neutro">Sem previsto</span>`;
    return fim <= previsto ? `<span class="ok">No prazo</span>` : `<span class="atraso">Com atraso</span>`;
  }
  if (!previsto) return `<span class="neutro">Em aberto</span>`;
  return previsto.getTime() < agoraMs ? `<span class="atraso">Em aberto — prazo vencido</span>` : `<span class="neutro">Em aberto — no prazo</span>`;
}

// ── Mapa de calor do relatório individual ──
// Reaproveita a lógica do mapa da Performance: calcularMapaCalorConclusoes (conclusões por
// dia e intervalos de execução), filtrarMapaCalorPorMes (recorte e "em execução" por dia),
// classificarDiaMapaCalor (prioridade das situações), obterCorMapaCalor (escala de azul) e
// obterFeriadoPernambuco (feriados). Só muda o desenho: um calendário mensal compacto
// (Seg–Dom) por mês do período, adequado ao A4. Somente o diagramador do relatório.
const NOMES_MES_RELATORIO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
  "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

function calcularMapaCalorRelatorio(listaDoProfissional, nome, diaInicio, diaFim, agoraMs) {
  const chave = normalizarNome(nome);
  const consultaFerias = criarConsultaFeriasMapa();
  let diasFerias = 0;
  const lista = listaDoProfissional.filter((d) => normalizarNome(d.diagramador) === chave);
  const mapa = calcularMapaCalorConclusoes(lista);
  const meses = [];
  const inicio = new Date(diaInicio);
  let ano = inicio.getUTCFullYear(), mes = inicio.getUTCMonth() + 1;
  let totalConclusoes = 0, diasExecucao = 0;
  while (Date.UTC(ano, mes - 1, 1) <= diaFim) {
    const recorte = filtrarMapaCalorPorMes(mapa, ano, mes, agoraMs);
    const linha = recorte.linhas[0] || { dias: new Map(), execucao: new Map() };
    const dias = recorte.dias.filter((d) => d >= diaInicio && d <= diaFim).map((d) => {
      const conclusoes = linha.dias.get(d) || 0;
      const execucao = linha.execucao.get(d) || 0;
      totalConclusoes += conclusoes;
      const situacaoAtividade = classificarDiaMapaCalor(conclusoes, execucao, d, recorte.hoje);
      if (situacaoAtividade === "execucao") diasExecucao += 1;
      const ferias = !!consultaFerias.periodo(nome, d);
      if (ferias) diasFerias += 1;
      const situacao = classificarDiaMapaCalorComFerias(conclusoes, execucao, d, recorte.hoje, ferias);
      return { dia: d, conclusoes, situacao, feriado: obterFeriadoPernambuco(d), ferias, execucao };
    });
    // escala de azul pelo maior valor do bloco exibido (mesma regra do mapa: máximo do recorte)
    const maximo = dias.reduce((m, d) => Math.max(m, d.conclusoes), 0);
    meses.push({ ano, mes, dias, maximo });
    mes += 1;
    if (mes > 12) { mes = 1; ano += 1; }
  }
  return { meses, totalConclusoes, diasExecucao, diasFerias, feriasDisponiveis: consultaFerias.disponivel };
}

function corpoMapaCalorRelatorio(listaDoProfissional, nome, diaInicio, diaFim, agoraMs) {
  const { meses, totalConclusoes, diasExecucao } = calcularMapaCalorRelatorio(listaDoProfissional, nome, diaInicio, diaFim, agoraMs);
  const cabecalho = `<h3>Mapa de calor — atividades por dia e diagramador</h3>` +
    `<p class="nota">Distribuição diária das atividades do profissional no período selecionado. Diagramador: <b>${escaparTexto(nome)}</b> · ${totalConclusoes} conclusão(ões) no período.</p>`;
  if (!totalConclusoes && !diasExecucao) {
    return `<div class="secao mapa-rel-secao">${cabecalho}<p class="vazio">Nenhuma atividade concluída ou em andamento registrada no período.</p></div>`;
  }
  const blocos = meses.map(({ ano, mes, dias, maximo }) => {
    const celulas = [];
    // posição da 1ª data na grade Seg..Dom
    const primeiro = new Date(dias[0].dia).getUTCDay();
    for (let i = 0; i < (primeiro + 6) % 7; i++) celulas.push(`<td class="mr-vazia"></td>`);
    dias.forEach(({ dia, conclusoes, situacao, feriado }) => {
      const numeroDia = new Date(dia).getUTCDate();
      let estilo = "", classe = `mr-${situacao}`, conteudo = "";
      if (situacao === "concluidas") {
        const cor = obterCorMapaCalor(conclusoes, maximo);
        estilo = ` style="background:${cor.fundo}"`;
        if (cor.textoClaro) classe += " mr-escura";
        conteudo = `<span class="mr-qtd">${conclusoes}</span>`;
        if (feriado || ehFimDeSemana(dia)) classe += " mr-nao-operacional"; // marca discreta
      } else if (situacao === "execucao") {
        conteudo = `<span class="mr-ponto"></span>`;
      }
      if (feriado) conteudo += `<span class="mr-fer${conclusoes ? " mr-fer-topo" : ""}">FER</span>`;
      const titulo = `${formatarDiaMes(dia, true)} — ${NOMES_DIA_SEMANA[new Date(dia).getUTCDay()]}` +
        (feriado ? ` · Feriado: ${feriado.nome}` : "") + ` · ${ROTULO_SITUACAO_MAPA[situacao]} · Conclusões: ${conclusoes}`;
      celulas.push(`<td class="${classe}"${estilo} title="${escaparTexto(titulo)}"><span class="mr-dia">${numeroDia}</span>${conteudo}</td>`);
    });
    while (celulas.length % 7) celulas.push(`<td class="mr-vazia"></td>`);
    const linhas = [];
    for (let i = 0; i < celulas.length; i += 7) linhas.push(`<tr>${celulas.slice(i, i + 7).join("")}</tr>`);
    const cab = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((d) => `<th>${d}</th>`).join("");
    const concl = dias.reduce((s, d) => s + d.conclusoes, 0);
    return `<div class="mr-mes"><div class="mr-titulo">${NOMES_MES_RELATORIO[mes - 1]} ${ano}<span>${concl} concl.</span></div>` +
      `<table class="mr-tabela"><thead><tr>${cab}</tr></thead><tbody>${linhas.join("")}</tbody></table></div>`;
  }).join("");
  const legenda = `<div class="mr-legenda">` +
    `<span><i class="mr-amostra mr-concluidas-amostra"></i>Concluídas (nº de conclusões no dia)</span>` +
    `<span><i class="mr-amostra mr-execucao"><span class="mr-ponto"></span></i>Em andamento</span>` +
    `<span><i class="mr-amostra mr-sem-registro"></i>Sem registro</span>` +
    `<span><i class="mr-amostra mr-fim-de-semana"></i>Não operacional (fim de semana sem entrega, feriado, dia futuro)</span>` +
    `<span><b class="mr-fer mr-fer-legenda">FER</b>Feriado</span></div>` +
    `<p class="nota">As cores representam os registros operacionais disponíveis e não constituem controle de presença ou frequência.</p>`;
  return `<div class="secao mapa-rel-secao">${cabecalho}${legenda}</div><div class="mr-grade">${blocos}</div>`;
}

function descreverJornadaRelatorio() {
  return `${JORNADA_TRABALHO.inicioExpediente}–${JORNADA_TRABALHO.fimExpediente}, seg–sex, ${formatarDuracaoOperacao(obterMinutosDiaUtil())} úteis por dia, sem feriados`;
}

// ── Mapa de calor do relatório de Coleção ──
// Mesma lógica do mapa da Performance: calcularMapaCalorConclusoes (conclusões por dia e
// intervalos de execução), filtrarMapaCalorPorMes (recorte mensal e "em execução"),
// classificarDiaMapaCalor (prioridade das situações), obterCorMapaCalor (escala de azul) e
// obterFeriadoPernambuco. Entrada: SOMENTE as demandas da coleção (já filtradas pelo núcleo
// gravado em cada demanda), sem repetir ID. Um bloco por mês: diagramadores x dias.
const LETRA_DIA_SEMANA = ["D", "S", "T", "Q", "Q", "S", "S"];

// Dados do mapa da coleção (sem desenho): meses do período e participantes ordenados
function calcularMapaCalorColecao(listaDaColecao, diaInicio, diaFim, agoraMs) {
  const vistos = new Set();
  const lista = listaDaColecao.filter((d) => {
    const id = String(d.id || "").trim();
    if (!id) return true;
    if (vistos.has(id)) return false;
    vistos.add(id);
    return true;
  });
  const mapa = calcularMapaCalorConclusoes(lista);

  // Recortes mensais do período (ano a ano, sem misturar anos)
  const meses = [];
  const inicio = new Date(diaInicio);
  let ano = inicio.getUTCFullYear(), mes = inicio.getUTCMonth() + 1;
  while (Date.UTC(ano, mes - 1, 1) <= diaFim) {
    const recorte = filtrarMapaCalorPorMes(mapa, ano, mes, agoraMs);
    meses.push({ ano, mes, recorte, dias: recorte.dias.filter((d) => d >= diaInicio && d <= diaFim) });
    mes += 1;
    if (mes > 12) { mes = 1; ano += 1; }
  }

  // Participantes: quem tem conclusão ou execução da coleção dentro do período; ordem pelo
  // total de conclusões no período (maior primeiro) - sem duplicar nomes
  const totais = new Map();
  meses.forEach(({ recorte, dias }) => recorte.linhas.forEach((linha) => {
    const chave = normalizarNome(linha.nome);
    const atual = totais.get(chave) || { nome: linha.nome, conclusoes: 0, ativo: false };
    dias.forEach((d) => {
      const c = linha.dias.get(d) || 0;
      atual.conclusoes += c;
      if (c || linha.execucao.get(d)) atual.ativo = true;
    });
    totais.set(chave, atual);
  }));
  const participantes = [...totais.values()].filter((t) => t.ativo)
    .sort((a, b) => b.conclusoes - a.conclusoes || a.nome.localeCompare(b.nome, "pt-BR"));
  return { meses, participantes };
}

function corpoMapaCalorColecao(listaDaColecao, diaInicio, diaFim, agoraMs) {
  const cabecalho = `<h3>Mapa de calor — atividades por dia e diagramador</h3>` +
    `<p class="nota">Distribuição diária das atividades dos diagramadores na coleção e no período selecionados.</p>`;
  const { meses, participantes } = calcularMapaCalorColecao(listaDaColecao, diaInicio, diaFim, agoraMs);
  if (!participantes.length) {
    return `<div class="secao">${cabecalho}<p class="vazio">Nenhuma atividade encontrada para a coleção no período selecionado.</p></div>`;
  }

  const blocos = meses.map(({ ano: a, mes: m, recorte, dias }) => {
    const porNome = new Map(recorte.linhas.map((l) => [normalizarNome(l.nome), l]));
    const vazias = (tag) => `<${tag} class="mc-vazia"></${tag}>`.repeat(31 - dias.length);
    const maximo = participantes.reduce((mx, p) => {
      const l = porNome.get(normalizarNome(p.nome));
      return l ? dias.reduce((x, d) => Math.max(x, l.dias.get(d) || 0), mx) : mx;
    }, 0);
    const cab = dias.map((d) => {
      const dt = new Date(d);
      const classes = [ehFimDeSemana(d) ? "mc-fds" : "", obterFeriadoPernambuco(d) ? "mc-cab-feriado" : "", d === recorte.hoje ? "mc-hoje" : ""].filter(Boolean).join(" ");
      return `<th class="${classes}"><span>${String(dt.getUTCDate()).padStart(2, "0")}</span><small>${LETRA_DIA_SEMANA[dt.getUTCDay()]}</small></th>`;
    }).join("");
    const linhas = participantes.map((p) => {
      const l = porNome.get(normalizarNome(p.nome)) || { dias: new Map(), execucao: new Map() };
      const conclMes = dias.reduce((x, d) => x + (l.dias.get(d) || 0), 0);
      const celulas = dias.map((d) => {
        const qtd = l.dias.get(d) || 0;
        const situacao = classificarDiaMapaCalor(qtd, l.execucao.get(d) || 0, d, recorte.hoje);
        const feriado = obterFeriadoPernambuco(d);
        let estilo = "", classe = `mc-${situacao}`, conteudo = "";
        if (situacao === "concluidas") {
          const cor = obterCorMapaCalor(qtd, maximo);
          estilo = ` style="background:${cor.fundo}"`;
          if (cor.textoClaro) classe += " mc-escura";
          if (feriado || ehFimDeSemana(d)) classe += " mc-nao-operacional";
          conteudo = `<span class="mc-qtd">${qtd}</span>`;
        } else if (situacao === "execucao") {
          conteudo = `<i class="mc-ponto"></i>`;
        }
        if (feriado) conteudo += `<b class="mc-fer">FER</b>`;
        if (d === recorte.hoje) classe += " mc-hoje";
        return `<td class="${classe}"${estilo}>${conteudo}</td>`;
      }).join("");
      return `<tr><th class="mc-nome">${escaparTexto(p.nome)}<small>${conclMes} concl.</small></th>${celulas}${vazias("td")}</tr>`;
    }).join("");
    // meses parciais completam as 31 colunas com células vazias: mesma largura em todos os blocos
    return `<div class="mc-mes"><div class="mc-titulo">${NOMES_MES_RELATORIO[m - 1]} ${a}</div>` +
      `<table class="mc-tabela"><colgroup><col class="mc-col-nome">${"<col>".repeat(31)}</colgroup>` +
      `<thead><tr><th class="mc-canto">Diagramador</th>${cab}${vazias("th")}</tr></thead><tbody>${linhas}</tbody></table></div>`;
  }).join("");
  const legenda = `<div class="mr-legenda">` +
    `<span><i class="mr-amostra mr-concluidas-amostra"></i>Concluídas (nº de entregas no dia)</span>` +
    `<span><i class="mr-amostra mr-execucao"><span class="mr-ponto"></span></i>Em andamento</span>` +
    `<span><i class="mr-amostra mr-sem-registro"></i>Sem registro</span>` +
    `<span><i class="mr-amostra mr-fim-de-semana"></i>Não operacional (fim de semana sem entrega, feriado, dia futuro)</span>` +
    `<span><b class="mr-fer mr-fer-legenda">FER</b>Feriado</span>` +
    `<span><i class="mr-amostra mc-hoje-amostra"></i>Hoje</span></div>` +
    `<p class="nota">As cores representam os registros operacionais disponíveis e não constituem controle de presença ou frequência.</p>`;
  return `<div class="secao mapa-rel-secao">${cabecalho}${legenda}</div>${blocos}`;
}

function corpoRelatorioColecao(r, diaInicio, diaFim, listaDaColecao = [], agoraMs = Date.now()) {
  const evolucao = montarSerieEvolucao(r.entregasPorDia, diaInicio, diaFim, { ocultarFimDeSemanaSemEntrega: true });
  const linhas = [...r.porDiagramador.values()].sort((a, b) => b.atribuidas - a.atribuidas || b.entregas - a.entregas || a.nome.localeCompare(b.nome, "pt-BR"));
  const tabela = linhas.length
    ? `<table><thead><tr><th>Diagramador</th><th class="num">Atribuídas</th><th class="num">Concluídas</th><th class="num">Em andamento</th><th class="num">Pendentes</th><th class="num">Entregas no período</th><th class="num">No prazo</th><th class="num">Com atraso</th><th class="num">% no prazo</th></tr></thead><tbody>` +
      linhas.map((l) => `<tr><td>${escaparTexto(l.nome)}</td><td class="num">${l.atribuidas}</td><td class="num">${l.concluidas}</td><td class="num">${l.emAndamento}</td><td class="num">${l.pendentes}</td><td class="num">${l.entregas}</td><td class="num">${l.noPrazo}</td><td class="num">${l.comAtraso}</td><td class="num">${formatarPercentual(calcularPercentual(l.noPrazo, l.noPrazo + l.comAtraso))}</td></tr>`).join("") +
      `</tbody></table>`
    : `<p class="vazio">Nenhum profissional com atividades no período.</p>`;
  return blocoIndicadoresRelatorio(r) +
    `<div class="secao"><h3>Conclusões por diagramador (entregas no período)</h3>${svgBarrasHorizontaisRelatorio([...linhas].sort((a, b) => b.entregas - a.entregas).map((l) => ({ rotulo: l.nome, valor: l.entregas })), COR_REL.azul)}</div>` +
    `<div class="secao"><h3>Evolução das entregas (${evolucao.granularidade})</h3>${svgColunasRelatorio(evolucao.serie)}</div>` +
    corpoMapaCalorColecao(listaDaColecao, diaInicio, diaFim, agoraMs) +
    `<h3>Profissionais vinculados à coleção</h3>${tabela}`;
}

function corpoRelatorioIndividual(r, part, diaInicio, diaFim, agoraMs, listaDoProfissional = [], nomeProfissional = "") {
  const finsDeSemanaComEntrega = obterFinsDeSemanaComEntrega(listaDoProfissional, nomeProfissional);
  const evolucao = montarSerieEvolucao(r.entregasPorDia, diaInicio, diaFim, { diasOperacionais: true });
  const participacao = part.percentual === null ? "—" : formatarPercentual(part.percentual);
  // Tabela: atividades atribuídas OU entregues no período (sem repetir), por Início
  const vistas = new Set();
  const atividades = [...r.atribuidas, ...r.entregas].filter((d) => (vistas.has(d) ? false : vistas.add(d)))
    .sort((a, b) => (obterDataPlausivelDemanda(a.inicio).data?.getTime() || 0) - (obterDataPlausivelDemanda(b.inicio).data?.getTime() || 0));
  const tabela = atividades.length
    ? `<table class="tabela-individual"><colgroup><col class="c-atividade"><col class="c-ano"><col class="c-modulo"><col class="c-frente"><col class="c-data"><col class="c-data"><col class="c-data"><col class="c-to"><col class="c-status"><col class="c-condicao"></colgroup>` +
      `<thead><tr><th>Atividade</th><th>Ano</th><th>Módulo</th><th>Frente</th><th>Início</th><th>Previsto</th><th>Fim</th><th class="num" title="Tempo de Operação">T.O.</th><th>Status</th><th>Condição do prazo</th></tr></thead><tbody>` +
      atividades.map((d) => {
        const to = calcularTempoOperacao(d.inicio, d.fim, finsDeSemanaComEntrega);
        const celulaTO = to.minutos === null && to.texto !== "—" ? `<td class="num atraso">${to.texto}</td>` : `<td class="num">${to.texto}</td>`;
        return `<tr><td>${escaparTexto(d.atividade || "–")}</td><td>${escaparTexto(d.anoEscolar || "–")}</td><td>${escaparTexto(d.modulo || "–")}</td><td>${escaparTexto(d.frente || "–")}</td><td>${formatarDataHoraRelatorio(d.inicio)}</td><td>${formatarDataHoraRelatorio(d.previsto)}</td><td>${formatarDataHoraRelatorio(d.fim)}</td>${celulaTO}<td>${escaparTexto(d.status || "–")}</td><td>${condicaoPrazoRelatorio(d, agoraMs)}</td></tr>`;
      }).join("") +
      `</tbody></table>`
    : `<p class="vazio">Nenhuma atividade no período.</p>`;
  // Indicadores do individual: uma linha com 5 cards (entregas, prazo e participação).
  // O relatório de coleção continua usando blocoIndicadoresRelatorio, sem alteração.
  const comPrevisto = r.noPrazo + r.comAtraso;
  return `<div class="cards">` +
    cardRelatorio("Entregas no período", r.entregas.length, "Finalizadas com Fim no período") +
    cardRelatorio("No prazo", r.noPrazo, "Fim ≤ Previsto", "verde") +
    cardRelatorio("Com atraso", r.comAtraso, "Fim > Previsto", "vermelho") +
    cardRelatorio("% no prazo", formatarPercentual(calcularPercentual(r.noPrazo, comPrevisto)), `no prazo ÷ entregas com Previsto (${r.semPrevisto} sem Previsto)`) +
    cardRelatorio("Participação no Núcleo", participacao, `Atividades atribuídas ao profissional ÷ atividades atribuídas no núcleo (${part.nucleo}: ${part.numerador} de ${part.denominador})`) +
    `</div>` +
    `<div class="secao"><h3>Evolução das conclusões (${evolucao.granularidade})</h3>${svgColunasRelatorio(evolucao.serie)}</div>` +
    `<div class="secao"><h3>Distribuição das atividades por status (atribuídas no período)</h3>${svgDistribuicaoRelatorio([
      { rotulo: "Concluídas", valor: r.concluidas, cor: COR_REL.azul }, { rotulo: "Em andamento", valor: r.emAndamento, cor: "#7aa7cf" }, { rotulo: "Pendentes", valor: r.pendentes, cor: COR_REL.cinza }])}</div>` +
    `<div class="secao"><h3>Entregas no prazo x com atraso</h3>${svgPizzaPrazoRelatorio(r.noPrazo, r.comAtraso, r.semPrevisto)}</div>` +
    corpoMapaCalorRelatorio(listaDoProfissional, nomeProfissional, diaInicio, diaFim, agoraMs) +
    `<h3>Atividades do período</h3><p class="nota">Inclui as atividades atribuídas no período e as entregues no período, de todos os núcleos em que o profissional atuou. T.O. — Tempo de Operação útil, calculado dentro do expediente, descontados almoço e intervalo (${escaparTexto(descreverJornadaRelatorio())}). Sábados e domingos entram somente nos dias com entrega registrada do profissional, e apenas no trecho em que a própria atividade começa ou termina nesse dia.${tabela.includes("≈") ? " ≈ = valor aproximado (limite superior): os horários das pausas ainda não estão configurados, então dias parciais não têm desconto de pausa." : ""}</p>${tabela}`;
}

// ===================== RELATÓRIO INDIVIDUAL: DOWNLOAD DIRETO EM PDF ===================== //
// O PDF é montado com pdfmake (texto e gráficos vetoriais, A4, cabeçalho da tabela repetido,
// "Página X de Y"), carregado do cdnjs só na primeira exportação. Os números, gráficos SVG,
// mapa de calor e T.O. vêm das MESMAS funções do relatório impresso - só a saída muda.
// O relatório de coleção continua usando a impressão (imprimirRelatorioHTML).
const PDFMAKE_SCRIPTS = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.min.js",
];
let promessaPdfMake = null;

function carregarScriptExterno(src) {
  return new Promise((ok, falha) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = ok;
    script.onerror = () => falha(new Error("Não foi possível carregar o gerador de PDF (" + src.split("/").pop() + ")."));
    document.head.appendChild(script);
  });
}

// Carrega uma única vez; se falhar, a próxima tentativa recomeça do zero
function carregarPdfMake() {
  if (window.pdfMake && window.pdfMake.vfs) return Promise.resolve(window.pdfMake);
  if (!promessaPdfMake) {
    promessaPdfMake = PDFMAKE_SCRIPTS.reduce((p, src) => p.then(() => carregarScriptExterno(src)), Promise.resolve())
      .then(() => {
        if (!window.pdfMake || !window.pdfMake.vfs) throw new Error("O gerador de PDF não foi inicializado.");
        return window.pdfMake;
      })
      .catch((erro) => { promessaPdfMake = null; throw erro; });
  }
  return promessaPdfMake;
}

// Logotipo como data URL (o pdfmake não lê URLs). Sem logo, o relatório sai sem ele.
async function carregarLogoRelatorioDataUrl() {
  try {
    const resposta = await fetch(new URL("assets/logo.png", window.location.href).href);
    if (!resposta.ok) return null;
    const blob = await resposta.blob();
    return await new Promise((ok) => {
      const leitor = new FileReader();
      leitor.onload = () => ok(leitor.result);
      leitor.onerror = () => ok(null);
      leitor.readAsDataURL(blob);
    });
  } catch (erro) {
    console.warn("Logo do relatório indisponível:", erro);
    return null;
  }
}

// NOME-NUCLEO-DD-MM-AAAA-a-DD-MM-AAAA.pdf, sem acentos nem caracteres inválidos
function normalizarParteNomeArquivo(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
}

function montarNomeArquivoRelatorioIndividual(nome, nucleo, diaInicio, diaFim) {
  const data = (dia) => formatarDiaMes(dia, true).replace(/\//g, "-");
  const partes = [normalizarParteNomeArquivo(nome) || "DIAGRAMADOR", normalizarParteNomeArquivo(nucleo) || "NUCLEO"];
  return `${partes.join("-")}-${data(diaInicio)}-a-${data(diaFim)}.pdf`;
}

// SVG gerado pelas funções do relatório, limpo para o pdfmake (sem width="100%"/<title>)
function extrairSvgRelatorio(html) {
  const m = /<svg[\s\S]*?<\/svg>/.exec(html || "");
  if (!m) return null;
  let svg = m[0].replace(/<title>[\s\S]*?<\/title>/g, "");
  // só a tag de abertura perde class/role/aria-label/width/height (o tamanho vem do pdfmake)
  svg = svg.replace(/^<svg[^>]*>/, (tag) => tag.replace(/\s(class|role|aria-label|width|height)="[^"]*"/g, ""));
  if (!/xmlns=/.test(svg)) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}

function textoSemTags(html) {
  return String(html || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

const COR_PDF = { marinho: "#0b2e4f", texto: "#1f2933", suave: "#4a5260", cinzaTexto: "#6b7385", borda: "#dde3ea", fundoCard: "#f7f9fc", zebra: "#f7f9fc" };
const CORES_CONDICAO_PDF = { ok: "#1e7a45", atraso: "#c0392b", neutro: "#6b7385" };

function tituloSecaoPdf(texto) {
  return { text: texto, style: "h3", headlineLevel: 1 };
}

function cardPdf(rotulo, valor, regra, cor) {
  return {
    table: { widths: [3, "*"], body: [[{ text: "", fillColor: cor || COR_PDF.marinho },
      { stack: [{ text: String(valor), style: "cardValor" }, { text: rotulo, style: "cardRotulo" }, { text: regra, style: "cardRegra" }], fillColor: COR_PDF.fundoCard, margin: [5, 4, 4, 5] }]] },
    layout: { hLineWidth: () => 0.6, vLineWidth: (i) => (i === 0 ? 0 : 0.6), hLineColor: () => COR_PDF.borda, vLineColor: () => COR_PDF.borda, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
  };
}

function legendaPdf(itens) {
  // itens: [{ cor, texto }] em linha, com quadradinho de cor
  return {
    columns: itens.map((i) => ({ width: "auto", columns: [
      { width: 8, canvas: [{ type: "rect", x: 0, y: 2, w: 7, h: 7, r: 1.5, color: i.cor, lineColor: i.borda || i.cor }] },
      { width: "auto", text: i.texto, fontSize: 7.5, color: COR_PDF.suave, margin: [3, 0, 0, 0] }] })),
    columnGap: 12,
    margin: [0, 4, 0, 0],
  };
}

// Um mês do mapa de calor como SVG (mesmas cores/regras do mapa do relatório impresso)
function svgMesMapaCalorPdf({ dias, maximo }) {
  const tam = 22, gap = 2, topo = 14;
  const nomes = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  let x0 = (new Date(dias[0].dia).getUTCDay() + 6) % 7;
  const linhas = Math.ceil((x0 + dias.length) / 7);
  const largura = 7 * tam + 6 * gap, altura = topo + linhas * (tam + gap);
  const partes = nomes.map((n, i) => `<rect x="${i * (tam + gap)}" y="0" width="${tam}" height="11" rx="1.5" fill="#0b2e4f"/>` +
    `<text x="${i * (tam + gap) + tam / 2}" y="8" font-size="6" font-weight="bold" text-anchor="middle" fill="#ffffff">${n}</text>`);
  dias.forEach(({ dia, conclusoes, situacao, feriado, ferias }, k) => {
    const pos = x0 + k, x = (pos % 7) * (tam + gap), y = topo + Math.floor(pos / 7) * (tam + gap);
    let fundo = "#eceff3", contorno = "", textoDia = "#4a5260", miolo = "";
    if (situacao === "concluidas") {
      const cor = obterCorMapaCalor(conclusoes, maximo);
      fundo = cor.fundo;
      textoDia = cor.textoClaro ? "#ffffff" : "#4a5260";
      miolo = `<text x="${x + tam / 2}" y="${y + (ferias ? 13.4 : 16)}" font-size="8.5" font-weight="bold" text-anchor="middle" fill="${cor.textoClaro ? "#ffffff" : "#0b3d6b"}">${conclusoes}</text>`;
      if (feriado || ehFimDeSemana(dia)) contorno = `<rect x="${x + 0.75}" y="${y + 0.75}" width="${tam - 1.5}" height="${tam - 1.5}" rx="2" fill="none" stroke="#c4cdd8" stroke-width="1.5"/>`;
    } else if (situacao === "execucao") {
      fundo = "#dcede2";
      contorno = `<rect x="${x + 0.4}" y="${y + 0.4}" width="${tam - 0.8}" height="${tam - 0.8}" rx="2" fill="none" stroke="#9cc6ad" stroke-width="0.8"/>`;
      miolo = `<circle cx="${x + tam / 2}" cy="${y + 13}" r="2.2" fill="#217847"/>`;
    } else if (situacao === "sem-registro") {
      fundo = "#f8dddf";
      contorno = `<rect x="${x + 0.4}" y="${y + 0.4}" width="${tam - 0.8}" height="${tam - 0.8}" rx="2" fill="none" stroke="#e3b5b8" stroke-width="0.8"/>`;
    } else if (situacao === "ferias") {
      fundo = "#fef3c7";
      contorno = `<rect x="${x + 0.4}" y="${y + 0.4}" width="${tam - 0.8}" height="${tam - 0.8}" rx="2" fill="none" stroke="#f2c76b" stroke-width="0.8"/>`;
      miolo = `<text x="${x + tam / 2}" y="${y + 14.2}" font-size="4.6" font-weight="bold" text-anchor="middle" fill="#92400e">FÉRIAS</text>`;
    }
    // entrega durante as férias: marca "FÉR" no canto inferior esquerdo (o número continua)
    if (ferias && situacao === "concluidas") {
      miolo += `<rect x="${x + tam / 2 - 5}" y="${y + tam - 6.4}" width="10" height="5.4" rx="1" fill="#fef3c7"/><text x="${x + tam / 2}" y="${y + tam - 2.3}" font-size="4.1" font-weight="bold" text-anchor="middle" fill="#92400e">FÉR</text>`;
    }
    const fer = feriado
      ? `<rect x="${x + tam - 11}" y="${conclusoes ? y + 1 : y + tam - 7}" width="10" height="6" rx="1" fill="#ede7fb"/><text x="${x + tam - 6}" y="${conclusoes ? y + 5.6 : y + tam - 2.4}" font-size="4.3" font-weight="bold" text-anchor="middle" fill="#4c2f91">FER</text>`
      : "";
    partes.push(`<rect x="${x}" y="${y}" width="${tam}" height="${tam}" rx="2" fill="${fundo}"/>${contorno}` +
      `<text x="${x + 2}" y="${y + 6}" font-size="5" fill="${textoDia}">${new Date(dia).getUTCDate()}</text>${miolo}${fer}`);
  });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largura} ${altura}">${partes.join("")}</svg>`, largura, altura };
}

function secaoMapaCalorPdf(lista, nome, diaInicio, diaFim, agoraMs) {
  const { meses, totalConclusoes, diasExecucao, diasFerias, feriasDisponiveis } = calcularMapaCalorRelatorio(lista, nome, diaInicio, diaFim, agoraMs);
  const avisoFerias = feriasDisponiveis ? "" : { text: "Dados de férias indisponíveis no momento: as férias não foram marcadas neste mapa.", style: "nota", color: "#92400e", margin: [0, 2, 0, 0] };
  const cabecalho = [tituloSecaoPdf("Mapa de calor — atividades por dia e diagramador"),
    { text: [{ text: "Distribuição diária das atividades do profissional no período selecionado. Diagramador: " }, { text: nome, bold: true }, { text: ` · ${totalConclusoes} conclusão(ões) no período.` }], style: "nota" }];
  if (!totalConclusoes && !diasExecucao && !diasFerias) return [...cabecalho, { text: "Nenhuma atividade concluída ou em andamento registrada no período.", style: "vazio" }, avisoFerias];
  const larguraBloco = 160;
  const blocos = meses.map((mes) => {
    const desenho = svgMesMapaCalorPdf(mes);
    const concl = mes.dias.reduce((s, d) => s + d.conclusoes, 0);
    return {
      width: larguraBloco,
      table: { widths: ["*"], body: [[{ stack: [
        { columns: [{ text: `${NOMES_MES_RELATORIO[mes.mes - 1]} ${mes.ano}`, bold: true, color: COR_PDF.marinho, fontSize: 8.5 }, { text: `${concl} concl.`, alignment: "right", fontSize: 7, color: COR_PDF.suave }], margin: [0, 0, 0, 3] },
        { svg: desenho.svg, width: larguraBloco - 10 }] }]] },
      layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => COR_PDF.borda, vLineColor: () => COR_PDF.borda, paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 4, paddingBottom: () => 4 },
    };
  });
  const linhas = [];
  for (let i = 0; i < blocos.length; i += 3) {
    const linha = blocos.slice(i, i + 3);
    while (linha.length < 3) linha.push({ width: larguraBloco, text: "" });
    linhas.push({ columns: linha, columnGap: 17, margin: [0, 0, 0, 8], unbreakable: true });
  }
  const itensLegenda = [
    ["#2a68a0", "", "Concluídas (nº no dia)", 88], ["#dcede2", "#9cc6ad", "Em andamento", 62], ["#f8dddf", "#e3b5b8", "Sem registro", 56],
    ["#eceff3", "", "Não operacional (fim de semana sem entrega, feriado, futuro)", 210], ["#ede7fb", "", "FER = Feriado", 64], ["#fef3c7", "#f2c76b", "Férias", 34],
  ];
  let xLeg = 0;
  const legenda = { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 515 12">${itensLegenda.map(([cor, borda, texto, largura]) => {
    const item = `<rect x="${xLeg}" y="2" width="8" height="8" rx="1.5" fill="${cor}"${borda ? ` stroke="${borda}" stroke-width="0.8"` : ""}/>` +
      `<text x="${xLeg + 11}" y="9" font-size="7" fill="#4a5260">${escaparTexto(texto)}</text>`;
    xLeg += largura;
    return item;
  }).join("")}</svg>`, width: 515, margin: [0, 2, 0, 0] };
  return [{ stack: [...cabecalho, legenda,
    { text: "As cores representam os registros operacionais disponíveis e não constituem controle de presença ou frequência.", style: "nota", margin: [0, 3, 0, avisoFerias ? 0 : 6] },
    avisoFerias ? { ...avisoFerias, margin: [0, 2, 0, 6] } : "", linhas[0]], unbreakable: true }, ...linhas.slice(1)];
}

// Condição do prazo de uma atividade FINALIZADA (mesma comparação dos indicadores):
//  "ok" = Fim <= Previsto | "atraso" = Fim > Previsto | "sem-previsao" = Previsto ausente/inválido
//  null = Fim inválido (não dá para classificar; a linha mostra "—")
function classificarPrazoFinalizada(d) {
  const previsto = obterDataPlausivelDemanda(d.previsto).data;
  if (!previsto) return "sem-previsao";
  const fim = obterDataPlausivelDemanda(d.fim).data;
  if (!fim) return null;
  return fim <= previsto ? "ok" : "atraso";
}

// Ícones vetoriais (SVG), sem depender de fontes de emoji: círculo + símbolo branco
const ICONES_PRAZO_PDF = {
  "ok": { cor: "#2e9e5b", rotulo: "No prazo", simbolo: '<path d="M5.2 10.3 L8.6 13.6 L14.8 6.9" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' },
  "atraso": { cor: "#c0392b", rotulo: "Com atraso", simbolo: '<rect x="8.8" y="4.4" width="2.4" height="7.6" rx="1.2" fill="#ffffff"/><circle cx="10" cy="15.2" r="1.45" fill="#ffffff"/>' },
  "sem-previsao": { cor: "#8a94a3", rotulo: "Sem previsão", simbolo: '<rect x="5" y="8.8" width="10" height="2.4" rx="1.2" fill="#ffffff"/>' },
};

function svgIconePrazoPdf(tipo) {
  const icone = ICONES_PRAZO_PDF[tipo];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="${icone.cor}"/>${icone.simbolo}</svg>`;
}

// Documento completo (capa, indicadores, gráficos, mapa, tabela, regras, contracapa).
// Sem acesso a DOM: testável fora do navegador.
function montarDocumentoPdfIndividual({ r, part, diaInicio, diaFim, agoraMs, lista, nome, nucleo, periodoTexto, geradoEm, logo }) {
  const titulo = "Performance Individual";
  const alvo = `${nome} · ${nucleo}`;
  const finsDeSemanaComEntrega = obterFinsDeSemanaComEntrega(lista, nome);
  const evolucao = montarSerieEvolucao(r.entregasPorDia, diaInicio, diaFim, { diasOperacionais: true });
  const participacao = part.percentual === null ? "—" : formatarPercentual(part.percentual);
  const comPrevisto = r.noPrazo + r.comAtraso;
  const larguraUtil = 515;

  const graficoOuVazio = (html, largura = larguraUtil) => {
    const svg = extrairSvgRelatorio(html);
    return svg ? { svg, width: largura } : { text: textoSemTags(html), style: "vazio" };
  };

  // Indicadores (mesmos 5 cards do relatório)
  const cards = { columns: [
    cardPdf("Entregas no período", r.entregas.length, "Finalizadas com Fim no período"),
    cardPdf("No prazo", r.noPrazo, "Fim ≤ Previsto", "#2e9e5b"),
    cardPdf("Com atraso", r.comAtraso, "Fim > Previsto", "#c0392b"),
    cardPdf("% no prazo", formatarPercentual(calcularPercentual(r.noPrazo, comPrevisto)), `no prazo ÷ entregas com Previsto (${r.semPrevisto} sem Previsto)`),
    cardPdf("Participação no Núcleo", participacao, `Atividades atribuídas ao profissional ÷ atividades atribuídas no núcleo (${part.nucleo}: ${part.numerador} de ${part.denominador})`),
  ], columnGap: 6, margin: [0, 0, 0, 6] };

  // Evolução
  const htmlEvolucao = svgColunasRelatorio(evolucao.serie);
  const notaEvolucao = (/<p class="nota">([\s\S]*?)<\/p>/.exec(htmlEvolucao) || [])[1];
  const secaoEvolucao = { stack: [tituloSecaoPdf(`Evolução das conclusões (${evolucao.granularidade})`), graficoOuVazio(htmlEvolucao),
    notaEvolucao ? { text: textoSemTags(notaEvolucao), style: "nota" } : ""], unbreakable: true };

  // Pizza
  const partesPizza = [{ rotulo: "No prazo", valor: r.noPrazo, cor: COR_REL.verde }, { rotulo: "Com atraso", valor: r.comAtraso, cor: COR_REL.vermelho }, { rotulo: "Entregas sem previsão", valor: r.semPrevisto, cor: COR_REL.semPrevisao }];
  const totalPizza = partesPizza.reduce((s, p) => s + p.valor, 0);
  const svgPizza = extrairSvgRelatorio(svgPizzaPrazoRelatorio(r.noPrazo, r.comAtraso, r.semPrevisto));
  const secaoPizza = { stack: [tituloSecaoPdf("Entregas no prazo x com atraso"), svgPizza ? {
    columns: [{ width: 120, svg: svgPizza }, { width: "*", margin: [24, 32, 0, 0], table: { widths: [10, 120, 30, 40], body: partesPizza.map((p) => [
      { canvas: [{ type: "rect", x: 0, y: 1, w: 8, h: 8, r: 1.5, color: p.cor }] }, { text: p.rotulo, fontSize: 9 },
      { text: String(p.valor), bold: true, color: COR_PDF.marinho, alignment: "right", fontSize: 9 },
      { text: formatarPercentual(calcularPercentual(p.valor, totalPizza)), color: COR_PDF.suave, alignment: "right", fontSize: 9 }]) }, layout: "noBorders" }],
  } : { text: "Nenhuma entrega concluída no período.", style: "vazio" }], unbreakable: true };

  // Tabela de atividades: só as FINALIZADAS (status real da base) entre as atribuídas ou
  // entregues no período do profissional, sem repetir, ordenadas pelo Início
  const vistas = new Set();
  const atividades = [...r.atribuidas, ...r.entregas].filter((d) => (vistas.has(d) ? false : vistas.add(d)))
    .filter((d) => statusEhFinalizado(d.status))
    .sort((a, b) => (obterDataPlausivelDemanda(a.inicio).data?.getTime() || 0) - (obterDataPlausivelDemanda(b.inicio).data?.getTime() || 0));
  // Cabeçalho centralizado na horizontal e na vertical: "Condição do prazo" ocupa 2 linhas;
  // os de 1 linha descem meia linha (o pdfmake 0.2 não tem alinhamento vertical em células)
  const meiaLinhaCab = 7.5 * 1.15 * 1.172 / 2; // fonte 7,5 × lineHeight 1,15 × altura da Roboto
  const cab = ["Atividade", "Ano", "Módulo", "Frente", "Início", "Previsto", "Fim", "T.O.", "Condição do\nprazo"]
    .map((t) => ({ text: t, style: "th", alignment: "center", margin: [0, t.includes("\n") ? 0 : meiaLinhaCab, 0, 0] }));
  const corpoTabela = atividades.map((d) => {
    const to = calcularTempoOperacao(d.inicio, d.fim, finsDeSemanaComEntrega);
    const inconsistente = to.minutos === null && to.texto !== "—";
    const prazo = classificarPrazoFinalizada(d);
    return [d.atividade || "–", d.anoEscolar || "–", d.modulo || "–", d.frente || "–",
      formatarDataHoraRelatorio(d.inicio), formatarDataHoraRelatorio(d.previsto), formatarDataHoraRelatorio(d.fim)]
      .map((t) => ({ text: String(t) }))
      .concat([{ text: to.texto, alignment: "right", color: inconsistente ? "#c0392b" : undefined, fontSize: inconsistente ? 6.5 : undefined },
        prazo ? { svg: svgIconePrazoPdf(prazo), width: 10, alignment: "center" } : { text: "—", alignment: "center", color: COR_PDF.cinzaTexto }]);
  });
  // Legenda com os mesmos ícones (uma vez, acima do cabeçalho)
  const legendaPrazo = {
    columns: ["ok", "atraso", "sem-previsao"].map((tipo) => ({ width: "auto", columns: [
      { width: 10, svg: svgIconePrazoPdf(tipo) },
      { width: "auto", text: ICONES_PRAZO_PDF[tipo].rotulo, fontSize: 8, color: COR_PDF.suave, margin: [4, 1, 0, 0] }] })),
    columnGap: 16, margin: [0, 0, 0, 6],
  };
  // Sempre começa em página nova: 1ª página de conteúdo = indicadores, gráficos e mapa;
  // 2ª página de conteúdo = esta tabela. Título, legenda e cabeçalho ficam juntos.
  const secaoTabela = [{ ...tituloSecaoPdf("Atividades do período"), id: "titulo-atividades-periodo", margin: [0, 0, 0, 6] },
    ...(atividades.length ? [legendaPrazo, {
      table: { headerRows: 1, dontBreakRows: true, widths: ["*", 27, 30, 44, 46, 46, 46, 46, 44], body: [cab, ...corpoTabela] },
      layout: { fillColor: (i) => (i === 0 ? COR_PDF.marinho : i % 2 === 0 ? COR_PDF.zebra : null), hLineWidth: (i) => (i === 0 ? 0 : 0.5), vLineWidth: () => 0,
        hLineColor: () => "#e3e7ee", paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 3, paddingBottom: () => 3 },
      fontSize: 7, color: COR_PDF.texto,
    }] : [{ text: "Nenhuma atividade finalizada no período selecionado.", style: "vazio" }])];

  // Regras de cálculo: blocos curtos (subtítulo + explicação), mesmos ícones da tabela
  const regraPdf = (titulo, texto, extra) => ({ stack: [{ text: titulo, bold: true, color: COR_PDF.marinho, fontSize: 8.5 },
    { text: texto, fontSize: 8, color: COR_PDF.suave, margin: [0, 1, 0, 0] }, ...(extra ? [extra] : [])], margin: [0, 0, 0, 7] });
  const itemPrazoPdf = (tipo, texto) => ({ columns: [{ width: 9, svg: svgIconePrazoPdf(tipo), margin: [0, 1, 0, 0] },
    { width: "*", text: [{ text: ICONES_PRAZO_PDF[tipo].rotulo + ": ", bold: true, color: COR_PDF.texto }, texto], fontSize: 8, color: COR_PDF.suave, margin: [5, 0, 0, 0] }],
    margin: [0, 3, 0, 0] });
  const regras = { stack: [tituloSecaoPdf("Regras de cálculo"), {
    table: { widths: ["*"], body: [[{ stack: [
      regraPdf("Entregas no período", "Atividades finalizadas dentro do período, mesmo que tenham começado antes."),
      regraPdf("Condição do prazo", "A data de conclusão é comparada com a data prevista.", { stack: [
        itemPrazoPdf("ok", "conclusão até a data e hora previstas."),
        itemPrazoPdf("atraso", "conclusão após a data e hora previstas."),
        itemPrazoPdf("sem-previsao", "atividade finalizada sem prazo válido."),
      ], margin: [0, 2, 0, 0] }),
      { ...regraPdf("Tratamento das datas", "Datas inválidas não entram nos cálculos. É considerado o horário de Recife, sem alterar os registros originais."), margin: [0, 0, 0, 0] },
    ], fillColor: "#fbfcfd", margin: [8, 7, 8, 7] }]] },
    layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => COR_PDF.borda, vLineColor: () => COR_PDF.borda },
  }], unbreakable: true };

  const capa = { stack: [
    logo ? { table: { body: [[{ image: logo, width: 150, margin: [8, 6, 8, 6] }]] }, layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => "#ffffff" }, margin: [0, 0, 0, 34] } : "",
    { text: titulo, fontSize: 28, bold: true, color: "#ffffff", margin: [0, 0, 0, 6] },
    { text: alvo, fontSize: 18, color: "#ffffff", margin: [0, 0, 0, 24] },
    { text: `Período analisado: ${periodoTexto}`, fontSize: 10.5, color: "#e6edf5", margin: [0, 0, 0, 3] },
    { text: `Gerado em: ${geradoEm}`, fontSize: 10.5, color: "#e6edf5", margin: [0, 0, 0, 3] },
    { text: "KANBAN - SGGE · Performance dos Núcleos", fontSize: 10.5, color: "#e6edf5" },
  ], margin: [22, 190, 0, 0], pageBreak: "after" };

  const contracapa = { stack: [
    logo ? { image: logo, width: 160, alignment: "center", margin: [0, 0, 0, 16] } : "",
    { text: "Sistema GGE de Ensino", bold: true, alignment: "center", color: COR_PDF.marinho, fontSize: 11 },
    { text: "Equipe de Diagramação · Relatório gerado pelo KANBAN - SGGE", alignment: "center", color: COR_PDF.suave, fontSize: 9.5, margin: [0, 4, 0, 0] },
  ], pageBreak: "before", margin: [0, 280, 0, 0] };

  return {
    pageSize: "A4",
    pageMargins: [40, 74, 40, 50],
    info: { title: `${titulo} — ${alvo}`, author: "Sistema GGE de Ensino", subject: `Período: ${periodoTexto}`, creator: "KANBAN - SGGE" },
    defaultStyle: { font: "Roboto", fontSize: 9, color: COR_PDF.texto, lineHeight: 1.15 },
    styles: {
      h3: { fontSize: 12, bold: true, color: COR_PDF.marinho, margin: [0, 12, 0, 6] },
      nota: { fontSize: 8, color: COR_PDF.cinzaTexto },
      vazio: { fontSize: 8.5, color: COR_PDF.cinzaTexto, margin: [0, 2, 0, 4] },
      th: { bold: true, color: "#ffffff", fontSize: 7.5 },
      cardValor: { fontSize: 15, bold: true, color: COR_PDF.marinho },
      cardRotulo: { fontSize: 8, bold: true, margin: [0, 1, 0, 1] },
      cardRegra: { fontSize: 6.5, color: COR_PDF.cinzaTexto },
    },
    // Capa (pág. 1) com o fundo azul degradê; contracapa (última) sem cabeçalho/rodapé
    background: (pagina, tamanho) => (pagina === 1 ? { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${tamanho.width}" height="${tamanho.height}" viewBox="0 0 ${tamanho.width} ${tamanho.height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b2e4f"/><stop offset="0.6" stop-color="#103a60"/><stop offset="1" stop-color="#1e6495"/></linearGradient></defs><rect width="${tamanho.width}" height="${tamanho.height}" fill="url(#g)"/></svg>`, width: tamanho.width } : null),
    header: (pagina, total) => (pagina === 1 || pagina === total ? null : {
      margin: [40, 24, 40, 0],
      stack: [{ columns: [logo ? { image: logo, width: 80 } : { text: "GGE", bold: true, color: COR_PDF.marinho },
        { text: `${titulo} · ${alvo}\n${periodoTexto}`, alignment: "right", fontSize: 8, color: COR_PDF.suave }] },
      { canvas: [{ type: "line", x1: 0, y1: 4, x2: larguraUtil, y2: 4, lineWidth: 1.5, lineColor: COR_PDF.marinho }] }],
    }),
    footer: (pagina, total) => (pagina === 1 || pagina === total ? null : {
      margin: [40, 16, 40, 0],
      columns: [{ text: "Sistema GGE de Ensino · KANBAN - SGGE", fontSize: 7.5, color: "#8a94a3" }, { text: `Página ${pagina} de ${total}`, alignment: "right", fontSize: 7.5, color: "#8a94a3" }],
    }),
    // título de seção nunca fica sozinho no pé da página
    pageBreakBefore: (no, seguintesNaPagina) => {
      if (no.id === "titulo-atividades-periodo") {
        // Sempre em página nova (sem gerar página vazia se já estiver no topo). O normal é o
        // conteúdo anterior caber na página 2 do PDF (capa = 1) e a tabela abrir a página 3.
        const pos = no.startPosition || {};
        const noTopo = pos.top !== undefined && pos.top <= 74.5;
        const paginaTabela = noTopo ? pos.pageNumber : pos.pageNumber + 1;
        if (paginaTabela > 3) {
          console.warn(`Relatório Individual: indicadores, gráficos e mapa ocupam mais de uma página; "Atividades do período" começa na página ${paginaTabela} do PDF (conteúdo preservado).`);
        }
        return !noTopo;
      }
      return no.headlineLevel === 1 && seguintesNaPagina.length === 0;
    },
    content: [capa, cards, secaoEvolucao, secaoPizza, ...secaoMapaCalorPdf(lista, nome, diaInicio, diaFim, agoraMs), ...secaoTabela, regras, contracapa],
  };
}

// ===================== RELATÓRIO POR COLEÇÃO: DOWNLOAD DIRETO EM PDF ===================== //
// Mesmo mecanismo do individual (pdfmake + baixarDocumentoPdf). Conteúdo igual ao relatório
// impresso: 4 indicadores, conclusões por diagramador, evolução, mapa de calor, tabela e regras.

// COLECAO-DD-MM-AAAA-a-DD-MM-AAAA.pdf
function montarNomeArquivoRelatorioColecao(colecao, diaInicio, diaFim) {
  const data = (dia) => formatarDiaMes(dia, true).replace(/\//g, "-");
  return `${normalizarParteNomeArquivo(colecao) || "COLECAO"}-${data(diaInicio)}-a-${data(diaFim)}.pdf`;
}

// Um mês do mapa da coleção como SVG: diagramadores x dias (31 colunas, mesmas cores/regras)
function svgMesMapaColecaoPdf(mes, participantes, consultaFerias = criarConsultaFeriasMapa()) {
  const { recorte, dias } = mes;
  const porNome = new Map(recorte.linhas.map((l) => [normalizarNome(l.nome), l]));
  const largNome = 78, cel = 13.2, gap = 1.2, altCab = 17, altLinha = 15;
  const largura = largNome + 31 * (cel + gap), altura = altCab + gap + participantes.length * (altLinha + gap);
  const maximo = participantes.reduce((mx, p) => {
    const l = porNome.get(normalizarNome(p.nome));
    return l ? dias.reduce((x, d) => Math.max(x, l.dias.get(d) || 0), mx) : mx;
  }, 0);
  const partes = [`<rect x="0" y="0" width="${largNome - 2}" height="${altCab}" rx="1.5" fill="#0b2e4f"/>` +
    `<text x="4" y="11" font-size="6.5" font-weight="bold" fill="#ffffff">Diagramador</text>`];
  dias.forEach((d, k) => {
    const x = largNome + k * (cel + gap), dt = new Date(d);
    const fundo = obterFeriadoPernambuco(d) ? "#5b4a8a" : ehFimDeSemana(d) ? "#33506d" : "#0b2e4f";
    partes.push(`<rect x="${x}" y="0" width="${cel}" height="${altCab}" rx="1.5" fill="${fundo}"/>` +
      `<text x="${x + cel / 2}" y="7.5" font-size="5.6" font-weight="bold" text-anchor="middle" fill="#ffffff">${String(dt.getUTCDate()).padStart(2, "0")}</text>` +
      `<text x="${x + cel / 2}" y="14" font-size="4.6" text-anchor="middle" fill="#dbe4ee">${LETRA_DIA_SEMANA[dt.getUTCDay()]}</text>` +
      (d === recorte.hoje ? `<rect x="${x}" y="${altCab - 1.6}" width="${cel}" height="1.6" fill="#dc3545"/>` : ""));
  });
  participantes.forEach((p, i) => {
    const y = altCab + gap + i * (altLinha + gap);
    const l = porNome.get(normalizarNome(p.nome)) || { dias: new Map(), execucao: new Map() };
    const conclMes = dias.reduce((x, d) => x + (l.dias.get(d) || 0), 0);
    partes.push(`<rect x="0" y="${y}" width="${largNome - 2}" height="${altLinha}" rx="1.5" fill="#f7f9fc"/>` +
      `<text x="3" y="${y + 6.6}" font-size="5.8" font-weight="bold" fill="#1f2933">${escaparTexto(p.nome.length > 22 ? p.nome.slice(0, 21) + "…" : p.nome)}</text>` +
      `<text x="3" y="${y + 12.6}" font-size="4.6" fill="#6b7385">${conclMes} concl.</text>`);
    dias.forEach((d, k) => {
      const x = largNome + k * (cel + gap);
      const qtd = l.dias.get(d) || 0;
      const ferias = !!consultaFerias.periodo(p.nome, d);
      const situacao = classificarDiaMapaCalorComFerias(qtd, l.execucao.get(d) || 0, d, recorte.hoje, ferias);
      const feriado = obterFeriadoPernambuco(d);
      let fundo = "#eceff3", extra = "";
      if (situacao === "concluidas") {
        const cor = obterCorMapaCalor(qtd, maximo);
        fundo = cor.fundo;
        extra = `<text x="${x + cel / 2}" y="${y + (feriado ? 7.6 : 9.6)}" font-size="6.6" font-weight="bold" text-anchor="middle" fill="${cor.textoClaro ? "#ffffff" : "#0b3d6b"}">${qtd}</text>`;
        if (feriado || ehFimDeSemana(d)) extra += `<rect x="${x + 0.6}" y="${y + 0.6}" width="${cel - 1.2}" height="${altLinha - 1.2}" rx="1.5" fill="none" stroke="#c4cdd8" stroke-width="1.1"/>`;
      } else if (situacao === "execucao") {
        fundo = "#dcede2";
        extra = `<rect x="${x + 0.3}" y="${y + 0.3}" width="${cel - 0.6}" height="${altLinha - 0.6}" rx="1.5" fill="none" stroke="#9cc6ad" stroke-width="0.6"/><circle cx="${x + cel / 2}" cy="${y + altLinha / 2}" r="1.9" fill="#217847"/>`;
      } else if (situacao === "sem-registro") {
        fundo = "#f8dddf";
        extra = `<rect x="${x + 0.3}" y="${y + 0.3}" width="${cel - 0.6}" height="${altLinha - 0.6}" rx="1.5" fill="none" stroke="#e3b5b8" stroke-width="0.6"/>`;
      } else if (situacao === "ferias") {
        fundo = "#fef3c7";
        extra = `<rect x="${x + 0.3}" y="${y + 0.3}" width="${cel - 0.6}" height="${altLinha - 0.6}" rx="1.5" fill="none" stroke="#f2c76b" stroke-width="0.6"/>` +
          `<text x="${x + cel / 2}" y="${y + (feriado ? 7.4 : 9.2)}" font-size="3.4" font-weight="bold" text-anchor="middle" fill="#92400e">FÉRIAS</text>`;
      }
      // entrega durante as férias: marca "FÉR" no topo (o número continua visível)
      if (ferias && situacao === "concluidas") extra += `<rect x="${x + 1.6}" y="${y + 0.9}" width="${cel - 3.2}" height="4.2" rx="0.8" fill="#fef3c7"/><text x="${x + cel / 2}" y="${y + 4.1}" font-size="3.2" font-weight="bold" text-anchor="middle" fill="#92400e">FÉR</text>`;
      if (feriado) extra += `<rect x="${x + 1.6}" y="${y + altLinha - 5.4}" width="${cel - 3.2}" height="4.6" rx="0.8" fill="#ede7fb"/><text x="${x + cel / 2}" y="${y + altLinha - 1.8}" font-size="3.4" font-weight="bold" text-anchor="middle" fill="#4c2f91">FER</text>`;
      if (d === recorte.hoje) extra += `<rect x="${x + 0.5}" y="${y + 0.5}" width="${cel - 1}" height="${altLinha - 1}" rx="1.5" fill="none" stroke="#dc3545" stroke-width="1"/>`;
      partes.push(`<rect x="${x}" y="${y}" width="${cel}" height="${altLinha}" rx="1.5" fill="${fundo}"/>${extra}`);
    });
  });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largura} ${altura}">${partes.join("")}</svg>`, largura, altura };
}

function secaoMapaColecaoPdf(listaDaColecao, diaInicio, diaFim, agoraMs) {
  const cabecalho = [tituloSecaoPdf("Mapa de calor — atividades por dia e diagramador"),
    { text: "Distribuição diária das atividades dos diagramadores na coleção e no período selecionados.", style: "nota" }];
  const { meses, participantes } = calcularMapaCalorColecao(listaDaColecao, diaInicio, diaFim, agoraMs);
  if (!participantes.length) return [...cabecalho, { text: "Nenhuma atividade encontrada para a coleção no período selecionado.", style: "vazio" }];
  const consultaFerias = criarConsultaFeriasMapa();
  const itensLegenda = [
    ["#2a68a0", "", "Concluídas (nº no dia)", 84], ["#dcede2", "#9cc6ad", "Em andamento", 58], ["#f8dddf", "#e3b5b8", "Sem registro", 52],
    ["#eceff3", "", "Não operacional (fim de semana sem entrega, feriado, futuro)", 196], ["#ede7fb", "", "FER = Feriado", 62], ["#fef3c7", "#f2c76b", "Férias", 32], ["#ffffff", "#dc3545", "Hoje", 28],
  ];
  let xLeg = 0;
  const legenda = { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 515 12">${itensLegenda.map(([cor, borda, texto, largura]) => {
    const item = `<rect x="${xLeg}" y="2" width="8" height="8" rx="1.5" fill="${cor}"${borda ? ` stroke="${borda}" stroke-width="0.9"` : ""}/>` +
      `<text x="${xLeg + 11}" y="9" font-size="6.6" fill="#4a5260">${escaparTexto(texto)}</text>`;
    xLeg += largura;
    return item;
  }).join("")}</svg>`, width: 515, margin: [0, 2, 0, 0] };
  const blocos = meses.filter((m) => m.dias.length).map((mes) => {
    const desenho = svgMesMapaColecaoPdf(mes, participantes, consultaFerias);
    return { stack: [{ text: `${NOMES_MES_RELATORIO[mes.mes - 1]} ${mes.ano}`, bold: true, color: COR_PDF.marinho, fontSize: 9.5, margin: [0, 6, 0, 3] },
      { svg: desenho.svg, width: 515 }], unbreakable: true };
  });
  const avisoFerias = consultaFerias.disponivel ? "" : { text: "Dados de férias indisponíveis no momento: as férias não foram marcadas neste mapa.", style: "nota", color: "#92400e", margin: [0, 2, 0, 0] };
  return [{ stack: [...cabecalho, legenda, { text: "As cores representam os registros operacionais disponíveis e não constituem controle de presença ou frequência.", style: "nota", margin: [0, 3, 0, 0] }, avisoFerias, blocos[0]], unbreakable: true }, ...blocos.slice(1)];
}

function montarDocumentoPdfColecao({ r, diaInicio, diaFim, agoraMs, lista, titulo, alvo, periodoTexto, geradoEm, logo }) {
  const comPrevisto = r.noPrazo + r.comAtraso;
  const evolucao = montarSerieEvolucao(r.entregasPorDia, diaInicio, diaFim, { ocultarFimDeSemanaSemEntrega: true });
  const linhas = [...r.porDiagramador.values()].sort((a, b) => b.atribuidas - a.atribuidas || b.entregas - a.entregas || a.nome.localeCompare(b.nome, "pt-BR"));
  const grafico = (html) => {
    const svg = extrairSvgRelatorio(html);
    return svg ? { svg, width: 515 } : { text: textoSemTags(html), style: "vazio" };
  };
  const cards = { columns: [
    cardPdf("Entregas no período", r.entregas.length, "Finalizadas com Fim no período"),
    cardPdf("No prazo", r.noPrazo, "Fim ≤ Previsto", "#2e9e5b"),
    cardPdf("Com atraso", r.comAtraso, "Fim > Previsto", "#c0392b"),
    cardPdf("% no prazo", formatarPercentual(calcularPercentual(r.noPrazo, comPrevisto)), `no prazo ÷ entregas com Previsto (${r.semPrevisto} sem Previsto)`),
  ], columnGap: 6, margin: [0, 0, 0, 6] };
  const htmlEvolucao = svgColunasRelatorio(evolucao.serie);
  const notaEvolucao = (/<p class="nota">([\s\S]*?)<\/p>/.exec(htmlEvolucao) || [])[1];
  const conclusoes = { stack: [tituloSecaoPdf("Conclusões por diagramador (entregas no período)"),
    grafico(svgBarrasHorizontaisRelatorio([...linhas].sort((a, b) => b.entregas - a.entregas).map((l) => ({ rotulo: l.nome, valor: l.entregas })), COR_REL.azul))], unbreakable: true };
  const secaoEvolucao = { stack: [tituloSecaoPdf(`Evolução das entregas (${evolucao.granularidade})`), grafico(htmlEvolucao),
    notaEvolucao ? { text: textoSemTags(notaEvolucao), style: "nota" } : ""], unbreakable: true };
  const cabTabela = ["Diagramador", "Atribuídas", "Concluídas", "Em andamento", "Pendentes", "Entregas no período", "No prazo", "Com atraso", "% no prazo"]
    .map((t, i) => ({ text: t, style: "th", alignment: i === 0 ? "left" : "right" }));
  // Título dentro da tabela (1ª linha de cabeçalho) + keepWithHeaderRows: o título nunca fica
  // sozinho no pé da página, e reaparece com o cabeçalho quando a tabela continua
  const linhaTitulo = [{ text: "Profissionais vinculados à coleção", style: "h3", colSpan: 9, margin: [-4, 8, 0, 2] }, ...Array(8).fill({})];
  const tabela = [linhas.length ? {
    table: { headerRows: 2, keepWithHeaderRows: 1, dontBreakRows: true, widths: ["*", 44, 44, 52, 42, 56, 38, 42, 42], body: [linhaTitulo, cabTabela, ...linhas.map((l) => [
      { text: l.nome }, ...[l.atribuidas, l.concluidas, l.emAndamento, l.pendentes, l.entregas, l.noPrazo, l.comAtraso].map((v) => ({ text: String(v), alignment: "right" })),
      { text: formatarPercentual(calcularPercentual(l.noPrazo, l.noPrazo + l.comAtraso)), alignment: "right" }])] },
    layout: { fillColor: (i) => (i === 1 ? COR_PDF.marinho : i > 1 && i % 2 === 1 ? COR_PDF.zebra : null), hLineWidth: (i) => (i <= 2 ? 0 : 0.5), vLineWidth: () => 0,
      hLineColor: () => "#e3e7ee", paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 3.5, paddingBottom: () => 3.5 },
    fontSize: 7.5, color: COR_PDF.texto,
  } : { stack: [tituloSecaoPdf("Profissionais vinculados à coleção"), { text: "Nenhum profissional com atividades no período.", style: "vazio" }] }];
  // Regras: as mesmas do relatório de coleção impresso
  const regras = { stack: [tituloSecaoPdf("Regras de cálculo"), {
    table: { widths: ["*"], body: [[{ ul: [
      { text: [{ text: "Atividades atribuídas: ", bold: true }, "Início dentro do período (sem Início válido: data de criação). Concluídas, em andamento e pendentes referem-se à situação atual dessas atividades."] },
      { text: [{ text: "Entregas no período: ", bold: true }, "atividades Finalizadas com data de Fim dentro do período, independentemente de quando foram atribuídas."] },
      { text: [{ text: "No prazo / com atraso: ", bold: true }, "comparação entre Fim e Previsto das entregas do período; entregas sem Previsto válido não são classificadas."] },
      "Datas inválidas ou com ano implausível são desconsideradas; os dias seguem o fuso America/Recife. Nenhum dado da planilha é alterado.",
    ], fontSize: 8, color: COR_PDF.suave, fillColor: "#fbfcfd", margin: [4, 4, 4, 4] }]] },
    layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => COR_PDF.borda, vLineColor: () => COR_PDF.borda },
  }], unbreakable: true };
  return montarMolduraPdfRelatorio({ titulo, alvo, periodoTexto, geradoEm, logo,
    conteudo: [cards, conclusoes, secaoEvolucao, ...secaoMapaColecaoPdf(lista, diaInicio, diaFim, agoraMs), ...tabela, regras] });
}

// Capa, contracapa, cabeçalho, rodapé e estilos (mesmo padrão do relatório individual)
function montarMolduraPdfRelatorio({ titulo, alvo, periodoTexto, geradoEm, logo, conteudo }) {
  const larguraUtil = 515;
  const capa = { stack: [
    logo ? { table: { body: [[{ image: logo, width: 150, margin: [8, 6, 8, 6] }]] }, layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => "#ffffff" }, margin: [0, 0, 0, 34] } : "",
    { text: titulo, fontSize: 28, bold: true, color: "#ffffff", margin: [0, 0, 0, 6] },
    { text: alvo, fontSize: 18, color: "#ffffff", margin: [0, 0, 0, 24] },
    { text: `Período analisado: ${periodoTexto}`, fontSize: 10.5, color: "#e6edf5", margin: [0, 0, 0, 3] },
    { text: `Gerado em: ${geradoEm}`, fontSize: 10.5, color: "#e6edf5", margin: [0, 0, 0, 3] },
    { text: "KANBAN - SGGE · Performance dos Núcleos", fontSize: 10.5, color: "#e6edf5" },
  ], margin: [22, 190, 0, 0], pageBreak: "after" };
  const contracapa = { stack: [
    logo ? { image: logo, width: 160, alignment: "center", margin: [0, 0, 0, 16] } : "",
    { text: "Sistema GGE de Ensino", bold: true, alignment: "center", color: COR_PDF.marinho, fontSize: 11 },
    { text: "Equipe de Diagramação · Relatório gerado pelo KANBAN - SGGE", alignment: "center", color: COR_PDF.suave, fontSize: 9.5, margin: [0, 4, 0, 0] },
  ], pageBreak: "before", margin: [0, 280, 0, 0] };
  return {
    pageSize: "A4",
    pageMargins: [40, 74, 40, 50],
    info: { title: `${titulo} — ${alvo}`, author: "Sistema GGE de Ensino", subject: `Período: ${periodoTexto}`, creator: "KANBAN - SGGE" },
    defaultStyle: { font: "Roboto", fontSize: 9, color: COR_PDF.texto, lineHeight: 1.15 },
    styles: {
      h3: { fontSize: 12, bold: true, color: COR_PDF.marinho, margin: [0, 12, 0, 6] },
      nota: { fontSize: 8, color: COR_PDF.cinzaTexto },
      vazio: { fontSize: 8.5, color: COR_PDF.cinzaTexto, margin: [0, 2, 0, 4] },
      th: { bold: true, color: "#ffffff", fontSize: 7.5 },
      cardValor: { fontSize: 15, bold: true, color: COR_PDF.marinho },
      cardRotulo: { fontSize: 8, bold: true, margin: [0, 1, 0, 1] },
      cardRegra: { fontSize: 6.5, color: COR_PDF.cinzaTexto },
    },
    background: (pagina, tamanho) => (pagina === 1 ? { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${tamanho.width}" height="${tamanho.height}" viewBox="0 0 ${tamanho.width} ${tamanho.height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b2e4f"/><stop offset="0.6" stop-color="#103a60"/><stop offset="1" stop-color="#1e6495"/></linearGradient></defs><rect width="${tamanho.width}" height="${tamanho.height}" fill="url(#g)"/></svg>`, width: tamanho.width } : null),
    header: (pagina, total) => (pagina === 1 || pagina === total ? null : {
      margin: [40, 24, 40, 0],
      stack: [{ columns: [logo ? { image: logo, width: 80 } : { text: "GGE", bold: true, color: COR_PDF.marinho },
        { text: `${titulo} · ${alvo}\n${periodoTexto}`, alignment: "right", fontSize: 8, color: COR_PDF.suave }] },
      { canvas: [{ type: "line", x1: 0, y1: 4, x2: larguraUtil, y2: 4, lineWidth: 1.5, lineColor: COR_PDF.marinho }] }],
    }),
    footer: (pagina, total) => (pagina === 1 || pagina === total ? null : {
      margin: [40, 16, 40, 0],
      columns: [{ text: "Sistema GGE de Ensino · KANBAN - SGGE", fontSize: 7.5, color: "#8a94a3" }, { text: `Página ${pagina} de ${total}`, alignment: "right", fontSize: 7.5, color: "#8a94a3" }],
    }),
    pageBreakBefore: (no, seguintesNaPagina) => no.headlineLevel === 1 && seguintesNaPagina.length === 0,
    content: [capa, ...conteudo, contracapa],
  };
}

// Gera o PDF (pdfmake) de um documento já montado e dispara o download
async function baixarDocumentoPdf(montarDocumento, nomeArquivo) {
  const [pdfMake, logo] = await Promise.all([carregarPdfMake(), carregarLogoRelatorioDataUrl()]);
  const documento = montarDocumento(logo);
  const blob = await new Promise((ok, falha) => {
    try {
      pdfMake.createPdf(documento).getBlob((b) => (b && b.size ? ok(b) : falha(new Error("O PDF gerado está vazio."))));
    } catch (erro) {
      falha(erro);
    }
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nomeArquivo;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Gera o PDF e dispara o download (link temporário com download="nome.pdf")
async function baixarRelatorioIndividualPdf(dados, nomeArquivo) {
  const [pdfMake, logo] = await Promise.all([carregarPdfMake(), carregarLogoRelatorioDataUrl()]);
  const documento = montarDocumentoPdfIndividual({ ...dados, logo });
  const blob = await new Promise((ok, falha) => {
    try {
      pdfMake.createPdf(documento).getBlob((b) => (b && b.size ? ok(b) : falha(new Error("O PDF gerado está vazio."))));
    } catch (erro) {
      falha(erro);
    }
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nomeArquivo;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ── Impressão em iframe oculto (gera o PDF pelo navegador) ──
function imprimirRelatorioHTML(html) {
  return new Promise((resolver, rejeitar) => {
    const iframe = document.createElement("iframe");
    iframe.className = "relatorio-iframe-impressao";
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
    const imprimir = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        resolver();
      } catch (erro) {
        rejeitar(erro);
      } finally {
        setTimeout(() => iframe.remove(), 1500);
      }
    };
    // espera o logo carregar (sem travar se a imagem falhar)
    const imagens = [...doc.images];
    let pendentes = imagens.filter((img) => !img.complete).length;
    if (!pendentes) return setTimeout(imprimir, 50);
    const pronto = () => { pendentes -= 1; if (pendentes <= 0) setTimeout(imprimir, 50); };
    imagens.forEach((img) => { if (!img.complete) { img.addEventListener("load", pronto, { once: true }); img.addEventListener("error", pronto, { once: true }); } });
  });
}

// ── Menu e modal ──
function abrirMenuRelatorios(abrir) {
  const menu = document.getElementById("menu-relatorios");
  const botao = document.getElementById("btn-relatorios");
  if (!menu || !botao) return;
  menu.hidden = !abrir;
  botao.setAttribute("aria-expanded", abrir ? "true" : "false");
  if (abrir) menu.querySelector(".menu-relatorios-item")?.focus();
}

function popularDiagramadoresRelatorio() {
  const nucleo = document.getElementById("rel-ind-nucleo").value;
  const seletor = document.getElementById("rel-ind-diagramador");
  seletor.innerHTML = "";
  const equipe = [...obterEquipeAtualDoNucleo(obterChaveNucleoMapa(nucleo)).values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
  equipe.forEach((nome) => {
    const option = document.createElement("option");
    option.value = nome;
    option.textContent = nome;
    seletor.appendChild(option);
  });
  if (!equipe.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Nenhum diagramador cadastrado";
    seletor.appendChild(option);
  }
}

function abrirModalRelatorio(tipo) {
  if (telaAtual !== "resumo") return; // só dentro da área gerencial
  tipoRelatorioAberto = tipo;
  const modal = document.getElementById("modal-relatorio");
  document.getElementById("modal-relatorio-titulo").textContent =
    tipo === "colecao" ? "Performance por Coleção" : "Performance Individual";
  document.getElementById("form-relatorio-colecao").hidden = tipo !== "colecao";
  document.getElementById("form-relatorio-individual").hidden = tipo !== "individual";
  // Individual: download direto do PDF. Coleção: continua pela janela de impressão.
  // Os dois relatórios são baixados direto em PDF (sem janela de impressão)
  document.getElementById("btn-gerar-relatorio").textContent = "Baixar relatório PDF";
  const dicaImpressao = document.getElementById("relatorio-dica-impressao");
  if (dicaImpressao) dicaImpressao.hidden = true;
  document.getElementById("relatorio-erro").hidden = true;

  // período padrão: do dia 1º do mês atual até hoje (fuso operacional)
  const hoje = obterDiaOperacional(new Date());
  const primeiroDia = Date.UTC(new Date(hoje).getUTCFullYear(), new Date(hoje).getUTCMonth(), 1);

  if (tipo === "colecao") {
    const seletor = document.getElementById("rel-colecao");
    const { colecoes, unidades } = obterColecoesRelatorio();
    seletor.innerHTML = "";
    const grupo = (rotulo, itens) => {
      if (!itens.length) return;
      const og = document.createElement("optgroup");
      og.label = rotulo;
      itens.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.nucleo;
        option.textContent = item.rotulo;
        option.dataset.nome = item.nome;
        option.dataset.tipo = item.tipo;
        og.appendChild(option);
      });
      seletor.appendChild(og);
    };
    grupo("Coleções", colecoes);
    grupo("Unidades operacionais", unidades);
    document.getElementById("rel-colecao-inicio").value = formatarDiaInput(primeiroDia);
    document.getElementById("rel-colecao-fim").value = formatarDiaInput(hoje);
  } else {
    const seletorNucleo = document.getElementById("rel-ind-nucleo");
    seletorNucleo.innerHTML = "";
    Object.keys(configuracoes.diagramadoresPorNucleo || {}).forEach((nucleo) => {
      const option = document.createElement("option");
      option.value = nucleo;
      option.textContent = nucleo;
      seletorNucleo.appendChild(option);
    });
    popularDiagramadoresRelatorio();
    document.getElementById("rel-ind-inicio").value = formatarDiaInput(primeiroDia);
    document.getElementById("rel-ind-fim").value = formatarDiaInput(hoje);
  }

  modal.classList.remove("oculto");
  setTimeout(() => modal.querySelector("form:not([hidden]) select")?.focus(), 30);
}

function fecharModalRelatorio() {
  document.getElementById("modal-relatorio").classList.add("oculto");
  tipoRelatorioAberto = null;
  document.getElementById("btn-relatorios")?.focus();
}

function mostrarErroRelatorio(texto) {
  const erro = document.getElementById("relatorio-erro");
  erro.textContent = texto;
  erro.hidden = !texto;
}

function lerPeriodoRelatorio(idInicio, idFim) {
  const inicio = converterDataInputEmDia(document.getElementById(idInicio).value);
  const fim = converterDataInputEmDia(document.getElementById(idFim).value);
  if (inicio === null || fim === null) return { erro: "Informe o período inicial e o período final." };
  if (inicio > fim) return { erro: "O período inicial deve ser anterior ou igual ao período final." };
  return { inicio, fim, texto: `${formatarDiaMes(inicio, true)} a ${formatarDiaMes(fim, true)}` };
}

async function gerarRelatorioSelecionado() {
  if (relatorioEmGeracao || telaAtual !== "resumo") return;
  const botao = document.getElementById("btn-gerar-relatorio");
  mostrarErroRelatorio("");

  const tipo = tipoRelatorioAberto;
  const periodo = tipo === "colecao"
    ? lerPeriodoRelatorio("rel-colecao-inicio", "rel-colecao-fim")
    : lerPeriodoRelatorio("rel-ind-inicio", "rel-ind-fim");
  if (periodo.erro) return mostrarErroRelatorio(periodo.erro);

  let html;
  let pdfIndividual = null; // { dados, nomeArquivo } quando o tipo é individual
  let pdfColecao = null;    // { montar, nomeArquivo } quando o tipo é coleção/unidade
  if (tipo === "colecao") {
    const seletor = document.getElementById("rel-colecao");
    const opcao = seletor.selectedOptions[0];
    if (!opcao) return mostrarErroRelatorio("Selecione uma coleção ou unidade.");
    const chave = obterChaveNucleoMapa(opcao.value);
    // Coleção: demandas pelo núcleo gravado em cada demanda (produção da coleção)
    const lista = demandas.filter((d) => obterChaveNucleoMapa(obterNucleoDaDemanda(d)) === chave);
    const r = calcularRelatorioPerformance(lista, periodo.inicio, periodo.fim);
    const geradoEmColecao = new Date().toLocaleString("pt-BR", { timeZone: FUSO_OPERACIONAL, dateStyle: "short", timeStyle: "short" });
    const dadosColecao = { r, diaInicio: periodo.inicio, diaFim: periodo.fim, agoraMs: Date.now(), lista,
      titulo: opcao.dataset.tipo === "colecao" ? "Performance por Coleção" : "Performance da Unidade",
      alvo: opcao.textContent, periodoTexto: periodo.texto, geradoEm: geradoEmColecao };
    pdfColecao = {
      montar: (logo) => montarDocumentoPdfColecao({ ...dadosColecao, logo }),
      nomeArquivo: montarNomeArquivoRelatorioColecao(opcao.dataset.nome || opcao.textContent, periodo.inicio, periodo.fim),
    };
  } else {
    const nome = document.getElementById("rel-ind-diagramador").value;
    if (!nome) return mostrarErroRelatorio("Selecione um diagramador.");
    const nucleo = document.getElementById("rel-ind-nucleo").value;
    const lista = demandas.filter((d) => normalizarNome(d.diagramador) === normalizarNome(nome));
    const r = calcularRelatorioPerformance(lista, periodo.inicio, periodo.fim);
    const participacao = calcularParticipacaoNoNucleo(demandas, nome, nucleo, periodo.inicio, periodo.fim);
    const geradoEm = new Date().toLocaleString("pt-BR", { timeZone: FUSO_OPERACIONAL, dateStyle: "short", timeStyle: "short" });
    pdfIndividual = {
      dados: { r, part: participacao, diaInicio: periodo.inicio, diaFim: periodo.fim, agoraMs: Date.now(), lista, nome, nucleo, periodoTexto: periodo.texto, geradoEm },
      nomeArquivo: montarNomeArquivoRelatorioIndividual(nome, nucleo, periodo.inicio, periodo.fim),
    };
  }

  relatorioEmGeracao = true;
  botao.disabled = true;
  const textoOriginal = botao.textContent;
  botao.textContent = pdfIndividual || pdfColecao ? "Gerando PDF..." : "Gerando…";
  try {
    await new Promise((ok) => setTimeout(ok, 30)); // deixa o "Gerando…" aparecer
    if (pdfIndividual) {
      await baixarRelatorioIndividualPdf(pdfIndividual.dados, pdfIndividual.nomeArquivo);
    } else if (pdfColecao) {
      await baixarDocumentoPdf(pdfColecao.montar, pdfColecao.nomeArquivo);
    } else {
      await imprimirRelatorioHTML(html);
    }
    fecharModalRelatorio();
  } catch (erro) {
    console.error("Falha ao gerar o relatório:", erro);
    mostrarErroRelatorio(pdfIndividual || pdfColecao
      ? "Não foi possível gerar o PDF. Tente novamente; se o problema continuar, verifique a conexão com a internet (o gerador de PDF é carregado on-line)."
      : "Não foi possível abrir a impressão do relatório. Verifique se o navegador permite impressão nesta página.");
  } finally {
    relatorioEmGeracao = false;
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

function configurarRelatorios() {
  const botao = document.getElementById("btn-relatorios");
  const menu = document.getElementById("menu-relatorios");
  if (!botao || !menu) return;

  botao.addEventListener("click", (e) => {
    e.stopPropagation();
    abrirMenuRelatorios(menu.hidden);
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".menu-relatorios-item");
    if (!item) return;
    abrirMenuRelatorios(false);
    abrirModalRelatorio(item.dataset.relatorio);
  });
  // teclado no menu: setas navegam, Escape fecha
  menu.addEventListener("keydown", (e) => {
    const itens = [...menu.querySelectorAll(".menu-relatorios-item")];
    const i = itens.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); itens[(i + 1) % itens.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); itens[(i - 1 + itens.length) % itens.length].focus(); }
    if (e.key === "Escape") { abrirMenuRelatorios(false); botao.focus(); }
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest("#relatorios-menu-wrap")) abrirMenuRelatorios(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!menu.hidden) abrirMenuRelatorios(false);
    if (!document.getElementById("modal-relatorio").classList.contains("oculto")) fecharModalRelatorio();
  });

  document.getElementById("rel-ind-nucleo").addEventListener("change", popularDiagramadoresRelatorio);
  document.getElementById("btn-gerar-relatorio").addEventListener("click", gerarRelatorioSelecionado);
  document.getElementById("btn-fechar-relatorio").addEventListener("click", fecharModalRelatorio);
  document.getElementById("btn-cancelar-relatorio").addEventListener("click", fecharModalRelatorio);
  document.getElementById("modal-relatorio").addEventListener("click", (e) => {
    if (e.target.id === "modal-relatorio") fecharModalRelatorio();
  });
}
