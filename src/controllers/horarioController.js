// Controlador de horários: jornada semanal e bloqueios por barbeiro.
// Acesso exclusivo do admin (garantido pela rota com exigeAdmin).
const prisma = require('../config/db');
const { DIAS_SEMANA } = require('../config/constantes');
const { dataLocal } = require('../services/disponibilidade');

const DIAS_ABREV = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Resume a jornada semanal numa frase curta (ex.: "Seg–Sáb, 09:00–18:00"),
// agrupando dias consecutivos que têm o mesmo horário.
function resumoJornada(jornada) {
  const porDia = new Array(7).fill(null);
  jornada.forEach((j) => { porDia[j.diaSemana] = j; });

  const grupos = [];
  let atual = null;
  for (let i = 0; i < 7; i++) {
    const j = porDia[i];
    if (j && j.trabalha) {
      if (atual && atual.fim === i - 1 && atual.horaInicio === j.horaInicio && atual.horaFim === j.horaFim) {
        atual.fim = i;
      } else {
        atual = { ini: i, fim: i, horaInicio: j.horaInicio, horaFim: j.horaFim };
        grupos.push(atual);
      }
    }
  }
  if (grupos.length === 0) return 'Sem expediente';
  return grupos
    .map((g) => {
      const dias = g.ini === g.fim ? DIAS_ABREV[g.ini] : `${DIAS_ABREV[g.ini]}–${DIAS_ABREV[g.fim]}`;
      return `${dias}, ${g.horaInicio}–${g.horaFim}`;
    })
    .join(' · ');
}

// Janela de agendamento do cliente: quantos DIAS à frente ele pode marcar pelo
// app. Guardada como número de dias (2026-09-03). Antes eram 3 palavras-chave
// fixas (semana/duas_semanas/sem_limite); o dono quis poder digitar qualquer
// valor ("só 7 dias", "só 3 dias" etc.). `normalizarJanelaDias` converte tanto
// os valores antigos por palavra quanto o número novo — nenhuma migração de
// banco necessária.
const JANELA_PADRAO_DIAS = 60;
const JANELA_MAX_DIAS = 365;

function normalizarJanelaDias(valor) {
  const legado = { semana: 7, duas_semanas: 14, sem_limite: 365 };
  if (valor && Object.prototype.hasOwnProperty.call(legado, valor)) return legado[valor];
  const n = parseInt(valor, 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(JANELA_MAX_DIAS, n);
  return JANELA_PADRAO_DIAS;
}

// Retorna a janela em NÚMERO DE DIAS (o público usa direto).
async function lerJanelaAgendamento(barbeariaId) {
  const cfg = await prisma.configuracao.findUnique({
    where: { barbeariaId_chave: { barbeariaId, chave: 'janelaAgendamento' } },
  }).catch(() => null);
  return normalizarJanelaDias(cfg && cfg.valor);
}

// GET /painel/horarios
//  - Admin: jornada + bloqueios de todos os barbeiros, e a janela de agendamento.
//  - Funcionário: só a PRÓPRIA jornada e os PRÓPRIOS bloqueios (sem a janela).
async function ver(req, res) {
  const b = req.barbeariaId;
  const ehAdmin = req.ehAdmin;

  const whereBarb = { barbeariaId: b, ativo: true };
  if (!ehAdmin) whereBarb.id = req.session.usuario.id;
  const barbeiros = await prisma.usuario.findMany({ where: whereBarb, orderBy: { id: 'asc' } });

  const todaJornada = await prisma.horarioTrabalho.findMany({ where: { barbeariaId: b } });
  const barbeirosComJornada = barbeiros.map((barbeiro) => {
    const jornada = todaJornada.filter((j) => j.usuarioId === barbeiro.id);
    return { barbeiro, jornada, resumo: resumoJornada(jornada) };
  });

  // Bloqueios manuais de hoje em diante (só os próprios, se funcionário).
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const whereBloq = { barbeariaId: b, data: { gte: hoje } };
  if (!ehAdmin) whereBloq.usuarioId = req.session.usuario.id;
  const bloqueios = await prisma.bloqueio.findMany({
    where: whereBloq,
    include: { usuario: true },
    orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
  });

  const janelaAgendamento = await lerJanelaAgendamento(b);

  res.render('painel/horarios', {
    titulo: 'Horários',
    ehAdmin,
    barbeirosComJornada,
    barbeiros,
    bloqueios,
    DIAS_SEMANA,
    janelaAgendamento,
  });
}

// POST /painel/horarios/janela — salva quantos dias à frente o cliente pode
// marcar. Aceita tanto os presets (campo `janela`, ex.: 7/14/30/365) quanto o
// número digitado no campo "Outro" (`janelaDias`); os dois caem em
// `normalizarJanelaDias`, então qualquer valor vira um número válido (1..365).
async function salvarJanela(req, res) {
  const b = req.barbeariaId;
  const bruto = req.body.janelaDias != null && String(req.body.janelaDias).trim() !== ''
    ? req.body.janelaDias
    : req.body.janela;
  const dias = normalizarJanelaDias(bruto);
  await prisma.configuracao.upsert({
    where: { barbeariaId_chave: { barbeariaId: b, chave: 'janelaAgendamento' } },
    update: { valor: String(dias) },
    create: { barbeariaId: b, chave: 'janelaAgendamento', valor: String(dias) },
  });
  req.session.flash = {
    tipo: 'sucesso',
    texto: dias >= JANELA_MAX_DIAS ? 'Cliente pode agendar sem limite de dias.' : `Cliente pode agendar até ${dias} dias à frente.`,
  };
  res.redirect('/painel/horarios');
}

// Confere se o barbeiro pertence à barbearia do contexto.
async function barbeiroDaBarbearia(barbeiroId, barbeariaId) {
  if (!barbeiroId) return null;
  return prisma.usuario.findFirst({ where: { id: barbeiroId, barbeariaId } });
}

// POST /painel/horarios/jornada — salva a jornada semanal do barbeiro.
// Funcionário só edita a própria jornada (ignora o barbeiroId do formulário).
async function salvarJornada(req, res) {
  const b = req.barbeariaId;
  // A jornada agora também é editada no Perfil (pedido do dono, 2026-08-01),
  // que salva pela mesma rota — `retorno` diz de onde veio para não jogar o
  // usuário numa tela que saiu do menu. Lista fechada de propósito: `retorno`
  // vem do formulário, e redirecionar para valor livre seria porta aberta.
  const RETORNOS = { perfil: '/painel/perfil', horarios: '/painel/horarios' };
  const voltarPara = RETORNOS[req.body.retorno] || '/painel/horarios';

  const barbeiroId = req.ehAdmin && req.body.barbeiroId ? Number(req.body.barbeiroId) : req.session.usuario.id;
  if (!(await barbeiroDaBarbearia(barbeiroId, b))) return res.redirect(voltarPara);

  for (let dia = 0; dia <= 6; dia++) {
    const trabalha = req.body['trabalha_' + dia] === 'on';
    const horaInicio = req.body['inicio_' + dia] || '09:00';
    const horaFim = req.body['fim_' + dia] || '20:00';

    const existente = await prisma.horarioTrabalho.findFirst({
      where: { barbeariaId: b, usuarioId: barbeiroId, diaSemana: dia },
    });
    if (existente) {
      await prisma.horarioTrabalho.update({
        where: { id: existente.id },
        data: { trabalha, horaInicio, horaFim },
      });
    } else {
      await prisma.horarioTrabalho.create({
        data: { barbeariaId: b, usuarioId: barbeiroId, diaSemana: dia, trabalha, horaInicio, horaFim },
      });
    }
  }

  req.session.flash = { tipo: 'sucesso', texto: 'Jornada atualizada.' };
  res.redirect(voltarPara);
}

// POST /painel/horarios/bloqueios — adiciona um bloqueio.
// Funcionário bloqueia sempre a PRÓPRIA agenda.
async function adicionarBloqueio(req, res) {
  const b = req.barbeariaId;
  const barbeiroId = req.ehAdmin ? Number(req.body.barbeiroId) : req.session.usuario.id;
  const data = req.body.data;
  const horaInicio = req.body.horaInicio;
  const horaFim = req.body.horaFim;
  const motivo = (req.body.motivo || '').trim() || null;

  if ((await barbeiroDaBarbearia(barbeiroId, b)) && data && horaInicio && horaFim && horaInicio < horaFim) {
    await prisma.bloqueio.create({
      data: { barbeariaId: b, usuarioId: barbeiroId, data: dataLocal(data), horaInicio, horaFim, motivo },
    });
    req.session.flash = { tipo: 'sucesso', texto: 'Bloqueio adicionado.' };
  } else {
    req.session.flash = { tipo: 'erro', texto: 'Preencha data e um intervalo de horário válido.' };
  }
  res.redirect('/painel/horarios');
}

// POST /painel/horarios/bloqueios/:id/remover — remove um bloqueio.
// Funcionário só remove os próprios bloqueios.
async function removerBloqueio(req, res) {
  const where = { id: Number(req.params.id), barbeariaId: req.barbeariaId };
  if (!req.ehAdmin) where.usuarioId = req.session.usuario.id;
  await prisma.bloqueio.deleteMany({ where }).catch(() => {});
  req.session.flash = { tipo: 'sucesso', texto: 'Bloqueio removido.' };
  res.redirect('/painel/horarios');
}

module.exports = { ver, salvarJornada, adicionarBloqueio, removerBloqueio, salvarJanela, resumoJornada, lerJanelaAgendamento };
