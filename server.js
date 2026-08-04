'use strict';
/*
 * 语文幼小衔接 · 同步后端
 * 零依赖 Node 服务：node:sqlite 真实数据库 + 同源静态托管 + 跨设备同步 API
 *
 * 运行（推荐，使用 SQLite 数据库）：
 *   node server.js          ← 自动按需加 --experimental-sqlite（Node<24），无需手记标志
 * 若 Node 版本 < 22.5 或不想加标志，会自动回退到 JSON 文件存储（yw.json），功能一致。
 *
 * 环境变量（可选）：
 *   PORT       端口，默认 3000
 *   PUBLIC_DIR 静态目录，默认 server.js 所在目录（放 index.html 即可）
 *   DB_PATH    数据库文件路径，默认 ./yw.db
 *   SYNC_KEY   共享密钥；设置后前端须带相同 x-sync-key 才能访问 /api
 */
// 兼容 Node<24：node:sqlite 需 --experimental-sqlite 标志；若当前未带且 require 失败，自动重启自身带上标志。
if (Number(process.versions.node.split('.')[0]) < 24 && !process.execArgv.includes('--experimental-sqlite')) {
  try { require('node:sqlite'); }
  catch (e) {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, ['--experimental-sqlite', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(r.status === null ? 1 : r.status);
  }
}
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = process.env.PUBLIC_DIR || __dirname;
const SYNC_KEY = process.env.SYNC_KEY || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'yw.db');

// ---------- 字段级合并：保证两端都不丢进度 ----------
function uniq(arr) { return Array.from(new Set(arr || [])); }
function mergeState(a, b) {
  a = a || {}; b = b || {};
  const out = Object.assign({}, a);
  out.points = Math.max(Number(a.points) || 0, Number(b.points) || 0);
  out.streak = Math.max(Number(a.streak) || 0, Number(b.streak) || 0);
  out.checkins = uniq([...(a.checkins || []), ...(b.checkins || [])]);
  out.unlocked = uniq([...(a.unlocked || []), ...(b.unlocked || [])]);
  // 练习成绩：按日期，取已批改/分数更高者
  const pMap = {};
  Object.entries(a.practice || {}).forEach(([k, v]) => { pMap[k] = v; });
  Object.entries(b.practice || {}).forEach(([k, v]) => {
    const ex = pMap[k];
    if (!ex || (v && v.done && (!ex.done || (v.score || 0) > (ex.score || 0)))) pMap[k] = v;
  });
  out.practice = pMap;
  // 学习记录：按日期，取分数更高者
  const rMap = {};
  (a.records || []).forEach(r => { rMap[r.date] = r; });
  (b.records || []).forEach(r => {
    const ex = rMap[r.date];
    if (!ex || (r.score != null && (ex.score == null || r.score > ex.score))) rMap[r.date] = r;
  });
  out.records = Object.values(rMap);
  // 学习动态日志：按 ts+类型+标题 去重
  const seen = new Set(); const log = [];
  [...(a.log || []), ...(b.log || [])].forEach(l => {
    const key = (l.ts || 0) + '|' + l.type + '|' + (l.title || '') + '|' + (l.detail || '');
    if (!seen.has(key)) { seen.add(key); log.push(l); }
  });
  out.log = log.sort((x, y) => (x.ts || 0) - (y.ts || 0));
  out.pinRate = (b.pinRate !== undefined && b.pinRate !== null) ? b.pinRate
    : (a.pinRate !== undefined ? a.pinRate : 8);
  return out;
}

// ---------- 存储抽象：优先 node:sqlite，回退 JSON 文件 ----------
function createStore() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) {}
    const db = new DatabaseSync(DB_PATH);
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      avatar TEXT NOT NULL DEFAULT '🐱',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    );`);
    return {
      kind: 'sqlite',
      listUsers() {
        return db.prepare('SELECT name, avatar, updated_at FROM users ORDER BY updated_at DESC').all()
          .map(r => ({ name: r.name, avatar: r.avatar, updatedAt: r.updated_at }));
      },
      getState(name) {
        const r = db.prepare('SELECT data, updated_at FROM users WHERE name=?').get(name);
        if (!r) return null;
        try { return { state: JSON.parse(r.data), updatedAt: r.updated_at }; }
        catch (e) { return { state: {}, updatedAt: r.updated_at }; }
      },
      upsert(name, avatar, state, now) {
        const ex = db.prepare('SELECT data FROM users WHERE name=?').get(name);
        const merged = ex ? mergeState(JSON.parse(ex.data || '{}'), state) : state;
        const data = JSON.stringify(merged);
        db.prepare(`INSERT INTO users(name,avatar,created_at,updated_at,data) VALUES(?,?,?,?,?)
          ON CONFLICT(name) DO UPDATE SET avatar=excluded.avatar, updated_at=excluded.updated_at, data=excluded.data`)
          .run(name, avatar || '🐱', now, now, data);
        return { state: merged, updatedAt: now };
      },
      deleteUser(name) { db.prepare('DELETE FROM users WHERE name=?').run(name); },
    };
  } catch (e) {
    const JF = path.join(__dirname, 'yw.json');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(JF, 'utf8')); } catch (e) {}
    const save = () => fs.writeFileSync(JF, JSON.stringify(data, null, 2));
    return {
      kind: 'json',
      listUsers() {
        return Object.keys(data).map(n => ({ name: n, avatar: data[n].avatar, updatedAt: data[n].updated_at }));
      },
      getState(name) {
        if (!data[name]) return null;
        return { state: data[name].data || {}, updatedAt: data[name].updated_at };
      },
      upsert(name, avatar, state, now) {
        const merged = data[name] ? mergeState(data[name].data || {}, state) : state;
        data[name] = { avatar: avatar || '🐱', created_at: data[name] ? data[name].created_at : now, updated_at: now, data: merged };
        save();
        return { state: merged, updatedAt: now };
      },
      deleteUser(name) { delete data[name]; save(); },
    };
  }
}

const store = createStore();
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-sync-key',
  };
}
function sendJson(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders()));
  res.end(JSON.stringify(obj));
}
function checkKey(req) {
  if (!SYNC_KEY) return true;
  return (req.headers['x-sync-key'] || '') === SYNC_KEY;
}
function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (p.startsWith('/api/')) {
    if (!checkKey(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (p === '/api/ping') return sendJson(res, 200, { ok: true, store: store.kind });

    if (p === '/api/users') {
      if (req.method === 'GET') return sendJson(res, 200, { users: store.listUsers() });
      if (req.method === 'POST') {
        const b = await readBody(req);
        const name = (b.name || '').toString().trim().slice(0, 8);
        if (!name) return sendJson(res, 400, { error: 'name required' });
        const r = store.upsert(name, b.avatar || '🐱', b.state || {}, Date.now());
        return sendJson(res, 200, { name, state: r.state, updatedAt: r.updatedAt });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const m = p.match(/^\/api\/users\/(.+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        const r = store.getState(name);
        if (!r) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, r);
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const r = store.upsert(name, b.avatar, b.state || {}, Date.now());
        return sendJson(res, 200, { name, state: r.state, updatedAt: r.updatedAt });
      }
      if (req.method === 'DELETE') {
        store.deleteUser(name);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // ---------- 静态文件托管 ----------
  let fp = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(b2);
      });
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`语文同步服务已启动 → http://localhost:${PORT}  (存储: ${store.kind})`);
  console.log(`把构建好的 index.html 放在此目录（${PUBLIC_DIR}）即可被托管并同步`);
});
