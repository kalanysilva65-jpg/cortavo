/* Cortavo v3 · Link de agendamento (Dani, redesign/v3/acesso/mockups/link.js).
   Copiar o link (botões [data-copiar-url] são tratados no cv-casca.js),
   mensagem pronta editável, compartilhar (folha nativa no celular; WhatsApp
   Web no PC), PNG do QR (1024 px) e PNG do cartaz A5 (874 x 1240, 150 ppp).
   O texto editado é salvo na barbearia (textoLink, POST /painel/link/texto),
   e copiar/compartilhar marca o passo 4 dos Primeiros passos
   (POST /painel/primeiros-passos, acao=link). */
(function () {
  'use strict';
  var doc = document, C = window.Cortavo;
  function $(s, c) { return (c || doc).querySelector(s); }
  function aviso(o) { if (C && C.aviso) C.aviso(o); }
  var base = $('[data-link]');
  if (!base) return;
  var D = { url: base.dataset.link, curto: base.dataset.curto, slug: base.dataset.slug, padrao: base.dataset.textoPadrao || '' };

  /* ---- Mensagem pronta --------------------------------------------------- */
  var tx = $('#lk-texto'), CHAVE = 'cvLinkTexto:' + D.slug, espera = null;
  function postar(url, dados) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }).catch(function () {});
  }
  function guardado() { try { return localStorage.getItem(CHAVE); } catch (e) { return null; } }
  /* Salva no servidor (meio segundo depois de parar de digitar). O texto antigo
     que ficou no aparelho sobe uma vez e sai do localStorage. */
  function guardar(v) {
    clearTimeout(espera);
    espera = setTimeout(function () { postar('/painel/link/texto', { texto: v }); }, 600);
    try { localStorage.removeItem(CHAVE); } catch (e) {}
  }
  function marcarLink() { postar('/painel/primeiros-passos', { acao: 'link' }); }
  function textoFinal() { var t = tx.value.trim(); return t.indexOf(D.url) >= 0 || t.indexOf(D.curto) >= 0 ? t : (t ? t + '\n' : '') + D.url; }
  if (tx) {
    var g = guardado(); if (g && tx.value === D.padrao) { tx.value = g; guardar(g); }
    tx.addEventListener('input', function () { guardar(tx.value); });
    $('#lk-restaurar').addEventListener('click', function () { tx.value = D.padrao; guardar(D.padrao); aviso({ titulo: 'Texto restaurado' }); });
    var copiarTexto = $('[data-copiar="texto"]');
    if (copiarTexto) copiarTexto.addEventListener('click', function () {
      window.cvCopiar(textoFinal()).then(function () { marcarLink(); aviso({ titulo: 'Texto copiado', sub: 'Cole na conversa do WhatsApp.' }); });
    });
    var podeNativo = !!navigator.share && matchMedia('(pointer: coarse)').matches;
    var bc = $('#lk-compartilhar');
    if (!podeNativo) $('.rot-b', bc).textContent = 'Enviar pelo WhatsApp Web';
    bc.addEventListener('click', function () {
      var t = textoFinal();
      marcarLink();
      if (podeNativo) { navigator.share({ text: t }).catch(function () {}); return; }
      // wa.me sem número: o WhatsApp abre com o texto pronto e o dono escolhe a conversa.
      window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank', 'noopener');
    });
  }

  /* ---- PNG do QR e do cartaz -------------------------------------------- */
  function baixar(canvas, nome) { var a = doc.createElement('a'); a.download = nome; a.href = canvas.toDataURL('image/png'); doc.body.appendChild(a); a.click(); a.remove(); }
  var bp = $('#lk-png');
  if (bp && window.QR) bp.addEventListener('click', function () {
    var c = doc.createElement('canvas'); c.width = c.height = 1024; QR.canvas(c.getContext('2d'), D.url, 0, 0, 1024);
    baixar(c, 'qr-' + D.slug + '.png'); aviso({ titulo: 'QR code baixado', sub: 'qr-' + D.slug + '.png' });
  });
  function quebrar(ctx, txt, larg) { var p = txt.split(' '), l = [], a = ''; p.forEach(function (w) { var t = a ? a + ' ' + w : w; if (ctx.measureText(t).width > larg && a) { l.push(a); a = w; } else a = t; }); if (a) l.push(a); return l; }
  var bz = $('#lk-cartaz-png'), cz = $('#lk-cartaz');
  if (bz && cz && window.QR) bz.addEventListener('click', function () {
    var W = 874, H = 1240, u = W / 350, c = doc.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d'), F = '"Plus Jakarta Sans", sans-serif', nome = cz.dataset.nome, ini = cz.dataset.inicial;
    var desenhar = function (img) {
      x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.textAlign = 'center'; x.fillStyle = '#111';
      var y = 30 * u, r = 32 * u;
      if (img) { x.drawImage(img, W / 2 - r, y, 2 * r, 2 * r); }
      else { x.beginPath(); x.arc(W / 2, y + r, r, 0, Math.PI * 2); x.fill(); x.fillStyle = '#fff'; x.font = '800 ' + 28 * u + 'px ' + F; x.fillText(ini, W / 2, y + r + 10 * u); }
      x.fillStyle = '#111'; x.font = '800 ' + 15 * u + 'px ' + F; y += 64 * u + 26 * u;
      quebrar(x, nome, 260 * u).slice(0, 3).forEach(function (l) { x.fillText(l, W / 2, y); y += 19 * u; });
      x.font = '800 ' + 30 * u + 'px ' + F; y += 22 * u;
      quebrar(x, 'Agende seu horário pelo celular', 200 * u).forEach(function (l) { x.fillText(l, W / 2, y); y += 31 * u; });
      y += 4 * u; QR.canvas(x, D.url, (W - 156 * u) / 2, y - 14 * u, 156 * u); y += 156 * u;
      x.fillStyle = '#3D3D3D'; x.font = '600 ' + 10.5 * u + 'px ' + F; x.fillText('Aponte a câmera para o código', W / 2, y + 2 * u);
      x.font = '800 ' + 13 * u + 'px ' + F; x.fillStyle = '#111'; x.fillText(D.curto, W / 2, y + 24 * u, W - 40 * u);
      var ly = H - 34 * u; x.save(); x.beginPath(); x.rect(0, ly, W, 10 * u); x.clip(); var cores = ['#111', '#fff', '#9A9A9A', '#fff'];
      for (var i = -40; i < W / (5 * u) + 40; i++) { x.fillStyle = cores[((i % 4) + 4) % 4]; x.beginPath(); var bx = i * 5 * u * Math.SQRT2; x.moveTo(bx, ly + 10 * u); x.lineTo(bx + 10 * u, ly); x.lineTo(bx + 10 * u + 5 * u * Math.SQRT2, ly); x.lineTo(bx + 5 * u * Math.SQRT2, ly + 10 * u); x.fill(); }
      x.restore(); x.fillStyle = '#666'; x.font = '600 ' + 8.5 * u + 'px ' + F; x.fillText('feito com Cortavo', W / 2, H - 12 * u);
      baixar(c, 'cartaz-a5-' + D.slug + '.png'); aviso({ titulo: 'Cartaz baixado', sub: 'Pronto para imprimir em A5.' });
    };
    if (cz.dataset.logo) { var im = new Image(); im.onload = function () { desenhar(im); }; im.onerror = function () { desenhar(null); }; im.src = cz.dataset.logo; }
    else desenhar(null);
  });
})();
