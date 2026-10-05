// Correções da revisão do Sérgio (fase2-planos-seguranca.md): M1, M2, B1, B3 e
// aviso de barbeiros só com ativos. Sem banco real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

// ---------- M1: maiúsculas no endereço ----------
function rodar(planoCortavo, caminho, method = 'GET') {
  const { exigeFuncaoDoPlano } = carregar('src/middlewares/planoCortavo.js');
  const req = reqFalso({ path: caminho, method, headers: { accept: method === 'GET' ? 'text/html' : '*/*' } });
  const res = resFalso();
  res.locals.barbeariaAtual = { id: 1, planoCortavo };
  let seguiu = false;
  exigeFuncaoDoPlano(req, res, () => { seguiu = true; });
  return { res, seguiu };
}

test('M1 /ESTOQUE, /Comissoes/percentual/3 e /METAS também param no Essencial', () => {
  for (const [c, m] of [['/ESTOQUE', 'GET'], ['/Estoque/3/editar', 'GET'], ['/Comissoes/percentual/3', 'POST'], ['/METAS', 'GET'], ['/RelaTorios', 'GET'], ['/FIDELIDADE/cupons', 'POST']]) {
    const { res, seguiu } = rodar('essencial', c, m);
    assert.equal(seguiu, false, c);
    assert.equal(res.statusCode, 403, c);
  }
  assert.equal(rodar('barbearia', '/ESTOQUE').seguiu, true);
});

test('M1 permissões por funcionário também ignoram maiúsculas', () => {
  const p = carregar('src/services/permissoes.js');
  assert.equal(p.moduloDoCaminho('/CLIENTES').chave, 'clientes');
  assert.equal(p.moduloDoCaminho('/Conversas/3').chave, 'conversas');
  assert.equal(p.moduloDoCaminho('/clientesx'), undefined);
});

// ---------- M2: falha de leitura fecha a IA, telas seguem abertas ----------
const NAO = (nome) => new Proxy({}, { get: (_, k) => (typeof k === 'symbol' || k === 'then' ? undefined : () => { throw new Error(`${nome}.${String(k)} não devia ser chamado`); }) });

function atendimentoFalhando(registro = { salvas: [], ia: 0, envios: 0 }) {
  const prisma = prismaFalso({
    barbearia: { findUnique: async () => { throw new Error('banco instável'); } },
    configuracao: { findUnique: async () => null },
    usoIA: { findUnique: async () => null },
    conversa: {
      findUnique: async () => ({ id: 9, barbeariaId: 1, iaAtiva: true, clienteNome: 'Zé', clienteTelefone: '5500999990000' }),
      update: async () => ({}),
    },
    mensagem: { create: async ({ data }) => { registro.salvas.push(data); return { id: 1, ...data }; } },
  });
  return carregar('src/services/atendimento.js', {
    prisma,
    stubs: {
      'src/services/secretaria.js': { habilitada: () => true, responder: async () => { registro.ia++; return { texto: 'x', usage: {} }; } },
      'src/services/faq.js': { tentarResponder: async () => { registro.ia++; return null; } },
      'src/services/whatsapp.js': { enviarTexto: async () => { registro.envios++; return { ok: true }; } },
      'src/services/waMidia.js': {},
      'src/services/notificacoes.js': { notificarHumanoSolicitado: async () => { registro.envios++; }, notificarNovaMensagem: async () => {} },
    },
  });
}

test('M2 leitura do plano falha: secretária e assistente ficam desligados (fail-closed)', async () => {
  const a = atendimentoFalhando();
  assert.equal((await a.estadoTeto(1)).desligado, true);
  assert.equal((await a.estadoTetoCopiloto(1)).desligado, true);
  const registro = { salvas: [], ia: 0, envios: 0 };
  const r = await atendimentoFalhando(registro).receberMensagemCliente(1, { telefone: '5500999990000', texto: 'quero marcar' });
  assert.equal(registro.salvas.length, 1, 'mensagem salva');
  assert.equal(registro.ia, 0);
  assert.equal(registro.envios, 0);
  assert.equal(r.respostaIA, null);
});

test('M2 telas não dependem da leitura que falhou: barbearia carregada sem plano = Personalizado aberto', () => {
  assert.equal(rodar(undefined, '/estoque').seguiu, true);
});

test('M2 valor desconhecido = Personalizado com aviso no log', () => {
  const pc = carregar('src/services/planoCortavo.js');
  const avisos = [];
  const orig = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try {
    assert.equal(pc.planoDe('premium').chave, 'personalizado');
    assert.equal(pc.planoDe(undefined).chave, 'personalizado');
  } finally { console.warn = orig; }
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /desconhecido/);
});

// ---------- B1: áudio sem secretária não é transcrito ----------
function webhookCom(plano, registro) {
  return carregar('src/controllers/webhookController.js', {
    prisma: prismaFalso({ barbearia: { findUnique: async () => ({ planoCortavo: plano }) } }),
    stubs: {
      'src/services/atendimento.js': { receberMensagemCliente: async (_b, d) => { registro.recebido = d; return {}; } },
      'src/services/whatsapp.js': { baixarMidia: async () => ({ buffer: Buffer.from('a'), mimeType: 'audio/ogg' }) },
      'src/services/waMidia.js': { salvar: () => 'arq.ogg' },
      'src/services/transcricao.js': { transcrever: async () => { registro.transcreveu++; return 'oi'; } },
    },
  });
}

test('B1 Essencial e Barbearia: áudio fica salvo sem transcrição; + IA transcreve', async () => {
  for (const [plano, esperado] of [['essencial', 0], ['barbearia', 0], ['barbearia_ia', 1], ['personalizado', 1]]) {
    const registro = { transcreveu: 0 };
    await webhookCom(plano, registro).processarMensagem(1, { from: '5500999990000', id: 'w1', type: 'audio', audio: { id: 'm1', mime_type: 'audio/ogg' } }, 'Zé');
    assert.equal(registro.transcreveu, esperado, plano);
    assert.equal(registro.recebido.tipo, 'audio');
    assert.equal(registro.recebido.texto, esperado ? 'oi' : '');
  }
});

// ---------- B3: Home e cabeçalho seguem a regra dos menus ----------
function dashboardCom(plano) {
  const chamadas = { estoque: 0, metas: 0 };
  const prisma = prismaFalso({
    usuario: { findMany: async () => [] },
    agendamento: { findMany: async () => [] },
    horarioTrabalho: { findMany: async () => [] },
    caixa: { aggregate: async () => ({ _sum: { valor: 0 } }), findMany: async () => [] },
    estoque: { findMany: async () => { chamadas.estoque++; return [{ nome: 'Pomada', quantidade: 0, quantidadeMinima: 2 }]; } },
  });
  const ctrl = carregar('src/controllers/dashboardController.js', {
    prisma,
    stubs: { 'src/controllers/metaController.js': { paraHome: async () => { chamadas.metas++; return [{ label: 'x' }]; } } },
  });
  return { ctrl, chamadas };
}

test('B3 Essencial: Home não consulta nem mostra estoque baixo e metas', async () => {
  const { ctrl, chamadas } = dashboardCom('essencial');
  const res = resFalso();
  const pc = carregar('src/services/planoCortavo.js');
  res.locals.planoCortavo = pc.planoDe('essencial');
  await ctrl.ver(reqFalso({ barbeariaId: 1, ehAdmin: true, session: { usuario: { id: 2, nome: 'Ana', papel: 'admin' } } }), res);
  assert.equal(chamadas.estoque, 0);
  assert.equal(chamadas.metas, 0);
  assert.equal(res.renderizou.dados.estoqueBaixo.tem, false);
  assert.deepEqual(res.renderizou.dados.metasHome, []);
});

test('B3 Barbearia: Home continua mostrando estoque baixo e metas', async () => {
  const { ctrl, chamadas } = dashboardCom('barbearia');
  const res = resFalso();
  res.locals.planoCortavo = carregar('src/services/planoCortavo.js').planoDe('barbearia');
  await ctrl.ver(reqFalso({ barbeariaId: 1, ehAdmin: true, session: { usuario: { id: 2, nome: 'Ana', papel: 'admin' } } }), res);
  assert.equal(chamadas.estoque, 1);
  assert.equal(chamadas.metas, 1);
  assert.equal(res.renderizou.dados.estoqueBaixo.tem, true);
});

test('B3 views: Home usa foraDoPlano nos atalhos; cabeçalho só conta estoque quando o plano libera', () => {
  const home = fs.readFileSync(path.join(RAIZ, 'src/views/painel/dashboard.ejs'), 'utf8');
  for (const h of ["fdp('/painel/relatorios')", "fdp('/painel/estoque')", "fdp('/painel/metas')", '<% if (!trancaEst || ehAdmin) { %>']) assert.ok(home.includes(h), h);
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(rotas, /req\.ehAdmin && planoCortavo\.libera\(planoCortavo\.planoDe\(barbearia && barbearia\.planoCortavo\), 'estoque'\)/);
});

test('B3 view da Home: admin vê cadeado, barbeiro não vê o sino de estoque (Essencial)', () => {
  const ejs = require(require.resolve('ejs', { paths: [RAIZ] }));
  const home = fs.readFileSync(path.join(RAIZ, 'src/views/painel/dashboard.ejs'), 'utf8');
  const pc = carregar('src/services/planoCortavo.js');
  const plano = pc.planoDe('essencial');
  const foraDoPlano = (href) => {
    const f = pc.funcaoDoCaminho(String(href).replace(/^\/painel/, '') || '/');
    return f && !pc.libera(plano, f.chave) ? { ...f, texto: pc.textoForaDoPlano(f.chave) } : null;
  };
  const base = {
    fmtT6: (v) => String(v), usuarioFotoUrl: null, fmtBRL: (v) => String(v), foraDoPlano, usuario: { nome: 'Ana' }, totalHoje: 0, concluidosHoje: 0, restantesHoje: 0, ganhoHoje: 0, ticketMedioHoje: 0,
    ocupacaoHoje: 0, ocupacaoLargura: 0, saudacao: 'Oi', dataLonga: '', proximoCorte: null, seguintesCortes: [],
    iniciaisUsuario: 'A', faturamentoSemanal: 0, barrasSemana: [], estoqueBaixo: { tem: false }, metasHome: [],
  };
  let html;
  try {
    html = ejs.render(home, { ...base, ehAdmin: true }, { filename: path.join(RAIZ, 'src/views/painel/dashboard.ejs') });
  } catch (e) {
    // A Home usa locais do app; o teste passa os mínimos.
    throw new Error("render da Home falhou: " + e.message);
  }
  assert.match(html, /Estoque \(fora do plano\)/);
  assert.match(html, /Relatórios \(fora do plano\)/);
  assert.match(html, /Disponível no plano Barbearia/);
  const htmlBarbeiro = ejs.render(home, { ...base, ehAdmin: false }, { filename: path.join(RAIZ, 'src/views/painel/dashboard.ejs') });
  assert.doesNotMatch(htmlBarbeiro, /href="\/painel\/estoque"/);
  assert.doesNotMatch(htmlBarbeiro, /fora do plano/);
});

// ---------- Lista do mestre: aviso conta só barbeiros ativos ----------
test('mestre: aviso de barbeiros na lista usa só os ativos', async () => {
  let filtro = null;
  const ctrl = carregar('src/controllers/mestreController.js', {
    prisma: prismaFalso({
      barbearia: {
        count: async () => 1,
        findMany: async () => [{ id: 7, nome: 'Navalha', planoCortavo: 'essencial', _count: { usuarios: 4, clientes: 0, agendamentos: 0 } }],
      },
      usuario: { groupBy: async (a) => { filtro = a.where; return [{ barbeariaId: 7, _count: { _all: 2 } }]; } },
    }),
  });
  const res = resFalso();
  await ctrl.painel(reqFalso({ query: {}, session: { usuario: { id: 1, papel: 'dono' } } }), res);
  assert.equal(filtro.ativo, true);
  const b = res.renderizou.dados.barbearias[0];
  assert.equal(b.barbeirosAtivos, 2);
  assert.equal(res.renderizou.dados.avisoBarbeiros(res.renderizou.dados.planoDe(b.planoCortavo), b.barbeirosAtivos, b.nome), null);
  const view = fs.readFileSync(path.join(RAIZ, 'src/views/mestre/painel.ejs'), 'utf8');
  assert.ok(view.includes('avisoBarbeiros(pl, barb.barbeirosAtivos, barb.nome)'));
});
