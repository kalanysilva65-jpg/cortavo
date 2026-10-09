// Fechar o caixa do dia (redesign v3, F6; pedido novo ao Beto).
//
// Resumo do dia + conferência da gaveta. Regras:
//  - o dia é o do CAIXA (lançamentos com `data` naquele dia, 00:00–24:00 local),
//    o mesmo recorte da tela de Caixa;
//  - dinheiro esperado na gaveta = fundo inicial (troco que já estava lá)
//    + entradas em dinheiro − saídas em dinheiro. Saída SEM forma de pagamento
//    não entra na conta da gaveta (quem tirou dinheiro da gaveta marca
//    "Dinheiro" ao lançar). Se a barbearia lança o troco como entrada em
//    dinheiro, o fundo inicial é 0;
//  - diferença = contado − esperado (negativo = faltou);
//  - um fechamento por dia; fechar de novo exige `refazer` e soma `vezes`;
//  - fechar não trava nada: é registro de conferência.
const prisma = require('../config/db');

const DIA_MS = 86400000;
const FORMAS = ['pix', 'credito', 'debito', 'dinheiro'];
const MAX_DIAS_ATRAS = 62;

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function inicioDoDia(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
// "AAAA-MM-DD" (ou vazio = hoje) -> Date 00:00 local; null se inválida/futura/antiga demais.
function lerDia(texto, agora = new Date()) {
  const hoje0 = inicioDoDia(agora);
  if (texto == null || texto === '') return hoje0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(texto))) return null;
  const [a, m, d] = String(texto).split('-').map(Number);
  const dia = new Date(a, m - 1, d);
  if (isNaN(dia.getTime()) || dia.getDate() !== d) return null;
  if (dia > hoje0) return null;
  if ((hoje0 - dia) / DIA_MS > MAX_DIAS_ATRAS) return null;
  return dia;
}

// Centavos a partir de número inteiro (centavos) ou texto em reais ("123,45").
function lerCentavos(centavos, reais) {
  if (centavos != null && centavos !== '') {
    const n = Number(centavos);
    return Number.isInteger(n) && n >= 0 && n <= 1e9 ? n : null;
  }
  if (reais != null && reais !== '') {
    const n = parseFloat(String(reais).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n <= 1e7 ? Math.round(n * 100) : null;
  }
  return null;
}

function formatarFechamento(f) {
  if (!f) return null;
  let porForma = {};
  try { porForma = JSON.parse(f.porForma || '{}'); } catch (_) { porForma = {}; }
  return {
    id: f.id, dia: iso(new Date(f.dia)), fechadoEm: f.fechadoEm, fechadoPorNome: f.fechadoPorNome,
    entradas: f.entradas, saidas: f.saidas, saldo: f.saldo, porForma, atendimentos: f.atendimentos,
    fundoInicial: f.fundoInicial, dinheiroEsperado: f.dinheiroEsperado, dinheiroContado: f.dinheiroContado,
    diferenca: f.diferenca, observacao: f.observacao, vezes: f.vezes,
  };
}

async function resumoDoDia(barbeariaId, dia, { fundoInicial = 0 } = {}) {
  const fim = new Date(dia);
  fim.setDate(fim.getDate() + 1);
  const [lanc, atendimentos, abertos, fechamento] = await Promise.all([
    prisma.caixa.findMany({ where: { barbeariaId, data: { gte: dia, lt: fim } }, select: { tipo: true, valor: true, formaPagamento: true } }),
    prisma.agendamento.count({ where: { barbeariaId, status: 'concluido', concluidoEm: { gte: dia, lt: fim } } }),
    prisma.agendamento.findMany({ where: { barbeariaId, status: 'agendado', data: dia }, select: { valorTotal: true } }),
    prisma.fechamentoCaixa.findUnique({ where: { barbeariaId_dia: { barbeariaId, dia } } }),
  ]);
  const porForma = { pix: 0, credito: 0, debito: 0, dinheiro: 0, sem_forma: 0 };
  let entradas = 0;
  let saidas = 0;
  let saidasDinheiro = 0;
  for (const l of lanc) {
    if (l.tipo === 'entrada') {
      entradas += l.valor;
      porForma[FORMAS.includes(l.formaPagamento) ? l.formaPagamento : 'sem_forma'] += l.valor;
    } else {
      saidas += l.valor;
      if (l.formaPagamento === 'dinheiro') saidasDinheiro += l.valor;
    }
  }
  return {
    dia: iso(dia),
    entradas,
    saidas,
    saldo: entradas - saidas,
    porForma,
    saidasDinheiro,
    fundoInicial,
    dinheiroEsperado: fundoInicial + porForma.dinheiro - saidasDinheiro,
    atendimentos,
    lancamentos: lanc.length,
    aReceber: { quantidade: abertos.length, valor: abertos.reduce((s, a) => s + a.valorTotal, 0) },
    fechamento: formatarFechamento(fechamento),
  };
}

// Fecha (ou refaz) o caixa do dia. Devolve { erro, status } ou { fechamento, resumo }.
async function fechar(barbeariaId, { dia, dinheiroContado, fundoInicial = 0, observacao = null, refazer = false, usuario }) {
  const r = await resumoDoDia(barbeariaId, dia, { fundoInicial });
  if (r.fechamento && !refazer) {
    return { status: 409, erro: 'O caixa deste dia já foi fechado. Para fechar de novo, confirme "refazer".', fechamento: r.fechamento };
  }
  const dados = {
    fechadoEm: new Date(),
    fechadoPorId: usuario && usuario.id ? usuario.id : null,
    fechadoPorNome: (usuario && usuario.nome) || 'Equipe',
    entradas: r.entradas,
    saidas: r.saidas,
    saldo: r.saldo,
    porForma: JSON.stringify(r.porForma),
    atendimentos: r.atendimentos,
    fundoInicial,
    dinheiroEsperado: r.dinheiroEsperado,
    dinheiroContado,
    diferenca: dinheiroContado - r.dinheiroEsperado,
    observacao: observacao ? String(observacao).trim().slice(0, 200) || null : null,
  };
  const salvo = await prisma.fechamentoCaixa.upsert({
    where: { barbeariaId_dia: { barbeariaId, dia } },
    create: { barbeariaId, dia, ...dados, vezes: 1 },
    update: { ...dados, vezes: { increment: 1 } },
  });
  return { fechamento: formatarFechamento(salvo), resumo: { ...r, fechamento: formatarFechamento(salvo) } };
}

async function listar(barbeariaId, de, ateExcl) {
  const lista = await prisma.fechamentoCaixa.findMany({ where: { barbeariaId, dia: { gte: de, lt: ateExcl } }, orderBy: { dia: 'desc' } });
  return lista.map(formatarFechamento);
}

module.exports = { resumoDoDia, fechar, listar, lerDia, lerCentavos, MAX_DIAS_ATRAS };
