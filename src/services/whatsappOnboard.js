// Onboarding do WhatsApp por EMBEDDED SIGNUP (coexistência).
//
// O barbeiro conecta o PRÓPRIO número num popup da Meta (e continua usando o app
// do WhatsApp Business dele — isso é a "coexistência"). O popup nos devolve:
//   - um `code` de autorização (trocamos por um token de acesso aos ativos DELE)
//   - o `waba_id` (conta do WhatsApp Business) e o `phone_number_id` (o número)
//
// A partir daí, no servidor:
//   1) trocamos o code por um token (usa o App Secret — nunca vai pro navegador)
//   2) inscrevemos o NOSSO app na WABA dele (senão a Meta não chama o webhook)
//   3) (best-effort) registramos o número na Cloud API
//   4) guardamos phone_number_id + token na Configuracao da barbearia — as MESMAS
//      chaves que o envio (services/whatsapp.js) já lê. Ou seja, terminou o popup,
//      a secretária já atende naquele número.
//
// Pré-requisitos no lado da Meta (uma vez, ver deploy/WHATSAPP.md):
//   - App com "Facebook Login for Business" + uma configuração de Embedded Signup
//     criada para COEXISTÊNCIA (o config_id vai no WHATSAPP_ES_CONFIG_ID).
//   - Env: META_APP_ID, WHATSAPP_ES_CONFIG_ID, META_APP_SECRET.
const prisma = require('../config/db');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const GRAPH = 'https://graph.facebook.com';

// Tudo que o Embedded Signup precisa está no .env?
function configurado() {
  return !!(process.env.META_APP_ID && process.env.WHATSAPP_ES_CONFIG_ID && process.env.META_APP_SECRET);
}

// Troca o `code` do popup por um token de acesso aos ativos do cliente.
async function trocarCodePorToken(code) {
  const url = new URL(`${GRAPH}/${API_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('client_secret', process.env.META_APP_SECRET);
  url.searchParams.set('code', code);
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error('troca de código falhou: ' + ((j.error && j.error.message) || `status ${r.status}`));
  }
  return j.access_token;
}

// Inscreve o NOSSO app na WABA do cliente (senão a Meta não repassa as mensagens
// recebidas pro nosso webhook). É o mesmo passo do subscribed_apps que fizemos à
// mão no número de teste — aqui é automático.
async function assinarAppNaWaba(wabaId, token) {
  const r = await fetch(`${GRAPH}/${API_VERSION}/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) {
    throw new Error('inscrever app na WABA falhou: ' + ((j.error && j.error.message) || `status ${r.status}`));
  }
  return true;
}

// Registra o número na Cloud API. Best-effort: na coexistência o próprio popup
// já pode ter registrado — se falhar, logamos e seguimos (o essencial é inscrever
// a WABA e salvar as credenciais).
async function registrarNumero(phoneNumberId, token, pin) {
  try {
    const r = await fetch(`${GRAPH}/${API_VERSION}/${phoneNumberId}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      console.log('[wa-onboard] registro do número (best-effort) falhou:', (j.error && j.error.message) || r.status);
      return false;
    }
    return true;
  } catch (e) {
    console.log('[wa-onboard] registro do número (best-effort) erro de rede:', e.message);
    return false;
  }
}

// Descobre número/nome de exibição, só para mostrar bonitinho na tela.
async function detalhesNumero(phoneNumberId, token) {
  try {
    const r = await fetch(`${GRAPH}/${API_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return {};
    const j = await r.json().catch(() => ({}));
    return { numero: j.display_phone_number || null, nome: j.verified_name || null };
  } catch (e) {
    return {};
  }
}

// Grava as credenciais na Configuracao da barbearia (mesmas chaves do envio).
async function salvarCredenciais(barbeariaId, dados) {
  const set = (chave, valor) =>
    prisma.configuracao.upsert({
      where: { barbeariaId_chave: { barbeariaId, chave } },
      create: { barbeariaId, chave, valor: String(valor) },
      update: { valor: String(valor) },
    });
  await set('whatsapp_phone_number_id', dados.phoneNumberId);
  await set('whatsapp_token', dados.token);
  if (dados.wabaId) await set('whatsapp_waba_id', dados.wabaId);
  if (dados.pin) await set('whatsapp_pin', dados.pin);
  if (dados.numero) await set('whatsapp_numero', dados.numero);
}

// Fluxo completo chamado pelo controller depois que o popup termina.
async function conectar(barbeariaId, { code, phoneNumberId, wabaId, coexistencia }) {
  if (!configurado()) throw new Error('Embedded Signup não configurado no servidor.');
  if (!code) throw new Error('faltou o código de autorização do popup.');
  const token = await trocarCodePorToken(code);
  if (wabaId) await assinarAppNaWaba(wabaId, token);
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  // Na coexistência NÃO se registra o número (/register): ele já está ativo no
  // app do barbeiro e registrar poderia tirá-lo de lá.
  if (phoneNumberId && !coexistencia) await registrarNumero(phoneNumberId, token, pin);
  const det = phoneNumberId ? await detalhesNumero(phoneNumberId, token) : {};
  await salvarCredenciais(barbeariaId, { phoneNumberId, token, wabaId, pin, numero: det.numero });
  return { numero: det.numero || null, nome: det.nome || null };
}

// Status da conexão (para a tela): conectado? qual número?
async function statusConexao(barbeariaId) {
  const regs = await prisma.configuracao.findMany({
    where: { barbeariaId, chave: { in: ['whatsapp_phone_number_id', 'whatsapp_token', 'whatsapp_numero', 'whatsapp_modo'] } },
  });
  const m = Object.fromEntries(regs.map((r) => [r.chave, r.valor]));
  const modoCortavo = m.whatsapp_modo === 'cortavo';
  return {
    conectado: !!(m.whatsapp_phone_number_id && (m.whatsapp_token || (modoCortavo && process.env.WHATSAPP_SYSTEM_TOKEN))),
    numero: m.whatsapp_numero || null,
    modoCortavo,
  };
}

// Libera o número na Meta: POST /{phone_number_id}/deregister (Cloud API,
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/registration).
// Usa o token do System User da Cortavo; nunca o loga.
// Erro lançado tem: fase 'meta', mensagemTela (amigável, sem texto técnico),
// tecnico (message/code/fbtrace_id, só para log e auditoria) e jaLiberado.
function erroMeta(tecnico, mensagemTela, jaLiberado = false) {
  const e = new Error(mensagemTela || 'A Meta não aceitou agora.');
  e.fase = 'meta';
  e.mensagemTela = mensagemTela || null;
  e.tecnico = tecnico;
  e.jaLiberado = jaLiberado;
  return e;
}

// "Número já não está registrado" conta como sucesso (correção Sergio M1).
// Só o código 133010 ("Account not registered" na Cloud API) vale (ajuste da
// Vera): procurar no TEXTO da mensagem tratava como "já liberado" erros que só
// citavam "not registered" por outro motivo. A confirmar com um teste real da
// Kalany (registrado no relatório).
function pareceJaLiberado(err) {
  if (!err) return false;
  return Number(err.code) === 133010;
}

async function desregistrarNumero(phoneNumberId, token) {
  let r;
  try {
    r = await fetch(`${GRAPH}/${API_VERSION}/${phoneNumberId}/deregister`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    throw erroMeta('fetch falhou: ' + e.message, null);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || j.success === false) {
    const er = j.error || {};
    const tecnico = `HTTP ${r.status} code=${er.code ?? '-'} subcode=${er.error_subcode ?? '-'} fbtrace_id=${er.fbtrace_id ?? '-'} msg=${String(er.message || '').slice(0, 200)}`;
    throw erroMeta(tecnico, er.error_user_msg || null, pareceJaLiberado(er));
  }
}

// Desconecta. No modo Cortavo (número na WABA da Cortavo):
//  1) libera o número na Meta; erro = NADA é apagado (fase 'meta');
//     "já não registrado" = segue como sucesso;
//  2) apaga as chaves no banco, com UMA retentativa; se ainda falhar, erro
//     de fase 'banco' (o número JÁ foi liberado na Meta: a mensagem diz isso).
// Coexistência (barbearias antigas): só apaga no banco, como antes.
// Devolve { desregistrado, jaLiberado, final4 }.
async function desconectar(barbeariaId) {
  const regs = await prisma.configuracao.findMany({
    where: { barbeariaId, chave: { in: ['whatsapp_phone_number_id', 'whatsapp_modo', 'whatsapp_numero'] } },
  });
  const m = Object.fromEntries(regs.map((r) => [r.chave, r.valor]));
  const final4 = String(m.whatsapp_numero || '').replace(/\D/g, '').slice(-4) || null;
  let desregistrado = false;
  let jaLiberado = false;
  if (m.whatsapp_modo === 'cortavo' && m.whatsapp_phone_number_id) {
    const token = process.env.WHATSAPP_SYSTEM_TOKEN;
    if (!token) throw erroMeta('WHATSAPP_SYSTEM_TOKEN ausente no servidor', null);
    try {
      await desregistrarNumero(m.whatsapp_phone_number_id, token);
    } catch (e) {
      if (!e.jaLiberado) {
        console.error('[wa-onboard] deregister falhou:', e.tecnico || e.message);
        throw e;
      }
      console.log('[wa-onboard] número já estava liberado na Meta; limpando o cadastro.');
      jaLiberado = true;
    }
    desregistrado = true;
  }
  try {
    await apagarCredenciais(barbeariaId);
  } catch (e1) {
    try {
      await apagarCredenciais(barbeariaId); // retentativa
    } catch (e2) {
      console.error('[wa-onboard] limpeza do cadastro falhou depois do deregister:', e2.message);
      const e = new Error('limpeza do cadastro falhou');
      e.fase = 'banco';
      e.desregistrado = desregistrado;
      e.tecnico = e2.message;
      e.final4 = final4;
      throw e;
    }
  }
  return { desregistrado, jaLiberado, final4 };
}

async function apagarCredenciais(barbeariaId) {
  await prisma.configuracao.deleteMany({
    where: {
      barbeariaId,
      chave: { in: ['whatsapp_phone_number_id', 'whatsapp_token', 'whatsapp_waba_id', 'whatsapp_pin', 'whatsapp_numero', 'whatsapp_modo'] },
    },
  });
}

module.exports = { configurado, conectar, statusConexao, desconectar, desregistrarNumero, pareceJaLiberado };
