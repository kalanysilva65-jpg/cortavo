// Spec 12, fatia B2: bloqueio NO SERVIDOR por chave de permissão.
//
// `exige('caixa_ver')` no lugar do `exigeAdmin` onde a leitura passa a valer
// para o barbeiro com a chave certa (R4). Usa o contexto montado pelo
// middleware do painel (`req.permissoes`, B1), que já cruza papel, o que o
// responsável liberou e o plano da Cortavo.
//
// Sem a chave:
//  - navegação (GET de HTML): volta para o Início com um aviso, como o bloqueio
//    de telas da fase 1 (critério 2: nunca uma tela de erro na navegação);
//  - API / POST: 403 em JSON SEM o dado (critério 4).
function negar(req, res, chave) {
  if (req.method === 'GET' && !req.xhr && (req.headers.accept || '').includes('text/html')) {
    req.session.flash = { tipo: 'erro', texto: 'Você não tem acesso a esta área. Fale com o responsável da barbearia.' };
    return res.redirect('/painel');
  }
  return res.status(403).json({ erro: 'Sem acesso a esta área.', semPermissao: true, chave });
}

function exige(...chaves) {
  return function exigePermissao(req, res, next) {
    const ctx = req.permissoes;
    // Sem contexto = rota montada fora do painel: fecha (nunca abre por engano).
    if (!ctx) return negar(req, res, chaves[0]);
    for (const k of chaves) if (!ctx.pode(k)) return negar(req, res, k);
    next();
  };
}

// Basta UMA das chaves (ex.: Gestão abre com meus_numeros OU numeros_barbearia).
function exigeAlguma(...chaves) {
  return function exigeAlgumaPermissao(req, res, next) {
    const ctx = req.permissoes;
    if (ctx && chaves.some((k) => ctx.pode(k))) return next();
    return negar(req, res, chaves[0]);
  };
}

module.exports = { exige, exigeAlguma, negar };
