// Assistente Cortavo (aba /painel/ia). Tela de conversa + endpoint que roda o
// laço da IA. O escopo (barbearia e, se barbeiro, o próprio usuário) sai SEMPRE
// da sessão — nunca do corpo da requisição.
const ia = require('../services/ia');
const atendimento = require('../services/atendimento');
const agseg = require('../services/agendamentoSeguro');
const pausa = require('../services/pausa');

// "AAAA-MM-DD" -> "DD/MM/AAAA" para as mensagens de confirmação.
function brData(iso) {
  const p = String(iso || '').split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}

const MAX_MSG = 1000; // tamanho máx. da pergunta do usuário
const MAX_HIST = 10; // últimas N mensagens do histórico que reenviamos
const MAX_HIST_TXT = 2000; // corte por mensagem do histórico

// Monta o contexto de escopo a partir da sessão. Admin/dono => barbearia toda
// (usuarioId null); barbeiro (funcionário) => só os próprios dados.
function contextoDe(req) {
  return {
    barbeariaId: req.barbeariaId,
    usuarioId: req.ehAdmin ? null : req.session.usuario.id,
    // Spec 12: o Assistente segue as mesmas chaves de permissão do painel.
    veContato: !req.permissoes || req.permissoes.pode('clientes_contato'),
    pode: (chave) => !req.permissoes || req.permissoes.pode(chave),
  };
}

// GET /painel/ia — tela do assistente.
function ver(req, res) {
  res.render('painel/ia', {
    titulo: 'Assistente',
    iaAtiva: ia.iaHabilitada(),
    primeiroNome: (req.session.usuario.nome || '').split(' ')[0],
    // Chave para guardar a conversa no aparelho (localStorage), separada por
    // barbearia + usuário — assim, num aparelho compartilhado, cada pessoa vê
    // só o próprio histórico e uma barbearia não vê o de outra.
    conversaKey: 'ia-conv-' + req.barbeariaId + '-' + req.session.usuario.id,
  });
}

// POST /painel/ia/mensagem — recebe { mensagem, historico } e devolve { resposta }.
async function mensagem(req, res) {
  if (!ia.iaHabilitada()) {
    return res.status(503).json({ erro: 'O assistente ainda não está configurado.' });
  }

  const texto = String(req.body.mensagem || '').trim().slice(0, MAX_MSG);
  if (!texto) return res.status(400).json({ erro: 'Escreva uma pergunta.' });

  // Pausa de verdade (spec 01): responde a mensagem de pausa sem chamar a IA e
  // sem contar consulta (vale também para a Kalany operando pelo painel-mestre).
  if (await pausa.estaPausada(req.barbeariaId)) {
    return res.json({ resposta: 'O acesso desta barbearia está pausado, então o Assistente não responde agora. Fale com a Cortavo pelo direct ' + pausa.CONTATO + '.' });
  }

  // Teto mensal do copiloto — ao estourar, para de responder no mês (protege custo).
  const teto = await atendimento.estadoTetoCopiloto(req.barbeariaId);
  if (teto.desligado) {
    // Fase 2.3: plano sem assistente (teto 0). Não chama a IA nem conta consulta.
    return res.json({ resposta: 'O Assistente não está no seu plano. Disponível no plano Barbearia. Fale com a Cortavo.' });
  }
  if (teto.atingido) {
    return res.json({ resposta: `Você atingiu o limite de ${teto.teto} consultas do Assistente neste mês. Ele volta no próximo mês. 🙂` });
  }

  // Histórico vem do cliente (stateless): validamos o formato, limitamos a
  // quantidade e o tamanho. Só 'user'/'assistant' entram.
  const histBruto = Array.isArray(req.body.historico) ? req.body.historico : [];
  const mensagens = histBruto
    .filter((m) => m && (m.papel === 'user' || m.papel === 'assistant') && typeof m.texto === 'string')
    .slice(-MAX_HIST)
    .map((m) => ({ role: m.papel, content: m.texto.slice(0, MAX_HIST_TXT) }));
  mensagens.push({ role: 'user', content: texto });

  try {
    const { texto: resposta, usage, proposta } = await ia.responder(contextoDe(req), mensagens);
    // Registra o uso do copiloto (contado à parte do WhatsApp) — não deixa
    // uma falha de contagem quebrar a resposta ao usuário.
    atendimento.registrarUsoCopiloto(req.barbeariaId, usage).catch((e) => console.error('[copiloto] uso:', e.message));
    // `proposta` (quando existe) é uma ação aguardando confirmação do usuário —
    // NADA foi gravado ainda; a execução só acontece em POST /painel/ia/acao.
    res.json({ resposta, proposta: proposta || null });
  } catch (e) {
    console.error('[ia] falha ao responder:', e.message);
    res.status(500).json({ erro: 'Não consegui responder agora. Tente de novo em instantes.' });
  }
}

// POST /painel/ia/mensagem/acao — executa uma ação (agendar/reagendar/cancelar)
// APÓS o usuário confirmar na tela. Re-valida tudo no servidor: barbeariaId sai
// da sessão; funcionário (não-admin) fica preso aos PRÓPRIOS atendimentos; e a
// criação/reagendamento re-checa conflito de forma atômica (agendamentoSeguro).
// A proposta que o cliente reenvia é só conveniência — quem manda é este código.
async function acao(req, res) {
  if (!ia.iaHabilitada()) return res.status(503).json({ erro: 'O assistente não está configurado.' });
  if (await pausa.estaPausada(req.barbeariaId)) return res.status(403).json({ erro: 'O acesso desta barbearia está pausado.' });
  if ((await atendimento.estadoTetoCopiloto(req.barbeariaId)).desligado) return res.status(403).json({ erro: 'O Assistente não está no seu plano.' });
  const tipo = String(req.body.tipo || '');
  const dados = req.body.dados || {};
  const b = req.barbeariaId;
  // Não-admin (funcionário) só age nos próprios atendimentos.
  const usuarioIdRestrito = req.ehAdmin ? null : req.session.usuario.id;

  try {
    if (tipo === 'agendar') {
      // Funcionário sempre agenda para SI; admin usa o barbeiro proposto.
      const barbeiroId = usuarioIdRestrito || Number(dados.barbeiroId);
      const r = await agseg.criarAgendamento(b, {
        usuarioId: barbeiroId,
        servicoIds: dados.servicoIds,
        data: dados.data,
        hora: dados.hora,
        clienteNome: dados.clienteNome,
        clienteTelefone: dados.clienteTelefone,
      });
      if (r.ok) return res.json({ ok: true, mensagem: `✅ Agendado: ${r.servicos.join(' + ')} com ${r.barbeiro} em ${brData(r.data)} às ${r.hora}.` });
      return res.status(400).json({ erro: r.mensagem || 'Não consegui agendar.' });
    }
    if (tipo === 'reagendar') {
      const r = await agseg.reagendarAgendamento(b, { agendamentoId: dados.agendamentoId, novaData: dados.novaData, novaHora: dados.novaHora, usuarioIdRestrito });
      if (r.ok) return res.json({ ok: true, mensagem: `✅ Reagendado para ${brData(r.data)} às ${r.hora}.` });
      return res.status(400).json({ erro: r.mensagem || 'Não consegui reagendar.' });
    }
    if (tipo === 'cancelar') {
      const r = await agseg.cancelarAgendamento(b, { agendamentoId: dados.agendamentoId, usuarioIdRestrito, canceladoPor: 'assistente', porUsuarioId: req.session.usuario.id });
      if (r.ok) {
        const nome = r.clienteNome ? r.clienteNome.split(' ')[0] : 'cliente';
        return res.json({ ok: true, mensagem: r.jaCancelado ? 'Esse agendamento já estava cancelado.' : `✅ Agendamento de ${nome} cancelado.` });
      }
      return res.status(400).json({ erro: r.mensagem || 'Não consegui cancelar.' });
    }
    return res.status(400).json({ erro: 'Ação desconhecida.' });
  } catch (e) {
    console.error('[ia] acao falhou:', e.message);
    res.status(500).json({ erro: 'Não consegui concluir a ação agora.' });
  }
}

module.exports = { ver, mensagem, acao };
