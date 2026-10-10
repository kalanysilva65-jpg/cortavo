// Itens da revisão final da Vera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

test('Vera: comentário do comissaoController diz que o funcionário também abre, só com a própria comissão', () => {
  const s = fs.readFileSync(path.join(RAIZ, 'src/controllers/comissaoController.js'), 'utf8');
  const cab = s.split('\n').slice(0, 6).join('\n');
  assert.doesNotMatch(cab, /somente admin/i);
  assert.match(cab, /FUNCIONÁRIO também abre/);
});

test('Vera: o funcionário nunca recebe os colegas nas Comissões (nem pedindo ?barbeiro=)', async () => {
  const usuarios = [
    { id: 1, nome: 'Ana Admin', ativo: true, comissaoPercentual: 50 },
    { id: 2, nome: 'Beto Barbeiro', ativo: true, comissaoPercentual: 40 },
    { id: 3, nome: 'Caio Colega', ativo: true, comissaoPercentual: 40 },
  ];
  const ag = (id, usuarioId, valor) => ({ id, usuarioId, data: new Date(), horaInicio: '10:00', concluidoEm: new Date(), status: 'concluido', valorTotal: valor, usuario: usuarios.find((u) => u.id === usuarioId), itens: [{ quantidade: 1, valorUnitario: valor, servico: { nome: 'Corte', duracaoMin: 30 } }], clientePlano: null });
  const prisma = prismaFalso({
    usuario: { findMany: async () => usuarios },
    agendamento: { findMany: async () => [ag(1, 1, 5000), ag(2, 2, 4000), ag(3, 3, 9000)] },
    horarioTrabalho: { findMany: async () => [] },
    bloqueio: { findMany: async () => [] },
  });
  const c = carregar('src/controllers/comissaoController.js', { prisma });
  for (const barbeiro of [undefined, 'todos', '3']) {
    const res = resFalso();
    await c.ver(reqFalso({ barbeariaId: 7, ehAdmin: false, session: { usuario: { id: 2 } }, query: { barbeiro } }), res);
    const d = res.renderizou.dados;
    assert.equal(d.barbeiroSelecionado, '2');
    assert.deepEqual(d.grupos.map((g) => g.barbeiro.id), [2]);
    assert.deepEqual(d.barbeiros.map((b) => b.id), [2]);
    const tudo = JSON.stringify({ grupos: d.grupos, barbeiros: d.barbeiros, situacoes: d.situacoes });
    assert.ok(!tudo.includes('Caio') && !tudo.includes('Ana Admin'), 'nenhum colega');
  }
  const res = resFalso();
  await c.ver(reqFalso({ barbeariaId: 7, ehAdmin: true, session: { usuario: { id: 1 } }, query: {} }), res);
  assert.equal(res.renderizou.dados.barbeiros.length, 3, 'admin continua vendo todos');
});

test('Vera: limite do POST /criar-senha conta por IP E por link (mesmo wifi não trava a barbearia)', () => {
  const { chaveCriarSenha } = carregar('src/middlewares/rateLimit.js');
  const a = chaveCriarSenha({ ip: '200.1.1.1', session: { acessoLink: { hash: 'a'.repeat(64) } } });
  const b = chaveCriarSenha({ ip: '200.1.1.1', session: { acessoLink: { hash: 'b'.repeat(64) } } });
  const semLink = chaveCriarSenha({ ip: '200.1.1.1', session: {} });
  assert.notEqual(a, b, 'dois barbeiros no mesmo wifi têm contadores separados');
  assert.equal(a, chaveCriarSenha({ ip: '200.1.1.1', session: { acessoLink: { hash: 'a'.repeat(64) } } }));
  assert.ok(!a.includes('a'.repeat(17)), 'a chave não guarda o hash inteiro');
  assert.match(semLink, /\|-$/);
});

test('Vera: iniciarLimpeza() dos links antigos é chamado no boot (server.js)', () => {
  const srv = fs.readFileSync(path.join(RAIZ, 'src/server.js'), 'utf8');
  assert.match(srv, /require\('\.\/services\/tokensAcesso'\)\.iniciarLimpeza\(\)/);
});

test('Vera: conta de antes do link mostra "Senha de antes do link", não "Senha criada em"', () => {
  const tk = carregar('src/services/tokensAcesso.js');
  const quando = new Date('2026-09-01T12:00:00Z');
  const antiga = tk.estadoDoAcesso({ criadoEm: quando, senhaDefinidaEm: quando }, null);
  assert.equal(antiga.codigo, 'senha_antiga');
  assert.match(antiga.texto, /^Senha de antes do link/);
  assert.equal(antiga.botao, 'Enviar link para nova senha');
  const nova = tk.estadoDoAcesso({ criadoEm: quando, senhaDefinidaEm: new Date('2026-10-02T12:00:00Z') }, null);
  assert.equal(nova.texto, 'Senha criada em 02/10');
});
