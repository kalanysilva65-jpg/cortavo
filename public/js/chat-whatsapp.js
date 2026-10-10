// Chat da conversa aberta — "clone do WhatsApp" (pedido do dono, 2026-09-30).
// Renderiza os balões (texto, foto, vídeo, áudio, documento, figurinha,
// localização, contato), os tiques (enviada/entregue/lida), envia texto sem
// recarregar, anexa arquivo com prévia + legenda e grava áudio.
(function () {
  var thread = document.getElementById('cv-thread');
  var dadosEl = document.getElementById('cv-dados');
  if (!thread || !dadosEl) return;
  var convId = thread.getAttribute('data-id');
  var mensagens = [];
  try { mensagens = JSON.parse(dadosEl.textContent || '[]'); } catch (e) {}

  var ROTULO = { imagem: 'Foto', video: 'Vídeo', audio: 'Áudio', documento: 'Documento', figurinha: 'Figurinha', localizacao: 'Localização', contato: 'Contato' }; // v3: sem emoji

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // Tiques: ✓ enviada, ✓✓ entregue, ✓✓ azul lida, ! falhou, relógio sem status.
  function tiques(status) {
    var s = el('span', 'cv-tique cv-tique--' + (status || 'pendente'));
    if (status === 'falhou') { s.textContent = '!'; s.title = 'Não entregue'; return s; }
    if (!status) { s.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'; return s; }
    var duplo = status === 'entregue' || status === 'lida';
    s.innerHTML = duplo
      ? '<svg width="17" height="11" viewBox="0 0 17 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6l3.2 3.2L11 2.2"/><path d="M6.5 9.2 7.5 10 15.5 1.5"/></svg>'
      : '<svg width="12" height="11" viewBox="0 0 12 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6l3.2 3.2L11 2.2"/></svg>';
    s.title = status === 'lida' ? 'Lida' : status === 'entregue' ? 'Entregue' : 'Enviada';
    return s;
  }

  // Deixa links clicáveis no texto (sem innerHTML com conteúdo do cliente).
  function textoComLinks(pai, texto) {
    var partes = String(texto).split(/(https?:\/\/[^\s]+)/g);
    partes.forEach(function (p) {
      if (/^https?:\/\//.test(p)) {
        var a = el('a', 'cv-link', p);
        a.href = p; a.target = '_blank'; a.rel = 'noopener';
        pai.appendChild(a);
      } else if (p) {
        pai.appendChild(document.createTextNode(p));
      }
    });
  }

  function corpoMidia(m) {
    var box = el('div', 'cv-midia cv-midia--' + m.tipo);
    if (!m.midia && m.tipo !== 'localizacao' && m.tipo !== 'contato') {
      box.appendChild(el('span', 'cv-midia-falta', (ROTULO[m.tipo] || 'Arquivo') + ' (indisponível)'));
      return box;
    }
    if (m.tipo === 'imagem' || m.tipo === 'figurinha') {
      var img = el('img');
      img.src = m.midia; img.loading = 'lazy'; img.alt = ROTULO[m.tipo];
      img.addEventListener('click', function () { abrirVisualizador(m.midia); });
      box.appendChild(img);
    } else if (m.tipo === 'video') {
      var v = el('video'); v.src = m.midia; v.controls = true; v.preload = 'metadata'; v.playsInline = true;
      box.appendChild(v);
    } else if (m.tipo === 'audio') {
      var au = el('audio'); au.src = m.midia; au.controls = true; au.preload = 'metadata';
      box.appendChild(au);
    } else if (m.tipo === 'documento') {
      var a = el('a', 'cv-doc');
      a.href = m.midia; a.target = '_blank'; a.rel = 'noopener';
      a.appendChild(el('span', 'cv-doc-ic', 'PDF'));
      a.appendChild(el('span', 'cv-doc-nome', m.midiaNome || 'Documento'));
      box.appendChild(a);
    }
    return box;
  }

  function balao(m) {
    var saida = m.autor !== 'cliente';
    var b = el('div', 'cv-msg cv-msg--' + (saida ? 'out' : 'in') + (m.tipo && m.tipo !== 'texto' ? ' cv-msg--midia' : ''));
    b.setAttribute('data-id', m.id);
    b.setAttribute('data-dia', m.dia || '');
    if (m.tipo && m.tipo !== 'texto' && m.tipo !== 'localizacao' && m.tipo !== 'contato') b.appendChild(corpoMidia(m));
    if (m.tipo === 'localizacao') b.appendChild(el('div', 'cv-rot-midia', 'Localização'));
    if (m.tipo === 'contato') b.appendChild(el('div', 'cv-rot-midia', 'Contato'));
    // Áudio: o texto é a TRANSCRIÇÃO (mostra menor, em itálico).
    if (m.texto) {
      var t = el('span', 'cv-msg-txt' + (m.tipo === 'audio' ? ' cv-msg-transcricao' : ''));
      textoComLinks(t, m.tipo === 'audio' ? '“' + m.texto + '”' : m.texto);
      b.appendChild(t);
    }
    var meta = el('span', 'cv-msg-meta');
    meta.appendChild(document.createTextNode((m.autor === 'ia' ? 'IA · ' : '') + m.hora));
    if (saida) meta.appendChild(tiques(m.status));
    b.appendChild(meta);
    return b;
  }

  function addSep(label) {
    var s = el('div', 'cv-sep');
    s.appendChild(el('span', null, label));
    thread.appendChild(s);
  }

  var ultimoDia = '';
  function adicionar(m) {
    if (thread.querySelector('.cv-msg[data-id="' + m.id + '"]')) return;
    var label = m.sep || (m.dia !== ultimoDia ? m.diaLabel : null);
    if (label && m.dia !== ultimoDia) addSep(label);
    if (m.dia) ultimoDia = m.dia;
    thread.appendChild(balao(m));
  }

  mensagens.forEach(adicionar);
  function irAoFim() { window.scrollTo(0, document.body.scrollHeight); }
  irAoFim();
  // Fotos carregam depois: segura no fim enquanto elas chegam.
  thread.querySelectorAll('img').forEach(function (i) { i.addEventListener('load', function () { if (pertoDoFim()) irAoFim(); }); });

  function pertoDoFim() { return (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 220; }
  function ultimoId() {
    var ms = thread.querySelectorAll('.cv-msg[data-id]');
    return ms.length ? Number(ms[ms.length - 1].getAttribute('data-id')) || 0 : 0;
  }

  // Visualizador de foto em tela cheia.
  function abrirVisualizador(src) {
    var v = el('div', 'cv-visu');
    var img = el('img'); img.src = src;
    v.appendChild(img);
    v.addEventListener('click', function () { v.remove(); });
    document.body.appendChild(v);
  }

  // --- Polling: mensagens novas + tiques + janela de 24h ---
  var janela = document.getElementById('cv-janela');
  async function atualizar() {
    if (document.hidden) return;
    try {
      var r = await fetch('/painel/conversas/' + convId + '/novas?apos=' + ultimoId(), { headers: { 'X-Requested-With': 'fetch' } });
      if (!r.ok || r.redirected) return;
      var d = await r.json();
      var perto = pertoDoFim();
      (d.mensagens || []).forEach(adicionar);
      Object.keys(d.status || {}).forEach(function (id) {
        var b = thread.querySelector('.cv-msg[data-id="' + id + '"] .cv-tique');
        if (b && !b.classList.contains('cv-tique--' + (d.status[id] || 'pendente'))) b.replaceWith(tiques(d.status[id]));
      });
      if (janela && typeof d.janelaAberta === 'boolean') janela.hidden = d.janelaAberta;
      if (perto && (d.mensagens || []).length) irAoFim();
    } catch (e) {}
  }
  setInterval(atualizar, 3000);

  // --- Envio de texto sem recarregar ---
  var form = document.getElementById('cv-form');
  var campo = document.getElementById('cv-texto');
  var btnEnviar = document.getElementById('cv-enviar');
  var btnMic = document.getElementById('cv-mic');
  function alternarBotao() {
    var tem = !!campo.value.trim();
    btnEnviar.hidden = !tem;
    btnMic.hidden = tem;
  }
  campo.addEventListener('input', alternarBotao);
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var texto = campo.value.trim();
    if (!texto) return;
    campo.value = '';
    alternarBotao();
    var corpo = new URLSearchParams(); corpo.append('texto', texto);
    try {
      await fetch(form.action, { method: 'POST', body: corpo, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch (err) { campo.value = texto; alternarBotao(); }
    await atualizar();
    irAoFim();
    campo.focus();
  });

  async function enviarArquivo(blob, nome, legenda) {
    var fd = new FormData();
    fd.append('arquivo', blob, nome);
    if (legenda) fd.append('legenda', legenda);
    try {
      var r = await fetch('/painel/conversas/' + convId + '/midia', { method: 'POST', body: fd });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.ok) alert(j.erro || 'Não consegui enviar o arquivo.');
    } catch (e) { alert('Falha de conexão ao enviar o arquivo.'); }
    await atualizar();
    irAoFim();
  }

  // --- Anexo com prévia + legenda ---
  var inpArq = document.getElementById('cv-arquivo');
  var prev = document.getElementById('cv-previa');
  var prevCorpo = document.getElementById('cv-prev-corpo');
  var prevNome = document.getElementById('cv-prev-nome');
  var prevLeg = document.getElementById('cv-prev-legenda');
  var arquivoEscolhido = null;
  function fecharPrevia() { prev.hidden = true; prevCorpo.innerHTML = ''; arquivoEscolhido = null; inpArq.value = ''; prevLeg.value = ''; }
  inpArq.addEventListener('change', function () {
    var f = inpArq.files && inpArq.files[0];
    if (!f) return;
    if (f.size > 16 * 1024 * 1024) { alert('Arquivo maior que 16 MB.'); inpArq.value = ''; return; }
    arquivoEscolhido = f;
    prevNome.textContent = f.name;
    prevCorpo.innerHTML = '';
    var url = URL.createObjectURL(f);
    if (f.type.indexOf('image/') === 0) { var i = el('img'); i.src = url; prevCorpo.appendChild(i); }
    else if (f.type.indexOf('video/') === 0) { var v = el('video'); v.src = url; v.controls = true; prevCorpo.appendChild(v); }
    else if (f.type.indexOf('audio/') === 0) { var a = el('audio'); a.src = url; a.controls = true; prevCorpo.appendChild(a); }
    else prevCorpo.appendChild(el('div', 'cv-prev-doc', 'Arquivo: ' + f.name));
    prevLeg.hidden = f.type.indexOf('audio/') === 0;
    prev.hidden = false;
  });
  document.getElementById('cv-prev-fechar').addEventListener('click', fecharPrevia);
  document.getElementById('cv-prev-enviar').addEventListener('click', function () {
    if (!arquivoEscolhido) return;
    var f = arquivoEscolhido, leg = prevLeg.value.trim();
    fecharPrevia();
    enviarArquivo(f, f.name, leg);
  });

  // --- Gravação de áudio ---
  // A Meta aceita ogg/opus, mp4/aac, mpeg e amr (NÃO aceita webm). Usa o
  // primeiro formato aceito que o navegador sabe gravar.
  var FORMATOS = ['audio/ogg;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/mpeg'];
  function formatoGravacao() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
    for (var i = 0; i < FORMATOS.length; i++) if (MediaRecorder.isTypeSupported(FORMATOS[i])) return FORMATOS[i];
    return null;
  }
  var barraGrav = document.getElementById('cv-gravando');
  var tempoEl = document.getElementById('cv-grav-tempo');
  var rec = null, pedacos = [], inicio = 0, relogio = null, cancelado = false, stream = null;
  btnMic.addEventListener('click', async function () {
    var fmt = formatoGravacao();
    if (!fmt) { alert('Este navegador não grava áudio num formato aceito pelo WhatsApp. Use o app no celular ou anexe um arquivo de áudio.'); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { alert('Permita o uso do microfone para gravar áudio.'); return; }
    pedacos = []; cancelado = false;
    rec = new MediaRecorder(stream, { mimeType: fmt });
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) pedacos.push(ev.data); };
    rec.onstop = function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      clearInterval(relogio);
      barraGrav.hidden = true;
      if (cancelado || !pedacos.length) return;
      var tipo = fmt.split(';')[0];
      var ext = tipo === 'audio/ogg' ? 'ogg' : tipo === 'audio/mpeg' ? 'mp3' : 'm4a';
      enviarArquivo(new Blob(pedacos, { type: tipo }), 'audio-' + Date.now() + '.' + ext, '');
    };
    rec.start();
    inicio = Date.now();
    tempoEl.textContent = '0:00';
    relogio = setInterval(function () {
      var s = Math.floor((Date.now() - inicio) / 1000);
      tempoEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 250);
    barraGrav.hidden = false;
  });
  document.getElementById('cv-grav-cancel').addEventListener('click', function () { cancelado = true; if (rec && rec.state !== 'inactive') rec.stop(); });
  document.getElementById('cv-grav-ok').addEventListener('click', function () { if (rec && rec.state !== 'inactive') rec.stop(); });
})();
