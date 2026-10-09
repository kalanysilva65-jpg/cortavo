// Spec 12, fatia B6: GET /painel/api/home ("Painel vivo") recortado por papel,
// permissão e plano — a matriz "papel x o que aparece" da spec, linha a linha.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoGestao, diaRel } = require('./helpers/dadosGestao');

function ambiente() {
  const banco = bancoGestao();
  const metricas = carregar('src/services/metricas.js', { prisma: banco });
  metricas.limparCache();
  const home = require('../src/services/home.js');
  home._cacheHome.clear();
  return { banco, metricas, home, permissoes: require('../src/services/permissoes.js'), planoCortavo: require('../src/services/planoCortavo.js') };
}
function perm(amb, { id = 1, papel = 'admin', gravado = null, plano = 'barbearia' } = {}) {
  return amb.permissoes.contexto({ id, papel }, { acessosBloqueados: gravado }, amb.planoCortavo.PLANOS[plano]);
}
const TODAS = ['horarios', 'clientes', 'clientes_contato', 'servicos', 'produtos', 'planos', 'estoque', 'comissoes', 'meus_numeros', 'numeros_barbearia', 'ranking_equipe', 'caixa_ver', 'caixa_lancar', 'conversas', 'ia'];
const GERENTE = JSON.stringify({ v: 2, liberados: TODAS });
const SO_AGENDA = JSON.stringify({ v: 2, bloqueados: TODAS });
const aneis = (h) => h.aneis.map((a) => a.chave);
const tipos = (h) => h.destaques.map((d) => d.tipo);

function montar(amb, p, agora = new Date()) {
  return amb.home.montarHome({ barbeariaId: 1, permissoes: p, agora, faixaTeste: { texto: 'Seu teste termina em 3 dias' } });
}

test('B6 admin (plano Barbearia): 3 anéis da barbearia com meta, horas livres por barbeiro, sem anel de comissão', async () => {
  const amb = ambiente();
  amb.banco._tabelas.estoque.push({ id: 1, barbeariaId: 1, nome: 'Pomada', quantidade: 1, quantidadeMinima: 3 });
  const h = await montar(amb, perm(amb));
  assert.equal(h.papel, 'admin');
  assert.deepEqual(h.escopo, { tipo: 'barbearia', usuarioId: null });
  assert.deepEqual(aneis(h), ['faturamento', 'atendimentos', 'ocupacao']);
  const fat = h.aneis[0];
  assert.equal(fat.fonte, 'caixa');
  assert.equal(fat.meta.alvo, 100000);
  assert.ok(Array.isArray(h.horasLivres.porBarbeiro));
  assert.ok(tipos(h).includes('estoque_baixo'));
  assert.equal(h.teste.texto, 'Seu teste termina em 3 dias');
  // Atendimentos de hoje da barbearia: 7, 8 concluídos; 11 agendado (9 cancelado e 10 faltou ficam fora).
  assert.deepEqual([h.aneis[1].concluidos, h.aneis[1].total], [2, 3]);
});

test('B6 admin no Essencial: faturamento sem meta, sem destaques de meta, estoque ou cliente sumido', async () => {
  const amb = ambiente();
  amb.banco._tabelas.estoque.push({ id: 1, barbeariaId: 1, nome: 'Pomada', quantidade: 1, quantidadeMinima: 3 });
  const h = await montar(amb, perm(amb, { plano: 'essencial' }));
  assert.deepEqual(aneis(h), ['faturamento', 'atendimentos', 'ocupacao']);
  assert.equal(h.aneis[0].meta, null);
  for (const t of ['meta_perto', 'estoque_baixo', 'cliente_sumido']) assert.ok(!tipos(h).includes(t), t);
});

test('B6 barbeiro "básico" (padrão): anéis DELE + comissão, sem detalhe da equipe, próximos só dele e sem telefone', async () => {
  const amb = ambiente();
  const h = await montar(amb, perm(amb, { id: 2, papel: 'funcionario' }));
  assert.equal(h.papel, 'barbeiro');
  assert.deepEqual(h.escopo, { tipo: 'barbeiro', usuarioId: 2 });
  assert.deepEqual(aneis(h), ['faturamento', 'atendimentos', 'ocupacao', 'comissao']);
  assert.equal(h.aneis[0].fonte, 'atendimentos');
  assert.equal(h.horasLivres.porBarbeiro, undefined);
  assert.equal(h.teste, null, 'faixa do teste é só do dono');
  const deBruno = amb.banco._tabelas.agendamento.filter((a) => a.barbeariaId === 1 && a.usuarioId === 2 && a.status === 'agendado' && a.data >= diaRel(0)).map((a) => a.id);
  assert.ok(h.proximos.every((p) => deBruno.includes(p.id) && p.barbeiro === null));
  assert.ok(!JSON.stringify(h).includes('1190000000'), 'nenhum telefone na Home');
  for (const t of ['estoque_baixo', 'cliente_sumido']) assert.ok(!tipos(h).includes(t), t);
});

test('B6 barbeiro "gerente" (tudo liberado): números da barbearia e a comissão dele', async () => {
  const amb = ambiente();
  const h = await montar(amb, perm(amb, { id: 2, papel: 'funcionario', gravado: GERENTE }));
  assert.deepEqual(h.escopo, { tipo: 'barbearia', usuarioId: null });
  assert.deepEqual(aneis(h), ['faturamento', 'atendimentos', 'ocupacao', 'comissao']);
  assert.equal(h.aneis[0].fonte, 'caixa');
});

test('B6 barbeiro "só agenda" (tudo bloqueado): 2 anéis dele, horas livres e próximos; nunca vazio', async () => {
  const amb = ambiente();
  const h = await montar(amb, perm(amb, { id: 2, papel: 'funcionario', gravado: SO_AGENDA }));
  assert.deepEqual(aneis(h), ['atendimentos', 'ocupacao']);
  assert.ok(h.horasLivres && Array.isArray(h.horasLivres.histograma));
  assert.ok(Array.isArray(h.proximos));
  assert.ok(tipos(h).every((t) => t === 'horario_vago'));
});

test('B6 meta do barbeiro aparece no anel dele (Caio tem meta de faturamento)', async () => {
  const amb = ambiente();
  const h = await montar(amb, perm(amb, { id: 3, papel: 'funcionario' }));
  assert.equal(h.aneis[0].meta.alvo, 50000);
});

test('B6 destaque de meta perto (>= 80%) e de cliente sumido para o admin', async () => {
  const amb = ambiente();
  amb.banco._tabelas.meta.push({ id: 9, barbeariaId: 1, usuarioId: null, metrica: 'atendimentos', alvo: 1, criadoEm: new Date() });
  amb.banco._tabelas.meta.push({ id: 10, barbeariaId: 1, usuarioId: null, metrica: 'faturamento', alvo: 1, criadoEm: new Date() });
  amb.banco._tabelas.meta[0].alvo = 1; // a de faturamento da barbearia vira batida
  const ag = amb.banco._tabelas.agendamento;
  // Meta de atendimentos do Bruno (10): com mais 7 concluídos hoje ele fica entre 8 e 9 (80% a 90%).
  const base = new Date();
  for (let i = 0; i < 7; i++) ag.push({ id: 300 + i, barbeariaId: 1, usuarioId: 2, status: 'concluido', valorTotal: 0, data: new Date(base.getFullYear(), base.getMonth(), base.getDate()), horaInicio: '08:00', concluidoEm: new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 30), clienteNome: 'X' });
  amb.banco._tabelas.cliente.push({ id: 5, barbeariaId: 1, nome: 'Cliente Sumido', telefone: '11988887777', criadoEm: diaRel(-120) });
  ag.push({ id: 50, barbeariaId: 1, usuarioId: 2, clienteId: 5, clienteNome: 'Cliente Sumido', data: diaRel(-100), horaInicio: '10:00', status: 'concluido', valorTotal: 5000, concluidoEm: diaRel(-100) });
  const h = await montar(amb, perm(amb));
  const perto = h.destaques.filter((d) => d.tipo === 'meta_perto');
  assert.ok(perto.some((d) => d.metaId === 2), 'meta de atendimentos do Bruno');
  assert.ok(!perto.some((d) => d.metaId === 1), 'meta batida não é "perto"');
  assert.ok(tipos(h).includes('cliente_sumido'));
});

test('B6 cache de 60 s por pessoa e invalidação quando a barbearia grava', async () => {
  const amb = ambiente();
  const p = perm(amb);
  const a = await montar(amb, p);
  assert.equal(a.cache, false);
  const b = await montar(amb, p);
  assert.equal(b.cache, true);
  amb.metricas.invalidar(1);
  const c = await montar(amb, p);
  assert.equal(c.cache, false);
});

test('B6 rota /painel/api/home', async () => {
  const amb = ambiente();
  const ctrl = require('../src/controllers/gestaoApiController.js');
  const res = resFalso();
  res.set = () => res;
  await ctrl.inicio(reqFalso({ barbeariaId: 1, permissoes: perm(amb, { id: 2, papel: 'funcionario', gravado: SO_AGENDA }) }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(aneis(res.enviado), ['atendimentos', 'ocupacao']);
});
