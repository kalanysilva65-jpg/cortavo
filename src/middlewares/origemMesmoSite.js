// Achado M5 do Sergio: o app não tem token CSRF; a defesa era só o cookie
// SameSite=Lax. Mas todos os *.cortavo.com.br são "o mesmo site" para o
// navegador: um subdomínio com conteúdo de terceiro poderia mandar POST com o
// cookie. Este freio, barato e sem mudar formulário nenhum, recusa pedidos que
// MUDAM dados (POST, PUT, PATCH, DELETE) quando:
//  - o navegador diz que o pedido veio de outro site (Sec-Fetch-Site: cross-site);
//  - ou o cabeçalho Origin aponta para outro host que não o do próprio pedido
//    (pega o caso de outro subdomínio, que o SameSite deixa passar).
// Sem os cabeçalhos (navegador antigo, curl), segue como antes.
// Os webhooks (Meta) são montados ANTES no server.js e não passam por aqui.
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

function origemPermitida(req) {
  if (METODOS_SEGUROS.has(req.method)) return true;
  const h = req.headers || {};
  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origem = h.origin;
  if (origem && origem !== 'null') {
    let host;
    try { host = new URL(origem).host.toLowerCase(); } catch (e) { return false; }
    return host === String(h.host || '').toLowerCase();
  }
  return true;
}

function origemMesmoSite(req, res, next) {
  if (origemPermitida(req)) return next();
  console.log('[origem] pedido recusado:', req.method, req.path);
  if ((req.get && (req.get('Accept') || '').includes('application/json')) || req.xhr) {
    return res.status(403).json({ erro: 'Pedido recusado (origem diferente).' });
  }
  return res.status(403).type('text').send('Pedido recusado: ele veio de outro site. Volte à página e tente de novo.');
}

module.exports = { origemMesmoSite, origemPermitida };
