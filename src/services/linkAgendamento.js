// Endereço do link de agendamento de uma barbearia: SUBDOMÍNIO (decisão da
// Kalany, 2026-10-09, como andrade.cortavo.com.br). É o que o tenant.js já
// resolve. Função única para a tela do link, o QR, o cartaz, o texto do
// WhatsApp, o atalho da Início e a Secretária.
const DOMINIO_PADRAO = 'cortavo.com.br';

function dominio() {
  return (process.env.APP_DOMAIN || DOMINIO_PADRAO).toLowerCase().replace(/^www\./, '');
}

// { url: 'https://vilarosa.cortavo.com.br', curto: 'vilarosa.cortavo.com.br', slug, dominio }
function linkAgendamento(barbearia) {
  if (!barbearia || !barbearia.slug) return null;
  const slug = String(barbearia.slug).toLowerCase();
  const d = dominio();
  return { url: `https://${slug}.${d}`, curto: `${slug}.${d}`, slug, dominio: d };
}

function textoPadrao(barbearia) {
  const l = linkAgendamento(barbearia);
  if (!l) return '';
  return `Oi! Agora você marca seu horário na ${barbearia.nome} pelo celular, a qualquer hora. É só escolher o serviço, o barbeiro e o horário:\n${l.url}`;
}

module.exports = { linkAgendamento, textoPadrao, dominio };
