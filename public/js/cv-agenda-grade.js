/* =========================================================================
   Cortavo v3 · Agenda no PC (F13): colunas por barbeiro e semana.
   Lê os JSONs do Beto (GET /painel/agenda/dia.json e /semana.json) e desenha
   uma grade de horas. Só no PC (>= 1024 px): no celular a linha do dia segue
   como está. Sem JS, nada muda (o controle de vista fica escondido).
   Um bloco do dia abre a folha do agendamento (abrirModal); na semana, leva
   ao dia daquele bloco.
   ========================================================================= */
(function (g) {
  'use strict';
  var doc = g.document;
  var raiz = doc.getElementById('cv-ag-grade'); if (!raiz) return;
  var seg = doc.getElementById('cv-ag-vistas');
  var lista = doc.getElementById('cv-ag-lista');
  var data = raiz.getAttribute('data-data'), barbeiro = raiz.getAttribute('data-barbeiro') || 'todos';
  var PX_MIN = 1.4; // altura de um minuto na grade
  var CHAVE = 'cv-ag-vista';
  var pc = g.matchMedia ? g.matchMedia('(min-width: 1024px)') : { matches: false };

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function min(h) { var p = String(h || '0:0').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
  function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function dinheiro(c) { var s = ((c || 0) / 100).toFixed(2).split('.'); return 'R$ ' + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '<small>,' + s[1] + '</small>'; }
  function ler() { try { return g.localStorage.getItem(CHAVE); } catch (e) { return null; } }
  function guardar(v) { try { g.localStorage.setItem(CHAVE, v); } catch (e) {} }

  var ICONE_FALTOU = '<svg class="cv-ic cv-ic--14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/></svg>';

  function faixaDe(j) {
    var f = j.faixa || {}, ini = min(f.inicio || '08:00'), fim = min(f.fim || '20:00');
    ini = Math.floor(ini / 60) * 60; fim = Math.ceil(fim / 60) * 60; if (fim <= ini) fim = ini + 60;
    return { ini: ini, fim: fim };
  }
  function regua(fx) {
    var h = '';
    for (var m = fx.ini; m <= fx.fim; m += 60) h += '<span style="top:' + ((m - fx.ini) * PX_MIN) + 'px">' + hhmm(m) + '</span>';
    return '<div class="cv-gr-regua" aria-hidden="true" style="height:' + ((fx.fim - fx.ini) * PX_MIN) + 'px">' + h + '</div>';
  }
  function trilho(fx, col, opc) {
    var h = '', alt = (fx.fim - fx.ini) * PX_MIN, jor = col.jornada || {};
    if (!jor.trabalha) h += '<div class="cv-gr-folga">Folga</div>';
    else {
      var a = min(jor.inicio), b = min(jor.fim);
      if (a > fx.ini) h += '<i class="cv-gr-fora" style="top:0;height:' + ((a - fx.ini) * PX_MIN) + 'px"></i>';
      if (b < fx.fim) h += '<i class="cv-gr-fora" style="top:' + ((b - fx.ini) * PX_MIN) + 'px;bottom:0"></i>';
    }
    (col.bloqueios || []).forEach(function (bl) {
      var a = min(bl.inicio || bl.horaInicio), b = min(bl.fim || bl.horaFim);
      h += '<div class="cv-gr-bloq" style="top:' + ((a - fx.ini) * PX_MIN) + 'px;height:' + Math.max(18, (b - a) * PX_MIN) + 'px"><span>' + esc(bl.motivo || 'Bloqueado') + '</span></div>';
    });
    // Sobreposição. Nas colunas (um barbeiro), dividem a largura. Na semana
    // (vários barbeiros no mesmo dia), viram um bloco só "N atendimentos",
    // com os nomes no title; o toque leva ao dia (revisão Dani, P1 #7).
    var bks = (col.blocos || []).slice().sort(function (x, y) { return x.inicioMin - y.inicioMin; });
    var grupos = [], fins = [], grupo = null, fimGrupo = -1;
    bks.forEach(function (bk) {
      var a = typeof bk.inicioMin === 'number' ? bk.inicioMin : min(bk.inicio), f = a + (bk.duracaoMin || 30);
      if (a >= fimGrupo) { grupo = []; grupos.push(grupo); fins = []; }
      var k = 0; while (fins[k] > a) k++; fins[k] = f; bk._k = k; grupo.push(bk); grupo.n = fins.length; fimGrupo = Math.max(fimGrupo, f);
    });
    var linkDia = ' href="/painel/agenda?data=' + esc(opc.data) + '&barbeiro=' + esc(barbeiro) + '"';
    grupos.forEach(function (gr) {
      if (opc.semana && gr.length > 1) {
        var a = gr[0].inicioMin, f = 0;
        gr.forEach(function (b) { f = Math.max(f, b.inicioMin + (b.duracaoMin || 30)); });
        var nomes = gr.map(function (b) { return b.inicio + ' ' + (b.cliente || 'Cliente'); }).join(', ');
        h += '<a class="cv-gr-bloco cv-gr-grupo"' + linkDia + ' title="' + esc(nomes) + '" aria-label="' + esc(gr.length + ' atendimentos: ' + nomes) + '" style="top:' + ((a - fx.ini) * PX_MIN) + 'px;height:' + Math.max(22, (f - a) * PX_MIN - 2) + 'px">' +
          '<b>' + esc(gr[0].inicio) + '</b><span class="cv-gr-n">' + gr.length + ' atendimentos</span></a>';
        return;
      }
      gr.forEach(function (bk) {
        var a = typeof bk.inicioMin === 'number' ? bk.inicioMin : min(bk.inicio), d = bk.duracaoMin || 30, n = gr.n;
        var lado = n > 1 ? 'left:calc(4px + ' + (bk._k * 100 / n) + '% - ' + (bk._k * 8 / n) + 'px);width:calc(' + (100 / n) + '% - ' + (8 / n + 2) + 'px);right:auto;' : '';
        var falta = bk.status === 'faltou' || bk.ocupa === false, feito = bk.status === 'concluido';
        var serv = (bk.servicos || []).map(function (x) { return x.nome || x; }).join(', ');
        var cli = bk.cliente || 'Cliente';
        var rot = bk.inicio + ', ' + cli + (serv ? ', ' + serv : '') + (falta ? ', Faltou' : feito ? ', Concluído' : '');
        var cls = 'cv-gr-bloco' + (feito ? ' feito' : '') + (falta ? ' faltou' : '') + (d * PX_MIN < 66 ? ' curto' : '');
        var attrs = opc.semana ? linkDia : ' href="#ag-' + bk.id + '" data-ag="' + bk.id + '"';
        // Estado escrito, nunca só cor nem listra: "Faltou" é o nome riscado
        // e o estado com ícone, como no celular (P1 #6).
        var estado = falta ? '<em class="cv-gr-est">' + ICONE_FALTOU + 'Faltou</em>' : feito ? '<em class="cv-gr-est">Concluído</em>' : '';
        var alto = d * PX_MIN >= 66;
        var linha2 = alto ? esc(bk.inicio) + (serv ? ' · ' + esc(serv) : '') : esc(bk.inicio);
        h += '<a class="' + cls + '"' + attrs + ' title="' + esc(cli) + '" aria-label="' + esc(rot) + '" style="' + lado + 'top:' + ((a - fx.ini) * PX_MIN) + 'px;height:' + Math.max(22, d * PX_MIN - 2) + 'px">' +
          '<b>' + esc(cli) + '</b>' + (alto ? '<span>' + linha2 + '</span>' + estado : '<span>' + linha2 + (estado ? ' · ' : '') + '</span>' + estado) + '</a>';
      });
    });
    return '<div class="cv-gr-trilho" style="height:' + alt + 'px">' + h + '</div>';
  }

  function desenharDia(j) {
    var fx = faixaDe(j), cols = j.colunas || [];
    if (!cols.length) { raiz.innerHTML = '<p class="cv-texto-apoio">Nenhum barbeiro trabalha neste dia.</p>'; return; }
    var cab = '', corpo = '';
    cols.forEach(function (c) {
      var nome = (c.barbeiro && c.barbeiro.nome) || '', ini = nome.trim().charAt(0).toUpperCase();
      var n = (c.blocos || []).filter(function (b) { return b.ocupa !== false; }).length;
      cab += '<div class="cv-gr-col-cab"><span class="cv-avatar" aria-hidden="true">' + esc(ini) + '</span><div><b>' + esc(nome.split(' ')[0]) + '</b><small>' + (n ? n + (n === 1 ? ' atendimento' : ' atendimentos') : 'Livre') + '</small></div></div>';
      corpo += trilho(fx, c, {});
    });
    raiz.innerHTML = '<div class="cv-gr" style="--cols:' + cols.length + '"><div class="cv-gr-cab"><span></span>' + cab + '</div><div class="cv-gr-corpo">' + regua(fx) + corpo + '</div></div>';
  }

  function desenharSemana(j) {
    var fx = faixaDe(j), dias = j.dias || [], cab = '', corpo = '';
    dias.forEach(function (d) {
      // Um trilho por dia, com os barbeiros (filtrados ou não) somados.
      var col = { jornada: { trabalha: false }, blocos: [], bloqueios: [] }, n = 0, ini = 1e9, fim = -1;
      (d.barbeiros || []).forEach(function (b) {
        col.blocos = col.blocos.concat(b.blocos || []); col.bloqueios = col.bloqueios.concat(b.bloqueios || []); n += b.quantidade || 0;
        if (b.jornada && b.jornada.trabalha) { col.jornada.trabalha = true; ini = Math.min(ini, min(b.jornada.inicio)); fim = Math.max(fim, min(b.jornada.fim)); }
      });
      if (col.jornada.trabalha) { col.jornada.inicio = hhmm(ini); col.jornada.fim = hhmm(fim); }
      var hoje = d.data === data;
      cab += '<a class="cv-gr-col-cab cv-gr-dia' + (hoje ? ' sel' : '') + '" href="/painel/agenda?data=' + esc(d.data) + '&barbeiro=' + esc(barbeiro) + '"' + (hoje ? ' aria-current="date"' : '') + '><div><b>' + esc(d.rotulo || d.data) + '</b><small>' + (n ? n + (n === 1 ? ' atendimento' : ' atendimentos') : 'Livre') + '</small></div></a>';
      corpo += trilho(fx, col, { semana: true, data: d.data });
    });
    raiz.innerHTML = '<div class="cv-gr cv-gr--semana" style="--cols:' + dias.length + '"><div class="cv-gr-cab"><span></span>' + cab + '</div><div class="cv-gr-corpo">' + regua(fx) + corpo + '</div></div>';
  }

  var cache = {};
  function carregar(vista) {
    var url = '/painel/agenda/' + (vista === 'semana' ? 'semana' : 'dia') + '.json?data=' + encodeURIComponent(data) + '&barbeiro=' + encodeURIComponent(barbeiro);
    raiz.setAttribute('aria-busy', 'true');
    var p = cache[url] || (cache[url] = fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { if (!r.ok) throw new Error(); return r.json(); }));
    p.then(function (j) { if (vista === 'semana') desenharSemana(j); else desenharDia(j); })
      .catch(function () { delete cache[url]; raiz.innerHTML = '<p class="cv-texto-apoio">Não deu para carregar a grade. Use a lista ou tente de novo.</p>'; })
      .then(function () { raiz.removeAttribute('aria-busy'); });
  }

  function aplicar(vista) {
    if (!pc.matches) vista = 'lista';
    if (seg) Array.prototype.forEach.call(seg.querySelectorAll('[data-vista]'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-vista') === vista ? 'true' : 'false'); });
    raiz.hidden = vista === 'lista';
    if (lista) lista.hidden = vista !== 'lista';
    if (vista !== 'lista') carregar(vista);
  }

  if (seg) {
    seg.hidden = false;
    seg.addEventListener('click', function (e) { var b = e.target.closest('[data-vista]'); if (!b) return; var v = b.getAttribute('data-vista'); guardar(v); aplicar(v); });
  }
  raiz.addEventListener('click', function (e) {
    var a = e.target.closest('[data-ag]'); if (!a || !g.abrirModal) return;
    e.preventDefault(); g.abrirModal(a.getAttribute('data-ag'));
  });
  if (pc.addEventListener) pc.addEventListener('change', function () { aplicar(ler() || 'colunas'); });
  aplicar(ler() || 'colunas');
})(window);
