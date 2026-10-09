/* =========================================================================
   Cortavo v3 · Caixa e Fechar caixa (fatia F6). Depende de cv-movimento.js.
   - Caixa: folha "Novo lançamento" (cxFolha global), Entrada/Saída, forma
     (saída sugere Dinheiro), valor em reais aceitando "1.234,50", atalhos do
     período personalizado.
   - Fechar: diferença ao vivo entre o contado e o esperado; envia para
     /painel/api/caixa/fechar (Beto) e mostra o M1 com o poste enquanto o
     servidor responde.
   ========================================================================= */
(function (g) {
  'use strict';
  var doc = g.document, C = g.Cortavo;
  function $(s, r) { return (r || doc).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); }
  // "1.234,50" -> "1234,50" (o servidor troca só a vírgula por ponto).
  function limparReais(t) { t = String(t || '').trim(); return t.indexOf(',') !== -1 ? t.replace(/\./g, '') : t; }
  function centavos(t) { var n = parseFloat(limparReais(t).replace(',', '.')); return isFinite(n) ? Math.round(n * 100) : NaN; }
  function brl(c) { var s = (Math.abs(c) / 100).toFixed(2).split('.'); return 'R$ ' + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + s[1]; }

  /* ---- Caixa ------------------------------------------------------------ */
  function caixa() {
    var f = doc.getElementById('cx-folha-novo');
    g.cxFolha = function (nome, abrir) {
      var el = doc.getElementById('cx-folha-' + nome); if (!el || !C) return;
      if (abrir) C.folha.abrir(el, { gatilho: doc.activeElement }); else C.folha.fechar(el);
    };
    if (f && C) {
      doc.body.appendChild(f); // fora do .cv-palco (que recua com transform)
      C.folha.arrastar(f);
      $$('[data-fechar]', f).forEach(function (b) { b.addEventListener('click', function () { C.folha.fechar(); }); });
      var veu = $('.cv-veu'); if (veu) veu.addEventListener('click', function () { if (C.folha.atual() === f) C.folha.fechar(); });
      doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && C.folha.atual() === f) C.folha.fechar(); });
      var tipo = $('#tipo-novo'), forma = $('#formaPagamento-novo'), ajuda = $('#ajuda-forma');
      function marcarForma(v) { forma.value = v || ''; $$('.cv-cx-formas .cv-chip', f).forEach(function (c) { c.setAttribute('aria-pressed', String(c.dataset.valor === v)); }); }
      $$('[data-tipo]', f).forEach(function (b) { b.addEventListener('click', function () {
        $$('[data-tipo]', f).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        tipo.value = b.dataset.tipo;
        // Saída sem forma não entra na conta da gaveta: sugere Dinheiro.
        if (b.dataset.tipo === 'saida' && !forma.value) marcarForma('dinheiro');
        ajuda.hidden = b.dataset.tipo !== 'saida';
      }); });
      $$('.cv-cx-formas .cv-chip', f).forEach(function (c) { c.addEventListener('click', function () { marcarForma(c.getAttribute('aria-pressed') === 'true' ? '' : c.dataset.valor); }); });
      var form = $('#cx-form-novo');
      if (form) form.addEventListener('submit', function () { var v = $('#valor-novo'); v.value = limparReais(v.value); });
    }
    $$('.cv-cx-atalhos .cv-chip').forEach(function (c) { c.addEventListener('click', function () {
      $('#cx-inicio').value = c.dataset.inicio; $('#cx-fim').value = c.dataset.fim;
      $$('.cv-cx-atalhos .cv-chip').forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
    }); });
  }

  /* ---- Fechar caixa ----------------------------------------------------- */
  function fechar() {
    var form = doc.getElementById('cx-fechar'); if (!form) return;
    var base = +form.dataset.base || 0, fundo = $('#cx-fundo'), gaveta = $('#cx-gaveta'), esperadoEl = $('#cx-esperado');
    var bate = $('#cx-bate'), bateTxt = $('#cx-bate-txt'), erro = $('#cx-erro'), btn = $('#btn-fechar');
    function esperado() { var f = centavos(fundo.value); return Math.max(0, base + (isFinite(f) ? f : 0)); }
    function conferir() {
      var esp = esperado(), cont = centavos(gaveta.value);
      esperadoEl.textContent = 'Esperado: ' + brl(esp);
      if (!isFinite(cont)) { bateTxt.textContent = 'Informe quanto dinheiro tem na gaveta.'; bate.dataset.estado = 'falta'; return; }
      var dif = cont - esp;
      bate.dataset.estado = dif === 0 ? 'ok' : 'dif';
      bateTxt.textContent = dif === 0 ? 'Bate com o esperado. Diferença de R$ 0,00.' : (dif < 0 ? 'Faltam ' : 'Sobram ') + brl(dif) + ' em relação ao esperado.';
    }
    fundo.addEventListener('input', conferir); gaveta.addEventListener('input', conferir); conferir();
    var refazer = $('#cx-refazer');
    if (refazer) refazer.addEventListener('click', function () { form.hidden = false; form.scrollIntoView({ block: 'start', behavior: 'smooth' }); gaveta.focus({ preventScroll: true }); });

    form.addEventListener('submit', function (e) {
      e.preventDefault(); erro.hidden = true;
      var cont = centavos(gaveta.value);
      if (!isFinite(cont) || cont < 0) { erro.textContent = 'Informe quanto dinheiro tem na gaveta.'; erro.hidden = false; return; }
      btn.disabled = true;
      var t0 = Date.now();
      var pedido = fetch('/painel/api/caixa/fechar', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ dinheiroContado: cont, fundoInicial: centavos(fundo.value) || 0, observacao: $('#cx-obs').value, refazer: form.dataset.refazer === '1' }),
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok && r.status !== 409) throw new Error(j.erro || 'Não deu para fechar o caixa. Tente de novo.'); return j; }); });
      pedido.then(function (j) {
        var f = j.fechamento || {};
        var sub = 'Saldo de ' + brl(f.saldo || 0) + (f.diferenca ? ', diferença de ' + brl(f.diferenca) : '');
        if (C) C.selo({ botao: btn, processando: Math.max(0, 650 - (Date.now() - t0)), titulo: 'Caixa fechado', sub: sub, segurar: 1300, aoFim: function () { g.location.reload(); } });
        else g.location.reload();
      }).catch(function (x) { btn.disabled = false; erro.textContent = x.message; erro.hidden = false; });
    });
  }

  function iniciar() { caixa(); fechar(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(window);
