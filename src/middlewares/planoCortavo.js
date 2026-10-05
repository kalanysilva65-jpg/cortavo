// Bloqueio NO SERVIDOR das rotas do painel fora do plano da Cortavo (spec 04,
// critério 1). Esconder o menu não basta: acessar o endereço direto também
// para aqui. Usa a barbearia já carregada em res.locals.barbeariaAtual pelo
// middleware do painel (sem consulta extra ao banco).
const planoCortavo = require('../services/planoCortavo');

function exigeFuncaoDoPlano(req, res, next) {
  const plano = planoCortavo.planoDe(res.locals.barbeariaAtual && res.locals.barbeariaAtual.planoCortavo);
  res.locals.planoCortavo = plano;
  res.locals.planoLibera = (funcao) => planoCortavo.libera(plano, funcao);

  const funcao = planoCortavo.funcaoDoCaminho(req.path);
  if (!funcao || planoCortavo.libera(plano, funcao.chave)) return next();

  const texto = planoCortavo.textoForaDoPlano(funcao.chave);
  if (req.method === 'GET' && !req.xhr && (req.headers.accept || '').includes('text/html')) {
    return res.status(403).render('painel/fora-do-plano', { titulo: funcao.rotulo, funcao, texto, plano });
  }
  return res.status(403).json({ erro: texto, foraDoPlano: true });
}

module.exports = { exigeFuncaoDoPlano };
