// Aba Metas (pedido do dono, 2026-09-07): metas CONFIGURÁVEIS — o admin escolhe a
// métrica e o alvo, e o escopo (barbearia toda ou um barbeiro). O progresso é
// sempre do MÊS corrente, calculado na hora (não guardado). Só admin (rotas).
const prisma = require('../config/db');

// Métricas suportadas. `dinheiro` = alvo em centavos (faturamento/ticket);
// `porBarbeiro` = pode ser meta de um barbeiro (novos_clientes é só da barbearia,
// porque cliente novo não "pertence" a um barbeiro).
const METRICAS = {
  faturamento: { label: 'Faturamento', dinheiro: true, porBarbeiro: true },
  atendimentos: { label: 'Atendimentos', dinheiro: false, porBarbeiro: true },
  ticket_medio: { label: 'Ticket médio', dinheiro: true, porBarbeiro: true },
  novos_clientes: { label: 'Novos clientes', dinheiro: false, porBarbeiro: false },
};

function mesCorrente() {
  const h = new Date();
  return {
    inicio: new Date(h.getFullYear(), h.getMonth(), 1),
    fimExcl: new Date(h.getFullYear(), h.getMonth() + 1, 1),
  };
}

// Apura os números do mês UMA vez e serve todas as metas.
// Faturamento/atendimentos saem dos agendamentos CONCLUÍDOS por `concluidoEm`
// (mesmo critério do relatório e das comissões — acompanha o dinheiro que entrou).
async function apurar(barbeariaId) {
  const { inicio, fimExcl } = mesCorrente();
  const ags = await prisma.agendamento.findMany({
    where: { barbeariaId, status: 'concluido', concluidoEm: { gte: inicio, lt: fimExcl } },
    select: { usuarioId: true, valorTotal: true },
  });
  const porBarb = new Map(); // usuarioId -> { fat, qtd }
  let fatTotal = 0;
  let qtdTotal = 0;
  ags.forEach((a) => {
    fatTotal += a.valorTotal;
    qtdTotal += 1;
    const g = porBarb.get(a.usuarioId) || { fat: 0, qtd: 0 };
    g.fat += a.valorTotal;
    g.qtd += 1;
    porBarb.set(a.usuarioId, g);
  });
  const novosClientes = await prisma.cliente.count({
    where: { barbeariaId, criadoEm: { gte: inicio, lt: fimExcl } },
  });
  return { porBarb, fatTotal, qtdTotal, novosClientes };
}

function atualDe(meta, ap) {
  const g = meta.usuarioId
    ? ap.porBarb.get(meta.usuarioId) || { fat: 0, qtd: 0 }
    : { fat: ap.fatTotal, qtd: ap.qtdTotal };
  switch (meta.metrica) {
    case 'faturamento':
      return g.fat;
    case 'atendimentos':
      return g.qtd;
    case 'ticket_medio':
      return g.qtd ? Math.round(g.fat / g.qtd) : 0;
    case 'novos_clientes':
      return ap.novosClientes;
    default:
      return 0;
  }
}

// GET /painel/metas
async function listar(req, res) {
  const b = req.barbeariaId;
  const [metas, barbeiros, ap] = await Promise.all([
    prisma.meta.findMany({ where: { barbeariaId: b }, include: { usuario: true }, orderBy: { criadoEm: 'asc' } }),
    prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true, papel: { not: 'dono' } }, orderBy: { nome: 'asc' } }),
    apurar(b),
  ]);

  const itens = metas.map((m) => {
    const conf = METRICAS[m.metrica] || { label: m.metrica, dinheiro: false };
    const atual = atualDe(m, ap);
    return {
      id: m.id,
      label: conf.label,
      dinheiro: !!conf.dinheiro,
      escopo: m.usuario ? m.usuario.nome : 'Barbearia toda',
      alvo: m.alvo,
      atual,
      pct: m.alvo > 0 ? Math.min(100, Math.round((atual / m.alvo) * 100)) : 0,
      batida: m.alvo > 0 && atual >= m.alvo,
    };
  });

  const mesLabel = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  res.render('painel/metas', { titulo: 'Metas', itens, barbeiros, metricas: METRICAS, mesLabel });
}

// POST /painel/metas
async function criar(req, res) {
  const b = req.barbeariaId;
  const metrica = req.body.metrica;
  const conf = METRICAS[metrica];
  if (!conf) {
    req.session.flash = { tipo: 'erro', texto: 'Métrica inválida.' };
    return res.redirect('/painel/metas');
  }

  // Escopo: barbeiro só se a métrica permitir E o usuário existir na barbearia.
  let usuarioId = null;
  if (conf.porBarbeiro && req.body.usuarioId) {
    const membro = await prisma.usuario.findFirst({ where: { id: Number(req.body.usuarioId), barbeariaId: b } });
    if (membro) usuarioId = membro.id;
  }

  // Alvo: dinheiro vem em reais (ex.: "20.000" ou "20000,00") -> centavos.
  const bruto = String(req.body.alvo || '').trim().replace(/\./g, '').replace(',', '.');
  const num = parseFloat(bruto);
  const alvo = conf.dinheiro ? Math.round(num * 100) : Math.round(num);
  if (!isFinite(alvo) || alvo <= 0) {
    req.session.flash = { tipo: 'erro', texto: 'Informe um alvo válido.' };
    return res.redirect('/painel/metas');
  }

  await prisma.meta.create({ data: { barbeariaId: b, usuarioId, metrica, alvo } });
  req.session.flash = { tipo: 'sucesso', texto: 'Meta criada.' };
  res.redirect('/painel/metas');
}

// POST /painel/metas/:id/remover
async function remover(req, res) {
  await prisma.meta.deleteMany({ where: { id: Number(req.params.id), barbeariaId: req.barbeariaId } });
  req.session.flash = { tipo: 'sucesso', texto: 'Meta removida.' };
  res.redirect('/painel/metas');
}

// Cartões de metas da Home. Admin vê todas; barbeiro vê só as metas DELE
// (funcionário não enxerga números da barbearia toda).
async function paraHome(barbeariaId, usuarioId, ehAdmin) {
  const where = { barbeariaId };
  if (!ehAdmin) where.usuarioId = usuarioId;
  const metas = await prisma.meta.findMany({ where, include: { usuario: true }, orderBy: { criadoEm: 'asc' } });
  if (!metas.length) return [];
  const ap = await apurar(barbeariaId);
  return metas.map((m) => {
    const conf = METRICAS[m.metrica] || { label: m.metrica, dinheiro: false };
    const atual = atualDe(m, ap);
    return {
      label: conf.label,
      dinheiro: !!conf.dinheiro,
      escopo: m.usuario ? m.usuario.nome.split(' ')[0] : 'Barbearia',
      alvo: m.alvo,
      atual,
      pct: m.alvo > 0 ? Math.min(100, Math.round((atual / m.alvo) * 100)) : 0,
      batida: m.alvo > 0 && atual >= m.alvo,
    };
  });
}

module.exports = { listar, criar, remover, paraHome, apurar, atualDe, METRICAS };
