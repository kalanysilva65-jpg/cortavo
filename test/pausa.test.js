// Spec 01 (pausa de verdade): com a barbearia pausada (ativo = false) nada que
// gera uso ou custo pode rodar. Tudo simulado: sem banco, sem WhatsApp, sem IA.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

const PAUSADA = { id: 7, nome: 'Barbearia Teste', slug: 'teste', ativo: false };
const ATIVA = { ...PAUSADA, ativo: true };
const HASH = bcrypt.hashSync('certa', 4);
const ADMIN = { id: 1, nome: 'Ana', papel: 'admin', barbeariaId: 7, ativo: true, senhaHash: HASH };

// ---------- Login (critério 1) ----------
function authCom(barbearia, usuario) {
  const prisma = prismaFalso({
    usuario: {
      findFirst: async () => null,
      findMany: async () => [usuario],
      findUnique: async () => usuario,
    },
    barbearia: {
      findUnique: async () => barbearia,
    },
  });
  return carregar('src/controllers/authController.js', { prisma });
}

test('login: admin com senha certa NÃO entra em barbearia pausada (domínio raiz)', async () => {
  const auth = authCom(PAUSADA, ADMIN);
  const req = reqFalso({ body: { email: 'ana@x.com', senha: 'certa' } });
  const res = resFalso();
  await auth.fazerLogin(req, res);
  assert.equal(req.session.usuario, undefined, 'não pode criar sessão');
  assert.equal(res.renderizou && res.renderizou.view, 'auth/acesso-pausado');
});

test('login: admin com senha certa NÃO entra pelo subdomínio de barbearia pausada', async () => {
  const auth = authCom(PAUSADA, ADMIN);
  const req = reqFalso({ slugBarbearia: 'teste', barbearia: null, body: { email: 'ana@x.com', senha: 'certa' } });
  const res = resFalso();
  await auth.fazerLogin(req, res);
  assert.equal(req.session.usuario, undefined);
  assert.equal(res.renderizou && res.renderizou.view, 'auth/acesso-pausado');
});

test('login: senha errada em barbearia pausada continua "e-mail ou senha inválidos" (não vaza a pausa)', async () => {
  const auth = authCom(PAUSADA, ADMIN);
  const req = reqFalso({ body: { email: 'ana@x.com', senha: 'errada' } });
  const res = resFalso();
  await auth.fazerLogin(req, res);
  assert.equal(res.redirecionou, '/login');
  assert.equal(req.session.usuario, undefined);
  assert.equal(res.renderizou, null);
});

test('login: barbearia ativa entra normalmente', async () => {
  const auth = authCom(ATIVA, ADMIN);
  const req = reqFalso({ body: { email: 'ana@x.com', senha: 'certa' } });
  const res = resFalso();
  await auth.fazerLogin(req, res);
  assert.equal(res.redirecionou, '/painel');
  assert.equal(req.session.usuario.barbeariaId, 7);
});

// ---------- Sessão aberta (critério 2) e Kalany (critério 9) ----------
function tenantCom(barbearia) {
  return carregar('src/middlewares/tenant.js', {
    prisma: prismaFalso({ barbearia: { findUnique: async () => barbearia } }),
  });
}

test('painel: barbeiro com sessão aberta cai na tela de pausa no próximo clique', async () => {
  const { exigeBarbeariaPainel } = tenantCom(PAUSADA);
  const req = reqFalso({ session: { usuario: { id: 2, papel: 'funcionario', barbeariaId: 7 } } });
  const res = resFalso();
  let seguiu = false;
  await exigeBarbeariaPainel(req, res, () => { seguiu = true; });
  assert.equal(seguiu, false);
  assert.equal(res.renderizou && res.renderizou.view, 'auth/acesso-pausado');
  assert.equal(req.session.destruida, true, 'a sessão deve ser encerrada');
});

test('painel: a Kalany (papel dono) abre a barbearia pausada pelo painel-mestre', async () => {
  const { exigeBarbeariaPainel } = tenantCom(PAUSADA);
  const req = reqFalso({ session: { usuario: { id: 99, papel: 'dono' }, barbeariaAtivaId: 7 } });
  let seguiu = false;
  await exigeBarbeariaPainel(req, resFalso(), () => { seguiu = true; });
  assert.equal(seguiu, true);
  assert.equal(req.barbeariaId, 7);
});

test('painel: barbearia ativa segue normal', async () => {
  const { exigeBarbeariaPainel } = tenantCom(ATIVA);
  const req = reqFalso({ session: { usuario: { id: 2, papel: 'funcionario', barbeariaId: 7 } } });
  let seguiu = false;
  await exigeBarbeariaPainel(req, resFalso(), () => { seguiu = true; });
  assert.equal(seguiu, true);
});

// ---------- Secretária (critério 3) ----------
function atendimentoCom(barbearia, registro) {
  const prisma = prismaFalso({
    barbearia: { findUnique: async () => barbearia },
    conversa: {
      findUnique: async () => ({ id: 1, barbeariaId: 7, iaAtiva: true, clienteNome: 'Zé', clienteTelefone: '5551999990000' }),
      create: async () => assert.fail('não deveria criar'),
      update: async () => ({}),
    },
    mensagem: {
      create: async ({ data }) => { registro.salvas.push(data); return { id: 1, ...data }; },
      findFirst: async () => ({ texto: 'oi' }),
      count: async () => { registro.ia++; return 0; },
    },
    configuracao: { findUnique: async () => null },
    usoIA: { upsert: async () => { registro.uso++; }, findUnique: async () => null },
  });
  const nada = async () => ({ ok: true });
  return carregar('src/services/atendimento.js', {
    prisma,
    stubs: {
      'src/services/secretaria.js': { habilitada: () => true, responder: async () => { registro.ia++; return { texto: 'resposta', usage: {} }; } },
      'src/services/faq.js': { tentarResponder: async () => { registro.ia++; return null; } },
      'src/services/whatsapp.js': { enviarTexto: async () => { registro.envios++; return { ok: true }; }, enviarMidia: nada },
      'src/services/waMidia.js': {},
      'src/services/notificacoes.js': { notificarHumanoSolicitado: async () => { registro.envios++; }, notificarNovaMensagem: nada },
    },
  });
}

test('secretária: mensagem em barbearia pausada é salva e não gera IA, envio nem uso', async () => {
  const registro = { salvas: [], ia: 0, envios: 0, uso: 0 };
  const atendimento = atendimentoCom(PAUSADA, registro);
  const r = await atendimento.receberMensagemCliente(7, { telefone: '5551999990000', nome: 'Zé', texto: 'quero marcar' });
  assert.equal(registro.salvas.length, 1, 'mensagem salva em Conversas');
  assert.equal(registro.ia, 0, 'IA/FAQ não rodam');
  assert.equal(registro.envios, 0, 'nada é enviado');
  assert.equal(registro.uso, 0, 'sem consumo em UsoIA');
  assert.equal(r.respostaIA, null);
});

test('secretária: em barbearia pausada nem o "SAIR" gera resposta', async () => {
  const registro = { salvas: [], ia: 0, envios: 0, uso: 0 };
  const atendimento = atendimentoCom(PAUSADA, registro);
  await atendimento.receberMensagemCliente(7, { telefone: '5551999990000', texto: 'SAIR' });
  assert.equal(registro.salvas.length, 1);
  assert.equal(registro.envios, 0);
});

// ---------- Webhook responde 200 (risco da spec) ----------
test('webhook: barbearia pausada ainda recebe 200 (a Meta não reenvia)', async () => {
  const webhook = carregar('src/controllers/webhookController.js', {
    stubs: {
      'src/services/atendimento.js': { receberMensagemCliente: async () => ({}), atualizarStatusEnvio: async () => {} },
      'src/services/whatsapp.js': { barbeariaPorPhoneNumberId: async () => 7 },
      'src/services/transcricao.js': {},
      'src/services/waMidia.js': {},
    },
  });
  delete process.env.META_APP_SECRET;
  delete process.env.APP_DOMAIN;
  const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1' }, messages: [{ from: '555', id: 'w', type: 'text', text: { body: 'oi' } }] } }] }] };
  const req = reqFalso({ get: () => '', body });
  const res = resFalso();
  await webhook.receber(req, res);
  assert.equal(res.statusCode, 200);
});

// ---------- Assistente (critério 4) ----------
function iaCom(barbearia, registro) {
  return carregar('src/controllers/iaController.js', {
    prisma: prismaFalso({ barbearia: { findUnique: async () => barbearia } }),
    stubs: {
      'src/services/ia.js': { iaHabilitada: () => true, responder: async () => { registro.ia++; return { texto: 'ok', usage: {} }; } },
      'src/services/atendimento.js': {
        estadoTetoCopiloto: async () => ({ atingido: false, teto: 200 }),
        registrarUsoCopiloto: async () => { registro.uso++; },
      },
      'src/services/agendamentoSeguro.js': {},
    },
  });
}

test('assistente: barbearia pausada responde a mensagem de pausa e não consome consulta', async () => {
  const registro = { ia: 0, uso: 0 };
  const ctrl = iaCom(PAUSADA, registro);
  const req = reqFalso({ barbeariaId: 7, ehAdmin: true, body: { mensagem: 'quanto faturei?' }, session: { usuario: { id: 99, papel: 'dono' } } });
  const res = resFalso();
  await ctrl.mensagem(req, res);
  assert.equal(registro.ia, 0);
  assert.equal(registro.uso, 0);
  assert.match(String(res.enviado && res.enviado.resposta), /pausad/i);
});

test('assistente: barbearia ativa responde normal', async () => {
  const registro = { ia: 0, uso: 0 };
  const ctrl = iaCom(ATIVA, registro);
  const req = reqFalso({ barbeariaId: 7, ehAdmin: true, body: { mensagem: 'oi' }, session: { usuario: { id: 1, papel: 'admin' } } });
  await ctrl.mensagem(req, resFalso());
  assert.equal(registro.ia, 1);
});

// ---------- Lembretes (critério 5 e regra 6) ----------
function lembretesCom(ativo, registro) {
  const daqui30 = new Date(Date.now() + 30 * 60000);
  const hh = String(daqui30.getHours()).padStart(2, '0');
  const mm = String(daqui30.getMinutes()).padStart(2, '0');
  const ag = {
    id: 1, clienteNome: 'Zé', clienteTelefone: '(00) 99999-0000',
    data: new Date(daqui30.getFullYear(), daqui30.getMonth(), daqui30.getDate()), horaInicio: hh + ':' + mm,
  };
  const prisma = prismaFalso({
    configuracao: { findMany: async () => [
      { barbeariaId: 7, chave: 'lembretes_ativos', valor: '1' },
      { barbeariaId: 7, chave: 'whatsapp_phone_number_id', valor: 'p' },
      { barbeariaId: 7, chave: 'whatsapp_token', valor: 't' },
    ] },
    barbearia: {
      findUnique: async () => ({ nome: 'Teste', ativo }),
      findMany: async ({ where } = {}) => [{ id: 7, ativo }].filter((b) => !where || where.ativo === undefined || b.ativo === where.ativo),
    },
    agendamento: { findMany: async () => [ag], update: async () => {} },
    lembreteLog: { create: async () => { registro.logs++; } },
  });
  return carregar('src/services/lembretes.js', {
    prisma,
    stubs: {
      'src/services/whatsapp.js': { enviarTemplate: async () => { registro.envios++; return { ok: true }; } },
      'src/utils/telefone.js': { telefoneCanonicoBR: () => '00999990000' },
    },
  });
}

test('lembretes: barbearia pausada não envia nada nem cria LembreteLog', async () => {
  const registro = { envios: 0, logs: 0 };
  await lembretesCom(false, registro).dispararDevidos();
  assert.equal(registro.envios, 0);
  assert.equal(registro.logs, 0);
});

test('lembretes: barbearia ativa envia (reativar devolve os lembretes futuros)', async () => {
  const registro = { envios: 0, logs: 0 };
  await lembretesCom(true, registro).dispararDevidos();
  assert.equal(registro.envios, 1);
  assert.equal(registro.logs, 1);
});
