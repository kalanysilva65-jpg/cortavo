// Teste de exemplo: prova que o ambiente roda sem tocar o banco real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

test('extrairSlug lê o subdomínio de localhost sem banco', () => {
  const { extrairSlug } = carregar('src/middlewares/tenant.js');
  assert.equal(extrairSlug({ hostname: 'navalha.localhost' }), 'navalha');
  assert.equal(extrairSlug({ hostname: 'localhost' }), null);
});

test('prisma falso recusa método não simulado (nunca cai no banco)', () => {
  const p = prismaFalso();
  assert.throws(() => p.barbearia.findMany(), /não simulado/);
});

test('exigeBarbeariaPainel manda o dono sem barbearia para /mestre', async () => {
  const { exigeBarbeariaPainel } = carregar('src/middlewares/tenant.js');
  const req = reqFalso({ session: { usuario: { id: 1, papel: 'dono' } } });
  const res = resFalso();
  await exigeBarbeariaPainel(req, res, () => assert.fail('não deveria seguir'));
  assert.equal(res.redirecionou, '/mestre');
});
