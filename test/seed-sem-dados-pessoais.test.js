// Sergio B6: o seed (roda no npm install, inclusive em produção) não tem dado
// pessoal nem senha fixa, não imprime senha e não cria conta a mais.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso } = require('./helpers/ambiente');

test('seed: sem e-mail pessoal, sem senha fixa', () => {
  const s = fs.readFileSync(path.join(RAIZ, 'prisma/seed.js'), 'utf8');
  assert.doesNotMatch(s, /@gmail\.com|kalany|andrade|bruno|dono123|admin123/i);
  assert.doesNotMatch(s, /hashSync\('[^']*'/, 'nenhuma senha literal');
});

async function rodar({ donoExiste, producao }) {
  const criados = [];
  const logs = [];
  const prisma = prismaFalso({
    usuario: {
      findFirst: async ({ where }) => (where.papel === 'dono' && donoExiste ? { id: 1, email: 'x@exemplo.test' } : null),
      create: async ({ data }) => { criados.push(data); return { id: 2, ...data }; },
      upsert: async ({ create }) => { criados.push(create); return { id: 3, ...create }; },
    },
    barbearia: { upsert: async ({ create }) => ({ id: 9, ...create }) },
    horarioTrabalho: { count: async () => 0, create: async () => ({}) },
    configuracao: { upsert: async () => ({}) },
  });
  const antes = { NODE_ENV: process.env.NODE_ENV, APP_DOMAIN: process.env.APP_DOMAIN };
  process.env.NODE_ENV = producao ? 'production' : 'test';
  delete process.env.APP_DOMAIN;
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await carregar('prisma/seed.js', { prisma }).main();
  } finally {
    console.log = orig;
    process.env.NODE_ENV = antes.NODE_ENV;
    if (antes.APP_DOMAIN !== undefined) process.env.APP_DOMAIN = antes.APP_DOMAIN;
  }
  return { criados, log: logs.join('\n') };
}

test('seed em produção com dono existente: não cria nada', async () => {
  const r = await rodar({ donoExiste: true, producao: true });
  assert.equal(r.criados.length, 0);
});

test('seed em banco vazio: cria um dono fictício com senha aleatória provisória e não imprime senha', async () => {
  const r = await rodar({ donoExiste: false, producao: true });
  assert.equal(r.criados.length, 1);
  assert.equal(r.criados[0].email, 'dono@exemplo.test');
  assert.equal(r.criados[0].senhaProvisoria, true);
  assert.ok(r.criados[0].senhaHash.startsWith('$2'));
  assert.doesNotMatch(r.log, /senha:|\/ \w{6,}/i);
  assert.match(r.log, /senha-dono\.js/);
});

test('seed em desenvolvimento: barbearia de exemplo fictícia, admin @exemplo.test', async () => {
  const r = await rodar({ donoExiste: true, producao: false });
  assert.deepEqual(r.criados.map((c) => c.email), ['admin@exemplo.test']);
  assert.equal(r.criados[0].senhaProvisoria, true);
});
