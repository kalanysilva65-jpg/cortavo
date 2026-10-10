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

// HTML da Dani (redesign/v3/acesso/emails/modelo.html), copiado para
// src/views/email/acesso-modelo.html. Tabelas e estilos inline (Gmail, Apple
// Mail, Outlook), uma imagem só (o ícone oficial, servido pelo próprio app em
// /email/icone-cortavo-192.png), botão de tabela que funciona sem imagens.
// Os {{campos}} passam por escape de HTML; só blocoExtra e duvidas são HTML
// montado aqui (com os dados já escapados).
const fs = require('fs');
const path = require('path');
let modeloCache = null;
function modeloHtml() {
  if (!modeloCache) modeloCache = fs.readFileSync(path.join(__dirname, '..', 'views', 'email', 'acesso-modelo.html'), 'utf8');
  return modeloCache;
}

// Endereço do ícone: do APP_DOMAIN (como o link), nunca do Host do pedido.
function urlIcone(env = process.env) {
  const dominio = String(env.APP_DOMAIN || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const base = dominio && /^[a-z0-9.-]+(:\d+)?$/.test(dominio) ? `https://${dominio}` : SITE;
  return `${base}/email/icone-cortavo-192.png`;
}

const FONTE = "font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
function blocoComoEntrar(email) {
  return '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:24px 0 0;"><tr><td style="' + FONTE + 'font-size:15px;line-height:23px;color:#3D3D3D;">' +
    `<p style="margin:0 0 10px;color:#111111;font-weight:bold;">Depois de criar a senha, entre com este e-mail (<span style="word-break:break-all;">${escapeHtml(email)}</span>) e a senha que escolheu:</p>` +
    `<p style="margin:0 0 6px;">No iPhone, pelo app Cortavo da App Store:<br><a href="${LINK_APP_IOS}" style="color:#111111;">apps.apple.com/br/app/cortavo</a></p>` +
    `<p style="margin:0;">No Android ou no computador, pelo navegador:<br><a href="${SITE}" style="color:#111111;">cortavo.com.br</a></p>` +
    '</td></tr></table>';
}
const DUVIDAS = '<p style="margin:16px 0 0;font-size:14px;line-height:21px;color:#666666;">Dúvidas? É só responder este e-mail.</p>';

function montarHtml(campos, brutos) {
  // Tira o comentário de instruções da Dani (não vai no e-mail).
  let s = modeloHtml()
    .replace(/<!--\s*Cortavo · e-mail de acesso[\s\S]*?-->\r?\n?/, '')
    .replace('<!-- rodapé: listra a 45° (o poste de barbeiro) feita de cor sólida, compatível -->', '<!-- rodapé -->');
  for (const [k, v] of Object.entries(campos)) s = s.split('{{' + k + '}}').join(escapeHtml(v));
  for (const [k, v] of Object.entries(brutos)) s = s.split('{{' + k + '}}').join(v);
  return s;
}

// Versão em texto (a da Dani, redesign/v3/acesso/emails/*.txt, sem as linhas
// "Assunto:" e "De:", que vão no cabeçalho).
function montarTexto(d) {
  const linhas = [`Olá, ${d.primeiroNome}.`, '', d.abertura, '', d.botao + ':', d.link, '', `O link vale por ${d.validade} ${d.validadeUnidade} e funciona uma vez só.`];
  if (d.email) {
    linhas.push('', `Depois de criar a senha, você entra com este e-mail (${d.email}) e a senha que escolheu:`,
      `- no iPhone, pelo app Cortavo da App Store: ${LINK_APP_IOS}`,
      `- no Android ou no computador, pelo navegador, em ${SITE}`);
  }
  linhas.push('', d.aviso, '', 'A Cortavo nunca pede a sua senha por e-mail, WhatsApp ou Instagram.');
  if (d.duvidas) linhas.push('', 'Dúvidas? É só responder este e-mail.');
  linhas.push('', 'Equipe Cortavo');
  return linhas.join('\n') + '\n';
}

function montar(d, env) {
  const campos = {
    assunto: d.assunto, preheader: d.preheader, titulo: d.titulo, nomeBarbearia: d.nomeBarbearia,
    primeiroNome: d.primeiroNome, abertura: d.abertura, link: d.link, botao: d.botao,
    validade: d.validade, validadeUnidade: d.validadeUnidade, aviso: d.aviso, urlIcone: urlIcone(env),
  };
  const html = montarHtml(campos, { blocoExtra: d.email ? blocoComoEntrar(d.email) : '', duvidas: d.duvidas ? DUVIDAS : '' });
  return { assunto: d.assunto, texto: montarTexto(d), html };
}

// 6.1 Primeiro acesso
function modeloPrimeiroAcesso({ nome, nomeBarbearia, email, link }, env) {
  return montar({
    assunto: 'Crie sua senha de acesso à Cortavo', titulo: 'Crie sua senha',
    preheader: 'O link vale por 72 horas. Depois, é só entrar com este e-mail e a senha que você criar.',
    primeiroNome: primeiroNome(nome), nomeBarbearia, email, link,
    abertura: `A conta da ${nomeBarbearia} na Cortavo foi criada. Para entrar, crie a sua senha pelo link abaixo:`,
    botao: 'Criar minha senha', validade: '72', validadeUnidade: 'horas',
    aviso: 'Se você não esperava este e-mail, pode ignorar. Sem criar a senha, ninguém entra na conta.',
    duvidas: true,
  }, env);
}

// 6.2 Nova senha (pedida pela Kalany ou "esqueci minha senha")
function modeloNovaSenha({ nome, nomeBarbearia, link }, env) {
  return montar({
    assunto: 'Link para criar uma nova senha na Cortavo', titulo: 'Criar uma nova senha',
    preheader: 'O link vale por 1 hora. Enquanto você não criar a nova senha, a atual continua valendo.',
    primeiroNome: primeiroNome(nome), nomeBarbearia, email: null, link,
    abertura: `Recebemos um pedido para criar uma nova senha para o seu acesso à ${nomeBarbearia} na Cortavo. Para continuar, use o link abaixo:`,
    botao: 'Criar nova senha', validade: '1', validadeUnidade: 'hora',
    aviso: 'Enquanto você não criar a nova senha, a atual continua valendo. Se não foi você que pediu, pode ignorar este e-mail. Sua senha não muda.',
    duvidas: false,
  }, env);
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
  urlIcone,
};
