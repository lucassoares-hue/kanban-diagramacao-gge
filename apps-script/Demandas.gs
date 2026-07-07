/**
 * Demandas.gs
 *
 * Funções de CRUD das demandas de diagramação na planilha:
 * criar, listar, atualizar status e remover demandas,
 * usadas como base de dados de produtividade da equipe.
 */

/**
 * Exclui uma demanda da aba BASE_DEMANDAS, localizando a linha pela coluna ID (coluna A).
 * Guarda os dados da linha antes de excluir, para registrar no log.
 *
 * @param {{ID: string}} dados - objeto recebido do frontend, com o ID da demanda
 * @return {{sucesso: boolean, mensagem: string}}
 */
function excluirDemanda(dados) {
  try {
    const id = dados && dados.ID ? String(dados.ID).trim() : '';

    if (!id) {
      return {
        sucesso: false,
        mensagem: 'ID da demanda não informado.'
      };
    }

    const planilha = abrirPlanilha();
    const abaBase = planilha.getSheetByName(ABA_BASE_DEMANDAS);

    if (!abaBase) {
      return {
        sucesso: false,
        mensagem: 'Aba BASE_DEMANDAS não encontrada.'
      };
    }

    const ultimaLinha = abaBase.getLastRow();

    if (ultimaLinha < 2) {
      return {
        sucesso: false,
        mensagem: 'Nenhuma demanda cadastrada.'
      };
    }

    const dadosBase = abaBase.getRange(2, 1, ultimaLinha - 1, abaBase.getLastColumn()).getValues();

    let linhaEncontrada = -1;
    let demandaAntes = null;

    for (let i = 0; i < dadosBase.length; i++) {
      const idLinha = String(dadosBase[i][0] || '').trim();

      if (idLinha === id) {
        linhaEncontrada = i + 2;
        demandaAntes = dadosBase[i];
        break;
      }
    }

    if (linhaEncontrada === -1) {
      return {
        sucesso: false,
        mensagem: 'Demanda não encontrada para exclusão.',
        idRecebido: id
      };
    }

    abaBase.deleteRow(linhaEncontrada);

    if (typeof registrarLog === 'function') {
      // Session.getActiveUser().getEmail() pode lançar erro de permissão dependendo de
      // como o Web App foi implantado (ex: acesso anônimo) - isolado num try próprio
      // para que uma falha aqui nunca derrube a exclusão, que já foi concluída acima.
      var usuario = 'Usuário não identificado';
      try {
        usuario = Session.getActiveUser().getEmail() || usuario;
      } catch (erroUsuario) {
        // Mantém o valor padrão "Usuário não identificado"
      }

      try {
        registrarLog({
          ID_Demanda: id,
          Usuario: usuario,
          Acao: 'EXCLUSÃO',
          Campo_Alterado: 'Linha completa',
          Valor_Anterior: JSON.stringify(demandaAntes),
          Valor_Novo: '',
          Status_Anterior: demandaAntes[11] || '',
          Status_Novo: '',
          Observacao_Log: 'Demanda excluída pelo usuário.'
        });
      } catch (erroLog) {
        // A demanda já foi excluída com sucesso; uma falha apenas no registro de log
        // não deve fazer a exclusão parecer ter falhado para o usuário
      }
    }

    return {
      sucesso: true,
      mensagem: 'Demanda excluída com sucesso.',
      id: id
    };

  } catch (erro) {
    return {
      sucesso: false,
      mensagem: 'Erro ao excluir demanda.',
      erro: erro.message
    };
  }
}
