// Telas de cadastro e configuração migradas para o v3 (uma fatia por tela).
// Renderiza as views reais com dados fictícios: sem banco, sem .env, sem app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { RAIZ } = require('./helpers/ambiente');

const VIEWS = path.join(RAIZ, 'src/views');
const render = (v, d) => ejs.renderFile(path.join(VIEWS, v), d);
const comuns = { fmtT6: (c) => 'R$' + Math.round(c / 100), fmtBRL: (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ','), fmtData: () => '02/10/2026', fmtTelefone: () => '(51) 98765-4321', ehAdmin: true, assetV: 'x' };
const layout = fs.readFileSync(path.join(VIEWS, 'layouts/painel.ejs'), 'utf8');
const SEM_ANTIGO = /class="sv-|class="btn |class="card|tema-minimal|#2f6bff|#7f92cf/;

function v3(caminho) {
  const lista = /var TELAS_V3 = \[([^\]]*)\]/.exec(layout)[1];
  const cad = /var CAD_V3 = \[([^\]]*)\]/.exec(layout)[1];
  assert.ok(lista.includes("'" + caminho + "'"), caminho + ' em TELAS_V3');
  assert.ok(cad.includes("'" + caminho + "'"), caminho + ' em CAD_V3');
}

test('Clientes v3: objeto com os 3 números, busca e filtros, lista no celular e tabela no PC, ficha em folha', async () => {
  v3('/painel/clientes');
  const c = { id: 7, nome: 'Lucas <b>Andrade</b>', telefone: '51987654321', iniciais: 'LA', selosFidelidade: 2, aniversarianteMes: true, nascimentoIso: '', observacoes: '',
    stats: { totalGasto: 123450, visitas: 9, frequenciaDias: 21, sumido: true, servicoFavorito: 'Corte', barbeiroFavorito: 'Diego', ultimaVisitaLabel: 'há 40 dias' }, agendamentos: [], assinaturas: [] };
  const html = await render('painel/clientes.ejs', { ...comuns, clientes: [c], planosDisponiveis: [], resumo: { total: 1, sumidos: 1, aniversariantes: 1 }, hojeIso: '2026-10-09' });
  assert.doesNotMatch(html, SEM_ANTIGO);
  assert.equal((html.match(/class="cv-objeto/g) || []).length, 2, 'um objeto na tela e um na ficha');
  assert.match(html, /data-busca="cl"/);
  assert.match(html, /data-filtros="sumido aniversario"/);
  assert.match(html, /<div class="cv-tabela" data-lista="cl">/);
  assert.match(html, /<span class="moeda" aria-hidden="true">R\$<\/span><span class="int" aria-hidden="true">1\.234<\/span><span class="cent" aria-hidden="true">,50<\/span>/);
  assert.match(html, /Lucas &lt;b&gt;Andrade&lt;\/b&gt;/);
  assert.match(html, /id="cl-folha-7" data-folha role="dialog" aria-modal="true"/);
  assert.match(html, /action="\/painel\/clientes\/7\/remover" data-confirmar=/);
  assert.match(html, /function clAbrirFolha\(/);
});

test('Equipe v3: segmento, lista, ficha em folha com o objeto do mês, foto, acessos e mesmas rotas', async () => {
  v3('/painel/equipe');
  const m = { id: 3, nome: 'Diego Santos', papel: 'funcionario', ativo: true, iniciais: 'DS', comissaoPercentual: 40, jornadaLabel: 'Seg a sáb', nomePublico: '', descricao: '', fotoUrl: null, fotoPos: null, bloqueados: new Set(['caixa']),
    stats: { ocupacaoPct: 61, faturado: 503820, atendimentos: 61, ticketMedio: 8259, comissaoReceber: 193062, clientesAtendidos: 48, taxaRetorno: 62, servicoTop: 'Corte', produtosVendidos: 7 } };
  const html = await render('painel/equipe.ejs', { ...comuns, membros: [m], historico: [], aba: 'equipe', modulosAcesso: [{ chave: 'clientes', rotulo: 'Clientes' }, { chave: 'caixa', rotulo: 'Caixa' }] });
  assert.doesNotMatch(html, SEM_ANTIGO);
  assert.equal((html.match(/class="cv-objeto/g) || []).length, 1);
  assert.match(html, /role="tablist"/);
  assert.match(html, /<form method="POST" enctype="multipart\/form-data" action="\/painel\/equipe\/3">/);
  assert.match(html, /name="acesso_clientes" value="1" checked/);
  assert.match(html, /name="acesso_caixa" value="1" \/>/);
  assert.match(html, /name="fotoPos"/);
  assert.match(html, /action="\/painel\/equipe\/3\/toggle"/);
  assert.match(html, /<form method="POST" action="\/painel\/equipe">/);
});
