// Resolução do tenant (barbearia) por subdomínio, com escopo por barbearia.
//
// Em produção a barbearia vem do subdomínio: <slug>.seuapp.com.
// Em desenvolvimento (localhost, sem subdomínio) usa-se ?b=<slug>, que fica
// guardado na sessão para persistir entre as páginas.
//
// Regras de contexto:
//  - Área pública (/agendar): a barbearia vem do subdomínio (req.barbearia).
//  - Painel (/painel): a barbearia vem do usuário logado (staff) ou da barbearia
//    que o dono escolheu "entrar" (impersonação) — NUNCA do subdomínio, por segurança.
const prisma = require('../config/db');
const pausa = require('../services/pausa');

// Subdomínios que NÃO representam uma barbearia.
const SUBDOMINIOS_RESERVADOS = new Set(['www', 'admin', 'painel', 'app', 'api', 'mestre']);

// Endereço IPv4 puro (ex.: "192.168.2.107") — usado para testar em outros
// aparelhos na mesma rede local. Não tem subdomínio de verdade.
const REGEX_IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Domínio raiz da aplicação em produção (ex.: "cortavo.com.br"). Necessário
// porque TLDs compostos (.com.br, .co.uk...) já têm 3 partes no domínio raiz,
// então "contar partes" confundiria o domínio raiz com um subdomínio.
const APP_DOMAIN = (process.env.APP_DOMAIN || '').toLowerCase().replace(/^www\./, '');

// O atalho `?b=<slug>` é uma muleta de DESENVOLVIMENTO (localhost não tem
// subdomínio real). Em produção ele não só é desnecessário como quebra o
// login: o slug fica guardado na sessão e, se não existir nenhuma barbearia
// com ele, o authController passa a recusar TODO login no domínio raiz com a
// mensagem enganosa "e-mail ou senha inválidos" — o usuário nunca descobre que
// o problema foi uma URL antiga que ele abriu antes. Mesmo critério de
// `config/paths.js`: com APP_DOMAIN definido, o subdomínio já resolve tudo.
const EH_PRODUCAO = process.env.NODE_ENV === 'production' || !!APP_DOMAIN;

// Extrai o slug da barbearia a partir do hostname.
// Ex.: "barbearia1.seuapp.com" -> "barbearia1"; "barbearia1.localhost" -> "barbearia1".
// localhost puro / IP / domínio raiz não têm subdomínio utilizável -> null.
function extrairSlug(req) {
  const host = (req.hostname || '').toLowerCase();
  if (REGEX_IPV4.test(host)) return null; // ex.: acesso via IP da rede local (celular/PC de teste)

  const partes = host.split('.');
  const ehLocalhost = partes[partes.length - 1] === 'localhost';
  if (ehLocalhost) {
    if (partes.length >= 2 && !SUBDOMINIOS_RESERVADOS.has(partes[0])) return partes[0];
    return null;
  }

  if (APP_DOMAIN) {
    const semWww = host.replace(/^www\./, '');
    if (semWww === APP_DOMAIN) return null; // domínio raiz: sem barbearia
    if (semWww.endsWith('.' + APP_DOMAIN)) {
      const prefixo = semWww.slice(0, semWww.length - ('.' + APP_DOMAIN).length);
      const primeiroRotulo = prefixo.split('.')[0];
      return SUBDOMINIOS_RESERVADOS.has(primeiroRotulo) ? null : primeiroRotulo;
    }
    return null;
  }

  // Sem APP_DOMAIN configurado (ex.: ambiente não previsto): heurística antiga.
  if (partes.length >= 3 && !SUBDOMINIOS_RESERVADOS.has(partes[0])) {
    return partes[0];
  }
  return null;
}

// Middleware: resolve a barbearia do contexto PÚBLICO (subdomínio ou ?b= em dev).
async function resolverBarbearia(req, res, next) {
  // Dev: ?b=slug fixa a barbearia na sessão (facilita testar sem subdomínio real).
  // ?b=mestre limpa o contexto (permite logar como dono do sistema em dev).
  // Em produção é ignorado por completo — inclusive um valor que já tenha
  // sobrado na sessão de antes (ver EH_PRODUCAO no topo do arquivo).
  if (!EH_PRODUCAO && req.query.b !== undefined) {
    const val = String(req.query.b).toLowerCase();
    if (!val || SUBDOMINIOS_RESERVADOS.has(val)) delete req.session.devBarbeariaSlug;
    else req.session.devBarbeariaSlug = val;
  }

  let slug = extrairSlug(req);
  if (!EH_PRODUCAO && !slug && req.session.devBarbeariaSlug) slug = req.session.devBarbeariaSlug;

  // slug informado (subdomínio ou dev) — mesmo que aponte para barbearia inexistente/inativa.
  req.slugBarbearia = slug || null;
  req.barbearia = null;
  if (slug) {
    const b = await prisma.barbearia.findUnique({ where: { slug } });
    if (b && b.ativo) req.barbearia = b;
  }
  res.locals.barbearia = req.barbearia;
  next();
}

// Retorna o id da barbearia "ativa" para o painel:
//  - staff (admin/funcionario): a própria barbearia;
//  - dono: a barbearia que ele escolheu operar (impersonação), se houver.
function barbeariaIdAtual(req) {
  const u = req.session.usuario;
  if (!u) return null;
  if (u.papel === 'dono') return req.session.barbeariaAtivaId || null;
  return u.barbeariaId || null;
}

// Middleware do painel: garante que há uma barbearia no contexto e a deixa em req.barbeariaId.
// Dono sem barbearia escolhida é mandado para o painel-mestre.
async function exigeBarbeariaPainel(req, res, next) {
  const id = barbeariaIdAtual(req);
  if (!id) {
    if (req.session.usuario && req.session.usuario.papel === 'dono') {
      return res.redirect('/mestre');
    }
    return res.status(400).render('erro', {
      layout: 'layouts/blank',
      titulo: 'Barbearia não encontrada',
      mensagem: 'Sua conta não está vinculada a nenhuma barbearia.',
    });
  }
  // Pausa de verdade (spec 01): equipe de barbearia pausada (ou removida) cai
  // fora no próximo clique — a sessão é encerrada e aparece a tela de pausa.
  // A Kalany (papel "dono") continua podendo abrir a barbearia pelo
  // painel-mestre para conferir dados.
  if (req.session.usuario.papel !== 'dono') {
    const b = await prisma.barbearia.findUnique({ where: { id }, select: { ativo: true, nome: true } });
    if (!b || b.ativo === false) {
      await new Promise((resolve) => req.session.destroy(() => resolve()));
      if (req.xhr || (req.headers.accept || '').includes('application/json')) {
        return res.status(403).json({ erro: pausa.mensagemPausa(b && b.nome) });
      }
      return pausa.renderTelaPausa(res, b && b.nome);
    }
  }
  req.barbeariaId = id;
  next();
}

// Middleware público: exige que o subdomínio aponte para uma barbearia válida.
function exigeBarbeariaPublica(req, res, next) {
  if (!req.barbearia) {
    return res.status(404).render('erro', {
      layout: 'layouts/blank',
      titulo: 'Barbearia não encontrada',
      mensagem: 'Este endereço não corresponde a nenhuma barbearia ativa.',
    });
  }
  req.barbeariaId = req.barbearia.id;
  next();
}

module.exports = {
  resolverBarbearia,
  barbeariaIdAtual,
  exigeBarbeariaPainel,
  exigeBarbeariaPublica,
  extrairSlug,
};
