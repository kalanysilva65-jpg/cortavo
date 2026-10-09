// Secretária Cortavo — CONFIGURAÇÃO (o dono ajusta modo, link, regras e tetos) e
// o CHAT DE TESTE (etapa 3.1, calibrar as respostas antes de ligar o WhatsApp).
// Tudo só admin.
const secretaria = require('../services/secretaria');
const onboard = require('../services/whatsappOnboard');
const numeroCortavo = require('../services/waNumeroCortavo');
const waPerfil = require('../services/waPerfil');
const prisma = require('../config/db');
const auditoria = require('../services/auditoria');
const planoCortavo = require('../services/planoCortavo');

// Chaves de configuração da secretária (na tabela Configuracao, por barbearia).
const CHAVES = ['secretaria_modo', 'secretaria_link', 'secretaria_regras', 'secretaria_teto_mes', 'copiloto_teto_mes', 'secretaria_privacidade_link', 'secretaria_pausada', 'lembretes_ativos', 'lembrete_template_nome', 'lembrete_antecedencia_min'];

const MAX_MSG = 1000;
const MAX_HIST = 12;
const MAX_HIST_TXT = 2000;

function modoValido(m) {
  return m === 'terceiros' ? 'terceiros' : 'cortavo';
}

// Monta o contexto da secretária a partir da sessão (escopo forçado) + o modo.
function contextoDe(req, res, modo) {
  const b = res.locals.barbeariaAtual;
  return {
    barbeariaId: req.barbeariaId,
    modo,
    nomeBarbearia: b ? b.nome : 'a barbearia',
    // CHAT DE TESTE: nunca grava de verdade (criar_agendamento só simula), para
    // não sujar a agenda real da barbearia.
    permitirAgendar: false,
    // No modo terceiros, o link de agendamento do outro app viria da config da
    // barbearia. Aqui, no teste, um link de exemplo.
    config: { linkAgendamento: b && b.slug ? `https://agenda.exemplo.com/${b.slug}` : null },
  };
}

// GET /painel/secretaria/teste
function verTeste(req, res) {
  const modo = modoValido(req.query.modo);
  res.render('painel/secretaria-teste', {
    titulo: 'Secretária (teste)',
    iaAtiva: secretaria.habilitada(),
    modo,
  });
}

// POST /painel/secretaria/teste/mensagem
async function mensagemTeste(req, res) {
  if (!secretaria.habilitada()) {
    return res.status(503).json({ erro: 'A secretária ainda não está configurada (falta a chave da IA).' });
  }
  // Fase 2.3: o chat de teste também gasta IA; fora do plano, não roda.
  if (!planoCortavo.temSecretaria(await planoCortavo.planoDaBarbearia(req.barbeariaId))) {
    return res.status(403).json({ erro: 'A secretária não está no seu plano. Disponível no plano Barbearia + IA. Fale com a Cortavo.' });
  }
  const modo = modoValido(req.body.modo);
  const texto = String(req.body.mensagem || '').trim().slice(0, MAX_MSG);
  if (!texto) return res.status(400).json({ erro: 'Escreva uma mensagem.' });

  const histBruto = Array.isArray(req.body.historico) ? req.body.historico : [];
  const mensagens = histBruto
    .filter((m) => m && (m.papel === 'user' || m.papel === 'assistant') && typeof m.texto === 'string')
    .slice(-MAX_HIST)
    .map((m) => ({ role: m.papel, content: m.texto.slice(0, MAX_HIST_TXT) }));
  mensagens.push({ role: 'user', content: texto });

  try {
    const { texto: resposta } = await secretaria.responder(contextoDe(req, res, modo), mensagens);
    res.json({ resposta });
  } catch (e) {
    console.error('[secretaria] falha ao responder:', e.message);
    res.status(500).json({ erro: 'Não consegui responder agora. Tente de novo.' });
  }
}

// GET /painel/secretaria — tela de configuração da secretária.
async function verConfig(req, res) {
  const regs = await prisma.configuracao.findMany({ where: { barbeariaId: req.barbeariaId, chave: { in: CHAVES } } });
  const cfg = Object.fromEntries(regs.map((r) => [r.chave, r.valor]));
  const whatsapp = await onboard.statusConexao(req.barbeariaId);
  // Redesign v3 (F8): respostas usadas no mês, no objeto do topo. Sem a
  // leitura, o objeto mostra só o estado.
  let usoSecretaria = null;
  try { usoSecretaria = await require('../services/atendimento').estadoTeto(req.barbeariaId); } catch (_) { usoSecretaria = null; }
  res.render('painel/secretaria-config', {
    titulo: 'Secretária',
    usoSecretaria,
    cfg: {
      modo: cfg.secretaria_modo === 'terceiros' ? 'terceiros' : 'cortavo',
      link: cfg.secretaria_link || '',
      regras: cfg.secretaria_regras || '',
      tetoMes: cfg.secretaria_teto_mes || '',
      copilotoTetoMes: cfg.copiloto_teto_mes || '',
      privacidadeLink: cfg.secretaria_privacidade_link || '',
      lembretesAtivos: cfg.lembretes_ativos === '1',
      lembreteTemplate: cfg.lembrete_template_nome || 'lembrete_agendamento', // já vem pré-programado
      lembreteAntecedencia: cfg.lembrete_antecedencia_min || '60',
    },
    whatsapp,
    numeroCortavo: {
      disponivel: numeroCortavo.disponivel(),
      nomeSugerido: (res.locals.barbeariaAtual && res.locals.barbeariaAtual.nome) || '',
    },
    iaPausada: cfg.secretaria_pausada === '1',
    es: {
      disponivel: onboard.configurado(),
      appId: process.env.META_APP_ID || '',
      configId: process.env.WHATSAPP_ES_CONFIG_ID || '',
      apiVersion: process.env.WHATSAPP_ES_SDK_VERSION || 'v23.0', // coexistência (featureType) exige SDK recente
    },
  });
}

// POST /painel/secretaria/ia/pausar — alterna o liga/desliga da IA por barbearia.
// Pausada: as mensagens continuam chegando na Caixa de entrada, mas a IA não
// responde sozinha (o dono atende na mão). Não desconecta o WhatsApp.
async function pausarIA(req, res) {
  const b = req.barbeariaId;
  const atual = await prisma.configuracao.findUnique({
    where: { barbeariaId_chave: { barbeariaId: b, chave: 'secretaria_pausada' } },
  });
  const novo = atual && atual.valor === '1' ? '0' : '1';
  // Fase 2.3: num plano sem secretária ninguém tira a pausa pelo painel; só a
  // Kalany, trocando o plano no painel-mestre. Pausar continua liberado.
  if (novo === '0' && !planoCortavo.temSecretaria(await planoCortavo.planoDaBarbearia(b))) {
    req.session.flash = { tipo: 'erro', texto: 'A secretária não está no seu plano. Disponível no plano Barbearia + IA. Fale com a Cortavo.' };
    return res.redirect('/painel/secretaria');
  }
  await prisma.configuracao.upsert({
    where: { barbeariaId_chave: { barbeariaId: b, chave: 'secretaria_pausada' } },
    update: { valor: novo },
    create: { barbeariaId: b, chave: 'secretaria_pausada', valor: novo },
  });
  req.session.flash = {
    tipo: 'sucesso',
    texto: novo === '1' ? 'IA pausada — ela não responde sozinha até você reativar.' : 'IA reativada — voltou a responder automaticamente.',
  };
  res.redirect('/painel/secretaria');
}

// POST /painel/secretaria/whatsapp/conectar — recebe o resultado do Embedded
// Signup (code + waba_id + phone_number_id vindos do popup) e liga o número.
async function conectarWhatsApp(req, res) {
  const code = req.body && req.body.code;
  const phoneNumberId = req.body && req.body.phoneNumberId;
  const wabaId = req.body && req.body.wabaId;
  if (!code) return res.status(400).json({ erro: 'Faltou o código de autorização do popup.' });
  try {
    const coexistencia = !!(req.body && req.body.coexistencia);
    const r = await onboard.conectar(req.barbeariaId, { code, phoneNumberId, wabaId, coexistencia });
    res.json({ ok: true, numero: r.numero });
  } catch (e) {
    console.error('[wa-onboard] conectar falhou:', e.message);
    res.status(500).json({ erro: 'Não consegui conectar o WhatsApp: ' + e.message });
  }
}

// GET /painel/secretaria/whatsapp/perfil — perfil comercial atual (JSON).
async function lerPerfilWa(req, res) {
  try {
    res.json({ ok: true, perfil: await waPerfil.obter(req.barbeariaId) });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
}

// POST /painel/secretaria/whatsapp/perfil — salva foto/sobre/descrição/endereço/e-mail/site.
async function salvarPerfilWa(req, res) {
  try {
    const b = req.body || {};
    await waPerfil.salvar(req.barbeariaId, { sobre: b.sobre, descricao: b.descricao, endereco: b.endereco, email: b.email, site: b.site }, req.file && req.file.buffer);
    res.json({ ok: true });
  } catch (e) {
    console.error('[wa-perfil] salvar falhou:', e.message);
    res.status(400).json({ erro: e.message });
  }
}

// POST /painel/secretaria/whatsapp/numero/codigo — passo 1 do caminho "pela Cortavo":
// cadastra o número e manda o código (SMS ou ligação). Guarda o id na sessão.
async function pedirCodigoNumero(req, res) {
  try {
    const r = await numeroCortavo.solicitarCodigo({
      numero: req.body.numero, nomeExibicao: req.body.nomeExibicao, metodo: req.body.metodo,
    });
    req.session.waPendente = { phoneNumberId: r.phoneNumberId, exibicao: r.exibicao, barbeariaId: req.barbeariaId };
    res.json({ ok: true, exibicao: r.exibicao });
  } catch (e) {
    console.error('[wa-numero] pedir código falhou:', e.message);
    res.status(400).json({ erro: e.message });
  }
}

// POST /painel/secretaria/whatsapp/numero/reenviar — outro código (SMS/ligação).
async function reenviarCodigoNumero(req, res) {
  const p = req.session.waPendente;
  if (!p || p.barbeariaId !== req.barbeariaId) return res.status(400).json({ erro: 'Comece de novo: informe o número.' });
  try {
    await numeroCortavo.reenviarCodigo(p.phoneNumberId, req.body.metodo);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
}

// POST /painel/secretaria/whatsapp/numero/verificar — passo 2: confere o código
// e liga o número na barbearia.
async function verificarCodigoNumero(req, res) {
  const p = req.session.waPendente;
  if (!p || p.barbeariaId !== req.barbeariaId) return res.status(400).json({ erro: 'Comece de novo: informe o número.' });
  try {
    const r = await numeroCortavo.verificarEAtivar(req.barbeariaId, p.phoneNumberId, req.body.codigo, p.exibicao);
    delete req.session.waPendente;
    res.json({ ok: true, numero: r.numero });
  } catch (e) {
    console.error('[wa-numero] verificar falhou:', e.message);
    res.status(400).json({ erro: e.message });
  }
}

// POST /painel/secretaria/whatsapp/desconectar — admin da barbearia ou a Kalany
// (dono). Confirmação conferida NO SERVIDOR: digitar DESCONECTAR. No modo
// Cortavo também libera o número na Meta. A cada desconexão a Kalany é avisada
// (push + auditoria, que aparece no painel-mestre) para remover o número no
// WhatsApp Manager. Mensagens da tela são amigáveis; o detalhe técnico vai só
// para o log e a auditoria.
const PALAVRA_DESCONECTAR = 'DESCONECTAR';

async function avisarKalanyDesconexao(titulo, corpo) {
  try {
    const notificacoes = require('../services/notificacoes');
    const donos = await prisma.usuario.findMany({ where: { papel: 'dono', ativo: true }, select: { id: true } });
    for (const d of donos) await notificacoes.enviarParaUsuario(d.id, { titulo, corpo, url: '/mestre/auditoria', tag: 'cortavo-whatsapp' });
  } catch (e) {
    console.error('[wa-onboard] aviso à Kalany falhou:', e.message);
  }
}

async function desconectarWhatsApp(req, res) {
  const { SUPORTE_CORTAVO } = require('../config/constantes');
  if (String(req.body.confirmacao || '').trim().toUpperCase() !== PALAVRA_DESCONECTAR) {
    req.session.flash = { tipo: 'erro', texto: `Para desconectar, digite ${PALAVRA_DESCONECTAR} no campo de confirmação. Nada foi alterado.` };
    return res.redirect('/painel/secretaria');
  }
  const quem = (req.session.usuario && req.session.usuario.nome) || 'alguém';
  try {
    const r = await onboard.desconectar(req.barbeariaId);
    const num = r.final4 ? ` (final ${r.final4})` : '';
    await auditoria.registrar(req, {
      acao: 'whatsapp.desconectar', alvoTipo: 'barbearia', alvoId: req.barbeariaId,
      detalhe: r.desregistrado
        ? `${quem} desconectou o WhatsApp${num}. Número liberado na Meta${r.jaLiberado ? ' (já estava liberado)' : ''}. Kalany: remover o número no WhatsApp Manager.`
        : `${quem} desconectou o WhatsApp${num} (coexistência: só apagou no Cortavo).`,
    });
    if (r.desregistrado) await avisarKalanyDesconexao('WhatsApp desconectado', `Barbearia ${req.barbeariaId}: número${num} liberado na Meta. Remova o número no WhatsApp Manager.`);
    req.session.flash = { tipo: 'sucesso', texto: r.desregistrado ? 'WhatsApp desconectado e número liberado na Meta.' : 'WhatsApp desconectado desta barbearia.' };
  } catch (e) {
    if (e.fase === 'banco') {
      // A Meta já liberou o número, mas o cadastro não foi limpo: mensagem verdadeira.
      await auditoria.registrar(req, {
        acao: 'whatsapp.desconectar_parcial', alvoTipo: 'barbearia', alvoId: req.barbeariaId,
        detalhe: `Número${e.final4 ? ' final ' + e.final4 : ''} liberado na Meta, mas a limpeza do cadastro falhou (2 tentativas). Erro: ${String(e.tecnico || '').slice(0, 300)}`,
      });
      await avisarKalanyDesconexao('Desconexão incompleta', `Barbearia ${req.barbeariaId}: número liberado na Meta, mas o cadastro não foi limpo. Confira.`);
      req.session.flash = { tipo: 'erro', texto: `O número foi liberado na Meta, mas não conseguimos limpar o cadastro. Fale com a Cortavo: ${SUPORTE_CORTAVO}.` };
    } else {
      await auditoria.registrar(req, {
        acao: 'whatsapp.desconectar_falhou', alvoTipo: 'barbearia', alvoId: req.barbeariaId,
        detalhe: 'A Meta não liberou o número; nada foi apagado. Detalhe: ' + String(e.tecnico || e.message || '').slice(0, 300),
      });
      const motivo = e.mensagemTela || `A Meta não aceitou agora. Tente mais tarde ou fale com ${SUPORTE_CORTAVO}.`;
      req.session.flash = { tipo: 'erro', texto: `Não foi possível desconectar. ${motivo} Nada foi apagado.` };
    }
  }
  res.redirect('/painel/secretaria');
}

// POST /painel/secretaria — salva a configuração.
async function salvarConfig(req, res) {
  const b = req.barbeariaId;
  const soDigitos = (v) => String(v || '').replace(/\D/g, '');
  const antecedencia = soDigitos(req.body.lembreteAntecedencia);
  const valores = {
    secretaria_modo: modoValido(req.body.modo),
    secretaria_link: String(req.body.link || '').trim().slice(0, 500),
    secretaria_regras: String(req.body.regras || '').trim().slice(0, 1500),
    secretaria_teto_mes: soDigitos(req.body.tetoMes),
    copiloto_teto_mes: soDigitos(req.body.copilotoTetoMes),
    secretaria_privacidade_link: String(req.body.privacidadeLink || '').trim().slice(0, 500),
    lembretes_ativos: req.body.lembretesAtivos ? '1' : '0',
    lembrete_template_nome: String(req.body.lembreteTemplate || '').trim().slice(0, 100),
    lembrete_antecedencia_min: antecedencia ? String(Math.min(1440, Math.max(5, parseInt(antecedencia, 10)))) : '60',
  };
  // Só o dono do sistema mexe no técnico; o admin da barbearia salva só a antecedência.
  if (req.session.usuario.papel !== 'dono') {
    for (const k of Object.keys(valores)) if (k !== 'lembrete_antecedencia_min') delete valores[k];
  }
  for (const [chave, valor] of Object.entries(valores)) {
    await prisma.configuracao.upsert({
      where: { barbeariaId_chave: { barbeariaId: b, chave } },
      update: { valor },
      create: { barbeariaId: b, chave, valor },
    });
  }
  req.session.flash = { tipo: 'sucesso', texto: 'Configuração da secretária salva.' };
  res.redirect('/painel/secretaria');
}

module.exports = { pedirCodigoNumero, reenviarCodigoNumero, verificarCodigoNumero, verConfig, salvarConfig, verTeste, mensagemTeste, conectarWhatsApp, desconectarWhatsApp, pausarIA, lerPerfilWa, salvarPerfilWa };
