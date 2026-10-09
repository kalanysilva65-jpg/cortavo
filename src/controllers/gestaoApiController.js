// API da Gestão (spec 12, B4): um endpoint por cartão, já recortado por
// permissão (B1/B2) e plano. Formato e regras de cada um em
// squads/app-cortavo/output/gestao-dados-apis.md (documento para o Fabio).
//
// O recorte NUNCA vem da tela: `?barbeiro=` só é aceito para o próprio usuário
// ou para quem pode comparar a equipe (admin ou ranking_equipe); o resto
// recebe 403 sem dado nenhum (critérios 4 e 5).
const prisma = require('../config/db');
const metricas = require('../services/metricas');

function semCache(res) {
  res.set('Cache-Control', 'private, no-store');
}

function responderErro(res, e) {
  if (e && e.status === 403) {
    if (e.foraDoPlano) {
      const planoCortavo = require('../services/planoCortavo');
      return res.status(403).json({ erro: planoCortavo.textoForaDoPlano(e.foraDoPlano), foraDoPlano: true });
    }
    return res.status(403).json({ erro: 'Sem acesso a esta área.', semPermissao: true });
  }
  if (e && (e.status === 400 || e.status === 404)) return res.status(e.status).json({ erro: e.message });
  throw e;
}

// `?barbeiro=ID` -> id de um membro DESTA barbearia (ou null). Lança 400 se o
// número não for de ninguém daqui (não revela se existe em outra barbearia).
async function lerBarbeiroFiltro(req) {
  const v = req.query.barbeiro;
  if (v == null || v === '' || v === 'todos') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) {
    const e = new Error('Barbeiro inválido.');
    e.status = 400;
    throw e;
  }
  const u = await prisma.usuario.findFirst({ where: { id, barbeariaId: req.barbeariaId }, select: { id: true } });
  if (!u) {
    const e = new Error('Barbeiro inválido.');
    e.status = 400;
    throw e;
  }
  return id;
}

// GET /painel/api/gestao/cartoes — os cartões que esta pessoa vê, em ordem.
async function cartoes(req, res) {
  semCache(res);
  res.json({ cartoes: metricas.cartoesDisponiveis(req.permissoes), podeFiltrarBarbeiro: req.permissoes.podeVerEquipe() });
}

// GET /painel/api/gestao/:metrica?periodo=&de=&ate=&barbeiro=&detalhe=1
async function metrica(req, res) {
  semCache(res);
  try {
    const barbeiroFiltro = await lerBarbeiroFiltro(req);
    const r = await metricas.calcular(req.params.metrica, {
      barbeariaId: req.barbeariaId,
      permissoes: req.permissoes,
      query: req.query,
      barbeiroFiltro,
    });
    res.json(r);
  } catch (e) {
    return responderErro(res, e);
  }
}

// ---------------------------------------------------- baixa de comissão ----
// POST /painel/api/gestao/comissoes/baixa (só admin; plano com Comissões)
// Corpo: { usuarioId, de, ate, valor?, observacao?, lancarNoCaixa?, formaPagamento? }
//  - de/ate: "AAAA-MM-DD", o período da comissão (o mesmo da tela);
//  - valor: centavos; sem valor = o que falta pagar do período;
//  - lancarNoCaixa: true grava também a SAÍDA no caixa ("Comissão — Nome").
const FORMAS_CAIXA = ['pix', 'credito', 'debito', 'dinheiro'];
async function baixarComissao(req, res) {
  semCache(res);
  const b = req.barbeariaId;
  const body = req.body || {};
  const usuarioId = Number(body.usuarioId);
  if (!Number.isInteger(usuarioId) || !metricas.dataValida(body.de) || !metricas.dataValida(body.ate)) {
    return res.status(400).json({ erro: 'Informe o barbeiro e o período.' });
  }
  let [de, ate] = [String(body.de), String(body.ate)];
  if (de > ate) [de, ate] = [ate, de];
  const barbeiro = await prisma.usuario.findFirst({ where: { id: usuarioId, barbeariaId: b }, select: { id: true, nome: true } });
  if (!barbeiro) return res.status(400).json({ erro: 'Barbeiro inválido.' });

  const inicio = metricas.dataLocal(de);
  const fimDia = metricas.dataLocal(ate);
  const fimExcl = new Date(fimDia);
  fimExcl.setDate(fimExcl.getDate() + 1);
  const [calc] = await metricas.calcularComissoes({ barbeariaId: b, usuarioId }, inicio, fimExcl);
  const calculado = calc ? calc.comissao : 0;
  const jaPago = (await prisma.comissaoPagamento.findMany({
    where: { barbeariaId: b, usuarioId, periodoInicio: { gte: inicio }, periodoFim: { lt: fimExcl } },
    select: { valor: true },
  })).reduce((s, x) => s + x.valor, 0);
  const valor = body.valor == null || body.valor === '' ? Math.max(0, calculado - jaPago) : Math.trunc(Number(body.valor));
  if (!Number.isFinite(valor) || valor <= 0 || valor > 100000000) {
    return res.status(400).json({ erro: 'Nada a pagar neste período, ou valor inválido.' });
  }
  const u = req.session.usuario;
  const observacao = String(body.observacao || '').trim().slice(0, 200) || null;
  let caixaId = null;
  const lancar = body.lancarNoCaixa === true || body.lancarNoCaixa === 'true' || body.lancarNoCaixa === '1' || body.lancarNoCaixa === 'on';
  const registro = await prisma.$transaction(async (tx) => {
    if (lancar) {
      const forma = FORMAS_CAIXA.includes(body.formaPagamento) ? body.formaPagamento : null;
      const ddmm = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      const saida = await tx.caixa.create({
        data: {
          barbeariaId: b,
          descricao: `Comissão — ${barbeiro.nome} (${ddmm(inicio)} a ${ddmm(fimDia)})`.slice(0, 120),
          valor,
          tipo: 'saida',
          data: new Date(),
          categoriaId: null,
          formaPagamento: forma,
        },
      });
      caixaId = saida.id;
    }
    return tx.comissaoPagamento.create({
      data: {
        barbeariaId: b, usuarioId, periodoInicio: inicio, periodoFim: fimDia, valor, valorCalculado: calculado,
        pagoPorId: u.id, pagoPorNome: u.nome || 'Admin', observacao, caixaId,
      },
    });
  });
  metricas.invalidar(b);
  res.json({
    ok: true,
    pagamento: { id: registro.id, usuarioId, de, ate, valor, valorCalculado: calculado, caixaId },
    situacao: { comissao: calculado, pago: jaPago + valor, aPagar: Math.max(0, calculado - jaPago - valor) },
  });
}

// POST /painel/api/gestao/comissoes/baixa/:id/desfazer (só admin): apaga a
// baixa e a saída de caixa que ela tiver criado.
async function desfazerBaixaComissao(req, res) {
  semCache(res);
  const b = req.barbeariaId;
  const reg = await prisma.comissaoPagamento.findFirst({ where: { id: Number(req.params.id) || 0, barbeariaId: b } });
  if (!reg) return res.status(404).json({ erro: 'Pagamento não encontrado.' });
  await prisma.$transaction(async (tx) => {
    if (reg.caixaId) await tx.caixa.deleteMany({ where: { id: reg.caixaId, barbeariaId: b } });
    await tx.comissaoPagamento.delete({ where: { id: reg.id } });
  });
  metricas.invalidar(b);
  res.json({ ok: true });
}

module.exports = { cartoes, metrica, responderErro, lerBarbeiroFiltro, semCache, baixarComissao, desfazerBaixaComissao };
