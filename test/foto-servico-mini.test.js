// Foto do serviço: miniatura quadrada leve (redesign v3). O recorte é feito no
// navegador; o servidor confere os BYTES (formato real, tamanho, quadrada) e
// apaga junto com a foto. Arquivos só numa pasta temporária do teste.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');
const { criarBanco } = require('./helpers/bancoMemoria');

// --- imagens mínimas montadas byte a byte (só o cabeçalho que importa) ---
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function webpVP8X(w, h) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}
function webpVP8L(w, h) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}
function jpeg(w, h) {
  // SOI + APP0 curto + SOF0
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
}

test('imagemInfo lê formato e dimensões de PNG, WEBP (VP8X e VP8L) e JPEG pelos bytes', () => {
  const { lerDimensoes } = carregar('src/services/imagemInfo.js');
  assert.deepEqual(lerDimensoes(png(240, 240)), { formato: 'png', largura: 240, altura: 240 });
  assert.deepEqual(lerDimensoes(webpVP8X(240, 240)), { formato: 'webp', largura: 240, altura: 240 });
  assert.deepEqual(lerDimensoes(webpVP8L(240, 200)), { formato: 'webp', largura: 240, altura: 200 });
  assert.deepEqual(lerDimensoes(jpeg(240, 240)), { formato: 'jpeg', largura: 240, altura: 240 });
  assert.equal(lerDimensoes(Buffer.from('<html><script>alert(1)</script></html>          ')), null);
  assert.equal(lerDimensoes(null), null);
});

function ambiente() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-fotos-'));
  const paths = {
    uploadsDir: pasta,
    caminhoDoUpload: (url) => (url && url.startsWith('/uploads/') ? path.join(pasta, path.basename(url)) : null),
  };
  const banco = criarBanco({ servico: [], servicoPrecoBarbeiro: [], servicoInsumo: [], usuario: [] });
  const ctrl = carregar('src/controllers/servicoController.js', {
    prisma: banco,
    stubs: {
      'src/config/paths.js': paths,
      'src/services/precos.js': { salvarPrecosDoForm: async () => {} },
    },
  });
  const gravar = (nome, buf) => {
    fs.writeFileSync(path.join(pasta, nome), buf);
    return { filename: nome };
  };
  const existe = (nome) => fs.existsSync(path.join(pasta, nome));
  return { pasta, banco, ctrl, gravar, existe };
}
const espera = () => new Promise((r) => setTimeout(r, 30)); // fs.unlink é assíncrono

test('Criar serviço com foto + miniatura válida (240x240 WEBP): guarda as duas', async () => {
  const a = ambiente();
  const req = reqFalso({ barbeariaId: 1, body: { nome: 'Corte', valor: '50' }, file: a.gravar('foto-1.jpg', jpeg(1600, 1200)), fileMini: a.gravar('foto-2.webp', webpVP8X(240, 240)) });
  await a.ctrl.criar(req, resFalso());
  const s = a.banco._tabelas.servico[0];
  assert.equal(s.fotoUrl, '/uploads/foto-1.jpg');
  assert.equal(s.fotoMiniUrl, '/uploads/foto-2.webp');
});

test('Miniatura inválida é descartada e apagada (não quadrada, grande demais, formato mentiroso)', async () => {
  for (const [nome, buf] of [
    ['foto-3.webp', webpVP8X(240, 180)],
    ['foto-4.webp', webpVP8X(1200, 1200)],
    ['foto-5.webp', png(240, 240)], // PNG com extensão .webp
    ['foto-6.jpg', Buffer.concat([jpeg(240, 240), Buffer.alloc(210 * 1024)])],
  ]) {
    const a = ambiente();
    const req = reqFalso({ barbeariaId: 1, body: { nome: 'Corte', valor: '50' }, file: a.gravar('foto-1.jpg', jpeg(1600, 1200)), fileMini: a.gravar(nome, buf) });
    await a.ctrl.criar(req, resFalso());
    await espera();
    assert.equal(a.banco._tabelas.servico[0].fotoMiniUrl, null, nome);
    assert.equal(a.existe(nome), false, nome + ' apagado');
    assert.equal(a.existe('foto-1.jpg'), true, 'a foto grande continua');
  }
});

test('Trocar a foto apaga a antiga e a miniatura antiga; só o recorte novo troca só a miniatura', async () => {
  const a = ambiente();
  a.gravar('velha.jpg', jpeg(1600, 1200));
  a.gravar('velha-mini.webp', webpVP8X(240, 240));
  a.banco._tabelas.servico.push({ id: 1, barbeariaId: 1, nome: 'Corte', valor: 5000, ehProduto: false, fotoUrl: '/uploads/velha.jpg', fotoMiniUrl: '/uploads/velha-mini.webp' });
  const body = { nome: 'Corte', valor: '50' };
  // Só um recorte novo.
  await a.ctrl.atualizar(reqFalso({ barbeariaId: 1, params: { id: '1' }, body, fileMini: a.gravar('recorte.webp', webpVP8L(240, 240)) }), resFalso());
  await espera();
  let s = a.banco._tabelas.servico[0];
  assert.equal(s.fotoUrl, '/uploads/velha.jpg');
  assert.equal(s.fotoMiniUrl, '/uploads/recorte.webp');
  assert.equal(a.existe('velha-mini.webp'), false);
  // Foto nova sem miniatura: a antiga e o recorte saem, mini fica nula.
  await a.ctrl.atualizar(reqFalso({ barbeariaId: 1, params: { id: '1' }, body, file: a.gravar('nova.jpg', jpeg(800, 800)) }), resFalso());
  await espera();
  s = a.banco._tabelas.servico[0];
  assert.equal(s.fotoUrl, '/uploads/nova.jpg');
  assert.equal(s.fotoMiniUrl, null);
  assert.equal(a.existe('velha.jpg'), false);
  assert.equal(a.existe('recorte.webp'), false);
});

test('Remover foto e excluir o serviço apagam também a miniatura', async () => {
  const a = ambiente();
  a.gravar('f.jpg', jpeg(800, 800));
  a.gravar('m.webp', webpVP8X(240, 240));
  a.banco._tabelas.servico.push({ id: 1, barbeariaId: 1, nome: 'Corte', valor: 5000, ehProduto: false, fotoUrl: '/uploads/f.jpg', fotoMiniUrl: '/uploads/m.webp' });
  await a.ctrl.removerFoto(reqFalso({ barbeariaId: 1, params: { id: '1' } }), resFalso());
  await espera();
  assert.equal(a.existe('f.jpg'), false);
  assert.equal(a.existe('m.webp'), false);
  assert.deepEqual([a.banco._tabelas.servico[0].fotoUrl, a.banco._tabelas.servico[0].fotoMiniUrl], [null, null]);

  const b = ambiente();
  b.gravar('f2.jpg', jpeg(800, 800));
  b.gravar('m2.webp', webpVP8X(240, 240));
  b.banco._tabelas.servico.push({ id: 1, barbeariaId: 1, nome: 'Corte', valor: 5000, ehProduto: false, fotoUrl: '/uploads/f2.jpg', fotoMiniUrl: '/uploads/m2.webp' });
  await b.ctrl.remover(reqFalso({ barbeariaId: 1, params: { id: '1' } }), resFalso());
  await espera();
  assert.equal(b.existe('m2.webp'), false);
});

test('Rota de serviços aceita foto + fotoMini; envio continua só admin; migração só adiciona coluna', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(src, /upload\.fields\(\[\{ name: 'foto', maxCount: 1 \}, \{ name: 'fotoMini', maxCount: 1 \}\]\)/);
  assert.match(src, /router\.post\('\/servicos', exigeAdmin, uploadFoto, servicoController\.criar\)/);
  assert.match(src, /router\.post\('\/servicos\/:id', exigeAdmin, uploadFoto, servicoController\.atualizar\)/);
  const sql = fs.readFileSync(path.join(RAIZ, 'prisma/migrations/20261009140000_servico_foto_mini/migration.sql'), 'utf8');
  assert.match(sql, /^ALTER TABLE "servicos" ADD COLUMN "foto_mini_url" TEXT;$/m);
  assert.match(sql, /serviço PARADO/);
});
