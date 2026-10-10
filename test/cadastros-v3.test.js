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
  assert.match(html, /name="acesso_caixa" value="1"\s+\/>/);
  assert.match(html, /name="fotoPos"/);
  assert.match(html, /action="\/painel\/equipe\/3\/toggle"/);
  assert.match(html, /<form method="POST" action="\/painel\/equipe">/);
});

test('Serviços e produtos v3: uma peça, segmento, foto opcional com miniatura, edição em folha e mesmas rotas', async () => {
  v3('/painel/servicos'); v3('/painel/produtos');
  const s = { id: 4, nome: 'Corte', valor: 4590, duracaoMin: 40, ativo: true, fotoUrl: '/u/g.jpg', fotoMiniUrl: '/u/m.jpg', categoriaId: 1, descricao: '', ehEncaixe: false, comissaoPercentual: 10, vendidosMes: 3 };
  const d = { ...comuns, servicos: [s, { ...s, id: 5, fotoUrl: null, fotoMiniUrl: null }], produtos: [s], categorias: [{ id: 1, nome: 'Cortes', _count: { servicos: 1 } }], estoqueItens: [{ id: 9, nome: 'Lâmina' }], insumosPorServico: { 4: { 9: 2 } }, resumoMes: { receita: 1000, unidades: 1, itens: 1 } };
  const sv = await render('painel/servicos.ejs', d);
  assert.doesNotMatch(sv, SEM_ANTIGO);
  assert.match(sv, /<a href="\/painel\/servicos" aria-pressed="true" aria-current="page">Serviços<\/a>/);
  assert.match(sv, /1 de 2 serviços com foto/);
  assert.match(sv, /<img src="\/u\/m\.jpg" alt="" loading="lazy" \/>/);
  assert.match(sv, /R\$ 45,90, sem foto|R\$ 45,90<\/span>/);
  assert.match(sv, /action="\/painel\/servicos\/4" *>|enctype="multipart\/form-data" action="\/painel\/servicos\/4">/);
  assert.match(sv, /name="foto" type="file" accept="image\/\*" data-foto-mini/);
  assert.match(sv, /name="insumo_9"[^>]*value="2"/);
  assert.match(sv, /name="ehEncaixe"/);
  const pr = await render('painel/produtos.ejs', d);
  assert.match(pr, /name="ehProduto" value="on"/);
  assert.match(pr, /name="comissaoPercentual"/);
  assert.equal((pr.match(/class="cv-objeto cv-gravada" aria-label="Vendido no mês"/g) || []).length, 1);
  assert.doesNotMatch(pr, /data-foto-mini/);
});

test('Estoque v3: objeto do gasto, "para repor" listrado, lista, folhas e o formulário avulso também no v3', async () => {
  v3('/painel/estoque');
  const i = { id: 2, nome: 'Lâmina', quantidade: 3, quantidadeMinima: 10, valorGasto: 4500, categoriaId: null, categoria: null };
  const html = await render('painel/estoque.ejs', { ...comuns, itens: [i], categorias: [{ id: 1, nome: 'Descartáveis' }], baixoEstoque: [i], resumo: { valorGasto: 84790, unidades: 3, itens: 1 } });
  assert.doesNotMatch(html, SEM_ANTIGO);
  assert.equal((html.match(/class="cv-objeto/g) || []).length, 1);
  assert.match(html, /1 para repor/);
  assert.match(html, /cv-etq--listra">repor/);
  assert.match(html, /action="\/painel\/estoque\/2"/);
  assert.match(html, /action="\/painel\/estoque\/2\/remover" class="cv-folha-acoes" data-confirmar/);
  const f = await render('painel/estoque-form.ejs', { item: i, categorias: [] });
  assert.doesNotMatch(f, SEM_ANTIGO);
  assert.match(f, /action="\/painel\/estoque\/2"/);
  assert.match(layout, /AVULSOS_V3 = /);
});

test('Planos v3: objeto com a receita (admin) ou o volume (barbeiro, sem R$), chips sem verde/vermelho e mesmas rotas', async () => {
  v3('/painel/planos');
  const p = { id: 1, nome: 'Clube', valor: 9900, tipo: 'limitado', usos: 2, diasSemana: '1,2', validadeDias: 30, ativo: true, assinantes: 3, mrr: 29700, servicos: [{ servicoId: 5, usos: 2, servico: { nome: 'Corte' } }] };
  const d = { ...comuns, planos: [p], servicos: [{ id: 5, nome: 'Corte' }], resumo: { mrr: 29700, assinantes: 3, ticket: 9900, ativos: 1, lider: null } };
  const adm = await render('painel/planos.ejs', d);
  assert.doesNotMatch(adm, SEM_ANTIGO);
  assert.doesNotMatch(adm, /verde|vermelho/);
  assert.match(adm, /Receita recorrente por mês/);
  assert.match(adm, /name="diasSemana" value="1,2" data-dias/);
  assert.match(adm, /name="usosServ_5" value="2"/);
  assert.match(adm, /action="\/painel\/planos\/1\/remover" data-confirmar=/);
  const barb = await render('painel/planos.ejs', { ...d, ehAdmin: false });
  assert.doesNotMatch(barb, /Receita|R\$ 297,00/);
  assert.doesNotMatch(barb, /data-abrir-folha="pl-folha/);
});

test('Metas v3: a primeira no objeto com anel, as outras com barra, nova em folha e mesmas rotas', async () => {
  v3('/painel/metas');
  const html = await render('painel/metas.ejs', { ...comuns, mesLabel: 'Outubro', barbeiros: [], metricas: { faturamento: { label: 'Faturamento', dinheiro: true, porBarbeiro: true } },
    itens: [{ id: 1, label: 'Faturamento', escopo: 'Barbearia', dinheiro: true, atual: 1980000, alvo: 3000000, pct: 66 }, { id: 2, label: 'Atendimentos', escopo: 'Diego', dinheiro: false, atual: 61, alvo: 80, pct: 76 }] });
  assert.doesNotMatch(html, SEM_ANTIGO);
  assert.equal((html.match(/class="cv-objeto/g) || []).length, 1);
  assert.match(html, /stroke-dashoffset:34/);
  assert.match(html, /role="progressbar" aria-valuenow="76"/);
  assert.match(html, /<form method="POST" action="\/painel\/metas">/);
  assert.match(html, /action="\/painel\/metas\/2\/remover" data-confirmar/);
});

test('Logo e aparência v3 (Dani, link.html#aparencia): prévia, posição, tamanho e excluir com confirmação', async () => {
  v3('/painel/logo');
  const html = await render('painel/logo.ejs', { ...comuns, barbeariaAtual: { nome: 'Barbearia Vila Rosa' }, marca: { logoUrl: '/u/l.png', logoAlinhamento: 'direita', logoTamanho: 140 } });
  assert.doesNotMatch(html, SEM_ANTIGO);
  assert.match(html, /<form class="lk-ap" method="POST" action="\/painel\/logo" enctype="multipart\/form-data"/);
  assert.match(html, /name="alinhamento" id="lk-ap-alinh" value="direita"/);
  assert.match(html, /name="tamanho" min="80" max="240" step="4" value="140"/);
  assert.match(html, /action="\/painel\/logo\/remover" data-confirmar="Excluir a logo\?/);
  assert.ok(!/semNav = \[[^\]]*'\/painel\/logo'/.test(layout), 'navbar fixa também em Logo');
});

test('Horários v3: janela em chips, jornada e bloqueio em folha, mesmas rotas e campos', async () => {
  v3('/painel/horarios');
  const html = await render('painel/horarios.ejs', { ...comuns, ehAdmin: true, janelaAgendamento: 14, DIAS_SEMANA: ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'], barbeiros: [{ id: 2, nome: 'Diego' }],
    barbeirosComJornada: [{ barbeiro: { id: 2, nome: 'Diego' }, resumo: 'x', jornada: [{ diaSemana: 1, trabalha: true, horaInicio: '09:00', horaFim: '19:00' }] }], bloqueios: [{ id: 3, data: new Date(), horaInicio: '12:00', horaFim: '13:00', motivo: '', usuario: { nome: 'Diego' } }] });
  assert.doesNotMatch(html, SEM_ANTIGO);
  assert.match(html, /name="janela" value="14" class="cv-chip" aria-pressed="true"/);
  assert.match(html, /name="trabalha_1"\s+checked/);
  assert.match(html, /id="agm-bloqueio" data-folha/);
  assert.match(html, /action="\/painel\/horarios\/bloqueios\/3\/remover" data-confirmar/);
  assert.match(html, /function abrirModal\(/);
});

test('Fidelidade v3: objeto com 3 números, cupons, ranking com selo e resgate, cupom em folha', async () => {
  v3('/painel/fidelidade');
  const html = await render('painel/fidelidade.ejs', { ...comuns, fidClientesFieisCount: 4, fidCuponsAtivosCount: 1, fidResgatesMes: 2, hojeIso: '2026-10-10',
    cupons: [{ id: 1, nome: 'Aniv', descricao: '', validade: new Date(), desconto: '20%', ativo: true }], fidRanking: [{ id: 9, rank: 1, initials: 'LA', name: "D'Ávila", loyalty: 3 }] });
  assert.doesNotMatch(html, SEM_ANTIGO);
  assert.equal((html.match(/class="cv-objeto/g) || []).length, 1);
  assert.match(html, /action="\/painel\/fidelidade\/clientes\/9\/resgatar" data-confirmar="Resgatar 3 selo\(s\) de D&#39;Ávila\?"/);
  assert.match(html, /action="\/painel\/fidelidade\/clientes\/9\/selo"/);
  assert.match(html, /action="\/painel\/fidelidade\/cupons"/);
});

test('Conversas v3: lista com busca e atualização, conversa com os ids do chat, sem cores do WhatsApp nem emoji', async () => {
  v3('/painel/conversas');
  const lista = await render('painel/conversas.ejs', { ...comuns, aberta: null, iaAtiva: true, tetoAtingido: false, conversas: [{ id: 1, nome: 'Lucas', hora: '14:02', previa: 'Oi', naoLidas: 2, iaAtiva: true }] });
  assert.doesNotMatch(lista, SEM_ANTIGO);
  assert.match(lista, /data-lista="cv"/);
  assert.match(lista, /\/painel\/conversas\/fragmento/);
  const chat = await render('painel/conversas.ejs', { ...comuns, conversas: [], iaAtiva: true, tetoAtingido: false, aberta: { conversa: { id: 5, nome: 'Lucas', telefone: '51', iaAtiva: false, janelaAberta: true }, mensagens: [{ id: 1, texto: '</script><b>' }] } });
  for (const id of ['cv-thread', 'cv-dados', 'cv-form', 'cv-texto', 'cv-mic', 'cv-enviar', 'cv-arquivo', 'cv-janela', 'cv-gravando', 'cv-grav-ok', 'cv-grav-cancel', 'cv-grav-tempo', 'cv-previa', 'cv-prev-corpo', 'cv-prev-enviar', 'cv-prev-fechar', 'cv-prev-legenda', 'cv-prev-nome']) assert.match(chat, new RegExp('id="' + id + '"'), id);
  assert.doesNotMatch(chat, /<\/script><b>/, 'o JSON não fecha a tag');
  assert.match(chat, /Devolver à IA/);
  const css = fs.readFileSync(path.join(RAIZ, 'public/css/cv-conversas.css'), 'utf8');
  assert.doesNotMatch(css, /#(00a884|d9fdd3|efeae2|53bdeb|16a34a|027eb5)/i);
  assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, 'public/js/chat-whatsapp.js'), 'utf8'), /📷|🎥|🎤|📄|📍|👤/u);
});

test('Assistente v3: cabeçalho v3, sugestões sem emoji, mesmos ids e rotas da IA', async () => {
  v3('/painel/ia');
  const html = await render('painel/ia.ejs', { ...comuns, iaAtiva: true, primeiroNome: 'Rafael', conversaKey: 'k', jsonSeguro: (o) => JSON.stringify(o) });
  assert.doesNotMatch(html, /class="sv-/);
  assert.doesNotMatch(html, /👋|📈|🗓|⭐|🕒|👍|✅/u);
  for (const id of ['ia-chat', 'ia-form', 'ia-input', 'ia-enviar', 'ia-mic', 'ia-limpar']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(html, /\/painel\/ia\/mensagem/);
  assert.match(html, /\/painel\/ia\/acao/);
});
