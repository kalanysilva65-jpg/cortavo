// Agenda pública (redesign v3, F12): "Aberto hoje, 9h às 19h" e "próximo dia
// com horário livre" no horarios.json e na página do passo 3.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoGestao, diaRel } = require('./helpers/dadosGestao');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function amb() {
  const banco = bancoGestao();
  banco._tabelas.configuracao = [];
  const ctrl = carregar('src/controllers/agendamentoPublicoController.js', { prisma: banco });
  return { banco, ctrl };
}
// Próximo dia (a partir de amanhã+1) que não é domingo: Bruno (2) folga no domingo.
function diaUtil(aPartir) {
  let n = aPartir;
  while (diaRel(n).getDay() === 0) n++;
  return n;
}

test('Horário de hoje: união das jornadas dos barbeiros ativos', async () => {
  const { ctrl } = amb();
  const manha = new Date();
  manha.setHours(8, 0, 0, 0);
  const h = await ctrl.horarioHojeDe(1, manha);
  if (manha.getDay() === 0) {
    // Domingo: só a Ana (09–18) trabalha.
    assert.deepEqual([h.inicio, h.fim], ['09:00', '18:00']);
  } else {
    // Ana e Bruno 09–18, Caio 10–19 -> 9h às 19h.
    assert.deepEqual([h.inicio, h.fim], ['09:00', '19:00']);
    assert.equal(h.texto, 'Aberto hoje, 9h às 19h');
  }
  assert.equal(h.aberto, true);
  const noite = new Date();
  noite.setHours(23, 0, 0, 0);
  assert.equal((await ctrl.horarioHojeDe(1, noite)).aberto, false);
});

test('Horário de hoje: barbearia sem ninguém trabalhando hoje = "Fechado hoje"', async () => {
  const { banco, ctrl } = amb();
  banco._tabelas.horarioTrabalho = banco._tabelas.horarioTrabalho.filter((j) => j.diaSemana !== new Date().getDay());
  const h = await ctrl.horarioHojeDe(1);
  assert.deepEqual(h, { aberto: false, inicio: null, fim: null, texto: 'Fechado hoje' });
});

test('Middleware público põe o horário de hoje em res.locals', async () => {
  const { ctrl } = amb();
  const res = resFalso();
  let seguiu = false;
  await ctrl.contextoPublico(reqFalso({ barbeariaId: 1 }), res, () => { seguiu = true; });
  assert.equal(seguiu, true);
  assert.ok(res.locals.horarioHoje && 'texto' in res.locals.horarioHoje);
  const src = fs.readFileSync(path.join(RAIZ, 'src/routes/agendar.js'), 'utf8');
  assert.match(src, /router\.use\(c\.contextoPublico\)/);
});

test('horarios.json: dia esgotado devolve temLivre=false e o próximo dia com horário livre', async () => {
  const { banco, ctrl } = amb();
  const n = diaUtil(2);
  const esgotado = diaRel(n);
  banco._tabelas.bloqueio.push({ id: 50, barbeariaId: 1, usuarioId: 2, data: esgotado, horaInicio: '09:00', horaFim: '18:00' });
  const res = resFalso();
  await ctrl.horariosJson(reqFalso({ barbeariaId: 1, query: { data: iso(esgotado), servicoIds: '1', barbeiroId: '2' } }), res);
  assert.equal(res.enviado.temLivre, false);
  const esperado = diaRel(diaUtil(n + 1));
  assert.equal(res.enviado.proximoDiaLivre.data, iso(esperado));
  assert.match(res.enviado.proximoDiaLivre.rotulo, /^\S{3}, \d{1,2} \S{3}$/);
});

test('horarios.json: dia com horário livre não calcula o próximo', async () => {
  const { ctrl } = amb();
  const res = resFalso();
  await ctrl.horariosJson(reqFalso({ barbeariaId: 1, query: { data: iso(diaRel(diaUtil(2))), servicoIds: '1', barbeiroId: '2' } }), res);
  assert.equal(res.enviado.temLivre, true);
  assert.equal(res.enviado.proximoDiaLivre, null);
});

test('horarios.json "qualquer barbeiro": esgotado só quando TODOS estão ocupados', async () => {
  const { banco, ctrl } = amb();
  const n = diaUtil(2);
  for (const u of [1, 2, 3]) banco._tabelas.bloqueio.push({ id: 60 + u, barbeariaId: 1, usuarioId: u, data: diaRel(n), horaInicio: '08:00', horaFim: '20:00' });
  const res = resFalso();
  await ctrl.horariosJson(reqFalso({ barbeariaId: 1, query: { data: iso(diaRel(n)), servicoIds: '1', barbeiroId: 'any' } }), res);
  assert.equal(res.enviado.temLivre, false);
  assert.ok(res.enviado.proximoDiaLivre && res.enviado.proximoDiaLivre.data > iso(diaRel(n)));
});
