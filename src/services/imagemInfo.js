// Lê formato e dimensões de uma imagem pelos BYTES do arquivo (sem biblioteca
// de imagem: o projeto não tem sharp/jimp e instalar dependência está fora do
// escopo). Usado para conferir a miniatura quadrada da foto do serviço que o
// navegador gera (redesign v3): a extensão e o tipo declarado vêm do cliente;
// aqui se confere o que o arquivo É.
//
// Suporta WEBP (VP8, VP8L, VP8X), JPEG (marcadores SOF) e PNG (IHDR).
// Devolve { formato: 'webp'|'jpeg'|'png', largura, altura } ou null.
function lerDimensoes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;

  // PNG: assinatura de 8 bytes + IHDR (largura/altura big-endian).
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { formato: 'png', largura: buf.readUInt32BE(16), altura: buf.readUInt32BE(20) };
  }

  // WEBP: "RIFF" .... "WEBP" + chunk.
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      // Quadro-chave: 3 bytes de tag + 9D 01 2A + 14 bits de largura/altura.
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
      return { formato: 'webp', largura: buf.readUInt16LE(26) & 0x3fff, altura: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      if (buf[20] !== 0x2f) return null;
      const b = buf.readUInt32LE(21);
      return { formato: 'webp', largura: (b & 0x3fff) + 1, altura: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const largura = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const altura = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { formato: 'webp', largura, altura };
    }
    return null;
  }

  // JPEG: FF D8, depois percorre os segmentos até um SOF (C0..CF, menos C4/C8/CC).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marca = buf[i + 1];
      if (marca === 0xd8 || (marca >= 0xd0 && marca <= 0xd7) || marca === 0x01) { i += 2; continue; }
      const tam = buf.readUInt16BE(i + 2);
      if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc) {
        return { formato: 'jpeg', altura: buf.readUInt16BE(i + 5), largura: buf.readUInt16BE(i + 7) };
      }
      if (tam < 2) return null;
      i += 2 + tam;
    }
    return null;
  }
  return null;
}

module.exports = { lerDimensoes };
