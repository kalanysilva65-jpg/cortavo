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
  const esperado = ['href="/painel"', 'href="/painel/agenda"', 'href="/painel/agenda?abrir=agendamento"', 'href="/painel/gestao"', 'href="/painel/mais"'];
  assert.deepEqual(hrefsDaNav(dono), esperado);
  assert.deepEqual(hrefsDaNav(soAgenda), esperado);
  for (const r of ['Início', 'Agenda', 'Gestão', 'Mais']) assert.match(dono, new RegExp('<span>' + r + '</span>'));
  assert.match(dono, /id="btn-novo"[^>]*aria-label="Novo"/);
});

test('F1 navbar: a seção ativa segue a tela (aria-current)', async () => {
  const casos = {
    '/painel': 'inicio', '/painel/agenda': 'agenda', '/painel/horarios': 'agenda', '/painel/caixa': 'mais',
    '/painel/relatorios': 'gestao', '/painel/clientes': 'mais', '/painel/perfil': 'mais', '/painel/secretaria/teste': 'mais',
  };
  for (const [caminho, secao] of Object.entries(casos)) {
    const html = await render('partials/nav-inferior.ejs', locais({ caminho }));
    assert.match(html, new RegExp('data-nav="' + secao + '" aria-current="page"'), caminho);
    const nav = html.match(/<nav class="cv-navbar"[\s\S]*?<\/nav>/)[0];
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1, caminho);
    // F13: o menu lateral do PC marca no máximo um item.
    const pc = html.match(/<aside class="pc-menu"[\s\S]*?<\/aside>/)[0];
    assert.ok((pc.match(/aria-current="page"/g) || []).length <= 1, caminho);
  }
});

// ---------- F13: menu lateral do PC ----------
const menuPC = (html) => html.match(/<aside class="pc-menu"[\s\S]*?<\/aside>/)[0];
test('F13 menu PC: mesmas seções, Novo com as ações liberadas e os itens do Mais (dono)', async () => {
  const pc = menuPC(await render('partials/nav-inferior.ejs', locais({ caminho: '/painel/caixa' })));
  for (const h of ['/painel', '/painel/agenda', '/painel/gestao', '/painel/caixa', '/painel/comissoes', '/painel/equipe', '/painel/clientes', '/painel/meu-plano']) assert.match(pc, new RegExp('href="' + h + '"'), h);
  // Caixa mora no Mais (Caixa e cadastros) desde 2026-10-10.
  assert.match(pc, /href="\/painel\/caixa"[^>]*aria-current="page"/);
  assert.doesNotMatch(pc, /href="\/painel\/gestao" aria-current/);
  assert.match(pc, /id="pc-novo" aria-haspopup="menu" aria-expanded="false"/);
  assert.equal((pc.match(/role="menuitem"/g) || []).length, 4);
  assert.match(pc, /action="\/logout"/);
});

test('F13 menu PC: barbeiro com tudo bloqueado vê o mesmo menu, sem Caixa nem cadastros', async () => {
  const pc = menuPC(await render('partials/nav-inferior.ejs', locais({ admin: false, bloqueados: TUDO_BLOQUEADO, plano: 'essencial', caminho: '/painel/agenda' })));
  for (const h of ['/painel', '/painel/agenda', '/painel/gestao']) assert.match(pc, new RegExp('href="' + h + '"'), h);
  assert.match(pc, /href="\/painel\/agenda" aria-current="page"/);
  for (const h of ['/painel/caixa', '/painel/clientes', '/painel/equipe', '/painel/relatorios']) assert.doesNotMatch(pc, new RegExp('href="' + h + '"'), h);
  assert.equal((pc.match(/role="menuitem"/g) || []).length, 1);
  const css = fs.readFileSync(path.join(RAIZ, 'public/css/cv-pc.css'), 'utf8');
  assert.match(css, /^\.pc-menu \{ display: none; \}/m);
  assert.match(css, /@media \(min-width: 1024px\)[\s\S]*\.cv-navbar \{ display: none !important; \}/);
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
  assert.doesNotMatch(admin, /href="\/painel\/caixa"/); // Caixa saiu da Gestão (fica no Mais)
  assert.match(admin, /href="\/painel\/comissoes"/);
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
  assert.match(rotas, /router\.get\('\/gestao', async \(req, res\) => \{[\s\S]*?res\.render\('painel\/gestao'/);
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

// ---------- F2: folha Novo ----------
const acoesDaFolha = (html) => (html.match(/<section class="cv-folha" id="folha-novo"[\s\S]*?<\/section>/) || [''])[0].match(/<b>[^<]+<\/b>/g).map((b) => b.replace(/<\/?b>/g, ''));
test('F2 folha Novo: ações filtradas pela permissão, "Agendamento" sempre e primeiro', async () => {
  const dono = await render('partials/nav-inferior.ejs', locais());
  assert.deepEqual(acoesDaFolha(dono), ['Agendamento', 'Cliente', 'Lançamento', 'Bloqueio']);
  assert.match(dono, /class="cv-acao cv-acao--principal" href="\/painel\/agenda\?abrir=agendamento"/);
  assert.match(dono, /href="\/painel\/caixa\?abrir=lancamento"/);
  const basico = await render('partials/nav-inferior.ejs', locais({ admin: false }));
  assert.deepEqual(acoesDaFolha(basico), ['Agendamento', 'Cliente', 'Bloqueio']);
  assert.match(basico, /href="\/painel\/agenda\?abrir=bloqueio"/);
  assert.doesNotMatch(basico, /abrir=lancamento/);
  // Com as chaves do B1: barbeiro com caixa_lancar ganha Lançamento; sem horarios, perde Bloqueio.
  const comChaves = await render('partials/nav-inferior.ejs', { ...locais({ admin: false }), pode: (k) => ['clientes', 'caixa_lancar'].includes(k) });
  assert.deepEqual(acoesDaFolha(comChaves), ['Agendamento', 'Cliente', 'Lançamento']);
  const soAgenda = await render('partials/nav-inferior.ejs', locais({ admin: false, bloqueados: TUDO_BLOQUEADO }));
  assert.deepEqual(acoesDaFolha(soAgenda), ['Agendamento']);
  assert.match(dono, /role="dialog" aria-modal="true" aria-labelledby="folha-novo-titulo"/);
  assert.match(dono, /data-fechar aria-label="Fechar"/);
});

test('F2 casca: "+" abre a folha e ?abrir= abre a folha da tela de destino', () => {
  const js = fs.readFileSync(path.join(RAIZ, 'public/js/cv-casca.js'), 'utf8');
  for (const t of ["C.folha.abrir(f, { gatilho: btn })", "C.folha.arrastar(f)", "e.key === 'Escape'", "g.abrirModal('novo')", "g.abrirModal('bloqueio')", "g.clAbrirFolha('novo')", "g.cxFolha('novo', true)"]) assert.ok(js.includes(t), t);
  // A Agenda v3 expõe abrirModal no próprio script; clientes e caixa, nas views.
  assert.ok(fs.readFileSync(path.join(RAIZ, 'public/js/cv-agenda.js'), 'utf8').includes('g.abrirModal = abrirModal'));
  assert.ok(fs.readFileSync(path.join(RAIZ, 'public/js/cv-caixa.js'), 'utf8').includes('g.cxFolha = function'));
  assert.ok(fs.readFileSync(path.join(VIEWS, 'painel/clientes.ejs'), 'utf8').includes('function clAbrirFolha('));
});

// ---------- F4: Agenda ----------
function agenda(extra = {}) {
  const arq = path.join(VIEWS, 'painel/agenda.ejs');
  const hoje = '2026-10-09';
  const D = { id: 3, nome: 'Diego Santos' };
  const it = (n, v) => ({ servico: { nome: n }, valor: v, quantidade: 1 });
  const ag = (id, h, cli, status) => ({ id, horaInicio: h, clienteNome: cli, clienteTelefone: '51999990000', itens: [it('Corte', 4000)], usuario: D, status, valorTotal: 4000, pagamentos: [], clientePlanoId: null });
  const base = {
    ehAdmin: true, usuario: { id: 2, nome: 'Rafael Moreira' }, faixaDias: [{ iso: hoje, num: 9, rotulo: 'Sex', selecionado: true, ehHoje: true }],
    diaNum: 9, proxDiaNum: 10, proximoId: 3, mesLabel: 'Outubro', anoMes: 2026, anoPicker: 2026, mesesPicker: [],
    agendamentos: [ag(1, '09:00', 'Gustavo Nunes', 'concluido'), ag(2, '10:30', 'Renato Alves', 'cancelado'), ag(3, '23:50', 'Lucas Andrade', 'agendado')],
    bloqueios: [{ id: 1, horaInicio: '12:00', horaFim: '13:00', motivo: 'Almoço da equipe', usuario: D }],
    barbeiros: [D], servicos: [], clientes: [], formasPagamento: [{ valor: 'pix', label: 'Pix' }, { valor: 'credito', label: 'Crédito' }], maxParcelas: 12,
    dataStr: hoje, dataExtenso: 'sexta, 09/10/2026', barbeiroSelecionado: 'todos', dataPrev: hoje, dataNext: hoje, dataHoje: hoje, hojeIso: hoje,
    mostrarBarbeiroNoCard: true, jsonSeguro: (x) => JSON.stringify(x), fmtTelefone: (t) => t, fmtBRL: (c) => 'R$ ' + c / 100, fmtT6: (c) => 'R$' + c / 100, podeAcessar: () => true,
  };
  return ejs.render(fs.readFileSync(arq, 'utf8'), { ...base, ...extra }, { filename: arq });
}

test('F4 Agenda: linha do dia v3 com estado escrito, listra no bloqueio e a linha "agora" só hoje', () => {
  const html = agenda();
  assert.match(html, /<h1>Agenda<\/h1>/);
  assert.match(html, /Sexta, 9 de outubro/);
  assert.match(html, /class="cv-ag cv-toca feito"[\s\S]*?Concluído/);
  assert.match(html, /class="cv-ag cv-toca cancelado"[\s\S]*?Cancelado/);
  assert.match(html, /class="cv-ag bloqueado"[\s\S]*?Almoço da equipe até 13:00/);
  assert.match(html, /class="cv-agora-linha"/);
  assert.match(html, /abrirModal\('bloqueio'\)[^>]*>[\s\S]*?Bloquear<\/button>/);
  assert.doesNotMatch(agenda({ dataHoje: '2026-10-10' }), /class="cv-agora-linha"/);
  assert.match(agenda({ agendamentos: [{ id: 9, horaInicio: '09:00', clienteNome: 'Ana', itens: [], usuario: { nome: 'Diego' }, status: 'faltou', valorTotal: 0, pagamentos: [] }] }), /class="cv-ag cv-toca faltou"[\s\S]*?Faltou/);
});

test('F4 Agenda: folhas, IDs e scripts de antes continuam (novo, bloqueio, mês, tira de dias)', () => {
  const html = agenda();
  for (const id of ['agm-novo', 'form-novo-agendamento', 'agm-bloqueio', 'agm-mes', 'cv-ag-dias', 'hora-livre', 'hora-novo', 'data-novo', 'agm-1']) assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.match(html, /action="\/painel\/agenda\/novo"/);
});

test('F4 Agenda: livres só com um barbeiro na tela; Bloquear para admin e para quem tem "horarios"', () => {
  assert.match(agenda(), /id="cv-ag-tl" data-barbeiro=""/);
  assert.match(agenda({ barbeiroSelecionado: '3' }), /id="cv-ag-tl" data-barbeiro="3"/);
  const semHorarios = agenda({ ehAdmin: false, pode: (c) => c !== 'horarios' });
  assert.match(semHorarios, /id="cv-ag-tl" data-barbeiro="2"/);
  assert.doesNotMatch(semHorarios, /cv-ag-bloquear|id="agm-bloqueio"/);
  const comHorarios = agenda({ ehAdmin: false, pode: () => true });
  assert.match(comHorarios, /cv-ag-bloquear" onclick="abrirModal\('bloqueio'\)"/);
  assert.match(comHorarios, /id="agm-bloqueio"[\s\S]*?name="barbeiroId" value="2"/);
  assert.doesNotMatch(comHorarios, /id="bloq-barbeiro"/);
  const js = fs.readFileSync(path.join(RAIZ, 'public/js/cv-agenda.js'), 'utf8');
  assert.ok(js.includes("fetch('/painel/agenda/horarios?'"));
  assert.ok(js.includes("C.selo({ botao: btn, titulo: 'Agendamento confirmado'"));
  assert.ok(js.includes("C.aviso({ titulo: p.titulo, sub: p.sub, desfazer: !!p.url"));
});

test('F4 Agenda reescrita: tudo em .cv-folha, nada da pilha antiga, e o detalhe com os ganchos do script', () => {
  const html = agenda();
  assert.doesNotMatch(html, /ag-overlay|ag-modal-box|sv-ag-|pill-opcao/);
  for (const id of ['mes', 'bloqueio', 'novo', '1', '2', '3']) assert.match(html, new RegExp('<section class="cv-folha cv-ag-folha" id="agm-' + id + '" role="dialog" aria-modal="true"'), id);
  assert.match(html, /id="cv-ag-dados">\{"clientes"/);
  // Detalhe de um aberto: divisão de pagamento, concluir, faltou, cancelar, excluir, itens.
  const det = html.slice(html.indexOf('id="agm-3"'));
  for (const g of ['data-pagto', 'data-concluir', 'data-faltou', 'data-cancelar', 'data-excluir', 'data-item-valor', 'data-total-valor', 'data-add-item', 'data-item-abas']) assert.ok(det.includes(g), g);
  // Concluído: sem divisão nem "Faltou"; mostra como foi pago e o Reabrir.
  const concl = agenda({ agendamentos: [{ id: 5, horaInicio: '09:00', clienteNome: 'Ana', clienteTelefone: '1', itens: [{ servico: { nome: 'Corte' }, valorUnitario: 4000, quantidade: 1 }], usuario: { nome: 'Diego Santos' }, status: 'concluido', valorTotal: 4000, pagamentos: [{ formaPagamento: 'pix', valor: 2500, parcelas: 1 }, { formaPagamento: 'credito', valor: 1500, parcelas: 3 }] }] });
  const detC = concl.slice(concl.indexOf('id="agm-5"'));
  assert.doesNotMatch(detC, /data-pagto|data-faltou/);
  assert.match(detC, /Crédito, 3x/);
  assert.match(detC, /data-reabrir>Concluído\. Reabrir/);
  // Plano: o detalhe diz que foi pelo plano.
  const plano = agenda({ agendamentos: [{ id: 6, horaInicio: '10:00', clienteNome: 'Bia', clienteTelefone: '1', itens: [], usuario: { nome: 'Diego Santos' }, status: 'agendado', valorTotal: 0, pagamentos: [], clientePlanoId: 3, clientePlano: { plano: { nome: 'Mensal' } } }] });
  assert.match(plano, /Pelo plano Mensal/);
  const layout = fs.readFileSync(path.join(VIEWS, 'layouts/painel.ejs'), 'utf8');
  assert.match(layout, /'\/painel\/agenda': 'cv-agenda'/);
  assert.doesNotMatch(layout, /PONTE/);
});

// ---------- F5: Gestão com números (contrato do B4) ----------
const GESTAO_FALSA = {
  rotulo: 'Últimos 7 dias', comparacao: 'vs. 7 dias anteriores',
  faturamento: { valor: 1245050, anterior: 1108000, serie: [120000, 180000, 160000, 210000, 260000, 0, 180000], serieAnt: [110000, 150000, 170000, 190000, 230000, 0, 160000], eixo: ['Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom', 'Seg'] },
  ticket: { valor: 5230, anterior: 5100, spark: [50, 52, 51, 54, 53] }, atendimentos: { valor: 238, anterior: 0, spark: [30, 34, 31, 40, 45] },
  equipe: [{ nome: 'Diego Santos', valor: 512000 }, { nome: 'Rafael Moreira', valor: 401000 }],
};
test('F5 Gestão: com o dado do B4 aparecem seletor de período e cartões; sem o dado, nenhum número', async () => {
  const sem = await render('painel/gestao.ejs', locais({ caminho: '/painel/gestao' }));
  assert.doesNotMatch(sem, /cv-periodo|cv-num/);
  const com = await render('painel/gestao.ejs', { ...locais({ caminho: '/painel/gestao' }), gestao: GESTAO_FALSA, periodo: 'mes' });
  assert.match(com, /name="periodo" value="mes" aria-pressed="true"/);
  assert.match(com, /Últimos 7 dias/);
  assert.match(com, /<span class="int">12\.450<\/span><span class="cent">,50<\/span>/);
  assert.match(com, /Sem período anterior/); // atendimentos sem base
  assert.match(com, /cv-delta--cai|cv-delta"/);
  assert.equal((com.match(/class="col"/g) || []).length, 7);
  assert.match(com, /Desempenho da equipe/);
  for (const ausente of ['Formas de pagamento', 'Comissões a pagar', 'Faltas', 'Lucro', 'Meta do mês', 'Ocupação<']) assert.ok(!com.includes(ausente), ausente);
  assert.match(com, /href="\/painel\/comissoes"/); // a lista de telas continua embaixo (Caixa foi para o Mais)
  const vazio = await render('painel/gestao.ejs', { ...locais({ caminho: '/painel/gestao' }), gestao: { rotulo: 'Hoje', faturamento: { valor: 0 }, atendimentos: { valor: 0 } } });
  assert.match(vazio, /Os números chegam com os atendimentos/);
});

test('F5 rota: período validado na URL, números só com o B4', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.ok(rotas.includes("['hoje', 'semana', 'mes', 'ano'].includes(req.query.periodo)"));
  assert.ok(rotas.includes('gestaoTela.montarGestao({ barbeariaId: req.barbeariaId, permissoes: req.permissoes'));
});

// ---------- F6: Caixa e Fechar caixa ----------
function caixaHtml(extra = {}) {
  const base = {
    podeLancarCaixa: true, podeRemoverCaixa: true, nomePeriodoSel: 'Hoje, 9 de outubro', periodoAtivo: 'hoje',
    presetHoje: { inicio: '2026-10-09', fim: '2026-10-09' }, presetSemana: { inicio: '2026-10-05', fim: '2026-10-11' }, presetMes: { inicio: '2026-10-01', fim: '2026-10-31' },
    periodoCustomLabel: 'Período', inicioStr: '2026-10-09', fimStr: '2026-10-09', atalhosPeriodo: [], hojeIso: '2026-10-09',
    resumoPeriodo: { entrou: 210650, saiu: 26400, saldo: 184250 }, lancamentos: [{ tipo: 'entrada' }, { tipo: 'entrada' }, { tipo: 'saida' }],
    aReceber: { quantidade: 2, valor: 9000 }, formasPagamento: [{ label: 'Pix', curto: 'Pix', valorCentavos: 109600 }, { label: 'Dinheiro', curto: 'Dinheiro', valorCentavos: 35800 }],
    servicosValor: 150000, produtosValor: 20000, comissaoValor: 60000, extratoLabel: 'Extrato de hoje', extratoRestantes: 0,
    extrato: [{ id: 7, hora: '14:12', diaLabel: '', descricao: 'Corte + barba', sub: 'Felipe Rocha · Pix', entrada: true, valor: 7000, saldo: 7000 }],
    formasPagamentoOpcoes: [{ valor: 'pix', curto: 'Pix' }, { valor: 'dinheiro', curto: 'Dinheiro' }],
    fmtBRL: (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ','),
  };
  const arq = path.join(VIEWS, 'painel/caixa.ejs');
  return ejs.render(fs.readFileSync(arq, 'utf8'), { ...base, ...extra }, { filename: arq });
}
test('F6 Caixa: saldo no objeto, Lançar e Fechar caixa só com caixa_lancar, excluir só com permissão', () => {
  const html = caixaHtml();
  assert.match(html, /Saldo de hoje/);
  assert.match(html, /<span class="int">1\.842<\/span><span class="cent">,50<\/span>/);
  assert.match(html, /2 lançamentos[\s\S]*1 lançamento/);
  assert.match(html, /href="\/painel\/caixa\/fechar"/);
  assert.match(html, /id="cx-folha-novo" role="dialog"/);
  assert.match(html, /action="\/painel\/caixa\/7\/remover"/);
  const so = caixaHtml({ podeLancarCaixa: false, podeRemoverCaixa: false });
  assert.doesNotMatch(so, /cx-folha-novo|caixa\/fechar|\/remover/);
  assert.doesNotMatch(html, /sv-cx-|pill-opcao/);
});
test('F6 Fechar caixa: conferência da gaveta com o esperado; dia já fechado mostra o registro e "Fechar de novo"', () => {
  const arq = path.join(VIEWS, 'painel/caixa-fechar.ejs');
  const resumo = { entradas: 210650, saidas: 26400, saldo: 184250, porForma: { pix: 109600, credito: 0, debito: 65250, dinheiro: 35800, sem_forma: 0 }, saidasDinheiro: 8400, aReceber: { quantidade: 0, valor: 0 }, fechamento: null };
  const r = (res) => ejs.render(fs.readFileSync(arq, 'utf8'), { resumo: res, dataLonga: 'Sexta, 9 de outubro', fmtBRL: (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ',') }, { filename: arq });
  const aberto = r(resumo);
  assert.match(aberto, /data-base="27400"/, 'dinheiro 358,00 menos 84,00 de saídas em dinheiro');
  assert.match(aberto, /Esperado: R\$ 274,00/);
  assert.doesNotMatch(aberto, /Crédito/, 'forma zerada não aparece');
  assert.match(aberto, /Fechar o caixa de hoje<\/button>/);
  const fechado = r({ ...resumo, fechamento: { fechadoEm: new Date(2026, 9, 9, 19, 42), fechadoPorNome: 'Ana Admin', entradas: 210650, saidas: 26400, saldo: 184250, dinheiroEsperado: 27400, dinheiroContado: 27000, diferenca: -400, vezes: 1 } });
  assert.match(fechado, /Caixa fechado às 19:42/);
  assert.match(fechado, /Faltaram R\$ 4,00 na gaveta\. Por Ana/);
  assert.match(fechado, /cv-logo-c/);
  assert.match(fechado, /id="cx-refazer"/);
  assert.match(fechado, /data-refazer="1"/);
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(rotas, /router\.get\('\/caixa\/fechar', exige\('caixa_lancar'\)/);
  const js = fs.readFileSync(path.join(RAIZ, 'public/js/cv-caixa.js'), 'utf8');
  assert.ok(js.includes("fetch('/painel/api/caixa/fechar'"));
  assert.ok(js.includes("C.selo({ botao: btn, processando:"));
});

// ---------- F8: Secretária, Meu plano e Perfil ----------
function sec(extra = {}) {
  const arq = path.join(VIEWS, 'painel/secretaria-config.ejs');
  const base = {
    ehDono: false, iaPausada: false, whatsapp: { conectado: true, numero: '+55 11 98765-4321' }, numeroCortavo: { disponivel: true, nomeSugerido: 'Vila Rosa' },
    cfg: { modo: 'cortavo', link: '', regras: '', tetoMes: '', copilotoTetoMes: '', privacidadeLink: '', lembretesAtivos: false, lembreteTemplate: 'x', lembreteAntecedencia: '60' },
    planoCortavo: { tetos: { secretaria: 800 } }, suporteCortavo: 'cortavo.app@gmail.com',
  };
  return ejs.render(fs.readFileSync(arq, 'utf8'), { ...base, ...extra }, { filename: arq });
}
test('F8 Secretária: estado no topo, Zona de risco com DESCONECTAR, sem emoji', () => {
  const on = sec();
  assert.match(on, /data-estado="on"><i aria-hidden="true"><\/i>Atendendo agora/);
  assert.match(on, /WhatsApp final 4321/);
  assert.match(on, /Zona de risco[\s\S]*name="confirmacao"[\s\S]*cv-btn--perigo/);
  assert.match(sec({ iaPausada: true }), />Pausada[\s\S]*Reativar IA/);
  const fora = sec({ planoCortavo: { tetos: { secretaria: 0 } } });
  assert.match(fora, /Fora do plano/);
  assert.doesNotMatch(fora, /Reativar IA<\/button>/);
  const desconectado = sec({ whatsapp: { conectado: false } });
  assert.match(desconectado, /id="svNumPasso1"/);
  assert.doesNotMatch(desconectado, /Zona de risco/);
  for (const h of [on, desconectado]) assert.doesNotMatch(h, /[\u{1F300}-\u{1FAFF}✅⏸]/u, 'sem emoji');
});
test('F8 Perfil: foto, jornada (campos do controller), avisos e backup com os IDs de antes', () => {
  const arq = path.join(VIEWS, 'painel/perfil.ejs');
  const html = ejs.render(fs.readFileSync(arq, 'utf8'), {
    ehDono: false, ehAdmin: true, usuario: { nome: 'Rafael Moreira', papel: 'admin', barbeariaId: 1 }, usuarioFotoUrl: null, barbeariaAtual: { nome: 'Vila Rosa' },
    atendimentos: 312, horarioTrabalho: 'Seg a sáb', planoCortavo: { nome: 'Barbearia' }, semana: { horas: '60h', dias: 6, linha: '6 dias · 10h por dia' },
    jornada: [{ dia: 1, label: 'Seg', trabalha: true, horaInicio: '09:00', horaFim: '19:00' }, { dia: 0, label: 'Dom', trabalha: false, horaInicio: '09:00', horaFim: '19:00' }],
  }, { filename: arq });
  for (const id of ['pf-avisos', 'pf-avisos-ligar', 'pf-backup', 'pf-jornada', 'pf-conta-dias', 'pf-hora-1', 'pf-hora-0']) assert.match(html, new RegExp('id="' + id + '"'), id);
  for (const n of ['trabalha_1', 'inicio_1', 'fim_0', 'retorno']) assert.match(html, new RegExp('name="' + n + '"'), n);
  assert.match(html, /action="\/painel\/perfil\/foto"/);
  assert.match(html, /action="\/logout"/);
  assert.match(html, /class="cv-linha cv-pf-hora folga" id="pf-hora-0"/);
});

// ---------- F10: painel-mestre ----------
test('F10 mestre: Visão geral com os números do visaoGeralMestre, atenção com link para a ficha e endereço por subdomínio', async () => {
  const body = await render('mestre/painel.ejs', {
    backup: { situacao: 'nunca' }, filtros: { q: '', status: 'todas' }, total: 1, paginacao: { pagina: 1, totalPaginas: 1 },
    planoDe: () => ({ nome: 'Barbearia' }), avisoBarbeiros: () => null, testesAtivos: [], vagasFundador: { usadas: 1, total: 5, livres: 4 },
    barbearias: [{ id: 4, nome: 'Andrade', slug: 'andrade', ativo: true, situacaoCortavo: 'ativa', _count: { usuarios: 2, clientes: 3, agendamentos: 4 } }],
    visao: { numeros: { ativas: 1, emTeste: 0, pausadas: 0, inativas: 0, receitaEstimada: 24900, semPrecoDefinido: 0, custoTotal: 1000, margemPct: 96 },
      precisaDeAtencao: [{ barbeariaId: 4, nome: 'Andrade', tipo: 'teste_terminando', gravidade: 'media', texto: 'Teste termina hoje.' }] },
  });
  assert.match(body, /Receita mensal estimada[\s\S]*<span class="int">249<\/span><span class="cent">,00<\/span>/);
  assert.match(body, /href="\/mestre\/barbearias\/4#teste">Ver ficha/);
  assert.match(body, /andrade\.cortavo\.com\.br/);
  assert.match(body, /action="\/mestre\/entrar\/4"/);
  const lay = await ejs.renderFile(path.join(VIEWS, 'layouts/mestre.ejs'), { body, assetV: 'x', usuario: { nome: 'Kalany' }, currentPath: '/mestre/uso', flash: null });
  assert.match(lay, /href="\/mestre\/uso" aria-current="page"/);
  assert.match(lay, /class="cv-navbar m-nav-cel"/);
  assert.doesNotMatch(lay, />CORTAVO</);
});

test('F10 mestre: ficha em abas com Zona de risco, popover E/P na lista e nada da pilha antiga', async () => {
  const det = fs.readFileSync(path.join(VIEWS, 'mestre/barbearia-detalhe.ejs'), 'utf8');
  for (const a of ['resumo', 'dados', 'marca', 'equipe', 'risco']) assert.match(det, new RegExp('id="aba-' + a + '"'), a);
  assert.match(det, /\/ativa"/);
  assert.match(det, /\/remover"/);
  const lista = fs.readFileSync(path.join(VIEWS, 'mestre/painel.ejs'), 'utf8');
  assert.match(lista, /Entrar como dono<kbd>E<\/kbd>/);
  assert.match(lista, /Trocar plano<kbd>P<\/kbd>/);
  for (const f of fs.readdirSync(path.join(VIEWS, 'mestre'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(VIEWS, 'mestre', f), 'utf8'), /class="(card|btn |tabela|campo)\b/, f);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(VIEWS, 'layouts/mestre.ejs'), 'utf8'), /sv-mestre/);
});
