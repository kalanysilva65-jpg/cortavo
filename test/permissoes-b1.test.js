// Spec 12, fatia B1: chaves de permissão (telas + dados), padrões e helpers.
// Sem banco real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

const p = () => carregar('src/services/permissoes.js');
const plano = (chave) => carregar('src/services/planoCortavo.js').PLANOS[chave];

const barb = (acessosBloqueados = null, id = 7) => ({ id, papel: 'funcionario', acessosBloqueados });

test('B1 todas as chaves da spec existem, com grupos', () => {
  const { CHAVES, GRUPOS } = p();
  const chaves = CHAVES.map((c) => c.chave);
  for (const k of ['agenda_propria', 'horarios', 'clientes', 'clientes_contato', 'servicos', 'produtos', 'planos', 'estoque',
    'comissoes', 'meus_numeros', 'numeros_barbearia', 'ranking_equipe', 'caixa_ver', 'caixa_lancar', 'conversas', 'ia']) {
    assert.ok(chaves.includes(k), k);
  }
  const grupos = GRUPOS.map((g) => g.chave);
  for (const c of CHAVES) assert.ok(grupos.includes(c.grupo), c.chave);
});

test('B1 critério 7: barbeiro com acessos nulo vê o mesmo que antes (9 telas + próprios números) e nada novo da barbearia', () => {
  const m = p();
  const u = barb(null);
  for (const k of m.LEGADO) assert.equal(m.pode(u, k), true, k);
  assert.equal(m.pode(u, 'meus_numeros'), true);
  assert.equal(m.pode(u, 'clientes_contato'), true);
  for (const k of ['numeros_barbearia', 'ranking_equipe', 'caixa_ver', 'caixa_lancar']) assert.equal(m.pode(u, k), false, k);
});

test('B1 formato antigo (lista de telas bloqueadas) continua valendo e não libera chave nova', () => {
  const m = p();
  const u = barb(JSON.stringify(['estoque', 'conversas']));
  assert.equal(m.pode(u, 'estoque'), false);
  assert.equal(m.pode(u, 'conversas'), false);
  assert.equal(m.pode(u, 'clientes'), true);
  assert.equal(m.pode(u, 'caixa_ver'), false);
  assert.equal(m.pode(u, 'ranking_equipe'), false);
});

test('B1 padrão de barbeiro NOVO segue a tabela da spec (ranking bloqueado, contato liberado)', () => {
  const m = p();
  const u = barb(m.padraoNovoSerializado());
  const esperado = {
    horarios: true, clientes: true, clientes_contato: true, servicos: true, produtos: true, planos: true, estoque: false,
    comissoes: true, meus_numeros: true, numeros_barbearia: false, ranking_equipe: false, caixa_ver: false, caixa_lancar: false,
    conversas: false, ia: true, agenda_propria: true,
  };
  for (const [k, v] of Object.entries(esperado)) assert.equal(m.pode(u, k), v, k);
});

test('B1 R2 admin e dono podem tudo; R1 o plano desliga até para o admin', () => {
  const m = p();
  for (const papel of ['admin', 'dono']) {
    const u = { id: 1, papel, acessosBloqueados: JSON.stringify({ v: 2, bloqueados: ['caixa_ver'] }) };
    assert.equal(m.pode(u, 'caixa_ver', { plano: plano('barbearia') }), true);
    assert.equal(m.pode(u, 'numeros_barbearia', { plano: plano('essencial') }), false);
    assert.equal(m.pode(u, 'comissoes', { plano: plano('essencial') }), false);
    assert.equal(m.pode(u, 'caixa_ver', { plano: plano('essencial') }), true, 'caixa existe no Essencial');
  }
});

test('B1 R1 barbeiro com chave liberada mas fora do plano: não pode', () => {
  const m = p();
  const u = barb(JSON.stringify({ v: 2, liberados: ['numeros_barbearia', 'ranking_equipe', 'estoque'] }));
  assert.equal(m.pode(u, 'numeros_barbearia', { plano: plano('barbearia') }), true);
  assert.equal(m.pode(u, 'numeros_barbearia', { plano: plano('essencial') }), false);
  assert.equal(m.pode(u, 'estoque', { plano: plano('essencial') }), false);
  assert.equal(m.pode(u, 'conversas', { plano: plano('barbearia') }), false, 'plano sem secretária');
});

test('B1 chave desconhecida ou usuário ausente: fecha', () => {
  const m = p();
  assert.equal(m.pode(barb(), 'qualquer_coisa'), false);
  assert.equal(m.pode({ id: 1, papel: 'admin' }, 'qualquer_coisa'), false);
  assert.equal(m.pode(null, 'clientes'), false);
});

test('B1 JSON quebrado vale como legado (nunca derruba a tela)', () => {
  const m = p();
  const u = barb('{isto não é json');
  assert.equal(m.pode(u, 'clientes'), true);
  assert.equal(m.pode(u, 'caixa_ver'), false);
});

test('B1 escopo(): barbeiro só os dele; com numeros_barbearia, a barbearia; admin, tudo', () => {
  const m = p();
  const pl = plano('barbearia');
  assert.deepEqual(m.escopo(barb(null, 7), { plano: pl }), { usuarioId: 7 });
  assert.deepEqual(m.escopo(barb(JSON.stringify({ v: 2, liberados: ['numeros_barbearia'] }), 7), { plano: pl }), {});
  assert.deepEqual(m.escopo(barb(JSON.stringify({ v: 2, liberados: ['numeros_barbearia'] }), 7), { plano: plano('essencial') }), { usuarioId: 7 });
  assert.deepEqual(m.escopo({ id: 1, papel: 'admin' }, { plano: pl }), {});
  assert.equal(m.podeVerEquipe(barb(null), { plano: pl }), false);
  assert.equal(m.podeVerEquipe(barb(JSON.stringify({ v: 2, liberados: ['ranking_equipe'] })), { plano: pl }), true);
});

test('B1 formulário ANTIGO (9 telas) não mexe nas chaves novas', () => {
  const m = p();
  // Só "clientes" e "ia" marcados; o resto das 9 telas desmarcado.
  const gravado = m.bloqueadosDoForm({ acesso_clientes: '1', acesso_ia: '1' }, null);
  const u = barb(gravado);
  assert.equal(m.pode(u, 'clientes'), true);
  assert.equal(m.pode(u, 'estoque'), false);
  assert.equal(m.pode(u, 'meus_numeros'), true, 'não foi exibida, mantém');
  assert.equal(m.pode(u, 'clientes_contato'), true, 'não foi exibida, mantém');
  assert.equal(m.pode(u, 'caixa_ver'), false, 'não foi exibida, mantém');
});

test('B1 formulário NOVO decide só as chaves exibidas', () => {
  const m = p();
  const antes = JSON.stringify({ v: 2, liberados: ['caixa_ver'], bloqueados: ['estoque'] });
  const gravado = m.bloqueadosDoForm({ acessoChaves: 'caixa_lancar,ranking_equipe,clientes_contato', acesso_caixa_lancar: '1' }, antes);
  const u = barb(gravado);
  assert.equal(m.pode(u, 'caixa_lancar'), true);
  assert.equal(m.pode(u, 'ranking_equipe'), false);
  assert.equal(m.pode(u, 'clientes_contato'), false);
  assert.equal(m.pode(u, 'caixa_ver'), true, 'não exibida, mantém liberada');
  assert.equal(m.pode(u, 'estoque'), false, 'não exibida, mantém bloqueada');
  assert.equal(JSON.parse(gravado).v, 2);
});

test('B1 chavesParaTela: no Essencial, chaves do plano voltam com cadeado e texto do plano', () => {
  const m = p();
  const grupos = m.chavesParaTela(barb(null), plano('essencial'));
  const todas = grupos.flatMap((g) => g.chaves);
  const nb = todas.find((c) => c.chave === 'numeros_barbearia');
  assert.equal(nb.foraDoPlano, true);
  assert.equal(nb.cadeado, 'Disponível no plano Barbearia. Fale com a Cortavo.');
  assert.equal(todas.find((c) => c.chave === 'caixa_ver').foraDoPlano, false);
  assert.ok(!todas.some((c) => c.chave === 'agenda_propria'), 'chave fixa não é opção');
});

test('B1 mascararTelefone mostra só o final', () => {
  assert.equal(p().mascararTelefone('(11) 98765-4321'), '•••• 4321');
  assert.equal(p().mascararTelefone(''), '');
});

test('B1 contexto(): pode/escopo/liberadas a partir da sessão + usuário do banco', () => {
  const m = p();
  const ctx = m.contexto({ id: 9, papel: 'funcionario' }, { acessosBloqueados: null }, plano('barbearia'));
  assert.equal(ctx.ehAdmin, false);
  assert.equal(ctx.pode('meus_numeros'), true);
  assert.deepEqual(ctx.escopo(), { usuarioId: 9 });
  assert.ok(ctx.liberadas().includes('agenda_propria'));
  assert.ok(!ctx.liberadas().includes('caixa_ver'));
});

test('B1 Equipe: barbeiro criado agora grava o padrão novo', async () => {
  let criado = null;
  const prisma = prismaFalso({ usuario: { create: async ({ data }) => { criado = data; return { id: 1, ...data }; } } });
  const ctrl = carregar('src/controllers/equipeController.js', { prisma });
  const req = reqFalso({ barbeariaId: 1, body: { nome: 'Davi' } });
  await ctrl.criar(req, resFalso());
  const m = p();
  assert.equal(criado.acessosBloqueados, m.padraoNovoSerializado());
});

test('B1 Equipe: salvar o formulário antigo preserva o que já estava gravado nas chaves novas', async () => {
  const m = p();
  const anterior = JSON.stringify({ v: 2, liberados: ['caixa_ver'] });
  let gravado = null;
  const prisma = prismaFalso({
    usuario: {
      findFirst: async () => ({ id: 3, barbeariaId: 1, papel: 'funcionario', acessosBloqueados: anterior }),
      update: async ({ data }) => { gravado = data; return {}; },
    },
  });
  const ctrl = carregar('src/controllers/equipeController.js', { prisma });
  const req = reqFalso({ barbeariaId: 1, params: { id: '3' }, body: { nome: 'Davi', comissaoPercentual: '50', acessosForm: '1', acesso_clientes: '1' } });
  await ctrl.atualizar(req, resFalso());
  const u = barb(gravado.acessosBloqueados);
  assert.equal(m.pode(u, 'caixa_ver'), true);
  assert.equal(m.pode(u, 'servicos'), false);
});
