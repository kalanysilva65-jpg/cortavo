// Plano da Cortavo por barbearia (fase 2, spec 04). LUGAR ÚNICO do que cada
// plano libera e dos tetos. Mudar o pacote depois do piloto = mudar só aqui.
//
// Não confundir com src/services/plano.js (pacotes que a barbearia vende aos
// clientes dela). Aqui é a assinatura da barbearia com a Cortavo.
//
// Números aprovados pela Kalany em 2026-10-05
// (squads/site-cortavo/output/preco-escolhido.md):
//   Essencial R$ 69 · Barbearia R$ 129 · Barbearia + IA R$ 249
//   secretária 0 / 0 / 800 respostas · assistente 0 / 50 / 50 consultas
//   lembretes 100 / 200 / 300 (referência, nunca corta) · barbeiros 2 / 5 / 5 (referência)
//   teste do + IA: secretária 250 respostas no total do teste (spec 05/07, fatia 2.10).
//
// Teto: número = limite do mês; 0 = DESLIGADO; null = "usar a configuração da
// barbearia" (só no Personalizado, que é como tudo funcionava antes da fase 2).
const prisma = require('../config/db');

// Funções que o plano pode desligar. `prefixos` = caminhos relativos a /painel.
const FUNCOES = [
  { chave: 'comissoes', rotulo: 'Comissões', prefixos: ['/comissoes'] },
  { chave: 'relatorios', rotulo: 'Relatórios', prefixos: ['/relatorios'] },
  { chave: 'estoque', rotulo: 'Estoque', prefixos: ['/estoque'] },
  { chave: 'fidelidade', rotulo: 'Fidelidade', prefixos: ['/fidelidade'] },
  { chave: 'metas', rotulo: 'Metas', prefixos: ['/metas'] },
];
const TODAS = FUNCOES.map((f) => f.chave);

const PLANOS = {
  essencial: {
    chave: 'essencial', nome: 'Essencial', precoCentavos: 6900, ordem: 1,
    funcoes: [],
    tetos: { secretaria: 0, assistente: 0, lembretesRef: 100, barbeirosRef: 2 },
  },
  barbearia: {
    chave: 'barbearia', nome: 'Barbearia', precoCentavos: 12900, ordem: 2,
    funcoes: TODAS,
    tetos: { secretaria: 0, assistente: 50, lembretesRef: 200, barbeirosRef: 5 },
  },
  barbearia_ia: {
    chave: 'barbearia_ia', nome: 'Barbearia + IA', precoCentavos: 24900, ordem: 3,
    funcoes: TODAS,
    tetos: { secretaria: 800, assistente: 50, lembretesRef: 300, barbeirosRef: 5 },
  },
  // Barbearias que já existiam antes da fase 2: nada muda para elas.
  personalizado: {
    chave: 'personalizado', nome: 'Personalizado', precoCentavos: null, ordem: 0,
    funcoes: TODAS,
    tetos: { secretaria: null, assistente: null, lembretesRef: null, barbeirosRef: null },
  },
};
const CHAVE_PADRAO = 'personalizado';

function chaveValida(chave) {
  return Object.prototype.hasOwnProperty.call(PLANOS, chave);
}

// Plano a partir do valor gravado. Valor desconhecido/vazio = Personalizado
// (nunca bloqueia por engano uma barbearia que já usa o app).
function planoDe(chave) {
  return PLANOS[chaveValida(chave) ? chave : CHAVE_PADRAO];
}

async function planoDaBarbearia(barbeariaId) {
  let b = null;
  try {
    b = await prisma.barbearia.findUnique({ where: { id: barbeariaId }, select: { planoCortavo: true } });
  } catch (e) {
    console.error('[plano-cortavo] leitura falhou:', e.message);
  }
  return planoDe(b && b.planoCortavo);
}

function libera(plano, funcao) {
  return plano.funcoes.includes(funcao);
}

// Qual função do plano cobre um caminho relativo a /painel (ex.: "/estoque/3").
function funcaoDoCaminho(caminho) {
  return FUNCOES.find((f) => f.prefixos.some((p) => caminho === p || caminho.startsWith(p + '/'))) || null;
}

// Plano mais barato que libera a função (para o texto do cadeado).
function menorPlanoCom(funcao) {
  return Object.values(PLANOS)
    .filter((p) => p.ordem > 0 && p.funcoes.includes(funcao))
    .sort((a, b) => a.ordem - b.ordem)[0] || null;
}

function textoForaDoPlano(funcao) {
  const p = menorPlanoCom(funcao);
  return `Disponível no plano ${p ? p.nome : 'Barbearia'}. Fale com a Cortavo.`;
}

// Teto efetivo de 'secretaria' ou 'assistente'.
//  - Plano com número: vale o número do plano (0 = desligado).
//  - Personalizado: vale a configuração da barbearia; vazio = padrão do código;
//    "0" = desligado (antes da fase 2, 0 virava o padrão).
function resolverTeto(plano, recurso, valorConfig, padrao) {
  const doPlano = plano.tetos[recurso];
  if (typeof doPlano === 'number') return doPlano;
  const txt = String(valorConfig == null ? '' : valorConfig).trim();
  if (txt === '') return padrao;
  const n = parseInt(txt, 10);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

// A secretária pode existir neste plano? (teto do plano diferente de 0)
function temSecretaria(plano) {
  return plano.tetos.secretaria !== 0;
}
function temAssistente(plano) {
  return plano.tetos.assistente !== 0;
}

module.exports = {
  FUNCOES, PLANOS, CHAVE_PADRAO,
  chaveValida, planoDe, planoDaBarbearia, libera, funcaoDoCaminho,
  menorPlanoCom, textoForaDoPlano, resolverTeto, temSecretaria, temAssistente,
};
