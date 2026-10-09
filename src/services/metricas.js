// Métricas da Gestão (spec 12, fatias B4 e B5). FONTE ÚNICA dos números que a
// Gestão (celular e PC) e a Home ("Painel vivo") mostram.
//
// De onde vêm as contas: são as MESMAS da tela de Relatórios
// (relatorioController) e de Comissões (comissaoController), reescritas aqui em
// funções separadas por cartão. Um teste de regressão (test/gestao-b4.test.js)
// roda o Relatórios atual e estas funções sobre os mesmos dados, em 3 períodos,
// e exige números iguais (critério 10). Enquanto as duas telas existirem, quem
// mudar uma conta muda nas duas, ou o teste quebra.
//
// Regras que valem para TODAS as métricas:
//  - Dinheiro sempre em CENTAVOS (inteiro). Quem formata é a tela.
//  - Faturamento, atendimentos e ticket contam por `concluidoEm` (decisão de
//    2026-08-16); ocupação e horas livres contam por `data` (quando o barbeiro
//    esteve ocupado).
//  - Escopo (R3): `ctx.usuarioId` preenchido = só os dados daquele barbeiro.
//    Quem decide o escopo é a rota (permissões), nunca a tela.
//  - Cache em memória de 60 s por (barbearia, métrica, escopo, filtros, período).
const prisma = require('../config/db');
const { paraMinutos, duracaoComEncaixe } = require('./disponibilidade');
const { INATIVOS } = require('../config/statusAgendamento');
const { COMISSAO_PRODUTO_PERCENTUAL } = require('../config/constantes');

const DIA_MS = 86400000;
const DATA_OK = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS_PERIODO = 731; // ~2 anos: acima disso a consulta vira relatório, não cartão

// ---------------------------------------------------------------- datas ----
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dataLocal(s) {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d);
}
function inicioDoDia(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function fmtDataBR(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function dataValida(s) {
  return DATA_OK.test(String(s || '')) && !isNaN(dataLocal(s).getTime());
}

// Período: a MESMA regra do Relatórios (hoje / semana começando na segunda /
// mês / ano / personalizado com De e Até) + o período anterior de mesma
// duração para a comparação. `?de=&ate=` sem `periodo` vale como personalizado.
function resolverPeriodo(q = {}, agora = new Date()) {
  const hoje0 = inicioDoDia(agora);
  let chave = ['hoje', 'semana', 'mes', 'ano', 'custom'].includes(q.periodo) ? q.periodo : null;
  if (!chave && q.de && q.ate) chave = 'custom';
  if (!chave) chave = 'mes';
  let inicio;
  let fimExcl;
  let rotulo;
  if (chave === 'custom' && dataValida(q.de) && dataValida(q.ate)) {
    let de = q.de;
    let ate = q.ate;
    if (de > ate) [de, ate] = [ate, de];
    inicio = dataLocal(de);
    fimExcl = dataLocal(ate);
    fimExcl.setDate(fimExcl.getDate() + 1);
    if ((fimExcl - inicio) / DIA_MS > MAX_DIAS_PERIODO) {
      const e = new Error('Período maior que 2 anos.');
      e.status = 400;
      throw e;
    }
    rotulo = fmtDataBR(inicio) + ' – ' + fmtDataBR(new Date(fimExcl.getTime() - DIA_MS));
  } else if (chave === 'hoje') {
    inicio = new Date(hoje0);
    fimExcl = new Date(hoje0);
    fimExcl.setDate(fimExcl.getDate() + 1);
    rotulo = 'Hoje';
  } else if (chave === 'semana') {
    inicio = new Date(hoje0);
    inicio.setDate(hoje0.getDate() - ((hoje0.getDay() + 6) % 7));
    fimExcl = new Date(inicio);
    fimExcl.setDate(inicio.getDate() + 7);
    rotulo = 'Esta semana';
  } else if (chave === 'ano') {
    inicio = new Date(hoje0.getFullYear(), 0, 1);
    fimExcl = new Date(hoje0.getFullYear() + 1, 0, 1);
    rotulo = 'Este ano';
  } else {
    chave = 'mes';
    inicio = new Date(hoje0.getFullYear(), hoje0.getMonth(), 1);
    fimExcl = new Date(hoje0.getFullYear(), hoje0.getMonth() + 1, 1);
    rotulo = 'Este mês';
  }
  const duracaoMs = fimExcl.getTime() - inicio.getTime();
  const anterior = { inicio: new Date(inicio.getTime() - duracaoMs), fimExcl: new Date(inicio) };
  return {
    chave,
    inicio,
    fimExcl,
    rotulo,
    de: iso(inicio),
    ate: iso(new Date(fimExcl.getTime() - DIA_MS)),
    anterior: { ...anterior, de: iso(anterior.inicio), ate: iso(new Date(anterior.fimExcl.getTime() - DIA_MS)) },
  };
}

function variacaoPct(atual, anterior) {
  if (anterior <= 0) return null;
  return Math.round(((atual - anterior) / anterior) * 100);
}
function pctDe(parte, todo) {
  return todo > 0 ? Math.round((parte / todo) * 100) : 0;
}

// Baldes do gráfico: por dia até 62 dias; acima disso, por mês.
function baldes(inicio, fimExcl) {
  const dias = Math.round((fimExcl - inicio) / DIA_MS);
  const lista = [];
  if (dias <= 62) {
    for (let d = new Date(inicio); d < fimExcl; d.setDate(d.getDate() + 1)) {
      const fim = new Date(d);
      fim.setDate(fim.getDate() + 1);
      lista.push({ chave: iso(d), inicio: new Date(d), fimExcl: fim });
    }
    return { unidade: 'dia', lista };
  }
  for (let d = new Date(inicio.getFullYear(), inicio.getMonth(), 1); d < fimExcl; d.setMonth(d.getMonth() + 1)) {
    const ini = d < inicio ? new Date(inicio) : new Date(d);
    const fim = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    lista.push({ chave: iso(ini).slice(0, 7), inicio: ini, fimExcl: fim > fimExcl ? new Date(fimExcl) : fim });
  }
  return { unidade: 'mes', lista };
}
function indiceBalde(b, data) {
  const t = new Date(data).getTime();
  for (let i = 0; i < b.lista.length; i++) if (t >= b.lista[i].inicio.getTime() && t < b.lista[i].fimExcl.getTime()) return i;
  return -1;
}

// ---------------------------------------------------------------- cache ----
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 1000;
const cache = new Map();
function cacheLer(chave, agora = Date.now()) {
  const c = cache.get(chave);
  if (!c) return undefined;
  if (c.exp <= agora) {
    cache.delete(chave);
    return undefined;
  }
  return c.valor;
}
function cacheGravar(chave, valor, agora = Date.now()) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // sai o mais antigo
  cache.set(chave, { exp: agora + CACHE_TTL_MS, valor });
}
// Depois de concluir/cancelar/lançar, a Home não pode mostrar o número velho
// por um minuto: quem grava chama isto e a barbearia volta a calcular.
// A versão por barbearia deixa outros caches (ex.: a Home) saberem que algo mudou.
const versoes = new Map();
function versaoCache(barbeariaId) {
  return versoes.get(barbeariaId) || 0;
}
function invalidar(barbeariaId) {
  const pref = barbeariaId + '|';
  for (const k of Array.from(cache.keys())) if (k.startsWith(pref)) cache.delete(k);
  versoes.set(barbeariaId, versaoCache(barbeariaId) + 1);
}
function limparCache() {
  cache.clear();
  versoes.clear();
}

// Memória da requisição: várias métricas pedem a mesma lista (ex.: a Home).
function memo(ctx, chave, fn) {
  if (!ctx._memo) ctx._memo = new Map();
  if (!ctx._memo.has(chave)) ctx._memo.set(chave, fn());
  return ctx._memo.get(chave);
}

// ------------------------------------------------------------- consultas ---
const filtroU = (ctx) => (ctx.usuarioId ? { usuarioId: ctx.usuarioId } : {});

function caixaDoPeriodo(ctx, inicio, fimExcl) {
  return memo(ctx, 'caixa|' + inicio.getTime() + '|' + fimExcl.getTime(), () =>
    prisma.caixa.findMany({ where: { barbeariaId: ctx.barbeariaId, data: { gte: inicio, lt: fimExcl } }, include: { categoria: true } })
  );
}

function concluidosDoPeriodo(ctx, inicio, fimExcl) {
  return memo(ctx, 'conc|' + inicio.getTime() + '|' + fimExcl.getTime(), () =>
    prisma.agendamento.findMany({
      where: { barbeariaId: ctx.barbeariaId, status: 'concluido', concluidoEm: { gte: inicio, lt: fimExcl }, ...filtroU(ctx) },
      include: {
        usuario: { select: { id: true, nome: true, comissaoPercentual: true } },
        itens: { include: { servico: true } },
        clientePlano: { include: { plano: true } },
      },
      orderBy: [{ concluidoEm: 'desc' }, { horaInicio: 'desc' }],
    })
  );
}

function contarConcluidos(ctx, inicio, fimExcl) {
  return prisma.agendamento.count({
    where: { barbeariaId: ctx.barbeariaId, status: 'concluido', concluidoEm: { gte: inicio, lt: fimExcl }, ...filtroU(ctx) },
  });
}

// Faturamento do período no escopo:
//  - barbearia toda: entradas do CAIXA (igual ao Relatórios; inclui venda de
//    plano e entrada manual);
//  - um barbeiro: soma do valor dos atendimentos DELE concluídos (o caixa não
//    tem barbeiro). `fonte` diz qual das duas foi usada.
async function faturamentoTotal(ctx, inicio, fimExcl) {
  if (ctx.usuarioId) {
    const ags = await prisma.agendamento.findMany({
      where: { barbeariaId: ctx.barbeariaId, status: 'concluido', concluidoEm: { gte: inicio, lt: fimExcl }, usuarioId: ctx.usuarioId },
      select: { valorTotal: true, concluidoEm: true },
    });
    return { fonte: 'atendimentos', total: ags.reduce((s, a) => s + a.valorTotal, 0), linhas: ags.map((a) => ({ valor: a.valorTotal, data: a.concluidoEm })) };
  }
  const lanc = await caixaDoPeriodo(ctx, inicio, fimExcl);
  const entradas = lanc.filter((l) => l.tipo === 'entrada');
  return { fonte: 'caixa', total: entradas.reduce((s, l) => s + l.valor, 0), linhas: entradas.map((l) => ({ valor: l.valor, data: l.data })) };
}

function serie(b, linhas) {
  const valores = b.lista.map(() => 0);
  for (const l of linhas) {
    const i = indiceBalde(b, l.data);
    if (i >= 0) valores[i] += l.valor;
  }
  return valores;
}

function itensCobrados(ag) {
  return ag.itens.map((it) => ({ servico: it.servico, quantidade: it.quantidade, valor: it.valorUnitario * it.quantidade }));
}

// ---------------------------------------------------------------- G1 -------
async function faturamento(ctx, p, { detalhe } = {}) {
  const [atual, ant] = await Promise.all([faturamentoTotal(ctx, p.inicio, p.fimExcl), faturamentoTotal(ctx, p.anterior.inicio, p.anterior.fimExcl)]);
  const resumo = { total: atual.total, anterior: ant.total, variacaoPct: variacaoPct(atual.total, ant.total), fonte: atual.fonte };
  const b = baldes(p.inicio, p.fimExcl);
  const bAnt = baldes(p.anterior.inicio, p.anterior.fimExcl);
  const valores = serie(b, atual.linhas);
  const valoresAnt = serie(bAnt, ant.linhas);
  resumo.serie = valores; // minigráfico do cartão
  if (!detalhe) return { resumo };
  const ags = await concluidosDoPeriodo(ctx, p.inicio, p.fimExcl);
  let servicosValor = 0;
  let produtosValor = 0;
  for (const ag of ags) for (const it of itensCobrados(ag)) (it.servico.ehProduto ? (produtosValor += it.valor) : (servicosValor += it.valor));
  return {
    resumo,
    detalhe: {
      unidade: b.unidade,
      barras: b.lista.map((x, i) => ({ chave: x.chave, valor: valores[i], anterior: valoresAnt[i] != null ? valoresAnt[i] : null })),
      servicosValor,
      produtosValor,
      atendimentos: ags.length,
    },
  };
}

// ---------------------------------------------------------------- G4 -------
async function atendimentos(ctx, p, { detalhe } = {}) {
  const [ags, anterior] = await Promise.all([concluidosDoPeriodo(ctx, p.inicio, p.fimExcl), contarConcluidos(ctx, p.anterior.inicio, p.anterior.fimExcl)]);
  const b = baldes(p.inicio, p.fimExcl);
  const qtd = serie(b, ags.map((a) => ({ valor: 1, data: a.concluidoEm })));
  const resumo = { total: ags.length, anterior, variacaoPct: variacaoPct(ags.length, anterior), serie: qtd };
  if (!detalhe) return { resumo };
  return { resumo, detalhe: { unidade: b.unidade, barras: b.lista.map((x, i) => ({ chave: x.chave, valor: qtd[i] })) } };
}

// ---------------------------------------------------------------- G3 -------
// Ticket = faturamento ÷ atendimentos concluídos (o Relatórios divide o CAIXA
// pelos atendimentos; no escopo de um barbeiro, o faturamento dele).
async function ticket(ctx, p, { detalhe } = {}) {
  const [fat, fatAnt, ags, qtdAnt] = await Promise.all([
    faturamentoTotal(ctx, p.inicio, p.fimExcl),
    faturamentoTotal(ctx, p.anterior.inicio, p.anterior.fimExcl),
    concluidosDoPeriodo(ctx, p.inicio, p.fimExcl),
    contarConcluidos(ctx, p.anterior.inicio, p.anterior.fimExcl),
  ]);
  const media = ags.length > 0 ? Math.round(fat.total / ags.length) : 0;
  const mediaAnt = qtdAnt > 0 ? Math.round(fatAnt.total / qtdAnt) : 0;
  const clientes = new Set(ags.filter((a) => a.clienteId).map((a) => a.clienteId));
  const porCliente = clientes.size > 0 ? Math.round(fat.total / clientes.size) : 0;
  const resumo = { valor: media, anterior: mediaAnt, variacaoPct: variacaoPct(media, mediaAnt), porCliente, fonte: fat.fonte };
  if (!detalhe) return { resumo };
  // Com produto x só serviço (mesma conta do Relatórios).
  let comQ = 0;
  let comV = 0;
  let semQ = 0;
  let semV = 0;
  for (const ag of ags) {
    if (ag.itens.some((it) => it.servico.ehProduto)) { comQ++; comV += ag.valorTotal; } else { semQ++; semV += ag.valorTotal; }
  }
  // Linha por dia: faturamento do dia ÷ atendimentos do dia.
  const b = baldes(p.inicio, p.fimExcl);
  const fatDia = serie(b, fat.linhas);
  const qtdDia = serie(b, ags.map((a) => ({ valor: 1, data: a.concluidoEm })));
  const detalheOut = {
    comProduto: { valor: comQ ? Math.round(comV / comQ) : 0, atendimentos: comQ },
    soServico: { valor: semQ ? Math.round(semV / semQ) : 0, atendimentos: semQ },
    unidade: b.unidade,
    linha: b.lista.map((x, i) => ({ chave: x.chave, valor: qtdDia[i] ? Math.round(fatDia[i] / qtdDia[i]) : null })),
  };
  if (ctx.podeVerEquipe && !ctx.usuarioId) detalheOut.porBarbeiro = porBarbeiroDe(ags).map((x) => ({ usuarioId: x.usuarioId, nome: x.nome, ticket: x.ticket, atendimentos: x.qtd }));
  return { resumo, detalhe: detalheOut };
}

// Faturamento e atendimentos por barbeiro, pela soma do valor dos atendimentos
// (igual ao "Desempenho por barbeiro" do Relatórios).
function porBarbeiroDe(ags) {
  const mapa = new Map();
  for (const ag of ags) {
    const k = ag.usuarioId;
    if (!mapa.has(k)) mapa.set(k, { usuarioId: k, nome: ag.usuario ? ag.usuario.nome : '—', valor: 0, qtd: 0 });
    const g = mapa.get(k);
    g.valor += ag.valorTotal;
    g.qtd += 1;
  }
  const lista = Array.from(mapa.values()).sort((a, b) => b.valor - a.valor);
  const max = Math.max(1, ...lista.map((x) => x.valor));
  return lista.map((x) => ({ ...x, pct: Math.round((x.valor / max) * 100), ticket: x.qtd > 0 ? Math.round(x.valor / x.qtd) : 0 }));
}

// ---------------------------------------------------------------- G2 -------
async function faturamentoPorBarbeiro(ctx, p) {
  const ags = await concluidosDoPeriodo(ctx, p.inicio, p.fimExcl);
  const lista = porBarbeiroDe(ags);
  return { resumo: { barbeiros: lista, total: lista.reduce((s, x) => s + x.valor, 0) } };
}

// ------------------------------------------------------------ G5 / G6 ------
function duracaoAgenda(ag, efetiva) {
  return duracaoComEncaixe(
    ag.itens.map((it) => ({ duracaoMin: it.servico.duracaoMin, ehEncaixe: it.servico.ehEncaixe, quantidade: it.quantidade })),
    { efetiva }
  );
}

// Ocupação = minutos atendidos ÷ minutos de jornada, só até hoje (a mesma
// conta do Relatórios: dias futuros não entram, bloqueios não descontam).
async function ocupacaoBase(ctx, inicio, fimExcl, agora = new Date()) {
  const b = ctx.barbeariaId;
  const [jornadas, equipe, ags] = await Promise.all([
    prisma.horarioTrabalho.findMany({ where: { barbeariaId: b, ...filtroU(ctx) } }),
    prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true, ...(ctx.usuarioId ? { id: ctx.usuarioId } : {}) }, select: { id: true, nome: true } }),
    prisma.agendamento.findMany({
      where: { barbeariaId: b, status: { notIn: INATIVOS }, data: { gte: inicio, lt: fimExcl }, ...filtroU(ctx) },
      select: { data: true, horaInicio: true, usuarioId: true, itens: { select: { quantidade: true, servico: { select: { duracaoMin: true, ehEncaixe: true } } } } },
    }),
  ]);
  const hoje0 = inicioDoDia(agora);
  const amanha0 = new Date(hoje0);
  amanha0.setDate(amanha0.getDate() + 1);
  const limite = new Date(Math.min(fimExcl.getTime(), amanha0.getTime()));
  const porBarbeiro = new Map();
  for (const u of equipe) porBarbeiro.set(u.id, { usuarioId: u.id, nome: u.nome, ocupado: 0, disponivel: 0 });
  for (let d = new Date(inicio); d < limite; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const j of jornadas) {
      if (j.diaSemana !== dow || !j.trabalha) continue;
      const alvo = porBarbeiro.get(j.usuarioId);
      if (alvo) alvo.disponivel += Math.max(0, paraMinutos(j.horaFim) - paraMinutos(j.horaInicio));
    }
  }
  for (const ag of ags) {
    const alvo = porBarbeiro.get(ag.usuarioId);
    if (alvo) alvo.ocupado += duracaoAgenda(ag, false);
  }
  let ocupado = 0;
  let disponivel = 0;
  for (const m of porBarbeiro.values()) {
    ocupado += m.ocupado;
    disponivel += m.disponivel;
  }
  return { jornadas, ags, porBarbeiro, ocupado, disponivel, pct: pctDe(ocupado, disponivel) };
}

async function ocupacao(ctx, p, { detalhe, agora } = {}) {
  const [base, ant] = await Promise.all([ocupacaoBase(ctx, p.inicio, p.fimExcl, agora), ocupacaoBase(ctx, p.anterior.inicio, p.anterior.fimExcl, agora)]);
  const resumo = {
    pct: base.pct,
    anteriorPct: ant.pct,
    variacaoPontos: ant.disponivel > 0 ? base.pct - ant.pct : null,
    horasAtendidas: Math.round(base.ocupado / 60),
    horasLivres: Math.max(0, Math.round((base.disponivel - base.ocupado) / 60)),
  };
  if (!detalhe) return { resumo };
  // Mapa de calor 7 x horas (segunda primeiro), faixa de horas tirada das jornadas.
  let horaMin = 9;
  let horaMax = 20;
  if (base.jornadas.length) {
    horaMin = Math.floor(Math.min(...base.jornadas.map((j) => paraMinutos(j.horaInicio))) / 60);
    horaMax = Math.ceil(Math.max(...base.jornadas.map((j) => paraMinutos(j.horaFim))) / 60);
  }
  if (horaMax - horaMin > 14) horaMax = horaMin + 14;
  const horas = [];
  for (let h = horaMin; h < horaMax; h++) horas.push(h);
  const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const contagem = dias.map(() => horas.map(() => 0));
  const porDiaSemana = dias.map(() => 0);
  const porHora = horas.map(() => 0);
  for (const ag of base.ags) {
    const di = (new Date(ag.data).getDay() + 6) % 7;
    porDiaSemana[di]++;
    const hi = horas.indexOf(Math.floor(paraMinutos(ag.horaInicio) / 60));
    if (hi !== -1) {
      contagem[di][hi]++;
      porHora[hi]++;
    }
  }
  const out = {
    mapaCalor: { dias, horas: horas.map((h) => h + 'h'), contagem },
    porDiaSemana: dias.map((d, i) => ({ dia: d, atendimentos: porDiaSemana[i] })),
    porHora: horas.map((h, i) => ({ hora: h + 'h', atendimentos: porHora[i] })),
  };
  if (ctx.podeVerEquipe && !ctx.usuarioId) {
    out.porBarbeiro = Array.from(base.porBarbeiro.values())
      .filter((m) => m.disponivel > 0 || m.ocupado > 0)
      .map((m) => ({ usuarioId: m.usuarioId, nome: m.nome, pct: pctDe(m.ocupado, m.disponivel), horasAtendidas: Math.round(m.ocupado / 60), horasJornada: Math.round(m.disponivel / 60) }))
      .sort((a, b) => b.pct - a.pct);
  }
  return { resumo, detalhe: out };
}

// Junta intervalos [ini, fim] que se sobrepõem.
function unir(intervalos) {
  const ord = intervalos.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of ord) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
function sobreposicao(a, b, intervalos) {
  let s = 0;
  for (const [x, y] of intervalos) s += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return s;
}

// G6 — horas livres por faixa de hora (o histograma da direção C). Para cada
// barbeiro no escopo e cada dia: jornada menos atendimentos ativos menos
// bloqueios. Hoje só conta o que ainda não passou. Até 14 dias por consulta.
async function horasLivres(ctx, p, { agora = new Date() } = {}) {
  const b = ctx.barbeariaId;
  // Dia que já passou não tem hora livre a oferecer: começa hoje (ou no início
  // do período, se for futuro) e olha no máximo 14 dias.
  const ini = new Date(Math.max(p.inicio.getTime(), inicioDoDia(agora).getTime()));
  const fim = new Date(Math.max(ini.getTime(), Math.min(p.fimExcl.getTime(), ini.getTime() + 14 * DIA_MS)));
  const [jornadas, equipe, ags, bloqueios] = await Promise.all([
    prisma.horarioTrabalho.findMany({ where: { barbeariaId: b, trabalha: true, ...filtroU(ctx) } }),
    prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true, ...(ctx.usuarioId ? { id: ctx.usuarioId } : {}) }, select: { id: true, nome: true } }),
    prisma.agendamento.findMany({
      where: { barbeariaId: b, status: { notIn: INATIVOS }, data: { gte: ini, lt: fim }, ...filtroU(ctx) },
      select: { data: true, horaInicio: true, usuarioId: true, itens: { select: { quantidade: true, servico: { select: { duracaoMin: true, ehEncaixe: true } } } } },
    }),
    prisma.bloqueio.findMany({ where: { barbeariaId: b, data: { gte: ini, lt: fim }, ...filtroU(ctx) } }),
  ]);
  const ativos = new Map(equipe.map((u) => [u.id, u.nome]));
  const hoje0 = inicioDoDia(agora).getTime();
  const minAgora = agora.getHours() * 60 + agora.getMinutes();
  const porHora = new Map(); // hora -> { livresMin, jornadaMin }
  const porBarbeiro = new Map();
  let livresTotal = 0;
  for (let d = new Date(ini); d < fim; d.setDate(d.getDate() + 1)) {
    const t = d.getTime();
    const dow = d.getDay();
    for (const j of jornadas) {
      if (j.diaSemana !== dow || !ativos.has(j.usuarioId)) continue;
      const ini = paraMinutos(j.horaInicio);
      const fimJ = paraMinutos(j.horaFim);
      const ocup = unir([
        ...ags.filter((a) => a.usuarioId === j.usuarioId && new Date(a.data).getTime() === t).map((a) => {
          const i = paraMinutos(a.horaInicio);
          return [i, i + duracaoAgenda(a, true)];
        }),
        ...bloqueios.filter((x) => x.usuarioId === j.usuarioId && new Date(x.data).getTime() === t).map((x) => [paraMinutos(x.horaInicio), paraMinutos(x.horaFim)]),
      ]);
      for (let h = Math.floor(ini / 60); h * 60 < fimJ; h++) {
        let a = Math.max(h * 60, ini);
        const z = Math.min(h * 60 + 60, fimJ);
        if (t === hoje0) a = Math.max(a, minAgora);
        if (z <= a) continue;
        const livres = z - a - sobreposicao(a, z, ocup);
        const reg = porHora.get(h) || { livresMin: 0, jornadaMin: 0 };
        reg.livresMin += livres;
        reg.jornadaMin += z - a;
        porHora.set(h, reg);
        livresTotal += livres;
        if (!porBarbeiro.has(j.usuarioId)) porBarbeiro.set(j.usuarioId, { usuarioId: j.usuarioId, nome: ativos.get(j.usuarioId), livresMin: 0 });
        porBarbeiro.get(j.usuarioId).livresMin += livres;
      }
    }
  }
  const horas = Array.from(porHora.keys()).sort((x, y) => x - y);
  const resumo = {
    livresMin: livresTotal,
    horasLivres: Math.round((livresTotal / 60) * 10) / 10,
    histograma: horas.map((h) => ({ hora: String(h).padStart(2, '0') + 'h', livresMin: porHora.get(h).livresMin, jornadaMin: porHora.get(h).jornadaMin })),
    de: iso(ini),
    ate: fim > ini ? iso(new Date(fim.getTime() - DIA_MS)) : iso(ini),
  };
  const out = { resumo };
  if (ctx.podeVerEquipe && !ctx.usuarioId) out.detalhe = { porBarbeiro: Array.from(porBarbeiro.values()).sort((a, b) => b.livresMin - a.livresMin) };
  return out;
}

// ---------------------------------------------------------------- G7 -------
async function equipe(ctx, p) {
  const ags = await concluidosDoPeriodo(ctx, p.inicio, p.fimExcl);
  const [ocup, comissoes] = await Promise.all([
    ocupacaoBase(ctx, p.inicio, p.fimExcl),
    ctx.verComissaoDeTodos ? calcularComissoes(ctx, p.inicio, p.fimExcl) : Promise.resolve(null),
  ]);
  const lista = porBarbeiroDe(ags);
  const comPorU = new Map((comissoes || []).map((c) => [c.usuarioId, c.comissao]));
  const linhas = lista.map((x) => {
    const o = ocup.porBarbeiro.get(x.usuarioId);
    const l = { usuarioId: x.usuarioId, nome: x.nome, faturamento: x.valor, atendimentos: x.qtd, ticket: x.ticket, ocupacaoPct: o && o.disponivel > 0 ? pctDe(o.ocupado, o.disponivel) : null };
    if (comissoes) l.comissao = comPorU.get(x.usuarioId) || 0;
    return l;
  });
  return { resumo: { barbeiros: linhas } };
}

// ------------------------------------------------------------ G8 / G9 ------
function vendasPorItem(ags) {
  const porItem = new Map();
  for (const ag of ags) {
    for (const it of itensCobrados(ag)) {
      const k = it.servico.id;
      if (!porItem.has(k)) porItem.set(k, { servicoId: k, nome: it.servico.nome, ehProduto: !!it.servico.ehProduto, valor: 0, qtd: 0 });
      const r = porItem.get(k);
      r.valor += it.valor;
      r.qtd += it.quantidade;
    }
  }
  return Array.from(porItem.values()).sort((a, b) => b.valor - a.valor);
}
async function maisVendidos(ctx, p, produto, { detalhe } = {}) {
  const ags = await concluidosDoPeriodo(ctx, p.inicio, p.fimExcl);
  const itens = vendasPorItem(ags).filter((x) => x.ehProduto === produto);
  const total = itens.reduce((s, x) => s + x.valor, 0);
  const qtd = itens.reduce((s, x) => s + x.qtd, 0);
  const lista = itens.map((x) => ({ servicoId: x.servicoId, nome: x.nome, valor: x.valor, qtd: x.qtd, pct: pctDe(x.valor, total) }));
  return { resumo: { total, qtd, top: lista.slice(0, 5) }, ...(detalhe ? { detalhe: { itens: lista } } : {}) };
}

// --------------------------------------------------------------- G10 -------
// Novo = o 1º atendimento concluído do cliente (em toda a barbearia, de todos
// os tempos) caiu dentro do período; recorrente = já tinha vindo antes.
async function clientes(ctx, p, { detalhe } = {}) {
  const ags = await concluidosDoPeriodo(ctx, p.inicio, p.fimExcl);
  const receita = new Map();
  const visitas = new Map();
  const primeiraNoPeriodo = new Map();
  for (const ag of ags) {
    if (!ag.clienteId) continue;
    receita.set(ag.clienteId, (receita.get(ag.clienteId) || 0) + ag.valorTotal);
    visitas.set(ag.clienteId, (visitas.get(ag.clienteId) || 0) + 1);
    const t = new Date(ag.concluidoEm).getTime();
    if (!primeiraNoPeriodo.has(ag.clienteId) || t < primeiraNoPeriodo.get(ag.clienteId)) primeiraNoPeriodo.set(ag.clienteId, t);
  }
  const ids = Array.from(receita.keys());
  const primeiros = ids.length
    ? await prisma.agendamento.groupBy({ by: ['clienteId'], where: { barbeariaId: ctx.barbeariaId, status: 'concluido', clienteId: { in: ids } }, _min: { data: true } })
    : [];
  const primeiraData = new Map(primeiros.map((g) => [g.clienteId, g._min.data]));
  let novos = 0;
  let recorrentes = 0;
  let receitaNovos = 0;
  let receitaRecorrentes = 0;
  const novoDe = new Map();
  for (const id of ids) {
    const d = primeiraData.get(id);
    const ehNovo = !!d && d >= p.inicio && d < p.fimExcl;
    novoDe.set(id, ehNovo);
    if (ehNovo) { novos++; receitaNovos += receita.get(id); } else { recorrentes++; receitaRecorrentes += receita.get(id); }
  }
  const total = novos + recorrentes;
  const novosPct = pctDe(novos, Math.max(1, total));
  let voltaram = 0;
  for (const n of visitas.values()) if (n >= 2) voltaram++;
  const resumo = { novos, recorrentes, total, novosPct, recorrentesPct: total > 0 ? 100 - novosPct : 0, receitaNovos, receitaRecorrentes, unicos: ids.length, visitas: ags.length, voltaramNoPeriodo: voltaram };
  if (!detalhe) return { resumo };
  // Barra empilhada por semana (segunda a domingo), pela 1ª visita no período.
  const semanas = [];
  const seg = new Date(p.inicio);
  seg.setDate(seg.getDate() - ((seg.getDay() + 6) % 7));
  for (let d = new Date(seg); d < p.fimExcl; d.setDate(d.getDate() + 7)) semanas.push({ inicio: iso(d), t: d.getTime(), novos: 0, recorrentes: 0 });
  for (const id of ids) {
    const t = primeiraNoPeriodo.get(id);
    let i = semanas.length - 1;
    while (i > 0 && semanas[i].t > t) i--;
    if (semanas[i]) semanas[i][novoDe.get(id) ? 'novos' : 'recorrentes']++;
  }
  return { resumo, detalhe: { semanas: semanas.map(({ t, ...s }) => s) } };
}

// --------------------------------------------------------------- G16 -------
const FORMAS = [
  { forma: 'pix', label: 'Pix', naHora: true },
  { forma: 'credito', label: 'Crédito', naHora: false },
  { forma: 'debito', label: 'Débito', naHora: false },
  { forma: 'dinheiro', label: 'Dinheiro', naHora: true },
];
async function pagamentos(ctx, p) {
  let linhas; // { forma, valor }
  if (ctx.usuarioId) {
    // Barbeiro: o caixa não tem barbeiro; usa a divisão gravada no atendimento.
    const ags = await concluidosDoPeriodo(ctx, p.inicio, p.fimExcl);
    const ids = ags.map((a) => a.id);
    const partes = ids.length ? await prisma.pagamentoAgendamento.findMany({ where: { agendamentoId: { in: ids } } }) : [];
    const comPartes = new Set(partes.map((x) => x.agendamentoId));
    linhas = partes.map((x) => ({ forma: x.formaPagamento, valor: x.valor }));
    for (const a of ags) if (!comPartes.has(a.id) && a.formaPagamento) linhas.push({ forma: a.formaPagamento, valor: a.valorTotal });
  } else {
    const lanc = await caixaDoPeriodo(ctx, p.inicio, p.fimExcl);
    linhas = lanc.filter((l) => l.tipo === 'entrada' && l.formaPagamento).map((l) => ({ forma: l.formaPagamento, valor: l.valor }));
  }
  const total = linhas.reduce((s, l) => s + l.valor, 0);
  const formas = FORMAS.map((f) => {
    const doGrupo = linhas.filter((l) => l.forma === f.forma);
    const valor = doGrupo.reduce((s, l) => s + l.valor, 0);
    return { forma: f.forma, label: f.label, naHora: f.naHora, valor, qtd: doGrupo.length, pct: pctDe(valor, total), ticket: doGrupo.length ? Math.round(valor / doGrupo.length) : 0 };
  }).filter((f) => f.valor > 0).sort((a, b) => b.valor - a.valor);
  const naHora = formas.filter((f) => f.naHora).reduce((s, f) => s + f.valor, 0);
  return { resumo: { total, transacoes: linhas.length, formas, naHoraValor: naHora, depoisValor: total - naHora, naHoraPct: pctDe(naHora, total) } };
}

// --------------------------------------------------------------- G17 -------
// Metas são sempre do MÊS corrente (regra do metaController), seja qual for o
// período escolhido. Quem vê quais: dele (meus_numeros), da barbearia
// (numeros_barbearia/admin), dos outros barbeiros (ranking/admin).
async function metas(ctx) {
  const metaCtrl = require('../controllers/metaController');
  const where = { barbeariaId: ctx.barbeariaId };
  const todas = await prisma.meta.findMany({ where, include: { usuario: { select: { id: true, nome: true } } }, orderBy: { criadoEm: 'asc' } });
  const visiveis = todas.filter((m) => {
    // Filtro por barbeiro (já autorizado no contexto): só as metas dele.
    if (ctx.filtroBarbeiro != null) return m.usuarioId === ctx.filtroBarbeiro;
    if (m.usuarioId == null) return ctx.verBarbearia;
    if (m.usuarioId === ctx.eu) return ctx.verMeus;
    return ctx.podeVerEquipe;
  });
  if (!visiveis.length) return { resumo: { metas: [] } };
  const ap = await metaCtrl.apurar(ctx.barbeariaId);
  return {
    resumo: {
      metas: visiveis.map((m) => {
        const conf = metaCtrl.METRICAS[m.metrica] || { label: m.metrica, dinheiro: false };
        const atual = metaCtrl.atualDe(m, ap);
        return {
          id: m.id, metrica: m.metrica, label: conf.label, dinheiro: !!conf.dinheiro,
          escopo: m.usuario ? { usuarioId: m.usuario.id, nome: m.usuario.nome } : null,
          alvo: m.alvo, atual, pct: m.alvo > 0 ? Math.min(100, Math.round((atual / m.alvo) * 100)) : 0, batida: m.alvo > 0 && atual >= m.alvo,
        };
      }),
    },
  };
}

// --------------------------------------------------------------- G18 -------
async function lucro(ctx, p, { detalhe } = {}) {
  const [lanc, lancAnt] = await Promise.all([caixaDoPeriodo(ctx, p.inicio, p.fimExcl), caixaDoPeriodo(ctx, p.anterior.inicio, p.anterior.fimExcl)]);
  const soma = (l) => l.reduce((acc, x) => { if (x.tipo === 'entrada') acc.entrou += x.valor; else acc.saiu += x.valor; return acc; }, { entrou: 0, saiu: 0 });
  const r = soma(lanc);
  const ra = soma(lancAnt);
  const lucroV = r.entrou - r.saiu;
  const lucroAnt = ra.entrou - ra.saiu;
  const ags = await contarConcluidos(ctx, p.inicio, p.fimExcl);
  const ticketMedio = ags > 0 ? Math.round(r.entrou / ags) : 0;
  const resumo = {
    faturamento: r.entrou, gastos: r.saiu, lucro: lucroV, anterior: lucroAnt, variacaoPct: variacaoPct(lucroV, lucroAnt),
    margemPct: pctDe(Math.max(0, lucroV), r.entrou), gastosPctFat: pctDe(r.saiu, r.entrou),
    pontoEquilibrio: ticketMedio > 0 ? Math.ceil(r.saiu / ticketMedio) : null,
  };
  if (!detalhe) return { resumo };
  const cat = new Map();
  for (const l of lanc) {
    if (l.tipo !== 'saida') continue;
    const nome = l.categoria ? l.categoria.nome : String(l.descricao || '').trim() || 'Sem descrição';
    const k = nome.toLowerCase();
    if (!cat.has(k)) cat.set(k, { nome, valor: 0, lancamentos: [] });
    const g = cat.get(k);
    g.valor += l.valor;
    g.lancamentos.push({ descricao: l.descricao, valor: l.valor, data: iso(new Date(l.data)) });
  }
  const gastos = Array.from(cat.values()).sort((a, b) => b.valor - a.valor).map((g) => ({
    nome: g.nome, valor: g.valor, pct: pctDe(g.valor, r.saiu), qtd: g.lancamentos.length,
    lancamentos: g.lancamentos.sort((a, b) => b.valor - a.valor).slice(0, 6),
  }));
  let resta = r.entrou;
  const cascata = [{ label: 'Faturamento', valor: r.entrou, resta: r.entrou }];
  for (const g of gastos) {
    resta -= g.valor;
    cascata.push({ label: g.nome, valor: -g.valor, resta });
  }
  return { resumo, detalhe: { gastos, cascata } };
}

// --------------------------------------------------------------- G19 -------
const ORIGENS = { publico: 'Link de agendamento', app: 'App do cliente', whatsapp: 'WhatsApp (secretária)', barbeiro: 'Balcão (equipe)', anterior: 'Sem registro' };
async function origem(ctx, p) {
  const ags = await prisma.agendamento.findMany({
    where: { barbeariaId: ctx.barbeariaId, data: { gte: p.inicio, lt: p.fimExcl }, ...filtroU(ctx) },
    select: { origem: true, status: true },
  });
  const mapa = new Map();
  for (const a of ags) {
    const k = ORIGENS[a.origem] ? a.origem : 'anterior';
    if (!mapa.has(k)) mapa.set(k, { origem: k, label: ORIGENS[k], total: 0, concluidos: 0, cancelados: 0, faltas: 0 });
    const g = mapa.get(k);
    g.total++;
    if (a.status === 'concluido') g.concluidos++;
    else if (a.status === 'cancelado') g.cancelados++;
    else if (a.status === 'faltou') g.faltas++;
  }
  const lista = Array.from(mapa.values()).sort((a, b) => b.total - a.total).map((g) => ({ ...g, pct: pctDe(g.total, ags.length) }));
  return { resumo: { total: ags.length, origens: lista } };
}

// --------------------------------------------------------------- G20 -------
async function planos(ctx, p, { agora = new Date() } = {}) {
  const b = ctx.barbeariaId;
  const [vendidos, ativos, usos] = await Promise.all([
    prisma.clientePlano.findMany({ where: { barbeariaId: b, criadoEm: { gte: p.inicio, lt: p.fimExcl } }, include: { plano: true } }),
    prisma.clientePlano.count({ where: { barbeariaId: b, ativo: true, dataFim: { gte: inicioDoDia(agora) } } }),
    prisma.agendamento.count({ where: { barbeariaId: b, status: 'concluido', concluidoEm: { gte: p.inicio, lt: p.fimExcl }, clientePlanoId: { not: null } } }),
  ]);
  const porPlano = new Map();
  for (const v of vendidos) {
    const k = v.planoId;
    if (!porPlano.has(k)) porPlano.set(k, { planoId: k, nome: v.plano ? v.plano.nome : '—', vendidos: 0, valor: 0 });
    const g = porPlano.get(k);
    g.vendidos++;
    g.valor += v.plano ? v.plano.valor : 0;
  }
  return {
    resumo: {
      vendidos: vendidos.length,
      valorVendido: vendidos.reduce((s, v) => s + (v.plano ? v.plano.valor : 0), 0),
      ativos,
      usosNoPeriodo: usos,
      planos: Array.from(porPlano.values()).sort((a, b) => b.vendidos - a.vendidos),
    },
  };
}

// ------------------------------------------------- lista do drill-down -----
// Barra -> dia -> lista de atendimentos -> atendimento. Sem telefone.
async function listaAtendimentos(ctx, p) {
  const ags = await concluidosDoPeriodo(ctx, p.inicio, p.fimExcl);
  return {
    resumo: {
      total: ags.length,
      atendimentos: ags.slice(0, 200).map((a) => ({
        id: a.id,
        data: iso(new Date(a.data)),
        hora: a.horaInicio,
        concluidoEm: a.concluidoEm,
        cliente: a.clienteNome,
        barbeiro: a.usuario ? { usuarioId: a.usuario.id, nome: a.usuario.nome } : null,
        servicos: a.itens.map((it) => it.servico.nome),
        valor: a.valorTotal,
        formaPagamento: a.formaPagamento || null,
        viaPlano: !!a.clientePlanoId,
      })),
    },
  };
}

// ------------------------------------------------ comissões (G15, B5) ------
// Mesma conta do comissaoController: serviços × % do barbeiro + produtos × %
// do produto; total ajustado à mão distribuído na proporção dos itens; plano
// conta o valor do plano UMA vez por assinatura no período.
async function calcularComissoes(ctx, inicio, fimExcl) {
  const b = ctx.barbeariaId;
  const barbeiros = await prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true, ...(ctx.usuarioId ? { id: ctx.usuarioId } : {}) }, orderBy: { id: 'asc' } });
  const ags = await prisma.agendamento.findMany({
    where: { barbeariaId: b, status: 'concluido', concluidoEm: { gte: inicio, lt: fimExcl }, ...filtroU(ctx) },
    include: { itens: { include: { servico: true } }, clientePlano: { include: { plano: true } } },
    orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
  });
  const mapa = new Map();
  for (const u of barbeiros) mapa.set(u.id, { barbeiro: u, servicosTotal: 0, produtosTotal: 0, comissaoProdutosTotal: 0, ocupadoMin: 0, qtd: 0 });
  const planosCreditados = new Set();
  for (const ag of ags) {
    const g = mapa.get(ag.usuarioId);
    if (!g) continue;
    let servicosSub = 0;
    let produtosSub = 0;
    if (ag.clientePlanoId && ag.clientePlano && ag.clientePlano.plano) {
      if (!planosCreditados.has(ag.clientePlanoId)) {
        servicosSub = ag.clientePlano.plano.valor;
        planosCreditados.add(ag.clientePlanoId);
      }
    } else {
      const somaItens = ag.itens.reduce((s, it) => s + it.valorUnitario * it.quantidade, 0);
      const ajustado = ag.totalManual && somaItens > 0;
      const fator = ajustado ? ag.valorTotal / somaItens : 1;
      let comProd = 0;
      for (const it of ag.itens) {
        const valor = Math.round(it.valorUnitario * it.quantidade * fator);
        if (it.servico.ehProduto) {
          produtosSub += valor;
          comProd += Math.round(valor * ((it.servico.comissaoPercentual ?? COMISSAO_PRODUTO_PERCENTUAL) / 100));
        } else servicosSub += valor;
      }
      if (ajustado) servicosSub += ag.valorTotal - (servicosSub + produtosSub);
      else if (ag.totalManual) servicosSub = ag.valorTotal;
      g.comissaoProdutosTotal += comProd;
    }
    g.servicosTotal += servicosSub;
    g.produtosTotal += produtosSub;
    g.ocupadoMin += duracaoAgenda(ag, false);
    g.qtd += 1;
  }
  // Disponibilidade com bloqueios descontados (igual à tela de Comissões).
  const [jornadas, bloqueios] = await Promise.all([
    prisma.horarioTrabalho.findMany({ where: { barbeariaId: b, ...filtroU(ctx) } }),
    prisma.bloqueio.findMany({ where: { barbeariaId: b, data: { gte: inicio, lt: fimExcl }, ...filtroU(ctx) } }),
  ]);
  const amanha = inicioDoDia(new Date());
  amanha.setDate(amanha.getDate() + 1);
  const limite = new Date(Math.min(fimExcl.getTime(), amanha.getTime()));
  const disp = new Map(barbeiros.map((u) => [u.id, 0]));
  for (let d = new Date(inicio); d < limite; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const u of barbeiros) {
      const j = jornadas.find((x) => x.usuarioId === u.id && x.diaSemana === dow);
      if (j && j.trabalha) disp.set(u.id, disp.get(u.id) + Math.max(0, paraMinutos(j.horaFim) - paraMinutos(j.horaInicio)));
    }
  }
  for (const bl of bloqueios) {
    if (bl.data < limite && disp.has(bl.usuarioId)) disp.set(bl.usuarioId, Math.max(0, disp.get(bl.usuarioId) - Math.max(0, paraMinutos(bl.horaFim) - paraMinutos(bl.horaInicio))));
  }
  return Array.from(mapa.values()).map((g) => {
    const pct = g.barbeiro.comissaoPercentual ?? 50;
    const comissaoServicos = Math.round(g.servicosTotal * (pct / 100));
    const faturadoTotal = g.servicosTotal + g.produtosTotal;
    const disponivelMin = disp.get(g.barbeiro.id) || 0;
    return {
      usuarioId: g.barbeiro.id,
      nome: g.barbeiro.nome,
      comissaoPercentual: pct,
      servicosTotal: g.servicosTotal,
      produtosTotal: g.produtosTotal,
      faturadoTotal,
      comissaoServicos,
      comissaoProdutos: g.comissaoProdutosTotal,
      comissao: comissaoServicos + g.comissaoProdutosTotal,
      atendimentos: g.qtd,
      ticketMedio: g.qtd > 0 ? Math.round(faturadoTotal / g.qtd) : 0,
      ocupacaoPct: disponivelMin > 0 ? Math.round((g.ocupadoMin / disponivelMin) * 100) : null,
    };
  });
}

// ------------------------------------------------------- B5: G11–G15 -------

// G11 — retenção por coorte: clientes cuja 1ª visita (de todos os tempos) caiu
// em cada um dos 12 meses até o fim do período, e quantos % voltaram em até
// 30, 60 e 90 dias. Conta pela data do atendimento. Só barbearia toda.
async function retencao(ctx, p, { agora = new Date() } = {}) {
  const b = ctx.barbeariaId;
  const fimRef = new Date(Math.min(p.fimExcl.getTime(), inicioDoDia(agora).getTime() + DIA_MS));
  const fimMes = new Date(fimRef.getFullYear(), fimRef.getMonth() + 1, 1);
  const iniJanela = new Date(fimMes.getFullYear(), fimMes.getMonth() - 12, 1);
  const primeiros = await prisma.agendamento.groupBy({
    by: ['clienteId'],
    where: { barbeariaId: b, status: 'concluido', clienteId: { not: null } },
    _min: { data: true },
  });
  const naJanela = primeiros.filter((g) => g._min.data && g._min.data >= iniJanela && g._min.data < fimMes);
  const ids = naJanela.map((g) => g.clienteId);
  const visitas = ids.length
    ? await prisma.agendamento.findMany({ where: { barbeariaId: b, status: 'concluido', clienteId: { in: ids } }, select: { clienteId: true, data: true } })
    : [];
  const porCliente = new Map();
  for (const v of visitas) {
    if (!porCliente.has(v.clienteId)) porCliente.set(v.clienteId, []);
    porCliente.get(v.clienteId).push(new Date(v.data).getTime());
  }
  const coortes = [];
  for (let d = new Date(iniJanela); d < fimMes; d.setMonth(d.getMonth() + 1)) {
    coortes.push({ mes: iso(d).slice(0, 7), t0: d.getTime(), clientes: 0, v30: 0, v60: 0, v90: 0, maduro30: 0, maduro60: 0, maduro90: 0 });
  }
  const hojeT = inicioDoDia(agora).getTime();
  for (const g of naJanela) {
    const t1 = new Date(g._min.data).getTime();
    let i = coortes.length - 1;
    while (i > 0 && coortes[i].t0 > t1) i--;
    const c = coortes[i];
    c.clientes++;
    const voltas = (porCliente.get(g.clienteId) || []).filter((t) => t > t1).sort((x, y) => x - y);
    const prox = voltas.length ? (voltas[0] - t1) / DIA_MS : null;
    for (const n of [30, 60, 90]) {
      // Só entra na conta quem já teve n dias para voltar.
      if (hojeT - t1 >= n * DIA_MS) {
        c['maduro' + n]++;
        if (prox != null && prox <= n) c['v' + n]++;
      }
    }
  }
  const pct = (a, b2) => (b2 > 0 ? Math.round((a / b2) * 100) : null);
  const soma = (k) => coortes.reduce((s, c) => s + c[k], 0);
  return {
    resumo: {
      clientes: naJanela.length,
      voltou30Pct: pct(soma('v30'), soma('maduro30')),
      voltou60Pct: pct(soma('v60'), soma('maduro60')),
      voltou90Pct: pct(soma('v90'), soma('maduro90')),
      coortes: coortes.map((c) => ({ mes: c.mes, clientes: c.clientes, voltou30Pct: pct(c.v30, c.maduro30), voltou60Pct: pct(c.v60, c.maduro60), voltou90Pct: pct(c.v90, c.maduro90) })),
    },
  };
}

// G12 — clientes sumidos: última visita concluída há mais de `dias` (padrão
// 45, de 15 a 365). Barbeiro: os que tiveram a última visita com ELE. Telefone
// e link do WhatsApp só com `clientes_contato`.
async function sumidos(ctx, p, { query = {}, agora = new Date() } = {}) {
  const b = ctx.barbeariaId;
  const dias = Math.min(365, Math.max(15, parseInt(query.dias, 10) || 45));
  const corte = inicioDoDia(agora);
  corte.setDate(corte.getDate() - dias);
  const ultimas = await prisma.agendamento.groupBy({
    by: ['clienteId'],
    where: { barbeariaId: b, status: 'concluido', clienteId: { not: null } },
    _max: { data: true },
    _count: { _all: true },
  });
  let alvo = ultimas.filter((g) => g._max.data && g._max.data < corte);
  if (!alvo.length) return { resumo: { dias, total: 0, clientes: [] } };
  // Quem atendeu na última visita (recorte do barbeiro e informação da tela).
  const ultimosAg = await prisma.agendamento.findMany({
    where: { barbeariaId: b, status: 'concluido', clienteId: { in: alvo.map((g) => g.clienteId) } },
    select: { clienteId: true, data: true, usuarioId: true },
    orderBy: [{ data: 'desc' }],
  });
  const quem = new Map();
  for (const a of ultimosAg) if (!quem.has(a.clienteId)) quem.set(a.clienteId, a.usuarioId);
  if (ctx.usuarioId) alvo = alvo.filter((g) => quem.get(g.clienteId) === ctx.usuarioId);
  const cadastros = await prisma.cliente.findMany({ where: { barbeariaId: b, id: { in: alvo.map((g) => g.clienteId) } }, select: { id: true, nome: true, telefone: true } });
  const cad = new Map(cadastros.map((c) => [c.id, c]));
  const verTel = ctx.verContato !== false;
  const hoje0 = inicioDoDia(agora);
  const lista = alvo
    .filter((g) => cad.has(g.clienteId))
    .map((g) => {
      const c = cad.get(g.clienteId);
      const tel = String(c.telefone || '').replace(/\D/g, '');
      return {
        clienteId: c.id,
        nome: c.nome,
        telefone: verTel ? c.telefone : '•••• ' + tel.slice(-4),
        whatsapp: verTel && tel ? 'https://wa.me/' + (tel.startsWith('55') ? tel : '55' + tel) : null,
        ultimaVisita: iso(new Date(g._max.data)),
        diasSemVir: Math.round((hoje0 - inicioDoDia(new Date(g._max.data))) / DIA_MS),
        visitas: g._count._all,
        ultimoBarbeiroId: quem.get(g.clienteId) || null,
      };
    })
    .sort((a, b2) => b2.diasSemVir - a.diasSemVir);
  return { resumo: { dias, total: lista.length, clientes: lista.slice(0, 100) } };
}

// G13 — cancelamentos do período (pela data do atendimento): número, % dos
// agendamentos do período, quem cancelou, motivos e antecedência média.
async function cancelamentos(ctx, p) {
  const ags = await prisma.agendamento.findMany({
    where: { barbeariaId: ctx.barbeariaId, data: { gte: p.inicio, lt: p.fimExcl }, ...filtroU(ctx) },
    select: { id: true, status: true, data: true, horaInicio: true, canceladoEm: true, canceladoPor: true, motivoCancelamento: true },
  });
  const canc = ags.filter((a) => a.status === 'cancelado');
  const porQuem = new Map();
  const motivos = new Map();
  let somaAntecedenciaH = 0;
  let comData = 0;
  for (const a of canc) {
    const q = a.canceladoPor || 'sem_registro';
    porQuem.set(q, (porQuem.get(q) || 0) + 1);
    const m = (a.motivoCancelamento || '').trim();
    if (m) motivos.set(m, (motivos.get(m) || 0) + 1);
    if (a.canceladoEm) {
      const ini = new Date(a.data);
      ini.setMinutes(paraMinutos(a.horaInicio));
      somaAntecedenciaH += (ini - new Date(a.canceladoEm)) / 3600000;
      comData++;
    }
  }
  return {
    resumo: {
      total: canc.length,
      agendamentos: ags.length,
      pct: pctDe(canc.length, ags.length),
      porQuem: Array.from(porQuem.entries()).map(([quem, total]) => ({ quem, total })).sort((a, b) => b.total - a.total),
      motivos: Array.from(motivos.entries()).map(([motivo, total]) => ({ motivo, total })).sort((a, b) => b.total - a.total).slice(0, 10),
      antecedenciaMediaHoras: comData ? Math.round(somaAntecedenciaH / comData) : null,
      semRegistro: canc.filter((a) => !a.canceladoEm).length, // cancelados antes da B3
    },
  };
}

// G14 — faltas (no-show): número, % dos atendimentos que deveriam ter
// acontecido (concluídos + faltas) e os clientes que mais faltaram (sem telefone).
async function faltas(ctx, p) {
  const ags = await prisma.agendamento.findMany({
    where: { barbeariaId: ctx.barbeariaId, data: { gte: p.inicio, lt: p.fimExcl }, status: { in: ['concluido', 'faltou'] }, ...filtroU(ctx) },
    select: { status: true, clienteId: true, clienteNome: true },
  });
  const f = ags.filter((a) => a.status === 'faltou');
  const porCliente = new Map();
  for (const a of f) {
    const k = a.clienteId ? 'c' + a.clienteId : 'n' + a.clienteNome;
    if (!porCliente.has(k)) porCliente.set(k, { clienteId: a.clienteId || null, nome: a.clienteNome, faltas: 0 });
    porCliente.get(k).faltas++;
  }
  return {
    resumo: {
      total: f.length,
      base: ags.length,
      pct: pctDe(f.length, ags.length),
      clientes: Array.from(porCliente.values()).sort((a, b) => b.faltas - a.faltas).slice(0, 10),
    },
  };
}

// G15 — comissões do período, o que já foi pago (ComissaoPagamento cujo
// período está DENTRO do período escolhido) e o que falta pagar.
// Barbeiro: só a dele. Admin: todos.
async function comissoes(ctx, p) {
  const calc = await calcularComissoes(ctx, p.inicio, p.fimExcl);
  const pagos = await prisma.comissaoPagamento.findMany({
    where: { barbeariaId: ctx.barbeariaId, periodoInicio: { gte: p.inicio }, periodoFim: { lt: p.fimExcl }, ...filtroU(ctx) },
    orderBy: { pagoEm: 'desc' },
  });
  const pagoPor = new Map();
  for (const x of pagos) pagoPor.set(x.usuarioId, (pagoPor.get(x.usuarioId) || 0) + x.valor);
  const barbeiros = calc
    .filter((c) => c.comissao > 0 || pagoPor.has(c.usuarioId) || ctx.usuarioId)
    .map((c) => {
      const pago = pagoPor.get(c.usuarioId) || 0;
      return { ...c, pago, aPagar: Math.max(0, c.comissao - pago), situacao: c.comissao > 0 && pago >= c.comissao ? 'paga' : pago > 0 ? 'parcial' : 'aberta' };
    });
  return {
    resumo: {
      total: barbeiros.reduce((s, x) => s + x.comissao, 0),
      pago: barbeiros.reduce((s, x) => s + x.pago, 0),
      aPagar: barbeiros.reduce((s, x) => s + x.aPagar, 0),
      barbeiros,
    },
    detalhe: {
      pagamentos: pagos.map((x) => ({
        id: x.id, usuarioId: x.usuarioId, de: iso(new Date(x.periodoInicio)), ate: iso(new Date(x.periodoFim)),
        valor: x.valor, valorCalculado: x.valorCalculado, pagoEm: x.pagoEm, pagoPorNome: x.pagoPorNome, observacao: x.observacao, caixaId: x.caixaId,
      })),
    },
  };
}

// ------------------------------------------------------------ catálogo -----
// Cada cartão: código da spec, função, o que libera e o plano. `acesso`:
//   'proprio'   -> qualquer um no próprio escopo (agenda própria: G4, G5, G6)
//   'numeros'   -> meus_numeros (escopo próprio) ou numeros_barbearia/admin
//   'barbearia' -> só barbearia toda: numeros_barbearia ou admin
//   'equipe'    -> números de cada barbeiro: ranking_equipe ou admin
//   'comissoes' -> a comissão (do próprio, ou de todos para admin)
//   'metas'     -> metas visíveis conforme as chaves
// `plano`: função do plano da Cortavo exigida (null = existe em todos).
const CARTOES = [
  { slug: 'faturamento', codigo: 'G1', titulo: 'Faturamento', acesso: 'numeros', plano: null, fn: faturamento },
  { slug: 'ocupacao', codigo: 'G5', titulo: 'Ocupação', acesso: 'proprio', plano: null, fn: ocupacao },
  { slug: 'horas-livres', codigo: 'G6', titulo: 'Horas livres', acesso: 'proprio', plano: null, fn: horasLivres },
  { slug: 'ticket', codigo: 'G3', titulo: 'Ticket médio', acesso: 'numeros', plano: 'relatorios', fn: ticket },
  { slug: 'atendimentos', codigo: 'G4', titulo: 'Atendimentos', acesso: 'proprio', plano: null, fn: atendimentos },
  { slug: 'equipe', codigo: 'G7', titulo: 'Equipe', acesso: 'equipe', plano: 'relatorios', fn: equipe },
  { slug: 'faturamento-barbeiros', codigo: 'G2', titulo: 'Faturamento por barbeiro', acesso: 'equipe', plano: 'relatorios', fn: faturamentoPorBarbeiro },
  { slug: 'servicos', codigo: 'G8', titulo: 'Serviços mais vendidos', acesso: 'numeros', plano: 'relatorios', fn: (c, p, o) => maisVendidos(c, p, false, o) },
  { slug: 'produtos', codigo: 'G9', titulo: 'Produtos mais vendidos', acesso: 'numeros', plano: 'relatorios', fn: (c, p, o) => maisVendidos(c, p, true, o) },
  { slug: 'clientes', codigo: 'G10', titulo: 'Clientes novos e recorrentes', acesso: 'numeros', plano: 'relatorios', fn: clientes },
  { slug: 'faltas', codigo: 'G14', titulo: 'Faltas', acesso: 'numeros', plano: 'relatorios', fn: faltas },
  { slug: 'comissoes', codigo: 'G15', titulo: 'Comissões', acesso: 'comissoes', plano: 'comissoes', fn: comissoes },
  { slug: 'pagamentos', codigo: 'G16', titulo: 'Formas de pagamento', acesso: 'numeros', plano: null, fn: pagamentos },
  { slug: 'metas', codigo: 'G17', titulo: 'Metas', acesso: 'metas', plano: 'metas', fn: metas },
  { slug: 'lucro', codigo: 'G18', titulo: 'Lucro e gastos', acesso: 'barbearia', plano: 'relatorios', fn: lucro },
  { slug: 'origem', codigo: 'G19', titulo: 'Origem dos agendamentos', acesso: 'numeros', plano: 'relatorios', fn: origem },
  { slug: 'planos', codigo: 'G20', titulo: 'Planos vendidos', acesso: 'barbearia', plano: 'relatorios', fn: planos },
  { slug: 'clientes-sumidos', codigo: 'G12', titulo: 'Clientes sumidos', acesso: 'clientes', plano: 'relatorios', fn: sumidos },
  { slug: 'retencao', codigo: 'G11', titulo: 'Retenção', acesso: 'barbearia', plano: 'relatorios', fn: retencao },
  { slug: 'cancelamentos', codigo: 'G13', titulo: 'Cancelamentos', acesso: 'numeros', plano: 'relatorios', fn: cancelamentos },
  { slug: 'atendimentos-lista', codigo: null, titulo: 'Lista de atendimentos', acesso: 'numeros', plano: null, fn: listaAtendimentos, oculto: true },
];
const POR_SLUG = new Map(CARTOES.map((c) => [c.slug, c]));

// Monta o contexto de cálculo a partir das permissões (B1) e do filtro pedido.
// Lança { status: 403 } quando a pessoa não pode ver aquele cartão ou aquele
// barbeiro — a rota devolve 403 SEM dado nenhum (critério 4).
function contextoCalculo({ barbeariaId, permissoes, barbeiroFiltro = null }, cartao) {
  const perm = permissoes;
  const eu = perm.usuario.id;
  const admin = perm.ehAdmin;
  const verBarbearia = admin || perm.pode('numeros_barbearia');
  const verMeus = admin || perm.pode('meus_numeros') || verBarbearia;
  const podeVerEquipe = perm.podeVerEquipe();
  const negar = () => { const e = new Error('Sem acesso a esta área.'); e.status = 403; throw e; };

  if (cartao.plano && !(perm.plano ? require('./planoCortavo').libera(perm.plano, cartao.plano) : true)) {
    const e = new Error('Fora do plano.');
    e.status = 403;
    e.foraDoPlano = cartao.plano;
    throw e;
  }
  switch (cartao.acesso) {
    case 'numeros': if (!verMeus) negar(); break;
    case 'barbearia': if (!verBarbearia) negar(); break;
    case 'equipe': if (!podeVerEquipe) negar(); break;
    case 'metas': if (!verMeus && !podeVerEquipe) negar(); break;
    case 'clientes': if (!verMeus || !perm.pode('clientes')) negar(); break;
    case 'comissoes': if (!perm.pode('comissoes')) negar(); break;
    default: break; // 'proprio'
  }

  // Escopo: barbearia toda só para quem pode; senão, o próprio.
  let usuarioId = null;
  if (barbeiroFiltro != null) {
    if (barbeiroFiltro !== eu && !podeVerEquipe) negar();
    if (cartao.acesso === 'comissoes' && barbeiroFiltro !== eu && !admin) negar();
    usuarioId = barbeiroFiltro;
  } else if (cartao.acesso === 'comissoes') {
    usuarioId = admin ? null : eu; // comissão dos colegas é só do admin
  } else if (cartao.acesso === 'equipe') {
    usuarioId = null; // o ranking compara todos (podeVerEquipe já conferido)
  } else if (!verBarbearia) {
    usuarioId = eu;
  }
  if (cartao.acesso === 'barbearia' && usuarioId != null) negar();
  return {
    barbeariaId, usuarioId, eu, ehAdmin: admin, podeVerEquipe, verBarbearia, verMeus,
    filtroBarbeiro: barbeiroFiltro,
    verComissaoDeTodos: admin,
    verContato: perm.pode('clientes_contato'),
  };
}

// Calcula um cartão com cache. `opcoes`: { detalhe, agora }.
async function calcular(slug, { barbeariaId, permissoes, query = {}, barbeiroFiltro = null, agora = new Date() }) {
  const cartao = POR_SLUG.get(slug);
  if (!cartao) {
    const e = new Error('Métrica desconhecida.');
    e.status = 404;
    throw e;
  }
  const ctx = contextoCalculo({ barbeariaId, permissoes, barbeiroFiltro }, cartao);
  const p = resolverPeriodo(query, agora);
  const detalhe = query.detalhe === '1' || query.detalhe === 'true';
  const chave = [barbeariaId, slug, ctx.usuarioId || 'todos', ctx.eu, ctx.podeVerEquipe ? 'eq' : '', ctx.verBarbearia ? 'bb' : '', ctx.verContato ? 'ct' : '', p.de, p.ate, detalhe ? 'd' : '', query.dias || ''].join('|');
  const emCache = cacheLer(chave, agora.getTime());
  const base = {
    metrica: slug,
    codigo: cartao.codigo,
    titulo: cartao.titulo,
    periodo: { chave: p.chave, rotulo: p.rotulo, de: p.de, ate: p.ate, anterior: { de: p.anterior.de, ate: p.anterior.ate } },
    escopo: ctx.usuarioId ? { tipo: 'barbeiro', usuarioId: ctx.usuarioId } : { tipo: 'barbearia', usuarioId: null },
  };
  if (emCache) return { ...base, ...emCache, cache: true };
  const r = await cartao.fn(ctx, p, { detalhe, agora, query });
  cacheGravar(chave, r, agora.getTime());
  return { ...base, ...r, geradoEm: agora.toISOString(), cache: false };
}

// Cartões que ESTA pessoa pode ver, na ordem da spec (a tela monta só estes:
// o que não está aqui some, sem cadeado — critério 3). Para o admin, os cartões
// fora do plano vêm com `foraDoPlano` (cadeado, R1); para o barbeiro, não vêm.
function cartoesDisponiveis(permissoes) {
  const planoCortavo = require('./planoCortavo');
  const out = [];
  for (const c of CARTOES) {
    if (c.oculto) continue;
    const forado = c.plano && permissoes.plano && !planoCortavo.libera(permissoes.plano, c.plano);
    try {
      contextoCalculo({ barbeariaId: 0, permissoes }, { ...c, plano: null });
    } catch (_) {
      continue; // sem permissão: nem aparece
    }
    if (forado) {
      if (permissoes.ehAdmin) out.push({ slug: c.slug, codigo: c.codigo, titulo: c.titulo, foraDoPlano: true, texto: planoCortavo.textoForaDoPlano(c.plano) });
      continue;
    }
    out.push({ slug: c.slug, codigo: c.codigo, titulo: c.titulo, foraDoPlano: false, url: '/painel/api/gestao/' + c.slug });
  }
  return out;
}

module.exports = {
  resolverPeriodo, variacaoPct, pctDe, iso, dataLocal, dataValida,
  calcular, cartoesDisponiveis, contextoCalculo, CARTOES,
  invalidar, limparCache, versaoCache,
  // funções expostas para a Home (B6) e para os testes de paridade
  faturamento, atendimentos, ticket, ocupacao, ocupacaoBase, horasLivres, equipe, faturamentoPorBarbeiro,
  maisVendidos, clientes, pagamentos, metas, lucro, origem, planos, listaAtendimentos, calcularComissoes,
  retencao, sumidos, cancelamentos, faltas, comissoes,
};
