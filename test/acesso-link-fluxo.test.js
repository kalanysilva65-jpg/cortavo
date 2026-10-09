// Spec 13 (acesso por link), fatias F3 a F6: telas /criar-senha, mestre,
// "Esqueci minha senha" e sessões derrubadas na troca de senha.
// Sem banco (memória), sem .env, sem rede: o transporte de e-mail é FALSO e
// guarda o que "sairia". Nenhum e-mail de verdade é enviado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const ejs = require('ejs');
const { RAIZ, carregar, reqFalso, resFalso } = require('./helpers/ambiente');
const { bancoAcesso } = require('./helpers/bancoAcesso');

const VIEWS = path.join(RAIZ, 'src/views');
const render = (v, dados) => ejs.renderFile(path.join(VIEWS, v), dados);
const HORA = 3600000;

const ENV_OK = {
  APP_DOMAIN: 'cortavo.com.br',
  EMAIL_SMTP_HOST: 'smtp.exemplo.test', EMAIL_SMTP_PORTA: '465', EMAIL_SMTP_USUARIO: 'conta@exemplo.test',
  EMAIL_SMTP_SENHA: 'segredo-de-teste', EMAIL_REMETENTE: 'cortavo.app@gmail.com', EMAIL_REMETENTE_NOME: 'Cortavo',
  EMAIL_ENVIO_DESLIGADO: '', EMAIL_LIMITE_DIA: '',
};
// Troca as variáveis de e-mail do processo durante um teste (e devolve depois).
function comEnv(env, t) {
  const nomes = Object.keys(ENV_OK);
  const antes = Object.fromEntries(nomes.map((n) => [n, process.env[n]]));
  for (const n of nomes) { if (env[n] === undefined) delete process.env[n]; else process.env[n] = env[n]; }
  t.after(() => { for (const n of nomes) { if (antes[n] === undefined) delete process.env[n]; else process.env[n] = antes[n]; } });
}

// Captura o console.log de um trecho (para provar que o link não vai ao log).
async function capturarLog(fn) {
  const linhas = [];
  const orig = console.log;
  console.log = (...a) => linhas.push(a.map(String).join(' '));
  try { return { r: await fn(), log: linhas.join('\n') }; } finally { console.log = orig; }
}

function res2() {
  const r = resFalso();
  r.headers = {};
  r.set = function (k, v) { this.headers[k] = v; return this; };
  return r;
}

const BARB = { id: 7, nome: 'Barbearia do Zé', slug: 'ze', ativo: true };
const pessoa = (extra = {}) => ({ id: 10, barbeariaId: 7, nome: 'José da Silva', email: 'ze@exemplo.test', papel: 'admin', ativo: true, senhaHash: bcrypt.hashSync('senha-antiga-1', 4), senhaProvisoria: false, senhaDefinidaEm: null, criadoEm: new Date('2026-10-01T12:00:00Z'), ...extra });

// Monta o mundo: banco em memória + módulos com o mesmo banco + e-mail falso.
function mundo({ usuarios = [pessoa()], barbearias = [{ ...BARB }], tokens = [], falhaSmtp = false } = {}) {
  // APP_DOMAIN liga o modo produção em config/paths.js: some só enquanto os
  // módulos carregam (o link lê a variável na hora do envio).
  const dominio = process.env.APP_DOMAIN;
  delete process.env.APP_DOMAIN;
  try { return montarMundo({ usuarios, barbearias, tokens, falhaSmtp }); } finally { if (dominio !== undefined) process.env.APP_DOMAIN = dominio; }
}
function montarMundo({ usuarios, barbearias, tokens, falhaSmtp }) {
  const banco = bancoAcesso({ usuarios, barbearias, tokens });
  let seqB = 100;
  banco.prisma.barbearia.create = async ({ data }) => { const b = { id: ++seqB, ativo: true, ...data }; barbearias.push(b); return { ...b }; };
  banco.prisma.barbearia.count = async () => 0;
  banco.prisma.configuracao = { upsert: async () => ({}), findMany: async () => [] };
  const auth = carregar('src/controllers/authController.js', { prisma: banco.prisma });
  // Mesma instância dos serviços que o controller carregou (cache do require).
  const email = require(path.join(RAIZ, 'src/services/email.js'));
  const tokens2 = require(path.join(RAIZ, 'src/services/tokensAcesso.js'));
  const acesso = require(path.join(RAIZ, 'src/services/acessoLink.js'));
  const mestre = require(path.join(RAIZ, 'src/controllers/mestreController.js'));
  const enviados = [];
  email.usarTransporte({ sendMail: async (m) => { if (falhaSmtp) { const e = new Error('Invalid login'); e.code = 'EAUTH'; throw e; } enviados.push(m); return {}; } });
  return { banco, auth, mestre, email, tokens: tokens2, acesso, enviados };
}
const tokenDoEmail = (m) => /criar-senha\?t=([A-Za-z0-9_-]+)/.exec(m.text)[1];
const reqKalany = (extra = {}) => reqFalso({ session: { usuario: { id: 1, nome: 'Kalany', papel: 'dono', barbeariaId: null } }, ...extra });

// Abre o link (GET com ?t) e devolve a sessão com o hash guardado.
async function abrirLink(m, token, session = {}) {
  const req = reqFalso({ query: { t: token }, session });
  const res = res2();
  await m.auth.mostrarCriarSenha(req, res);
  return { req, res };
}

// ---------------- C1 / C2 / C3 / C15: criar barbearia no mestre ----------------
test('C1 criar barbearia: sem senha no formulário, dono com senha desconhecida e e-mail 6.1 enviado', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ usuarios: [] });
  const req = reqKalany({ body: { nome: 'Nova Casa', slug: 'nova', adminNome: 'Ana Souza', adminEmail: 'Ana@Exemplo.test', plano: 'barbearia' } });
  const res = res2();
  const { log } = await capturarLog(() => m.mestre.criarBarbearia(req, res));
  assert.match(res.redirecionou, /^\/mestre\/barbearias\/\d+$/);
  const dono = m.banco.usuarios[0];
  assert.equal(dono.email, 'ana@exemplo.test');
  assert.equal(dono.senhaDefinidaEm, null);
  assert.equal(dono.papel, 'admin');
  assert.ok(dono.senhaHash.startsWith('$2'), 'bcrypt de um valor aleatório que ninguém conhece');
  assert.equal(m.enviados.length, 1);
  const e = m.enviados[0];
  assert.equal(e.to, 'ana@exemplo.test');
  assert.deepEqual(e.from, { name: 'Cortavo', address: 'cortavo.app@gmail.com' });
  assert.equal(e.subject, 'Crie sua senha de acesso à Cortavo');
  assert.match(e.text, /A conta da Nova Casa na Cortavo foi criada/);
  assert.equal(m.banco.tokens[0].tipo, 'primeiro_acesso');
  assert.ok(m.banco.tokens[0].enviadoEm);
  assert.equal(req.session.flash.tipo, 'sucesso');
  assert.match(req.session.flash.texto, /Enviamos um e-mail para ana@exemplo\.test criar a senha/);
  // C2/C15: nenhum flash, log ou auditoria com o token ou o link.
  const token = tokenDoEmail(e);
  const tudo = [log, JSON.stringify(req.session.flash), JSON.stringify(m.banco.logs), JSON.stringify(m.banco.tokens)].join('\n');
  assert.ok(!tudo.includes(token), 'token não aparece em lugar nenhum');
  assert.ok(!tudo.includes('criar-senha?t='), 'link não aparece em lugar nenhum');
  assert.ok(m.banco.logs.some((l) => l.acao === 'acesso.link_enviado'));
});

test('C3 o link do e-mail usa APP_DOMAIN, nunca o Host do pedido (Host forjado)', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ usuarios: [] });
  const req = reqKalany({ hostname: 'site-do-atacante.test', headers: { host: 'site-do-atacante.test', 'x-forwarded-host': 'site-do-atacante.test' }, body: { nome: 'Casa', slug: 'casa', adminNome: 'Ana', adminEmail: 'ana@exemplo.test', plano: 'barbearia' } });
  await m.mestre.criarBarbearia(req, res2());
  assert.match(m.enviados[0].text, /https:\/\/cortavo\.com\.br\/criar-senha\?t=[A-Za-z0-9_-]{43}\b/);
  assert.ok(!m.enviados[0].text.includes('atacante'));
  assert.ok(!m.enviados[0].html.includes('atacante'));
  assert.equal(m.acesso.baseDoLink({ APP_DOMAIN: '' , PORT: '3000' }), 'http://localhost:3000');
  assert.equal(m.acesso.baseDoLink({ APP_DOMAIN: 'https://cortavo.com.br/' }), 'https://cortavo.com.br');
});

test('C2 telas e rotas do mestre sem senha: sem campo de senha e sem "Resetar senha"', async () => {
  const pc = carregar('src/services/planoCortavo.js');
  const nova = await render('mestre/barbearia-nova.ejs', { valores: null, erro: null, planos: pc.planosParaSeletor() });
  assert.doesNotMatch(nova, /adminSenha|type="password"|name="senha"/);
  assert.match(nova, /O dono recebe um e-mail para criar a própria senha\. Confira o e-mail antes de salvar\./);
  const det = fs.readFileSync(path.join(VIEWS, 'mestre/barbearia-detalhe.ejs'), 'utf8');
  assert.doesNotMatch(det, /reset-senha|Resetar senha|name="senha"/);
  assert.match(det, /\/enviar-link"/);
  const edt = fs.readFileSync(path.join(VIEWS, 'mestre/barbeiro-editar.ejs'), 'utf8');
  assert.doesNotMatch(edt, /name="senha"/);
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/mestre.js'), 'utf8');
  assert.doesNotMatch(rotas, /reset-senha/);
  const ctrl = fs.readFileSync(path.join(RAIZ, 'src/controllers/mestreController.js'), 'utf8');
  assert.doesNotMatch(ctrl, /gerarSenhaProvisoria|Senha provisória de/);
});

test('C1 adicionar pessoa pelo mestre: sem senha, e-mail de primeiro acesso', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ usuarios: [] });
  const req = reqKalany({ params: { id: '7' }, body: { nome: 'Beto', email: 'beto@exemplo.test', papel: 'funcionario' } });
  await m.mestre.criarBarbeiro(req, res2());
  assert.equal(m.banco.usuarios[0].senhaDefinidaEm, null);
  assert.equal(m.enviados[0].to, 'beto@exemplo.test');
  assert.match(req.session.flash.texto, /Beto adicionado à equipe\. Enviamos um e-mail/);
});

// ---------------- C4 / C5: abrir o link ----------------
test('C4 abrir o link (GET) não consome: guarda o hash na sessão, limpa a URL e funciona duas vezes', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo();
  const { token } = await m.tokens.gerar(10, 'primeiro_acesso', 1);
  const a = await abrirLink(m, token);
  assert.equal(a.res.redirecionou, '/criar-senha', 'redireciona para a URL limpa (token sai do histórico)');
  assert.equal(a.res.headers['Cache-Control'], 'no-store');
  assert.equal(a.req.session.acessoLink.hash, m.tokens.hashToken(token));
  assert.ok(!JSON.stringify(a.req.session).includes(token), 'a sessão guarda o hash, não o token');
  const b = await abrirLink(m, token);
  assert.equal(b.res.redirecionou, '/criar-senha');
  assert.equal(m.banco.tokens[0].usadoEm, null);
  // Formulário (GET sem ?t) com e-mail e barbearia.
  const res = res2();
  await m.auth.mostrarCriarSenha(reqFalso({ session: { acessoLink: b.req.session.acessoLink } }), res);
  assert.equal(res.renderizou.view, 'auth/criar-senha');
  assert.equal(res.renderizou.dados.email, 'ze@exemplo.test');
  assert.equal(res.renderizou.dados.nomeBarbearia, 'Barbearia do Zé');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('C5 link usado, revogado, vencido, de pessoa inativa ou inventado: a MESMA tela "Este link não vale mais"', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ usuarios: [pessoa(), pessoa({ id: 11, email: 'inativo@exemplo.test', ativo: false })] });
  const telas = [];
  const ver = async (token) => { const { res } = await abrirLink(m, token); telas.push(JSON.stringify({ s: res.statusCode, v: res.renderizou && res.renderizou.view, d: res.renderizou && res.renderizou.dados })); };

  const velho = await m.tokens.gerar(10, 'primeiro_acesso', 1);
  const novo = await m.tokens.gerar(10, 'primeiro_acesso', 1); // revoga o velho
  await ver(velho.token); // revogado
  const vencido = await m.tokens.gerar(10, 'redefinir', 1, { agora: new Date(Date.now() - 2 * HORA) });
  await ver(vencido.token); // vencido (1 h)
  const venc72 = await m.tokens.gerar(10, 'primeiro_acesso', 1, { agora: new Date(Date.now() - 73 * HORA) });
  await ver(venc72.token); // vencido (72 h)
  const inativo = await m.tokens.gerar(11, 'primeiro_acesso', 1);
  await ver(inativo.token); // pessoa inativa
  await ver('A'.repeat(43)); // inventado
  await ver('x'); // formato errado
  // Usado: cria a senha e tenta de novo.
  const usado = await m.tokens.gerar(10, 'primeiro_acesso', 1);
  await m.tokens.consumirHash(m.tokens.hashToken(usado.token), 'h');
  await ver(usado.token);
  assert.equal(new Set(telas).size, 1, 'todas as recusas são idênticas');
  const d = JSON.parse(telas[0]);
  assert.equal(d.v, 'auth/link-invalido');
  assert.equal(d.s, 410);
  const html = await render('auth/link-invalido.ejs', d.d);
  assert.match(html, /Este link não vale mais/);
  assert.match(html, /Ele pode ter vencido ou já ter sido usado\./);
  assert.match(html, /cortavo\.app@gmail\.com/);
  assert.match(html, /Pedir novo link/);
  assert.match(html, /Ir para o login/);
  assert.ok(novo);
});

// ---------------- C6 / C8 / C9 / C10: criar a senha ----------------
test('C8 regras da senha: mínimo 8, máximo 72 bytes, confirmação igual (erro anunciado no formulário)', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo();
  const { token } = await m.tokens.gerar(10, 'primeiro_acesso', 1);
  const { req: r0 } = await abrirLink(m, token);
  const tentar = async (senha, confirmar) => {
    const res = res2();
    await m.auth.criarSenha(reqFalso({ session: { acessoLink: r0.session.acessoLink }, body: { senha, confirmar } }), res);
    return res;
  };
  let r = await tentar('1234567', '1234567');
  assert.equal(r.statusCode, 422);
  assert.equal(r.renderizou.dados.erro, 'A senha precisa ter ao menos 8 caracteres.');
  r = await tentar('é'.repeat(37), 'é'.repeat(37)); // 37 caracteres, 74 bytes
  assert.equal(r.renderizou.dados.erro, 'Use no máximo 72 caracteres.');
  r = await tentar('senha-boa-1', 'senha-boa-2');
  assert.equal(r.renderizou.dados.erro, 'As duas senhas não são iguais.');
  assert.equal(m.banco.tokens[0].usadoEm, null, 'erro de validação não gasta o link');
  const html = await render('auth/criar-senha.ejs', r.renderizou.dados);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-invalid="true"/);
});

test('C8/C9 criar a senha: bcrypt, provisória falsa, senhaDefinidaEm, sessão regenerada e /painel com boas-vindas', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ usuarios: [pessoa({ senhaProvisoria: true })] });
  const { token } = await m.tokens.gerar(10, 'primeiro_acesso', 1);
  const { req: r0 } = await abrirLink(m, token);
  let regenerou = 0;
  const req = reqFalso({ session: { acessoLink: r0.session.acessoLink }, body: { senha: 'minha-senha-nova', confirmar: 'minha-senha-nova' } });
  const regen = req.session.regenerate;
  req.session.regenerate = function (cb) { regenerou++; return regen.call(this, cb); };
  const res = res2();
  await m.auth.criarSenha(req, res);
  assert.equal(res.redirecionou, '/painel');
  assert.equal(regenerou, 1, 'anti session-fixation');
  assert.deepEqual(req.session.usuario, { id: 10, nome: 'José da Silva', papel: 'admin', barbeariaId: 7 });
  assert.equal(req.session.trocarSenha, false);
  assert.equal(req.session.cookie.maxAge, undefined, 'sem "manter conectado" (padrão de 8 h)');
  assert.equal(req.session.flash.texto, 'Senha criada. Bem-vindo à Cortavo.');
  assert.equal(req.session.acessoLink, undefined);
  const u = m.banco.usuarios[0];
  assert.ok(await bcrypt.compare('minha-senha-nova', u.senhaHash));
  assert.equal(u.senhaProvisoria, false);
  assert.ok(u.senhaDefinidaEm instanceof Date);
  assert.equal(req.session.senhaVersao, u.senhaDefinidaEm.getTime());
  assert.ok(m.banco.logs.some((l) => l.acao === 'acesso.senha_criada' && !l.detalhe.includes(token)));
});

test('C9 barbearia pausada: senha criada, mas tela de pausa e NENHUMA sessão', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ barbearias: [{ ...BARB, ativo: false }] });
  const { token } = await m.tokens.gerar(10, 'primeiro_acesso', 1);
  const { req: r0 } = await abrirLink(m, token);
  const req = reqFalso({ session: { acessoLink: r0.session.acessoLink }, body: { senha: 'minha-senha-nova', confirmar: 'minha-senha-nova' } });
  const res = res2();
  await m.auth.criarSenha(req, res);
  assert.equal(res.renderizou.view, 'auth/acesso-pausado');
  assert.equal(req.session.usuario, undefined);
});

test('C6 dois POST simultâneos com o mesmo link: só um grava a senha', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo();
  const { token } = await m.tokens.gerar(10, 'primeiro_acesso', 1);
  const { req: r0 } = await abrirLink(m, token);
  const mk = (senha) => ({ req: reqFalso({ session: { acessoLink: { ...r0.session.acessoLink } }, body: { senha, confirmar: senha } }), res: res2() });
  const a = mk('senha-do-primeiro');
  const b = mk('senha-do-segundo');
  await Promise.all([m.auth.criarSenha(a.req, a.res), m.auth.criarSenha(b.req, b.res)]);
  const venceu = [a, b].filter((x) => x.res.redirecionou === '/painel');
  const perdeu = [a, b].filter((x) => x.res.renderizou && x.res.renderizou.view === 'auth/link-invalido');
  assert.equal(venceu.length, 1);
  assert.equal(perdeu.length, 1);
  assert.equal(perdeu[0].req.session.usuario, undefined);
});

test('C10 login com a senha nova funciona; a senha de antes do link deixa de funcionar', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ usuarios: [pessoa({ senhaDefinidaEm: new Date('2026-10-01T12:00:00Z') })] });
  const { token } = await m.tokens.gerar(10, 'redefinir', 1);
  const { req: r0 } = await abrirLink(m, token);
  // Enquanto o link não é usado, a senha atual continua valendo.
  let res = res2();
  let req = reqFalso({ body: { email: 'ze@exemplo.test', senha: 'senha-antiga-1' } });
  await m.auth.fazerLogin(req, res);
  assert.equal(res.redirecionou, '/painel');
  await m.auth.criarSenha(reqFalso({ session: { acessoLink: r0.session.acessoLink }, body: { senha: 'senha-nova-123', confirmar: 'senha-nova-123' } }), res2());
  res = res2();
  req = reqFalso({ body: { email: 'ze@exemplo.test', senha: 'senha-antiga-1' } });
  await m.auth.fazerLogin(req, res);
  assert.equal(res.redirecionou, '/login');
  assert.equal(req.session.flash.texto, 'E-mail ou senha inválidos.');
  res = res2();
  req = reqFalso({ body: { email: 'ze@exemplo.test', senha: 'senha-nova-123' } });
  await m.auth.fazerLogin(req, res);
  assert.equal(res.redirecionou, '/painel');
  assert.equal(req.session.usuario.id, 10);
});

// ---------------- C7 / C11 / C12 / C13 / C15: mestre ----------------
test('C7 reenviar revoga o link anterior; só o último funciona. Trocar o e-mail revoga os abertos', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo();
  const { token: primeiro } = await m.tokens.gerar(10, 'primeiro_acesso', 1, { agora: new Date(Date.now() - 5 * 60000) });
  const req = reqKalany({ params: { id: '7', uid: '10' } });
  await m.mestre.enviarLinkMembro(req, res2());
  assert.equal(req.session.flash.tipo, 'sucesso');
  assert.equal(m.enviados.length, 1);
  const segundo = tokenDoEmail(m.enviados[0]);
  assert.equal(await m.tokens.validar(primeiro), null);
  assert.ok(await m.tokens.validar(segundo));
  assert.ok(m.banco.logs.some((l) => l.acao === 'acesso.link_reenviado'));
  // Troca de e-mail no mestre.
  const reqE = reqKalany({ params: { id: '7', uid: '10' }, body: { nome: 'José da Silva', email: 'jose.novo@exemplo.test', papel: 'admin' } });
  m.banco.prisma.usuario.findFirst = async ({ where }) => {
    const u = m.banco.usuarios.find((x) => x.id === where.id && x.barbeariaId === where.barbeariaId);
    if (where.NOT) return m.banco.usuarios.find((x) => x.email === where.email && x.id !== where.NOT.id) || null;
    return u ? { ...u } : null;
  };
  await m.mestre.atualizarBarbeiro(reqE, res2());
  assert.equal(await m.tokens.validar(segundo), null, 'link do e-mail antigo morreu');
  assert.match(reqE.session.flash.texto, /o link anterior deixou de valer/);
});

test('C11 estado do acesso de cada pessoa no mestre: aguardando, vencido, não enviado, senha criada', async () => {
  const tk = carregar('src/services/tokensAcesso.js');
  const agora = new Date('2026-10-09T17:32:00Z'); // 14:32 em Brasília
  const enviado = { usadoEm: null, revogadoEm: null, enviadoEm: agora, expiraEm: new Date(agora.getTime() + 72 * HORA) };
  let e = tk.estadoDoAcesso({ senhaDefinidaEm: null }, enviado, agora);
  assert.equal(e.codigo, 'aguardando');
  assert.equal(e.texto, 'Aguardando criar a senha · enviado em 09/10 14:32 · vence em 12/10 14:32');
  assert.equal(e.botao, 'Reenviar link');
  e = tk.estadoDoAcesso({ senhaDefinidaEm: null }, enviado, new Date(agora.getTime() + 73 * HORA));
  assert.equal(e.codigo, 'vencido');
  assert.equal(e.texto, 'Link vencido em 12/10');
  assert.equal(e.botao, 'Reenviar link');
  e = tk.estadoDoAcesso({ senhaDefinidaEm: null }, { ...enviado, enviadoEm: null, erroEnvio: 'e-mail não configurado' }, agora);
  assert.equal(e.codigo, 'nao_enviado');
  assert.equal(e.texto, 'E-mail não enviado');
  assert.equal(e.botao, 'Reenviar link');
  e = tk.estadoDoAcesso({ senhaDefinidaEm: new Date('2026-10-09T18:01:00Z') }, { ...enviado, usadoEm: agora }, agora);
  assert.equal(e.codigo, 'senha_criada');
  assert.equal(e.texto, 'Senha criada em 09/10');
  assert.equal(e.botao, 'Enviar link para nova senha');
});

test('C11 detalhe da barbearia mostra o estado e o botão certo de cada pessoa', async (t) => {
  comEnv({ ...ENV_OK, EMAIL_SMTP_SENHA: undefined }, t);
  const m = mundo({ usuarios: [pessoa(), pessoa({ id: 11, nome: "D'Ávila", email: 'd@exemplo.test', papel: 'funcionario', senhaDefinidaEm: new Date('2026-10-01T12:00:00Z') })] });
  await m.acesso.enviarLink({ usuario: m.banco.usuarios[0], barbearia: BARB, tipo: 'primeiro_acesso', criadoPorId: 1, req: {} });
  m.banco.prisma.usuario.findMany = async () => m.banco.usuarios.map((u) => ({ ...u }));
  const res = res2();
  await m.mestre.detalhe(reqKalany({ params: { id: '7' } }), res);
  const d = res.renderizou.dados;
  assert.equal(d.acessos[10].texto, 'E-mail não enviado');
  assert.equal(d.acessos[11].botao, 'Enviar link para nova senha');
  assert.match(d.avisoEmail, /Envio de e-mail não configurado/);
  // A tabela mostra o estado e o botão (o nome com apóstrofo não quebra o JS da confirmação).
  const det = fs.readFileSync(path.join(VIEWS, 'mestre/barbearia-detalhe.ejs'), 'utf8');
  const ini = det.indexOf('<!-- Equipe -->');
  const fim = det.indexOf('<h3 class="mt-16">Adicionar barbeiro</h3>');
  const trecho = det.slice(ini, fim);
  const html = ejs.render(trecho, { ...d });
  assert.match(html, /data-acesso="nao_enviado">E-mail não enviado/);
  assert.match(html, />Reenviar link</);
  assert.match(html, />Enviar link para nova senha</);
  assert.match(html, /Senha criada em 01\/10/);
  assert.match(html, /data-nome="D&#39;Ávila"/);
  assert.match(html, /role="status">Envio de e-mail não configurado/);
});

test('C12 reenvio pelo mestre: 1 a cada 60 s e no máximo 5 por dia por pessoa (contado na tabela)', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo();
  const req1 = reqKalany({ params: { id: '7', uid: '10' } });
  await m.mestre.enviarLinkMembro(req1, res2());
  assert.equal(req1.session.flash.tipo, 'sucesso');
  const req2 = reqKalany({ params: { id: '7', uid: '10' } });
  await m.mestre.enviarLinkMembro(req2, res2());
  assert.equal(req2.session.flash.texto, 'Aguarde um minuto antes de reenviar.');
  assert.equal(m.enviados.length, 1);
  // 5 por dia (relógio fixo: 15:00 em Brasília).
  const agora = new Date('2026-10-12T18:00:00Z');
  const tokens = [1, 2, 3, 4, 5].map((i) => ({ id: 100 + i, usuarioId: 10, tokenHash: 'h' + i, criadoPorId: 1, criadoEm: new Date(agora.getTime() - i * 10 * 60000), expiraEm: agora, revogadoEm: agora }));
  const m2 = mundo({ tokens });
  assert.equal(await m2.acesso.limiteReenvio(10, agora), 'Limite de reenvios de hoje atingido.');
  tokens.pop();
  assert.equal(await m2.acesso.limiteReenvio(10, agora), null);
  // Pedidos do "esqueci" (criadoPorId nulo) não travam a Kalany.
  tokens.push({ id: 200, usuarioId: 10, tokenHash: 'e1', criadoPorId: null, criadoEm: new Date(agora.getTime() - 1000), expiraEm: agora });
  assert.equal(await m2.acesso.limiteReenvio(10, agora), null);
  // Ontem não conta.
  assert.equal(await m2.acesso.limiteReenvio(10, new Date('2026-10-13T03:30:00Z')), null);
});

test('C12 teto diário EMAIL_LIMITE_DIA: para de enviar e avisa', async (t) => {
  comEnv({ ...ENV_OK, EMAIL_LIMITE_DIA: '2' }, t);
  const agora = new Date();
  const tokens = [1, 2].map((i) => ({ id: i, usuarioId: 99, tokenHash: 'x' + i, enviadoEm: agora, criadoEm: agora, expiraEm: agora }));
  const m = mundo({ tokens });
  const r = await m.acesso.enviarLink({ usuario: m.banco.usuarios[0], barbearia: BARB, tipo: 'primeiro_acesso', criadoPorId: 1, req: {}, agora });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'limite_dia');
  assert.equal(m.enviados.length, 0);
  assert.equal(m.banco.tokens.at(-1).erroEnvio, 'limite diário de envios atingido');
});

// Limites por IP (express-rate-limit de verdade, num mini servidor só com o
// limite e uma resposta fixa: NÃO é o app, não há sessão, banco nem .env).
async function bater(middleware, vezes, metodo = 'GET') {
  const express = require('express');
  const app = express();
  app.set('views', VIEWS);
  app.set('view engine', 'ejs');
  app.use((req, res, next) => { req.session = {}; res.render = (v) => res.status(res.statusCode).type('text').send('render:' + v); next(); });
  app.all('/x', middleware, (req, res) => res.send('ok'));
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const porta = srv.address().port;
  const respostas = [];
  try {
    for (let i = 0; i < vezes; i++) {
      respostas.push(await new Promise((ok, erro) => {
        const r = http.request({ host: '127.0.0.1', port: porta, path: '/x', method: metodo }, (rr) => {
          let corpo = '';
          rr.on('data', (c) => { corpo += c; });
          rr.on('end', () => ok({ status: rr.statusCode, corpo, local: rr.headers.location }));
        });
        r.on('error', erro);
        r.end();
      }));
    }
  } finally { srv.close(); }
  return respostas;
}

test('C12 limites por IP: GET /criar-senha 30/15 min, POST 10/15 min, "esqueci" 5/15 min', async () => {
  const rl = carregar('src/middlewares/rateLimit.js');
  let r = await bater(rl.criarLimiteCriarSenhaGet(), 31);
  assert.equal(r.filter((x) => x.corpo === 'ok').length, 30);
  assert.equal(r[30].status, 429);
  assert.equal(r[30].corpo, 'render:auth/link-invalido');
  r = await bater(rl.criarLimiteCriarSenhaPost(), 11, 'POST');
  assert.equal(r.filter((x) => x.corpo === 'ok').length, 10);
  assert.equal(r[10].local, '/criar-senha');
  r = await bater(rl.criarLimiteEsqueci(), 6, 'POST');
  assert.equal(r.filter((x) => x.corpo === 'ok').length, 5);
  assert.equal(r[5].corpo, 'render:auth/esqueci-senha', 'mesma tela de sempre');
  const rotas = fs.readFileSync(path.join(RAIZ, 'src/routes/auth.js'), 'utf8');
  assert.match(rotas, /router\.get\('\/criar-senha', limiteCriarSenhaGet,/);
  assert.match(rotas, /router\.post\('\/criar-senha', limiteCriarSenhaPost,/);
  assert.match(rotas, /router\.post\('\/esqueci-senha', limiteEsqueci,/);
});

test('C13 falha no envio (não configurado ou SMTP recusando): barbearia criada, sem 500, "E-mail não enviado"', async (t) => {
  for (const caso of [{ env: { ...ENV_OK, EMAIL_SMTP_HOST: undefined }, motivo: 'e-mail não configurado' }, { env: ENV_OK, falhaSmtp: true, motivo: 'falha no servidor de e-mail' }]) {
    comEnv(caso.env, t);
    const m = mundo({ usuarios: [], falhaSmtp: caso.falhaSmtp });
    const req = reqKalany({ body: { nome: 'Casa', slug: 'casa', adminNome: 'Ana', adminEmail: 'ana@exemplo.test', plano: 'barbearia' } });
    const res = res2();
    await capturarLog(() => m.mestre.criarBarbearia(req, res));
    assert.match(res.redirecionou, /^\/mestre\/barbearias\/\d+$/);
    assert.equal(m.banco.barbearias.length, 2, 'barbearia criada');
    assert.equal(req.session.flash.tipo, 'aviso');
    assert.match(req.session.flash.texto, new RegExp(`E-mail não enviado \\(${caso.motivo}\\)`));
    assert.equal(m.banco.tokens[0].enviadoEm, null);
    assert.equal(m.banco.tokens[0].erroEnvio, caso.motivo);
    assert.ok(m.banco.logs.some((l) => l.acao === 'acesso.envio_falhou'));
  }
});

test('C14 EMAIL_ENVIO_DESLIGADO=1: nada sai, o log não tem o link e o mestre mostra "E-mail não enviado"', async (t) => {
  comEnv({ ...ENV_OK, EMAIL_ENVIO_DESLIGADO: '1' }, t);
  const m = mundo({ usuarios: [] });
  const req = reqKalany({ body: { nome: 'Casa', slug: 'casa', adminNome: 'Ana', adminEmail: 'ana@exemplo.test', plano: 'barbearia' } });
  const { log } = await capturarLog(() => m.mestre.criarBarbearia(req, res2()));
  assert.equal(m.enviados.length, 0);
  assert.match(log, /envio simulado/);
  assert.doesNotMatch(log, /criar-senha|\?t=/);
  assert.match(req.session.flash.texto, /E-mail não enviado \(envio desligado\)/);
  assert.equal(m.tokens.estadoDoAcesso(m.banco.usuarios[0], m.banco.tokens[0]).codigo, 'nao_enviado');
});

test('C15 auditoria: link_enviado, link_reenviado, senha_criada e envio_falhou, nunca com token', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo();
  await m.acesso.enviarLink({ usuario: m.banco.usuarios[0], barbearia: BARB, tipo: 'primeiro_acesso', criadoPorId: 1, req: {}, agora: new Date(Date.now() - 5 * 60000) });
  await m.mestre.enviarLinkMembro(reqKalany({ params: { id: '7', uid: '10' } }), res2());
  const token = tokenDoEmail(m.enviados[1]);
  const { req: r0 } = await abrirLink(m, token);
  await m.auth.criarSenha(reqFalso({ session: { acessoLink: r0.session.acessoLink }, body: { senha: 'senha-nova-123', confirmar: 'senha-nova-123' } }), res2());
  process.env.EMAIL_SMTP_HOST = '';
  await capturarLog(() => m.acesso.enviarLink({ usuario: m.banco.usuarios[0], barbearia: BARB, tipo: 'redefinir', criadoPorId: 1, req: {} }));
  const acoes = m.banco.logs.map((l) => l.acao);
  for (const a of ['acesso.link_enviado', 'acesso.link_reenviado', 'acesso.senha_criada', 'acesso.envio_falhou']) assert.ok(acoes.includes(a), a);
  const tudo = JSON.stringify(m.banco.logs);
  for (const e of m.enviados) assert.ok(!tudo.includes(tokenDoEmail(e)));
  assert.doesNotMatch(tudo, /criar-senha\?t=|[0-9a-f]{64}/);
});

// ---------------- F5: Esqueci minha senha ----------------
test('F5 "Esqueci minha senha": resposta sempre igual; só quem tem acesso recebe o e-mail 6.2 (1 h)', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ usuarios: [pessoa({ senhaDefinidaEm: new Date('2026-10-01T12:00:00Z') }), { id: 1, barbeariaId: null, nome: 'Kalany', email: 'dona@exemplo.test', papel: 'dono', ativo: true, senhaHash: 'x' }] });
  const pedir = async (email) => {
    const res = res2();
    m.auth.pedirLinkEsqueci(reqFalso({ body: { email } }), res);
    await res.locals.tarefaEsqueci;
    return res;
  };
  const a = await pedir('ze@exemplo.test');
  const b = await pedir('ninguem@exemplo.test');
  const c = await pedir('dona@exemplo.test');
  const d = await pedir('nao é email');
  for (const r of [a, b, c, d]) {
    assert.deepEqual({ v: r.renderizou.view, d: r.renderizou.dados, s: r.statusCode }, { v: a.renderizou.view, d: a.renderizou.dados, s: a.statusCode });
  }
  const html = await render('auth/esqueci-senha.ejs', a.renderizou.dados);
  assert.match(html, /Se esse e-mail tiver acesso, enviamos um link\./);
  assert.equal(m.enviados.length, 1, 'só a conta da barbearia (o papel dono fica de fora)');
  assert.equal(m.enviados[0].to, 'ze@exemplo.test');
  assert.equal(m.enviados[0].subject, 'Link para criar uma nova senha na Cortavo');
  const tk = m.banco.tokens[0];
  assert.equal(tk.tipo, 'redefinir');
  assert.equal(tk.criadoPorId, null);
  assert.equal(tk.expiraEm.getTime() - tk.criadoEm.getTime(), HORA);
});

test('F5 "esqueci": no máximo 3 por hora por e-mail', async (t) => {
  comEnv(ENV_OK, t);
  const m = mundo({ usuarios: [pessoa({ senhaDefinidaEm: new Date('2026-10-01T12:00:00Z') })] });
  for (let i = 0; i < 5; i++) {
    const res = res2();
    m.auth.pedirLinkEsqueci(reqFalso({ body: { email: 'ZE@exemplo.test ' } }), res);
    await res.locals.tarefaEsqueci;
  }
  assert.equal(m.enviados.length, 3);
});

test('F5 a tela de login tem "Esqueci minha senha" e a de link inválido oferece "Pedir novo link"', () => {
  const login = fs.readFileSync(path.join(VIEWS, 'auth/login.ejs'), 'utf8');
  assert.match(login, /href="\/esqueci-senha"[^>]*>Esqueci minha senha</);
  const inv = fs.readFileSync(path.join(VIEWS, 'auth/link-invalido.ejs'), 'utf8');
  assert.match(inv, /href="\/esqueci-senha"[^>]*>Pedir novo link/);
});

// ---------------- F6: sessões derrubadas quando a senha muda ----------------
function sessaoCom(usuarios) {
  const banco = bancoAcesso({ usuarios });
  return { banco, mw: carregar('src/middlewares/sessaoValida.js', { prisma: banco.prisma }).sessaoValida };
}
async function passar(mw, session) {
  const req = reqFalso({ session });
  const res = res2();
  let seguiu = false;
  await mw(req, res, () => { seguiu = true; });
  return { req, res, seguiu };
}

test('F6 senha trocada depois do login: a sessão antiga cai; a mesma versão segue', async () => {
  const quando = new Date('2026-10-05T12:00:00Z');
  const { banco, mw } = sessaoCom([pessoa({ senhaDefinidaEm: quando })]);
  let r = await passar(mw, { usuario: { id: 10 }, senhaVersao: quando.getTime() });
  assert.equal(r.seguiu, true);
  banco.usuarios[0].senhaDefinidaEm = new Date('2026-10-09T12:00:00Z');
  r = await passar(mw, { usuario: { id: 10 }, senhaVersao: quando.getTime() });
  assert.equal(r.seguiu, false);
  assert.equal(r.req.session.destruida, true);
  assert.equal(r.res.redirecionou, '/login');
});

test('F6 pessoa desativada cai na hora; sessão antiga (sem versão) adota a atual sem deslogar no deploy', async () => {
  const { banco, mw } = sessaoCom([pessoa({ senhaDefinidaEm: new Date('2026-10-05T12:00:00Z') })]);
  let r = await passar(mw, { usuario: { id: 10 } });
  assert.equal(r.seguiu, true);
  assert.equal(r.req.session.senhaVersao, new Date('2026-10-05T12:00:00Z').getTime());
  banco.usuarios[0].ativo = false;
  r = await passar(mw, { usuario: { id: 10 }, senhaVersao: r.req.session.senhaVersao });
  assert.equal(r.seguiu, false);
  assert.equal(r.res.redirecionou, '/login');
  r = await passar(mw, {});
  assert.equal(r.seguiu, true, 'visitante sem login passa direto');
});

test('F6 troca obrigatória (/trocar-senha) atualiza a versão: esta sessão segue, as outras caem', async () => {
  const banco = bancoAcesso({ usuarios: [pessoa({ senhaProvisoria: true, senhaDefinidaEm: null })] });
  const auth = carregar('src/controllers/authController.js', { prisma: banco.prisma });
  const req = reqFalso({ session: { usuario: { id: 10, papel: 'admin' }, trocarSenha: true, senhaVersao: 0 }, body: { senhaAtual: 'senha-antiga-1', novaSenha: 'outra-senha-9', confirmar: 'outra-senha-9' } });
  await auth.trocarSenha(req, res2());
  const u = banco.usuarios[0];
  assert.ok(u.senhaDefinidaEm instanceof Date);
  assert.equal(req.session.senhaVersao, u.senhaDefinidaEm.getTime());
  const mw = require(path.join(RAIZ, 'src/middlewares/sessaoValida.js')).sessaoValida;
  assert.equal((await passar(mw, { usuario: { id: 10 }, senhaVersao: req.session.senhaVersao })).seguiu, true);
  assert.equal((await passar(mw, { usuario: { id: 10 }, senhaVersao: 0 })).seguiu, false);
  const srv = fs.readFileSync(path.join(RAIZ, 'src/server.js'), 'utf8');
  assert.ok(srv.indexOf("sessaoValida") > srv.indexOf('app.use(resolverBarbearia)'));
  assert.ok(srv.indexOf("sessaoValida") < srv.indexOf("app.use('/', require('./routes/auth'))"));
});

// ---------------- C19: telas novas ----------------
test('C19 tela "Crie sua senha": textos da spec, rótulos, autocomplete, toque ≥ 44 px e sem azul', async () => {
  const html = await render('auth/criar-senha.ejs', { nomeBarbearia: 'Barbearia do <b>Zé</b>', email: 'ze@exemplo.test', erro: null });
  assert.match(html, /<h1 class="cv-ac-titulo">Crie sua senha<\/h1>/);
  assert.match(html, /Para <strong>Barbearia do &lt;b&gt;Zé&lt;\/b&gt;<\/strong> · ze@exemplo\.test/);
  assert.match(html, /<label class="cv-ac-rot" for="senha">Nova senha \(mínimo 8 caracteres\)<\/label>/);
  assert.match(html, /<label class="cv-ac-rot" for="confirmar">Repita a senha<\/label>/);
  assert.match(html, /Criar senha e entrar/);
  assert.equal((html.match(/autocomplete="new-password"/g) || []).length, 2);
  assert.match(html, /type="email" name="usuario" value="ze@exemplo\.test" autocomplete="username" hidden/);
  assert.doesNotMatch(html, /name="t"|\?t=/, 'o token não vai para a página');
  const css = fs.readFileSync(path.join(RAIZ, 'public/css/cv-acesso.css'), 'utf8');
  assert.match(css, /--toque-min: 44px/);
  assert.match(css, /min-height: 52px/);
  assert.match(css, /:focus-visible/);
  for (const hex of css.match(/#[0-9a-fA-F]{6}\b/g)) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(!(b > r && b > g), `sem azul: ${hex}`);
  }
  assert.doesNotMatch(css, /\bblue\b/i);
});
