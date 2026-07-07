/**
 * Code.gs
 *
 * Ponto de entrada do projeto Google Apps Script.
 * Aqui ficam as funções de entrada da Web App (doGet/doPost)
 * que servem o Kanban e recebem requisições do frontend.
 *
 * ATENÇÃO: este arquivo, neste repositório, continha apenas este cabeçalho de
 * comentário (sem doPost implementado) - o doPost de produção, com as ações
 * "criar", "atualizar", "atualizar-status" e "buscarConfiguracoes", não está
 * versionado aqui. O doPost abaixo foi criado para registrar a nova ação
 * "excluirDemanda". NÃO publique este arquivo substituindo o doPost real do
 * projeto: copie apenas o bloco abaixo
 *
 *   if (acao === 'excluirDemanda') {
 *     var resultado = excluirDemanda(dadosRecebidos.dados);
 *     return respostaJson(resultado);
 *   }
 *
 * para dentro do doPost(e) que já está publicado, mantendo as demais ações
 * intactas. Se este projeto ainda não tiver nenhum doPost publicado, o arquivo
 * abaixo já funciona sozinho para a ação "excluirDemanda".
 */

function doPost(e) {
  try {
    var dadosRecebidos = JSON.parse(e.postData.contents);
    var acao = dadosRecebidos.acao;

    if (acao === 'excluirDemanda') {
      const resultado = excluirDemanda(dadosRecebidos.dados);
      return respostaJson(resultado);
    }

    // Demais ações (criar, atualizar, atualizar-status, buscarConfiguracoes, ...)
    // devem continuar com a implementação já publicada em produção.
    return respostaJson({
      sucesso: false,
      mensagem: 'Ação não reconhecida neste doPost: ' + acao,
    });
  } catch (erro) {
    return respostaJson({
      sucesso: false,
      mensagem: 'Erro ao processar a requisição: ' + erro.message,
    });
  }
}

/**
 * Monta a resposta JSON padrão devolvida pelo Web App.
 */
function respostaJson(objeto) {
  return ContentService
    .createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}
