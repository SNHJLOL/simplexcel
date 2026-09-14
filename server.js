'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { spawn, spawnSync, exec } = require('child_process');

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

// 监听地址：默认仅本机（127.0.0.1），避免同局域网他人直接使用你配置的 token 读写数据。
// 需要局域网访问时设置 SIMPLE_HOST=0.0.0.0（或 config.json 的 host 字段）。
function resolveHost() {
  let host = process.env.SIMPLE_HOST;
  if (!host || !String(host).trim()) {
    const cfg = loadConfig() || {};
    host = cfg.host;
  }
  host = String(host || '').trim();
  return host || '127.0.0.1';
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// GET / POST / DELETE 统一走这里：query 拼在 URL 上，bodyObj 作为 JSON 请求体
function apiRequest(method, pathname, query, bodyObj) {
  return new Promise((resolve, reject) => {
    const qs = query ? new URLSearchParams(query).toString() : '';
    const url = API_BASE + pathname + (qs ? '?' + qs : '');
    const payload = bodyObj == null ? null : JSON.stringify(bodyObj);
    const headers = {
      'Authorization': getToken(),
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(url, { method, headers, timeout: REQUEST_TIMEOUT }, (res) => {
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
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function apiGet(pathname, query) {
  return apiRequest('GET', pathname, query, null);
}

function apiSend(method, pathname, bodyObj) {
  return apiRequest(method, pathname, null, bodyObj);
}

// per_page 由客户端传入，做一次上限收敛，避免被要求拉取超大分页
const MAX_PER_PAGE = 100;
// 用户主页接口对 per_page 卡得更死：实测 >30 直接 400 per_page does not have a valid value
const MAX_PER_PAGE_PROFILE = 30;
function normalizePerPage(query, def, max = MAX_PER_PAGE) {
  const n = Number(query.per_page);
  query.per_page = String(Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def);
  return query;
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

const ME_CACHE = { data: null, at: 0 };
const ME_CACHE_TTL = Number(process.env.ME_CACHE_TTL || 5 * 60 * 1000); // 毫秒

// 工作表 → 上游接口的映射（前端只传 source 名）
const SOURCE_ENDPOINTS = {
  posts: '/api/v2/posts',
  followings: '/api/v3/posts/followings',
  mine: '/api/v3/posts/mine',
  profile: '/api/v3/posts/profile',
  recommendations: '/api/v2/posts/recommendations',
  all: '/api/v2/posts/channels/all',
};

// 当前登录用户的 id（「我的」工作表需要）。优先用缓存，未命中才请求一次。
async function currentUserId() {
  if (ME_CACHE.data && ME_CACHE.data.id) return ME_CACHE.data.id;
  try {
    const upstream = await apiGet('/api/v2/current_user', {});
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 200 && payload && payload.id) {
      ME_CACHE.data = payload;
      ME_CACHE.at = Date.now();
      return payload.id;
    }
  } catch (_) { /* 拿不到就让上游自己判断（该接口不带 user_id 也能返回自己的帖子） */ }
  return '';
}


// 媒体代理白名单：默认放行 imsummer.cn 及其全部子域（CDN 域名变更时无需改代码）。
// 可用环境变量 SIMPLE_MEDIA_HOSTS，或 config.json 的 mediaHosts（数组 / 逗号分隔字符串）追加。
const DEFAULT_MEDIA_HOSTS = 'imsummer.cn';
let _mediaHosts = null;
function mediaHostSuffixes() {
  if (_mediaHosts) return _mediaHosts;
  let extra = process.env.SIMPLE_MEDIA_HOSTS;
  if (!extra) {
    const cfg = loadConfig() || {};
    if (Array.isArray(cfg.mediaHosts)) extra = cfg.mediaHosts.join(',');
    else if (typeof cfg.mediaHosts === 'string') extra = cfg.mediaHosts;
  }
  const list = String(extra || DEFAULT_MEDIA_HOSTS)
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
  _mediaHosts = list.length ? list : DEFAULT_MEDIA_HOSTS.split(',');
  return _mediaHosts;
}

function isAllowedMediaHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return mediaHostSuffixes().some((sfx) => h === sfx || h.endsWith('.' + sfx));
}

/* ---------------- HEVC（H.265）兜底：交给本机播放器 ---------------- */
// 上游的实况照片 / 视频几乎都是 H.265/HEVC 编码。Windows 上如果没装「HEVC 视频扩展」，
// 浏览器（Edge / Chrome）会跳过视频轨只播音频，屏幕停在我们设的首帧封面图上，
// 看上去就是「点开不动、但有声音」。这类文件交给本机播放器最省事：
// PotPlayer / VLC / mpv 都自带 HEVC 解码，而且能直接播放 URL（省掉先下载）。
const PLAYER_CANDIDATES = [
  { name: 'PotPlayer', paths: [
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayer.exe',
  ] },
  { name: 'VLC', paths: [
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
  ] },
  { name: 'mpv', paths: [
    'C:\\Program Files\\mpv\\mpv.exe',
    'C:\\Program Files (x86)\\mpv\\mpv.exe',
  ] },
];

let _player = undefined; // undefined=未探测，null=没找到
function findPlayer() {
  if (_player !== undefined) return _player;
  _player = null;
  if (process.platform !== 'win32') return _player;
  const override = (process.env.SIMPLE_PLAYER || '').trim();
  if (override && fs.existsSync(override)) { _player = { name: path.basename(override), path: override }; return _player; }
  for (const cand of PLAYER_CANDIDATES) {
    for (const p of cand.paths) {
      try { if (fs.existsSync(p)) { _player = { name: cand.name, path: p }; return _player; } } catch (_) { /* ignore */ }
    }
  }
  return _player;
}

// 没有外链播放器时退而求其次：把文件下载到临时目录，再交给系统默认程序打开
function downloadToTemp(targetUrl) {
  return new Promise((resolve, reject) => {
    const dir = path.join(os.tmpdir(), 'simplexcel-media');
    let file;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const m = /\.(mp4|m4v|mov|m4a|mp3|webm)(\?|$)/i.exec(targetUrl);
      const ext = m ? m[1].toLowerCase() : 'mp4';
      file = path.join(dir, crypto.createHash('md5').update(targetUrl).digest('hex') + '.' + ext);
      if (fs.existsSync(file) && fs.statSync(file).size > 0) return resolve(file);
    } catch (err) { return reject(err); }
    const tmp = file + '.part';
    const req = https.get(targetUrl, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      timeout: 120000,
    }, (up) => {
      if (up.statusCode >= 400) { up.resume(); return reject(new Error('上游返回 ' + up.statusCode)); }
      const ws = fs.createWriteStream(tmp);
      up.pipe(ws);
      ws.on('finish', () => { ws.close(() => { try { fs.renameSync(tmp, file); } catch (_) { /* 用回 .part */ } resolve(fs.existsSync(file) ? file : tmp); }); });
      ws.on('error', reject);
      up.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

// 只探头部，用来判断文件大小（CDN 支持 HEAD）
function headSize(targetUrl) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.request(targetUrl, { method: 'HEAD', headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 8000 }, (res) => {
        const n = Number(res.headers['content-length'] || 0);
        res.resume();
        resolve(Number.isFinite(n) && n > 0 ? n : 0);
      });
    } catch (_) { return resolve(0); }
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

// 超过这个大小就直接把 URL 喂给播放器，避免让人干等下载（实况/短视频一般 2~5MB）
const STREAM_IF_LARGER_THAN = 80 * 1024 * 1024;

function launch(player, arg) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(player.path, [arg], { detached: true, stdio: 'ignore' });
    } catch (err) { return reject(err); }
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// 用本机播放器打开一个受白名单约束的媒体地址。
// 小文件先落盘再打开最稳（播放器不用处理 http 流、重复打开还能命中缓存），大文件才直接喂 URL。
async function openInSystemPlayer(targetUrl) {
  let player = findPlayer();
  const size = await headSize(targetUrl);
  if (player && size > STREAM_IF_LARGER_THAN) {
    try {
      await launch(player, targetUrl);
      return { ok: true, mode: 'player-stream', player: player.name, size };
    } catch (_) { player = null; } // 播放器起不来就别卡在这，走下面的下载 + 系统默认程序
  }
  const file = await downloadToTemp(targetUrl);
  if (player) {
    try {
      await launch(player, file);
      return { ok: true, mode: 'player-file', player: player.name, path: file, size };
    } catch (_) { player = null; }
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
  }
  return { ok: true, mode: 'download', path: file, size };
}

/* ---------------- H.265(HEVC) → H.264 本机转码 ---------------- */
// 有些机器装不上「HEVC 视频扩展」（Store 打不开 / 显卡不支持硬解 / 公司策略禁用），
// 浏览器就永远只有声音没画面。这时改用本机 ffmpeg 把视频轨转成 H.264（浏览器通吃），
// 转好的文件按源地址缓存，第二次直接读本地文件，秒开。
// ffmpeg 也可以不用手动装：没有时从官方构建下载一份解到用户目录（不写系统目录、不需要管理员）。

// 用户级数据目录：Windows 放 %LOCALAPPDATA%，其它平台放 ~/.simplexcel
const DATA_DIR = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Simplexcel')
  : path.join(os.homedir(), '.simplexcel');
const FFMPEG_DIR = path.join(DATA_DIR, 'ffmpeg');
const FFMPEG_EXE = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const H264_CACHE_DIR = path.join(os.tmpdir(), 'simplexcel-media', 'h264');
const TRANSCODE_TIMEOUT = Number(process.env.SIMPLE_TRANSCODE_TIMEOUT || 10 * 60 * 1000);
const H264_CACHE_MAX_FILES = Number(process.env.SIMPLE_H264_CACHE_MAX || 200);

// PATH 里找可执行文件（不依赖 which，跨平台）
function whichSync(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) { /* ignore */ }
    }
  }
  return '';
}

let _ffmpeg = undefined; // undefined=未探测，null=没找到，{path}=可用
let _ffmpegProbeAt = 0;
function findFfmpeg() {
  if (_ffmpeg) return _ffmpeg;
  // 「没找到」只缓存 10 秒：用户手动装好 ffmpeg 后不用重启本工具就能被认出来
  if (_ffmpeg === null && Date.now() - _ffmpegProbeAt < 10000) return null;
  const cfg = loadConfig() || {};
  const candidates = [
    (process.env.SIMPLE_FFMPEG || '').trim(),
    typeof cfg.ffmpegPath === 'string' ? cfg.ffmpegPath.trim() : '',
    FFMPEG_EXE,
    path.join(ROOT, '.ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) { _ffmpeg = { path: c, source: 'local' }; return _ffmpeg; } } catch (_) { /* ignore */ }
  }
  const onPath = whichSync('ffmpeg');
  _ffmpeg = onPath ? { path: onPath, source: 'path' } : null;
  _ffmpegProbeAt = Date.now();
  return _ffmpeg;
}

let _ffmpegVersion = null;
function ffmpegVersion(exe) {
  if (_ffmpegVersion !== null) return _ffmpegVersion;
  try {
    const r = spawnSync(exe, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const line = String((r.stdout || '') + (r.stderr || '')).split('\n')[0] || '';
    _ffmpegVersion = line.replace(/^ffmpeg version\s*/i, '').slice(0, 60);
  } catch (_) { _ffmpegVersion = ''; }
  return _ffmpegVersion;
}

// 优先 libx264（静态构建自带）；个别构建没有时退到 Windows 硬件编码 / 老式 mpeg4
let _encoder = undefined;
function pickEncoder(exe) {
  if (_encoder !== undefined) return _encoder;
  let text = '';
  try {
    const r = spawnSync(exe, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    text = String((r.stdout || '') + (r.stderr || ''));
  } catch (_) { text = ''; }
  _encoder = '';
  for (const enc of ['libx264', 'h264_mf', 'mpeg4']) {
    if (new RegExp('\\b' + enc + '\\b').test(text)) { _encoder = enc; break; }
  }
  if (!_encoder) _encoder = 'libx264'; // 探测失败也按最常见的一种试，真跑不通会把 ffmpeg 的报错原样带回去
  return _encoder;
}

function usableFile(f) {
  try { return fs.existsSync(f) && fs.statSync(f).size > 1024; } catch (_) { return false; }
}

function h264PathFor(targetUrl) {
  return path.join(H264_CACHE_DIR, crypto.createHash('md5').update(targetUrl).digest('hex') + '.mp4');
}

// 缓存目录别无限长大：超过上限就按修改时间删掉最旧的一批
function pruneH264Cache() {
  try {
    const files = fs.readdirSync(H264_CACHE_DIR)
      .filter((n) => n.endsWith('.mp4'))
      .map((n) => { const p = path.join(H264_CACHE_DIR, n); return { p, at: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => a.at - b.at);
    for (let i = 0; i < files.length - H264_CACHE_MAX_FILES; i++) {
      try { fs.unlinkSync(files[i].p); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

function runFfmpeg(exe, targetUrl, out) {
  return new Promise((resolve, reject) => {
    let tmp;
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      tmp = out + '.part';
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (err) { return reject(err); }

    const enc = pickEncoder(exe);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', targetUrl,
      '-map', '0:v:0', '-map', '0:a?', '-c:v', enc];
    if (enc === 'libx264') args.push('-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    else if (enc === 'h264_mf') args.push('-b:v', '3M');
    else args.push('-q:v', '5');
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp);

    let child;
    try { child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
    catch (err) { return reject(err); }

    let errText = '';
    const timer = setTimeout(() => {
      errText = errText || '转码超时（文件可能过长）';
      try { child.kill(); } catch (_) { /* ignore */ }
    }, TRANSCODE_TIMEOUT);
    child.stderr.on('data', (c) => { if (errText.length < 4000) errText += c.toString(); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        return reject(new Error(errText.trim() || ('ffmpeg 退出码 ' + code)));
      }
      try { fs.renameSync(tmp, out); } catch (_) { /* 改名失败就退回 .part */ }
      if (!usableFile(out)) return reject(new Error('转码结果为空'));
      pruneH264Cache();
      resolve(out);
    });
  });
}

const h264Inflight = new Map(); // 输出文件 -> Promise，避免同一条视频被并发转多次

function ensureH264(targetUrl) {
  const out = h264PathFor(targetUrl);
  if (usableFile(out)) return Promise.resolve({ file: out, cached: true });
  if (h264Inflight.has(out)) return h264Inflight.get(out);
  const ff = findFfmpeg();
  if (!ff) {
    const err = new Error('本机还没有 ffmpeg');
    err.code = 'NO_FFMPEG';
    return Promise.reject(err);
  }
  const p = runFfmpeg(ff.path, targetUrl, out)
    .then((file) => ({ file, cached: false }))
    .finally(() => h264Inflight.delete(out));
  h264Inflight.set(out, p);
  return p;
}

/* -------- ffmpeg 一键安装：下载官方构建解到用户目录 -------- */
// 按实测下载速度排序（国内外差异极大，逐个试）：
//   1) npm 镜像 / npm 官方：@ffmpeg-installer 的平台包里就是一份静态链接的 ffmpeg.exe，
//      压缩包只有 ~21MB，国内镜像能跑到十几 MB/s，几秒下完；
//   2) gyan.dev 官方构建（~90MB，国内实测常只有几十 KB/s，留作保底）；
//   3) GitHub BtbN 构建（shared 版，会连同一堆 dll 一起拷）。
function ffmpegSources() {
  if (process.platform !== 'win32') return []; // 其它平台让用户用包管理器装，别自作主张下二进制
  const arch = process.arch === 'ia32' ? 'win32-ia32' : 'win32-x64';
  const v = '4.1.0'; // 固定版本：可复现，也省掉解析 registry 元数据这个额外失败点
  return [
    `https://registry.npmmirror.com/@ffmpeg-installer/${arch}/-/${arch}-${v}.tgz`,
    `https://registry.npmjs.org/@ffmpeg-installer/${arch}/-/${arch}-${v}.tgz`,
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
  ];
}
const ffInstall = { active: false, phase: 'idle', downloaded: 0, total: 0, error: '', source: '' };

function downloadFile(url, dest, onProgress, depth) {
  return new Promise((resolve, reject) => {
    if ((depth || 0) > 5) return reject(new Error('重定向次数过多'));
    let req;
    try {
      req = https.get(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, url).href; } catch (_) { return reject(new Error('重定向地址不合法')); }
          return downloadFile(next, dest, onProgress, (depth || 0) + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败 HTTP ' + res.statusCode)); }
        const total = Number(res.headers['content-length'] || 0);
        if (total) onProgress(0, total);
        let got = 0;
        const ws = fs.createWriteStream(dest);
        res.on('data', (c) => { got += c.length; onProgress(got, total); });
        res.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => ws.close(() => resolve(dest)));
        res.pipe(ws);
      });
    } catch (err) { return reject(err); }
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

function runCmd(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (err) { return reject(err); }
    let errText = '';
    child.stderr.on('data', (c) => { if (errText.length < 2000) errText += c.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, timeout || 120000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(errText.trim() || (cmd + ' 退出码 ' + code)));
    });
  });
}

// Windows 10+ 自带 bsdtar，可直接解 zip，不必引入压缩库；不行再退到 PowerShell
function extractZip(zipFile, outDir) {
  const sysTar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  if (process.platform !== 'win32' || fs.existsSync(sysTar)) {
    return runCmd(sysTar, ['-xf', zipFile, '-C', outDir], 180000).catch((err) => {
      if (process.platform === 'win32') return extractZipPowerShell(zipFile, outDir);
      throw err;
    });
  }
  return extractZipPowerShell(zipFile, outDir);
}

function extractZipPowerShell(zipFile, outDir) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return runCmd(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`], 300000);
}

function findFileRecursive(dir, names, depth) {
  if ((depth || 0) > 4) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    if (e.isFile() && names.includes(e.name.toLowerCase())) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFileRecursive(path.join(dir, e.name), names, (depth || 0) + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function installFfmpeg() {
  if (ffInstall.active) return;
  ffInstall.active = true;
  ffInstall.phase = 'download';
  ffInstall.downloaded = 0;
  ffInstall.total = 0;
  ffInstall.error = '';
  const work = path.join(os.tmpdir(), 'simplexcel-ffmpeg-' + Date.now());
  try {
    const sources = ffmpegSources();
    if (!sources.length) {
      throw new Error(process.platform === 'darwin'
        ? 'macOS 请用 brew install ffmpeg 安装后重试'
        : 'Linux 请用包管理器安装 ffmpeg（如 apt install ffmpeg）后重试');
    }
    fs.mkdirSync(work, { recursive: true });
    let pkg = '';
    let lastErr = null;
    for (const src of sources) {
      ffInstall.source = src;
      try {
        const dest = path.join(work, 'ffmpeg.pkg');
        await downloadFile(src, dest, (got, total) => { ffInstall.downloaded = got; ffInstall.total = total; });
        pkg = dest;
        break;
      } catch (err) { lastErr = err; }
    }
    if (!pkg) throw lastErr || new Error('下载失败');

    ffInstall.phase = 'extract';
    const outDir = path.join(work, 'x');
    fs.mkdirSync(outDir, { recursive: true });
    await extractZip(pkg, outDir);

    const found = findFileRecursive(outDir, process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']);
    if (!found) throw new Error('压缩包里没找到 ffmpeg 可执行文件');
    fs.mkdirSync(FFMPEG_DIR, { recursive: true });
    // shared 版的 ffmpeg.exe 旁边还有一堆 dll，整目录一起拷，免得拷过去跑不起来
    for (const name of fs.readdirSync(path.dirname(found))) {
      const from = path.join(path.dirname(found), name);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(FFMPEG_DIR, name));
    }
    try { fs.chmodSync(FFMPEG_EXE, 0o755); } catch (_) { /* Windows 上忽略 */ }

    _ffmpeg = undefined;  // 重新探测
    _encoder = undefined;
    _ffmpegVersion = null;
    const ff = findFfmpeg();
    if (!ff) throw new Error('安装完成但仍找不到 ffmpeg');
    ffInstall.phase = 'done';
    ffInstall.path = ff.path;
    console.log(`[ffmpeg] 已安装: ${ff.path} (${ffmpegVersion(ff.path)})`);
  } catch (err) {
    ffInstall.phase = 'error';
    ffInstall.error = String((err && err.message) || err);
    console.error('[ffmpeg] 安装失败:', ffInstall.error);
  } finally {
    ffInstall.active = false;
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// 本地文件直出（带 Range 支持，视频才能拖动进度条）
function serveLocalFile(req, res, filePath, contentType, extraHeaders) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return false; }
  const total = stat.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m && total > 0) {
    let start;
    let end;
    if (!m[1] && m[2]) {           // bytes=-N：最后 N 字节
      start = Math.max(0, total - parseInt(m[2], 10));
      end = total - 1;
    } else {
      start = m[1] ? parseInt(m[1], 10) : 0;
      end = m[2] ? parseInt(m[2], 10) : total - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return true;
    }
    end = Math.min(end, total - 1);
    res.writeHead(206, Object.assign({
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    }, extraHeaders || {}));
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, Object.assign({
    'Content-Type': contentType,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  }, extraHeaders || {}));
  fs.createReadStream(filePath).pipe(res);
  return true;
}

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
const NOTIFY_CACHE = new Map(); // key -> { at, body }
const NOTIFY_CACHE_TTL = Number(process.env.NOTIFY_CACHE_TTL || 15000); // 毫秒
const POST_CACHE_TTL = Number(process.env.POST_CACHE_TTL || 120000); // 毫秒
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 300); // 每个缓存 Map 的条目上限

// 写入缓存并做最简淘汰（超出上限丢弃最早插入的一条），避免长时间运行内存持续增长
function cacheSet(map, key, body) {
  if (map.size >= CACHE_MAX_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, { at: Date.now(), body });
}

function clearApiCaches() {
  POST_CACHE.clear();
  COMMENT_CACHE.clear();
  FAV_CACHE.clear();
  NOTIFY_CACHE.clear();
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

// 上游的报错有些是 i18n 缺翻译的英文占位（如 "Translation missing: zh-CN.errors.post.not_found"），
// 直接透传给用户看不懂，这里换成可读的中文说明。
function deleteFailMessage(status, payload) {
  const raw = (payload && payload.message) || '';
  if (raw && !/Translation missing/i.test(raw)) return raw;
  if (status === 404) return '帖子不存在或已被删除';
  if (status === 401 || status === 403) return '没有权限删除这条动态（token 可能已失效或不是本人发布）';
  if (status === 429) return '操作过于频繁，请稍后再试';
  return `删除失败（HTTP ${status || 502}）`;
}

async function handleApi(url, req, res) {
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','posts']
  if (parts.length < 2 || parts[0] !== 'api') return false;

  const sub = parts[1];

  // 用本机播放器打开媒体：上游实况/视频多为 H.265(HEVC)，浏览器缺解码器时只有声音没画面，
  // 这时交给自带 HEVC 解码器的本机播放器是最省事的办法。
  if (sub === 'open-media') {
    if (req.method !== 'POST') return sendJson(res, 405, { message: '方法不支持' });
    let body = null;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { /* ignore */ }
    const target = body && typeof body.url === 'string' ? body.url.trim() : '';
    let parsed = null;
    try { parsed = new URL(target); } catch (_) { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || !isAllowedMediaHost(parsed.hostname)) {
      return sendJson(res, 400, { message: '媒体地址不合法：仅允许打开白名单内的 https 资源' });
    }
    if (process.env.SIMPLE_NO_OPEN === '1') {
      return sendJson(res, 200, { ok: true, mode: 'player', player: '（SIMPLE_NO_OPEN=1，未真正打开）', simulated: true });
    }
    try {
      const result = await openInSystemPlayer(parsed.href);
      const player = findPlayer();
      console.log(`[open-media] ${result.mode} ${player ? player.name : '系统默认程序'} ${parsed.href}`);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 502, { message: '打开失败：' + (err && err.message || err) });
    }
  }

  // 本机转码（HEVC → H.264）：状态查询 + 一键安装 ffmpeg + 取转码后的视频
  if (sub === 'ffmpeg') {
    const action = parts[2] || '';
    if (action === 'status') {
      if (req.method !== 'GET') return sendJson(res, 405, { message: '方法不支持' });
      const ff = findFfmpeg();
      return sendJson(res, 200, {
        available: !!ff,
        path: ff ? ff.path : '',
        version: ff ? ffmpegVersion(ff.path) : '',
        dir: FFMPEG_DIR,
        installing: ffInstall.active,
        phase: ffInstall.phase,
        downloaded: ffInstall.downloaded,
        total: ffInstall.total,
        error: ffInstall.error,
        source: ffInstall.source,
      });
    }
    if (action === 'install') {
      if (req.method !== 'POST') return sendJson(res, 405, { message: '方法不支持' });
      if (ffInstall.active) {
        return sendJson(res, 202, { ok: true, installing: true, phase: ffInstall.phase, downloaded: ffInstall.downloaded, total: ffInstall.total });
      }
      if (findFfmpeg()) return sendJson(res, 200, { ok: true, available: true, already: true });
      if (process.env.SIMPLE_NO_FFMPEG_INSTALL === '1') {
        return sendJson(res, 200, { ok: true, available: false, simulated: true });
      }
      installFfmpeg(); // 下载在后台跑，前端轮询 status 看进度
      return sendJson(res, 202, { ok: true, installing: true, phase: 'download' });
    }
    return sendJson(res, 404, { message: '未知的 ffmpeg 操作' });
  }

  // 取「转码后的 H.264 版本」。check=1 时只回报进度并后台预热，正式请求才吐文件。
  if (sub === 'transcoded') {
    if (req.method !== 'GET') return sendJson(res, 405, { message: '方法不支持' });
    const target = url.searchParams.get('url') || '';
    let parsed = null;
    try { parsed = new URL(target); } catch (_) { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || !isAllowedMediaHost(parsed.hostname)) {
      return sendJson(res, 400, { message: '媒体地址不合法：仅允许转码白名单内的 https 资源' });
    }
    if (url.searchParams.get('check') === '1') {
      const out = h264PathFor(parsed.href);
      const cached = usableFile(out);
      if (!cached && !h264Inflight.has(out)) {
        // 后台预热（缺 ffmpeg 时会被 NO_FFMPEG 拒绝，静默吞掉）
        ensureH264(parsed.href).catch(() => { /* 后续轮询会再次尝试 */ });
      } else if (h264Inflight.has(out)) {
        // 进行中：从 inflight promise 拿粗略的进度（不阻塞响应）
      }
      return sendJson(res, 200, {
        ready: cached,
        ffmpeg: !!findFfmpeg(),
        installing: ffInstall.active,
        phase: ffInstall.phase,
        downloaded: ffInstall.downloaded,
        total: ffInstall.total,
        error: ffInstall.error,
      });
    }
    try {
      const result = await ensureH264(parsed.href);
      const headers = result.cached
        ? { 'X-Transcode-Cache': 'hit' }
        : { 'X-Transcode-Cache': 'miss' };
      const sent = serveLocalFile(req, res, result.file, 'video/mp4', headers);
      if (!sent && !res.headersSent) sendJson(res, 502, { message: '转码结果不可用' });
    } catch (err) {
      const code = err && err.code;
      if (code === 'NO_FFMPEG') {
        return sendJson(res, 412, { message: '本机还没有 ffmpeg，无法转码（前端会自动下载安装，或自行安装后重试）' });
      }
      return sendJson(res, 502, { message: '转码失败：' + ((err && err.message) || err) });
    }
    return;
  }

  if (sub === 'votes' || sub === 'favourites') {
    if (sub === 'favourites' && req.method === 'GET') {
      const query = {};
      for (const key of ['last_id', 'per_page']) {
        const v = url.searchParams.get(key);
        if (v) query[key] = v;
      }
      normalizePerPage(query, '20');
      const cacheKey = '/api/v2/favourites?' + qsFor(query);
      const hit = FAV_CACHE.get(cacheKey);
      if (hit && Date.now() - hit.at < FAV_CACHE_TTL) {
        return sendJson(res, 200, JSON.parse(hit.body));
      }
      const upstream = await apiGet('/api/v2/favourites', query);
      let payload;
      try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
      if (upstream.status === 200 && Array.isArray(payload)) {
        cacheSet(FAV_CACHE, cacheKey, upstream.body.toString('utf8'));
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
      normalizePerPage(query, '10');
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const cacheKey = '/api/v2/comments?' + qsFor(query);
      if (!forceRefresh) {
        const hit = COMMENT_CACHE.get(cacheKey);
        if (hit && Date.now() - hit.at < COMMENT_CACHE_TTL) {
          return sendJson(res, 200, JSON.parse(hit.body));
        }
      }
      const upstream = await apiGet('/api/v2/comments', query);
      let payload;
      try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
      if (upstream.status === 200 && Array.isArray(payload)) {
        cacheSet(COMMENT_CACHE, cacheKey, upstream.body.toString('utf8'));
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


  // 评论点赞：POST / DELETE /api/comment_votes（body: { comment_id }）
  if (sub === 'comment_votes') {
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      return sendJson(res, 405, { message: '方法不支持' });
    }
    let body = null;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { /* ignore */ }
    const commentId = body && typeof body.comment_id === 'string' ? body.comment_id.trim() : '';
    if (!commentId) return sendJson(res, 400, { message: '缺少 comment_id' });
    const upstream = await apiSend(req.method, '/api/v3/comment_votes', { comment_id: commentId });
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 200 || upstream.status === 201 || upstream.status === 204) {
      COMMENT_CACHE.clear(); // 评论点赞状态已变化，丢弃旧缓存
    }
    return sendJson(res, upstream.status || 502, payload || { message: '请求失败' });
  }

  if (sub === 'notifications') {
    if (req.method !== 'GET') return sendJson(res, 405, { message: '方法不支持' });
    const query = {};
    for (const key of ['last_id', 'per_page']) {
      const v = url.searchParams.get(key);
      if (v) query[key] = v;
    }
    normalizePerPage(query, '10');
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const cacheKey = '/api/v3/notifications?' + qsFor(query);
    if (!forceRefresh) {
      const hit = NOTIFY_CACHE.get(cacheKey);
      if (hit && Date.now() - hit.at < NOTIFY_CACHE_TTL) {
        return sendJson(res, 200, JSON.parse(hit.body));
      }
    }
    const upstream = await apiGet('/api/v3/notifications', query);
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 200 && Array.isArray(payload)) {
      cacheSet(NOTIFY_CACHE, cacheKey, upstream.body.toString('utf8'));
    }
    return sendJson(res, upstream.status || 502, Array.isArray(payload) ? payload : { message: (payload && payload.message) || '获取通知失败' });
  }

  if (sub === 'status') {
    const player = process.env.SIMPLE_NO_OPEN === '1' ? null : findPlayer();
    return sendJson(res, 200, {
      hasToken: getToken().length > 0,
      ok: true,
      player: player ? player.name : null,
      ffmpeg: !!findFfmpeg(), // 能否本机把 HEVC 转成 H.264（前端据此选兜底方案）
    });
  }

  if (sub === 'me') {
    const now = Date.now();
    const forceRefresh = url.searchParams.get('refresh') === '1';
    if (!forceRefresh && ME_CACHE.data && now - ME_CACHE.at < ME_CACHE_TTL) {
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

  // 列表：GET /api/posts（单帖详情 /api/posts/:id 由下面的分支处理）
  if (sub === 'posts' && parts.length === 2) {
    const src = url.searchParams.get('source') || 'posts';
    const source = SOURCE_ENDPOINTS[src] ? src : 'posts';
    const query = {};
    for (const key of ['per_page', 'last_id', 'model_type', 'user_id']) {
      const v = url.searchParams.get(key);
      if (v) query[key] = v;
    }
    normalizePerPage(query, '20');
    if (!query.model_type && source === 'recommendations') query.model_type = 'random';
    if (source === 'followings') query.user_scope = 'normal';
    // 「我的」：user_id 由服务端自动补上（客户端不用知道自己的 id）
    if (source === 'mine' && !query.user_id) {
      const uid = await currentUserId();
      if (uid) query.user_id = uid;
    }
    // 用户主页：必须指定 user_id；同样用 last_id 游标翻页，但上游对 per_page 的上限只有 30
    if (source === 'profile') {
      if (!query.user_id) return sendJson(res, 400, { message: '缺少 user_id：查看用户主页需要指定用户' });
      normalizePerPage(query, '20', MAX_PER_PAGE_PROFILE);
    }
    const endpoint = SOURCE_ENDPOINTS[source];
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
        cacheSet(POST_CACHE, cacheKey, upstream.body.toString('utf8'));
      }
      return sendJson(res, 200, Array.isArray(payload) ? payload : { message: '响应格式异常' });
    }
    return sendJson(res, upstream.status || 502, { message: (payload && payload.message) || '获取数据失败' });
  }

  // 删除单帖：DELETE /api/posts/:id → 上游 DELETE /api/v3/posts/:id
  // 「我的」工作表的批量删除逐条走这里；上游对删除有频率限制（连发会返回「操作过快」），
  // 由前端控制节奏并在失败时重试，服务端只负责转发 + 成功后丢弃列表缓存。
  if (sub === 'posts' && parts.length >= 3 && req.method === 'DELETE') {
    const postId = parts[2];
    if (!postId) return sendJson(res, 400, { message: '缺少要删除的帖子 id' });
    const upstream = await apiSend('DELETE', '/api/v3/posts/' + encodeURIComponent(postId), null);
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status >= 200 && upstream.status < 300) {
      POST_CACHE.clear(); // 帖子已删除，丢弃列表缓存，避免刷新后还看得到它
      // 上游成功时可能返回 204（无响应体），统一成 200 + JSON，前端处理更省事
      return sendJson(res, 200, payload == null ? { ok: true } : payload);
    }
    return sendJson(res, upstream.status || 502, {
      code: (payload && payload.code) || upstream.status,
      message: deleteFailMessage(upstream.status, payload),
    });
  }

  // 单帖详情：GET /api/posts/:id
  if (sub === 'posts' && parts.length >= 3 && req.method === 'GET') {
    const postId = parts[2];
    const cacheKey = '/api/v3/posts/' + postId;
    const hit = POST_CACHE.get(cacheKey);
    if (hit && Date.now() - hit.at < POST_CACHE_TTL) {
      return sendJson(res, 200, JSON.parse(hit.body));
    }
    const upstream = await apiGet('/api/v3/posts/' + postId, {});
    let payload;
    try { payload = JSON.parse(upstream.body.toString('utf8')); } catch (_) { payload = null; }
    if (upstream.status === 200 && payload && payload.id) {
      POST_CACHE.set(cacheKey, { at: Date.now(), body: upstream.body.toString('utf8') });
      return sendJson(res, 200, payload);
    }
    return sendJson(res, upstream.status || 502, { message: (payload && payload.message) || '获取帖子失败' });
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
      let parsed = null;
      try { parsed = new URL(target); } catch (_) { parsed = null; }
      if (!parsed || parsed.protocol !== 'https:' || !isAllowedMediaHost(parsed.hostname)) {
        sendJson(res, 400, { message: '媒体地址不合法：仅允许代理白名单内的 https 资源' });
        return;
      }
      await streamMedia(res, parsed.href, req);
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

function listenOn(port, tries, host) {
  const onError = (err) => {
    const inUse = err && (err.code === 'EADDRINUSE' || err.code === 'UNKNOWN') && tries > 0;
    if (inUse) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1} …`);
      server.removeListener('error', onError);
      listenOn(port + 1, tries - 1, host);
      return;
    }
    console.error('启动失败:', (err && err.message) || err);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, host, () => {
    server.removeListener('error', onError); // 监听成功后摘除，避免运行期报错触发重复 listen
    console.log(`Simple 仿真Excel 已启动: http://localhost:${port}`);
    if (!isLoopbackHost(host)) {
      console.log(`⚠ 当前监听地址为 ${host}，同一网络内的其他设备也能访问本工具（会使用你配置的 token）。`);
      console.log('  若只想本机使用，请去掉 SIMPLE_HOST，或设为 127.0.0.1。');
    }
    console.log(`token 状态: ${getToken() ? '已配置' : '未配置（可在网页右上角点「登录」粘贴 token）'}`);
    if (process.pkg && process.platform === 'win32' && process.env.SIMPLE_NO_OPEN !== '1') {
      try { exec(`start "" "http://localhost:${port}"`, { stdio: 'ignore' }); } catch (_) { /* 忽略 */ }
    }
  });
}
listenOn(PORT, 10, resolveHost());
