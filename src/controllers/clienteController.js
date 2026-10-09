// Controlador do cadastro de clientes.
// Acessível a admin e funcionários (rota sem exigeAdmin) — útil no balcão.
// Regra principal: telefone único por barbearia, comparado de forma NORMALIZADA (só dígitos).
const prisma = require('../config/db');
const { normalizarTelefone } = require('../utils/telefone');
const planoServ = require('../services/plano');
const { DIAS_SEMANA } = require('../config/constantes');
const permissoes = require('../services/permissoes');

// Spec 12 (B2): sem `clientes_contato`, o telefone do cliente chega à tela só
// com o final (a tela não recebe o dado que não vai mostrar).
function veContato(req) {
  return !req.permissoes || req.permissoes.pode('clientes_contato');
}

const DIAS_SUMIDO = 30; // mesmo limite usado no HTML original (lastVisitDays >= 30)

// Rótulos amigáveis do plano pra folha do cliente (usos, validade, dias).
function usosLabelPlano(a) {
  if (a.usosRestantes === null) return 'ilimitado';
  const porServ = planoServ.usosPorServicoTexto(a);
  return porServ || `${a.usosRestantes} uso(s) restante(s)`;
}
function diasLabelPlano(diasSemana) {
  const todos = '0,1,2,3,4,5,6';
  const s = String(diasSemana || todos).trim();
  if (!s || s === todos) return null; // sem restrição: não precisa mostrar
  return s.split(',').map((n) => DIAS_SEMANA[Number(n)]).filter(Boolean).join(', ');
}

// Estatísticas por cliente (gasto total, última visita, serviço/barbeiro mais
// frequentes) — calculadas a partir do histórico real de agendamentos
// concluídos, diferente do protótipo (que usava campos soltos fixos).
function calcularStats(agendamentos) {
  const concluidos = agendamentos.filter((a) => a.status === 'concluido').sort((a, b) => new Date(a.data) - new Date(b.data));

  const totalGasto = concluidos.reduce((soma, a) => soma + a.valorTotal, 0);

  const contagemServico = new Map();
  const contagemBarbeiro = new Map();
  concluidos.forEach((a) => {
    contagemBarbeiro.set(a.usuario.nome, (contagemBarbeiro.get(a.usuario.nome) || 0) + 1);
    a.itens.forEach((it) => {
      contagemServico.set(it.servico.nome, (contagemServico.get(it.servico.nome) || 0) + 1);
    });
  });
  const maisFrequente = (mapa) => {
    let melhor = null;
    let max = 0;
    mapa.forEach((qtd, nome) => { if (qtd > max) { max = qtd; melhor = nome; } });
    return melhor;
  };

  let diasDesdeUltima = null;
  let frequenciaDias = null;
  if (concluidos.length > 0) {
    const ultima = concluidos[concluidos.length - 1].data;
    diasDesdeUltima = Math.floor((Date.now() - new Date(ultima).getTime()) / 86400000);
  }
  if (concluidos.length >= 2) {
    const primeira = new Date(concluidos[0].data).getTime();
    const ultima = new Date(concluidos[concluidos.length - 1].data).getTime();
    frequenciaDias = Math.round((ultima - primeira) / 86400000 / (concluidos.length - 1));
  }

  return {
    totalGasto,
    visitas: concluidos.length,
    diasDesdeUltima,
    ultimaVisitaLabel: rotuloVisita(diasDesdeUltima),
    frequenciaDias,
    servicoFavorito: maisFrequente(contagemServico),
    barbeiroFavorito: maisFrequente(contagemBarbeiro),
    sumido: diasDesdeUltima !== null && diasDesdeUltima >= DIAS_SUMIDO,
  };
}

// "há 12 dias" / "ontem" / "nunca veio". Vem do controller (e não da view)
// porque o design suave (2026-07-31) mostra o mesmo rótulo em dois lugares —
// no cartão da lista e no subtítulo da folha de detalhe.
function rotuloVisita(dias) {
  if (dias === null) return 'nunca veio';
  if (dias === 0) return 'hoje';
  if (dias === 1) return 'ontem';
  return 'há ' + dias + ' dias';
}

function iniciais(nome) {
  return nome.split(' ').filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

// "YYYY-MM-DD" do dia atual (meia-noite local)
function isoHoje() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// GET /painel/clientes — lista + pop-up de detalhe por cliente (tudo numa
// tela só, igual ao HTML original — sem página de detalhe separada).
async function listar(req, res) {
  const b = req.barbeariaId;
  const clientes = await prisma.cliente.findMany({
    where: { barbeariaId: b },
    orderBy: { nome: 'asc' },
    include: {
      agendamentos: { include: { usuario: true, itens: { include: { servico: true } } }, orderBy: [{ data: 'desc' }, { horaInicio: 'desc' }] },
      planos: { include: { plano: { include: { servicos: { include: { servico: true } } } } }, orderBy: { criadoEm: 'desc' } },
    },
  });

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const planosDisponiveis = await prisma.plano.findMany({ where: { barbeariaId: b, ativo: true }, orderBy: { nome: 'asc' } });

  // "Aniversariante" = nasceu no mês corrente. O Turno 6 (2026-07-28) filtra a
  // lista por isso e mostra a contagem no resumo do topo, então o cálculo sai
  // do template e vem pronto para cada cliente.
  const mesAtual = hoje.getMonth();

  const clientesComStats = clientes.map((c) => {
    const stats = calcularStats(c.agendamentos);
    const assinaturas = c.planos.map((a) => ({
      ...a,
      vigente: a.ativo && new Date(a.dataFim) >= hoje && (a.usosRestantes === null || a.usosRestantes > 0),
      usosLabel: usosLabelPlano(a),
      validadeLabel: a.dataFim ? new Date(a.dataFim).toLocaleDateString('pt-BR') : null,
      diasLabel: diasLabelPlano(a.plano && a.plano.diasSemana),
    }));
    const aniversarianteMes = !!c.dataNascimento && new Date(c.dataNascimento).getMonth() === mesAtual;
    // "YYYY-MM-DD" para o <input type="date"> da folha de detalhe. A data é
    // gravada ao meio-dia local justamente para que o corte em UTC não puxe
    // o dia para trás aqui.
    const nascimentoIso = c.dataNascimento ? new Date(c.dataNascimento).toISOString().slice(0, 10) : '';
    const telefone = veContato(req) ? c.telefone : permissoes.mascararTelefone(c.telefone);
    // Os agendamentos do histórico também carregam o telefone: sai mascarado junto.
    const agendamentos = veContato(req) ? c.agendamentos : c.agendamentos.map((a) => ({ ...a, clienteTelefone: permissoes.mascararTelefone(a.clienteTelefone) }));
    return { ...c, telefone, agendamentos, telefoneOculto: !veContato(req), iniciais: iniciais(c.nome), stats, assinaturas, aniversarianteMes, nascimentoIso };
  });

  // Resumo do topo ("Na base"): o número grande é o tamanho da carteira, e as
  // duas linhas abaixo espelham exatamente os dois filtros disponíveis.
  const resumo = {
    total: clientesComStats.length,
    sumidos: clientesComStats.filter((c) => c.stats.sumido).length,
    aniversariantes: clientesComStats.filter((c) => c.aniversarianteMes).length,
  };

  res.render('painel/clientes', { titulo: 'Clientes', clientes: clientesComStats, planosDisponiveis, resumo, hojeIso: isoHoje() });
}

// POST /painel/clientes — cadastra um cliente
async function criar(req, res) {
  const b = req.barbeariaId;
  const nome = (req.body.nome || '').trim();
  const telefone = normalizarTelefone(req.body.telefone);

  if (!nome || !telefone) {
    req.session.flash = { tipo: 'erro', texto: 'Informe nome e telefone.' };
    return res.redirect('/painel/clientes');
  }

  // Unicidade do telefone (normalizado) dentro da barbearia
  const existe = await prisma.cliente.findUnique({ where: { barbeariaId_telefone: { barbeariaId: b, telefone } } });
  if (existe) {
    req.session.flash = { tipo: 'erro', texto: 'Já existe um cliente com esse telefone.' };
    return res.redirect('/painel/clientes');
  }

  const dataNascimento = req.body.dataNascimento ? new Date(req.body.dataNascimento + 'T12:00:00') : null;
  await prisma.cliente.create({ data: { barbeariaId: b, nome, telefone, dataNascimento } });
  req.session.flash = { tipo: 'sucesso', texto: 'Cliente cadastrado.' };
  res.redirect('/painel/clientes');
}

// POST /painel/clientes/:id — atualiza os campos editáveis do pop-up
async function atualizar(req, res) {
  const b = req.barbeariaId;
  const id = Number(req.params.id);
  const cliente = await prisma.cliente.findFirst({ where: { id, barbeariaId: b } });
  if (!cliente) return res.redirect('/painel/clientes');

  // Sem `clientes_contato` a tela mostra o telefone mascarado; o que voltar no
  // formulário é ignorado, senão "•••• 4321" viraria o telefone "4321".
  const telefone = veContato(req) ? normalizarTelefone(req.body.telefone) : cliente.telefone;
  if (!telefone) {
    req.session.flash = { tipo: 'erro', texto: 'Informe um telefone válido.' };
    return res.redirect('/painel/clientes');
  }

  // O telefone não pode ser de OUTRO cliente da mesma barbearia
  const outro = await prisma.cliente.findUnique({ where: { barbeariaId_telefone: { barbeariaId: b, telefone } } });
  if (outro && outro.id !== id) {
    req.session.flash = { tipo: 'erro', texto: 'Já existe um cliente com esse telefone.' };
    return res.redirect('/painel/clientes');
  }

  const dataNascimento = req.body.dataNascimento ? new Date(req.body.dataNascimento + 'T12:00:00') : null;
  const observacoes = (req.body.observacoes || '').trim() || null;
  await prisma.cliente.update({ where: { id }, data: { telefone, dataNascimento, observacoes } });
  req.session.flash = { tipo: 'sucesso', texto: 'Cliente atualizado.' };
  res.redirect('/painel/clientes');
}

// POST /painel/clientes/:id/planos — atribui um plano ao cliente (entrada no caixa na compra)
async function adicionarPlano(req, res) {
  const b = req.barbeariaId;
  const clienteId = Number(req.params.id);
  const cliente = await prisma.cliente.findFirst({ where: { id: clienteId, barbeariaId: b } });
  if (!cliente) return res.redirect('/painel/clientes');

  const plano = await prisma.plano.findFirst({ where: { id: Number(req.body.planoId), barbeariaId: b, ativo: true }, include: { servicos: true } });
  if (!plano) {
    req.session.flash = { tipo: 'erro', texto: 'Selecione um plano válido.' };
    return res.redirect('/painel/clientes');
  }

  const dataInicio = req.body.dataInicio ? new Date(req.body.dataInicio + 'T12:00:00') : new Date();
  const dataFim = new Date(dataInicio);
  dataFim.setDate(dataFim.getDate() + plano.validadeDias);
  // Plano com cota por serviço: guarda o saldo de cada um; o total é a soma.
  const mapa = planoServ.mapaInicial(plano);
  const usosRestantes = mapa ? Object.values(mapa).reduce((s, n) => s + n, 0) : (plano.tipo === 'limitado' ? plano.usos : null);

  await prisma.clientePlano.create({
    data: { barbeariaId: b, clienteId, planoId: plano.id, dataInicio, dataFim, usosRestantes, usosPorServico: mapa ? JSON.stringify(mapa) : null, ativo: true },
  });

  if (plano.valor > 0) {
    await prisma.caixa.create({
      data: {
        barbeariaId: b,
        descricao: 'Plano: ' + plano.nome + ' — ' + cliente.nome,
        valor: plano.valor,
        tipo: 'entrada',
        data: new Date(),
        categoriaId: null,
      },
    });
  }

  req.session.flash = { tipo: 'sucesso', texto: 'Plano adicionado ao cliente.' };
  res.redirect('/painel/clientes');
}

// POST /painel/clientes/planos/:id/remover — remove uma assinatura do cliente
async function removerPlano(req, res) {
  const assinatura = await prisma.clientePlano.findFirst({ where: { id: Number(req.params.id), barbeariaId: req.barbeariaId } });
  if (assinatura) await prisma.clientePlano.delete({ where: { id: assinatura.id } }).catch(() => {});
  req.session.flash = { tipo: 'sucesso', texto: 'Plano removido do cliente.' };
  res.redirect('/painel/clientes');
}

// POST /painel/clientes/:id/remover — exclui o cliente
async function remover(req, res) {
  await prisma.cliente
    .deleteMany({ where: { id: Number(req.params.id), barbeariaId: req.barbeariaId } })
    .catch(() => {});
  req.session.flash = { tipo: 'sucesso', texto: 'Cliente removido.' };
  res.redirect('/painel/clientes');
}

module.exports = { listar, criar, atualizar, remover, adicionarPlano, removerPlano };
