// Movimento no app, rodadas 1 e 2 (movimento-app-proposta.md, Dani 2026-10-10).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ler = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('#1 transição entre páginas: view transition nativa, navbar parada, reduzir esmaece', () => {
  const css = ler('public', 'css', 'cv-telas.css');
  assert.match(css, /@view-transition \{ navigation: auto; \}/);
  assert.match(css, /\.pg-cv \.cv-navbar \{ view-transition-name: cv-navbar; \}/);
  assert.match(css, /::view-transition-new\(root\) \{ animation: 240ms var\(--ease-out\) 80ms both cvPagEntra; \}/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*::view-transition-old\(root\) \{ animation: 150ms/);
  assert.match(ler('src', 'views', 'layouts', 'painel.ejs'), /cv-telas\.css/);
});

test('#2 cascata: até 8 itens visíveis, 1 vez por sessão por tela, interrompível, reduzir esmaece', () => {
  const js = ler('public', 'js', 'cv-vida.js');
  assert.match(ler('src', 'views', 'layouts', 'painel.ejs'), /cv-movimento\.js[^\n]*\n\s*<script src="\/js\/cv-vida\.js/);
  assert.match(js, /itens\.length >= 8/);
  assert.match(js, /primeiraVez\('cvCascata:' \+ caminho\(\)\)/);
  assert.match(js, /Math\.min\(i \* 30, 240\)/);
  assert.match(js, /addEventListener\('pointerdown', terminarTudo/);
  assert.match(js, /rd \? \[\{ opacity: 0 \}, \{ opacity: 1 \}\]/);
  assert.doesNotMatch(js, /(width|height|top|left|margin)\s*:\s*['"]?\d/); // nada de animar layout
});
