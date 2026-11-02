'use strict';
/**
 * Controle de Estoque - Loja de Roupas
 * Servidor sem dependências externas: usa apenas módulos nativos do Node (>= 22.13).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'estoque.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSAO_HORAS = 12;
const COOKIE = 'sid';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    categoria TEXT NOT NULL DEFAULT 'Outros',
    tamanho TEXT NOT NULL DEFAULT 'Único',
    cor TEXT NOT NULL DEFAULT '',
    quantidade INTEGER NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
    estoque_minimo INTEGER NOT NULL DEFAULT 3 CHECK (estoque_minimo >= 0),
    preco_custo REAL NOT NULL DEFAULT 0 CHECK (preco_custo >= 0),
    preco_venda REAL NOT NULL DEFAULT 0 CHECK (preco_venda >= 0),
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS movimentacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('entrada','saida','ajuste')),
    quantidade INTEGER NOT NULL,
    saldo_apos INTEGER NOT NULL,
    observacao TEXT NOT NULL DEFAULT '',
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mov_produto ON movimentacoes(produto_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_produtos_nome ON produtos(nome);
`);

/* ---------- utilidades ---------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, sal, 64);
  return `${sal.toString('hex')}:${hash.toString('hex')}`;
}

function conferirSenha(senha, armazenado) {
  const [salHex, hashHex] = armazenado.split(':');
  const esperado = Buffer.from(hashHex, 'hex');
  const obtido = crypto.scryptSync(senha, Buffer.from(salHex, 'hex'), 64);
  return esperado.length === obtido.length && crypto.timingSafeEqual(esperado, obtido);
}

function lerCookies(req) {
  const out = {};
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

function lerCorpo(req, limite = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > limite) {
        reject(new HttpError(413, 'Requisição muito grande.'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => {
      if (!partes.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function responder(res, status, dados, extraHeaders = {}) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(corpo);
}

/* ---------- sessão e login ---------- */

function criarSessao(res, usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = Date.now() + SESSAO_HORAS * 3600 * 1000;
  db.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)').run(
    sha256(token), usuarioId, expira
  );
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_HORAS * 3600}`;
}

function usuarioDaSessao(req) {
  const token = lerCookies(req)[COOKIE];
  if (!token) return null;
  const linha = db
    .prepare(
      `SELECT u.id, u.usuario, s.expira_em FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?`
    )
    .get(sha256(token));
  if (!linha) return null;
  if (linha.expira_em < Date.now()) {
    db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { id: Number(linha.id), usuario: linha.usuario };
}

// Limite simples de tentativas de login por IP
const tentativas = new Map();
function checarLimiteLogin(ip) {
  const agora = Date.now();
  const reg = tentativas.get(ip) || { n: 0, desde: agora };
  if (agora - reg.desde > 15 * 60 * 1000) {
    reg.n = 0;
    reg.desde = agora;
  }
  tentativas.set(ip, reg);
  if (reg.n >= 8) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  return reg;
}

/* ---------- validação de produtos ---------- */

function texto(valor, campo, { max = 80, obrigatorio = false } = {}) {
  const v = String(valor ?? '').trim();
  if (obrigatorio && !v) throw new HttpError(400, `Informe ${campo}.`);
  if (v.length > max) throw new HttpError(400, `${campo} muito longo (máx. ${max}).`);
  return v;
}

function inteiro(valor, campo, { min = 0 } = {}) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${campo} deve ser um número inteiro ≥ ${min}.`);
  return n;
}

function dinheiro(valor, campo) {
  const n = Number(String(valor ?? 0).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${campo} deve ser um valor ≥ 0.`);
  return Math.round(n * 100) / 100;
}

function validarProduto(b) {
  return {
    nome: texto(b.nome, 'o nome', { obrigatorio: true, max: 120 }),
    categoria: texto(b.categoria, 'a categoria', { max: 60 }) || 'Outros',
    tamanho: texto(b.tamanho, 'o tamanho', { max: 20 }) || 'Único',
    cor: texto(b.cor, 'a cor', { max: 40 }),
    quantidade: inteiro(b.quantidade ?? 0, 'Quantidade'),
    estoque_minimo: inteiro(b.estoque_minimo ?? 3, 'Estoque mínimo'),
    preco_custo: dinheiro(b.preco_custo, 'Preço de custo'),
    preco_venda: dinheiro(b.preco_venda, 'Preço de venda'),
  };
}

const num = (r) => ({ ...r, id: Number(r.id) });

/* ---------- rotas da API ---------- */

const rotas = [];
function rota(metodo, padrao, { publica = false } = {}, handler) {
  const chaves = [];
  const regex = new RegExp(
    '^' + padrao.replace(/:(\w+)/g, (_, k) => (chaves.push(k), '([^/]+)')) + '/?$'
  );
  rotas.push({ metodo, regex, chaves, publica, handler });
}

const temUsuarios = () => db.prepare('SELECT COUNT(*) c FROM usuarios').get().c > 0;

rota('GET', '/api/status', { publica: true }, (ctx) => {
  const u = usuarioDaSessao(ctx.req);
  return { configurado: temUsuarios(), autenticado: !!u, usuario: u?.usuario ?? null };
});

rota('POST', '/api/setup', { publica: true }, async (ctx) => {
  if (temUsuarios()) throw new HttpError(403, 'O sistema já foi configurado.');
  const b = await lerCorpo(ctx.req);
  const usuario = texto(b.usuario, 'o usuário', { obrigatorio: true, max: 40 });
  const senha = String(b.senha ?? '');
  if (senha.length < 6) throw new HttpError(400, 'A senha precisa ter pelo menos 6 caracteres.');
  const r = db.prepare('INSERT INTO usuarios (usuario, senha_hash) VALUES (?, ?)').run(usuario, hashSenha(senha));
  ctx.cookie = criarSessao(ctx.res, Number(r.lastInsertRowid));
  return { ok: true, usuario };
});

rota('POST', '/api/login', { publica: true }, async (ctx) => {
  const reg = checarLimiteLogin(ctx.req.socket.remoteAddress);
  const b = await lerCorpo(ctx.req);
  const u = db.prepare('SELECT id, usuario, senha_hash FROM usuarios WHERE usuario = ?').get(String(b.usuario ?? '').trim());
  // Mesmo custo de cálculo quando o usuário não existe (evita revelar quais usuários existem)
  const ok = u ? conferirSenha(String(b.senha ?? ''), u.senha_hash) : (conferirSenha('x', hashSenha('y')), false);
  if (!ok) {
    reg.n += 1;
    throw new HttpError(401, 'Usuário ou senha incorretos.');
  }
  reg.n = 0;
  ctx.cookie = criarSessao(ctx.res, Number(u.id));
  return { ok: true, usuario: u.usuario };
});

rota('POST', '/api/logout', { publica: true }, (ctx) => {
  const token = lerCookies(ctx.req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sha256(token));
  ctx.cookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  return { ok: true };
});

rota('GET', '/api/resumo', {}, () => {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS modelos,
              COALESCE(SUM(quantidade),0) AS pecas,
              COALESCE(SUM(quantidade*preco_custo),0) AS valor_custo,
              COALESCE(SUM(quantidade*preco_venda),0) AS valor_venda,
              COALESCE(SUM(CASE WHEN quantidade > 0 AND quantidade <= estoque_minimo THEN 1 ELSE 0 END),0) AS estoque_baixo,
              COALESCE(SUM(CASE WHEN quantidade = 0 THEN 1 ELSE 0 END),0) AS zerados
       FROM produtos`
    )
    .get();
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
});

rota('GET', '/api/categorias', {}, () =>
  db.prepare('SELECT DISTINCT categoria FROM produtos ORDER BY categoria').all().map((r) => r.categoria)
);

rota('GET', '/api/produtos', {}, (ctx) => {
  const q = ctx.url.searchParams;
  const where = [];
  const params = [];
  const busca = (q.get('busca') || '').trim();
  if (busca) {
    where.push('(nome LIKE ? OR cor LIKE ? OR categoria LIKE ?)');
    const like = `%${busca.replace(/[%_]/g, '')}%`;
    params.push(like, like, like);
  }
  if (q.get('categoria')) {
    where.push('categoria = ?');
    params.push(q.get('categoria'));
  }
  const situacao = q.get('situacao');
  if (situacao === 'baixo') where.push('quantidade > 0 AND quantidade <= estoque_minimo');
  else if (situacao === 'zerado') where.push('quantidade = 0');
  else if (situacao === 'alerta') where.push('quantidade <= estoque_minimo');
  const sql = `SELECT * FROM produtos ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY nome COLLATE NOCASE, tamanho`;
  return db.prepare(sql).all(...params).map(num);
});

rota('POST', '/api/produtos', {}, async (ctx) => {
  const p = validarProduto(await lerCorpo(ctx.req));
  db.exec('BEGIN');
  try {
    const r = db
      .prepare(
        `INSERT INTO produtos (nome, categoria, tamanho, cor, quantidade, estoque_minimo, preco_custo, preco_venda)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(p.nome, p.categoria, p.tamanho, p.cor, p.quantidade, p.estoque_minimo, p.preco_custo, p.preco_venda);
    const id = Number(r.lastInsertRowid);
    if (p.quantidade > 0) {
      db.prepare(
        `INSERT INTO movimentacoes (produto_id, tipo, quantidade, saldo_apos, observacao) VALUES (?, 'entrada', ?, ?, 'Cadastro inicial')`
      ).run(id, p.quantidade, p.quantidade);
    }
    db.exec('COMMIT');
    ctx.status = 201;
    return num(db.prepare('SELECT * FROM produtos WHERE id = ?').get(id));
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

function buscarProduto(id) {
  const p = db.prepare('SELECT * FROM produtos WHERE id = ?').get(Number(id));
  if (!p) throw new HttpError(404, 'Produto não encontrado.');
  return p;
}

rota('PUT', '/api/produtos/:id', {}, async (ctx) => {
  const atual = buscarProduto(ctx.params.id);
  const b = await lerCorpo(ctx.req);
  const p = validarProduto({ ...b, quantidade: atual.quantidade }); // quantidade só muda por movimentação
  db.prepare(
    `UPDATE produtos SET nome=?, categoria=?, tamanho=?, cor=?, estoque_minimo=?, preco_custo=?, preco_venda=?,
            atualizado_em=datetime('now') WHERE id=?`
  ).run(p.nome, p.categoria, p.tamanho, p.cor, p.estoque_minimo, p.preco_custo, p.preco_venda, atual.id);
  return num(buscarProduto(atual.id));
});

rota('DELETE', '/api/produtos/:id', {}, (ctx) => {
  const p = buscarProduto(ctx.params.id);
  db.prepare('DELETE FROM produtos WHERE id = ?').run(p.id);
  return { ok: true };
});

rota('POST', '/api/produtos/:id/movimentar', {}, async (ctx) => {
  const b = await lerCorpo(ctx.req);
  const tipo = String(b.tipo);
  if (!['entrada', 'saida', 'ajuste'].includes(tipo)) throw new HttpError(400, 'Tipo de movimentação inválido.');
  const obs = texto(b.observacao, 'a observação', { max: 200 });
  db.exec('BEGIN IMMEDIATE');
  try {
    const p = buscarProduto(ctx.params.id);
    let novo;
    let qtd;
    if (tipo === 'ajuste') {
      novo = inteiro(b.quantidade, 'Quantidade', { min: 0 });
      qtd = novo - p.quantidade;
    } else {
      qtd = inteiro(b.quantidade, 'Quantidade', { min: 1 });
      novo = tipo === 'entrada' ? p.quantidade + qtd : p.quantidade - qtd;
      if (novo < 0) throw new HttpError(400, `Estoque insuficiente: só há ${p.quantidade} unidade(s).`);
    }
    db.prepare(`UPDATE produtos SET quantidade=?, atualizado_em=datetime('now') WHERE id=?`).run(novo, p.id);
    db.prepare(
      'INSERT INTO movimentacoes (produto_id, tipo, quantidade, saldo_apos, observacao) VALUES (?,?,?,?,?)'
    ).run(p.id, tipo, qtd, novo, obs);
    db.exec('COMMIT');
    return num(buscarProduto(p.id));
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

rota('GET', '/api/movimentacoes', {}, (ctx) => {
  const limite = Math.min(Math.max(Number(ctx.url.searchParams.get('limite')) || 30, 1), 200);
  const produtoId = ctx.url.searchParams.get('produto_id');
  const sql = `SELECT m.id, m.produto_id, p.nome, p.tamanho, p.cor, m.tipo, m.quantidade, m.saldo_apos,
                      m.observacao, m.criado_em
               FROM movimentacoes m JOIN produtos p ON p.id = m.produto_id
               ${produtoId ? 'WHERE m.produto_id = ?' : ''}
               ORDER BY m.id DESC LIMIT ?`;
  const args = produtoId ? [Number(produtoId), limite] : [limite];
  return db.prepare(sql).all(...args).map(num);
});

/* ---------- arquivos estáticos ---------- */

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function servirEstatico(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const arquivo = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!arquivo.startsWith(PUBLIC_DIR + path.sep)) return responder(res, 403, { erro: 'Acesso negado.' });
  fs.readFile(arquivo, (err, dados) => {
    if (err) return responder(res, 404, { erro: 'Não encontrado.' });
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(dados);
  });
}

/* ---------- servidor ---------- */

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      return servirEstatico(req, res, url.pathname);
    }

    // Proteção CSRF extra: requisições que alteram dados devem ser da mesma origem
    if (req.method !== 'GET') {
      const origem = req.headers.origin;
      if (origem && new URL(origem).host !== req.headers.host) throw new HttpError(403, 'Origem não permitida.');
    }

    for (const r of rotas) {
      if (r.metodo !== req.method) continue;
      const m = r.regex.exec(url.pathname);
      if (!m) continue;
      if (!r.publica && !usuarioDaSessao(req)) throw new HttpError(401, 'Faça login para continuar.');
      const ctx = { req, res, url, params: {}, status: 200, cookie: null };
      r.chaves.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));
      const resultado = await r.handler(ctx);
      return responder(res, ctx.status, resultado, ctx.cookie ? { 'Set-Cookie': ctx.cookie } : {});
    }
    throw new HttpError(404, 'Rota não encontrada.');
  } catch (e) {
    if (e instanceof HttpError) return responder(res, e.status, { erro: e.message });
    console.error(e);
    responder(res, 500, { erro: 'Erro interno do servidor.' });
  }
});

// Limpa sessões expiradas de hora em hora
setInterval(() => db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(Date.now()), 3600 * 1000).unref();

if (require.main === module) {
  servidor.listen(PORT, () => console.log(`Estoque rodando em http://localhost:${PORT}`));
}

module.exports = { servidor };
