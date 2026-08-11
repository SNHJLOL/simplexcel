'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

// pkg 打包后：config.json 等外部可写文件放在 EXE 同目录；public 静态资源嵌入 EXE 快照
const ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = process.pkg ? path.join(__dirname, 'public') : path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const API_BASE = 'https://simple.imsummer.cn';
const REQUEST_TIMEOUT = 65000;

function loadConfig() {
  try {
    const cfgPath = path.join(ROOT, 'config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch (_) { /* ignore */ }
  return {};
}

let TOKEN_OVERRIDE = null; // null = 使用 config.json / 环境变量中的 token；'' = 已退出登录

function getToken() {
  if (TOKEN_OVERRIDE !== null) return TOKEN_OVERRIDE;
  if (process.env.SIMPLE_TOKEN) return process.env.SIMPLE_TOKEN.trim();
  const cfg = loadConfig();
  return (cfg && cfg.token ? String(cfg.token) : '').trim();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function qsFor(query) {
  return new URLSearchParams(query).toString();
}

function apiGet(pathname, query) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(query).toString();
    const url = API_BASE + pathname + (qs ? '?' + qs : '');
    const req = https.get(url, {
      headers: {
        'Authorization': getToken(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('上游接口超时')));
    req.on('error', (err) => reject(err));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function apiSend(method, pathname, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = API_BASE + pathname;
    const payload = JSON.stringify(bodyObj || {});
    const req = https.request(url, {
      method,
      headers: {
        'Authorization': getToken(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('上游接口超时')));
    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}
const ME_CACHE = { data: null, at: 0 };


const MEDIA_HOST = 'static-simple.imsummer.cn';

function streamMedia(res, targetUrl, clientReq) {
  return new Promise((resolve) => {
    const range = clientReq.headers.range || '';
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (range) headers['Range'] = range;
    const req = https.get(targetUrl, { headers, timeout: 60000 }, (up) => {
      const hdrs = {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
        'Accept-Ranges': up.headers['accept-ranges'] || 'bytes',
      };
      if (up.headers['content-length']) hdrs['Content-Length'] = up.headers['content-length'];
      if (up.headers['content-range']) hdrs['Content-Range'] = up.headers['content-range'];
      res.writeHead(up.statusCode || 502, hdrs);
      up.pipe(res);
      up.on('end', () => resolve());
      up.on('error', () => { res.destroy(); resolve(); });
    });
    req.on('timeout', () => req.destroy(new Error('media timeout')));
    req.on('error', (err) => {
      if (!res.headersSent) sendJson(res, 502, { message: String(err.message || err) });
      else res.destroy();
      resolve();
    });
  });
}
const POST_CACHE = new Map(); // key -> { at, body }
const COMMENT_CACHE = new Map(); // key -> { at, body }
const COMMENT_CACHE_TTL = Number(process.env.COMMENT_CACHE_TTL || 15000); // 毫秒
const FAV_CACHE = new Map(); // key -> { at, body }
const FAV_CACHE_TTL = Number(process.env.FAV_CACHE_TTL || 15000); // 毫秒
const POST_CACHE_TTL = Number(process.env.POST_CACHE_TTL || 120000); // 毫秒
function clearApiCaches() {
  POST_CACHE.clear();
  COMMENT_CACHE.clear();
  FAV_CACHE.clear();
  ME_CACHE.data = null;
  ME_CACHE.at = 0;
}


function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
  return true;
}

async function handleApi(url, req, res) {
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','posts']
  if (parts.length < 2 || parts[0] !== 'api') return false;

  const sub = parts[1];
  if (sub === 'votes' || sub === 'favourites') {
    if (sub === 'favourites' && req.method === 'GET') {
      const query = {};
      for (const key of ['last_id', 'per_page']) {
        const v = url.searchParams.get(key);
        if (v) query[key] = v;
      }
      if (!query.per_page) query.per_page = '20';
      const cacheKey = '/api/v2/favourites?' + qsFor(query);
      const hit = FAV_CACHE.get(cacheKey);
      if (hit && Date.now() - hit.at < FAV_CACHE_TTL) {
        return sendJson(res, 200, JSON.parse(hit.body));
      }
      const upstream = await apiGet('/api/v2/favourites', query);
      let payload;
      try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
      if (upstream.status === 200 && Array.isArray(payload)) {
        FAV_CACHE.set(cacheKey, { at: Date.now(), body: upstream.body.toString('utf8') });
      }
      return sendJson(res, upstream.status || 502, Array.isArray(payload) ? payload : { message: (payload && payload.message) || '获取收藏失败' });
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      return sendJson(res, 405, { message: '方法不支持' });
    }
    let body = null;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { /* ignore */ }
    const postId = body && typeof body.post_id === 'string' ? body.post_id.trim() : '';
    if (!postId) return sendJson(res, 400, { message: '缺少 post_id' });
    const endpoint = sub === 'votes' ? '/api/v2/votes' : '/api/v2/favourites';
    const upstream = await apiSend(req.method, endpoint, { post_id: postId });
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 201 || upstream.status === 200) {
      POST_CACHE.clear(); // 点赞/收藏状态已变化，丢弃旧缓存
      if (sub === 'favourites') FAV_CACHE.clear();
    }
    return sendJson(res, upstream.status || 502, payload || { message: '请求失败' });
  }

  if (sub === 'comments') {
    if (req.method === 'GET') {
      const query = {};
      for (const key of ['post_id', 'last_id', 'per_page']) {
        const v = url.searchParams.get(key);
        if (v) query[key] = v;
      }
      if (!query.post_id) return sendJson(res, 400, { message: '缺少 post_id' });
      if (!query.per_page) query.per_page = '10';
      const cacheKey = '/api/v2/comments?' + qsFor(query);
      const hit = COMMENT_CACHE.get(cacheKey);
      if (hit && Date.now() - hit.at < COMMENT_CACHE_TTL) {
        return sendJson(res, 200, JSON.parse(hit.body));
      }
      const upstream = await apiGet('/api/v2/comments', query);
      let payload;
      try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
      if (upstream.status === 200 && Array.isArray(payload)) {
        COMMENT_CACHE.set(cacheKey, { at: Date.now(), body: upstream.body.toString('utf8') });
      }
      return sendJson(res, upstream.status || 502, Array.isArray(payload) ? payload : { message: (payload && payload.message) || '获取评论失败' });
    }
    if (req.method === 'POST') {
      let body = null;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { /* ignore */ }
      const content = body && typeof body.content === 'string' ? body.content.trim() : '';
      const isReply = parts[2] === 'replies';
      if (isReply) {
        const commentId = body && typeof body.comment_id === 'string' ? body.comment_id.trim() : '';
        if (!commentId || !content) return sendJson(res, 400, { message: '缺少 comment_id 或 content' });
        const upstream = await apiSend('POST', '/api/v2/comments/replies', { comment_id: commentId, content });
        let payload;
        try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
        if (upstream.status === 201 || upstream.status === 200) {
          COMMENT_CACHE.clear(); // 回复已变化，丢弃旧缓存
        }
        return sendJson(res, upstream.status || 502, payload || { message: '请求失败' });
      }
      const postId = body && typeof body.post_id === 'string' ? body.post_id.trim() : '';
      if (!postId || !content) return sendJson(res, 400, { message: '缺少 post_id 或 content' });
      const upstream = await apiSend('POST', '/api/v2/comments', { post_id: postId, content });
      let payload;
      try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
      if (upstream.status === 201 || upstream.status === 200) {
        COMMENT_CACHE.clear(); // 评论已变化，丢弃旧缓存
      }
      return sendJson(res, upstream.status || 502, payload || { message: '请求失败' });
    }
    return sendJson(res, 405, { message: '方法不支持' });
  }

  if (sub === 'status') {
    return sendJson(res, 200, { hasToken: getToken().length > 0, ok: true });
  }

  if (sub === 'me') {
    const now = Date.now();
    const forceRefresh = url.searchParams.get('refresh') === '1';
    if (!forceRefresh && ME_CACHE.data && now - ME_CACHE.at < 5 * 60 * 1000) {
      return sendJson(res, 200, ME_CACHE.data);
    }
    const upstream = await apiGet('/api/v2/current_user', {});
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 200 && payload) {
      ME_CACHE.data = payload;
      ME_CACHE.at = now;
      return sendJson(res, 200, payload);
    }
    return sendJson(res, upstream.status || 502, { message: (payload && payload.message) || '获取用户信息失败' });
  }

  if (sub === 'login' && req.method === 'POST') {
    TOKEN_OVERRIDE = null; // 重新启用 config.json / 环境变量中的 token
    clearApiCaches();
    const upstream = await apiGet('/api/v2/current_user', {});
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 200 && payload) {
      ME_CACHE.data = payload;
      ME_CACHE.at = Date.now();
      return sendJson(res, 200, payload);
    }
    return sendJson(res, upstream.status || 502, { message: (payload && payload.message) || '登录失败：token 无效或已过期' });
  }

  if (sub === 'logout' && req.method === 'POST') {
    TOKEN_OVERRIDE = '';
    clearApiCaches();
    return sendJson(res, 200, { ok: true });
  }

  if (sub === 'token' && req.method === 'POST') {
    let body = null;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { /* ignore */ }
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return sendJson(res, 400, { message: '缺少 token' });
    const prevOverride = TOKEN_OVERRIDE;
    TOKEN_OVERRIDE = token;
    clearApiCaches();
    const upstream = await apiGet('/api/v2/current_user', {});
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 200 && payload) {
      let persisted = false;
      try {
        const cfgPath = path.join(ROOT, 'config.json');
        const cfg = loadConfig() || {};
        cfg.token = token;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        persisted = true;
      } catch (_) { /* 写入失败则保持内存态 */ }
      if (persisted) TOKEN_OVERRIDE = null; // 持久化成功后以 config.json 为准
      ME_CACHE.data = payload;
      ME_CACHE.at = Date.now();
      return sendJson(res, 200, payload);
    }
    TOKEN_OVERRIDE = prevOverride;
    return sendJson(res, upstream.status || 502, { message: (payload && payload.message) || '登录失败：token 无效或已过期' });
  }

  if (sub === 'posts') {
    const src = url.searchParams.get('source') || 'posts';
    const source = src === 'all' ? 'all' : (src === 'recommendations' ? 'recommendations' : 'posts');
    const query = {};
    for (const key of ['per_page', 'last_id', 'model_type']) {
      const v = url.searchParams.get(key);
      if (v) query[key] = v;
    }
    if (!query.per_page) query.per_page = '20';
    if (!query.model_type && source === 'recommendations') query.model_type = 'random';
    const endpoint = source === 'all' ? '/api/v2/posts/channels/all' : (source === 'recommendations' ? '/api/v2/posts/recommendations' : '/api/v2/posts');
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const cacheKey = endpoint + '?' + qsFor(query);
    if (!forceRefresh) {
      const hit = POST_CACHE.get(cacheKey);
      if (hit && Date.now() - hit.at < POST_CACHE_TTL) {
        return sendJson(res, 200, JSON.parse(hit.body));
      }
    }
    const upstream = await apiGet(endpoint, query);
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 200) {
      if (Array.isArray(payload)) {
        POST_CACHE.set(cacheKey, { at: Date.now(), body: upstream.body.toString('utf8') });
      }
      return sendJson(res, 200, Array.isArray(payload) ? payload : { message: '响应格式异常' });
    }
    return sendJson(res, upstream.status || 502, { message: (payload && payload.message) || '获取广场数据失败' });
  }

  return false;
}

function serveStatic(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (res.writableEnded) return;
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(ROOT, 'server-error.log'), new Date().toISOString() + ' ' + (err && err.stack || err) + '\n'); } catch (_) {}
});
process.on('unhandledRejection', (err) => {
  try { fs.appendFileSync(path.join(ROOT, 'server-error.log'), new Date().toISOString() + ' [rejection] ' + (err && err.stack || err) + '\n'); } catch (_) {}
});

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/media') {
      const target = url.searchParams.get('url') || '';
      let host = '';
      try { host = new URL(target).host; } catch (_) { host = ''; }
      if (!target.startsWith('https://') || host !== MEDIA_HOST) {
        sendJson(res, 400, { message: '????????' });
        return;
      }
      await streamMedia(res, target, req);
      return;
    }
    const handled = await handleApi(url, req, res);
    if (handled) return;

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    serveStatic(filePath, res);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 502, { message: String(err.message || err) });
    } else {
      res.end();
    }
  } finally {
    if (req.url.startsWith('/api/')) {
      console.log(`[api] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - t0}ms)`);
    }
  }
});

function listenOn(port, tries) {
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && tries > 0) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1} …`);
      listenOn(port + 1, tries - 1);
      return;
    }
    console.error('启动失败:', (err && err.message) || err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`Simple 仿真Excel 已启动: http://localhost:${port}`);
    console.log(`token 状态: ${getToken() ? '已配置' : '未配置（可在网页右上角点「登录」粘贴 token）'}`);
    if (process.pkg && process.platform === 'win32' && process.env.SIMPLE_NO_OPEN !== '1') {
      try { require('child_process').execSync(`start "" "http://localhost:${port}"`, { stdio: 'ignore' }); } catch (_) { /* 忽略 */ }
    }
  });
}
listenOn(PORT, 10);