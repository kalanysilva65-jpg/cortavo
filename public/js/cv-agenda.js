/* =========================================================================
   Cortavo v3 · Agenda (fatia F4)
   1. Horários livres na linha do dia: quando a agenda mostra um barbeiro só,
      busca /painel/agenda/horarios (a mesma rota do "Novo agendamento"),
      junta os horários livres seguidos em blocos ("15:00 até 16:00, 2
      horários") e põe cada bloco no lugar certo da linha. Tocar abre a folha
      do novo agendamento com a data e a hora já escolhidas.
   2. M1 ao confirmar: o envio do formulário guarda o pedido do selo; quando
      a agenda volta com o aviso de sucesso do servidor, o C com check se
      escreve. Com erro, nada de selo.
      TODO(Beto): "desfazer agendamento" por alguns segundos (aviso com
      Desfazer) precisa de rota nova.
   ========================================================================= */
(function (g) {
  'use strict';
  var doc = g.document;
  var PASSO = 30; // a grade de horários do app (INTERVALO_SLOT_MIN)

  function min(h) { var p = String(h).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function blocosLivres(horarios, aPartirDe) {
    var blocos = [], atual = null;
    horarios.forEach(function (h) {
      var m = min(h.hora);
      if (!h.livre || m < aPartirDe) { atual = null; return; }
      if (atual && m === atual.fim) { atual.fim = m + PASSO; atual.n++; }
      else { atual = { ini: m, fim: m + PASSO, n: 1 }; blocos.push(atual); }
    });
    return blocos;
  }

  function abrirNovoCom(data, hora) {
    if (typeof g.abrirModal !== 'function') return;
    g.abrirModal('novo');
    var dataInp = doc.getElementById('data-novo');
    if (dataInp && dataInp.value !== data) { dataInp.value = data; dataInp.dispatchEvent(new Event('change')); }
    var livre = doc.getElementById('hora-livre');
    if (livre) { livre.value = hora; livre.dispatchEvent(new Event('input')); }
  }

  function livres() {
    var tl = doc.getElementById('cv-ag-tl');
    if (!tl || !tl.dataset.barbeiro) return;
    var data = tl.dataset.data, hoje = tl.dataset.hoje === '1';
    var qs = new URLSearchParams({ barbeiroId: tl.dataset.barbeiro, data: data });
    fetch('/painel/agenda/horarios?' + qs.toString(), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { horarios: [] }; })
      .then(function (json) {
        var blocos = blocosLivres(json.horarios || [], hoje ? +tl.dataset.agora : 0);
        if (!blocos.length) return;
        var total = 0;
        blocos.forEach(function (b) {
          total += b.n;
          var item = doc.createElement('div');
          item.className = 'cv-tl-item';
          item.dataset.min = b.ini;
          var txt = hhmm(b.ini) + ' até ' + hhmm(b.fim) + ', ' + b.n + (b.n === 1 ? ' horário' : ' horários');
          item.innerHTML = '<span class="cv-tl-hora">' + hhmm(b.ini) + '</span>' +
            '<button type="button" class="cv-ag livre cv-toca" aria-label="Livre, ' + esc(txt) + '. Marcar um cliente"><span class="corpo"><span class="t">Livre</span><span class="s">' + esc(txt) + '</span></span>' +
            '<span class="mais" aria-hidden="true"><svg class="cv-ic cv-ic--18" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span></button>';
          item.querySelector('button').addEventListener('click', function () { abrirNovoCom(data, hhmm(b.ini)); });
          // Entra antes do primeiro item (ou da linha "agora") que começa depois
          var depois = Array.prototype.find.call(tl.children, function (el) { return +el.dataset.min > b.ini; });
          tl.insertBefore(item, depois || null);
        });
        var resumo = doc.getElementById('cv-ag-resumo');
        if (resumo) {
          var n = +resumo.dataset.n || 0;
          resumo.textContent = (n ? n + (n === 1 ? ' atendimento e ' : ' atendimentos e ') : '') + total + (total === 1 ? ' horário livre' : ' horários livres');
        }
      })
      .catch(function () { /* sem os livres, a agenda segue igual */ });
  }

  var CHAVE = 'cvSeloAgenda';
  function seloAoConfirmar() {
    var form = doc.getElementById('form-novo-agendamento');
    if (form) form.addEventListener('submit', function () {
      if (form.checkValidity && !form.checkValidity()) return;
      var cli = doc.getElementById('resumo-cliente'), hora = doc.getElementById('hora-novo');
      try { sessionStorage.setItem(CHAVE, JSON.stringify({ sub: ((cli && cli.textContent !== '—') ? cli.textContent + ', ' : '') + 'às ' + (hora ? hora.value : '') })); } catch (e) {}
    });
    var pedido = null;
    try { pedido = JSON.parse(sessionStorage.getItem(CHAVE) || 'null'); sessionStorage.removeItem(CHAVE); } catch (e) {}
    var ok = doc.querySelector('.cv-aviso[data-flash="ok"]');
    if (pedido && ok && g.Cortavo) {
      ok.style.visibility = 'hidden';
      g.Cortavo.selo({ titulo: 'Agendamento confirmado', sub: pedido.sub, segurar: 1200, aoFim: function () { ok.style.visibility = ''; } });
    }
  }

  function iniciar() { livres(); seloAoConfirmar(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(window);
