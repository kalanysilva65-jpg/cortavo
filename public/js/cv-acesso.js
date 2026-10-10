/* Cortavo v3 · telas de acesso (login, esqueci, criar senha, trocar senha,
   link inválido, pausado). Base: redesign/v3/acesso/mockups/acesso.js (Dani).
   Tudo aqui é melhoria progressiva: sem JS, cada tela é um formulário comum
   com POST e redirect, e funciona igual. */
(function () {
  'use strict';
  var doc = document, body = doc.body;
  var C = window.Cortavo, M = window.Mola;
  var EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
  function $(s, c) { return (c || doc).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); }
  function reduz() { return M ? M.reduzMovimento() : matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function vibrar(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
  function guardar(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} }
  function ler(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }

  var tela = $('.ac-tela');
  if (!tela) return;

  /* ---- Abertura do acesso (M8): substitui o splash "CORTAVO" ------------
     O objeto nasce do tamanho do ícone e abre com a mola da folha; o C se
     escreve e vai ao canto; título, listra e formulário entram. Uma vez por
     sessão; ao voltar de um erro, a tela entra pronta. Tocar ou focar um
     campo termina tudo na hora. */
  function abertura() {
    var obj = $('.ac-obj', tela);
    if (!obj || !C || !M || ler('cvAcesso')) return;
    guardar('cvAcesso', '1');
    if ($('.ac-erro:not([hidden])', tela)) return;
    var cascata = $$('[data-cascata]', tela);
    if (reduz()) { [obj].concat(cascata).forEach(function (el) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE_OUT }); }); return; }
    var r = obj.getBoundingClientRect(), lado = Math.min(92, r.width), cy = Math.max(0, (r.height - lado) / 2), cx = Math.max(0, (r.width - lado) / 2);
    var mf = M.mola(M.MOLAS.folha), mp = M.mola(M.MOLAS.padrao), raio = getComputedStyle(obj).borderTopLeftRadius;
    obj.animate([{ clipPath: 'inset(' + cy + 'px ' + cx + 'px round 22px)' }, { clipPath: 'inset(0 round ' + raio + ')' }], { duration: mf.duracao, delay: 60, easing: mf.easing, fill: 'backwards' });
    var ic = $('[data-icone]', tela);
    if (ic) {
      var ri = ic.getBoundingClientRect();
      ic.innerHTML = C.logoSVG('#fff', true);
      var dx = (r.left + r.width / 2) - (ri.left + ri.width / 2), dy = (r.top + r.height / 2) - (ri.top + ri.height / 2), s = lado / ri.width;
      ic.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')' }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')', offset: 0 }, { transform: 'none' }], { duration: mp.duracao, delay: 620, easing: mp.easing, fill: 'backwards' });
      var svg = $('svg', ic); if (svg && C.desenharLogo) C.desenharLogo(svg, 520, 140);
    }
    $$('.ac-nome, .ac-voltar', tela).forEach(function (el) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 820, easing: EASE_OUT, fill: 'backwards' }); });
    $$('.ac-cab > *', tela).forEach(function (el, i) { el.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 700 + i * 70, easing: EASE_OUT, fill: 'backwards' }); });
    var fa = $('.ac-fantasma', tela); if (fa) fa.animate([{ opacity: 0, transform: 'translate(-28px, 28px)' }, { opacity: 1, transform: 'none' }], { duration: 900, delay: 520, easing: EASE_OUT, fill: 'backwards' });
    cascata.forEach(function (el, i) { el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 820 + i * 45, easing: EASE_OUT, fill: 'backwards' }); });
    var fim = function () { tela.getAnimations({ subtree: true }).forEach(function (a) { if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish(); }); };
    tela.addEventListener('pointerdown', fim, { once: true });
    tela.addEventListener('focusin', fim, { once: true });
  }

  /* ---- Mostrar / ocultar senha: não tira o foco (o teclado não fecha) ---- */
  function alternar(b, forcar) {
    var ids = b.getAttribute('aria-controls').split(' '), primeiro = doc.getElementById(ids[0]);
    var mostra = forcar != null ? forcar : primeiro.type === 'password';
    ids.forEach(function (id) { var i = doc.getElementById(id); if (i) i.type = mostra ? 'text' : 'password'; });
    b.textContent = mostra ? 'Ocultar' : 'Mostrar';
    b.setAttribute('aria-pressed', String(mostra));
  }
  $$('[data-mostrar]').forEach(function (b) {
    b.hidden = false;
    b.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function () {
      alternar(b);
      var inp = doc.getElementById(b.getAttribute('aria-controls').split(' ')[0]), n = inp.value.length;
      inp.focus({ preventScroll: true }); try { inp.setSelectionRange(n, n); } catch (e) {}
    });
  });

  /* ---- Botão ocupado (M3): desliga já; a listra só depois de 300 ms ------ */
  function ocupado(btn, sim) {
    if (!btn) return;
    var rot = $('.rot', btn);
    if (sim) {
      btn.dataset.rotulo = rot.textContent; btn.setAttribute('aria-busy', 'true');
      btn._t = setTimeout(function () { btn.classList.add('carregando'); rot.textContent = btn.dataset.ocupado || rot.textContent; }, 300);
    } else {
      clearTimeout(btn._t); btn.removeAttribute('aria-busy'); btn.classList.remove('carregando');
      if (btn.dataset.rotulo) rot.textContent = btn.dataset.rotulo;
    }
  }
  // Voltar pelo navegador restaura a página do cache: destrava os botões.
  addEventListener('pageshow', function () { $$('.ac-btn[aria-busy]').forEach(function (b) { ocupado(b, false); }); });

  function erroCampo(campo, msg) {
    if (!campo) return;
    var p = $('.cv-erro', campo), i = $('.cv-entrada', campo);
    if (p) { p.textContent = msg; p.hidden = !msg; if (msg && !p.id) p.id = campo.id + '-erro'; }
    campo.classList.toggle('invalido', !!msg);
    if (msg) { i.setAttribute('aria-invalid', 'true'); if (p) i.setAttribute('aria-describedby', p.id); }
    else i.removeAttribute('aria-invalid');
  }

  /* ---- Login: JSON com o servidor, erro sem recarregar, M1 "Tudo certo" -- */
  var fl = $('form[data-acesso="login"]');
  if (fl) {
    var btnEntrar = $('#btn-entrar'), caixa = $('#login-erro');
    var mostrarErro = function (msg, animar) {
      var estava = !caixa.hidden; $('span', caixa).textContent = msg; caixa.hidden = false;
      [fl.email, fl.senha].forEach(function (i) { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', 'login-erro'); });
      if (animar && !reduz()) {
        if (!estava) caixa.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE_OUT });
        else caixa.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], { duration: 320, easing: EASE_OUT });
      }
    };
    fl.addEventListener('input', function () { [fl.email, fl.senha].forEach(function (i) { i.removeAttribute('aria-invalid'); }); });
    fl.addEventListener('submit', function (e) {
      if (!window.fetch || !window.FormData) return; // envio comum
      e.preventDefault();
      if (btnEntrar.getAttribute('aria-busy') === 'true') return;
      if (!fl.email.value.trim() || !fl.senha.value) { mostrarErro('Digite seu e-mail e sua senha.', true); (fl.email.value.trim() ? fl.senha : fl.email).focus(); return; }
      ocupado(btnEntrar, true);
      var corpo = new URLSearchParams(new FormData(fl));
      fetch(fl.action, { method: 'POST', body: corpo, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(function (r) { return r.json().catch(function () { return { ok: false, comum: true }; }); })
        .then(function (d) {
          if (d && d.ok) {
            caixa.hidden = true;
            var ir = function () { location.href = d.destino || '/painel'; };
            if (!C || !C.selo) { ir(); return; }
            btnEntrar.setAttribute('aria-busy', 'true');
            C.selo({ botao: btnEntrar, titulo: 'Tudo certo', sub: d.barbearia ? 'Abrindo a ' + d.barbearia : 'Abrindo o painel', segurar: 450, aoFim: function () { setTimeout(ir, 160); } });
            return;
          }
          if (d && (d.pausada || d.comum)) { HTMLFormElement.prototype.submit.call(fl); return; } // a tela de pausa vem do servidor
          ocupado(btnEntrar, false);
          mostrarErro((d && d.erro) || 'E-mail ou senha inválidos.', true);
          fl.senha.value = ''; fl.senha.focus(); vibrar([12, 40, 12]);
        })
        .catch(function () { HTMLFormElement.prototype.submit.call(fl); });
    });
  }

  /* ---- Esqueci: valida o formato; guarda o e-mail SÓ neste navegador ----- */
  var fe = $('form[data-acesso="esqueci"]');
  if (fe) {
    fe.addEventListener('submit', function (e) {
      var em = fe.email, valido = em.value.trim() && em.checkValidity();
      erroCampo($('#c-esq-email'), valido ? '' : 'Digite um e-mail válido.');
      if (!valido) { e.preventDefault(); em.focus(); return; }
      guardar('cvEsqEmail', em.value.trim());
      ocupado($('#btn-esqueci'), true);
    });
  }
  var enviado = $('#esqueci-enviado');
  if (enviado) {
    var digitado = ler('cvEsqEmail'), linha = $('[data-email-digitado]', enviado);
    if (digitado && linha) { $('b', linha).textContent = digitado; linha.hidden = false; }
    var br = $('#btn-reenviar'), fr = $('#f-reenviar');
    if (br && fr && digitado) {
      fr.email.value = digitado; br.hidden = false;
      var t = 60, pinta = function () {
        if (t > 0) { br.setAttribute('aria-disabled', 'true'); br.innerHTML = 'Reenviar em <span class="cv-num">' + Math.floor(t / 60) + ':' + (t % 60 < 10 ? '0' : '') + (t % 60) + '</span>'; }
        else { br.removeAttribute('aria-disabled'); br.textContent = 'Reenviar link'; clearInterval(iv); }
      };
      var iv = setInterval(function () { t--; pinta(); }, 1000); pinta();
      fr.addEventListener('submit', function (e) { if (br.getAttribute('aria-disabled')) e.preventDefault(); });
    }
  }

  /* ---- Senha nova (criar e trocar): força e requisitos ao vivo ----------- */
  function bytes(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; } }
  function forca(s) {
    var n = s.length; if (!n) return 0; if (n < 8) return 1;
    var classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(function (r) { return r.test(s); }).length;
    if (n >= 16 || (n >= 12 && classes >= 3)) return 4; if (n >= 12 || classes >= 3) return 3; return 2;
  }
  var ROT = ['', 'Curta', 'Razoável', 'Boa', 'Forte'];
  function senhaNova(f, nova, conf, atual) {
    var req = $('.ac-req', f);
    function pinta() {
      var s = nova.value, k = forca(s), n = s.length;
      $$('.ac-forca .seg', f).forEach(function (seg, i) { seg.classList.toggle('on', i < k); });
      var tx = $('.ac-forca .txt', f); if (tx) tx.textContent = ROT[k];
      var cont = $('.n', req); if (cont) cont.textContent = n < 8 ? n + '/8' : '';
      $('[data-req="tam"]', req).classList.toggle('ok', n >= 8 && bytes(s) <= 72);
      var dif = $('[data-req="dif"]', req); if (dif) dif.classList.toggle('ok', n > 0 && s !== atual.value);
      $('[data-req="igual"]', req).classList.toggle('ok', !!conf.value && conf.value === s);
      erroCampo(nova.closest('.cv-campo'), bytes(s) > 72 ? 'Use no máximo 72 caracteres.' : '');
    }
    [nova, conf].concat(atual ? [atual] : []).forEach(function (i) { i.addEventListener('input', function () { pinta(); if (i !== nova) erroCampo(i.closest('.cv-campo'), ''); }); });
    pinta();
    f.addEventListener('submit', function (e) {
      var s = nova.value, ok = true, btn = $('.ac-btn', f);
      if (btn.getAttribute('aria-busy') === 'true') { e.preventDefault(); return; }
      if (atual && !atual.value) { erroCampo(atual.closest('.cv-campo'), 'Digite a senha atual.'); ok = false; }
      if (s.length < 8) { erroCampo(nova.closest('.cv-campo'), atual ? 'A nova senha precisa ter ao menos 8 caracteres.' : 'A senha precisa ter ao menos 8 caracteres.'); ok = false; }
      else if (bytes(s) > 72) { erroCampo(nova.closest('.cv-campo'), 'Use no máximo 72 caracteres.'); ok = false; }
      else if (atual && s === atual.value) { erroCampo(nova.closest('.cv-campo'), 'A nova senha precisa ser diferente da atual.'); ok = false; }
      if (ok && conf.value !== s) { erroCampo(conf.closest('.cv-campo'), 'As duas senhas não são iguais.'); ok = false; }
      if (!ok) { e.preventDefault(); var inv = $('[aria-invalid="true"]', f); if (inv) inv.focus(); vibrar([12, 40, 12]); return; }
      ocupado(btn, true);
    });
  }
  var fc = $('form[data-acesso="criar"]');
  if (fc) senhaNova(fc, fc.senha, fc.confirmar, null);
  var ft = $('form[data-acesso="trocar"]');
  if (ft) senhaNova(ft, ft.novaSenha, ft.confirmar, ft.senhaAtual);

  /* ---- Teclado aberto (celular): o objeto encolhe e o botão fica à vista -- */
  function medirTeclado() {
    var vv = window.visualViewport, h = vv ? vv.height : innerHeight;
    doc.documentElement.style.setProperty('--vvh', h + 'px');
    body.classList.toggle('teclado', innerWidth < 900 && innerHeight - h > 120);
  }
  if (window.visualViewport) visualViewport.addEventListener('resize', medirTeclado);
  doc.addEventListener('focusin', function (e) {
    if (!/INPUT/.test(e.target.tagName)) return;
    setTimeout(function () { if (!body.classList.contains('teclado')) return; var f = e.target.form, b = f && f.querySelector('[type="submit"]'); (b || e.target).scrollIntoView({ block: 'end', behavior: 'auto' }); }, 60);
  });

  abertura();
})();
