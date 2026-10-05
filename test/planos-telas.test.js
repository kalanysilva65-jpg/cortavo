// Fase 2.4 (spec 04): telas do plano da Cortavo. Sem banco, sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

const VIEWS = path.join(RAIZ, 'src/views');
const render = (v, dados) => ejs.renderFile(path.join(VIEWS, v), dados);

test('2.4 aviso de barbeiros acima do plano: só avisa, nunca no Personalizado', () => {
  const pc = carregar('src/services/planoCortavo.js');
  assert.equal(pc.avisoBarbeiros(pc.PLANOS.essencial, 4, 'Barbearia X'), 'Barbearia X tem 4 barbeiros no Essencial (referência: até 2).');
  assert.equal(pc.avisoBarbeiros(pc.PLANOS.essencial, 2, 'X'), null);
  assert.equal(pc.avisoBarbeiros(pc.PLANOS.barbearia, 6), 'Tem 6 barbeiros no Barbearia (referência: até 5).');
  assert.equal(pc.avisoBarbeiros(pc.PLANOS.personalizado, 50, 'X'), null);
});

test('2.4 seletor lista os 3 planos em ordem e o Personalizado por último', () => {
  const pc = carregar('src/services/planoCortavo.js');
  assert.deepEqual(pc.planosParaSeletor().map((p) => p.chave), ['essencial', 'barbearia', 'barbearia_ia', 'personalizado']);
});

function locaisDoPlano(planoCortavo) {
  const { exigeFuncaoDoPlano } = carregar('src/middlewares/planoCortavo.js');
  const res = resFalso();
  res.locals.barbeariaAtual = { id: 1, nome: 'X', planoCortavo };
  exigeFuncaoDoPlano(reqFalso({ path: '/', method: 'GET', headers: { accept: 'text/html' } }), res, () => {});
  return res.locals;
}

test('2.4 foraDoPlano(): Essencial tranca as 5 funções, Barbearia não', () => {
  const ess = locaisDoPlano('essencial');
  for (const h of ['/painel/estoque', '/painel/relatorios', '/painel/metas', '/painel/comissoes', '/painel/fidelidade']) {
    assert.ok(ess.foraDoPlano(h), h);
  }
  assert.equal(ess.foraDoPlano('/painel/agenda'), null);
  assert.equal(ess.foraDoPlano('/painel/estoque').texto, 'Disponível no plano Barbearia. Fale com a Cortavo.');
  assert.equal(locaisDoPlano('barbearia').foraDoPlano('/painel/estoque'), null);
});

function dadosNav(planoChave, ehAdmin) {
  const l = locaisDoPlano(planoChave);
  return { ...l, currentPath: '/painel', ehAdmin, podeAcessar: () => true, usuarioFotoUrl: null, usuarioPrimeiroNome: 'A' };
}

test('2.4 menu: admin no Essencial vê cadeado; barbeiro não vê o item; Barbearia sem cadeado', async () => {
  const admin = await render('partials/nav-inferior.ejs', dadosNav('essencial', true));
  assert.match(admin, /Estoque \(fora do plano\)/);
  assert.match(admin, /sv-grade-cadeado/);
  const barbeiro = await render('partials/nav-inferior.ejs', dadosNav('essencial', false));
  assert.doesNotMatch(barbeiro, /href="\/painel\/estoque"/);
  assert.match(barbeiro, /href="\/painel\/agenda"/);
  const plenoAdmin = await render('partials/nav-inferior.ejs', dadosNav('barbearia', true));
  assert.doesNotMatch(plenoAdmin, /sv-grade-cadeado/);
  assert.match(plenoAdmin, /href="\/painel\/estoque"/);
});

test('2.4 "Meu plano" sem pagamento e com o que fica de fora', async () => {
  const pc = carregar('src/services/planoCortavo.js');
  const plano = pc.PLANOS.essencial;
  const html = await render('painel/meu-plano.ejs', {
    plano, funcoes: pc.resumoFuncoes(plano), desde: null,
    uso: { secretaria: { usado: 0, teto: 0, desligado: true }, assistente: { usado: 0, teto: 0, desligado: true }, lembretesRef: 100, barbeiros: 3, barbeirosRef: 2 },
  });
  assert.match(html, /Essencial/);
  assert.match(html, /Disponível no plano Barbearia\. Fale com a Cortavo\./);
  assert.match(html, /Não incluso no plano/);
  assert.doesNotMatch(html, /R\$|pagar|assinar|comprar|checkout/i);
});

test('2.4 controller "Meu plano" lê o uso sem chamar IA', async () => {
  const c = carregar('src/controllers/meuPlanoController.js', {
    prisma: prismaFalso({ usuario: { count: async () => 3 } }),
    stubs: { 'src/services/atendimento.js': {
      estadoTeto: async () => ({ respostas: 10, teto: 800, desligado: false }),
      estadoTetoCopiloto: async () => ({ consultas: 5, teto: 50, desligado: false }),
    } },
  });
  const pc = carregar('src/services/planoCortavo.js');
  const res = resFalso();
  res.locals.planoCortavo = pc.PLANOS.barbearia_ia;
  await c.ver(reqFalso({ barbeariaId: 1 }), res);
  assert.equal(res.renderizou.view, 'painel/meu-plano');
  assert.deepEqual(res.renderizou.dados.uso.secretaria, { usado: 10, teto: 800, desligado: false });
  assert.equal(res.renderizou.dados.uso.barbeiros, 3);
});

test('2.4 fora do plano: tela com cadeado, sem botão de pagar', async () => {
  const html = await render('painel/fora-do-plano.ejs', { funcao: { rotulo: 'Estoque' }, texto: 'Disponível no plano Barbearia. Fale com a Cortavo.', ehAdmin: true });
  assert.match(html, /Estoque/);
  assert.match(html, /\/painel\/meu-plano/);
  assert.doesNotMatch(html, /pagar|assinar|comprar/i);
});

test('2.4 criar barbearia exige escolher o plano e grava o escolhido', async () => {
  const criadas = [];
  const prisma = prismaFalso({
    barbearia: { findUnique: async () => null, create: async ({ data }) => { criadas.push(data); return { id: 7, ...data }; } },
    usuario: { create: async () => ({}) },
    configuracao: { upsert: async () => ({}) },
  });
  const corpo = { nome: 'Teste', slug: 'teste', adminNome: 'A', adminEmail: 'a@exemplo.test', adminSenha: 'x'.repeat(8) };
  const stubs = { 'src/services/auditoria.js': { registrar: async () => {} } };

  let m = carregar('src/controllers/mestreController.js', { prisma, stubs });
  let res = resFalso();
  await m.criarBarbearia(reqFalso({ body: { ...corpo } }), res);
  assert.equal(res.renderizou.view, 'mestre/barbearia-nova');
  assert.match(res.renderizou.dados.erro, /Escolha o plano/);
  assert.equal(criadas.length, 0);

  m = carregar('src/controllers/mestreController.js', { prisma, stubs });
  res = resFalso();
  await m.criarBarbearia(reqFalso({ body: { ...corpo, plano: 'essencial' } }), res);
  assert.equal(res.redirecionou, '/mestre/barbearias/7');
  assert.equal(criadas[0].planoCortavo, 'essencial');
});

test('2.4 mestre: seletor na criação e no detalhe (rota de plano existente)', async () => {
  const pc = carregar('src/services/planoCortavo.js');
  const det = fs.readFileSync(path.join(VIEWS, 'mestre/barbearia-detalhe.ejs'), 'utf8');
  assert.ok(det.includes('action="/mestre/barbearias/<%= barbearia.id %>/plano"'));
  assert.ok(det.includes('avisoBarbeiros'));
  const nova = await render('mestre/barbearia-nova.ejs', { valores: null, erro: null, planos: pc.planosParaSeletor() });
  assert.match(nova, /name="plano"/);
  assert.match(nova, /value="barbearia_ia"/);
});

test('2.4 secretária: "Reativar IA" some quando o plano não tem secretária', () => {
  const txt = fs.readFileSync(path.join(VIEWS, 'painel/secretaria-config.ejs'), 'utf8');
  const i = txt.indexOf('if (semSecretaria) {');
  const j = txt.lastIndexOf('Reativar IA</button>');
  assert.ok(i > 0 && j > i, 'Reativar IA fica depois do ramo de plano sem secretária');
  assert.ok(txt.includes('planoCortavo.tetos.secretaria === 0'));
});
