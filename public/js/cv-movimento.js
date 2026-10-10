/* =========================================================================
   Cortavo v3 · movimento.js (Dani Design, 2026-10-06)
   Implementação de referência dos 7 movimentos-assinatura (M1 a M7).
   Sem biblioteca: WAAPI + transitions + mola.js. Copiado de redesign/v3 para
   public/js/cv-movimento.js (fatia F0). Valores: motion-spec.md.
   Regra de ouro: toda animação parte do valor que está NA TELA agora
   (getComputedStyle), então tudo pode ser interrompido sem salto.
   ========================================================================= */
(function (g) {
  'use strict';
  var M = g.Mola, doc = g.document;
  var EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)', EASE_IO = 'cubic-bezier(0.77, 0, 0.175, 1)';
  function reduz() { return M.reduzMovimento(); }
  function atual(el, prop) { return getComputedStyle(el)[prop]; }
  function parar(el) { el.getAnimations().forEach(function (a) { a.cancel(); }); }
  function vibrar(ms) {
    /* No app da loja (Capacitor) usa o Haptics nativo quando o plugin existir; no navegador, vibrate. */
    try {
      var H = g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.Haptics;
      if (H) { if (ms >= 10) H.notification({ type: 'SUCCESS' }); else H.impact({ style: 'LIGHT' }); return; }
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) {}
  }

  /* ---- O logo: C com check (traçado do ícone oficial, 1024x1024) -------- */
  var LOGO_D = 'M600 350A250 250 0 1 0 415 763L550 765L897 385L760 385L483 686L450 662L430 652A139.8 139.8 0 1 1 522 427Z';
  /* Linha-guia do traço: o C e o check são UM gesto só (começa na ponta do C,
     dá a volta, sai pelo pé e sobe a 45°, o mesmo ângulo da listra). */
  var LOGO_GUIA = 'M564 388A195 195 0 1 0 415 708L522 708L872 328';
  var nLogo = 0;
  function logoSVG(cor, comMascara) {
    var id = 'cvlg' + (++nLogo);
    if (!comMascara) return '<svg class="logo" viewBox="150 240 770 545" aria-hidden="true"><path fill="' + (cor || '#fff') + '" d="' + LOGO_D + '"/></svg>';
    return '<svg class="logo" viewBox="150 240 770 545" aria-hidden="true"><defs><mask id="' + id + '" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">' +
      '<path class="guia" d="' + LOGO_GUIA + '" fill="none" stroke="#fff" stroke-width="150" stroke-linejoin="miter"/></mask></defs>' +
      '<path fill="' + (cor || '#fff') + '" d="' + LOGO_D + '" mask="url(#' + id + ')"/></svg>';
  }
  /* Desenha o logo como um traço (M1). dur ~560ms, ease-in-out: é um gesto. */
  function desenharLogo(svg, dur, atraso) {
    var guia = svg.querySelector('.guia'); if (!guia) return null;
    var L = guia.getTotalLength(); guia.style.strokeDasharray = L + ' ' + L;
    // Reduzir movimento: o logo aparece pronto, esmaecendo (200 ms), sem traço.
    if (reduz()) { guia.style.strokeDashoffset = 0; return svg.animate ? svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: atraso || 0, fill: 'backwards' }) : null; }
    guia.style.strokeDashoffset = L;
    return guia.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: dur || 560, delay: atraso || 0, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' });
  }

  /* ---- M2: número que conta ---------------------------------------------- */
  function fmtBRL(v, casas) {
    casas = casas == null ? 2 : casas;
    var s = Math.abs(v).toFixed(casas).split('.'), i = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return { int: (v < 0 ? '−' : '') + i, cent: casas ? ',' + s[1] : '' };
  }
  function contar(el, para, opc) {
    opc = opc || {}; var de = opc.de || 0, dur = opc.dur || 700, casas = opc.casas == null ? 0 : opc.casas;
    var alvoInt = el.querySelector('.int') || el, alvoCent = el.querySelector('.cent');
    function pinta(v) { var f = fmtBRL(v, casas); alvoInt.textContent = f.int; if (alvoCent && casas) alvoCent.textContent = f.cent; }
    if (reduz() || opc.semAnimar) { pinta(para); return; }
    var t0 = null;
    function passo(t) { if (!t0) t0 = t; var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 4); pinta(de + (para - de) * e); if (p < 1) requestAnimationFrame(passo); }
    pinta(de); requestAnimationFrame(passo);
  }

  /* ---- M6: odômetro (dígitos que rolam ao trocar o período) -------------- */
  function odometro(el, texto, animar) {
    var cols = el.querySelectorAll('.cv-odo-col'), chars = String(texto).split('');
    var mesmaForma = el.dataset.forma === chars.map(function (c) { return /\d/.test(c) ? 'd' : c; }).join('');
    el.setAttribute('aria-label', texto);
    if (!mesmaForma) {
      el.innerHTML = chars.map(function (c) {
        if (!/\d/.test(c)) return '<span aria-hidden="true">' + c + '</span>';
        var col = ''; for (var i = 0; i <= 9; i++) col += '<i>' + i + '</i>';
        return '<span class="cv-odo-col" aria-hidden="true"><span style="transform:translateY(-' + (+c * 1.1) + 'em)">' + col + '</span></span>';
      }).join('');
      el.classList.add('cv-odo'); el.dataset.forma = chars.map(function (c) { return /\d/.test(c) ? 'd' : c; }).join('');
      if (animar && !reduz()) el.animate([{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 240, easing: EASE_OUT });
      return;
    }
    var k = 0;
    chars.forEach(function (c) { if (/\d/.test(c)) { var s = cols[k++].firstElementChild; s.style.transform = 'translateY(-' + (+c * 1.1) + 'em)'; } });
  }

  /* ---- M2: anéis que fecham ---------------------------------------------- */
  /* <circle class="arco" pathLength="100" data-p="0.69">; stagger 80ms */
  function aneis(svg, opc) {
    opc = opc || {};
    var arcos = svg.querySelectorAll('.arco');
    arcos.forEach(function (a, i) {
      var p = Math.max(0, Math.min(1, +a.dataset.p || 0)), fim = 100 - p * 100;
      a.setAttribute('stroke-dasharray', '100 100');
      if (reduz() || opc.semAnimar) { a.style.strokeDashoffset = fim; return; }
      var ini = a.style.strokeDashoffset !== '' ? parseFloat(atual(a, 'strokeDashoffset')) : 100;
      parar(a); a.style.strokeDashoffset = fim;
      var m = M.mola(M.MOLAS.padrao);
      a.animate([{ strokeDashoffset: ini }, { strokeDashoffset: fim }], opc.abertura ?
        { duration: 700, delay: i * 80, easing: EASE_OUT, fill: 'backwards' } :
        { duration: m.duracao, easing: m.easing });
    });
  }

  /* ---- M6: barras que crescem / morfam ------------------------------------ */
  /* els: lista de elementos; vals: 0..1; eixo 'Y' (vertical) ou 'X'. */
  function barras(els, vals, opc) {
    opc = opc || {}; var eixo = opc.eixo || 'Y';
    Array.prototype.forEach.call(els, function (b, i) {
      var v = Math.max(0, Math.min(1, vals[i] || 0)), fim = 'scale' + eixo + '(' + Math.max(v, 0.0001) + ')';
      if (reduz() || opc.semAnimar) { parar(b); b.style.transform = fim; return; }
      var ini = opc.inicial ? 'scale' + eixo + '(0.0001)' : atual(b, 'transform');
      if (ini === 'none') ini = 'scale' + eixo + '(1)';
      parar(b); b.style.transform = fim;
      b.animate([{ transform: ini }, { transform: fim }], opc.inicial ?
        { duration: 500, delay: Math.min(i * 24, 280), easing: EASE_OUT, fill: 'backwards' } :
        { duration: 320, easing: EASE_IO });
    });
  }

  /* ---- M5: lente da navbar ------------------------------------------------ */
  function lente(nav, alvo, animar) {
    var L = nav.querySelector('.cv-lente'); if (!L || !alvo) return;
    var rn = nav.getBoundingClientRect(), ra = alvo.getBoundingClientRect();
    var x = ra.left - rn.left, w = ra.width;
    L.style.width = w + 'px';
    var fim = x + 'px 0';
    if (!animar || reduz() || !L.dataset.pos) { parar(L); L.style.translate = fim; L.dataset.pos = x; return; }
    var ini = atual(L, 'translate'); parar(L); L.style.translate = fim; L.dataset.pos = x;
    var m = M.mola(M.MOLAS.lente);
    L.animate([{ translate: ini }, { translate: fim }], { duration: m.duracao, easing: m.easing });
    /* o "líquido": estica no meio do caminho e assenta */
    var dist = Math.abs(parseFloat(ini) - x), est = Math.min(1.28, 1 + dist / 420);
    L.animate([{ scale: '1 1' }, { scale: est + ' .92', offset: .4 }, { scale: '1 1' }], { duration: 280, easing: EASE_IO });
    /* sem haptic: troca de aba acontece 100+ vezes por dia (regra de utilidade) */
  }

  /* ---- M4: folha de vidro -------------------------------------------------- */
  var folhaAtual = null;
  function folhaAbrir(f, opc) {
    opc = opc || {}; var veu = doc.querySelector('.cv-veu');
    folhaAtual = f; f.classList.add('aberta'); f.classList.remove('assentada');
    doc.body.classList.add('folha-aberta'); if (veu) veu.classList.add('on');
    if (opc.gatilho) opc.gatilho.setAttribute('aria-expanded', 'true');
    f._gatilho = opc.gatilho;
    var ini = f.style.transform ? atual(f, 'transform') : 'translateY(105%)';
    parar(f); f.style.transform = 'translateY(0)';
    var assentar = function () { f.classList.add('assentada'); };
    if (reduz()) { f.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 }); assentar(); }
    else { var m = M.mola(M.MOLAS.folha); var a = f.animate([{ transform: ini }, { transform: 'translateY(0)' }], { duration: m.duracao, easing: m.easing }); a.onfinish = assentar;
      Array.prototype.forEach.call(f.querySelectorAll('[data-cascata]'), function (el, i) { el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 60 + i * 40, easing: EASE_OUT, fill: 'backwards' }); }); }
    var foco = f.querySelector('[data-foco]') || f.querySelector('button, a, input'); if (foco) setTimeout(function () { foco.focus({ preventScroll: true }); }, 50);
    vibrar(6);
  }
  function folhaFechar(f, opc) {
    f = f || folhaAtual; if (!f) return; opc = opc || {};
    var veu = doc.querySelector('.cv-veu');
    f.classList.remove('assentada'); doc.body.classList.remove('folha-aberta'); if (veu) veu.classList.remove('on');
    if (f._gatilho) { f._gatilho.setAttribute('aria-expanded', 'false'); f._gatilho.focus({ preventScroll: true }); }
    var ini = atual(f, 'transform'); parar(f); f.style.transform = 'translateY(105%)';
    var fim = function () { f.classList.remove('aberta'); if (opc.aoFim) opc.aoFim(); };
    if (reduz()) { f.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'none' }], { duration: 200 }).onfinish = fim; }
    else { var m = M.mola(opc.velocidade ? { resposta: 0.32, amortecimento: 1, velocidade: opc.velocidade } : { resposta: 0.32, amortecimento: 1 });
      f.animate([{ transform: ini }, { transform: 'translateY(105%)' }], { duration: m.duracao, easing: m.easing }).onfinish = fim; }
    folhaAtual = null;
  }
  /* Arrastar: 1:1, elástico para cima, fecha por projeção ou velocidade */
  function folhaArrastar(f) {
    var zona = f.querySelector('.cv-folha-zona') || f, y0 = 0, dy = 0, hist = [], arrastando = false;
    zona.addEventListener('pointerdown', function (e) {
      if (arrastando) return; arrastando = true; zona.setPointerCapture(e.pointerId);
      var m = new DOMMatrix(atual(f, 'transform')); parar(f); f.style.transform = 'translateY(' + m.m42 + 'px)';
      y0 = e.clientY - m.m42; hist = [[e.timeStamp, e.clientY]]; f.classList.remove('assentada');
    });
    zona.addEventListener('pointermove', function (e) {
      if (!arrastando) return; dy = e.clientY - y0;
      var y = dy < 0 ? M.elastico(dy, f.offsetHeight, 0.4) : dy;
      f.style.transform = 'translateY(' + y + 'px)';
      hist.push([e.timeStamp, e.clientY]); if (hist.length > 6) hist.shift();
    });
    function soltar() {
      if (!arrastando) return; arrastando = false;
      var a = hist[0], b = hist[hist.length - 1], v = b && a && b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) * 1000 : 0;
      var h = f.offsetHeight, proj = Math.max(0, dy) + M.projetar(v);
      if (proj > h * 0.5 || v > 700) folhaFechar(f, { velocidade: Math.max(0, v) / Math.max(1, h - dy) });
      else { var ini = atual(f, 'transform'); f.style.transform = 'translateY(0)'; var m = M.mola(Math.abs(v) > 400 ? M.MOLAS.arremesso : M.MOLAS.folha);
        f.animate([{ transform: ini }, { transform: 'translateY(0)' }], { duration: m.duracao, easing: m.easing }).onfinish = function () { f.classList.add('assentada'); }; }
      dy = 0;
    }
    zona.addEventListener('pointerup', soltar); zona.addEventListener('pointercancel', soltar);
  }

  /* ---- M1: selo do C com check --------------------------------------------- */
  function selo(opc) {
    opc = opc || {};
    var el = doc.createElement('div'); el.className = 'cv-selo'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="cv-selo-veu"></div><div class="cv-selo-anel"></div><div class="cv-selo-disco">' + logoSVG('#fff', true) + '</div>' +
      '<div class="cv-selo-txt"><b>' + (opc.titulo || 'Feito') + '</b>' + (opc.sub ? '<span>' + opc.sub + '</span>' : '') + '</div>';
    doc.body.appendChild(el);
    var veu = el.querySelector('.cv-selo-veu'), disco = el.querySelector('.cv-selo-disco'), anel = el.querySelector('.cv-selo-anel'), txt = el.querySelector('.cv-selo-txt'), svg = disco.querySelector('svg');
    var guia = svg.querySelector('.guia'), L = guia.getTotalLength(); guia.style.strokeDasharray = L + ' ' + L; guia.style.strokeDashoffset = L;
    var b = opc.botao, proc = opc.processando || 0;

    function terminar() {
      setTimeout(function () {
        var s = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: EASE_OUT, fill: 'forwards' });
        s.onfinish = function () { el.remove(); if (b) { b.style.visibility = ''; } };
        if (opc.aoFim) opc.aoFim();
      }, opc.segurar || 1300);
    }
    if (reduz()) {
      guia.style.strokeDashoffset = 0; if (b) b.style.visibility = 'hidden';
      [veu, disco, txt].forEach(function (x) { x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' }); });
      vibrar(12); terminar(); return;
    }
    /* 1. o botão encolhe até virar um círculo, onde está (a ação acontece no lugar) */
    var t = 0, rb = b ? b.getBoundingClientRect() : null, cx = innerWidth / 2, cy = innerHeight / 2;
    disco.style.opacity = '0';
    if (b) {
      var fant = doc.createElement('div'); fant.className = 'cv-selo-fant';
      fant.style.cssText = 'position:fixed;left:' + rb.left + 'px;top:' + rb.top + 'px;width:' + rb.width + 'px;height:' + rb.height + 'px;border-radius:999px;background:#111;z-index:1;overflow:hidden';
      el.appendChild(fant); b.style.visibility = 'hidden';
      var r = rb.height / 2, lado = (rb.width - rb.height) / 2;
      fant.animate([{ clipPath: 'inset(0 0 0 0 round ' + r + 'px)' }, { clipPath: 'inset(0 ' + lado + 'px 0 ' + lado + 'px round ' + r + 'px)' }], { duration: 300, easing: EASE_IO, fill: 'forwards' });
      t = 300;
      /* 1b. processando: o círculo vira um poste girando (M3 dentro do M1) */
      if (proc) {
        var pst = doc.createElement('i'); pst.style.cssText = 'position:absolute;inset:-40px;background:repeating-linear-gradient(-45deg,rgba(255,255,255,.22) 0 5px,transparent 5px 12px);';
        fant.appendChild(pst);
        pst.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(24.04px)' }], { duration: 600, iterations: Infinity, easing: 'linear' });
        t += proc;
      }
      setTimeout(function () { fant.remove(); }, t + 20);
      var x0 = rb.left + rb.width / 2, y0 = rb.top + rb.height / 2, s0 = rb.height / 112;
      var ms = M.mola(M.MOLAS.selo);
      disco.animate([{ opacity: 1, transform: 'translate(' + (x0 - cx) + 'px,' + (y0 - cy) + 'px) scale(' + s0 + ')' }, { opacity: 1, transform: 'none' }], { duration: ms.duracao, delay: t, easing: ms.easing, fill: 'both' });
    } else {
      var ms2 = M.mola(M.MOLAS.selo);
      disco.animate([{ opacity: 0, transform: 'scale(.86)' }, { opacity: 1, transform: 'none' }], { duration: ms2.duracao, easing: ms2.easing, fill: 'both' });
    }
    veu.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: t, easing: EASE_OUT, fill: 'both' });
    /* 2. o C se escreve e o check sobe a 45° (um traço só) */
    var tC = t + 200;
    guia.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 560, delay: tC, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' });
    /* 3. haptic no quadro em que o check termina */
    setTimeout(function () { vibrar(12); }, tC + 560);
    /* 4. a listra de barbeiro dá UMA volta em torno do selo */
    anel.animate([{ opacity: 0, transform: 'rotate(-90deg) scale(.92)' }, { opacity: 1, transform: 'rotate(0deg) scale(1)', offset: .35 }, { opacity: 1, transform: 'rotate(200deg) scale(1)', offset: .75 }, { opacity: 0, transform: 'rotate(270deg) scale(1.04)' }],
      { duration: 900, delay: tC + 380, easing: EASE_IO, fill: 'both' });
    /* 5. o texto entra depois do check */
    txt.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: tC + 620, easing: EASE_OUT, fill: 'both' });
    setTimeout(terminar, tC + 620);
  }

  /* ---- M7: cartão que abre (View Transitions) ------------------------------ */
  function abrirCartao(cartao, mudar) {
    if (!doc.startViewTransition || reduz()) { mudar(); return; }
    if (cartao) cartao.style.viewTransitionName = 'cv-cartao';
    var vt = doc.startViewTransition(function () { if (cartao) cartao.style.viewTransitionName = ''; mudar(); });
    return vt;
  }

  /* ---- Cabeçalho compacto de vidro ao rolar -------------------------------- */
  function cabecalho(opc) {
    opc = opc || {};
    var cab = doc.querySelector('.cv-cab-compacto'), pend = false;
    function medir() {
      pend = false; var y = g.scrollY, txt = doc.querySelector('.cv-cab .cv-cab-txt'), lim = opc.limiar || 44;
      if (txt && !reduz()) { var p = Math.max(0, Math.min(1, y / lim)); txt.style.transform = 'scale(' + (1 - p * 0.08) + ')'; txt.style.opacity = String(1 - p * 0.9); }
      if (cab) cab.classList.toggle('vidro', y > lim * 0.9);
    }
    g.addEventListener('scroll', function () { if (!pend) { pend = true; requestAnimationFrame(medir); } }, { passive: true });
    medir(); return medir;
  }

  /* ---- Aviso (toast) com check desenhado ----------------------------------- */
  function aviso(opc) {
    var box = doc.querySelector('.cv-avisos'); if (!box) { box = doc.createElement('div'); box.className = 'cv-avisos'; box.setAttribute('aria-live', 'polite'); doc.body.appendChild(box); }
    Array.prototype.forEach.call(box.children, function (c) { c.setAttribute('data-saindo', ''); setTimeout(function () { c.remove(); }, 240); });
    var t = doc.createElement('div'); t.className = 'cv-aviso';
    t.innerHTML = '<span class="ok"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7" pathLength="1" style="stroke-dasharray:1 1;stroke-dashoffset:1"/></svg></span><span><b>' + opc.titulo + '</b>' + (opc.sub ? '<small>' + opc.sub + '</small>' : '') + '</span>' + (opc.desfazer ? '<button class="desfazer" type="button">Desfazer</button>' : '');
    box.appendChild(t);
    var p = t.querySelector('path');
    if (!reduz()) p.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 260, delay: 140, easing: EASE_OUT, fill: 'forwards' }); else p.style.strokeDashoffset = 0;
    setTimeout(function () { t.setAttribute('data-saindo', ''); setTimeout(function () { t.remove(); }, 260); }, opc.tempo || 3200);
    return t;
  }

  g.Cortavo = { logoSVG: logoSVG, desenharLogo: desenharLogo, contar: contar, odometro: odometro, fmtBRL: fmtBRL, aneis: aneis, barras: barras, lente: lente,
    folha: { abrir: folhaAbrir, fechar: folhaFechar, arrastar: folhaArrastar, atual: function () { return folhaAtual; } },
    selo: selo, abrirCartao: abrirCartao, cabecalho: cabecalho, aviso: aviso, reduz: reduz, LOGO_D: LOGO_D };
})(window);
