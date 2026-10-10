// Agenda em colunas por barbeiro (dia) e visão de semana, para a agenda do PC
// (F13 do redesign v3, Fabio). Só leitura. Cada bloco traz início, fim e
// DURAÇÃO (soma dos serviços com a regra do encaixe, a mesma da
// disponibilidade), o estado e os bloqueios, para desenhar as colunas sem
// recalcular nada no navegador.
//
// Privacidade: o bloco leva só o nome do cliente (nunca telefone ou e-mail).
// Quem não é admin só recebe a própria coluna (regra da agenda).
const prisma = require('../config/db');
const { dataLocal, paraMinutos, duracaoComEncaixe } = require('./disponibilidade');
const STATUS = require('../config/statusAgendamento');

const DIAS_ABR = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function dataValida(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(dataLocal(s).getTime());
}

function bloco(ag) {
  const ini = paraMinutos(ag.horaInicio);
  const itens = (ag.itens || []).filter((it) => it.servico);
  const dur = duracaoComEncaixe(itens.map((it) => ({ duracaoMin: it.servico.duracaoMin, ehEncaixe: it.servico.ehEncaixe, quantidade: it.quantidade })), { efetiva: true });
  return {
    id: ag.id,
    barbeiroId: ag.usuarioId,
    inicio: ag.horaInicio,
    fim: hhmm(ini + dur),
    inicioMin: ini,
    duracaoMin: dur,
    status: ag.status,
    ocupa: !STATUS.INATIVOS.includes(ag.status),
    cliente: ag.clienteNome,
    servicos: itens.map((it) => it.servico.nome),
    valorCentavos: ag.valorTotal || 0,
  };
}
function bloqueio(bl) {
  const ini = paraMinutos(bl.horaInicio);
  const fim = paraMinutos(bl.horaFim);
  return { id: bl.id, barbeiroId: bl.usuarioId, inicio: bl.horaInicio, fim: bl.horaFim, inicioMin: ini, duracaoMin: Math.max(0, fim - ini), motivo: bl.motivo || null };
}

// Quem aparece: admin vê todos os ativos (ou um, com `barbeiro`); os demais, só
// a própria coluna.
async function barbeirosVisiveis({ barbeariaId, ehAdmin, usuarioId, barbeiro }) {
  const where = { barbeariaId, ativo: true };
  if (!ehAdmin) where.id = usuarioId;
  else if (barbeiro && barbeiro !== 'todos' && Number.isFinite(Number(barbeiro))) where.id = Number(barbeiro);
  return prisma.usuario.findMany({ where, select: { id: true, nome: true, nomePublico: true, fotoUrl: true }, orderBy: { id: 'asc' } });
}

async function jornadasDe(barbeariaId, ids) {
  if (!ids.length) return [];
  return prisma.horarioTrabalho.findMany({ where: { barbeariaId, usuarioId: { in: ids } } });
}
function jornadaDoDia(jornadas, usuarioId, diaSemana) {
  const j = jornadas.find((x) => x.usuarioId === usuarioId && x.diaSemana === diaSemana);
  if (!j || !j.trabalha) return { trabalha: false, inicio: null, fim: null };
  return { trabalha: true, inicio: j.horaInicio, fim: j.horaFim };
}

async function dadosDoPeriodo(barbeariaId, ids, inicio, fimExcl) {
  if (!ids.length) return { ags: [], bls: [] };
  const filtro = { barbeariaId, usuarioId: { in: ids }, data: { gte: inicio, lt: fimExcl } };
  const [ags, bls] = await Promise.all([
    prisma.agendamento.findMany({ where: { ...filtro, status: { not: STATUS.CANCELADO } }, include: { itens: { include: { servico: true } } }, orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }] }),
    prisma.bloqueio.findMany({ where: filtro, orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }] }),
  ]);
  return { ags, bls };
}

// Faixa de horas da grade: do começo da jornada mais cedo ao fim da mais tarde,
// esticada se houver bloco fora dela. Padrão 09:00-20:00.
function faixa(jornadas, blocos) {
  let ini = Infinity;
  let fim = -Infinity;
  for (const j of jornadas) if (j.trabalha) { ini = Math.min(ini, paraMinutos(j.inicio)); fim = Math.max(fim, paraMinutos(j.fim)); }
  for (const b of blocos) { ini = Math.min(ini, b.inicioMin); fim = Math.max(fim, b.inicioMin + b.duracaoMin); }
  if (!Number.isFinite(ini)) { ini = 9 * 60; fim = 20 * 60; }
  return { inicio: hhmm(Math.floor(ini / 30) * 30), fim: hhmm(Math.min(24 * 60 - 1, Math.ceil(fim / 30) * 30)) };
}

// Dia em colunas: uma coluna por barbeiro, com jornada, blocos e bloqueios.
async function dia({ barbeariaId, ehAdmin, usuarioId, barbeiro, data }) {
  const dataStr = dataValida(data) ? data : iso(new Date());
  const d0 = dataLocal(dataStr);
  const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
  const barbeiros = await barbeirosVisiveis({ barbeariaId, ehAdmin, usuarioId, barbeiro });
  const ids = barbeiros.map((b) => b.id);
  const [jornadas, { ags, bls }] = await Promise.all([jornadasDe(barbeariaId, ids), dadosDoPeriodo(barbeariaId, ids, d0, d1)]);
  const blocos = ags.map(bloco);
  const bloqs = bls.map(bloqueio);
  const colunas = barbeiros.map((b) => {
    const meus = blocos.filter((x) => x.barbeiroId === b.id);
    return {
      barbeiro: { id: b.id, nome: b.nomePublico || b.nome, fotoUrl: b.fotoUrl || null },
      jornada: jornadaDoDia(jornadas, b.id, d0.getDay()),
      blocos: meus,
      bloqueios: bloqs.filter((x) => x.barbeiroId === b.id),
      ocupadoMin: meus.filter((x) => x.ocupa).reduce((s, x) => s + x.duracaoMin, 0),
    };
  });
  return { data: dataStr, diaSemana: d0.getDay(), faixa: faixa(colunas.map((c) => c.jornada), [...blocos, ...bloqs]), colunas };
}

// Semana (segunda a domingo) que contém a data: por dia e por barbeiro, os
// blocos, os bloqueios, a jornada e quanto já está ocupado.
async function semana({ barbeariaId, ehAdmin, usuarioId, barbeiro, data }) {
  const dataStr = dataValida(data) ? data : iso(new Date());
  const ref = dataLocal(dataStr);
  const seg = new Date(ref); seg.setDate(ref.getDate() - ((ref.getDay() + 6) % 7));
  const fimExcl = new Date(seg); fimExcl.setDate(seg.getDate() + 7);
  const barbeiros = await barbeirosVisiveis({ barbeariaId, ehAdmin, usuarioId, barbeiro });
  const ids = barbeiros.map((b) => b.id);
  const [jornadas, { ags, bls }] = await Promise.all([jornadasDe(barbeariaId, ids), dadosDoPeriodo(barbeariaId, ids, seg, fimExcl)]);
  const dias = [];
  const todosBlocos = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(seg); d.setDate(seg.getDate() + i);
    const chave = iso(d);
    const doDia = (x) => iso(new Date(x.data)) === chave;
    const blocos = ags.filter(doDia).map(bloco);
    const bloqs = bls.filter(doDia).map(bloqueio);
    todosBlocos.push(...blocos, ...bloqs);
    dias.push({
      data: chave,
      rotulo: `${DIAS_ABR[d.getDay()]} ${d.getDate()}`,
      barbeiros: barbeiros.map((b) => {
        const meus = blocos.filter((x) => x.barbeiroId === b.id);
        return {
          barbeiroId: b.id,
          jornada: jornadaDoDia(jornadas, b.id, d.getDay()),
          blocos: meus,
          bloqueios: bloqs.filter((x) => x.barbeiroId === b.id),
          quantidade: meus.filter((x) => x.ocupa).length,
          ocupadoMin: meus.filter((x) => x.ocupa).reduce((s, x) => s + x.duracaoMin, 0),
        };
      }),
    });
  }
  const todasJornadas = dias.flatMap((d) => d.barbeiros.map((b) => b.jornada));
  return {
    inicio: iso(seg),
    fim: iso(new Date(fimExcl.getTime() - 86400000)),
    faixa: faixa(todasJornadas, todosBlocos),
    barbeiros: barbeiros.map((b) => ({ id: b.id, nome: b.nomePublico || b.nome, fotoUrl: b.fotoUrl || null })),
    dias,
  };
}

module.exports = { dia, semana };
