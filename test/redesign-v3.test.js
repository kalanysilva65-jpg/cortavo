// Redesign v3 (branch squad/app-redesign): telas renderizadas de verdade com
// o EJS do app e dados fictícios. Sem banco, sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');

const VIEWS = path.join(RAIZ, 'src/views');
const render = (v, dados) => ejs.renderFile(path.join(VIEWS, v), dados);
const TUDO_BLOQUEADO = ['clientes', 'servicos', 'produtos', 'estoque', 'planos', 'comissoes', 'horarios', 'conversas', 'ia'];

function locais({ plano = 'barbearia', admin = true, bloqueados = [], caminho = '/painel' } = {}) {
  const { exigeFuncaoDoPlano } = carregar('src/middlewares/planoCortavo.js');
  const permissoes = carregar('src/services/permissoes.js');
  const res = resFalso();
  res.locals.barbeariaAtual = { id: 1, nome: 'Barbearia Vila Rosa', planoCortavo: plano };
  exigeFuncaoDoPlano(reqFalso({ path: '/', method: 'GET', headers: { accept: 'text/html' } }), res, () => {});
  const bloq = new Set(bloqueados);
  return {
    ...res.locals, currentPath: caminho, ehAdmin: admin, ehDono: false, usuarioFotoUrl: null, faixaTeste: null,
    usuario: { id: 2, nome: admin ? 'Rafael Moreira' : 'Diego Santos', papel: admin ? 'admin' : 'funcionario' },
    podeAcessar: (href) => {
      const m = permissoes.moduloDoCaminho(String(href).replace(/^\/painel/, '') || '/');
      return admin || !m || !bloq.has(m.chave);
    },
  };
}
const hrefsDaNav = (html) => (html.match(/<nav class="cv-navbar"[\s\S]*?<\/nav>/) || [''])[0].match(/href="[^"]+"/g);

// ---------- F1: navbar de 5 seções (spec 12, critério 1) ----------
test('F1 navbar: as mesmas 5 seções para dono e para barbeiro com tudo bloqueado', async () => {
  const dono = await render('partials/nav-inferior.ejs', locais());
  const soAgenda = await render('partials/nav-inferior.ejs', locais({ admin: false, bloqueados: TUDO_BLOQUEADO, plano: 'essencial' }));
  const esperado = ['href="/painel"', 'href="/painel/agenda"', 'href="/painel/agenda/novo"', 'href="/painel/gestao"', 'href="/painel/mais"'];
  assert.deepEqual(hrefsDaNav(dono), esperado);
  assert.deepEqual(hrefsDaNav(soAgenda), esperado);
  for (const r of ['Início', 'Agenda', 'Gestão', 'Mais']) assert.match(dono, new RegExp('<span>' + r + '</span>'));
  assert.match(dono, /aria-label="Novo agendamento"/);
});

test('F1 navbar: a seção ativa segue a tela (aria-current)', async () => {
  const casos = {
    '/painel': 'inicio', '/painel/agenda': 'agenda', '/painel/horarios': 'agenda', '/painel/caixa': 'gestao',
    '/painel/relatorios': 'gestao', '/painel/clientes': 'mais', '/painel/perfil': 'mais', '/painel/secretaria/teste': 'mais',
  };
  for (const [caminho, secao] of Object.entries(casos)) {
    const html = await render('partials/nav-inferior.ejs', locais({ caminho }));
    assert.match(html, new RegExp('data-nav="' + secao + '" aria-current="page"'), caminho);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1, caminho);
  }
});

// ---------- F1: Gestão e estado vazio (spec 12, critério 2) ----------
test('F1 Gestão: barbeiro com tudo bloqueado vê o estado vazio com atalho, nunca 403', async () => {
  const html = await render('painel/gestao.ejs', locais({ admin: false, bloqueados: TUDO_BLOQUEADO, caminho: '/painel/gestao' }));
  assert.match(html, /Ainda sem números para você/);
  assert.match(html, /o responsável não liberou nenhuma parte para você/);
  assert.match(html, /href="\/painel\/agenda"[^>]*>[\s\S]*Ver minha agenda/);
  assert.doesNotMatch(html, /href="\/painel\/(caixa|relatorios|clientes|comissoes)"/);
});

test('F1 Gestão: admin no Essencial vê cadeado; barbeiro vê só o liberado, sem cadeado', async () => {
  const admin = await render('painel/gestao.ejs', locais({ plano: 'essencial', caminho: '/painel/gestao' }));
  assert.match(admin, /href="\/painel\/caixa"/);
  assert.match(admin, /Relatórios \(fora do plano\)/);
  assert.match(admin, /Plano Barbearia/);
  const barbeiro = await render('painel/gestao.ejs', locais({ admin: false, plano: 'essencial', bloqueados: ['estoque'], caminho: '/painel/gestao' }));
  assert.doesNotMatch(barbeiro, /fora do plano|cv-cadeado/);
  assert.doesNotMatch(barbeiro, /href="\/painel\/(caixa|relatorios|metas|estoque|comissoes)"/);
  assert.match(barbeiro, /href="\/painel\/clientes"/);
  const barbeiroPleno = await render('painel/gestao.ejs', locais({ admin: false, caminho: '/painel/gestao' }));
  assert.match(barbeiroPleno, /Minha comissão/);
});

// ---------- F1: Mais ----------
test('F1 Mais: barbeiro não vê itens de admin; todos têm perfil, ajuda e sair; nada de compra', async () => {
  const barbeiro = await render('painel/mais.ejs', locais({ admin: false, caminho: '/painel/mais' }));
  for (const h of ['/painel/equipe', '/painel/secretaria', '/painel/meu-plano', '/painel/fidelidade', '/painel/logo', '/painel/perfil#pf-backup']) {
    assert.doesNotMatch(barbeiro, new RegExp('href="' + h + '"'), h);
  }
  const soAgenda = await render('painel/mais.ejs', locais({ admin: false, bloqueados: TUDO_BLOQUEADO, caminho: '/painel/mais' }));
  for (const html of [barbeiro, soAgenda]) {
    assert.match(html, /href="\/painel\/perfil"/);
    assert.match(html, /action="\/logout"/);
    assert.match(html, /href="mailto:/);
  }
  assert.doesNotMatch(soAgenda, /href="\/painel\/(clientes|servicos|conversas|ia)"/);
  const dono = await render('painel/mais.ejs', locais({ caminho: '/painel/mais' }));
  assert.match(dono, /Seu plano/);
  assert.match(dono, /Secretária de IA \(fora do plano\)/); // o plano Barbearia não tem secretária
  for (const html of [dono, barbeiro]) assert.doesNotMatch(html, /pagar|assinar agora|comprar|checkout|R\$/i);
});

test('F1 rotas: Mais é a lista de seções, Perfil tem rota própria, Gestão existe para todos', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(rotas, /router\.get\('\/mais', \(req, res\) => res\.render\('painel\/mais'/);
  assert.match(rotas, /router\.get\('\/perfil', perfilController\.ver\)/);
  assert.match(rotas, /router\.get\('\/gestao', \(req, res\) => res\.render\('painel\/gestao'/);
  assert.doesNotMatch(rotas.split("router.get('/gestao'")[1].split('\n')[0], /exigeAdmin/);
  const horario = fs.readFileSync(path.join(RAIZ, 'src/controllers/horarioController.js'), 'utf8');
  assert.match(horario, /perfil: '\/painel\/perfil'/);
});

// ---------- F0: fundação ----------
test('F0 fundação: sem azul, fonte da v3 self-host, acessibilidade de movimento e transparência', () => {
  const css = ['tokens.css', 'cv.css', 'cv-telas.css'].map((f) => fs.readFileSync(path.join(RAIZ, 'public/css', f), 'utf8')).join('\n');
  assert.doesNotMatch(css, /#(2f6bff|7f92cf|0d6efd|1e90ff|007bff|2563eb|3b82f6)\b/i, 'sem azul');
  assert.match(css, /url\('\/fonts\/plus-jakarta-sans-latin-800-normal\.woff2'\)/);
  for (const p of [400, 600, 800]) assert.ok(fs.existsSync(path.join(RAIZ, `public/fonts/plus-jakarta-sans-latin-${p}-normal.woff2`)));
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-reduced-transparency: reduce/);
  const layout = fs.readFileSync(path.join(VIEWS, 'layouts/painel.ejs'), 'utf8');
  assert.match(layout, /theme-color" content="#F2F2F2"/);
  assert.match(layout, /viewport-fit=cover/);
  for (const js of ['cv-mola', 'cv-movimento', 'cv-casca']) assert.match(layout, new RegExp('/js/' + js + '\\.js[^"]*" defer'));
});
