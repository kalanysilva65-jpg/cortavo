// Comissões v3 (F7): "Minha comissão" do barbeiro e a lista do admin com a
// baixa (B5 do Beto). Banco em memória; sem banco real, sem .env, sem app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoGestao } = require('./helpers/dadosGestao');
const ejs = require(require.resolve('ejs', { paths: [RAIZ] }));

const fmtBRL = (c) => 'R$ ' + ((c || 0) / 100).toFixed(2).replace('.', ',');
function grupo(id, nome, extra = {}) {
  return {
    barbeiro: { id, nome, fotoUrl: null, comissaoPercentual: 40 }, servicosTotal: 190240, produtosTotal: 28220, qtd: 61,
    comissaoServicos: 76096, comissaoProdutos: 2822, produtoPct: 10, comissao: 78918, faturadoTotal: 218460, ticketMedio: 3581, ocupacaoPct: 71,
    atendimentos: [{ ag: { clienteNome: 'Lucas Andrade', horaInicio: '14:30' }, itens: [{ nome: 'Corte' }], servicosSub: 4000, produtosSub: 0 }], ...extra,
  };
}
function render(extra) {
  const arq = path.join(RAIZ, 'src/views/painel/comissoes.ejs');
  const base = {
    ehAdmin: false, grupos: [grupo(2, 'Bruno Barbeiro')], barbeiros: [], barbeiroSelecionado: '2', inicioStr: '2026-10-01', fimStr: '2026-10-31', periodoAtivo: 'mes',
    totalServicos: 190240, totalProdutos: 28220, totalGeralComissao: 78918, comissaoProdutoPct: 10, nomePeriodo: 'Este mês',
    presetHoje: { inicio: 'a', fim: 'a' }, presetSemana: { inicio: 'b', fim: 'b' }, presetMes: { inicio: '2026-10-01', fim: '2026-10-31' },
    situacoes: {}, pagamentosComissao: [], fmtBRL,
  };
  return ejs.render(fs.readFileSync(arq, 'utf8'), { ...base, ...extra }, { filename: arq });
}

test('F7 Minha comissão (barbeiro): objeto com o valor, de onde veio e pagamentos com o C com check', () => {
  const html = render({ situacoes: { 2: { pago: 50000, aPagar: 28918, situacao: 'parcial' } }, pagamentosComissao: [{ id: 1, usuarioId: 2, de: '2026-10-01', ate: '2026-10-15', valor: 50000, pagoEm: '2026-10-16T12:00:00Z' }] });
  assert.match(html, /<h1>Minha comissão<\/h1>/);
  assert.match(html, /<span class="int">789<\/span><span class="cent">,18<\/span>/);
  assert.match(html, /40% nos serviços e 10% nos produtos/);
  assert.match(html, /cv-logo-c[\s\S]*?Pago[\s\S]*?R\$ 500,00/);
  assert.match(html, /Em aberto: R\$ 289,18/);
  assert.doesNotMatch(html, /data-baixa|Marcar como pago|percentual|cm-barbeiro/, 'barbeiro não dá baixa nem edita %');
});

test('F7 Comissões (admin): lista com a situação, folha com % , foto, "Marcar como pago" e Desfazer', () => {
  const html = render({
    ehAdmin: true, barbeiroSelecionado: 'todos', barbeiros: [{ id: 2, nome: 'Bruno Barbeiro' }, { id: 3, nome: 'Caio Barbeiro' }],
    grupos: [grupo(2, 'Bruno Barbeiro'), grupo(3, 'Caio Barbeiro', { comissao: 10000 })],
    situacoes: { 2: { pago: 78918, aPagar: 0, situacao: 'paga' }, 3: { pago: 0, aPagar: 10000, situacao: 'aberta' } },
    pagamentosComissao: [{ id: 9, usuarioId: 2, de: '2026-10-01', ate: '2026-10-31', valor: 78918, pagoEm: '2026-10-31T12:00:00Z', pagoPorNome: 'Ana Admin' }],
  });
  assert.match(html, /<h1>Comissões<\/h1>/);
  assert.match(html, /onclick="cmAbrir\(2\)"[\s\S]*?cv-etiqueta cv-etiqueta--preta">Paga/);
  assert.match(html, /onclick="cmAbrir\(3\)"[\s\S]*?Em aberto/);
  assert.match(html, /id="cm-folha-3" role="dialog"[\s\S]*?data-baixa="3" data-de="2026-10-01" data-ate="2026-10-31"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="cm-folha-2"'), html.indexOf('id="cm-folha-3"')), /data-baixa=/, 'paga: sem botão de baixa');
  assert.match(html, /data-desfazer-baixa="9"/);
  assert.match(html, /action="\/painel\/comissoes\/percentual\/3"/);
  assert.match(html, /action="\/painel\/comissoes\/3\/foto"/);
  const js = fs.readFileSync(path.join(RAIZ, 'public/js/cv-comissoes.js'), 'utf8');
  assert.ok(js.includes("postar('/painel/api/gestao/comissoes/baixa'"));
  assert.ok(js.includes("C.selo({ botao: b, titulo: 'Comissão paga'"));
});

test('F7 controller: situação e histórico vêm do B5, com o mesmo recorte do barbeiro', async () => {
  const banco = bancoGestao();
  const metricas = carregar('src/services/metricas.js', { prisma: banco });
  metricas.limparCache();
  const ctrl = require('../src/controllers/comissaoController.js');
  const permissoes = require('../src/services/permissoes.js');
  const pc = require('../src/services/planoCortavo.js');
  const perm = permissoes.contexto({ id: 2, papel: 'funcionario' }, { acessosBloqueados: null }, pc.PLANOS.barbearia);
  const res = resFalso();
  await ctrl.ver(reqFalso({ barbeariaId: 1, ehAdmin: false, permissoes: perm, query: {}, session: { usuario: { id: 2, nome: 'Bruno Barbeiro', papel: 'funcionario' } } }), res);
  const d = res.renderizou.dados;
  assert.equal(res.renderizou.view, 'painel/comissoes');
  assert.deepEqual(Object.keys(d.situacoes).map(Number).filter((id) => id !== 2), [], 'só a situação dele');
  assert.ok(Array.isArray(d.pagamentosComissao));
  assert.ok(d.nomePeriodo);
});
