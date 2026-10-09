// Home "Painel vivo" (spec 12, fatia B6; direção C aprovada em 2026-10-05).
// Monta em UMA resposta o que a Início mostra, já recortado por papel,
// permissão e plano — a tela não recebe o que não vai mostrar (R3):
//   anéis (faturamento/meta, atendimentos, ocupação, comissão),
//   histograma de horas livres de hoje, próximos atendimentos e destaques.
// Anel ou destaque que a pessoa não pode ver simplesmente NÃO vem (a Home se
// reorganiza com 1, 2 ou 3 anéis, critério 3). A agenda própria é direito
// básico: "Próximos" e "Horas livres" vêm sempre (estado "só agenda").
//
// Os números saem de services/metricas.js (mesma fonte da Gestão) e a resposta
// inteira fica 60 s em cache por pessoa, apagado quando a barbearia grava algo.
const prisma = require('../config/db');
const metricas = require('./metricas');
const planoCortavo = require('./planoCortavo');
const { paraMinutos } = require('./disponibilidade');

const DIA_MS = 86400000;
const cacheHome = new Map();
const TTL = 60 * 1000;

function inicioDoDia(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Contexto de cálculo de um "cartão" fictício; null quando a pessoa não pode.
function ctxOuNulo(barbeariaId, permissoes, acesso, plano = null) {
  try {
    return metricas.contextoCalculo({ barbeariaId, permissoes }, { acesso, plano });
  } catch (_) {
    return null;
  }
}

async function montarHome({ barbeariaId, permissoes, agora = new Date(), faixaTeste = null }) {
  const chave = barbeariaId + '|home|' + permissoes.usuario.id + '|' + permissoes.liberadas().join(',') + '|' + (permissoes.plano ? permissoes.plano.chave : '') + '|' + metricas.iso(agora);
  const c = cacheHome.get(chave);
  if (c && c.exp > agora.getTime() && c.versao === metricas.versaoCache(barbeariaId)) return { ...c.valor, cache: true };

  const plano = permissoes.plano;
  const libera = (f) => !plano || planoCortavo.libera(plano, f);
  const hoje = metricas.resolverPeriodo({ periodo: 'hoje' }, agora);
  const mes = metricas.resolverPeriodo({ periodo: 'mes' }, agora);

  const ctxProprio = ctxOuNulo(barbeariaId, permissoes, 'proprio'); // sempre existe
  const ctxNumeros = ctxOuNulo(barbeariaId, permissoes, 'numeros');
  const escopo = ctxProprio.usuarioId ? { tipo: 'barbeiro', usuarioId: ctxProprio.usuarioId } : { tipo: 'barbearia', usuarioId: null };

  const aneis = [];

  // Anel 1 — faturamento (hoje e mês) com a meta do mês, se houver e o plano tiver Metas.
  if (ctxNumeros) {
    const [fHoje, fMes] = await Promise.all([metricas.faturamento(ctxNumeros, hoje), metricas.faturamento(ctxNumeros, mes)]);
    let meta = null;
    if (libera('metas')) {
      const ms = (await metricas.metas({ ...ctxNumeros, filtroBarbeiro: null })).resumo.metas;
      const alvo = ms.find((m) => m.metrica === 'faturamento' && (ctxNumeros.usuarioId ? m.escopo && m.escopo.usuarioId === ctxNumeros.usuarioId : !m.escopo));
      if (alvo) meta = { metaId: alvo.id, alvo: alvo.alvo, atual: alvo.atual, pct: alvo.pct, batida: alvo.batida };
    }
    aneis.push({ chave: 'faturamento', hoje: fHoje.resumo.total, mes: fMes.resumo.total, variacaoMesPct: fMes.resumo.variacaoPct, fonte: fMes.resumo.fonte, meta });
  }

  // Anel 2 — atendimentos de hoje (concluídos de quantos marcados). Agenda
  // própria: vem sempre.
  const agsHoje = await prisma.agendamento.findMany({
    where: { barbeariaId, data: hoje.inicio, status: { in: ['agendado', 'concluido'] }, ...(ctxProprio.usuarioId ? { usuarioId: ctxProprio.usuarioId } : {}) },
    select: { status: true },
  });
  const concluidosHoje = agsHoje.filter((a) => a.status === 'concluido').length;
  aneis.push({ chave: 'atendimentos', concluidos: concluidosHoje, total: agsHoje.length, pct: agsHoje.length ? Math.round((concluidosHoje / agsHoje.length) * 100) : 0 });

  // Anel 3 — ocupação de hoje.
  const oc = await metricas.ocupacaoBase(ctxProprio, hoje.inicio, hoje.fimExcl, agora);
  aneis.push({ chave: 'ocupacao', pct: oc.pct, horasAtendidas: Math.round((oc.ocupado / 60) * 10) / 10, horasJornada: Math.round((oc.disponivel / 60) * 10) / 10 });

  // Anel 4 — comissão do mês, só do PRÓPRIO barbeiro (admin não tem anel de comissão).
  if (!permissoes.ehAdmin && permissoes.pode('comissoes')) {
    const [minha] = await metricas.calcularComissoes({ barbeariaId, usuarioId: permissoes.usuario.id }, mes.inicio, mes.fimExcl);
    aneis.push({ chave: 'comissao', mes: minha ? minha.comissao : 0, atendimentos: minha ? minha.atendimentos : 0 });
  }

  // Horas livres de hoje (histograma). Admin: também por barbeiro.
  const ctxHoras = { ...ctxProprio };
  const hl = await metricas.horasLivres(ctxHoras, hoje, { agora });
  const horasLivres = { livresMin: hl.resumo.livresMin, histograma: hl.resumo.histograma };
  if (hl.detalhe && hl.detalhe.porBarbeiro) horasLivres.porBarbeiro = hl.detalhe.porBarbeiro;

  // Próximos atendimentos (hoje em diante; hoje só o que não passou).
  const minAgora = agora.getHours() * 60 + agora.getMinutes();
  const futuros = await prisma.agendamento.findMany({
    where: { barbeariaId, data: { gte: hoje.inicio }, status: 'agendado', ...(ctxProprio.usuarioId ? { usuarioId: ctxProprio.usuarioId } : {}) },
    include: { itens: { include: { servico: { select: { nome: true } } } }, usuario: { select: { id: true, nome: true } } },
    orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
    take: 20,
  });
  const proximos = futuros
    .filter((a) => new Date(a.data).getTime() > hoje.inicio.getTime() || paraMinutos(a.horaInicio) >= minAgora)
    .slice(0, 4)
    .map((a) => ({
      id: a.id,
      data: metricas.iso(new Date(a.data)),
      hora: a.horaInicio,
      cliente: a.clienteNome,
      servicos: a.itens.map((i) => i.servico.nome),
      barbeiro: escopo.tipo === 'barbearia' && a.usuario ? { usuarioId: a.usuario.id, nome: a.usuario.nome } : null,
    }));

  // Destaques.
  const destaques = [];
  const vago = hl.resumo.histograma.find((h) => h.livresMin >= 30);
  if (vago) destaques.push({ tipo: 'horario_vago', hora: vago.hora, livresMin: vago.livresMin });
  if (libera('metas') && (ctxNumeros || permissoes.podeVerEquipe())) {
    const ctxMetas = ctxOuNulo(barbeariaId, permissoes, 'metas');
    if (ctxMetas) {
      const ms = (await metricas.metas(ctxMetas)).resumo.metas;
      for (const m of ms) if (m.pct >= 80 && !m.batida) destaques.push({ tipo: 'meta_perto', metaId: m.id, label: m.label, dinheiro: m.dinheiro, atual: m.atual, alvo: m.alvo, pct: m.pct, escopo: m.escopo });
    }
  }
  if (libera('estoque') && (permissoes.ehAdmin || permissoes.pode('estoque'))) {
    const itens = await prisma.estoque.findMany({ where: { barbeariaId }, select: { nome: true, quantidade: true, quantidadeMinima: true } });
    const emFalta = itens.filter((e) => e.quantidadeMinima > 0 && e.quantidade <= e.quantidadeMinima);
    if (emFalta.length) destaques.push({ tipo: 'estoque_baixo', quantidade: emFalta.length, nomes: emFalta.slice(0, 4).map((e) => e.nome) });
  }
  const ctxSumidos = libera('relatorios') ? ctxOuNulo(barbeariaId, permissoes, 'barbearia') : null;
  if (ctxSumidos && permissoes.pode('clientes')) {
    const s = await metricas.sumidos({ ...ctxSumidos, verContato: false }, mes, { agora, query: {} });
    if (s.resumo.total) destaques.push({ tipo: 'cliente_sumido', total: s.resumo.total, dias: s.resumo.dias });
  }
  if (permissoes.pode('clientes')) {
    const comData = await prisma.cliente.findMany({ where: { barbeariaId, dataNascimento: { not: null } }, select: { id: true, nome: true, dataNascimento: true } });
    const aniv = comData.filter((c) => {
      const d = new Date(c.dataNascimento);
      return d.getMonth() === agora.getMonth() && d.getDate() === agora.getDate();
    });
    if (aniv.length) destaques.push({ tipo: 'aniversariante', total: aniv.length, clientes: aniv.slice(0, 3).map((c) => ({ clienteId: c.id, nome: c.nome })) });
  }

  const valor = {
    papel: permissoes.ehAdmin ? 'admin' : 'barbeiro',
    escopo,
    aneis,
    horasLivres,
    proximos,
    destaques,
    teste: permissoes.ehAdmin ? faixaTeste || null : null,
    geradoEm: agora.toISOString(),
  };
  if (cacheHome.size > 500) cacheHome.delete(cacheHome.keys().next().value);
  cacheHome.set(chave, { exp: agora.getTime() + TTL, valor, versao: metricas.versaoCache(barbeariaId) });
  return { ...valor, cache: false };
}

module.exports = { montarHome, _cacheHome: cacheHome, DIA_MS };
