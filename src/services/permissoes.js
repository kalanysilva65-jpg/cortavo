// Permissões por barbeiro contratado (pedido do dono, 2026-09-30): o admin
// escolhe, na Equipe, quais telas cada funcionário acessa. Guardado em
// Usuario.acessosBloqueados (JSON com as CHAVES bloqueadas) — nulo = tudo
// liberado, que é o comportamento de antes. Só restringe telas que o
// funcionário já podia ver; áreas de admin (caixa, equipe...) continuam só admin.
const MODULOS = [
  { chave: 'clientes', rotulo: 'Clientes', prefixos: ['/clientes'] },
  { chave: 'servicos', rotulo: 'Serviços', prefixos: ['/servicos'] },
  { chave: 'produtos', rotulo: 'Produtos', prefixos: ['/produtos'] },
  { chave: 'estoque', rotulo: 'Estoque', prefixos: ['/estoque'] },
  { chave: 'planos', rotulo: 'Planos', prefixos: ['/planos'] },
  { chave: 'comissoes', rotulo: 'Comissões (a dele)', prefixos: ['/comissoes'] },
  { chave: 'horarios', rotulo: 'Horários e bloqueios', prefixos: ['/horarios'] },
  { chave: 'conversas', rotulo: 'Conversas do WhatsApp', prefixos: ['/conversas'] },
  { chave: 'ia', rotulo: 'Assistente de IA', prefixos: ['/ia'] },
];
const CHAVES = new Set(MODULOS.map((m) => m.chave));

function bloqueadosDe(usuario) {
  try {
    const lista = JSON.parse((usuario && usuario.acessosBloqueados) || '[]');
    return new Set(Array.isArray(lista) ? lista.filter((c) => CHAVES.has(c)) : []);
  } catch (_) {
    return new Set();
  }
}

// Qual módulo cobre um caminho relativo ao /painel (ex.: "/clientes/3").
// Sem diferenciar maiúsculas (o Express casa /CLIENTES com /clientes).
function moduloDoCaminho(caminho) {
  const c = String(caminho || '').toLowerCase();
  return MODULOS.find((m) => m.prefixos.some((p) => c === p || c.startsWith(p + '/')));
}

// Do formulário: checkboxes `acesso_<chave>` marcados = liberado.
function bloqueadosDoForm(body) {
  const bloq = MODULOS.filter((m) => !body['acesso_' + m.chave]).map((m) => m.chave);
  return bloq.length ? JSON.stringify(bloq) : null;
}

module.exports = { MODULOS, bloqueadosDe, moduloDoCaminho, bloqueadosDoForm };
