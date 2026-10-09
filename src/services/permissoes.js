// Permissões por barbeiro contratado.
//
// Fase 1 (pedido do dono, 2026-09-30): o admin escolhe, na Equipe, quais TELAS
// cada funcionário acessa (9 módulos com prefixo de rota).
// Spec 12, fatia B1 (aprovada pela Kalany em 2026-10-05): além das telas,
// chaves de DADOS (números dele, números da barbearia, ranking, caixa, contato
// do cliente), organizadas em grupos, com padrão próprio para barbeiro novo.
//
// Onde fica gravado: Usuario.acessosBloqueados (texto JSON). Três formatos:
//   null                      -> "legado": as 9 telas liberadas (como sempre foi)
//                                e as chaves de dados no padrão LEGADO (abaixo);
//   ["estoque", ...]          -> "legado" com algumas telas bloqueadas (formato
//                                que a tela antiga gravava). Chaves novas: padrão legado;
//   {"v":2,"bloqueados":[...],"liberados":[...]}
//                             -> formato novo: cada chave decidida explicitamente;
//                                chave que não aparece em nenhuma lista usa o
//                                padrão de barbeiro NOVO (chaves que surgirem depois).
//
// Por que o padrão "legado" existe (critério 7 da spec 12): quem já trabalha com
// `null` não pode passar a ver MAIS nem MENOS do que via antes do deploy. Antes,
// caixa e relatórios eram só do admin -> as chaves que abrem dados da barbearia
// nascem BLOQUEADAS para o legado; o que ele já via (as 9 telas, os próprios
// números, o telefone do cliente) continua liberado.
//
// Regras (spec 12):
//  R1 plano antes de permissão: o que o plano desliga some para o barbeiro e
//     não aparece como opção (ver `chavesParaTela`).
//  R2 admin/dono nunca é restringido por permissão, só pelo plano.
//  R3 dado de barbeiro é filtrado no servidor por usuarioId (ver `escopo`).
const planoCortavo = require('./planoCortavo');

// Grupos na ordem da tela da Equipe (R5).
const GRUPOS = [
  { chave: 'agenda', rotulo: 'Agenda' },
  { chave: 'clientes', rotulo: 'Clientes' },
  { chave: 'catalogo', rotulo: 'Catálogo' },
  { chave: 'numeros', rotulo: 'Números' },
  { chave: 'caixa', rotulo: 'Caixa' },
  { chave: 'comunicacao', rotulo: 'Comunicação' },
];

// Todas as chaves. Campos:
//  prefixos     telas do /painel que a chave abre (vazio = chave só de dados)
//  padraoNovo   liberado para barbeiro criado depois da B1
//  padraoLegado liberado para quem tem acessosBloqueados nulo/no formato antigo
//  plano        função do plano da Cortavo que precisa estar liberada (R1)
//  fixa         sempre liberada, não aparece como opção
const CHAVES = [
  { chave: 'agenda_propria', grupo: 'agenda', rotulo: 'Agenda dele', descricao: 'A própria agenda. Sempre liberada.', prefixos: [], padraoNovo: true, padraoLegado: true, fixa: true },
  { chave: 'horarios', grupo: 'agenda', rotulo: 'Horários e bloqueios', descricao: 'Editar a própria jornada e bloquear horários.', prefixos: ['/horarios'], padraoNovo: true, padraoLegado: true },

  { chave: 'clientes', grupo: 'clientes', rotulo: 'Clientes', descricao: 'Lista de clientes e histórico.', prefixos: ['/clientes'], padraoNovo: true, padraoLegado: true },
  { chave: 'clientes_contato', grupo: 'clientes', rotulo: 'Telefone dos clientes', descricao: 'Ver o telefone completo. Bloqueado, aparece só o final.', prefixos: [], padraoNovo: true, padraoLegado: true },

  { chave: 'servicos', grupo: 'catalogo', rotulo: 'Serviços', descricao: 'Consultar serviços e preços.', prefixos: ['/servicos'], padraoNovo: true, padraoLegado: true },
  { chave: 'produtos', grupo: 'catalogo', rotulo: 'Produtos', descricao: 'Consultar produtos e preços.', prefixos: ['/produtos'], padraoNovo: true, padraoLegado: true },
  { chave: 'planos', grupo: 'catalogo', rotulo: 'Planos', descricao: 'Consultar os planos vendidos aos clientes.', prefixos: ['/planos'], padraoNovo: true, padraoLegado: true },
  { chave: 'estoque', grupo: 'catalogo', rotulo: 'Estoque', descricao: 'Consultar o estoque.', prefixos: ['/estoque'], padraoNovo: false, padraoLegado: true, plano: 'estoque' },

  { chave: 'comissoes', grupo: 'numeros', rotulo: 'Comissões (a dele)', descricao: 'Ver a própria comissão.', prefixos: ['/comissoes'], padraoNovo: true, padraoLegado: true, plano: 'comissoes' },
  { chave: 'meus_numeros', grupo: 'numeros', rotulo: 'Meus números', descricao: 'Faturamento, ticket e ocupação dele.', prefixos: [], padraoNovo: true, padraoLegado: true },
  { chave: 'numeros_barbearia', grupo: 'numeros', rotulo: 'Números da barbearia', descricao: 'Totais da barbearia toda, sem os outros barbeiros.', prefixos: [], padraoNovo: false, padraoLegado: false, plano: 'relatorios' },
  { chave: 'ranking_equipe', grupo: 'numeros', rotulo: 'Comparar com a equipe', descricao: 'Ver os números de cada barbeiro lado a lado.', prefixos: [], padraoNovo: false, padraoLegado: false, plano: 'relatorios' },

  { chave: 'caixa_ver', grupo: 'caixa', rotulo: 'Ver o caixa', descricao: 'Ver entradas, saídas e o saldo.', prefixos: [], padraoNovo: false, padraoLegado: false },
  { chave: 'caixa_lancar', grupo: 'caixa', rotulo: 'Lançar no caixa', descricao: 'Registrar entrada ou saída.', prefixos: [], padraoNovo: false, padraoLegado: false },

  { chave: 'conversas', grupo: 'comunicacao', rotulo: 'Conversas do WhatsApp', descricao: 'Ver e responder as conversas.', prefixos: ['/conversas'], padraoNovo: false, padraoLegado: true, planoOk: (p) => planoCortavo.temSecretaria(p) },
  { chave: 'ia', grupo: 'comunicacao', rotulo: 'Assistente de IA', descricao: 'Perguntar ao assistente.', prefixos: ['/ia'], padraoNovo: true, padraoLegado: true, planoOk: (p) => planoCortavo.temAssistente(p) },
];
const POR_CHAVE = new Map(CHAVES.map((c) => [c.chave, c]));
const VALIDAS = new Set(CHAVES.map((c) => c.chave));

// Compatibilidade: as 9 telas da fase 1, na ordem antiga (a tela atual da
// Equipe e o middleware de rotas usam esta lista).
const LEGADO = ['clientes', 'servicos', 'produtos', 'estoque', 'planos', 'comissoes', 'horarios', 'conversas', 'ia'];
const MODULOS = LEGADO.map((k) => {
  const c = POR_CHAVE.get(k);
  return { chave: c.chave, rotulo: c.rotulo, prefixos: c.prefixos };
});

function ehAdminPapel(usuario) {
  return !!usuario && (usuario.papel === 'admin' || usuario.papel === 'dono');
}

// Lê o texto gravado. Nunca lança: JSON quebrado vale como "legado sem bloqueios"
// (é o comportamento que a fase 1 já tinha para valor inválido).
function lerGravado(texto) {
  if (texto == null || texto === '') return { formato: 'legado', bloqueados: new Set(), liberados: new Set() };
  try {
    const v = JSON.parse(texto);
    if (Array.isArray(v)) {
      return { formato: 'legado', bloqueados: new Set(v.filter((c) => LEGADO.includes(c))), liberados: new Set() };
    }
    if (v && typeof v === 'object' && v.v === 2) {
      const so = (l) => new Set((Array.isArray(l) ? l : []).filter((c) => VALIDAS.has(c)));
      return { formato: 'v2', bloqueados: so(v.bloqueados), liberados: so(v.liberados) };
    }
  } catch (_) { /* cai no legado */ }
  return { formato: 'legado', bloqueados: new Set(), liberados: new Set() };
}

// Mapa chave -> liberada (true/false) pelo que está gravado, SEM olhar plano
// nem papel. É a "vontade do responsável".
function estadoDe(usuario) {
  const g = lerGravado(usuario && usuario.acessosBloqueados);
  const estado = new Map();
  for (const c of CHAVES) {
    let liberada;
    if (c.fixa) liberada = true;
    else if (g.formato === 'v2') liberada = g.bloqueados.has(c.chave) ? false : g.liberados.has(c.chave) ? true : c.padraoNovo;
    else liberada = LEGADO.includes(c.chave) ? !g.bloqueados.has(c.chave) : c.padraoLegado;
    estado.set(c.chave, liberada);
  }
  return estado;
}

// O plano libera esta chave? (R1)
function planoPermite(chave, plano) {
  const c = POR_CHAVE.get(chave);
  if (!c) return false;
  if (!plano) return true;
  if (c.plano && !planoCortavo.libera(plano, c.plano)) return false;
  if (c.planoOk && !c.planoOk(plano)) return false;
  return true;
}

// pode(usuario, chave, { plano }) — a pergunta única do app.
//  - chave desconhecida: false (fecha por padrão);
//  - plano desliga: false para todos (admin inclusive);
//  - admin/dono: true (R2);
//  - barbeiro: o que o responsável gravou.
// `usuario` precisa de `papel` e, para barbeiro, de `acessosBloqueados`.
function pode(usuario, chave, { plano } = {}) {
  if (!usuario || !VALIDAS.has(chave)) return false;
  if (!planoPermite(chave, plano)) return false;
  if (ehAdminPapel(usuario)) return true;
  return estadoDe(usuario).get(chave) === true;
}

// Recorte dos DADOS (R3). Devolve o filtro a juntar no `where`:
//   {}                       -> barbearia toda (admin, ou barbeiro com numeros_barbearia)
//   { usuarioId: <id dele> } -> só o que é dele
function escopo(usuario, { plano } = {}) {
  if (ehAdminPapel(usuario)) return {};
  if (pode(usuario, 'numeros_barbearia', { plano })) return {};
  return { usuarioId: usuario.id };
}

// Pode ver os números de CADA barbeiro lado a lado (ranking, desempenho por
// barbeiro, filtro por outro barbeiro)?
function podeVerEquipe(usuario, { plano } = {}) {
  return ehAdminPapel(usuario) || pode(usuario, 'ranking_equipe', { plano });
}

// Contexto pronto para uma requisição do painel: o middleware monta uma vez e
// controllers/rotas consultam sem repetir a leitura do JSON.
function contexto(usuarioSessao, usuarioDb, plano) {
  const usuario = {
    id: usuarioSessao.id,
    papel: usuarioSessao.papel,
    acessosBloqueados: usuarioDb ? usuarioDb.acessosBloqueados : null,
  };
  return {
    usuario,
    plano,
    ehAdmin: ehAdminPapel(usuario),
    pode: (chave) => pode(usuario, chave, { plano }),
    escopo: () => escopo(usuario, { plano }),
    podeVerEquipe: () => podeVerEquipe(usuario, { plano }),
    // Lista das chaves liberadas (o front usa para montar menus e cartões).
    liberadas: () => CHAVES.filter((c) => pode(usuario, c.chave, { plano })).map((c) => c.chave),
  };
}

// Conjunto das chaves BLOQUEADAS (compatível com a fase 1: o middleware de rotas
// só pergunta pelas que têm prefixo de tela).
function bloqueadosDe(usuario) {
  const est = estadoDe(usuario);
  return new Set(CHAVES.filter((c) => !est.get(c.chave)).map((c) => c.chave));
}

// Qual módulo cobre um caminho relativo ao /painel (ex.: "/clientes/3").
// Sem diferenciar maiúsculas (o Express casa /CLIENTES com /clientes).
function moduloDoCaminho(caminho) {
  const c = String(caminho || '').toLowerCase();
  return MODULOS.find((m) => m.prefixos.some((p) => c === p || c.startsWith(p + '/')));
}

// Formato novo a partir de um estado (Map chave -> liberada).
function serializar(estado) {
  const bloqueados = [];
  const liberados = [];
  for (const c of CHAVES) {
    if (c.fixa) continue;
    if (estado.get(c.chave)) liberados.push(c.chave);
    else bloqueados.push(c.chave);
  }
  return JSON.stringify({ v: 2, bloqueados, liberados });
}

// Padrão de barbeiro NOVO (gravado na criação, para não cair no legado).
function padraoNovoSerializado() {
  return serializar(new Map(CHAVES.map((c) => [c.chave, !!(c.fixa || c.padraoNovo)])));
}

// Do formulário da Equipe: checkbox `acesso_<chave>` marcado = liberado.
//
// Só decide as chaves que o formulário MOSTROU. A tela antiga mostra as 9 telas
// e não manda `acessoChaves`; a tela nova (F3 do Fabio) manda
// `acessoChaves=chave1,chave2,...` com as que exibiu (o plano esconde algumas, R1).
// Chave não exibida mantém o valor que já estava gravado — senão salvar a tela
// antiga bloquearia "meus números" sem ninguém ter pedido.
function bloqueadosDoForm(body, gravadoAnterior) {
  body = body || {};
  const exibidas = body.acessoChaves != null
    ? String(body.acessoChaves).split(',').map((s) => s.trim()).filter((k) => VALIDAS.has(k))
    : LEGADO;
  const estado = estadoDe({ acessosBloqueados: gravadoAnterior == null ? null : gravadoAnterior });
  for (const k of exibidas) {
    if (POR_CHAVE.get(k).fixa) continue;
    estado.set(k, !!body['acesso_' + k]);
  }
  return serializar(estado);
}

// Para a tela de permissões (F3): grupos com as chaves e o estado de cada uma.
// `foraDoPlano` = o plano desliga (R1): a tela do responsável mostra com cadeado
// e o texto do plano; nunca é oferecida como opção liberável.
function chavesParaTela(usuarioAlvo, plano) {
  const est = estadoDe(usuarioAlvo);
  return GRUPOS.map((g) => ({
    ...g,
    chaves: CHAVES.filter((c) => c.grupo === g.chave && !c.fixa).map((c) => {
      const permite = planoPermite(c.chave, plano);
      return {
        chave: c.chave,
        rotulo: c.rotulo,
        descricao: c.descricao,
        liberada: est.get(c.chave),
        foraDoPlano: !permite,
        cadeado: !permite && c.plano ? planoCortavo.textoForaDoPlano(c.plano) : null,
      };
    }),
  })).filter((g) => g.chaves.length);
}

// Telefone com só o final visível ("•••• 4321"), para quem não tem clientes_contato.
function mascararTelefone(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (!d) return '';
  return '•••• ' + d.slice(-4);
}

module.exports = {
  GRUPOS, CHAVES, MODULOS, LEGADO,
  estadoDe, pode, escopo, podeVerEquipe, contexto, planoPermite,
  bloqueadosDe, moduloDoCaminho, bloqueadosDoForm, serializar, padraoNovoSerializado,
  chavesParaTela, mascararTelefone,
};
