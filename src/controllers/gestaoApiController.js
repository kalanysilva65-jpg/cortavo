// API da Gestão (spec 12, B4): um endpoint por cartão, já recortado por
// permissão (B1/B2) e plano. Formato e regras de cada um em
// squads/app-cortavo/output/gestao-dados-apis.md (documento para o Fabio).
//
// O recorte NUNCA vem da tela: `?barbeiro=` só é aceito para o próprio usuário
// ou para quem pode comparar a equipe (admin ou ranking_equipe); o resto
// recebe 403 sem dado nenhum (critérios 4 e 5).
const prisma = require('../config/db');
const metricas = require('../services/metricas');

function semCache(res) {
  res.set('Cache-Control', 'private, no-store');
}

function responderErro(res, e) {
  if (e && e.status === 403) {
    if (e.foraDoPlano) {
      const planoCortavo = require('../services/planoCortavo');
      return res.status(403).json({ erro: planoCortavo.textoForaDoPlano(e.foraDoPlano), foraDoPlano: true });
    }
    return res.status(403).json({ erro: 'Sem acesso a esta área.', semPermissao: true });
  }
  if (e && (e.status === 400 || e.status === 404)) return res.status(e.status).json({ erro: e.message });
  throw e;
}

// `?barbeiro=ID` -> id de um membro DESTA barbearia (ou null). Lança 400 se o
// número não for de ninguém daqui (não revela se existe em outra barbearia).
async function lerBarbeiroFiltro(req) {
  const v = req.query.barbeiro;
  if (v == null || v === '' || v === 'todos') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) {
    const e = new Error('Barbeiro inválido.');
    e.status = 400;
    throw e;
  }
  const u = await prisma.usuario.findFirst({ where: { id, barbeariaId: req.barbeariaId }, select: { id: true } });
  if (!u) {
    const e = new Error('Barbeiro inválido.');
    e.status = 400;
    throw e;
  }
  return id;
}

// GET /painel/api/gestao/cartoes — os cartões que esta pessoa vê, em ordem.
async function cartoes(req, res) {
  semCache(res);
  res.json({ cartoes: metricas.cartoesDisponiveis(req.permissoes), podeFiltrarBarbeiro: req.permissoes.podeVerEquipe() });
}

// GET /painel/api/gestao/:metrica?periodo=&de=&ate=&barbeiro=&detalhe=1
async function metrica(req, res) {
  semCache(res);
  try {
    const barbeiroFiltro = await lerBarbeiroFiltro(req);
    const r = await metricas.calcular(req.params.metrica, {
      barbeariaId: req.barbeariaId,
      permissoes: req.permissoes,
      query: req.query,
      barbeiroFiltro,
    });
    res.json(r);
  } catch (e) {
    return responderErro(res, e);
  }
}

module.exports = { cartoes, metrica, responderErro, lerBarbeiroFiltro, semCache };
