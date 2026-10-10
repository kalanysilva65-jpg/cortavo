// Sessão ainda vale? (spec 13, fatia F6, recomendada pelo Sergio)
//
// A sessão não era revalidada no banco: trocar a senha ou desativar alguém não
// derrubava as sessões já abertas (até 8 h, ou 30 dias com "manter conectado").
// Agora, a cada pedido de quem está logado, UMA leitura leve (por id, só dois
// campos) confere:
//  - a pessoa ainda existe e está ativa;
//  - a "versão" da senha (senhaDefinidaEm) é a mesma de quando a sessão nasceu.
// Se não, a sessão é encerrada e a pessoa volta ao login.
//
// Sessões que já existiam antes deste código não têm a versão gravada: elas
// ADOTAM a versão atual no primeiro pedido (ninguém é deslogado no deploy); a
// partir daí, uma troca de senha derruba todas.
const prisma = require('../config/db');

function versao(u) {
  return u && u.senhaDefinidaEm ? new Date(u.senhaDefinidaEm).getTime() : 0;
}

async function sessaoValida(req, res, next) {
  const s = req.session;
  if (!s || !s.usuario || !s.usuario.id) return next();
  let u;
  try {
    u = await prisma.usuario.findUnique({ where: { id: s.usuario.id }, select: { ativo: true, senhaDefinidaEm: true, papel: true, barbeariaId: true } });
  } catch (e) {
    // Banco indisponível: não derruba ninguém por isso (o pedido segue e falha
    // onde falharia de qualquer jeito).
    return next();
  }
  // Achado M3 do Sergio: o papel e a barbearia ficam na sessão (req.ehAdmin,
  // exigeAdmin). Se mudaram no banco (admin rebaixado a barbeiro, pessoa
  // movida), a sessão antiga cai: a pessoa entra de novo já com o papel novo.
  const mudouPapel = u && ((u.papel !== undefined && s.usuario.papel !== undefined && u.papel !== s.usuario.papel) || (u.barbeariaId !== undefined && s.usuario.barbeariaId !== undefined && (u.barbeariaId || null) !== (s.usuario.barbeariaId || null)));
  if (mudouPapel) {
    return s.destroy(() => {
      res.locals.usuario = null;
      res.redirect('/login');
    });
  }
  if (s.senhaVersao === undefined && u && u.ativo !== false) {
    s.senhaVersao = versao(u);
    return next();
  }
  if (!u || u.ativo === false || versao(u) !== s.senhaVersao) {
    return s.destroy(() => {
      res.locals.usuario = null;
      res.redirect('/login');
    });
  }
  next();
}

module.exports = { sessaoValida };
