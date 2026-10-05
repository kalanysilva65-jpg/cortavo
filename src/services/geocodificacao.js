// Geocodificação: endereço em texto -> { latitude, longitude }.
//
// Usa o Nominatim (OpenStreetMap): gratuito e sem chave de API. Em troca, a
// política de uso pede um User-Agent identificável e no máximo 1 requisição por
// segundo — o que é de sobra aqui, já que só geocodificamos quando o admin salva
// o endereço da barbearia (evento raro), nunca em massa nem a cada request.
//
// Se algo falhar (rede, endereço não encontrado, resposta inesperada), retorna
// null e o chamador segue sem coordenadas — a barbearia simplesmente não aparece
// na busca "perto de você" até o endereço ser corrigido. Nunca lança.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Identifica a aplicação para o Nominatim (exigido pela política de uso).
const USER_AGENT = 'Cortavo/1.0 (agendamento de barbearias; contato: cortavo.app@gmail.com)';

async function geocodificar(endereco) {
  const texto = (endereco || '').trim();
  if (!texto) return null;

  const url = `${NOMINATIM_URL}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(texto)}`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR' },
      // Sem timeout nativo no fetch: aborta em 8s para não travar o "salvar".
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;

    const dados = await resp.json();
    if (!Array.isArray(dados) || dados.length === 0) return null;

    const lat = parseFloat(dados[0].lat);
    const lon = parseFloat(dados[0].lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return null;

    return { latitude: lat, longitude: lon };
  } catch {
    // Rede fora, timeout, JSON inválido: trata como "não geocodificou".
    return null;
  }
}

module.exports = { geocodificar };
