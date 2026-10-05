// Tela "Meu plano" do dono/admin da barbearia (fase 2.4, spec 04).
// Mostra o plano da Cortavo, o que ele libera e o uso do mês. SEM pagamento
// dentro do app (regra da Apple): para mudar de plano, "Fale com a Cortavo".
const prisma = require('../config/db');
const planoCortavo = require('../services/planoCortavo');
const atendimento = require('../services/atendimento');

async function ver(req, res) {
  const plano = res.locals.planoCortavo || planoCortavo.planoDe(res.locals.barbeariaAtual && res.locals.barbeariaAtual.planoCortavo);
  const [secretaria, assistente, barbeiros] = await Promise.all([
    atendimento.estadoTeto(req.barbeariaId),
    atendimento.estadoTetoCopiloto(req.barbeariaId),
    prisma.usuario.count({ where: { barbeariaId: req.barbeariaId, ativo: true } }),
  ]);
  res.render('painel/meu-plano', {
    titulo: 'Meu plano',
    plano,
    funcoes: planoCortavo.resumoFuncoes(plano),
    uso: {
      secretaria: { usado: secretaria.respostas, teto: secretaria.teto, desligado: secretaria.desligado },
      assistente: { usado: assistente.consultas, teto: assistente.teto, desligado: assistente.desligado },
      lembretesRef: plano.tetos.lembretesRef,
      barbeiros,
      barbeirosRef: plano.tetos.barbeirosRef,
    },
    desde: res.locals.barbeariaAtual ? res.locals.barbeariaAtual.planoCortavoDesde : null,
  });
}

module.exports = { ver };
