// Agenda do PC (F13): dia em colunas por barbeiro e semana. Banco em memória.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

const val = (v) => (v instanceof Date ? v.getTime() : v);
function casa(r, w) {
  return Object.entries(w || {}).every(([k, c]) => {
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      if ('in' in c) return c.in.includes(r[k]);
      if ('not' in c) return r[k] !== c.not;
      let ok = true;
      if ('gte' in c) ok = ok && val(r[k]) >= val(c.gte);
      if ('lt' in c) ok = ok && val(r[k]) < val(c.lt);
      return ok;
    }
    return r[k] === c;
  });
}
const d = (s) => { const [a, m, dd] = s.split('-').map(Number); return new Date(a, m - 1, dd); };
const SERV = { corte: { nome: 'Corte', duracaoMin: 40, ehEncaixe: false }, sobr: { nome: 'Sobrancelha', duracaoMin: 10, ehEncaixe: true }, barba: { nome: 'Barba', duracaoMin: 30, ehEncaixe: false } };

function mundo() {
  const usuarios = [
    { id: 1, barbeariaId: 7, nome: 'Ana Dona', nomePublico: null, fotoUrl: null, ativo: true },
    { id: 2, barbeariaId: 7, nome: 'Beto Barbeiro', nomePublico: 'Beto', fotoUrl: '/u/b.jpg', ativo: true },
    { id: 3, barbeariaId: 7, nome: 'Inativo', ativo: false },
    { id: 9, barbeariaId: 8, nome: 'Outra casa', ativo: true },
  ];
  const ags = [
    { id: 10, barbeariaId: 7, usuarioId: 2, data: d('2026-10-14'), horaInicio: '10:00', status: 'agendado', clienteNome: 'Cliente A', clienteTelefone: '51999990000', valorTotal: 6000, itens: [{ quantidade: 1, servico: SERV.corte }, { quantidade: 1, servico: SERV.sobr }] },
    { id: 11, barbeariaId: 7, usuarioId: 1, data: d('2026-10-14'), horaInicio: '09:00', status: 'faltou', clienteNome: 'Cliente B', clienteTelefone: 'x', valorTotal: 0, itens: [{ quantidade: 1, servico: SERV.barba }, { quantidade: 1, servico: null }] },
    { id: 12, barbeariaId: 7, usuarioId: 2, data: d('2026-10-14'), horaInicio: '15:00', status: 'cancelado', clienteNome: 'Cancelado', clienteTelefone: 'x', itens: [] },
    { id: 13, barbeariaId: 7, usuarioId: 2, data: d('2026-10-17'), horaInicio: '19:30', status: 'concluido', clienteNome: 'Sexta', clienteTelefone: 'x', valorTotal: 4000, itens: [{ quantidade: 2, servico: SERV.barba }] },
    { id: 14, barbeariaId: 8, usuarioId: 9, data: d('2026-10-14'), horaInicio: '10:00', status: 'agendado', clienteNome: 'De outra barbearia', clienteTelefone: 'x', itens: [] },
  ];
  const bls = [{ id: 20, barbeariaId: 7, usuarioId: 2, data: d('2026-10-14'), horaInicio: '12:00', horaFim: '13:00', motivo: 'Almoço' }];
  const jornadas = [
    { barbeariaId: 7, usuarioId: 1, diaSemana: 3, horaInicio: '09:00', horaFim: '18:00', trabalha: true },
    { barbeariaId: 7, usuarioId: 2, diaSemana: 3, horaInicio: '10:00', horaFim: '20:00', trabalha: true },
    { barbeariaId: 7, usuarioId: 2, diaSemana: 0, horaInicio: '10:00', horaFim: '14:00', trabalha: false },
  ];
  const prisma = prismaFalso({
    usuario: { findMany: async ({ where }) => usuarios.filter((u) => casa(u, where)).map(({ id, nome, nomePublico, fotoUrl }) => ({ id, nome, nomePublico, fotoUrl })) },
    agendamento: { findMany: async ({ where }) => ags.filter((a) => casa(a, where)) },
    bloqueio: { findMany: async ({ where }) => bls.filter((b) => casa(b, where)) },
    horarioTrabalho: { findMany: async ({ where }) => jornadas.filter((j) => casa(j, where)) },
  });
  return carregar('src/services/agendaColunas.js', { prisma });
}

test('dia em colunas: uma coluna por barbeiro ativo, com jornada, blocos (duração com encaixe), bloqueios e faixa', async () => {
  const r = await mundo().dia({ barbeariaId: 7, ehAdmin: true, usuarioId: 1, barbeiro: 'todos', data: '2026-10-14' });
  assert.equal(r.data, '2026-10-14');
  assert.deepEqual(r.colunas.map((c) => c.barbeiro.nome), ['Ana Dona', 'Beto']);
  const beto = r.colunas[1];
  assert.deepEqual(beto.jornada, { trabalha: true, inicio: '10:00', fim: '20:00' });
  assert.equal(beto.blocos.length, 1, 'cancelado não entra');
  assert.deepEqual({ ...beto.blocos[0], servicos: beto.blocos[0].servicos }, {
    id: 10, barbeiroId: 2, inicio: '10:00', fim: '10:40', inicioMin: 600, duracaoMin: 40, status: 'agendado', ocupa: true,
    cliente: 'Cliente A', servicos: ['Corte', 'Sobrancelha'], valorCentavos: 6000,
  });
  assert.equal(JSON.stringify(r).includes('51999990000'), false, 'sem telefone do cliente');
  assert.deepEqual(beto.bloqueios[0], { id: 20, barbeiroId: 2, inicio: '12:00', fim: '13:00', inicioMin: 720, duracaoMin: 60, motivo: 'Almoço' });
  const ana = r.colunas[0];
  assert.equal(ana.blocos[0].status, 'faltou');
  assert.equal(ana.blocos[0].ocupa, false);
  assert.equal(ana.blocos[0].duracaoMin, 30, 'item sem serviço (produto) é ignorado na duração');
  assert.equal(ana.ocupadoMin, 0);
  assert.equal(beto.ocupadoMin, 40);
  assert.deepEqual(r.faixa, { inicio: '09:00', fim: '20:00' });
  assert.equal(JSON.stringify(r).includes('De outra barbearia'), false);
});

test('dia em colunas: funcionário só recebe a própria coluna, mesmo pedindo "todos" ou outro id', async () => {
  const s = mundo();
  for (const barbeiro of ['todos', '1']) {
    const r = await s.dia({ barbeariaId: 7, ehAdmin: false, usuarioId: 2, barbeiro, data: '2026-10-14' });
    assert.deepEqual(r.colunas.map((c) => c.barbeiro.id), [2]);
  }
  const r = await s.dia({ barbeariaId: 7, ehAdmin: true, usuarioId: 1, barbeiro: '2', data: '2026-10-14' });
  assert.deepEqual(r.colunas.map((c) => c.barbeiro.id), [2]);
  const lixo = await s.dia({ barbeariaId: 7, ehAdmin: true, usuarioId: 1, barbeiro: 'todos', data: 'lixo' });
  assert.match(lixo.data, /^\d{4}-\d{2}-\d{2}$/, 'data inválida cai em hoje, sem 500');
});

test('semana: segunda a domingo, por dia e barbeiro, com quantidade e minutos ocupados', async () => {
  const r = await mundo().semana({ barbeariaId: 7, ehAdmin: true, usuarioId: 1, barbeiro: 'todos', data: '2026-10-15' });
  assert.equal(r.inicio, '2026-10-12');
  assert.equal(r.fim, '2026-10-18');
  assert.equal(r.dias.length, 7);
  assert.equal(r.dias[0].rotulo, 'Seg 12');
  const qua = r.dias.find((x) => x.data === '2026-10-14');
  const betoQua = qua.barbeiros.find((b) => b.barbeiroId === 2);
  assert.equal(betoQua.quantidade, 1);
  assert.equal(betoQua.ocupadoMin, 40);
  assert.equal(betoQua.bloqueios.length, 1);
  const sex = r.dias.find((x) => x.data === '2026-10-17');
  const betoSex = sex.barbeiros.find((b) => b.barbeiroId === 2);
  assert.equal(betoSex.blocos[0].duracaoMin, 60, '2 x barba de 30');
  assert.equal(betoSex.blocos[0].fim, '20:30');
  assert.deepEqual(r.faixa, { inicio: '09:00', fim: '20:30' }, 'faixa estica para caber o bloco fora da jornada');
  const dom = r.dias[6];
  assert.deepEqual(dom.barbeiros.find((b) => b.barbeiroId === 2).jornada, { trabalha: false, inicio: null, fim: null });
  assert.deepEqual(r.barbeiros.map((b) => b.nome), ['Ana Dona', 'Beto']);
});

test('rotas: /painel/agenda/dia.json e /semana.json sob /agenda (mesma trava de permissão da tela), JSON sem cache', async () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(rotas, /router\.get\('\/agenda\/dia\.json', agendaController\.diaColunasJson\)/);
  assert.match(rotas, /router\.get\('\/agenda\/semana\.json', agendaController\.semanaJson\)/);
  const chamadas = [];
  const ctrl = carregar('src/controllers/agendaController.js', { stubs: { 'src/services/agendaColunas.js': { dia: async (o) => { chamadas.push(o); return { ok: 'dia' }; }, semana: async (o) => { chamadas.push(o); return { ok: 'semana' }; } } } });
  const res = resFalso();
  res.set = function (k, v) { this.cab = { [k]: v }; return this; };
  await ctrl.diaColunasJson(reqFalso({ barbeariaId: 7, ehAdmin: false, session: { usuario: { id: 2 } }, query: { data: '2026-10-14' } }), res);
  assert.deepEqual(res.enviado, { ok: 'dia' });
  assert.equal(res.cab['Cache-Control'], 'no-store');
  assert.deepEqual(chamadas[0], { barbeariaId: 7, ehAdmin: false, usuarioId: 2, barbeiro: 'todos', data: '2026-10-14' });
  await ctrl.semanaJson(reqFalso({ barbeariaId: 7, ehAdmin: true, session: { usuario: { id: 1 } }, query: { barbeiro: '2' } }), res);
  assert.deepEqual(res.enviado, { ok: 'semana' });
  assert.equal(chamadas[1].barbeiro, '2');
});
