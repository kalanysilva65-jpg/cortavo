// Rotas internas (painel da equipe). Tudo aqui exige login.
const express = require('express');
const router = express.Router();
const { exigeLogin, exigeAdmin } = require('../middlewares/auth');
const { exigeBarbeariaPainel } = require('../middlewares/tenant');
const { exigeFuncaoDoPlano } = require('../middlewares/planoCortavo');
const planoCortavo = require('../services/planoCortavo');
const testeGratis = require('../services/testeGratis');
const prisma = require('../config/db');
const agendaController = require('../controllers/agendaController');
const horarioController = require('../controllers/horarioController');
const servicoController = require('../controllers/servicoController');
const estoqueController = require('../controllers/estoqueController');
const caixaController = require('../controllers/caixaController');
const comissaoController = require('../controllers/comissaoController');
const clienteController = require('../controllers/clienteController');
const planoController = require('../controllers/planoController');
const dashboardController = require('../controllers/dashboardController');
const perfilController = require('../controllers/perfilController');
const equipeController = require('../controllers/equipeController');
const relatorioController = require('../controllers/relatorioController');
const fidelidadeController = require('../controllers/fidelidadeController');
const notificacaoController = require('../controllers/notificacaoController');
const exportacaoController = require('../controllers/exportacaoController');
const metaController = require('../controllers/metaController');
const permissoes = require('../services/permissoes');
const iaController = require('../controllers/iaController');
const secretariaController = require('../controllers/secretariaController');
const logoController = require('../controllers/logoController');
const meuPlanoController = require('../controllers/meuPlanoController');
const conversasController = require('../controllers/conversasController');
const { limiteIA } = require('../middlewares/rateLimit');
const ia = require('../services/ia');
const upload = require('../middlewares/upload');
const multer = require('multer');

// Mídia enviada pelo painel no chat do WhatsApp: fica na MEMÓRIA (vai direto
// pra Meta e pro armazenamento privado). 16 MB = teto da Meta p/ áudio/vídeo.
const uploadWa = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
function uploadMidiaWa(req, res, next) {
  uploadWa.single('arquivo')(req, res, (err) => {
    if (err) return res.status(400).json({ erro: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que 16 MB.' : 'Falha no envio do arquivo.' });
    next();
  });
}

// Envolve o upload do multer para tratar erros (tamanho/formato) com mensagem amigável.
function uploadFoto(req, res, next) {
  upload.single('foto')(req, res, (err) => {
    if (err) {
      req.session.flash = { tipo: 'erro', texto: err.message || 'Falha no upload da imagem.' };
      return res.redirect('/painel/servicos');
    }
    next();
  });
}

// Upload da logo do agendamento público (dono da barbearia).
function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, (err) => {
    if (err) {
      req.session.flash = { tipo: 'erro', texto: err.message || 'Falha no upload da imagem.' };
      return res.redirect('/painel/logo');
    }
    next();
  });
}

// Upload da foto do próprio usuário logado (hero do painel).
function uploadFotoPerfil(req, res, next) {
  upload.single('foto')(req, res, (err) => {
    if (err) {
      req.session.flash = { tipo: 'erro', texto: err.message || 'Falha no upload da imagem.' };
      return res.redirect(req.get('Referer') || '/painel');
    }
    next();
  });
}

// Upload da foto do barbeiro (volta para a tela de Comissões em caso de erro).
function uploadFotoBarbeiro(req, res, next) {
  upload.single('foto')(req, res, (err) => {
    if (err) {
      req.session.flash = { tipo: 'erro', texto: err.message || 'Falha no upload da foto.' };
      return res.redirect('/painel/comissoes');
    }
    next();
  });
}

// Idem, mas volta para a Equipe em caso de erro.
function uploadFotoEquipe(req, res, next) {
  upload.single('foto')(req, res, (err) => {
    if (err) {
      req.session.flash = { tipo: 'erro', texto: err.message || 'Falha no upload da foto.' };
      return res.redirect('/painel/equipe');
    }
    next();
  });
}

// Tudo abaixo exige usuário logado E uma barbearia no contexto.
router.use(exigeLogin);
router.use(exigeBarbeariaPainel);

// "Qui, 3 jul" — usado no subtítulo constante do cabeçalho do painel.
const DIAS_SEMANA_ABR = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES_ABR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function formatarDataCabecalho(d) {
  return `${DIAS_SEMANA_ABR[d.getDay()]}, ${d.getDate()} ${MESES_ABR[d.getMonth()]}`;
}

// Define o "papel efetivo": o dono, ao entrar numa barbearia, age como admin dela.
// Também carrega a barbearia ativa (nome) para o cabeçalho / banner do dono.
router.use(async (req, res, next) => {
  const u = req.session.usuario;
  req.ehAdmin = u.papel === 'admin' || u.papel === 'dono';
  res.locals.ehAdmin = req.ehAdmin;
  res.locals.ehDono = u.papel === 'dono';
  const barbearia = await prisma.barbearia.findUnique({ where: { id: req.barbeariaId } });
  res.locals.barbeariaAtual = barbearia || null;
  const usuarioDb = await prisma.usuario.findUnique({ where: { id: u.id } });
  res.locals.usuarioFotoUrl = usuarioDb ? usuarioDb.fotoUrl : null;
  res.locals.usuarioPrimeiroNome = (u.nome || '').split(' ')[0];
  res.locals.hojeFormatado = formatarDataCabecalho(new Date());
  // O item "Assistente" no menu só aparece quando a IA está configurada (chave
  // da API presente no servidor).
  res.locals.iaAtiva = ia.iaHabilitada();

  // Telas que ESTE funcionário não pode abrir (escolhidas pelo admin na Equipe).
  // Admin/dono nunca é restringido.
  const bloqueados = req.ehAdmin ? new Set() : permissoes.bloqueadosDe(usuarioDb);
  res.locals.podeAcessar = (href) => {
    const mod = permissoes.moduloDoCaminho(String(href || '').replace(/^\/painel/, '') || '/');
    return !mod || !bloqueados.has(mod.chave);
  };
  const modAtual = permissoes.moduloDoCaminho(req.path);
  if (modAtual && bloqueados.has(modAtual.chave)) {
    if (req.method === 'GET' && !req.xhr && (req.headers.accept || '').includes('text/html')) {
      req.session.flash = { tipo: 'erro', texto: 'Você não tem acesso a ' + modAtual.rotulo + '. Fale com o responsável da barbearia.' };
      return res.redirect('/painel');
    }
    return res.status(403).json({ erro: 'Sem acesso a esta área.' });
  }

  // Alerta de estoque baixo (admin) — mostrado no subtítulo do cabeçalho em todas as telas.
  res.locals.estoqueBaixoCount = 0;
  // Fase 2 (B3): fora do plano, o cabeçalho não fala de estoque.
  if (req.ehAdmin && planoCortavo.libera(planoCortavo.planoDe(barbearia && barbearia.planoCortavo), 'estoque')) {
    const itens = await prisma.estoque.findMany({ where: { barbeariaId: req.barbeariaId } });
    res.locals.estoqueBaixoCount = itens.filter((i) => i.quantidade <= i.quantidadeMinima).length;
  }
  // Fase 2.7: faixa "Seu teste grátis termina em X dias" (sem botão de pagar).
  res.locals.faixaTeste = req.ehAdmin ? testeGratis.faixaDono(barbearia) : null; // só dono/admin (correção Sergio 7)
  next();
});

// Plano da Cortavo (fase 2.2): rotas fora do plano param aqui, no servidor.
router.use(exigeFuncaoDoPlano);

// Painel (dashboard).
router.get('/', dashboardController.ver);

// Foto do próprio usuário logado (hero do painel).
router.get('/logo', exigeAdmin, logoController.ver);
router.post('/logo', exigeAdmin, uploadLogo, logoController.salvar);
router.post('/logo/remover', exigeAdmin, logoController.remover);
router.post('/perfil/foto', uploadFotoPerfil, perfilController.salvarFoto);
router.post('/perfil/foto/remover', perfilController.removerFoto);
// A jornada é editada no Perfil (a tela /painel/horarios saiu do menu em
// 2026-08-01). Reusa o mesmo controller: a regra de "funcionário só edita a
// própria jornada" já vive lá, e duplicá-la seria criar dois lugares para
// errar. O `retorno=perfil` do formulário traz o usuário de volta pra cá.
router.post('/perfil/jornada', horarioController.salvarJornada);

// Redesign v3 (fatia F1): a navbar tem 5 seções fixas para todos (spec 12).
// "Mais" virou a lista de seções (cadastros, equipe, conta) e o perfil com
// foto e jornada mudou para /painel/perfil. "Gestão" reúne caixa, relatórios,
// comissões, metas e cadastros; para quem não tem nada liberado mostra o
// estado vazio da spec 12 (nunca 403). Os itens são filtrados na view pelas
// mesmas regras de antes (podeAcessar, exigeAdmin, plano).
// TODO(Beto B4): cartões-resumo da Gestão com /painel/api/gestao/*.
router.get('/mais', (req, res) => res.render('painel/mais', { titulo: 'Mais' }));
router.get('/perfil', perfilController.ver);
router.get('/gestao', (req, res) => res.render('painel/gestao', { titulo: 'Gestão' }));
// Fase 2.4: plano da Cortavo da barbearia (só admin/dono; barbeiro não vê plano).
router.get('/meu-plano', exigeAdmin, meuPlanoController.ver);

// Backup manual dos dados (só admin — inclui financeiro e todos os clientes).
// JSON = cópia fiel para restaurar; PDF = documento legível para arquivo.
router.get('/exportar/dados.json', exigeAdmin, exportacaoController.json);
router.get('/exportar/relatorio.pdf', exigeAdmin, exportacaoController.pdf);
router.get('/exportar/relatorio', exigeAdmin, exportacaoController.visualizar);

// Assistente Cortavo (IA de consulta). Disponível para admin E barbeiro — o
// escopo (barbearia toda ou só o próprio barbeiro) é resolvido no controller a
// partir da sessão. Read-only. A rota de mensagem tem freio de uso próprio.
router.get('/ia', iaController.ver);
router.post('/ia/mensagem', limiteIA, iaController.mensagem);
router.post('/ia/acao', limiteIA, iaController.acao); // executa a ação após o usuário confirmar

// Secretária (IA que atende o cliente) — CHAT DE TESTE da etapa 3.1. Só admin,
// para calibrar as respostas antes de ligar o WhatsApp. Nada é gravado aqui.
router.get('/secretaria', exigeAdmin, secretariaController.verConfig);
router.post('/secretaria', exigeAdmin, secretariaController.salvarConfig);
router.get('/secretaria/teste', exigeAdmin, secretariaController.verTeste);
router.post('/secretaria/teste/mensagem', exigeAdmin, limiteIA, secretariaController.mensagemTeste);
// Conectar o WhatsApp da barbearia por Embedded Signup (coexistência) — só admin.
router.post('/secretaria/whatsapp/conectar', exigeAdmin, secretariaController.conectarWhatsApp);
router.post('/secretaria/whatsapp/desconectar', exigeAdmin, secretariaController.desconectarWhatsApp);
// Número registrado pela conta de WhatsApp da Cortavo (cobrança no cartão da Cortavo).
// Perfil comercial do WhatsApp (foto, sobre, descrição...) — só admin.
function uploadFotoPerfilWa(req, res, next) {
  uploadWa.single('foto')(req, res, (err) => {
    if (err) return res.status(400).json({ erro: err.code === 'LIMIT_FILE_SIZE' ? 'Foto maior que o limite.' : 'Falha no envio da foto.' });
    next();
  });
}
router.get('/secretaria/whatsapp/perfil', exigeAdmin, secretariaController.lerPerfilWa);
router.post('/secretaria/whatsapp/perfil', exigeAdmin, uploadFotoPerfilWa, secretariaController.salvarPerfilWa);
router.post('/secretaria/whatsapp/numero/codigo', exigeAdmin, secretariaController.pedirCodigoNumero);
router.post('/secretaria/whatsapp/numero/reenviar', exigeAdmin, secretariaController.reenviarCodigoNumero);
router.post('/secretaria/whatsapp/numero/verificar', exigeAdmin, secretariaController.verificarCodigoNumero);
// Pausar/reativar a IA por barbearia (mantém o número conectado).
router.post('/secretaria/ia/pausar', exigeAdmin, secretariaController.pausarIA);

// Caixa de entrada (Fase 3.2): conversas de WhatsApp da barbearia. Admin E
// barbeiro (é o balcão compartilhado). `/simular` injeta uma mensagem de cliente
// para testar sem o WhatsApp (só admin) — específica ANTES da paramétrica.
router.get('/conversas', conversasController.ver);
router.get('/conversas/fragmento', conversasController.fragmento); // auto-atualização da lista
router.post('/conversas/simular', exigeAdmin, limiteIA, conversasController.simular);
router.get('/conversas/:id/novas', conversasController.novas); // auto-atualização do chat
router.get('/conversas/midia/:mensagemId', conversasController.midia); // mídia das conversas (privada)
router.post('/conversas/:id/midia', uploadMidiaWa, conversasController.enviarMidia);
router.post('/conversas/:id/responder', conversasController.responder);
router.post('/conversas/:id/ia', conversasController.definirIA);
router.post('/conversas/:id/excluir', conversasController.excluir);

// Metas (admin): metas configuráveis por métrica e escopo, progresso do mês.
router.get('/metas', exigeAdmin, metaController.listar);
router.post('/metas', exigeAdmin, metaController.criar);
router.post('/metas/:id/remover', exigeAdmin, metaController.remover);

// --- Avisos no aparelho ----------------------------------------------------
// Agem sempre sobre o usuário logado (nunca sobre um id vindo do corpo), senão
// daria para inscrever o aparelho de um barbeiro na conta de outro.
router.get('/notificacoes/chave', notificacaoController.chave);
router.post('/notificacoes/inscrever', notificacaoController.inscrever);
router.post('/notificacoes/cancelar', notificacaoController.cancelar);
router.post('/notificacoes/testar', notificacaoController.testar);

// --- Agenda (todos: funcionário vê a sua, admin vê todas) -----------------
router.get('/agenda', agendaController.verAgenda);
router.get('/agenda/horarios', agendaController.horariosJson); // JSON p/ o pop-up "Novo agendamento"
router.get('/agenda/planos', agendaController.planosJson); // JSON: planos ativos do cliente (marcar pelo plano)
router.get('/agenda/novo', agendaController.formNovo); // agendamento manual
router.post('/agenda/novo', agendaController.criarManual);
router.get('/agenda/:id/detalhe', agendaController.detalheFragmento); // miolo da folha, p/ atualizar sem recarregar
router.post('/agenda/:id/itens', agendaController.adicionarItem);
router.post('/agenda/:id/total', agendaController.alterarTotal); // total ajustado à mão
router.post('/agenda/itens/:id/valor', agendaController.alterarValorItem); // preço só deste atendimento
router.post('/agenda/itens/:id/remover', agendaController.removerItem);
router.post('/agenda/:id/status', agendaController.mudarStatus);
router.post('/agenda/:id/excluir', agendaController.excluir);
// Bloqueios direto da agenda: barbeiro bloqueia a PRÓPRIA agenda (escopado no controller).
router.post('/agenda/bloqueios', agendaController.criarBloqueio);
router.post('/agenda/bloqueios/:id/remover', agendaController.removerBloqueio);

// --- Clientes (admin + funcionários) --------------------------------------
// Específicas (/:id/editar, /:id/remover) antes da paramétrica de update (/:id).
router.get('/clientes', clienteController.listar);
router.post('/clientes/planos/:id/remover', exigeAdmin, clienteController.removerPlano);
router.post('/clientes/:id/planos', exigeAdmin, clienteController.adicionarPlano);
router.post('/clientes', clienteController.criar);
router.post('/clientes/:id/remover', exigeAdmin, clienteController.remover);
router.post('/clientes/:id', clienteController.atualizar);

// --- Planos: ver para todos; criar/editar só admin ------------------------
router.get('/planos', planoController.listar);
router.get('/planos/novo', exigeAdmin, planoController.formNovo);
router.post('/planos', exigeAdmin, planoController.criar);
router.get('/planos/:id/editar', exigeAdmin, planoController.formEditar);
router.post('/planos/:id/toggle', exigeAdmin, planoController.alternarAtivo);
router.post('/planos/:id/remover', exigeAdmin, planoController.remover);
router.post('/planos/:id', exigeAdmin, planoController.atualizar);

// --- Equipe (só admin) -------------------------------------------------------
// Voltou a existir no painel comum (antes só no painel-mestre) — decisão do
// dono, 2026-07-20. Gerenciar quem trabalha na barbearia é coisa de admin.
router.get('/equipe', exigeAdmin, equipeController.listar);
router.post('/equipe', exigeAdmin, equipeController.criar);
router.post('/equipe/:id/toggle', exigeAdmin, equipeController.alternarAtivo);
router.post('/equipe/:id/foto/remover', exigeAdmin, equipeController.removerFoto);
router.post('/comissoes/:id/foto/remover', exigeAdmin, equipeController.removerFoto);
router.post('/equipe/:id', exigeAdmin, uploadFotoEquipe, equipeController.atualizar);

// --- Comissões ----------------------------------------------------
// Barbeiro vê SÓ a comissão dele (escopado no controller). Editar a % e trocar
// a foto de barbeiros continua sendo exclusivo do admin.
router.get('/comissoes', comissaoController.ver);
router.post('/comissoes/percentual/:id', exigeAdmin, comissaoController.salvarPercentual);
router.post('/comissoes/:id/foto', exigeAdmin, uploadFotoBarbeiro, comissaoController.salvarFoto);

// --- Horários & bloqueios --------------------------------------------------
// Barbeiro edita a PRÓPRIA jornada e os PRÓPRIOS bloqueios (escopado no
// controller). A janela de agendamento é da barbearia toda: só admin.
router.get('/horarios', horarioController.ver);
router.post('/horarios/jornada', horarioController.salvarJornada);
router.post('/horarios/bloqueios', horarioController.adicionarBloqueio);
router.post('/horarios/bloqueios/:id/remover', horarioController.removerBloqueio);
router.post('/horarios/janela', exigeAdmin, horarioController.salvarJanela);

// --- Serviços e Produtos (admin + barbeiros) ------------------------------
// Duas telas separadas (decisão do dono, 2026-07-20 — antes eram uma só com
// abas). Mesma tabela/controller por trás (Servico.ehProduto distingue);
// só a listagem filtra por tipo. IMPORTANTE: específicas (/novo, /categorias)
// vêm ANTES das paramétricas (/:id).
router.get('/servicos', servicoController.listar);
router.get('/produtos', servicoController.listarProdutos);
router.get('/servicos/novo', exigeAdmin, servicoController.formNovo);
router.post('/servicos', exigeAdmin, uploadFoto, servicoController.criar);
// Categorias do catálogo (compartilhadas entre serviços e produtos)
router.post('/servicos/categorias', exigeAdmin, servicoController.criarCategoria);
router.post('/servicos/categorias/:id/remover', exigeAdmin, servicoController.removerCategoria);
router.post('/servicos/categorias/:id', exigeAdmin, servicoController.renomearCategoria);
// Item específico (serviço ou produto — o redirect depois de salvar volta
// para a tela certa, conforme o ehProduto do registro)
router.get('/servicos/:id/editar', exigeAdmin, servicoController.formEditar);
router.post('/servicos/:id/toggle', exigeAdmin, servicoController.alternarAtivo);
router.post('/servicos/:id/foto/remover', exigeAdmin, servicoController.removerFoto);
router.post('/servicos/:id/remover', exigeAdmin, servicoController.remover);
router.post('/servicos/:id', exigeAdmin, uploadFoto, servicoController.atualizar);

// --- Estoque (admin + barbeiros) ------------------------------------------
// Específicas (/novo, /categorias) antes das paramétricas (/:id).
router.get('/estoque', estoqueController.listar);
router.get('/estoque/novo', exigeAdmin, estoqueController.formNovo);
router.post('/estoque', exigeAdmin, estoqueController.criar);
router.post('/estoque/categorias', exigeAdmin, estoqueController.criarCategoria);
router.post('/estoque/categorias/:id/remover', exigeAdmin, estoqueController.removerCategoria);
router.post('/estoque/categorias/:id', exigeAdmin, estoqueController.renomearCategoria);
router.get('/estoque/:id/editar', exigeAdmin, estoqueController.formEditar);
router.post('/estoque/:id/ajuste', exigeAdmin, estoqueController.ajustar);
router.post('/estoque/:id/remover', exigeAdmin, estoqueController.remover);
router.post('/estoque/:id', exigeAdmin, estoqueController.atualizar);

// Equipe (barbeiros) e Marca são gerenciadas apenas no painel-mestre (dono do
// sistema), em /mestre/barbearias/:id — por isso não há rotas delas aqui.

// --- Caixa (somente admin) ------------------------------------------------
// Específicas (/config, /categorias) antes das paramétricas (/:id).
router.get('/caixa', exigeAdmin, caixaController.ver);
router.post('/caixa', exigeAdmin, caixaController.criar);
router.post('/caixa/:id/remover', exigeAdmin, caixaController.remover);

// --- Relatórios (somente admin) --------------------------------------------
router.get('/relatorios', exigeAdmin, relatorioController.ver);

// --- Fidelidade (somente admin) --------------------------------------------
router.get('/fidelidade', exigeAdmin, fidelidadeController.ver);
router.post('/fidelidade/cupons', exigeAdmin, fidelidadeController.criarCupom);
router.post('/fidelidade/cupons/:id/remover', exigeAdmin, fidelidadeController.removerCupom);
router.post('/fidelidade/clientes/:id/selo', exigeAdmin, fidelidadeController.adicionarSelo);
router.post('/fidelidade/clientes/:id/resgatar', exigeAdmin, fidelidadeController.resgatar);

module.exports = router;
