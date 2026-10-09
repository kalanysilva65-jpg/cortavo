// Agenda pública v3 (F12): as views do link do cliente renderizadas de verdade
// com o EJS do app e dados fictícios. Sem banco, sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { RAIZ } = require('./helpers/ambiente');

const VIEWS = path.join(RAIZ, 'src/views');
async function pagina(view, locais) {
  const body = await ejs.renderFile(path.join(VIEWS, 'agendar', view + '.ejs'), locais);
  return ejs.renderFile(path.join(VIEWS, 'layouts/publico.ejs'), { ...locais, body });
}
const fmtT6 = (c) => 'R$' + Math.round(c / 100);
const SERV = [
  { id: 1, nome: 'Corte degradê', duracaoMin: 40, valor: 4500, descricao: 'Navalha.', fotoUrl: '/uploads/grande.jpg', fotoMiniUrl: '/uploads/mini.jpg' },
  { id: 2, nome: 'Barba', duracaoMin: 30, valor: 3000, fotoUrl: '/uploads/so-grande.jpg' },
  { id: 3, nome: 'Sobrancelha', duracaoMin: 10, valor: 1500 },
];
const BARB = { id: 2, nome: 'Rafael Moreira', nomePublico: 'Rafael' };
function base(extra = {}) {
  return {
    barbearia: { id: 1, nome: 'Barbearia Vila Rosa', slug: 'vilarosa' }, marcaLogoUrl: '/uploads/logo.png',
    horarioHoje: { aberto: true, inicio: '09:00', fim: '19:00', texto: 'Aberto hoje, 9h às 19h' },
    assinatura: null, voltarHref: null, flash: null, fmtT6, fmtTelefone: () => '(11) 98472-3051', fmtData: () => '31/12/2026',
    ...extra,
  };
}
const passo3 = (extra = {}) => base({
  passo: 3, servicos: [SERV[1]], servicoIdsStr: '2', duracaoTotal: 30, valorTotal: 3000, aPartirDe: false, barbeiro: BARB,
  datas: [{ iso: '2026-10-09', dow: 'Hoje', dia: 9 }, { iso: '2026-10-10', dow: 'Amanhã', dia: 10 }, { iso: '2026-10-12', dow: 'Seg', dia: 12 }],
  dataSel: '2026-10-10', diasPlanoLabel: null, proximoDiaLivre: null, voltarHref: '/agendar/barbeiro?servicoIds=2', ...extra,
});

test('F12 layout: só o sistema v3 (tokens + cv + cv-agendar), sem o tema antigo nem azul', async () => {
  const html = await pagina('servico', base({ passo: 1, servicos: SERV, faixas: {} }));
  for (const css of ['/css/tokens.css', '/css/cv.css', '/css/cv-agendar.css']) assert.ok(html.includes(css), css);
  for (const velho of ['agendamento-novo.css', 'tema-minimal.css', 'sv-ag6', 'Overused']) assert.ok(!html.includes(velho), velho);
  assert.doesNotMatch(html, /#2f6bff|#7f92cf/i);
  const css = fs.readFileSync(path.join(RAIZ, 'public/css/cv-agendar.css'), 'utf8');
  assert.doesNotMatch(css, /#2f6bff|#7f92cf|Overused/i);
});

test('F12 topo: logo da barbearia, "Aberto hoje" do horarioHoje, trilha de 4 passos e "feito com Cortavo"', async () => {
  const html = await pagina('servico', base({ passo: 1, servicos: SERV, faixas: {} }));
  assert.match(html, /<span class="ap-logo"><img src="\/uploads\/logo.png"/);
  assert.match(html, /Aberto hoje, 9h às 19h/);
  assert.match(html, /class="ap-trilha" role="progressbar"[^>]*aria-valuenow="1"/);
  assert.equal((html.match(/<i class="atual"><\/i>/g) || []).length, 1);
  assert.match(html, /feito com Cortavo/);
  // Sem logo: a inicial do nome sem o "Barbearia".
  const sem = await pagina('servico', base({ passo: 1, servicos: SERV, faixas: {}, marcaLogoUrl: null, horarioHoje: { aberto: false, texto: 'Fechado hoje' } }));
  assert.match(sem, /<span class="ini">V<\/span>/);
  assert.match(sem, /Fechado hoje/);
});

test('F12 serviços: foto opcional usa a miniatura (fotoMiniUrl), cai na fotoUrl, e sem foto não desenha o quadrado', async () => {
  const html = await pagina('servico', base({ passo: 1, servicos: SERV, faixas: {} }));
  const cartoes = html.split('class="ap-serv"').slice(1);
  assert.equal(cartoes.length, 3);
  assert.match(cartoes[0], /<span class="ap-foto"><img src="\/uploads\/mini.jpg"[^>]*width="72" height="72" loading="lazy"/);
  assert.ok(!cartoes[0].includes('grande.jpg'));
  assert.match(cartoes[1], /<img src="\/uploads\/so-grande.jpg"/);
  assert.ok(!cartoes[2].split('</button>')[0].includes('ap-foto'));
  // O fluxo do formulário não mudou.
  assert.match(html, /<form id="form-servicos" action="\/agendar\/barbeiro" method="GET"/);
  assert.match(html, /id="servicoIds-input"/);
  assert.match(html, /data-id="1" data-valor="4500"/);
  assert.match(html, /id="btn-continuar" disabled/);
  assert.match(html, /href="\/agendar\/plano"/);
});

test('F12 horário: ocupado não é link, livre leva para os dados', async () => {
  const html = await pagina('horario', passo3({
    horariosManha: [{ hora: '09:00', livre: false }, { hora: '09:20', livre: true }], horariosTarde: [],
  }));
  assert.match(html, /<span class="ap-hora ocupado" aria-label="09:00, ocupado">09:00<\/span>/);
  assert.match(html, /<a class="ap-hora" href="\/agendar\/dados\?servicoIds=2&barbeiroId=2&data=2026-10-10&hora=09:20">/);
  assert.match(html, /class="ap-dia sel" aria-current="date"/);
  assert.match(html, /\/agendar\/horarios\.json\?/);
});

test('F12 horário: dia esgotado fica listrado e ganha o atalho para o próximo dia livre', async () => {
  const html = await pagina('horario', passo3({
    horariosManha: [{ hora: '09:00', livre: false }], horariosTarde: [{ hora: '13:00', livre: false }],
    proximoDiaLivre: { data: '2026-10-12', rotulo: 'Seg, 12 out' },
  }));
  assert.match(html, /class="ap-dia sel esgotado"[^>]*aria-label="Amanhã 10, esgotado"/);
  assert.match(html, /Amanhã está esgotado/);
  assert.match(html, /O próximo dia com horário livre é Seg, 12 out\./);
  assert.match(html, /<a class="cv-btn" data-ir-dia="2026-10-12" href="\/agendar\/horario\?servicoIds=2&amp;barbeiroId=2&amp;data=2026-10-12">Ver Seg, 12 out<\/a>/);
  const slots = html.slice(html.indexOf('id="ag6-slots"'), html.indexOf('<div class="ap-barra"'));
  assert.ok(!slots.includes('class="ap-horas"'));
});

test('F12 dados: mesmos campos e destino; erro do envio aparece no topo com atalho para os horários', async () => {
  const html = await pagina('dados', base({
    passo: 4, servicos: [SERV[0]], servicoIdsStr: '1', valorTotal: 4500, barbeiro: BARB, data: '2026-10-10', hora: '16:20',
    dataExtenso: 'Sábado, 10 de outubro', voltarHref: '/agendar/horario?servicoIds=1&barbeiroId=2',
    flash: { tipo: 'erro', texto: 'Esse horário não está mais disponível. Escolha outro.' },
  }));
  assert.match(html, /<form method="POST" action="\/agendar\/confirmar" id="ag6-form-dados">/);
  for (const n of ['servicoIds', 'barbeiroId', 'data', 'hora', 'cliente_nome', 'cliente_telefone', 'cliente_nascimento']) assert.match(html, new RegExp('name="' + n + '"'), n);
  const erro = html.indexOf('class="ap-erro ap-erro-caixa" role="alert"');
  assert.ok(erro > html.indexOf('Seus dados') && erro < html.indexOf('cliente_nome'));
  assert.match(html, /<a class="acao" href="\/agendar\/horario\?servicoIds=1&amp;barbeiroId=2">Ver horários livres<\/a>/);
  assert.match(html, /id="ag6-confirmar" disabled>Preencha seus dados/);
  // Resumo do PC (painel da esquerda) com o que já foi escolhido.
  assert.match(html, /<aside class="ap-lado"[\s\S]*Sábado, 10 de outubro · 16:20[\s\S]*<\/aside>/);
});

test('F12 pronto: selo M1 com o logo da barbearia (ou a inicial) e o check', async () => {
  const ag = { horaInicio: '16:20', clienteNome: 'Pedro Souza', clienteTelefone: '11984723051', valorTotal: 7000, usuario: BARB, itens: [{ servico: SERV[0] }] };
  const html = await pagina('sucesso', base({ passo: 5, agendamento: ag, dataExtenso: 'Sábado, 10 de outubro', usouPlano: false }));
  assert.match(html, /<div class="ap-selo" id="ap-selo"[\s\S]*?<span class="disco"><img src="\/uploads\/logo.png"/);
  assert.match(html, /Está<\/span><span style="display:block">marcado\./);
  assert.match(html, /href="\/agendar">Marcar outro horário/);
  assert.ok(!html.includes('class="ap-trilha"'));
  const sem = await pagina('sucesso', base({ passo: 5, agendamento: ag, dataExtenso: 'x', usouPlano: true, marcaLogoUrl: null }));
  assert.match(sem, /<span class="disco"><span class="ini">V<\/span>/);
  assert.match(sem, /Via plano/);
});
