/* =========================================================================
   Cortavo v3 · casca do painel (fatia F1)
   - Lente da navbar (M5): o app é renderizado no servidor, então cada toque
     na barra é uma página nova. A posição da lente vai no sessionStorage e,
     na página seguinte, ela nasce onde estava e desliza com a mola `lente`
     até a seção atual. O conteúdo troca na hora (motion-spec §1).
   - Aviso do servidor (flash) em vidro preto: some sozinho ou ao tocar.
   - Cartão com role="link": Enter e Espaço abrem (web-design-guidelines).
   - Cabeçalho compacto de vidro ao rolar, quando a tela tiver um.
   Depende de cv-mola.js e cv-movimento.js (carregados antes, com defer).
   ========================================================================= */
(function (g) {
  'use strict';
  var doc = g.document, C = g.Cortavo;
  var CHAVE = 'cvLenteDe';

  function lerLente() { try { var v = sessionStorage.getItem(CHAVE); sessionStorage.removeItem(CHAVE); return v; } catch (e) { return null; } }
  function gravarLente(v) { try { sessionStorage.setItem(CHAVE, String(v)); } catch (e) {} }

  function navbar() {
    var nav = doc.querySelector('.cv-navbar');
    if (!nav || !C) return;
    var L = nav.querySelector('.cv-lente');
    var alvo = nav.querySelector('.cv-nav-item[aria-current="page"]');
    var anterior = lerLente();
    if (alvo && L) {
      if (anterior !== null && anterior !== '' && !isNaN(+anterior) && !C.reduz()) {
        L.style.width = alvo.getBoundingClientRect().width + 'px';
        L.style.translate = (+anterior) + 'px 0';
        L.dataset.pos = anterior;
        nav.classList.add('com-lente');
        g.requestAnimationFrame(function () { C.lente(nav, alvo, true); });
      } else {
        C.lente(nav, alvo, false);
        nav.classList.add('com-lente');
      }
      g.addEventListener('resize', function () { C.lente(nav, alvo, false); });
    }
    nav.addEventListener('click', function (e) {
      var item = e.target.closest && e.target.closest('.cv-nav-item');
      if (item && L && L.dataset.pos != null) gravarLente(L.dataset.pos);
    });
  }

  function avisosDoServidor() {
    Array.prototype.forEach.call(doc.querySelectorAll('.cv-aviso[data-flash]'), function (a) {
      var saiu = false;
      function sair() {
        if (saiu) return; saiu = true;
        a.setAttribute('data-saindo', '');
        setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 260);
      }
      a.addEventListener('click', sair);
      setTimeout(sair, a.getAttribute('data-flash') === 'erro' ? 6000 : 3600);
    });
  }

  function cartoesLink() {
    doc.addEventListener('keydown', function (e) {
      var c = e.target.closest && e.target.closest('[role="link"][data-href]');
      if (!c || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); g.location.href = c.getAttribute('data-href');
    });
    doc.addEventListener('click', function (e) {
      var c = e.target.closest && e.target.closest('[role="link"][data-href]');
      if (c && !e.target.closest('a, button')) g.location.href = c.getAttribute('data-href');
    });
  }

  function iniciar() {
    navbar();
    avisosDoServidor();
    cartoesLink();
    if (C && doc.querySelector('.cv-cab-compacto')) C.cabecalho({ limiar: 44 });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(window);
