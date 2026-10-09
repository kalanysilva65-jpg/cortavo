// Controlador da agenda interna (equipe).
// Regras de acesso (verificadas no backend):
//  - Funcionário vê e altera SOMENTE a própria agenda.
//  - Admin (e o dono operando a barbearia) vê a agenda de todos e altera qualquer um.
// Tudo é escopado pela barbearia do contexto (req.barbeariaId).
const prisma = require('../config/db');
const precos = require('../services/precos');
const { dataLocal, paraMinutos, duracaoEfetiva, todosHorarios, duracaoComEncaixe } = require('../services/disponibilidade');
const { DIAS_SEMANA, INTERVALO_SLOT_MIN } = require('../config/constantes');
const { normalizarTelefone } = require('../utils/telefone');
const permissoes = require('../services/permissoes');

// Spec 12 (B2): sem `clientes_contato`, telefone de cliente só com o final.
function veContato(req) {
  return !req.permissoes || req.permissoes.pode('clientes_contato');
}
function clientesParaTela(req, clientes) {
  return veContato(req) ? clientes : clientes.map((c) => ({ ...c, telefone: permissoes.mascararTelefone(c.telefone) }));
}
const caixaServ = require('../services/caixa');
const planoServ = require('../services/plano');
const estoqueServ = require('../services/estoque');

// Formas de pagamento oferecidas ao concluir um atendimento. Rótulos CURTOS
// (design suave, 2026-07-31): viram pílulas dentro do cartão preto do detalhe,
// onde "Cartão de Crédito" quebraria a linha. Os VALORES são os mesmos do
// caixa — é o que o serviço de caixa lê ao gerar a entrada automática.
const FORMAS_PAGAMENTO = [
  { valor: 'pix', label: 'Pix' },
  { valor: 'credito', label: 'Crédito' },
  { valor: 'debito', label: 'Débito' },
  { valor: 'dinheiro', label: 'Dinheiro' },
];

const MESES_EXT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Date -> meia-noite local do mesmo dia.
function inicioDoDia(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Id vindo da URL -> inteiro, ou 0 se não for número. `Number('abc')` é NaN, e
// o Prisma recusa NaN com erro não tratado (tela de 500 em vez de "não achei").
function idNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// A data veio no formato certo? Mesma razão do `idNum`: `dataLocal('lixo')` dá
// `Invalid Date`, que o Prisma recusa com erro não tratado. `?data=lixo`
// derrubava a agenda inteira com tela de erro em vez de simplesmente cair no
// dia de hoje.
function dataValida(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(dataLocal(s).getTime());
}

// Parcelamento só faz sentido no crédito; nas outras formas fica travado em 1.
const MAX_PARCELAS = 12;
const FORMAS_PARCELAVEIS = new Set(['credito']);

// Normaliza a divisão de pagamento vinda do formulário.
//
// Aceita duas formas porque o mesmo endpoint atende o pop-up (que manda JSON,
// para não recarregar a tela) e um POST comum de formulário:
//   - JSON:  pagamentos: [{ forma, valorCentavos, parcelas }]
//   - form:  pagForma[]=pix&pagValor[]=20,00&pagParcelas[]=1
//
// A unidade vai no NOME do campo de propósito. Quando os dois caminhos usavam
// só `valor`, o pop-up mandava centavos e o servidor lia como reais: R$30
// virava R$3.000 e a conclusão era recusada por "não fechar". Com
// `valorCentavos` separado de `valor` (reais, como o usuário digita) não dá
// para confundir de novo.
function lerPagamentos(body) {
  let brutos = [];
  if (Array.isArray(body.pagamentos)) {
    brutos = body.pagamentos;
  } else {
    const formas = [].concat(body.pagForma || []);
    const valores = [].concat(body.pagValor || []);
    const parcelas = [].concat(body.pagParcelas || []);
    brutos = formas.map((f, i) => ({ forma: f, valor: valores[i], parcelas: parcelas[i] }));
  }

  const partes = [];
  for (const b of brutos) {
    const forma = String(b.forma || '').trim();
    if (!FORMAS_PAGAMENTO.some((f) => f.valor === forma)) continue;

    // "45,90" e "45.90" são a mesma coisa para quem digita; só o ponto é que o
    // parseFloat entende.
    const centavos =
      b.valorCentavos !== undefined
        ? Math.trunc(Number(b.valorCentavos))
        : Math.round(parseFloat(String(b.valor).replace(',', '.')) * 100);
    if (!Number.isFinite(centavos) || centavos <= 0) continue;

    let parcelas = Math.trunc(Number(b.parcelas) || 1);
    if (!FORMAS_PARCELAVEIS.has(forma) || parcelas < 1) parcelas = 1;
    if (parcelas > MAX_PARCELAS) parcelas = MAX_PARCELAS;

    partes.push({ formaPagamento: forma, valor: centavos, parcelas });
  }
  return partes;
}

// Date -> "YYYY-MM-DD"
function iso(data) {
  const a = data.getFullYear();
  const m = String(data.getMonth() + 1).padStart(2, '0');
  const d = String(data.getDate()).padStart(2, '0');
  return `${a}-${m}-${d}`;
}

// Recalcula o valor_total do agendamento a partir dos seus itens.
//
// EXCEÇÃO: se o total foi ajustado à mão (`totalManual`), ele MANDA e não é
// recalculado — decisão do dono em 2026-08-13: "o valor lá de cima tem que ser
// o principal". A lista de itens continua registrando o que foi feito no
// atendimento; ela só deixa de mandar no que se cobra.
async function recalcularTotal(agendamentoId) {
  const itens = await prisma.agendamentoItem.findMany({ where: { agendamentoId } });
  const soma = itens.reduce((s, it) => s + it.valorUnitario * it.quantidade, 0);

  const ag = await prisma.agendamento.findUnique({
    where: { id: agendamentoId },
    select: { totalManual: true, valorTotal: true },
  });
  if (ag && ag.totalManual) return ag.valorTotal;

  await prisma.agendamento.update({ where: { id: agendamentoId }, data: { valorTotal: soma } });
  return soma;
}

// Depois de QUALQUER mudança no total (item somado, removido ou com o valor
// alterado), a divisão de pagamento de um atendimento já CONCLUÍDO pode não
// fechar mais com o total. Deixar assim faria o caixa guardar um valor
// diferente do atendimento — receita errada, e em silêncio.
//
// Uma forma só: o novo total foi todo nela, sem ambiguidade — ajusta e pronto.
// Dividido em várias: não há como saber como o novo total se reparte entre
// elas, e "chutar" a divisão seria inventar registro financeiro. Nesse caso
// limpa a divisão e devolve o atendimento para "agendado", para ser concluído
// de novo com o pagamento certo.
async function reconciliarPagamentos(agendamentoId) {
  const ag = await prisma.agendamento.findUnique({
    where: { id: agendamentoId },
    include: { pagamentos: true },
  });
  if (!ag || ag.status !== 'concluido') return null;

  const soma = ag.pagamentos.reduce((s, p) => s + p.valor, 0);
  if (soma === ag.valorTotal) return null; // continua fechando: nada a fazer

  if (ag.pagamentos.length <= 1) {
    if (ag.pagamentos.length === 1) {
      await prisma.pagamentoAgendamento.update({
        where: { id: ag.pagamentos[0].id },
        data: { valor: ag.valorTotal },
      });
    }
    const atual = await prisma.agendamento.findUnique({ where: { id: agendamentoId } });
    await caixaServ.registrarEntradaAgendamento(atual);
    return null;
  }

  await prisma.pagamentoAgendamento.deleteMany({ where: { agendamentoId } });
  await caixaServ.removerEntradaAgendamento(agendamentoId);
  await prisma.agendamento.update({
    where: { id: agendamentoId },
    // `concluidoEm` sai junto: o atendimento deixou de estar concluído, e o
    // faturamento dele precisa sair do dia em que estava contado.
    data: { status: 'agendado', formaPagamento: null, concluidoEm: null },
  });
  return 'O total mudou e o pagamento estava dividido em mais de uma forma. O atendimento voltou para "em aberto" — conclua de novo informando como ficou o pagamento.';
}

// Confere se o usuário logado pode mexer no agendamento (admin/dono, ou o próprio barbeiro).
function podeAlterar(req, agendamento) {
  return req.ehAdmin || agendamento.usuarioId === req.session.usuario.id;
}

function negarAcesso(res) {
  return res.status(403).render('erro', {
    layout: 'layouts/blank',
    titulo: 'Acesso negado',
    mensagem: 'Você só pode alterar os seus próprios agendamentos.',
  });
}

// Monta a URL de retorno para a agenda, preservando data e filtro de barbeiro.
function urlRetorno(req) {
  const qs = new URLSearchParams();
  if (req.body.retornoData) qs.set('data', req.body.retornoData);
  if (req.body.retornoBarbeiro) qs.set('barbeiro', req.body.retornoBarbeiro);
  const s = qs.toString();
  return '/painel/agenda' + (s ? '?' + s : '');
}

// "4500" (centavos) -> "R$ 45,00"
function fmtBRL(centavos) {
  return 'R$ ' + (Number(centavos || 0) / 100).toFixed(2).replace('.', ',');
}

// A folha de detalhe da agenda conversa por fetch, para que mexer nela (somar
// item, concluir, cancelar) não jogue o usuário de volta pra lista — era o que
// acontecia quando toda ação era POST + redirect. O resto do painel continua
// mandando formulário comum, então os mesmos controllers respondem dos dois
// jeitos conforme o `Accept` da requisição.
function querJson(req) {
  return (req.get('Accept') || '').includes('application/json');
}

function responderOk(req, res, aviso) {
  if (querJson(req)) return res.json(aviso ? { ok: true, aviso } : { ok: true });
  if (aviso) req.session.flash = { tipo: 'erro', texto: aviso };
  return res.redirect(urlRetorno(req));
}

function falhar(req, res, texto) {
  if (querJson(req)) return res.status(400).json({ erro: texto });
  req.session.flash = { tipo: 'erro', texto };
  return res.redirect(urlRetorno(req));
}

// GET /painel/agenda
async function verAgenda(req, res) {
  const usuario = req.session.usuario;
  const ehAdmin = req.ehAdmin;
  const b = req.barbeariaId;

  // Data selecionada (padrão: hoje)
  const dataStr = dataValida(req.query.data) ? req.query.data : iso(new Date());
  const dataObj = dataLocal(dataStr);

  // Mostra sempre um dia só (como sempre foi) — a faixa de dias é que agora
  // é rolável e cobre o mês inteiro, em vez de só a semana.
  const periodoInicio = new Date(dataObj);
  const periodoFimExcl = new Date(dataObj);
  periodoFimExcl.setDate(periodoFimExcl.getDate() + 1);

  // Filtro de barbeiro:
  //  - Funcionário: sempre o próprio (ignora a query).
  //  - Admin: 'todos' ou um id específico; padrão = a própria agenda.
  let filtroBarbeiro = null; // null = todos
  let barbeiroSelecionado;
  if (ehAdmin) {
    barbeiroSelecionado = req.query.barbeiro || String(usuario.id);
    if (barbeiroSelecionado !== 'todos') filtroBarbeiro = Number(barbeiroSelecionado);
  } else {
    barbeiroSelecionado = String(usuario.id);
    filtroBarbeiro = usuario.id;
  }

  const where = { barbeariaId: b, data: { gte: periodoInicio, lt: periodoFimExcl } };
  if (filtroBarbeiro) where.usuarioId = filtroBarbeiro;

  const agendamentos = await prisma.agendamento.findMany({
    where,
    include: {
      usuario: true,
      itens: { include: { servico: true } },
      pagamentos: { orderBy: { id: 'asc' } },
      clientePlano: { include: { plano: true } },
    },
    orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
  });

  const barbeiros = ehAdmin
    ? await prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true }, orderBy: { id: 'asc' } })
    : [];
  const servicos = await prisma.servico.findMany({ where: { barbeariaId: b, ativo: true }, orderBy: { nome: 'asc' } });
  // Clientes cadastrados — usado no autocomplete do pop-up "Novo agendamento".
  const clientes = clientesParaTela(req, await prisma.cliente.findMany({
    where: { barbeariaId: b },
    select: { id: true, nome: true, telefone: true },
    orderBy: { nome: 'asc' },
  }));

  // Bloqueios do dia (mesmo filtro de barbeiro) — aparecem na linha do tempo.
  const whereBloq = { barbeariaId: b, data: { gte: periodoInicio, lt: periodoFimExcl } };
  if (filtroBarbeiro) whereBloq.usuarioId = filtroBarbeiro;
  const bloqueios = await prisma.bloqueio.findMany({
    where: whereBloq,
    include: { usuario: true },
    orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
  });

  // Navegação de datas (dia anterior / seguinte)
  const prev = new Date(dataObj);
  prev.setDate(prev.getDate() - 1);
  const next = new Date(dataObj);
  next.setDate(next.getDate() + 1);

  const hoje0 = new Date();
  hoje0.setHours(0, 0, 0, 0);

  // Faixa de dias (design novo): TODOS os dias do mês da data selecionada,
  // numa tira ROLÁVEL (pedido do dono — antes era só a semana, fixa).
  const anoMes = dataObj.getFullYear();
  const mesMes = dataObj.getMonth();
  const ultimoDiaMes = new Date(anoMes, mesMes + 1, 0).getDate();
  const faixaDias = [];
  for (let dia = 1; dia <= ultimoDiaMes; dia++) {
    const d = new Date(anoMes, mesMes, dia);
    faixaDias.push({
      iso: iso(d),
      num: dia,
      rotulo: DIAS_SEMANA[d.getDay()].slice(0, 3),
      selecionado: iso(d) === iso(dataObj),
      ehHoje: d.getTime() === hoje0.getTime(),
    });
  }

  // Pop-up de escolher mês: ano navegável (?anoPicker=) + grade dos 12 meses;
  // clicar num mês pula pro dia 1 dele.
  const anoPicker = /^\d{4}$/.test(req.query.anoPicker || '') ? Number(req.query.anoPicker) : anoMes;
  const mesesPicker = MESES_EXT.map((nome, i) => ({
    nome,
    iso: `${anoPicker}-${String(i + 1).padStart(2, '0')}-01`,
    atual: anoPicker === anoMes && i === mesMes,
  }));

  // --- Atendimento "da vez" ------------------------------------------------
  // O próximo que ainda não passou sai INVERTIDO (preto) na lista — é assim
  // que a referência do design suave destaca o atendimento atual, sem precisar
  // de ponto, borda ou cor de status (pedido do dono, 2026-07-31). Em um dia
  // que não é hoje, "da vez" é simplesmente o primeiro em aberto.
  function _minT6(hhmm) {
    const p = String(hhmm).split(':');
    return (+p[0]) * 60 + (+p[1]);
  }
  const ehHojeSelecionado = dataObj.getTime() === hoje0.getTime();
  const agoraT6 = new Date();
  const minutoAgora = agoraT6.getHours() * 60 + agoraT6.getMinutes();
  const aindaAbertos = agendamentos.filter((a) => a.status === 'agendado');
  const proximoAg = ehHojeSelecionado
    ? aindaAbertos.find((a) => _minT6(a.horaInicio) >= minutoAgora) || null
    : aindaAbertos[0] || null;

  res.render('painel/agenda', {
    titulo: 'Agenda',
    ehAdmin,
    faixaDias,
    diaNum: dataObj.getDate(),
    proxDiaNum: next.getDate(),
    proximoId: proximoAg ? proximoAg.id : null,
    mesLabel: MESES_EXT[mesMes],
    anoMes,
    anoPicker,
    mesesPicker,
    agendamentos,
    bloqueios,
    barbeiros,
    servicos,
    clientes,
    // Formas de pagamento do detalhe do atendimento: viajam no mesmo POST que
    // conclui, que é quando o cliente paga. A conta pode ser dividida em
    // várias formas, e a parte no crédito pode ser parcelada.
    formasPagamento: FORMAS_PAGAMENTO,
    maxParcelas: MAX_PARCELAS,
    dataStr,
    dataExtenso: `${DIAS_SEMANA[dataObj.getDay()]}, ${res.locals.fmtData(dataObj)}`,
    barbeiroSelecionado,
    dataPrev: iso(prev),
    dataNext: iso(next),
    dataHoje: iso(new Date()),
    hojeIso: iso(new Date()),
    mostrarBarbeiroNoCard: !filtroBarbeiro, // mostra o nome do barbeiro quando vê "todos"
  });
}

// POST /painel/agenda/:id/itens — adiciona um serviço/produto ao agendamento
async function adicionarItem(req, res) {
  const b = req.barbeariaId;
  const agendamento = await prisma.agendamento.findFirst({
    where: { id: idNum(req.params.id), barbeariaId: b },
  });
  if (!agendamento) return res.redirect('/painel/agenda');
  if (!podeAlterar(req, agendamento)) return negarAcesso(res);

  const servico = await prisma.servico.findFirst({
    where: { id: idNum(req.body.servicoId), barbeariaId: b, ativo: true },
  });
  const quantidade = Math.max(1, Number(req.body.quantidade) || 1);

  let aviso = null;
  if (servico) {
    // Preço do barbeiro DESTE agendamento (pode diferir do padrão).
    const [comPreco] = await precos.comPrecoDoBarbeiro([servico], agendamento.usuarioId);
    await prisma.agendamentoItem.create({
      data: {
        agendamentoId: agendamento.id,
        servicoId: servico.id,
        valorUnitario: comPreco.valor, // congela o preço atual (editável depois)
        quantidade,
      },
    });
    await recalcularTotal(agendamento.id);
    aviso = await reconciliarPagamentos(agendamento.id);
    req.session.flash = { tipo: 'sucesso', texto: 'Item adicionado.' };
  } else {
    req.session.flash = { tipo: 'erro', texto: 'Selecione um item válido.' };
  }
  responderOk(req, res, aviso);
}

// POST /painel/agenda/itens/:id/remover — remove um item do agendamento
async function removerItem(req, res) {
  const item = await prisma.agendamentoItem.findUnique({
    where: { id: idNum(req.params.id) },
    include: { agendamento: true },
  });
  if (!item || item.agendamento.barbeariaId !== req.barbeariaId) return res.redirect('/painel/agenda');
  if (!podeAlterar(req, item.agendamento)) return negarAcesso(res);

  await prisma.agendamentoItem.delete({ where: { id: item.id } });
  await recalcularTotal(item.agendamentoId);
  const aviso = await reconciliarPagamentos(item.agendamentoId);
  req.session.flash = { tipo: 'sucesso', texto: 'Item removido.' };
  responderOk(req, res, aviso);
}

// POST /painel/agenda/itens/:id/valor — muda o preço de um item DENTRO deste
// atendimento (desconto, cobrança a mais, combinado com o cliente).
//
// Mexe só em `valorUnitario` do item, nunca no catálogo: o preço do serviço
// para os próximos atendimentos continua o mesmo. Era justamente para isso que
// o valor já era "congelado" na criação do item.
async function alterarValorItem(req, res) {
  const item = await prisma.agendamentoItem.findUnique({
    where: { id: idNum(req.params.id) },
    include: { agendamento: true },
  });
  if (!item || item.agendamento.barbeariaId !== req.barbeariaId) {
    return falhar(req, res, 'Item não encontrado.');
  }
  if (!podeAlterar(req, item.agendamento)) return negarAcesso(res);

  // Mesma convenção do pagamento: `valorCentavos` (do pop-up, já em centavos)
  // ou `valor` (de formulário, em reais).
  const centavos =
    req.body.valorCentavos !== undefined
      ? Math.trunc(Number(req.body.valorCentavos))
      : Math.round(parseFloat(String(req.body.valor).replace(',', '.')) * 100);

  // Zero é válido (cortesia); negativo não existe.
  if (!Number.isFinite(centavos) || centavos < 0) {
    return falhar(req, res, 'Informe um valor válido.');
  }

  const quantidade = Math.max(1, Math.trunc(Number(req.body.quantidade) || item.quantidade));

  await prisma.agendamentoItem.update({
    where: { id: item.id },
    data: { valorUnitario: centavos, quantidade },
  });
  await recalcularTotal(item.agendamentoId);
  const aviso = await reconciliarPagamentos(item.agendamentoId);
  responderOk(req, res, aviso);
}

// POST /painel/agenda/:id/total — ajusta o total a receber deste atendimento.
//
// Ajustado aqui, o total vira a REFERÊNCIA do atendimento: mexer nos itens
// depois não o recalcula mais (ver `recalcularTotal`). É o que o dono pediu em
// 2026-08-13 — o valor do topo é o combinado com o cliente, e a lista de itens
// serve para registrar o que foi feito, não para mandar no preço.
//
// `auto: true` desfaz o ajuste e devolve o total a seguir a soma dos itens —
// sem isso não haveria volta depois de digitar um valor.
async function alterarTotal(req, res) {
  const b = req.barbeariaId;
  const agendamento = await prisma.agendamento.findFirst({
    where: { id: idNum(req.params.id), barbeariaId: b },
  });
  if (!agendamento) return falhar(req, res, 'Atendimento não encontrado.');
  if (!podeAlterar(req, agendamento)) return negarAcesso(res);

  if (req.body.auto) {
    await prisma.agendamento.update({
      where: { id: agendamento.id },
      data: { totalManual: false },
    });
    await recalcularTotal(agendamento.id);
  } else {
    const centavos =
      req.body.valorCentavos !== undefined
        ? Math.trunc(Number(req.body.valorCentavos))
        : Math.round(parseFloat(String(req.body.valor).replace(',', '.')) * 100);

    // Zero é válido (cortesia); negativo não existe.
    if (!Number.isFinite(centavos) || centavos < 0) {
      return falhar(req, res, 'Informe um valor válido.');
    }

    await prisma.agendamento.update({
      where: { id: agendamento.id },
      data: { valorTotal: centavos, totalManual: true },
    });
  }

  const aviso = await reconciliarPagamentos(agendamento.id);
  responderOk(req, res, aviso);
}

// POST /painel/agenda/:id/status — muda o status do agendamento
async function mudarStatus(req, res) {
  const b = req.barbeariaId;
  const agendamento = await prisma.agendamento.findFirst({
    where: { id: idNum(req.params.id), barbeariaId: b },
  });
  if (!agendamento) return res.redirect('/painel/agenda');
  if (!podeAlterar(req, agendamento)) return negarAcesso(res);

  const novo = req.body.status;
  if (['agendado', 'concluido', 'cancelado'].includes(novo)) {
    // Forma de pagamento: registrada junto ao concluir (é quando o cliente paga).
    // Reabrir/cancelar limpa o registro, senão ficaria uma forma de pagamento
    // pendurada num atendimento que não aconteceu.
    const dados = { status: novo };
    let partes = [];

    if (novo === 'concluido') {
      partes = lerPagamentos(req.body);

      // Formulário antigo (uma forma só, sem valor): vira uma parte com o total.
      if (!partes.length && FORMAS_PAGAMENTO.some((f) => f.valor === req.body.formaPagamento)) {
        partes = [{ formaPagamento: req.body.formaPagamento, valor: agendamento.valorTotal, parcelas: 1 }];
      }

      // A soma das partes tem que fechar com o total: o caixa é alimentado a
      // partir delas, então divergir aqui faria a receita do dia não bater com
      // os atendimentos. Continua valendo concluir SEM informar pagamento
      // (partes vazias) — é o comportamento de sempre.
      if (partes.length) {
        const soma = partes.reduce((s, p) => s + p.valor, 0);
        if (soma !== agendamento.valorTotal) {
          return falhar(
            req,
            res,
            `A divisão soma ${fmtBRL(soma)}, mas o atendimento é ${fmtBRL(agendamento.valorTotal)}.`
          );
        }
      }

      // Resumo no próprio agendamento: com uma forma só, guarda qual foi (é o
      // que as telas antigas leem). Dividido, fica nulo — a verdade está em
      // `pagamentos`, e eleger "a" forma de um pagamento dividido seria mentira.
      dados.formaPagamento = partes.length === 1 ? partes[0].formaPagamento : null;

      // Carimba QUANDO foi concluído — é por este instante que o faturamento é
      // contado, não pelo dia do atendimento. Reconcluir um atendimento que já
      // estava concluído (ex.: para trocar a forma de pagamento) NÃO remarca a
      // data: o dinheiro entrou na primeira vez, e remarcar moveria receita
      // já fechada de um dia para outro.
      if (agendamento.status !== 'concluido') dados.concluidoEm = new Date();
    } else {
      dados.formaPagamento = null;
      // Reabrir ou cancelar desfaz a conclusão: o valor sai do dia em que
      // estava contado, senão sobraria faturamento de um atendimento que não
      // aconteceu.
      dados.concluidoEm = null;
    }

    await prisma.agendamento.update({ where: { id: agendamento.id }, data: dados });

    // Regrava a divisão do zero: reconcluir com outro pagamento tem que
    // substituir o anterior, não somar em cima.
    await prisma.pagamentoAgendamento.deleteMany({ where: { agendamentoId: agendamento.id } });
    if (partes.length) {
      await prisma.pagamentoAgendamento.createMany({
        data: partes.map((p) => ({ ...p, barbeariaId: b, agendamentoId: agendamento.id })),
      });
    }

    // Integração com o caixa:
    if (novo === 'concluido') {
      // Concluir SEMPRE gera a entrada no caixa (com o total atualizado). Antes
      // dependia do toggle "caixa automático", que nascia DESLIGADO e não tinha
      // como ligar (o interruptor saiu da tela) — então concluir não virava
      // faturamento. O toggle foi removido; concluir = entra no caixa, sempre.
      const atual = await prisma.agendamento.findUnique({ where: { id: agendamento.id } });
      await caixaServ.registrarEntradaAgendamento(atual);
    } else {
      // Reabrir (agendado) ou cancelar: remove eventual entrada automática.
      await caixaServ.removerEntradaAgendamento(agendamento.id);
    }

    // Estoque: baixa na 1ª conclusão e devolve ao reabrir/cancelar um concluído.
    // Mesma lógica de transição do `concluidoEm` (compara o status ANTERIOR com
    // o novo), pra não baixar duas vezes numa reconclusão nem esquecer de
    // devolver. Só age se o serviço/produto tiver receita de consumo cadastrada.
    const eraConcluido = agendamento.status === 'concluido';
    const ficaConcluido = novo === 'concluido';
    if (!eraConcluido && ficaConcluido) await estoqueServ.aplicarConsumo(agendamento.id, -1);
    else if (eraConcluido && !ficaConcluido) await estoqueServ.aplicarConsumo(agendamento.id, +1);

    // Ajuste de uso do plano (cancelar devolve 1 uso; reabrir volta a consumir).
    if (agendamento.clientePlanoId) {
      const eraAtivo = agendamento.status !== 'cancelado';
      const ficaAtivo = novo !== 'cancelado';
      const cobertos = await planoServ.servicosCobertosDe(agendamento.id);
      if (eraAtivo && !ficaAtivo) await planoServ.ajustarUso(agendamento.clientePlanoId, +1, cobertos);
      else if (!eraAtivo && ficaAtivo) await planoServ.ajustarUso(agendamento.clientePlanoId, -1, cobertos);
    }
  }
  responderOk(req, res);
}

// GET /painel/agenda/:id/detalhe — só o miolo da folha de detalhe, em HTML.
//
// É o que permite mexer no atendimento sem sair da folha: depois de somar um
// item, concluir ou cancelar, a tela busca este pedaço e troca no lugar, em vez
// de recarregar a agenda inteira (que fechava a folha e voltava pra lista).
async function detalheFragmento(req, res) {
  const b = req.barbeariaId;
  const ag = await prisma.agendamento.findFirst({
    where: { id: idNum(req.params.id), barbeariaId: b },
    include: {
      usuario: true,
      itens: { include: { servico: true } },
      pagamentos: { orderBy: { id: 'asc' } },
      clientePlano: { include: { plano: true } },
    },
  });
  if (!ag) return res.status(404).send('');
  if (!podeAlterar(req, ag)) return res.status(403).send('');
  if (!veContato(req)) ag.clienteTelefone = permissoes.mascararTelefone(ag.clienteTelefone);

  // "Agora" é o próximo atendimento em aberto do dia — mesmo critério da lista,
  // senão o selo mudaria sozinho ao atualizar a folha.
  const inicioDia = new Date(ag.data);
  const fimDia = new Date(inicioDia);
  fimDia.setDate(fimDia.getDate() + 1);
  const doDia = await prisma.agendamento.findMany({
    where: { barbeariaId: b, usuarioId: ag.usuarioId, data: { gte: inicioDia, lt: fimDia }, status: 'agendado' },
    orderBy: { horaInicio: 'asc' },
    select: { id: true, horaInicio: true },
  });
  const emMin = (h) => Number(String(h).slice(0, 2)) * 60 + Number(String(h).slice(3, 5));
  const hoje0 = inicioDoDia(new Date());
  const ehHoje = inicioDoDia(new Date(ag.data)).getTime() === hoje0.getTime();
  const agora = new Date();
  const minutoAgora = agora.getHours() * 60 + agora.getMinutes();
  const proximo = ehHoje
    ? doDia.find((a) => emMin(a.horaInicio) >= minutoAgora) || null
    : doDia[0] || null;

  let selo = 'Confirmado';
  if (ag.status === 'cancelado') selo = 'Cancelado';
  else if (ag.status === 'concluido') selo = 'Concluído';
  else if (proximo && proximo.id === ag.id) selo = 'Agora';

  const servicos = await prisma.servico.findMany({
    where: { barbeariaId: b, ativo: true },
    orderBy: { nome: 'asc' },
  });

  const d = new Date(ag.data);
  res.render('painel/_agenda-detalhe', {
    layout: false,
    ag,
    selo,
    dataStr: iso(d),
    barbeiroSelecionado: String(req.query.barbeiro || ''),
    diaNum: d.getDate(),
    mesCurto: MESES_EXT[d.getMonth()].toLowerCase().slice(0, 3),
    formasPagamento: FORMAS_PAGAMENTO,
    servicos,
    maxParcelas: MAX_PARCELAS,
  });
}

// POST /painel/agenda/:id/excluir — exclui o agendamento (qualquer status)
async function excluir(req, res) {
  const agendamento = await prisma.agendamento.findFirst({
    where: { id: idNum(req.params.id), barbeariaId: req.barbeariaId },
  });
  if (!agendamento) return res.redirect('/painel/agenda');
  if (!podeAlterar(req, agendamento)) return negarAcesso(res);

  // Remove eventual entrada automática no caixa vinculada a este agendamento.
  await caixaServ.removerEntradaAgendamento(agendamento.id);
  // Devolve o uso do plano se o agendamento ainda estava ativo (não cancelado).
  if (agendamento.clientePlanoId && agendamento.status !== 'cancelado') {
    await planoServ.ajustarUso(agendamento.clientePlanoId, +1, await planoServ.servicosCobertosDe(agendamento.id));
  }
  // Exclui o agendamento (os itens caem em cascata pelo schema).
  await prisma.agendamento.delete({ where: { id: agendamento.id } });

  req.session.flash = { tipo: 'sucesso', texto: 'Agendamento excluído.' };
  responderOk(req, res);
}

// Carrega os dados auxiliares do formulário de agendamento manual.
async function dadosForm(req) {
  const b = req.barbeariaId;
  const ehAdmin = req.ehAdmin;
  const barbeiros = ehAdmin
    ? await prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true }, orderBy: { id: 'asc' } })
    : [];
  const servicos = await prisma.servico.findMany({ where: { barbeariaId: b, ativo: true }, orderBy: { nome: 'asc' } });
  const clientes = clientesParaTela(req, await prisma.cliente.findMany({
    where: { barbeariaId: b },
    select: { id: true, nome: true, telefone: true },
    orderBy: { nome: 'asc' },
  }));
  return { ehAdmin, barbeiros, servicos, clientes };
}

// GET /painel/agenda/horarios — JSON com o grid de horários (livres e ocupados)
// de um barbeiro numa data, para um serviço. Usado pelo pop-up "Novo agendamento"
// pra atualizar as pílulas de horário quando o barbeiro/serviço mudam.
async function horariosJson(req, res) {
  const b = req.barbeariaId;
  const barbeiroId = idNum(req.query.barbeiroId);
  const data = req.query.data;
  // Múltiplos serviços (CSV); mantém compat com o `servicoId` único.
  const servicoIds = String(req.query.servicoIds || req.query.servicoId || '')
    .split(',').map((x) => idNum(x)).filter(Boolean);

  const barbeiro = await prisma.usuario.findFirst({ where: { id: barbeiroId, barbeariaId: b, ativo: true } });
  if (!req.ehAdmin && barbeiro && barbeiro.id !== req.session.usuario.id) return res.json({ horarios: [] });
  // Data inválida devolve lista vazia, não erro: este endpoint alimenta o
  // pop-up "Novo agendamento" por fetch, e um 500 aqui chegava como página HTML
  // de erro dentro de uma resposta que o script espera que seja JSON.
  if (!barbeiro || !dataValida(data)) return res.json({ horarios: [] });

  // Duração = soma efetiva de todos os serviços escolhidos (regra de encaixe).
  let duracao = 0;
  if (servicoIds.length) {
    const servicos = await prisma.servico.findMany({ where: { id: { in: servicoIds }, barbeariaId: b } });
    duracao = duracaoComEncaixe(servicos.map((s) => ({ duracaoMin: s.duracaoMin, ehEncaixe: s.ehEncaixe })), { efetiva: true });
  }
  const horarios = await todosHorarios(barbeiroId, data, duracao);
  res.json({ horarios });
}

// GET /painel/agenda/planos?telefone=... — planos ATIVOS do cliente (por variantes
// do telefone), pra o pop-up "Novo agendamento" oferecer marcar pelo plano.
async function planosJson(req, res) {
  const b = req.barbeariaId;
  const telefone = String(req.query.telefone || '');
  if (normalizarTelefone(telefone).length < 8) return res.json({ planos: [] });
  const assinaturas = await planoServ.assinaturasVigentesPorVariantes(b, telefone);
  const planos = assinaturas.map((a) => ({
    id: a.id,
    nome: a.plano.nome,
    servicoIds: planoServ.servicosDoPlano(a.plano).map((s) => s.id),
    // Nomes juntos ("Corte, Barba") para o texto do pop-up; vazio = qualquer serviço.
    servicoNome: planoServ.servicosDoPlano(a.plano).map((s) => s.nome).filter(Boolean).join(', ') || null,
    ilimitado: a.usosRestantes === null,
    usosRestantes: a.usosRestantes,
    usosPorServico: planoServ.usosPorServicoTexto(a), // "Corte: 1 · Barba: 3" ou null
  }));
  res.json({ planos });
}

// GET /painel/agenda/novo — formulário de agendamento manual
async function formNovo(req, res) {
  const dados = await dadosForm(req);
  res.render('painel/agenda-novo', {
    titulo: 'Novo agendamento',
    ...dados,
    valores: null,
    erro: null,
    hojeIso: iso(new Date()),
  });
}

// POST /painel/agenda/novo — cria o agendamento manual (com bloqueio de conflito)
async function criarManual(req, res) {
  const usuario = req.session.usuario;
  const ehAdmin = req.ehAdmin;
  const b = req.barbeariaId;

  // Barbeiro: admin escolhe; funcionário agenda sempre para si.
  const usuarioId = ehAdmin ? idNum(req.body.barbeiroId) : usuario.id;
  // Serviços: agora MÚLTIPLOS (CSV de ids). Mantém compat com o campo antigo `servicoId`.
  const servicoIds = String(req.body.servicoIds || req.body.servicoId || '')
    .split(',').map((x) => idNum(x)).filter(Boolean);
  const data = req.body.data;
  const hora = req.body.hora;
  const nome = (req.body.cliente_nome || '').trim();
  const email = (req.body.cliente_email || '').trim();
  let telefone = (req.body.cliente_telefone || '').trim();
  // Spec 12 (B2): quem não vê o telefone escolhe o cliente no autocomplete e o
  // campo chega mascarado ("•••• 4321"). O número de verdade sai do cadastro:
  // pelo `clienteId` (tela nova) ou, na tela atual, pelo nome + final do número.
  if (telefone.includes('•')) {
    const final = normalizarTelefone(telefone);
    const idCli = idNum(req.body.clienteId);
    const candidatos = idCli
      ? await prisma.cliente.findMany({ where: { id: idCli, barbeariaId: b }, select: { telefone: true } })
      : await prisma.cliente.findMany({ where: { barbeariaId: b, nome, telefone: { endsWith: final } }, select: { telefone: true } });
    telefone = candidatos.length === 1 && final && candidatos[0].telefone.endsWith(final) ? candidatos[0].telefone : '';
  }

  const barbeiro = await prisma.usuario.findFirst({ where: { id: usuarioId, barbeariaId: b, ativo: true } });
  const servicosBase = servicoIds.length
    ? await prisma.servico.findMany({ where: { id: { in: servicoIds }, barbeariaId: b, ativo: true } })
    : [];
  // Preço do barbeiro escolhido (pode diferir do padrão — services/precos.js).
  const servicos = barbeiro ? await precos.comPrecoDoBarbeiro(servicosBase, barbeiro.id) : servicosBase;

  const erros = [];
  if (!barbeiro) erros.push('Selecione um barbeiro.');
  if (!servicos.length) erros.push('Selecione ao menos um serviço.');
  if (!data || !hora) erros.push('Informe data e horário.');
  if (!nome) erros.push('Informe o nome do cliente.');
  if (!telefone) erros.push('Informe o telefone do cliente.');

  // Duração efetiva somando todos os serviços (regra de encaixe incluída).
  const duracaoTotal = duracaoComEncaixe(
    servicos.map((s) => ({ duracaoMin: s.duracaoMin, ehEncaixe: s.ehEncaixe })),
    { efetiva: true }
  );

  // Bloqueio de conflito: o novo horário não pode sobrepor outro atendimento do barbeiro.
  if (barbeiro && servicos.length && dataValida(data) && hora) {
    const iniNovo = paraMinutos(hora);
    const fimNovo = iniNovo + duracaoTotal;
    const existentes = await prisma.agendamento.findMany({
      where: { barbeariaId: b, usuarioId, data: dataLocal(data), status: { not: 'cancelado' } },
      include: { itens: { include: { servico: true } } },
    });
    const conflita = existentes.some((ag) => {
      const ini = paraMinutos(ag.horaInicio);
      const dur = duracaoComEncaixe(
        ag.itens.map((it) => ({ duracaoMin: it.servico.duracaoMin, ehEncaixe: it.servico.ehEncaixe, quantidade: it.quantidade })),
        { efetiva: true }
      );
      return iniNovo < ini + dur && ini < fimNovo;
    });
    if (conflita) erros.push('Esse horário conflita com outro atendimento desse barbeiro. Escolha outro.');
  }

  // Plano (opcional): o barbeiro pode marcar pelo plano do cliente. Valida e
  // descobre qual serviço ele cobre (mesma regra da secretária — plano.js).
  const clientePlanoId = idNum(req.body.clientePlanoId);
  let cobertura = null;
  if (clientePlanoId && barbeiro && servicos.length && dataValida(data) && telefone) {
    const cob = await planoServ.avaliarCobertura({ clientePlanoId, barbeariaId: b, clienteTelefone: telefone, servicos, data });
    if (cob.erro) erros.push(cob.mensagem);
    else cobertura = cob;
  }

  if (erros.length) {
    req.session.flash = { tipo: 'erro', texto: erros.join(' ') };
    const qs = new URLSearchParams();
    if (data) qs.set('data', data);
    if (ehAdmin && req.body.barbeiroId) qs.set('barbeiro', req.body.barbeiroId);
    return res.redirect('/painel/agenda' + (qs.toString() ? '?' + qs.toString() : ''));
  }

  // Alimenta/vincula o cliente pelo telefone normalizado (igual ao agendamento do site).
  // Se marcou por PLANO, vincula ao DONO do plano (a assinatura já foi validada).
  const telNorm = normalizarTelefone(telefone);
  let clienteId = null;
  if (cobertura) {
    clienteId = cobertura.assinatura.clienteId;
  } else if (telNorm) {
    let cliente = await prisma.cliente.findUnique({
      where: { barbeariaId_telefone: { barbeariaId: b, telefone: telNorm } },
    });
    if (!cliente) cliente = await prisma.cliente.create({ data: { barbeariaId: b, nome, telefone: telNorm } });
    clienteId = cliente.id;
  }

  // Os serviços que o plano cobre (`cobertosIds`) saem 0; os demais somam normal.
  const cobertos = new Set(cobertura ? cobertura.cobertosIds : []);
  const valorTotal = servicos.reduce((soma, s) => soma + (cobertos.has(s.id) ? 0 : s.valor), 0);
  await prisma.agendamento.create({
    data: {
      barbeariaId: b,
      usuarioId,
      clienteId,
      clienteNome: nome,
      clienteEmail: email,
      clienteTelefone: telefone,
      data: dataLocal(data),
      horaInicio: hora,
      status: 'agendado',
      valorTotal,
      origem: 'barbeiro', // criado manualmente no painel pela equipe
      clientePlanoId: cobertura ? cobertura.assinatura.id : null,
      itens: { create: servicos.map((s) => ({ servicoId: s.id, valorUnitario: cobertos.has(s.id) ? 0 : s.valor, quantidade: 1 })) },
    },
  });
  // Consome 1 uso do plano (limitado; ilimitado não muda) — igual à secretária.
  if (cobertura) await planoServ.ajustarUso(cobertura.assinatura.id, -1, cobertura.cobertosIds);

  req.session.flash = { tipo: 'sucesso', texto: 'Agendamento criado.' };
  res.redirect('/painel/agenda?data=' + data + (ehAdmin ? '&barbeiro=' + usuarioId : ''));
}

// POST /painel/agenda/bloqueios — cria um bloqueio direto da agenda.
// Admin escolhe o barbeiro; funcionário bloqueia sempre a PRÓPRIA agenda.
async function criarBloqueio(req, res) {
  const b = req.barbeariaId;
  const barbeiroId = req.ehAdmin ? idNum(req.body.barbeiroId) : req.session.usuario.id;
  const data = req.body.data;
  const horaInicio = req.body.horaInicio;
  const horaFim = req.body.horaFim;
  const motivo = (req.body.motivo || '').trim() || null;
  const barbeiro = await prisma.usuario.findFirst({ where: { id: barbeiroId, barbeariaId: b } });

  if (barbeiro && dataValida(data) && horaInicio && horaFim && horaInicio < horaFim) {
    await prisma.bloqueio.create({
      data: { barbeariaId: b, usuarioId: barbeiroId, data: dataLocal(data), horaInicio, horaFim, motivo },
    });
    req.session.flash = { tipo: 'sucesso', texto: 'Horário bloqueado.' };
  } else {
    req.session.flash = { tipo: 'erro', texto: 'Preencha barbeiro, data e um intervalo de horário válido.' };
  }
  const barbeiroRet = req.body.barbeiro || String(barbeiroId);
  res.redirect('/painel/agenda?data=' + (data || '') + '&barbeiro=' + barbeiroRet);
}

// POST /painel/agenda/bloqueios/:id/remover — remove um bloqueio.
// Funcionário só remove os PRÓPRIOS bloqueios; admin remove qualquer um.
async function removerBloqueio(req, res) {
  const where = { id: idNum(req.params.id), barbeariaId: req.barbeariaId };
  if (!req.ehAdmin) where.usuarioId = req.session.usuario.id;
  await prisma.bloqueio.deleteMany({ where }).catch(() => {});
  req.session.flash = { tipo: 'sucesso', texto: 'Bloqueio removido.' };
  const qs = new URLSearchParams();
  if (req.body.retornoData) qs.set('data', req.body.retornoData);
  if (req.body.retornoBarbeiro) qs.set('barbeiro', req.body.retornoBarbeiro);
  const s = qs.toString();
  res.redirect('/painel/agenda' + (s ? '?' + s : ''));
}

module.exports = { verAgenda, adicionarItem, removerItem, alterarValorItem, alterarTotal, mudarStatus, excluir, detalheFragmento, formNovo, criarManual, criarBloqueio, removerBloqueio, horariosJson, planosJson };
