// Tokens do acesso por link (spec 13). A pessoa recebe um e-mail com um link e
// cria a PRÓPRIA senha; ninguém (nem a Kalany) conhece a senha dela.
//
// Regras de segurança (seção 4 da spec, checagem do Sergio):
//  - token = 32 bytes de crypto.randomBytes em base64url (256 bits);
//  - o banco guarda SÓ o sha256 do token (hex). Hash rápido basta: o token tem
//    256 bits de entropia (bcrypt é para senha escolhida por gente);
//  - uso único e atômico: o consumo é um updateMany condicionado que precisa
//    afetar exatamente 1 linha (dois toques ao mesmo tempo: só um vence);
//  - um link vivo por pessoa: gerar um novo revoga os abertos;
//  - pessoa inativa = link inválido;
//  - nada aqui escreve o token, o link ou o hash em log.
const crypto = require('crypto');
const prisma = require('../config/db');

// Prazos (decisão da Kalany, 2026-10-09). No código, não no .env.
const ACESSO_LINK_HORAS_PRIMEIRO = 72;
const ACESSO_LINK_HORAS_REDEFINIR = 1;
const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const TIPOS = { primeiro_acesso: ACESSO_LINK_HORAS_PRIMEIRO, redefinir: ACESSO_LINK_HORAS_REDEFINIR };

// Tokens usados, revogados ou vencidos há mais que isto são apagados (LGPD).
const RETENCAO_DIAS = 30;

// Formato do token em base64url: 32 bytes viram 43 caracteres.
const FORMATO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function tokenNovo() {
  return crypto.randomBytes(32).toString('base64url');
}

// Revoga todos os links ainda abertos da pessoa (troca de e-mail, desativar,
// gerar um novo). Devolve quantos foram revogados.
async function revogarDoUsuario(usuarioId, { agora = new Date(), db = prisma } = {}) {
  const r = await db.tokenAcesso.updateMany({
    where: { usuarioId, usadoEm: null, revogadoEm: null },
    data: { revogadoEm: agora },
  });
  return (r && r.count) || 0;
}

// Gera um link novo para a pessoa. Revoga os abertos antes (só um vivo).
// Devolve { token, registro }: o token em claro vai SÓ para quem chamou montar o
// link do e-mail; nunca é gravado.
async function gerar(usuarioId, tipo, criadoPorId = null, { agora = new Date() } = {}) {
  if (!TIPOS[tipo]) throw new Error('tipo de link inválido');
  const token = tokenNovo();
  const registro = await prisma.$transaction(async (tx) => {
    await revogarDoUsuario(usuarioId, { agora, db: tx });
    return tx.tokenAcesso.create({
      data: {
        usuarioId,
        tokenHash: hashToken(token),
        tipo,
        expiraEm: new Date(agora.getTime() + TIPOS[tipo] * HORA),
        criadoPorId: criadoPorId || null,
        criadoEm: agora,
      },
    });
  });
  return { token, registro };
}

// Confere um link pelo HASH (a sessão guarda o hash depois do GET, nunca o
// token). Devolve { registro, usuario } ou null. Qualquer motivo de recusa
// (não existe, usado, revogado, vencido, pessoa inativa) dá o MESMO null: a tela
// não pode dizer o motivo.
async function validarHash(tokenHash, { agora = new Date() } = {}) {
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  const registro = await prisma.tokenAcesso.findUnique({ where: { tokenHash } });
  if (!registro) return null;
  if (registro.usadoEm || registro.revogadoEm) return null;
  if (new Date(registro.expiraEm).getTime() <= agora.getTime()) return null;
  const usuario = await prisma.usuario.findUnique({ where: { id: registro.usuarioId } });
  if (!usuario || usuario.ativo === false || !usuario.barbeariaId) return null;
  return { registro, usuario };
}

// Confere o token em claro (vindo do link).
async function validar(token, opcoes) {
  if (typeof token !== 'string' || !FORMATO_TOKEN.test(token)) return null;
  return validarHash(hashToken(token), opcoes);
}

// Consome o link e grava a senha nova, tudo numa transação:
//  1) updateMany condicionado (não usado, não revogado, não vencido) precisa
//     afetar exatamente 1 linha: é o que garante o uso único mesmo com dois
//     pedidos chegando juntos;
//  2) grava o hash bcrypt (calculado ANTES, fora da transação, para ela ser
//     curta), senhaProvisoria = false e senhaDefinidaEm = agora;
//  3) revoga qualquer outro link aberto da pessoa.
// Devolve o usuário atualizado ou null (link sem valor).
async function consumirHash(tokenHash, senhaHash, { agora = new Date() } = {}) {
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  return prisma.$transaction(async (tx) => {
    const r = await tx.tokenAcesso.updateMany({
      where: { tokenHash, usadoEm: null, revogadoEm: null, expiraEm: { gt: agora } },
      data: { usadoEm: agora },
    });
    if (!r || r.count !== 1) return null;
    const registro = await tx.tokenAcesso.findUnique({ where: { tokenHash } });
    const usuario = await tx.usuario.findUnique({ where: { id: registro.usuarioId } });
    if (!usuario || usuario.ativo === false || !usuario.barbeariaId) {
      // Pessoa desativada entre abrir e enviar: desfaz o consumo jogando a
      // transação fora (nada é gravado).
      throw new ErroLinkSemValor();
    }
    const atualizado = await tx.usuario.update({
      where: { id: usuario.id },
      data: { senhaHash, senhaProvisoria: false, senhaDefinidaEm: agora },
    });
    await tx.tokenAcesso.updateMany({
      where: { usuarioId: usuario.id, usadoEm: null, revogadoEm: null },
      data: { revogadoEm: agora },
    });
    return atualizado;
  }).catch((e) => {
    if (e instanceof ErroLinkSemValor) return null;
    throw e;
  });
}

class ErroLinkSemValor extends Error {}

// Apaga links usados, revogados ou vencidos há mais de 30 dias.
async function limpar({ agora = new Date() } = {}) {
  const corte = new Date(agora.getTime() - RETENCAO_DIAS * DIA);
  const r = await prisma.tokenAcesso.deleteMany({
    where: { OR: [{ usadoEm: { lt: corte } }, { revogadoEm: { lt: corte } }, { expiraEm: { lt: corte } }] },
  });
  return (r && r.count) || 0;
}

// Roda a limpeza no boot e uma vez por dia. Nunca derruba o app.
function iniciarLimpeza() {
  const rodar = () => limpar().catch((e) => console.log('[acesso] falha na limpeza de links antigos:', e && e.message));
  setTimeout(rodar, 60 * 1000).unref();
  setInterval(rodar, DIA).unref();
}

// ---------- Estado do acesso no painel-mestre ----------
// Texto e botão de cada pessoa da equipe (seção 3, tabela do mestre).
//  - senha criada  -> "Senha criada em {data}" + "Enviar link para nova senha";
//  - aguardando    -> "Aguardando criar a senha · enviado em ... · vence em ..." + "Reenviar link";
//  - não enviado   -> "E-mail não enviado" + "Reenviar link";
//  - vencido       -> "Link vencido em {data}" + "Reenviar link".
function fmtDataHora(d) {
  const x = new Date(new Date(d).getTime() - 3 * HORA); // Brasília (sem horário de verão desde 2019)
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getUTCDate())}/${p(x.getUTCMonth() + 1)} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
}
function fmtData(d) {
  return fmtDataHora(d).slice(0, 5);
}

function estadoDoAcesso(usuario, ultimo, agora = new Date()) {
  const aberto = ultimo && !ultimo.usadoEm && !ultimo.revogadoEm;
  const vencido = aberto && new Date(ultimo.expiraEm).getTime() <= agora.getTime();
  const naoEnviado = aberto && !ultimo.enviadoEm;

  if (usuario.senhaDefinidaEm) {
    let detalhe = null;
    if (aberto && !vencido) {
      detalhe = naoEnviado
        ? 'Link de nova senha: e-mail não enviado'
        : `Link de nova senha enviado em ${fmtDataHora(ultimo.enviadoEm)} · vence em ${fmtDataHora(ultimo.expiraEm)}`;
    }
    return { codigo: 'senha_criada', texto: `Senha criada em ${fmtData(usuario.senhaDefinidaEm)}`, detalhe, botao: 'Enviar link para nova senha', alerta: !!(detalhe && naoEnviado) };
  }
  if (naoEnviado) return { codigo: 'nao_enviado', texto: 'E-mail não enviado', detalhe: null, botao: 'Reenviar link', alerta: true };
  if (vencido) return { codigo: 'vencido', texto: `Link vencido em ${fmtData(ultimo.expiraEm)}`, detalhe: null, botao: 'Reenviar link', alerta: true };
  if (aberto) {
    return {
      codigo: 'aguardando',
      texto: `Aguardando criar a senha · enviado em ${fmtDataHora(ultimo.enviadoEm)} · vence em ${fmtDataHora(ultimo.expiraEm)}`,
      detalhe: null,
      botao: 'Reenviar link',
      alerta: false,
    };
  }
  // Sem link vivo (revogado por troca de e-mail, por exemplo).
  return { codigo: 'sem_link', texto: 'Sem link válido', detalhe: null, botao: 'Reenviar link', alerta: true };
}

// Último link de cada pessoa (para o detalhe da barbearia no mestre).
async function ultimosPorUsuario(usuarioIds) {
  if (!usuarioIds.length) return {};
  const lista = await prisma.tokenAcesso.findMany({
    where: { usuarioId: { in: usuarioIds } },
    orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
  });
  const mapa = {};
  for (const t of lista) if (!mapa[t.usuarioId]) mapa[t.usuarioId] = t;
  return mapa;
}

module.exports = {
  ACESSO_LINK_HORAS_PRIMEIRO,
  ACESSO_LINK_HORAS_REDEFINIR,
  RETENCAO_DIAS,
  hashToken,
  gerar,
  validar,
  validarHash,
  consumirHash,
  revogarDoUsuario,
  limpar,
  iniciarLimpeza,
  estadoDoAcesso,
  ultimosPorUsuario,
  fmtDataHora,
};
