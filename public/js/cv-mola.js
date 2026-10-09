/* =========================================================================
   Cortavo v3 · mola.js (Dani Design, 2026-10-06)
   Molas no estilo Apple (resposta + amortecimento) viradas em CSS linear(),
   para usar com WAAPI (element.animate) ou transition. Sem biblioteca.

   mola({ resposta: .38, amortecimento: .86, velocidade: 0 })
     -> { easing: 'linear(...)', duracao: 512 }   // duração sai da física
   Física (massa 1): rigidez k = (2π/resposta)², atrito c = 4π·ζ/resposta.
   velocidade = velocidade inicial RELATIVA (px/s ÷ distância restante),
   para herdar a velocidade do dedo ao soltar uma folha (apple-design §5).

   As 5 molas do Cortavo (valores finais, ver motion-spec.md):
     MOLAS.padrao   resp .40 amort 1    (nada pula: dinheiro e dados)
     MOLAS.folha    resp .38 amort .86  (M4 abrir; só um assentar)
     MOLAS.arremesso resp .34 amort .80 (M4 quando o dedo arremessou)
     MOLAS.lente    resp .30 amort .92  (M5 lente da navbar)
     MOLAS.selo     resp .50 amort .82  (M1 selo do C crescendo)
   ========================================================================= */
(function (g) {
  'use strict';
  var cache = {};

  function mola(o) {
    o = o || {};
    var resp = o.resposta || 0.4;
    var zeta = o.amortecimento == null ? 1 : o.amortecimento;
    var v0 = o.velocidade || 0;
    var chave = resp + '|' + zeta + '|' + v0.toFixed(2);
    if (cache[chave]) return cache[chave];

    var k = Math.pow(2 * Math.PI / resp, 2), c = 4 * Math.PI * zeta / resp;
    var x = 0, v = v0, dt = 1 / 600, t = 0, pts = [[0, 0]], parado = 0;
    while (t < 3) {
      var a = -k * (x - 1) - c * v; v += a * dt; x += v * dt; t += dt;
      pts.push([t, x]);
      if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) { if (++parado > 30) break; } else parado = 0;
    }
    var dur = t, n = 48, out = [];
    for (var i = 1; i <= n; i++) {
      var p = pts[Math.min(pts.length - 1, Math.round((dur * i / n) / dt))];
      out.push((+p[1].toFixed(4)) + ' ' + (i * 100 / n).toFixed(1) + '%');
    }
    out[out.length - 1] = '1 100%';
    return (cache[chave] = { easing: 'linear(0, ' + out.join(', ') + ')', duracao: Math.round(dur * 1000) });
  }

  /* Projeção de momento da Apple (Designing Fluid Interfaces, WWDC18) */
  function projetar(velocidadePxS, desaceleracao) {
    var d = desaceleracao || 0.998;
    return (velocidadePxS / 1000) * d / (1 - d);
  }

  /* Rubber-band: quanto mais passa do limite, menos acompanha */
  function elastico(passou, dimensao, constante) {
    var c = constante || 0.55;
    return (passou * dimensao * c) / (dimensao + c * Math.abs(passou));
  }

  function reduzMovimento() {
    return !!(g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  g.Mola = {
    mola: mola, projetar: projetar, elastico: elastico, reduzMovimento: reduzMovimento,
    MOLAS: {
      padrao:    { resposta: 0.40, amortecimento: 1 },
      folha:     { resposta: 0.38, amortecimento: 0.86 },
      arremesso: { resposta: 0.34, amortecimento: 0.80 },
      lente:     { resposta: 0.30, amortecimento: 0.92 },
      selo:      { resposta: 0.50, amortecimento: 0.82 }
    }
  };
  g.mola = mola; /* compatível com movimento/demos */
})(window);
