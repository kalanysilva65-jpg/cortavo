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
  function caminho() { return (g.location.pathname || '').replace(/\/+$/, '') || '/painel'; }
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

  function iniciar() { cascata(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
  g.CortavoVida = { terminarTudo: terminarTudo, reduz: reduz };
})(window);
