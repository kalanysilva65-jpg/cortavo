// Conferência do src/services/qr.js (Beto, 2026-10-10). A decodificação real
// foi feita fora da suíte (OpenCV, versões 1 a 10, até 213 bytes, UTF-8: 15 de
// 15 lidos certo; ver relatório). Aqui ficam as propriedades estruturais.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar } = require('./helpers/ambiente');
const QR = () => carregar('src/services/qr.js');

test('QR: tamanho = 4·versão + 17 e os três localizadores 7x7 nos cantos', () => {
  const q = QR().gerar('https://vilarosa.cortavo.com.br');
  assert.equal(q.tamanho, q.versao * 4 + 17);
  const n = q.tamanho;
  for (const [cx, cy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(q.escuro(cx + i, cy), true); assert.equal(q.escuro(cx + i, cy + 6), true);
      assert.equal(q.escuro(cx, cy + i), true); assert.equal(q.escuro(cx + 6, cy + i), true);
    }
    assert.equal(q.escuro(cx + 1, cy + 1), false);
    assert.equal(q.escuro(cx + 3, cy + 3), true);
  }
  assert.equal(q.escuro(8, n - 8), true, 'módulo escuro fixo da norma');
});

test('QR: até 213 bytes cabe (versão 10); 214 recusa com erro claro; determinístico', () => {
  const qr = QR();
  assert.equal(qr.gerar('x'.repeat(213)).versao, 10);
  assert.throws(() => qr.gerar('x'.repeat(214)), /máximo 213 bytes/);
  assert.equal(qr.svg('https://a.cortavo.com.br'), qr.svg('https://a.cortavo.com.br'));
});

test('QR: rótulo e cor escapados no SVG (aspas não quebram o atributo)', () => {
  const s = QR().svg('https://a.cortavo.com.br', { rotulo: 'QR "x" <b>', cor: '#111" onload="x' });
  assert.match(s, /aria-label="QR &quot;x&quot; &lt;b&gt;"/);
  assert.doesNotMatch(s, /onload="/);
  assert.match(QR().svg('a'), /aria-hidden="true"/);
});
