// Freio a força-bruta nas telas de login (equipe e cliente).
// O server usa `trust proxy = 1`, então o rate-limit enxerga o IP real do
// cliente atrás do nginx — sem isso, todo mundo apareceria com o IP do proxy e
// um cadeado só derrubaria o site inteiro.
const rateLimit = require('express-rate-limit');

// Janela de 15 min. O teto é generoso de propósito: numa barbearia várias
// pessoas saem pelo MESMO IP (o wifi da casa), então um teto baixo travaria
// quem só errou a senha. 20 tentativas seguram um humano distraído e ainda
// assim fecham a porta pra milhares de tentativas automatizadas.
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // As telas de login são formulários (POST): responder o 429 cru do pacote
  // apareceria como página quebrada. Em vez disso, volta pro formulário com um
  // aviso amigável, no mesmo padrão de erro do resto do app.
  handler(req, res) {
    req.session.flash = {
      tipo: 'erro',
      texto: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.',
    };
    res.redirect(req.get('Referer') || '/login');
  },
});

// Freio das rotas do painel-mestre (super-admin do SaaS). É a área mais sensível
// do sistema, usada por UMA pessoa (o dono) — então o teto pode ser bem mais
// baixo que o de tráfego público. Aqui o alvo não é força-bruta de login (isso
// o `limiteLogin` já cobre no /login), e sim conter uma sessão sequestrada que
// tente disparar muitas ações em rajada. 300 req / 10 min é folgado pra um
// humano navegando e fecha a porta pra automação.
const limiteAdmin = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).render('erro', {
      layout: 'layouts/blank',
      titulo: 'Muitas requisições',
      mensagem: 'Você fez muitas ações em pouco tempo. Aguarde um minuto e tente de novo.',
    });
  },
});

// Freio do assistente de IA (/painel/ia/mensagem). Cada mensagem pode disparar
// várias chamadas ao modelo (que custam dinheiro), então o teto protege tanto
// contra abuso quanto contra a conta da API estourar. 30 perguntas / 10 min é
// bastante para um uso humano normal. É endpoint JSON — responde 429 em JSON.
const limiteIA = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).json({ erro: 'Você fez muitas perguntas seguidas. Aguarde um minuto e tente de novo.' });
  },
});

// Freio da CONFIRMAÇÃO de agendamento público (POST /agendar/confirmar). É uma
// rota SEM login: sem freio, um script pode criar milhares de clientes e
// agendamentos falsos por barbearia — lixo no banco e pressão de escrita (o
// recurso mais escasso no SQLite). 15 confirmações / 10 min é folgado para um
// cliente de verdade (que marca um horário, não vinte) e fecha a porta pra
// automação. É form (POST) — volta pro fluxo com aviso amigável, sem 429 cru.
const limiteAgendar = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    req.session.flash = {
      tipo: 'erro',
      texto: 'Muitas tentativas de agendamento em pouco tempo. Aguarde alguns minutos e tente de novo.',
    };
    res.redirect(req.get('Referer') || '/agendar');
  },
});

// --- Acesso por link (spec 13, seção 4) ------------------------------------
// Telas públicas e sem login. Fábricas (criar*) para os testes montarem limites
// novos sem estado compartilhado.
const QUINZE_MIN = 15 * 60 * 1000;

// GET /criar-senha: 30 / 15 min por IP. Responde a tela simples de aviso.
function criarLimiteCriarSenhaGet() {
  return rateLimit({
    windowMs: QUINZE_MIN,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler(req, res) {
      res.set('Cache-Control', 'no-store');
      res.status(429).render('auth/link-invalido', { layout: 'layouts/auth', titulo: 'Muitas tentativas', barbearia: null, aviso: true, suporte: '' });
    },
  });
}

// POST /criar-senha: 10 / 15 min por IP. Volta ao formulário com o aviso
// (padrão do limiteLogin). Redireciona para a própria rota: o Referer não vem
// (helmet manda Referrer-Policy: no-referrer).
// Revisão da Vera: a conta é por IP E por link (o hash do link guardado na
// sessão no GET). Numa barbearia, todo mundo sai pelo mesmo wifi; contar só por
// IP deixaria um barbeiro que errou a senha travar a criação de senha dos
// colegas. Sem link na sessão o POST já cai em "link não vale mais" antes de
// qualquer bcrypt, então separar por link não abre força bruta.
function chaveCriarSenha(req) {
  const h = req.session && req.session.acessoLink && req.session.acessoLink.hash;
  return (req.ip || '') + '|' + (typeof h === 'string' ? h.slice(0, 16) : '-');
}

function criarLimiteCriarSenhaPost() {
  return rateLimit({
    windowMs: QUINZE_MIN,
    max: 10,
    keyGenerator: chaveCriarSenha,
    standardHeaders: true,
    legacyHeaders: false,
    handler(req, res) {
      req.session.flash = { tipo: 'erro', texto: 'Muitas tentativas, aguarde alguns minutos.' };
      res.redirect('/criar-senha');
    },
  });
}

// POST /esqueci-senha: 5 / 15 min por IP. Estourado, a resposta é a MESMA de
// sempre ("Se esse e-mail tiver acesso, enviamos um link."), só que nada sai.
function criarLimiteEsqueci() {
  return rateLimit({
    windowMs: QUINZE_MIN,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler(req, res) {
      res.set('Cache-Control', 'no-store');
      res.render('auth/esqueci-senha', { layout: 'layouts/auth', titulo: 'Esqueci minha senha', barbearia: null, pedido: true });
    },
  });
}

const limiteCriarSenhaGet = criarLimiteCriarSenhaGet();
const limiteCriarSenhaPost = criarLimiteCriarSenhaPost();
const limiteEsqueci = criarLimiteEsqueci();

module.exports = {
  limiteLogin, limiteAdmin, limiteIA, limiteAgendar,
  limiteCriarSenhaGet, limiteCriarSenhaPost, limiteEsqueci,
  criarLimiteCriarSenhaGet, criarLimiteCriarSenhaPost, criarLimiteEsqueci, chaveCriarSenha,
};
