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

// ---------- F3: Início "Painel vivo" ----------
function inicio(extra = {}) {
  const arq = path.join(VIEWS, 'painel/dashboard.ejs');
  const base = {
    ehAdmin: true, usuarioFotoUrl: null, iniciaisUsuario: 'RM', dataLonga: 'sexta, 9 de outubro', faixaTeste: null,
    totalHoje: 20, concluidosHoje: 14, restantesHoje: 6, ganhoHoje: 123850, previstoHoje: 180000, ocupacaoHoje: 64,
    proximoCorte: { cliente: 'Lucas Andrade', hora: '14:30', servico: 'Corte + barba', diaNum: 9, mesLabel: 'out', hoje: true, emMin: 10, barbeiro: 'Diego' },
    maisHoje: 5, atualizadoAs: '14:20', estoqueBaixo: { tem: false }, metasHome: [],
  };
  return ejs.render(fs.readFileSync(arq, 'utf8'), { ...base, ...extra }, { filename: arq });
}

test('F3 Início: dono vê 3 anéis, frase do dia com plural e o próximo com o barbeiro', () => {
  const html = inicio();
  assert.match(html, /<h1>Hoje<\/h1>/);
  assert.match(html, /Sexta, 9 de outubro/);
  assert.equal((html.match(/class="arco"/g) || []).length, 3);
  assert.match(html, /Faturamento/);
  assert.match(html, /Hoje são <b>20 atendimentos<\/b>, <b>14 concluídos<\/b>\. Já entraram <b>R\$ 1\.238,50<\/b> no caixa\./); // espaço sem quebra entre R$ e o valor
  assert.match(html, /em 10 min/);
  assert.match(html, /Corte \+ barba com Diego/);
  assert.match(html, /Mais 5 hoje/);
  assert.match(html, /href="\/painel\/gestao"/);
  const um = inicio({ totalHoje: 1, concluidosHoje: 1 });
  assert.match(um, /<b>1 atendimento<\/b>, <b>1 concluído<\/b>/);
});

test('F3 Início: barbeiro vê só a agenda dele (2 anéis, sem dinheiro, sem barbeiro no próximo)', () => {
  const html = inicio({ ehAdmin: false, ganhoHoje: 0, previstoHoje: 0, totalHoje: 6, concluidosHoje: 2 });
  assert.equal((html.match(/class="arco"/g) || []).length, 2);
  assert.doesNotMatch(html, /Faturamento|R\$/);
  assert.match(html, /Você tem <b>6 atendimentos<\/b> hoje\. O próximo é às <b>14:30<\/b>\./);
  assert.doesNotMatch(html, /com Diego/);
  assert.match(html, /Minha agenda/);
});

test('F3 Início: barbearia nova e valores grandes não quebram (break-ui)', () => {
  const vazio = inicio({ totalHoje: 0, concluidosHoje: 0, ganhoHoje: 0, previstoHoje: 0, ocupacaoHoje: 0, proximoCorte: null, maisHoje: 0 });
  assert.match(vazio, /Nenhum atendimento marcado para hoje\./);
  assert.match(vazio, /Atualiza a cada atendimento/);
  assert.equal((vazio.match(/data-p="0"/g) || []).length, 3, 'anel a 0% não desenha ponto');
  assert.match(vazio, /Nenhum agendamento a partir de agora/);
  const grande = inicio({ ganhoHoje: 12849300, previstoHoje: 15000000 });
  assert.match(grande, /128,5 mil/);
  assert.match(grande, /\/150 mil/);
  assert.match(grande, /data-fixo/);
});

test('F3 Início: horas livres só com o dado do Beto (B6); faixa do teste só quando existe', () => {
  assert.doesNotMatch(inicio(), /Horas livres hoje|class="cv-histo"/);
  const comHoras = inicio({ horasLivres: { de: 9, ocup: [1, 1, 0.5, 'b', 1, 1, 0.5, 0, 0, 0.5, 0, 0.5], agoraH: 14.3, livres: 5, faixa: 'entre 15h e 19h' } });
  assert.match(comHoras, /Horas livres hoje/);
  assert.equal((comHoras.match(/class="h[ "]/g) || []).length, 12);
  assert.match(comHoras, /class="h bloq/);
  assert.match(comHoras, /class="agora"/);
  assert.doesNotMatch(inicio(), /cv-faixa/);
  assert.match(inicio({ faixaTeste: { dias: 3, aviso: true, texto: 'Seu teste termina em 3 dias.' } }), /cv-faixa faixa-teste/);
});
