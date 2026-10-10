// A rota "/" do subdomínio da barbearia leva ao agendamento (link do QR e do
// WhatsApp), mesmo com alguém da equipe logado; o domínio raiz segue para o
// login/painel (app da equipe, revisão da Apple).
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, reqFalso, resFalso } = require('./helpers/ambiente');

const raiz = () => carregar('src/routes/auth.js').raiz;
const ir = (extra) => { const res = resFalso(); raiz()(reqFalso(extra), res); return res.redirecionou; };

test('subdomínio: visitante vai para /agendar', () => {
  assert.equal(ir({ barbearia: { id: 7, slug: 'andrade' }, slugBarbearia: 'andrade' }), '/agendar');
});
test('subdomínio: dono da barbearia logado também vai para /agendar (vê o que o cliente vê)', () => {
  assert.equal(ir({ barbearia: { id: 7 }, slugBarbearia: 'andrade', session: { usuario: { id: 1, papel: 'admin' } } }), '/agendar');
  assert.equal(ir({ barbearia: { id: 7 }, slugBarbearia: 'andrade', session: { usuario: { id: 1, papel: 'dono' } } }), '/agendar');
});
test('subdomínio pausado ou inexistente: /agendar (que mostra o aviso), nunca o painel', () => {
  assert.equal(ir({ barbearia: null, slugBarbearia: 'pausada', session: { usuario: { id: 1, papel: 'admin' } } }), '/agendar');
});
test('domínio raiz: visitante /login, equipe /painel, dono do sistema /mestre', () => {
  assert.equal(ir({}), '/login');
  assert.equal(ir({ session: { usuario: { id: 1, papel: 'admin' } } }), '/painel');
  assert.equal(ir({ session: { usuario: { id: 1, papel: 'funcionario' } } }), '/painel');
  assert.equal(ir({ session: { usuario: { id: 1, papel: 'dono' } } }), '/mestre');
});
