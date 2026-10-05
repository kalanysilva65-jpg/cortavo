// Fase 2.6/2.7 (spec 05): teste grátis de 14 dias, rotina diária, prorrogação,
// vagas de fundador e contador de 250 respostas. Relógio SIMULADO: sem banco,
// sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { RAIZ, carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

const VIEWS = path.join(RAIZ, 'src/views');
const render = (v, dados) => ejs.renderFile(path.join(VIEWS, v), dados);
const DIA = 86400000;

// Criada em 20/10/2026 às 10:00 de Brasília (13:00 UTC).
const CRIACAO = new Date('2026-10-20T13:00:00Z');
const noDia = (n, horaUtc = '15:00') => new Date(new Date(`2026-10-20T${horaUtc}:00Z`).getTime() + n * DIA);

// Banco em memória só com o que o teste grátis usa.
function bancoFalso(barbearias, { donos = [{ id: 1 }] } = {}) {
  const casa = (b, where = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(b[k]);
    if (v === null) return b[k] == null;
    return b[k] === v;
  });
  const aplica = (b, data) => {
    for (const [k, v] of Object.entries(data)) b[k] = v && typeof v === 'object' && 'increment' in v ? (b[k] || 0) + v.increment : v;
  };
  const prisma = prismaFalso({
    barbearia: {
      findMany: async ({ where } = {}) => barbearias.filter((b) => casa(b, where)).map((b) => ({ ...b })),
      findUnique: async ({ where }) => { const b = barbearias.find((x) => x.id === where.id); return b ? { ...b } : null; },
      count: async ({ where } = {}) => barbearias.filter((b) => casa(b, where)).length,
      updateMany: async ({ where, data }) => {
        const alvo = barbearias.filter((b) => casa(b, where));
        alvo.forEach((b) => aplica(b, data));
        return { count: alvo.length };
      },
      update: async ({ where, data }) => { const b = barbearias.find((x) => x.id === where.id); aplica(b, data); return { ...b }; },
    },
    usuario: { findMany: async () => donos },
  });
  return prisma;
}

function servico(barbearias, opcoes) {
  const auditorias = [];
  const tg = carregar('src/services/testeGratis.js', {
    prisma: bancoFalso(barbearias, opcoes),
    stubs: { 'src/services/auditoria.js': { registrar: async (_req, a) => { auditorias.push(a); } } },
  });
  return { tg, auditorias };
}

function emTeste(extra = {}) {
  const tg = carregar('src/services/testeGratis.js');
  return {
    id: 7, nome: 'Barbearia Nova', ativo: true, planoCortavo: 'barbearia_ia',
    testeProrrogado: false, testeSegurarPausa: false, testePagoEm: null,
    testeAvisoFimEm: null, testeAvisoVencidoEm: null, testeRespostas: 0, fundador: null,
    ...tg.dadosNovoTeste(CRIACAO), ...extra,
  };
}

// ---------- Critério 1 ----------
test('C1 criada hoje: "termina em 14 dias"; no dia 12 o aviso aparece e a Kalany é notificada', async () => {
  const b = emTeste();
  const { tg } = servico([b]);
  assert.equal(tg.faixaDono(b, CRIACAO).texto, 'Seu teste grátis termina em 14 dias.');
  assert.equal(tg.faixaDono(b, CRIACAO).aviso, false);
  assert.equal(tg.faixaDono(b, noDia(11)).texto, 'Seu teste grátis termina em 3 dias.');
  const d12 = tg.faixaDono(b, noDia(12));
  assert.equal(d12.texto, 'Seu teste termina em 2 dias. A Cortavo vai falar com você para continuar.');
  assert.equal(d12.aviso, true);
  assert.doesNotMatch(d12.texto, /pagar|assinar|R\$/i);

  const enviados = [];
  const banco = [b];
  const s = servico(banco);
  const r = await s.tg.rodarRotina({ agora: noDia(12), notificar: async (id, aviso) => enviados.push({ id, aviso }) });
  assert.equal(r.avisosFim, 1);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].id, 1);
  assert.match(enviados[0].aviso.corpo, /Barbearia Nova/);
  assert.ok(banco[0].testeAvisoFimEm);
});

test('C1 barbearia fora do teste (as que já existiam) não mostra faixa', () => {
  const tg = carregar('src/services/testeGratis.js');
  assert.equal(tg.faixaDono({ situacaoCortavo: 'ativa', testeFim: null }), null);
  assert.equal(tg.faixaDono(null), null);
});

// ---------- Critério 2 ----------
test('C2 dia 15 sem pagamento: aviso à Kalany e NADA pausado; dia 16 sem "Segurar pausa": pausa real', async () => {
  const banco = [emTeste({ fundador: 'reservada' })];
  const { tg, auditorias } = servico(banco);
  const enviados = [];
  const notificar = async (id, aviso) => enviados.push(aviso.titulo);

  await tg.rodarRotina({ agora: noDia(15), notificar });
  assert.equal(banco[0].ativo, true, 'dia 15 só avisa');
  assert.ok(banco[0].testeAvisoVencidoEm);
  assert.ok(enviados.includes('Teste acabou sem pagamento'));

  const r = await tg.rodarRotina({ agora: noDia(16), notificar });
  assert.equal(r.pausadas, 1);
  assert.equal(banco[0].ativo, false, 'usa a pausa de verdade (ativo = false, spec 01)');
  assert.equal(banco[0].situacaoCortavo, 'pausada_teste');
  assert.equal(banco[0].fundador, null, 'a vaga de fundador volta');
  assert.ok(auditorias.some((a) => a.acao === 'teste.pausar'));
  assert.ok(enviados.includes('Acesso pausado'));
});

test('C2 com "Segurar pausa" o dia 16 não pausa', async () => {
  const banco = [emTeste({ testeSegurarPausa: true })];
  const { tg } = servico(banco);
  await tg.rodarRotina({ agora: noDia(15), notificar: async () => {} });
  const r = await tg.rodarRotina({ agora: noDia(16), notificar: async () => {} });
  assert.equal(r.seguradas, 1);
  assert.equal(banco[0].ativo, true);
  assert.equal(banco[0].situacaoCortavo, 'teste');
});

test('C2 rotina que não rodou no dia 15: avisa primeiro e só pausa no dia seguinte', async () => {
  const banco = [emTeste()];
  const { tg } = servico(banco);
  await tg.rodarRotina({ agora: noDia(17), notificar: async () => {} });
  assert.equal(banco[0].ativo, true);
  await tg.rodarRotina({ agora: noDia(18), notificar: async () => {} });
  assert.equal(banco[0].ativo, false);
});

test('C2 a pausa do teste usa a mesma pausa da spec 01 (pausa.estaPausada)', async () => {
  const banco = [emTeste()];
  const { tg } = servico(banco);
  await tg.rodarRotina({ agora: noDia(15), notificar: async () => {} });
  await tg.rodarRotina({ agora: noDia(16), notificar: async () => {} });
  const pausa = carregar('src/services/pausa.js', { prisma: bancoFalso(banco) });
  assert.equal(await pausa.estaPausada(7), true);
});

// ---------- Critério 3 ----------
test('C3 dia 15 com pagamento confirmado: nada é pausado e a situação vira "ativa" (fundador confirmado)', async () => {
  const banco = [emTeste({ testePagoEm: noDia(10), fundador: 'reservada' })];
  const { tg } = servico(banco);
  const enviados = [];
  const r = await tg.rodarRotina({ agora: noDia(15), notificar: async (id, a) => enviados.push(a) });
  assert.equal(r.convertidas, 1);
  assert.equal(banco[0].situacaoCortavo, 'ativa');
  assert.equal(banco[0].fundador, 'confirmada');
  await tg.rodarRotina({ agora: noDia(16), notificar: async (id, a) => enviados.push(a) });
  assert.equal(banco[0].ativo, true);
  assert.equal(enviados.length, 0);
});

test('C3 "Registrar pagamento" no mestre converte na hora e grava auditoria', async () => {
  const banco = [emTeste({ fundador: 'reservada' })];
  const auditorias = [];
  const m = carregar('src/controllers/mestreController.js', {
    prisma: bancoFalso(banco),
    stubs: { 'src/services/auditoria.js': { registrar: async (_r, a) => { auditorias.push(a); } } },
  });
  const req = reqFalso({ params: { id: '7' } });
  const res = resFalso();
  await m.registrarPagamentoTeste(req, res);
  assert.equal(banco[0].situacaoCortavo, 'ativa');
  assert.equal(banco[0].fundador, 'confirmada');
  assert.ok(banco[0].testePagoEm);
  assert.equal(auditorias[0].acao, 'teste.pago');
});

// ---------- Critério 4 ----------
test('C4 prorrogar uma vez funciona; a segunda é recusada com mensagem clara', async () => {
  const banco = [emTeste()];
  const auditorias = [];
  const m = carregar('src/controllers/mestreController.js', {
    prisma: bancoFalso(banco),
    stubs: { 'src/services/auditoria.js': { registrar: async (_r, a) => { auditorias.push(a); } } },
  });
  const fimAntes = banco[0].testeFim.getTime();
  let req = reqFalso({ params: { id: '7' }, body: { dias: '7', motivo: 'Dono viajou' } });
  await m.prorrogarTeste(req, resFalso());
  assert.equal(req.session.flash.tipo, 'sucesso');
  assert.equal(banco[0].testeFim.getTime(), fimAntes + 7 * DIA);
  assert.equal(banco[0].testeProrrogado, true);
  assert.match(auditorias[0].detalhe, /Dono viajou/);

  req = reqFalso({ params: { id: '7' }, body: { dias: '3', motivo: 'De novo' } });
  await m.prorrogarTeste(req, resFalso());
  assert.equal(req.session.flash.tipo, 'erro');
  assert.match(req.session.flash.texto, /já foi prorrogado uma vez/);
  assert.equal(banco[0].testeFim.getTime(), fimAntes + 7 * DIA, 'fim não muda na segunda tentativa');
});

test('C4 prorrogação: mais de 7 dias ou sem motivo é recusado', () => {
  const tg = carregar('src/services/testeGratis.js');
  const b = emTeste();
  assert.match(tg.validarProrrogacao(b, '8', 'x').erro, /1 a 7/);
  assert.match(tg.validarProrrogacao(b, '0', 'x').erro, /1 a 7/);
  assert.match(tg.validarProrrogacao(b, '3', '   ').erro, /motivo/);
  assert.match(tg.validarProrrogacao({ ...b, situacaoCortavo: 'ativa' }, '3', 'x').erro, /em teste/);
});

test('C4 depois de prorrogar, a pausa anda junto: dia 16 não pausa, dia 23 pausa', async () => {
  const b = emTeste();
  b.testeFim = new Date(b.testeFim.getTime() + 7 * DIA);
  b.testeProrrogado = true;
  const banco = [b];
  const { tg } = servico(banco);
  await tg.rodarRotina({ agora: noDia(15), notificar: async () => {} });
  await tg.rodarRotina({ agora: noDia(16), notificar: async () => {} });
  assert.equal(banco[0].ativo, true);
  await tg.rodarRotina({ agora: noDia(22), notificar: async () => {} });
  await tg.rodarRotina({ agora: noDia(23), notificar: async () => {} });
  assert.equal(banco[0].ativo, false);
});

// ---------- Critério 5 ----------
test('C5 com 5 vagas reservadas, a 6ª barbearia em teste não recebe vaga e o painel avisa', async () => {
  const banco = [1, 2, 3, 4, 5].map((id) => ({ id, nome: 'B' + id, situacaoCortavo: 'teste', fundador: id === 5 ? 'confirmada' : 'reservada' }));
  const criadas = [];
  const prisma = bancoFalso(banco);
  prisma.barbearia.create = async ({ data }) => { criadas.push(data); return { id: 6, ...data }; };
  prisma.usuario.create = async () => ({});
  prisma.configuracao = { upsert: async () => ({}) };
  const m = carregar('src/controllers/mestreController.js', { prisma, stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  const req = reqFalso({ body: { nome: 'Sexta', slug: 'sexta', adminNome: 'A', adminEmail: 'a@exemplo.test', adminSenha: 'x'.repeat(8), plano: 'barbearia', emTeste: '1' } });
  prisma.barbearia.findUnique = async () => null;
  await m.criarBarbearia(req, resFalso());
  assert.equal(criadas[0].situacaoCortavo, 'teste');
  assert.equal(criadas[0].fundador, undefined, 'sem vaga');
  assert.equal(req.session.flash.tipo, 'aviso');
  assert.match(req.session.flash.texto, /5 vagas de fundador já estão reservadas/);

  const { tg } = servico(banco);
  assert.deepEqual(await tg.vagasFundador(), { usadas: 5, total: 5, livres: 0 });
  assert.equal(await tg.dadosReservaFundador(), null);
});

test('C5 com vaga livre, o teste começa com a vaga reservada; sem "Em teste" nada de teste', async () => {
  const banco = [];
  const criadas = [];
  const prisma = bancoFalso(banco);
  prisma.barbearia.create = async ({ data }) => { criadas.push(data); return { id: 1, ...data }; };
  prisma.barbearia.findUnique = async () => null;
  prisma.usuario.create = async () => ({});
  prisma.configuracao = { upsert: async () => ({}) };
  const m = carregar('src/controllers/mestreController.js', { prisma, stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  const corpo = { nome: 'Primeira', slug: 'primeira', adminNome: 'A', adminEmail: 'a@exemplo.test', adminSenha: 'x'.repeat(8), plano: 'barbearia_ia' };
  await m.criarBarbearia(reqFalso({ body: { ...corpo, emTeste: '1' } }), resFalso());
  assert.equal(criadas[0].fundador, 'reservada');
  assert.equal(criadas[0].testeFim.getTime() - criadas[0].testeInicio.getTime(), 14 * DIA);
  await m.criarBarbearia(reqFalso({ body: { ...corpo } }), resFalso());
  assert.equal(criadas[1].situacaoCortavo, undefined, 'sem marcar: barbearia comum (padrão "ativa")');
});

test('C5 painel-mestre mostra "Vagas de fundador: 5 de 5" e o aviso', async () => {
  const html = await render('mestre/painel.ejs', {
    backup: { situacao: 'nunca' }, filtros: { q: '', status: 'todas' }, total: 0, barbearias: [],
    paginacao: { pagina: 1, totalPaginas: 1 }, planoDe: () => ({ nome: 'Barbearia' }), avisoBarbeiros: () => null,
    testesAtivos: [{ id: 3, nome: 'Em Teste', planoCortavo: 'barbearia', diasRestantes: 9, fundador: 'reservada' }],
    vagasFundador: { usadas: 5, total: 5, livres: 0 },
  });
  assert.match(html, /Testes ativos \(1\)/);
  assert.match(html, /Vagas de fundador: 5 de 5/);
  assert.match(html, /As 5 vagas estão reservadas/);
  assert.match(html, /Em Teste/);
});

// ---------- Critério 6 ----------
test('C6 rodar a rotina duas vezes no mesmo dia não duplica aviso', async () => {
  const banco = [emTeste()];
  const { tg } = servico(banco);
  const enviados = [];
  const notificar = async (id, a) => enviados.push(a);
  await tg.rodarRotina({ agora: noDia(12, '12:00'), notificar });
  await tg.rodarRotina({ agora: noDia(12, '20:00'), notificar });
  await tg.rodarRotina({ agora: noDia(13), notificar });
  assert.equal(enviados.length, 1);
  await tg.rodarRotina({ agora: noDia(15, '12:00'), notificar });
  await tg.rodarRotina({ agora: noDia(15, '20:00'), notificar });
  assert.equal(enviados.length, 2, 'aviso do dia 15 só uma vez, e sem pausa no mesmo dia');
  assert.equal(banco[0].ativo, true);
  await tg.rodarRotina({ agora: noDia(16), notificar });
  await tg.rodarRotina({ agora: noDia(16, '20:00'), notificar });
  assert.equal(enviados.filter((a) => a.titulo === 'Acesso pausado').length, 1, 'pausa uma vez só');
});

// ---------- Critério 7 ----------
test('C7 horário de Brasília: criada 23:30 de 24/10 conta o dia 24 como dia 0 (em UTC já seria 25)', () => {
  const tg = carregar('src/services/testeGratis.js');
  const inicio = new Date('2026-10-25T02:30:00Z'); // 24/10 23:30 em Brasília
  const b = { situacaoCortavo: 'teste', ...tg.dadosNovoTeste(inicio) };
  assert.equal(tg.diasRestantes(b, new Date('2026-10-25T02:59:00Z')), 14, 'ainda 24/10 em Brasília');
  assert.equal(tg.diasRestantes(b, new Date('2026-10-25T03:00:00Z')), 13, 'meia-noite de Brasília vira o dia');
});

test('C7 virada de mês: teste que começa 25/10 termina 08/11 e pausa 10/11', async () => {
  const inicio = new Date('2026-10-25T13:00:00Z');
  const tg0 = carregar('src/services/testeGratis.js');
  const b = { ...emTeste(), ...tg0.dadosNovoTeste(inicio) };
  const banco = [b];
  const { tg } = servico(banco);
  assert.equal(tg.diasRestantes(b, new Date('2026-10-31T15:00:00Z')), 8);
  assert.equal(tg.diasRestantes(b, new Date('2026-11-06T15:00:00Z')), 2);
  assert.equal(tg.diasRestantes(b, new Date('2026-11-08T15:00:00Z')), 0);
  await tg.rodarRotina({ agora: new Date('2026-11-09T15:00:00Z'), notificar: async () => {} });
  assert.equal(banco[0].ativo, true);
  await tg.rodarRotina({ agora: new Date('2026-11-10T02:00:00Z'), notificar: async () => {} }); // 09/11 23:00 em Brasília
  assert.equal(banco[0].ativo, true, 'ainda é dia 9 em Brasília');
  await tg.rodarRotina({ agora: new Date('2026-11-10T03:00:00Z'), notificar: async () => {} }); // 10/11 00:00 em Brasília
  assert.equal(banco[0].ativo, false);
});

// ---------- Secretária no teste: 250 respostas, contador separado (spec 05 regra 4 / spec 07 regra 3) ----------
test('250 no teste do + IA: teto do teste vale e é separado do mensal; outros planos seguem o plano', async () => {
  const banco = [emTeste({ testeRespostas: 249 })];
  const { tg } = servico(banco);
  let t = await tg.tetoSecretariaTeste(7, 'barbearia_ia');
  assert.deepEqual(t, { teto: 250, respostas: 249, atingido: false });
  await tg.contarRespostaTeste(7);
  t = await tg.tetoSecretariaTeste(7, 'barbearia_ia');
  assert.equal(t.atingido, true);
  assert.equal(await tg.tetoSecretariaTeste(7, 'barbearia'), null, 'Barbearia: vale o teto do plano (secretária desligada)');
  banco[0].situacaoCortavo = 'ativa';
  assert.equal(await tg.tetoSecretariaTeste(7, 'barbearia_ia'), null, 'depois do teste vale o mensal');
  await tg.contarRespostaTeste(7);
  assert.equal(banco[0].testeRespostas, 250, 'fora do teste não conta mais');
});

test('250 no teste: estadoTeto da secretária usa o contador do teste mesmo com o mensal zerado (virada de mês)', async () => {
  const banco = [emTeste({ testeRespostas: 250 })];
  const prisma = bancoFalso(banco);
  prisma.configuracao = { findUnique: async () => null };
  prisma.usoIA = { findUnique: async () => ({ respostas: 0, avisadoTeto: false }) };
  const at = carregar('src/services/atendimento.js', { prisma });
  const e = await at.estadoTeto(7);
  assert.equal(e.teto, 250);
  assert.equal(e.atingido, true, 'mensal em 0, mas o teste já usou as 250');
  assert.equal(e.teste, true);
});

// ---------- Tela do dono (2.7) ----------
test('2.7 faixa do dono aparece no layout do painel sem botão de pagar', async () => {
  const fs = require('node:fs');
  const layout = fs.readFileSync(path.join(VIEWS, 'layouts/painel.ejs'), 'utf8');
  assert.ok(layout.includes('faixaTeste.texto'));
  const det = fs.readFileSync(path.join(VIEWS, 'mestre/barbearia-detalhe.ejs'), 'utf8');
  assert.ok(det.includes('/teste/prorrogar') && det.includes('/teste/segurar') && det.includes('/fundador'));
  for (const v of ['layouts/painel.ejs', 'mestre/barbearia-detalhe.ejs', 'mestre/painel.ejs']) {
    const txt = fs.readFileSync(path.join(VIEWS, v), 'utf8');
    assert.doesNotMatch(txt.slice(txt.indexOf('teste') || 0), /#(0d6efd|1e90ff|007bff|2563eb|3b82f6)/i, 'sem azul');
  }
});
