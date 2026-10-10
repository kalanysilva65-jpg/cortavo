/* =========================================================================
   Cortavo v3 · Vida nas telas do painel (movimento-app-proposta.md, Dani
   2026-10-10). Usa o motor que já existe (cv-mola.js e cv-movimento.js),
   sem biblioteca. Regras do motion-spec:
   - só transform e opacity (nada de layout);
   - tudo interrompível: um toque termina na hora o que está animando;
   - "reduzir movimento" esmaece em vez de ficar mudo;
   - nada animando em aba escondida.
   ========================================================================= */
(function (g) {
  'use strict';
  var doc = g.document;
  var EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
  function reduz() { return !!(g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  // A tela vem do layout (data-tela no body); sem ele, o endereço.
  function caminho() { var t = doc.body && doc.body.getAttribute('data-tela'); return t || (g.location.pathname || '').replace(/\/+$/, '') || '/painel'; }
  // "Uma vez" por sessão (cascata) ou por dia (números), por tela.
  function primeiraVez(chave) {
    try { if (g.sessionStorage.getItem(chave)) return false; g.sessionStorage.setItem(chave, '1'); return true; } catch (e) { return true; }
  }
  var animando = [];
  function guardar(a) { if (a) animando.push(a); return a; }
  // Interrompível: o primeiro toque ou tecla termina tudo o que está entrando.
  function terminarTudo() { animando.forEach(function (a) { try { a.finish(); } catch (e) {} }); animando = []; }
  doc.addEventListener('pointerdown', terminarTudo, { capture: true, passive: true });
  doc.addEventListener('keydown', terminarTudo, { capture: true });
  doc.addEventListener('visibilitychange', function () { if (doc.hidden) terminarTudo(); });

  /* ---- #2 Listas e cartões em cascata ------------------------------------
     Na primeira entrada da tela na sessão: até 8 cartões ou linhas visíveis
     sobem 8 px e aparecem, 30 ms entre eles (teto de 240 ms), 260 ms cada.
     O resto já entra pronto. Reduzir movimento: só esmaece em 150 ms. */
  var SEL_CASCATA = '.cv-tela .cv-objeto, .cv-tela .cv-cartao, .cv-tela .cv-lista > li, .cv-tela [data-cascata] > *';
  function cascata() {
    if (!g.Element || !Element.prototype.animate) return;
    if (!primeiraVez('cvCascata:' + caminho())) return;
    var alt = g.innerHeight, vistos = [], itens = [];
    Array.prototype.forEach.call(doc.querySelectorAll(SEL_CASCATA), function (el) {
      if (itens.length >= 8) return;
      if (el.closest('.cv-folha, [hidden]')) return;
      if (vistos.some(function (v) { return v.contains(el); })) return; // não anima filho de quem já anima
      var r = el.getBoundingClientRect(); if (!r.height || r.top > alt || r.bottom < 0) return;
      vistos.push(el); itens.push(el);
    });
    var rd = reduz();
    itens.forEach(function (el, i) {
      guardar(el.animate(rd ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
        { duration: rd ? 150 : 260, delay: rd ? 0 : Math.min(i * 30, 240), easing: EASE_OUT, fill: 'backwards' }));
    });
  }

  /* ---- #3 M2 nas telas de números ----------------------------------------
     Gestão, Caixa, Comissões e Metas: na primeira abertura do dia de cada
     tela, os números contam (700 ms, quartic out), os anéis fecham (80 ms
     entre eles) e as barras crescem (500 ms, 24 ms entre elas), como a Início.
     Só o que está visível, no máximo 6 números. Depois, tudo entra pronto.
     Reduzir movimento: o motor já entrega o valor final (Cortavo.reduz). */
  var TELAS_M2 = ['/painel/gestao', '/painel/caixa', '/painel/comissoes', '/painel/metas'];
  function visivel(el) { var r = el.getBoundingClientRect(); return r.height > 0 && r.top < g.innerHeight && r.bottom > 0 && !el.closest('.cv-folha, [hidden]'); }
  function numeros() {
    var C = g.Cortavo; if (!C || TELAS_M2.indexOf(caminho()) < 0) return;
    if (!primeiraVez('cvM2:' + caminho() + ':' + new Date().toDateString())) return;
    // #12 Reduzir movimento sem ficar mudo: números, anéis e barras entram
    // prontos, mas esmaecem (200 ms) em vez de aparecer secos.
    if (reduz()) {
      Array.prototype.forEach.call(doc.querySelectorAll('.cv-tela .cv-num, .cv-tela .cv-aneis, .cv-tela .cv-barras, .cv-tela .cv-hbarras'), function (el) {
        if (visivel(el)) guardar(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear' }));
      });
    }
    var n = 0;
    Array.prototype.forEach.call(doc.querySelectorAll('.cv-tela .cv-num'), function (el) {
      var iEl = el.querySelector('.int'), cEl = el.querySelector('.cent');
      if (n >= 6 || !iEl || !visivel(el)) return;
      var t = iEl.textContent.trim(); if (!/^\d[\d.]*$/.test(t)) return; // só número limpo (sem sinal nem texto)
      var v = parseInt(t.replace(/\D/g, ''), 10) + (cEl ? (parseInt(cEl.textContent.replace(/\D/g, ''), 10) || 0) / 100 : 0);
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim()); // o leitor ouve o valor final
      n++; C.contar(el, v, { casas: cEl ? 2 : 0, dur: 700 });
    });
    Array.prototype.forEach.call(doc.querySelectorAll('.cv-tela .cv-aneis'), function (svg) {
      if (!visivel(svg)) return;
      Array.prototype.forEach.call(svg.querySelectorAll('.arco'), function (a) {
        var off = parseFloat(a.style.strokeDashoffset || a.getAttribute('stroke-dashoffset') || '100');
        a.setAttribute('data-p', String(Math.max(0, Math.min(1, 1 - off / 100))));
        a.style.strokeDashoffset = ''; a.removeAttribute('stroke-dashoffset');
      });
      C.aneis(svg, { abertura: true });
    });
    var verticais = Array.prototype.filter.call(doc.querySelectorAll('.cv-tela .cv-barras .barra[data-v]'), visivel);
    if (verticais.length) C.barras(verticais, verticais.map(function (b) { return +b.getAttribute('data-v'); }), { inicial: true });
    var horizontais = Array.prototype.filter.call(doc.querySelectorAll('.cv-tela b[style*="scaleX"], .cv-tela i[style*="scaleX"]'), visivel).slice(0, 12);
    if (horizontais.length) C.barras(horizontais, horizontais.map(function (b) { var m = /scaleX\(([\d.]+)\)/.exec(b.getAttribute('style')); return m ? +m[1] : 0; }), { inicial: true, eixo: 'X' });
  }

  /* ---- #5 Carregando de verdade (M3) --------------------------------------
     Espera de mais de 300 ms mostra a barra listrada (poste, 4 px) no topo:
     buscas por fetch do próprio painel e a troca de página (link ou
     formulário). Antes de 300 ms, nada pisca. Conteúdo que vai ser trocado
     ganha esqueleto no formato dele (CortavoVida.esqueleto). Reduzir
     movimento: a listra e o esqueleto ficam parados (já no CSS). */
  var ESPERA = 300, pendentes = 0, timer = null, poste = null;
  function mostrarPoste() {
    if (!poste) { poste = doc.createElement('div'); poste.className = 'cv-poste cv-poste--topo'; poste.setAttribute('role', 'progressbar'); poste.setAttribute('aria-label', 'Carregando'); doc.body.appendChild(poste); }
    poste.hidden = false;
  }
  function esconderPoste() { clearTimeout(timer); timer = null; if (poste) poste.hidden = true; }
  function comecou() { pendentes++; if (!timer) timer = setTimeout(mostrarPoste, ESPERA); }
  function acabou() { pendentes = Math.max(0, pendentes - 1); if (!pendentes) esconderPoste(); }
  // Buscas de fundo (conversa aberta, notificações) não acendem o poste.
  var FUNDO = /\/novas\?|\/notificacoes\//;
  if (g.fetch) {
    var fetchOriginal = g.fetch;
    g.fetch = function (url) {
      var u = String(url && url.url ? url.url : url || '');
      var conta = !FUNDO.test(u) && (u.charAt(0) === '/' || u.indexOf(g.location.origin) === 0);
      if (conta) comecou();
      var pr = fetchOriginal.apply(this, arguments);
      if (conta) pr.then(acabou, acabou);
      return pr;
    };
  }
  // Troca de página: o documento antigo fica na tela (view transition) e o
  // poste avisa que a próxima está vindo. Volta pelo histórico apaga.
  doc.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]'); if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || a.target === '_blank' || a.hasAttribute('download')) return;
    var h = a.getAttribute('href'); if (!h || h.charAt(0) === '#' || /^(mailto|tel|https?):/i.test(h) && a.origin !== g.location.origin) return;
    if (a.pathname === g.location.pathname && a.search === g.location.search && a.hash) return;
    timer = timer || setTimeout(mostrarPoste, ESPERA);
  });
  doc.addEventListener('submit', function (e) { if (!e.defaultPrevented) timer = timer || setTimeout(mostrarPoste, ESPERA); });
  g.addEventListener('pageshow', esconderPoste);
  function esqueleto(el, opc) {
    opc = opc || {}; var linhas = opc.linhas || 3, alt = opc.altura || 44, feito = false;
    var t = setTimeout(function () {
      if (feito) return;
      var h = ''; for (var i = 0; i < linhas; i++) h += '<div class="cv-esq" style="height:' + alt + 'px;margin-top:' + (i ? 8 : 0) + 'px' + (opc.coluna ? ';grid-column:1/-1' : '') + '"></div>';
      el.innerHTML = '<div class="cv-esq-grupo" role="progressbar" aria-label="Carregando"' + (opc.coluna ? ' style="grid-column:1/-1"' : '') + '>' + h + '</div>';
    }, ESPERA);
    return function fim() { feito = true; clearTimeout(t); };
  }
  // Conteúdo que chega depois da espera entra com 240 ms (esmaece).
  function chegou(el) { if (el && el.animate) guardar(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduz() ? 150 : 240, easing: EASE_OUT })); }

  function iniciar() { cascata(); numeros(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
  g.CortavoVida = { terminarTudo: terminarTudo, reduz: reduz, esqueleto: esqueleto, chegou: chegou };
})(window);
