// Painel-mestre › Visão geral (redesign v3, F10): ativas, receita estimada,
// custo de IA/WhatsApp por barbearia, margem e "Precisa de atenção".
// Barbearias e números fictícios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { criarBanco } = require('./helpers/bancoMemoria');

function banco() {
  const agora = new Date();
  const dias = (n) => new Date(agora.getTime() + n * 86400000);
  const comp = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
  return criarBanco({
    barbearia: [
      { id: 1, nome: 'Alfa', slug: 'alfa', ativo: true, planoCortavo: 'barbearia', situacaoCortavo: 'ativa', fundador: 'confirmada', fundadorEm: dias(-30) },
      { id: 2, nome: 'Beta', slug: 'beta', ativo: true, planoCortavo: 'barbearia_ia', situacaoCortavo: 'ativa', fundador: null },
      { id: 3, nome: 'Gama', slug: 'gama', ativo: true, planoCortavo: 'barbearia_ia', situacaoCortavo: 'teste', testeFim: dias(1) },
      { id: 4, nome: 'Delta', slug: 'delta', ativo: true, planoCortavo: 'essencial', situacaoCortavo: 'pausada_atraso' },
      { id: 5, nome: 'Épsilon', slug: 'eps', ativo: true, planoCortavo: 'personalizado', situacaoCortavo: 'ativa' },
      { id: 6, nome: 'Zeta', slug: 'zeta', ativo: false, planoCortavo: 'essencial', situacaoCortavo: 'ativa' },
      { id: 7, nome: 'Eta', slug: 'eta', ativo: true, planoCortavo: 'barbearia', situacaoCortavo: 'ativa', fundador: 'confirmada', fundadorEm: dias(-200) },
    ],
    usoIA: [{ id: 1, barbeariaId: 2, competencia: comp, respostas: 700, copilotoConsultas: 45 }],
    usoIAModelo: [{ id: 1, barbeariaId: 2, competencia: comp, canal: 'whatsapp', modelo: 'claude-haiku-4-5', tokensEntrada: 50000000, tokensSaida: 0, chamadas: 700 }],
    conversa: [],
    mensagem: [],
    lembreteLog: [],
    agendamento: [1, 2, 7].map((b, i) => ({ id: i + 1, barbeariaId: b, criadoEm: dias(-1), status: 'agendado' })),
    usuario: [],
  });
}

function carregarServico(b) {
  return carregar('src/services/visaoGeralMestre.js', { prisma: b });
}

test('Visão geral: contagem por situação, receita com desconto de fundador e "sem preço" do Personalizado', async () => {
  const s = carregarServico(banco());
  const v = await s.visaoGeral({ backup: { situacao: 'ok' } });
  assert.deepEqual([v.numeros.ativas, v.numeros.emTeste, v.numeros.pausadas, v.numeros.inativas], [4, 1, 1, 1]);
  // Alfa: 12900 com 30% (fundador há 1 mês) = 9030; Beta 24900; Eta: fundador há 200 dias, sem desconto = 12900.
  assert.equal(v.numeros.receitaEstimada, 9030 + 24900 + 12900);
  assert.equal(v.numeros.semPrecoDefinido, 1);
  const alfa = v.porBarbearia.find((x) => x.barbeariaId === 1);
  assert.equal(alfa.receitaEstimada, 9030);
});

test('Visão geral: custo de IA por barbearia (pelo modelo) e margem', async () => {
  const s = carregarServico(banco());
  const v = await s.visaoGeral({});
  const beta = v.porBarbearia.find((x) => x.barbeariaId === 2);
  // 50 milhões de tokens de entrada no Haiku (US$ 1/M) = US$ 50 x 5,5 = R$ 275,00.
  assert.equal(beta.custoIA, 27500);
  assert.equal(beta.custoTotal, 27500);
  assert.equal(beta.margem, 24900 - 27500);
  assert.equal(v.numeros.custoTotal, 27500);
  assert.equal(v.numeros.margem, v.numeros.receitaEstimada - 27500);
  assert.equal(v.porBarbearia[0].barbeariaId, 2, 'ordenado pelo maior custo');
});

test('Precisa de atenção: pausa, teste acabando, margem negativa, teto perto, sem movimento e backup', async () => {
  const s = carregarServico(banco());
  const v = await s.visaoGeral({ backup: { situacao: 'atrasado' } });
  const t = (tipo, id) => v.precisaDeAtencao.find((a) => a.tipo === tipo && (id === undefined || a.barbeariaId === id));
  assert.ok(t('pausada_atraso', 4));
  assert.ok(t('teste_terminando', 3));
  assert.equal(t('teste_terminando', 3).diasRestantes, 1);
  assert.ok(t('margem_negativa', 2));
  assert.ok(t('secretaria_perto_do_teto', 2), '700 de 800 respostas');
  assert.ok(t('assistente_perto_do_teto', 2), '45 de 50 consultas');
  assert.ok(t('sem_movimento', 5));
  assert.ok(!t('sem_movimento', 1));
  assert.ok(!v.precisaDeAtencao.some((a) => a.barbeariaId === 6), 'inativa não gera alerta');
  assert.ok(t('backup'));
  const grav = v.precisaDeAtencao.map((a) => a.gravidade);
  assert.deepEqual(grav, grav.slice().sort((a, b) => ({ alta: 0, media: 1, baixa: 2 }[a] - { alta: 0, media: 1, baixa: 2 }[b])), 'mais grave primeiro');
});

test('Rota /mestre/visao-geral.json fica atrás do exigeDono', async () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src/routes/mestre.js'), 'utf8');
  assert.ok(src.indexOf('router.use(exigeDono)') < src.indexOf("router.get('/visao-geral.json'"));
  const ctrl = carregar('src/controllers/mestreController.js', { prisma: banco() });
  const res = resFalso();
  res.set = () => res;
  await ctrl.visaoGeralJson(reqFalso(), res);
  assert.ok(res.enviado.numeros && Array.isArray(res.enviado.precisaDeAtencao));
});
