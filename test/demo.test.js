// Spec 03 (demonstração segura): na demo e na vitrine ninguém real recebe
// mensagem. Tudo simulado: sem banco, sem WhatsApp, sem IA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { RAIZ, carregar, prismaFalso } = require('./helpers/ambiente');

function lembretesCom(slug, registro) {
  const daqui30 = new Date(Date.now() + 30 * 60000);
  const ag = {
    id: 1, clienteNome: 'Zé', clienteTelefone: '(00) 99999-0000',
    data: new Date(daqui30.getFullYear(), daqui30.getMonth(), daqui30.getDate()),
    horaInicio: String(daqui30.getHours()).padStart(2, '0') + ':' + String(daqui30.getMinutes()).padStart(2, '0'),
  };
  const barbs = [{ id: 7, slug, nome: 'Teste', ativo: true }];
  const prisma = prismaFalso({
    configuracao: { findMany: async () => [
      { barbeariaId: 7, chave: 'lembretes_ativos', valor: '1' },
      { barbeariaId: 7, chave: 'whatsapp_phone_number_id', valor: 'p' },
      { barbeariaId: 7, chave: 'whatsapp_token', valor: 't' },
    ] },
    barbearia: {
      findUnique: async () => barbs[0],
      findMany: async ({ where }) => barbs.filter((b) => {
        if (where.slug && where.slug.in) return where.slug.in.includes(b.slug);
        if (where.ativo !== undefined) return b.ativo === where.ativo;
        return true;
      }),
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

for (const slug of ['demo', 'vitrine']) {
  test(`lembretes: "${slug}" não envia nem cria LembreteLog, mesmo com lembretes_ativos = 1`, async () => {
    const registro = { envios: 0, logs: 0 };
    await lembretesCom(slug, registro).dispararDevidos();
    assert.equal(registro.envios, 0);
    assert.equal(registro.logs, 0);
  });
}

test('lembretes: barbearia comum continua recebendo', async () => {
  const registro = { envios: 0, logs: 0 };
  await lembretesCom('navalha', registro).dispararDevidos();
  assert.equal(registro.envios, 1);
});

function atendimentoCom(slug, registro) {
  const prisma = prismaFalso({
    barbearia: { findUnique: async () => ({ id: 7, slug, ativo: true }) },
    conversa: {
      findUnique: async () => ({ id: 1, barbeariaId: 7, iaAtiva: true, clienteNome: 'Zé' }),
      update: async () => ({}),
    },
    mensagem: {
      create: async ({ data }) => { registro.salvas++; return { id: 1, ...data }; },
      findFirst: async () => ({ texto: 'oi' }),
      count: async () => { registro.ia++; return 0; },
    },
    configuracao: { findUnique: async () => null },
  });
  return carregar('src/services/atendimento.js', {
    prisma,
    stubs: {
      'src/services/secretaria.js': { habilitada: () => true, responder: async () => { registro.ia++; return { texto: 'x', usage: {} }; } },
      'src/services/faq.js': { tentarResponder: async () => { registro.ia++; return null; } },
      'src/services/whatsapp.js': { enviarTexto: async () => { registro.envios++; return { ok: true }; } },
      'src/services/waMidia.js': {},
      'src/services/notificacoes.js': { notificarHumanoSolicitado: async () => { registro.envios++; } },
    },
  });
}

test('secretária: mensagem no número da demo fica salva e não gera resposta da IA', async () => {
  const registro = { salvas: 0, ia: 0, envios: 0 };
  const r = await atendimentoCom('demo', registro).receberMensagemCliente(7, { telefone: '5500999990000', texto: 'quero marcar' });
  assert.equal(registro.salvas, 1);
  assert.equal(registro.ia, 0);
  assert.equal(registro.envios, 0);
  assert.equal(r.respostaIA, null);
});

test('marca de demonstração é fixa no código (não depende de configuração)', () => {
  const demo = carregar('src/services/demo.js');
  assert.ok(demo.ehSlugDemo('demo'));
  assert.ok(demo.ehSlugDemo('VITRINE'));
  assert.ok(!demo.ehSlugDemo('navalha'));
  assert.ok(Object.isFrozen(demo.SLUGS_DEMO));
});

function renderPublico(barbearia) {
  const arq = path.join(RAIZ, 'src/views/layouts/publico.ejs');
  return ejs.render(fs.readFileSync(arq, 'utf8'), {
    barbearia, body: '', titulo: 'Agendar', agMarca: 'Teste', agVoltar: null, agPasso: 1, agAtual: 1,
    marcaLogoUrl: null,
  }, { filename: arq });
}

test('página pública da demo mostra o aviso; barbearia comum não', () => {
  let html;
  try {
    html = renderPublico({ slug: 'demo', nome: 'Demo' });
  } catch (e) {
    // O layout depende de variáveis que só o servidor injeta; se faltar alguma,
    // o teste mostra qual, em vez de passar sem conferir.
    assert.fail('layout público não renderizou: ' + e.message.split('\n').pop());
  }
  assert.match(html, /Barbearia de demonstração: pode marcar à vontade, ninguém vai aparecer\./);
  assert.doesNotMatch(renderPublico({ slug: 'navalha', nome: 'Navalha' }), /Barbearia de demonstração/);
});

// ---------- Limpeza semanal (critério 4) ----------
function bancoDemo() {
  const agora = new Date('2026-10-05T12:00:00Z');
  const h = (horas) => new Date(agora.getTime() - horas * 3600000);
  const ags = [
    { id: 1, barbeariaId: 1, origem: 'publico', criadoEm: h(48), data: agora, horaInicio: '10:00', clienteNome: 'Teste A' },
    { id: 2, barbeariaId: 1, origem: 'publico', criadoEm: h(2), data: agora, horaInicio: '11:00', clienteNome: 'Teste B' },
    { id: 3, barbeariaId: 1, origem: 'barbeiro', criadoEm: h(72), data: agora, horaInicio: '12:00', clienteNome: 'Revisor' },
    { id: 4, barbeariaId: 1, origem: null, criadoEm: h(500), data: agora, horaInicio: '13:00', clienteNome: 'Semente' },
    { id: 5, barbeariaId: 2, origem: 'publico', criadoEm: h(48), data: agora, horaInicio: '14:00', clienteNome: 'Cliente real' },
  ];
  const casa = (a, w) => a.barbeariaId === w.barbeariaId && a.origem === w.origem && a.criadoEm < w.criadoEm.lt
    && (!w.id || w.id.in.includes(a.id));
  const registro = { backup: 0 };
  const prisma = prismaFalso({
    barbearia: { findUnique: async ({ where }) => (where.slug === 'demo' ? { id: 1, nome: 'Demo', slug: 'demo' } : null) },
    agendamento: {
      findMany: async ({ where }) => ags.filter((a) => casa(a, where)),
      deleteMany: async ({ where }) => {
        const fora = ags.filter((a) => casa(a, where));
        for (const a of fora) ags.splice(ags.indexOf(a), 1);
        return { count: fora.length };
      },
    },
    $queryRawUnsafe: async () => [{ name: 'main', file: '/tmp/x.db' }],
    $executeRawUnsafe: async () => { registro.backup++; },
  });
  return { prisma, ags, agora, registro };
}

test('limpeza da demo: simulação lista e não apaga nada', async () => {
  const { limparDemo } = carregar('scripts/limpar-demo-publico.js');
  const { prisma, ags, agora } = bancoDemo();
  const r = await limparDemo({ prisma, agora, log: () => {} });
  assert.equal(r.simulacao, true);
  assert.equal(r.encontrados, 1);
  assert.equal(ags.length, 5);
});

test('limpeza da demo: executar apaga só agendamento público com mais de 1 dia da demo', async () => {
  const { limparDemo } = carregar('scripts/limpar-demo-publico.js');
  const { prisma, ags, agora, registro } = bancoDemo();
  const r = await limparDemo({ prisma, agora, executar: true, confirmar: 'demo', log: () => {} });
  assert.equal(r.apagados, 1);
  assert.deepEqual(ags.map((a) => a.id), [2, 3, 4, 5]);
  assert.equal(registro.backup, 1, 'faz backup antes');
});

test('limpeza da demo: sem --confirmar certo não apaga; slug que não é demo é recusado', async () => {
  const { limparDemo } = carregar('scripts/limpar-demo-publico.js');
  const { prisma, ags, agora } = bancoDemo();
  assert.equal((await limparDemo({ prisma, agora, executar: true, confirmar: 'errado', log: () => {} })).ok, false);
  assert.equal((await limparDemo({ prisma, agora, slug: 'navalha', executar: true, confirmar: 'navalha', log: () => {} })).motivo, 'nao-demo');
  assert.equal(ags.length, 5);
});
