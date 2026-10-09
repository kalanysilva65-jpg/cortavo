// Fechar o caixa do dia (redesign v3, F6): resumo, conferência da gaveta,
// refazer e permissões. Banco em memória; migração só lida como texto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoGestao, diaRel } = require('./helpers/dadosGestao');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function amb() {
  const banco = bancoGestao();
  const ctrl = carregar('src/controllers/caixaApiController.js', { prisma: banco });
  return { banco, ctrl };
}
function res() {
  const r = resFalso();
  r.set = () => r;
  return r;
}
const sessao = { usuario: { id: 1, nome: 'Ana Admin', papel: 'admin' } };

test('Fechar caixa: migração só cria a tabela nova e avisa para parar o serviço', () => {
  const sql = fs.readFileSync(path.join(RAIZ, 'prisma/migrations/20261009130000_fechamento_caixa/migration.sql'), 'utf8');
  const cmds = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(cmds, /CREATE TABLE "fechamentos_caixa"/);
  assert.match(cmds, /CREATE UNIQUE INDEX "fechamentos_caixa_barbearia_id_dia_key"/);
  assert.doesNotMatch(cmds, /^\s*(DROP|DELETE|UPDATE|ALTER)\b/im);
  assert.match(sql, /serviço PARADO/);
});

test('Resumo do dia: entradas, saídas, formas, dinheiro esperado na gaveta, atendimentos e a receber', async () => {
  const { ctrl } = amb();
  const r = res();
  await ctrl.dia(reqFalso({ barbeariaId: 1, query: { fundoInicial: '5000' } }), r);
  const d = r.enviado;
  // Hoje: atendimento 8 (R$ 80, pix) + troco lançado (R$ 10, dinheiro); saída Luz R$ 45 em dinheiro.
  assert.equal(d.entradas, 9000);
  assert.equal(d.saidas, 4500);
  assert.equal(d.saldo, 4500);
  assert.deepEqual(d.porForma, { pix: 8000, credito: 0, debito: 0, dinheiro: 1000, sem_forma: 0 });
  assert.equal(d.dinheiroEsperado, 5000 + 1000 - 4500);
  assert.equal(d.atendimentos, 2);
  assert.deepEqual(d.aReceber, { quantidade: 1, valor: 5000 });
  assert.equal(d.fechamento, null);
});

test('Fechar: grava quem fechou, hora, contado e diferença; segunda vez pede "refazer"', async () => {
  const { banco, ctrl } = amb();
  const r = res();
  await ctrl.fechar(reqFalso({ barbeariaId: 1, body: { dinheiroContadoReais: '10,00', fundoInicial: 5000, observacao: 'Faltou troco' }, session: sessao }), r);
  assert.equal(r.statusCode, 200);
  const f = r.enviado.fechamento;
  assert.equal(f.fechadoPorNome, 'Ana Admin');
  assert.equal(f.dinheiroEsperado, 1500);
  assert.equal(f.dinheiroContado, 1000);
  assert.equal(f.diferenca, -500, 'faltaram R$ 5');
  assert.equal(f.dia, iso(new Date()));
  assert.equal(banco._tabelas.fechamentoCaixa.length, 1);
  assert.equal(banco._tabelas.fechamentoCaixa[0].fechadoPorId, 1);

  const r2 = res();
  await ctrl.fechar(reqFalso({ barbeariaId: 1, body: { dinheiroContado: 1500, fundoInicial: 5000 }, session: sessao }), r2);
  assert.equal(r2.statusCode, 409);
  assert.equal(r2.enviado.fechamento.diferenca, -500, 'devolve o fechamento existente');

  const r3 = res();
  await ctrl.fechar(reqFalso({ barbeariaId: 1, body: { dinheiroContado: 1500, fundoInicial: 5000, refazer: true }, session: sessao }), r3);
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.enviado.fechamento.diferenca, 0);
  assert.equal(r3.enviado.fechamento.vezes, 2);
  assert.equal(banco._tabelas.fechamentoCaixa.length, 1);
});

test('Fechar: data futura, antiga demais ou valor ausente = 400', async () => {
  const { ctrl } = amb();
  for (const body of [{ data: iso(diaRel(1)), dinheiroContado: 0 }, { data: iso(diaRel(-90)), dinheiroContado: 0 }, { data: '2026-02-31', dinheiroContado: 0 }, {}]) {
    const r = res();
    await ctrl.fechar(reqFalso({ barbeariaId: 1, body, session: sessao }), r);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
  }
});

test('Fechar um dia passado e listar os fechamentos', async () => {
  const { ctrl } = amb();
  const r = res();
  await ctrl.fechar(reqFalso({ barbeariaId: 1, body: { data: iso(diaRel(-4)), dinheiroContado: 0 }, session: sessao }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.enviado.fechamento.saidas, 30000, 'aluguel do dia -4');
  const l = res();
  await ctrl.fechamentos(reqFalso({ barbeariaId: 1, query: {} }), l);
  assert.equal(l.enviado.fechamentos.length, 1);
});

test('Fechar caixa: rotas com as permissões certas (ver com caixa_ver, fechar com caixa_lancar)', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(src, /router\.get\('\/api\/caixa\/dia', exige\('caixa_ver'\)/);
  assert.match(src, /router\.get\('\/api\/caixa\/fechamentos', exige\('caixa_ver'\)/);
  assert.match(src, /router\.post\('\/api\/caixa\/fechar', exige\('caixa_lancar'\)/);
});
