// Rotas de autenticação e entrada do app.
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { limiteLogin, limiteCriarSenhaGet, limiteCriarSenhaPost, limiteEsqueci } = require('../middlewares/rateLimit');

// Raiz ("/").
//  - SUBDOMÍNIO de barbearia (andrade.cortavo.com.br): é o link de agendamento
//    que vai no QR, no cartaz e na mensagem do WhatsApp. Sempre /agendar, MESMO
//    com alguém da equipe logado neste navegador: o dono que testa o próprio
//    link precisa ver o que o cliente vê (antes caía no painel). Subdomínio
//    pausado ou inexistente também vai para /agendar, que mostra o aviso certo.
//  - DOMÍNIO RAIZ (cortavo.com.br): dono do sistema -> /mestre; equipe logada
//    -> /painel; visitante -> /login. É assim que o APP DA EQUIPE abre (ele
//    carrega a raiz). Mandar o visitante para /agendar aqui levava a "Barbearia
//    não encontrada" e o app travava na abertura: o revisor da Apple nunca
//    chegava no login (rejeição 2.1a, 2026-08-27).
function raiz(req, res) {
  if (req.barbearia || req.slugBarbearia) return res.redirect('/agendar');
  const u = req.session.usuario;
  if (u) return res.redirect(u.papel === 'dono' ? '/mestre' : '/painel');
  return res.redirect('/login');
}
router.get('/', raiz);

// Política de privacidade — pública e SEM login de propósito: a App Store e a
// Play Store exigem uma URL aberta no formulário de submissão, e o revisor
// precisa conseguir abri-la sem conta.
router.get('/privacidade', (req, res) => {
  res.render('legal/privacidade', {
    layout: 'layouts/legal',
    titulo: 'Política de Privacidade',
    atualizadoEm: '5 de outubro de 2026',
    emailContato: require('../config/constantes').SUPORTE_CORTAVO,
  });
});

// Termos de Serviço — pública e SEM login (mesma razão da privacidade: as lojas
// e o App Review da Meta pedem uma URL aberta).
router.get('/termos', (req, res) => {
  res.render('legal/termos', {
    layout: 'layouts/legal',
    titulo: 'Termos de Serviço',
    atualizadoEm: '5 de outubro de 2026',
    emailContato: require('../config/constantes').SUPORTE_CORTAVO,
  });
});

router.get('/login', authController.mostrarLogin);
router.post('/login', limiteLogin, authController.fazerLogin);
router.post('/logout', authController.logout);

// Troca de senha obrigatória (senha provisória / padrão de fábrica). Fica no
// nível raiz de propósito: serve tanto a equipe (painel) quanto o dono (mestre),
// que caem em áreas diferentes depois do login.
router.get('/trocar-senha', authController.mostrarTrocaSenha);
router.post('/trocar-senha', authController.trocarSenha);

// Acesso por link (spec 13): a pessoa cria a PRÓPRIA senha pelo link do e-mail.
// Públicas e sem login. O GET não consome o link (só valida e limpa a URL).
router.get('/criar-senha', limiteCriarSenhaGet, authController.mostrarCriarSenha);
router.post('/criar-senha', limiteCriarSenhaPost, authController.criarSenha);
// "Esqueci minha senha" (F5): resposta sempre igual, exista o e-mail ou não.
router.get('/esqueci-senha', authController.mostrarEsqueci);
router.post('/esqueci-senha', limiteEsqueci, authController.pedirLinkEsqueci);

router.raiz = raiz; // para os testes
module.exports = router;
