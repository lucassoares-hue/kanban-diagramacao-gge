/**
 * KANBAN SGGE - Controle de Ferias
 * Codigo.gs (projeto Apps Script INDEPENDENTE, vinculado à planilha KANBAN_SGGE_FERIAS)
 *
 * Este projeto NÃO grava nada no backend de demandas: não altera BASE_DEMANDAS, LISTAS ou
 * LOG_MOVIMENTACOES. Grava somente na planilha à qual está vinculado
 * (SpreadsheetApp.getActiveSpreadsheet()), aba FERIAS_DIAGRAMADORES.
 *
 * Cabeçalhos (linha 1; localizados PELO NOME, a ordem não importa):
 *   ID | Diagramador | Data_Inicio | Data_Fim | Observacoes | Data_Registro | Situacao
 *   + opcional: Registrado_por (auditoria; ver abaixo)
 *
 * PÁGINA (HtmlService): GET sem ação -> página "Programação de férias" (Pagina.html), que
 *   conversa com o servidor por google.script.run (sem CORS). ?diagramador=<nome> apenas
 *   PRÉ-SELECIONA o profissional na tela - não é autorização.
 *
 * AUTENTICAÇÃO / AUTORIZAÇÃO (sempre no servidor):
 *   · usuário = Session.getActiveUser().getEmail() (implantação "Qualquer pessoa no
 *     domínio", executando como o dono). E-mail vazio => escrita negada.
 *   · Propriedade do script FERIAS_EDITORES = e-mails autorizados a gravar (separados por
 *     vírgula, ponto e vírgula, espaço ou quebra de linha). Nenhum e-mail fica no código.
 *   · TODA escrita (criar/atualizar/excluir/atualizarSituacao) verifica a autorização,
 *     inclusive quando chamada direto (doPost ou google.script.run), sem passar pela tela.
 *   · Diagramador validado contra a lista OFICIAL (aba LISTAS do Kanban), obtida SOMENTE
 *     POR LEITURA em <URL_CONFIGURACOES>?acao=buscarConfiguracoes (Propriedade do script),
 *     com cache de 6 h. Sem lista disponível, a gravação é negada.
 *
 * AUDITORIA: se a aba tiver a coluna opcional "Registrado_por", ela recebe o e-mail de quem
 *   criou ou alterou o período por último. Sem a coluna, tudo funciona e a auditoria fica
 *   desativada (a página informa).
 *
 * AÇÕES DO WEB APP (JSON)
 *   GET  ?acao=buscarFerias                         -> { sucesso, ferias: [...] }
 *   GET  ?acao=status                               -> { sucesso, mensagem: "...online" }
 *   POST { acao: "criarFerias",     dados: {...} }  -> { sucesso, mensagem, ferias }
 *   POST { acao: "atualizarFerias", dados: {...} }  -> { sucesso, mensagem, ferias }
 *   POST { acao: "excluirFerias",   dados: { id } } -> { sucesso, mensagem, id }
 *   Erros: { sucesso: false, mensagem } (+ naoAutorizado: true quando for o caso).
 *   Período: { id, diagramador, inicio: "AAAA-MM-DD", fim: "AAAA-MM-DD", observacoes,
 *              registradoPor, situacao }
 *
 * DATAS: tratadas como DIAS de calendário ("AAAA-MM-DD"), sem horas:
 *   · células lidas pelo fuso da planilha (como aparecem na tela);
 *   · "hoje" calculado no fuso operacional America/Recife;
 *   · gravadas como texto ISO "AAAA-MM-DD", que o Sheets converte em data.
 *
 * SITUAÇÃO (início e fim inclusivos): Programadas | Em férias | Encerradas.
 *   Sempre recalculada nas respostas; a coluna Situacao é gravada nas escritas e pode ser
 *   mantida em dia por um acionador diário de atualizarSituacaoFerias().
 *
 * Nenhum dado pessoal é enviado ao console/logs.
 */

var ABA_FERIAS = 'FERIAS_DIAGRAMADORES';
var CABECALHOS_FERIAS = ['ID', 'Diagramador', 'Data_Inicio', 'Data_Fim', 'Observacoes', 'Data_Registro', 'Situacao'];
var COLUNA_AUDITORIA = 'Registrado_por'; // opcional
var FUSO_OPERACIONAL = 'America/Recife';
var LIMITE_OBSERVACOES_FERIAS = 500;
var LIMITE_NOME_DIAGRAMADOR = 120;
var ANO_MINIMO_FERIAS = 2020;
var ANO_MAXIMO_FERIAS = 2100;
var PROP_EDITORES = 'FERIAS_EDITORES';            // Propriedade do script
var PROP_URL_CONFIGURACOES = 'URL_CONFIGURACOES'; // Propriedade do script
var CHAVE_CACHE_DIAGRAMADORES = 'ferias_diagramadores_oficiais_v1';
var CACHE_DIAGRAMADORES_SEGUNDOS = 6 * 60 * 60;

// ══ Web App ═══════════════════════════════════════════════════════════════════

function doGet(e) {
  try {
    var acao = e && e.parameter ? String(e.parameter.acao || '') : '';
    if (acao === 'buscarFerias') return respostaJson(buscarFerias());
    if (acao === 'status') return respostaJson({ sucesso: true, mensagem: 'KANBAN SGGE - Controle de Ferias online' });
    if (!acao) {
      return HtmlService.createHtmlOutputFromFile('Pagina')
        .setTitle('Programação de férias · KANBAN - SGGE')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    }
    return respostaJson({ sucesso: false, mensagem: 'Ação não reconhecida: ' + acao });
  } catch (erro) {
    return respostaJson({ sucesso: false, mensagem: 'Erro ao processar a requisição.' });
  }
}

function doPost(e) {
  var corpo;
  try {
    corpo = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (erro) {
    return respostaJson({ sucesso: false, mensagem: 'Requisição inválida: o corpo não é um JSON válido.' });
  }
  var acao = String(corpo.acao || '');
  var dados = corpo.dados || {};
  try {
    if (acao === 'criarFerias') return respostaJson(criarFerias(dados));
    if (acao === 'atualizarFerias') return respostaJson(atualizarFerias(dados));
    if (acao === 'excluirFerias') return respostaJson(excluirFerias(dados));
    return respostaJson({ sucesso: false, mensagem: 'Ação não reconhecida: ' + acao });
  } catch (erro) {
    return respostaJson({ sucesso: false, mensagem: 'Erro ao processar a requisição.' });
  }
}

function respostaJson(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// ══ Utilitários ═══════════════════════════════════════════════════════════════

function abrirPlanilhaFerias_() {
  var planilha = SpreadsheetApp.getActiveSpreadsheet();
  if (!planilha) throw new Error('Este projeto precisa estar vinculado à planilha KANBAN_SGGE_FERIAS.');
  return planilha;
}

function obterAbaFerias_() {
  var aba = abrirPlanilhaFerias_().getSheetByName(ABA_FERIAS);
  if (!aba) throw new Error('Aba ' + ABA_FERIAS + ' não encontrada.');
  return aba;
}

// Mapa { nomeDoCabecalho: índice (0-based) }; falha se faltar algum cabeçalho obrigatório
function mapearColunasFerias_(aba) {
  var ultimaColuna = aba.getLastColumn();
  if (ultimaColuna < 1) throw new Error('A aba ' + ABA_FERIAS + ' está sem cabeçalhos.');
  var cabecalho = aba.getRange(1, 1, 1, ultimaColuna).getValues()[0];
  var mapa = {};
  cabecalho.forEach(function (nome, i) {
    var chave = String(nome).trim();
    if (chave && mapa[chave] === undefined) mapa[chave] = i;
  });
  var faltando = CABECALHOS_FERIAS.filter(function (c) { return mapa[c] === undefined; });
  if (faltando.length) throw new Error('Cabeçalhos ausentes em ' + ABA_FERIAS + ': ' + faltando.join(', '));
  mapa._total = ultimaColuna;
  return mapa;
}

function normalizarNomeFerias_(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Dia "AAAA-MM-DD" válido (data existente, ano plausível) ou null
function validarDiaIso_(texto) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto || '').trim());
  if (!m) return null;
  var ano = Number(m[1]), mes = Number(m[2]), dia = Number(m[3]);
  if (ano < ANO_MINIMO_FERIAS || ano > ANO_MAXIMO_FERIAS || mes < 1 || mes > 12) return null;
  var ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  if (dia < 1 || dia > ultimoDia) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

// Valor de célula -> "AAAA-MM-DD" (Date lido no fuso da planilha) ou null
function lerDiaDaCelula_(valor, fusoPlanilha) {
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    return Utilities.formatDate(valor, fusoPlanilha, 'yyyy-MM-dd');
  }
  return validarDiaIso_(valor);
}

function hojeOperacional_() {
  return Utilities.formatDate(new Date(), FUSO_OPERACIONAL, 'yyyy-MM-dd');
}

// Situação pelas datas (strings "AAAA-MM-DD" comparam corretamente em ordem lexicográfica)
function calcularSituacaoFerias_(inicio, fim, hoje) {
  hoje = hoje || hojeOperacional_();
  if (hoje < inicio) return 'Programadas';
  if (hoje > fim) return 'Encerradas';
  return 'Em férias';
}

function gerarIdFerias_() {
  var carimbo = Utilities.formatDate(new Date(), FUSO_OPERACIONAL, 'yyyyMMddHHmmss');
  return 'FER-' + carimbo + '-' + Math.floor(1000 + Math.random() * 9000);
}

// Todos os períodos como objetos (com o número da linha na planilha)
function lerPeriodosFerias_(aba, col) {
  var ultimaLinha = aba.getLastRow();
  if (ultimaLinha < 2) return [];
  var fuso = abrirPlanilhaFerias_().getSpreadsheetTimeZone();
  var valores = aba.getRange(2, 1, ultimaLinha - 1, col._total).getValues();
  var colAuditoria = col[COLUNA_AUDITORIA];
  return valores.map(function (linha, i) {
    return {
      linha: i + 2,
      id: String(linha[col.ID] || '').trim(),
      diagramador: String(linha[col.Diagramador] || '').trim(),
      inicio: lerDiaDaCelula_(linha[col.Data_Inicio], fuso),
      fim: lerDiaDaCelula_(linha[col.Data_Fim], fuso),
      observacoes: String(linha[col.Observacoes] || ''),
      registradoPor: colAuditoria === undefined ? '' : String(linha[colAuditoria] || ''),
    };
  }).filter(function (p) { return p.id; });
}

// Valida os dados recebidos; retorna { erro } ou { diagramador, inicio, fim, observacoes }
function validarDadosFerias_(dados) {
  dados = dados || {};
  var diagramador = String(dados.diagramador || '').trim();
  if (!diagramador) return { erro: 'Diagramador não informado.' };
  if (diagramador.length > LIMITE_NOME_DIAGRAMADOR) return { erro: 'Nome do diagramador muito longo.' };
  var inicio = validarDiaIso_(dados.inicio);
  var fim = validarDiaIso_(dados.fim);
  if (!inicio || !fim) return { erro: 'Informe datas válidas no formato AAAA-MM-DD.' };
  if (fim < inicio) return { erro: 'A data de término não pode ser anterior à data de início.' };
  var observacoes = String(dados.observacoes || '').trim();
  if (observacoes.length > LIMITE_OBSERVACOES_FERIAS) {
    return { erro: 'As observações devem ter no máximo ' + LIMITE_OBSERVACOES_FERIAS + ' caracteres.' };
  }
  return { diagramador: diagramador, inicio: inicio, fim: fim, observacoes: observacoes };
}

// Período sobreposto do MESMO profissional (intervalos inclusivos), ignorando idIgnorado
function encontrarSobreposicaoFerias_(periodos, diagramador, inicio, fim, idIgnorado) {
  var nome = normalizarNomeFerias_(diagramador);
  for (var i = 0; i < periodos.length; i++) {
    var p = periodos[i];
    if (p.id === idIgnorado || normalizarNomeFerias_(p.diagramador) !== nome || !p.inicio || !p.fim) continue;
    if (p.inicio <= fim && inicio <= p.fim) return p;
  }
  return null;
}

function executarComLockFerias_(funcao) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { sucesso: false, mensagem: 'O sistema está ocupado. Tente novamente em instantes.' };
  }
  try {
    return funcao();
  } catch (erro) {
    return { sucesso: false, mensagem: 'Erro ao gravar férias: ' + erro.message };
  } finally {
    lock.releaseLock();
  }
}

function serializarPeriodoFerias_(p) {
  return {
    id: p.id,
    diagramador: p.diagramador,
    inicio: p.inicio,
    fim: p.fim,
    observacoes: p.observacoes,
    registradoPor: p.registradoPor || '',
    situacao: calcularSituacaoFerias_(p.inicio, p.fim),
  };
}

// ══ Autenticação, autorização e lista oficial ═════════════════════════════════

function obterEmailUsuario_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (erro) {
    return '';
  }
}

function obterEditores_() {
  var valor = PropertiesService.getScriptProperties().getProperty(PROP_EDITORES) || '';
  return valor.split(/[,;\s]+/)
    .map(function (e) { return e.trim().toLowerCase(); })
    .filter(function (e) { return e && e.indexOf('@') > 0; });
}

// { email, podeEditar, motivo }
function verificarAutorizacao_() {
  var email = obterEmailUsuario_();
  if (!email) {
    return { email: '', podeEditar: false, motivo: 'Não foi possível identificar o usuário. Gravação não permitida.' };
  }
  if (obterEditores_().indexOf(email) === -1) {
    return { email: email, podeEditar: false, motivo: 'Seu usuário não tem permissão para cadastrar, editar ou excluir férias.' };
  }
  return { email: email, podeEditar: true, motivo: '' };
}

// null se autorizado; senão, a resposta de erro padronizada
function exigirEditor_() {
  var auth = verificarAutorizacao_();
  return auth.podeEditar ? null : { sucesso: false, mensagem: auth.motivo, naoAutorizado: true };
}

// Lista oficial de diagramadores: [{ nome, nucleo }] ou null (indisponível).
// SOMENTE LEITURA: GET <URL_CONFIGURACOES>?acao=buscarConfiguracoes. Nenhuma outra ação é
// enviada ao backend de demandas.
function obterDiagramadoresOficiais_() {
  var cache = CacheService.getScriptCache();
  var emCache = cache.get(CHAVE_CACHE_DIAGRAMADORES);
  if (emCache) {
    try { return JSON.parse(emCache); } catch (e) { /* recalcula */ }
  }
  var url = String(PropertiesService.getScriptProperties().getProperty(PROP_URL_CONFIGURACOES) || '').trim();
  if (!/^https:\/\/script\.google\.com\//.test(url)) return null;
  try {
    var resposta = UrlFetchApp.fetch(url + '?acao=buscarConfiguracoes', { method: 'get', muteHttpExceptions: true, followRedirects: true });
    if (resposta.getResponseCode() !== 200) return null;
    var dados = JSON.parse(resposta.getContentText());
    var grupos = dados && dados.sucesso && dados.configuracoes && dados.configuracoes.diagramadoresPorNucleo;
    if (!grupos || typeof grupos !== 'object') return null;
    var vistos = {};
    var lista = [];
    Object.keys(grupos).forEach(function (nucleo) {
      (grupos[nucleo] || []).forEach(function (nome) {
        var n = String(nome || '').trim();
        var chave = normalizarNomeFerias_(n);
        if (n && !vistos[chave]) {
          vistos[chave] = true;
          lista.push({ nome: n, nucleo: String(nucleo) });
        }
      });
    });
    if (!lista.length) return null;
    cache.put(CHAVE_CACHE_DIAGRAMADORES, JSON.stringify(lista), CACHE_DIAGRAMADORES_SEGUNDOS);
    return lista;
  } catch (erro) {
    return null;
  }
}

// { nome } (grafia oficial) ou { erro }
function validarDiagramadorOficial_(nome) {
  var lista = obterDiagramadoresOficiais_();
  if (!lista) return { erro: 'Lista oficial de diagramadores indisponível no momento. Tente novamente mais tarde.' };
  var chave = normalizarNomeFerias_(nome);
  for (var i = 0; i < lista.length; i++) {
    if (normalizarNomeFerias_(lista[i].nome) === chave) return { nome: lista[i].nome };
  }
  return { erro: 'Diagramador não encontrado na lista oficial.' };
}

/**
 * Dados iniciais da página (google.script.run). Leitura para usuários do domínio (a
 * implantação já exige login). Não expõe a lista de editores.
 */
function obterContextoFerias() {
  var auth = verificarAutorizacao_();
  var auditoriaAtiva = false;
  try {
    auditoriaAtiva = mapearColunasFerias_(obterAbaFerias_())[COLUNA_AUDITORIA] !== undefined;
  } catch (erro) {
    return { sucesso: false, mensagem: erro.message };
  }
  var busca = buscarFerias();
  if (!busca.sucesso) return busca;
  var diagramadores = obterDiagramadoresOficiais_() || [];
  return {
    sucesso: true,
    usuario: auth.email,
    podeEditar: auth.podeEditar,
    motivo: auth.motivo,
    auditoriaAtiva: auditoriaAtiva,
    diagramadores: diagramadores,
    listaOficialDisponivel: diagramadores.length > 0,
    hoje: hojeOperacional_(),
    ferias: busca.ferias,
  };
}

// ══ Ações ═════════════════════════════════════════════════════════════════════

/** Lista os períodos válidos (inválidos/corrompidos são ignorados, sem expor conteúdo). */
function buscarFerias() {
  try {
    var aba = obterAbaFerias_();
    var col = mapearColunasFerias_(aba);
    var ferias = lerPeriodosFerias_(aba, col)
      .filter(function (p) { return p.inicio && p.fim && p.fim >= p.inicio; })
      .map(serializarPeriodoFerias_);
    return { sucesso: true, ferias: ferias };
  } catch (erro) {
    return { sucesso: false, mensagem: 'Erro ao buscar férias: ' + erro.message };
  }
}

function criarFerias(dados) {
  var negado = exigirEditor_();
  if (negado) return negado;
  var v = validarDadosFerias_(dados);
  if (v.erro) return { sucesso: false, mensagem: v.erro };
  var oficial = validarDiagramadorOficial_(v.diagramador);
  if (oficial.erro) return { sucesso: false, mensagem: oficial.erro };
  v.diagramador = oficial.nome;
  var responsavel = obterEmailUsuario_();
  return executarComLockFerias_(function () {
    var aba = obterAbaFerias_();
    var col = mapearColunasFerias_(aba);
    var conflito = encontrarSobreposicaoFerias_(lerPeriodosFerias_(aba, col), v.diagramador, v.inicio, v.fim, null);
    if (conflito) {
      return { sucesso: false, mensagem: 'Já existe um período de férias de ' + v.diagramador +
        ' entre ' + conflito.inicio + ' e ' + conflito.fim + '.' };
    }
    var periodo = { id: gerarIdFerias_(), diagramador: v.diagramador, inicio: v.inicio, fim: v.fim, observacoes: v.observacoes, registradoPor: '' };
    var linha = [];
    for (var i = 0; i < col._total; i++) linha.push('');
    linha[col.ID] = periodo.id;
    linha[col.Diagramador] = periodo.diagramador;
    linha[col.Data_Inicio] = periodo.inicio; // texto ISO -> o Sheets converte em data
    linha[col.Data_Fim] = periodo.fim;
    linha[col.Observacoes] = periodo.observacoes;
    linha[col.Data_Registro] = new Date();
    linha[col.Situacao] = calcularSituacaoFerias_(periodo.inicio, periodo.fim);
    if (col[COLUNA_AUDITORIA] !== undefined) {
      linha[col[COLUNA_AUDITORIA]] = responsavel;
      periodo.registradoPor = responsavel;
    }
    aba.appendRow(linha);
    return { sucesso: true, mensagem: 'Férias cadastradas com sucesso.', ferias: serializarPeriodoFerias_(periodo) };
  });
}

function atualizarFerias(dados) {
  var negado = exigirEditor_();
  if (negado) return negado;
  var id = String((dados && dados.id) || '').trim();
  if (!id) return { sucesso: false, mensagem: 'ID do período não informado.' };
  var v = validarDadosFerias_(dados);
  if (v.erro) return { sucesso: false, mensagem: v.erro };
  var oficial = validarDiagramadorOficial_(v.diagramador);
  if (oficial.erro) return { sucesso: false, mensagem: oficial.erro };
  v.diagramador = oficial.nome;
  var responsavel = obterEmailUsuario_();
  return executarComLockFerias_(function () {
    var aba = obterAbaFerias_();
    var col = mapearColunasFerias_(aba);
    var periodos = lerPeriodosFerias_(aba, col);
    var atual = periodos.filter(function (p) { return p.id === id; })[0];
    if (!atual) return { sucesso: false, mensagem: 'Período de férias não encontrado.' };
    if (encontrarSobreposicaoFerias_(periodos, v.diagramador, v.inicio, v.fim, id)) {
      return { sucesso: false, mensagem: 'O novo período se sobrepõe a outro período de ' + v.diagramador + '.' };
    }
    // altera só as células do período (nunca a linha inteira)
    aba.getRange(atual.linha, col.Diagramador + 1).setValue(v.diagramador);
    aba.getRange(atual.linha, col.Data_Inicio + 1).setValue(v.inicio);
    aba.getRange(atual.linha, col.Data_Fim + 1).setValue(v.fim);
    aba.getRange(atual.linha, col.Observacoes + 1).setValue(v.observacoes);
    aba.getRange(atual.linha, col.Situacao + 1).setValue(calcularSituacaoFerias_(v.inicio, v.fim));
    var registradoPor = atual.registradoPor;
    if (col[COLUNA_AUDITORIA] !== undefined) {
      aba.getRange(atual.linha, col[COLUNA_AUDITORIA] + 1).setValue(responsavel);
      registradoPor = responsavel;
    }
    var periodo = { id: id, diagramador: v.diagramador, inicio: v.inicio, fim: v.fim, observacoes: v.observacoes, registradoPor: registradoPor };
    return { sucesso: true, mensagem: 'Férias atualizadas com sucesso.', ferias: serializarPeriodoFerias_(periodo) };
  });
}

function excluirFerias(dados) {
  var negado = exigirEditor_();
  if (negado) return negado;
  var id = String((dados && dados.id) || '').trim();
  if (!id) return { sucesso: false, mensagem: 'ID do período não informado.' };
  return executarComLockFerias_(function () {
    var aba = obterAbaFerias_();
    var col = mapearColunasFerias_(aba);
    var atual = lerPeriodosFerias_(aba, col).filter(function (p) { return p.id === id; })[0];
    if (!atual) return { sucesso: false, mensagem: 'Período de férias não encontrado.' };
    aba.deleteRow(atual.linha);
    return { sucesso: true, mensagem: 'Férias excluídas com sucesso.', id: id };
  });
}

/**
 * Mantém a coluna Situacao em dia para quem consulta a planilha diretamente.
 * Configure um acionador diário (baseado em tempo) para esta função; ele roda como o dono
 * do projeto. Como a função é pública e grava, quem a chamar pela página precisa ser
 * editor autorizado. Só altera as células cuja situação mudou.
 */
function atualizarSituacaoFerias() {
  var email = obterEmailUsuario_();
  var dono = '';
  try { dono = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { dono = ''; }
  if (!(email && dono && email === dono)) {
    var negado = exigirEditor_();
    if (negado) return negado;
  }
  return executarComLockFerias_(function () {
    var aba = obterAbaFerias_();
    var col = mapearColunasFerias_(aba);
    var hoje = hojeOperacional_();
    var alteradas = 0;
    lerPeriodosFerias_(aba, col).forEach(function (p) {
      if (!p.inicio || !p.fim) return;
      var situacao = calcularSituacaoFerias_(p.inicio, p.fim, hoje);
      var celula = aba.getRange(p.linha, col.Situacao + 1);
      if (celula.getValue() !== situacao) {
        celula.setValue(situacao);
        alteradas++;
      }
    });
    return { sucesso: true, alteradas: alteradas };
  });
}
