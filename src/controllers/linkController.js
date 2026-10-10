// Link de agendamento (redesign v3, telas da Dani em redesign/v3/acesso):
// o endereço por subdomínio, copiar, compartilhar, QR para o balcão e o
// cartaz A5. O QR sai no servidor, sem biblioteca nova (services/qr.js).
const QR = require('../services/qr');
const prisma = require('../config/db');

// Texto da mensagem: até 1000 caracteres (sobra para o WhatsApp).
const TEXTO_MAX = 1000;
const { linkAgendamento, textoPadrao } = require('../services/linkAgendamento');

function dados(res) {
  const b = res.locals.barbeariaAtual;
  const link = linkAgendamento(b);
  return {
    link,
    textoPadrao: textoPadrao(b),
    // Texto salvo da barbearia (campo textoLink); sem ele, o padrão.
    textoAtual: (b && b.textoLink) || textoPadrao(b),
    qrSvg: link ? QR.svg(link.url, { borda: 2, rotulo: 'QR code do link ' + link.curto }) : '',
    nomeBarbearia: b ? b.nome : '',
    inicial: b ? String(b.nome || '?').replace(/^Barbearia\s+(d[aeo]s?\s+|e\s+)?/i, '').charAt(0).toUpperCase() : '?',
  };
}

// GET /painel/link (?novo=1: dica do passo 4 dos Primeiros passos)
function ver(req, res) {
  res.render('painel/link', { titulo: 'Link de agendamento', novo: req.query.novo === '1', ...dados(res) });
}

// GET /painel/link/cartaz — folha A5 para imprimir (só o cartaz sai no papel)
function cartaz(req, res) {
  res.render('painel/link-cartaz', { titulo: 'Cartaz A5', ...dados(res) });
}

// GET /painel/link/qr.svg — o mesmo QR, como arquivo (cache de 1 dia)
function qrSvg(req, res) {
  const { qrSvg: svg } = dados(res);
  if (!svg) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/svg+xml').send(svg);
}

// POST /painel/link/texto — salva a mensagem pronta da barbearia (antes ficava
// só no aparelho). Vazio ou igual ao padrão = volta ao padrão (null). JSON.
async function salvarTexto(req, res) {
  const b = res.locals.barbeariaAtual;
  if (!b) return res.status(404).json({ erro: 'Barbearia não encontrada.' });
  const bruto = typeof req.body.texto === 'string' ? req.body.texto.replace(/\r\n/g, '\n').trim() : '';
  if (bruto.length > TEXTO_MAX) return res.status(400).json({ erro: `Use no máximo ${TEXTO_MAX} caracteres.` });
  const textoLink = !bruto || bruto === textoPadrao(b) ? null : bruto;
  await prisma.barbearia.update({ where: { id: b.id }, data: { textoLink } });
  res.json({ ok: true, padrao: textoLink === null });
}

module.exports = { ver, cartaz, qrSvg, salvarTexto, TEXTO_MAX };
