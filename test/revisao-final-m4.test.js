// Sergio M4: o Assistente respeita a chave `meus_numeros`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, prismaFalso } = require('./helpers/ambiente');

function ia() {
  const prisma = prismaFalso({
    agendamento: { findMany: async () => [{ valorTotal: 5000, horaInicio: '10:00', clienteNome: 'Ana', clienteTelefone: '1' }] },
    cliente: { count: async () => 0 },
  });
  return carregar('src/services/ia.js', { prisma });
}

test('M4 barbeiro sem meus_numeros: ferramentas de números recusam, sem valor', async () => {
  const s = ia();
  const ctx = { barbeariaId: 7, usuarioId: 2, pode: (k) => k !== 'meus_numeros' };
  for (const [nome, args] of [['resumo_mes', {}], ['faturamento_periodo', { inicio: '2026-10-01', fim: '2026-10-31' }], ['top_clientes', {}], ['horarios_movimento', {}]]) {
    const r = await s.execFerramenta(nome, args, ctx);
    assert.match(r.erro, /Sem acesso aos números/, nome);
    assert.ok(!JSON.stringify(r).includes('R$'), nome);
  }
});

test('M4 com meus_numeros (ou admin), os números continuam saindo', async () => {
  const s = ia();
  const r = await s.execFerramenta('resumo_mes', {}, { barbeariaId: 7, usuarioId: 2, pode: () => true });
  assert.match(r.faturamento, /50/);
  const adm = await s.execFerramenta('resumo_mes', {}, { barbeariaId: 7, usuarioId: null, pode: () => false });
  assert.match(adm.faturamento, /50/, 'admin (escopo da barbearia) não é travado pela chave do barbeiro');
});
