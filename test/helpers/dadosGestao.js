// Dados FICTÍCIOS para os testes da Gestão (spec 12, B4–B6). Nomes inventados,
// telefones de mentira. As datas são relativas a "agora" para os períodos
// hoje/semana/mês/ano sempre terem movimento.
//
// Barbearia 1: admin Ana (id 1), barbeiros Bruno (2) e Caio (3), Davi (4)
// inativo. Barbearia 2 (id 9) existe só para provar que nada vaza entre elas.
const { criarBanco } = require('./bancoMemoria');

function diaRel(n, agora = new Date()) {
  const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  d.setDate(d.getDate() + n);
  return d;
}
function instante(n, hh, mm = 0, agora = new Date()) {
  const d = diaRel(n, agora);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function montar(agora = new Date()) {
  const usuario = [
    { id: 1, barbeariaId: 1, nome: 'Ana Admin', papel: 'admin', ativo: true, comissaoPercentual: 50, acessosBloqueados: null },
    { id: 2, barbeariaId: 1, nome: 'Bruno Barbeiro', papel: 'funcionario', ativo: true, comissaoPercentual: 40, acessosBloqueados: null },
    { id: 3, barbeariaId: 1, nome: 'Caio Barbeiro', papel: 'funcionario', ativo: true, comissaoPercentual: 50, acessosBloqueados: null },
    { id: 4, barbeariaId: 1, nome: 'Davi Antigo', papel: 'funcionario', ativo: false, comissaoPercentual: 50, acessosBloqueados: null },
    { id: 20, barbeariaId: 9, nome: 'Outra Pessoa', papel: 'admin', ativo: true, comissaoPercentual: 50, acessosBloqueados: null },
  ];
  const servico = [
    { id: 1, barbeariaId: 1, nome: 'Corte', valor: 5000, duracaoMin: 30, ehProduto: false, ehEncaixe: false, comissaoPercentual: 10, ativo: true },
    { id: 2, barbeariaId: 1, nome: 'Barba', valor: 3000, duracaoMin: 20, ehProduto: false, ehEncaixe: true, comissaoPercentual: 10, ativo: true },
    { id: 3, barbeariaId: 1, nome: 'Pomada', valor: 4000, duracaoMin: 0, ehProduto: true, ehEncaixe: false, comissaoPercentual: 15, ativo: true },
    { id: 4, barbeariaId: 1, nome: 'Pigmentação', valor: 8000, duracaoMin: 60, ehProduto: false, ehEncaixe: false, comissaoPercentual: 10, ativo: true },
    { id: 50, barbeariaId: 9, nome: 'Corte X', valor: 9900, duracaoMin: 30, ehProduto: false, ehEncaixe: false, comissaoPercentual: 10, ativo: true },
  ];
  const cliente = [
    { id: 1, barbeariaId: 1, nome: 'Cliente Um', telefone: '11900000001', criadoEm: diaRel(-200, agora) },
    { id: 2, barbeariaId: 1, nome: 'Cliente Dois', telefone: '11900000002', criadoEm: diaRel(-40, agora) },
    { id: 3, barbeariaId: 1, nome: 'Cliente Três', telefone: '11900000003', criadoEm: diaRel(-3, agora) },
    { id: 4, barbeariaId: 1, nome: 'Cliente Quatro', telefone: '11900000004', criadoEm: diaRel(-120, agora) },
    { id: 90, barbeariaId: 9, nome: 'Cliente Outra', telefone: '11900000090', criadoEm: diaRel(-1, agora) },
  ];
  const plano = [{ id: 1, barbeariaId: 1, nome: 'Plano Mensal', tipo: 'ilimitado', valor: 12000, validadeDias: 30, ativo: true }];
  const clientePlano = [{ id: 1, barbeariaId: 1, clienteId: 4, planoId: 1, dataInicio: diaRel(-5, agora), dataFim: diaRel(25, agora), usosRestantes: null, ativo: true, criadoEm: diaRel(-5, agora) }];

  // [id, usuarioId, clienteId, nome, diaAtend, status, itens:[servicoId, valorUnit, qtd], conclDia, conclHora, forma, extra]
  const A = [
    [1, 2, 1, 'Cliente Um', -150, 'concluido', [[1, 5000, 1]], -150, 10, 'pix'],
    [2, 2, 1, 'Cliente Um', -35, 'concluido', [[1, 5000, 1], [2, 3000, 1]], -35, 11, 'dinheiro'],
    [3, 3, 2, 'Cliente Dois', -34, 'concluido', [[4, 8000, 1]], -33, 9, 'credito'],
    [4, 2, 2, 'Cliente Dois', -6, 'concluido', [[1, 5000, 1], [3, 4000, 1]], -6, 15, 'debito'],
    [5, 3, 3, 'Cliente Três', -2, 'concluido', [[1, 5000, 1]], -1, 10, 'pix'],
    [6, 1, 1, 'Cliente Um', -1, 'concluido', [[1, 5000, 1], [2, 3000, 1], [3, 4000, 2]], -1, 18, null, { totalManual: true, valorTotal: 15000 }],
    [7, 2, 4, 'Cliente Quatro', 0, 'concluido', [[1, 0, 1]], 0, 9, null, { clientePlanoId: 1, valorTotal: 0 }],
    [8, 3, 3, 'Cliente Três', 0, 'concluido', [[4, 8000, 1]], 0, 11, 'pix'],
    [9, 2, 1, 'Cliente Um', 0, 'cancelado', [[1, 5000, 1]], null, null, null, { canceladoEm: instante(0, 8, 0, agora), canceladoPor: 'cliente' }],
    [10, 3, 2, 'Cliente Dois', 0, 'faltou', [[1, 5000, 1]], null, null, null],
    [11, 2, 4, 'Cliente Quatro', 0, 'agendado', [[1, 5000, 1]], null, null, null],
    [12, 3, null, 'Avulso Sem Cadastro', -3, 'concluido', [[2, 3000, 1]], -3, 16, 'dinheiro'],
    [13, 4, 4, 'Cliente Quatro', -10, 'concluido', [[1, 5000, 1]], -10, 10, 'pix'],
    [14, 2, 2, 'Cliente Dois', -400, 'concluido', [[1, 4500, 1]], -400, 10, 'pix'],
    [15, 2, 1, 'Cliente Um', 2, 'agendado', [[4, 8000, 1]], null, null, null],
    [16, 2, 3, 'Cliente Três', -20, 'cancelado', [[1, 5000, 1]], null, null, null, { canceladoEm: instante(-21, 9, 0, agora), canceladoPor: 'equipe', motivoCancelamento: 'Chuva' }],
    [17, 3, 4, 'Cliente Quatro', -8, 'faltou', [[1, 5000, 1]], null, null, null],
  ];
  const horas = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'];
  const agendamento = [];
  const agendamentoItem = [];
  const caixa = [];
  const pagamentoAgendamento = [];
  let itemId = 1;
  let caixaId = 1;
  for (const [id, uid, cid, nome, dia, status, itens, cDia, cHora, forma, extra = {}] of A) {
    const soma = itens.reduce((s, [, v, q]) => s + v * q, 0);
    const ag = {
      id, barbeariaId: 1, usuarioId: uid, clienteId: cid, clienteNome: nome, clienteTelefone: '1190000000' + (cid || 0),
      data: diaRel(dia, agora), horaInicio: horas[id % horas.length], status, valorTotal: soma, totalManual: false,
      formaPagamento: forma, concluidoEm: cDia != null ? instante(cDia, cHora, 30, agora) : null, origem: ['publico', 'barbeiro', 'whatsapp', 'app', null][id % 5],
      clientePlanoId: null, criadoEm: diaRel(dia - 2, agora), ...extra,
    };
    agendamento.push(ag);
    for (const [sid, v, q] of itens) agendamentoItem.push({ id: itemId++, agendamentoId: id, servicoId: sid, valorUnitario: v, quantidade: q });
    if (status === 'concluido' && ag.valorTotal > 0) {
      caixa.push({ id: caixaId++, barbeariaId: 1, categoriaId: null, descricao: 'Atendimento — ' + nome, valor: ag.valorTotal, tipo: 'entrada', data: ag.concluidoEm, agendamentoId: id, formaPagamento: forma });
    }
  }
  // Pagamento dividido no atendimento 6 (dinheiro + crédito).
  caixa.splice(caixa.findIndex((c) => c.agendamentoId === 6), 1);
  pagamentoAgendamento.push({ id: 1, barbeariaId: 1, agendamentoId: 6, valor: 9000, formaPagamento: 'dinheiro', parcelas: 1 });
  pagamentoAgendamento.push({ id: 2, barbeariaId: 1, agendamentoId: 6, valor: 6000, formaPagamento: 'credito', parcelas: 2 });
  caixa.push({ id: caixaId++, barbeariaId: 1, descricao: 'Atendimento — Cliente Um', valor: 9000, tipo: 'entrada', data: instante(-1, 18, 30, agora), agendamentoId: 6, formaPagamento: 'dinheiro' });
  caixa.push({ id: caixaId++, barbeariaId: 1, descricao: 'Atendimento — Cliente Um (2x)', valor: 6000, tipo: 'entrada', data: instante(-1, 18, 30, agora), agendamentoId: 6, formaPagamento: 'credito' });
  // Lançamentos manuais: venda de plano, saídas com e sem categoria.
  caixa.push({ id: caixaId++, barbeariaId: 1, descricao: 'Plano Mensal — Cliente Quatro', valor: 12000, tipo: 'entrada', data: instante(-5, 12, 0, agora), formaPagamento: 'pix' });
  caixa.push({ id: caixaId++, barbeariaId: 1, descricao: 'Aluguel', valor: 30000, tipo: 'saida', data: instante(-4, 9, 0, agora), formaPagamento: null });
  caixa.push({ id: caixaId++, barbeariaId: 1, descricao: 'Luz', valor: 4500, tipo: 'saida', data: instante(0, 8, 0, agora), formaPagamento: 'dinheiro' });
  caixa.push({ id: caixaId++, barbeariaId: 1, categoriaId: 1, descricao: 'Lâminas', valor: 2000, tipo: 'saida', data: instante(-36, 8, 0, agora), formaPagamento: 'dinheiro' });
  caixa.push({ id: caixaId++, barbeariaId: 1, descricao: 'Troco inicial', valor: 1000, tipo: 'entrada', data: instante(0, 7, 0, agora), formaPagamento: 'dinheiro' });
  // Outra barbearia: nada disto pode aparecer na barbearia 1.
  agendamento.push({ id: 100, barbeariaId: 9, usuarioId: 20, clienteId: 90, clienteNome: 'Cliente Outra', clienteTelefone: '11900000090', data: diaRel(0, agora), horaInicio: '10:00', status: 'concluido', valorTotal: 9900, concluidoEm: instante(0, 10, 0, agora), formaPagamento: 'pix', origem: 'publico', criadoEm: diaRel(-1, agora) });
  agendamentoItem.push({ id: itemId++, agendamentoId: 100, servicoId: 50, valorUnitario: 9900, quantidade: 1 });
  caixa.push({ id: caixaId++, barbeariaId: 9, descricao: 'Outra', valor: 9900, tipo: 'entrada', data: instante(0, 10, 0, agora), agendamentoId: 100, formaPagamento: 'pix' });

  const horarioTrabalho = [];
  let hid = 1;
  for (const uid of [1, 2, 3, 4]) {
    for (let dow = 0; dow < 7; dow++) {
      horarioTrabalho.push({ id: hid++, barbeariaId: 1, usuarioId: uid, diaSemana: dow, horaInicio: uid === 3 ? '10:00' : '09:00', horaFim: uid === 3 ? '19:00' : '18:00', trabalha: dow !== 0 || uid === 1 });
    }
  }
  horarioTrabalho.push({ id: hid++, barbeariaId: 9, usuarioId: 20, diaSemana: diaRel(0, agora).getDay(), horaInicio: '08:00', horaFim: '20:00', trabalha: true });
  const bloqueio = [
    { id: 1, barbeariaId: 1, usuarioId: 2, data: diaRel(0, agora), horaInicio: '12:00', horaFim: '13:00', motivo: 'Almoço' },
    { id: 2, barbeariaId: 1, usuarioId: 3, data: diaRel(-2, agora), horaInicio: '12:00', horaFim: '14:00', motivo: null },
  ];
  const categoriaCaixa = [{ id: 1, barbeariaId: 1, nome: 'Material', tipo: 'saida' }];
  const meta = [
    { id: 1, barbeariaId: 1, usuarioId: null, metrica: 'faturamento', alvo: 100000, criadoEm: diaRel(-30, agora) },
    { id: 2, barbeariaId: 1, usuarioId: 2, metrica: 'atendimentos', alvo: 10, criadoEm: diaRel(-30, agora) },
    { id: 3, barbeariaId: 1, usuarioId: 3, metrica: 'faturamento', alvo: 50000, criadoEm: diaRel(-30, agora) },
  ];
  return {
    barbearia: [
      { id: 1, nome: 'Barbearia Demo', slug: 'demo-teste', ativo: true, planoCortavo: 'barbearia', situacaoCortavo: 'ativa', criadoEm: diaRel(-300, agora) },
      { id: 9, nome: 'Outra Demo', slug: 'outra', ativo: true, planoCortavo: 'essencial', situacaoCortavo: 'ativa', criadoEm: diaRel(-30, agora) },
    ],
    usuario, servico, cliente, plano, clientePlano, agendamento, agendamentoItem, caixa, pagamentoAgendamento,
    horarioTrabalho, bloqueio, categoriaCaixa, meta, estoque: [], comissaoPagamento: [], planoServico: [],
  };
}

function bancoGestao(agora = new Date()) {
  return criarBanco(montar(agora));
}

module.exports = { montar, bancoGestao, diaRel, instante };
