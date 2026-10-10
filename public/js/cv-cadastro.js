/* Cortavo v3 · comportamento comum das telas de cadastro e configuração.
   - Folhas: toda .cv-folha[data-folha] vai para o body (fora do .cv-palco,
     que recua com transform), arrasta para fechar, fecha no véu, no Esc e nos
     [data-fechar]. Abre por [data-abrir-folha="id"] ou window.cvAbrirFolha(id).
   - Busca e filtros juntos: [data-busca] filtra os [data-item] de
     [data-lista] pelo data-texto; chips [data-filtro] filtram pelo
     data-filtros do item. A contagem vazia mostra [data-sem-resultado].
   - Confirmação: formulários com data-confirmar pedem confirmação antes.
   Sem JS, as folhas viram blocos no fim da página (fallback do cv.css) e os
   formulários continuam sendo POST comuns. */
(function (g) {
  'use strict';
  var doc = g.document, C = g.Cortavo;
  function $$(s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); }

  function folhas() {
    var veu = doc.querySelector('.cv-veu');
    $$('.cv-folha[data-folha]').forEach(function (f) {
      doc.body.appendChild(f);
      if (C && C.folha.arrastar) C.folha.arrastar(f);
      $$('[data-fechar]', f).forEach(function (b) { b.addEventListener('click', function () { if (C) C.folha.fechar(); }); });
    });
    if (veu) veu.addEventListener('click', function () { var a = C && C.folha.atual(); if (a && a.hasAttribute('data-folha')) C.folha.fechar(); });
    doc.addEventListener('keydown', function (e) { var a = C && C.folha.atual(); if (e.key === 'Escape' && a && a.hasAttribute('data-folha')) C.folha.fechar(); });
    g.cvAbrirFolha = function (id) {
      var f = doc.getElementById(id); if (!f || !C) return;
      if (C.folha.atual() && C.folha.atual() !== f) { C.folha.fechar(); setTimeout(function () { C.folha.abrir(f, { gatilho: doc.activeElement }); }, 260); }
      else C.folha.abrir(f, { gatilho: doc.activeElement });
    };
    doc.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-abrir-folha]') : null;
      if (!b) return;
      e.preventDefault();
      g.cvAbrirFolha(b.getAttribute('data-abrir-folha'));
    });
  }

  function busca() {
    $$('[data-lista]').forEach(function (lista) {
      var grupo = lista.getAttribute('data-lista');
      var campo = doc.querySelector('[data-busca="' + grupo + '"]');
      var chips = $$('[data-filtros-de="' + grupo + '"] [data-filtro]');
      var vazio = doc.querySelector('[data-sem-resultado="' + grupo + '"]');
      var filtro = 'todos';
      function aplicar() {
        var t = (campo ? campo.value : '').trim().toLowerCase(), dig = t.replace(/\D/g, ''), n = 0;
        $$('[data-lista="' + grupo + '"] [data-item]').forEach(function (it) {
          var texto = it.getAttribute('data-texto') || '';
          var casa = !t || texto.indexOf(t) !== -1 || (dig.length >= 3 && texto.replace(/\D/g, '').indexOf(dig) !== -1);
          var f = filtro === 'todos' || (' ' + (it.getAttribute('data-filtros') || '') + ' ').indexOf(' ' + filtro + ' ') !== -1;
          it.hidden = !(casa && f);
          if (casa && f && lista.contains(it)) n++;
        });
        if (vazio) vazio.hidden = n > 0;
      }
      if (campo) campo.addEventListener('input', aplicar);
      chips.forEach(function (c) { c.addEventListener('click', function () {
        chips.forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
        filtro = c.getAttribute('data-filtro'); aplicar();
      }); });
    });
  }

  function confirmar() {
    doc.addEventListener('submit', function (e) {
      var f = e.target, msg = f.getAttribute && f.getAttribute('data-confirmar');
      if (msg && !g.confirm(msg)) e.preventDefault();
    }, true);
  }

  function iniciar() { folhas(); busca(); confirmar(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(window);
