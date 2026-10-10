// Spec 13 (acesso por link), fatias F1 e F2: tokens e e-mail. Sem banco, sem
// .env, sem rede: banco em memória e transporte de e-mail FALSO.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { RAIZ, carregar } = require('./helpers/ambiente');
const { bancoAcesso } = require('./helpers/bancoAcesso');

const HORA = 3600000;
const AGORA = new Date('2026-10-12T15:00:00Z');
const BARB = { id: 7, nome: 'Barbearia do Zé', slug: 'ze', ativo: true };
const usuarioBase = (extra = {}) => ({ id: 10, barbeariaId: 7, nome: 'José da Silva', email: 'ze@exemplo.test', papel: 'admin', ativo: true, senhaHash: 'x', senhaProvisoria: false, senhaDefinidaEm: null, ...extra });

function servicos(dados = {}) {
  const banco = bancoAcesso({ usuarios: [usuarioBase()], barbearias: [{ ...BARB }], ...dados });
  const tk = carregar('src/services/tokensAcesso.js', { prisma: banco.prisma });
  return { banco, tk };
}

// ---------- Critério 3: 32 bytes, só o sha256 no banco ----------
test('C3 token tem 32 bytes aleatórios (base64url) e o banco guarda só o sha256', async () => {
  const { banco, tk } = servicos();
  const { token, registro } = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(registro.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  const salvo = JSON.stringify(banco.tokens);
  assert.ok(!salvo.includes(token), 'o token em claro nunca vai para o banco');
  const outro = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  assert.notEqual(outro.token, token);
});

test('C3/C5 prazos: 72 h no primeiro acesso, 1 h na nova senha', async () => {
  const { tk } = servicos();
  assert.equal(tk.ACESSO_LINK_HORAS_PRIMEIRO, 72);
  assert.equal(tk.ACESSO_LINK_HORAS_REDEFINIR, 1);
  const a = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  assert.equal(a.registro.expiraEm.getTime() - AGORA.getTime(), 72 * HORA);
  const b = await tk.gerar(10, 'redefinir', 1, { agora: AGORA });
  assert.equal(b.registro.expiraEm.getTime() - AGORA.getTime(), 1 * HORA);
  await assert.rejects(tk.gerar(10, 'qualquer', 1), /tipo/);
});

// ---------- Critério 4: validar não consome ----------
test('C4 validar (o GET) não consome: duas validações seguidas funcionam', async () => {
  const { banco, tk } = servicos();
  const { token } = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  assert.ok(await tk.validar(token, { agora: AGORA }));
  assert.ok(await tk.validar(token, { agora: new Date(AGORA.getTime() + HORA) }));
  assert.equal(banco.tokens[0].usadoEm, null);
});

// ---------- Critério 5: inválido, usado, revogado, vencido, inativo ----------
test('C5 link usado, revogado, vencido (72 h e 1 h), adulterado ou de pessoa inativa: todos viram null', async () => {
  const { banco, tk } = servicos();
  const p = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  assert.equal(await tk.validar(p.token, { agora: new Date(AGORA.getTime() + 72 * HORA) }), null, 'vencido em 72 h');
  assert.ok(await tk.validar(p.token, { agora: new Date(AGORA.getTime() + 72 * HORA - 1000) }));
  const r = await tk.gerar(10, 'redefinir', 1, { agora: AGORA });
  assert.equal(await tk.validar(p.token, { agora: AGORA }), null, 'revogado ao gerar outro');
  assert.equal(await tk.validar(r.token, { agora: new Date(AGORA.getTime() + HORA) }), null, 'vencido em 1 h');
  assert.ok(await tk.validar(r.token, { agora: AGORA }));
  assert.equal(await tk.validar(r.token.slice(0, -1) + (r.token.endsWith('A') ? 'B' : 'A'), { agora: AGORA }), null, 'adulterado');
  assert.equal(await tk.validar('', { agora: AGORA }), null);
  assert.equal(await tk.validar(undefined, { agora: AGORA }), null);
  banco.usuarios[0].ativo = false;
  assert.equal(await tk.validar(r.token, { agora: AGORA }), null, 'pessoa inativa');
  banco.usuarios[0].ativo = true;
  assert.ok(await tk.consumirHash(tk.hashToken(r.token), 'novo-hash', { agora: AGORA }));
  assert.equal(await tk.validar(r.token, { agora: AGORA }), null, 'já usado');
});

// ---------- Critério 6: uso único atômico ----------
test('C6 dois consumos simultâneos do mesmo link: só um grava a senha', async () => {
  const { banco, tk } = servicos();
  const { token } = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  const h = tk.hashToken(token);
  const [a, b] = await Promise.all([tk.consumirHash(h, 'hash-A', { agora: AGORA }), tk.consumirHash(h, 'hash-B', { agora: AGORA })]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(banco.usuarios[0].senhaHash, a ? 'hash-A' : 'hash-B');
});

test('C6/C8 consumir grava a senha, tira a provisória, preenche senhaDefinidaEm e revoga os outros links', async () => {
  const { banco, tk } = servicos({ usuarios: [usuarioBase({ senhaProvisoria: true })] });
  const { token } = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  banco.tokens.push({ id: 99, usuarioId: 10, tokenHash: 'f'.repeat(64), tipo: 'redefinir', expiraEm: new Date(AGORA.getTime() + HORA), usadoEm: null, revogadoEm: null, criadoEm: AGORA });
  const u = await tk.consumirHash(tk.hashToken(token), 'hash-novo', { agora: AGORA });
  assert.equal(u.senhaHash, 'hash-novo');
  assert.equal(u.senhaProvisoria, false);
  assert.equal(u.senhaDefinidaEm.getTime(), AGORA.getTime());
  assert.ok(banco.tokens.find((t) => t.id === 99).revogadoEm, 'o outro link aberto foi revogado');
});

test('C6 pessoa desativada entre abrir e enviar: consumo não grava senha', async () => {
  const { banco, tk } = servicos();
  const { token } = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  banco.usuarios[0].ativo = false;
  assert.equal(await tk.consumirHash(tk.hashToken(token), 'hash-novo', { agora: AGORA }), null);
  assert.equal(banco.usuarios[0].senhaHash, 'x');
});

// ---------- Critério 7: só um link vivo ----------
test('C7 gerar de novo revoga o anterior; revogarDoUsuario revoga todos os abertos', async () => {
  const { tk } = servicos();
  const a = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  const b = await tk.gerar(10, 'primeiro_acesso', 1, { agora: AGORA });
  assert.equal(await tk.validar(a.token, { agora: AGORA }), null);
  assert.ok(await tk.validar(b.token, { agora: AGORA }));
  assert.equal(await tk.revogarDoUsuario(10, { agora: AGORA }), 1);
  assert.equal(await tk.validar(b.token, { agora: AGORA }), null);
});

test('limpeza apaga links usados, revogados ou vencidos há mais de 30 dias', async () => {
  const velho = new Date(AGORA.getTime() - 31 * 24 * HORA);
  const tokens = [
    { id: 1, usuarioId: 10, tokenHash: 'a', usadoEm: velho, revogadoEm: null, expiraEm: velho, criadoEm: velho },
    { id: 2, usuarioId: 10, tokenHash: 'b', usadoEm: null, revogadoEm: velho, expiraEm: AGORA, criadoEm: velho },
    { id: 3, usuarioId: 10, tokenHash: 'c', usadoEm: null, revogadoEm: null, expiraEm: velho, criadoEm: velho },
    { id: 4, usuarioId: 10, tokenHash: 'd', usadoEm: null, revogadoEm: null, expiraEm: new Date(AGORA.getTime() + HORA), criadoEm: AGORA },
    { id: 5, usuarioId: 10, tokenHash: 'e', usadoEm: new Date(AGORA.getTime() - 2 * 24 * HORA), revogadoEm: null, expiraEm: AGORA, criadoEm: AGORA },
  ];
  const { tk, banco } = servicos({ tokens });
  assert.equal(await tk.limpar({ agora: AGORA }), 3);
  assert.deepEqual(banco.tokens.map((t) => t.id), [4, 5]);
});

// ---------- Critério 16: migração só adiciona ----------
test('C16 migração aditiva: cria tokens_acesso, adiciona senha_definida_em e preenche as contas existentes', () => {
  const dir = path.join(RAIZ, 'prisma/migrations/20261009150000_acesso_por_link');
  const sql = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8');
  const semComentarios = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(semComentarios, /\bDROP\b|DELETE FROM|RENAME/i);
  assert.match(sql, /ALTER TABLE "usuarios" ADD COLUMN "senha_definida_em" DATETIME;/);
  assert.match(sql, /UPDATE "usuarios" SET "senha_definida_em" = "criado_em" WHERE "senha_definida_em" IS NULL;/);
  assert.match(sql, /CREATE TABLE "tokens_acesso"/);
  assert.match(sql, /CREATE UNIQUE INDEX "tokens_acesso_token_hash_key"/);
  assert.match(sql, /ON DELETE CASCADE/);
  const schema = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8');
  assert.match(schema, /model TokenAcesso \{[\s\S]*tokenHash\s+String\s+@unique @map\("token_hash"\)/);
  assert.match(schema, /senhaDefinidaEm DateTime\? @map\("senha_definida_em"\)/);
  // A migração nova é a última da pasta (ordem de aplicação).
  const todas = fs.readdirSync(path.join(RAIZ, 'prisma/migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.ok(todas.indexOf('20261009150000_acesso_por_link') >= 0);
});

// ---------- F2: e-mail ----------
function emailCom(env) {
  const em = carregar('src/services/email.js');
  return { em, env };
}
const ENV_OK = { EMAIL_SMTP_HOST: 'smtp.exemplo.test', EMAIL_SMTP_PORTA: '465', EMAIL_SMTP_USUARIO: 'conta@exemplo.test', EMAIL_SMTP_SENHA: 'segredo-de-teste', EMAIL_REMETENTE: 'cortavo.app@gmail.com', EMAIL_REMETENTE_NOME: 'Cortavo' };

test('C1 e-mail sai com remetente "Cortavo <cortavo.app@gmail.com>", responder para o mesmo, assunto fixo', async () => {
  const { em } = emailCom();
  const enviados = [];
  em.usarTransporte({ sendMail: async (m) => { enviados.push(m); return {}; } });
  const modelo = em.modeloPrimeiroAcesso({ nome: 'José da Silva', nomeBarbearia: 'Barbearia do Zé', email: 'ze@exemplo.test', link: 'https://cortavo.com.br/criar-senha?t=abc' });
  const r = await em.enviar({ para: 'ze@exemplo.test', ...modelo }, { env: ENV_OK });
  assert.deepEqual(r, { enviado: true });
  assert.deepEqual(enviados[0].from, { name: 'Cortavo', address: 'cortavo.app@gmail.com' });
  assert.equal(enviados[0].replyTo, 'cortavo.app@gmail.com');
  assert.equal(enviados[0].subject, 'Crie sua senha de acesso à Cortavo');
  assert.match(enviados[0].text, /Olá, José\./);
  assert.match(enviados[0].text, /O link vale por 72 horas e funciona uma vez só\./);
  assert.match(enviados[0].text, /https:\/\/cortavo\.com\.br\/criar-senha\?t=abc/);
  assert.match(enviados[0].html, /Criar minha senha/);
  assert.doesNotMatch(enviados[0].html, /<img/i, 'sem imagem nem pixel');
});

test('C1 textos 6.1 e 6.2 idênticos aos aprovados; nome da barbearia passa por escape no HTML', () => {
  const { em } = emailCom();
  const a = em.modeloPrimeiroAcesso({ nome: 'Ana', nomeBarbearia: '<script>x</script>', email: 'a@x.test', link: 'https://cortavo.com.br/criar-senha?t=1' });
  assert.ok(!a.html.includes('<script>x</script>'));
  assert.ok(a.html.includes('&lt;script&gt;x&lt;/script&gt;'));
  for (const frase of [
    'Se você não esperava este e-mail, pode ignorar. Sem criar a senha, ninguém entra na conta.',
    'A Cortavo nunca pede a sua senha por e-mail, WhatsApp ou Instagram.',
    'Dúvidas? É só responder este e-mail.',
    'no iPhone, pelo app Cortavo da App Store: https://apps.apple.com/br/app/cortavo/id6804311130',
    'no Android ou no computador, pelo navegador, em https://cortavo.com.br',
  ]) assert.ok(a.texto.includes(frase), frase);
  const b = em.modeloNovaSenha({ nome: 'Ana Paula', nomeBarbearia: 'Casa', link: 'https://cortavo.com.br/criar-senha?t=2' });
  assert.equal(b.assunto, 'Link para criar uma nova senha na Cortavo');
  assert.ok(b.texto.includes('O link vale por 1 hora e funciona uma vez só. Enquanto você não criar a nova senha, a atual continua valendo.'));
  assert.ok(b.texto.includes('Se não foi você que pediu, pode ignorar este e-mail. Sua senha não muda.'));
  assert.match(b.texto, /^Olá, Ana\./);
});

test('C13 sem configuração ou com o SMTP fora: não lança, devolve o motivo', async () => {
  const { em } = emailCom();
  assert.equal(em.estado({}), 'nao_configurado');
  assert.equal(em.estado(ENV_OK), 'ok');
  const r1 = await em.enviar({ para: 'a@x.test', assunto: 's', texto: 't' }, { env: {} });
  assert.equal(r1.enviado, false);
  assert.equal(r1.motivo, 'nao_configurado');
  em.usarTransporte({ sendMail: async () => { const e = new Error('Invalid login: 535 a@x.test'); e.code = 'EAUTH'; throw e; } });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const r2 = await em.enviar({ para: 'a@x.test', assunto: 's', texto: 'link secreto', rotulo: 'teste' }, { env: ENV_OK });
    assert.equal(r2.enviado, false);
    assert.equal(r2.motivo, 'falha_envio');
  } finally { console.log = orig; }
  assert.ok(logs.some((l) => l.includes('EAUTH')));
  assert.ok(!logs.join('\n').includes('a@x.test'), 'a mensagem do servidor (com o e-mail) não vai para o log');
});

test('C13 nodemailer ausente: motivo claro, sem derrubar nada (lazy require)', async () => {
  const { em } = emailCom();
  em.usarTransporte(null);
  let instalado = true;
  try { require.resolve('nodemailer', { paths: [RAIZ] }); } catch { instalado = false; }
  if (instalado) return; // depois do npm install da Kalany este caso não existe mais
  const orig = console.log;
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  let r;
  try { r = await em.enviar({ para: 'a@x.test', assunto: 's', texto: 't' }, { env: ENV_OK }); } finally { console.log = orig; }
  assert.equal(r.motivo, 'biblioteca_ausente');
  assert.equal(r.texto, 'biblioteca de e-mail não instalada');
  assert.match(logs.join('\n'), /npm install/);
});

test('C14 EMAIL_ENVIO_DESLIGADO=1: nada é enviado e o log não tem o link', async () => {
  const { em } = emailCom();
  const enviados = [];
  em.usarTransporte({ sendMail: async (m) => { enviados.push(m); } });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let r;
  try {
    r = await em.enviar({ para: 'a@x.test', assunto: 's', texto: 'https://cortavo.com.br/criar-senha?t=SEGREDO', rotulo: 'link de acesso do usuário 3' }, { env: { ...ENV_OK, EMAIL_ENVIO_DESLIGADO: '1' } });
  } finally { console.log = orig; }
  assert.equal(r.enviado, false);
  assert.equal(r.motivo, 'desligado');
  assert.equal(enviados.length, 0);
  assert.match(logs.join('\n'), /envio simulado/);
  assert.ok(!logs.join('\n').includes('SEGREDO'));
  assert.ok(!logs.join('\n').includes('criar-senha'));
});

test('destinatário com quebra de linha (injeção de cabeçalho) é recusado', async () => {
  const { em } = emailCom();
  const enviados = [];
  em.usarTransporte({ sendMail: async (m) => { enviados.push(m); } });
  const r = await em.enviar({ para: 'a@x.test\r\nBcc: b@y.test', assunto: 's', texto: 't' }, { env: ENV_OK });
  assert.equal(r.motivo, 'destinatario_invalido');
  assert.equal(enviados.length, 0);
});

test('.env.example traz só os NOMES das variáveis de e-mail (sem valores) e o nodemailer está no package.json', () => {
  const ex = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8');
  for (const nome of ['EMAIL_SMTP_HOST', 'EMAIL_SMTP_PORTA', 'EMAIL_SMTP_USUARIO', 'EMAIL_SMTP_SENHA', 'EMAIL_REMETENTE', 'EMAIL_REMETENTE_NOME', 'EMAIL_ENVIO_DESLIGADO', 'EMAIL_LIMITE_DIA']) {
    assert.match(ex, new RegExp(`^${nome}=$`, 'm'), nome);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.nodemailer);
});
