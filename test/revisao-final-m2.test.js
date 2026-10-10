// Sergio M2: o token do link (?t=) não vai para o log de erro 500 nem para o
// log de acesso do nginx.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ } = require('./helpers/ambiente');

test('M2 [ERRO500] registra só o caminho (req.path), nunca a URL com a query', () => {
  const srv = fs.readFileSync(path.join(RAIZ, 'src/server.js'), 'utf8');
  const linha = srv.split('\n').find((l) => l.includes("'[ERRO500]'"));
  assert.ok(linha);
  assert.match(linha, /req\.path/);
  assert.doesNotMatch(linha, /originalUrl|req\.url/);
  for (const arq of fs.readdirSync(path.join(RAIZ, 'src'), { recursive: true }).filter((f) => f.endsWith('.js'))) {
    const t = fs.readFileSync(path.join(RAIZ, 'src', arq), 'utf8');
    assert.doesNotMatch(t, /console\.(log|error|warn)\([^)]*(originalUrl|req\.url\b|req\.query\.t\b)/, arq);
  }
});

test('M2 nginx: /criar-senha sem log de acesso, com o mesmo proxy (Host preservado)', () => {
  const conf = fs.readFileSync(path.join(RAIZ, 'deploy/nginx-cortavo.conf'), 'utf8');
  const m = /location = \/criar-senha \{([\s\S]*?)\}/.exec(conf);
  assert.ok(m, 'bloco da rota');
  assert.match(m[1], /access_log off;/);
  assert.match(m[1], /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(m[1], /proxy_set_header Host \$host;/);
  assert.match(m[1], /X-Forwarded-Proto/);
});
