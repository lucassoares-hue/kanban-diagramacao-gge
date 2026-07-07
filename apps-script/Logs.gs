/**
 * Logs.gs
 *
 * Funções de registro de eventos e alterações de status das
 * demandas, usadas para alimentar as métricas de produtividade
 * da equipe de diagramação.
 *
 * O registro do log de exclusão de demanda é feito diretamente dentro de
 * excluirDemanda() (em Demandas.gs), chamando registrarLog(dados) - a mesma
 * função genérica já usada pelas demais ações (criar, atualizar, etc.), que
 * deve estar implementada neste arquivo na versão de produção do projeto.
 */
