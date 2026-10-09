// Spec 12, fatia B2: permissões aplicadas no servidor (middleware por chave,
// caixa para barbeiro com chave, telefone do cliente). Sem banco real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { criarBanco } = require('./helpers/bancoMemoria');

const pc = () => carregar('src/services/planoCortavo.js');
function ctx(papel, gravado, planoChave = 'barbearia', id = 7) {
  const perm = carregar('src/services/permissoes.js');
  return perm.contexto({ id, papel }, { acessosBloqueados: gravado }, pc().PLANOS[planoChave]);
}
const V2 = (liberados = [], bloqueados = []) => JSON.stringify({ v: 2, liberados, bloqueados });

function rodar(mw, req) {
  const res = resFalso();
  let seguiu = false;
  mw(req, res, () => { seguiu = true; });
  return { res, seguiu };
}

test('B2 exige(): barbeiro sem a chave recebe 403 em JSON, sem dado (critério 4)', () => {
  const { exige } = carregar('src/middlewares/permissao.js');
  const req = reqFalso({ method: 'POST', headers: { accept: 'application/json' }, permissoes: ctx('funcionario', null) });
  const { res, seguiu } = rodar(exige('caixa_lancar'), req);
  assert.equal(seguiu, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.enviado, { erro: 'Sem acesso a esta área.', semPermissao: true, chave: 'caixa_lancar' });
});

test('B2 exige(): na navegação (GET de HTML) volta ao Início com aviso, nunca tela de erro (critério 2)', () => {
  const { exige } = carregar('src/middlewares/permissao.js');
  const req = reqFalso({ method: 'GET', headers: { accept: 'text/html' }, permissoes: ctx('funcionario', null) });
  const { res, seguiu } = rodar(exige('caixa_ver'), req);
  assert.equal(seguiu, false);
  assert.equal(res.redirecionou, '/painel');
  assert.equal(req.session.flash.tipo, 'erro');
});

test('B2 exige(): com a chave, admin, ou sem contexto (fecha)', () => {
  const { exige, exigeAlguma } = carregar('src/middlewares/permissao.js');
  assert.equal(rodar(exige('caixa_ver'), reqFalso({ method: 'GET', permissoes: ctx('funcionario', V2(['caixa_ver'])) })).seguiu, true);
  assert.equal(rodar(exige('caixa_ver'), reqFalso({ method: 'GET', permissoes: ctx('admin', null, 'barbearia', 1) })).seguiu, true);
  assert.equal(rodar(exige('caixa_ver'), reqFalso({ method: 'GET' })).seguiu, false);
  assert.equal(rodar(exigeAlguma('numeros_barbearia', 'meus_numeros'), reqFalso({ method: 'GET', permissoes: ctx('funcionario', null) })).seguiu, true);
  // Plano Essencial: "números da barbearia" não existe nem liberado
  assert.equal(rodar(exige('numeros_barbearia'), reqFalso({ method: 'GET', headers: {}, permissoes: ctx('funcionario', V2(['numeros_barbearia']), 'essencial') })).seguiu, false);
});

test('B2 rotas: caixa usa as chaves; excluir lançamento, relatórios, metas e equipe continuam só admin (R4)', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(src, /router\.get\('\/caixa', exige\('caixa_ver'\), caixaController\.ver\)/);
  assert.match(src, /router\.post\('\/caixa', exige\('caixa_lancar'\), caixaController\.criar\)/);
  assert.match(src, /router\.post\('\/caixa\/:id\/remover', exigeAdmin, caixaController\.remover\)/);
  assert.match(src, /router\.get\('\/relatorios', exigeAdmin/);
  assert.match(src, /router\.get\('\/metas', exigeAdmin/);
  assert.match(src, /router\.get\('\/equipe', exigeAdmin/);
  assert.match(src, /router\.get\('\/exportar\/dados\.json', exigeAdmin/);
});

function bancoCaixa() {
  const hoje = new Date();
  return criarBanco({
    caixa: [
      { id: 1, barbeariaId: 1, tipo: 'entrada', valor: 5000, data: hoje, descricao: 'Corte', formaPagamento: 'pix' },
      { id: 2, barbeariaId: 2, tipo: 'entrada', valor: 9999, data: hoje, descricao: 'Outra barbearia' },
    ],
    agendamento: [
      { id: 1, barbeariaId: 1, usuarioId: 1, status: 'concluido', data: new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()), valorTotal: 5000, clienteNome: 'A', horaInicio: '10:00' },
    ],
    agendamentoItem: [{ id: 1, agendamentoId: 1, servicoId: 1, valorUnitario: 5000, quantidade: 1 }],
    servico: [{ id: 1, barbeariaId: 1, nome: 'Corte', ehProduto: false, duracaoMin: 30, comissaoPercentual: 10 }],
    usuario: [{ id: 1, barbeariaId: 1, nome: 'Davi', comissaoPercentual: 50 }],
  });
}

test('B2 caixa: barbeiro com caixa_ver vê o caixa da barbearia, sem excluir, e sem a comissão somada da equipe', async () => {
  const ctrl = carregar('src/controllers/caixaController.js', { prisma: bancoCaixa() });
  const req = reqFalso({ barbeariaId: 1, permissoes: ctx('funcionario', V2(['caixa_ver'])) });
  const res = resFalso();
  await ctrl.ver(req, res);
  const d = res.renderizou.dados;
  assert.equal(d.resumoPeriodo.entrou, 5000, 'só a barbearia 1');
  assert.equal(d.podeRemoverCaixa, false);
  assert.equal(d.podeLancarCaixa, false);
  assert.equal(d.comissaoValor, 0);
});

test('B2 caixa: admin continua vendo tudo (comissão, excluir, lançar)', async () => {
  const ctrl = carregar('src/controllers/caixaController.js', { prisma: bancoCaixa() });
  const req = reqFalso({ barbeariaId: 1, permissoes: ctx('admin', null, 'barbearia', 1) });
  const res = resFalso();
  await ctrl.ver(req, res);
  const d = res.renderizou.dados;
  assert.equal(d.podeRemoverCaixa, true);
  assert.equal(d.podeLancarCaixa, true);
  assert.equal(d.comissaoValor, 2500);
});

test('B2 caixa: a tela esconde Lançar e Excluir conforme a permissão', () => {
  const v = fs.readFileSync(path.join(RAIZ, 'src/views/painel/caixa.ejs'), 'utf8');
  // Redesign v3 (F6): Lançar e Fechar caixa ficam juntos atrás de podeLancarCaixa.
  assert.match(v, /var _lancar = \(typeof podeLancarCaixa === 'undefined' \|\| podeLancarCaixa\);/);
  assert.match(v, /<% if \(_lancar\) \{ %>\s*<div class="cv-cx-acoes">\s*<button type="button" class="cv-btn cv-btn--2 cv-cx-lancar"/);
  assert.match(v, /podeRemoverCaixa\) \{ %>\s*<form method="POST" action="\/painel\/caixa\/<%= ex\.id %>\/remover"/);
});

function bancoClientes() {
  return criarBanco({
    cliente: [{ id: 1, barbeariaId: 1, nome: 'Ana', telefone: '51999991234', criadoEm: new Date() }],
    plano: [],
    agendamento: [],
  });
}

test('B2 clientes_contato bloqueado: lista recebe o telefone mascarado (a tela não recebe o dado)', async () => {
  const ctrl = carregar('src/controllers/clienteController.js', { prisma: bancoClientes() });
  const req = reqFalso({ barbeariaId: 1, permissoes: ctx('funcionario', V2([], ['clientes_contato'])) });
  const res = resFalso();
  await ctrl.listar(req, res);
  const c = res.renderizou.dados.clientes[0];
  assert.equal(c.telefone, '•••• 1234');
  assert.equal(c.telefoneOculto, true);
  assert.ok(!JSON.stringify(res.renderizou.dados).includes('51999991234'));
});

test('B2 clientes_contato liberado (padrão): telefone completo', async () => {
  const ctrl = carregar('src/controllers/clienteController.js', { prisma: bancoClientes() });
  const req = reqFalso({ barbeariaId: 1, permissoes: ctx('funcionario', null) });
  const res = resFalso();
  await ctrl.listar(req, res);
  assert.equal(res.renderizou.dados.clientes[0].telefone, '51999991234');
});

test('B2 clientes_contato bloqueado: salvar o cliente não troca o telefone pelo mascarado', async () => {
  const banco = bancoClientes();
  const ctrl = carregar('src/controllers/clienteController.js', { prisma: banco });
  const req = reqFalso({ barbeariaId: 1, params: { id: '1' }, body: { telefone: '•••• 1234', observacoes: 'gosta de degradê' }, permissoes: ctx('funcionario', V2([], ['clientes_contato'])) });
  await ctrl.atualizar(req, resFalso());
  const c = banco._tabelas.cliente[0];
  assert.equal(c.telefone, '51999991234');
  assert.equal(c.observacoes, 'gosta de degradê');
});
