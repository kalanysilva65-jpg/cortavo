// Gestão (redesign v3, F5): junta os cartões do B4 (services/metricas.js) no
// formato que a tela usa (partial painel/_gestao-numeros.ejs). Não calcula
// número nenhum: só lê `metricas.calcular`, que já recorta por papel,
// permissão e plano e guarda em cache por 60 s. Cartão que a pessoa não vê
// (ou que falha) simplesmente não entra: a tela some com ele, sem buraco.
const metricas = require('./metricas');
const fechamento = require('./fechamentoCaixa');

const DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES_CURTOS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const COMPARACAO = { hoje: 'vs. ontem', semana: 'vs. semana passada', mes: 'vs. mês passado', ano: 'vs. ano passado', custom: 'vs. período anterior' };

// Rótulos do eixo: no máximo ~7 no celular (os outros ficam vazios).
function eixoDe(barras, unidade) {
  const n = barras.length;
  const passo = Math.max(1, Math.ceil(n / 7));
  return barras.map((b, i) => {
    if (i % passo !== 0 && i !== n - 1) return '';
    if (unidade === 'mes') return MESES_CURTOS[Number(b.chave.slice(5, 7)) - 1] || '';
    const d = new Date(b.chave + 'T12:00:00');
    return n <= 7 ? DIAS_CURTOS[d.getDay()] : String(d.getDate());
  });
}

// Contagem do mapa de calor em 5 tons (0 a 4), relativos ao máximo do período.
function niveis(contagem) {
  const max = Math.max(1, ...contagem.flat());
  return (c) => (c ? Math.max(1, Math.min(4, Math.ceil((c / max) * 4))) : 0);
}

async function montarGestao({ barbeariaId, permissoes, query = {}, agora = new Date() }) {
  const disponiveis = metricas.cartoesDisponiveis(permissoes).filter((c) => !c.foraDoPlano).map((c) => c.slug);
  // Sem número de dinheiro (só agenda): a tela mostra o estado vazio da spec 12.
  if (!disponiveis.includes('faturamento')) return null;

  const pedir = (slug, detalhe) => (disponiveis.includes(slug)
    ? metricas.calcular(slug, { barbeariaId, permissoes, query: { ...query, ...(detalhe ? { detalhe: '1' } : {}) }, agora }).catch(() => null)
    : Promise.resolve(null));
  const [fat, ocup, tick, atend, eq, serv, cli, falt, com, pag, met, luc] = await Promise.all([
    pedir('faturamento', true), pedir('ocupacao', true), pedir('ticket', true), pedir('atendimentos'), pedir('equipe'),
    pedir('servicos'), pedir('clientes'), pedir('faltas'), pedir('comissoes'), pedir('pagamentos'), pedir('metas'), pedir('lucro'),
  ]);
  if (!fat) return null;

  const g = {
    rotulo: fat.periodo.rotulo,
    comparacao: COMPARACAO[fat.periodo.chave] || COMPARACAO.custom,
  };
  const barras = (fat.detalhe && fat.detalhe.barras) || [];
  g.faturamento = {
    valor: fat.resumo.total, anterior: fat.resumo.anterior,
    serie: barras.map((b) => b.valor), serieAnt: barras.map((b) => b.anterior || 0), eixo: eixoDe(barras, fat.detalhe && fat.detalhe.unidade),
  };
  if (ocup) {
    g.ocupacao = { pct: ocup.resumo.pct, anterior: ocup.resumo.anteriorPct };
    const mc = ocup.detalhe && ocup.detalhe.mapaCalor;
    if (mc && mc.horas.length && mc.contagem.flat().some(Boolean)) {
      const nivel = niveis(mc.contagem);
      g.ocupacao.mapa = { dias: mc.dias.map((d) => d.charAt(0)), faixas: mc.horas, valores: mc.horas.map((_, hi) => mc.dias.map((_, di) => nivel(mc.contagem[di][hi]))) };
    }
  }
  if (tick) g.ticket = { valor: tick.resumo.valor, anterior: tick.resumo.anterior, spark: ((tick.detalhe && tick.detalhe.linha) || []).map((x) => x.valor) };
  if (atend) g.atendimentos = { valor: atend.resumo.total, anterior: atend.resumo.anterior, spark: atend.resumo.serie || [] };
  if (eq && eq.resumo.barbeiros && eq.resumo.barbeiros.length) g.equipe = eq.resumo.barbeiros.map((b) => ({ nome: b.nome, valor: b.faturamento })).sort((a, b) => b.valor - a.valor);
  if (serv && serv.resumo.top && serv.resumo.top.length) g.servicos = serv.resumo.top.map((s) => ({ nome: s.nome, qtd: s.qtd }));
  if (cli && cli.resumo.total) g.clientes = { novos: cli.resumo.novos, recorrentes: cli.resumo.recorrentes };
  if (falt) g.faltas = { valor: falt.resumo.total, total: falt.resumo.base };
  if (com && com.resumo.barbeiros) {
    const n = com.resumo.barbeiros.length;
    g.comissoes = { valor: com.resumo.aPagar, texto: n + (n === 1 ? ' barbeiro' : ' barbeiros') + (com.resumo.pago ? ', parte já paga' : '') };
  }
  if (pag && pag.resumo.formas) {
    const formas = pag.resumo.formas.filter((f) => f.valor > 0).sort((a, b) => b.valor - a.valor);
    if (formas.length) g.pagamentos = formas.map((f) => ({ rot: f.label, valor: f.valor }));
  }
  if (met && met.resumo.metas && met.resumo.metas.length) {
    const m = met.resumo.metas.find((x) => x.metrica === 'faturamento') || met.resumo.metas[0];
    g.metas = { pct: m.pct, texto: m.label + (m.batida ? ', batida' : '') };
  }
  if (luc) g.lucro = { valor: luc.resumo.lucro, gastos: luc.resumo.gastos };
  if (permissoes.ehAdmin || permissoes.pode('caixa_ver')) {
    try {
      const d = fechamento.lerDia(undefined, agora);
      const r = await fechamento.resumoDoDia(barbeariaId, d, {});
      g.caixaHoje = { saldo: r.saldo, texto: r.fechamento ? 'Fechado' : r.lancamentos + (r.lancamentos === 1 ? ' lançamento hoje' : ' lançamentos hoje') };
    } catch (_) { /* sem o caixa do dia, o cartão não aparece */ }
  }
  return g;
}

module.exports = { montarGestao, eixoDe };
