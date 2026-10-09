// Spec 12, fatia B3: migração aditiva (faltou, canceladoEm/Por, índice de
// concluidoEm, ComissaoPagamento) e o comportamento dos status novos.
// Só lê o arquivo de migração; nada roda no banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { criarBanco } = require('./helpers/bancoMemoria');

const MIG = path.join(RAIZ, 'prisma/migrations/20261009120000_gestao_permissoes/migration.sql');

test('B3 migração só ADICIONA (sem DROP/DELETE/UPDATE/RENAME) e avisa: serviço parado', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  const semComentarios = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  // Comandos destrutivos no começo da linha (o "ON DELETE CASCADE" da chave
  // estrangeira é cláusula, não comando).
  assert.doesNotMatch(semComentarios, /^\s*(DROP|DELETE|UPDATE)\b/im);
  assert.doesNotMatch(semComentarios, /\bRENAME\b/i);
  assert.match(sql, /ADD COLUMN "cancelado_em" DATETIME;/);
  assert.match(sql, /ADD COLUMN "cancelado_por" TEXT;/);
  assert.match(sql, /ADD COLUMN "cancelado_por_id" INTEGER;/);
  assert.match(sql, /ADD COLUMN "motivo_cancelamento" TEXT;/);
  assert.match(sql, /CREATE INDEX "agendamentos_barbearia_id_concluido_em_idx" ON "agendamentos"\("barbearia_id", "concluido_em"\)/);
  assert.match(sql, /CREATE TABLE "comissao_pagamentos"/);
  assert.match(sql, /serviço PARADO/);
  // Colunas novas nascem nulas: nenhum NOT NULL sem DEFAULT em ALTER TABLE.
  for (const l of semComentarios.split('\n').filter((x) => /ALTER TABLE/.test(x))) assert.doesNotMatch(l, /NOT NULL/);
});

test('B3 schema bate com a migração', () => {
  const s = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8');
  assert.match(s, /canceladoEm\s+DateTime\?\s+@map\("cancelado_em"\)/);
  assert.match(s, /canceladoPor\s+String\?\s+@map\("cancelado_por"\)/);
  assert.match(s, /@@index\(\[barbeariaId, concluidoEm\]\)/);
  assert.match(s, /model ComissaoPagamento \{[\s\S]*@@map\("comissao_pagamentos"\)/);
});

test('B3 lista única de status: faltou é separado de cancelado, e os dois são inativos', () => {
  const st = carregar('src/config/statusAgendamento.js');
  assert.deepEqual(st.VALIDOS, ['agendado', 'concluido', 'cancelado', 'faltou']);
  assert.deepEqual(st.INATIVOS, ['cancelado', 'faltou']);
});

test('B3 nenhuma consulta de agenda ainda usa só "not cancelado" (faltou ficaria ocupando horário)', () => {
  const arquivos = ['src/services/disponibilidade.js', 'src/services/agendamentoSeguro.js', 'src/controllers/agendaController.js',
    'src/controllers/agendamentoPublicoController.js', 'src/controllers/dashboardController.js', 'src/controllers/relatorioController.js'];
  for (const a of arquivos) {
    assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, a), 'utf8'), /status: \{ not: 'cancelado' \}/, a);
  }
});

function bancoAgenda(extra = {}) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return criarBanco({
    agendamento: [{ id: 10, barbeariaId: 1, usuarioId: 7, status: 'concluido', concluidoEm: new Date(), data: hoje, horaInicio: '10:00', valorTotal: 5000, clienteNome: 'Ana', clienteTelefone: '51999991234', clientePlanoId: null, ...extra }],
    caixa: [{ id: 1, barbeariaId: 1, agendamentoId: 10, tipo: 'entrada', valor: 5000, data: new Date(), descricao: 'Atendimento' }],
    pagamentoAgendamento: [],
    agendamentoItem: [],
  });
}

function carregarAgenda(banco, registro) {
  return carregar('src/controllers/agendaController.js', {
    prisma: banco,
    stubs: {
      'src/services/estoque.js': { aplicarConsumo: async (id, sinal) => registro.push(['estoque', id, sinal]) },
      'src/services/plano.js': {
        ajustarUso: async (id, delta) => registro.push(['plano', id, delta]),
        servicosCobertosDe: async () => [],
      },
    },
  });
}

test('B3 marcar "faltou" num concluído: sai do caixa e do faturamento, devolve estoque, NÃO devolve uso do plano', async () => {
  const banco = bancoAgenda({ clientePlanoId: 5 });
  const registro = [];
  const ctrl = carregarAgenda(banco, registro);
  const req = reqFalso({ barbeariaId: 1, ehAdmin: true, params: { id: '10' }, body: { status: 'faltou' }, headers: { accept: 'application/json' }, xhr: true, get: () => '', session: { usuario: { id: 1, papel: 'admin' } } });
  await ctrl.mudarStatus(req, resFalso());
  const ag = banco._tabelas.agendamento[0];
  assert.equal(ag.status, 'faltou');
  assert.equal(ag.concluidoEm, null);
  assert.equal(ag.canceladoEm, undefined, 'faltou não é cancelamento');
  assert.equal(banco._tabelas.caixa.length, 0);
  assert.deepEqual(registro.filter((r) => r[0] === 'estoque'), [['estoque', 10, 1]]);
  assert.deepEqual(registro.filter((r) => r[0] === 'plano'), [], 'falta não devolve o uso');
});

test('B3 cancelar grava quando, quem e o motivo; reabrir limpa', async () => {
  const banco = bancoAgenda({ status: 'agendado', concluidoEm: null });
  const ctrl = carregarAgenda(banco, []);
  const base = { barbeariaId: 1, ehAdmin: false, params: { id: '10' }, headers: { accept: 'application/json' }, xhr: true, get: () => '', session: { usuario: { id: 7, papel: 'funcionario' } } };
  await ctrl.mudarStatus(reqFalso({ ...base, body: { status: 'cancelado', motivo: 'Cliente pediu' } }), resFalso());
  let ag = banco._tabelas.agendamento[0];
  assert.equal(ag.status, 'cancelado');
  assert.ok(ag.canceladoEm instanceof Date);
  assert.equal(ag.canceladoPor, 'equipe');
  assert.equal(ag.canceladoPorId, 7);
  assert.equal(ag.motivoCancelamento, 'Cliente pediu');
  await ctrl.mudarStatus(reqFalso({ ...base, body: { status: 'agendado' } }), resFalso());
  ag = banco._tabelas.agendamento[0];
  assert.equal(ag.canceladoEm, null);
  assert.equal(ag.canceladoPor, null);
  assert.equal(ag.motivoCancelamento, null);
});

test('B3 status desconhecido não muda nada', async () => {
  const banco = bancoAgenda({ status: 'agendado', concluidoEm: null });
  const ctrl = carregarAgenda(banco, []);
  await ctrl.mudarStatus(reqFalso({ barbeariaId: 1, ehAdmin: true, params: { id: '10' }, body: { status: 'sumiu' }, headers: { accept: 'application/json' }, xhr: true, get: () => '', session: { usuario: { id: 1 } } }), resFalso());
  assert.equal(banco._tabelas.agendamento[0].status, 'agendado');
});

test('B3 horário de quem faltou volta a ficar livre na disponibilidade', async () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  const banco = criarBanco({
    agendamento: [
      { id: 1, barbeariaId: 1, usuarioId: 7, data: d, horaInicio: '10:00', status: 'faltou' },
      { id: 2, barbeariaId: 1, usuarioId: 7, data: d, horaInicio: '11:00', status: 'agendado' },
    ],
    agendamentoItem: [
      { id: 1, agendamentoId: 1, servicoId: 1, quantidade: 1, valorUnitario: 0 },
      { id: 2, agendamentoId: 2, servicoId: 1, quantidade: 1, valorUnitario: 0 },
    ],
    servico: [{ id: 1, barbeariaId: 1, duracaoMin: 30, ehEncaixe: false }],
    bloqueio: [],
  });
  const disp = carregar('src/services/disponibilidade.js', { prisma: banco });
  const ocupados = await disp.intervalosOcupados(7, d);
  assert.deepEqual(ocupados, [[660, 690]]);
});

test('B3 secretária e assistente registram quem cancelou', async () => {
  const banco = criarBanco({ agendamento: [{ id: 3, barbeariaId: 1, usuarioId: 7, status: 'agendado', clienteNome: 'Bia' }] });
  const seg = carregar('src/services/agendamentoSeguro.js', { prisma: banco, stubs: { 'src/services/plano.js': { ajustarUso: async () => {}, servicosCobertosDe: async () => [] } } });
  const r = await seg.cancelarAgendamento(1, { agendamentoId: 3, canceladoPor: 'secretaria' });
  assert.equal(r.ok, true);
  const ag = banco._tabelas.agendamento[0];
  assert.equal(ag.canceladoPor, 'secretaria');
  assert.ok(ag.canceladoEm instanceof Date);
  const src = fs.readFileSync(path.join(RAIZ, 'src/controllers/iaController.js'), 'utf8');
  assert.match(src, /canceladoPor: 'assistente', porUsuarioId: req\.session\.usuario\.id/);
});
