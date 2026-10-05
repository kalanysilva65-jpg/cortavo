// Atendimento / caixa de entrada (Fase 3.2) + LGPD e tetos de custo (Fase 3.5).
// Orquestra: mensagem do cliente entra -> grava -> (se cabível) a secretária
// responde. Em 3.3 o webhook do WhatsApp chama `receberMensagemCliente` e o envio
// real sai por `enviarWhatsApp` (hoje stub).
//
// Camadas de proteção (3.5), na ordem em que agem antes de gastar IA:
//   1) OPT-OUT: "SAIR"/"PARAR" pausa a IA na conversa e chama um humano.
//   2) KILL SWITCH global (env SECRETARIA_DESLIGADA=1).
//   3) FREIO ANTI-ABUSO: flood de um mesmo número não roda a IA à toa.
//   4) TETO mensal por barbearia: ao estourar, a IA pausa no mês (humanos seguem).
// Tudo escopado por barbeariaId (multi-tenant).
const prisma = require('../config/db');
const secretaria = require('./secretaria');
const faq = require('./faq');
const whatsapp = require('./whatsapp');
const waMidia = require('./waMidia');
const notificacoes = require('./notificacoes');
const pausa = require('./pausa');
const demo = require('./demo');
const planoCortavo = require('./planoCortavo');
const testeGratis = require('./testeGratis');
const { normalizarTelefone } = require('../utils/telefone');

const HIST_MAX = 30; // mensagens recentes enviadas à IA como contexto
const TETO_PADRAO = 1500; // respostas de IA por mês por barbearia (config: secretaria_teto_mes)
const TETO_COPILOTO_PADRAO = 200; // consultas do copiloto/mês por barbearia (config: copiloto_teto_mes)
const ABUSO_MAX_HORA = 20; // msgs do MESMO cliente numa 1h antes de a IA recuar
const REPETICOES_RESET = 2; // 2ª repetição -> auto-recuperação (responde sem o histórico enviesado)
const REPETICOES_MAX = 3; // 3ª repetição -> passa pra humano (IA travou de vez)
const RETENCAO_MESES = 12; // conversas mais antigas que isso são apagadas (LGPD)
const PALAVRAS_OPTOUT = ['SAIR', 'PARAR', 'STOP', 'CANCELAR'];

// Remove "metades soltas" de emoji (surrogates sem par). Elas surgem quando um
// texto com emoji é cortado no meio (ex.: slice de 80 na prévia) e QUEBRAM a
// serialização do Prisma/SQLite -> "unexpected end of hex escape". Tira o high
// surrogate sem o low seguinte, e o low sem o high anterior.
function semSurrogatesSoltos(s) {
  return String(s == null ? '' : s)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
function previa(texto) {
  return semSurrogatesSoltos((texto || '').replace(/\s+/g, ' ').trim().slice(0, 80));
}
function competenciaAtual() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
// Opt-out só quando a mensagem INTEIRA é a palavra-chave (evita falso positivo
// tipo "quero sair do plano").
function ehOptOut(texto) {
  const limpo = (texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z]/g, '').toUpperCase();
  return PALAVRAS_OPTOUT.includes(limpo);
}

// Pedido explícito de atendimento HUMANO (além do opt-out). Determinístico: não
// depende de a IA decidir chamar a ferramenta — garante o handoff mesmo que o
// modelo hesite ou tente responder. Exige um verbo de "querer/falar" JUNTO de um
// alvo humano, pra não confundir com "você é humano?" (isso é tratado no prompt).
function pedeHumano(texto) {
  const t = (texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const querFalar = /(falar|conversar|atendimento|atender|passar|transferir|me passa|quero|queria|preciso|tem |chama|chamar)/.test(t);
  const alvoHumano = /(atendente|humano|uma pessoa|com alguem|responsavel|gerente|com o dono|ser humano|pessoa de verdade|nao (e|eh) (robo|bot|ia))/.test(t);
  return querFalar && alvoHumano;
}

// A resposta da IA ANUNCIA que vai passar/chamar a equipe? Usado para FORÇAR o
// handoff de verdade (pausar a IA + notificar) quando o modelo diz que vai chamar
// a equipe mas não invoca a ferramenta — sem isso ela fica repetindo "já chamei a
// equipe" e nunca passa de fato.
function anunciaHandoff(texto) {
  const t = (texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return /(cham(ei|ando|ar|o)|acion(ei|ar|ando)|passar|passei|transferir|encaminh).{0,30}(equipe|atendente|humano|pessoa)/.test(t)
    || /(um|a) atendente.{0,20}(vai|vem|ja)/.test(t)
    || /aguard[ae].{0,20}(equipe|atendente)/.test(t);
}

// "Assinatura" de uma mensagem para comparar repetição (ignora acento, caixa,
// pontuação e espaços). "Quero agendar!" e "quero agendar" viram a mesma coisa.
function assinaturaMsg(texto) {
  return (texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
// Quantas das ÚLTIMAS mensagens do cliente (incluindo a atual) são praticamente
// iguais, em sequência. Se o cliente repete o mesmo pedido, a IA não resolveu.
function repeticoesSeguidas(msgs) {
  const doCliente = msgs.filter((m) => m.autor === 'cliente');
  if (!doCliente.length) return 0;
  const alvo = assinaturaMsg(doCliente[doCliente.length - 1].texto);
  if (!alvo) return 0;
  let n = 0;
  for (let i = doCliente.length - 1; i >= 0; i--) {
    if (assinaturaMsg(doCliente[i].texto) === alvo) n++;
    else break;
  }
  return n;
}

async function lerConfig(barbeariaId, chave, padrao) {
  const c = await prisma.configuracao
    .findUnique({ where: { barbeariaId_chave: { barbeariaId, chave } } })
    .catch(() => null);
  return c ? c.valor : padrao;
}
async function modoDaBarbearia(barbeariaId) {
  const v = await lerConfig(barbeariaId, 'secretaria_modo', 'cortavo');
  return v === 'terceiros' ? 'terceiros' : 'cortavo';
}

function historicoParaIA(mensagens) {
  const arr = [];
  for (let m of mensagens) {
    // Mídia sem texto vira um marcador ("[📷 Foto]") pra IA saber que houve algo.
    if (!m.texto) {
      if (!m.tipo || m.tipo === 'texto') continue;
      m = { ...m, texto: '[' + (ROTULO_MIDIA[m.tipo] || 'arquivo') + ']' };
    }
    const role = m.autor === 'cliente' ? 'user' : 'assistant';
    if (arr.length && arr[arr.length - 1].role === role) {
      arr[arr.length - 1].content += '\n' + m.texto;
    } else {
      arr.push({ role, content: m.texto });
    }
  }
  while (arr.length && arr[0].role !== 'user') arr.shift();
  // A conversa enviada ao modelo TEM que TERMINAR numa mensagem do usuário — o
  // Sonnet não aceita "prefill" (terminar em assistant) e devolve 400. Com
  // mensagens em rajada processadas em paralelo (ex.: vários áudios seguidos),
  // uma resposta da IA pode ganhar timestamp posterior e cair no fim do
  // histórico; aqui descartamos qualquer mensagem de assistant pendurada no fim.
  while (arr.length && arr[arr.length - 1].role !== 'user') arr.pop();
  return arr;
}

// Envio real pela WhatsApp Cloud API (Fase 3.3). Usa as credenciais da barbearia
// da conversa e manda para o telefone do cliente. Erros são engolidos lá dentro
// (logados) — a mensagem já ficou gravada na conversa de qualquer jeito.
async function enviarWhatsApp(conversa, texto) {
  return whatsapp.enviarTexto(conversa.barbeariaId, conversa.clienteTelefone, texto);
}

// Grava uma mensagem de saída (IA ou sistema), atualiza a prévia e envia.
async function emitir(conversa, autor, texto) {
  const limpo = semSurrogatesSoltos(texto);
  const msg = await prisma.mensagem.create({ data: { conversaId: conversa.id, autor, texto: limpo } });
  await prisma.conversa.update({ where: { id: conversa.id }, data: { ultimaPrevia: previa(limpo), ultimaMensagemEm: new Date() } });
  const r = await enviarWhatsApp(conversa, limpo);
  await registrarEnvio(msg.id, r);
}

// Guarda o wamid + status inicial do envio (os tiques vêm depois pelo webhook).
async function registrarEnvio(mensagemId, r) {
  const data = r && r.ok ? { waId: r.waId || null, statusEnvio: 'enviada' } : { statusEnvio: r && r.motivo === 'sem_credenciais' ? null : 'falhou' };
  await prisma.mensagem.update({ where: { id: mensagemId }, data }).catch(() => {});
}

// Rótulo curto de uma mídia (prévia da lista e texto de mensagens sem legenda).
const ROTULO_MIDIA = {
  imagem: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', documento: '📄 Documento',
  figurinha: '💟 Figurinha', localizacao: '📍 Localização', contato: '👤 Contato',
};

// Status de entrega vindo do webhook (sent/delivered/read/failed). Nunca
// "rebaixa" (um 'delivered' atrasado não desfaz o 'read').
const ORDEM_STATUS = { enviada: 1, entregue: 2, lida: 3 };
const STATUS_META = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' };
async function atualizarStatusEnvio(waId, statusMeta) {
  const novo = STATUS_META[statusMeta];
  if (!waId || !novo) return;
  const m = await prisma.mensagem.findFirst({ where: { waId }, select: { id: true, statusEnvio: true } });
  if (!m) return;
  if (novo !== 'falhou' && (ORDEM_STATUS[m.statusEnvio] || 0) >= ORDEM_STATUS[novo]) return;
  await prisma.mensagem.update({ where: { id: m.id }, data: { statusEnvio: novo } });
}

// --- Teto de custo (uso mensal de IA por barbearia) ---
async function estadoTeto(barbeariaId) {
  const competencia = competenciaAtual();
  // Fase 2.3: teto vem do plano da Cortavo; 0 = DESLIGADO (antes 0 virava o
  // padrão). No Personalizado vale a configuração, como antes.
  const plano = await planoCortavo.planoDaBarbearia(barbeariaId);
  const teto = planoCortavo.resolverTeto(plano, 'secretaria', await lerConfig(barbeariaId, 'secretaria_teto_mes', ''), TETO_PADRAO);
  const uso = await prisma.usoIA.findUnique({ where: { barbeariaId_competencia: { barbeariaId, competencia } } });
  // Fase 2.6 (spec 05 regra 4 / spec 07 regra 3): no teste do + IA vale o
  // total do TESTE (250), num contador separado do mensal.
  const doTeste = await testeGratis.tetoSecretariaTeste(barbeariaId, plano.chave);
  if (doTeste) {
    // Correção Sergio 2: desligado (teto 0) continua desligado no teste, e um
    // teto menor que 250 vale. A pausa do dono (secretaria_pausada) é checada antes.
    const tetoTeste = teto === 0 ? 0 : Math.min(doTeste.teto, teto);
    return { competencia, teto: tetoTeste, respostas: doTeste.respostas, atingido: doTeste.respostas >= tetoTeste, desligado: tetoTeste === 0, avisado: uso ? uso.avisadoTeto : false, teste: true };
  }
  const respostas = uso ? uso.respostas : 0;
  return { competencia, teto, respostas, atingido: respostas >= teto, desligado: teto === 0, avisado: uso ? uso.avisadoTeto : false };
}
// Teto mensal do COPILOTO (Assistente do painel), à parte do WhatsApp.
async function estadoTetoCopiloto(barbeariaId) {
  const competencia = competenciaAtual();
  const plano = await planoCortavo.planoDaBarbearia(barbeariaId);
  const teto = planoCortavo.resolverTeto(plano, 'assistente', await lerConfig(barbeariaId, 'copiloto_teto_mes', ''), TETO_COPILOTO_PADRAO);
  const uso = await prisma.usoIA.findUnique({ where: { barbeariaId_competencia: { barbeariaId, competencia } } });
  // No teste: 50 consultas no período do teste (contador próprio); desligado continua desligado.
  const doTeste = teto > 0 ? await testeGratis.tetoAssistenteTeste(barbeariaId) : null;
  if (doTeste) {
    const t = Math.min(doTeste.teto, teto);
    return { competencia, teto: t, consultas: doTeste.consultas, atingido: doTeste.consultas >= t, desligado: false, teste: true };
  }
  const consultas = uso ? uso.copilotoConsultas : 0;
  return { competencia, teto, consultas, atingido: consultas >= teto, desligado: teto === 0 };
}

// Registra o uso DETALHADO por modelo (canal whatsapp|copiloto) — base do custo
// exato no painel-mestre, mesmo trocando de modelo no meio do mês.
async function registrarUsoModelo(barbeariaId, competencia, canal, modelo, usage) {
  if (!modelo) return;
  try {
    await prisma.usoIAModelo.upsert({
      where: { barbeariaId_competencia_canal_modelo: { barbeariaId, competencia, canal, modelo } },
      create: { barbeariaId, competencia, canal, modelo, tokensEntrada: usage?.input || 0, tokensSaida: usage?.output || 0, tokensEntradaCru: usage?.inputCru || 0, chamadas: 1 },
      update: { tokensEntrada: { increment: usage?.input || 0 }, tokensSaida: { increment: usage?.output || 0 }, tokensEntradaCru: { increment: usage?.inputCru || 0 }, chamadas: { increment: 1 } },
    });
  } catch (e) {
    console.error('[uso-modelo] falhou:', e.message);
  }
}

async function registrarUso(barbeariaId, competencia, usage) {
  await prisma.usoIA.upsert({
    where: { barbeariaId_competencia: { barbeariaId, competencia } },
    create: { barbeariaId, competencia, respostas: 1, tokensEntrada: usage?.input || 0, tokensSaida: usage?.output || 0, tokensEntradaCru: usage?.inputCru || 0 },
    update: { respostas: { increment: 1 }, tokensEntrada: { increment: usage?.input || 0 }, tokensSaida: { increment: usage?.output || 0 }, tokensEntradaCru: { increment: usage?.inputCru || 0 } },
  });
  // Contador do teste (só conta se a barbearia estiver em teste).
  await testeGratis.contarRespostaTeste(barbeariaId);
  // Modelo REAL usado pela secretária (para o custo por modelo).
  await registrarUsoModelo(barbeariaId, competencia, 'whatsapp', secretaria.MODELO, usage);
}
// Uso do COPILOTO (Assistente do painel) — contado à parte do WhatsApp.
async function registrarUsoCopiloto(barbeariaId, usage) {
  const competencia = competenciaAtual();
  await prisma.usoIA.upsert({
    where: { barbeariaId_competencia: { barbeariaId, competencia } },
    create: {
      barbeariaId,
      competencia,
      copilotoConsultas: 1,
      copilotoTokensEntrada: usage?.input || 0,
      copilotoTokensSaida: usage?.output || 0,
      copilotoTokensEntradaCru: usage?.inputCru || 0,
    },
    update: {
      copilotoConsultas: { increment: 1 },
      copilotoTokensEntrada: { increment: usage?.input || 0 },
      copilotoTokensSaida: { increment: usage?.output || 0 },
      copilotoTokensEntradaCru: { increment: usage?.inputCru || 0 },
    },
  });
  // Modelo REAL do copiloto (mesma lógica de env do services/ia.js).
  const modeloCop = process.env.IA_MODELO_COPILOTO || process.env.IA_MODELO || 'claude-haiku-4-5';
  await testeGratis.contarConsultaTeste(barbeariaId); // assistente no teste (fase 2.6)
  await registrarUsoModelo(barbeariaId, competencia, 'copiloto', modeloCop, usage);
}

async function marcarAvisadoTeto(barbeariaId, competencia) {
  await prisma.usoIA.upsert({
    where: { barbeariaId_competencia: { barbeariaId, competencia } },
    create: { barbeariaId, competencia, respostas: 0, avisadoTeto: true },
    update: { avisadoTeto: true },
  });
}

// Freio anti-abuso: quantas mensagens do cliente nesta conversa na última 1h.
// Respeita o "recomeço" (iaContextoDesde): ao devolver o atendimento à IA, o
// contador zera junto — a equipe já tratou, então a janela começa do zero.
async function floodNaConversa(conversaId, desde) {
  const umaHora = new Date(Date.now() - 60 * 60 * 1000);
  const limite = desde && new Date(desde) > umaHora ? new Date(desde) : umaHora;
  return prisma.mensagem.count({ where: { conversaId, autor: 'cliente', criadoEm: { gte: limite } } });
}

// Agrupamento de mensagens (debounce). LIGADO só quando SECRETARIA_DEBOUNCE_MS>0:
// a resposta da IA espera esse tempo; se o cliente manda mais mensagens (áudios ou
// textos picados) o timer REINICIA, e no fim tudo é respondido de uma vez — uma
// chamada de IA e uma resposta coerente, em vez de N respostas fragmentadas.
// Padrão 0 = desligado (responde inline, comportamento de sempre). É in-process
// (o app roda num processo só), keyed por conversa.
const DEBOUNCE_MS = Math.max(0, parseInt(process.env.SECRETARIA_DEBOUNCE_MS, 10) || 0);
const _debounce = new Map(); // conversaId -> timeout pendente
const _processando = new Set(); // conversaId sendo respondida agora (evita 2 IA em paralelo)

function _agendarResposta(barbeariaId, conversaId) {
  const anterior = _debounce.get(conversaId);
  if (anterior) clearTimeout(anterior);
  const t = setTimeout(function () {
    _debounce.delete(conversaId);
    // Se já há uma resposta rodando pra esta conversa, espera terminar (re-agenda)
    // pra não disparar duas chamadas de IA em paralelo na mesma conversa.
    if (_processando.has(conversaId)) return _agendarResposta(barbeariaId, conversaId);
    _processando.add(conversaId);
    responderConversa(barbeariaId, conversaId)
      .catch((e) => console.error('[atendimento] responder (debounce) falhou:', e && (e.message || e)))
      .finally(() => _processando.delete(conversaId));
  }, DEBOUNCE_MS);
  _debounce.set(conversaId, t);
}

// Cancela uma resposta agendada (ex.: cliente mandou SAIR / pediu humano no meio).
function _cancelarResposta(conversaId) {
  const t = _debounce.get(conversaId);
  if (t) {
    clearTimeout(t);
    _debounce.delete(conversaId);
  }
}

// Mensagem RECEBIDA de um cliente. Ponto único chamado pelo webhook (3.3).
async function receberMensagemCliente(barbeariaId, { telefone, nome, texto, tipo, midia, waId }) {
  const tel = normalizarTelefone(telefone) || String(telefone || '').trim();
  tipo = tipo || 'texto';
  texto = texto || '';
  if (!tel || (!texto && tipo === 'texto')) return { erro: 'Dados insuficientes.' };
  // Blinda contra emoji cortado/malformado vindo do cliente (mesmo motivo da
  // previa): evita quebrar o Prisma ao gravar/atualizar a conversa.
  texto = semSurrogatesSoltos(texto);

  // Cria/atualiza a conversa e grava a mensagem do cliente.
  let conversa = await prisma.conversa.findUnique({
    where: { barbeariaId_clienteTelefone: { barbeariaId, clienteTelefone: tel } },
  });
  const nova = !conversa;
  if (!conversa) {
    conversa = await prisma.conversa.create({ data: { barbeariaId, clienteTelefone: tel, clienteNome: nome || null } });
  } else if (nome && !conversa.clienteNome) {
    await prisma.conversa.update({ where: { id: conversa.id }, data: { clienteNome: nome } });
  }
  await prisma.mensagem.create({
    data: {
      conversaId: conversa.id, autor: 'cliente', texto, tipo, waId: waId || null,
      midiaArquivo: (midia && midia.arquivo) || null, midiaMime: (midia && midia.mime) || null, midiaNome: (midia && midia.nome) || null,
    },
  });
  const agora = new Date();
  const rotulo = tipo !== 'texto' ? ROTULO_MIDIA[tipo] || '📎 Arquivo' : '';
  await prisma.conversa.update({
    where: { id: conversa.id },
    data: {
      ultimaPrevia: previa(tipo === 'texto' ? texto : rotulo + (texto && tipo !== 'audio' ? ' ' + texto : '')),
      ultimaMensagemEm: agora, ultimaMsgClienteEm: agora, naoLidas: { increment: 1 }, status: 'aberta',
    },
  });

  // (0) PAUSA de verdade (spec 01): barbearia pausada guarda a mensagem (fica
  // em Conversas) mas NADA responde — nem IA, nem FAQ, nem o aviso de SAIR.
  if (await pausa.estaPausada(barbeariaId)) return { conversaId: conversa.id, respostaIA: null, pausada: true };
  // (0) DEMONSTRAÇÃO (spec 03): a mensagem fica salva, mas nada responde.
  if (await demo.ehDemo(barbeariaId)) return { conversaId: conversa.id, respostaIA: null, demo: true };

  // Mídia sem texto (foto sem legenda, figurinha, localização...): fica na caixa
  // de entrada pro humano ver, mas a IA não tem o que responder. Áudio chega aqui
  // já TRANSCRITO em `texto`, então segue o fluxo normal.
  if (!texto) return { conversaId: conversa.id, respostaIA: null };

  // (0b) Fase 2.3: plano sem secretária (Essencial/Barbearia). A mensagem fica
  // em Conversas para a equipe, mas nada responde sozinho (nem FAQ, nem SAIR).
  if (!planoCortavo.temSecretaria(await planoCortavo.planoDaBarbearia(barbeariaId))) {
    return { conversaId: conversa.id, respostaIA: null, foraDoPlano: true };
  }

  // (1) OPT-OUT: pausa a IA nesta conversa e chama um humano.
  if (ehOptOut(texto)) {
    _cancelarResposta(conversa.id); // cancela resposta agrupada pendente, se houver
    await prisma.conversa.update({ where: { id: conversa.id }, data: { iaAtiva: false } });
    await emitir(conversa, 'ia', 'Tudo bem! 🙂 Vou avisar a equipe para continuar seu atendimento por aqui.');
    await notificacoes.notificarHumanoSolicitado(barbeariaId, conversa);
    return { conversaId: conversa.id, optOut: true };
  }

  // (1b) HANDOFF: cliente pede uma PESSOA. Pausa a IA nesta conversa, avisa a
  // equipe (push no app e fora dele) e responde curto. Só quando a IA ainda está
  // ativa na conversa (evita re-notificar depois de já ter passado pra humano).
  if (conversa.iaAtiva && pedeHumano(texto)) {
    console.log('[atendimento] handoff DETERMINISTICO (pedeHumano) por:', JSON.stringify(texto.slice(0, 60)));
    _cancelarResposta(conversa.id); // cancela resposta agrupada pendente, se houver
    await prisma.conversa.update({ where: { id: conversa.id }, data: { iaAtiva: false } });
    await emitir(conversa, 'ia', 'Claro! 🙂 Já estou chamando a equipe pra continuar seu atendimento por aqui. Um instante, por favor.');
    await notificacoes.notificarHumanoSolicitado(barbeariaId, conversa);
    return { conversaId: conversa.id, handoffHumano: true };
  }

  // Portões que impedem a IA de responder automaticamente. `secretaria_pausada`
  // é o liga/desliga por barbearia (botão "Pausar IA" no painel): a mensagem do
  // cliente continua sendo gravada e aparece na Caixa de entrada, mas a IA não
  // responde sozinha até o dono reativar.
  const pausada = (await lerConfig(barbeariaId, 'secretaria_pausada', null)) === '1';
  // Fase 2.3: plano sem secretária (teto 0) = desligada, nem a FAQ responde.
  const noPlano = planoCortavo.temSecretaria(await planoCortavo.planoDaBarbearia(barbeariaId));
  const ligada = secretaria.habilitada() && process.env.SECRETARIA_DESLIGADA !== '1' && !pausada && noPlano;
  if (!conversa.iaAtiva || !ligada) return { conversaId: conversa.id, respostaIA: null };

  // O aviso de privacidade (LGPD) NÃO sai mais como mensagem separada: vai junto
  // da PRIMEIRA resposta (ver avisoPrivacidadeSeNovo). Desde 01/10/2026 a Meta
  // cobra cada mensagem enviada — assim a 1ª conversa custa 1 mensagem, não 2.

  // A resposta da IA: AGRUPADA (debounce) quando SECRETARIA_DEBOUNCE_MS>0, senão
  // INLINE (comportamento atual). O agrupamento relê tudo do banco quando dispara,
  // então uma rajada de mensagens do cliente vira UMA resposta, não N fragmentadas.
  if (DEBOUNCE_MS > 0) {
    _agendarResposta(barbeariaId, conversa.id);
    return { conversaId: conversa.id, agendado: true };
  }
  return responderConversa(barbeariaId, conversa.id);
}

// Aviso de privacidade (LGPD) para PREFIXAR a primeira resposta da conversa.
// "Primeira" = ainda não há nenhuma mensagem da IA nesta conversa. Devolve '' se
// o aviso já foi dado. Vai na MESMA mensagem da resposta (economia na Meta).
async function avisoPrivacidadeSeNovo(barbeariaId, conversaId) {
  const jaFalou = await prisma.mensagem.count({ where: { conversaId, autor: 'ia' } });
  if (jaFalou) return '';
  const b0 = await prisma.barbearia.findUnique({ where: { id: barbeariaId } });
  const link = await lerConfig(barbeariaId, 'secretaria_privacidade_link', null);
  let aviso = `Você fala com o atendimento virtual 🤖 da ${b0 ? b0.nome : 'nossa barbearia'}. Usamos seus dados apenas para te atender e agendar.`;
  if (link) aviso += ` Política de privacidade: ${link}`;
  aviso += ` (Se preferir um atendente, é só escrever SAIR.)`;
  return aviso + String.fromCharCode(10, 10);
}

// Gera e ENVIA a resposta da IA de uma conversa. Chamada inline logo após gravar a
// mensagem (debounce off) ou pelo agendador depois que a rajada do cliente assenta.
// Relê a conversa e o histórico do banco — por isso agrupa naturalmente a rajada.
async function responderConversa(barbeariaId, conversaId) {
  const conversa = await prisma.conversa.findUnique({ where: { id: conversaId } });
  if (!conversa) return { conversaId, respostaIA: null };
  // Estado pode ter mudado entre agendar e disparar (opt-out / pausa / handoff).
  if (await pausa.estaPausada(barbeariaId)) return { conversaId, respostaIA: null, pausada: true };
  if (await demo.ehDemo(barbeariaId)) return { conversaId, respostaIA: null, demo: true };
  const pausada = (await lerConfig(barbeariaId, 'secretaria_pausada', null)) === '1';
  // Fase 2.3: plano sem secretária (teto 0) = desligada, nem a FAQ responde.
  const noPlano = planoCortavo.temSecretaria(await planoCortavo.planoDaBarbearia(barbeariaId));
  const ligada = secretaria.habilitada() && process.env.SECRETARIA_DESLIGADA !== '1' && !pausada && noPlano;
  if (!conversa.iaAtiva || !ligada) return { conversaId, respostaIA: null };

  // Texto da ÚLTIMA mensagem do cliente (para o cache de FAQ). No modo agrupado é a
  // última da rajada; no inline é a que acabou de chegar — mesmo resultado.
  const ultimaCliente = await prisma.mensagem.findFirst({
    where: { conversaId: conversa.id, autor: 'cliente' },
    orderBy: { criadoEm: 'desc' },
  });
  const texto = ultimaCliente ? ultimaCliente.texto : '';

  // (3) Freio anti-abuso: muitas mensagens do mesmo cliente em 1h. Em vez de ficar
  // muda (deixa o cliente no vácuo e a conversa no limbo), passa pra um humano e
  // para de gastar IA nesta conversa. iaAtiva=false evita re-notificar a cada msg.
  if ((await floodNaConversa(conversa.id, conversa.iaContextoDesde)) > ABUSO_MAX_HORA) {
    console.log('[atendimento] handoff por FLOOD (anti-abuso) conversa', conversa.id);
    await prisma.conversa.update({ where: { id: conversa.id }, data: { iaAtiva: false } });
    await emitir(conversa, 'ia', 'Vou pedir pra alguém da equipe continuar seu atendimento por aqui, tá? 🙂');
    await notificacoes.notificarHumanoSolicitado(barbeariaId, conversa);
    return { conversaId: conversa.id, freado: true };
  }

  // (3.5) CACHE DE FAQ: pergunta estática (endereço, horário, preços) responde
  // direto dos dados — SEM IA (custo zero), e vale mesmo se o teto da IA estourou.
  const respostaFaq = await faq.tentarResponder(barbeariaId, texto);
  if (respostaFaq) {
    await emitir(conversa, 'ia', (await avisoPrivacidadeSeNovo(barbeariaId, conversa.id)) + respostaFaq);
    return { conversaId: conversa.id, respostaIA: respostaFaq, faqHit: true };
  }

  // (4) Teto mensal por barbearia.
  const teto = await estadoTeto(barbeariaId);
  if (teto.atingido) {
    if (!teto.avisado) await marcarAvisadoTeto(barbeariaId, teto.competencia);
    return { conversaId: conversa.id, respostaIA: null, tetoAtingido: true };
  }

  // Monta contexto e responde. A partir do "recomeço" (iaContextoDesde), a IA só
  // vê mensagens novas — assim, ao ser devolvida, não fica presa no histórico de
  // handoff antigo.
  const filtroMsgs = { conversaId: conversa.id };
  if (conversa.iaContextoDesde) filtroMsgs.criadoEm = { gte: conversa.iaContextoDesde };
  const msgs = await prisma.mensagem.findMany({ where: filtroMsgs, orderBy: { criadoEm: 'asc' }, take: HIST_MAX });

  // (4.5) ANTI-LOOP em 2 níveis. Quando o cliente repete praticamente a MESMA
  // mensagem, a IA está presa no próprio padrão (o histórico "envenenado" faz ela
  // imitar as respostas anteriores). Em vez de exigir apagar a conversa na mão:
  //   - 3ª repetição -> SALVA-VIDAS: passa pra humano e para de gastar IA.
  //   - 2ª repetição -> AUTO-RECUPERAÇÃO: responde IGNORANDO o histórico velho (só
  //     a última mensagem), o mesmo efeito de "recomeçar", sem apagar nada.
  const repeticoes = repeticoesSeguidas(msgs);
  if (repeticoes >= REPETICOES_MAX) {
    console.log('[atendimento] handoff por LOOP (', repeticoes, 'repeticoes) conversa', conversa.id);
    await prisma.conversa.update({ where: { id: conversa.id }, data: { iaAtiva: false } });
    await emitir(conversa, 'ia', 'Deixa eu chamar alguém da equipe pra te ajudar melhor com isso 🙂 Já já uma pessoa te responde por aqui.');
    await notificacoes.notificarHumanoSolicitado(barbeariaId, conversa);
    return { conversaId: conversa.id, loopDetectado: true };
  }
  const contextoLimpo = repeticoes >= REPETICOES_RESET;

  const b = await prisma.barbearia.findUnique({ where: { id: barbeariaId } });
  const ctx = {
    barbeariaId,
    conversaId: conversa.id, // permite à ferramenta encaminhar_humano pausar a IA desta conversa
    modo: await modoDaBarbearia(barbeariaId),
    nomeBarbearia: b ? b.nome : 'a barbearia',
    permitirAgendar: true,
    clienteTelefone: conversa.clienteTelefone,
    clienteNome: conversa.clienteNome || null,
    // Se um HUMANO já respondeu nesta conversa e mesmo assim a IA está rodando
    // agora, é porque a equipe DEVOLVEU o atendimento à IA. Sinaliza pra ela não
    // ficar repetindo o "vou chamar a equipe" com base no histórico antigo.
    retomadoDeHumano: msgs.some((m) => m.autor === 'humano'),
    regrasExtras: await lerConfig(barbeariaId, 'secretaria_regras', null),
    config: { linkAgendamento: (await lerConfig(barbeariaId, 'secretaria_link', null)) || (b && b.slug ? `https://agenda.exemplo.com/${b.slug}` : null) },
  };

  // Auto-recuperação: na 2ª repetição, manda só a última mensagem do cliente (sem
  // o histórico que estava enviesando o modelo). Recomeço limpo, sem apagar nada.
  const historico = contextoLimpo
    ? historicoParaIA(msgs.filter((m) => m.autor === 'cliente').slice(-1))
    : historicoParaIA(msgs);

  let respostaIA = null;
  try {
    const { texto: resp, usage, ferramentas, semTexto } = await secretaria.responder(ctx, historico);
    respostaIA = resp;
    // TRAVA anti-spam de NÃO-RESPOSTA: quando a IA não consegue responder de
    // verdade (texto vazio -> "pode repetir?") e a resposta ANTERIOR também já
    // foi uma não-resposta, para de repetir e passa pra um humano.
    if (semTexto) {
      const ultimaIa = await prisma.mensagem.findFirst({ where: { conversaId: conversa.id, autor: 'ia' }, orderBy: { criadoEm: 'desc' } });
      const anteriorNaoResp = ultimaIa && /desculpa, pode repetir|vou te transferir|instabilidade/i.test((ultimaIa.texto || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
      if (anteriorNaoResp) {
        console.log('[atendimento] TRAVA nao-resposta -> humano, conversa', conversa.id);
        await prisma.conversa.update({ where: { id: conversa.id }, data: { iaAtiva: false } });
        await emitir(conversa, 'ia', 'Deixa eu chamar alguém da equipe pra te ajudar com isso, tá? 🙂 Já já te respondem por aqui.');
        await notificacoes.notificarHumanoSolicitado(barbeariaId, conversa);
        return { conversaId: conversa.id, travaNaoResposta: true };
      }
    }
    // Diagnóstico: a IA AFIRMOU que agendou/cancelou/remarcou sem ter chamado a
    // ferramenta que faz isso de verdade? (alucinação — o horário não foi mexido).
    const afirmaAgendou = /\b(agendad|agendei|marcad|marquei|confirmad|confirmei|reservad|reservei|cancelad|cancelei|remarcad|remarquei)/i
      .test((resp || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
    const ferramentaAcao = (ferramentas || []).some((f) => ['criar_agendamento', 'cancelar_agendamento', 'reagendar_agendamento'].includes(f));
    if (afirmaAgendou && !ferramentaAcao) {
      console.log('[atendimento] ALERTA: IA alegou agendar/cancelar SEM chamar a ferramenta. conversa', conversa.id, '| ferramentas:', JSON.stringify(ferramentas || []));
    }
    await emitir(conversa, 'ia', (await avisoPrivacidadeSeNovo(barbeariaId, conversa.id)) + resp);
    await registrarUso(barbeariaId, teto.competencia, usage);
    // HANDOFF DETERMINÍSTICO: se a IA ANUNCIOU que vai chamar a equipe mas a IA
    // ainda está ativa (a ferramenta encaminhar_humano não foi de fato chamada),
    // o código executa o handoff: pausa a IA e notifica a equipe. Assim o "já
    // chamei a equipe" nunca é só da boca pra fora — e para o loop de repetição.
    if (anunciaHandoff(resp)) {
      const atual = await prisma.conversa.findUnique({ where: { id: conversa.id } });
      if (atual && atual.iaAtiva) {
        console.log('[atendimento] handoff FORCADO (a IA anunciou na resposta) conversa', conversa.id, '| resp:', JSON.stringify(resp.slice(0, 80)));
        await prisma.conversa.update({ where: { id: conversa.id }, data: { iaAtiva: false } });
        await notificacoes.notificarHumanoSolicitado(barbeariaId, conversa);
      } else {
        console.log('[atendimento] IA chamou encaminhar_humano (ferramenta) conversa', conversa.id);
      }
    }
  } catch (e) {
    // Log detalhado: e.message às vezes vem vazio (ex.: erro da API Anthropic traz
    // o detalhe em .status/.error). Sem isso não dá pra saber por que a IA caiu.
    console.error('[atendimento] IA falhou:', e && (e.message || e.name || String(e)));
    if (e && e.status) console.error('[atendimento] IA status:', e.status);
    if (e && e.error) { try { console.error('[atendimento] IA erro:', JSON.stringify(e.error)); } catch (_) {} }
    if (e && e.stack) console.error('[atendimento] IA stack:', e.stack);
    // Nunca deixar o cliente sem resposta: manda um recado curto (fica gravado na
    // conversa mesmo se o envio falhar) para ele não achar que ninguém viu.
    try {
      await emitir(conversa, 'ia', 'Tive uma instabilidade rapidinha por aqui 😅 Pode mandar de novo, por favor? Se preferir, escreva SAIR para falar com um atendente.');
    } catch (_) { /* envio pode falhar; a mensagem já foi tentada */ }
  }
  return { conversaId: conversa.id, respostaIA };
}

// Lista de conversas da barbearia (mais recentes primeiro).
async function listarConversas(barbeariaId) {
  return prisma.conversa.findMany({
    where: { barbeariaId, status: 'aberta' },
    orderBy: { ultimaMensagemEm: 'desc' },
    take: 50,
  });
}

async function abrirConversa(barbeariaId, conversaId) {
  const conversa = await prisma.conversa.findFirst({ where: { id: Number(conversaId), barbeariaId } });
  if (!conversa) return null;
  if (conversa.naoLidas > 0) {
    await prisma.conversa.update({ where: { id: conversa.id }, data: { naoLidas: 0 } });
    conversa.naoLidas = 0;
  }
  const mensagens = await prisma.mensagem.findMany({ where: { conversaId: conversa.id }, orderBy: { criadoEm: 'asc' } });
  // Tiques azuis pro cliente: marca como lida a última mensagem dele.
  const ultimaDoCliente = [...mensagens].reverse().find((m) => m.autor === 'cliente' && m.waId);
  if (ultimaDoCliente) whatsapp.marcarLida(barbeariaId, ultimaDoCliente.waId).catch(() => {});
  return { conversa, mensagens };
}

async function responderComoHumano(barbeariaId, conversaId, texto) {
  const conversa = await prisma.conversa.findFirst({ where: { id: Number(conversaId), barbeariaId } });
  if (!conversa || !texto) return null;
  await emitir(conversa, 'humano', texto);
  return conversa;
}

// Humano envia MÍDIA pelo painel (foto, vídeo, áudio gravado, documento).
async function enviarMidiaComoHumano(barbeariaId, conversaId, { buffer, mime, nome, legenda }) {
  const conversa = await prisma.conversa.findFirst({ where: { id: Number(conversaId), barbeariaId } });
  if (!conversa || !buffer) return null;
  const tipo = waMidia.tipoDoMime(mime);
  const arquivo = waMidia.salvar(buffer, mime, nome);
  const texto = semSurrogatesSoltos(String(legenda || '').slice(0, 1024));
  const msg = await prisma.mensagem.create({
    data: { conversaId: conversa.id, autor: 'humano', texto, tipo, midiaArquivo: arquivo, midiaMime: mime, midiaNome: nome || null },
  });
  await prisma.conversa.update({
    where: { id: conversa.id },
    data: { ultimaPrevia: previa(ROTULO_MIDIA[tipo] + (texto ? ' ' + texto : '')), ultimaMensagemEm: new Date() },
  });
  const r = await whatsapp.enviarMidia(barbeariaId, conversa.clienteTelefone, {
    tipo: waMidia.TIPO_API[tipo], buffer, mime: String(mime).split(';')[0], nome, legenda: texto,
  });
  await registrarEnvio(msg.id, r);
  return { conversa, ok: !!(r && r.ok), erro: r && r.erro };
}

async function definirIA(barbeariaId, conversaId, ativa) {
  const conversa = await prisma.conversa.findFirst({ where: { id: Number(conversaId), barbeariaId } });
  if (!conversa) return null;
  // Ao DEVOLVER à IA, marca o recomeço do contexto: daqui pra frente ela ignora o
  // histórico antigo (evita repetir o handoff). Ao ASSUMIR (humano), não mexe.
  const data = { iaAtiva: !!ativa };
  if (ativa) data.iaContextoDesde = new Date();
  return prisma.conversa.update({ where: { id: conversa.id }, data });
}

// Mensagens de uma conversa com id MAIOR que `aposId` (para o polling do chat).
// Zera as não-lidas se chegou algo novo (a equipe está com a conversa aberta).
async function mensagensApos(barbeariaId, conversaId, aposId) {
  const conversa = await prisma.conversa.findFirst({ where: { id: Number(conversaId), barbeariaId } });
  if (!conversa) return null;
  const msgs = await prisma.mensagem.findMany({
    where: { conversaId: conversa.id, id: { gt: Number(aposId) || 0 } },
    orderBy: { criadoEm: 'asc' },
  });
  if (msgs.length && conversa.naoLidas > 0) {
    await prisma.conversa.update({ where: { id: conversa.id }, data: { naoLidas: 0 } });
  }
  const novaDoCliente = [...msgs].reverse().find((m) => m.autor === 'cliente' && m.waId);
  if (novaDoCliente) whatsapp.marcarLida(barbeariaId, novaDoCliente.waId).catch(() => {});
  return { conversa, msgs };
}

// { mensagemId: status } das últimas mensagens de saída (tiques no polling).
async function statusRecentes(conversaId) {
  const ms = await prisma.mensagem.findMany({
    where: { conversaId, autor: { not: 'cliente' } },
    orderBy: { id: 'desc' }, take: 40, select: { id: true, statusEnvio: true },
  });
  const out = {};
  ms.forEach((m) => { out[m.id] = m.statusEnvio || null; });
  return out;
}

// LGPD: exclui uma conversa e todas as suas mensagens (direito de exclusão).
// Escopado por barbearia — nunca apaga de outro tenant.
async function excluirConversa(barbeariaId, conversaId) {
  const r = await prisma.conversa.deleteMany({ where: { id: Number(conversaId), barbeariaId } });
  return r.count > 0;
}

// LGPD: retenção. Apaga conversas sem atividade há mais de RETENCAO_MESES.
// Roda por um cron (scripts/retencao-conversas.js). Retorna quantas apagou.
async function expirarConversasAntigas() {
  const limite = new Date();
  limite.setMonth(limite.getMonth() - RETENCAO_MESES);
  const r = await prisma.conversa.deleteMany({ where: { ultimaMensagemEm: { lt: limite } } });
  return r.count;
}

module.exports = {
  receberMensagemCliente,
  enviarMidiaComoHumano,
  statusRecentes,
  atualizarStatusEnvio,
  ROTULO_MIDIA,
  listarConversas,
  abrirConversa,
  mensagensApos,
  responderComoHumano,
  definirIA,
  excluirConversa,
  expirarConversasAntigas,
  estadoTeto,
  estadoTetoCopiloto,
  registrarUsoCopiloto,
};
