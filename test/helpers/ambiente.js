// Ambiente de teste ISOLADO (node --test, sem instalar nada).
//
// Regra de ouro: nenhum teste toca o banco real nem lê o .env.
//  - `dotenv` é trocado por um stub que NÃO lê arquivo nenhum;
//  - `src/config/db.js` é trocado por um prisma FALSO (em memória) que o teste
//    monta com só os métodos de que precisa;
//  - qualquer outro módulo pode ser simulado (WhatsApp, IA, push...) pelo
//    mesmo mecanismo, passando o caminho relativo à raiz do projeto.
// Se algum código tentar usar um método do prisma que o teste não simulou, o
// teste falha com erro claro em vez de cair no banco.
const path = require('node:path');
const Module = require('node:module');

const RAIZ = path.resolve(__dirname, '..', '..');

// Garante que nada herdado do processo aponte para um banco de verdade.
process.env.DATABASE_URL = 'file:./banco-de-teste-inexistente.db';
process.env.NODE_ENV = 'test';

function resolver(rel) {
  return require.resolve(path.join(RAIZ, rel));
}

function instalarStub(caminhoAbs, exportsFalsos) {
  const m = new Module(caminhoAbs);
  m.filename = caminhoAbs;
  m.loaded = true;
  m.exports = exportsFalsos;
  require.cache[caminhoAbs] = m;
}

// Prisma falso: só responde aos métodos informados; o resto explode.
function prismaFalso(modelos = {}) {
  const alvo = {};
  for (const [nome, metodos] of Object.entries(modelos)) alvo[nome] = metodos;
  return new Proxy(alvo, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return new Proxy({}, {
        get(_, metodo) {
          if (typeof metodo === 'symbol' || metodo === 'then') return undefined;
          return () => { throw new Error(`prisma falso: ${String(prop)}.${String(metodo)} não simulado no teste`); };
        },
      });
    },
  });
}

// Carrega um módulo de src/ com stubs. `stubs` = { 'src/services/x.js': {...} }.
function carregar(rel, { prisma = prismaFalso(), stubs = {} } = {}) {
  // Limpa o cache de tudo que é do projeto (fora node_modules) para cada teste
  // receber módulos novos com os stubs dele.
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(RAIZ) && !k.includes('node_modules') && !k.includes(path.join('test', 'helpers'))) {
      delete require.cache[k];
    }
  }
  instalarStub(require.resolve('dotenv', { paths: [RAIZ] }), { config: () => ({ parsed: {} }) });
  instalarStub(resolver('src/config/db.js'), prisma);
  for (const [r, exp] of Object.entries(stubs)) instalarStub(resolver(r), exp);
  return require(resolver(rel));
}

// req/res mínimos de Express para testar controllers e middlewares.
function reqFalso(extra = {}) {
  const session = {
    regenerate(cb) { cb(); },
    save(cb) { cb && cb(); },
    destroy(cb) { this.destruida = true; cb && cb(); },
    cookie: {},
  };
  return { body: {}, query: {}, params: {}, headers: {}, hostname: 'localhost', session, ...extra, session: Object.assign(session, extra.session || {}) };
}

function resFalso() {
  const res = {
    statusCode: 200, locals: {}, redirecionou: null, renderizou: null, enviado: undefined,
    status(c) { this.statusCode = c; return this; },
    redirect(u) { this.redirecionou = u; return this; },
    render(v, d) { this.renderizou = { view: v, dados: d }; return this; },
    send(b) { this.enviado = b; return this; },
    json(b) { this.enviado = b; return this; },
    sendStatus(c) { this.statusCode = c; this.enviado = c; return this; },
    end() { this.enviado = this.enviado ?? null; return this; },
  };
  return res;
}

module.exports = { RAIZ, carregar, prismaFalso, reqFalso, resFalso, instalarStub };
