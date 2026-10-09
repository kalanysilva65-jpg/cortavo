// Serviço de cálculo de disponibilidade de horários por barbeiro.
// Cada barbeiro tem agenda independente: o cálculo considera a jornada do dia,
// os agendamentos ativos e os bloqueios manuais daquele barbeiro.
const prisma = require('../config/db');
const { INTERVALO_SLOT_MIN } = require('../config/constantes');
const { INATIVOS: STATUS_INATIVOS } = require('../config/statusAgendamento');

// "HH:MM" -> minutos desde 00:00
function paraMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// minutos -> "HH:MM"
function paraHHMM(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// "YYYY-MM-DD" -> Date à meia-noite local (usado de forma consistente em todo o app)
function dataLocal(yyyymmdd) {
  const [ano, mes, dia] = yyyymmdd.split('-').map(Number);
  return new Date(ano, mes - 1, dia);
}

// Duração efetiva para fins de agenda: produtos (0 min) ocupam ao menos um intervalo.
function duracaoEfetiva(duracaoMin) {
  return duracaoMin && duracaoMin > 0 ? duracaoMin : INTERVALO_SLOT_MIN;
}

// Duração total de uma seleção aplicando a regra do "ENCAIXE" (2026-09-03):
// um serviço marcado como encaixe NÃO soma tempo quando há pelo menos um
// serviço NÃO-encaixe na seleção — ele "cabe" dentro do tempo do outro. Se a
// seleção só tem encaixes (ou um encaixe sozinho), aí eles contam a própria
// duração. Ex.: Sobrancelha(encaixe,10) + Corte(30) = 30; Sobrancelha sozinha = 10.
//   itens: [{ duracaoMin, ehEncaixe, quantidade? }]
//   efetiva=true (padrão): aplica o piso de 1 slot p/ itens de 0 min — usar no
//     cálculo de agenda/ocupação. efetiva=false: minutos crus — usar em texto.
function duracaoComEncaixe(itens, opcoes) {
  const efetiva = !opcoes || opcoes.efetiva !== false;
  const base = (d) => (efetiva ? duracaoEfetiva(d) : d || 0);
  let regular = 0;
  let encaixe = 0;
  for (const it of itens || []) {
    const q = it.quantidade || 1;
    const d = base(it.duracaoMin) * q;
    if (it.ehEncaixe) encaixe += d;
    else regular += d;
  }
  const total = regular > 0 ? regular : encaixe;
  return efetiva ? total || INTERVALO_SLOT_MIN : total;
}

// Intervalos [inicio, fim] (em minutos) já ocupados pelo barbeiro nessa data:
// agendamentos ativos (soma da duração dos itens) + bloqueios manuais.
async function intervalosOcupados(barbeiroId, data) {
  const ocupados = [];

  const agendamentos = await prisma.agendamento.findMany({
    where: { usuarioId: barbeiroId, data, status: { notIn: STATUS_INATIVOS } },
    include: { itens: { include: { servico: true } } },
  });
  for (const ag of agendamentos) {
    const ini = paraMinutos(ag.horaInicio);
    // Aplica a regra do encaixe: um serviço-encaixe agendado junto de outro não
    // estende o horário ocupado (cabe no tempo do outro).
    const dur = duracaoComEncaixe(
      ag.itens.map((it) => ({
        duracaoMin: it.servico.duracaoMin,
        ehEncaixe: it.servico.ehEncaixe,
        quantidade: it.quantidade,
      })),
      { efetiva: true }
    );
    ocupados.push([ini, ini + dur]);
  }

  const bloqueios = await prisma.bloqueio.findMany({
    where: { usuarioId: barbeiroId, data },
  });
  for (const b of bloqueios) {
    ocupados.push([paraMinutos(b.horaInicio), paraMinutos(b.horaFim)]);
  }

  return ocupados;
}

// Calcula os horários (slots) livres de um barbeiro numa data, para um serviço.
// Retorna um array de strings "HH:MM".
async function horariosDisponiveis(barbeiroId, dataStr, duracaoServico) {
  const todos = await todosHorarios(barbeiroId, dataStr, duracaoServico);
  return todos.filter((s) => s.livre).map((s) => s.hora);
}

// Igual ao acima, mas retorna TODOS os horários do expediente (livres e ocupados),
// cada um com a flag `livre` — usado no pop-up "Novo agendamento" para mostrar o
// grid completo de horários, riscando os que já estão ocupados.
async function todosHorarios(barbeiroId, dataStr, duracaoServico) {
  const data = dataLocal(dataStr);
  const diaSemana = data.getDay(); // 0 = domingo

  const jornada = await prisma.horarioTrabalho.findFirst({
    where: { usuarioId: barbeiroId, diaSemana },
  });
  if (!jornada || !jornada.trabalha) return [];

  const inicioExpediente = paraMinutos(jornada.horaInicio);
  const fimExpediente = paraMinutos(jornada.horaFim);
  const duracao = duracaoEfetiva(duracaoServico);
  const ocupados = await intervalosOcupados(barbeiroId, data);

  const agora = new Date();
  const ehHoje = data.toDateString() === agora.toDateString();
  const minutoAgora = agora.getHours() * 60 + agora.getMinutes();

  const slots = [];
  for (let t = inicioExpediente; t + duracao <= fimExpediente; t += INTERVALO_SLOT_MIN) {
    const fim = t + duracao;
    const conflita = ocupados.some(([oIni, oFim]) => t < oFim && oIni < fim);
    const passou = ehHoje && t <= minutoAgora;
    slots.push({ hora: paraHHMM(t), livre: !conflita && !passou });
  }
  return slots;
}

module.exports = { horariosDisponiveis, todosHorarios, intervalosOcupados, dataLocal, paraMinutos, paraHHMM, duracaoEfetiva, duracaoComEncaixe };
