/* =========================================================================
   Cortavo v3 · Comissões (fatia F7). Folha de cada barbeiro (admin) e
   "Marcar como pago" (POST /painel/api/gestao/comissoes/baixa, B5 do Beto)
   com o M1; "Desfazer" de cada baixa. Depende de cv-movimento.js.
   ========================================================================= */
(function (g) {
  'use strict';
  var doc = g.document, C = g.Cortavo;
  function postar(url, corpo) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(corpo || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.erro || 'Não deu para salvar. Tente de novo.'); return j; }); });
  }
  function brl(c) { var s = (Math.abs(c) / 100).toFixed(2).split('.'); return 'R$ ' + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + s[1]; }
  g.cmAbrir = function (id) { var f = doc.getElementById('cm-folha-' + id); if (f && C) C.folha.abrir(f, { gatilho: doc.activeElement }); };
  function iniciar() {
    Array.prototype.forEach.call(doc.querySelectorAll('.cv-cm-folha'), function (f) { doc.body.appendChild(f); if (C) C.folha.arrastar(f); });
    var veu = doc.querySelector('.cv-veu'); if (veu) veu.addEventListener('click', function () { if (C && C.folha.atual()) C.folha.fechar(); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && C && C.folha.atual()) C.folha.fechar(); });
    doc.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      if (e.target.closest('.cv-cm-folha [data-fechar]')) { C.folha.fechar(); return; }
      var b = e.target.closest('[data-baixa]');
      if (b) {
        var sec = b.closest('.cv-cm-pagar'), erro = sec.querySelector('[data-erro]');
        b.disabled = true; erro.hidden = true;
        var caixa = sec.querySelector('[data-caixa]'), forma = sec.querySelector('[data-forma]');
        postar('/painel/api/gestao/comissoes/baixa', { usuarioId: +b.dataset.baixa, de: b.dataset.de, ate: b.dataset.ate, lancarNoCaixa: !!(caixa && caixa.checked), formaPagamento: forma ? forma.value : undefined })
          .then(function (r) {
            var sub = b.dataset.nome + ', ' + brl((r.pagamento && r.pagamento.valor) || 0);
            if (C) C.selo({ botao: b, titulo: 'Comissão paga', sub: sub, segurar: 1200, aoFim: function () { g.location.reload(); } }); else g.location.reload();
          })
          .catch(function (x) { b.disabled = false; erro.textContent = x.message; erro.hidden = false; });
        return;
      }
      var d = e.target.closest('[data-desfazer-baixa]');
      if (d) {
        if (!g.confirm('Desfazer este pagamento? A saída lançada no caixa também sai.')) return;
        d.disabled = true;
        postar('/painel/api/gestao/comissoes/baixa/' + d.dataset.desfazerBaixa + '/desfazer').then(function () { g.location.reload(); }).catch(function (x) { d.disabled = false; g.alert(x.message); });
      }
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(window);
