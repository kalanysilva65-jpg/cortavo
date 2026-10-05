// Fase 2.1 a 2.3 (spec 04): plano da Cortavo por barbearia. Sem banco real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

// ---------- 2.1 migração ----------
test('2.1 migração só adiciona colunas e todas as atuais viram "personalizado"', () => {
  const sql = fs.readFileSync(path.join(RAIZ, 'prisma/migrations/20261006120000_plano_cortavo/migration.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN "plano_cortavo" TEXT NOT NULL DEFAULT 'personalizado'/);
  assert.match(sql, /ADD COLUMN "plano_cortavo_desde" DATETIME/);
  assert.doesNotMatch(sql, /DROP|DELETE|UPDATE|RENAME/i);
  const schema = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8');
  assert.match(schema, /planoCortavo\s+String\s+@default\("personalizado"\)\s+@map\("plano_cortavo"\)/);
});

// ---------- 2.2 lista única ----------
test('2.2 números do plano batem com o preço aprovado', () => {
  const { PLANOS } = carregar('src/services/planoCortavo.js');
  assert.deepEqual(PLANOS.essencial.tetos, { secretaria: 0, assistente: 0, lembretesRef: 100, barbeirosRef: 2 });
  assert.deepEqual(PLANOS.barbearia.tetos, { secretaria: 0, assistente: 50, lembretesRef: 200, barbeirosRef: 5 });
  assert.deepEqual(PLANOS.barbearia_ia.tetos, { secretaria: 800, assistente: 50, lembretesRef: 300, barbeirosRef: 5 });
  assert.deepEqual([PLANOS.essencial.precoCentavos, PLANOS.barbearia.precoCentavos, PLANOS.barbearia_ia.precoCentavos], [6900, 12900, 24900]);
});

test('2.2 valor vazio ou desconhecido = Personalizado com tudo liberado (critério 7)', () => {
  const pc = carregar('src/services/planoCortavo.js');
  for (const v of [undefined, null, '', 'xyz']) {
    const p = pc.planoDe(v);
    assert.equal(p.chave, 'personalizado');
    for (const f of pc.FUNCOES) assert.ok(pc.libera(p, f.chave));
  }
});

function rodarMiddleware(planoCortavo, caminho, { method = 'GET', accept = 'text/html' } = {}) {
  const { exigeFuncaoDoPlano } = carregar('src/middlewares/planoCortavo.js');
  const req = reqFalso({ path: caminho, method, headers: { accept } });
  const res = resFalso();
  res.locals.barbeariaAtual = { id: 1, nome: 'X', planoCortavo };
  let seguiu = false;
  exigeFuncaoDoPlano(req, res, () => { seguiu = true; });
  return { res, seguiu };
}

test('2.2 Essencial: comissões, relatórios, estoque, fidelidade e metas param no servidor (critério 1)', () => {
  for (const c of ['/comissoes', '/relatorios', '/estoque', '/estoque/3/editar', '/fidelidade', '/metas']) {
    const { res, seguiu } = rodarMiddleware('essencial', c);
    assert.equal(seguiu, false, c);
    assert.equal(res.statusCode, 403);
    assert.equal(res.renderizou.view, 'painel/fora-do-plano');
    assert.equal(res.renderizou.dados.texto, 'Disponível no plano Barbearia. Fale com a Cortavo.');
  }
});

test('2.2 Essencial: POST direto fora do plano devolve 403 em JSON', () => {
  const { res, seguiu } = rodarMiddleware('essencial', '/estoque', { method: 'POST', accept: '*/*' });
  assert.equal(seguiu, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.enviado.foraDoPlano, true);
});

test('2.2 Essencial: agenda, clientes, caixa e link continuam abertos', () => {
  for (const c of ['/', '/agenda', '/clientes', '/caixa', '/servicos', '/estoquex']) {
    assert.equal(rodarMiddleware('essencial', c).seguiu, true, c);
  }
});

test('2.2 Barbearia, + IA e Personalizado liberam as 5 funções', () => {
  for (const p of ['barbearia', 'barbearia_ia', 'personalizado', undefined]) {
    for (const c of ['/comissoes', '/relatorios', '/estoque', '/fidelidade', '/metas']) {
      assert.equal(rodarMiddleware(p, c).seguiu, true, `${p} ${c}`);
    }
  }
});

test('2.2 rota do painel usa o bloqueio por plano', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(src, /router\.use\(exigeFuncaoDoPlano\);/);
  // vem antes da primeira rota do painel
  assert.ok(src.indexOf('router.use(exigeFuncaoDoPlano)') < src.indexOf("router.get('/', dashboardController.ver)"));
});

// ---------- 2.2 só a Kalany troca o plano (critério 8) ----------
test('2.2 admin da barbearia recebe 403 no painel-mestre (onde fica a troca de plano)', () => {
  const { exigeDono } = carregar('src/middlewares/auth.js');
  const req = reqFalso({ session: { usuario: { id: 2, papel: 'admin' } } });
  const res = resFalso();
  exigeDono(req, res, () => assert.fail('admin não pode seguir'));
  assert.equal(res.statusCode, 403);
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/mestre.js'), 'utf8');
  assert.ok(rotas.indexOf('router.use(exigeDono)') < rotas.indexOf("'/barbearias/:id/plano'"));
});

function mestreCom(barbearia) {
  const gravado = [];
  const auditado = [];
  const prisma = prismaFalso({
    barbearia: {
      findUnique: async () => barbearia,
      update: async (a) => { gravado.push(a); return a; },
    },
  });
  const ctrl = carregar('src/controllers/mestreController.js', {
    prisma,
    stubs: { 'src/services/auditoria.js': { registrar: async (_r, d) => auditado.push(d) } },
  });
  return { ctrl, gravado, auditado };
}

test('2.2 dono troca o plano: grava, marca a data e registra auditoria', async () => {
  const { ctrl, gravado, auditado } = mestreCom({ id: 7, nome: 'Navalha', planoCortavo: 'personalizado' });
  const req = reqFalso({ params: { id: '7' }, body: { plano: 'essencial' }, session: { usuario: { id: 1, papel: 'dono' } } });
  const res = resFalso();
  await ctrl.definirPlano(req, res);
  assert.equal(gravado.length, 1);
  assert.equal(gravado[0].data.planoCortavo, 'essencial');
  assert.ok(gravado[0].data.planoCortavoDesde instanceof Date);
  assert.equal(auditado[0].acao, 'barbearia.plano');
  assert.equal(res.redirecionou, '/mestre/barbearias/7');
});

test('2.2 plano inválido não grava nada', async () => {
  const { ctrl, gravado } = mestreCom({ id: 7, nome: 'Navalha', planoCortavo: 'personalizado' });
  const req = reqFalso({ params: { id: '7' }, body: { plano: 'gratis' }, session: { usuario: { id: 1, papel: 'dono' } } });
  await ctrl.definirPlano(req, resFalso());
  assert.equal(gravado.length, 0);
  assert.equal(req.session.flash.tipo, 'erro');
});

// ---------- 2.3 tetos lidos do plano ----------
const NAO_CHAMAR = (nome) => new Proxy({}, { get: (_, k) => (typeof k === 'symbol' || k === 'then' ? undefined : () => { throw new Error(`${nome}.${String(k)} não devia ser chamado`); }) });

function atendimentoCom({ plano, config = {}, uso = null, conversa = null, faq = NAO_CHAMAR('faq') }) {
  const prisma = prismaFalso({
    barbearia: { findUnique: async () => (plano === undefined ? null : { planoCortavo: plano }) },
    configuracao: { findUnique: async ({ where }) => (where.barbeariaId_chave.chave in config ? { valor: config[where.barbeariaId_chave.chave] } : null) },
    usoIA: { findUnique: async () => uso },
    conversa: { findUnique: async () => conversa },
  });
  return carregar('src/services/atendimento.js', {
    prisma,
    stubs: {
      'src/services/secretaria.js': { habilitada: () => true },
      'src/services/faq.js': faq,
      'src/services/whatsapp.js': NAO_CHAMAR('whatsapp'),
      'src/services/waMidia.js': NAO_CHAMAR('waMidia'),
      'src/services/notificacoes.js': NAO_CHAMAR('notificacoes'),
    },
  });
}

test('2.3/M3 opção A: Personalizado com teto "0" = padrão antigo (1500/200), nada muda para as atuais', async () => {
  let a = atendimentoCom({ plano: 'personalizado', config: { secretaria_teto_mes: '0', copiloto_teto_mes: '0' } });
  let s = await a.estadoTeto(1);
  assert.equal(s.teto, 1500); assert.equal(s.atingido, false); assert.equal(s.desligado, false);
  let c = await a.estadoTetoCopiloto(1);
  assert.equal(c.teto, 200); assert.equal(c.atingido, false); assert.equal(c.desligado, false);

  a = atendimentoCom({ plano: 'personalizado', config: { secretaria_teto_mes: '', copiloto_teto_mes: '' } });
  assert.equal((await a.estadoTeto(1)).teto, 1500);
  assert.equal((await a.estadoTetoCopiloto(1)).teto, 200);
  a = atendimentoCom({ plano: 'personalizado', config: { secretaria_teto_mes: '900' } });
  assert.equal((await a.estadoTeto(1)).teto, 900);
});

test('2.3 barbearia sem a coluna ainda (cliente antigo) = Personalizado, nada muda (critério 7)', async () => {
  const a = atendimentoCom({ plano: undefined });
  assert.equal((await a.estadoTeto(1)).teto, 1500);
  assert.equal((await a.estadoTetoCopiloto(1)).teto, 200);
});

test('2.3 Essencial: secretária e assistente desligados, mesmo com config alta', async () => {
  const a = atendimentoCom({ plano: 'essencial', config: { secretaria_teto_mes: '5000', copiloto_teto_mes: '5000' } });
  assert.equal((await a.estadoTeto(1)).desligado, true);
  assert.equal((await a.estadoTetoCopiloto(1)).desligado, true);
});

test('2.3 Barbearia: assistente para na 51ª consulta; secretária desligada (critério 3)', async () => {
  let a = atendimentoCom({ plano: 'barbearia', uso: { copilotoConsultas: 49, respostas: 0 } });
  let c = await a.estadoTetoCopiloto(1);
  assert.equal(c.teto, 50); assert.equal(c.atingido, false);
  a = atendimentoCom({ plano: 'barbearia', uso: { copilotoConsultas: 50, respostas: 0 } });
  assert.equal((await a.estadoTetoCopiloto(1)).atingido, true);
  assert.equal((await a.estadoTeto(1)).desligado, true);
});

test('2.3 Barbearia + IA: secretária com 800 respostas (critério 4)', async () => {
  let a = atendimentoCom({ plano: 'barbearia_ia', uso: { respostas: 799, copilotoConsultas: 0, avisadoTeto: false } });
  let s = await a.estadoTeto(1);
  assert.equal(s.teto, 800); assert.equal(s.atingido, false);
  a = atendimentoCom({ plano: 'barbearia_ia', uso: { respostas: 800, copilotoConsultas: 0, avisadoTeto: false } });
  assert.equal((await a.estadoTeto(1)).atingido, true);
});

function atendimentoMensagem(plano, registro) {
  const prisma = prismaFalso({
    barbearia: { findUnique: async () => ({ planoCortavo: plano }) },
    conversa: {
      findUnique: async () => ({ id: 9, barbeariaId: 1, iaAtiva: true, clienteNome: 'Zé', clienteTelefone: '5500999990000' }),
      update: async () => ({}),
    },
    mensagem: { create: async ({ data }) => { registro.salvas.push(data); return { id: 1, ...data }; } },
    configuracao: { findUnique: async () => null },
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

test('2.3 Essencial e Barbearia: secretária não responde nada, nem FAQ nem SAIR; mensagem fica salva (critério 2)', async () => {
  for (const plano of ['essencial', 'barbearia']) {
    for (const texto of ['quero marcar amanhã', 'SAIR']) {
      const registro = { salvas: [], ia: 0, envios: 0 };
      const r = await atendimentoMensagem(plano, registro).receberMensagemCliente(1, { telefone: '5500999990000', texto });
      assert.equal(registro.salvas.length, 1, 'mensagem salva');
      assert.equal(registro.ia, 0, 'IA/FAQ não rodam');
      assert.equal(registro.envios, 0, 'nada é enviado');
      assert.equal(r.respostaIA, null);
    }
  }
});

test('2.3 Essencial: assistente responde "não está no seu plano" sem chamar a IA nem contar consulta', async () => {
  const a = atendimentoCom({ plano: 'essencial' });
  a.registrarUsoCopiloto = () => assert.fail('não pode contar consulta');
  const ctrl = carregar('src/controllers/iaController.js', {
    prisma: prismaFalso({
      barbearia: { findUnique: async () => ({ planoCortavo: 'essencial' }) },
      configuracao: { findUnique: async () => null },
      usoIA: { findUnique: async () => null },
    }),
    stubs: {
      'src/services/ia.js': { iaHabilitada: () => true, responder: () => assert.fail('não pode chamar a IA') },
      'src/services/secretaria.js': { habilitada: () => true },
      'src/services/faq.js': {}, 'src/services/whatsapp.js': {}, 'src/services/waMidia.js': {}, 'src/services/notificacoes.js': {},
    },
  });
  const res = resFalso();
  await ctrl.mensagem(reqFalso({ barbeariaId: 1, body: { mensagem: 'quanto faturei?' }, session: { usuario: { id: 2, papel: 'admin' } } }), res);
  assert.match(res.enviado.resposta, /não está no seu plano/);
});

function secretariaCtrlCom(plano, pausadaAtual) {
  const gravado = [];
  const ctrl = carregar('src/controllers/secretariaController.js', {
    prisma: prismaFalso({
      barbearia: { findUnique: async () => ({ planoCortavo: plano }) },
      configuracao: {
        findUnique: async () => (pausadaAtual == null ? null : { valor: pausadaAtual }),
        upsert: async (a) => { gravado.push(a); return a; },
      },
    }),
  });
  return { ctrl, gravado };
}

test('2.3 plano sem secretária: dono da barbearia não tira a pausa', async () => {
  for (const plano of ['essencial', 'barbearia']) {
    const { ctrl, gravado } = secretariaCtrlCom(plano, '1');
    const req = reqFalso({ barbeariaId: 1, session: { usuario: { id: 2, papel: 'admin' } } });
    await ctrl.pausarIA(req, resFalso());
    assert.equal(gravado.length, 0, plano);
    assert.equal(req.session.flash.tipo, 'erro');
  }
});

test('2.3 plano sem secretária: pausar continua liberado; + IA e Personalizado despausam', async () => {
  let { ctrl, gravado } = secretariaCtrlCom('essencial', '0');
  await ctrl.pausarIA(reqFalso({ barbeariaId: 1, session: { usuario: { id: 2, papel: 'admin' } } }), resFalso());
  assert.equal(gravado[0].update.valor, '1');
  for (const plano of ['barbearia_ia', 'personalizado']) {
    ({ ctrl, gravado } = secretariaCtrlCom(plano, '1'));
    await ctrl.pausarIA(reqFalso({ barbeariaId: 1, session: { usuario: { id: 2, papel: 'admin' } } }), resFalso());
    assert.equal(gravado[0].update.valor, '0', plano);
  }
});

test('M3 opção A: nos planos novos 0 = desligado (critério 5)', async () => {
  const a = atendimentoCom({ plano: 'essencial', config: { secretaria_teto_mes: '0', copiloto_teto_mes: '0' } });
  const s = await a.estadoTeto(1);
  assert.equal(s.teto, 0); assert.equal(s.atingido, true); assert.equal(s.desligado, true);
  const c = await a.estadoTetoCopiloto(1);
  assert.equal(c.teto, 0); assert.equal(c.desligado, true);
  const b = atendimentoCom({ plano: 'barbearia' });
  assert.equal((await b.estadoTeto(1)).desligado, true);
  assert.equal((await b.estadoTetoCopiloto(1)).teto, 50);
});

test('critério 6: 3º barbeiro no Essencial gera aviso para a Kalany, sem bloqueio', () => {
  const pc = carregar('src/services/planoCortavo.js');
  assert.equal(pc.avisoBarbeiros(pc.planoDe('essencial'), 2, 'Navalha'), null);
  assert.match(pc.avisoBarbeiros(pc.planoDe('essencial'), 3, 'Navalha'), /Navalha tem 3 barbeiros no Essencial/);
  assert.equal(pc.avisoBarbeiros(pc.planoDe('personalizado'), 30, 'X'), null);
  // o cadastro de barbeiro não consulta o plano (nunca bloqueia)
  const eq = fs.readFileSync(path.join(RAIZ, 'src/controllers/equipeController.js'), 'utf8');
  assert.doesNotMatch(eq, /planoCortavo|barbeirosRef/);
});
