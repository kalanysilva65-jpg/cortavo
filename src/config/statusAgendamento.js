// Status do agendamento num lugar só (spec 12, B3).
//
//   agendado  -> marcado, ainda não aconteceu
//   concluido -> atendido (entra no caixa e no faturamento por `concluidoEm`)
//   cancelado -> desmarcado (grava canceladoEm/canceladoPor)
//   faltou    -> o cliente não veio (no-show). SEPARADO de cancelado por decisão
//                da Kalany (2026-10-05): entra na métrica G14 e não na G13.
//
// INATIVOS = não ocupam a agenda (o horário fica livre), não contam na ocupação
// e não entram em conflito com um agendamento novo. "faltou" é inativo porque o
// barbeiro ficou ocioso naquele tempo: contar como ocupado inflaria a ocupação.
//
// Uso do plano do cliente: cancelar devolve o uso; FALTAR NÃO devolve (a vaga
// ficou reservada para ele). Regra em agendaController.mudarStatus.
const AGENDADO = 'agendado';
const CONCLUIDO = 'concluido';
const CANCELADO = 'cancelado';
const FALTOU = 'faltou';

const VALIDOS = [AGENDADO, CONCLUIDO, CANCELADO, FALTOU];
const INATIVOS = [CANCELADO, FALTOU];

// Quem cancelou (Agendamento.canceladoPor).
const CANCELADO_POR = ['equipe', 'cliente', 'secretaria', 'assistente'];

module.exports = { AGENDADO, CONCLUIDO, CANCELADO, FALTOU, VALIDOS, INATIVOS, CANCELADO_POR };
