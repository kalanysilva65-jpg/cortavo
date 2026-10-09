// Envio de e-mail (spec 13, fatia F2). SMTP genérico via `nodemailer`: hoje o
// SMTP do Gmail com senha de app (remetente cortavo.app@gmail.com); amanhã
// Brevo/Resend/SES trocando SÓ o .env.
//
// Regras:
//  - credenciais só no .env do servidor (nomes em .env.example, sem valores);
//  - o app NUNCA cai por causa do e-mail: sem configuração, com envio desligado
//    ou com o SMTP fora, `enviar` devolve { enviado: false, motivo } e quem
//    chamou mostra "E-mail não enviado" com Reenviar;
//  - `nodemailer` é carregado só na hora de enviar (lazy). Se o pacote ainda
//    não foi instalado (o squad não roda npm install), o motivo é claro e o app
//    segue de pé;
//  - nada aqui escreve o conteúdo do e-mail (que leva o link) em log.
const MOTIVOS = {
  desligado: 'envio desligado',
  nao_configurado: 'e-mail não configurado',
  biblioteca_ausente: 'biblioteca de e-mail não instalada',
  destinatario_invalido: 'e-mail do destinatário inválido',
  limite_dia: 'limite diário de envios atingido',
  falha_envio: 'falha no servidor de e-mail',
};

const LIMITE_DIA_PADRAO = 200;

function config(env = process.env) {
  const porta = Number(env.EMAIL_SMTP_PORTA) || 465;
  const limite = Number(env.EMAIL_LIMITE_DIA);
  return {
    host: (env.EMAIL_SMTP_HOST || '').trim(),
    porta,
    usuario: (env.EMAIL_SMTP_USUARIO || '').trim(),
    senha: env.EMAIL_SMTP_SENHA || '',
    remetente: (env.EMAIL_REMETENTE || '').trim(),
    remetenteNome: (env.EMAIL_REMETENTE_NOME || 'Cortavo').trim() || 'Cortavo',
    desligado: ['1', 'true', 'sim'].includes(String(env.EMAIL_ENVIO_DESLIGADO || '').trim().toLowerCase()),
    limiteDia: Number.isFinite(limite) && limite > 0 ? Math.floor(limite) : LIMITE_DIA_PADRAO,
  };
}

// 'desligado' | 'nao_configurado' | 'ok'
function estado(env = process.env) {
  const c = config(env);
  if (c.desligado) return 'desligado';
  if (!c.host || !c.usuario || !c.senha || !c.remetente) return 'nao_configurado';
  return 'ok';
}

// Transporte injetado nos testes (nunca há envio de verdade nos testes).
let transporteInjetado = null;
function usarTransporte(t) {
  transporteInjetado = t || null;
}

let transporteReal = null;
let chaveTransporte = null;
function transporte(c) {
  if (transporteInjetado) return transporteInjetado;
  const chave = [c.host, c.porta, c.usuario, c.senha].join('|');
  if (transporteReal && chaveTransporte === chave) return transporteReal;
  let nodemailer;
  try {
    nodemailer = require('nodemailer'); // lazy: só quando há envio de verdade
  } catch (e) {
    const erro = new Error('O pacote "nodemailer" não está instalado. Rode `npm install` no servidor (ele está no package.json).');
    erro.motivo = 'biblioteca_ausente';
    throw erro;
  }
  transporteReal = nodemailer.createTransport({
    host: c.host,
    port: c.porta,
    secure: c.porta === 465, // 465 = SSL direto; 587 = STARTTLS
    requireTLS: c.porta !== 465,
    auth: { user: c.usuario, pass: c.senha },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  chaveTransporte = chave;
  return transporteReal;
}

// E-mail simples, sem quebra de linha (evita injeção de cabeçalho).
const RE_EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
function emailValido(e) {
  return typeof e === 'string' && e.length <= 254 && !/[\r\n]/.test(e) && RE_EMAIL.test(e);
}

// Envia um e-mail. `rotulo` é o que aparece no log (ex.: "acesso do usuário 12"),
// NUNCA o conteúdo. Devolve { enviado: true } ou { enviado: false, motivo, texto }.
async function enviar({ para, assunto, texto, html, rotulo = 'e-mail' }, { env = process.env } = {}) {
  const c = config(env);
  const falha = (motivo) => ({ enviado: false, motivo, texto: MOTIVOS[motivo] });

  if (c.desligado) {
    console.log(`[email] envio simulado (EMAIL_ENVIO_DESLIGADO): ${rotulo}`);
    return falha('desligado');
  }
  if (estado(env) !== 'ok') {
    console.log(`[email] não enviado, e-mail não configurado: ${rotulo}`);
    return falha('nao_configurado');
  }
  if (!emailValido(para)) return falha('destinatario_invalido');

  let t;
  try {
    t = transporte(c);
  } catch (e) {
    console.log(`[email] ${e.message}`);
    return falha(e.motivo || 'falha_envio');
  }
  try {
    await t.sendMail({
      from: { name: c.remetenteNome.replace(/[\r\n"]/g, ''), address: c.remetente },
      replyTo: c.remetente,
      to: para,
      subject: assunto,
      text: texto,
      html,
    });
    return { enviado: true };
  } catch (e) {
    // Só o código técnico (ex.: EAUTH, ETIMEDOUT): a mensagem do servidor pode
    // trazer o endereço do destinatário.
    console.log(`[email] falha ao enviar (${(e && (e.code || e.responseCode)) || 'erro'}): ${rotulo}`);
    return falha('falha_envio');
  }
}

// ---------- Modelos (seção 6 da spec, textos aprovados) ----------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || 'tudo bem';
}

const LINK_APP_IOS = 'https://apps.apple.com/br/app/cortavo/id6804311130';
const SITE = 'https://cortavo.com.br';

// HTML simples: sem imagem, sem pixel, sem link encurtado. Botão + o endereço
// completo escrito embaixo (para a pessoa conferir que é cortavo.com.br).
function moldeHtml(paragrafos) {
  const corpo = paragrafos.join('\n');
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F2F2F2;">
<div style="max-width:520px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.5;color:#111111;">
<div style="background:#FFFFFF;border-radius:24px;padding:24px;">
${corpo}
</div>
</div>
</body></html>`;
}
const p = (html) => `<p style="margin:0 0 16px;">${html}</p>`;
const botao = (link, rotulo) =>
  `<p style="margin:8px 0 8px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111111;color:#FFFFFF;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:999px;">${escapeHtml(rotulo)}</a></p>` +
  `<p style="margin:0 0 16px;font-size:13px;color:#3D3D3D;word-break:break-all;">${escapeHtml(link)}</p>`;

// 6.1 Primeiro acesso
function modeloPrimeiroAcesso({ nome, nomeBarbearia, email, link }) {
  const n = primeiroNome(nome);
  const assunto = 'Crie sua senha de acesso à Cortavo';
  const texto = [
    `Olá, ${n}.`,
    '',
    `A conta da ${nomeBarbearia} na Cortavo foi criada. Para entrar, crie a sua senha pelo link abaixo:`,
    '',
    'Criar minha senha:',
    link,
    '',
    'O link vale por 72 horas e funciona uma vez só.',
    '',
    `Depois de criar a senha, você entra com este e-mail (${email}) e a senha que escolheu:`,
    `- no iPhone, pelo app Cortavo da App Store: ${LINK_APP_IOS}`,
    `- no Android ou no computador, pelo navegador, em ${SITE}`,
    '',
    'Se você não esperava este e-mail, pode ignorar. Sem criar a senha, ninguém entra na conta.',
    '',
    'A Cortavo nunca pede a sua senha por e-mail, WhatsApp ou Instagram.',
    '',
    'Dúvidas? É só responder este e-mail.',
    '',
    'Equipe Cortavo',
  ].join('\n');
  const html = moldeHtml([
    p(`Olá, ${escapeHtml(n)}.`),
    p(`A conta da ${escapeHtml(nomeBarbearia)} na Cortavo foi criada. Para entrar, crie a sua senha pelo link abaixo:`),
    botao(link, 'Criar minha senha'),
    p('O link vale por 72 horas e funciona uma vez só.'),
    p(`Depois de criar a senha, você entra com este e-mail (${escapeHtml(email)}) e a senha que escolheu:`),
    `<ul style="margin:0 0 16px;padding-left:20px;"><li>no iPhone, pelo app Cortavo da App Store: <a href="${LINK_APP_IOS}" style="color:#111111;">${LINK_APP_IOS}</a></li><li>no Android ou no computador, pelo navegador, em <a href="${SITE}" style="color:#111111;">${SITE}</a></li></ul>`,
    p('Se você não esperava este e-mail, pode ignorar. Sem criar a senha, ninguém entra na conta.'),
    p('A Cortavo nunca pede a sua senha por e-mail, WhatsApp ou Instagram.'),
    p('Dúvidas? É só responder este e-mail.'),
    p('Equipe Cortavo'),
  ]);
  return { assunto, texto, html };
}

// 6.2 Nova senha (pedida pela Kalany ou "esqueci minha senha")
function modeloNovaSenha({ nome, nomeBarbearia, link }) {
  const n = primeiroNome(nome);
  const assunto = 'Link para criar uma nova senha na Cortavo';
  const texto = [
    `Olá, ${n}.`,
    '',
    `Recebemos um pedido para criar uma nova senha para o seu acesso à ${nomeBarbearia} na Cortavo. Para continuar, use o link abaixo:`,
    '',
    'Criar nova senha:',
    link,
    '',
    'O link vale por 1 hora e funciona uma vez só. Enquanto você não criar a nova senha, a atual continua valendo.',
    '',
    'Se não foi você que pediu, pode ignorar este e-mail. Sua senha não muda.',
    '',
    'A Cortavo nunca pede a sua senha por e-mail, WhatsApp ou Instagram.',
    '',
    'Equipe Cortavo',
  ].join('\n');
  const html = moldeHtml([
    p(`Olá, ${escapeHtml(n)}.`),
    p(`Recebemos um pedido para criar uma nova senha para o seu acesso à ${escapeHtml(nomeBarbearia)} na Cortavo. Para continuar, use o link abaixo:`),
    botao(link, 'Criar nova senha'),
    p('O link vale por 1 hora e funciona uma vez só. Enquanto você não criar a nova senha, a atual continua valendo.'),
    p('Se não foi você que pediu, pode ignorar este e-mail. Sua senha não muda.'),
    p('A Cortavo nunca pede a sua senha por e-mail, WhatsApp ou Instagram.'),
    p('Equipe Cortavo'),
  ]);
  return { assunto, texto, html };
}

module.exports = {
  MOTIVOS,
  LIMITE_DIA_PADRAO,
  config,
  estado,
  enviar,
  usarTransporte,
  emailValido,
  escapeHtml,
  modeloPrimeiroAcesso,
  modeloNovaSenha,
};
