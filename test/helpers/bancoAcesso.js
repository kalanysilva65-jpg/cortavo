// Banco em memória para os testes do acesso por link (spec 13). Só os métodos
// que o fluxo usa; o resto cai no erro claro do prismaFalso. Sem banco real.
const { prismaFalso } = require('./ambiente');

const val = (v) => (v instanceof Date ? v.getTime() : v);

function casa(reg, where = {}) {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return cond.some((w) => casa(reg, w));
    if (k === 'NOT') return !casa(reg, cond);
    if (k === 'barbeariaId_email') return reg.barbeariaId === cond.barbeariaId && reg.email === cond.email;
    const v = reg[k];
    if (cond === null) return v == null;
    if (cond instanceof Date) return val(v) === cond.getTime();
    if (cond && typeof cond === 'object') {
      if ('not' in cond) return cond.not === null ? v != null : val(v) !== val(cond.not);
      if ('in' in cond) return cond.in.includes(v);
      let ok = true;
      if ('gt' in cond) ok = ok && v != null && val(v) > val(cond.gt);
      if ('gte' in cond) ok = ok && v != null && val(v) >= val(cond.gte);
      if ('lt' in cond) ok = ok && v != null && val(v) < val(cond.lt);
      return ok;
    }
    return v === cond;
  });
}

function bancoAcesso({ usuarios = [], barbearias = [], tokens = [] } = {}) {
  const logs = [];
  let seqToken = tokens.reduce((m, t) => Math.max(m, t.id), 0);
  let seqUsuario = usuarios.reduce((m, u) => Math.max(m, u.id), 0);
  const copia = (x) => (x ? { ...x } : null);

  const prisma = prismaFalso({
    usuario: {
      findUnique: async ({ where }) => copia(usuarios.find((u) => (where.id != null ? u.id === where.id : casa(u, where)))),
      findFirst: async ({ where }) => copia(usuarios.find((u) => casa(u, where))),
      findMany: async ({ where = {}, take } = {}) => usuarios.filter((u) => casa(u, where)).slice(0, take || undefined).map(copia),
      create: async ({ data }) => { const u = { id: ++seqUsuario, ativo: true, senhaProvisoria: false, senhaDefinidaEm: null, criadoEm: new Date(), ...data }; usuarios.push(u); return copia(u); },
      update: async ({ where, data }) => { const u = usuarios.find((x) => x.id === where.id); Object.assign(u, data); return copia(u); },
    },
    barbearia: {
      findUnique: async ({ where }) => copia(barbearias.find((b) => (where.id != null ? b.id === where.id : b.slug === where.slug))),
    },
    tokenAcesso: {
      create: async ({ data }) => { const t = { id: ++seqToken, usadoEm: null, revogadoEm: null, enviadoEm: null, erroEnvio: null, criadoPorId: null, criadoEm: new Date(), ...data }; tokens.push(t); return copia(t); },
      findUnique: async ({ where }) => copia(tokens.find((t) => (where.id != null ? t.id === where.id : t.tokenHash === where.tokenHash))),
      findMany: async ({ where = {} } = {}) => tokens.filter((t) => casa(t, where)).sort((a, b) => val(b.criadoEm) - val(a.criadoEm) || b.id - a.id).map(copia),
      count: async ({ where = {} } = {}) => tokens.filter((t) => casa(t, where)).length,
      update: async ({ where, data }) => { const t = tokens.find((x) => x.id === where.id); Object.assign(t, data); return copia(t); },
      updateMany: async ({ where, data }) => { const alvo = tokens.filter((t) => casa(t, where)); alvo.forEach((t) => Object.assign(t, data)); return { count: alvo.length }; },
      deleteMany: async ({ where }) => { const antes = tokens.length; for (let i = tokens.length - 1; i >= 0; i--) if (casa(tokens[i], where)) tokens.splice(i, 1); return { count: antes - tokens.length }; },
    },
    logAuditoria: { create: async ({ data }) => { logs.push(data); return data; } },
  });
  prisma.$transaction = async (fn) => fn(prisma);
  return { prisma, usuarios, barbearias, tokens, logs };
}

module.exports = { bancoAcesso, casa };
