/* =========================================================================
   Cortavo v3 · qr.js (Dani Design, 2026-10-09)
   Gerador de QR code SEM biblioteca (modo byte, correção M, versões 1 a 10,
   até 213 bytes). Algoritmo da norma ISO/IEC 18004, na forma do
   "QR Code generator" de Project Nayuki (MIT), reescrito e enxugado.
   Funciona no navegador (window.QR) e no Node (module.exports), para o Beto
   gerar o SVG no servidor sem `npm install`:
     const QR = require('./qr');  QR.svg('https://vilarosa.cortavo.com.br/agendar')
   API:
     QR.gerar(texto)            -> { tamanho, escuro(x, y) }
     QR.svg(texto, {borda, cor}) -> '<svg ...>' (um <path> só, 4 módulos de margem)
     QR.canvas(ctx, texto, x, y, lado, cor)  (navegador: PNG e cartaz)
   ========================================================================= */
(function (raiz) {
  'use strict';
  var ECC_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   /* palavras de correção por bloco */
  var BLOCOS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];           /* blocos por versão */
  var FORMATO_M = 0;                                          /* bits do nível M no formato */

  function modulosBrutos(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function palavrasDados(v) { return Math.floor(modulosBrutos(v) / 8) - ECC_M[v] * BLOCOS_M[v]; }

  /* ---- Reed-Solomon em GF(256), polinômio 0x11D ---- */
  function mult(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
  function divisor(grau) {
    var r = []; for (var i = 0; i < grau; i++) r.push(0); r[grau - 1] = 1;
    var raizRS = 1;
    for (i = 0; i < grau; i++) { for (var j = 0; j < r.length; j++) { r[j] = mult(r[j], raizRS); if (j + 1 < r.length) r[j] ^= r[j + 1]; } raizRS = mult(raizRS, 0x02); }
    return r;
  }
  function resto(dados, div) {
    var r = div.map(function () { return 0; });
    dados.forEach(function (b) { var f = b ^ r.shift(); r.push(0); div.forEach(function (c, i) { r[i] ^= mult(c, f); }); });
    return r;
  }

  function utf8(texto) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(texto));
    return unescape(encodeURIComponent(texto)).split('').map(function (c) { return c.charCodeAt(0); });
  }

  function gerar(texto) {
    var bytes = utf8(texto), v;
    for (v = 1; v <= 10; v++) { var cc = v <= 9 ? 8 : 16; if (4 + cc + bytes.length * 8 <= palavrasDados(v) * 8) break; }
    if (v > 10) throw new Error('Texto longo demais para o QR (máximo 213 bytes)');
    var tam = v * 4 + 17, cap = palavrasDados(v) * 8;

    /* ---- bits de dados ---- */
    var bits = [];
    function por(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    por(4, 4); por(bytes.length, v <= 9 ? 8 : 16); bytes.forEach(function (b) { por(b, 8); });
    por(0, Math.min(4, cap - bits.length)); por(0, (8 - bits.length % 8) % 8);
    for (var p = 0xEC; bits.length < cap; p ^= 0xEC ^ 0x11) por(p, 8);
    var dados = []; for (var i = 0; i < bits.length; i += 8) { var b = 0; for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k]; dados.push(b); }

    /* ---- correção e intercalação ---- */
    var nb = BLOCOS_M[v], ecl = ECC_M[v], brutos = Math.floor(modulosBrutos(v) / 8);
    var curtos = nb - brutos % nb, lenCurto = Math.floor(brutos / nb), div = divisor(ecl), blocos = [], pos = 0;
    for (i = 0; i < nb; i++) {
      var d = dados.slice(pos, pos + lenCurto - ecl + (i < curtos ? 0 : 1)); pos += d.length;
      var e = resto(d, div); if (i < curtos) d.push(0); blocos.push(d.concat(e));
    }
    var final = [];
    for (i = 0; i < blocos[0].length; i++) for (var j = 0; j < blocos.length; j++) if (i !== lenCurto - ecl || j >= curtos) final.push(blocos[j][i]);

    /* ---- matriz ---- */
    var m = [], fn = [];
    for (i = 0; i < tam; i++) { m.push(new Array(tam).fill(false)); fn.push(new Array(tam).fill(false)); }
    function pf(x, y, esc) { m[y][x] = esc; fn[y][x] = true; }
    for (i = 0; i < tam; i++) { pf(6, i, i % 2 === 0); pf(i, 6, i % 2 === 0); }
    function localizador(x, y) { for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) { var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy; if (xx >= 0 && xx < tam && yy >= 0 && yy < tam) pf(xx, yy, dist !== 2 && dist !== 4); } }
    localizador(3, 3); localizador(tam - 4, 3); localizador(3, tam - 4);
    var al = [];
    if (v > 1) { var na = Math.floor(v / 7) + 2, passo = Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2; al = [6]; for (var q = tam - 7; al.length < na; q -= passo) al.splice(1, 0, q); }
    al.forEach(function (ay, ai) { al.forEach(function (ax, aj) {
      if ((ai === 0 && aj === 0) || (ai === 0 && aj === al.length - 1) || (ai === al.length - 1 && aj === 0)) return;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) pf(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }); });
    function formato(mask) {
      var dd = (FORMATO_M << 3) | mask, r = dd;
      for (var i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      var fb = ((dd << 10) | r) ^ 0x5412, bit = function (i) { return ((fb >>> i) & 1) !== 0; };
      for (i = 0; i <= 5; i++) pf(8, i, bit(i));
      pf(8, 7, bit(6)); pf(8, 8, bit(7)); pf(7, 8, bit(8));
      for (i = 9; i < 15; i++) pf(14 - i, 8, bit(i));
      for (i = 0; i < 8; i++) pf(tam - 1 - i, 8, bit(i));
      for (i = 8; i < 15; i++) pf(8, tam - 15 + i, bit(i));
      pf(8, tam - 8, true);
    }
    formato(0);
    if (v >= 7) {
      var rv = v; for (i = 0; i < 12; i++) rv = (rv << 1) ^ ((rv >>> 11) * 0x1F25);
      var vb = (v << 12) | rv;
      for (i = 0; i < 18; i++) { var bt = ((vb >>> i) & 1) !== 0, a = tam - 11 + i % 3, c = Math.floor(i / 3); pf(a, c, bt); pf(c, a, bt); }
    }
    /* codewords em zigue-zague */
    var n = 0;
    for (var dir = tam - 1; dir >= 1; dir -= 2) {
      if (dir === 6) dir = 5;
      for (var vert = 0; vert < tam; vert++) for (j = 0; j < 2; j++) {
        var x = dir - j, sobe = ((dir + 1) & 2) === 0, y = sobe ? tam - 1 - vert : vert;
        if (!fn[y][x] && n < final.length * 8) { m[y][x] = ((final[n >>> 3] >>> (7 - (n & 7))) & 1) !== 0; n++; }
      }
    }
    /* máscara: escolhe a de menor penalidade (regras 1, 2 e 4 da norma) */
    function inverte(mask, x, y) {
      switch (mask) {
        case 0: return (x + y) % 2 === 0; case 1: return y % 2 === 0; case 2: return x % 3 === 0; case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; case 5: return x * y % 2 + x * y % 3 === 0;
        case 6: return (x * y % 2 + x * y % 3) % 2 === 0; default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
      }
    }
    function aplicar(mask) { for (var y = 0; y < tam; y++) for (var x = 0; x < tam; x++) if (!fn[y][x] && inverte(mask, x, y)) m[y][x] = !m[y][x]; }
    function penal() {
      var p = 0, escuros = 0, x, y, run;
      for (y = 0; y < tam; y++) { run = 1; for (x = 1; x < tam; x++) { if (m[y][x] === m[y][x - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
      for (x = 0; x < tam; x++) { run = 1; for (y = 1; y < tam; y++) { if (m[y][x] === m[y - 1][x]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
      for (y = 0; y < tam - 1; y++) for (x = 0; x < tam - 1; x++) { var c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
      for (y = 0; y < tam; y++) for (x = 0; x < tam; x++) if (m[y][x]) escuros++;
      return p + Math.floor(Math.abs(escuros * 20 - tam * tam * 10) / (tam * tam)) * 10;
    }
    var melhor = 0, menor = Infinity;
    for (var mk = 0; mk < 8; mk++) { aplicar(mk); formato(mk); var pp = penal(); if (pp < menor) { menor = pp; melhor = mk; } aplicar(mk); }
    aplicar(melhor); formato(melhor);
    return { tamanho: tam, versao: v, escuro: function (x, y) { return x >= 0 && y >= 0 && x < tam && y < tam && m[y][x]; } };
  }

  function svg(texto, o) {
    o = o || {}; var q = gerar(texto), b = o.borda == null ? 4 : o.borda, t = q.tamanho + b * 2, d = '';
    for (var y = 0; y < q.tamanho; y++) for (var x = 0; x < q.tamanho; x++) if (q.escuro(x, y)) d += 'M' + (x + b) + ' ' + (y + b) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + t + ' ' + t + '" shape-rendering="crispEdges"' + (o.rotulo ? ' role="img" aria-label="' + o.rotulo + '"' : ' aria-hidden="true"') + '>' +
      (o.fundo === false ? '' : '<rect width="' + t + '" height="' + t + '" fill="#fff"/>') + '<path fill="' + (o.cor || '#111') + '" d="' + d + '"/></svg>';
  }

  function canvas(ctx, texto, x0, y0, lado, cor) {
    var q = gerar(texto), b = 4, t = q.tamanho + b * 2, u = lado / t;
    ctx.fillStyle = '#fff'; ctx.fillRect(x0, y0, lado, lado); ctx.fillStyle = cor || '#111';
    for (var y = 0; y < q.tamanho; y++) for (var x = 0; x < q.tamanho; x++) if (q.escuro(x, y)) ctx.fillRect(Math.floor(x0 + (x + b) * u), Math.floor(y0 + (y + b) * u), Math.ceil(u), Math.ceil(u));
  }

  var QR = { gerar: gerar, svg: svg, canvas: canvas };
  if (typeof module !== 'undefined' && module.exports) module.exports = QR; else raiz.QR = QR;
})(typeof window !== 'undefined' ? window : this);
