// Webhook da WhatsApp Cloud API (Meta) — Fase 3.3.
//  - GET  /webhooks/whatsapp : handshake de verificação (Meta confere o token).
//  - POST /webhooks/whatsapp : recebe as mensagens dos clientes.
// É rota PÚBLICA (a Meta chama de fora, sem sessão). A autenticidade do POST é
// garantida pela assinatura X-Hub-Signature-256 (HMAC com o App Secret).
const crypto = require('crypto');
const atendimento = require('../services/atendimento');
const whatsapp = require('../services/whatsapp');
const transcricao = require('../services/transcricao');
const planoCortavo = require('../services/planoCortavo');
const waMidia = require('../services/waMidia');

// GET: a Meta manda hub.mode/hub.verify_token/hub.challenge. Se o token bate com
// o nosso WHATSAPP_VERIFY_TOKEN, devolvemos o challenge (texto puro) e ela ativa.
function verificar(req, res) {
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (modo === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ''));
  }
  return res.sendStatus(403);
}

// Confere a assinatura do corpo (garante que o POST veio mesmo da Meta).
// Sem META_APP_SECRET: em DEV liberamos (facilita testar no localhost); em
// PRODUÇÃO é FAIL-CLOSED — rejeitamos e logamos alto. Aceitar sem conferir
// deixaria qualquer um injetar mensagem forjada em nome de um cliente, então é
// melhor o webhook recusar (erro visível no log) do que passar inseguro em
// silêncio — mesma lógica do guard do SESSION_SECRET no server.js.
function assinaturaValida(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    const ehProducao = process.env.NODE_ENV === 'production' || !!process.env.APP_DOMAIN;
    if (ehProducao) {
      console.log('[SEGURANÇA] META_APP_SECRET ausente em produção — webhook do WhatsApp REJEITADO (fail-closed). Defina o segredo no .env do VPS e reinicie.');
      return false;
    }
    return true; // dev: sem segredo, não bloqueia
  }
  const assinatura = req.get('x-hub-signature-256') || '';
  if (!req.rawBody) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperado));
  } catch (e) {
    return false;
  }
}

// POST: a Meta exige um 200 RÁPIDO, senão reenvia. Então respondemos na hora e
// processamos em segundo plano (a mensagem é persistida logo no início do
// receberMensagemCliente, então nada se perde mesmo se a IA demorar/falhar).
async function receber(req, res) {
  if (!assinaturaValida(req)) return res.sendStatus(403);
  res.sendStatus(200);

  try {
    const body = req.body || {};
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const ch of entry.changes || []) {
        if (ch.field !== 'messages') continue; // mensagens E status (entregue/lido) vêm neste campo
        const value = ch.value || {};
        const pnid = value.metadata && value.metadata.phone_number_id;
        const barbeariaId = await whatsapp.barbeariaPorPhoneNumberId(pnid);
        if (!barbeariaId) {
          console.log('[webhook] phone_number_id sem barbearia vinculada:', pnid);
          continue;
        }
        const nomeContato =
          (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || null;
        for (const msg of value.messages || []) {
          processarMensagem(barbeariaId, msg, nomeContato)
            .catch((e) => console.error('[webhook] processar mensagem (' + msg.type + '):', e.message));
        }
        // Status de entrega (sent/delivered/read/failed): viram os tiques no
        // painel. As FALHAS também vão pro log, com o motivo.
        for (const st of value.statuses || []) {
          atendimento.atualizarStatusEnvio(st.id, st.status).catch(() => {});
          if (st.status === 'failed') {
            console.log('[webhook] entrega FALHOU para', st.recipient_id, '-', JSON.stringify(st.errors || []));
          }
        }
      }
    }
  } catch (e) {
    console.error('[webhook] erro ao processar:', e.message);
  }
}

// Tipos de mídia da Cloud API -> nosso tipo.
const TIPO_NOSSO = { image: 'imagem', video: 'video', audio: 'audio', document: 'documento', sticker: 'figurinha' };

// Uma mensagem recebida, de qualquer tipo ("clone do WhatsApp", 2026-09-30).
// Texto e respostas de botão seguem direto; mídia é baixada e guardada (fica
// visível no painel); áudio também é TRANSCRITO pra IA entender.
async function processarMensagem(barbeariaId, msg, nomeContato) {
  const base = { telefone: msg.from, nome: nomeContato, waId: msg.id };

  if (msg.type === 'text' && msg.text) {
    return atendimento.receberMensagemCliente(barbeariaId, { ...base, texto: msg.text.body });
  }
  if (msg.type === 'button' && msg.button) {
    return atendimento.receberMensagemCliente(barbeariaId, { ...base, texto: msg.button.text || msg.button.payload || '' });
  }
  if (msg.type === 'interactive' && msg.interactive) {
    const r = msg.interactive.button_reply || msg.interactive.list_reply || {};
    return atendimento.receberMensagemCliente(barbeariaId, { ...base, texto: r.title || '' });
  }
  if (msg.type === 'location' && msg.location) {
    const l = msg.location;
    const texto = [l.name, l.address].filter(Boolean).join(' — ') +
      (l.latitude != null ? (l.name || l.address ? '\n' : '') + 'https://maps.google.com/?q=' + l.latitude + ',' + l.longitude : '');
    return atendimento.receberMensagemCliente(barbeariaId, { ...base, tipo: 'localizacao', texto: texto.trim() || '📍 Localização' });
  }
  if (msg.type === 'contacts' && msg.contacts) {
    const texto = msg.contacts.map((ct) => {
      const nome = (ct.name && (ct.name.formatted_name || ct.name.first_name)) || 'Contato';
      const tels = (ct.phones || []).map((p) => p.phone || p.wa_id).filter(Boolean).join(', ');
      return nome + (tels ? ': ' + tels : '');
    }).join('\n');
    return atendimento.receberMensagemCliente(barbeariaId, { ...base, tipo: 'contato', texto });
  }

  const tipo = TIPO_NOSSO[msg.type];
  const dado = tipo && msg[msg.type];
  if (!dado || !dado.id) return; // reação, pedido, etc.: ignorados por ora

  const midia = await whatsapp.baixarMidia(barbeariaId, dado.id);
  const mime = (midia && midia.mimeType) || dado.mime_type || null;
  const arquivo = midia ? waMidia.salvar(midia.buffer, mime, dado.filename) : null;
  const infoMidia = { arquivo, mime, nome: dado.filename || null };

  if (tipo === 'audio') {
    // Correção B1 do Sérgio: transcrever custa; só quando o plano tem secretária.
    // Sem ela, o áudio fica em Conversas sem texto para a equipe ouvir.
    const comSecretaria = planoCortavo.temSecretaria(await planoCortavo.planoDaBarbearia(barbeariaId));
    const texto = midia && comSecretaria ? await transcricao.transcrever(midia.buffer, mime) : null;
    if (texto) console.log('[webhook] áudio transcrito:', JSON.stringify(texto.slice(0, 80)));
    // Sem transcrição o áudio fica na caixa de entrada pra alguém ouvir.
    return atendimento.receberMensagemCliente(barbeariaId, { ...base, tipo, midia: infoMidia, texto: texto || '' });
  }
  return atendimento.receberMensagemCliente(barbeariaId, { ...base, tipo, midia: infoMidia, texto: dado.caption || '' });
}

module.exports = { verificar, receber, processarMensagem }; // processarMensagem exportada para teste
