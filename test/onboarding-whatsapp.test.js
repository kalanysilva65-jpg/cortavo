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

test('modo Cortavo: erro da Meta mantém as chaves e sobe a mensagem', async () => {
  const c = cenario(CHAVES, { status: 400, corpo: { error: { message: 'Invalid parameter' } } });
  try {
    const ob = carregar('src/services/whatsappOnboard.js', { prisma: c.prisma });
    await assert.rejects(() => ob.desconectar(7), /Invalid parameter/);
    assert.equal(c.apagadas.length, 0);
    assert.equal(c.banco.whatsapp_phone_number_id, '111222');
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

test('controller: sucesso e erro vão para a auditoria; erro mostra a mensagem e diz que nada foi apagado', async () => {
  const auditorias = [];
  const stubAud = { registrar: async (_r, a) => { auditorias.push(a); } };
  let ctrl = carregar('src/controllers/secretariaController.js', { stubs: {
    'src/services/auditoria.js': stubAud,
    'src/services/whatsappOnboard.js': { desconectar: async () => ({ desregistrado: true }) },
  } });
  let req = reqFalso({ barbeariaId: 7, session: { usuario: { id: 1, nome: 'Ana', papel: 'admin' } } });
  let res = resFalso();
  await ctrl.desconectarWhatsApp(req, res);
  assert.equal(res.redirecionou, '/painel/secretaria');
  assert.equal(req.session.flash.tipo, 'sucesso');
  assert.equal(auditorias[0].acao, 'whatsapp.desconectar');

  ctrl = carregar('src/controllers/secretariaController.js', { stubs: {
    'src/services/auditoria.js': stubAud,
    'src/services/whatsappOnboard.js': { desconectar: async () => { throw new Error('Invalid parameter'); } },
  } });
  req = reqFalso({ barbeariaId: 7, session: { usuario: { id: 1, nome: 'Ana', papel: 'admin' } } });
  res = resFalso();
  await ctrl.desconectarWhatsApp(req, res);
  assert.equal(req.session.flash.tipo, 'erro');
  assert.match(req.session.flash.texto, /Invalid parameter/);
  assert.match(req.session.flash.texto, /Nada foi apagado/);
  assert.equal(auditorias[1].acao, 'whatsapp.desconectar_falhou');
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
