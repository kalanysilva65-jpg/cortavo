// API do Caixa do dia (redesign v3, F6: "Saldo de hoje" e "Fechar o caixa de
// hoje"). Permissões (spec 12): ver com `caixa_ver`, fechar com `caixa_lancar`
// (admin sempre). Documentado em squads/app-cortavo/output/gestao-dados-apis.md.
const fechamento = require('../services/fechamentoCaixa');
const metricas = require('../services/metricas');

function semCache(res) {
  res.set('Cache-Control', 'private, no-store');
}

// GET /painel/api/caixa/dia?data=AAAA-MM-DD&fundoInicial=centavos
async function dia(req, res) {
  semCache(res);
  const d = fechamento.lerDia(req.query.data);
  if (!d) return res.status(400).json({ erro: `Data inválida (até ${fechamento.MAX_DIAS_ATRAS} dias atrás, nunca no futuro).` });
  const fundo = fechamento.lerCentavos(req.query.fundoInicial, null);
  res.json(await fechamento.resumoDoDia(req.barbeariaId, d, { fundoInicial: fundo || 0 }));
}

// POST /painel/api/caixa/fechar
// Corpo: { data?, dinheiroContado (centavos) | dinheiroContadoReais ("123,45"),
//          fundoInicial? (centavos), observacao?, refazer? }
async function fechar(req, res) {
  semCache(res);
  const body = req.body || {};
  const d = fechamento.lerDia(body.data);
  if (!d) return res.status(400).json({ erro: `Data inválida (até ${fechamento.MAX_DIAS_ATRAS} dias atrás, nunca no futuro).` });
  const contado = fechamento.lerCentavos(body.dinheiroContado, body.dinheiroContadoReais);
  if (contado == null) return res.status(400).json({ erro: 'Informe quanto dinheiro tem na gaveta.' });
  const fundo = fechamento.lerCentavos(body.fundoInicial, body.fundoInicialReais) || 0;
  const refazer = body.refazer === true || body.refazer === 'true' || body.refazer === '1';
  const r = await fechamento.fechar(req.barbeariaId, {
    dia: d,
    dinheiroContado: contado,
    fundoInicial: fundo,
    observacao: body.observacao,
    refazer,
    usuario: req.session.usuario,
  });
  if (r.erro) return res.status(r.status || 400).json({ erro: r.erro, fechamento: r.fechamento });
  metricas.invalidar(req.barbeariaId);
  res.json({ ok: true, ...r });
}

// GET /painel/api/caixa/fechamentos?de=&ate= (padrão: últimos 30 dias)
async function fechamentos(req, res) {
  semCache(res);
  const ate = fechamento.lerDia(req.query.ate) || new Date(new Date().setHours(0, 0, 0, 0));
  const de = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.de || '')) ? metricas.dataLocal(req.query.de) : new Date(ate.getTime() - 29 * 86400000);
  const ateExcl = new Date(ate);
  ateExcl.setDate(ateExcl.getDate() + 1);
  if (isNaN(de.getTime()) || de > ate || (ateExcl - de) / 86400000 > 366) return res.status(400).json({ erro: 'Período inválido (até 1 ano).' });
  res.json({ de: metricas.iso(de), ate: metricas.iso(ate), fechamentos: await fechamento.listar(req.barbeariaId, de, ateExcl) });
}

module.exports = { dia, fechar, fechamentos };
