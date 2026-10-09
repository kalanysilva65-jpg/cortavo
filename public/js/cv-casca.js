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

  /* Folha Novo (M4): "+" abre e fecha; véu, Esc, "×" e arrastar fecham. */
  function folhaNovo() {
    var btn = doc.getElementById('btn-novo'), f = doc.getElementById('folha-novo');
    if (!btn || !f || !C) return;
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-controls', 'folha-novo');
    btn.setAttribute('aria-expanded', 'false');
    C.folha.arrastar(f);
    function fechar() { if (C.folha.atual()) C.folha.fechar(); } // a folha aberta, seja qual for
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (C.folha.atual()) { fechar(); return; }
      var palco = doc.querySelector('.cv-palco');
      if (palco) palco.style.transformOrigin = '50% ' + (g.scrollY + g.innerHeight / 2) + 'px';
      C.folha.abrir(f, { gatilho: btn });
    });
    var veu = doc.querySelector('.cv-veu');
    if (veu) veu.addEventListener('click', fechar);
    Array.prototype.forEach.call(f.querySelectorAll('[data-fechar]'), function (b) { b.addEventListener('click', fechar); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') fechar(); });
  }

  /* Ação do Novo que abre a folha da própria tela (?abrir=...). As funções
     são as globais que cada tela já usa nos onclick. */
  function abrirPelaUrl() {
    var q; try { q = new URLSearchParams(g.location.search); } catch (e) { return; }
    var alvo = q.get('abrir'); if (!alvo) return;
    var mapa = {
      agendamento: function () { if (typeof g.abrirModal === 'function') g.abrirModal('novo'); },
      bloqueio: function () { if (typeof g.abrirModal === 'function') g.abrirModal('bloqueio'); },
      cliente: function () { if (typeof g.clAbrirFolha === 'function') g.clAbrirFolha('novo'); },
      lancamento: function () { if (typeof g.cxFolha === 'function') g.cxFolha('novo', true); },
    };
    if (mapa[alvo]) mapa[alvo]();
    q.delete('abrir');
    try { g.history.replaceState(null, '', g.location.pathname + (q.toString() ? '?' + q : '') + g.location.hash); } catch (e) {}
  }

  /* Seletor de período em vidro: o indicador preto fica sob o período
     escolhido; ao tocar outro, desliza com a mola `lente` e o formulário vai. */
  function seletorPeriodo() {
    var sel = doc.querySelector('.cv-periodo'); if (!sel || !C) return;
    var ind = sel.querySelector('.ind');
    function por(b, animar) {
      if (!ind || !b) return;
      var rs = sel.getBoundingClientRect(), rb = b.getBoundingClientRect(), x = rb.left - rs.left;
      ind.style.width = rb.width + 'px';
      var fim = 'translateX(' + x + 'px)';
      if (!animar || C.reduz()) { ind.style.transform = fim; return; }
      var ini = getComputedStyle(ind).transform; ind.style.transform = fim;
      var m = g.Mola.mola(g.Mola.MOLAS.lente);
      ind.animate([{ transform: ini }, { transform: fim }], { duration: m.duracao, easing: m.easing });
    }
    por(sel.querySelector('button[aria-pressed="true"]'), false);
    sel.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button[name="periodo"]');
      if (!b) return;
      Array.prototype.forEach.call(sel.querySelectorAll('button[name="periodo"]'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      por(b, true);
    });
  }

  function iniciar() {
    navbar();
    seletorPeriodo();
    folhaNovo();
    abrirPelaUrl();
    avisosDoServidor();
    cartoesLink();
    if (C && doc.querySelector('.cv-cab-compacto')) C.cabecalho({ limiar: 44 });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(window);
