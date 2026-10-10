// Rotas do painel-mestre (dono do sistema). Tudo aqui exige o papel "dono".
const express = require('express');
const router = express.Router();
const { exigeDono } = require('../middlewares/auth');
const { limiteAdmin } = require('../middlewares/rateLimit');
const mestreController = require('../controllers/mestreController');
const upload = require('../middlewares/upload');

// Rate-limit agressivo em TODO o painel-mestre (área mais sensível do sistema),
// antes mesmo do exigeDono. Depois, exige o papel "dono" em toda rota.
router.use(limiteAdmin);
router.use(exigeDono);

// Envolve o upload de imagem (logo ou capa) tratando erros com mensagem amigável.
function uploadImagem(req, res, next) {
  upload.single('foto')(req, res, (err) => {
    if (err) {
      req.session.flash = { tipo: 'erro', texto: err.message || 'Falha no upload da imagem.' };
      return res.redirect('/mestre/barbearias/' + req.params.id);
    }
    next();
  });
}

// Lista + criação de barbearias
router.get('/', mestreController.painel);
router.get('/auditoria', mestreController.auditoriaLista);
// Uso & custos de IA por barbearia (tempo real via /uso.json)
router.get('/uso', mestreController.usoCustos);
router.get('/uso.json', mestreController.usoCustosJson);
// Visão geral (redesign v3, F10): ativas, receita estimada, custo de IA e
// WhatsApp por barbearia, margem e "Precisa de atenção".
router.get('/visao-geral.json', mestreController.visaoGeralJson);
// Canais de agendamento + mensagens enviadas (todas as barbearias, por mês)
router.get('/canais', mestreController.canaisMensagensView);
router.get('/nova', mestreController.formNova);
router.post('/barbearias', mestreController.criarBarbearia);

// Impersonação
router.post('/entrar/:id', mestreController.entrar);
router.post('/sair', mestreController.sair);

// Detalhe / edição de uma barbearia
router.get('/barbearias/:id', mestreController.detalhe);
router.post('/barbearias/:id', mestreController.atualizarBarbearia);
router.post('/barbearias/:id/notas', mestreController.salvarNotas);
router.post('/barbearias/:id/plano', mestreController.definirPlano); // fase 2.2: só papel dono
router.post('/barbearias/:id/ativa', mestreController.definirAtiva);
// Teste grátis e vaga de fundador (fase 2.6)
router.post('/barbearias/:id/teste/prorrogar', mestreController.prorrogarTeste);
router.post('/barbearias/:id/teste/segurar', mestreController.segurarPausaTeste);
router.post('/barbearias/:id/teste/pago', mestreController.registrarPagamentoTeste);
router.post('/barbearias/:id/fundador', mestreController.definirFundador);
router.post('/barbearias/:id/remover', mestreController.removerBarbearia);

// Equipe da barbearia (barbeiros + e-mail/senha)
router.post('/barbearias/:id/equipe', mestreController.criarBarbeiro);
router.get('/barbearias/:id/equipe/:uid/editar', mestreController.formEditarBarbeiro);
router.post('/barbearias/:id/equipe/:uid', mestreController.atualizarBarbeiro);
router.post('/barbearias/:id/equipe/:uid/toggle', mestreController.toggleBarbeiro);
// Spec 13: o antigo "Resetar senha" virou "Enviar link" (a Kalany nunca vê senha).
router.post('/barbearias/:id/equipe/:uid/enviar-link', mestreController.enviarLinkMembro);

// Marca (logo + powered-by) da barbearia
router.post('/barbearias/:id/marca', uploadImagem, mestreController.salvarMarca);
router.post('/barbearias/:id/marca/remover-logo', mestreController.removerLogo);

// Foto de capa (hero da Home)
router.post('/barbearias/:id/capa', uploadImagem, mestreController.salvarCapa);
router.post('/barbearias/:id/capa/remover', mestreController.removerCapa);

module.exports = router;
