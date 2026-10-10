// Aviso de conexão (pedido do dono, 2026-09-30): quando a internet cai, fica
// lenta ou uma requisição falha, mostra uma faixa no topo em vez de o app
// parecer travado. Autocontido (injeta o próprio estilo); incluído nos layouts.
(function () {
  if (window.__avisoConexao) return;
  window.__avisoConexao = true;

  var css = '.aviso-cx{position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 10px);z-index:99999;' +
    'display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:16px;background:#1a1a1a;color:#fff;' +
    'font:500 13px/1.35 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);' +
    'transform:translateY(-140%);transition:transform .25s ease;max-width:520px;margin:0 auto}' +
    '.aviso-cx.on{transform:none}.aviso-cx--ok{background:#111}' +
    '.aviso-cx span{flex:1}.aviso-cx button{border:0;border-radius:10px;padding:7px 11px;background:#fff;color:#1a1a1a;font:600 12px system-ui,sans-serif;cursor:pointer}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var el, timerEsconde, timerLento;
  function mostrar(texto, opts) {
    opts = opts || {};
    if (!el) {
      el = document.createElement('div');
      el.className = 'aviso-cx';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.className = 'aviso-cx' + (opts.ok ? ' aviso-cx--ok' : '');
    el.innerHTML = '<span></span>' + (opts.recarregar ? '<button type="button">Tentar de novo</button>' : '');
    el.firstChild.textContent = texto;
    var b = el.querySelector('button');
    if (b) b.onclick = function () { location.reload(); };
    requestAnimationFrame(function () { el.classList.add('on'); });
    clearTimeout(timerEsconde);
    if (opts.duracao) timerEsconde = setTimeout(esconder, opts.duracao);
  }
  function esconder() { if (el) el.classList.remove('on'); }

  var SEM_NET = 'Sem conexão com a internet. Verifique o Wi-Fi ou os dados móveis.';
  window.addEventListener('offline', function () { mostrar(SEM_NET); });
  window.addEventListener('online', function () { mostrar('Conexão restabelecida.', { ok: true, duracao: 2500 }); });
  if (navigator.onLine === false) mostrar(SEM_NET);

  // Navegação demorando (link ou formulário): avisa em vez de parecer travado.
  function vigiarNavegacao() {
    clearTimeout(timerLento);
    timerLento = setTimeout(function () {
      mostrar(navigator.onLine === false ? SEM_NET : 'A conexão está lenta. Aguarde um instante…', { recarregar: true });
    }, 8000);
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || a.target === '_blank' || a.hasAttribute('download')) return;
    var h = a.getAttribute('href') || '';
    if (h.charAt(0) === '#' || /^(javascript|mailto|tel|whatsapp):/i.test(h)) return;
    vigiarNavegacao();
  });
  document.addEventListener('submit', function (e) { if (!e.defaultPrevented) vigiarNavegacao(); });
  // Voltou pela página (bfcache) ou carregou: limpa.
  window.addEventListener('pageshow', function () { clearTimeout(timerLento); if (navigator.onLine !== false) esconder(); });

  // Requisições em segundo plano (fetch) que falham por rede.
  if (window.fetch) {
    var fetchOriginal = window.fetch;
    window.fetch = function () {
      return fetchOriginal.apply(this, arguments).catch(function (err) {
        if (!(err && err.name === 'AbortError')) {
          mostrar(navigator.onLine === false ? SEM_NET : 'Falha de conexão. Não foi possível concluir a ação.', { recarregar: true, duracao: 8000 });
        }
        throw err;
      });
    };
  }
})();
