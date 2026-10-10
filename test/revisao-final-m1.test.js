// Sergio M1: sem `clientes_contato`, o telefone do cliente sai mascarado nas
// Conversas (lista, cabeçalho, nome que é número) e no Assistente.
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregar, prismaFalso, reqFalso, resFalso } = require('./helpers/ambiente');

const CONVERSAS = [
  { id: 1, clienteNome: null, clienteTelefone: '5551999998888', ultimaPrevia: 'oi', ultimaMensagemEm: new Date(), naoLidas: 1, iaAtiva: true },
  { id: 2, clienteNome: '51 98888-7777', clienteTelefone: '5551988887777', ultimaPrevia: '', ultimaMensagemEm: new Date(), naoLidas: 0, iaAtiva: true },
  { id: 3, clienteNome: 'Carlos', clienteTelefone: '5551977776666', ultimaPrevia: '', ultimaMensagemEm: new Date(), naoLidas: 0, iaAtiva: false },
];
function ctrl() {
  return carregar('src/controllers/conversasController.js', {
    stubs: {
      'src/services/atendimento.js': {
        listarConversas: async () => CONVERSAS,
        estadoTeto: async () => ({ atingido: false }),
        abrirConversa: async (_b, id) => ({ conversa: { ...CONVERSAS.find((c) => c.id === Number(id)), ultimaMsgClienteEm: null }, mensagens: [] }),
      },
      'src/services/secretaria.js': { habilitada: () => true },
    },
  });
}
const perm = (liberado) => ({ pode: (k) => (k === 'clientes_contato' ? liberado : true) });

test('M1 Conversas: sem clientes_contato, lista e cabeçalho mostram só o final do número', async () => {
  const c = ctrl();
  const res = resFalso();
  await c.ver(reqFalso({ barbeariaId: 7, permissoes: perm(false), query: { id: '1' } }), res);
  const d = res.renderizou.dados;
  const tudo = JSON.stringify(d);
  for (const n of ['99999-8888', '999998888', '98888-7777', '977776666']) assert.ok(!tudo.includes(n), n);
  assert.equal(d.conversas[0].nome, '•••• 8888');
  assert.equal(d.conversas[1].nome, '•••• 7777', 'nome que é número também');
  assert.equal(d.conversas[2].nome, 'Carlos');
  assert.equal(d.aberta.conversa.telefone, '•••• 8888');
  assert.equal(d.aberta.conversa.nome, '•••• 8888');
});

test('M1 Conversas: com clientes_contato, o número completo continua aparecendo', async () => {
  const res = resFalso();
  await ctrl().ver(reqFalso({ barbeariaId: 7, permissoes: perm(true), query: { id: '1' } }), res);
  assert.match(res.renderizou.dados.aberta.conversa.telefone.replace(/\D/g, ''), /999998888/);
});

test('M1 Conversas: o fragmento da lista (auto-atualização) também mascara', async () => {
  const res = resFalso();
  await ctrl().fragmento(reqFalso({ barbeariaId: 7, permissoes: perm(false) }), res);
  assert.ok(!JSON.stringify(res.renderizou.dados).includes('8888-'));
  assert.equal(res.renderizou.dados.conversas[0].nome, '•••• 8888');
});

test('M1 Assistente: nome de cliente que é número sai mascarado sem clientes_contato', async () => {
  const prisma = prismaFalso({
    agendamento: { findMany: async () => [{ id: 5, data: new Date(2026, 9, 14), horaInicio: '10:00', clienteNome: '51 99999-8888', status: 'agendado', valorTotal: 0, usuario: { nome: 'Beto' } }] },
  });
  const ia = carregar('src/services/ia.js', { prisma });
  const sem = await ia.execFerramenta('resumo_agenda', { data: '2026-10-14' }, { barbeariaId: 7, usuarioId: 2, veContato: false });
  assert.equal(sem.agendamentos[0].cliente, '•••• 8888');
  const busca = await ia.execFerramenta('buscar_agendamentos', {}, { barbeariaId: 7, usuarioId: 2, veContato: false });
  assert.ok(!JSON.stringify(busca).includes('99999'));
  const com = await ia.execFerramenta('resumo_agenda', { data: '2026-10-14' }, { barbeariaId: 7, usuarioId: 2, veContato: true });
  assert.equal(com.agendamentos[0].cliente, '51');
});
