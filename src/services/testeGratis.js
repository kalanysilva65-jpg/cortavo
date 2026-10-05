// Teste grátis de 14 dias e vagas de fundador (fase 2.6, spec 05). LUGAR ÚNICO
// das regras do teste. Telas e rotina diária só chamam daqui.
//
// Contagem de dias (sempre no horário de Brasília, UTC-3, sem horário de verão):
//   dia 0 = dia em que o acesso foi criado -> "termina em 14 dias"
//   dia 12 -> faltam 2 -> aviso ao dono (faixa) e à Kalany (notificação)
//   dia 14 -> último dia do teste ("termina hoje")
//   dia 15 -> sem pagamento: aviso à Kalany
//   dia 16 -> sem pagamento e sem "Segurar pausa": pausa de verdade (spec 01)
// Com prorrogação, tudo anda junto com a data de fim.
const prisma = require('../config/db');
const auditoria = require('./auditoria');

const DIAS_TESTE = 14;
const PRORROGACAO_MAX_DIAS = 7;
const VAGAS_FUNDADOR = 5;
const TETO_SECRETARIA_TESTE = 250; // respostas no total do teste (só Barbearia + IA)
const DIAS_AVISO = 2; // aviso quando faltam 2 dias (dia 12)
const DIA_MS = 86400000;
const FUSO_BRASILIA_MS = -3 * 3600000;

const SITUACOES = ['ativa', 'teste', 'pausada_teste', 'pausada_atraso'];

// Número do dia no calendário de Brasília (para comparar só a data).
function diaBrasilia(data) {
  return Math.floor((new Date(data).getTime() + FUSO_BRASILIA_MS) / DIA_MS);
}

function emTeste(b) {
  return !!b && b.situacaoCortavo === 'teste' && !!b.testeFim;
}

// Dias que faltam até o fim (0 = último dia; negativo = já acabou).
function diasRestantes(b, agora = new Date()) {
  if (!b || !b.testeFim) return null;
  return diaBrasilia(b.testeFim) - diaBrasilia(agora);
}

// Campos de uma barbearia que começa o teste agora.
function dadosNovoTeste(agora = new Date()) {
  return {
    situacaoCortavo: 'teste',
    testeInicio: agora,
    testeFim: new Date(agora.getTime() + DIAS_TESTE * DIA_MS),
  };
}

// Faixa do topo do painel do dono. Sem botão de pagar (regra da Apple).
function faixaDono(b, agora = new Date()) {
  if (!emTeste(b)) return null;
  const r = diasRestantes(b, agora);
  if (r > DIAS_AVISO) return { aviso: false, dias: r, texto: `Seu teste grátis termina em ${r} dias.` };
  const quando = r > 1 ? `em ${r} dias` : r === 1 ? 'amanhã' : 'hoje';
  if (r >= 0) return { aviso: true, dias: r, texto: `Seu teste termina ${quando}. A Cortavo vai falar com você para continuar.` };
  return { aviso: true, dias: r, texto: 'Seu teste terminou. A Cortavo vai falar com você para continuar.' };
}

// ---------- Vagas de fundador ----------
async function vagasFundador() {
  const usadas = await prisma.barbearia.count({ where: { fundador: { in: ['reservada', 'confirmada'] } } });
  return { usadas, total: VAGAS_FUNDADOR, livres: Math.max(0, VAGAS_FUNDADOR - usadas) };
}

// Dados para reservar a vaga, ou null quando as 5 já estão ocupadas.
async function dadosReservaFundador(agora = new Date()) {
  const v = await vagasFundador();
  if (v.livres <= 0) return null;
  return { fundador: 'reservada', fundadorEm: agora };
}

const TEXTO_SEM_VAGA = `As ${VAGAS_FUNDADOR} vagas de fundador já estão reservadas. Esta barbearia fica sem o desconto de fundador.`;

// ---------- Prorrogação (uma vez, até 7 dias, com motivo) ----------
function validarProrrogacao(b, diasTexto, motivoTexto) {
  if (!emTeste(b)) return { erro: 'Só dá para prorrogar uma barbearia que está em teste.' };
  if (b.testeProrrogado) return { erro: 'Este teste já foi prorrogado uma vez. A prorrogação só pode ser usada uma única vez.' };
  const dias = parseInt(String(diasTexto || ''), 10);
  if (!Number.isInteger(dias) || dias < 1 || dias > PRORROGACAO_MAX_DIAS) return { erro: `Escolha de 1 a ${PRORROGACAO_MAX_DIAS} dias.` };
  const motivo = String(motivoTexto || '').trim().slice(0, 500);
  if (!motivo) return { erro: 'Escreva o motivo da prorrogação.' };
  return { dias, motivo, novoFim: new Date(new Date(b.testeFim).getTime() + dias * DIA_MS) };
}

// ---------- Secretária no teste (250 no total, contador separado) ----------
// Devolve null quando a barbearia não está em teste do + IA (vale o teto do plano).
async function tetoSecretariaTeste(barbeariaId, chavePlano) {
  let b = null;
  try {
    b = await prisma.barbearia.findUnique({ where: { id: barbeariaId }, select: { situacaoCortavo: true, testeFim: true, testeRespostas: true } });
  } catch (e) {
    return null;
  }
  if (!emTeste(b) || chavePlano !== 'barbearia_ia') return null;
  const respostas = Number(b.testeRespostas) || 0;
  return { teto: TETO_SECRETARIA_TESTE, respostas, atingido: respostas >= TETO_SECRETARIA_TESTE };
}

async function contarRespostaTeste(barbeariaId) {
  try {
    await prisma.barbearia.updateMany({ where: { id: barbeariaId, situacaoCortavo: 'teste' }, data: { testeRespostas: { increment: 1 } } });
  } catch (e) {
    console.error('[teste-gratis] falha ao contar resposta do teste:', e.message);
  }
}

// ---------- Rotina diária ----------
const REQ_ROTINA = { session: { usuario: { nome: 'Rotina do teste grátis' } }, ip: '' };

async function avisarKalany(notificar, titulo, corpo) {
  try {
    const donos = await prisma.usuario.findMany({ where: { papel: 'dono', ativo: true }, select: { id: true } });
    for (const d of donos) await notificar(d.id, { titulo, corpo, url: '/mestre', tag: 'cortavo-teste' });
  } catch (e) {
    console.error('[teste-gratis] falha ao avisar a Kalany:', e.message);
  }
}

function notificadorPadrao() {
  const n = require('./notificacoes');
  return (id, aviso) => n.enviarParaUsuario(id, aviso);
}

// Idempotente: cada passo grava a marca com updateMany condicionado ao campo
// ainda vazio; só quem conseguiu gravar (count = 1) avisa. Rodar duas vezes no
// mesmo dia (ou dois processos ao mesmo tempo) não duplica aviso nem pausa.
async function rodarRotina({ agora = new Date(), notificar = null } = {}) {
  const enviar = notificar || notificadorPadrao();
  const resumo = { convertidas: 0, avisosFim: 0, avisosVencido: 0, pausadas: 0, seguradas: 0 };
  const testes = await prisma.barbearia.findMany({ where: { situacaoCortavo: 'teste' } });
  for (const b of testes) {
    if (!b.testeFim) continue;
    // Pagou no teste: vira assinatura, sem pausa (critério 3 / regra 7).
    if (b.testePagoEm) {
      const r = await prisma.barbearia.updateMany({
        where: { id: b.id, situacaoCortavo: 'teste' },
        data: { situacaoCortavo: 'ativa', ...(b.fundador === 'reservada' ? { fundador: 'confirmada' } : {}) },
      });
      if (r.count) {
        resumo.convertidas++;
        await auditoria.registrar(REQ_ROTINA, { acao: 'teste.convertido', alvoTipo: 'barbearia', alvoId: b.id, detalhe: `Teste de "${b.nome}" virou assinatura (pagamento registrado).` });
      }
      continue;
    }
    const r = diasRestantes(b, agora);
    // Dia 12 (faltam 2 dias ou menos): aviso à Kalany, uma vez.
    if (r <= DIAS_AVISO && r >= 0 && !b.testeAvisoFimEm) {
      const u = await prisma.barbearia.updateMany({ where: { id: b.id, testeAvisoFimEm: null }, data: { testeAvisoFimEm: agora } });
      if (u.count) {
        resumo.avisosFim++;
        await avisarKalany(enviar, 'Teste terminando', `O teste da ${b.nome} termina em ${r} dia(s).`);
      }
    }
    // Dia 15 (passou do fim): aviso à Kalany, uma vez.
    if (r < 0 && !b.testeAvisoVencidoEm) {
      const u = await prisma.barbearia.updateMany({ where: { id: b.id, testeAvisoVencidoEm: null }, data: { testeAvisoVencidoEm: agora } });
      if (u.count) {
        resumo.avisosVencido++;
        await avisarKalany(enviar, 'Teste acabou sem pagamento', `O teste da ${b.nome} acabou sem pagamento registrado. Amanhã o acesso é pausado, a menos que você clique em "Segurar pausa".`);
      }
      continue; // a pausa só vem no dia seguinte ao aviso
    }
    // Dia 16 em diante: pausa, se o aviso já saiu num dia anterior e a Kalany não segurou.
    if (r < 0 && b.testeAvisoVencidoEm && diaBrasilia(b.testeAvisoVencidoEm) < diaBrasilia(agora)) {
      if (b.testeSegurarPausa) { resumo.seguradas++; continue; }
      const u = await prisma.barbearia.updateMany({
        where: { id: b.id, situacaoCortavo: 'teste', testeSegurarPausa: false, testePagoEm: null },
        data: {
          ativo: false, // a pausa real que já existe (spec 01)
          situacaoCortavo: 'pausada_teste',
          testePausadoEm: agora,
          // Vaga de fundador volta (regra 5).
          ...(b.fundador === 'reservada' ? { fundador: null, fundadorEm: null } : {}),
        },
      });
      if (u.count) {
        resumo.pausadas++;
        await auditoria.registrar(REQ_ROTINA, { acao: 'teste.pausar', alvoTipo: 'barbearia', alvoId: b.id, detalhe: `Teste de "${b.nome}" acabou sem pagamento: acesso pausado${b.fundador === 'reservada' ? ' e vaga de fundador liberada' : ''}.` });
        await avisarKalany(enviar, 'Acesso pausado', `A ${b.nome} foi pausada: o teste acabou sem pagamento. Os dados ficam guardados.`);
      }
    }
  }
  return resumo;
}

// Lista "Testes ativos" do painel-mestre.
async function testesAtivos(agora = new Date()) {
  const lista = await prisma.barbearia.findMany({ where: { situacaoCortavo: 'teste' }, orderBy: { testeFim: 'asc' } });
  return lista.map((b) => ({ ...b, diasRestantes: diasRestantes(b, agora) }));
}

// Agendador: confere a cada hora; a idempotência garante uma ação por dia.
const INTERVALO_MS = 60 * 60 * 1000;
let timer = null;
function iniciarAgendador() {
  if (timer) return;
  const rodar = () => rodarRotina().catch((e) => console.error('[teste-gratis]', e.message));
  setTimeout(rodar, 60000);
  timer = setInterval(rodar, INTERVALO_MS);
  console.log('[teste-gratis] rotina ligada (a cada 60 min)');
}

module.exports = {
  DIAS_TESTE, PRORROGACAO_MAX_DIAS, VAGAS_FUNDADOR, TETO_SECRETARIA_TESTE, SITUACOES, TEXTO_SEM_VAGA,
  diaBrasilia, emTeste, diasRestantes, dadosNovoTeste, faixaDono,
  vagasFundador, dadosReservaFundador, validarProrrogacao,
  tetoSecretariaTeste, contarRespostaTeste,
  rodarRotina, testesAtivos, iniciarAgendador,
};
