// Constantes de configuração de funcionamento e agendamento.
module.exports = {
  // Intervalo (em minutos) entre os horários oferecidos ao cliente.
  // Configurável: mudar aqui altera a grade de horários do agendamento.
  INTERVALO_SLOT_MIN: 30,

  // Horário de funcionamento padrão (usado no seed das jornadas).
  HORA_ABERTURA_PADRAO: '09:00',
  HORA_FECHAMENTO_PADRAO: '20:00',

  // Nomes dos dias da semana (índice 0 = domingo), para exibição.
  DIAS_SEMANA: ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],

  // Comissão fixa dos produtos (em %). Serviços usam a % de cada barbeiro.
  COMISSAO_PRODUTO_PERCENTUAL: 10,

  // Contato de ajuda da Cortavo mostrado nas telas (lugar único; a spec 11
  // reutiliza). Disponível nas views como `suporteCortavo`.
  SUPORTE_CORTAVO: 'cortavo.app@gmail.com',
};
