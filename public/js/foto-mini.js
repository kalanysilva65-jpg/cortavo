// Miniatura QUADRADA da foto do serviço (redesign v3, agenda pública).
//
// O servidor não tem biblioteca de imagem, então o recorte é feito aqui: ao
// escolher a foto num <input type="file" data-foto-mini>, gera uma versão
// 240x240 (WEBP; JPEG quando o navegador não sabe gerar WEBP, caso de alguns
// iPhones) e a coloca num campo `fotoMini` do mesmo formulário. O servidor
// confere os bytes, o tamanho (até 200 KB) e se é quadrada antes de guardar.
//
// Recorte: centro da foto, ou o ponto focal em `data-foco="50% 30%"` (a
// "moldura do recorte" da tela pode atualizar esse atributo e chamar
// window.cvFotoMini.gerar(input) para refazer a miniatura).
// Para usar: <input type="file" name="foto" accept="image/*" data-foto-mini>
// e <script src="/js/foto-mini.js" defer></script> depois de foto-comprimir.js.
(function () {
  var LADO = 240;

  function carregar(arquivo) {
    if (window.createImageBitmap) {
      return createImageBitmap(arquivo, { imageOrientation: 'from-image' }).catch(function () { return viaImg(arquivo); });
    }
    return viaImg(arquivo);
  }
  function viaImg(arquivo) {
    return new Promise(function (ok, erro) {
      var url = URL.createObjectURL(arquivo);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); ok(img); };
      img.onerror = function () { URL.revokeObjectURL(url); erro(new Error('decode')); };
      img.src = url;
    });
  }
  function foco(input) {
    var m = String(input.getAttribute('data-foco') || '50% 50%').match(/(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
    return m ? [Math.min(100, +m[1]) / 100, Math.min(100, +m[2]) / 100] : [0.5, 0.5];
  }
  function blob(canvas, tipo, q) {
    return new Promise(function (ok) { canvas.toBlob(ok, tipo, q); });
  }

  function gerar(input) {
    var arq = input.files && input.files[0];
    if (!arq) return Promise.resolve(null);
    return carregar(arq).then(function (img) {
      var w = img.width, h = img.height, lado = Math.min(w, h);
      var f = foco(input);
      var sx = Math.round((w - lado) * f[0]), sy = Math.round((h - lado) * f[1]);
      var c = document.createElement('canvas');
      c.width = LADO; c.height = LADO;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, LADO, LADO);
      ctx.drawImage(img, sx, sy, lado, lado, 0, 0, LADO, LADO);
      if (img.close) img.close();
      return blob(c, 'image/webp', 0.8).then(function (b) {
        if (b && b.type === 'image/webp') return { b: b, nome: 'mini.webp', tipo: 'image/webp' };
        return blob(c, 'image/jpeg', 0.82).then(function (j) { return j ? { b: j, nome: 'mini.jpg', tipo: 'image/jpeg' } : null; });
      });
    }).then(function (r) {
      if (!r || !input.form) return null;
      var campo = input.form.querySelector('input[type="file"][name="fotoMini"]');
      if (!campo) {
        campo = document.createElement('input');
        campo.type = 'file';
        campo.name = 'fotoMini';
        campo.hidden = true;
        input.form.appendChild(campo);
      }
      var dt = new DataTransfer();
      dt.items.add(new File([r.b], r.nome, { type: r.tipo, lastModified: Date.now() }));
      campo.files = dt.files;
      return campo;
    }).catch(function () { return null; }); // sem miniatura, a foto grande segue valendo
  }

  document.addEventListener('change', function (e) {
    var input = e.target;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'file' || !input.hasAttribute('data-foto-mini')) return;
    gerar(input);
  });

  window.cvFotoMini = { gerar: gerar };
})();
