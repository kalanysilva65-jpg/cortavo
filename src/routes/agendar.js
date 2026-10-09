// Rotas públicas de agendamento (cliente, sem login).
const express = require('express');
const router = express.Router();
const c = require('../controllers/agendamentoPublicoController');
const { exigeBarbeariaPublica } = require('../middlewares/tenant');
const { limiteAgendar } = require('../middlewares/rateLimit');

// Toda a área pública precisa de uma barbearia válida no contexto (subdomínio).
router.use(exigeBarbeariaPublica);
// Redesign v3 (F12): "Aberto hoje, 9h às 19h" disponível em todas as páginas.
router.use(c.contextoPublico);

router.get('/plano', c.passoPlano); // consulta de plano por telefone
router.get('/', c.passoServico); // passo 1: serviço
router.get('/barbeiro', c.passoBarbeiro); // passo 2: barbeiro
router.get('/horario', c.passoHorario); // passo 3: data e horário
router.get('/horarios.json', c.horariosJson); // troca de dia sem recarregar a tela
router.get('/dados', c.passoDados); // passo 4: dados do cliente
router.post('/confirmar', limiteAgendar, c.confirmar); // cria o agendamento
router.get('/sucesso/:id', c.sucesso); // confirmação

module.exports = router;
