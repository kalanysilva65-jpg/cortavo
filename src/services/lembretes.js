// Lembretes de agendamento por WhatsApp.
//
// Um agendador roda de tempos em tempos, acha os agendamentos que começam dentro
// da janela de antecedência (padrão 1h) e ainda NÃO foram lembrados, e dispara um
// TEMPLATE aprovado da Meta (mensagem que a barbearia inicia — tem custo baixo).
// O cliente pode responder o lembrete: como ele iniciou, abre a janela de 24h e a
// secretária continua de graça.
//
// Só age por barbearia que LIGOU os lembretes (config `lembretes_ativos`), tem um
// template aprovado configurado e o WhatsApp conectado. Falha de envio nunca
// derruba nada; só é remarcada pra próxima rodada (enquanto o agendamento não passa).
const prisma = require('../config/db');
const whatsapp = require('./whatsapp');
const { telefoneCanonicoBR } = require('../utils/telefone');

const INTERVALO_MS = 5 * 60 * 1000; // roda a cada 5 min
const IDIOMA = process.env.LEMBRETE_IDIOMA || 'pt_BR';
const ANTECEDENCIA_PADRAO = 60; // minutos
// Nome do template usado quando a barbearia liga os lembretes mas não digita um
// nome próprio — assim já funciona "de fábrica" (o template padrão do Cortavo).
const TEMPLATE_PADRAO = process.env.LEMBRETE_TEMPLATE_PADRAO || 'lembrete_agendamento';

function primeiroNome(nome) {
  return (nome || '').trim().split(/\s+/)[0] || 'cliente';
}

// Número no formato que a Meta ENTREGA: DDI 55 + DDD + 9 + número.
// O agendamento guarda o telefone digitado no painel ("(51) 99983-2112"), que
// vem SEM o código do país. Sem o "55" a Meta lê o "51" como outro DDI (Peru) e
// ACEITA a mensagem sem ENTREGAR — some sem erro. (Nas RESPOSTAS isso não acontece
// porque lá o número vem do `wa_id` da Meta, que já traz o 55.)
function paraEnvioBR(valor) {
  const canon = telefoneCanonicoBR(valor); // DDD + 9 + 8 díg, sem país
  return canon ? '55' + canon : '';
}

// Início do agendamento em horário LOCAL (mesma convenção do resto do app:
// getters locais de `data` + horaInicio "HH:MM").
function inicioLocal(ag) {
  const [hh, mm] = String(ag.horaInicio || '0:0').split(':').map(Number);
  return new Date(ag.data.getFullYear(), ag.data.getMonth(), ag.data.getDate(), hh || 0, mm || 0, 0, 0);
}

// Configs de lembrete + credenciais de TODAS as barbearias, de uma vez.
async function configPorBarbearia() {
  const chaves = ['lembretes_ativos', 'lembrete_template_nome', 'lembrete_antecedencia_min', 'whatsapp_phone_number_id', 'whatsapp_token'];
  const regs = await prisma.configuracao.findMany({ where: { chave: { in: chaves } } });
  const mapa = new Map();
  for (const r of regs) {
    const m = mapa.get(r.barbeariaId) || {};
    m[r.chave] = r.valor;
    mapa.set(r.barbeariaId, m);
  }
  return mapa;
}

// Evita duas rodadas SOBREPOSTAS: se uma rodada demora mais que o INTERVALO
// (muitos agendamentos / API lenta), o setInterval dispararia outra por cima e o
// mesmo agendamento (ainda sem `lembreteEnviadoEm`) poderia sair 2× antes de
// qualquer rodada marcá-lo. Com o flag, a rodada nova espera a próxima volta.
let rodando = false;

async function dispararDevidos() {
  if (rodando) return;
  rodando = true;
  try {
    const cfg = await configPorBarbearia();
    // Pausa de verdade (spec 01): barbearia pausada não recebe lembrete. Na
    // reativação NADA sai em lote: os que venceram na pausa já saíram da janela.
    const pausadas = new Set(
      (await prisma.barbearia.findMany({ where: { ativo: false }, select: { id: true } })).map((b) => b.id),
    );
    const agora = new Date();
    for (const [barbeariaId, c] of cfg) {
      // Isola a barbearia: um erro aqui (ex.: falha de banco ao ler os
      // agendamentos) NÃO pode abortar a rodada e deixar as OUTRAS sem lembrete.
      try {
        if (c.lembretes_ativos !== '1') continue;
        if (pausadas.has(barbeariaId)) continue;
        if (!c.whatsapp_phone_number_id || !c.whatsapp_token) continue; // sem WhatsApp conectado, não há como enviar
        const templateNome = c.lembrete_template_nome || TEMPLATE_PADRAO; // pré-programado se o dono não digitou um nome
        const antecedencia = parseInt(c.lembrete_antecedencia_min, 10) || ANTECEDENCIA_PADRAO;

        // Só olha agendamentos de hoje/amanhã ainda 'agendado' e sem lembrete.
        const ini = new Date(agora); ini.setHours(0, 0, 0, 0);
        const fim = new Date(agora); fim.setDate(fim.getDate() + 2); fim.setHours(0, 0, 0, 0);
        const ags = await prisma.agendamento.findMany({
          where: { barbeariaId, status: 'agendado', lembreteEnviadoEm: null, data: { gte: ini, lt: fim } },
          select: { id: true, clienteNome: true, clienteTelefone: true, data: true, horaInicio: true },
        });
        if (!ags.length) continue;

        const b = await prisma.barbearia.findUnique({ where: { id: barbeariaId }, select: { nome: true } });
        for (const ag of ags) {
          // Isola cada agendamento: um que dê erro (envio ou banco) não impede os
          // seguintes. Sem marcar `lembreteEnviadoEm`, ele volta na próxima rodada.
          try {
            if (!ag.clienteTelefone) continue;
            const paraEnvio = paraEnvioBR(ag.clienteTelefone);
            if (!paraEnvio) continue;
            const minutosAte = (inicioLocal(ag) - agora) / 60000;
            if (minutosAte <= 0 || minutosAte > antecedencia) continue; // ainda longe, ou já passou

            const params = [primeiroNome(ag.clienteNome), (b && b.nome) || 'a barbearia', ag.horaInicio];
            const r = await whatsapp.enviarTemplate(barbeariaId, paraEnvio, templateNome, IDIOMA, params);
            if (!r.ok) {
              // Não marca -> retenta na próxima rodada (até sair da janela).
              console.log('[lembretes] falha ao enviar p/ agendamento', ag.id, r.status || r.erro || r.motivo);
              continue;
            }
            // Só marca quando REALMENTE enviou. Em falha, tenta de novo na próxima
            // rodada (até o agendamento sair da janela) — e se o dono corrigir o
            // template no meio, ainda dá tempo de sair.
            await prisma.agendamento.update({ where: { id: ag.id }, data: { lembreteEnviadoEm: new Date() } });
            // Registro DURÁVEL do lembrete (sobrevive se o agendamento for cancelado
            // ou apagado depois). Copia os dados do cliente; o log é bônus, então um
            // erro aqui nunca derruba o envio (o `update` acima é a trava de repetição).
            await prisma.lembreteLog.create({
              data: {
                barbeariaId,
                agendamentoId: ag.id,
                clienteNome: ag.clienteNome || '',
                clienteTelefone: ag.clienteTelefone || '',
                horaAgendamento: ag.horaInicio || null,
                dataAgendamento: ag.data || null,
              },
            }).catch((e) => console.log('[lembretes] log falhou p/ agendamento', ag.id, e.message));
          } catch (e) {
            console.log('[lembretes] erro no agendamento', ag.id, e.message);
          }
        }
      } catch (e) {
        console.log('[lembretes] erro na barbearia', barbeariaId, e.message);
      }
    }
  } finally {
    rodando = false;
  }
}

let timer = null;
function iniciarAgendador() {
  if (timer) return;
  // 1ª rodada 30s após subir (deixa o app estabilizar), depois a cada INTERVALO_MS.
  setTimeout(() => dispararDevidos().catch((e) => console.error('[lembretes]', e.message)), 30000);
  timer = setInterval(() => dispararDevidos().catch((e) => console.error('[lembretes]', e.message)), INTERVALO_MS);
  console.log('[lembretes] agendador ligado (a cada', INTERVALO_MS / 60000, 'min)');
}

module.exports = { iniciarAgendador, dispararDevidos };
