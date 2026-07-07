/**
 * Config.gs
 *
 * Configurações gerais do projeto: IDs da planilha,
 * nomes das abas, colunas esperadas e demais constantes
 * usadas pelos outros scripts.
 */

// Nome da aba que guarda a base de demandas (linha 1 = cabeçalho com os nomes dos campos;
// a coluna A dessa aba é o ID da demanda)
var ABA_BASE_DEMANDAS = 'BASE_DEMANDAS';

/**
 * Abre a planilha usada pelo projeto.
 *
 * IMPORTANTE: se este Apps Script já estiver vinculado (container-bound) à planilha
 * do Kanban, SpreadsheetApp.getActiveSpreadsheet() funciona normalmente. Se for um
 * script standalone (não vinculado), getActiveSpreadsheet() retorna null dentro do
 * doPost - nesse caso, troque a linha abaixo por:
 *   return SpreadsheetApp.openById('SEU_ID_DA_PLANILHA_AQUI');
 */
function abrirPlanilha() {
  return SpreadsheetApp.getActiveSpreadsheet();
}
