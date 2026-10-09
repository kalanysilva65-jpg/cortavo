// Dashboard do painel do barbeiro (tela inicial /painel).
// Reúne, a partir dos dados que já existem, os cartões: agenda de hoje + próximo
// cliente, faturamento do dia + barras da semana, produtividade (ocupação),
// retenção e novos clientes. Tudo escopado pela barbearia do contexto.
const prisma = require('../config/db');
const planoCortavo = require('../services/planoCortavo');
const { paraHome: metasDaHome } = require('./metaController');
const { paraMinutos, duracaoComEncaixe } = require('../services/disponibilidade');
const { INATIVOS: STATUS_INATIVOS } = require('../config/statusAgendamento');

// Date -> meia-noite local do mesmo dia.
function inicioDoDia(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// "João Pedro Silva" -> "JP". Alimenta os avatares do design "suave", que
// substituíram a foto onde não existe foto (pedido do dono, 2026-07-31).
function iniciais(nome) {
  const ini = (nome || '')
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return ini || '—';
}

// Ocupação (%) = minutos atendidos ÷ minutos de jornada disponível no período.
async function calcularOcupacao(barbeariaId, barbeiroIds, inicio, fimExcl) {
  if (!barbeiroIds.length) return 0;
  const ags = await prisma.agendamento.findMany({
    where: { barbeariaId, usuarioId: { in: barbeiroIds }, data: { gte: inicio, lt: fimExcl }, status: { notIn: STATUS_INATIVOS } },
    include: { itens: { include: { servico: true } } },
  });
  let ocupado = 0;
  for (const a of ags) {
    ocupado += duracaoComEncaixe(
      a.itens.map((it) => ({ duracaoMin: it.servico.duracaoMin, ehEncaixe: it.servico.ehEncaixe, quantidade: it.quantidade })),
      { efetiva: false }
    );
  }

  const jornadas = await prisma.horarioTrabalho.findMany({ where: { barbeariaId, usuarioId: { in: barbeiroIds } } });
  const amanha0 = inicioDoDia(new Date());
  amanha0.setDate(amanha0.getDate() + 1);
  const limite = new Date(Math.min(fimExcl.getTime(), amanha0.getTime())); // não conta dias futuros
  let disponivel = 0;
  for (let d = new Date(inicio); d < limite; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const j of jornadas) {
      if (j.diaSemana === dow && j.trabalha) disponivel += Math.max(0, paraMinutos(j.horaFim) - paraMinutos(j.horaInicio));
    }
  }
  return disponivel > 0 ? Math.round((ocupado / disponivel) * 100) : 0;
}

// GET /painel
async function ver(req, res) {
  const b = req.barbeariaId;
  const ehAdmin = req.ehAdmin;
  const usuarioId = req.session.usuario.id;

  const agora = new Date();
  const hoje0 = inicioDoDia(agora);
  const amanha0 = new Date(hoje0);
  amanha0.setDate(hoje0.getDate() + 1);
  const minutoAgora = agora.getHours() * 60 + agora.getMinutes();

  // Barbeiros do escopo: admin vê a barbearia toda; funcionário, só a si.
  const barbeiros = await prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true }, select: { id: true } });
  const barbeiroIds = ehAdmin ? barbeiros.map((x) => x.id) : [usuarioId];

  // --- Agenda de hoje + próximo cliente ------------------------------------
  const filtroBarbeiro = ehAdmin ? {} : { usuarioId };
  const agsHoje = await prisma.agendamento.findMany({
    where: { barbeariaId: b, data: hoje0, status: { notIn: STATUS_INATIVOS }, ...filtroBarbeiro },
    include: { usuario: true, itens: { include: { servico: true } } },
    orderBy: { horaInicio: 'asc' },
  });
  const totalHoje = agsHoje.length;
  const concluidosHoje = agsHoje.filter((a) => a.status === 'concluido').length;
  const restantesHoje = totalHoje - concluidosHoje;

  // Próximos atendimentos (agendados, ainda não concluídos, a partir de agora).
  const proximosLista = agsHoje
    .filter((a) => a.status === 'agendado' && paraMinutos(a.horaInicio) >= minutoAgora)
    .slice(0, 3)
    .map((a) => ({
      nome: a.clienteNome,
      hora: a.horaInicio,
      servico: a.itens.map((i) => i.servico.nome).join(' + ') || 'Atendimento',
    }));

  // --- Faturamento de hoje + previsto + barras da semana (admin) ------------
  let ganhoHoje = 0;
  let previstoHoje = 0;
  let variacaoHojeOntem = null; // % vs ontem (null = sem dado de ontem pra comparar)
  let barras = [];
  let maxBarra = 1;
  if (ehAdmin) {
    const caixaHoje = await prisma.caixa.aggregate({
      _sum: { valor: true },
      where: { barbeariaId: b, tipo: 'entrada', data: { gte: hoje0, lt: amanha0 } },
    });
    ganhoHoje = caixaHoje._sum.valor || 0;
    previstoHoje = agsHoje.reduce((s, a) => s + a.valorTotal, 0);

    const ontem0 = new Date(hoje0);
    ontem0.setDate(ontem0.getDate() - 1);
    const caixaOntem = await prisma.caixa.aggregate({
      _sum: { valor: true },
      where: { barbeariaId: b, tipo: 'entrada', data: { gte: ontem0, lt: hoje0 } },
    });
    const ganhoOntem = caixaOntem._sum.valor || 0;
    if (ganhoOntem > 0) variacaoHojeOntem = Math.round(((ganhoHoje - ganhoOntem) / ganhoOntem) * 100);

    // Semana atual (segunda a domingo) numa consulta só.
    // Antes eram SETE `aggregate` num laço, um por dia — sete idas ao banco
    // para somar a mesma semana. Agora vem a semana inteira de uma vez e a
    // divisão por dia é feita aqui (pedido do dono, 2026-08-01: deixar o app
    // mais rápido).
    const offSeg = (agora.getDay() + 6) % 7; // 0 = segunda
    const seg = new Date(hoje0);
    seg.setDate(hoje0.getDate() - offSeg);
    const fimSemana = new Date(seg);
    fimSemana.setDate(seg.getDate() + 7);
    const rotulos = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

    const lancamentos = await prisma.caixa.findMany({
      where: { barbeariaId: b, tipo: 'entrada', data: { gte: seg, lt: fimSemana } },
      select: { valor: true, data: true },
    });
    const porDia = new Array(7).fill(0);
    lancamentos.forEach((l) => {
      // Diferença em dias a partir da segunda. `Math.floor` sobre o tempo
      // absoluto erraria na virada do horário de verão; comparar as datas
      // zeradas evita isso.
      const d = inicioDoDia(l.data);
      const i = Math.round((d - seg) / 86400000);
      if (i >= 0 && i < 7) porDia[i] += l.valor;
    });
    for (let i = 0; i < 7; i++) {
      const d0 = new Date(seg);
      d0.setDate(seg.getDate() + i);
      barras.push({ rotulo: rotulos[i], valor: porDia[i], hoje: d0.getTime() === hoje0.getTime() });
    }
    maxBarra = Math.max(1, ...barras.map((x) => x.valor));
  }

  // "Novos clientes" e "Retenção" (janelas de 90 dias) saíram daqui: nenhuma
  // das duas era exibida desde que a Home virou o design suave, mas as
  // consultas continuavam rodando a cada abertura — e a de retenção varria 90
  // dias de agendamentos. Se voltarem a ser mostradas, voltam com elas.

  // --- Ticket médio de hoje (faturado ÷ atendimentos concluídos) -----------
  const ticketMedioHoje = concluidosHoje > 0 ? Math.round(ganhoHoje / concluidosHoje) : 0;

  // --- Ocupação DE HOJE ----------------------------------------------------
  // O design "suave" põe a barrinha de ocupação dentro do cartão "Resumo de
  // hoje" (pedido do dono, 2026-07-31) — ali a métrica de 90 dias acima
  // responderia outra pergunta. A barra satura em 100%: encaixe acima da
  // jornada (dois barbeiros no mesmo horário, atendimento estendido) é real,
  // mas não cabe visualmente; o número ao lado continua o verdadeiro.
  const ocupacaoHoje = await calcularOcupacao(b, barbeiroIds, hoje0, amanha0);
  const ocupacaoLargura = Math.min(100, ocupacaoHoje);

  // --- Saudação pela hora do dia (Bom dia / Boa tarde / Boa noite) ---------
  const hora = new Date().getHours();
  const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

  // --- Data por extenso do cabeçalho ---------------------------------------
  const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const dataLonga = `${DIAS_SEMANA[agora.getDay()]}, ${agora.getDate()} de ${MESES_LONGOS[agora.getMonth()]}`;

  // --- "PRÓXIMO AGENDAMENTO" + os seguintes --------------------------------
  // Olha ALÉM de hoje de propósito: quando o dia já acabou, a Home mostra o
  // próximo compromisso real (amanhã, semana que vem) em vez de ficar vazia
  // — é o bloco que abre a tela no design Turno 6, não pode ficar em branco.
  const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const agsFuturos = await prisma.agendamento.findMany({
    where: { barbeariaId: b, data: { gte: hoje0 }, status: 'agendado', ...filtroBarbeiro },
    include: { itens: { include: { servico: true } } },
    orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
    take: 20,
  });
  const proximosTodos = agsFuturos
    // Hoje só conta o que ainda não passou; dias futuros contam inteiros.
    .filter((a) => a.data.getTime() > hoje0.getTime() || paraMinutos(a.horaInicio) >= minutoAgora)
    .slice(0, 4)
    .map((a) => ({
      cliente: a.clienteNome,
      hora: a.horaInicio,
      servico: a.itens.map((i) => i.servico.nome).join(' + ') || 'Atendimento',
      diaNum: a.data.getDate(),
      mesLabel: MESES_CURTOS[a.data.getMonth()],
      iniciais: iniciais(a.clienteNome),
    }));
  const proximoCorte = proximosTodos[0] || null;
  const seguintesCortes = proximosTodos.slice(1);

  // --- Faturamento semanal: total + colunas do gráfico ---------------------
  // No design "suave" (2026-07-31) as colunas são finas, dentro de uma caixa
  // de 84px, e só o dia de HOJE é preto — as cores saem do CSS, aqui só sai a
  // altura. (No Turno 6 cada bloco levava valor e cor próprios.)
  const faturamentoSemanal = barras.reduce((s, x) => s + x.valor, 0);
  const ALTURA_GRAFICO = 84;
  const barrasSemana = barras.map((x) => ({
    label: x.rotulo,
    // Piso de 5px: um dia zerado ainda precisa existir como traço na base,
    // senão a semana parece ter menos dias do que tem.
    altura: Math.max(5, Math.round((x.valor / maxBarra) * ALTURA_GRAFICO)),
    hoje: x.hoje,
  }));

  // --- Alerta de estoque baixo ---------------------------------------------
  // Fase 2 (B3): função fora do plano não aparece na Home (nem é consultada).
  const plano = res.locals.planoCortavo || planoCortavo.planoDe(res.locals.barbeariaAtual && res.locals.barbeariaAtual.planoCortavo);
  const itensEstoque = planoCortavo.libera(plano, 'estoque') ? await prisma.estoque.findMany({ where: { barbeariaId: b } }) : [];
  const emFalta = itensEstoque.filter((e) => e.quantidadeMinima > 0 && e.quantidade <= e.quantidadeMinima);
  const estoqueBaixo = {
    tem: emFalta.length > 0,
    quantidade: emFalta.length,
    titulo: emFalta.length === 1 ? 'item no limite' : 'itens no limite',
    nomes: emFalta.slice(0, 4).map((e) => e.nome).join(', '),
  };

  // Só o que a view consome. `barras`/`maxBarra` continuam existindo acima,
  // mas como matéria-prima de `barrasSemana` — não vão para a view.
  const u = req.session.usuario;
  const metasHome = planoCortavo.libera(plano, 'metas') ? await metasDaHome(b, u.id, !!req.ehAdmin) : [];

  res.render('painel/dashboard', {
    titulo: 'Painel',
    totalHoje,
    concluidosHoje,
    restantesHoje,
    ganhoHoje,
    ticketMedioHoje,
    ocupacaoHoje,
    ocupacaoLargura,
    saudacao,
    dataLonga,
    proximoCorte,
    seguintesCortes,
    iniciaisUsuario: iniciais(req.session.usuario.nome),
    faturamentoSemanal,
    barrasSemana,
    estoqueBaixo,
    metasHome,
  });
}

module.exports = { ver };
