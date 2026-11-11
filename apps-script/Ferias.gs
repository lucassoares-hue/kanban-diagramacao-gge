/**
 * Ferias.gs
 *
 * Cadastro de férias dos diagramadores na aba FERIAS_DIAGRAMADORES.
 * Cabeçalhos esperados (linha 1, localizados PELO NOME, não pela posição):
 *   ID | Diagramador | Data_Inicio | Data_Fim | Observacoes | Data_Registro | Situacao
 *
 * ATENÇÃO - INTEGRAÇÃO AO doGet/doPost DE PRODUÇÃO
 * O doGet/doPost completo de produção NÃO está versionado neste repositório (Code.gs só
 * tem um doPost parcial). Não substitua o roteamento de produção por este arquivo.
 * Depois de recuperar o código de produção e validar em HOMOLOGAÇÃO, ACRESCENTE as
 * linhas abaixo, mantendo todas as ações existentes:
 *
 *   // dentro do doGet(e):
 *   if (e.parameter.acao === 'buscarFerias') {
 *     return respostaJson(buscarFerias());
 *   }
 *
 *   // dentro do doPost(e), após ler dadosRecebidos/acao:
 *   if (acao === 'criarFerias')     return respostaJson(criarFerias(dadosRecebidos.dados));
 *   if (acao === 'atualizarFerias') return respostaJson(atualizarFerias(dadosRecebidos.dados));
 *   if (acao === 'excluirFerias')   return respostaJson(excluirFerias(dadosRecebidos.dados));
 *
 * Respostas: { sucesso: true, ... } ou { sucesso: false, mensagem: '...' }.
 *
 * SITUAÇÃO: o frontend calcula a situação (Programadas / Em férias / Encerradas) a partir
 * das datas, a cada carregamento - não depende da coluna Situacao. A coluna é gravada como
 * referência no momento da escrita e pode ser mantida sincronizada pela função
 * atualizarSituacaoFerias(), com um acionador diário (ver docs/implantacao-ferias.md).
 */

var ABA_FERIAS = 'FERIAS_DIAGRAMADORES';
var CABECALHOS_FERIAS = ['ID', 'Diagramador', 'Data_Inicio', 'Data_Fim', 'Observacoes', 'Data_Registro', 'Situacao'];
var LIMITE_OBSERVACOES_FERIAS = 500;

// ── Utilitários ──────────────────────────────────────────────────────────────

function obterAbaFerias_() {
  var aba = abrirPlanilha().getSheetByName(ABA_FERIAS);
  if (!aba) throw new Error('Aba ' + ABA_FERIAS + ' não encontrada.');
  return aba;
}

// Mapa { nomeDoCabecalho: índice (0-based) }; falha se faltar algum cabeçalho obrigatório
function mapearColunasFerias_(aba) {
  var ultimaColuna = aba.getLastColumn();
  if (ultimaColuna < 1) throw new Error('A aba ' + ABA_FERIAS + ' está sem cabeçalhos.');
  var cabecalho = aba.getRange(1, 1, 1, ultimaColuna).getValues()[0];
  var mapa = {};
  cabecalho.forEach(function (nome, i) { mapa[String(nome).trim()] = i; });
  var faltando = CABECALHOS_FERIAS.filter(function (c) { return mapa[c] === undefined; });
  if (faltando.length) throw new Error('Cabeçalhos ausentes em ' + ABA_FERIAS + ': ' + faltando.join(', '));
  mapa._total = ultimaColuna;
  return mapa;
}

function normalizarNomeFerias_(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// "AAAA-MM-DD" -> Date (meia-noite no fuso da planilha) ou null
function converterDataFerias_(valor) {
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    return new Date(valor.getFullYear(), valor.getMonth(), valor.getDate());
  }
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor || '').trim());
  if (!m) return null;
  var data = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // rejeita datas inexistentes (ex.: 31/02) e anos implausíveis
  if (data.getMonth() !== Number(m[2]) - 1 || data.getFullYear() < 2020 || data.getFullYear() > 2100) return null;
  return data;
}

function formatarDataFerias_(data) {
  return Utilities.formatDate(data, abrirPlanilha().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

function hojeFerias_() {
  var agora = new Date();
  return new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
}

// Situação pelas datas (início e fim INCLUSIVOS)
function calcularSituacaoFerias_(inicio, fim, hoje) {
  hoje = hoje || hojeFerias_();
  if (hoje < inicio) return 'Programadas';
  if (hoje > fim) return 'Encerradas';
  return 'Em férias';
}

function gerarIdFerias_() {
  var carimbo = Utilities.formatDate(new Date(), abrirPlanilha().getSpreadsheetTimeZone(), 'yyyyMMddHHmmss');
  return 'FER-' + carimbo + '-' + Math.floor(1000 + Math.random() * 9000);
}

// Lê todos os períodos como objetos (com o número da linha na planilha)
function lerPeriodosFerias_(aba, col) {
  var ultimaLinha = aba.getLastRow();
  if (ultimaLinha < 2) return [];
  var valores = aba.getRange(2, 1, ultimaLinha - 1, col._total).getValues();
  return valores.map(function (linha, i) {
    return {
      linha: i + 2,
      id: String(linha[col.ID] || '').trim(),
      diagramador: String(linha[col.Diagramador] || '').trim(),
      inicio: converterDataFerias_(linha[col.Data_Inicio]),
      fim: converterDataFerias_(linha[col.Data_Fim]),
      observacoes: String(linha[col.Observacoes] || ''),
    };
  }).filter(function (p) { return p.id; });
}

// Valida os dados recebidos; retorna { erro } ou { diagramador, inicio, fim, observacoes }
function validarDadosFerias_(dados) {
  dados = dados || {};
  var diagramador = String(dados.diagramador || '').trim();
  if (!diagramador) return { erro: 'Diagramador não informado.' };
  var inicio = converterDataFerias_(dados.inicio);
  var fim = converterDataFerias_(dados.fim);
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
    inicio: formatarDataFerias_(p.inicio),
    fim: formatarDataFerias_(p.fim),
    observacoes: p.observacoes,
    situacao: calcularSituacaoFerias_(p.inicio, p.fim),
  };
}

// ── Ações públicas ───────────────────────────────────────────────────────────

/** GET ?acao=buscarFerias -> { sucesso, ferias: [{ id, diagramador, inicio, fim, observacoes, situacao }] } */
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

/** POST { acao: 'criarFerias', dados: { diagramador, inicio, fim, observacoes } } */
function criarFerias(dados) {
  var v = validarDadosFerias_(dados);
  if (v.erro) return { sucesso: false, mensagem: v.erro };
  return executarComLockFerias_(function () {
    var aba = obterAbaFerias_();
    var col = mapearColunasFerias_(aba);
    var conflito = encontrarSobreposicaoFerias_(lerPeriodosFerias_(aba, col), v.diagramador, v.inicio, v.fim, null);
    if (conflito) {
      return { sucesso: false, mensagem: 'Já existe um período de férias de ' + v.diagramador + ' entre ' +
        formatarDataFerias_(conflito.inicio) + ' e ' + formatarDataFerias_(conflito.fim) + '.' };
    }
    var linha = new Array(col._total).fill('');
    var periodo = { id: gerarIdFerias_(), diagramador: v.diagramador, inicio: v.inicio, fim: v.fim, observacoes: v.observacoes };
    linha[col.ID] = periodo.id;
    linha[col.Diagramador] = periodo.diagramador;
    linha[col.Data_Inicio] = periodo.inicio;
    linha[col.Data_Fim] = periodo.fim;
    linha[col.Observacoes] = periodo.observacoes;
    linha[col.Data_Registro] = new Date();
    linha[col.Situacao] = calcularSituacaoFerias_(periodo.inicio, periodo.fim);
    aba.appendRow(linha);
    return { sucesso: true, mensagem: 'Férias cadastradas com sucesso.', ferias: serializarPeriodoFerias_(periodo) };
  });
}

/** POST { acao: 'atualizarFerias', dados: { id, diagramador, inicio, fim, observacoes } } */
function atualizarFerias(dados) {
  var id = String((dados && dados.id) || '').trim();
  if (!id) return { sucesso: false, mensagem: 'ID do período não informado.' };
  var v = validarDadosFerias_(dados);
  if (v.erro) return { sucesso: false, mensagem: v.erro };
  return executarComLockFerias_(function () {
    var aba = obterAbaFerias_();
    var col = mapearColunasFerias_(aba);
    var periodos = lerPeriodosFerias_(aba, col);
    var atual = periodos.filter(function (p) { return p.id === id; })[0];
    if (!atual) return { sucesso: false, mensagem: 'Período de férias não encontrado.' };
    var conflito = encontrarSobreposicaoFerias_(periodos, v.diagramador, v.inicio, v.fim, id);
    if (conflito) {
      return { sucesso: false, mensagem: 'O novo período se sobrepõe a outro período de ' + v.diagramador + '.' };
    }
    // altera só as células do período (nunca a linha inteira com valores antigos)
    aba.getRange(atual.linha, col.Diagramador + 1).setValue(v.diagramador);
    aba.getRange(atual.linha, col.Data_Inicio + 1).setValue(v.inicio);
    aba.getRange(atual.linha, col.Data_Fim + 1).setValue(v.fim);
    aba.getRange(atual.linha, col.Observacoes + 1).setValue(v.observacoes);
    aba.getRange(atual.linha, col.Situacao + 1).setValue(calcularSituacaoFerias_(v.inicio, v.fim));
    var periodo = { id: id, diagramador: v.diagramador, inicio: v.inicio, fim: v.fim, observacoes: v.observacoes };
    return { sucesso: true, mensagem: 'Férias atualizadas com sucesso.', ferias: serializarPeriodoFerias_(periodo) };
  });
}

/** POST { acao: 'excluirFerias', dados: { id } } */
function excluirFerias(dados) {
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
 * Sincroniza a coluna Situacao com as datas (opcional, para quem consulta a planilha
 * diretamente). Configure um acionador diário baseado em tempo para esta função.
 * Só altera células cuja situação mudou.
 */
function atualizarSituacaoFerias() {
  return executarComLockFerias_(function () {
    var aba = obterAbaFerias_();
    var col = mapearColunasFerias_(aba);
    var hoje = hojeFerias_();
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
