// Link de agendamento (telas da Dani, redesign/v3/acesso): subdomínio
// slug.cortavo.com.br em todo lugar (decisão da Kalany), QR sem biblioteca,
// tela no Mais e atalho na Início. Sem banco, sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');

const VIEWS = path.join(RAIZ, 'src/views');
const render = (v, d) => ejs.renderFile(path.join(VIEWS, v), d);

test('linkAgendamento: subdomínio, com APP_DOMAIN ou o padrão cortavo.com.br', (t) => {
  const antes = process.env.APP_DOMAIN;
  t.after(() => { if (antes === undefined) delete process.env.APP_DOMAIN; else process.env.APP_DOMAIN = antes; });
  delete process.env.APP_DOMAIN;
  const { linkAgendamento, textoPadrao } = require(path.join(RAIZ, 'src/services/linkAgendamento.js'));
  assert.deepEqual(linkAgendamento({ slug: 'Andrade' }), { url: 'https://andrade.cortavo.com.br', curto: 'andrade.cortavo.com.br', slug: 'andrade', dominio: 'cortavo.com.br' });
  process.env.APP_DOMAIN = 'www.exemplo.test';
  assert.equal(linkAgendamento({ slug: 'vilarosa' }).url, 'https://vilarosa.exemplo.test');
  assert.equal(linkAgendamento(null), null);
  assert.match(textoPadrao({ nome: 'Vila Rosa', slug: 'vilarosa' }), /na Vila Rosa pelo celular[\s\S]*\nhttps:\/\/vilarosa\.exemplo\.test$/);
  for (const f of ['src/controllers/secretariaController.js', 'src/services/atendimento.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, f), 'utf8'), /agenda\.exemplo\.com/, f);
  }
});

test('QR sem biblioteca: SVG com rótulo, mesmo gerador no servidor e no navegador', () => {
  const QR = require(path.join(RAIZ, 'src/services/qr.js'));
  const svg = QR.svg('https://vilarosa.cortavo.com.br', { borda: 2, rotulo: 'QR code do link vilarosa.cortavo.com.br' });
  assert.match(svg, /^<svg [^>]*role="img" aria-label="QR code do link vilarosa\.cortavo\.com\.br"/);
  const g = QR.gerar('https://vilarosa.cortavo.com.br');
  assert.ok(g.tamanho >= 21 && (g.tamanho - 17) % 4 === 0, 'tamanho de QR válido');
  assert.equal(fs.readFileSync(path.join(RAIZ, 'public/js/qr.js'), 'utf8'), fs.readFileSync(path.join(RAIZ, 'src/services/qr.js'), 'utf8'));
});

test('Tela do link: endereço por subdomínio, copiar, compartilhar, QR e cartaz; só admin', async () => {
  const ctrl = carregar('src/controllers/linkController.js');
  const res = resFalso();
  res.locals.barbeariaAtual = { id: 1, nome: 'Barbearia Vila Rosa', slug: 'vilarosa' };
  ctrl.ver(reqFalso({ query: {} }), res);
  const d = res.renderizou.dados;
  assert.equal(res.renderizou.view, 'painel/link');
  const html = await render('painel/link.ejs', { ...d, marcaLogoUrl: null });
  assert.match(html, /<span class="slug">vilarosa<\/span><span class="dom">\.cortavo\.com\.br<\/span>/);
  assert.match(html, /data-copiar-url="https:\/\/vilarosa\.cortavo\.com\.br"/);
  assert.match(html, /id="lk-compartilhar"/);
  assert.match(html, /<div class="lk-qr-img"><svg /);
  assert.match(html, /href="\/painel\/link\/cartaz"/);
  assert.doesNotMatch(html, /<iframe/, 'sem moldura de outra origem (anti-clickjacking)');
  const cz = await render('painel/link-cartaz.ejs', { ...d, marcaLogoUrl: null });
  assert.match(cz, /Agende seu horário pelo celular/);
  assert.match(cz, /<b>vilarosa<\/b><span>\.cortavo\.com\.br<\/span>/);
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(rotas, /router\.get\('\/link', exigeAdmin, linkController\.ver\)/);
  assert.match(rotas, /router\.get\('\/link\/cartaz', exigeAdmin, linkController\.cartaz\)/);
  const css = fs.readFileSync(path.join(RAIZ, 'public/css/cv-link.css'), 'utf8');
  assert.match(css, /@page \{ size: A5 portrait/);
});

test('Mais › Agendamento online e o atalho na Início (só para quem cuida da barbearia)', async () => {
  const M = {};
  const base = { ehAdmin: true, ehDono: false, usuario: { nome: 'Rafael Moreira' }, podeAcessar: () => true, foraDoPlano: () => null, planoCortavo: { nome: 'Barbearia', tetos: {} }, saida: M };
  await render('partials/mais-listas.ejs', base);
  const sec = M.secoes.find((s) => s.t === 'Agendamento online');
  assert.deepEqual(sec.itens.map((i) => i.href), ['/painel/link', '/painel/logo']);
  const M2 = {};
  await render('partials/mais-listas.ejs', { ...base, ehAdmin: false, saida: M2 });
  assert.ok(!M2.secoes.some((s) => s.t === 'Agendamento online'));
  const dash = fs.readFileSync(path.join(VIEWS, 'painel/dashboard.ejs'), 'utf8');
  assert.match(dash, /admin && typeof linkAgendamento !== 'undefined' && linkAgendamento/);
  assert.match(dash, /data-copiar-url="<%= linkAgendamento\.url %>"/);
});
