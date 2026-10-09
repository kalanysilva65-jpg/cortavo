// Agenda reescrita na v3 (F4 sem "ponte"): o que a tela nova manda para o
// servidor tem que continuar funcionando igual. Pagamento dividido, marcar
// pelo plano do cliente e conflito de horário, com o banco em memória.
// Sem banco real, sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoGestao, diaRel } = require('./helpers/dadosGestao');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ana = { usuario: { id: 1, nome: 'Ana Admin', papel: 'admin' } };

function amb({ cobertura } = {}) {
  const banco = bancoGestao();
  banco._tabelas.servicoPrecoBarbeiro = [];
  const registro = [];
  const ctrl = carregar('src/controllers/agendaController.js', {
    prisma: banco,
    stubs: {
      'src/services/estoque.js': { aplicarConsumo: async (id, sinal) => registro.push(['estoque', id, sinal]) },
      'src/services/plano.js': {
        ajustarUso: async (id, delta) => registro.push(['plano', id, delta]),
        servicosCobertosDe: async () => [],
        avaliarCobertura: async (args) => { registro.push(['cobertura', args.clientePlanoId]); return cobertura || { erro: true, mensagem: 'Esse plano não cobre o serviço.' }; },
      },
    },
  });
  return { banco, ctrl, registro };
}
// A tela nova manda tudo por fetch, pedindo JSON.
const reqJson = (extra) => reqFalso({ barbeariaId: 1, ehAdmin: true, session: ana, headers: { accept: 'application/json' }, get: (h) => (h.toLowerCase() === 'accept' ? 'application/json' : ''), ...extra });

function agAberto(banco, extra = {}) {
  const ag = { id: 700, barbeariaId: 1, usuarioId: 2, status: 'agendado', origem: 'barbeiro', criadoEm: new Date(Date.now() - 3600e3), data: diaRel(0), horaInicio: '10:00', valorTotal: 7000, clienteNome: 'Cliente Um', clienteTelefone: '11900000001', clientePlanoId: null, ...extra };
  banco._tabelas.agendamento.push(ag);
  banco._tabelas.agendamentoItem.push({ id: 901, agendamentoId: 700, servicoId: 1, valorUnitario: 5000, quantidade: 1 }, { id: 902, agendamentoId: 700, servicoId: 2, valorUnitario: 2000, quantidade: 1 });
  return ag;
}

// ---------- Pagamento dividido ----------
test('Agenda v3: concluir com pagamento dividido grava as duas partes e uma entrada no caixa', async () => {
  const { banco, ctrl, registro } = amb();
  agAberto(banco);
  const r = resFalso();
  await ctrl.mudarStatus(reqJson({ params: { id: '700' }, body: { status: 'concluido', pagamentos: [{ forma: 'pix', valorCentavos: 5000, parcelas: 1 }, { forma: 'credito', valorCentavos: 2000, parcelas: 2 }] } }), r);
  assert.equal(r.enviado.ok, true);
  const ag = banco._tabelas.agendamento.find((a) => a.id === 700);
  assert.equal(ag.status, 'concluido');
  assert.equal(ag.formaPagamento, null, 'dividido: nenhuma forma "eleita"');
  assert.ok(ag.concluidoEm instanceof Date);
  const partes = banco._tabelas.pagamentoAgendamento.filter((p) => p.agendamentoId === 700);
  assert.deepEqual(partes.map((p) => [p.formaPagamento, p.valor, p.parcelas]).sort(), [['credito', 2000, 2], ['pix', 5000, 1]]);
  assert.ok(banco._tabelas.caixa.some((c) => c.agendamentoId === 700 && c.tipo === 'entrada'), 'entrada no caixa');
  assert.deepEqual(registro.filter((x) => x[0] === 'estoque'), [['estoque', 700, -1]]);
});

test('Agenda v3: divisão que não fecha com o total é recusada e nada muda', async () => {
  const { banco, ctrl } = amb();
  agAberto(banco);
  const r = resFalso();
  await ctrl.mudarStatus(reqJson({ params: { id: '700' }, body: { status: 'concluido', pagamentos: [{ forma: 'pix', valorCentavos: 5000 }, { forma: 'dinheiro', valorCentavos: 1000 }] } }), r);
  assert.ok(r.statusCode >= 400, 'erro');
  assert.match(JSON.stringify(r.enviado), /A divisão soma R\$\s?60,00, mas o atendimento é R\$\s?70,00/);
  assert.equal(banco._tabelas.agendamento.find((a) => a.id === 700).status, 'agendado');
  assert.equal(banco._tabelas.pagamentoAgendamento.filter((p) => p.agendamentoId === 700).length, 0);
});

test('Agenda v3: reconcluir troca a divisão (não soma) e "Faltou" tira do caixa', async () => {
  const { banco, ctrl } = amb();
  agAberto(banco);
  await ctrl.mudarStatus(reqJson({ params: { id: '700' }, body: { status: 'concluido', pagamentos: [{ forma: 'pix', valorCentavos: 7000 }] } }), resFalso());
  await ctrl.mudarStatus(reqJson({ params: { id: '700' }, body: { status: 'concluido', pagamentos: [{ forma: 'dinheiro', valorCentavos: 3500 }, { forma: 'debito', valorCentavos: 3500 }] } }), resFalso());
  assert.equal(banco._tabelas.pagamentoAgendamento.filter((p) => p.agendamentoId === 700).length, 2);
  await ctrl.mudarStatus(reqJson({ params: { id: '700' }, body: { status: 'faltou' } }), resFalso());
  const ag = banco._tabelas.agendamento.find((a) => a.id === 700);
  assert.equal(ag.status, 'faltou');
  assert.ok(!banco._tabelas.caixa.some((c) => c.agendamentoId === 700), 'saiu do caixa');
});

// ---------- Plano do cliente ----------
test('Agenda v3: marcar pelo plano zera o serviço coberto, vincula o dono do plano e consome 1 uso', async () => {
  const cobertura = { erro: false, assinatura: { id: 31, clienteId: 4 }, cobertosIds: [1] };
  const { banco, ctrl, registro } = amb({ cobertura });
  const r = resFalso();
  await ctrl.criarManual(reqJson({ body: { barbeiroId: '2', servicoIds: '1,2', data: iso(diaRel(2)), hora: '15:00', cliente_nome: 'Cliente Quatro', cliente_telefone: '(11) 90000-0004', clientePlanoId: '31' } }), r);
  assert.equal(r.enviado.ok, true, JSON.stringify(r.enviado));
  const ag = banco._tabelas.agendamento.find((a) => a.id === r.enviado.agendamento.id);
  assert.equal(ag.clientePlanoId, 31);
  assert.equal(ag.clienteId, 4);
  assert.equal(ag.valorTotal, 3000, 'Corte pelo plano (0) + Barba (30,00)');
  assert.deepEqual(registro.filter((x) => x[0] === 'plano'), [['plano', 31, -1]]);
});

test('Agenda v3: plano que não cobre volta 400 com a mensagem e não cria nada', async () => {
  const { banco, ctrl } = amb();
  const antes = banco._tabelas.agendamento.length;
  const r = resFalso();
  await ctrl.criarManual(reqJson({ body: { barbeiroId: '2', servicoIds: '4', data: iso(diaRel(2)), hora: '15:00', cliente_nome: 'Cliente Quatro', cliente_telefone: '(11) 90000-0004', clientePlanoId: '31' } }), r);
  assert.equal(r.statusCode, 400);
  assert.match(r.enviado.erro, /não cobre/);
  assert.equal(banco._tabelas.agendamento.length, antes);
});

// ---------- Conflito de horário ----------
test('Agenda v3: horário que sobrepõe outro atendimento do barbeiro é recusado; o vizinho livre passa', async () => {
  const { banco, ctrl } = amb();
  const dia = diaRel(3);
  banco._tabelas.agendamento.push({ id: 800, barbeariaId: 1, usuarioId: 3, status: 'agendado', origem: 'barbeiro', data: dia, horaInicio: '14:00', valorTotal: 5000, clienteNome: 'X', clientePlanoId: null });
  banco._tabelas.agendamentoItem.push({ id: 980, agendamentoId: 800, servicoId: 1, valorUnitario: 5000, quantidade: 1 });
  const corpo = (hora) => ({ barbeiroId: '3', servicoIds: '1', data: iso(dia), hora, cliente_nome: 'Cliente Novo', cliente_telefone: '(11) 97777-0000' });
  const r = resFalso();
  await ctrl.criarManual(reqJson({ body: corpo('14:15') }), r);
  assert.equal(r.statusCode, 400);
  assert.match(r.enviado.erro, /conflita com outro atendimento/);
  const r2 = resFalso();
  await ctrl.criarManual(reqJson({ body: corpo('14:30') }), r2);
  assert.equal(r2.enviado.ok, true, 'logo depois do atendimento de 30 min');
  // Cancelado e faltou não ocupam: o mesmo horário volta a valer.
  banco._tabelas.agendamento.find((a) => a.id === 800).status = 'faltou';
  const r3 = resFalso();
  await ctrl.criarManual(reqJson({ body: { ...corpo('14:00'), cliente_telefone: '(11) 97777-0001' } }), r3);
  assert.equal(r3.enviado.ok, true);
});
