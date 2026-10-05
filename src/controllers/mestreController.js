// Painel-mestre: área exclusiva do DONO do sistema (super-admin do SaaS).
// Gerencia as barbearias assinantes: criar/editar, equipe (barbeiros + e-mail/senha),
// marca (logo/powered-by) e a operação (impersonação) de cada uma.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const prisma = require('../config/db');
const { caminhoDoUpload } = require('../config/paths');
const { geocodificar } = require('../services/geocodificacao');
const auditoria = require('../services/auditoria');
const planoCortavo = require('../services/planoCortavo');
const custosIA = require('../services/custosIA');
const canaisMensagens = require('../services/canaisMensagens');

// Quantas barbearias por página na lista (paginação server-side).
const POR_PAGINA = 20;

// Senha provisória forte e legível pra passar por telefone/WhatsApp: sem
// caracteres ambíguos (0/O, 1/l/I). O barbeiro entra com ela e o app OBRIGA a
// troca no 1º login (senhaProvisoria = true), então ela nunca fica valendo.
function gerarSenhaProvisoria() {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += alfabeto[bytes[i] % alfabeto.length];
  return s;
}

// Normaliza um slug de subdomínio: minúsculas, sem acentos, só [a-z0-9-].
function normalizarSlug(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// Lê a marca (logo + powered by) de uma barbearia.
async function lerMarca(barbeariaId) {
  const registros = await prisma.configuracao.findMany({
    where: { barbeariaId, chave: { in: ['logo_url', 'mostrar_powered_by'] } },
  });
  const mapa = Object.fromEntries(registros.map((r) => [r.chave, r.valor]));
  return { logoUrl: mapa['logo_url'] || null, mostrarPoweredBy: mapa['mostrar_powered_by'] !== 'false' };
}

// Garante as configurações padrão de uma barbearia recém-criada.
// (O 'caixa_automatico' saiu: concluir um atendimento SEMPRE entra no caixa
// agora — antes ele nascia 'false' e a barbearia parecia não faturar.)
async function criarConfigsPadrao(barbeariaId) {
  const padroes = [
    ['logo_url', ''],
    ['mostrar_powered_by', 'true'],
  ];
  for (const [chave, valor] of padroes) {
    await prisma.configuracao.upsert({
      where: { barbeariaId_chave: { barbeariaId, chave } },
      update: {},
      create: { barbeariaId, chave, valor },
    });
  }
}

// GET /mestre — lista de barbearias com busca, filtro de status e paginação.
async function painel(req, res) {
  const q = (req.query.q || '').trim();
  const status = ['ativa', 'inativa'].includes(req.query.status) ? req.query.status : 'todas';
  const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);

  // Monta o filtro a partir da busca (nome OU slug) e do status. SQLite no
  // Prisma não tem `mode: insensitive`; o slug já é minúsculo e a busca por
  // nome casa por substring — suficiente pra uma lista de assinantes.
  const where = {};
  if (q) where.OR = [{ nome: { contains: q } }, { slug: { contains: q.toLowerCase() } }];
  if (status === 'ativa') where.ativo = true;
  else if (status === 'inativa') where.ativo = false;

  const total = await prisma.barbearia.count({ where });
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const paginaAtual = Math.min(pagina, totalPaginas);

  const barbearias = await prisma.barbearia.findMany({
    where,
    orderBy: { criadoEm: 'desc' },
    include: { _count: { select: { usuarios: true, clientes: true, agendamentos: true } } },
    skip: (paginaAtual - 1) * POR_PAGINA,
    take: POR_PAGINA,
  });
  // Aviso de barbeiros (fase 2.4): conta só os ATIVOS, igual ao detalhe.
  const ativosPorBarbearia = new Map();
  if (barbearias.length) {
    const grupos = await prisma.usuario.groupBy({
      by: ['barbeariaId'],
      where: { barbeariaId: { in: barbearias.map((x) => x.id) }, ativo: true },
      _count: { _all: true },
    });
    for (const g of grupos) ativosPorBarbearia.set(g.barbeariaId, g._count._all);
  }
  for (const x of barbearias) x.barbeirosAtivos = ativosPorBarbearia.get(x.id) || 0;

  res.render('mestre/painel', {
    layout: 'layouts/mestre',
    titulo: 'Painel-mestre',
    barbearias,
    total,
    filtros: { q, status },
    paginacao: { pagina: paginaAtual, totalPaginas },
    backup: statusBackup(),
    // Fase 2.4: plano de cada uma e aviso de barbeiros acima da referência
    // (nunca bloqueia; spec 04, regra 3).
    planoDe: planoCortavo.planoDe,
    avisoBarbeiros: planoCortavo.avisoBarbeiros,
  });
}

// Situação do backup semanal (scripts/backup-semanal.js grava o histórico).
// "Atrasado" = último backup OK há mais de 2 dias — pega também o caso de o
// cron simplesmente NÃO ter rodado (sem erro nenhum registrado).
function statusBackup() {
  let hist = [];
  try {
    hist = JSON.parse(require('fs').readFileSync(require('path').join(require('../config/paths').appDataDir, 'backups', 'historico.json'), 'utf8'));
  } catch (_) { /* ainda não rodou */ }
  const backups = hist.filter((h) => !h.teste);
  const ultimo = backups[0] || null;
  const ultimoOk = backups.find((h) => h.ok) || null;
  const dias = ultimoOk ? (Date.now() - new Date(ultimoOk.quando).getTime()) / 86400000 : null;
  const teste = hist.find((h) => h.teste) || null;
  return {
    ultimo,
    ultimoOk,
    teste,
    situacao: !ultimo ? 'nunca' : !ultimo.ok ? 'falhou' : dias > 2 ? 'atrasado' : 'ok',
  };
}

// GET /mestre/nova — formulário de nova barbearia (+ primeiro admin).
function formNova(req, res) {
  res.render('mestre/barbearia-nova', { layout: 'layouts/mestre', titulo: 'Nova barbearia', valores: null, erro: null, planos: planoCortavo.planosParaSeletor() });
}

// POST /mestre/barbearias — cria a barbearia e o admin inicial.
async function criarBarbearia(req, res) {
  const nome = (req.body.nome || '').trim();
  const slug = normalizarSlug(req.body.slug || nome);
  const adminNome = (req.body.adminNome || '').trim();
  const adminEmail = (req.body.adminEmail || '').trim().toLowerCase();
  const adminSenha = req.body.adminSenha || '';
  const plano = String(req.body.plano || '');

  const erros = [];
  if (!nome) erros.push('Informe o nome da barbearia.');
  if (!slug) erros.push('Informe um subdomínio válido.');
  if (!adminNome) erros.push('Informe o nome do admin.');
  if (!adminEmail) erros.push('Informe o e-mail do admin.');
  if (adminSenha.length < 6) erros.push('A senha do admin precisa de no mínimo 6 caracteres.');
  if (!planoCortavo.chaveValida(plano)) erros.push('Escolha o plano da Cortavo.');
  if (slug && (await prisma.barbearia.findUnique({ where: { slug } }))) {
    erros.push('Já existe uma barbearia com esse subdomínio.');
  }

  if (erros.length) {
    return res.render('mestre/barbearia-nova', {
      layout: 'layouts/mestre',
      titulo: 'Nova barbearia',
      valores: req.body,
      erro: erros.join(' '),
      planos: planoCortavo.planosParaSeletor(),
    });
  }

  const barbearia = await prisma.barbearia.create({ data: { nome, slug, planoCortavo: plano, planoCortavoDesde: new Date() } });
  await prisma.usuario.create({
    data: {
      barbeariaId: barbearia.id,
      nome: adminNome,
      email: adminEmail,
      senhaHash: await bcrypt.hash(adminSenha, 10),
      papel: 'admin',
    },
  });
  await criarConfigsPadrao(barbearia.id);

  await auditoria.registrar(req, {
    acao: 'barbearia.criar',
    alvoTipo: 'barbearia',
    alvoId: barbearia.id,
    detalhe: `Criou "${nome}" (slug ${slug}) com admin ${adminEmail}, plano ${planoCortavo.planoDe(plano).nome}.`,
  });
  req.session.flash = { tipo: 'sucesso', texto: 'Barbearia criada.' };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// Carrega a barbearia do parâmetro ou redireciona.
async function carregarBarbearia(req, res) {
  const barbearia = await prisma.barbearia.findUnique({ where: { id: Number(req.params.id) } });
  if (!barbearia) {
    req.session.flash = { tipo: 'erro', texto: 'Barbearia não encontrada.' };
    res.redirect('/mestre');
    return null;
  }
  return barbearia;
}

// GET /mestre/barbearias/:id — detalhe (editar barbearia + equipe + marca).
async function detalhe(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;

  const equipe = await prisma.usuario.findMany({
    where: { barbeariaId: barbearia.id },
    orderBy: [{ papel: 'asc' }, { nome: 'asc' }],
  });
  const marca = await lerMarca(barbearia.id);

  res.render('mestre/barbearia-detalhe', {
    layout: 'layouts/mestre',
    titulo: barbearia.nome,
    barbearia,
    equipe,
    marca,
    plano: planoCortavo.planoDe(barbearia.planoCortavo),
    planos: planoCortavo.planosParaSeletor(),
    avisoBarbeiros: planoCortavo.avisoBarbeiros(planoCortavo.planoDe(barbearia.planoCortavo), equipe.filter((m) => m.ativo !== false).length, barbearia.nome),
  });
}

// POST /mestre/barbearias/:id — atualiza nome/slug/ativo/endereço.
async function atualizarBarbearia(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;

  const nome = (req.body.nome || '').trim();
  const slug = normalizarSlug(req.body.slug || nome);
  const endereco = (req.body.endereco || '').trim() || null;

  if (!nome || !slug) {
    req.session.flash = { tipo: 'erro', texto: 'Nome e subdomínio são obrigatórios.' };
    return res.redirect('/mestre/barbearias/' + barbearia.id);
  }
  const conflito = await prisma.barbearia.findFirst({ where: { slug, NOT: { id: barbearia.id } } });
  if (conflito) {
    req.session.flash = { tipo: 'erro', texto: 'Esse subdomínio já está em uso por outra barbearia.' };
    return res.redirect('/mestre/barbearias/' + barbearia.id);
  }

  // `ativo` NÃO entra aqui de propósito: suspender/reativar tem ação própria
  // (/ativa) que grava auditoria. Se o status viesse por este form também,
  // haveria um caminho de suspensão SEM registro — e pior, salvar os dados sem o
  // checkbox marcado suspenderia a barbearia sem querer.
  const dados = { nome, slug, endereco };

  // Só geocodifica quando o endereço muda (evita bater no Nominatim à toa e
  // preserva as coordenadas se o texto continuou igual). Endereço apagado zera
  // as coordenadas — a barbearia sai da busca "perto de você".
  let avisoGeo = '';
  if (endereco !== barbearia.endereco) {
    if (!endereco) {
      dados.latitude = null;
      dados.longitude = null;
    } else {
      const geo = await geocodificar(endereco);
      if (geo) {
        dados.latitude = geo.latitude;
        dados.longitude = geo.longitude;
      } else {
        dados.latitude = null;
        dados.longitude = null;
        avisoGeo = ' Não consegui localizar esse endereço no mapa — confira e salve de novo para aparecer na busca do app.';
      }
    }
  }

  await prisma.barbearia.update({ where: { id: barbearia.id }, data: dados });
  req.session.flash = { tipo: avisoGeo ? 'erro' : 'sucesso', texto: 'Barbearia atualizada.' + avisoGeo };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/barbearias/:id/remover — exclui a barbearia (cascata).
async function removerBarbearia(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  await prisma.barbearia.delete({ where: { id: barbearia.id } }).catch(() => {});
  // Se estava operando essa barbearia, encerra a impersonação.
  if (req.session.barbeariaAtivaId === barbearia.id) delete req.session.barbeariaAtivaId;
  await auditoria.registrar(req, {
    acao: 'barbearia.excluir',
    alvoTipo: 'barbearia',
    alvoId: barbearia.id,
    detalhe: `Excluiu "${barbearia.nome}" (slug ${barbearia.slug}) e todos os dados.`,
  });
  req.session.flash = { tipo: 'sucesso', texto: 'Barbearia excluída.' };
  res.redirect('/mestre');
}

// POST /mestre/barbearias/:id/equipe — adiciona um barbeiro à barbearia.
async function criarBarbeiro(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;

  const nome = (req.body.nome || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const senha = req.body.senha || '';
  const papel = req.body.papel === 'admin' ? 'admin' : 'funcionario';

  if (!nome || !email || senha.length < 6) {
    req.session.flash = { tipo: 'erro', texto: 'Preencha nome, e-mail e senha (mínimo 6 caracteres).' };
    return res.redirect('/mestre/barbearias/' + barbearia.id);
  }
  const existe = await prisma.usuario.findUnique({
    where: { barbeariaId_email: { barbeariaId: barbearia.id, email } },
  });
  if (existe) {
    req.session.flash = { tipo: 'erro', texto: 'Já existe um usuário com esse e-mail nesta barbearia.' };
    return res.redirect('/mestre/barbearias/' + barbearia.id);
  }

  const novo = await prisma.usuario.create({
    data: { barbeariaId: barbearia.id, nome, email, senhaHash: await bcrypt.hash(senha, 10), papel },
  });
  await auditoria.registrar(req, {
    acao: 'usuario.criar',
    alvoTipo: 'usuario',
    alvoId: novo.id,
    detalhe: `Adicionou ${email} (${papel}) à barbearia "${barbearia.nome}".`,
  });
  req.session.flash = { tipo: 'sucesso', texto: `${nome} adicionado à equipe.` };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// GET /mestre/barbearias/:id/equipe/:uid/editar — edita um barbeiro.
async function formEditarBarbeiro(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const membro = await prisma.usuario.findFirst({
    where: { id: Number(req.params.uid), barbeariaId: barbearia.id },
  });
  if (!membro) return res.redirect('/mestre/barbearias/' + barbearia.id);
  res.render('mestre/barbeiro-editar', { layout: 'layouts/mestre', titulo: 'Editar ' + membro.nome, barbearia, membro });
}

// POST /mestre/barbearias/:id/equipe/:uid — atualiza nome/e-mail/senha/papel.
async function atualizarBarbeiro(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const uid = Number(req.params.uid);
  const membro = await prisma.usuario.findFirst({ where: { id: uid, barbeariaId: barbearia.id } });
  if (!membro) return res.redirect('/mestre/barbearias/' + barbearia.id);

  const nome = (req.body.nome || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const papel = req.body.papel === 'admin' ? 'admin' : 'funcionario';
  const senha = req.body.senha || '';

  if (!nome || !email) {
    req.session.flash = { tipo: 'erro', texto: 'Nome e e-mail são obrigatórios.' };
    return res.redirect(`/mestre/barbearias/${barbearia.id}/equipe/${uid}/editar`);
  }
  if (senha && senha.length < 6) {
    req.session.flash = { tipo: 'erro', texto: 'A nova senha precisa de no mínimo 6 caracteres.' };
    return res.redirect(`/mestre/barbearias/${barbearia.id}/equipe/${uid}/editar`);
  }
  const conflito = await prisma.usuario.findFirst({
    where: { barbeariaId: barbearia.id, email, NOT: { id: uid } },
  });
  if (conflito) {
    req.session.flash = { tipo: 'erro', texto: 'Esse e-mail já está em uso por outro usuário desta barbearia.' };
    return res.redirect(`/mestre/barbearias/${barbearia.id}/equipe/${uid}/editar`);
  }

  const data = { nome, email, papel };
  const trocouSenha = senha.length >= 6;
  if (trocouSenha) data.senhaHash = await bcrypt.hash(senha, 10);
  await prisma.usuario.update({ where: { id: uid }, data });
  await auditoria.registrar(req, {
    acao: 'usuario.editar',
    alvoTipo: 'usuario',
    alvoId: uid,
    detalhe: `Editou ${email} na "${barbearia.nome}"` + (trocouSenha ? ' (incluindo a senha).' : '.'),
  });
  req.session.flash = { tipo: 'sucesso', texto: 'Dados do barbeiro atualizados.' };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/barbearias/:id/equipe/:uid/toggle — ativa/desativa um barbeiro.
async function toggleBarbeiro(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const membro = await prisma.usuario.findFirst({
    where: { id: Number(req.params.uid), barbeariaId: barbearia.id },
  });
  if (membro) {
    await prisma.usuario.update({ where: { id: membro.id }, data: { ativo: !membro.ativo } });
    await auditoria.registrar(req, {
      acao: membro.ativo ? 'usuario.desativar' : 'usuario.ativar',
      alvoTipo: 'usuario',
      alvoId: membro.id,
      detalhe: `${membro.ativo ? 'Desativou' : 'Ativou'} ${membro.email} na "${barbearia.nome}".`,
    });
  }
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/barbearias/:id/equipe/:uid/reset-senha — gera uma senha
// provisória para um membro da equipe. A senha atual NUNCA é exposta (é hash);
// geramos uma nova aleatória, marcamos como provisória (o app obriga a troca no
// 1º login) e mostramos UMA vez pro dono repassar. Serve pra "o dono da
// barbearia esqueceu a senha".
async function resetarSenha(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const uid = Number(req.params.uid);
  const membro = await prisma.usuario.findFirst({ where: { id: uid, barbeariaId: barbearia.id } });
  if (!membro) {
    req.session.flash = { tipo: 'erro', texto: 'Usuário não encontrado nesta barbearia.' };
    return res.redirect('/mestre/barbearias/' + barbearia.id);
  }

  const provisoria = gerarSenhaProvisoria();
  await prisma.usuario.update({
    where: { id: uid },
    data: { senhaHash: await bcrypt.hash(provisoria, 10), senhaProvisoria: true },
  });
  await auditoria.registrar(req, {
    acao: 'usuario.reset_senha',
    alvoTipo: 'usuario',
    alvoId: uid,
    detalhe: `Gerou senha provisória para ${membro.email} na "${barbearia.nome}".`,
  });

  // A senha provisória vai no flash uma única vez (não fica salva em lugar
  // nenhum em texto). O dono copia e repassa; no 1º login o app força a troca.
  req.session.flash = {
    tipo: 'sucesso',
    texto: `Senha provisória de ${membro.nome}: ${provisoria} — copie agora, ela não será mostrada de novo. No 1º login o app pede a troca.`,
  };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/barbearias/:id/ativa — suspende (ativa=false) ou reativa
// (ativa=true) a barbearia. Desativada, o login e o agendamento ficam bloqueados
// (o middleware de tenant só resolve barbearia com `ativo:true`).
async function definirAtiva(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const ativa = req.body.ativa === 'true';
  await prisma.barbearia.update({ where: { id: barbearia.id }, data: { ativo: ativa } });
  // Suspender enquanto opera a barbearia: encerra a impersonação pra não seguir
  // dentro de uma conta suspensa.
  if (!ativa && req.session.barbeariaAtivaId === barbearia.id) delete req.session.barbeariaAtivaId;
  await auditoria.registrar(req, {
    acao: ativa ? 'barbearia.reativar' : 'barbearia.suspender',
    alvoTipo: 'barbearia',
    alvoId: barbearia.id,
    detalhe: `${ativa ? 'Reativou' : 'Pausou'} "${barbearia.nome}".`,
  });
  req.session.flash = { tipo: 'sucesso', texto: ativa ? 'Barbearia reativada.' : 'Acesso da barbearia pausado.' };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/barbearias/:id/plano — troca o plano da Cortavo (fase 2.2,
// spec 04). Só a Kalany (papel dono: a rota inteira do mestre exige exigeDono).
// Vale na hora; dados das funções desligadas ficam guardados.
async function definirPlano(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const novo = String(req.body.plano || '');
  if (!planoCortavo.chaveValida(novo)) {
    req.session.flash = { tipo: 'erro', texto: 'Plano inválido.' };
    return res.redirect('/mestre/barbearias/' + barbearia.id);
  }
  const antes = planoCortavo.planoDe(barbearia.planoCortavo);
  if (antes.chave !== novo) {
    await prisma.barbearia.update({ where: { id: barbearia.id }, data: { planoCortavo: novo, planoCortavoDesde: new Date() } });
    await auditoria.registrar(req, {
      acao: 'barbearia.plano',
      alvoTipo: 'barbearia',
      alvoId: barbearia.id,
      detalhe: `Plano de "${barbearia.nome}": ${antes.nome} -> ${planoCortavo.planoDe(novo).nome}.`,
    });
  }
  req.session.flash = { tipo: 'sucesso', texto: 'Plano: ' + planoCortavo.planoDe(novo).nome + '.' };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/barbearias/:id/notas — salva as notas internas do dono do SaaS
// sobre a barbearia (só o painel-mestre vê; a barbearia nunca).
async function salvarNotas(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const notas = (req.body.notasInternas || '').trim().slice(0, 5000) || null;
  await prisma.barbearia.update({ where: { id: barbearia.id }, data: { notasInternas: notas } });
  req.session.flash = { tipo: 'sucesso', texto: 'Notas salvas.' };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// GET /mestre/auditoria — trilha de auditoria (ações administrativas), paginada.
async function auditoriaLista(req, res) {
  const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
  const total = await prisma.logAuditoria.count();
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const paginaAtual = Math.min(pagina, totalPaginas);
  const logs = await prisma.logAuditoria.findMany({
    orderBy: { criadoEm: 'desc' },
    skip: (paginaAtual - 1) * POR_PAGINA,
    take: POR_PAGINA,
  });
  res.render('mestre/auditoria', {
    layout: 'layouts/mestre',
    titulo: 'Auditoria',
    logs,
    total,
    paginacao: { pagina: paginaAtual, totalPaginas },
  });
}

// POST /mestre/barbearias/:id/marca — salva logo (upload) + powered-by.
async function salvarMarca(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const barbeariaId = barbearia.id;
  const mostrarPoweredBy = req.body.mostrar_powered_by === 'on';

  await prisma.configuracao.upsert({
    where: { barbeariaId_chave: { barbeariaId, chave: 'mostrar_powered_by' } },
    update: { valor: String(mostrarPoweredBy) },
    create: { barbeariaId, chave: 'mostrar_powered_by', valor: String(mostrarPoweredBy) },
  });

  if (req.file) {
    const atual = await prisma.configuracao.findUnique({
      where: { barbeariaId_chave: { barbeariaId, chave: 'logo_url' } },
    });
    const anterior = atual && caminhoDoUpload(atual.valor);
    if (anterior) fs.unlink(anterior, () => {});
    const novoUrl = '/uploads/' + req.file.filename;
    await prisma.configuracao.upsert({
      where: { barbeariaId_chave: { barbeariaId, chave: 'logo_url' } },
      update: { valor: novoUrl },
      create: { barbeariaId, chave: 'logo_url', valor: novoUrl },
    });
  }

  req.session.flash = { tipo: 'sucesso', texto: 'Marca atualizada.' };
  res.redirect('/mestre/barbearias/' + barbeariaId);
}

// POST /mestre/barbearias/:id/marca/remover-logo — remove o logo.
async function removerLogo(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const atual = await prisma.configuracao.findUnique({
    where: { barbeariaId_chave: { barbeariaId: barbearia.id, chave: 'logo_url' } },
  });
  if (atual && atual.valor) {
    const arq = caminhoDoUpload(atual.valor);
    if (arq) fs.unlink(arq, () => {});
    await prisma.configuracao.update({
      where: { barbeariaId_chave: { barbeariaId: barbearia.id, chave: 'logo_url' } },
      data: { valor: '' },
    });
  }
  req.session.flash = { tipo: 'sucesso', texto: 'Logo removido.' };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/barbearias/:id/capa — envia/troca a foto de capa (hero da Home).
async function salvarCapa(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  if (req.file) {
    const anterior = caminhoDoUpload(barbearia.capaUrl);
    if (anterior) fs.unlink(anterior, () => {});
    await prisma.barbearia.update({
      where: { id: barbearia.id },
      data: { capaUrl: '/uploads/' + req.file.filename },
    });
    req.session.flash = { tipo: 'sucesso', texto: 'Foto de capa atualizada.' };
  }
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/barbearias/:id/capa/remover — remove a foto de capa.
async function removerCapa(req, res) {
  const barbearia = await carregarBarbearia(req, res);
  if (!barbearia) return;
  const anterior = caminhoDoUpload(barbearia.capaUrl);
  if (anterior) fs.unlink(anterior, () => {});
  await prisma.barbearia.update({ where: { id: barbearia.id }, data: { capaUrl: null } });
  req.session.flash = { tipo: 'sucesso', texto: 'Foto de capa removida.' };
  res.redirect('/mestre/barbearias/' + barbearia.id);
}

// POST /mestre/entrar/:id — o dono passa a operar uma barbearia (impersonação).
async function entrar(req, res) {
  const id = Number(req.params.id);
  const barbearia = await prisma.barbearia.findUnique({ where: { id } });
  if (!barbearia) {
    req.session.flash = { tipo: 'erro', texto: 'Barbearia não encontrada.' };
    return res.redirect('/mestre');
  }
  req.session.barbeariaAtivaId = barbearia.id;
  await auditoria.registrar(req, {
    acao: 'barbearia.impersonar',
    alvoTipo: 'barbearia',
    alvoId: barbearia.id,
    detalhe: `Entrou (operou) a barbearia "${barbearia.nome}".`,
  });
  res.redirect('/painel');
}

// POST /mestre/sair — encerra a operação de uma barbearia e volta ao painel-mestre.
async function sair(req, res) {
  delete req.session.barbeariaAtivaId;
  res.redirect('/mestre');
}

// GET /mestre/uso — uso & custos de IA por barbearia (mês). ?competencia=AAAA-MM.
async function usoCustos(req, res) {
  const dados = await custosIA.resumo(req.query.competencia);
  res.render('mestre/uso', { layout: 'layouts/mestre', titulo: 'Uso & custos', ...dados });
}

// GET /mestre/uso.json — mesmos dados em JSON, para a atualização em tempo real.
async function usoCustosJson(req, res) {
  res.json(await custosIA.resumo(req.query.competencia));
}

// GET /mestre/canais — canais de agendamento + mensagens enviadas (mês, todas
// as barbearias). ?competencia=AAAA-MM.
async function canaisMensagensView(req, res) {
  const dados = await canaisMensagens.resumo(req.query.competencia);
  res.render('mestre/canais', { layout: 'layouts/mestre', titulo: 'Canais & mensagens', ...dados });
}

module.exports = {
  painel,
  usoCustos,
  usoCustosJson,
  canaisMensagensView,
  formNova,
  criarBarbearia,
  detalhe,
  atualizarBarbearia,
  removerBarbearia,
  criarBarbeiro,
  formEditarBarbeiro,
  atualizarBarbeiro,
  toggleBarbeiro,
  salvarMarca,
  removerLogo,
  salvarCapa,
  removerCapa,
  entrar,
  sair,
  resetarSenha,
  definirAtiva,
  salvarNotas,
  auditoriaLista,
  definirPlano,
};
