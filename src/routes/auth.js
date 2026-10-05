// Rotas de autenticação e entrada do app.
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { limiteLogin } = require('../middlewares/rateLimit');

// Raiz: dono -> painel-mestre; equipe logada -> painel; visitante -> depende
// do contexto (ver abaixo).
router.get('/', (req, res) => {
  const u = req.session.usuario;
  if (u) return res.redirect(u.papel === 'dono' ? '/mestre' : '/painel');

  // Sem barbearia no contexto = domínio RAIZ (cortavo.com.br sem subdomínio).
  // É assim que o APP DA EQUIPE abre: ele carrega a raiz. Mandar um visitante
  // não logado para /agendar aqui levava direto para "Barbearia não
  // encontrada" (o agendamento público exige uma barbearia no subdomínio), e
  // o app travava nessa tela logo na abertura — o revisor da Apple nunca
  // chegava no login (rejeição 2.1a, 2026-08-27). Na raiz, o destino certo é
  // o login da equipe.
  //
  // Num subdomínio de barbearia (andrade.cortavo.com.br) req.barbearia existe,
  // e aí o comportamento continua o de antes: o cliente cai no agendamento.
  if (!req.barbearia) return res.redirect('/login');
  res.redirect('/agendar');
});

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

module.exports = router;
