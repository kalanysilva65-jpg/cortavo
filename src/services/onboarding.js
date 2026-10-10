// Estado dos "Primeiros passos" por usuário (spec 11). Guarda só o que NÃO dá
// para deduzir do banco: "link compartilhado", passos vistos e quando a pessoa
// escondeu o cartão. Antes ficava no aparelho (localStorage); agora vale em
// qualquer aparelho.
const prisma = require('../config/db');

const PASSOS_VALIDOS = new Set(['servicos', 'equipe', 'horarios', 'link', 'agenda', 'caixa', 'comissoes', 'secretaria']);

function lerEstado(texto) {
  let e = {};
  try { e = texto ? JSON.parse(texto) : {}; } catch (err) { e = {}; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) e = {};
  return {
    vistos: Array.isArray(e.vistos) ? e.vistos.filter((p) => PASSOS_VALIDOS.has(p)) : [],
    link: e.link === true,
  };
}

async function doUsuario(usuarioId) {
  const u = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { onboardingEstado: true, onboardingOcultoEm: true } });
  return { estado: lerEstado(u && u.onboardingEstado), ocultoEm: (u && u.onboardingOcultoEm) || null };
}

// Ações: 'esconder' | 'mostrar' (Mais > Ajuda) | 'link' (copiou/compartilhou o
// link) | 'visto' (com `passo`). Devolve o estado novo ou null (ação inválida).
async function registrar(usuarioId, acao, passo, agora = new Date()) {
  const atual = await doUsuario(usuarioId);
  const data = {};
  if (acao === 'esconder') data.onboardingOcultoEm = agora;
  else if (acao === 'mostrar') data.onboardingOcultoEm = null;
  else if (acao === 'link') data.onboardingEstado = JSON.stringify({ ...atual.estado, link: true });
  else if (acao === 'visto' && PASSOS_VALIDOS.has(passo)) {
    const vistos = Array.from(new Set([...atual.estado.vistos, passo]));
    data.onboardingEstado = JSON.stringify({ ...atual.estado, vistos });
  } else return null;
  await prisma.usuario.update({ where: { id: usuarioId }, data });
  return doUsuario(usuarioId);
}

module.exports = { lerEstado, doUsuario, registrar, PASSOS_VALIDOS };
