// Primeiros passos da Início (fatia F9; spec 11 e telas da Dani em
// redesign/v3/acesso, "#passos"). Cada passo é marcado como feito a partir do
// que JÁ EXISTE no banco, sem tabela nova: serviço cadastrado, equipe com mais
// de uma pessoa, jornada definida, agendamento feito, lançamento no caixa,
// comissão paga e WhatsApp conectado. O passo 4 (compartilhar o link) conta
// como feito quando a barbearia já recebeu um agendamento.
// TODO(Beto, spec 11): quando existir onboardingEstado (POST
// /painel/primeiros-passos), ler "link compartilhado" e "esconder" de lá; hoje
// o "Esconder" fica no aparelho (localStorage).
const prisma = require('../config/db');
const planoCortavo = require('./planoCortavo');

async function contar(fn) {
  try { return await fn(); } catch (e) { return 0; }
}

async function montar({ barbeariaId, planoChave }) {
  const plano = planoCortavo.planoDe(planoChave);
  const comComissoes = planoCortavo.libera(plano, 'comissoes');
  const comSecretaria = !(plano.tetos && plano.tetos.secretaria === 0);
  const w = { barbeariaId };

  const [servicos, equipe, jornadas, agendamentos, caixa, comissoes, whatsapp] = await Promise.all([
    contar(() => prisma.servico.count({ where: { ...w, ativo: true } })),
    contar(() => prisma.usuario.count({ where: { ...w, ativo: true } })),
    contar(() => prisma.horarioTrabalho.count({ where: { ...w, trabalha: true } })),
    contar(() => prisma.agendamento.count({ where: w })),
    contar(() => prisma.caixa.count({ where: w })),
    comComissoes ? contar(() => prisma.comissaoPagamento.count({ where: w })) : 0,
    comSecretaria ? contar(() => prisma.configuracao.count({ where: { ...w, chave: 'whatsapp_phone_number_id' } })) : 0,
  ]);

  const passos = [
    { chave: 'servicos', t: 'Cadastre seus serviços', s: 'Corte, barba, sobrancelha. Coloque preço e quanto tempo leva.', href: '/painel/servicos', acao: 'Cadastrar serviços', feito: servicos > 0 },
    { chave: 'equipe', t: 'Monte sua equipe', s: 'Cada barbeiro recebe um acesso próprio.', href: '/painel/equipe', acao: 'Adicionar', feito: equipe > 1 },
    { chave: 'horarios', t: 'Defina os horários', s: 'A agenda só oferece os horários que você abrir.', href: '/painel/horarios', acao: 'Definir', feito: jornadas > 0 },
    { chave: 'link', t: 'Compartilhe seu link', s: 'Seus clientes marcam sozinhos por ele.', href: '/painel/link?novo=1', acao: 'Abrir', feito: agendamentos > 0 },
    { chave: 'agenda', t: 'Conheça a agenda', s: 'Marque um cliente que chegou pelo balcão.', href: '/painel/agenda', acao: 'Abrir', feito: agendamentos > 0 },
    { chave: 'caixa', t: 'Feche um atendimento no caixa', s: 'O caixa do dia soma tudo.', href: '/painel/caixa', acao: 'Abrir', feito: caixa > 0 },
    comComissoes ? { chave: 'comissoes', t: 'Veja as comissões', s: 'Calculadas pelo percentual que você define.', href: '/painel/comissoes', acao: 'Ver', feito: comissoes > 0 } : null,
    comSecretaria ? { chave: 'secretaria', t: 'Conecte a secretária de IA', s: 'Ela responde e agenda pelo WhatsApp.', href: '/painel/secretaria', acao: 'Conectar', feito: whatsapp > 0 } : null,
  ].filter(Boolean).map((p, i) => ({ ...p, n: i + 1 }));

  const feitos = passos.filter((p) => p.feito).length;
  const proximo = passos.find((p) => !p.feito) || null;
  return { total: passos.length, feitos, pct: Math.round((feitos / passos.length) * 100), passos, proximo: proximo ? proximo.chave : null, completo: !proximo };
}

module.exports = { montar };
