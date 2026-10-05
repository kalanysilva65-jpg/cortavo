// Barbearias de DEMONSTRAÇÃO (spec 03): marca FIXA no código, não uma
// configuração que alguém possa religar pelo painel. Nelas:
//  - nenhum lembrete sai (lembretes.js), mesmo com `lembretes_ativos = 1`;
//  - a secretária não responde (atendimento.js) — a mensagem fica salva;
//  - o agendamento público não manda push para a equipe;
//  - a página pública mostra o aviso de demonstração.
// `demo`   = barbearia do link público e da conta do revisor (Apple/Meta).
// `vitrine` = barbearia só para marketing (deploy/vitrine-marketing.js).
const prisma = require('../config/db');

const SLUGS_DEMO = Object.freeze(['demo', 'vitrine']);

const AVISO = 'Barbearia de demonstração: pode marcar à vontade, ninguém vai aparecer.';

function ehSlugDemo(slug) {
  return SLUGS_DEMO.includes(String(slug || '').toLowerCase());
}

async function ehDemo(barbeariaId) {
  if (!barbeariaId) return false;
  const b = await prisma.barbearia.findUnique({ where: { id: barbeariaId }, select: { slug: true } });
  return !!b && ehSlugDemo(b.slug);
}

// Ids das barbearias de demonstração (para rotinas que olham todas de uma vez).
async function idsDemo() {
  const lista = await prisma.barbearia.findMany({ where: { slug: { in: [...SLUGS_DEMO] } }, select: { id: true } });
  return new Set(lista.map((b) => b.id));
}

module.exports = { SLUGS_DEMO, AVISO, ehSlugDemo, ehDemo, idsDemo };
