// App do cliente (marketplace) — navegação e agendamento no design "Cortavo".
// Tudo aqui exige uma CONTA DE CLIENTE logada (req.session.contaCliente) e roda
// no domínio raiz: a barbearia vem do :slug na URL, NÃO do subdomínio. Por isso
// não reusa o exigeBarbeariaPublica; resolve a barbearia por slug em cada rota.
//
// A lógica de disponibilidade e as regras de criação de agendamento são as
// mesmas do fluxo público (services/disponibilidade); só a apresentação muda.
const prisma = require('../config/db');
const precos = require('../services/precos');
const { todosHorarios, horariosDisponiveis, dataLocal, duracaoComEncaixe } = require('../services/disponibilidade');
const { DIAS_SEMANA } = require('../config/constantes');
const { normalizarTelefone } = require('../utils/telefone');
const { lerJanelaAgendamento } = require('./horarioController');

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseIds(str) {
  return (str || '').toString().split(',').map(Number).filter(Boolean);
}
// Iniciais para o monograma do tile de serviço (ex.: "Corte Degradê" -> "CD").
function iniciais(nome) {
  const p = (nome || '').trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || (nome || '?').slice(0, 2).toUpperCase();
}

// Barbearia ativa pelo slug (ou null). Não usa subdomínio.
async function barbeariaPorSlug(slug) {
  if (!slug) return null;
  const b = await prisma.barbearia.findUnique({ where: { slug } });
  return b && b.ativo ? b : null;
}

// GET /conta — HOME: barbearias disponíveis.
async function home(req, res) {
  const termo = (req.query.q || '').trim();
  const barbearias = await prisma.barbearia.findMany({
    where: {
      ativo: true,
      // A "Barbearia Demonstração" (dados fictícios) tem agendamento público
      // aberto pelo subdomínio, mas NÃO entra na lista de barbearias reais.
      // A vitrine de marketing (spec 03) também fica de fora.
      slug: { notIn: ['demo', 'vitrine'] },
      ...(termo ? { nome: { contains: termo } } : {}),
    },
    orderBy: { nome: 'asc' },
  });

  // "Aberta hoje" = tem algum barbeiro com jornada ativa no dia da semana atual.
  const dow = new Date().getDay();
  const lista = await Promise.all(
    barbearias.map(async (b) => {
      const abre = await prisma.horarioTrabalho.findFirst({
        where: { barbeariaId: b.id, diaSemana: dow, trabalha: true },
      });
      return { ...b, abertaHoje: !!abre, local: localCurto(b.endereco) };
    })
  );

  res.render('app/home', {
    layout: 'layouts/app-cliente',
    titulo: 'Cortavo',
    abaAtiva: termo ? 'busca' : 'home',
    barbearias: lista,
    termo,
    busca: !!req.query.buscando || !!termo,
  });
}

// Pega um pedaço curto do endereço para exibir (bairro/cidade, sem a rua toda).
function localCurto(endereco) {
  if (!endereco) return 'SÃO PAULO';
  const partes = endereco.split(',').map((s) => s.trim()).filter(Boolean);
  return (partes.slice(-2).join(' · ') || endereco).toUpperCase();
}

// GET /conta/busca — mesma home em modo busca.
async function busca(req, res) {
  req.query.buscando = '1';
  return home(req, res);
}

// GET /conta/b/:slug — detalhe da barbearia (serviços).
async function barbearia(req, res) {
  const b = await barbeariaPorSlug(req.params.slug);
  if (!b) return res.redirect('/conta');

  const servicos = await prisma.servico.findMany({
    where: { barbeariaId: b.id, ativo: true, ehProduto: false },
    orderBy: { nome: 'asc' },
  });

  res.render('app/barbearia', {
    layout: 'layouts/app-cliente',
    titulo: b.nome,
    barbearia: b,
    local: localCurto(b.endereco),
    servicos: servicos.map((s) => ({ ...s, iniciais: iniciais(s.nome) })),
  });
}

// GET /conta/b/:slug/agendar — barbeiro + data + horário.
async function agendar(req, res) {
  const b = await barbeariaPorSlug(req.params.slug);
  if (!b) return res.redirect('/conta');

  const ids = parseIds(req.query.servicos);
  const servicos = await prisma.servico.findMany({
    where: { id: { in: ids }, barbeariaId: b.id, ativo: true },
    orderBy: { nome: 'asc' },
  });
  if (!servicos.length) return res.redirect('/conta/b/' + b.slug);

  const servicosStr = servicos.map((s) => s.id).join(',');
  const duracaoTotal = duracaoComEncaixe(servicos.map((x) => ({ duracaoMin: x.duracaoMin, ehEncaixe: x.ehEncaixe })), { efetiva: false });
  const valorTotal = servicos.reduce((s, x) => s + x.valor, 0);

  const barbeiros = await prisma.usuario.findMany({
    where: { barbeariaId: b.id, ativo: true },
    orderBy: { id: 'asc' },
  });
  let barbeiro = barbeiros.find((x) => x.id === Number(req.query.barbeiro)) || barbeiros[0] || null;

  // Dias em que o barbeiro trabalha, dentro da janela configurada.
  let datas = [];
  let dataSel = null;
  let manha = [];
  let tarde = [];
  if (barbeiro) {
    const jornadas = await prisma.horarioTrabalho.findMany({ where: { usuarioId: barbeiro.id, trabalha: true } });
    const trabalha = new Set(jornadas.map((j) => j.diaSemana));
    const janelaDias = await lerJanelaAgendamento(b.id);

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    for (let i = 0; i < janelaDias && datas.length < 30; i++) {
      const d = new Date(hoje);
      d.setDate(hoje.getDate() + i);
      if (!trabalha.has(d.getDay())) continue;
      datas.push({
        iso: iso(d),
        dow: i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : DIAS_SEMANA[d.getDay()].slice(0, 3),
        n: d.getDate(),
        mes: MESES_ABREV[d.getMonth()],
      });
    }

    dataSel = datas.find((x) => x.iso === req.query.data) ? req.query.data : datas[0]?.iso || null;
    if (dataSel) {
      const todos = await todosHorarios(barbeiro.id, dataSel, duracaoTotal);
      manha = todos.filter((h) => Number(h.hora.slice(0, 2)) < 12);
      tarde = todos.filter((h) => Number(h.hora.slice(0, 2)) >= 12);
    }
  }

  const mesLabel = dataSel ? MESES_ABREV[dataLocal(dataSel).getMonth()].toUpperCase() : '';

  res.render('app/agendar', {
    layout: 'layouts/app-cliente',
    titulo: 'Agendar',
    barbearia: b,
    servicos,
    servicosStr,
    duracaoTotal,
    valorTotal,
    barbeiros: barbeiros.map((x) => ({ ...x, ini: iniciais(x.nome) })),
    barbeiro,
    datas,
    dataSel,
    mesLabel,
    manha,
    tarde,
  });
}

// POST /conta/b/:slug/agendar — cria o agendamento pela conta logada.
async function confirmar(req, res) {
  const b = await barbeariaPorSlug(req.params.slug);
  if (!b) return res.redirect('/conta');

  // A sessão guarda só id/nome/email; buscamos a conta completa para ter o
  // telefone (usado no vínculo com o CRM local da barbearia).
  const conta = await prisma.contaCliente.findUnique({ where: { id: req.session.contaCliente.id } });
  if (!conta) return res.redirect('/conta/entrar');
  const ids = parseIds(req.body.servicos);
  const barbeiroId = Number(req.body.barbeiro);
  const data = req.body.data;
  const hora = req.body.hora;

  const servicosBase = await prisma.servico.findMany({ where: { id: { in: ids }, barbeariaId: b.id, ativo: true } });
  const barbeiro = await prisma.usuario.findFirst({ where: { id: barbeiroId, barbeariaId: b.id, ativo: true } });
  // Preço do barbeiro escolhido (pode diferir do padrão — services/precos.js).
  const servicos = barbeiro ? await precos.comPrecoDoBarbeiro(servicosBase, barbeiro.id) : servicosBase;

  const voltar = () => {
    const qs = new URLSearchParams({ servicos: ids.join(','), barbeiro: barbeiroId || '', data: data || '' });
    return res.redirect(`/conta/b/${b.slug}/agendar?` + qs.toString());
  };

  const erros = [];
  if (!servicos.length) erros.push('Serviço inválido.');
  if (!barbeiro) erros.push('Selecione um profissional.');
  if (!data || !hora) erros.push('Selecione data e horário.');
  const duracaoTotal = duracaoComEncaixe(servicos.map((x) => ({ duracaoMin: x.duracaoMin, ehEncaixe: x.ehEncaixe })), { efetiva: false });
  if (servicos.length && barbeiro && data && hora) {
    const livres = await horariosDisponiveis(barbeiroId, data, duracaoTotal);
    if (!livres.includes(hora)) erros.push('Esse horário não está mais disponível. Escolha outro.');
  }
  if (erros.length) {
    req.session.flash = { tipo: 'erro', texto: erros.join(' ') };
    return voltar();
  }

  // Garante o cadastro LOCAL (CRM) da barbearia a partir da conta, para o painel
  // e os planos daquela barbearia continuarem valendo. Chave: telefone (se houver)
  // — senão, cria um cadastro pelo nome sem telefone único.
  const telNorm = normalizarTelefone(conta.telefone);
  let clienteId = null;
  if (telNorm) {
    let cliente = await prisma.cliente.findUnique({
      where: { barbeariaId_telefone: { barbeariaId: b.id, telefone: telNorm } },
    });
    if (!cliente) cliente = await prisma.cliente.create({ data: { barbeariaId: b.id, nome: conta.nome, telefone: telNorm } });
    clienteId = cliente.id;
  }

  const valorTotal = servicos.reduce((s, x) => s + x.valor, 0);
  const ag = await prisma.agendamento.create({
    data: {
      barbeariaId: b.id,
      usuarioId: barbeiroId,
      clienteId,
      contaClienteId: conta.id,
      clienteNome: conta.nome,
      clienteEmail: conta.email,
      clienteTelefone: conta.telefone || '',
      data: dataLocal(data),
      horaInicio: hora,
      status: 'agendado',
      valorTotal,
      origem: 'app', // agendamento pelo app do cliente (marketplace)
      itens: { create: servicos.map((s) => ({ servicoId: s.id, valorUnitario: s.valor, quantidade: 1 })) },
    },
  });

  res.redirect('/conta/agendamento/' + ag.id);
}

// GET /conta/agendamento/:id — detalhe/sucesso (só do próprio cliente).
async function agendamentoDetalhe(req, res) {
  const ag = await prisma.agendamento.findFirst({
    where: { id: Number(req.params.id), contaClienteId: req.session.contaCliente.id },
    include: { usuario: true, barbearia: true, itens: { include: { servico: true } } },
  });
  if (!ag) return res.redirect('/conta/agendamentos');

  res.render('app/agendamento', {
    layout: 'layouts/app-cliente',
    titulo: 'Agendamento',
    ag,
    dataExtenso: `${DIAS_SEMANA[new Date(ag.data).getDay()]}, ${iso(new Date(ag.data)).split('-').reverse().join('/')}`,
  });
}

// GET /conta/agendamentos — lista os agendamentos da conta.
async function agendamentos(req, res) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const todos = await prisma.agendamento.findMany({
    where: { contaClienteId: req.session.contaCliente.id },
    include: { barbearia: true, itens: { include: { servico: true } } },
    orderBy: [{ data: 'desc' }, { horaInicio: 'desc' }],
  });
  const marcar = (ag) => ({
    ...ag,
    servicosLabel: ag.itens.map((i) => i.servico.nome).join(' + '),
    quando: `${DIAS_SEMANA[new Date(ag.data).getDay()].slice(0, 3)}, ${new Date(ag.data).getDate()} ${MESES_ABREV[new Date(ag.data).getMonth()]} · ${ag.horaInicio}`,
    concluido: ag.status === 'concluido',
  });
  const proximos = todos.filter((a) => new Date(a.data) >= hoje && a.status !== 'cancelado').map(marcar);
  const passados = todos.filter((a) => new Date(a.data) < hoje || a.status === 'concluido').map(marcar);

  res.render('app/agendamentos', {
    layout: 'layouts/app-cliente',
    titulo: 'Agendamentos',
    abaAtiva: 'agenda',
    tabbarDark: true,
    proximos,
    passados,
    aba: req.query.aba === 'passados' ? 'passados' : 'proximos',
  });
}

// GET /conta/perfil
function perfil(req, res) {
  res.render('app/perfil', {
    layout: 'layouts/app-cliente',
    titulo: 'Perfil',
    abaAtiva: 'perfil',
    conta: req.session.contaCliente,
  });
}

module.exports = {
  home,
  busca,
  barbearia,
  agendar,
  confirmar,
  agendamentoDetalhe,
  agendamentos,
  perfil,
};
