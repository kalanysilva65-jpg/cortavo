// Desfazer agendamento recém-criado (redesign v3: aviso "Agendamento criado ·
// Desfazer") e criação pela folha "Novo" respondendo em JSON.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoGestao, diaRel } = require('./helpers/dadosGestao');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function amb(registro = []) {
  const banco = bancoGestao();
  banco._tabelas.servicoPrecoBarbeiro = [];
  const ctrl = carregar('src/controllers/agendaController.js', {
    prisma: banco,
    stubs: {
      'src/services/plano.js': {
        ajustarUso: async (id, delta) => registro.push(['plano', id, delta]),
        servicosCobertosDe: async () => [],
        avaliarCobertura: async () => ({ erro: true, mensagem: 'sem plano' }),
      },
    },
  });
  return { banco, ctrl, registro };
}
function req(extra) {
  return reqFalso({ barbeariaId: 1, headers: { accept: 'application/json' }, get: (h) => (h.toLowerCase() === 'accept' ? 'application/json' : ''), ...extra });
}
const admin = { usuario: { id: 1, nome: 'Ana Admin', papel: 'admin' } };
const bruno = { usuario: { id: 2, nome: 'Bruno Barbeiro', papel: 'funcionario' } };

function novoAg(banco, extra = {}) {
  const ag = { id: 500, barbeariaId: 1, usuarioId: 2, status: 'agendado', origem: 'barbeiro', criadoEm: new Date(), data: diaRel(1), horaInicio: '10:00', valorTotal: 5000, clienteNome: 'Cliente Um', clientePlanoId: null, ...extra };
  banco._tabelas.agendamento.push(ag);
  banco._tabelas.agendamentoItem.push({ id: 900, agendamentoId: 500, servicoId: 1, valorUnitario: 5000, quantidade: 1 });
  return ag;
}

test('Desfazer dentro da janela apaga o agendamento (e devolve o uso do plano)', async () => {
  const { banco, ctrl, registro } = amb();
  novoAg(banco, { clientePlanoId: 1 });
  const r = resFalso();
  await ctrl.desfazer(req({ params: { id: '500' }, ehAdmin: false, session: bruno }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.enviado, { ok: true, desfeito: 500 });
  assert.ok(!banco._tabelas.agendamento.some((a) => a.id === 500));
  assert.ok(!banco._tabelas.agendamentoItem.some((i) => i.agendamentoId === 500), 'itens vão junto');
  assert.deepEqual(registro, [['plano', 1, 1]]);
});

test('Desfazer fora da janela (31 s), já concluído ou vindo do link: 409, nada apagado', async () => {
  for (const extra of [{ criadoEm: new Date(Date.now() - 31000) }, { status: 'concluido' }, { origem: 'publico' }]) {
    const { banco, ctrl } = amb();
    novoAg(banco, extra);
    const r = resFalso();
    await ctrl.desfazer(req({ params: { id: '500' }, ehAdmin: true, session: admin }), r);
    assert.equal(r.statusCode, 409, JSON.stringify(Object.keys(extra)));
    assert.ok(banco._tabelas.agendamento.some((a) => a.id === 500));
  }
});

test('Desfazer agendamento de outro barbeiro: 403; de outra barbearia: 404', async () => {
  const { banco, ctrl } = amb();
  novoAg(banco, { usuarioId: 3 });
  const r = resFalso();
  await ctrl.desfazer(req({ params: { id: '500' }, ehAdmin: false, session: bruno }), r);
  assert.equal(r.statusCode, 403);
  const r2 = resFalso();
  await ctrl.desfazer(req({ params: { id: '100' }, ehAdmin: true, session: admin }), r2);
  assert.equal(r2.statusCode, 404);
});

test('Criar pela folha "Novo" (JSON): devolve o id e o endereço do Desfazer', async () => {
  const { banco, ctrl } = amb();
  const r = resFalso();
  await ctrl.criarManual(req({
    ehAdmin: false,
    session: bruno,
    body: { servicoIds: '1', data: iso(diaRel(3)), hora: '14:00', cliente_nome: 'Cliente Novo', cliente_telefone: '(11) 97777-0000' },
  }), r);
  assert.equal(r.enviado.ok, true);
  const id = r.enviado.agendamento.id;
  assert.equal(r.enviado.desfazer.url, `/painel/agenda/${id}/desfazer`);
  const ag = banco._tabelas.agendamento.find((a) => a.id === id);
  assert.equal(ag.usuarioId, 2);
  assert.equal(ag.origem, 'barbeiro');
  // E o desfazer funciona logo em seguida.
  ag.criadoEm = new Date();
  const r2 = resFalso();
  await ctrl.desfazer(req({ params: { id: String(id) }, ehAdmin: false, session: bruno }), r2);
  assert.equal(r2.enviado.ok, true);
});

test('Criar pela folha com erro de validação (JSON): 400 com a mensagem', async () => {
  const { ctrl } = amb();
  const r = resFalso();
  await ctrl.criarManual(req({ ehAdmin: false, session: bruno, body: { servicoIds: '1', data: iso(diaRel(3)), hora: '14:00' } }), r);
  assert.equal(r.statusCode, 400);
  assert.match(r.enviado.erro, /nome do cliente/);
});

test('B2: sem clientes_contato, o telefone mascarado do autocomplete vira o número do cadastro (nome + final)', async () => {
  const permissoes = require('../src/services/permissoes.js');
  const planoCortavo = require('../src/services/planoCortavo.js');
  const { banco, ctrl } = amb();
  const semContato = permissoes.contexto({ id: 2, papel: 'funcionario' }, { acessosBloqueados: JSON.stringify({ v: 2, bloqueados: ['clientes_contato'] }) }, planoCortavo.PLANOS.barbearia);
  const r = resFalso();
  await ctrl.criarManual(req({
    ehAdmin: false,
    session: bruno,
    permissoes: semContato,
    body: { servicoIds: '1', data: iso(diaRel(3)), hora: '15:00', cliente_nome: 'Cliente Dois', cliente_telefone: '•••• 0002' },
  }), r);
  assert.equal(r.enviado.ok, true);
  const ag = banco._tabelas.agendamento.find((a) => a.id === r.enviado.agendamento.id);
  assert.equal(ag.clienteTelefone, '11900000002');
  assert.equal(ag.clienteId, 2, 'vinculou ao cliente certo, sem criar cadastro "0002"');
  // Mascarado que não casa com ninguém: recusa (não inventa telefone).
  const r2 = resFalso();
  await ctrl.criarManual(req({ ehAdmin: false, session: bruno, permissoes: semContato, body: { servicoIds: '1', data: iso(diaRel(3)), hora: '16:00', cliente_nome: 'Fulano', cliente_telefone: '•••• 0002' } }), r2);
  assert.equal(r2.statusCode, 400);
});
