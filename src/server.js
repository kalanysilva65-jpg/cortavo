// Ponto de entrada do app: configura o Express, a sessão, as views e as rotas.
require('dotenv').config();
require('express-async-errors');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const expressLayouts = require('express-ejs-layouts');
const methodOverride = require('method-override');
const helmet = require('helmet');

const { uploadsDir, sessionsDir } = require('./config/paths');

const app = express();
app.set('trust proxy', 1);

// --- Cabeçalhos de segurança (helmet) -------------------------------------
// Liga o pacote padrão do helmet (HSTS, nosniff, no-referrer, anti-clickjacking
// etc.) com duas ressalvas próprias deste app:
//  - CSP DESLIGADA por ora: o app usa <script>/<style> inline em vários lugares
//    (splash, flash, alternar senha...). A CSP padrão bloquearia tudo e quebraria
//    a tela. É um item de Tier 1/2 — precisa de uma política sob medida, não do
//    default. Melhor não ligar meia-boca e dar falsa sensação de segurança.
//  - CORP em 'cross-origin': os links públicos de agendamento e imagens de
//    /uploads são compartilhados/pré-visualizados fora do site (WhatsApp etc.);
//    o padrão 'same-origin' bloquearia essas prévias.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Versão dos assets. Muda a cada boot — e como todo deploy reinicia o serviço
// (systemctl restart cortavo), muda a cada deploy. Vai como ?v=... nos links de
// CSS/JS: com isso o navegador pode cachear esses arquivos "para sempre"
// (immutable) e ainda assim pegar a versão nova quando a gente publica.
// É o que faz a troca de tela parar de revalidar ~7 arquivos na rede toda vez.
const ASSET_V = Date.now().toString(36);
app.locals.assetV = ASSET_V;

// --- Views: EJS + layouts -------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/painel'); // layout padrão (painel interno)

// --- Parsers e utilidades -------------------------------------------------
app.use(express.urlencoded({ extended: true }));
// `verify` guarda o corpo CRU (req.rawBody) — o webhook do WhatsApp precisa dele
// para conferir a assinatura X-Hub-Signature-256 (HMAC calcula sobre os bytes
// originais, não sobre o JSON já parseado).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(methodOverride('_method')); // permite PUT/DELETE em formulários

// --- Webhooks externos (públicos) -----------------------------------------
// Montado ANTES da sessão/tenant: a Meta chama de fora, sem cookie, e não deve
// criar arquivo de sessão nem passar pela resolução de barbearia por subdomínio.
app.use('/webhooks', require('./routes/webhooks'));

// --- Arquivos estáticos ---------------------------------------------------
// Cache agressivo, mas seguro:
//  - fonte (.woff2): nunca muda -> 1 ano immutable.
//  - CSS/JS pedidos com ?v=... (versionados por deploy): 1 ano immutable; o ?v
//    muda no próximo deploy e o navegador busca a versão nova.
//  - o resto (sw.js, manifest, ícones sem ?v): revalida sempre, para não
//    congelar o service worker nem o manifesto.
// Antes era sem cache: cada troca de tela revalidava tudo na rede (lentidão).
const UM_ANO = 31536000;
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: 0,
    setHeaders(res, filePath) {
      const temVersao = /[?&]v=/.test(res.req.originalUrl || '');
      if (/\.woff2?$/.test(filePath) || temVersao) {
        res.setHeader('Cache-Control', `public, max-age=${UM_ANO}, immutable`);
      } else {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      }
    },
  })
);
app.use('/uploads', express.static(uploadsDir, { maxAge: UM_ANO * 1000 }));

// --- Sessão ---------------------------------------------------------------
// O SESSION_SECRET assina os cookies de sessão. Se faltar em produção, o
// fallback abaixo seria um segredo PÚBLICO (está no código) — qualquer um
// poderia forjar uma sessão e se passar por outro usuário. Por isso, em
// produção, um segredo ausente ou igual ao placeholder ABORTA o boot: é melhor
// o serviço não subir (erro visível no log) do que subir inseguro em silêncio.
// Em dev o fallback continua valendo, para não atrapalhar o localhost.
const EH_PRODUCAO_SRV = process.env.NODE_ENV === 'production' || !!process.env.APP_DOMAIN;
if (EH_PRODUCAO_SRV && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'troque-este-segredo')) {
  console.log('[SEGURANÇA] SESSION_SECRET ausente ou no valor padrão em produção. Defina um valor forte e único (32+ caracteres aleatórios) no .env do VPS e reinicie. Abortando o boot.');
  process.exit(1);
}
app.use(
  session({
    store: new FileStore({
      path: sessionsDir,
      ttl: 60 * 60 * 8, // 8 horas, igual ao maxAge do cookie
      retries: 2,
      reapInterval: 60 * 60, // limpa sessões expiradas a cada hora
      logFn: () => {}, // silencia os logs verbosos do store
    }),
    name: 'barbearia.sid',
    secret: process.env.SESSION_SECRET || 'troque-este-segredo',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8, // 8 horas
    },
  })
);

// --- Tenant: resolve a barbearia do subdomínio (contexto público) ---------
const { resolverBarbearia, barbeariaIdAtual } = require('./middlewares/tenant');
app.use(resolverBarbearia);

// --- Sessão ainda vale? (spec 13, F6) ---------------------------------------
// Senha trocada ou pessoa desativada: as sessões abertas antes caem.
app.use(require('./middlewares/sessaoValida').sessaoValida);

// --- Variáveis disponíveis em todas as views ------------------------------
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash; // flash some depois de exibido
  res.locals.currentPath = req.path;
  res.locals.suporteCortavo = require('./config/constantes').SUPORTE_CORTAVO;
  // Formata centavos -> "R$ 40,00"
  res.locals.fmtBRL = (centavos) =>
    ((centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  // Formata centavos -> "R$40" (sem centavos, sem espaço). É o formato do
  // design Turno 6: os números aparecem a 50-80px, onde ",00" só rouba
  // largura e quebra a linha.
  res.locals.fmtT6 = (centavos) =>
    'R$' + Math.round((centavos || 0) / 100).toLocaleString('pt-BR');
  // Formata Date -> "dd/mm/aaaa"
  res.locals.fmtData = (d) => {
    const x = new Date(d);
    return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
  };
  // Formata telefone normalizado -> "(51) 99999-9999"
  res.locals.fmtTelefone = require('./utils/telefone').formatarTelefone;

  // Serializa um objeto para embutir dentro de <script> COM SEGURANÇA. Um
  // JSON.stringify cru não escapa "</script>": um dado controlado pelo usuário
  // (ex.: nome de cliente vindo do agendamento PÚBLICO) contendo "</script>..."
  // fecharia a tag e rodaria script na origem do painel (XSS armazenado). Aqui
  // os caracteres perigosos viram escapes \uXXXX — o JSON continua idêntico ao
  // ser lido pelo JS, mas não há como quebrar a tag. Também escapa U+2028/2029,
  // que são quebras de linha válidas em JS e estouram o parser.
  // Serializa um objeto para embutir dentro de <script> COM SEGURANCA. Um
  // JSON.stringify cru nao escapa "</script>": um dado do usuario (ex.: nome
  // vindo do agendamento PUBLICO) com "</script>..." fecharia a tag e rodaria
  // script na origem do painel (XSS armazenado). Aqui os caracteres perigosos
  // viram escapes unicode; o JSON continua identico ao ser lido pelo JS, mas
  // nao da pra quebrar a tag. U+2028/U+2029 entram tambem: sao quebras de
  // linha validas em JS que estouram o parser dentro do <script>.
  res.locals.jsonSeguro = (obj) => {
    const perigosos = new RegExp('[<>&\\u2028\\u2029]', 'g');
    return JSON.stringify(obj).replace(perigosos, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  };

  // Logo/marca da barbearia do contexto: a do usuário logado (painel) ou a do
  // subdomínio (público). Sem contexto, usa os padrões.
  const ctxId = barbeariaIdAtual(req) || (req.barbearia && req.barbearia.id) || null;
  require('./controllers/configuracaoMarcaController').lerMarca(ctxId).then((marca) => {
    res.locals.marcaLogoUrl = marca.logoUrl;
    res.locals.marcaMostrarPoweredBy = marca.mostrarPoweredBy;
    res.locals.marcaLogoAlinhamento = marca.logoAlinhamento;
    res.locals.marcaLogoTamanho = marca.logoTamanho;
    next();
  }).catch(() => {
    res.locals.marcaLogoUrl = null;
    res.locals.marcaMostrarPoweredBy = true;
    res.locals.marcaLogoAlinhamento = 'centro';
    res.locals.marcaLogoTamanho = 168;
    next();
  });
});

// --- Manifesto PWA (dinâmico por barbearia) -------------------------------
// Cada subdomínio serve um manifesto com o nome/logo da sua barbearia. Abre
// direto no painel — se a sessão expirou, o próprio /painel redireciona pro
// login (e o login, já logado, redireciona de volta pro painel). O logo
// enviado (se houver) vira o ícone do app.
app.get('/manifest.webmanifest', (req, res) => {
  const nome = req.barbearia ? req.barbearia.nome : 'Barbearia';
  // Ícones PNG reais (192 e 512) são obrigatórios para o app ser instalável no
  // Android; o "maskable" evita o corte feio no ícone adaptativo. O SVG não vale
  // como ícone de instalação (Android ignora; iOS usa o apple-touch-icon PNG).
  const icones = [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  res.type('application/manifest+json').json({
    name: nome,
    short_name: nome.length > 12 ? nome.slice(0, 12) : nome,
    start_url: '/painel',
    scope: '/',
    display: 'standalone',
    background_color: '#111111',
    theme_color: '#111111',
    icons: icones,
  });
});

// --- Troca de senha obrigatória -------------------------------------------
// Contas com senha PROVISÓRIA (padrão de fábrica dono123/admin123, ou criadas
// pelo admin) precisam definir uma senha própria antes de usar o app. Fecha o
// buraco das senhas padrão em produção. Vale para painel E mestre — por isso
// fica aqui no topo, antes de montar as rotas, e não dentro de um router.
// Só age quando há login E a sessão está marcada como provisória; libera apenas
// a própria tela de troca e o logout, pra não criar laço de redirecionamento.
app.use((req, res, next) => {
  if (req.session.usuario && req.session.trocarSenha) {
    if (!['/trocar-senha', '/logout', '/criar-senha', '/esqueci-senha'].includes(req.path)) {
      return res.redirect('/trocar-senha');
    }
  }
  next();
});

// --- Rotas ----------------------------------------------------------------
app.use('/', require('./routes/auth'));
app.use('/conta', require('./routes/conta')); // conta de cliente (app do marketplace)
app.use('/agendar', require('./routes/agendar')); // área pública do cliente
app.use('/painel', require('./routes/painel'));
app.use('/mestre', require('./routes/mestre')); // painel-mestre (dono do sistema)

// --- 404 ------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('erro', {
    layout: 'layouts/blank',
    titulo: 'Página não encontrada',
    mensagem: 'A página que você procura não existe.',
  });
});

// --- Tratamento de erros --------------------------------------------------
app.use((err, req, res, next) => {
  // Loga no stdout (não só stderr) para aparecer no painel de logs da Hostinger,
  // com marcador para facilitar a busca. Inclui rota e método para contexto.
  console.log('[ERRO500]', req.method, req.path, /* só o caminho: a query pode ter o token do link (M2) */ '\n', (err && err.stack) || err);

  // Se a resposta já começou a ser enviada, não dá para renderizar a página de
  // erro — apenas encerra a conexão para não estourar outra exceção.
  if (res.headersSent) return next(err);

  try {
    res.status(500).render('erro', {
      layout: 'layouts/blank',
      titulo: 'Erro',
      mensagem: 'Ocorreu um erro inesperado.',
    });
  } catch (e) {
    console.log('[ERRO500-RENDER]', (e && e.stack) || e);
    res.status(500).type('text').send('Erro inesperado.');
  }
});

// Captura falhas fora do ciclo de request (promessas sem catch, etc.) no stdout.
process.on('unhandledRejection', (motivo) => {
  console.log('[unhandledRejection]', (motivo && motivo.stack) || motivo);
});
process.on('uncaughtException', (erro) => {
  console.log('[uncaughtException]', (erro && erro.stack) || erro);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Barbearia rodando em http://localhost:${PORT}`);
  // Agendador de lembretes de WhatsApp. Só age nas barbearias que ligaram o
  // recurso (config `lembretes_ativos`) — seguro deixar sempre ligado.
  try {
    require('./services/lembretes').iniciarAgendador();
  } catch (e) {
    console.log('[lembretes] não foi possível iniciar o agendador:', (e && e.message) || e);
  }
  // Limpeza diária dos links de acesso antigos (spec 13, LGPD: 30 dias).
  try {
    require('./services/tokensAcesso').iniciarLimpeza();
  } catch (e) {
    console.log('[acesso] não foi possível iniciar a limpeza de links:', (e && e.message) || e);
  }
  // Rotina diária do teste grátis (fase 2.6): aviso no 12º dia e pausa no 16º.
  try {
    require('./services/testeGratis').iniciarAgendador();
  } catch (e) {
    console.log('[teste-gratis] não foi possível iniciar a rotina:', (e && e.message) || e);
  }
});
