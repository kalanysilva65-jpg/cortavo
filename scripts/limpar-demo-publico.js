// Limpeza SEMANAL da barbearia de demonstração (spec 03).
//
// Apaga SÓ os agendamentos que o público criou pelo link (origem "publico")
// na barbearia de demonstração, criados há mais de 1 dia. NUNCA mexe em
// cadastro, serviços, equipe, configurações, caixa ou na conta do revisor.
// (O `scripts/limpar-barbearia.js` é forte demais para isso: apaga tudo.)
//
// SEGURANÇA
//  - Só aceita barbearias de demonstração (lista fixa em src/services/demo.js).
//  - Por padrão SÓ SIMULA: lista o que apagaria e não apaga nada.
//  - Para apagar: --executar --confirmar=<slug>. Antes, faz backup do banco
//    (VACUUM INTO) ao lado do arquivo do banco; --sem-backup pula o backup
//    (para a rotina agendada, só depois que a Kalany aprovar).
//  - Quem roda no servidor é a Kalany, sempre primeiro em simulação.
//
// USO (no VPS, dentro de /home/cortavo/app):
//   sudo -u cortavo node scripts/limpar-demo-publico.js                                # simula (slug demo)
//   sudo -u cortavo node scripts/limpar-demo-publico.js --executar --confirmar=demo    # apaga
const path = require('path');

const UM_DIA_MS = 24 * 60 * 60 * 1000;

function filtroPublicoAntigo(barbeariaId, agora) {
  return { barbeariaId, origem: 'publico', criadoEm: { lt: new Date(agora.getTime() - UM_DIA_MS) } };
}

// Núcleo testável: recebe o prisma e devolve o que fez. Não lê argv nem .env.
async function limparDemo({ prisma, slug = 'demo', executar = false, confirmar = '', semBackup = false, agora = new Date(), log = console.log }) {
  const { ehSlugDemo } = require('../src/services/demo');
  if (!ehSlugDemo(slug)) {
    log('ABORTADO: "' + slug + '" não é barbearia de demonstração.');
    return { ok: false, motivo: 'nao-demo' };
  }
  const b = await prisma.barbearia.findUnique({ where: { slug } });
  if (!b) {
    log('Barbearia "' + slug + '" não existe.');
    return { ok: false, motivo: 'inexistente' };
  }

  const where = filtroPublicoAntigo(b.id, agora);
  const lista = await prisma.agendamento.findMany({
    where,
    select: { id: true, data: true, horaInicio: true, clienteNome: true, criadoEm: true },
    orderBy: { criadoEm: 'asc' },
  });

  log('');
  log('  Barbearia: ' + b.nome + ' (id ' + b.id + ', slug "' + b.slug + '")');
  log('  ' + (executar ? 'MODO: EXECUTAR (vai apagar)' : 'MODO: SIMULAÇÃO (nada será apagado)'));
  log('  Agendamentos criados pelo link público há mais de 1 dia: ' + lista.length);
  for (const a of lista) {
    const dia = a.data instanceof Date ? a.data.toISOString().slice(0, 10) : String(a.data);
    log('    #' + a.id + '  ' + dia + ' ' + (a.horaInicio || '') + '  ' + (a.clienteNome || ''));
  }
  log('');

  if (!executar) {
    log('  Nada foi apagado. Para apagar de verdade:');
    log('    node scripts/limpar-demo-publico.js --slug=' + b.slug + ' --executar --confirmar=' + b.slug);
    return { ok: true, simulacao: true, encontrados: lista.length, apagados: 0 };
  }
  if (confirmar !== b.slug) {
    log('  ABORTADO: --confirmar precisa ser exatamente o slug "' + b.slug + '".');
    return { ok: false, motivo: 'confirmacao' };
  }
  if (!lista.length) return { ok: true, encontrados: 0, apagados: 0 };

  if (!semBackup) {
    const linhas = await prisma.$queryRawUnsafe('PRAGMA database_list');
    const main = linhas.find((l) => l.name === 'main');
    if (!main || !main.file) throw new Error('não consegui descobrir o arquivo do banco para o backup');
    const carimbo = agora.toISOString().replace(/[:.]/g, '-');
    const backup = path.join(path.dirname(main.file), 'backup-antes-limpeza-demo-' + carimbo + '.db');
    await prisma.$executeRawUnsafe("VACUUM INTO '" + backup.replace(/'/g, "''") + "'");
    log('  Backup salvo em: ' + backup);
  }

  // Apaga pelos ids listados E pelo mesmo filtro: nada fora da lista mostrada.
  const r = await prisma.agendamento.deleteMany({ where: { ...where, id: { in: lista.map((a) => a.id) } } });
  log('  Limpeza concluída: ' + r.count + ' agendamento(s) apagado(s).');
  return { ok: true, encontrados: lista.length, apagados: r.count };
}

module.exports = { limparDemo, filtroPublicoAntigo };

if (require.main === module) {
  require('dotenv').config();
  const prisma = require('../src/config/db');
  const args = process.argv.slice(2);
  const arg = (n) => (args.find((a) => a.startsWith('--' + n + '=')) || '').split('=').slice(1).join('=');
  limparDemo({
    prisma,
    slug: arg('slug') || 'demo',
    executar: args.includes('--executar'),
    confirmar: arg('confirmar'),
    semBackup: args.includes('--sem-backup'),
  })
    .then((r) => { if (!r.ok) process.exitCode = 1; })
    .catch((e) => { console.error('Falhou:', e.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
