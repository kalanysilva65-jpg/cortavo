// Controlador da tela de Relatórios (só admin) — visão consolidada do
// desempenho da barbearia: faturamento, gastos/lucro, ranking de serviços/
// produtos/barbeiros, formas de pagamento e ocupação por dia/horário.
// Tudo calculado a partir dos dados reais (Agendamento/Caixa/Servico), sem
// nada fixo — diferente do protótipo, que usava números de exemplo.
//
// A tela é uma capa curta (os números que importam) + folhas com o detalhe de
// cada um. Por isso o controlador devolve, além dos totais, os RECORTES que
// cada folha abre — vendas item a item, gastos por categoria, ocupação hora a
// hora etc. Os valores monetários vão em CENTAVOS: quem escolhe entre `fmtT6`
// (número grande, sem centavos) e `fmtBRL` (precisão) é a view.
//
// SUAVE (pedido do dono, 2026-07-31): o cálculo não mudou; o que mudou foram as
// CORES que saem daqui. O Turno 6 pintava as faixas com o próprio contraste
// (#0E0E0E / #ADADAD / #FAFAFA); agora tudo vem da rampa monocromática do
// design novo, e as folhas de página inteira viraram folhas inferiores.
const prisma = require('../config/db');
const { paraMinutos, duracaoComEncaixe } = require('../services/disponibilidade');
const { INATIVOS: STATUS_INATIVOS } = require('../config/statusAgendamento');

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dataLocal(s) {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d);
}
function fmtDataBR(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function fmtDataCurta(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Rampa monocromática do design "suave": do quase-preto ao cinza-fio, sempre
// com a tinta de texto que dá contraste em cima. A cor NÃO codifica valor —
// é só o que separa uma faixa da vizinha, já que aqui elas não têm moldura.
// `text` é a tinta de quem escreve DENTRO da faixa; `muted`, a do rótulo.
const TONS = [
  { bg: '#191919', text: '#E0E0E0', muted: '#9C9C9C' },
  { bg: '#393939', text: '#E0E0E0', muted: '#9C9C9C' },
  { bg: '#6B6B6B', text: '#FFFFFF', muted: '#E0E0E0' },
  { bg: '#9C9C9C', text: '#191919', muted: '#393939' },
  { bg: '#E0E0E0', text: '#191919', muted: '#6B6B6B' },
];

function somarEntradaSaida(lancamentos) {
  let entrou = 0;
  let saiu = 0;
  for (const l of lancamentos) {
    if (l.tipo === 'entrada') entrou += l.valor;
    else saiu += l.valor;
  }
  return { entrou, saiu, lucro: entrou - saiu };
}

function variacaoPct(atual, anterior) {
  if (anterior <= 0) return null;
  return Math.round(((atual - anterior) / anterior) * 100);
}

function pctDe(parte, todo) {
  return todo > 0 ? Math.round((parte / todo) * 100) : 0;
}

// GET /painel/relatorios
async function ver(req, res) {
  const b = req.barbeariaId;
  const agora = new Date();
  const hoje0 = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());

  // --- Período -----------------------------------------------------------
  const periodo = ['hoje', 'semana', 'mes', 'ano', 'custom'].includes(req.query.periodo) ? req.query.periodo : 'mes';
  // Data digitada na URL precisa ser conferida: sem isto, `?de=lixo` virava
  // `Invalid Date`, o Prisma recusava e a tela inteira caía com erro 500. O
  // Caixa já validava assim; os relatórios não.
  const DATA_OK = /^\d{4}-\d{2}-\d{2}$/;
  const customValido =
    periodo === 'custom' && DATA_OK.test(req.query.de || '') && DATA_OK.test(req.query.ate || '');

  let inicio, fimExcl, rotulo;
  if (customValido) {
    inicio = dataLocal(req.query.de);
    fimExcl = dataLocal(req.query.ate);
    fimExcl.setDate(fimExcl.getDate() + 1);
    rotulo = fmtDataBR(inicio) + ' – ' + fmtDataBR(new Date(fimExcl.getTime() - 86400000));
  } else if (periodo === 'hoje') {
    inicio = new Date(hoje0);
    fimExcl = new Date(hoje0);
    fimExcl.setDate(fimExcl.getDate() + 1);
    rotulo = 'Hoje';
  } else if (periodo === 'semana') {
    inicio = new Date(hoje0);
    // Semana começa na SEGUNDA, igual ao Caixa e ao painel. Aqui começava no
    // domingo (`- getDay()`), então "esta semana" queria dizer coisas
    // diferentes em telas diferentes: num domingo, o relatório abria a semana
    // que ainda ia começar (com dias futuros) enquanto o caixa mostrava a que
    // estava terminando — R$100 de diferença no caso medido.
    inicio.setDate(hoje0.getDate() - ((hoje0.getDay() + 6) % 7));
    fimExcl = new Date(inicio);
    fimExcl.setDate(inicio.getDate() + 7);
    rotulo = 'Esta semana';
  } else if (periodo === 'ano') {
    inicio = new Date(hoje0.getFullYear(), 0, 1);
    fimExcl = new Date(hoje0.getFullYear() + 1, 0, 1);
    rotulo = 'Este ano';
  } else {
    inicio = new Date(hoje0.getFullYear(), hoje0.getMonth(), 1);
    fimExcl = new Date(hoje0.getFullYear(), hoje0.getMonth() + 1, 1);
    rotulo = 'Este mês';
  }
  // Período anterior de mesma duração, pra comparar (%).
  const duracaoMs = fimExcl.getTime() - inicio.getTime();
  const inicioAnterior = new Date(inicio.getTime() - duracaoMs);
  const fimAnteriorExcl = new Date(inicio);

  // Atalhos do painel de período personalizado (a referência tem essa fileira
  // de selos cinzas embaixo dos campos De/Até). Só preenchem os campos — quem
  // manda é o form GET, então o filtro continua sendo um link compartilhável.
  function atalho(label, diasAtras) {
    const de = new Date(hoje0);
    de.setDate(de.getDate() - diasAtras);
    return { label, de: iso(de), ate: iso(hoje0) };
  }
  const relCustomShortcuts = [
    atalho('7 dias', 6),
    atalho('30 dias', 29),
    atalho('90 dias', 89),
  ];

  const [lancamentos, lancamentosAnterior] = await Promise.all([
    prisma.caixa.findMany({ where: { barbeariaId: b, data: { gte: inicio, lt: fimExcl } }, include: { categoria: true } }),
    prisma.caixa.findMany({ where: { barbeariaId: b, data: { gte: inicioAnterior, lt: fimAnteriorExcl } } }),
  ]);
  const resumo = somarEntradaSaida(lancamentos);
  const resumoAnterior = somarEntradaSaida(lancamentosAnterior);
  const variacaoFaturamento = variacaoPct(resumo.entrou, resumoAnterior.entrou);
  const variacaoLucro = variacaoPct(resumo.lucro, resumoAnterior.lucro);

  // --- Gastos por categoria (folha "Gastos") ------------------------------
  const gastosPorCategoria = new Map();
  for (const l of lancamentos) {
    if (l.tipo !== 'saida') continue;
    // Sem categoria (todos os lançamentos novos): agrupa pela DESCRIÇÃO (ex.: "Aluguel").
    const nome = l.categoria ? l.categoria.nome : String(l.descricao || '').trim() || 'Sem descrição';
    const chave = nome.toLowerCase();
    if (!gastosPorCategoria.has(chave)) gastosPorCategoria.set(chave, { nome, valor: 0, itens: [] });
    const g = gastosPorCategoria.get(chave);
    g.valor += l.valor;
    g.itens.push({ label: l.descricao, valor: l.valor, data: l.data });
  }
  const gastoRows = Array.from(gastosPorCategoria.values())
    .sort((a, b2) => b2.valor - a.valor)
    .map((g) => ({
      name: g.nome,
      valor: g.valor,
      pct: pctDe(g.valor, resumo.saiu),
      // O detalhe abre por toque (sanfona). Corta em 6 lançamentos: a folha é
      // uma leitura, não a tela de Caixa — quem quer tudo vai no Caixa.
      qtdLabel: g.itens.length === 1 ? '1 lançamento' : g.itens.length + ' lançamentos',
      entries: g.itens
        .sort((a, b2) => b2.valor - a.valor)
        .slice(0, 6)
        .map((it) => ({ desc: it.label, date: fmtDataBR(new Date(it.data)), valor: it.valor })),
    }));

  // Cascata do lucro: começa no faturamento e vai descontando categoria por
  // categoria até sobrar o lucro. É a mesma conta do cartão "Lucro", só que
  // mostrada passo a passo — é assim que a referência explica o número.
  const lucroCascata = [
    { label: 'Faturamento', amount: resumo.entrou, rest: resumo.entrou, w: '100%', bg: TONS[0].bg, text: TONS[0].text },
  ];
  {
    let restante = resumo.entrou;
    const categorias = Array.from(gastosPorCategoria.values()).sort((a, b2) => b2.valor - a.valor);
    categorias.forEach((g, i) => {
      restante -= g.valor;
      // Começa no segundo tom: a primeira faixa (o faturamento cheio) já usou o
      // mais escuro, e cada desconto vai clareando junto com o que sobra.
      const t = TONS[(i + 1) % TONS.length];
      lucroCascata.push({
        label: '− ' + g.nome,
        amount: -g.valor,
        rest: restante,
        w: Math.max(14, pctDe(Math.max(0, restante), resumo.entrou)) + '%',
        bg: t.bg,
        text: t.text,
      });
    });
  }

  // --- Agendamentos concluídos do período (base pra ticket médio, top
  //     serviços/produtos, desempenho por barbeiro, clientes novos/recorrentes) ---
  // Filtra por `concluidoEm`, não por `data`: o faturamento conta no dia em que
  // o atendimento foi CONCLUÍDO (decisão do dono, 2026-08-16). Como as entradas
  // do caixa também são gravadas no instante da conclusão, as duas metades
  // desta tela passam a falar do mesmo período — antes, um atendimento de
  // ontem concluído hoje aparecia como "R$0 e 1 atendimento" ontem e
  // "R$150 e 0 atendimentos" hoje.
  const agendamentos = await prisma.agendamento.findMany({
    where: { barbeariaId: b, status: 'concluido', concluidoEm: { gte: inicio, lt: fimExcl } },
    // `cliente: true` foi removido: a relação era hidratada e nunca lida (só
    // se usa ag.clienteId e ag.clienteNome, que são colunas do próprio
    // agendamento). Era um join + objeto a mais por linha, à toa.
    include: { usuario: true, itens: { include: { servico: true } } },
    orderBy: [{ concluidoEm: 'desc' }, { horaInicio: 'desc' }],
  });

  const atendimentos = agendamentos.length;
  const ticketMedio = atendimentos > 0 ? Math.round(resumo.entrou / atendimentos) : 0;
  const agendamentosAnterior = await prisma.agendamento.count({
    where: { barbeariaId: b, status: 'concluido', concluidoEm: { gte: inicioAnterior, lt: fimAnteriorExcl } },
  });
  const ticketMedioAnterior = agendamentosAnterior > 0 ? Math.round(resumoAnterior.entrou / agendamentosAnterior) : 0;
  const variacaoTicket = variacaoPct(ticketMedio, ticketMedioAnterior);

  // --- Vendas item a item (serviços e produtos) ----------------------------
  // Uma passada só alimenta: o recorte serviços x produtos do topo, o ranking
  // de serviços da capa, a folha de produtos e a folha de faturamento.
  const porItem = new Map();
  let servicosValor = 0;
  let produtosValor = 0;
  for (const ag of agendamentos) {
    for (const it of ag.itens) {
      const valor = it.valorUnitario * it.quantidade;
      if (it.servico.ehProduto) produtosValor += valor;
      else servicosValor += valor;
      const chave = it.servico.id;
      if (!porItem.has(chave)) {
        porItem.set(chave, { nome: it.servico.nome, ehProduto: it.servico.ehProduto, valor: 0, qtd: 0, vendas: [] });
      }
      const reg = porItem.get(chave);
      reg.valor += valor;
      reg.qtd += it.quantidade;
      reg.vendas.push({
        when: `${fmtDataCurta(new Date(ag.data))} · ${ag.horaInicio}`,
        who: ag.clienteNome,
        valor,
      });
    }
  }
  const itensVendidos = Array.from(porItem.values()).sort((a, b2) => b2.valor - a.valor);

  // Ranking de serviços da capa: uma barra fina por serviço, com o % do
  // faturamento de serviços à direita. No Turno 6 cada linha era uma faixa
  // colorida com o número por dentro; no "suave" a barra é um traço de 7px
  // sobre trilho cinza, então sobra só a largura — sem tom próprio.
  const topServices = itensVendidos
    .filter((x) => !x.ehProduto)
    .slice(0, 5)
    .map((x) => {
      const pct = pctDe(x.valor, servicosValor);
      return {
        name: x.nome,
        valor: x.valor,
        qtd: x.qtd,
        pct,
        // Piso de 3%: sem ele um serviço de participação mínima viraria trilho
        // vazio e pareceria erro de renderização.
        w: Math.max(3, pct) + '%',
      };
    });

  const produtosVendidos = itensVendidos.filter((x) => x.ehProduto);
  const relProdutosRows = produtosVendidos.slice(0, 6).map((x) => ({ qty: x.qtd, name: x.nome, valor: x.valor }));
  const relProdutosTotalQty = produtosVendidos.reduce((s, x) => s + x.qtd, 0);

  const relVendasRows = itensVendidos.map((x) => ({
    name: x.nome,
    kind: x.ehProduto ? 'Produto' : 'Serviço',
    valor: x.valor,
    qtyLabel: x.qtd === 1 ? '1 venda' : x.qtd + ' vendas',
    entries: x.vendas.slice(0, 4),
    more: x.vendas.length > 4 ? `+ ${x.vendas.length - 4} no período` : '',
  }));

  // --- Desempenho por barbeiro (faturamento e ticket) ----------------------
  const porBarbeiro = new Map();
  for (const ag of agendamentos) {
    const nome = ag.usuario.nome;
    if (!porBarbeiro.has(nome)) porBarbeiro.set(nome, { nome, valor: 0, qtd: 0 });
    const p = porBarbeiro.get(nome);
    p.valor += ag.valorTotal;
    p.qtd += 1;
  }
  const maxBarbeiro = Math.max(1, ...Array.from(porBarbeiro.values()).map((x) => x.valor));
  const barberPerf = Array.from(porBarbeiro.values())
    .sort((a, b2) => b2.valor - a.valor)
    .map((p) => ({
      name: p.nome,
      valor: p.valor,
      qtd: p.qtd,
      pct: Math.round((p.valor / maxBarbeiro) * 100),
      ticket: p.qtd > 0 ? Math.round(p.valor / p.qtd) : 0,
    }));

  // --- Ticket: com produto x só serviço ------------------------------------
  let comProdutoQtd = 0;
  let comProdutoValor = 0;
  let semProdutoQtd = 0;
  let semProdutoValor = 0;
  for (const ag of agendamentos) {
    if (ag.itens.some((it) => it.servico.ehProduto)) {
      comProdutoQtd++;
      comProdutoValor += ag.valorTotal;
    } else {
      semProdutoQtd++;
      semProdutoValor += ag.valorTotal;
    }
  }
  const ticketCom = comProdutoQtd > 0 ? Math.round(comProdutoValor / comProdutoQtd) : 0;
  const ticketSem = semProdutoQtd > 0 ? Math.round(semProdutoValor / semProdutoQtd) : 0;
  const maxTicketLado = Math.max(1, ticketCom, ticketSem);
  const ticketData = {
    com: ticketCom,
    sem: ticketSem,
    comQtd: comProdutoQtd,
    semQtd: semProdutoQtd,
    comW: Math.max(18, Math.round((ticketCom / maxTicketLado) * 100)) + '%',
    semW: Math.max(18, Math.round((ticketSem / maxTicketLado) * 100)) + '%',
    comPct: pctDe(comProdutoQtd, atendimentos),
    delta: Math.max(0, ticketCom - ticketSem),
  };

  // --- Clientes novos vs recorrentes ----------------------------------------
  // Novo = o 1º agendamento concluído (de todos os tempos) desse cliente caiu
  // dentro do período; recorrente = já tinha atendimento concluído antes.
  const receitaPorCliente = new Map();
  for (const ag of agendamentos) {
    if (!ag.clienteId) continue;
    receitaPorCliente.set(ag.clienteId, (receitaPorCliente.get(ag.clienteId) || 0) + ag.valorTotal);
  }
  const clienteIds = Array.from(receitaPorCliente.keys());
  let clientesNovos = 0;
  let clientesRecorrentes = 0;
  let receitaNovos = 0;
  let receitaRecorrentes = 0;
  // Antes: um findFirst por cliente (N+1 — num mês cheio, centenas de idas ao
  // banco). Agora UMA agregação traz a data do 1º atendimento concluído de
  // cada cliente. `_min.data` é exatamente o que o findFirst ordenado por
  // `data asc` retornava (o horaInicio era só desempate e não muda a data),
  // então a classificação novo/recorrente sai idêntica.
  const primeiros = await prisma.agendamento.groupBy({
    by: ['clienteId'],
    where: { barbeariaId: b, status: 'concluido', clienteId: { in: clienteIds } },
    _min: { data: true },
  });
  const primeiraDataPorCliente = new Map();
  for (const g of primeiros) primeiraDataPorCliente.set(g.clienteId, g._min.data);
  for (const cid of clienteIds) {
    const primeiraData = primeiraDataPorCliente.get(cid);
    const receita = receitaPorCliente.get(cid) || 0;
    if (primeiraData && primeiraData >= inicio && primeiraData < fimExcl) {
      clientesNovos++;
      receitaNovos += receita;
    } else {
      clientesRecorrentes++;
      receitaRecorrentes += receita;
    }
  }
  const totalClientesPeriodo = clientesNovos + clientesRecorrentes;
  const clientesNovosPct = pctDe(clientesNovos, Math.max(1, totalClientesPeriodo));
  const clientesRecorrentesPct = totalClientesPeriodo > 0 ? 100 - clientesNovosPct : 0;
  const maxGrupoCliente = Math.max(1, clientesNovos, clientesRecorrentes);
  const clientesData = {
    novos: clientesNovos,
    recorrentes: clientesRecorrentes,
    total: totalClientesPeriodo,
    novosPct: clientesNovosPct,
    recorrentesPct: clientesRecorrentesPct,
    receitaNovos,
    receitaRecorrentes,
    novosW: Math.max(16, Math.round((clientesNovos / maxGrupoCliente) * 100)) + '%',
    recorrentesW: Math.max(16, Math.round((clientesRecorrentes / maxGrupoCliente) * 100)) + '%',
  };

  // --- Ticket por atendimento x por cliente, e clientes únicos x visitas -----
  // (pedido do dono, 2026-09-03). "Por atendimento" é o ticketMedio de sempre.
  // "Por cliente" divide o MESMO faturamento pelo nº de clientes DISTINTOS —
  // fica maior que o por-atendimento quando a mesma pessoa volta no período.
  // Únicos = clientes distintos (com cadastro); visitas = atendimentos totais.
  // "Veio 1x x voltou" olha a frequência DENTRO do período.
  const clientesUnicos = clienteIds.length;
  const ticketPorCliente = clientesUnicos > 0 ? Math.round(resumo.entrou / clientesUnicos) : 0;
  const maxTicketTipo = Math.max(1, ticketMedio, ticketPorCliente);
  const ticketPorTipo = {
    atendimento: ticketMedio,
    cliente: ticketPorCliente,
    atendW: Math.max(18, Math.round((ticketMedio / maxTicketTipo) * 100)) + '%',
    clienteW: Math.max(18, Math.round((ticketPorCliente / maxTicketTipo) * 100)) + '%',
  };

  const atendPorClienteMap = new Map();
  for (const ag of agendamentos) {
    if (!ag.clienteId) continue;
    atendPorClienteMap.set(ag.clienteId, (atendPorClienteMap.get(ag.clienteId) || 0) + 1);
  }
  let clientesUmaVez = 0;
  let clientesVoltaram = 0;
  for (const n of atendPorClienteMap.values()) {
    if (n >= 2) clientesVoltaram++;
    else clientesUmaVez++;
  }
  const maxFreqGrupo = Math.max(1, clientesUmaVez, clientesVoltaram);
  clientesData.unicos = clientesUnicos;
  clientesData.visitas = atendimentos;
  clientesData.mediaVisitas = clientesUnicos > 0 ? atendimentos / clientesUnicos : 0;
  clientesData.umaVez = clientesUmaVez;
  clientesData.voltaram = clientesVoltaram;
  clientesData.umaVezPct = pctDe(clientesUmaVez, Math.max(1, clientesUnicos));
  clientesData.voltaramPct = pctDe(clientesVoltaram, Math.max(1, clientesUnicos));
  clientesData.umaVezW = Math.max(16, Math.round((clientesUmaVez / maxFreqGrupo) * 100)) + '%';
  clientesData.voltaramW = Math.max(16, Math.round((clientesVoltaram / maxFreqGrupo) * 100)) + '%';

  // --- Formas de pagamento ---------------------------------------------------
  const FORMAS = [
    { valor: 'pix', label: 'Pix', naHora: true },
    { valor: 'credito', label: 'Crédito', naHora: false },
    { valor: 'debito', label: 'Débito', naHora: false },
    { valor: 'dinheiro', label: 'Dinheiro', naHora: true },
  ];
  const entradasComForma = lancamentos.filter((l) => l.tipo === 'entrada' && l.formaPagamento);
  const totalPago = entradasComForma.reduce((s, l) => s + l.valor, 0);
  const formasPagamento = FORMAS.map((f, i) => {
    const doGrupo = entradasComForma.filter((l) => l.formaPagamento === f.valor);
    const valor = doGrupo.reduce((s, l) => s + l.valor, 0);
    const t = TONS[i % TONS.length];
    return {
      ...f,
      valor,
      qtd: doGrupo.length,
      pct: pctDe(valor, totalPago),
      ticket: doGrupo.length > 0 ? Math.round(valor / doGrupo.length) : 0,
      cor: t.bg,
      text: t.text,
      muted: t.muted,
    };
  }).filter((f) => f.valor > 0);
  formasPagamento.sort((a, b2) => b2.valor - a.valor);

  // Rosca em SVG (a referência desenha com stroke-dasharray, não com
  // conic-gradient): cada fatia é um arco do mesmo círculo, deslocado pelo
  // acumulado das anteriores.
  const CIRCUNFERENCIA = 2 * Math.PI * 42;
  let percorrido = 0;
  const pagDonut = formasPagamento.map((f) => {
    const comprimento = (f.pct / 100) * CIRCUNFERENCIA;
    const seg = {
      color: f.cor,
      dash: `${comprimento.toFixed(2)} ${(CIRCUNFERENCIA - comprimento).toFixed(2)}`,
      offset: (-percorrido).toFixed(2),
    };
    percorrido += comprimento;
    return seg;
  });
  const naHoraValor = formasPagamento.filter((f) => f.naHora).reduce((s, f) => s + f.valor, 0);
  const depoisValor = totalPago - naHoraValor;
  const maxQuando = Math.max(1, naHoraValor, depoisValor);
  const pagData = {
    total: totalPago,
    transacoes: entradasComForma.length,
    maiorPct: formasPagamento.length ? formasPagamento[0].pct : 0,
    maiorNome: formasPagamento.length ? formasPagamento[0].label : '—',
    naHoraValor,
    depoisValor,
    naHoraPct: pctDe(naHoraValor, totalPago),
    depoisPct: pctDe(depoisValor, totalPago),
    naHoraW: Math.max(16, Math.round((naHoraValor / maxQuando) * 100)) + '%',
    depoisW: Math.max(16, Math.round((depoisValor / maxQuando) * 100)) + '%',
  };

  // --- Ocupação ------------------------------------------------------------
  // Ocupação = minutos atendidos ÷ minutos de jornada. Só conta dias que já
  // aconteceram: contar a agenda de amanhã como "vazia" derrubaria o número
  // do mês inteiro logo no dia 1º.
  const [jornadas, equipe, agsOcupacao] = await Promise.all([
    prisma.horarioTrabalho.findMany({ where: { barbeariaId: b } }),
    prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true }, select: { id: true, nome: true } }),
    prisma.agendamento.findMany({
      where: { barbeariaId: b, status: { notIn: STATUS_INATIVOS }, data: { gte: inicio, lt: fimExcl } },
      select: { data: true, horaInicio: true, usuarioId: true, itens: { select: { quantidade: true, servico: { select: { duracaoMin: true, ehEncaixe: true } } } } },
    }),
  ]);

  const amanha0 = new Date(hoje0);
  amanha0.setDate(amanha0.getDate() + 1);
  const limiteOcup = new Date(Math.min(fimExcl.getTime(), amanha0.getTime()));

  const minutosPorBarbeiro = new Map(); // usuarioId -> { ocupado, disponivel }
  for (const u of equipe) minutosPorBarbeiro.set(u.id, { nome: u.nome, ocupado: 0, disponivel: 0 });
  for (let d = new Date(inicio); d < limiteOcup; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const j of jornadas) {
      if (j.diaSemana !== dow || !j.trabalha) continue;
      const alvo = minutosPorBarbeiro.get(j.usuarioId);
      if (alvo) alvo.disponivel += Math.max(0, paraMinutos(j.horaFim) - paraMinutos(j.horaInicio));
    }
  }
  function duracaoDe(ag) {
    // efetiva:false preserva o comportamento antigo (produto = 0 min aqui); só
    // acrescenta a regra do encaixe.
    return duracaoComEncaixe(
      ag.itens.map((it) => ({ duracaoMin: it.servico.duracaoMin, ehEncaixe: it.servico.ehEncaixe, quantidade: it.quantidade })),
      { efetiva: false }
    );
  }
  for (const ag of agsOcupacao) {
    const alvo = minutosPorBarbeiro.get(ag.usuarioId);
    if (alvo) alvo.ocupado += duracaoDe(ag);
  }
  let ocupadoTotal = 0;
  let disponivelTotal = 0;
  for (const m of minutosPorBarbeiro.values()) {
    ocupadoTotal += m.ocupado;
    disponivelTotal += m.disponivel;
  }
  const ocupacaoPct = pctDe(ocupadoTotal, disponivelTotal);
  const ocupPorBarbeiro = Array.from(minutosPorBarbeiro.values())
    .filter((m) => m.disponivel > 0 || m.ocupado > 0)
    .map((m) => {
      const pct = pctDe(m.ocupado, m.disponivel);
      return {
        name: m.nome,
        pct,
        w: Math.min(100, pct) + '%',
        sub: `${Math.round(m.ocupado / 60)}h atendidas de ${Math.round(m.disponivel / 60)}h de jornada`,
      };
    })
    .sort((a, b2) => b2.pct - a.pct);

  // Faixa de horas da grade: sai das próprias jornadas (uma barbearia que abre
  // às 13h não precisa de linhas mortas das 9h). Teto de 14 linhas.
  let horaMin = 9;
  let horaMax = 20;
  if (jornadas.length) {
    horaMin = Math.floor(Math.min(...jornadas.map((j) => paraMinutos(j.horaInicio))) / 60);
    horaMax = Math.ceil(Math.max(...jornadas.map((j) => paraMinutos(j.horaFim))) / 60);
  }
  if (horaMax - horaMin > 14) horaMax = horaMin + 14;
  const HORAS_GRID = [];
  for (let h = horaMin; h < horaMax; h++) HORAS_GRID.push(h);
  const DIAS_GRID = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

  const contagem = DIAS_GRID.map(() => HORAS_GRID.map(() => 0));
  const porHora = HORAS_GRID.map(() => 0);
  const porDiaSemana = DIAS_GRID.map(() => 0);
  for (const ag of agsOcupacao) {
    const diaIdx = (new Date(ag.data).getDay() + 6) % 7; // 0 = segunda
    porDiaSemana[diaIdx]++;
    const horaIdx = HORAS_GRID.indexOf(Math.floor(paraMinutos(ag.horaInicio) / 60));
    if (horaIdx !== -1) {
      contagem[diaIdx][horaIdx]++;
      porHora[horaIdx]++;
    }
  }
  const maxCelula = Math.max(1, ...contagem.flat());
  // Quatro degraus do mais cheio ao vazio — os mesmos da legenda do mapa.
  function corCelula(n) {
    if (n === 0) return '#EBEBEB';
    const r = n / maxCelula;
    if (r > 0.66) return '#191919';
    if (r > 0.33) return '#393939';
    return '#9C9C9C';
  }
  // Grade transposta em relação ao layout antigo: hora nas LINHAS e dia nas
  // COLUNAS, como na referência — cabe no celular sem rolagem lateral.
  const ocupGrid = {
    days: DIAS_GRID,
    rows: HORAS_GRID.map((h, hi) => ({
      hour: h + 'h',
      cells: DIAS_GRID.map((_, di) => ({ bg: corCelula(contagem[di][hi]) })),
    })),
  };

  const maxHora = Math.max(1, ...porHora);
  const ocupSlots = HORAS_GRID.map((h, hi) => {
    const ehPico = porHora[hi] === maxHora && maxHora > 0;
    return {
      hour: h + 'h',
      label: String(porHora[hi]),
      w: Math.round((porHora[hi] / maxHora) * 100) + '%',
      bg: ehPico ? '#191919' : porHora[hi] > 0 ? '#393939' : '#9C9C9C',
      hourColor: ehPico ? '#191919' : '#6B6B6B',
      labelColor: ehPico ? '#191919' : '#6B6B6B',
    };
  });

  // "Onde agir": o pico é a hora mais cheia; o buraco é a hora mais vazia
  // DENTRO da faixa em que a barbearia realmente atende (da primeira à última
  // hora com movimento). Sem esse recorte, o buraco seria sempre a primeira
  // linha da grade — uma hora em que ninguém marca porque a loja mal abriu.
  let idxPico = 0;
  let primeiroCheio = -1;
  let ultimoCheio = -1;
  for (let i = 0; i < porHora.length; i++) {
    if (porHora[i] > porHora[idxPico]) idxPico = i;
    if (porHora[i] > 0) {
      if (primeiroCheio === -1) primeiroCheio = i;
      ultimoCheio = i;
    }
  }
  let idxBuraco = idxPico;
  for (let i = primeiroCheio; i >= 0 && i <= ultimoCheio; i++) {
    if (porHora[i] < porHora[idxBuraco]) idxBuraco = i;
  }
  const ocupInsight = {
    peak: HORAS_GRID.length ? HORAS_GRID[idxPico] + 'h' : '—',
    gap: HORAS_GRID.length ? HORAS_GRID[idxBuraco] + 'h' : '—',
    temDados: maxHora > 0,
    // Com um único horário movimentado não existe "buraco" a apontar.
    temBuraco: maxHora > 0 && idxBuraco !== idxPico,
  };

  const maxDiaSemana = Math.max(1, ...porDiaSemana);
  const ocupWeekBars = DIAS_GRID.map((dia, i) => {
    // No Turno 6 cada coluna pegava um tom da paleta só por ritmo visual. Aqui
    // a cor passa a dizer algo: escura é o dia mais movimentado da semana, o
    // resto fica no cinza de fundo. Empate pinta os dois — é a leitura certa.
    const destaque = porDiaSemana[i] === maxDiaSemana && maxDiaSemana > 0;
    return {
      label: dia,
      value: porDiaSemana[i],
      // Piso de 96px: uma coluna zerada ainda precisa caber número + rótulo.
      // Teto menor que o do Turno 6 porque agora isto vive dentro da folha
      // inferior, que só tem 88% da altura da tela.
      h: Math.max(96, Math.round((porDiaSemana[i] / maxDiaSemana) * 200)),
      // `#E0E0E0` e não `#F2F2F2` na coluna comum: o detalhe do relatório é
      // uma página CINZA (#F2F2F2), então a coluna sumia dentro do fundo — o
      // dono viu as colunas "sem card". Precisa de um degrau acima da página.
      bg: destaque ? '#191919' : '#E0E0E0',
      text: destaque ? '#E0E0E0' : '#191919',
      muted: destaque ? '#9C9C9C' : '#6B6B6B',
    };
  });

  const horasLivres = Math.max(0, Math.round((disponivelTotal - ocupadoTotal) / 60));
  const ocupData = {
    pct: ocupacaoPct,
    sub: `${Math.round(ocupadoTotal / 60)}h atendidas`,
    livres: `${horasLivres}h livres na agenda`,
  };

  // --- Últimos atendimentos (lista da folha de faturamento) -----------------
  const slotHistory = agendamentos.slice(0, 10).map((ag) => ({
    time: ag.horaInicio,
    day: fmtDataCurta(new Date(ag.data)),
    client: ag.clienteNome,
    service: ag.itens.map((it) => it.servico.nome).join(' + ') || 'Atendimento',
    barber: ag.usuario.nome.split(' ')[0],
    valor: ag.valorTotal,
  }));

  res.render('painel/relatorios', {
    titulo: 'Relatórios',
    periodo,
    relPeriodLabel: rotulo,
    deStr: req.query.de || iso(inicio),
    ateStr: req.query.ate || iso(new Date(fimExcl.getTime() - 86400000)),
    relCustomShortcuts,

    // Capa
    faturamento: resumo.entrou,
    servicosValor,
    produtosValor,
    atendimentos,
    variacaoFaturamento,
    topServices,
    ticketMedio,
    ticketPorCliente,
    ticketPorTipo,
    variacaoTicket,
    ocupacaoPct,
    formasPagamento,
    clientesNovos,
    clientesRecorrentes,
    lucro: resumo.lucro,
    variacaoLucro,
    gastos: resumo.saiu,
    lucroCascata,
    margemPct: pctDe(Math.max(0, resumo.lucro), resumo.entrou),
    // Ponto de equilíbrio: quantos atendimentos, no ticket atual, só pagam os
    // gastos do período. Sem ticket (nenhum atendimento) não há conta a fazer.
    breakEven: ticketMedio > 0 ? Math.ceil(resumo.saiu / ticketMedio) : null,

    // Folhas
    relVendasRows,
    barberPerf,
    slotHistory,
    relProdutosRows,
    relProdutosTotalQty,
    produtosValorTotal: produtosValor,
    pagData,
    pagDonut,
    clientesData,
    ticketData,
    gastoRows,
    gastosPctFat: pctDe(resumo.saiu, resumo.entrou),
    ocupData,
    ocupGrid,
    ocupSlots,
    ocupInsight,
    ocupPorBarbeiro,
    ocupWeekBars,
  });
}

module.exports = { ver };
