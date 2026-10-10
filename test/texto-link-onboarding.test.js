// textoLink (mensagem do WhatsApp salva na barbearia) e onboardingEstado da
// spec 11 (Esconder e passo 4 por usuário). Banco em memória, sem .env.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

const B = { id: 7, nome: 'Barbearia Vila Rosa', slug: 'vilarosa', textoLink: null };

function linkCom(barbearia, gravados) {
  const prisma = prismaFalso({ barbearia: { update: async ({ where, data }) => { gravados.push({ where, data }); Object.assign(barbearia, data); return barbearia; } } });
  return carregar('src/controllers/linkController.js', { prisma });
}
function res2(b) { const r = resFalso(); r.locals.barbeariaAtual = b; return r; }

test('textoLink: salva na barbearia; vazio ou igual ao padrão volta ao padrão (null); limite de 1000', async () => {
  const b = { ...B };
  const g = [];
  const c = linkCom(b, g);
  let res = res2(b);
  await c.salvarTexto(reqFalso({ body: { texto: '  Oi! Marque aqui:\r\nhttps://vilarosa.cortavo.com.br  ' } }), res);
  assert.deepEqual(res.enviado, { ok: true, padrao: false });
  assert.equal(b.textoLink, 'Oi! Marque aqui:\nhttps://vilarosa.cortavo.com.br');
  assert.deepEqual(g[0].where, { id: 7 });
  res = res2(b);
  c.ver(reqFalso({ query: {} }), res);
  assert.equal(res.renderizou.dados.textoAtual, b.textoLink, 'a tela mostra o texto salvo');
  assert.match(res.renderizou.dados.textoPadrao, /^Oi! Agora você marca/);
  const { textoPadrao } = carregar('src/services/linkAgendamento.js');
  res = res2(b);
  await c.salvarTexto(reqFalso({ body: { texto: textoPadrao(b) } }), res);
  assert.equal(b.textoLink, null);
  await c.salvarTexto(reqFalso({ body: { texto: '' } }), res2(b));
  assert.equal(b.textoLink, null);
  res = res2(b);
  await c.salvarTexto(reqFalso({ body: { texto: 'x'.repeat(1001) } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(b.textoLink, null);
  res = res2(b);
  c.ver(reqFalso({ query: {} }), res);
  assert.equal(res.renderizou.dados.textoAtual, textoPadrao(b), 'sem texto salvo: o padrão');
});

test('textoLink: rota só de admin, view usa o texto salvo, JS não guarda mais no aparelho', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(rotas, /router\.post\('\/link\/texto', exigeAdmin, linkController\.salvarTexto\)/);
  assert.match(fs.readFileSync(path.join(RAIZ, 'src/views/painel/link.ejs'), 'utf8'), /textoAtual/);
  const js = fs.readFileSync(path.join(RAIZ, 'public/js/cv-link.js'), 'utf8');
  assert.match(js, /\/painel\/link\/texto/);
  assert.doesNotMatch(js, /localStorage\.setItem/);
});

// ---------- onboardingEstado (spec 11) ----------
function bancoUsuarios(usuarios) {
  return prismaFalso({
    usuario: {
      findUnique: async ({ where }) => { const u = usuarios.find((x) => x.id === where.id); return u ? { ...u } : null; },
      update: async ({ where, data }) => { const u = usuarios.find((x) => x.id === where.id); Object.assign(u, data); return { ...u }; },
    },
  });
}

test('spec 11: POST /painel/primeiros-passos grava só no próprio usuário (outro = 403); esconder, mostrar, link, visto', async () => {
  const usuarios = [{ id: 1, onboardingEstado: null, onboardingOcultoEm: null }, { id: 2, onboardingEstado: null, onboardingOcultoEm: null }];
  const c = carregar('src/controllers/primeirosPassosController.js', { prisma: bancoUsuarios(usuarios) });
  const req = (body) => reqFalso({ session: { usuario: { id: 1 } }, body });
  let res = resFalso();
  await c.registrar(req({ acao: 'esconder', usuarioId: 2 }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(usuarios[1].onboardingOcultoEm, null);
  res = resFalso();
  await c.registrar(req({ acao: 'esconder' }), res);
  assert.equal(res.enviado.oculto, true);
  assert.ok(usuarios[0].onboardingOcultoEm instanceof Date);
  await c.registrar(req({ acao: 'mostrar' }), resFalso());
  assert.equal(usuarios[0].onboardingOcultoEm, null);
  await c.registrar(req({ acao: 'link' }), resFalso());
  await c.registrar(req({ acao: 'visto', passo: 'caixa' }), resFalso());
  await c.registrar(req({ acao: 'visto', passo: 'caixa' }), resFalso());
  assert.deepEqual(JSON.parse(usuarios[0].onboardingEstado), { vistos: ['caixa'], link: true });
  res = resFalso();
  await c.registrar(req({ acao: 'visto', passo: '<script>' }), res);
  assert.equal(res.statusCode, 400);
  res = resFalso();
  await c.registrar(req({ acao: 'apagar-tudo' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(usuarios[1].onboardingEstado, null, 'o outro usuário não muda');
  const ob = carregar('src/services/onboarding.js');
  assert.deepEqual(ob.lerEstado('não é json'), { vistos: [], link: false });
});

function passosCom(contagens) {
  const conta = (n) => ({ count: async () => n });
  const prisma = prismaFalso({
    servico: conta(contagens.servicos || 0), usuario: conta(contagens.equipe || 1), horarioTrabalho: conta(0),
    agendamento: conta(contagens.agendamentos || 0), caixa: conta(0), comissaoPagamento: conta(0), configuracao: conta(0),
  });
  return carregar('src/services/primeirosPassos.js', { prisma });
}

test('spec 11: passo 4 conta com o 1º agendamento OU com o link compartilhado (estado no banco)', async () => {
  const pp = passosCom({});
  const passo4 = async (estado, ag) => (await passosCom({ agendamentos: ag }).montar({ barbeariaId: 7, planoChave: 'barbearia', estado })).passos.find((p) => p.chave === 'link').feito;
  assert.equal(await passo4(null, 0), false);
  assert.equal(await passo4({ link: true, vistos: [] }, 0), true);
  assert.equal(await passo4({ link: false, vistos: [] }, 2), true);
  assert.ok(pp);
});

test('spec 11: Início não mostra os Primeiros passos para quem escondeu (onboardingOcultoEm)', () => {
  const d = fs.readFileSync(path.join(RAIZ, 'src/controllers/dashboardController.js'), 'utf8');
  assert.match(d, /ob\.ocultoEm \? null/);
  const v = fs.readFileSync(path.join(RAIZ, 'src/views/painel/_primeiros-passos.ejs'), 'utf8');
  assert.match(v, /\/painel\/primeiros-passos/);
});

test('migração aditiva: texto_link, onboarding_estado, onboarding_oculto_em e barbearias em uso já escondidas', () => {
  const sql = fs.readFileSync(path.join(RAIZ, 'prisma/migrations/20261010120000_texto_link_onboarding/migration.sql'), 'utf8');
  const semComentarios = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(semComentarios, /\bDROP\b|DELETE FROM|RENAME/i);
  assert.match(sql, /ALTER TABLE "barbearias" ADD COLUMN "texto_link" TEXT;/);
  assert.match(sql, /ALTER TABLE "usuarios" ADD COLUMN "onboarding_estado" TEXT;/);
  assert.match(sql, /ALTER TABLE "usuarios" ADD COLUMN "onboarding_oculto_em" DATETIME;/);
  assert.match(sql, /UPDATE "usuarios" SET "onboarding_oculto_em" = CURRENT_TIMESTAMP[\s\S]*FROM "servicos"/);
  const schema = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8');
  assert.match(schema, /textoLink String\? @map\("texto_link"\)/);
  assert.match(schema, /onboardingEstado\s+String\?\s+@map\("onboarding_estado"\)/);
  const todas = fs.readdirSync(path.join(RAIZ, 'prisma/migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.equal(todas[todas.length - 1], '20261010120000_texto_link_onboarding');
});
