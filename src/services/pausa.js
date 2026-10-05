// Pausa de verdade (spec 01): barbearia com `ativo = false` não gera uso nem
// custo. Ponto único para perguntar "esta barbearia está pausada?" — usado no
// login, no painel, na secretária, no assistente e nos lembretes.
const prisma = require('../config/db');

const CONTATO = '@cortavo.app';

// true quando a barbearia existe e está pausada. Barbearia inexistente não é
// "pausada" (quem chama trata o caso de não encontrada do jeito dele).
async function estaPausada(barbeariaId) {
  if (!barbeariaId) return false;
  const b = await prisma.barbearia.findUnique({ where: { id: barbeariaId }, select: { ativo: true } });
  return !!b && b.ativo === false;
}

// Texto mostrado para a equipe. Sem valor e sem chave Pix (regra da Apple).
function mensagemPausa(nome) {
  return `O acesso da ${nome || 'barbearia'} está pausado. Fale com a Cortavo pelo direct ${CONTATO}.`;
}

// Renderiza a tela simples de "acesso pausado" (status 403).
function renderTelaPausa(res, nome) {
  return res.status(403).render('auth/acesso-pausado', {
    layout: 'layouts/auth',
    titulo: 'Acesso pausado',
    barbearia: null,
    nomeBarbearia: nome || 'barbearia',
    mensagem: mensagemPausa(nome),
  });
}

module.exports = { estaPausada, mensagemPausa, renderTelaPausa, CONTATO };
