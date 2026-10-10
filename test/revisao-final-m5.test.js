// Sergio M5: POST de outro site ou de outro subdomínio é recusado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, resFalso } = require('./helpers/ambiente');

const { origemPermitida, origemMesmoSite } = carregar('src/middlewares/origemMesmoSite.js');
const req = (method, headers) => ({ method, path: '/painel/x', headers, get: (k) => headers[k.toLowerCase()] });

test('M5 GET sempre passa; POST do próprio host passa; sem cabeçalhos (navegador antigo) passa', () => {
  assert.equal(origemPermitida(req('GET', { 'sec-fetch-site': 'cross-site' })), true);
  assert.equal(origemPermitida(req('POST', { host: 'cortavo.com.br', origin: 'https://cortavo.com.br', 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(origemPermitida(req('POST', { host: 'andrade.cortavo.com.br', origin: 'https://andrade.cortavo.com.br' })), true);
  assert.equal(origemPermitida(req('POST', { host: 'cortavo.com.br' })), true);
  assert.equal(origemPermitida(req('POST', { host: 'localhost:3000', origin: 'http://localhost:3000' })), true);
});

test('M5 POST de outro site ou de outro subdomínio (mesmo site) é recusado', () => {
  assert.equal(origemPermitida(req('POST', { host: 'cortavo.com.br', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(origemPermitida(req('POST', { host: 'cortavo.com.br', origin: 'https://site-ruim.test' })), false);
  assert.equal(origemPermitida(req('POST', { host: 'cortavo.com.br', origin: 'https://qualquer.cortavo.com.br', 'sec-fetch-site': 'same-site' })), false);
  assert.equal(origemPermitida(req('DELETE', { host: 'cortavo.com.br', origin: 'https://site-ruim.test' })), false);
  assert.equal(origemPermitida(req('POST', { host: 'cortavo.com.br', origin: 'lixo' })), false);
});

test('M5 resposta 403 (JSON para fetch, texto para formulário) e montado depois da sessão, fora dos webhooks', () => {
  let res = resFalso();
  res.type = function () { return this; };
  origemMesmoSite(req('POST', { host: 'a', origin: 'https://b', accept: 'application/json' }), res, () => assert.fail('não deveria seguir'));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.stringify(res.enviado), /recusado/);
  let seguiu = false;
  origemMesmoSite(req('POST', { host: 'a', origin: 'https://a' }), resFalso(), () => { seguiu = true; });
  assert.equal(seguiu, true);
  const srv = fs.readFileSync(path.join(RAIZ, 'src/server.js'), 'utf8');
  const i = srv.indexOf('origemMesmoSite');
  assert.ok(i > srv.indexOf("app.use('/webhooks'"), 'webhooks da Meta ficam antes (não passam pelo freio)');
  assert.ok(i < srv.indexOf("app.use('/', require('./routes/auth'))"));
});
