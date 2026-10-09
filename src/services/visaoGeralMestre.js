// Painel-mestre › Visão geral (redesign v3, F10; auditoria aprovada em
// 2026-10-05: "4 números + Precisa de atenção"). Só leitura; só o papel dono.
//
// Os 4 números (competência = mês atual, valores em CENTAVOS):
//  1. ativas: barbearias com acesso ligado e situação "ativa" (pagantes);
//     ao lado, quantas em teste e quantas pausadas;
//  2. receita estimada do mês: soma do preço do plano de cada ativa, com o
//     desconto de fundador (30% por 6 meses, decisão de 2026-10-05) para quem
//     tem a vaga CONFIRMADA. Plano "Personalizado" não tem preço no app: fica
//     fora da soma e é contado em `semPrecoDefinido`;
//  3. custo de IA + WhatsApp do mês (services/custosIA.js, que já calcula o
//     custo por modelo e as mensagens pagas da Meta), por barbearia e total;
//  4. margem = receita estimada − custo (só das barbearias com preço).
// É ESTIMATIVA: a cobrança real vive no Asaas, na Anthropic e na Meta.
//
// "Precisa de atenção": lista curta, da mais grave para a menos grave.
const prisma = require('../config/db');
const planoCortavo = require('./planoCortavo');
const testeGratis = require('./testeGratis');
const custosIA = require('./custosIA');

const DESCONTO_FUNDADOR = 0.3;
const MESES_FUNDADOR = 6;
const DIAS_SEM_MOVIMENTO = 14;
const LIMITE_ALERTA = 0.8; // 80% do teto

function fundadorComDesconto(b, agora) {
  if (b.fundador !== 'confirmada') return false;
  if (!b.fundadorEm) return true; // confirmada sem data: vale o desconto (a favor do cliente)
  const fim = new Date(b.fundadorEm);
  fim.setMonth(fim.getMonth() + MESES_FUNDADOR);
  return agora < fim;
}

function precoDoMes(b, agora) {
  const plano = planoCortavo.planoDe(b.planoCortavo);
  if (plano.precoCentavos == null) return null;
  return fundadorComDesconto(b, agora) ? Math.round(plano.precoCentavos * (1 - DESCONTO_FUNDADOR)) : plano.precoCentavos;
}

const reaisParaCentavos = (v) => Math.round((Number(v) || 0) * 100);

async function visaoGeral({ agora = new Date(), backup = null } = {}) {
  const competencia = custosIA.competenciaAtual();
  const [barbearias, custos, vagas] = await Promise.all([
    prisma.barbearia.findMany({
      select: { id: true, nome: true, slug: true, ativo: true, planoCortavo: true, situacaoCortavo: true, testeFim: true, fundador: true, fundadorEm: true },
      orderBy: { nome: 'asc' },
    }),
    custosIA.resumo(competencia),
    testeGratis.vagasFundador(),
  ]);
  const custoPor = new Map(custos.linhas.map((l) => [l.id, l]));

  const desde = new Date(agora);
  desde.setDate(desde.getDate() - DIAS_SEM_MOVIMENTO);
  const [movimento, barbeirosAtivos] = await Promise.all([
    prisma.agendamento.groupBy({ by: ['barbeariaId'], where: { criadoEm: { gte: desde } }, _count: { _all: true } }),
    prisma.usuario.groupBy({ by: ['barbeariaId'], where: { ativo: true, barbeariaId: { not: null } }, _count: { _all: true } }),
  ]);
  const comMovimento = new Set(movimento.map((m) => m.barbeariaId));
  const qtdBarbeiros = new Map(barbeirosAtivos.map((g) => [g.barbeariaId, g._count._all]));

  let ativas = 0;
  let emTeste = 0;
  let pausadas = 0;
  let inativas = 0;
  let receita = 0;
  let custoComPreco = 0;
  let semPreco = 0;
  const porBarbearia = [];
  const atencao = [];
  const alerta = (b, tipo, gravidade, texto, extra = {}) => atencao.push({ barbeariaId: b ? b.id : null, nome: b ? b.nome : null, tipo, gravidade, texto, ...extra });

  for (const b of barbearias) {
    const plano = planoCortavo.planoDe(b.planoCortavo);
    const c = custoPor.get(b.id) || {};
    const custoIA = reaisParaCentavos((c.custoUSD || 0) * custos.cotacao);
    const custoMeta = reaisParaCentavos(c.custoMetaBRL || 0);
    const custo = reaisParaCentavos(c.custoBRL || 0);
    const pagante = b.ativo && b.situacaoCortavo === 'ativa';
    const preco = pagante ? precoDoMes(b, agora) : null;

    if (!b.ativo) inativas++;
    else if (b.situacaoCortavo === 'teste') emTeste++;
    else if (String(b.situacaoCortavo).startsWith('pausada')) pausadas++;
    else ativas++;
    if (pagante && preco == null) semPreco++;
    if (preco != null) {
      receita += preco;
      custoComPreco += custo;
    }
    porBarbearia.push({
      barbeariaId: b.id,
      nome: b.nome,
      plano: plano.chave,
      situacao: b.ativo ? b.situacaoCortavo : 'inativa',
      receitaEstimada: preco,
      custoIA,
      custoWhatsApp: custoMeta,
      custoTotal: custo,
      margem: preco != null ? preco - custo : null,
      margemPct: preco ? Math.round(((preco - custo) / preco) * 100) : null,
      respostasSecretaria: c.respostas || 0,
      consultasAssistente: c.copilotoConsultas || 0,
      mensagensWhatsApp: c.msgsEnviadas || 0,
    });

    if (!b.ativo) continue;
    // --- Precisa de atenção -------------------------------------------------
    if (b.situacaoCortavo === 'pausada_atraso') alerta(b, 'pausada_atraso', 'alta', 'Pausada por atraso no pagamento.');
    if (b.situacaoCortavo === 'pausada_teste') alerta(b, 'pausada_teste', 'alta', 'Teste acabou e a barbearia está pausada.');
    if (b.situacaoCortavo === 'teste') {
      const dias = testeGratis.diasRestantes(b, agora);
      if (dias != null && dias < 0) alerta(b, 'teste_vencido', 'alta', 'Teste vencido sem pagamento.', { diasRestantes: dias });
      else if (dias != null && dias <= 2) alerta(b, 'teste_terminando', 'media', dias === 0 ? 'Teste termina hoje.' : `Teste termina em ${dias} dia${dias === 1 ? '' : 's'}.`, { diasRestantes: dias });
    }
    if (preco != null && custo > preco) alerta(b, 'margem_negativa', 'alta', 'Custo de IA e WhatsApp acima do preço do plano.', { margem: preco - custo });
    const tetoSec = plano.tetos.secretaria;
    if (typeof tetoSec === 'number' && tetoSec > 0 && (c.respostas || 0) >= tetoSec * LIMITE_ALERTA) {
      alerta(b, 'secretaria_perto_do_teto', 'media', `Secretária com ${c.respostas} de ${tetoSec} respostas do mês.`, { usado: c.respostas, teto: tetoSec });
    }
    const tetoAss = plano.tetos.assistente;
    if (typeof tetoAss === 'number' && tetoAss > 0 && (c.copilotoConsultas || 0) >= tetoAss * LIMITE_ALERTA) {
      alerta(b, 'assistente_perto_do_teto', 'media', `Assistente com ${c.copilotoConsultas} de ${tetoAss} consultas do mês.`, { usado: c.copilotoConsultas, teto: tetoAss });
    }
    if (c.alertaMsgs) alerta(b, 'whatsapp_franquia', 'media', `WhatsApp com ${c.msgsEnviadas} mensagens no mês (franquia grátis: ${custos.wppGratisMes}).`, { usado: c.msgsEnviadas });
    const aviso = planoCortavo.avisoBarbeiros(plano, qtdBarbeiros.get(b.id) || 0, null);
    if (aviso) alerta(b, 'barbeiros_acima', 'baixa', aviso);
    if (b.situacaoCortavo !== 'pausada_teste' && b.situacaoCortavo !== 'pausada_atraso' && !comMovimento.has(b.id)) {
      alerta(b, 'sem_movimento', 'baixa', `Nenhum agendamento novo em ${DIAS_SEM_MOVIMENTO} dias.`);
    }
  }
  if (backup && ['atrasado', 'falhou', 'nunca'].includes(backup.situacao)) {
    alerta(null, 'backup', 'alta', backup.situacao === 'falhou' ? 'O último backup falhou.' : backup.situacao === 'nunca' ? 'Nenhum backup registrado.' : 'Backup semanal atrasado.');
  }

  const ordem = { alta: 0, media: 1, baixa: 2 };
  atencao.sort((a, b) => ordem[a.gravidade] - ordem[b.gravidade] || String(a.nome || '').localeCompare(String(b.nome || '')));
  porBarbearia.sort((a, b) => b.custoTotal - a.custoTotal);

  return {
    competencia,
    numeros: {
      ativas,
      emTeste,
      pausadas,
      inativas,
      receitaEstimada: receita,
      semPrecoDefinido: semPreco,
      custoTotal: reaisParaCentavos(custos.totais.custoBRL),
      custoDasComPreco: custoComPreco,
      margem: receita - custoComPreco,
      margemPct: receita > 0 ? Math.round(((receita - custoComPreco) / receita) * 100) : null,
    },
    vagasFundador: vagas,
    precisaDeAtencao: atencao,
    porBarbearia,
    premissas: { cotacaoDolar: custos.cotacao, descontoFundador: DESCONTO_FUNDADOR, mesesFundador: MESES_FUNDADOR, estimativa: true },
  };
}

module.exports = { visaoGeral, precoDoMes, fundadorComDesconto };
