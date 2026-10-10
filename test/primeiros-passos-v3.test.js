// F9 (spec 11; telas da Dani): Primeiros passos na Início e a boas-vindas do
// primeiro acesso pelo link. Sem banco, sem .env, sem subir o app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { RAIZ, carregar } = require('./helpers/ambiente');

const VIEWS = path.join(RAIZ, 'src/views');
function prismaCom(n) {
  const c = (k) => ({ count: async () => n[k] || 0 });
  return { servico: c('servico'), usuario: c('usuario'), horarioTrabalho: c('horario'), agendamento: c('agendamento'), caixa: c('caixa'), comissaoPagamento: c('comissao'), configuracao: c('whatsapp') };
}

test('F9 passos: 8 no plano Barbearia + IA, 6 no Essencial; feito vem dos dados que já existem', async () => {
  const pp = carregar('src/services/primeirosPassos.js', { prisma: prismaCom({ servico: 3, usuario: 1, horario: 5 }) });
  const r = await pp.montar({ barbeariaId: 1, planoChave: 'barbearia_ia' });
  assert.equal(r.total, 8);
  assert.deepEqual(r.passos.filter((p) => p.feito).map((p) => p.chave), ['servicos', 'horarios']);
  assert.equal(r.proximo, 'equipe');
  assert.equal(r.feitos, 2);
  assert.equal(r.passos.find((p) => p.chave === 'link').href, '/painel/link?novo=1');
  const ess = await pp.montar({ barbeariaId: 1, planoChave: 'essencial' });
  assert.equal(ess.total, 6);
  assert.ok(!ess.passos.some((p) => p.chave === 'secretaria' || p.chave === 'comissoes'));
  const tudo = carregar('src/services/primeirosPassos.js', { prisma: prismaCom({ servico: 1, usuario: 2, horario: 1, agendamento: 1, caixa: 1, comissao: 1, whatsapp: 1 }) });
  assert.equal((await tudo.montar({ barbeariaId: 1, planoChave: 'barbearia_ia' })).completo, true);
});

test('F9 Início: cartão com o passo atual em destaque; boas-vindas como diálogo com Começar e Ver depois', async () => {
  const PP = { total: 8, feitos: 1, pct: 13, proximo: 'equipe', completo: false, passos: [
    { chave: 'servicos', n: 1, t: 'Cadastre seus serviços', s: 'x', href: '/painel/servicos', acao: 'Cadastrar serviços', feito: true },
    { chave: 'equipe', n: 2, t: 'Monte sua equipe', s: 'y', href: '/painel/equipe', acao: 'Adicionar', feito: false },
    { chave: 'horarios', n: 3, t: 'Defina os horários', s: 'z', href: '/painel/horarios', acao: 'Definir', feito: false },
  ] };
  const card = await ejs.renderFile(path.join(VIEWS, 'painel/_primeiros-passos.ejs'), { primeirosPassos: PP, barbeariaAtual: { id: 1 } });
  assert.match(card, /role="progressbar" aria-valuenow="1"[^>]*aria-valuemax="8"/);
  assert.match(card, /class="cv-passo ac-proximo"><span class="marca">2<\/span>[\s\S]*?class="cv-btn cv-btn--p ac-pp-btn" href="\/painel\/equipe">Adicionar/);
  assert.match(card, /class="cv-passo feito"/);
  const bv = await ejs.renderFile(path.join(VIEWS, 'painel/_boas-vindas.ejs'), { primeirosPassos: PP, usuario: { nome: 'Rafael Moreira' }, barbeariaAtual: { nome: 'Barbearia Vila Rosa' } });
  assert.match(bv, /role="dialog" aria-modal="true"/);
  assert.match(bv, /Bem-vindo à Cortavo, Rafael\./);
  assert.match(bv, /<span class="cv-num cv-num--p">8<\/span> passos no total/);
  assert.match(bv, /id="bv-comecar"[\s\S]*id="bv-depois"/);
  const ctrl = fs.readFileSync(path.join(RAIZ, 'src/controllers/dashboardController.js'), 'utf8');
  assert.match(ctrl, /\/\^Senha criada\/\.test/);
  assert.match(fs.readFileSync(path.join(RAIZ, 'src/controllers/authController.js'), 'utf8'), /texto: 'Senha criada\. Bem-vindo à Cortavo\.'/);
});
