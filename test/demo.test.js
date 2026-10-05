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
