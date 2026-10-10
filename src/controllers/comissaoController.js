// Controlador do painel de comissões por barbeiro.
// Acesso (spec 12): o ADMIN vê todos; o FUNCIONÁRIO também abre a tela (rota
// GET /comissoes liberada pelo plano `comissoes`), mas SÓ com a própria
// comissão: o recorte por usuário está em `barbeiroSelecionado` e na lista de
// barbeiros enviada à tela. Não restringir a rota ao admin.
// Serviços: comissão pela % de cada barbeiro. Produtos: comissão fixa (COMISSAO_PRODUTO_PERCENTUAL).
// Relatório sobre dados existentes, usando o valorUnitario congelado e só
// agendamentos CONCLUÍDOS no período.
const prisma = require('../config/db');
const fs = require('fs');
const { caminhoDoUpload } = require('../config/paths');
const { COMISSAO_PRODUTO_PERCENTUAL } = require('../config/constantes');
const { paraMinutos, duracaoComEncaixe } = require('../services/disponibilidade');

// Date -> "YYYY-MM-DD"
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "YYYY-MM-DD" -> Date à meia-noite local
function dataLocal(s) {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d);
}

// Período padrão = mês atual (primeiro ao último dia)
function periodoMesAtual() {
  const hoje = new Date();
  return {
    inicio: iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)),
    fim: iso(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0)),
  };
}

// GET /painel/comissoes
async function ver(req, res) {
  const padrao = periodoMesAtual();
  let inicioStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.inicio || '') ? req.query.inicio : padrao.inicio;
  let fimStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fim || '') ? req.query.fim : padrao.fim;
  if (inicioStr > fimStr) {
    const t = inicioStr;
    inicioStr = fimStr;
    fimStr = t;
  }

  const inicio = dataLocal(inicioStr);
  const fimExcl = dataLocal(fimStr);
  fimExcl.setDate(fimExcl.getDate() + 1); // limite superior exclusivo (inclui o dia "fim")

  const b = req.barbeariaId;
  const barbeiros = await prisma.usuario.findMany({ where: { barbeariaId: b, ativo: true }, orderBy: { id: 'asc' } });

  const agendamentos = await prisma.agendamento.findMany({
    // Por CONCLUSAO, igual ao relatorio e ao caixa: a comissao acompanha o
    // dinheiro que entrou no periodo. Contar pelo dia do atendimento faria esta
    // tela discordar do faturamento que a alimenta.
    where: { barbeariaId: b, status: 'concluido', concluidoEm: { gte: inicio, lt: fimExcl } },
    include: {
      usuario: true,
      itens: { include: { servico: true } },
      clientePlano: { include: { plano: true } },
    },
    orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
  });

  // Agrupa por barbeiro, separando serviços de produtos
  const mapa = new Map();
  for (const b of barbeiros) {
    mapa.set(b.id, { barbeiro: b, atendimentos: [], servicosTotal: 0, produtosTotal: 0, comissaoProdutosTotal: 0, ocupadoMin: 0, qtd: 0 });
  }

  // O valor do plano conta UMA ÚNICA VEZ por assinatura (não por atendimento).
  const planosCreditados = new Set();
  for (const ag of agendamentos) {
    const grupo = mapa.get(ag.usuarioId);
    if (!grupo) continue; // agendamento de barbeiro inativo: fora do relatório

    let servicosSub = 0;
    let produtosSub = 0;
    const viaPlano = !!ag.clientePlanoId;

    // Tempo ocupado do atendimento, já com a regra do encaixe (serviço-encaixe
    // não soma tempo quando há outro serviço junto).
    const duracaoApt = duracaoComEncaixe(
      ag.itens.map((it) => ({ duracaoMin: it.servico.duracaoMin, ehEncaixe: it.servico.ehEncaixe, quantidade: it.quantidade })),
      { efetiva: false }
    );

    // Itens (para exibição).
    const itens = ag.itens.map((it) => {
      return {
        nome: it.servico.nome,
        quantidade: it.quantidade,
        valor: it.valorUnitario * it.quantidade,
        ehProduto: it.servico.ehProduto,
      };
    });

    if (viaPlano && ag.clientePlano && ag.clientePlano.plano) {
      // Cliente paga R$ 0. A comissão usa o VALOR DO PLANO, contado uma única vez
      // por assinatura no período (no 1º atendimento concluído); os demais usos contam 0.
      if (!planosCreditados.has(ag.clientePlanoId)) {
        servicosSub = ag.clientePlano.plano.valor;
        planosCreditados.add(ag.clientePlanoId);
      }
    } else {
      // Total ajustado à mão MANDA sobre a soma dos itens.
      //
      // A comissão tem que sair do que foi cobrado do cliente. Sem isto, um
      // atendimento com R$45 de itens cobrado a R$100 pagava comissão sobre
      // R$45 — a 50%, R$22,50 em vez de R$50. O barbeiro recebia menos do que
      // devia, e o caixa (que registra o cobrado) não batia com esta tela.
      //
      // O ajuste é distribuído na PROPORÇÃO dos itens para a parte de produto
      // continuar recebendo a comissão própria dela, que é diferente da do
      // barbeiro. Sem nenhum item com valor (tudo cortesia), não há proporção
      // de onde partir e o valor cobrado conta como serviço.
      const somaItens = ag.itens.reduce((s, it) => s + it.valorUnitario * it.quantidade, 0);
      const ajustado = ag.totalManual && somaItens > 0;
      const fator = ajustado ? ag.valorTotal / somaItens : 1;

      let comissaoProdutosSub = 0;
      for (const it of ag.itens) {
        const valor = Math.round(it.valorUnitario * it.quantidade * fator);
        if (it.servico.ehProduto) {
          produtosSub += valor;
          comissaoProdutosSub += Math.round(valor * ((it.servico.comissaoPercentual ?? 10) / 100));
        } else servicosSub += valor;
      }

      if (ajustado) {
        // Arredondar item a item pode sobrar (ou faltar) centavo. O resto vai
        // para serviços, senão o "Faturado" da tela não fecharia com o total.
        servicosSub += ag.valorTotal - (servicosSub + produtosSub);
      } else if (ag.totalManual) {
        servicosSub = ag.valorTotal; // ajustado, mas sem itens com valor
      }

      grupo.comissaoProdutosTotal += comissaoProdutosSub;
    }

    grupo.atendimentos.push({ ag, itens, servicosSub, produtosSub, viaPlano });
    grupo.servicosTotal += servicosSub;
    grupo.produtosTotal += produtosSub;
    grupo.ocupadoMin += duracaoApt;
    grupo.qtd += 1;
  }

  // --- Disponibilidade (minutos de jornada) por barbeiro no período --------
  // Soma a jornada dos dias trabalhados, desconta os bloqueios e NÃO conta dias
  // futuros (limita ao começo de amanhã), para a ocupação fazer sentido "até hoje".
  const jornadas = await prisma.horarioTrabalho.findMany({ where: { barbeariaId: b } });
  const bloqueios = await prisma.bloqueio.findMany({ where: { barbeariaId: b, data: { gte: inicio, lt: fimExcl } } });

  const amanha = new Date();
  amanha.setHours(0, 0, 0, 0);
  amanha.setDate(amanha.getDate() + 1);
  const limite = new Date(Math.min(fimExcl.getTime(), amanha.getTime()));

  const dispMin = new Map();
  for (const b of barbeiros) dispMin.set(b.id, 0);

  for (let d = new Date(inicio); d < limite; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const b of barbeiros) {
      const j = jornadas.find((x) => x.usuarioId === b.id && x.diaSemana === dow);
      if (j && j.trabalha) {
        dispMin.set(b.id, dispMin.get(b.id) + Math.max(0, paraMinutos(j.horaFim) - paraMinutos(j.horaInicio)));
      }
    }
  }
  for (const bl of bloqueios) {
    if (bl.data < limite && dispMin.has(bl.usuarioId)) {
      const m = Math.max(0, paraMinutos(bl.horaFim) - paraMinutos(bl.horaInicio));
      dispMin.set(bl.usuarioId, Math.max(0, dispMin.get(bl.usuarioId) - m));
    }
  }

  // Comissão = serviços × (% do barbeiro) + produtos × (% fixo de produto)
  const rotulosSemana = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const todosGrupos = Array.from(mapa.values()).map((g) => {
    const pct = g.barbeiro.comissaoPercentual ?? 50;
    const comissaoServicos = Math.round(g.servicosTotal * (pct / 100));
    const comissaoProdutos = g.comissaoProdutosTotal;
    const faturadoTotal = g.servicosTotal + g.produtosTotal;

    // % que a tela REALMENTE pagou sobre produtos no período.
    //
    // O rótulo mostrava um valor fixo (a constante COMISSAO_PRODUTO_PERCENTUAL,
    // 10%) que não era o que a conta usava: cada produto tem a sua própria %.
    // Um produto a 15% fazia a linha dizer "10%" ao lado de um valor calculado
    // a 15% — quem conferisse na mão achava erro onde não havia. Null quando
    // não houve produto no período: aí não há percentual nenhum a mostrar.
    const produtoPct = g.produtosTotal > 0 ? Math.round((comissaoProdutos / g.produtosTotal) * 100) : null;
    // Ticket médio = faturado total ÷ atendimentos concluídos no período.
    const ticketMedio = g.qtd > 0 ? Math.round(faturadoTotal / g.qtd) : 0;
    // Ocupação = tempo ocupado ÷ jornada disponível (null se não há jornada no período).
    const disponivelMin = dispMin.get(g.barbeiro.id) || 0;
    const ocupacaoPct = disponivelMin > 0 ? Math.round((g.ocupadoMin / disponivelMin) * 100) : null;

    // Faturado por dia da semana (soma de todos os atendimentos do período) — gráfico do detalhe.
    const porDia = [0, 0, 0, 0, 0, 0, 0];
    for (const a of g.atendimentos) {
      const idx = (new Date(a.ag.data).getDay() + 6) % 7; // 0 = segunda
      porDia[idx] += a.servicosSub + a.produtosSub;
    }
    const barsSemana = rotulosSemana.map((rotulo, i) => ({ rotulo, valor: porDia[i] }));
    const maxBarSemana = Math.max(1, ...porDia);

    return {
      ...g,
      comissaoServicos,
      comissaoProdutos,
      produtoPct,
      comissao: comissaoServicos + comissaoProdutos,
      faturadoTotal,
      ticketMedio,
      ocupacaoPct,
      barsSemana,
      maxBarSemana,
    };
  });

  // Filtro de barbeiro:
  //  - Funcionário: sempre o próprio (só vê a comissão dele, ignora a query).
  //  - Admin: 'todos' (padrão) ou um id específico.
  const barbeiroSelecionado = !req.ehAdmin
    ? String(req.session.usuario.id)
    : req.query.barbeiro && /^\d+$/.test(req.query.barbeiro)
      ? req.query.barbeiro
      : 'todos';

  const grupos =
    barbeiroSelecionado === 'todos'
      ? todosGrupos
      : todosGrupos.filter((g) => String(g.barbeiro.id) === barbeiroSelecionado);

  // Totais refletem a seleção
  const totalServicos = grupos.reduce((s, g) => s + g.servicosTotal, 0);
  const totalProdutos = grupos.reduce((s, g) => s + g.produtosTotal, 0);
  const totalGeralComissao = grupos.reduce((s, g) => s + g.comissao, 0);
  // Maior ticket médio da seleção — usado para escalar a barrinha do card.
  const maxTicket = Math.max(1, ...grupos.map((g) => g.ticketMedio));

  // Atalhos de período
  const hoje = new Date();
  const offSegunda = (hoje.getDay() + 6) % 7; // 0 = segunda
  const seg = new Date(hoje);
  seg.setDate(hoje.getDate() - offSegunda);
  const dom = new Date(seg);
  dom.setDate(seg.getDate() + 6);
  const presetHoje = { inicio: iso(hoje), fim: iso(hoje) };
  const presetSemana = { inicio: iso(seg), fim: iso(dom) };
  const presetMes = periodoMesAtual();

  // Qual pill de atalho está ativa (pra destacar visualmente).
  let periodoAtivo = 'custom';
  if (inicioStr === presetHoje.inicio && fimStr === presetHoje.fim) periodoAtivo = 'hoje';
  else if (inicioStr === presetSemana.inicio && fimStr === presetSemana.fim) periodoAtivo = 'semana';
  else if (inicioStr === presetMes.inicio && fimStr === presetMes.fim) periodoAtivo = 'mes';

  // Redesign v3 (F7): o que já foi pago e o que falta, por barbeiro, e o
  // histórico das baixas (B5 do Beto, mesmo recorte da Gestão: o barbeiro só
  // recebe a dele). Sem a leitura, a tela mostra só a comissão calculada.
  let situacoes = {};
  let pagamentosComissao = [];
  if (req.permissoes) {
    try {
      const r = await require('../services/metricas').calcular('comissoes', { barbeariaId: b, permissoes: req.permissoes, query: { de: inicioStr, ate: fimStr, detalhe: '1' } });
      for (const x of r.resumo.barbeiros) situacoes[x.usuarioId] = { pago: x.pago, aPagar: x.aPagar, situacao: x.situacao };
      pagamentosComissao = (r.detalhe && r.detalhe.pagamentos) || [];
    } catch (e) {
      situacoes = {};
    }
  }

  // Funcionário não recebe os colegas (nem na lista do filtro, nem nos dados).
  const barbeirosTela = req.ehAdmin ? barbeiros : barbeiros.filter((x) => String(x.id) === barbeiroSelecionado);
  if (!req.ehAdmin) {
    for (const k of Object.keys(situacoes)) if (k !== barbeiroSelecionado) delete situacoes[k];
  }

  res.render('painel/comissoes', {
    situacoes,
    pagamentosComissao,
    nomePeriodo: periodoAtivo === 'hoje' ? 'Hoje' : periodoAtivo === 'semana' ? 'Esta semana' : periodoAtivo === 'mes' ? 'Este mês' : inicioStr.split('-').reverse().join('/') + ' a ' + fimStr.split('-').reverse().join('/'),
    titulo: 'Comissões',
    grupos,
    barbeiros: barbeirosTela,
    barbeiroSelecionado,
    inicioStr,
    fimStr,
    periodoAtivo,
    totalServicos,
    totalProdutos,
    totalGeralComissao,
    maxTicket,
    comissaoProdutoPct: COMISSAO_PRODUTO_PERCENTUAL,
    presetHoje,
    presetSemana,
    presetMes,
    hojeIdx: (new Date().getDay() + 6) % 7, // 0 = segunda, usado p/ destacar o dia atual no gráfico
  });
}

// POST /painel/comissoes/percentual/:id — ajusta a % de comissão (serviços) de um barbeiro
async function salvarPercentual(req, res) {
  const id = Number(req.params.id);
  let p = parseFloat(String(req.body.percentual || '').replace(',', '.'));
  if (isNaN(p)) p = 0;
  p = Math.min(100, Math.max(0, p)); // limita entre 0 e 100
  await prisma.usuario
    .updateMany({ where: { id, barbeariaId: req.barbeariaId }, data: { comissaoPercentual: p } })
    .catch(() => {});

  // Redireciona preservando o período e o filtro de barbeiro
  const qs = new URLSearchParams();
  if (req.body.inicio) qs.set('inicio', req.body.inicio);
  if (req.body.fim) qs.set('fim', req.body.fim);
  if (req.body.barbeiro) qs.set('barbeiro', req.body.barbeiro);
  const s = qs.toString();
  res.redirect('/painel/comissoes' + (s ? '?' + s : ''));
}

// POST /painel/comissoes/:id/foto — envia/troca a foto de um barbeiro da barbearia.
async function salvarFoto(req, res) {
  const id = Number(req.params.id);
  const barbeiro = await prisma.usuario.findFirst({ where: { id, barbeariaId: req.barbeariaId } });

  const qs = new URLSearchParams();
  if (req.body.inicio) qs.set('inicio', req.body.inicio);
  if (req.body.fim) qs.set('fim', req.body.fim);
  if (req.body.barbeiro) qs.set('barbeiro', req.body.barbeiro);
  const destino = '/painel/comissoes' + (qs.toString() ? '?' + qs.toString() : '');

  if (!barbeiro || !req.file) {
    if (req.file) fs.unlink(caminhoDoUpload('/uploads/' + req.file.filename), () => {});
    return res.redirect(destino);
  }

  // Apaga a foto anterior, se houver.
  const anterior = caminhoDoUpload(barbeiro.fotoUrl);
  if (anterior) fs.unlink(anterior, () => {});
  await prisma.usuario.update({ where: { id }, data: { fotoUrl: '/uploads/' + req.file.filename } });
  req.session.flash = { tipo: 'sucesso', texto: 'Foto atualizada.' };
  res.redirect(destino);
}

module.exports = { ver, salvarPercentual, salvarFoto };
