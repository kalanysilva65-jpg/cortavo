// Acesso por link (spec 13): junta o token (tokensAcesso), o e-mail (email) e a
// auditoria. É o único lugar que monta o link e manda o e-mail de acesso.
//
// Regra de ouro: NUNCA lança. Quem chama (criar barbearia, reenviar, esqueci a
// senha) recebe { ok, motivo, texto } e decide o aviso; falha de e-mail nunca
// vira erro 500 e nunca desfaz a conta criada.
const prisma = require('../config/db');
const tokens = require('./tokensAcesso');
const email = require('./email');
const auditoria = require('./auditoria');

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

// Limites (seção 4 da spec). Contados na tabela, não na memória.
const REENVIO_INTERVALO_MS = 60 * 1000; // 1 reenvio a cada 60 s por pessoa
const REENVIO_MAX_DIA = 5; // no máximo 5 por dia por pessoa
const ESQUECI_MAX_HORA = 3; // "esqueci": 3 por hora por e-mail

// Começo do dia em Brasília (UTC-3, sem horário de verão desde 2019).
function inicioDoDiaBR(agora = new Date()) {
  const fuso = 3 * HORA;
  return new Date(Math.floor((agora.getTime() - fuso) / DIA) * DIA + fuso);
}

// Base do link: SEMPRE do APP_DOMAIN, nunca do Host do pedido (um Host forjado
// faria o e-mail legítimo apontar para o site de um atacante). Sem APP_DOMAIN
// (desenvolvimento): http://localhost:{PORT}.
function baseDoLink(env = process.env) {
  const dominio = String(env.APP_DOMAIN || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (dominio && /^[a-z0-9.-]+(:\d+)?$/.test(dominio)) return `https://${dominio}`;
  return `http://localhost:${Number(env.PORT) || 3000}`;
}

function montarLink(token, env = process.env) {
  return `${baseDoLink(env)}/criar-senha?t=${encodeURIComponent(token)}`;
}

// Quantos e-mails de acesso já saíram hoje (teto EMAIL_LIMITE_DIA).
async function enviadosHoje(agora = new Date()) {
  return prisma.tokenAcesso.count({ where: { enviadoEm: { gte: inicioDoDiaBR(agora) } } });
}

// Gera o link, manda o e-mail e registra. `acao` é a ação de auditoria em caso
// de sucesso ('acesso.link_enviado' ou 'acesso.link_reenviado').
async function enviarLink({ usuario, barbearia, tipo, criadoPorId = null, req, acao = 'acesso.link_enviado', origem = '', agora = new Date() }) {
  const nomeBarbearia = (barbearia && barbearia.nome) || 'sua barbearia';
  const alvo = { alvoTipo: 'usuario', alvoId: usuario && usuario.id };
  const falhou = async (motivo, texto) => {
    await auditoria.registrar(req || {}, {
      acao: 'acesso.envio_falhou',
      ...alvo,
      detalhe: `E-mail de acesso não enviado para ${usuario && usuario.email} na "${nomeBarbearia}": ${texto}.`,
    });
    return { ok: false, motivo, texto };
  };

  let gerado;
  try {
    gerado = await tokens.gerar(usuario.id, tipo, criadoPorId, { agora });
  } catch (e) {
    console.log('[acesso] falha ao gerar o link:', e && e.message);
    return falhou('erro_interno', 'falha ao gerar o link');
  }

  let resultado;
  try {
    const limite = email.config().limiteDia;
    if (email.estado() === 'ok' && (await enviadosHoje(agora)) >= limite) {
      resultado = { enviado: false, motivo: 'limite_dia', texto: email.MOTIVOS.limite_dia };
    } else {
      const link = montarLink(gerado.token);
      const modelo = tipo === 'primeiro_acesso'
        ? email.modeloPrimeiroAcesso({ nome: usuario.nome, nomeBarbearia, email: usuario.email, link })
        : email.modeloNovaSenha({ nome: usuario.nome, nomeBarbearia, link });
      resultado = await email.enviar({ para: usuario.email, ...modelo, rotulo: `link de acesso do usuário ${usuario.id}` });
    }
  } catch (e) {
    console.log('[acesso] falha inesperada no envio:', e && e.message);
    resultado = { enviado: false, motivo: 'falha_envio', texto: email.MOTIVOS.falha_envio };
  }

  try {
    await prisma.tokenAcesso.update({
      where: { id: gerado.registro.id },
      data: resultado.enviado ? { enviadoEm: agora, erroEnvio: null } : { enviadoEm: null, erroEnvio: resultado.texto },
    });
  } catch (e) {
    console.log('[acesso] falha ao registrar o envio:', e && e.message);
  }

  if (!resultado.enviado) return falhou(resultado.motivo, resultado.texto);
  await auditoria.registrar(req || {}, {
    acao,
    ...alvo,
    detalhe: `Link de ${tipo === 'primeiro_acesso' ? 'primeiro acesso' : 'nova senha'} enviado para ${usuario.email} na "${nomeBarbearia}"${origem ? ` (${origem})` : ''}.`,
  });
  return { ok: true };
}

// Limite de reenvio pelo mestre (por pessoa): 1 a cada 60 s e 5 por dia.
// Só conta os links pedidos pela Kalany (criadoPorId preenchido): um curioso
// apertando "esqueci" não pode travar o reenvio dela.
async function limiteReenvio(usuarioId, agora = new Date()) {
  const recente = await prisma.tokenAcesso.count({
    where: { usuarioId, criadoPorId: { not: null }, criadoEm: { gt: new Date(agora.getTime() - REENVIO_INTERVALO_MS) } },
  });
  if (recente > 0) return 'Aguarde um minuto antes de reenviar.';
  const hoje = await prisma.tokenAcesso.count({
    where: { usuarioId, criadoPorId: { not: null }, criadoEm: { gte: inicioDoDiaBR(agora) } },
  });
  if (hoje >= REENVIO_MAX_DIA) return 'Limite de reenvios de hoje atingido.';
  return null;
}

// "Esqueci minha senha" (F5). Quem chama responde SEMPRE a mesma frase, exista o
// e-mail ou não; este trabalho roda depois da resposta (sem diferença de tempo).
// Contas do papel "dono" (sem barbearia) ficam de fora (spec, seção 2).
async function esqueciSenha({ email: emailDigitado, barbeariaId = null, req, agora = new Date() }) {
  try {
    const alvo = String(emailDigitado || '').trim().toLowerCase();
    if (!email.emailValido(alvo)) return { enviados: 0 };
    let usuarios;
    if (barbeariaId) {
      const u = await prisma.usuario.findUnique({ where: { barbeariaId_email: { barbeariaId, email: alvo } } });
      usuarios = u ? [u] : [];
    } else {
      usuarios = await prisma.usuario.findMany({ where: { email: alvo, ativo: true, barbeariaId: { not: null } }, take: 3 });
    }
    let enviados = 0;
    for (const u of usuarios) {
      if (!u || u.ativo === false || !u.barbeariaId || u.papel === 'dono') continue;
      const naUltimaHora = await prisma.tokenAcesso.count({
        where: { usuarioId: u.id, criadoPorId: null, criadoEm: { gt: new Date(agora.getTime() - HORA) } },
      });
      if (naUltimaHora >= ESQUECI_MAX_HORA) continue;
      const barbearia = await prisma.barbearia.findUnique({ where: { id: u.barbeariaId } });
      const r = await enviarLink({
        usuario: u,
        barbearia,
        tipo: u.senhaDefinidaEm ? 'redefinir' : 'primeiro_acesso',
        criadoPorId: null,
        req,
        acao: 'acesso.link_enviado',
        origem: 'pedido em "Esqueci minha senha"',
        agora,
      });
      if (r.ok) enviados++;
    }
    return { enviados };
  } catch (e) {
    console.log('[acesso] falha no "esqueci minha senha":', e && e.message);
    return { enviados: 0 };
  }
}

module.exports = {
  REENVIO_INTERVALO_MS,
  REENVIO_MAX_DIA,
  ESQUECI_MAX_HORA,
  inicioDoDiaBR,
  baseDoLink,
  montarLink,
  enviarLink,
  limiteReenvio,
  esqueciSenha,
};
