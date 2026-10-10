// Caixa de entrada (Fase 3.2 + melhorias "cara de WhatsApp"): lista de conversas
// + conversa aberta, resposta humana, assumir/pausar IA. Rota única
// /painel/conversas com ?id= para abrir (o detalhe não vira path novo).
// Extras: separadores de data no chat, busca (no cliente) e auto-atualização
// (endpoints `fragmento` p/ a lista e `:id/novas` p/ o chat).
const fs = require('fs');
const prisma = require('../config/db');
const atendimento = require('../services/atendimento');
const waMidia = require('../services/waMidia');
const secretaria = require('../services/secretaria');
const { formatarTelefone } = require('../utils/telefone');

function horaCurta(d) {
  return new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function diaKey(d) {
  const x = new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
// "Hoje" / "Ontem" / "DD/MM" (com ano se for outro ano).
function rotuloDia(d) {
  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);
  const k = diaKey(d);
  if (k === diaKey(hoje)) return 'Hoje';
  if (k === diaKey(ontem)) return 'Ontem';
  const x = new Date(d);
  return (
    String(x.getDate()).padStart(2, '0') + '/' + String(x.getMonth() + 1).padStart(2, '0') +
    (x.getFullYear() !== hoje.getFullYear() ? '/' + x.getFullYear() : '')
  );
}

// Mapeia a lista de conversas da barbearia (usado na página e no fragmento).
async function listaMapeada(barbeariaId, abertaId) {
  const conversas = await atendimento.listarConversas(barbeariaId);
  return conversas.map((c) => ({
    id: c.id,
    nome: c.clienteNome || formatarTelefone(c.clienteTelefone),
    previa: c.ultimaPrevia || '',
    hora: horaCurta(c.ultimaMensagemEm),
    naoLidas: c.naoLidas,
    iaAtiva: c.iaAtiva,
    ativa: abertaId != null && c.id === abertaId,
  }));
}

// Formato de uma mensagem para a tela (e para o JSON do polling).
function paraView(m) {
  return {
    id: m.id,
    autor: m.autor,
    texto: m.texto,
    tipo: m.tipo || 'texto',
    midia: m.midiaArquivo ? '/painel/conversas/midia/' + m.id : null,
    midiaNome: m.midiaNome || null,
    status: m.autor !== 'cliente' ? m.statusEnvio || null : null,
    hora: horaCurta(m.criadoEm),
  };
}

// Janela de 24h da Meta: fora dela, texto/mídia livres não são entregues — só
// modelo (template) aprovado. Conta a partir da última mensagem do CLIENTE.
const JANELA_MS = 24 * 60 * 60 * 1000;
function janelaAberta(conversa) {
  const t = conversa.ultimaMsgClienteEm ? new Date(conversa.ultimaMsgClienteEm).getTime() : 0;
  return t > 0 && Date.now() - t < JANELA_MS;
}

// Anexa separadores de data às mensagens (o `sep` aparece antes da 1ª msg do dia).
function comSeparadores(mensagens) {
  let prev = null;
  return mensagens.map((m) => {
    const k = diaKey(m.criadoEm);
    const sep = k !== prev ? rotuloDia(m.criadoEm) : null;
    prev = k;
    return { ...paraView(m), dia: k, sep };
  });
}

// GET /painel/conversas  (?id=N abre uma conversa)
async function ver(req, res) {
  let aberta = null;
  if (req.query.id) aberta = await atendimento.abrirConversa(req.barbeariaId, req.query.id);
  const abertaId = aberta ? aberta.conversa.id : null;

  const [conversas, teto] = await Promise.all([
    listaMapeada(req.barbeariaId, abertaId),
    atendimento.estadoTeto(req.barbeariaId),
  ]);

  res.render('painel/conversas', {
    titulo: 'Conversas',
    modoTeste: req.query.teste === '1',
    iaAtiva: secretaria.habilitada(),
    tetoAtingido: teto.atingido,
    conversas,
    aberta: aberta
      ? {
          conversa: {
            id: aberta.conversa.id,
            nome: aberta.conversa.clienteNome || formatarTelefone(aberta.conversa.clienteTelefone),
            telefone: formatarTelefone(aberta.conversa.clienteTelefone),
            iaAtiva: aberta.conversa.iaAtiva,
            janelaAberta: janelaAberta(aberta.conversa),
          },
          mensagens: comSeparadores(aberta.mensagens),
        }
      : null,
  });
}

// GET /painel/conversas/fragmento — só a lista (para a auto-atualização trocar sem recarregar).
async function fragmento(req, res) {
  const conversas = await listaMapeada(req.barbeariaId, null);
  res.render('painel/_conversas-lista', { layout: false, conversas, polling: true });
}

// GET /painel/conversas/:id/novas?apos=<id> — mensagens novas para o chat aberto.
async function novas(req, res) {
  const r = await atendimento.mensagensApos(req.barbeariaId, req.params.id, req.query.apos);
  if (!r) return res.status(404).json({ erro: 'Conversa não encontrada.' });
  res.json({
    iaAtiva: r.conversa.iaAtiva,
    mensagens: r.msgs.map((m) => ({ ...paraView(m), dia: diaKey(m.criadoEm), diaLabel: rotuloDia(m.criadoEm) })),
    // Tiques das últimas mensagens de SAÍDA (mudam depois de enviadas).
    status: await atendimento.statusRecentes(r.conversa.id),
    janelaAberta: janelaAberta(r.conversa),
  });
}

// POST /painel/conversas/:id/responder
async function responder(req, res) {
  const texto = String(req.body.texto || '').trim().slice(0, 2000);
  if (texto) await atendimento.responderComoHumano(req.barbeariaId, req.params.id, texto);
  res.redirect('/painel/conversas?id=' + encodeURIComponent(req.params.id));
}

// POST /painel/conversas/:id/ia   (body ativa=0|1) — assumir/devolver
async function definirIA(req, res) {
  const ativa = String(req.body.ativa) === '1';
  await atendimento.definirIA(req.barbeariaId, req.params.id, ativa);
  res.redirect('/painel/conversas?id=' + encodeURIComponent(req.params.id));
}

// POST /painel/conversas/simular — injeta uma mensagem de cliente (SÓ TESTE, admin).
async function simular(req, res) {
  const telefone = String(req.body.telefone || '').trim();
  const nome = String(req.body.nome || '').trim();
  const texto = String(req.body.texto || '').trim().slice(0, 2000);
  if (telefone && texto) {
    const r = await atendimento.receberMensagemCliente(req.barbeariaId, { telefone, nome, texto });
    if (r && r.conversaId) return res.redirect('/painel/conversas?id=' + r.conversaId);
  }
  res.redirect('/painel/conversas');
}

// POST /painel/conversas/:id/excluir — LGPD: apaga a conversa e suas mensagens.
async function excluir(req, res) {
  await atendimento.excluirConversa(req.barbeariaId, req.params.id);
  req.session.flash = { tipo: 'sucesso', texto: 'Conversa excluída.' };
  res.redirect('/painel/conversas');
}

// GET /painel/conversas/midia/:mensagemId — entrega a mídia (só logado, só da
// própria barbearia). Não fica em /uploads porque é dado de cliente.
async function midia(req, res) {
  const m = await prisma.mensagem.findFirst({
    where: { id: Number(req.params.mensagemId), conversa: { barbeariaId: req.barbeariaId } },
    select: { midiaArquivo: true, midiaMime: true, midiaNome: true },
  });
  const arq = m && waMidia.caminho(m.midiaArquivo);
  if (!arq || !fs.existsSync(arq)) return res.sendStatus(404);
  res.setHeader('Content-Type', (m.midiaMime || 'application/octet-stream').split(';')[0]);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (m.midiaNome) res.setHeader('Content-Disposition', 'inline; filename="' + m.midiaNome.replace(/[^\w.\- ]/g, '_') + '"');
  fs.createReadStream(arq).pipe(res);
}

// POST /painel/conversas/:id/midia — humano envia foto/vídeo/áudio/documento.
async function enviarMidia(req, res) {
  const f = req.file;
  if (!f) return res.status(400).json({ erro: 'Nenhum arquivo.' });
  const r = await atendimento.enviarMidiaComoHumano(req.barbeariaId, req.params.id, {
    buffer: f.buffer, mime: f.mimetype, nome: f.originalname, legenda: req.body.legenda,
  });
  if (!r) return res.status(404).json({ erro: 'Conversa não encontrada.' });
  res.json({ ok: r.ok, erro: r.ok ? null : r.erro || 'O WhatsApp recusou o arquivo.' });
}

module.exports = { ver, fragmento, novas, responder, definirIA, simular, excluir, midia, enviarMidia };
