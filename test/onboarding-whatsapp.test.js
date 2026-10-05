// Onboarding do WhatsApp (proposta da Manu, seção 6): Desconectar libera o
// número na Meta (deregister). Meta SIMULADA: fetch falso, nenhuma chamada real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

const CHAVES = { whatsapp_phone_number_id: '111222', whatsapp_modo: 'cortavo', whatsapp_pin: '123456', whatsapp_numero: '+55 11 90000-0000' };

function cenario(config, respostaMeta) {
  const banco = { ...config };
  const chamadas = [];
  const apagadas = [];
  const prisma = prismaFalso({
    configuracao: {
      findMany: async ({ where }) => Object.entries(banco).filter(([k]) => where.chave.in.includes(k)).map(([chave, valor]) => ({ chave, valor })),
      deleteMany: async ({ where }) => { for (const k of where.chave.in) if (k in banco) { apagadas.push(k); delete banco[k]; } return {}; },
    },
  });
  const fetchOriginal = global.fetch;
  global.fetch = async (url, opts) => {
    chamadas.push({ url: String(url), opts });
    if (respostaMeta instanceof Error) throw respostaMeta;
    return { ok: respostaMeta.status < 400, status: respostaMeta.status, json: async () => respostaMeta.corpo };
  };
  const restaurar = () => { global.fetch = fetchOriginal; };
  return { banco, chamadas, apagadas, prisma, restaurar };
}

test.beforeEach(() => { process.env.WHATSAPP_SYSTEM_TOKEN = 'token-falso-de-teste'; delete process.env.WHATSAPP_API_VERSION; });
test.afterEach(() => { delete process.env.WHATSAPP_SYSTEM_TOKEN; });

test('modo Cortavo: chama POST /{phone_number_id}/deregister com o token da Cortavo e só então apaga', async () => {
  const c = cenario(CHAVES, { status: 200, corpo: { success: true } });
  try {
    const ob = carregar('src/services/whatsappOnboard.js', { prisma: c.prisma });
    const r = await ob.desconectar(7);
    assert.equal(r.desregistrado, true);
    assert.equal(c.chamadas.length, 1);
    assert.equal(c.chamadas[0].url, 'https://graph.facebook.com/v21.0/111222/deregister');
    assert.equal(c.chamadas[0].opts.method, 'POST');
    assert.equal(c.chamadas[0].opts.headers.Authorization, 'Bearer token-falso-de-teste');
    assert.deepEqual(Object.keys(c.banco), [], 'chaves apagadas');
  } finally { c.restaurar(); }
});

test('modo Cortavo: erro da Meta mantém as chaves; tela recebe só o texto amigável, técnico vai à parte (B2)', async () => {
  const c = cenario(CHAVES, { status: 400, corpo: { error: { message: '(#100) Invalid parameter phone_number_id', code: 100, fbtrace_id: 'AbC' } } });
  try {
    const ob = carregar('src/services/whatsappOnboard.js', { prisma: c.prisma });
    const e = await ob.desconectar(7).then(() => null, (x) => x);
    assert.ok(e);
    assert.equal(e.fase, 'meta');
    assert.equal(e.mensagemTela, null, 'sem error_user_msg: a tela usa o texto genérico');
    assert.match(e.tecnico, /code=100/);
    assert.match(e.tecnico, /fbtrace_id=AbC/);
    assert.equal(c.apagadas.length, 0);
    assert.equal(c.banco.whatsapp_phone_number_id, '111222');
  } finally { c.restaurar(); }
});

test('M1: número que a Meta diz já não estar registrado conta como sucesso e limpa o cadastro', async () => {
  const c = cenario(CHAVES, { status: 400, corpo: { error: { message: 'Account not registered', code: 133010 } } });
  try {
    const ob = carregar('src/services/whatsappOnboard.js', { prisma: c.prisma });
    const r = await ob.desconectar(7);
    assert.equal(r.desregistrado, true);
    assert.equal(r.jaLiberado, true);
    assert.deepEqual(Object.keys(c.banco), []);
  } finally { c.restaurar(); }
});

test('M1: Meta liberou mas o banco falhou: tenta de novo; se passar, sucesso', async () => {
  const c = cenario(CHAVES, { status: 200, corpo: { success: true } });
  try {
    let falhas = 1;
    const del = c.prisma.configuracao.deleteMany;
    c.prisma.configuracao.deleteMany = async (a) => { if (falhas-- > 0) throw new Error('database is locked'); return del(a); };
    const ob = carregar('src/services/whatsappOnboard.js', { prisma: c.prisma });
    const r = await ob.desconectar(7);
    assert.equal(r.desregistrado, true);
    assert.deepEqual(Object.keys(c.banco), []);
  } finally { c.restaurar(); }
});

test('M1: Meta liberou e o banco falhou duas vezes: erro de fase "banco" (não "nada foi apagado")', async () => {
  const c = cenario(CHAVES, { status: 200, corpo: { success: true } });
  try {
    c.prisma.configuracao.deleteMany = async () => { throw new Error('database is locked'); };
    const ob = carregar('src/services/whatsappOnboard.js', { prisma: c.prisma });
    const e = await ob.desconectar(7).then(() => null, (x) => x);
    assert.equal(e.fase, 'banco');
    assert.equal(e.desregistrado, true);
    assert.equal(e.final4, '0000');
  } finally { c.restaurar(); }
});

test('modo Cortavo: Meta fora do ar (fetch falha) também mantém as chaves', async () => {
  const c = cenario(CHAVES, new Error('ECONNRESET'));
  try {
    const ob = carregar('src/services/whatsappOnboard.js', { prisma: c.prisma });
    await assert.rejects(() => ob.desconectar(7), /Meta/);
    assert.equal(c.apagadas.length, 0);
  } finally { c.restaurar(); }
});

test('coexistência (barbearia antiga): como antes, só apaga no banco, sem chamar a Meta', async () => {
  const c = cenario({ whatsapp_phone_number_id: '999', whatsapp_token: 't' }, { status: 500, corpo: {} });
  try {
    const ob = carregar('src/services/whatsappOnboard.js', { prisma: c.prisma });
    const r = await ob.desconectar(7);
    assert.equal(r.desregistrado, false);
    assert.equal(c.chamadas.length, 0);
    assert.deepEqual(Object.keys(c.banco), []);
  } finally { c.restaurar(); }
});

function controllerCom(desconectar, { push = [] } = {}) {
  const auditorias = [];
  const prisma = prismaFalso({ usuario: { findMany: async () => [{ id: 1 }] } });
  const ctrl = carregar('src/controllers/secretariaController.js', { prisma, stubs: {
    'src/services/auditoria.js': { registrar: async (_r, a) => { auditorias.push(a); } },
    'src/services/whatsappOnboard.js': { desconectar },
    'src/services/notificacoes.js': { enviarParaUsuario: async (id, a) => { push.push({ id, a }); return 1; } },
  } });
  return { ctrl, auditorias, push };
}
const reqDesc = (confirmacao) => reqFalso({ barbeariaId: 7, body: { confirmacao }, session: { usuario: { id: 2, nome: 'Ana', papel: 'admin' } } });

test('confirmação no servidor: sem digitar DESCONECTAR nada acontece (substitui o confirm do navegador)', async () => {
  let chamou = false;
  const { ctrl } = controllerCom(async () => { chamou = true; return {}; });
  for (const v of [undefined, '', 'sim', 'desconecta']) {
    const req = reqDesc(v);
    await ctrl.desconectarWhatsApp(req, resFalso());
    assert.equal(req.session.flash.tipo, 'erro');
    assert.match(req.session.flash.texto, /digite DESCONECTAR/);
  }
  assert.equal(chamou, false);
  const tela = fs.readFileSync(path.join(RAIZ, 'src/views/painel/secretaria-config.ejs'), 'utf8');
  assert.match(tela, /name="confirmacao"/);
  assert.doesNotMatch(tela, /whatsapp\/desconectar" onsubmit/);
});

test('sucesso (minúsculas aceitas): auditoria com final do número e aviso por push à Kalany', async () => {
  const { ctrl, auditorias, push } = controllerCom(async () => ({ desregistrado: true, jaLiberado: false, final4: '1234' }));
  const req = reqDesc(' desconectar ');
  const res = resFalso();
  await ctrl.desconectarWhatsApp(req, res);
  assert.equal(res.redirecionou, '/painel/secretaria');
  assert.equal(req.session.flash.tipo, 'sucesso');
  assert.equal(auditorias[0].acao, 'whatsapp.desconectar');
  assert.match(auditorias[0].detalhe, /final 1234/);
  assert.match(auditorias[0].detalhe, /WhatsApp Manager/);
  assert.equal(push.length, 1);
  assert.match(push[0].a.corpo, /WhatsApp Manager/);
});

test('erro da Meta: tela amigável (sem texto técnico), técnico só na auditoria', async () => {
  const err = Object.assign(new Error('x'), { fase: 'meta', mensagemTela: null, tecnico: 'HTTP 400 code=100 msg=(#100) Invalid parameter' });
  const { ctrl, auditorias, push } = controllerCom(async () => { throw err; });
  const req = reqDesc('DESCONECTAR');
  await ctrl.desconectarWhatsApp(req, resFalso());
  assert.equal(req.session.flash.tipo, 'erro');
  assert.match(req.session.flash.texto, /A Meta não aceitou agora/);
  assert.match(req.session.flash.texto, /cortavo\.app@gmail\.com/);
  assert.match(req.session.flash.texto, /Nada foi apagado/);
  assert.doesNotMatch(req.session.flash.texto, /#100|Invalid parameter|HTTP/);
  assert.equal(auditorias[0].acao, 'whatsapp.desconectar_falhou');
  assert.match(auditorias[0].detalhe, /Invalid parameter/);
  assert.equal(push.length, 0);
});

test('M1 controller: falha só no banco grava "desconectar_parcial" com mensagem verdadeira e avisa a Kalany', async () => {
  const err = Object.assign(new Error('x'), { fase: 'banco', desregistrado: true, tecnico: 'database is locked', final4: '1234' });
  const { ctrl, auditorias, push } = controllerCom(async () => { throw err; });
  const req = reqDesc('DESCONECTAR');
  await ctrl.desconectarWhatsApp(req, resFalso());
  assert.match(req.session.flash.texto, /liberado na Meta, mas não conseguimos limpar o cadastro/);
  assert.doesNotMatch(req.session.flash.texto, /Nada foi apagado/);
  assert.equal(auditorias[0].acao, 'whatsapp.desconectar_parcial');
  assert.equal(push.length, 1);
});

test('páginas legais: seção 4 nova, planos atuais, responsável Cortavo, prazos, sem documento', () => {
  const termos = fs.readFileSync(path.join(RAIZ, 'src/views/legal/termos.ejs'), 'utf8');
  for (const t of ['4.1 O número é da barbearia', '4.7 Disponibilidade', 'em até 5 dias úteis', 'em até 30 dias', 'R$ 69', 'R$ 129', 'R$ 249', 'fora do app', 'Não há fidelidade']) assert.ok(termos.includes(t), t);
  assert.doesNotMatch(termos, /combinada à parte/);
  const priv = fs.readFileSync(path.join(RAIZ, 'src/views/legal/privacidade.ejs'), 'utf8');
  for (const t of ['controladora', 'operadora', 'suboperadores', 'Responsável: Cortavo', 'por 30 dias', 'art. 33 da LGPD']) assert.ok(priv.includes(t), t);
  for (const txt of [termos, priv]) {
    assert.doesNotMatch(txt, /CNPJ|CPF|\[/, 'sem documento e sem pendência entre colchetes');
  }
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/auth.js'), 'utf8');
  assert.equal((rotas.match(/atualizadoEm: '5 de outubro de 2026'/g) || []).length, 2);
  assert.equal((rotas.match(/SUPORTE_CORTAVO/g) || []).length, 2);
});

test('textos: tela da secretária e ONBOARDING com o fluxo novo; contato numa constante única', () => {
  const tela = fs.readFileSync(path.join(RAIZ, 'src/views/painel/secretaria-config.ejs'), 'utf8');
  assert.match(tela, /a Cortavo paga as mensagens para a Meta/);
  assert.match(tela, /número é liberado na Meta para voltar ao app do WhatsApp/);
  assert.match(tela, /suporteCortavo/);
  const { SUPORTE_CORTAVO } = require(path.join(RAIZ, 'src/config/constantes.js'));
  assert.equal(SUPORTE_CORTAVO, 'cortavo.app@gmail.com');
  const onb = fs.readFileSync(path.join(RAIZ, 'deploy/ONBOARDING-BARBEARIA.md'), 'utf8');
  assert.match(onb, /WhatsApp pela conta da Cortavo/);
  assert.match(onb, /Se a barbearia sair da Cortavo/);
});
