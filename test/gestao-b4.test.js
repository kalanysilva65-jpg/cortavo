// Spec 12, fatia B4: services/metricas.js + /painel/api/gestao/*.
//  - critério 10: os números da Gestão batem com os da tela de Relatórios atual
//    (mesmos dados, mesmos períodos: hoje, semana, mês, ano e personalizado);
//  - critério 5: barbeiro sem numeros_barbearia só recebe os PRÓPRIOS dados;
//  - critério 4: dado bloqueado devolve 403 sem dado;
//  - cache de 60 s e invalidação.
// Banco em memória com dados fictícios; nada toca banco real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoGestao, diaRel } = require('./helpers/dadosGestao');
const { iso } = (() => ({ iso: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }))();

function ambiente() {
  const banco = bancoGestao();
  const metricas = carregar('src/services/metricas.js', { prisma: banco });
  metricas.limparCache();
  const relatorio = require('../src/controllers/relatorioController.js');
  const permissoes = require('../src/services/permissoes.js');
  const planoCortavo = require('../src/services/planoCortavo.js');
  const ctrl = require('../src/controllers/gestaoApiController.js');
  return { banco, metricas, relatorio, permissoes, planoCortavo, ctrl };
}

function permissoesDe(amb, { id = 1, papel = 'admin', gravado = null, plano = 'barbearia' } = {}) {
  return amb.permissoes.contexto({ id, papel }, { acessosBloqueados: gravado }, amb.planoCortavo.PLANOS[plano]);
}

async function relatorioDe(amb, query) {
  const res = resFalso();
  await amb.relatorio.ver(reqFalso({ barbeariaId: 1, query }), res);
  return res.renderizou.dados;
}

async function cartao(amb, slug, query, perm = permissoesDe(amb), barbeiroFiltro = null) {
  return amb.metricas.calcular(slug, { barbeariaId: 1, permissoes: perm, query: { ...query, detalhe: '1' }, barbeiroFiltro });
}

const PERIODOS = [
  { periodo: 'hoje' },
  { periodo: 'semana' },
  { periodo: 'mes' },
  { periodo: 'ano' },
  { periodo: 'custom', de: iso(diaRel(-90)), ate: iso(diaRel(0)) },
  { periodo: 'custom', de: iso(diaRel(-500)), ate: iso(diaRel(-30)) },
];

for (const q of PERIODOS) {
  const nome = q.periodo + (q.de ? ` ${q.de}..${q.ate}` : '');

  test(`B4 critério 10 — ${nome}: faturamento, atendimentos, ticket e lucro batem com o Relatórios`, async () => {
    const amb = ambiente();
    const rel = await relatorioDe(amb, q);
    const fat = await cartao(amb, 'faturamento', q);
    assert.equal(fat.resumo.total, rel.faturamento);
    assert.equal(fat.resumo.variacaoPct, rel.variacaoFaturamento);
    assert.equal(fat.detalhe.servicosValor, rel.servicosValor);
    assert.equal(fat.detalhe.produtosValor, rel.produtosValor);
    assert.equal(fat.resumo.serie.reduce((s, v) => s + v, 0), rel.faturamento, 'a soma das barras fecha com o total');
    const at = await cartao(amb, 'atendimentos', q);
    assert.equal(at.resumo.total, rel.atendimentos);
    const tk = await cartao(amb, 'ticket', q);
    assert.equal(tk.resumo.valor, rel.ticketMedio);
    assert.equal(tk.resumo.variacaoPct, rel.variacaoTicket);
    assert.equal(tk.resumo.porCliente, rel.ticketPorCliente);
    assert.equal(tk.detalhe.comProduto.valor, rel.ticketData.com);
    assert.equal(tk.detalhe.soServico.valor, rel.ticketData.sem);
    const lu = await cartao(amb, 'lucro', q);
    assert.equal(lu.resumo.lucro, rel.lucro);
    assert.equal(lu.resumo.gastos, rel.gastos);
    assert.equal(lu.resumo.variacaoPct, rel.variacaoLucro);
    assert.equal(lu.resumo.margemPct, rel.margemPct);
    assert.equal(lu.resumo.pontoEquilibrio, rel.breakEven);
    assert.equal(lu.resumo.gastosPctFat, rel.gastosPctFat);
    assert.deepEqual(lu.detalhe.gastos.map((g) => [g.nome, g.valor, g.pct]), rel.gastoRows.map((g) => [g.name, g.valor, g.pct]));
  });

  test(`B4 critério 10 — ${nome}: ocupação, equipe, serviços, produtos, clientes e pagamentos batem`, async () => {
    const amb = ambiente();
    const rel = await relatorioDe(amb, q);
    const oc = await cartao(amb, 'ocupacao', q);
    assert.equal(oc.resumo.pct, rel.ocupacaoPct);
    assert.deepEqual(oc.detalhe.porBarbeiro.map((x) => [x.nome, x.pct]), rel.ocupPorBarbeiro.map((x) => [x.name, x.pct]));
    assert.deepEqual(oc.detalhe.porDiaSemana.map((x) => x.atendimentos), rel.ocupWeekBars.map((x) => x.value));
    const g2 = await cartao(amb, 'faturamento-barbeiros', q);
    assert.deepEqual(g2.resumo.barbeiros.map((x) => [x.nome, x.valor, x.qtd, x.pct, x.ticket]), rel.barberPerf.map((x) => [x.name, x.valor, x.qtd, x.pct, x.ticket]));
    const g7 = await cartao(amb, 'equipe', q);
    assert.deepEqual(g7.resumo.barbeiros.map((x) => [x.nome, x.faturamento, x.atendimentos, x.ticket]), rel.barberPerf.map((x) => [x.name, x.valor, x.qtd, x.ticket]));
    const sv = await cartao(amb, 'servicos', q);
    assert.deepEqual(sv.resumo.top.map((x) => [x.nome, x.valor, x.qtd, x.pct]), rel.topServices.map((x) => [x.name, x.valor, x.qtd, x.pct]));
    assert.equal(sv.resumo.total, rel.servicosValor);
    const pr = await cartao(amb, 'produtos', q);
    assert.deepEqual(pr.detalhe.itens.slice(0, 6).map((x) => [x.qtd, x.nome, x.valor]), rel.relProdutosRows.map((x) => [x.qty, x.name, x.valor]));
    assert.equal(pr.resumo.qtd, rel.relProdutosTotalQty);
    const cl = await cartao(amb, 'clientes', q);
    for (const k of ['novos', 'recorrentes', 'total', 'novosPct', 'recorrentesPct', 'receitaNovos', 'receitaRecorrentes', 'unicos', 'visitas']) {
      assert.equal(cl.resumo[k], rel.clientesData[k], k);
    }
    assert.equal(cl.resumo.voltaramNoPeriodo, rel.clientesData.voltaram);
    const pg = await cartao(amb, 'pagamentos', q);
    assert.deepEqual(pg.resumo.formas.map((f) => [f.label, f.valor, f.qtd, f.pct, f.ticket]), rel.formasPagamento.map((f) => [f.label, f.valor, f.qtd, f.pct, f.ticket]));
    assert.equal(pg.resumo.total, rel.pagData.total);
    assert.equal(pg.resumo.naHoraValor, rel.pagData.naHoraValor);
  });
}

test('B4 a barbearia 2 nunca aparece nos números da barbearia 1', async () => {
  const amb = ambiente();
  const fat = await cartao(amb, 'faturamento', { periodo: 'hoje' });
  // Hoje na barbearia 1: atendimento 8 (R$ 80) + troco inicial (R$ 10). A outra tem R$ 99.
  assert.equal(fat.resumo.total, 9000);
  const lista = await cartao(amb, 'atendimentos-lista', { periodo: 'hoje' });
  assert.ok(lista.resumo.atendimentos.every((a) => a.cliente !== 'Cliente Outra'));
});

test('B4 "faltou" e "cancelado" não contam na ocupação (horário ocioso)', async () => {
  const amb = ambiente();
  const oc = await cartao(amb, 'ocupacao', { periodo: 'hoje' });
  // Hoje ativos: ag 7 (Bruno, Corte 30) + 8 (Caio, Pigmentação 60) + 11 (Bruno, agendado, Corte 30) = 120 min.
  assert.equal(oc.resumo.horasAtendidas, 2);
});

// ---------- critério 5: barbeiro só recebe os próprios dados ----------
const SLUGS_PROPRIOS = ['faturamento', 'ticket', 'atendimentos', 'ocupacao', 'horas-livres', 'servicos', 'produtos', 'clientes', 'pagamentos', 'origem', 'atendimentos-lista', 'metas'];

test('B4 critério 5: barbeiro padrão (sem numeros_barbearia) recebe só dados com o usuarioId dele, em todos os cartões', async () => {
  const amb = ambiente();
  const bruno = permissoesDe(amb, { id: 2, papel: 'funcionario' });
  const q = { periodo: 'custom', de: iso(diaRel(-500)), ate: iso(diaRel(5)) };
  for (const slug of SLUGS_PROPRIOS) {
    const r = await cartao(amb, slug, q, bruno);
    assert.deepEqual(r.escopo, { tipo: 'barbeiro', usuarioId: 2 }, slug);
  }
  const fat = await cartao(amb, 'faturamento', q, bruno);
  const deBruno = amb.banco._tabelas.agendamento.filter((a) => a.barbeariaId === 1 && a.usuarioId === 2 && a.status === 'concluido');
  assert.equal(fat.resumo.total, deBruno.reduce((s, a) => s + a.valorTotal, 0));
  assert.equal(fat.resumo.fonte, 'atendimentos');
  const lista = await cartao(amb, 'atendimentos-lista', q, bruno);
  assert.ok(lista.resumo.atendimentos.length > 0);
  assert.ok(lista.resumo.atendimentos.every((a) => a.barbeiro.usuarioId === 2));
  const sv = await cartao(amb, 'servicos', q, bruno);
  assert.ok(!sv.detalhe.itens.some((x) => x.nome === 'Pigmentação'), 'pigmentação só o Caio fez');
  const metas = await cartao(amb, 'metas', q, bruno);
  assert.deepEqual(metas.resumo.metas.map((m) => m.id), [2], 'só a meta dele');
  // Nenhum cartão traz o detalhe por barbeiro para ele.
  const oc = await cartao(amb, 'ocupacao', q, bruno);
  assert.equal(oc.detalhe.porBarbeiro, undefined);
});

test('B4 critério 5: dois barbeiros recebem números diferentes e cada um só os seus', async () => {
  const amb = ambiente();
  const q = { periodo: 'ano' };
  const b = await cartao(amb, 'atendimentos-lista', q, permissoesDe(amb, { id: 2, papel: 'funcionario' }));
  const c = await cartao(amb, 'atendimentos-lista', q, permissoesDe(amb, { id: 3, papel: 'funcionario' }));
  const idsB = b.resumo.atendimentos.map((a) => a.id);
  const idsC = c.resumo.atendimentos.map((a) => a.id);
  assert.ok(idsB.length && idsC.length);
  assert.ok(idsB.every((id) => !idsC.includes(id)));
});

test('B4 critério 4: barbeiro sem a chave recebe 403 sem dado (lucro, planos, equipe, outro barbeiro)', async () => {
  const amb = ambiente();
  const bruno = permissoesDe(amb, { id: 2, papel: 'funcionario' });
  for (const slug of ['lucro', 'planos', 'equipe', 'faturamento-barbeiros']) {
    await assert.rejects(cartao(amb, slug, { periodo: 'mes' }, bruno), (e) => e.status === 403, slug);
  }
  await assert.rejects(cartao(amb, 'faturamento', { periodo: 'mes' }, bruno, 3), (e) => e.status === 403);
  // "Só agenda": sem meus_numeros, faturamento some; atendimentos e ocupação dele continuam.
  const soAgenda = permissoesDe(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, bloqueados: ['meus_numeros', 'comissoes', 'clientes'] }) });
  await assert.rejects(cartao(amb, 'faturamento', { periodo: 'mes' }, soAgenda), (e) => e.status === 403);
  assert.equal((await cartao(amb, 'atendimentos', { periodo: 'mes' }, soAgenda)).escopo.usuarioId, 2);
});

test('B4 barbeiro com numeros_barbearia vê os totais da barbearia, mas não a equipe; com ranking, vê a equipe sem comissão', async () => {
  const amb = ambiente();
  const q = { periodo: 'mes' };
  const rel = await relatorioDe(amb, q);
  const nb = permissoesDe(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, liberados: ['numeros_barbearia'] }) });
  const fat = await cartao(amb, 'faturamento', q, nb);
  assert.equal(fat.resumo.total, rel.faturamento);
  assert.equal(fat.escopo.tipo, 'barbearia');
  const oc = await cartao(amb, 'ocupacao', q, nb);
  assert.equal(oc.detalhe.porBarbeiro, undefined, 'sem ranking, sem os outros barbeiros');
  await assert.rejects(cartao(amb, 'equipe', q, nb), (e) => e.status === 403);
  const rk = permissoesDe(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, liberados: ['ranking_equipe'] }) });
  const eq = await cartao(amb, 'equipe', q, rk);
  assert.ok(eq.resumo.barbeiros.length >= 2);
  assert.ok(eq.resumo.barbeiros.every((x) => !('comissao' in x)), 'comissão dos colegas fica só com o admin');
  const adm = await cartao(amb, 'equipe', q);
  assert.ok(adm.resumo.barbeiros.every((x) => 'comissao' in x));
});

test('B4 plano Essencial: admin vê faturamento e pagamentos; ticket/serviços ficam fora do plano (403 foraDoPlano)', async () => {
  const amb = ambiente();
  const ess = permissoesDe(amb, { plano: 'essencial' });
  assert.equal((await cartao(amb, 'faturamento', { periodo: 'mes' }, ess)).escopo.tipo, 'barbearia');
  assert.ok(await cartao(amb, 'pagamentos', { periodo: 'mes' }, ess));
  await assert.rejects(cartao(amb, 'ticket', { periodo: 'mes' }, ess), (e) => e.status === 403 && e.foraDoPlano === 'relatorios');
  const lista = amb.metricas.cartoesDisponiveis(ess);
  const ticket = lista.find((c) => c.slug === 'ticket');
  assert.equal(ticket.foraDoPlano, true);
  assert.equal(ticket.texto, 'Disponível no plano Barbearia. Fale com a Cortavo.');
  // Barbeiro no Essencial: o que o plano desliga nem aparece (sem cadeado).
  const barbEss = permissoesDe(amb, { id: 2, papel: 'funcionario', plano: 'essencial' });
  assert.ok(!amb.metricas.cartoesDisponiveis(barbEss).some((c) => c.slug === 'ticket'));
});

test('B4 cartões: ordem da spec para o admin; "só agenda" vê só os da agenda própria', async () => {
  const amb = ambiente();
  const adm = amb.metricas.cartoesDisponiveis(permissoesDe(amb)).map((c) => c.slug);
  assert.deepEqual(adm.slice(0, 5), ['faturamento', 'ocupacao', 'horas-livres', 'ticket', 'atendimentos']);
  const soAgenda = permissoesDe(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, bloqueados: ['meus_numeros', 'comissoes'] }) });
  assert.deepEqual(amb.metricas.cartoesDisponiveis(soAgenda).map((c) => c.slug), ['ocupacao', 'horas-livres', 'atendimentos']);
});

test('B4 período: personalizado acima de 2 anos é recusado (400); De/Até invertidos são aceitos', async () => {
  const amb = ambiente();
  await assert.rejects(cartao(amb, 'faturamento', { de: '2020-01-01', ate: '2026-01-01' }), (e) => e.status === 400);
  const r = await cartao(amb, 'faturamento', { de: iso(diaRel(0)), ate: iso(diaRel(-10)) });
  assert.equal(r.periodo.de, iso(diaRel(-10)));
  assert.equal(r.periodo.chave, 'custom');
});

test('B4 cache de 60 s por chave e invalidação depois de gravar', async () => {
  const amb = ambiente();
  const agora = new Date();
  const args = { barbeariaId: 1, permissoes: permissoesDe(amb), query: { periodo: 'hoje' }, agora };
  const a = await amb.metricas.calcular('faturamento', args);
  assert.equal(a.cache, false);
  amb.banco._tabelas.caixa.push({ id: 999, barbeariaId: 1, tipo: 'entrada', valor: 100, data: new Date(), descricao: 'x' });
  const b = await amb.metricas.calcular('faturamento', args);
  assert.equal(b.cache, true);
  assert.equal(b.resumo.total, a.resumo.total, 'dentro de 60 s, o número guardado');
  const depois = await amb.metricas.calcular('faturamento', { ...args, agora: new Date(agora.getTime() + 61000) });
  assert.equal(depois.cache, false);
  assert.equal(depois.resumo.total, a.resumo.total + 100);
  amb.metricas.invalidar(1);
  const c = await amb.metricas.calcular('faturamento', args);
  assert.equal(c.cache, false);
});

test('B4 horas livres de hoje: jornada menos atendimentos e bloqueios, só do que ainda não passou', async () => {
  const amb = ambiente();
  const agora = new Date();
  agora.setHours(7, 0, 0, 0); // antes de todos abrirem: o dia inteiro conta
  const bruno = permissoesDe(amb, { id: 2, papel: 'funcionario' });
  const r = await amb.metricas.calcular('horas-livres', { barbeariaId: 1, permissoes: bruno, query: { periodo: 'hoje' }, agora });
  const dow = new Date().getDay();
  // Bruno: 09–18 (540 min) menos Corte 09:00? (ag 7 às horas[7%6]=10:00, 30 min), ag 11 às 15:00 (30 min) e almoço 12–13 (60).
  const esperado = dow === 0 ? 0 : 540 - 30 - 30 - 60;
  assert.equal(r.resumo.livresMin, esperado);
  if (esperado) {
    const h12 = r.resumo.histograma.find((h) => h.hora === '12h');
    assert.equal(h12.livresMin, 0);
  }
});

// ---------- rotas ----------
test('B4 rota: /api/gestao/:metrica responde 403 JSON sem dado e 400 para barbeiro de fora', async () => {
  const amb = ambiente();
  const req = reqFalso({ barbeariaId: 1, params: { metrica: 'lucro' }, query: { periodo: 'mes' }, permissoes: permissoesDe(amb, { id: 2, papel: 'funcionario' }) });
  const res = resFalso();
  res.set = () => res;
  await amb.ctrl.metrica(req, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.enviado, { erro: 'Sem acesso a esta área.', semPermissao: true });
  const req2 = reqFalso({ barbeariaId: 1, params: { metrica: 'faturamento' }, query: { barbeiro: '20' }, permissoes: permissoesDe(amb) });
  const res2 = resFalso();
  res2.set = () => res2;
  await amb.ctrl.metrica(req2, res2);
  assert.equal(res2.statusCode, 400, 'o barbeiro 20 é de outra barbearia');
  const req3 = reqFalso({ barbeariaId: 1, params: { metrica: 'nao-existe' }, query: {}, permissoes: permissoesDe(amb) });
  const res3 = resFalso();
  res3.set = () => res3;
  await amb.ctrl.metrica(req3, res3);
  assert.equal(res3.statusCode, 404);
});

test('B4 rota: admin filtra por barbeiro e recebe o escopo dele', async () => {
  const amb = ambiente();
  const req = reqFalso({ barbeariaId: 1, params: { metrica: 'faturamento' }, query: { periodo: 'ano', barbeiro: '3' }, permissoes: permissoesDe(amb) });
  const res = resFalso();
  res.set = () => res;
  await amb.ctrl.metrica(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.enviado.escopo, { tipo: 'barbeiro', usuarioId: 3 });
});
