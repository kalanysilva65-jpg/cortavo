// Controlador do controle de caixa (entradas/saídas) e suas categorias.
// Acesso exclusivo do admin (garantido pelas rotas com exigeAdmin).
const prisma = require('../config/db');
const caixaServ = require('../services/caixa');
const metricas = require('../services/metricas');
const { COMISSAO_PRODUTO_PERCENTUAL } = require('../config/constantes');

// `curto` é o rótulo das pílulas do design suave (pedido do dono, 2026-07-31):
// numa fila de 4 pílulas de 11.5px, "Cartão de Crédito" quebra a linha e o
// grupo vira duas fileiras. O `label` inteiro continua valendo onde há espaço
// (extrato e folha "Formas de pagamento").
const FORMAS_PAGAMENTO = [
  { valor: 'pix', label: 'Pix', curto: 'Pix' },
  { valor: 'credito', label: 'Cartão de Crédito', curto: 'Crédito' },
  { valor: 'debito', label: 'Cartão de Débito', curto: 'Débito' },
  { valor: 'dinheiro', label: 'Dinheiro', curto: 'Dinheiro' },
];

// "40,00" / "40" -> 4000 (centavos). Retorna null se inválido.
function reaisParaCentavos(valorStr) {
  const n = parseFloat(String(valorStr).replace(',', '.'));
  if (isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

// Date -> "YYYY-MM-DD"
function isoDia(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "YYYY-MM-DD" -> Date à meia-noite local
function dataLocal(s) {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d);
}

function fmtDataBR(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// Período padrão = mês atual (primeiro ao último dia)
function periodoMesAtual() {
  const hoje = new Date();
  return {
    inicio: isoDia(new Date(hoje.getFullYear(), hoje.getMonth(), 1)),
    fim: isoDia(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0)),
  };
}

// Soma entradas/saídas de uma lista de lançamentos.
function somar(lista) {
  let entrou = 0;
  let saiu = 0;
  for (const l of lista) {
    if (l.tipo === 'entrada') entrou += l.valor;
    else saiu += l.valor;
  }
  return { entrou, saiu, saldo: entrou - saiu };
}

// GET /painel/caixa
async function ver(req, res) {
  const b = req.barbeariaId;
  const agora = new Date();

  const padrao = periodoMesAtual();
  let inicioStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.inicio || '') ? req.query.inicio : padrao.inicio;
  let fimStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fim || '') ? req.query.fim : padrao.fim;
  if (inicioStr > fimStr) {
    const t = inicioStr;
    inicioStr = fimStr;
    fimStr = t;
  }

  const inicio = dataLocal(inicioStr);
  const fimExcl = dataLocal(fimStr);
  fimExcl.setDate(fimExcl.getDate() + 1); // limite superior exclusivo (inclui o dia "fim")

  // Lançamentos do período selecionado
  const lancamentos = await prisma.caixa.findMany({
    where: { barbeariaId: b, data: { gte: inicio, lt: fimExcl } },
    include: { categoria: true },
    orderBy: [{ data: 'desc' }, { id: 'desc' }],
  });
  const resumoPeriodo = somar(lancamentos);

  // Formas de pagamento (só entradas) — soma do período selecionado, usada
  // no pop-up "Detalhes" da carteira.
  const formasPagamento = FORMAS_PAGAMENTO.map((f) => ({
    ...f,
    valorCentavos: lancamentos
      .filter((l) => l.tipo === 'entrada' && l.formaPagamento === f.valor)
      .reduce((s, l) => s + l.valor, 0),
  })).filter((f) => f.valorCentavos > 0);

  // Serviços/Produtos/Comissão do período — a partir dos agendamentos
  // concluídos (não dos lançamentos de caixa, que só têm o valor total).
  const agendamentosPeriodo = await prisma.agendamento.findMany({
    where: { barbeariaId: b, status: 'concluido', data: { gte: inicio, lt: fimExcl } },
    include: { usuario: true, itens: { include: { servico: true } } },
  });
  let servicosValor = 0;
  let produtosValor = 0;
  let comissaoValor = 0;
  for (const ag of agendamentosPeriodo) {
    const pct = ag.usuario.comissaoPercentual ?? 50;
    for (const it of ag.itens) {
      const valor = it.valorUnitario * it.quantidade;
      if (it.servico.ehProduto) {
        produtosValor += valor;
        comissaoValor += Math.round(valor * ((it.servico.comissaoPercentual ?? COMISSAO_PRODUTO_PERCENTUAL) / 100));
      } else {
        servicosValor += valor;
        comissaoValor += Math.round(valor * (pct / 100));
      }
    }
  }

  // Resumo do dia (hoje) — só faz sentido mostrar se "hoje" está dentro do período visto.
  const hoje0 = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  const amanha0 = new Date(hoje0);
  amanha0.setDate(hoje0.getDate() + 1);
  const lancHoje = await prisma.caixa.findMany({ where: { barbeariaId: b, data: { gte: hoje0, lt: amanha0 } } });
  const resumoHoje = somar(lancHoje);
  const incluiHoje = hoje0 >= inicio && hoje0 < fimExcl;

  // Saldo do mês corrente (fixo — independe do período filtrado acima).
  const mesAtualStr = periodoMesAtual();
  const inicioMesAtual = dataLocal(mesAtualStr.inicio);
  const fimMesAtualExcl = dataLocal(mesAtualStr.fim);
  fimMesAtualExcl.setDate(fimMesAtualExcl.getDate() + 1);
  const lancMesAtual = await prisma.caixa.findMany({
    where: { barbeariaId: b, data: { gte: inicioMesAtual, lt: fimMesAtualExcl } },
  });
  const resumoMesAtual = somar(lancMesAtual);

  // (As categorias de caixa saíram da tela em 2026-10-05; lançamentos antigos
  // que tinham categoria continuam mostrando o nome dela na lista.)
  // Ganhos por semana DENTRO do período selecionado — para o gráfico de barras.
  const barrasPeriodo = [];
  let cursor = new Date(inicio);
  while (cursor < fimExcl) {
    const fimSemana = new Date(cursor);
    fimSemana.setDate(cursor.getDate() + 7);
    const bucketFim = fimSemana > fimExcl ? fimExcl : fimSemana;
    const valor = lancamentos
      .filter((l) => l.tipo === 'entrada' && l.data >= cursor && l.data < bucketFim)
      .reduce((s, l) => s + l.valor, 0);
    barrasPeriodo.push({
      rotulo: String(cursor.getDate()).padStart(2, '0') + '/' + String(cursor.getMonth() + 1).padStart(2, '0'),
      valor,
      hoje: hoje0 >= cursor && hoje0 < bucketFim,
    });
    cursor = bucketFim;
  }
  const maxBarraPeriodo = Math.max(1, ...barrasPeriodo.map((x) => x.valor));

  const nomePeriodoSel = inicioStr === fimStr ? fmtDataBR(inicio) : `${fmtDataBR(inicio)} – ${fmtDataBR(new Date(fimExcl.getTime() - 86400000))}`;

  // Atalhos de período
  const offSegunda = (agora.getDay() + 6) % 7; // 0 = segunda
  const seg = new Date(hoje0);
  seg.setDate(hoje0.getDate() - offSegunda);
  const dom = new Date(seg);
  dom.setDate(seg.getDate() + 6);
  const presetHoje = { inicio: isoDia(hoje0), fim: isoDia(hoje0) };
  const presetSemana = { inicio: isoDia(seg), fim: isoDia(dom) };

  // Qual pill de atalho está ativa (pra destacar visualmente) — 'custom' se o
  // período não bater com nenhum atalho (ex.: De/Até escolhido manualmente).
  let periodoAtivo = 'custom';
  if (inicioStr === presetHoje.inicio && fimStr === presetHoje.fim) periodoAtivo = 'hoje';
  else if (inicioStr === presetSemana.inicio && fimStr === presetSemana.fim) periodoAtivo = 'semana';
  else if (inicioStr === padrao.inicio && fimStr === padrao.fim) periodoAtivo = 'mes';

  // --- Dados da tela de extrato (design suave, 2026-07-31) -----------------
  // Nasceram no Turno 6 e seguem valendo no design novo: saldo do período em
  // destaque, o que ainda falta entrar e a lista de lançamentos com o saldo
  // acumulado ao lado de cada um.

  // "A receber": atendimentos do período que ainda não foram concluídos —
  // dinheiro que a agenda promete e o caixa ainda não viu.
  const abertosPeriodo = await prisma.agendamento.findMany({
    where: { barbeariaId: b, status: 'agendado', data: { gte: inicio, lt: fimExcl } },
    select: { valorTotal: true },
  });
  const aReceber = {
    valor: abertosPeriodo.reduce((s, a) => s + a.valorTotal, 0),
    quantidade: abertosPeriodo.length,
  };

  // Extrato: o saldo mostrado em cada faixa é o acumulado ATÉ aquele
  // lançamento, então precisa ser somado do mais antigo para o mais novo —
  // por isso o vai-e-volta de ordem (a lista chega do mais novo pro mais velho).
  const hojeIsoDia = isoDia(hoje0);
  let acumulado = 0;
  const extratoCompleto = lancamentos
    .slice()
    .reverse()
    .map((l) => {
      const entrada = l.tipo === 'entrada';
      acumulado += entrada ? l.valor : -l.valor;
      const d = new Date(l.data);
      const ddmm = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      const forma = FORMAS_PAGAMENTO.find((f) => f.valor === l.formaPagamento);
      return {
        id: l.id,
        hora: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        diaLabel: isoDia(d) === hojeIsoDia ? 'hoje' : ddmm,
        descricao: l.descricao,
        sub: [l.categoria ? l.categoria.nome : null, forma ? forma.label : null].filter(Boolean).join(' · '),
        entrada,
        valor: l.valor,
        saldo: acumulado,
      };
    })
    .reverse();
  const LIMITE_EXTRATO = 30;
  const extrato = extratoCompleto.slice(0, LIMITE_EXTRATO);
  const extratoRestantes = Math.max(0, extratoCompleto.length - LIMITE_EXTRATO);

  // Atalhos do painel de período customizado (só preenchem os campos De/Até).
  const diasAtras = (n) => {
    const d = new Date(hoje0);
    d.setDate(hoje0.getDate() - n);
    return isoDia(d);
  };
  const atalhosPeriodo = [
    { label: 'Últimos 7 dias', inicio: diasAtras(6), fim: isoDia(hoje0) },
    { label: 'Últimos 15 dias', inicio: diasAtras(14), fim: isoDia(hoje0) },
    { label: 'Últimos 30 dias', inicio: diasAtras(29), fim: isoDia(hoje0) },
    {
      label: 'Mês passado',
      inicio: isoDia(new Date(agora.getFullYear(), agora.getMonth() - 1, 1)),
      fim: isoDia(new Date(agora.getFullYear(), agora.getMonth(), 0)),
    },
  ];

  const ROTULO_PERIODO = { hoje: 'do dia', semana: 'da semana', mes: 'do mês', custom: 'do período' };
  const ROTULO_EXTRATO = {
    hoje: 'Extrato de hoje',
    semana: 'Extrato da semana',
    mes: 'Extrato do mês',
    custom: `Extrato de ${fmtDataBR(inicio)} a ${fmtDataBR(new Date(fimExcl.getTime() - 86400000))}`,
  };
  const ddmmCurto = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

  const hora = agora.getHours();
  const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

  // Spec 12 (B2): barbeiro com `caixa_ver` vê o caixa; só lança com
  // `caixa_lancar` e nunca exclui. A comissão somada da equipe é número dos
  // outros barbeiros: só para quem pode comparar a equipe.
  const perm = req.permissoes;
  const podeLancarCaixa = !perm || perm.pode('caixa_lancar');
  const podeRemoverCaixa = !perm || perm.ehAdmin;
  if (perm && !perm.podeVerEquipe()) comissaoValor = 0;

  res.render('painel/caixa', {
    titulo: 'Financeiro',
    podeLancarCaixa,
    podeRemoverCaixa,
    saudacao,
    lancamentos,
    resumoPeriodo,
    resumoHoje,
    resumoMesAtual,
    incluiHoje,
    barrasPeriodo,
    maxBarraPeriodo,
    nomePeriodoSel,
    periodoAtivo,
    inicioStr,
    fimStr,
    hojeIso: isoDia(agora),
    presetHoje,
    presetSemana,
    presetMes: padrao,
    formasPagamento,
    servicosValor,
    produtosValor,
    comissaoValor,
    formasPagamentoOpcoes: FORMAS_PAGAMENTO,
    // Extrato / cabeçalho de período
    aReceber,
    extrato,
    extratoRestantes,
    atalhosPeriodo,
    periodoLabelCurto: ROTULO_PERIODO[periodoAtivo] || 'do período',
    extratoLabel: ROTULO_EXTRATO[periodoAtivo] || 'Extrato do período',
    periodoCustomLabel:
      periodoAtivo === 'custom' ? `${ddmmCurto(inicio)} – ${ddmmCurto(new Date(fimExcl.getTime() - 86400000))}` : 'Período',
  });
}

// POST /painel/caixa — registra um lançamento manual
async function criar(req, res) {
  const b = req.barbeariaId;
  const descricao = (req.body.descricao || '').trim();
  const valor = reaisParaCentavos(req.body.valor);
  // O tipo (entrada/saída) vem DIRETO do lançamento (as categorias saíram da tela).
  const tipo = req.body.tipo === 'saida' ? 'saida' : 'entrada';
  const formaPagamento = FORMAS_PAGAMENTO.some((f) => f.valor === req.body.formaPagamento) ? req.body.formaPagamento : null;

  const qs = new URLSearchParams();
  if (req.body.inicio) qs.set('inicio', req.body.inicio);
  if (req.body.fim) qs.set('fim', req.body.fim);
  const destino = '/painel/caixa' + (qs.toString() ? '?' + qs.toString() : '');

  if (valor === null || valor <= 0) {
    req.session.flash = { tipo: 'erro', texto: 'Informe um valor válido.' };
    return res.redirect(destino);
  }

  // Data: meio-dia local evita "pular" de dia por causa de fuso.
  const data = req.body.data ? new Date(req.body.data + 'T12:00:00') : new Date();

  await prisma.caixa.create({
    data: {
      barbeariaId: b,
      descricao: (descricao || (tipo === 'saida' ? 'Saída' : 'Entrada')).slice(0, 120),
      valor,
      tipo,
      data,
      categoriaId: null,
      formaPagamento,
    },
  });
  metricas.invalidar(b);
  req.session.flash = { tipo: 'sucesso', texto: 'Lançamento registrado.' };
  res.redirect(destino);
}

// POST /painel/caixa/:id/remover
async function remover(req, res) {
  const l = await prisma.caixa.findFirst({ where: { id: Number(req.params.id), barbeariaId: req.barbeariaId } });
  if (l) await prisma.caixa.delete({ where: { id: l.id } }).catch(() => {});
  metricas.invalidar(req.barbeariaId);
  req.session.flash = { tipo: 'sucesso', texto: 'Lançamento removido.' };

  const qs = new URLSearchParams();
  if (req.body.inicio) qs.set('inicio', req.body.inicio);
  if (req.body.fim) qs.set('fim', req.body.fim);
  res.redirect('/painel/caixa' + (qs.toString() ? '?' + qs.toString() : ''));
}

module.exports = {
  ver,
  criar,
  remover,
};
