// Início "Painel vivo" ligada ao B6 de verdade: a resposta de
// services/home.montarHome (banco em memória do Beto) renderizada pela view
// da v3. Sem banco real, sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar } = require('./helpers/ambiente');
const { bancoGestao } = require('./helpers/dadosGestao');
const ejs = require(require.resolve('ejs', { paths: [RAIZ] }));

function ambiente() {
  const banco = bancoGestao();
  const metricas = carregar('src/services/metricas.js', { prisma: banco });
  metricas.limparCache();
  const home = require('../src/services/home.js');
  home._cacheHome.clear();
  return { banco, home, permissoes: require('../src/services/permissoes.js'), planoCortavo: require('../src/services/planoCortavo.js') };
}
const perm = (amb, { id = 1, papel = 'admin', plano = 'barbearia' } = {}) => amb.permissoes.contexto({ id, papel }, { acessosBloqueados: null }, amb.planoCortavo.PLANOS[plano]);

function renderInicio(home, extra = {}) {
  const arq = path.join(RAIZ, 'src/views/painel/dashboard.ejs');
  const base = {
    ehAdmin: true, usuarioFotoUrl: null, iniciaisUsuario: 'AA', dataLonga: 'sexta, 9 de outubro', faixaTeste: null,
    totalHoje: 3, concluidosHoje: 2, restantesHoje: 1, ganhoHoje: 9000, previstoHoje: 15000, ocupacaoHoje: 40,
    proximoCorte: null, maisHoje: 0, atualizadoAs: '14:20', estoqueBaixo: { tem: false }, metasHome: [], home,
  };
  return ejs.render(fs.readFileSync(arq, 'utf8'), { ...base, ...extra }, { filename: arq });
}

test('Início + B6 (admin): anéis vêm do home, faturamento contra a meta do mês, destaques do B6', async () => {
  const amb = ambiente();
  amb.banco._tabelas.estoque.push({ id: 1, barbeariaId: 1, nome: 'Pomada', quantidade: 1, quantidadeMinima: 3 });
  const h = await amb.home.montarHome({ barbeariaId: 1, permissoes: perm(amb), faixaTeste: null });
  const html = renderInicio(h);
  assert.equal((html.match(/class="arco"/g) || []).length, 3);
  assert.match(html, /Meta do mês/, 'há meta de faturamento no banco de teste');
  assert.match(html, /Estoque baixo: Pomada/);
  assert.doesNotMatch(html, /TODO/);
});

test('Início + B6 (barbeiro básico): comissão entra só na legenda, sem anel nem buraco', async () => {
  const amb = ambiente();
  const h = await amb.home.montarHome({ barbeariaId: 1, permissoes: perm(amb, { id: 2, papel: 'funcionario' }), faixaTeste: null });
  assert.ok(h.aneis.some((a) => a.chave === 'comissao'));
  const html = renderInicio(h, { ehAdmin: false });
  assert.match(html, /Sua comissão no mês/);
  assert.equal((html.match(/class="arco"/g) || []).length, h.aneis.filter((a) => a.chave !== 'comissao').length);
  assert.doesNotMatch(html, /Meta do mês<\/span>/);
});

test('Início + B6: sem meta, faturamento contra o previsto do dia; horas livres viram o histograma', () => {
  const home = {
    aneis: [{ chave: 'faturamento', hoje: 9000, mes: 50000, meta: null }, { chave: 'atendimentos', concluidos: 2, total: 3 }, { chave: 'ocupacao', pct: 40 }],
    horasLivres: { livresMin: 150, histograma: [{ hora: '15h', livresMin: 0, jornadaMin: 60 }, { hora: '16h', livresMin: 30, jornadaMin: 60 }, { hora: '17h', livresMin: 60, jornadaMin: 60 }, { hora: '18h', livresMin: 60, jornadaMin: 60 }, { hora: '19h', livresMin: 0, jornadaMin: 0 }] },
    destaques: [{ tipo: 'horario_vago', hora: '17h', livresMin: 60 }, { tipo: 'cliente_sumido', total: 4, dias: 45 }],
  };
  const html = renderInicio(home);
  assert.match(html, /Faturamento/);
  assert.match(html, /<span class="de" aria-hidden="true">\/150<\/span>/);
  assert.match(html, /Horas livres hoje/);
  assert.equal((html.match(/class="h[ "]/g) || []).length, 5);
  assert.match(html, /class="h bloq/, 'hora sem jornada entra listrada');
  assert.match(html, /5 <\/span>|>5<\/span>/);
  assert.match(html, /entre 16h e 19h/);
  assert.match(html, /Horário vago às 17h/);
  assert.match(html, /4 clientes não vêm há mais de 45 dias/);
});

test('Início: dashboardController chama o B6 e, se ele falhar, segue sem quebrar', () => {
  const ctrl = fs.readFileSync(path.join(RAIZ, 'src/controllers/dashboardController.js'), 'utf8');
  assert.match(ctrl, /homeServ\.montarHome\(\{ barbeariaId: b, permissoes: req\.permissoes/);
  assert.match(ctrl, /catch \(e\) \{\s*console\.error\('\[inicio\] montarHome falhou/);
});
