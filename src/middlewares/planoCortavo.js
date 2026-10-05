// Bloqueio NO SERVIDOR das rotas do painel fora do plano da Cortavo (spec 04,
// critério 1). Esconder o menu não basta: acessar o endereço direto também
// para aqui. Usa a barbearia já carregada em res.locals.barbeariaAtual pelo
// middleware do painel (sem consulta extra ao banco).
const planoCortavo = require('../services/planoCortavo');

function exigeFuncaoDoPlano(req, res, next) {
  const plano = planoCortavo.planoDe(res.locals.barbeariaAtual && res.locals.barbeariaAtual.planoCortavo);
  res.locals.planoCortavo = plano;
  res.locals.planoLibera = (funcao) => planoCortavo.libera(plano, funcao);
  // Fase 2.4 (cadeados nos menus): função do plano que um link do painel
  // abre e que este plano NÃO libera; null quando o link está liberado.
  res.locals.foraDoPlano = (href) => {
    const f = planoCortavo.funcaoDoCaminho(String(href || '').replace(/^\/painel/, '') || '/');
    return f && !planoCortavo.libera(plano, f.chave) ? { ...f, texto: planoCortavo.textoForaDoPlano(f.chave) } : null;
  };

  const funcao = planoCortavo.funcaoDoCaminho(req.path);
  if (!funcao || planoCortavo.libera(plano, funcao.chave)) return next();

  const texto = planoCortavo.textoForaDoPlano(funcao.chave);
  if (req.method === 'GET' && !req.xhr && (req.headers.accept || '').includes('text/html')) {
    return res.status(403).render('painel/fora-do-plano', { titulo: funcao.rotulo, funcao, texto, plano });
  }
  return res.status(403).json({ erro: texto, foraDoPlano: true });
}

module.exports = { exigeFuncaoDoPlano };
