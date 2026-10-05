// Envio de avisos para os aparelhos da equipe (agendamento novo, cancelamento).
//
// Hoje funciona por Web Push (padrão do navegador, chaves VAPID). O app nativo
// da loja usará APNs/FCM, que muda só o TRANSPORTE: o resto — quem recebe, o
// que é escrito, quando disparar — já vive aqui e é reaproveitado. Por isso
// `enviarParaUsuario` decide pelo campo `plataforma` de cada aparelho em vez de
// assumir web.
//
// Regra de ouro deste arquivo: falha de notificação NUNCA derruba a ação que a
// disparou. Um push que não sai não pode impedir um agendamento de ser criado.
const webpush = require('web-push');
const prisma = require('../config/db');
const apns = require('./apns');

const PUBLICA = process.env.VAPID_PUBLIC_KEY || '';
const PRIVADA = process.env.VAPID_PRIVATE_KEY || '';
const CONTATO = process.env.VAPID_SUBJECT || 'mailto:cortavo.app@gmail.com';

const configurado = Boolean(PUBLICA && PRIVADA);
if (configurado) {
  webpush.setVapidDetails(CONTATO, PUBLICA, PRIVADA);
}

// A tela precisa saber se vale a pena oferecer o botão de ativar avisos.
function estaConfigurado() {
  return configurado;
}

function chavePublica() {
  return PUBLICA;
}

// Plataformas que o serviço sabe entregar. Fechada de propósito: um valor
// desconhecido aqui viraria um aparelho que nunca recebe nada e ninguém
// descobre por quê.
const PLATAFORMAS = new Set(['web', 'ios', 'android']);

// Guarda (ou atualiza) a inscrição de um aparelho.
// O endpoint é único: reinscrever o mesmo aparelho atualiza em vez de duplicar.
// No iOS o "endpoint" é o token do aparelho e não há chaves de cifragem — quem
// cifra é o próprio APNs.
async function registrarDispositivo(usuarioId, inscricao, plataforma) {
  const endpoint = String(inscricao && inscricao.endpoint ? inscricao.endpoint : '').trim();
  if (!endpoint) return null;

  const plat = PLATAFORMAS.has(plataforma) ? plataforma : 'web';
  const chaves = inscricao.keys || {};
  const dados = {
    usuarioId,
    p256dh: chaves.p256dh || null,
    auth: chaves.auth || null,
    plataforma: plat,
  };

  return prisma.dispositivoPush.upsert({
    where: { endpoint },
    update: dados,
    create: { endpoint, ...dados },
  });
}

async function removerDispositivo(endpoint) {
  if (!endpoint) return;
  await prisma.dispositivoPush.deleteMany({ where: { endpoint: String(endpoint) } });
}

async function contarDispositivos(usuarioId) {
  return prisma.dispositivoPush.count({ where: { usuarioId } });
}

// Há como enviar por ALGUM transporte? (VAPID para navegador, APNs para iPhone)
function algumTransporteAtivo() {
  return configurado || apns.estaConfigurado();
}

// Envia um aviso para todos os aparelhos de um usuário.
//
// Cada aparelho é entregue pelo transporte da sua plataforma: navegador vai por
// Web Push, app iOS vai por APNs. Um transporte desligado não impede o outro —
// o barbeiro pode ter o app no iPhone e o navegador no computador da barbearia,
// e desligar um dos dois não pode calar o outro.
//
// Retorna quantos receberam — útil para testar e para o log.
async function enviarParaUsuario(usuarioId, aviso) {
  if (!algumTransporteAtivo() || !usuarioId) return 0;

  const aparelhos = await prisma.dispositivoPush.findMany({ where: { usuarioId } });
  if (!aparelhos.length) return 0;

  const carga = JSON.stringify({
    titulo: aviso.titulo,
    corpo: aviso.corpo,
    url: aviso.url || '/painel/agenda',
    tag: aviso.tag || 'cortavo',
  });

  let entregues = 0;
  for (const ap of aparelhos) {
    // --- app iOS (APNs) ---
    if (ap.plataforma === 'ios') {
      if (!apns.estaConfigurado()) continue;
      const r = await apns.enviar(ap.endpoint, aviso);
      if (r.ok) entregues++;
      else if (r.removerToken) {
        await prisma.dispositivoPush.deleteMany({ where: { endpoint: ap.endpoint } });
      }
      continue;
    }

    // --- navegador (Web Push) ---
    if (ap.plataforma !== 'web') continue; // android/FCM entra aqui quando existir
    if (!configurado) continue;

    try {
      await webpush.sendNotification(
        { endpoint: ap.endpoint, keys: { p256dh: ap.p256dh, auth: ap.auth } },
        carga
      );
      entregues++;
    } catch (e) {
      // 404/410 = inscrição morta (app desinstalado, permissão revogada).
      // Limpar é o certo: insistir nela só gera erro para sempre.
      const status = e && e.statusCode;
      if (status === 404 || status === 410) {
        await prisma.dispositivoPush.deleteMany({ where: { endpoint: ap.endpoint } });
      } else {
        console.error('[push] falha ao enviar para o aparelho', ap.id, status || e.message);
      }
    }
  }
  return entregues;
}

// "2026-08-20" + "14:30" -> "20/08 às 14:30"
function quando(data, hora) {
  const d = data instanceof Date ? data : new Date(data);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes} às ${hora}`;
}

// Avisa o barbeiro que caiu um agendamento na agenda dele.
//
// Envolvido em try/catch porque é chamado no meio da confirmação do
// agendamento: se o push falhar, o cliente não pode receber um erro de um
// agendamento que na verdade foi criado.
async function notificarNovoAgendamento(agendamento, servicosLabel) {
  try {
    return await enviarParaUsuario(agendamento.usuarioId, {
      titulo: 'Novo agendamento',
      corpo: `${agendamento.clienteNome} — ${servicosLabel} · ${quando(agendamento.data, agendamento.horaInicio)}`,
      url: '/painel/agenda',
      tag: 'agendamento-' + agendamento.id,
    });
  } catch (e) {
    console.error('[push] erro ao notificar agendamento', agendamento.id, e.message);
    return 0;
  }
}

// Avisa a EQUIPE (todos os usuários ativos da barbearia) que um cliente pediu
// atendimento humano no WhatsApp. Chega no app (web push) e fora dele (APNs no
// iPhone). Falha de push nunca derruba o fluxo do atendimento.
async function notificarHumanoSolicitado(barbeariaId, conversa) {
  try {
    const usuarios = await prisma.usuario.findMany({ where: { barbeariaId, ativo: true }, select: { id: true } });
    const nome = (conversa && (conversa.clienteNome || conversa.clienteTelefone)) || 'Um cliente';
    let total = 0;
    for (const u of usuarios) {
      total += await enviarParaUsuario(u.id, {
        titulo: 'Cliente quer falar com atendente',
        corpo: `${nome} pediu atendimento humano no WhatsApp. Abra as Conversas para assumir.`,
        url: '/painel/conversas?id=' + (conversa ? conversa.id : ''),
        tag: 'humano-' + (conversa ? conversa.id : 'x'),
      });
    }
    return total;
  } catch (e) {
    console.error('[push] erro ao notificar handoff humano', e.message);
    return 0;
  }
}

module.exports = {
  estaConfigurado,
  chavePublica,
  registrarDispositivo,
  removerDispositivo,
  contarDispositivos,
  enviarParaUsuario,
  notificarNovoAgendamento,
  notificarHumanoSolicitado,
};
