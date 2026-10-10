/* =========================================================================
   Cortavo v3 · Agenda (fatia F4, reescrita). Depende de cv-mola.js e
   cv-movimento.js (window.Cortavo). Sem biblioteca.

   1. Folhas (M4): abrirModal(id) / fecharModal() globais, uma folha por vez.
   2. Novo agendamento: chips de serviço (vários) e barbeiro, horários do
      servidor, hora exata, autocomplete de cliente, plano do cliente, resumo,
      envio em JSON -> M1 (C com check) -> aviso com Desfazer (8 s).
   3. Detalhe: divisão de pagamento, concluir, reabrir, faltou, cancelar,
      excluir, itens e total, sempre por fetch e redesenhando a folha.
   4. Linha do dia: horários livres tocáveis e a tira de dias centralizada.
   5. Bloqueio: sugere a próxima hora cheia.
   ========================================================================= */
(function (g) {
  'use strict';
  var doc = g.document, C = g.Cortavo;
  var dados = {}; try { dados = JSON.parse((doc.getElementById('cv-ag-dados') || {}).textContent || '{}'); } catch (e) {}
  var PASSO = 30; // grade de horários do app (INTERVALO_SLOT_MIN)
  var JANELA_DESFAZER_MS = 8000;

  function $(s, r) { return (r || doc).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function min(h) { var p = String(h).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function reais(c) { return (c / 100).toFixed(2).replace('.', ','); }
  function centavos(t) { var n = parseFloat(String(t).replace(/\./g, '').replace(',', '.')); return isFinite(n) ? Math.round(n * 100) : NaN; }
  function brl(c) { var s = reais(c).split(','); return 'R$ ' + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + s[1]; }
  function fmtTel(d) { d = (d || '').replace(/\D/g, ''); if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7); if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6); return d; }

  function postar(url, corpo) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(corpo || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.erro || 'Não deu para salvar. Tente de novo.'); return j; }); });
  }

  /* ---- 1. Folhas -------------------------------------------------------- */
  function abrirModal(id) {
    var f = doc.getElementById('agm-' + id); if (!f || !C) return;
    var gatilho = doc.activeElement;
    var abrir = function () { C.folha.abrir(f, { gatilho: gatilho && gatilho !== doc.body ? gatilho : null }); };
    if (C.folha.atual() && C.folha.atual() !== f) C.folha.fechar(C.folha.atual(), { aoFim: abrir }); else abrir();
  }
  function fecharModal() { if (C && C.folha.atual()) C.folha.fechar(); }
  g.abrirModal = abrirModal;
  g.fecharModal = fecharModal;

  function ligarFolhas() {
    // As folhas saem de dentro do .cv-palco (que recua com transform quando
    // uma folha abre e prenderia o position:fixed delas embaixo do véu).
    $$('.cv-ag-folha').forEach(function (f) { doc.body.appendChild(f); if (C) C.folha.arrastar(f); });
    doc.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('.cv-ag-folha [data-fechar]')) fecharModal(); });
    var veu = $('.cv-veu'); if (veu) veu.addEventListener('click', fecharModal);
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') fecharModal(); });
  }

  /* ---- 2. Novo agendamento --------------------------------------------- */
  function novo() {
    var form = doc.getElementById('form-novo-agendamento'); if (!form) return;
    var nome = $('#cliente_nome-novo'), tel = $('#cliente_telefone-novo'), cliId = $('#clienteId-novo');
    var servicosIn = $('#servicoIds-novo'), barbIn = $('#barbeiroId-novo'), dataIn = $('#data-novo');
    var horaIn = $('#hora-novo'), horaLivre = $('#hora-livre'), grade = $('#pills-horario');
    var resumo = $('#resumo-novo'), erroEl = $('#erro-novo'), btn = $('#confirmar-novo');

    function erro(msg) { erroEl.textContent = msg || ''; erroEl.hidden = !msg; if (msg) erroEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    function chipsAtivos(id) { return $$('#' + id + ' .cv-chip[aria-pressed="true"]'); }
    function rotuloDia() {
      var v = dataIn.value; if (!v) return '';
      var hoje = new Date(), d = new Date(v + 'T12:00:00');
      var dif = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 864e5);
      if (dif === 0) return 'hoje'; if (dif === 1) return 'amanhã';
      return ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][d.getDay()] + ', ' + d.getDate() + '/' + (d.getMonth() + 1);
    }
    function atualizarResumo() {
      var svs = chipsAtivos('pills-servico').map(function (c) { return c.dataset.nome; });
      var b = chipsAtivos('pills-barbeiro')[0];
      var bNome = b ? b.dataset.nome : (barbIn && barbIn.dataset.nome) || '';
      if (!svs.length || !horaIn.value) { resumo.textContent = 'Escolha o serviço e o horário.'; return; }
      resumo.innerHTML = esc(svs.join(' + ')) + (bNome ? ' com ' + esc(bNome) : '') + ', ' + esc(rotuloDia()) + ' às <b>' + esc(horaIn.value) + '</b>.';
    }

    // Serviço: vários; barbeiro: um.
    var gServ = $('#pills-servico');
    if (gServ) gServ.addEventListener('click', function (e) {
      var c = e.target.closest('.cv-chip'); if (!c) return;
      c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true'));
      servicosIn.value = chipsAtivos('pills-servico').map(function (x) { return x.dataset.id; }).join(',');
      buscarHorarios(); atualizarResumo();
    });
    var gBarb = $('#pills-barbeiro');
    if (gBarb) gBarb.addEventListener('click', function (e) {
      var c = e.target.closest('.cv-chip'); if (!c) return;
      $$('.cv-chip', gBarb).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
      barbIn.value = c.dataset.id; buscarHorarios(); atualizarResumo();
    });

    function buscarHorarios() {
      horaIn.value = horaLivre.value || '';
      if (!barbIn || !barbIn.value) { grade.innerHTML = '<p class="cv-ajuda" style="grid-column:1/-1">Escolha o barbeiro para ver os horários.</p>'; return; }
      // M3: esqueleto dos horários só se a espera passar de 300 ms.
      var fimEsq = g.CortavoVida ? g.CortavoVida.esqueleto(grade, { linhas: 2, altura: 44, coluna: true }) : function () {};
      var qs = new URLSearchParams({ barbeiroId: barbIn.value, data: dataIn.value || '', servicoIds: servicosIn.value || '' });
      fetch('/painel/agenda/horarios?' + qs, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          fimEsq();
          var hs = j.horarios || [];
          if (!hs.length) { grade.innerHTML = '<p class="cv-ajuda" style="grid-column:1/-1">Sem horários nesse dia. Use o horário exato para um encaixe.</p>'; return; }
          grade.innerHTML = hs.map(function (h) {
            return h.livre
              ? '<button type="button" class="cv-hora" data-hora="' + h.hora + '" aria-pressed="' + (h.hora === horaIn.value) + '">' + h.hora + '</button>'
              : '<button type="button" class="cv-hora" disabled aria-label="' + h.hora + ', ocupado">' + h.hora + '</button>';
          }).join('');
        })
        .catch(function () { fimEsq(); grade.innerHTML = '<p class="cv-ajuda" style="grid-column:1/-1">Não foi possível carregar os horários.</p>'; });
    }
    grade.addEventListener('click', function (e) {
      var b = e.target.closest('.cv-hora'); if (!b || b.disabled) return;
      $$('.cv-hora', grade).forEach(function (x) { if (!x.disabled) x.setAttribute('aria-pressed', String(x === b)); });
      horaIn.value = b.dataset.hora; horaLivre.value = ''; atualizarResumo();
    });
    horaLivre.addEventListener('input', function () {
      $$('.cv-hora', grade).forEach(function (x) { if (!x.disabled) x.setAttribute('aria-pressed', 'false'); });
      horaIn.value = horaLivre.value; atualizarResumo();
    });
    dataIn.addEventListener('change', function () { buscarHorarios(); atualizarResumo(); });

    // Autocomplete de cliente. Sem clientes_contato o telefone vem mascarado e
    // o servidor resolve pelo clienteId.
    var lista = $('#sugestoes-cliente-novo'), clientes = dados.clientes || [];
    function fecharLista() { lista.innerHTML = ''; lista.hidden = true; }
    function sugerir() {
      cliId.value = '';
      var q = nome.value.trim().toLowerCase(); if (!q) return fecharLista();
      var dig = q.replace(/\D/g, '');
      var achados = clientes.filter(function (c) { return String(c.nome).toLowerCase().indexOf(q) !== -1 || (dig && String(c.telefone).replace(/\D/g, '').indexOf(dig) !== -1); }).slice(0, 6);
      if (!achados.length) return fecharLista();
      lista.innerHTML = achados.map(function (c, i) { return '<button type="button" role="option" class="cv-linha" data-i="' + i + '"><span class="corpo"><span class="t">' + esc(c.nome) + '</span><span class="s">' + esc(/\d{8}/.test(c.telefone) ? fmtTel(c.telefone) : c.telefone) + '</span></span></button>'; }).join('');
      lista.hidden = false;
      $$('button', lista).forEach(function (b) { b.addEventListener('click', function () {
        var c = achados[+b.dataset.i];
        nome.value = c.nome; tel.value = /\d{8}/.test(c.telefone) ? fmtTel(c.telefone) : c.telefone;
        tel.dispatchEvent(new Event('input', { bubbles: true }));
        cliId.value = c.id || ''; fecharLista(); atualizarResumo();
      }); });
    }
    nome.addEventListener('input', sugerir);
    doc.addEventListener('click', function (e) { if (!lista.contains(e.target) && e.target !== nome) fecharLista(); });

    // Plano do cliente: aparece quando o telefone tem plano ativo.
    var area = $('#plano-novo-area'), check = $('#plano-novo-check'), rotPlano = $('#plano-novo-label'), planoIn = $('#clientePlanoId-novo'), plano = null, tempo = null;
    function semPlano() { area.hidden = true; check.checked = false; planoIn.value = ''; plano = null; }
    function buscarPlano() {
      var t = tel.value.replace(/\D/g, ''); if (t.length < 8) return semPlano();
      fetch('/painel/agenda/planos?telefone=' + encodeURIComponent(t), { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var ps = (j && j.planos) || []; if (!ps.length) return semPlano();
          plano = ps[0];
          var cobre = plano.servicoNome ? 'cobre ' + plano.servicoNome : 'cobre 1 serviço';
          var usos = plano.ilimitado ? 'ilimitado' : (plano.usosPorServico || plano.usosRestantes + (plano.usosRestantes === 1 ? ' uso' : ' usos'));
          rotPlano.textContent = 'Marcar pelo plano ' + plano.nome + ' (' + cobre + ', ' + usos + ')';
          area.hidden = false;
        })
        .catch(semPlano);
    }
    tel.addEventListener('input', function () { planoIn.value = ''; check.checked = false; clearTimeout(tempo); tempo = setTimeout(buscarPlano, 400); });
    check.addEventListener('change', function () { planoIn.value = check.checked && plano ? String(plano.id) : ''; });

    // Envio em JSON: M1 a partir do botão; na agenda que volta, o aviso com Desfazer.
    form.addEventListener('submit', function (e) {
      e.preventDefault(); erro('');
      if (!nome.value.trim()) return erro('Informe o nome do cliente.');
      if (!tel.value.trim()) return erro('Informe o WhatsApp do cliente.');
      if (!servicosIn.value) return erro('Escolha ao menos um serviço.');
      if (!barbIn || !barbIn.value) return erro('Escolha o barbeiro.');
      if (!horaIn.value) return erro('Escolha o horário.');
      var corpo = {}; new FormData(form).forEach(function (v, k) { corpo[k] = v; });
      btn.disabled = true;
      var sub = nome.value.trim() + ', ' + rotuloDia() + ' às ' + horaIn.value;
      postar(form.action, corpo)
        .then(function (r) {
          try { sessionStorage.setItem('cvAgDesfazer', JSON.stringify({ url: r.desfazer && r.desfazer.url, ate: Date.now() + JANELA_DESFAZER_MS + 2500, titulo: nome.value.trim().split(' ')[0] + ' está na agenda', sub: sub })); } catch (x) {}
          var destino = '/painel/agenda?data=' + encodeURIComponent(corpo.data) + (dados.ehAdmin ? '&barbeiro=' + encodeURIComponent(corpo.barbeiroId) : '');
          if (C) C.selo({ botao: btn, titulo: 'Agendamento confirmado', sub: sub, segurar: 900, aoFim: function () { g.location.href = destino; } });
          else g.location.href = destino;
        })
        .catch(function (x) { btn.disabled = false; erro(x.message); });
    });

    if (barbIn && barbIn.value) buscarHorarios();
    atualizarResumo();
    novo.abrirCom = function (data, hora) {
      if (data && dataIn.value !== data) dataIn.value = data;
      horaLivre.value = hora || ''; horaIn.value = hora || '';
      buscarHorarios(); atualizarResumo();
    };
  }

  // Aviso com Desfazer, ao voltar para a agenda com o agendamento novo na lista.
  function avisoDesfazer() {
    var p = null; try { p = JSON.parse(sessionStorage.getItem('cvAgDesfazer') || 'null'); sessionStorage.removeItem('cvAgDesfazer'); } catch (e) {}
    if (!p || !C || Date.now() > p.ate) return;
    var a = C.aviso({ titulo: p.titulo, sub: p.sub, desfazer: !!p.url, tempo: JANELA_DESFAZER_MS });
    var b = a && a.querySelector('.desfazer');
    if (b) b.addEventListener('click', function () {
      b.disabled = true;
      postar(p.url).then(function () { g.location.reload(); }).catch(function (x) { C.aviso({ titulo: 'Não deu para desfazer', sub: x.message }); });
    });
  }

  /* ---- 3. Detalhe ------------------------------------------------------- */
  function caixaDe(el) { return el.closest('[data-detalhe]'); }
  function avisoNaFolha(box, msg, ancora) {
    var ant = box.querySelector('[data-erro]'); if (ant) ant.remove();
    var p = doc.createElement('p'); p.className = 'cv-erro'; p.setAttribute('data-erro', ''); p.setAttribute('role', 'alert'); p.textContent = msg;
    if (ancora && ancora.parentNode) ancora.parentNode.insertBefore(p, ancora); else box.insertBefore(p, box.firstChild);
    p.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function montarPagto(raiz) {
    var total = +raiz.dataset.total || 0, formas = JSON.parse(raiz.dataset.formas || '[]'), parcelaveis = JSON.parse(raiz.dataset.parcelaveis || '[]');
    var maxP = +raiz.dataset.maxParcelas || 1, alvo = raiz.querySelector('[data-linhas]'), saldo = raiz.querySelector('[data-saldo]');
    var linhas = JSON.parse(raiz.dataset.inicial || '[]'); if (!linhas.length) linhas = [{ forma: '', valor: total, parcelas: 1 }];
    function pintarSaldo() {
      if (!linhas.some(function (l) { return l.forma; })) { saldo.textContent = ''; return; }
      var dif = total - linhas.reduce(function (s, l) { return s + (l.forma ? l.valor : 0); }, 0);
      saldo.textContent = dif === 0 ? 'Fecha certo' : (dif > 0 ? 'Falta ' : 'Passou ') + brl(Math.abs(dif));
      saldo.dataset.ok = String(dif === 0);
    }
    function desenhar() {
      alvo.innerHTML = '';
      linhas.forEach(function (l, i) {
        var linha = doc.createElement('div'); linha.className = 'cv-ag-pagto-linha';
        var v = doc.createElement('input'); v.type = 'text'; v.inputMode = 'decimal'; v.className = 'cv-ag-pagto-valor'; v.value = reais(l.valor); v.setAttribute('aria-label', 'Valor desta parte');
        v.addEventListener('input', function () { var c = centavos(v.value); l.valor = isFinite(c) ? c : 0; pintarSaldo(); });
        var sel = doc.createElement('select'); sel.className = 'cv-ag-pagto-forma'; sel.setAttribute('aria-label', 'Forma de pagamento'); sel.appendChild(new Option('Forma…', ''));
        formas.forEach(function (f) { var o = new Option(f.label, f.valor); if (f.valor === l.forma) o.selected = true; sel.appendChild(o); });
        sel.addEventListener('change', function () { l.forma = sel.value; if (parcelaveis.indexOf(l.forma) === -1) l.parcelas = 1; desenhar(); });
        linha.appendChild(v); linha.appendChild(sel);
        if (parcelaveis.indexOf(l.forma) !== -1) {
          var par = doc.createElement('select'); par.className = 'cv-ag-pagto-parcelas'; par.setAttribute('aria-label', 'Parcelas');
          for (var n = 1; n <= maxP; n++) { var op = new Option(n + 'x', String(n)); if (n === l.parcelas) op.selected = true; par.appendChild(op); }
          par.addEventListener('change', function () { l.parcelas = +par.value || 1; desenhar(); });
          linha.appendChild(par);
          if (l.parcelas > 1) { var nota = doc.createElement('span'); nota.className = 'cv-ag-pagto-nota'; nota.textContent = l.parcelas + 'x de ' + brl(Math.round(l.valor / l.parcelas)); linha.appendChild(nota); }
        }
        if (linhas.length > 1) {
          var x = doc.createElement('button'); x.type = 'button'; x.className = 'cv-ag-pagto-x'; x.setAttribute('aria-label', 'Tirar esta parte');
          x.innerHTML = '<svg class="cv-ic cv-ic--16" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
          x.addEventListener('click', function () { linhas.splice(i, 1); var resto = total - linhas.reduce(function (s, y) { return s + y.valor; }, 0); if (resto && linhas.length) linhas[0].valor += resto; desenhar(); });
          linha.appendChild(x);
        }
        alvo.appendChild(linha);
      });
      pintarSaldo();
    }
    raiz.querySelector('[data-add]').addEventListener('click', function () {
      var sobra = Math.max(total - linhas.reduce(function (s, l) { return s + l.valor; }, 0), 0);
      if (sobra === 0 && linhas.length) { var meia = Math.floor(linhas[0].valor / 2); linhas[0].valor -= meia; sobra = meia; }
      linhas.push({ forma: '', valor: sobra, parcelas: 1 }); desenhar();
    });
    raiz._coletar = function () { return linhas.filter(function (l) { return l.forma && l.valor > 0; }).map(function (l) { return { forma: l.forma, valorCentavos: l.valor, parcelas: l.parcelas }; }); };
    raiz._pendentes = function () { return linhas.filter(function (l) { return !l.forma && l.valor > 0; }); };
    raiz._marcar = function () { $$('.cv-ag-pagto-forma', alvo).forEach(function (s) { s.classList.toggle('falta', !s.value); }); };
    raiz._total = total;
    desenhar();
  }

  function montarAbas(escopo) {
    $$('[data-item-abas]', escopo).forEach(function (abas) {
      if (abas._pronto) return; abas._pronto = true;
      var sel = abas.parentNode.querySelector('[data-novo-servico]'); if (!sel) return;
      var opts = { servico: JSON.parse(sel.getAttribute('data-opts-servico') || '[]'), produto: JSON.parse(sel.getAttribute('data-opts-produto') || '[]') };
      $$('[data-aba]', abas).forEach(function (b) { b.addEventListener('click', function () {
        $$('[data-aba]', abas).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        var aba = b.getAttribute('data-aba'); sel.innerHTML = ''; sel.appendChild(new Option(aba === 'produto' ? 'Produto…' : 'Serviço…', ''));
        (opts[aba] || []).forEach(function (o) { sel.appendChild(new Option(o.label, o.id)); });
      }); });
    });
  }
  function montarTudo(escopo) { $$('[data-pagto]', escopo).forEach(montarPagto); montarAbas(escopo); }

  function recarregar(id) {
    return fetch('/painel/agenda/' + id + '/detalhe?barbeiro=' + encodeURIComponent(dados.barbeiro || ''), { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
      .then(function (html) { var box = doc.querySelector('[data-detalhe="' + id + '"]'); if (box) { box.innerHTML = html; montarTudo(box); } });
  }

  function detalhe() {
    doc.addEventListener('change', function (ev) {
      var campo = ev.target; if (!campo || !campo.dataset) return;
      var ehItem = campo.dataset.itemValor !== undefined, ehTotal = campo.dataset.totalValor !== undefined;
      if (!ehItem && !ehTotal) return;
      var box = caixaDe(campo); if (!box) return;
      var id = box.dataset.detalhe, c = centavos(campo.value);
      if (!isFinite(c) || c < 0) return avisoNaFolha(box, ehTotal ? 'Informe um total válido.' : 'Informe um valor válido para o item.', campo);
      campo.disabled = true;
      postar(ehTotal ? '/painel/agenda/' + id + '/total' : '/painel/agenda/itens/' + campo.dataset.itemValor + '/valor', { valorCentavos: c })
        .then(function (r) { return recarregar(id).then(function () { if (r && r.aviso) avisoNaFolha(doc.querySelector('[data-detalhe="' + id + '"]'), r.aviso); }); })
        .catch(function (e) { campo.disabled = false; avisoNaFolha(box, e.message, campo); });
    });

    doc.addEventListener('click', function (ev) {
      if (!ev.target.closest) return;
      var box = caixaDe(ev.target); if (!box) return;
      var id = box.dataset.detalhe, b;
      function agir(btn, url, corpo, depois) {
        ev.preventDefault(); btn.disabled = true;
        postar(url, corpo)
          .then(function (r) { if (depois) return depois(r); return recarregar(id).then(function () { if (r && r.aviso) avisoNaFolha(doc.querySelector('[data-detalhe="' + id + '"]'), r.aviso); }); })
          .catch(function (e) { btn.disabled = false; avisoNaFolha(box, e.message, btn); });
      }
      var recarregarPagina = function () { g.location.reload(); };

      if ((b = ev.target.closest('[data-concluir]'))) {
        var raiz = box.querySelector('[data-pagto]'), partes = raiz ? raiz._coletar() : [], pend = raiz ? raiz._pendentes() : [];
        // A forma é obrigatória para concluir (pedido da barbearia), menos em valor zero.
        if (pend.length) {
          raiz._marcar();
          return avisoNaFolha(box, !partes.length ? 'Escolha a forma de pagamento para concluir o atendimento.' : (pend.length === 1 ? 'Escolha a forma da outra parte, ou tire a parte.' : 'Escolha a forma das outras ' + pend.length + ' partes, ou tire as partes.'), b);
        }
        if (partes.length) {
          var soma = partes.reduce(function (s, p) { return s + p.valorCentavos; }, 0);
          if (soma !== raiz._total) return avisoNaFolha(box, 'A divisão soma ' + brl(soma) + ', mas o atendimento é ' + brl(raiz._total) + '.', b);
        }
        return agir(b, '/painel/agenda/' + id + '/status', { status: 'concluido', pagamentos: partes }, recarregarPagina);
      }
      if ((b = ev.target.closest('[data-total-auto]'))) return agir(b, '/painel/agenda/' + id + '/total', { auto: true });
      if ((b = ev.target.closest('[data-reabrir]'))) return agir(b, '/painel/agenda/' + id + '/status', { status: 'agendado' }, recarregarPagina);
      if ((b = ev.target.closest('[data-faltou]'))) {
        if (!g.confirm('Marcar que o cliente faltou? O horário volta a ficar livre.')) return;
        return agir(b, '/painel/agenda/' + id + '/status', { status: 'faltou' }, recarregarPagina);
      }
      if ((b = ev.target.closest('[data-cancelar]'))) {
        if (!g.confirm('Cancelar este atendimento?')) return;
        return agir(b, '/painel/agenda/' + id + '/status', { status: 'cancelado' }, recarregarPagina);
      }
      if ((b = ev.target.closest('[data-add-item]'))) {
        var sel = box.querySelector('[data-novo-servico]'), qtd = box.querySelector('[data-nova-qtd]');
        if (!sel || !sel.value) return avisoNaFolha(box, 'Escolha um item para adicionar.', b);
        return agir(b, '/painel/agenda/' + id + '/itens', { servicoId: sel.value, quantidade: qtd ? qtd.value : 1 });
      }
      if ((b = ev.target.closest('[data-remover-item]'))) return agir(b, '/painel/agenda/itens/' + b.dataset.removerItem + '/remover', {});
      if ((b = ev.target.closest('[data-excluir]'))) {
        if (!g.confirm('Excluir este agendamento? Não dá para desfazer.')) return;
        return agir(b, '/painel/agenda/' + id + '/excluir', {}, recarregarPagina);
      }
    });
    montarTudo(doc);
  }

  /* ---- 4. Linha do dia -------------------------------------------------- */
  function blocosLivres(hs, aPartirDe) {
    var blocos = [], atual = null;
    hs.forEach(function (h) {
      var m = min(h.hora);
      if (!h.livre || m < aPartirDe) { atual = null; return; }
      if (atual && m === atual.fim) { atual.fim = m + PASSO; atual.n++; } else { atual = { ini: m, fim: m + PASSO, n: 1 }; blocos.push(atual); }
    });
    return blocos;
  }
  function livres() {
    var tl = doc.getElementById('cv-ag-tl'); if (!tl || !tl.dataset.barbeiro) return;
    var data = tl.dataset.data, hoje = tl.dataset.hoje === '1';
    fetch('/painel/agenda/horarios?' + new URLSearchParams({ barbeiroId: tl.dataset.barbeiro, data: data }), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { horarios: [] }; })
      .then(function (j) {
        var blocos = blocosLivres(j.horarios || [], hoje ? +tl.dataset.agora : 0); if (!blocos.length) return;
        var total = 0;
        blocos.forEach(function (b) {
          total += b.n;
          var txt = hhmm(b.ini) + ' até ' + hhmm(b.fim) + ', ' + b.n + (b.n === 1 ? ' horário' : ' horários');
          var item = doc.createElement('div'); item.className = 'cv-tl-item'; item.dataset.min = b.ini;
          item.innerHTML = '<span class="cv-tl-hora">' + hhmm(b.ini) + '</span><button type="button" class="cv-ag livre cv-toca" aria-label="Livre, ' + esc(txt) + '. Marcar um cliente"><span class="corpo"><span class="t">Livre</span><span class="s">' + esc(txt) + '</span></span><span class="mais" aria-hidden="true"><svg class="cv-ic cv-ic--18" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span></button>';
          item.querySelector('button').addEventListener('click', function () { abrirModal('novo'); if (novo.abrirCom) novo.abrirCom(data, hhmm(b.ini)); });
          var depois = Array.prototype.find.call(tl.children, function (el) { return +el.dataset.min > b.ini; });
          tl.insertBefore(item, depois || null);
        });
        var res = doc.getElementById('cv-ag-resumo');
        if (res) { var n = +res.dataset.n || 0; res.textContent = (n ? n + (n === 1 ? ' atendimento e ' : ' atendimentos e ') : '') + total + (total === 1 ? ' horário livre' : ' horários livres'); }
      })
      .catch(function () {});
  }
  function centralizarDia() {
    var tira = doc.getElementById('cv-ag-dias'), sel = tira && tira.querySelector('.cv-dia.sel'); if (!sel) return;
    // No PC (revisão Dani P3 #27) a tira começa dois dias antes do
    // selecionado, sem dia cortado na borda; no celular, centraliza.
    if (g.matchMedia && g.matchMedia('(min-width: 1024px)').matches) {
      var dias = Array.prototype.slice.call(tira.querySelectorAll('.cv-dia')), i = dias.indexOf(sel), ini = dias[Math.max(0, i - 2)];
      tira.scrollLeft = Math.max(0, ini.offsetLeft - dias[0].offsetLeft);
      return;
    }
    tira.scrollLeft = Math.max(0, Math.min(sel.offsetLeft - (tira.clientWidth - sel.offsetWidth) / 2, tira.scrollWidth - tira.clientWidth));
  }

  /* ---- 5. Bloqueio ------------------------------------------------------ */
  function bloqueio() {
    var ini = doc.getElementById('bloq-ini'), fim = doc.getElementById('bloq-fim'); if (!ini || !fim) return;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var h = Math.min(new Date().getHours() + 1, 22);
    if (!ini.value) { ini.value = p2(h) + ':00'; fim.value = p2(h + 1) + ':00'; }
    ini.addEventListener('change', function () { if (!ini.value) return; var p = ini.value.split(':'); if (!fim.value || fim.value <= ini.value) fim.value = p2(Math.min(+p[0] + 1, 23)) + ':' + p[1]; });
  }

  function iniciar() { ligarFolhas(); novo(); detalhe(); livres(); centralizarDia(); bloqueio(); avisoDesfazer(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(window);
