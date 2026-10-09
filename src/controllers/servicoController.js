// Controlador do catálogo de serviços/produtos e suas categorias.
// Alterar é exclusivo do admin (rotas com exigeAdmin). LISTAR é aberto ao
// funcionário: ele precisa do catálogo e dos preços para montar o atendimento.
const prisma = require('../config/db');
const precos = require('../services/precos');
const fs = require('fs');
const { caminhoDoUpload } = require('../config/paths');
const { lerDimensoes } = require('../services/imagemInfo');

// Miniatura quadrada (redesign v3): o navegador recorta e reduz a foto e manda
// em `fotoMini`. Aqui só se aceita o que é, DE FATO, uma imagem quadrada
// pequena: confere os bytes (não a extensão), o tamanho e as dimensões.
// Inválida = apagada; a foto grande continua valendo (a tela usa fotoUrl).
const MINI_MAX_BYTES = 200 * 1024;
const MINI_LADO_MIN = 64;
const MINI_LADO_MAX = 480;
const EXT_DO_FORMATO = { webp: ['.webp'], jpeg: ['.jpg', '.jpeg'], png: ['.png'] };
function miniValida(arquivo) {
  if (!arquivo) return null;
  const url = '/uploads/' + arquivo.filename;
  try {
    const caminho = caminhoDoUpload(url);
    const buf = fs.readFileSync(caminho);
    const info = lerDimensoes(buf);
    const ext = String(require('path').extname(arquivo.filename)).toLowerCase();
    const ok = buf.length <= MINI_MAX_BYTES && info && (EXT_DO_FORMATO[info.formato] || []).includes(ext) &&
      info.largura === info.altura && info.largura >= MINI_LADO_MIN && info.largura <= MINI_LADO_MAX;
    if (ok) return url;
  } catch (_) { /* cai no apagar */ }
  apagarFoto(url);
  return null;
}

// "40.50" / "40" -> 4050 (centavos). Retorna null se inválido.
function reaisParaCentavos(valorStr) {
  const n = parseFloat(String(valorStr).replace(',', '.'));
  if (isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

// Apaga um arquivo de foto do disco (silencioso se não existir).
function apagarFoto(fotoUrl) {
  const caminho = caminhoDoUpload(fotoUrl);
  if (caminho) fs.unlink(caminho, () => {});
}

// POST /painel/servicos/:id/foto/remover — tira a foto de um serviço OU produto (admin).
async function removerFoto(req, res) {
  const s = await prisma.servico.findFirst({ where: { id: Number(req.params.id), barbeariaId: req.barbeariaId } });
  if (!s) return res.redirect('/painel/servicos');
  if (s.fotoUrl) apagarFoto(s.fotoUrl);
  if (s.fotoMiniUrl) apagarFoto(s.fotoMiniUrl); // a miniatura vai junto
  await prisma.servico.update({ where: { id: s.id }, data: { fotoUrl: null, fotoMiniUrl: null } });
  req.session.flash = { tipo: 'sucesso', texto: 'Foto removida.' };
  res.redirect(destino(s.ehProduto));
}

// Serviços e Produtos são telas separadas, mas a mesma tabela/registro por
// trás — o redirect volta para a tela certa conforme o ehProduto do item.
function destino(ehProduto) {
  return ehProduto ? '/painel/produtos' : '/painel/servicos';
}

// GET /painel/servicos — lista só os serviços (ehProduto:false)
async function listar(req, res) {
  const b = req.barbeariaId;
  const servicos = await prisma.servico.findMany({
    where: { barbeariaId: b, ehProduto: false },
    include: { categoria: true },
    orderBy: [{ ativo: 'desc' }, { nome: 'asc' }],
  });
  const categorias = await prisma.categoriaServico.findMany({
    where: { barbeariaId: b },
    orderBy: { nome: 'asc' },
    include: { _count: { select: { servicos: true } } },
  });
  const { estoqueItens, insumosPorServico } = await insumosDaLista(b);
  res.render('painel/servicos', { titulo: 'Serviços', servicos, categorias, estoqueItens, insumosPorServico });
}

// GET /painel/produtos — lista só os produtos (ehProduto:true)
async function listarProdutos(req, res) {
  const b = req.barbeariaId;
  const produtos = await prisma.servico.findMany({
    where: { barbeariaId: b, ehProduto: true },
    include: { categoria: true },
    orderBy: [{ ativo: 'desc' }, { nome: 'asc' }],
  });
  const categorias = await prisma.categoriaServico.findMany({
    where: { barbeariaId: b },
    orderBy: { nome: 'asc' },
    include: { _count: { select: { servicos: true } } },
  });

  // Quanto cada produto vendeu NO MÊS: o design Turno 6 (2026-07-28) abre a
  // tela com "vendido no mês" em manchete e traz o número de vendas dentro de
  // cada faixa. Só conta atendimento concluído — agendado ainda pode furar.
  const agora = new Date();
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const inicioProxMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 1);
  const vendidos = await prisma.agendamentoItem.findMany({
    where: {
      servico: { barbeariaId: b, ehProduto: true },
      agendamento: { barbeariaId: b, status: 'concluido', data: { gte: inicioMes, lt: inicioProxMes } },
    },
    select: { servicoId: true, quantidade: true, valorUnitario: true },
  });

  const porProduto = new Map();
  vendidos.forEach((it) => {
    const acc = porProduto.get(it.servicoId) || { qtd: 0, receita: 0 };
    acc.qtd += it.quantidade;
    acc.receita += it.valorUnitario * it.quantidade;
    porProduto.set(it.servicoId, acc);
  });
  produtos.forEach((p) => {
    const v = porProduto.get(p.id) || { qtd: 0, receita: 0 };
    p.vendidosMes = v.qtd;
    p.receitaMes = v.receita;
  });

  const maisVendido = produtos.reduce((a, p) => (a && a.vendidosMes >= p.vendidosMes ? a : p), null);
  const resumoMes = {
    receita: produtos.reduce((s, p) => s + p.receitaMes, 0),
    unidades: produtos.reduce((s, p) => s + p.vendidosMes, 0),
    itens: produtos.length,
    topNome: maisVendido && maisVendido.vendidosMes > 0 ? maisVendido.nome : null,
    topQtd: maisVendido ? maisVendido.vendidosMes : 0,
  };

  const { estoqueItens, insumosPorServico } = await insumosDaLista(b);
  res.render('painel/produtos', { titulo: 'Produtos', produtos, categorias, resumoMes, estoqueItens, insumosPorServico });
}

// Itens de estoque + a receita de consumo atual (mapa estoqueId -> quantidade)
// para o formulário. A receita vem vazia num serviço novo.
async function dadosInsumos(barbeariaId, servicoId) {
  const estoqueItens = await prisma.estoque.findMany({ where: { barbeariaId }, orderBy: { nome: 'asc' } });
  const insumosMap = {};
  if (servicoId) {
    const insumos = await prisma.servicoInsumo.findMany({ where: { servicoId } });
    for (const i of insumos) insumosMap[i.estoqueId] = i.quantidade;
  }
  return { estoqueItens, insumosMap };
}

// Versão em lote pras telas de lista (Serviços/Produtos): os itens de estoque e
// a receita de CADA serviço, num mapa servicoId -> { estoqueId: quantidade }.
async function insumosDaLista(barbeariaId) {
  const estoqueItens = await prisma.estoque.findMany({ where: { barbeariaId }, orderBy: { nome: 'asc' } });
  const linhas = await prisma.servicoInsumo.findMany({ where: { barbeariaId } });
  const insumosPorServico = {};
  for (const l of linhas) {
    if (!insumosPorServico[l.servicoId]) insumosPorServico[l.servicoId] = {};
    insumosPorServico[l.servicoId][l.estoqueId] = l.quantidade;
  }
  return { estoqueItens, insumosPorServico };
}

// Regrava a receita de consumo do serviço a partir do formulário: cada item de
// estoque vem como `insumo_<id>` (0/vazio = não consome). Recria do zero.
async function salvarInsumos(barbeariaId, servicoId, body) {
  // Só rebaixa a receita se o formulário REALMENTE trouxe a seção de estoque
  // (marcador `insumos_form`). Sem isso, um form sem a seção apagaria a receita
  // sem querer ao salvar — o padrão seguro é não mexer.
  if (!body || !body.insumos_form) return;
  const estoqueItens = await prisma.estoque.findMany({ where: { barbeariaId }, select: { id: true } });
  await prisma.servicoInsumo.deleteMany({ where: { servicoId } });
  const linhas = [];
  for (const e of estoqueItens) {
    const q = parseInt(body['insumo_' + e.id], 10);
    if (Number.isFinite(q) && q > 0) linhas.push({ barbeariaId, servicoId, estoqueId: e.id, quantidade: q });
  }
  if (linhas.length) await prisma.servicoInsumo.createMany({ data: linhas });
}

// GET /painel/servicos/novo — formulário de criação
// Barbeiros ativos para a seção "Preço por barbeiro" do formulário.
function barbeirosDoForm(barbeariaId) {
  return prisma.usuario.findMany({ where: { barbeariaId, ativo: true }, orderBy: { id: 'asc' }, select: { id: true, nome: true } });
}

async function formNovo(req, res) {
  const categorias = await prisma.categoriaServico.findMany({ where: { barbeariaId: req.barbeariaId }, orderBy: { nome: 'asc' } });
  const { estoqueItens, insumosMap } = await dadosInsumos(req.barbeariaId, null);
  const barbeiros = await barbeirosDoForm(req.barbeariaId);
  res.render('painel/servico-form', { titulo: 'Novo serviço', servico: null, categorias, estoqueItens, insumosMap, barbeiros, precosBarbeiro: {} });
}

// POST /painel/servicos — cria um serviço/produto
async function criar(req, res) {
  const nome = (req.body.nome || '').trim();
  const descricao = (req.body.descricao || '').trim() || null;
  const valor = reaisParaCentavos(req.body.valor);
  const duracaoMin = Math.max(0, parseInt(req.body.duracaoMin, 10) || 0);
  const categoriaId = req.body.categoriaId ? Number(req.body.categoriaId) : null;
  const ehProduto = req.body.ehProduto === 'on';
  // "Encaixe" só faz sentido em serviço (produto não tem tempo de agenda).
  const ehEncaixe = !ehProduto && req.body.ehEncaixe === 'on';
  const comissaoPercentual = Math.min(100, Math.max(0, parseFloat(req.body.comissaoPercentual) || 10));
  const fotoUrl = req.file ? '/uploads/' + req.file.filename : null;
  // Miniatura só acompanha uma foto (sozinha não faz sentido).
  const fotoMiniUrl = fotoUrl ? miniValida(req.fileMini) : (req.fileMini && apagarFoto('/uploads/' + req.fileMini.filename), null);

  if (!nome || valor === null) {
    if (fotoUrl) apagarFoto(fotoUrl);
    if (fotoMiniUrl) apagarFoto(fotoMiniUrl);
    req.session.flash = { tipo: 'erro', texto: 'Informe ao menos nome e um valor válido.' };
    return res.redirect(destino(ehProduto));
  }

  const novoServico = await prisma.servico.create({ data: { barbeariaId: req.barbeariaId, nome, descricao, valor, duracaoMin, categoriaId, ehProduto, ehEncaixe, comissaoPercentual, fotoUrl, fotoMiniUrl } });
  await salvarInsumos(req.barbeariaId, novoServico.id, req.body);
  if (!ehProduto) await precos.salvarPrecosDoForm(req.barbeariaId, novoServico.id, req.body, reaisParaCentavos);
  req.session.flash = { tipo: 'sucesso', texto: ehProduto ? 'Produto criado.' : 'Serviço criado.' };
  res.redirect(destino(ehProduto));
}

// GET /painel/servicos/:id/editar — formulário de edição
async function formEditar(req, res) {
  const servico = await prisma.servico.findFirst({ where: { id: Number(req.params.id), barbeariaId: req.barbeariaId } });
  if (!servico) return res.redirect('/painel/servicos');
  const categorias = await prisma.categoriaServico.findMany({ where: { barbeariaId: req.barbeariaId }, orderBy: { nome: 'asc' } });
  const { estoqueItens, insumosMap } = await dadosInsumos(req.barbeariaId, servico.id);
  const barbeiros = await barbeirosDoForm(req.barbeariaId);
  const linhas = await prisma.servicoPrecoBarbeiro.findMany({ where: { servicoId: servico.id } });
  const precosBarbeiro = Object.fromEntries(linhas.map((l) => [l.usuarioId, l.valor]));
  res.render('painel/servico-form', { titulo: 'Editar serviço', servico, categorias, estoqueItens, insumosMap, barbeiros, precosBarbeiro });
}

// POST /painel/servicos/:id — atualiza um serviço/produto
async function atualizar(req, res) {
  const id = Number(req.params.id);
  const servico = await prisma.servico.findFirst({ where: { id, barbeariaId: req.barbeariaId } });
  if (!servico) {
    if (req.file) apagarFoto('/uploads/' + req.file.filename);
    if (req.fileMini) apagarFoto('/uploads/' + req.fileMini.filename);
    return res.redirect('/painel/servicos');
  }

  const nome = (req.body.nome || '').trim();
  const descricao = (req.body.descricao || '').trim() || null;
  const valor = reaisParaCentavos(req.body.valor);
  const duracaoMin = Math.max(0, parseInt(req.body.duracaoMin, 10) || 0);
  const categoriaId = req.body.categoriaId ? Number(req.body.categoriaId) : null;
  const ehProduto = req.body.ehProduto === 'on';
  const ehEncaixe = !ehProduto && req.body.ehEncaixe === 'on';
  const comissaoPercentual = Math.min(100, Math.max(0, parseFloat(req.body.comissaoPercentual) || 10));

  if (!nome || valor === null) {
    if (req.file) apagarFoto('/uploads/' + req.file.filename);
    if (req.fileMini) apagarFoto('/uploads/' + req.fileMini.filename);
    req.session.flash = { tipo: 'erro', texto: 'Informe ao menos nome e um valor válido.' };
    return res.redirect(destino(servico.ehProduto));
  }

  const data = { nome, descricao, valor, duracaoMin, categoriaId, ehProduto, ehEncaixe, comissaoPercentual };
  if (req.file) {
    apagarFoto(servico.fotoUrl); // remove a foto antiga
    apagarFoto(servico.fotoMiniUrl); // e a miniatura dela
    data.fotoUrl = '/uploads/' + req.file.filename;
    data.fotoMiniUrl = miniValida(req.fileMini);
  } else if (req.fileMini) {
    // Só um novo recorte da MESMA foto ("moldura do recorte"): troca a miniatura.
    const nova = servico.fotoUrl ? miniValida(req.fileMini) : (apagarFoto('/uploads/' + req.fileMini.filename), null);
    if (nova) {
      apagarFoto(servico.fotoMiniUrl);
      data.fotoMiniUrl = nova;
    }
  }

  await prisma.servico.update({ where: { id }, data });
  await salvarInsumos(req.barbeariaId, id, req.body);
  if (!ehProduto) await precos.salvarPrecosDoForm(req.barbeariaId, id, req.body, reaisParaCentavos);
  req.session.flash = { tipo: 'sucesso', texto: ehProduto ? 'Produto atualizado.' : 'Serviço atualizado.' };
  res.redirect(destino(ehProduto));
}

// POST /painel/servicos/:id/toggle — ativa/desativa
async function alternarAtivo(req, res) {
  const id = Number(req.params.id);
  const s = await prisma.servico.findFirst({ where: { id, barbeariaId: req.barbeariaId } });
  if (s) await prisma.servico.update({ where: { id }, data: { ativo: !s.ativo } });
  res.redirect(destino(s && s.ehProduto));
}

// POST /painel/servicos/:id/remover — exclui (ou desativa se tiver histórico)
async function remover(req, res) {
  const id = Number(req.params.id);
  const s = await prisma.servico.findFirst({ where: { id, barbeariaId: req.barbeariaId } });
  if (!s) return res.redirect('/painel/servicos');

  try {
    await prisma.servico.delete({ where: { id } });
    apagarFoto(s.fotoUrl);
    apagarFoto(s.fotoMiniUrl);
    req.session.flash = { tipo: 'sucesso', texto: s.ehProduto ? 'Produto excluído.' : 'Serviço excluído.' };
  } catch (e) {
    // Está referenciado em agendamentos: desativa em vez de excluir.
    await prisma.servico.update({ where: { id }, data: { ativo: false } });
    req.session.flash = {
      tipo: 'aviso',
      texto: 'Esse item tem histórico em agendamentos, então foi desativado em vez de excluído.',
    };
  }
  res.redirect(destino(s.ehProduto));
}

// --- Categorias -------------------------------------------------------------
// Compartilhadas entre Serviços e Produtos (mesmo CategoriaServico) — o
// redirect volta para a tela de onde veio o formulário via campo `retorno`.
function destinoCategoria(req) {
  const retorno = req.body.retorno || req.query.retorno;
  return retorno === 'produtos' ? '/painel/produtos' : '/painel/servicos';
}

async function criarCategoria(req, res) {
  const nome = (req.body.nome || '').trim();
  if (nome) await prisma.categoriaServico.create({ data: { barbeariaId: req.barbeariaId, nome } });
  res.redirect(destinoCategoria(req));
}

async function renomearCategoria(req, res) {
  const nome = (req.body.nome || '').trim();
  if (nome) await prisma.categoriaServico.updateMany({ where: { id: Number(req.params.id), barbeariaId: req.barbeariaId }, data: { nome } });
  res.redirect(destinoCategoria(req));
}

async function removerCategoria(req, res) {
  // Os serviços da categoria não são apagados: ficam "sem categoria" (SetNull).
  await prisma.categoriaServico.deleteMany({ where: { id: Number(req.params.id), barbeariaId: req.barbeariaId } }).catch(() => {});
  res.redirect(destinoCategoria(req));
}

module.exports = {
  listar,
  listarProdutos,
  formNovo,
  criar,
  formEditar,
  atualizar,
  alternarAtivo,
  remover,
  criarCategoria,
  renomearCategoria,
  removerCategoria, removerFoto };
