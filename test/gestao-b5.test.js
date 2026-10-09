// Spec 12, fatia B5: métricas novas (G11 retenção, G12 sumidos, G13
// cancelamentos, G14 faltas, G15 comissões) e baixa de comissão.
// Banco em memória com dados fictícios.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoGestao, diaRel, instante } = require('./helpers/dadosGestao');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function ambiente() {
  const banco = bancoGestao();
  const metricas = carregar('src/services/metricas.js', { prisma: banco });
  metricas.limparCache();
  return {
    banco,
    metricas,
    permissoes: require('../src/services/permissoes.js'),
    planoCortavo: require('../src/services/planoCortavo.js'),
    comissaoCtrl: require('../src/controllers/comissaoController.js'),
    api: require('../src/controllers/gestaoApiController.js'),
  };
}
function perm(amb, { id = 1, papel = 'admin', gravado = null, plano = 'barbearia' } = {}) {
  return amb.permissoes.contexto({ id, papel }, { acessosBloqueados: gravado }, amb.planoCortavo.PLANOS[plano]);
}
function cartao(amb, slug, query, p = perm(amb), barbeiroFiltro = null) {
  return amb.metricas.calcular(slug, { barbeariaId: 1, permissoes: p, query: { ...query, detalhe: '1' }, barbeiroFiltro });
}
function res() {
  const r = resFalso();
  r.set = () => r;
  return r;
}

for (const q of [
  { de: iso(diaRel(-30)), ate: iso(diaRel(0)) },
  { de: iso(diaRel(-400)), ate: iso(diaRel(0)) },
  { de: iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), ate: iso(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)) },
]) {
  test(`B5 G15 bate com a tela de Comissões (${q.de} a ${q.ate})`, async () => {
    const amb = ambiente();
    const r = res();
    await amb.comissaoCtrl.ver(reqFalso({ barbeariaId: 1, ehAdmin: true, query: { inicio: q.de, fim: q.ate }, session: { usuario: { id: 1, papel: 'admin' } } }), r);
    const grupos = r.renderizou.dados.grupos;
    const g15 = await cartao(amb, 'comissoes', q);
    const porId = new Map(g15.resumo.barbeiros.map((x) => [x.usuarioId, x]));
    for (const g of grupos) {
      const m = porId.get(g.barbeiro.id);
      if (!m) {
        assert.equal(g.comissao, 0, 'só some quem não tem comissão');
        continue;
      }
      assert.equal(m.comissao, g.comissao, g.barbeiro.nome);
      assert.equal(m.servicosTotal, g.servicosTotal);
      assert.equal(m.produtosTotal, g.produtosTotal);
      assert.equal(m.faturadoTotal, g.faturadoTotal);
      assert.equal(m.ticketMedio, g.ticketMedio);
      assert.equal(m.ocupacaoPct, g.ocupacaoPct);
    }
    assert.equal(g15.resumo.total, r.renderizou.dados.totalGeralComissao);
  });
}

test('B5 G15: barbeiro vê só a comissão dele; pedir a de outro é 403; sem a chave, 403', async () => {
  const amb = ambiente();
  const q = { periodo: 'ano' };
  const bruno = perm(amb, { id: 2, papel: 'funcionario' });
  const r = await cartao(amb, 'comissoes', q, bruno);
  assert.deepEqual(r.resumo.barbeiros.map((x) => x.usuarioId), [2]);
  // Com ranking ele compara faturamento, mas comissão dos colegas continua fechada.
  const rk = perm(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, liberados: ['ranking_equipe'] }) });
  await assert.rejects(cartao(amb, 'comissoes', q, rk, 3), (e) => e.status === 403);
  const semChave = perm(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, bloqueados: ['comissoes'] }) });
  await assert.rejects(cartao(amb, 'comissoes', q, semChave), (e) => e.status === 403);
  await assert.rejects(cartao(amb, 'comissoes', q, perm(amb, { plano: 'essencial' })), (e) => e.status === 403 && e.foraDoPlano === 'comissoes');
});

test('B5 baixa de comissão: grava quem pagou, lança a saída no caixa, aparece como paga e pode ser desfeita', async () => {
  const amb = ambiente();
  const de = iso(diaRel(-30));
  const ate = iso(diaRel(0));
  const antes = await cartao(amb, 'comissoes', { de, ate });
  const bruno = antes.resumo.barbeiros.find((x) => x.usuarioId === 2);
  assert.ok(bruno.comissao > 0);
  const r = res();
  await amb.api.baixarComissao(reqFalso({ barbeariaId: 1, body: { usuarioId: 2, de, ate, lancarNoCaixa: true, formaPagamento: 'pix', observacao: 'Pago no Pix' }, session: { usuario: { id: 1, nome: 'Ana Admin', papel: 'admin' } } }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.enviado.pagamento.valor, bruno.comissao, 'sem valor = o que falta pagar');
  assert.equal(r.enviado.situacao.aPagar, 0);
  const reg = amb.banco._tabelas.comissaoPagamento[0];
  assert.equal(reg.pagoPorId, 1);
  assert.equal(reg.pagoPorNome, 'Ana Admin');
  assert.equal(reg.valorCalculado, bruno.comissao);
  const saida = amb.banco._tabelas.caixa.find((c) => c.id === reg.caixaId);
  assert.equal(saida.tipo, 'saida');
  assert.equal(saida.valor, bruno.comissao);
  assert.match(saida.descricao, /^Comissão — Bruno Barbeiro/);
  const depois = await cartao(amb, 'comissoes', { de, ate });
  assert.equal(depois.cache, false, 'a baixa invalida o cache');
  const b2 = depois.resumo.barbeiros.find((x) => x.usuarioId === 2);
  assert.equal(b2.situacao, 'paga');
  assert.equal(b2.aPagar, 0);
  assert.equal(depois.detalhe.pagamentos.length, 1);
  // Pagar de novo o mesmo período: nada a pagar.
  const r2 = res();
  await amb.api.baixarComissao(reqFalso({ barbeariaId: 1, body: { usuarioId: 2, de, ate }, session: { usuario: { id: 1, nome: 'Ana Admin' } } }), r2);
  assert.equal(r2.statusCode, 400);
  // Desfazer apaga a baixa e a saída do caixa.
  const r3 = res();
  await amb.api.desfazerBaixaComissao(reqFalso({ barbeariaId: 1, params: { id: String(reg.id) } }), r3);
  assert.equal(r3.enviado.ok, true);
  assert.equal(amb.banco._tabelas.comissaoPagamento.length, 0);
  assert.ok(!amb.banco._tabelas.caixa.some((c) => c.id === reg.caixaId));
});

test('B5 baixa: barbeiro de outra barbearia ou período inválido = 400; desfazer de outra barbearia = 404', async () => {
  const amb = ambiente();
  const r = res();
  await amb.api.baixarComissao(reqFalso({ barbeariaId: 1, body: { usuarioId: 20, de: '2026-01-01', ate: '2026-01-31' }, session: { usuario: { id: 1 } } }), r);
  assert.equal(r.statusCode, 400);
  const r2 = res();
  await amb.api.baixarComissao(reqFalso({ barbeariaId: 1, body: { usuarioId: 2, de: 'ontem', ate: '2026-01-31' }, session: { usuario: { id: 1 } } }), r2);
  assert.equal(r2.statusCode, 400);
  amb.banco._tabelas.comissaoPagamento.push({ id: 77, barbeariaId: 9, usuarioId: 20, valor: 100 });
  const r3 = res();
  await amb.api.desfazerBaixaComissao(reqFalso({ barbeariaId: 1, params: { id: '77' } }), r3);
  assert.equal(r3.statusCode, 404);
  assert.equal(amb.banco._tabelas.comissaoPagamento.length, 1);
});

test('B5 G13 cancelamentos: número, %, quem cancelou e motivo; barbeiro só os dele', async () => {
  const amb = ambiente();
  const q = { de: iso(diaRel(-30)), ate: iso(diaRel(5)) };
  const r = await cartao(amb, 'cancelamentos', q);
  assert.equal(r.resumo.total, 2);
  const noPeriodo = amb.banco._tabelas.agendamento.filter((a) => a.barbeariaId === 1 && a.data >= diaRel(-30) && a.data < diaRel(6)).length;
  assert.equal(r.resumo.agendamentos, noPeriodo);
  assert.deepEqual(r.resumo.motivos, [{ motivo: 'Chuva', total: 1 }]);
  assert.deepEqual(r.resumo.porQuem.map((x) => x.quem).sort(), ['cliente', 'equipe']);
  const caio = await cartao(amb, 'cancelamentos', q, perm(amb, { id: 3, papel: 'funcionario' }));
  assert.equal(caio.resumo.total, 0);
});

test('B5 G14 faltas: separado de cancelado, % sobre concluídos + faltas, ranking sem telefone', async () => {
  const amb = ambiente();
  const q = { de: iso(diaRel(-30)), ate: iso(diaRel(0)) };
  const r = await cartao(amb, 'faltas', q);
  assert.equal(r.resumo.total, 2);
  assert.ok(r.resumo.clientes.every((c) => !('telefone' in c)));
  const caio = await cartao(amb, 'faltas', q, perm(amb, { id: 3, papel: 'funcionario' }));
  assert.equal(caio.resumo.total, 2);
  const bruno = await cartao(amb, 'faltas', q, perm(amb, { id: 2, papel: 'funcionario' }));
  assert.equal(bruno.resumo.total, 0);
});

function comSumido(amb) {
  amb.banco._tabelas.cliente.push({ id: 5, barbeariaId: 1, nome: 'Cliente Sumido', telefone: '11988887777', criadoEm: diaRel(-120) });
  amb.banco._tabelas.agendamento.push({ id: 50, barbeariaId: 1, usuarioId: 2, clienteId: 5, clienteNome: 'Cliente Sumido', data: diaRel(-100), horaInicio: '10:00', status: 'concluido', valorTotal: 5000, concluidoEm: instante(-100, 10) });
}

test('B5 G12 clientes sumidos: lista quem não vem há mais de X dias; telefone só com clientes_contato', async () => {
  const amb = ambiente();
  comSumido(amb);
  const r = await cartao(amb, 'clientes-sumidos', { dias: '60' });
  assert.deepEqual(r.resumo.clientes.map((c) => c.nome), ['Cliente Sumido']);
  assert.equal(r.resumo.clientes[0].diasSemVir, 100);
  assert.equal(r.resumo.clientes[0].whatsapp, 'https://wa.me/5511988887777');
  // Bruno atendeu a última visita: ele vê; Caio não.
  assert.equal((await cartao(amb, 'clientes-sumidos', { dias: '60' }, perm(amb, { id: 2, papel: 'funcionario' }))).resumo.total, 1);
  assert.equal((await cartao(amb, 'clientes-sumidos', { dias: '60' }, perm(amb, { id: 3, papel: 'funcionario' }))).resumo.total, 0);
  const semContato = perm(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, bloqueados: ['clientes_contato'] }) });
  const m = await cartao(amb, 'clientes-sumidos', { dias: '60' }, semContato);
  assert.equal(m.resumo.clientes[0].telefone, '•••• 7777');
  assert.equal(m.resumo.clientes[0].whatsapp, null);
  // Sem a chave "clientes", a lista não sai.
  const semClientes = perm(amb, { id: 2, papel: 'funcionario', gravado: JSON.stringify({ v: 2, bloqueados: ['clientes'] }) });
  await assert.rejects(cartao(amb, 'clientes-sumidos', {}, semClientes), (e) => e.status === 403);
});

test('B5 G11 retenção: coortes de 12 meses, só quem já teve tempo de voltar entra na conta', async () => {
  const amb = ambiente();
  comSumido(amb);
  const r = await cartao(amb, 'retencao', { periodo: 'mes' });
  assert.equal(r.resumo.coortes.length, 12);
  // Clientes com 1ª visita na janela: Um (-150), Três (-2), Quatro (-10), Sumido (-100). Dois veio há 400 dias.
  assert.equal(r.resumo.clientes, 4);
  // Maduros para 90 dias: Um e Sumido; nenhum voltou em até 90 dias.
  assert.equal(r.resumo.voltou90Pct, 0);
  await assert.rejects(cartao(amb, 'retencao', { periodo: 'mes' }, perm(amb, { id: 2, papel: 'funcionario' })), (e) => e.status === 403);
});
