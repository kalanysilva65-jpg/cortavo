// Fase 2.1 a 2.3 (spec 04): plano da Cortavo por barbearia. Sem banco real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

// ---------- 2.1 migração ----------
test('2.1 migração só adiciona colunas e todas as atuais viram "personalizado"', () => {
  const sql = fs.readFileSync(path.join(RAIZ, 'prisma/migrations/20261006120000_plano_cortavo/migration.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN "plano_cortavo" TEXT NOT NULL DEFAULT 'personalizado'/);
  assert.match(sql, /ADD COLUMN "plano_cortavo_desde" DATETIME/);
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE|RENAME/i);
  const schema = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8');
  assert.match(schema, /planoCortavo\s+String\s+@default\("personalizado"\)\s+@map\("plano_cortavo"\)/);
});

// ---------- 2.2 lista única ----------
test('2.2 números do plano batem com o preço aprovado', () => {
  const { PLANOS } = carregar('src/services/planoCortavo.js');
  assert.deepEqual(PLANOS.essencial.tetos, { secretaria: 0, assistente: 0, lembretesRef: 100, barbeirosRef: 2 });
  assert.deepEqual(PLANOS.barbearia.tetos, { secretaria: 0, assistente: 50, lembretesRef: 200, barbeirosRef: 5 });
  assert.deepEqual(PLANOS.barbearia_ia.tetos, { secretaria: 800, assistente: 50, lembretesRef: 300, barbeirosRef: 5 });
  assert.deepEqual([PLANOS.essencial.precoCentavos, PLANOS.barbearia.precoCentavos, PLANOS.barbearia_ia.precoCentavos], [6900, 12900, 24900]);
});

test('2.2 valor vazio ou desconhecido = Personalizado com tudo liberado (critério 7)', () => {
  const pc = carregar('src/services/planoCortavo.js');
  for (const v of [undefined, null, '', 'xyz']) {
    const p = pc.planoDe(v);
    assert.equal(p.chave, 'personalizado');
    for (const f of pc.FUNCOES) assert.ok(pc.libera(p, f.chave));
  }
});

function rodarMiddleware(planoCortavo, caminho, { method = 'GET', accept = 'text/html' } = {}) {
  const { exigeFuncaoDoPlano } = carregar('src/middlewares/planoCortavo.js');
  const req = reqFalso({ path: caminho, method, headers: { accept } });
  const res = resFalso();
  res.locals.barbeariaAtual = { id: 1, nome: 'X', planoCortavo };
  let seguiu = false;
  exigeFuncaoDoPlano(req, res, () => { seguiu = true; });
  return { res, seguiu };
}

test('2.2 Essencial: comissões, relatórios, estoque, fidelidade e metas param no servidor (critério 1)', () => {
  for (const c of ['/comissoes', '/relatorios', '/estoque', '/estoque/3/editar', '/fidelidade', '/metas']) {
    const { res, seguiu } = rodarMiddleware('essencial', c);
    assert.equal(seguiu, false, c);
    assert.equal(res.statusCode, 403);
    assert.equal(res.renderizou.view, 'painel/fora-do-plano');
    assert.equal(res.renderizou.dados.texto, 'Disponível no plano Barbearia. Fale com a Cortavo.');
  }
});

test('2.2 Essencial: POST direto fora do plano devolve 403 em JSON', () => {
  const { res, seguiu } = rodarMiddleware('essencial', '/estoque', { method: 'POST', accept: '*/*' });
  assert.equal(seguiu, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.enviado.foraDoPlano, true);
});

test('2.2 Essencial: agenda, clientes, caixa e link continuam abertos', () => {
  for (const c of ['/', '/agenda', '/clientes', '/caixa', '/servicos', '/estoquex']) {
    assert.equal(rodarMiddleware('essencial', c).seguiu, true, c);
  }
});

test('2.2 Barbearia, + IA e Personalizado liberam as 5 funções', () => {
  for (const p of ['barbearia', 'barbearia_ia', 'personalizado', undefined]) {
    for (const c of ['/comissoes', '/relatorios', '/estoque', '/fidelidade', '/metas']) {
      assert.equal(rodarMiddleware(p, c).seguiu, true, `${p} ${c}`);
    }
  }
});

test('2.2 rota do painel usa o bloqueio por plano', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(src, /router\.use\(exigeFuncaoDoPlano\);/);
  // vem antes da primeira rota do painel
  assert.ok(src.indexOf('router.use(exigeFuncaoDoPlano)') < src.indexOf("router.get('/', dashboardController.ver)"));
});

// ---------- 2.2 só a Kalany troca o plano (critério 8) ----------
test('2.2 admin da barbearia recebe 403 no painel-mestre (onde fica a troca de plano)', () => {
  const { exigeDono } = carregar('src/middlewares/auth.js');
  const req = reqFalso({ session: { usuario: { id: 2, papel: 'admin' } } });
  const res = resFalso();
  exigeDono(req, res, () => assert.fail('admin não pode seguir'));
  assert.equal(res.statusCode, 403);
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/mestre.js'), 'utf8');
  assert.ok(rotas.indexOf('router.use(exigeDono)') < rotas.indexOf("'/barbearias/:id/plano'"));
});

function mestreCom(barbearia) {
  const gravado = [];
  const auditado = [];
  const prisma = prismaFalso({
    barbearia: {
      findUnique: async () => barbearia,
      update: async (a) => { gravado.push(a); return a; },
    },
  });
  const ctrl = carregar('src/controllers/mestreController.js', {
    prisma,
    stubs: { 'src/services/auditoria.js': { registrar: async (_r, d) => auditado.push(d) } },
  });
  return { ctrl, gravado, auditado };
}

test('2.2 dono troca o plano: grava, marca a data e registra auditoria', async () => {
  const { ctrl, gravado, auditado } = mestreCom({ id: 7, nome: 'Navalha', planoCortavo: 'personalizado' });
  const req = reqFalso({ params: { id: '7' }, body: { plano: 'essencial' }, session: { usuario: { id: 1, papel: 'dono' } } });
  const res = resFalso();
  await ctrl.definirPlano(req, res);
  assert.equal(gravado.length, 1);
  assert.equal(gravado[0].data.planoCortavo, 'essencial');
  assert.ok(gravado[0].data.planoCortavoDesde instanceof Date);
  assert.equal(auditado[0].acao, 'barbearia.plano');
  assert.equal(res.redirecionou, '/mestre/barbearias/7');
});

test('2.2 plano inválido não grava nada', async () => {
  const { ctrl, gravado } = mestreCom({ id: 7, nome: 'Navalha', planoCortavo: 'personalizado' });
  const req = reqFalso({ params: { id: '7' }, body: { plano: 'gratis' }, session: { usuario: { id: 1, papel: 'dono' } } });
  await ctrl.definirPlano(req, resFalso());
  assert.equal(gravado.length, 0);
  assert.equal(req.session.flash.tipo, 'erro');
});
