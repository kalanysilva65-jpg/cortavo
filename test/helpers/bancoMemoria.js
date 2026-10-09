// Banco EM MEMÓRIA com a forma do Prisma, só para testes (spec 12, B3–B6).
//
// O `prismaFalso` de ambiente.js serve quando o teste responde método a método.
// Para conferir números (Gestão x Relatórios, filtro por barbeiro, caixa do
// dia) é preciso que as MESMAS linhas respondam a consultas diferentes, com o
// `where` aplicado de verdade. Este módulo implementa o subconjunto do Prisma
// que o app usa: findMany/findFirst/findUnique/count/aggregate/groupBy/create/
// createMany/update/updateMany/upsert/delete/deleteMany, com where (igualdade,
// gte/gt/lte/lt, in/notIn, not, contains/startsWith/endsWith, AND/OR/NOT e
// filtro por relação 1:1), include/select aninhados, orderBy, skip/take.
// Nunca toca disco nem banco real.

// Relações: modelo -> campo -> [modeloAlvo, campoLocal, campoAlvo, muitos?]
const REL = {
  barbearia: { usuarios: ['usuario', 'id', 'barbeariaId', true] },
  usuario: { barbearia: ['barbearia', 'barbeariaId', 'id', false], agendamentos: ['agendamento', 'id', 'usuarioId', true] },
  agendamento: {
    usuario: ['usuario', 'usuarioId', 'id', false],
    itens: ['agendamentoItem', 'id', 'agendamentoId', true],
    pagamentos: ['pagamentoAgendamento', 'id', 'agendamentoId', true],
    cliente: ['cliente', 'clienteId', 'id', false],
    clientePlano: ['clientePlano', 'clientePlanoId', 'id', false],
    barbearia: ['barbearia', 'barbeariaId', 'id', false],
  },
  agendamentoItem: { servico: ['servico', 'servicoId', 'id', false], agendamento: ['agendamento', 'agendamentoId', 'id', false] },
  caixa: { categoria: ['categoriaCaixa', 'categoriaId', 'id', false] },
  cliente: { agendamentos: ['agendamento', 'id', 'clienteId', true], planos: ['clientePlano', 'id', 'clienteId', true] },
  clientePlano: { plano: ['plano', 'planoId', 'id', false], cliente: ['cliente', 'clienteId', 'id', false] },
  plano: { servicos: ['planoServico', 'id', 'planoId', true] },
  planoServico: { servico: ['servico', 'servicoId', 'id', false] },
  meta: { usuario: ['usuario', 'usuarioId', 'id', false] },
  conversa: { mensagens: ['mensagem', 'id', 'conversaId', true], barbearia: ['barbearia', 'barbeariaId', 'id', false] },
  mensagem: { conversa: ['conversa', 'conversaId', 'id', false] },
  comissaoPagamento: { usuario: ['usuario', 'usuarioId', 'id', false] },
  fechamentoCaixa: {},
};

const ehData = (v) => v instanceof Date;
const val = (v) => (ehData(v) ? v.getTime() : v);

function igual(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return val(a) === val(b);
}

function casaCampo(valor, cond) {
  if (cond === null) return valor == null;
  if (ehData(cond) || typeof cond !== 'object') return igual(valor, cond);
  for (const [op, alvo] of Object.entries(cond)) {
    switch (op) {
      case 'equals': if (!igual(valor, alvo)) return false; break;
      case 'not':
        if (alvo !== null && typeof alvo === 'object' && !ehData(alvo)) { if (casaCampo(valor, alvo)) return false; }
        else if (igual(valor, alvo)) return false;
        break;
      case 'in': if (!alvo.some((x) => igual(valor, x))) return false; break;
      case 'notIn': if (alvo.some((x) => igual(valor, x))) return false; break;
      case 'gte': if (valor == null || val(valor) < val(alvo)) return false; break;
      case 'gt': if (valor == null || val(valor) <= val(alvo)) return false; break;
      case 'lte': if (valor == null || val(valor) > val(alvo)) return false; break;
      case 'lt': if (valor == null || val(valor) >= val(alvo)) return false; break;
      case 'contains': if (valor == null || !String(valor).includes(alvo)) return false; break;
      case 'startsWith': if (valor == null || !String(valor).startsWith(alvo)) return false; break;
      case 'endsWith': if (valor == null || !String(valor).endsWith(alvo)) return false; break;
      case 'mode': break;
      default: throw new Error('bancoMemoria: operador não suportado: ' + op);
    }
  }
  return true;
}

function criarBanco(inicial = {}) {
  const tabelas = {};
  const seq = {};
  const t = (nome) => (tabelas[nome] = tabelas[nome] || []);
  for (const [nome, linhas] of Object.entries(inicial)) {
    tabelas[nome] = linhas.map((l) => ({ ...l }));
    seq[nome] = Math.max(0, ...tabelas[nome].map((l) => l.id || 0));
  }

  function relacionados(modelo, linha, campo) {
    const r = (REL[modelo] || {})[campo];
    if (!r) return undefined;
    const [alvo, local, remoto, muitos] = r;
    const lista = t(alvo).filter((x) => linha[local] != null && igual(x[remoto], linha[local]));
    return muitos ? lista : lista[0] || null;
  }

  function casa(modelo, linha, where) {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === 'AND') { if (![].concat(cond).every((w) => casa(modelo, linha, w))) return false; continue; }
      if (k === 'OR') { if (!cond.some((w) => casa(modelo, linha, w))) return false; continue; }
      if (k === 'NOT') { if ([].concat(cond).some((w) => casa(modelo, linha, w))) return false; continue; }
      const rel = (REL[modelo] || {})[k];
      if (rel && cond && typeof cond === 'object' && !ehData(cond)) {
        const [alvo, , , muitos] = rel;
        const r = relacionados(modelo, linha, k);
        if (muitos) {
          if (cond.some) { if (!r.some((x) => casa(alvo, x, cond.some))) return false; }
          else if (cond.none) { if (r.some((x) => casa(alvo, x, cond.none))) return false; }
          else if (cond.every) { if (!r.every((x) => casa(alvo, x, cond.every))) return false; }
          continue;
        }
        if (!r || !casa(alvo, r, cond.is || cond)) return false;
        continue;
      }
      if (!casaCampo(linha[k], cond)) return false;
    }
    return true;
  }

  function moldar(modelo, linha, { include, select } = {}) {
    if (!linha) return null;
    let out;
    if (select) {
      out = {};
      for (const [k, v] of Object.entries(select)) {
        if (!v) continue;
        if ((REL[modelo] || {})[k]) out[k] = moldarRel(modelo, linha, k, v);
        else out[k] = linha[k];
      }
      return out;
    }
    out = { ...linha };
    if (include) {
      for (const [k, v] of Object.entries(include)) {
        if (!v) continue;
        out[k] = moldarRel(modelo, linha, k, v);
      }
    }
    return out;
  }

  function moldarRel(modelo, linha, campo, opcoes) {
    const alvo = REL[modelo][campo][0];
    const r = relacionados(modelo, linha, campo);
    const op = opcoes === true ? {} : opcoes;
    if (Array.isArray(r)) {
      let lista = r.filter((x) => casa(alvo, x, op.where));
      lista = ordenar(lista, op.orderBy);
      return lista.map((x) => moldar(alvo, x, op));
    }
    return moldar(alvo, r, op);
  }

  function ordenar(lista, orderBy) {
    if (!orderBy) return lista;
    const regras = [].concat(orderBy).flatMap((o) => Object.entries(o));
    return lista.slice().sort((a, b) => {
      for (const [campo, dir] of regras) {
        const va = val(a[campo]);
        const vb = val(b[campo]);
        if (va === vb) continue;
        if (va == null) return 1;
        if (vb == null) return -1;
        const c = va < vb ? -1 : 1;
        return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  // `where` de findUnique pode vir com chave composta (barbeariaId_telefone).
  function achatar(where) {
    const out = {};
    for (const [k, v] of Object.entries(where || {})) {
      if (k.includes('_') && v && typeof v === 'object' && !ehData(v) && !Array.isArray(v)) Object.assign(out, v);
      else out[k] = v;
    }
    return out;
  }

  function aplicarDados(modelo, linha, data) {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const rel = (REL[modelo] || {})[k];
      if (rel && v && typeof v === 'object' && (v.create || v.createMany)) continue;
      if (v && typeof v === 'object' && !ehData(v) && ('increment' in v || 'decrement' in v)) {
        linha[k] = (linha[k] || 0) + (v.increment || 0) - (v.decrement || 0);
      } else linha[k] = v;
    }
  }

  function criarLinha(modelo, data) {
    seq[modelo] = (seq[modelo] || 0) + 1;
    const linha = { id: seq[modelo] };
    aplicarDados(modelo, linha, data);
    if (data.id != null) linha.id = data.id;
    t(modelo).push(linha);
    for (const [k, v] of Object.entries(data)) {
      const rel = (REL[modelo] || {})[k];
      if (!rel || !v || typeof v !== 'object' || !v.create) continue;
      const [alvo, local, remoto] = rel;
      for (const filho of [].concat(v.create)) criarLinha(alvo, { ...filho, [remoto]: linha[local] });
    }
    return linha;
  }

  function modeloApi(modelo) {
    return {
      async findMany(a = {}) {
        let lista = t(modelo).filter((l) => casa(modelo, l, a.where));
        lista = ordenar(lista, a.orderBy);
        if (a.skip) lista = lista.slice(a.skip);
        if (a.take != null) lista = lista.slice(0, a.take);
        return lista.map((l) => moldar(modelo, l, a));
      },
      async findFirst(a = {}) {
        const r = await this.findMany({ ...a, take: 1 });
        return r[0] || null;
      },
      async findUnique(a = {}) {
        const w = achatar(a.where);
        const l = t(modelo).find((x) => casa(modelo, x, w));
        return l ? moldar(modelo, l, a) : null;
      },
      async count(a = {}) {
        return t(modelo).filter((l) => casa(modelo, l, a.where)).length;
      },
      async aggregate(a = {}) {
        const lista = t(modelo).filter((l) => casa(modelo, l, a.where));
        const out = {};
        if (a._sum) { out._sum = {}; for (const k of Object.keys(a._sum)) out._sum[k] = lista.length ? lista.reduce((s, l) => s + (l[k] || 0), 0) : null; }
        if (a._count) out._count = typeof a._count === 'object' ? Object.fromEntries(Object.keys(a._count).map((k) => [k, k === '_all' ? lista.length : lista.filter((l) => l[k] != null).length])) : lista.length;
        if (a._min) { out._min = {}; for (const k of Object.keys(a._min)) { const vs = lista.map((l) => l[k]).filter((v) => v != null); out._min[k] = vs.length ? vs.reduce((m, v) => (val(v) < val(m) ? v : m)) : null; } }
        if (a._max) { out._max = {}; for (const k of Object.keys(a._max)) { const vs = lista.map((l) => l[k]).filter((v) => v != null); out._max[k] = vs.length ? vs.reduce((m, v) => (val(v) > val(m) ? v : m)) : null; } }
        return out;
      },
      async groupBy(a = {}) {
        const lista = t(modelo).filter((l) => casa(modelo, l, a.where));
        const grupos = new Map();
        for (const l of lista) {
          const chave = JSON.stringify(a.by.map((k) => val(l[k])));
          if (!grupos.has(chave)) grupos.set(chave, []);
          grupos.get(chave).push(l);
        }
        const out = [];
        for (const linhas of grupos.values()) {
          const g = {};
          for (const k of a.by) g[k] = linhas[0][k];
          const ag = await modeloApiTemp(linhas).aggregate({ _sum: a._sum, _min: a._min, _max: a._max, _count: a._count });
          Object.assign(g, ag);
          out.push(g);
        }
        return ordenar(out, a.orderBy);
      },
      async create(a) {
        const l = criarLinha(modelo, a.data);
        return moldar(modelo, l, a);
      },
      async createMany(a) {
        for (const d of [].concat(a.data)) criarLinha(modelo, d);
        return { count: [].concat(a.data).length };
      },
      async update(a) {
        const w = achatar(a.where);
        const l = t(modelo).find((x) => casa(modelo, x, w));
        if (!l) throw Object.assign(new Error('Registro não encontrado'), { code: 'P2025' });
        aplicarDados(modelo, l, a.data);
        return moldar(modelo, l, a);
      },
      async updateMany(a) {
        const lista = t(modelo).filter((l) => casa(modelo, l, a.where));
        lista.forEach((l) => aplicarDados(modelo, l, a.data));
        return { count: lista.length };
      },
      async upsert(a) {
        const w = achatar(a.where);
        const l = t(modelo).find((x) => casa(modelo, x, w));
        if (l) { aplicarDados(modelo, l, a.update); return moldar(modelo, l, a); }
        return moldar(modelo, criarLinha(modelo, a.create), a);
      },
      async delete(a) {
        const w = achatar(a.where);
        const i = t(modelo).findIndex((x) => casa(modelo, x, w));
        if (i < 0) throw Object.assign(new Error('Registro não encontrado'), { code: 'P2025' });
        const [l] = t(modelo).splice(i, 1);
        // Cascata simples dos filhos 1:N declarados.
        for (const [, rel] of Object.entries(REL[modelo] || {})) {
          const [alvo, local, remoto, muitos] = rel;
          if (muitos && remoto !== 'id') tabelas[alvo] = t(alvo).filter((x) => !igual(x[remoto], l[local]));
        }
        return l;
      },
      async deleteMany(a = {}) {
        const antes = t(modelo).length;
        tabelas[modelo] = t(modelo).filter((l) => !casa(modelo, l, a.where));
        return { count: antes - tabelas[modelo].length };
      },
    };
  }

  // Agregação sobre um subconjunto (usado pelo groupBy).
  function modeloApiTemp(linhas) {
    return {
      async aggregate(a) {
        const out = {};
        if (a._sum) { out._sum = {}; for (const k of Object.keys(a._sum)) out._sum[k] = linhas.reduce((s, l) => s + (l[k] || 0), 0); }
        if (a._count) out._count = typeof a._count === 'object' ? Object.fromEntries(Object.keys(a._count).map((k) => [k, k === '_all' ? linhas.length : linhas.filter((l) => l[k] != null).length])) : linhas.length;
        if (a._min) { out._min = {}; for (const k of Object.keys(a._min)) { const vs = linhas.map((l) => l[k]).filter((v) => v != null); out._min[k] = vs.length ? vs.reduce((m, v) => (val(v) < val(m) ? v : m)) : null; } }
        if (a._max) { out._max = {}; for (const k of Object.keys(a._max)) { const vs = linhas.map((l) => l[k]).filter((v) => v != null); out._max[k] = vs.length ? vs.reduce((m, v) => (val(v) > val(m) ? v : m)) : null; } }
        return out;
      },
    };
  }

  const apis = {};
  const banco = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === '_tabelas') return tabelas;
      if (prop === '$transaction') {
        return async (arg) => (typeof arg === 'function' ? arg(banco) : Promise.all(arg));
      }
      if (!apis[prop]) apis[prop] = modeloApi(prop);
      return apis[prop];
    },
  });
  return banco;
}

module.exports = { criarBanco };
