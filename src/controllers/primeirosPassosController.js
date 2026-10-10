// POST /painel/primeiros-passos (spec 11): grava o estado dos Primeiros passos
// do PRÓPRIO usuário logado. Corpo: { acao: 'esconder'|'mostrar'|'link'|'visto', passo? }.
// Nunca aceita outro usuário: se vier `usuarioId` diferente do da sessão, 403.
const onboarding = require('../services/onboarding');

async function registrar(req, res) {
  const eu = req.session.usuario.id;
  const body = req.body || {};
  if (body.usuarioId !== undefined && Number(body.usuarioId) !== eu) {
    return res.status(403).json({ erro: 'Só dá para mudar os seus próprios primeiros passos.' });
  }
  const r = await onboarding.registrar(eu, String(body.acao || ''), String(body.passo || ''));
  if (!r) return res.status(400).json({ erro: 'Ação inválida.' });
  res.json({ ok: true, oculto: !!r.ocultoEm, link: r.estado.link, vistos: r.estado.vistos });
}

module.exports = { registrar };
