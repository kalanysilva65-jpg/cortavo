// Seed inicial do banco (MULTI-BARBEARIA). Roda no `npm install` (postinstall),
// inclusive em PRODUÇÃO, então segue três regras (achado B6 do Sergio):
//  1. Nenhum dado pessoal no código: nada de e-mail de pessoa real nem senha
//     fixa. Tudo aqui é fictício (domínio reservado .test).
//  2. Nunca cria conta a mais num banco que já tem dono: se já existe um
//     usuário "dono", o seed não cria outro. Em produção ele só confere.
//  3. Nunca imprime senha. As contas nascem com senha ALEATÓRIA e provisória:
//     o dono define a dele com `node scripts/senha-dono.js` (mostra uma senha
//     provisória uma vez e obriga a troca no 1º login).
// É idempotente: pode rodar várias vezes sem duplicar nem sobrescrever dados.
//
// Variáveis opcionais (só para o PRIMEIRO dono de um banco vazio):
//   SEED_DONO_EMAIL  e-mail do dono do sistema (sem ele, usa dono@exemplo.test)
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/db');

const EH_PRODUCAO = process.env.NODE_ENV === 'production' || !!process.env.APP_DOMAIN;

// Senha que ninguém conhece (troca obrigatória / redefinição pelo script).
function senhaAleatoria() {
  return bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
}

// Garante UM dono do sistema (barbeariaId = null). Se já existe algum, não cria.
async function garantirDono() {
  const existente = await prisma.usuario.findFirst({ where: { barbeariaId: null, papel: 'dono' } });
  if (existente) return { usuario: existente, criado: false };
  const email = String(process.env.SEED_DONO_EMAIL || 'dono@exemplo.test').trim().toLowerCase();
  const usuario = await prisma.usuario.create({
    data: { barbeariaId: null, nome: 'Dono do sistema', email, senhaHash: senhaAleatoria(), papel: 'dono', senhaProvisoria: true },
  });
  return { usuario, criado: true };
}

// Cria/garante uma barbearia pelo slug.
// Se o e-mail do admin já existe em ALGUMA barbearia, é ela — mesmo que o slug
// tenha sido renomeado depois (pelo painel-mestre). Sem isso, um redeploy
// recriaria uma barbearia duplicada com o slug antigo.
async function garantirBarbearia(nome, slug, emailAdmin) {
  const porAdmin = await prisma.usuario.findFirst({
    where: { email: emailAdmin, barbeariaId: { not: null } },
    include: { barbearia: true },
  });
  if (porAdmin && porAdmin.barbearia) return porAdmin.barbearia;

  return prisma.barbearia.upsert({
    where: { slug },
    update: {},
    create: { nome, slug },
  });
}

// Cria/garante um usuário dentro de uma barbearia.
async function garantirUsuario(barbeariaId, { nome, email, papel }) {
  return prisma.usuario.upsert({
    where: { barbeariaId_email: { barbeariaId, email } },
    update: {},
    // Senha de fábrica: força a troca no 1º login. Não sobrescreve quem já
    // existe (update vazio), então quem já trocou continua com a sua.
    create: { barbeariaId, nome, email, senhaHash: senhaAleatoria(), papel, senhaProvisoria: true },
  });
}

// Jornada padrão: segunda a sábado 09:00–20:00, domingo de folga.
async function garantirJornada(barbeariaId, usuarioId) {
  const qtd = await prisma.horarioTrabalho.count({ where: { usuarioId } });
  if (qtd > 0) return;
  for (let dia = 0; dia <= 6; dia++) {
    await prisma.horarioTrabalho.create({
      data: { barbeariaId, usuarioId, diaSemana: dia, horaInicio: '09:00', horaFim: '20:00', trabalha: dia !== 0 },
    });
  }
}

// Configuração chave/valor por barbearia (idempotente; não sobrescreve valores existentes).
async function garantirConfig(barbeariaId, chave, valor) {
  await prisma.configuracao.upsert({
    where: { barbeariaId_chave: { barbeariaId, chave } },
    update: {},
    create: { barbeariaId, chave, valor },
  });
}

async function main() {
  console.log('› Seed: conferindo o dono do sistema...');
  const dono = await garantirDono();
  console.log(dono.criado
    ? '✓ Dono do sistema criado (' + dono.usuario.email + '). Defina a senha com: node scripts/senha-dono.js'
    : '✓ Dono do sistema já existe: nada criado.');

  // Barbearia de exemplo SÓ em desenvolvimento (dados fictícios). Em produção
  // as barbearias são criadas pelo painel-mestre (com o link por e-mail).
  if (EH_PRODUCAO) {
    console.log('✓ Produção: nenhuma barbearia criada pelo seed.');
    return;
  }
  const EMAIL_ADMIN = 'admin@exemplo.test';
  const exemplo = await garantirBarbearia('Barbearia Exemplo', 'exemplo', EMAIL_ADMIN);
  const admin = await garantirUsuario(exemplo.id, { nome: 'Admin Exemplo', email: EMAIL_ADMIN, papel: 'admin' });
  await garantirJornada(exemplo.id, admin.id);
  // Ligado por padrão: concluir um atendimento lança no caixa (quem registra o
  // caixa à mão desliga em Caixa > 'Entrada automática').
  await garantirConfig(exemplo.id, 'caixa_automatico', 'true');
  await garantirConfig(exemplo.id, 'logo_url', '');
  await garantirConfig(exemplo.id, 'mostrar_powered_by', 'true');
  console.log('✓ Desenvolvimento: "Barbearia Exemplo" (dev: ?b=exemplo), admin ' + EMAIL_ADMIN + '.');
  console.log('  Senha aleatória e provisória: para entrar, crie uma pelo mestre ("Enviar link") ou pelo "Esqueci minha senha".');
}



// `node prisma/seed.js` (postinstall) roda; os testes importam e chamam main().
if (require.main === module) {
  main()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error('Erro no seed:', e);
      await prisma.$disconnect();
      process.exit(1);
    });
}

module.exports = { main };
