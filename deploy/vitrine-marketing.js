// Barbearia VITRINE (spec 03): só para marketing (gravar vídeos, tirar fotos
// das telas para as lojas). Separada da demo do revisor (deploy/conta-revisor-apple.js),
// que continua intocada.
//
// O QUE CRIA (tudo fictício)
//  - Barbearia "Barbearia Vitrine" (slug `vitrine`), marcada como demonstração
//    no código (src/services/demo.js): sem lembrete, sem secretária, sem push,
//    fora da lista do app do cliente.
//  - 3 barbeiros (um deles é o login de quem grava), serviços e produtos.
//  - Clientes com telefone de DDD inexistente (00) 9xxxx-xxxx (regra 2026-10-04).
//  - 6 semanas de atendimentos com movimento CRESCENDO semana a semana e a
//    semana atual com a agenda cheia.
//
// USO (no VPS, só a Kalany, com backup feito antes)
//   node deploy/vitrine-marketing.js --simular             # só mostra o que criaria (não grava)
//   node deploy/vitrine-marketing.js                       # cria/recria; MANTÉM a senha atual do login
//   node deploy/vitrine-marketing.js --senha=XXX           # (re)define a senha do login da vitrine
//   node deploy/vitrine-marketing.js --remover             # apaga a vitrine (cascata)
//
// Idempotente: rodar de novo apaga o MOVIMENTO e os cadastros da vitrine e
// repovoa, sem tocar em nenhuma outra barbearia (tudo filtrado pelo id da vitrine).
const crypto = require('crypto');

const SLUG = 'vitrine';
const EMAIL = 'vitrine@cortavo.com.br';

const BARBEIROS = [
  { nome: 'Rafa Lima', email: EMAIL, papel: 'admin', comissao: 50 },
  { nome: 'Dudu Castro', email: 'dudu@vitrine.cortavo.com.br', papel: 'funcionario', comissao: 50 },
  { nome: 'Léo Martins', email: 'leo@vitrine.cortavo.com.br', papel: 'funcionario', comissao: 45 },
];

const CATALOGO = [
  // [nome, valor (centavos), duração, ehProduto]
  ['Corte social', 5000, 40, false],
  ['Corte degradê', 5500, 45, false],
  ['Barba completa', 4000, 30, false],
  ['Corte + barba', 8000, 60, false],
  ['Pezinho', 2000, 15, false],
  ['Sobrancelha', 1500, 10, false],
  ['Pomada modeladora', 4500, 0, true],
  ['Óleo para barba', 3900, 0, true],
];

const NOMES_CLIENTES = [
  'Arthur Nogueira', 'Bernardo Vieira', 'Caio Fernandes', 'Davi Rocha', 'Enzo Cardoso',
  'Fábio Teixeira', 'Gabriel Moura', 'Heitor Barros', 'Igor Pacheco', 'João Pedro Lins',
  'Kaique Santana', 'Lucas Ribeiro', 'Mateus Freitas', 'Nicolas Prado', 'Otávio Reis',
  'Pedro Henrique Sá', 'Rodrigo Campos', 'Samuel Tavares',
];

const HORAS = ['09:00', '09:45', '10:30', '11:15', '13:00', '13:45', '14:30', '15:15', '16:00', '16:45', '17:30', '18:15'];
const COMBOS = [['Corte social'], ['Corte degradê'], ['Corte + barba'], ['Barba completa'], ['Corte social', 'Pomada modeladora'], ['Corte + barba', 'Óleo para barba'], ['Pezinho'], ['Corte degradê', 'Sobrancelha']];
const FORMAS = ['pix', 'credito', 'debito', 'dinheiro', 'pix'];

// Telefone fictício com DDD inexistente: "(00) 9xxxx-xxxx".
function telefoneFicticio(i) {
  const n = String(10000000 + i * 7919).slice(-8);
  return '(00) 9' + n.slice(0, 4) + '-' + n.slice(4);
}

// Plano dos dados, PURO (sem banco): fácil de testar e de simular.
//  - 6 semanas para trás, com 2 a 3 atendimentos a mais por dia a cada semana;
//  - semana atual: dias que já passaram concluídos, o resto da semana cheio
//    de agendamentos (todos os barbeiros, quase todos os horários).
function gerarPlano(hoje = new Date()) {
  let seed = 20261005;
  const rnd = (n) => { seed = (seed * 9301 + 49297) % 233280; return Math.floor((seed / 233280) * n); };
  const base = new Date(hoje); base.setHours(0, 0, 0, 0);
  const dia = (offset) => { const d = new Date(base); d.setDate(d.getDate() + offset); return d; };

  const historico = [];
  for (let atras = 42; atras >= 1; atras--) {
    const d = dia(-atras);
    if (d.getDay() === 0) continue; // domingo fechado
    const semana = 6 - Math.floor((atras - 1) / 7); // 1 (mais antiga) ... 6 (mais recente)
    const porDia = 3 + semana * 2 + rnd(2); // cresce semana a semana
    const usados = new Set();
    for (let k = 0; k < porDia; k++) {
      const iBarb = k % BARBEIROS.length;
      let hora; let t = 0;
      do { hora = HORAS[rnd(HORAS.length)]; t++; } while (usados.has(iBarb + hora) && t < 20);
      if (usados.has(iBarb + hora)) continue;
      usados.add(iBarb + hora);
      historico.push({ atras, semana, hora, iBarb, iCliente: rnd(NOMES_CLIENTES.length), itens: COMBOS[rnd(COMBOS.length)], forma: FORMAS[rnd(FORMAS.length)] });
    }
  }

  // Resto da semana atual (de hoje até sábado; se hoje for domingo, a semana seguinte).
  const futuros = [];
  const fimSemana = hoje.getDay() === 0 ? 6 : 6 - hoje.getDay();
  for (let frente = 0; frente <= fimSemana; frente++) {
    const d = dia(frente);
    if (d.getDay() === 0) continue;
    for (let iBarb = 0; iBarb < BARBEIROS.length; iBarb++) {
      for (const hora of HORAS) {
        if (rnd(10) < 2) continue; // ~80% ocupado: agenda cheia, mas real
        futuros.push({ frente, hora, iBarb, iCliente: rnd(NOMES_CLIENTES.length), itens: COMBOS[rnd(COMBOS.length)] });
      }
    }
  }
  return { historico, futuros, dia };
}

function sortearSenha() {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(14), (b) => alfabeto[b % alfabeto.length]).join('');
}

function instante(data, hora) {
  const [h, m] = hora.split(':').map(Number);
  const d = new Date(data); d.setHours(h, m, 0, 0);
  const agora = new Date();
  return d > agora ? agora : d;
}

async function remover(prisma) {
  const b = await prisma.barbearia.findUnique({ where: { slug: SLUG } });
  if (!b) return console.log('Nada a remover: não existe a vitrine.');
  await prisma.agendamento.deleteMany({ where: { barbeariaId: b.id } });
  await prisma.barbearia.delete({ where: { id: b.id } });
  console.log('Vitrine removida (id ' + b.id + ').');
}

async function criar(prisma, senhaArg) {
  const bcrypt = require('bcryptjs');
  const { registrarEntradaAgendamento } = require('../src/services/caixa');
  const b = await prisma.barbearia.upsert({
    where: { slug: SLUG },
    update: { ativo: true },
    create: { nome: 'Barbearia Vitrine', slug: SLUG, ativo: true, endereco: 'Rua Exemplo, 123 — Centro' },
  });
  const bid = b.id;

  // Zera o conteúdo da VITRINE (só dela) antes de repovoar. Não apaga usuários.
  for (const m of ['caixa', 'clientePlano', 'plano', 'agendamento', 'cliente', 'servico', 'categoriaCaixa', 'conversa']) {
    await prisma[m].deleteMany({ where: { barbeariaId: bid } });
  }

  const existente = await prisma.usuario.findUnique({ where: { barbeariaId_email: { barbeariaId: bid, email: EMAIL } } });
  const preservar = !!existente && !senhaArg;
  const senha = preservar ? null : senhaArg || sortearSenha();
  const barbeiros = [];
  for (const def of BARBEIROS) {
    const ehLogin = def.email === EMAIL;
    const hash = bcrypt.hashSync(ehLogin && senha ? senha : sortearSenha(), 10);
    barbeiros.push(await prisma.usuario.upsert({
      where: { barbeariaId_email: { barbeariaId: bid, email: def.email } },
      update: ehLogin && !preservar ? { ativo: true, senhaHash: hash, papel: def.papel } : { ativo: true },
      create: { barbeariaId: bid, nome: def.nome, email: def.email, senhaHash: hash, papel: def.papel, comissaoPercentual: def.comissao },
    }));
  }
  for (const u of barbeiros) {
    if (await prisma.horarioTrabalho.count({ where: { usuarioId: u.id } })) continue;
    for (let d = 0; d <= 6; d++) {
      await prisma.horarioTrabalho.create({ data: { barbeariaId: bid, usuarioId: u.id, diaSemana: d, horaInicio: '09:00', horaFim: '19:00', trabalha: d !== 0 } });
    }
  }

  const servicos = {};
  for (const [nome, valor, duracaoMin, ehProduto] of CATALOGO) {
    servicos[nome] = await prisma.servico.create({ data: { barbeariaId: bid, nome, valor, duracaoMin: duracaoMin || 30, ehProduto, comissaoPercentual: ehProduto ? 10 : 50 } });
  }
  const clientes = [];
  for (let i = 0; i < NOMES_CLIENTES.length; i++) {
    clientes.push(await prisma.cliente.create({ data: { barbeariaId: bid, nome: NOMES_CLIENTES[i], telefone: telefoneFicticio(i) } }));
  }

  const { historico, futuros, dia } = gerarPlano();
  for (const e of historico) {
    const data = dia(-e.atras);
    const cli = clientes[e.iCliente];
    const itens = e.itens.map((n) => servicos[n]);
    const total = itens.reduce((s, it) => s + it.valor, 0);
    const ag = await prisma.agendamento.create({
      data: {
        barbeariaId: bid, usuarioId: barbeiros[e.iBarb].id, clienteId: cli.id, clienteNome: cli.nome, clienteTelefone: cli.telefone,
        data, horaInicio: e.hora, status: 'concluido', concluidoEm: instante(data, e.hora), valorTotal: total, formaPagamento: e.forma, origem: 'barbeiro',
        itens: { create: itens.map((it) => ({ servicoId: it.id, valorUnitario: it.valor, quantidade: 1 })) },
      },
    });
    await prisma.pagamentoAgendamento.create({ data: { barbeariaId: bid, agendamentoId: ag.id, valor: total, formaPagamento: e.forma, parcelas: 1 } });
    await registrarEntradaAgendamento(ag);
    await prisma.caixa.updateMany({ where: { agendamentoId: ag.id }, data: { data: instante(data, e.hora) } });
  }
  for (const f of futuros) {
    const cli = clientes[f.iCliente];
    const itens = f.itens.map((n) => servicos[n]);
    await prisma.agendamento.create({
      data: {
        barbeariaId: bid, usuarioId: barbeiros[f.iBarb].id, clienteId: cli.id, clienteNome: cli.nome, clienteTelefone: cli.telefone,
        data: dia(f.frente), horaInicio: f.hora, status: 'agendado', origem: 'barbeiro',
        valorTotal: itens.reduce((s, it) => s + it.valor, 0),
        itens: { create: itens.map((it) => ({ servicoId: it.id, valorUnitario: it.valor, quantidade: 1 })) },
      },
    });
  }

  console.log('Vitrine pronta: ' + historico.length + ' atendimentos concluídos, ' + futuros.length + ' agendados nesta semana.');
  console.log('Login: ' + EMAIL + (senha ? '  senha: ' + senha + '  (copie agora; não será mostrada de novo)' : '  (senha mantida)'));
}

module.exports = { gerarPlano, telefoneFicticio, BARBEIROS, SLUG };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--simular')) {
    const { historico, futuros } = gerarPlano();
    const porSemana = {};
    for (const e of historico) porSemana[e.semana] = (porSemana[e.semana] || 0) + 1;
    console.log('SIMULAÇÃO (nada gravado). Atendimentos por semana:', porSemana, '· agendados na semana atual:', futuros.length);
    process.exit(0);
  }
  require('dotenv').config();
  const prisma = require('../src/config/db');
  const senhaArg = (args.find((a) => a.startsWith('--senha=')) || '').slice('--senha='.length);
  (args.includes('--remover') ? remover(prisma) : criar(prisma, senhaArg))
    .catch((e) => { console.error('Falhou:', e.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
