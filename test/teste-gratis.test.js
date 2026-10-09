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
function bancoFalso(barbearias, { donos = [{ id: 1 }], logs = [], auditoriaFalha = false } = {}) {
  const casa = (b, where = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(b[k]);
    if (v === null) return b[k] == null;
    if (v && typeof v === 'object' && 'not' in v) return v.not === null ? b[k] != null : b[k] !== v.not;
    if (v && typeof v === 'object' && 'lt' in v) return b[k] != null && new Date(b[k]).getTime() < new Date(v.lt).getTime();
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
    logAuditoria: { create: async ({ data }) => { if (auditoriaFalha) throw new Error('banco travado'); logs.push(data); return data; } },
  });
  prisma.$transaction = async (fn) => fn(prisma);
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
  assert.equal(await tg.reservarFundador(99), false);
});

test('C5 com vaga livre, o teste começa com a vaga reservada; sem "Em teste" nada de teste', async () => {
  const banco = [];
  const criadas = [];
  const prisma = bancoFalso(banco);
  prisma.barbearia.create = async ({ data }) => { const b = { id: banco.length + 1, fundador: null, ...data }; banco.push(b); criadas.push(b); return b; };
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
  // Redesign v3 (F3): a faixa saiu do layout e mora no topo da Início.
  const faixa = fs.readFileSync(path.join(VIEWS, 'partials/faixa-teste.ejs'), 'utf8');
  assert.ok(faixa.includes('faixaTeste.texto'));
  assert.doesNotMatch(faixa.replace(/<%\/\*[\s\S]*?\*\/%>/g, ''), /pagar|assinar|comprar|checkout/i, 'sem botão de pagar');
  const home = fs.readFileSync(path.join(VIEWS, 'painel/dashboard.ejs'), 'utf8');
  assert.ok(home.includes("include('../partials/faixa-teste')"));
  const det = fs.readFileSync(path.join(VIEWS, 'mestre/barbearia-detalhe.ejs'), 'utf8');
  assert.ok(det.includes('/teste/prorrogar') && det.includes('/teste/segurar') && det.includes('/fundador'));
  for (const v of ['partials/faixa-teste.ejs', 'layouts/painel.ejs', 'mestre/barbearia-detalhe.ejs', 'mestre/painel.ejs']) {
    const txt = fs.readFileSync(path.join(VIEWS, v), 'utf8');
    assert.doesNotMatch(txt.slice(txt.indexOf('teste') || 0), /#(0d6efd|1e90ff|007bff|2563eb|3b82f6)/i, 'sem azul');
  }
});


// ---------- Correções do Sergio (fase2-teste-gratis-seguranca.md) ----------
test('Sergio 1: reservas simultâneas nunca passam de 5 (conta e grava na mesma transação)', async () => {
  const banco = [1, 2, 3, 4].map((id) => ({ id, fundador: 'reservada' })).concat([{ id: 5, fundador: null }, { id: 6, fundador: null }]);
  const prisma = bancoFalso(banco);
  // Transação serializada como no SQLite: uma de cada vez.
  let fila = Promise.resolve();
  prisma.$transaction = (fn) => { const p = fila.then(() => fn(prisma)); fila = p.catch(() => {}); return p; };
  const tg = carregar('src/services/testeGratis.js', { prisma, stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  const [a, b] = await Promise.all([tg.reservarFundador(5), tg.reservarFundador(6)]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(banco.filter((x) => x.fundador).length, 5);
});

test('Sergio 2: no teste do + IA, secretária desligada (teto 0) continua desligada; teto menor vale', async () => {
  const banco = [emTeste({ testeRespostas: 10 })];
  const prisma = bancoFalso(banco);
  prisma.configuracao = { findUnique: async () => null };
  prisma.usoIA = { findUnique: async () => null };
  const stubPlano = (teto) => ({ ...carregar('src/services/planoCortavo.js'), planoDaBarbearia: async () => ({ chave: 'barbearia_ia', tetos: { secretaria: teto } }), resolverTeto: () => teto });
  let at = carregar('src/services/atendimento.js', { prisma, stubs: { 'src/services/planoCortavo.js': stubPlano(0) } });
  let e = await at.estadoTeto(7);
  assert.equal(e.desligado, true);
  assert.equal(e.teto, 0);
  at = carregar('src/services/atendimento.js', { prisma, stubs: { 'src/services/planoCortavo.js': stubPlano(100) } });
  e = await at.estadoTeto(7);
  assert.equal(e.teto, 100);
  assert.equal(e.desligado, false);
  at = carregar('src/services/atendimento.js', { prisma, stubs: { 'src/services/planoCortavo.js': stubPlano(800) } });
  e = await at.estadoTeto(7);
  assert.equal(e.teto, 250);
});

test('Sergio 3: erro numa barbearia não interrompe a rotina das outras', async () => {
  const banco = [emTeste({ id: 1, nome: 'Quebra' }), emTeste({ id: 2, nome: 'Boa' })];
  const prisma = bancoFalso(banco);
  const original = prisma.barbearia.updateMany;
  prisma.barbearia.updateMany = async (a) => { if (a.where.id === 1) throw new Error('banco travado'); return original(a); };
  const tg = carregar('src/services/testeGratis.js', { prisma, stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  const r = await tg.rodarRotina({ agora: noDia(12), notificar: async () => 1 });
  assert.equal(r.erros, 1);
  assert.equal(r.avisosFim, 1);
  assert.ok(banco[1].testeAvisoFimEm);
});

test('Sergio 4: aviso que não chegou nem ficou registrado desfaz a marca e a pausa não acontece', async () => {
  const banco = [emTeste()];
  const opts = { auditoriaFalha: true };
  const tg = carregar('src/services/testeGratis.js', { prisma: bancoFalso(banco, opts), stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  const semPush = async () => { throw new Error('push fora'); };
  await tg.rodarRotina({ agora: noDia(15), notificar: semPush });
  assert.equal(banco[0].testeAvisoVencidoEm, null, 'marca desfeita');
  await tg.rodarRotina({ agora: noDia(16), notificar: semPush });
  assert.equal(banco[0].ativo, true, 'sem aviso registrado, sem pausa');
});

test('Sergio 4: push falhou mas o aviso ficou na auditoria do painel: segue o fluxo', async () => {
  const banco = [emTeste()];
  const logs = [];
  const tg = carregar('src/services/testeGratis.js', { prisma: bancoFalso(banco, { logs }), stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  await tg.rodarRotina({ agora: noDia(15), notificar: async () => 0 });
  assert.ok(banco[0].testeAvisoVencidoEm);
  assert.ok(logs.some((l) => l.acao === 'teste.aviso' && /acabou sem pagamento/.test(l.detalhe)));
});

test('Sergio 5: prorrogado entre a leitura e a pausa, a condição do UPDATE impede a pausa', async () => {
  const banco = [emTeste({ testeAvisoVencidoEm: noDia(15) })];
  const prisma = bancoFalso(banco);
  const findMany = prisma.barbearia.findMany;
  prisma.barbearia.findMany = async (a) => {
    const lidos = await findMany(a);
    // A Kalany prorroga logo depois da leitura da rotina.
    banco[0].testeFim = new Date(banco[0].testeFim.getTime() + 7 * DIA);
    banco[0].testeAvisoVencidoEm = null;
    return lidos;
  };
  const tg = carregar('src/services/testeGratis.js', { prisma, stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  const r = await tg.rodarRotina({ agora: noDia(16), notificar: async () => 1 });
  assert.equal(r.pausadas, 0);
  assert.equal(banco[0].ativo, true);
});

test('Sergio 7: faixa do teste só para dono/admin, não para funcionário', () => {
  const fs = require('node:fs');
  const txt = fs.readFileSync(path.join(RAIZ, 'src/routes/painel.js'), 'utf8');
  assert.match(txt, /res\.locals\.faixaTeste = req\.ehAdmin \? testeGratis\.faixaDono\(barbearia\) : null/);
});

test('Sergio obs.: soltar "Segurar pausa" depois do prazo limpa o aviso (avisa de novo e só pausa no dia seguinte)', async () => {
  const banco = [emTeste({ testeFim: new Date(Date.now() - 3 * DIA), testeSegurarPausa: true, testeAvisoVencidoEm: new Date(Date.now() - 2 * DIA) })];
  const m = carregar('src/controllers/mestreController.js', { prisma: bancoFalso(banco), stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  const req = reqFalso({ params: { id: '7' }, body: { segurar: 'false' } });
  await m.segurarPausaTeste(req, resFalso());
  assert.equal(banco[0].testeSegurarPausa, false);
  assert.equal(banco[0].testeAvisoVencidoEm, null);
  assert.match(req.session.flash.texto, /novo aviso/);
});

test('Sergio obs.: liberar vaga CONFIRMADA pede confirmação na tela', () => {
  const fs = require('node:fs');
  const det = fs.readFileSync(path.join(VIEWS, 'mestre/barbearia-detalhe.ejs'), 'utf8');
  assert.match(det, /fundador === 'confirmada'[\s\S]{0,40}onsubmit="return confirm/);
});


// ---------- Ajustes da Vera ----------
test('Vera T1: faixa do teste usa classe própria e estática (sem `alerta`, que vira aviso flutuante na Home)', async () => {
  // Redesign v3 (F3): a faixa virou o componente estático cv-faixa, no topo da
  // Início (partials/faixa-teste.ejs), e continua sem a classe `alerta`.
  const fs = require('node:fs');
  const txt = fs.readFileSync(path.join(VIEWS, 'partials/faixa-teste.ejs'), 'utf8');
  const linha = txt.split('\n').find((l) => l.includes('class="cv-faixa'));
  assert.match(linha, /class="cv-faixa faixa-teste/);
  assert.doesNotMatch(txt.replace(/<%\/\*[\s\S]*?\*\/%>/g, ''), /alerta/);
  const html = await render('partials/faixa-teste.ejs', { faixaTeste: { dias: 3, aviso: true, texto: 'Seu teste termina em 3 dias. A Cortavo vai falar com você para continuar.' } });
  assert.match(html, /<b>3<\/b><small>dias<\/small>/);
  assert.match(html, /href="\/painel\/meu-plano"/);
  assert.match(html, /role="status"/);
});

test('Vera: mestre mostra "Pausa amanhã" para teste já vencido', async () => {
  const html = await render('mestre/painel.ejs', {
    backup: { situacao: 'nunca' }, filtros: { q: '', status: 'todas' }, total: 0, barbearias: [],
    paginacao: { pagina: 1, totalPaginas: 1 }, planoDe: () => ({ nome: 'Barbearia' }), avisoBarbeiros: () => null,
    testesAtivos: [{ id: 3, nome: 'Vencida', planoCortavo: 'barbearia', diasRestantes: -1, fundador: null }],
    vagasFundador: { usadas: 0, total: 5, livres: 5 },
  });
  assert.match(html, /Pausa amanhã/);
  assert.doesNotMatch(html, /avisar o dono/);
});

test('Vera: assistente no teste tem 50 consultas no período (contador próprio, atravessa a virada do mês)', async () => {
  const banco = [emTeste({ testeConsultas: 50 })];
  const prisma = bancoFalso(banco);
  prisma.configuracao = { findUnique: async () => null };
  prisma.usoIA = { findUnique: async () => ({ copilotoConsultas: 0 }) }; // mês novo zerado
  const at = carregar('src/services/atendimento.js', { prisma });
  const e = await at.estadoTetoCopiloto(7);
  assert.equal(e.teto, 50);
  assert.equal(e.atingido, true);
  const { tg } = servico(banco);
  banco[0].testeConsultas = 3;
  await tg.contarConsultaTeste(7);
  assert.equal(banco[0].testeConsultas, 4);
  banco[0].situacaoCortavo = 'ativa';
  assert.equal(await tg.tetoAssistenteTeste(7), null, 'depois do teste vale o mensal');
});


test('Vera R1: reserva de vaga rejeitada pelo banco (SQLITE_BUSY) não dá 500: cria sem vaga e avisa', async () => {
  const banco = [];
  const criadas = [];
  const prisma = bancoFalso(banco);
  prisma.$transaction = async () => { const e = new Error('SQLITE_BUSY: database is locked'); e.code = 'P2034'; throw e; };
  prisma.barbearia.create = async ({ data }) => { const b = { id: 1, fundador: null, ...data }; banco.push(b); criadas.push(b); return b; };
  prisma.barbearia.findUnique = async () => null;
  prisma.usuario.create = async () => ({});
  prisma.configuracao = { upsert: async () => ({}) };
  const m = carregar('src/controllers/mestreController.js', { prisma, stubs: { 'src/services/auditoria.js': { registrar: async () => {} } } });
  const req = reqFalso({ body: { nome: 'Corrida', slug: 'corrida', adminNome: 'A', adminEmail: 'a@exemplo.test', adminSenha: 'x'.repeat(8), plano: 'barbearia', emTeste: '1' } });
  const res = resFalso();
  await m.criarBarbearia(req, res);
  assert.equal(res.redirecionou, '/mestre/barbearias/1');
  assert.equal(criadas[0].situacaoCortavo, 'teste');
  assert.equal(banco[0].fundador, null);
  assert.equal(req.session.flash.tipo, 'aviso');
  assert.match(req.session.flash.texto, /vagas de fundador/);
});
