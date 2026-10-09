// Gestão v3 ligada ao B4: services/gestaoTela.montarGestao lê os cartões de
// services/metricas.js (banco em memória do Beto) e a view desenha.
// Sem banco real, sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar } = require('./helpers/ambiente');
const { bancoGestao } = require('./helpers/dadosGestao');
const ejs = require(require.resolve('ejs', { paths: [RAIZ] }));

const TODAS = ['horarios', 'clientes', 'clientes_contato', 'servicos', 'produtos', 'planos', 'estoque', 'comissoes', 'meus_numeros', 'numeros_barbearia', 'ranking_equipe', 'caixa_ver', 'caixa_lancar', 'conversas', 'ia'];
function ambiente() {
  const banco = bancoGestao();
  const metricas = carregar('src/services/metricas.js', { prisma: banco });
  metricas.limparCache();
  return {
    tela: require('../src/services/gestaoTela.js'),
    permissoes: require('../src/services/permissoes.js'),
    planoCortavo: require('../src/services/planoCortavo.js'),
  };
}
const perm = (amb, { id = 1, papel = 'admin', gravado = null, plano = 'barbearia' } = {}) => amb.permissoes.contexto({ id, papel }, { acessosBloqueados: gravado }, amb.planoCortavo.PLANOS[plano]);

function renderGestao(gestao, extra = {}) {
  const arq = path.join(RAIZ, 'src/views/painel/gestao.ejs');
  const base = {
    ehAdmin: true, foraDoPlano: () => null, podeAcessar: () => true, barbeariaAtual: { nome: 'Barbearia Teste' }, periodo: 'semana', gestao,
  };
  return ejs.render(fs.readFileSync(arq, 'utf8'), { ...base, ...extra }, { filename: arq });
}

test('Gestão + B4 (admin): faturamento com barras e eixo, ticket, atendimentos, equipe, pagamentos e caixa de hoje', async () => {
  const amb = ambiente();
  const g = await amb.tela.montarGestao({ barbeariaId: 1, permissoes: perm(amb), query: { periodo: 'semana' } });
  assert.ok(g, 'admin tem números');
  assert.equal(g.rotulo, 'Esta semana');
  assert.equal(g.comparacao, 'vs. semana passada');
  assert.equal(g.faturamento.serie.length, 7);
  assert.deepEqual(g.faturamento.eixo, ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']);
  for (const k of ['ocupacao', 'ticket', 'atendimentos']) assert.ok(g[k], k);
  assert.ok(Array.isArray(g.equipe) && g.equipe.length >= 2, 'admin vê a equipe');
  assert.ok(g.caixaHoje && typeof g.caixaHoje.saldo === 'number');
  const html = renderGestao(g);
  assert.match(html, /class="cv-periodo"/);
  assert.match(html, /Desempenho da equipe/);
  assert.equal((html.match(/class="col"/g) || []).length, 7);
});

test('Gestão + B4 (barbeiro básico): só os números dele, sem equipe nem caixa', async () => {
  const amb = ambiente();
  const g = await amb.tela.montarGestao({ barbeariaId: 1, permissoes: perm(amb, { id: 2, papel: 'funcionario' }), query: { periodo: 'mes' } });
  assert.ok(g, 'meus_numeros é liberado por padrão');
  assert.equal(g.equipe, undefined);
  assert.equal(g.caixaHoje, undefined);
  assert.equal(g.lucro, undefined);
});

test('Gestão + B4 (só agenda): sem número de dinheiro, null (a tela mostra o estado vazio da spec 12)', async () => {
  const amb = ambiente();
  const g = await amb.tela.montarGestao({ barbeariaId: 1, permissoes: perm(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, bloqueados: TODAS }) }) });
  assert.equal(g, null);
});

test('Gestão + B4 (admin no Essencial): o que é do plano Relatórios não entra nos números', async () => {
  const amb = ambiente();
  const g = await amb.tela.montarGestao({ barbeariaId: 1, permissoes: perm(amb, { plano: 'essencial' }), query: { periodo: 'mes' } });
  assert.ok(g && g.faturamento);
  for (const k of ['ticket', 'equipe', 'servicos', 'clientes', 'lucro']) assert.equal(g[k], undefined, k);
});

test('Gestão: rótulos do eixo no máximo 7 e por mês no ano', () => {
  const { eixoDe } = require('../src/services/gestaoTela.js');
  const mes = Array.from({ length: 31 }, (_, i) => ({ chave: '2026-10-' + String(i + 1).padStart(2, '0') }));
  assert.ok(eixoDe(mes, 'dia').filter(Boolean).length <= 8);
  assert.deepEqual(eixoDe([{ chave: '2026-01' }, { chave: '2026-02' }], 'mes'), ['Jan', 'Fev']);
});
