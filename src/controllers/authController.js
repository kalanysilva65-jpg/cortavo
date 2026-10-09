// Controlador de autenticação (login/logout) com bcrypt + sessão.
// Multi-tenant: a autenticação é feita DENTRO da barbearia do contexto
// (subdomínio). O dono do sistema (papel "dono") loga sem barbearia e cai no
// painel-mestre.
const bcrypt = require('bcryptjs');
const prisma = require('../config/db');
const pausa = require('../services/pausa');
const auditoria = require('../services/auditoria');
const tokensAcesso = require('../services/tokensAcesso');
const acessoLink = require('../services/acessoLink');
const { SUPORTE_CORTAVO } = require('../config/constantes');

// "Versão" da senha guardada na sessão (F6 da spec 13): quando a senha muda,
// senhaDefinidaEm muda e as sessões abertas antes deixam de valer
// (middlewares/sessaoValida.js).
function versaoSenha(usuario) {
  return usuario && usuario.senhaDefinidaEm ? new Date(usuario.senhaDefinidaEm).getTime() : 0;
}

// Cria a sessão do usuário. Usado pelo login e pelo "Crie sua senha".
async function abrirSessao(req, usuario, { manterConectado = false } = {}) {
  // Renova o ID de sessão no login (anti session-fixation): se alguém plantou
  // um cookie de sessão conhecido antes do login, ele deixa de valer no instante
  // em que o usuário se autentica. Só depois da renovação é que gravamos os
  // dados do usuário na sessão nova.
  await new Promise((resolve) => req.session.regenerate(() => resolve()));

  // Guarda só o essencial na sessão (inclui a barbearia do usuário).
  req.session.usuario = {
    id: usuario.id,
    nome: usuario.nome,
    papel: usuario.papel,
    barbeariaId: usuario.barbeariaId,
  };
  req.session.senhaVersao = versaoSenha(usuario);

  // Senha provisória (padrão de fábrica ou criada pelo admin): o guard global
  // vai forçar a tela de troca antes de liberar qualquer área. A marca fica na
  // sessão pra não reler o banco a cada request.
  req.session.trocarSenha = !!usuario.senhaProvisoria;

  // "Manter conectado" (pedido do dono, 2026-08-01): estende o cookie de 8h
  // para 30 dias. Sem marcar, segue o padrão curto.
  //
  // EXCEÇÃO — dono do sistema (super-admin do painel-mestre): a sessão dele
  // NUNCA é estendida, mesmo marcando o checkbox. O /mestre é a área mais
  // sensível do sistema; uma sessão de 30 dias ali é risco grande demais.
  if (manterConectado && usuario.papel !== 'dono') {
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
  }
}

// Persiste a sessão (novo ID + dados) ANTES de redirecionar: com store em
// arquivo, sem isso a requisição seguinte poderia chegar antes da gravação.
function salvarSessao(req) {
  return new Promise((resolve) => req.session.save(() => resolve()));
}

// Para onde mandar cada perfil depois do login.
function destino(usuario) {
  return usuario.papel === 'dono' ? '/mestre' : '/painel';
}

// Tela de login.
function mostrarLogin(req, res) {
  if (req.session.usuario) return res.redirect(destino(req.session.usuario));
  res.render('auth/login', {
    // Layout próprio (não o `blank`): o login da equipe foi para o design
    // "suave" e o `blank` ainda serve as páginas de conta do cliente.
    layout: 'layouts/auth',
    titulo: 'Entrar',
    barbearia: req.barbearia || null,
  });
}

// Localiza o usuário que está tentando logar, conforme o contexto.
async function localizarUsuario(email, req) {
  // Um subdomínio/slug foi informado mas NÃO resolveu para uma barbearia ativa.
  // Inexistente: bloqueia (mensagem genérica). PAUSADA (spec 01): procura o
  // usuário nela só para, com a senha certa, mostrar a tela de acesso pausado —
  // o bloqueio de fato acontece em fazerLogin, antes de criar a sessão.
  if (req.slugBarbearia && !req.barbearia) {
    const b = await prisma.barbearia.findUnique({ where: { slug: req.slugBarbearia } });
    if (!b || b.ativo) return null;
    return prisma.usuario.findUnique({
      where: { barbeariaId_email: { barbeariaId: b.id, email } },
    });
  }
  // Com barbearia no contexto, autentica dentro dela.
  if (req.barbearia) {
    return prisma.usuario.findUnique({
      where: { barbeariaId_email: { barbeariaId: req.barbearia.id, email } },
    });
  }

  // Sem barbearia no contexto (domínio raiz): primeiro o dono do sistema.
  const dono = await prisma.usuario.findFirst({ where: { barbeariaId: null, email } });
  if (dono) return dono;

  // A equipe das barbearias também precisa entrar pelo domínio raiz enquanto os
  // subdomínios não estiverem no ar. O e-mail é único por barbearia, não global:
  // se o mesmo e-mail existir em mais de uma, o contexto é ambíguo e o login só
  // pode ser feito pelo subdomínio da barbearia.
  const candidatos = await prisma.usuario.findMany({ where: { email, ativo: true }, take: 2 });
  return candidatos.length === 1 ? candidatos[0] : null;
}

// Processa o login.
async function fazerLogin(req, res) {
  const email = (req.body.email || '').trim().toLowerCase();
  const senha = req.body.senha || '';

  const usuario = await localizarUsuario(email, req);

  // Mensagem genérica de propósito (não revela se o e-mail existe).
  // bcrypt.compare (assíncrono) em vez do ...Sync: o cálculo do bcrypt é caro
  // (~dezenas de ms) e a versão síncrona TRAVA o event-loop — numa rajada de
  // logins, todos os outros requests esperam. O await só roda se houver usuário
  // (o || curto-circuita antes), mantendo a mensagem de erro genérica.
  const invalido = !usuario || !usuario.ativo || !(await bcrypt.compare(senha, usuario.senhaHash));
  if (invalido) {
    req.session.flash = { tipo: 'erro', texto: 'E-mail ou senha inválidos.' };
    return res.redirect('/login');
  }

  // Pausa de verdade (spec 01): só DEPOIS de conferir a senha (quem erra a
  // senha continua vendo a mensagem genérica, sem saber que está pausada) e
  // ANTES de criar a sessão. O dono do sistema não tem barbearia: nunca cai aqui.
  if (usuario.papel !== 'dono' && usuario.barbeariaId) {
    const b = await prisma.barbearia.findUnique({ where: { id: usuario.barbeariaId }, select: { ativo: true, nome: true } });
    if (!b || b.ativo === false) return pausa.renderTelaPausa(res, b && b.nome);
  }

  await abrirSessao(req, usuario, { manterConectado: !!req.body.manterConectado });
  await salvarSessao(req);
  res.redirect(destino(usuario));
}

// Encerra a sessão.
function logout(req, res) {
  req.session.destroy(() => res.redirect('/login'));
}

// Tela de definir uma senha nova (troca obrigatória de senha provisória).
function mostrarTrocaSenha(req, res) {
  if (!req.session.usuario) return res.redirect('/login');
  res.render('auth/trocar-senha', {
    layout: 'layouts/auth',
    titulo: 'Defina sua senha',
    barbearia: req.barbearia || null,
    obrigatoria: !!req.session.trocarSenha,
  });
}

// Processa a troca de senha. Exige a senha atual (a provisória), uma nova de ao
// menos 8 caracteres e diferente da atual. Ao concluir, limpa a marca de
// provisória no banco e na sessão e leva o usuário para a sua área.
async function trocarSenha(req, res) {
  if (!req.session.usuario) return res.redirect('/login');
  const atual = req.body.senhaAtual || '';
  const nova = req.body.novaSenha || '';
  const conf = req.body.confirmar || '';

  const erro = (texto) => {
    req.session.flash = { tipo: 'erro', texto };
    return res.redirect('/trocar-senha');
  };

  const usuario = await prisma.usuario.findUnique({ where: { id: req.session.usuario.id } });
  if (!usuario) return req.session.destroy(() => res.redirect('/login'));

  if (!(await bcrypt.compare(atual, usuario.senhaHash))) return erro('Senha atual incorreta.');
  if (nova.length < 8) return erro('A nova senha precisa ter ao menos 8 caracteres.');
  if (nova !== conf) return erro('A confirmação não bate com a nova senha.');
  if (await bcrypt.compare(nova, usuario.senhaHash)) return erro('A nova senha precisa ser diferente da atual.');

  // senhaDefinidaEm muda junto: as OUTRAS sessões abertas com a senha antiga
  // caem (F6); esta segue valendo com a versão nova.
  const agora = new Date();
  await prisma.usuario.update({
    where: { id: usuario.id },
    data: { senhaHash: await bcrypt.hash(nova, 10), senhaProvisoria: false, senhaDefinidaEm: agora },
  });
  req.session.senhaVersao = agora.getTime();
  req.session.trocarSenha = false;
  req.session.flash = { tipo: 'sucesso', texto: 'Senha atualizada com sucesso.' };
  res.redirect(destino(usuario));
}

// ===================== Acesso por link (spec 13) =====================
// Respostas destas telas nunca vão para cache (o link carrega um segredo).
function semCache(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

// A MESMA tela para link inválido, usado, revogado, vencido ou de pessoa
// inativa: nunca diz o motivo.
function telaLinkInvalido(req, res) {
  if (req.session) delete req.session.acessoLink;
  semCache(res);
  return res.status(410).render('auth/link-invalido', {
    layout: 'layouts/auth',
    titulo: 'Este link não vale mais',
    barbearia: null,
    aviso: false,
    suporte: SUPORTE_CORTAVO,
  });
}

// Regras da senha nova: mínimo 8 caracteres, máximo 72 BYTES (o bcrypt ignora
// o que passa disso), confirmação igual. Sem regra de "maiúscula + símbolo".
const SENHA_MIN = 8;
const SENHA_MAX_BYTES = 72;
function erroDaSenha(senha, confirmar) {
  if (typeof senha !== 'string' || senha.length < SENHA_MIN) return 'A senha precisa ter ao menos 8 caracteres.';
  if (Buffer.byteLength(senha, 'utf8') > SENHA_MAX_BYTES) return 'Use no máximo 72 caracteres.';
  if (senha !== confirmar) return 'As duas senhas não são iguais.';
  return null;
}

async function renderFormCriarSenha(req, res, valido, erro, status = 200) {
  const b = await prisma.barbearia.findUnique({ where: { id: valido.usuario.barbeariaId }, select: { nome: true } });
  semCache(res);
  return res.status(status).render('auth/criar-senha', {
    layout: 'layouts/auth',
    titulo: 'Crie sua senha',
    barbearia: null,
    nomeBarbearia: (b && b.nome) || 'sua barbearia',
    email: valido.usuario.email,
    erro,
  });
}

// GET /criar-senha?t=... e GET /criar-senha.
// Com ?t: só VALIDA (não consome: leitores de e-mail e antivírus abrem links
// sozinhos), guarda o HASH na sessão e redireciona para a URL limpa (o token sai
// do histórico do navegador). Sem ?t: mostra o formulário do link guardado.
async function mostrarCriarSenha(req, res) {
  const t = req.query && req.query.t;
  if (t !== undefined) {
    const valido = typeof t === 'string' ? await tokensAcesso.validar(t) : null;
    if (!valido) return telaLinkInvalido(req, res);
    req.session.acessoLink = { hash: tokensAcesso.hashToken(t) };
    await salvarSessao(req);
    semCache(res);
    return res.redirect('/criar-senha');
  }
  const hash = req.session.acessoLink && req.session.acessoLink.hash;
  const valido = hash ? await tokensAcesso.validarHash(hash) : null;
  if (!valido) return telaLinkInvalido(req, res);
  // Aviso do limite de tentativas (flash) aparece dentro do formulário.
  const flash = res.locals && res.locals.flash;
  const erro = flash && flash.tipo === 'erro' ? flash.texto : null;
  if (erro) res.locals.flash = null;
  return renderFormCriarSenha(req, res, valido, erro);
}

// POST /criar-senha: confere a senha, consome o link de forma atômica, grava e
// já entra (sessão regenerada). Barbearia pausada: tela de pausa, sem sessão.
// Proteção extra contra formulário forjado: o hash do link precisa estar na
// sessão (um site de fora não tem).
async function criarSenha(req, res) {
  const hash = req.session.acessoLink && req.session.acessoLink.hash;
  const valido = hash ? await tokensAcesso.validarHash(hash) : null;
  if (!valido) return telaLinkInvalido(req, res);

  const senha = req.body.senha;
  const erro = erroDaSenha(senha, req.body.confirmar);
  if (erro) return renderFormCriarSenha(req, res, valido, erro, 422);

  const senhaHash = await bcrypt.hash(senha, 10);
  const usuario = await tokensAcesso.consumirHash(hash, senhaHash);
  if (!usuario) return telaLinkInvalido(req, res);
  delete req.session.acessoLink;

  const b = await prisma.barbearia.findUnique({ where: { id: usuario.barbeariaId }, select: { ativo: true, nome: true } });
  if (!b || b.ativo === false) {
    await auditoria.registrar(req, { acao: 'acesso.senha_criada', alvoTipo: 'usuario', alvoId: usuario.id, detalhe: `${usuario.email} criou a senha pelo link (barbearia pausada: não entrou).` });
    semCache(res);
    return pausa.renderTelaPausa(res, b && b.nome);
  }

  await abrirSessao(req, usuario);
  await auditoria.registrar(req, { acao: 'acesso.senha_criada', alvoTipo: 'usuario', alvoId: usuario.id, detalhe: `${usuario.email} criou a senha pelo link.` });
  req.session.flash = { tipo: 'sucesso', texto: 'Senha criada. Bem-vindo à Cortavo.' };
  await salvarSessao(req);
  semCache(res);
  return res.redirect(destino(usuario));
}

// GET /esqueci-senha
function mostrarEsqueci(req, res) {
  semCache(res);
  res.render('auth/esqueci-senha', { layout: 'layouts/auth', titulo: 'Esqueci minha senha', barbearia: null, pedido: false });
}

// POST /esqueci-senha: SEMPRE a mesma resposta. O envio roda depois da resposta
// (sem diferença de tempo entre e-mail com e sem conta).
function pedirLinkEsqueci(req, res) {
  const tarefa = acessoLink.esqueciSenha({
    email: req.body.email,
    barbeariaId: req.barbearia ? req.barbearia.id : null,
    req: { ip: req.ip, session: {} },
  });
  res.locals.tarefaEsqueci = tarefa; // os testes esperam por ela
  semCache(res);
  res.render('auth/esqueci-senha', { layout: 'layouts/auth', titulo: 'Esqueci minha senha', barbearia: null, pedido: true });
}

module.exports = {
  mostrarLogin, fazerLogin, logout, mostrarTrocaSenha, trocarSenha,
  mostrarCriarSenha, criarSenha, mostrarEsqueci, pedirLinkEsqueci,
  erroDaSenha, versaoSenha,
};

