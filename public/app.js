'use strict';

/* ---------------- 列定义 ---------------- */
const COLUMNS = [
  { key: 'user.nickname',   label: '昵称',     width: 120 },
  { key: 'avatar',          label: '头像',     width: 64, avatar: true, align: 'center' },
  { key: 'created_at',      label: '发布时间', width: 168 },
  { key: 'user.gender',     label: '性别',     width: 64  },
  { key: 'content',         label: '内容',     width: 380 },
  { key: 'media',           label: '媒体',     width: 210, media: true },
  { key: 'tags',            label: '标签',     width: 140 },
  { key: 'comments_count',  label: '评论数',   width: 72, numeric: true, align: 'right' },
  { key: 'likes',           label: '点赞',     width: 76, likes: true, align: 'center' },
  { key: 'favourites',      label: '收藏',     width: 76, favourites: true, align: 'center' },
];

const ALIGN_LABEL = { left: '左对齐', center: '居中', right: '右对齐' };

// 批量删除列：不参与「显示列」体系（不加进 COLUMNS），只在删除模式下作为额外一列渲染，
// 这样排序 / 对齐 / 键盘导航 / 导出 CSV 都不受影响。
const DELETE_COL_KEY = '__delete__';
const DELETE_COL_WIDTH = 58;
// 上游删帖有频率限制（短时间内连发会返回「操作过快」），逐条之间留一点间隔、失败再补一次
const DELETE_GAP_MS = 400;
const DELETE_RETRY_GAP_MS = 1500;

const GENDER_MAP = { male: '男', female: '女' };

const COL_MIN_W = 40;
const COL_MAX_W = 800;
const resize = { active: false, col: null, th: null, startX: 0, startW: 0 };

/* ---------------- 工作表（状态栏页签） ---------------- */
// 三张固定工作表。点表格里的头像会往 state.sheets 里追加一张「用户主页」工作表（可关闭）。
const BUILTIN_SHEETS = [
  { key: 'posts', source: 'posts', label: '广场', title: '切换到「广场」（不自动刷新，需要更新内容请点工具栏「刷新」）' },
  { key: 'followings', source: 'followings', label: '关注', title: '切换到「关注」（不自动刷新，需要更新内容请点工具栏「刷新」）' },
  { key: 'mine', source: 'mine', label: '我的', title: '切换到「我的」（不自动刷新，需要更新内容请点工具栏「刷新」）' },
];
const USER_SHEET_PREFIX = 'user:';
// 用户主页工作表：上游 /api/v3/posts/profile，用 last_id 游标翻页（per_page 上限 30，由服务端收敛）
const USER_SHEET_FLAGS = { source: 'profile', closable: true };

/* ---------------- 状态 ---------------- */
const state = {
  source: 'posts',
  sheets: BUILTIN_SHEETS.map((s) => Object.assign({ view: null }, s)),
  activeSheetKey: 'posts',
  posts: [],
  perPage: 20,
  lastId: '',
  hasMore: true,
  loading: false,
  error: '',
  sortKey: '',
  sortDir: 1,
  search: '',
  visible: new Set(COLUMNS.map((c) => c.key)),
  lastUpdate: null,
  user: null,
  favIds: new Set(),
  favLoaded: false, // 收藏 id 集合是否已成功拉取过（配合 TTL 缓存）
  colWidths: {},
  align: {}, // 列对齐：colKey -> 'left' | 'center' | 'right'（未设置则用列自身的默认对齐）
  pageZoom: 1,
  wrapContent: true,
  selectedIdx: -1,
  selectedId: null, // 选中帖子的 id：排序 / 搜索后用它重新定位，避免选区“串行”
  selectedPost: null,
  selectedColKey: null,
  deleteMode: false,   // 批量删除模式（只在「我的」工作表可用）
  deleteIds: new Set(), // 已勾选要删除的帖子 id
  deleting: false,     // 正在执行删除请求
};

/* ---------------- 评论状态 ---------------- */
const comments = {
  post: null,
  list: [],
  lastId: '',
  hasMore: true,
  loading: false,
  sending: false,
  replyTo: null,
};

/* ---------------- 点赞和回复通知 ---------------- */
const notify = {
  list: [],
  lastId: '',
  hasMore: true,
  loading: false,
};

/* ---------------- 图片缩放状态 ---------------- */
const zoom = { scale: 1, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0, origTx: 0, origTy: 0 };
let zoomImg = null;
const mediaViewer = { items: [], index: -1 };

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const sheetHead = $('sheetHead');
const sheetBody = $('sheetBody');
const sentinel = $('sentinel');
const loadMoreBtn = $('loadMoreBtn');
const statusMode = $('statusMode');
const statusCount = $('statusCount');
const statusTime = $('statusTime');
const errorBar = $('errorBar');
const searchInput = $('searchInput');
const refreshBtn = $('refreshBtn');
const exportBtn = $('exportBtn');
const colBtn = $('colBtn');
const colPanel = $('colPanel');
const modal = $('detailModal');
const modalBack = $('modalBack');
const modalTitle = $('modalTitle');
const postPreview = $('postPreview');

const commentsPanel = $('commentsPanel');
const commentsList = $('commentsList');
const commentsCount = $('commentsCount');
const commentsMore = $('commentsMore');
const commentsInput = $('commentsInput');
const commentsSend = $('commentsSend');
const notifyModal = $('notifyModal');
const notifyBtn = $('notifyBtn');
const notifyList = $('notifyList');
const notifyCount = $('notifyCount');
const notifyMore = $('notifyMore');
const notifyRefresh = $('notifyRefresh');
const toastEl = $('toast');
const imageModal = $('imageModal');
const imageModalMedia = $('imageModalMedia');
const imageModalLink = $('imageModalLink');
const zoomLabel = $('zoomLabel');
const mediaPos = $('mediaPos');
const zoomInBtn = $('zoomInBtn');
const zoomOutBtn = $('zoomOutBtn');
const zoomResetBtn = $('zoomResetBtn');
const mediaPrev = $('mediaPrev');
const mediaNext = $('mediaNext');
const sheet = $('sheet');
const nameBox = $('nameBox');
const formulaInput = $('formulaInput');
const zoomOutPage = $('zoomOutPage');
const zoomInPage = $('zoomInPage');
const zoomPct = $('zoomPct');
const wrapBtn = $('wrapBtn');
const deleteBtn = $('deleteBtn');
const deleteConfirmBtn = $('deleteConfirmBtn');
const deleteCancelBtn = $('deleteCancelBtn');
const confirmModal = $('confirmModal');
const alignLeftBtn = $('alignLeftBtn');
const alignCenterBtn = $('alignCenterBtn');
const alignRightBtn = $('alignRightBtn');
const ALIGN_BTNS = { left: alignLeftBtn, center: alignCenterBtn, right: alignRightBtn };
const copyRowBtn = $('copyRowBtn');
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const loginModal = $('loginModal');
const aboutModal = $('aboutModal');
const loginCurrent = $('loginCurrent');
const loginTokenInput = $('loginTokenInput');
const loginSubmit = $('loginSubmit');
const loginCancel = $('loginCancel');
const loginModalClose = $('loginModalClose');
const pasteDemoBtn = $('pasteDemoBtn');
const brushDemoBtn = $('brushDemoBtn');
const sheetTabsEl = $('sheetTabs');
const fileMenuBtn = $('fileMenuBtn');
const fileDropdown = $('fileDropdown');
const menuBar = $('menuBar');
const themeToggleBtn = $('themeToggleBtn');

/* ---------------- 外观：白天/黑夜 + 配色 ---------------- */
const THEME_KEY = 'simple_theme';
const ACCENT_KEY = 'simple_accent';

/* 配色清单：key 必须与 style.css 里的 [data-accent="key"] 对应。
   green 是默认值（即 :root 的原始色板），因此不需要写 data-accent 属性。 */
const ACCENTS = [
  { key: 'green', label: '森林绿' },
  { key: 'blue', label: '靛蓝' },
  { key: 'teal', label: '青蓝' },
  { key: 'violet', label: '紫罗兰' },
  { key: 'amber', label: '琥珀' },
  { key: 'rose', label: '玫瑰' },
  { key: 'slate', label: '石墨' },
];
const ACCENT_DEFAULT = 'green';

let currentTheme = 'light';
let currentAccent = ACCENT_DEFAULT;

const themeMenu = $('themeMenu');
const themePanel = $('themePanel');
const themeSeg = $('themeSeg');
const themeSwatches = $('themeSwatches');

function accentLabel(key) {
  const hit = ACCENTS.find((a) => a.key === key);
  return hit ? hit.label : ACCENTS[0].label;
}

/* theme / accent 传 null 表示保持当前值不变 */
function applyTheme(theme, accent) {
  if (theme) currentTheme = theme === 'dark' ? 'dark' : 'light';
  if (accent) currentAccent = ACCENTS.some((a) => a.key === accent) ? accent : ACCENT_DEFAULT;

  const root = document.documentElement;
  if (currentTheme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');

  if (currentAccent === ACCENT_DEFAULT) root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', currentAccent);

  syncThemeUI();
}

function syncThemeUI() {
  const dark = currentTheme === 'dark';
  themeToggleBtn.textContent = dark ? '☀️ ▾' : '🌙 ▾';
  themeToggleBtn.title = '当前：' + (dark ? '黑夜' : '白天') + '模式 · ' + accentLabel(currentAccent) + '（点击选择配色）';
  if (themeSeg) {
    themeSeg.querySelectorAll('button[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === currentTheme);
    });
  }
  if (themeSwatches) {
    themeSwatches.querySelectorAll('.theme-swatch').forEach((b) => {
      b.classList.toggle('active', b.dataset.key === currentAccent);
    });
  }
}

function saveThemePrefs() {
  try {
    localStorage.setItem(THEME_KEY, currentTheme);
    localStorage.setItem(ACCENT_KEY, currentAccent);
  } catch (_) {}
}

function buildThemeSwatches() {
  if (!themeSwatches) return;
  themeSwatches.innerHTML = ACCENTS.map((a) =>
    '<button type="button" class="theme-swatch" data-key="' + a.key + '" title="' + a.label + '">' +
      '<span class="sw-dot"></span>' +
      '<span class="sw-name">' + a.label + '</span>' +
      '<span class="sw-check">✓</span>' +
    '</button>'
  ).join('');
}

(function initTheme() {
  let savedTheme = null;
  let savedAccent = null;
  try {
    savedTheme = localStorage.getItem(THEME_KEY);
    savedAccent = localStorage.getItem(ACCENT_KEY);
  } catch (_) {}
  buildThemeSwatches();
  applyTheme(savedTheme === 'dark' ? 'dark' : 'light', savedAccent || ACCENT_DEFAULT);
})();

/* ---------------- 视图偏好持久化（换行 / 页面缩放） ---------------- */
const VIEW_PREF_KEY = 'simple_sheet_view_prefs';

function saveViewPrefs() {
  try {
    localStorage.setItem(VIEW_PREF_KEY, JSON.stringify({ wrap: state.wrapContent, zoom: state.pageZoom, align: state.align }));
  } catch (_) {}
}

function loadViewPrefs() {
  try {
    const raw = localStorage.getItem(VIEW_PREF_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return;
    if (typeof o.wrap === 'boolean') state.wrapContent = o.wrap;
    if (typeof o.zoom === 'number' && o.zoom >= 0.7 && o.zoom <= 1.5) state.pageZoom = o.zoom;
    if (o.align && typeof o.align === 'object') {
      state.align = {};
      Object.keys(o.align).forEach((k) => {
        const v = o.align[k];
        // 只接受已知列 + 合法对齐值，避免旧数据或手改 localStorage 导致渲染异常
        if (COLUMNS.some((c) => c.key === k) && ALIGN_LABEL[v]) state.align[k] = v;
      });
    }
  } catch (_) {}
}

function applyWrap() {
  sheet.classList.toggle('wrap-off', !state.wrapContent);
  wrapBtn.classList.toggle('active', state.wrapContent);
  wrapBtn.title = state.wrapContent ? '内容列：自动换行（点击切换）' : '内容列：单行省略（点击切换）';
}

/* ---------------- 工具 ---------------- */
function getVal(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// 媒体统一走本地代理：去掉 Referer，避免 CDN 403
function mediaProxyUrl(rawUrl) {
  return '/media?url=' + encodeURIComponent(rawUrl);
}

// 给源站图片拼上缩放参数（CDN 七牛）；地址已带 query 时用 & 连接，避免出现两个 ?
function thumbUrl(rawUrl, w) {
  if (!rawUrl) return rawUrl;
  const sep = String(rawUrl).includes('?') ? '&' : '?';
  return rawUrl + sep + 'imageView2/2/w/' + w;
}

// 头像背景色：源站头像图本身是透明/无色剪影，需要 avatar_color 作为底色
function avatarBgStyle(user) {
  const c = user && user.avatar_color;
  return c ? `background-color:${escAttr('#' + c)};` : '';
}

// 单个媒体项的缩略图（表格与「原帖详情」共用，保证两边展示一致、不遗漏任何媒体类型）
function mediaItemHtml(m) {
  if (!m || !m.url) return '';
  if (m.type === 'image') {
    const thumb = mediaProxyUrl(thumbUrl(m.url, 300));
    return `<img class="thumb" loading="lazy" src="${escAttr(thumb)}" data-kind="image" data-url="${escAttr(m.url)}" alt="">`;
  }
  if (m.type === 'video' || m.type === 'live_photo') {
    const poster = mediaProxyUrl(thumbUrl(m.thumbnail_url || m.url, 300));
    return `<span class="thumb-wrap" data-kind="${m.type}" data-url="${escAttr(m.url)}" data-poster="${escAttr(m.thumbnail_url || '')}">`
      + `<img class="thumb" loading="lazy" src="${escAttr(poster)}" alt="">`
      + `<i class="play-badge">▶</i>`
      + `<b class="type-label">${m.type === 'live_photo' ? '实况' : '视频'}</b>`
      + `</span>`;
  }
  if (m.type === 'audio') {
    return `<span class="thumb-audio" data-kind="audio" data-url="${escAttr(m.url)}">♪ 音频</span>`;
  }
  const music = m.music || {};
  return `<span class="media-tag" title="${escAttr(m.url)}">${escAttr(music.music_title || m.type)}</span>`;
}

function renderCell(col, post) {
  if (col.likes || col.favourites) {
    const isLike = !!col.likes;
    const flag = isLike ? 'is_voted' : 'is_favourited';
    const on = !!post[flag];
    const name = isLike ? '点赞' : '收藏';
    const html = `<label class="action-toggle" title="${on ? '取消' + name : name}"><input type="checkbox" class="action-check" ${on ? 'checked' : ''}><span class="box"></span></label>`;
    return { text: on ? (isLike ? '已赞' : '已收藏') : (isLike ? '未赞' : '未收藏'), title: '', html };
  }
  if (col.avatar) {
    const u = post.user || {};
    const nick = u.nickname || u.id || '';
    const raw = u.avatar_url || '';
    const bg = avatarBgStyle(u);
    const resized = thumbUrl(raw, 80);
    // 头像可点：打开该用户的主页工作表
    const uid = escAttr(u.id || '');
    const tip = (nick || '?') + (u.id ? '（点击查看主页）' : '');
    const html = raw
      ? `<img class="avatar-img avatar-link" src="${escAttr(mediaProxyUrl(resized))}" alt="" title="${escAttr(tip)}" data-user-id="${uid}" style="${bg}">`
      : `<span class="avatar-img avatar-fallback avatar-link" title="${escAttr(tip)}" data-user-id="${uid}" style="${bg}">${escAttr(String((nick || '?').charAt(0)).toUpperCase())}</span>`;
    return { text: nick, title: nick, html };
  }
  const v = getVal(post, col.key);
  if (v == null) return { text: '', title: '', html: null };
  if (col.key === 'created_at') return { text: fmtTime(v), title: v, html: null };
  if (col.key === 'user.gender') return { text: GENDER_MAP[v] || v || '', title: v, html: null };

  if (col.media) {
    const items = Array.isArray(v) ? v : [];
    const urls = [];
    let html = '';
    items.forEach((m) => {
      if (!m || !m.url) return;
      urls.push(m.url);
      html += mediaItemHtml(m);
    });
    const text = urls.join('\n');
    return { text, title: text, html };
  }
  if (col.key === 'tags') {
    const fmtTag = (x) => {
      if (x == null) return '';
      if (typeof x === 'object') return x.name || x.label || x.title || x.id || JSON.stringify(x);
      return String(x);
    };
    const t = Array.isArray(v) ? v.map(fmtTag).filter(Boolean).join(', ') : fmtTag(v);
    return { text: t, title: t, html: null };
  }
  // 兜底：对象 / 数组类型尽量取出可读字段，避免渲染成 [object Object]
  if (typeof v === 'object') {
    const one = (x) => {
      if (x == null) return '';
      if (typeof x === 'object') return x.name || x.label || x.title || x.id || JSON.stringify(x);
      return String(x);
    };
    const t = Array.isArray(v) ? v.map(one).filter(Boolean).join(', ') : one(v);
    return { text: t, title: t, html: null };
  }
  const text = String(v);
  return { text, title: text.length > 40 ? text : '', html: null };
}

function letterOf(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), 1600);
}

/* ---------------- 媒体查看（图片可滚轮缩放 + 拖拽） ---------------- */
function applyZoom() {
  if (!zoomImg) return;
  zoomImg.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
  zoomLabel.textContent = '×' + zoom.scale.toFixed(1);
  imageModalMedia.classList.toggle('zoomed', zoom.scale > 1);
}

function resetZoom() {
  zoom.scale = 1;
  zoom.tx = 0;
  zoom.ty = 0;
  if (zoomImg) applyZoom();
}

function clampPan() {
  if (!zoomImg) return;
  const stage = imageModalMedia;
  const maxX = Math.max(0, (zoomImg.offsetWidth * zoom.scale - stage.clientWidth) / 2);
  const maxY = Math.max(0, (zoomImg.offsetHeight * zoom.scale - stage.clientHeight) / 2);
  zoom.tx = Math.max(-maxX, Math.min(maxX, zoom.tx));
  zoom.ty = Math.max(-maxY, Math.min(maxY, zoom.ty));
}

function setupImageZoom(img) {
  zoomImg = img;
  resetZoom();
  img.style.transformOrigin = 'center center';
}

function setZoomEnabled(enabled) {
  zoomOutBtn.disabled = !enabled;
  zoomInBtn.disabled = !enabled;
  zoomResetBtn.disabled = !enabled;
  zoomLabel.classList.toggle('disabled', !enabled);
}

// 自动播放：浏览器的自动播放策略会拦下「带声音的自动播放」，光靠 <video autoplay> 往往只停在首帧。
// 点缩略图 / 上一张下一张都发生在用户手势里，此刻直接 play() 最容易通过策略；万一仍被拦
// （例如页面嵌在 iframe 里），退回静音播放——静音播放始终允许；连静音都失败才摆一个大播放按钮。
function autoplayMedia(media) {
  const start = (muted, onFail) => {
    media.muted = muted;
    let p = null;
    try { p = media.play(); } catch (_) { p = null; }
    if (p && typeof p.catch === 'function') p.catch(onFail);
  };
  start(false, () => start(true, () => showPlayOverlay(media)));
}

function showPlayOverlay(media) {
  if (!media || imageModalMedia.querySelector('.media-play-overlay')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'media-play-overlay';
  btn.title = '点击播放';
  btn.textContent = '▶';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.remove();
    media.muted = false;
    let p = null;
    try { p = media.play(); } catch (_) { p = null; }
    if (p && typeof p.catch === 'function') {
      p.catch(() => { media.muted = true; const q = media.play(); if (q && typeof q.catch === 'function') q.catch(() => {}); });
    }
  });
  imageModalMedia.appendChild(btn);
}

// 媒体本身加载失败（CDN 403 / 文件损坏 / 网络中断）时给一句可读提示，
// 而不是只留一块黑屏让人以为「点了没反应」
function showMediaError(media) {
  if (!media || imageModalMedia.querySelector('.media-error')) return;
  const code = media.error && media.error.code;
  const div = document.createElement('div');
  div.className = 'media-error';
  div.textContent = '媒体加载失败' + (code ? `（错误码 ${code}）` : '') + '：可点下方「在新窗口打开」直接访问原文件';
  imageModalMedia.appendChild(div);
  const o = imageModalMedia.querySelector('.media-play-overlay');
  if (o) o.remove();
}

// 上游的实况照片 / 视频基本都是 H.265(HEVC) 编码。Windows 上若没装「HEVC 视频扩展」，
// 浏览器会跳过视频轨、只解音频：声音正常，画面却永远停在我们设的首帧封面图上——
// 看起来就是「点开不动」。判据是「已经在播 / 已有数据，却拿不到任何画面尺寸」。
// strict：来自 playing 事件时，只要拿不到画面尺寸就可判定；
//         延后兜底检查时要多加一个 readyState 条件，避免把「还没加载完」误判成解不出来。
function isVideoTrackUndecodable(media, strict) {
  if (!media || media.error) return false;
  if (!strict && media.readyState < 2) return false;
  return media.videoWidth === 0 && media.videoHeight === 0;
}

// 一旦确认这台机器解不出 HEVC（出现过一次「有声音没画面」），后面的实况 / 视频就直接走
// 本机转码地址，省掉「先只出声、再等判断」那一段。转码成功过一次才置位，避免没 ffmpeg
// 时每条都白打一次转码接口。
let preferTranscoded = false;
const autoTranscoding = new WeakSet();

// 解不出画面时不弹任何提示条：直接在本机把 HEVC 转成 H.264 播。
// 机器上没有 ffmpeg 就后台自动装一个（约 21MB，解压到用户目录，不需要管理员权限），
// 装完立刻接着转；转好的文件按源地址缓存，同一条以后秒开。
function autoTranscode(media, rawUrl) {
  if (!media || !media.isConnected || autoTranscoding.has(media)) return;
  autoTranscoding.add(media);

  let stopped = false;
  let pollTimer = null;
  let installRequested = false;
  const stop = () => { stopped = true; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };

  // 切到转码后的地址：此时服务端已经落好缓存，这是一次本地文件读取，很快
  const applyTranscoded = () => {
    stop();
    preferTranscoded = true;
    media.src = '/api/transcoded?url=' + encodeURIComponent(rawUrl);
    media.load();
    autoplayMedia(media);
  };

  // check=1 只回报进度、并在后台预热转码，避免挂一个几分钟都不响应的请求
  async function pollOnce() {
    if (stopped || !media.isConnected) { stop(); return; }
    let d = null;
    try {
      const res = await fetch('/api/transcoded?check=1&url=' + encodeURIComponent(rawUrl));
      if (res.ok) d = await res.json();
    } catch (_) { /* 网络抖动就下一轮再看 */ }
    if (stopped || !media.isConnected) { stop(); return; }
    if (d && d.ready) return applyTranscoded();
    if (d && !d.ffmpeg && !d.installing) {
      // 装过一次还是不行（下载失败 / 平台不支持）就安静收手，不再反复重试
      if (installRequested || d.error) { stop(); return; }
      installRequested = true;
      fetch('/api/ffmpeg/install', { method: 'POST' }).catch(() => { /* 轮询会再次读到状态 */ });
    }
    pollTimer = setTimeout(pollOnce, 800);
  }

  pollOnce();
}

// 直接换 innerHTML 不会停掉旧媒体，上下张切换时会出现声音重叠：先暂停再清空
function clearMediaStage() {
  const old = imageModalMedia.querySelector('video, audio');
  if (old) { try { old.pause(); } catch (_) { /* ignore */ } }
  imageModalMedia.innerHTML = '';
}

function renderMediaItem() {
  const item = mediaViewer.items[mediaViewer.index];
  if (!item) return;
  const kind = item.dataset.kind;
  const url = item.dataset.url;
  const poster = item.dataset.poster || '';
  clearMediaStage();
  imageModalMedia.classList.remove('zoomed', 'dragging');
  let media = null;
  if (kind === 'image') {
    media = document.createElement('img');
    media.alt = '原图';
    media.src = mediaProxyUrl(url);
  } else if (kind === 'video' || kind === 'live_photo') {
    media = document.createElement('video');
    // 已经确认本机解不了 HEVC 时直接吃转码版，省掉「先只出声再判断」那一段
    media.src = preferTranscoded
      ? '/api/transcoded?url=' + encodeURIComponent(url)
      : mediaProxyUrl(url);
    if (poster) media.poster = mediaProxyUrl(poster);
    media.controls = true;
    media.loop = kind === 'live_photo'; // 实况照片本身就是一小段视频，循环播放更接近源站
    media.autoplay = true;
    media.playsInline = true;
    media.setAttribute('playsinline', '');
    media.preload = 'auto';
  } else if (kind === 'audio') {
    media = document.createElement('audio');
    media.src = mediaProxyUrl(url);
    media.controls = true;
    media.autoplay = true;
    media.preload = 'auto';
  }
  if (media) imageModalMedia.appendChild(media);
  if (kind === 'image' && media) {
    setupImageZoom(media);
  } else {
    zoomImg = null;
    zoomLabel.textContent = '×1.0';
  }
  setZoomEnabled(kind === 'image');
  imageModalLink.href = mediaProxyUrl(url);
  mediaPos.textContent = mediaViewer.items.length ? `${mediaViewer.index + 1}/${mediaViewer.items.length}` : '';
  if (media && kind !== 'image') {
    // 一旦真的播出画面就把兜底播放按钮 / 错误提示收掉（用户自己点过播放的情况也适用）
    media.addEventListener('playing', () => {
      const o = imageModalMedia.querySelector('.media-play-overlay');
      if (o) o.remove();
      const er = imageModalMedia.querySelector('.media-error');
      if (er) er.remove();
    });
    media.addEventListener('error', () => {
      // 转码版拿不到（还没转好 / 转码失败）就悄悄退回原文件，不弹「加载失败」
      if (media.dataset.transcodeFallback !== '1' && /\/api\/transcoded\?/.test(media.getAttribute('src') || '')) {
        media.dataset.transcodeFallback = '1';
        media.src = mediaProxyUrl(url);
        media.load();
        autoplayMedia(media);
        return;
      }
      showMediaError(media);
    });
    // HEVC 缺解码器时「有声音没画面」：识别出来后直接在本机转码，不给提示
    if (kind === 'video' || kind === 'live_photo') {
      let checked = false;
      const checkDecodable = (strict) => {
        if (checked || !media.isConnected) return;
        if (!isVideoTrackUndecodable(media, strict)) return;
        checked = true;
        autoTranscode(media, url);
      };
      media.addEventListener('playing', () => checkDecodable(true));
      // 兜底：被自动播放策略挡住时不会触发 playing，延后再判一次
      setTimeout(() => checkDecodable(false), 1500);
    }
    if (media.paused) autoplayMedia(media);
  }
}

// 同一组媒体的范围：表格里是所在单元格，原帖详情 / 评论区里是那一段媒体块
function mediaScopeOf(el) {
  return el.closest('.post-preview-media, .comment-media, td');
}

// scope 用于限定「同组媒体」的翻阅范围
function openMedia(el, scope) {
  const box = scope || mediaScopeOf(el);
  mediaViewer.items = box ? Array.from(box.querySelectorAll('[data-kind]')) : [el];
  mediaViewer.index = Math.max(0, mediaViewer.items.indexOf(el));
  // 先显示灯箱再加载媒体：在 display:none 的容器里 play() 可能被忽略
  imageModal.classList.remove('hidden');
  renderMediaItem();
}

function mediaStep(dir) {
  if (!mediaViewer.items.length) return;
  const target = mediaViewer.index + dir;
  if (target < 0) { toast('已经是第一张了'); return; }
  if (target >= mediaViewer.items.length) { toast('已经是最后一张了'); return; }
  mediaViewer.index = target;
  renderMediaItem();
}

function closeImageModal() {
  imageModal.classList.add('hidden');
  clearMediaStage(); // 顺带停掉正在播放的视频 / 音频
  zoomImg = null;
  zoom.dragging = false;
  zoomLabel.textContent = '×1.0';
  mediaViewer.items = [];
  mediaViewer.index = -1;
  mediaPos.textContent = '';
}

/* ---------------- 数据 ---------------- */
function activeSheet() {
  return state.sheets.find((s) => s.key === state.activeSheetKey) || state.sheets[0] || BUILTIN_SHEETS[0];
}

// 按 source 找内置工作表（如 'mine'），用户主页工作表不参与匹配
function builtinSheetBySource(source) {
  return state.sheets.find((s) => s.source === source && !s.userId);
}

// 切换工作表前把上一次的数据 / 选区 / 排序视图整体清空
function resetSheetView() {
  state.posts = [];
  state.lastId = '';
  state.hasMore = true;
  state.error = '';
  state.selectedIdx = -1;
  state.selectedId = null;
  state.selectedPost = null;
  state.selectedColKey = null;
  state.lastUpdate = null;
  // 删除只针对「我的」，切表就退出删除模式，避免把上一张表的勾选带过去
  state.deleteMode = false;
  state.deleteIds = new Set();
}

/* ---------------- 工作表数据缓存：切换 / 关闭都不再重新拉取 ---------------- */
// 每张工作表把自己的数据、翻页游标、选区和滚动位置留在 sheet.view 里：切走时拍一份快照，
// 切回时原样还原。于是只有「从没加载过」或用户显式点「刷新」时才会真的发请求；
// 切换、关闭页签都不会触发网络刷新，也不会把人从看了一半的位置踢回第一行。
let skipAutoLoadOnce = false;

function sheetWrapEl() {
  return document.querySelector('.sheet-wrap');
}

// 把当前 state 里的东西登记到当前工作表上（快照）
function snapshotSheetView() {
  const sheet = state.sheets.find((s) => s.key === state.activeSheetKey);
  if (!sheet) return;
  const wrap = sheetWrapEl();
  sheet.view = {
    posts: state.posts,
    lastId: state.lastId,
    hasMore: state.hasMore,
    error: state.error,
    lastUpdate: state.lastUpdate,
    selectedId: state.selectedId,
    selectedColKey: state.selectedColKey,
    deleteMode: state.deleteMode,
    deleteIds: new Set(state.deleteIds),
    scrollTop: wrap ? wrap.scrollTop : 0,
  };
}

// 还原某张工作表：有缓存就用缓存（不请求网络），没缓存才清空等着首屏拉取。返回是否有缓存
function restoreSheetView(sheet) {
  state.activeSheetKey = sheet.key;
  state.source = sheet.source;
  state.loading = false;
  const v = sheet.view;
  if (!v) { resetSheetView(); return false; }
  state.posts = v.posts || [];
  state.lastId = v.lastId || '';
  state.hasMore = v.hasMore !== false;
  state.error = v.error || '';
  state.lastUpdate = v.lastUpdate || null;
  state.deleteMode = !!v.deleteMode;
  state.deleteIds = new Set(v.deleteIds || []);
  state.selectedColKey = v.selectedColKey || null;
  state.selectedId = v.selectedId || null;
  return true;
}

function applySheetScroll(v) {
  const wrap = sheetWrapEl();
  if (wrap) wrap.scrollTop = v ? v.scrollTop || 0 : 0;
}

function switchSheet(key) {
  const sheet = state.sheets.find((s) => s.key === key);
  if (!sheet) return;
  if (state.activeSheetKey === key) { // 点当前页签 = 显式重新加载
    fetchPage(true);
    return;
  }
  snapshotSheetView();
  const cached = restoreSheetView(sheet);
  if (cached) {
    // 还原的内容不够高时也别顺手补一页：切换页签本身不该产生网络请求
    skipAutoLoadOnce = true;
  } else {
    applySheetScroll(null);
  }
  render();
  if (cached) requestAnimationFrame(() => applySheetScroll(sheet.view));
  else fetchPage(true);
}

// 兼容旧调用（按数据源名切换内置工作表）
function switchSource(source) {
  const sheet = builtinSheetBySource(source);
  if (sheet) switchSheet(sheet.key);
}

// 点击表格里的头像：打开（或切到）该用户的主页工作表
function openUserSheet(user) {
  const u = user || {};
  const uid = u.id;
  if (!uid) return;
  const mine = builtinSheetBySource('mine');
  if (mine && state.user && state.user.id === uid) { // 点到自己就直接用「我的」
    toast('这是你自己的头像，已切到「我的」工作表');
    switchSheet(mine.key);
    return;
  }
  const key = USER_SHEET_PREFIX + uid;
  let sheet = state.sheets.find((s) => s.key === key);
  if (!sheet) {
    sheet = Object.assign({
      key,
      userId: uid,
      label: u.nickname || uid.slice(0, 8),
      title: (u.nickname || '该用户') + ' 的主页（右键「×」关闭）',
    }, USER_SHEET_FLAGS);
    state.sheets.push(sheet);
  } else if (u.nickname) {
    sheet.label = u.nickname;
  }
  switchSheet(key);
}

function closeSheet(key) {
  const i = state.sheets.findIndex((s) => s.key === key);
  if (i < 0 || !state.sheets[i].closable) return;
  state.sheets.splice(i, 1);
  if (state.activeSheetKey !== key) {
    renderSheetTabs();
    return;
  }
  const fallback = state.sheets[Math.max(0, i - 1)] || state.sheets[0];
  state.activeSheetKey = ''; // 刚被关掉的这张已不在列表里，先置空避免 activeSheet() 误命中
  const cached = restoreSheetView(fallback);
  if (!cached) applySheetScroll(null);
  else skipAutoLoadOnce = true; // 关闭页签同样不该触发刷新
  render();
  if (cached) requestAnimationFrame(() => applySheetScroll(fallback.view));
  else fetchPage(true);
}

function renderSheetTabs() {
  if (!sheetTabsEl) return;
  sheetTabsEl.querySelectorAll('.sheet-tab').forEach((el) => el.remove());
  const addBtn = sheetTabsEl.querySelector('.sheet-tab-add');
  const frag = document.createDocumentFragment();
  state.sheets.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'sheet-tab' + (s.key === state.activeSheetKey ? ' active' : '');
    el.dataset.sheetKey = s.key;
    el.title = s.title || s.label;
    const name = document.createElement('span');
    name.textContent = s.label;
    el.appendChild(name);
    if (s.closable) {
      const x = document.createElement('em');
      x.className = 'sheet-tab-close';
      x.dataset.closeKey = s.key;
      x.title = '关闭工作表';
      x.textContent = '×';
      el.appendChild(x);
    }
    frag.appendChild(el);
  });
  sheetTabsEl.insertBefore(frag, addBtn || null);
}

async function fetchPage(reset) {
  if (state.loading) return;
  if (!reset && !state.hasMore) return;
  const reqKey = state.activeSheetKey; // 请求期间切走了工作表 → 结果作废，别写进别人的表
  state.loading = true;
  state.error = '';
  setLoadingUI(true);
  updateSentinel();

  if (reset) {
    const wrap = sheetWrapEl();
    if (wrap) wrap.scrollTop = 0;
  }

  const sheet = activeSheet();
  const params = new URLSearchParams({ source: sheet.source, per_page: String(state.perPage) });
  if (sheet.userId) params.set('user_id', sheet.userId);
  if (reset) params.set('refresh', '1'); // 手动刷新绕过服务端缓存
  if (!reset && state.lastId) params.set('last_id', state.lastId);

  try {
    const res = await fetch('/api/posts?' + params.toString());
    let data;
    try { data = await res.json(); } catch (_) { data = null; }
    if (reqKey !== state.activeSheetKey) return; // 数据回来时已经不在那张工作表上：直接丢弃
    if (!res.ok) {
      throw new Error(res.status === 401 ? '登录已失效：请重新登录后在 config.json 中更新 token' : ((data && data.message) || `HTTP ${res.status}`));
    }
    if (!Array.isArray(data)) throw new Error((data && data.message) || '响应格式异常');

    const knownIds = new Set(state.posts.map((p) => p.id));
    const merged = reset ? data : state.posts.concat(data);
    const seen = new Set();
    state.posts = merged.filter((p) => {
      if (!p || !p.id || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    state.posts.forEach((p) => { p.is_favourited = state.favIds.has(p.id); });

    const newCount = data.filter((p) => p && p.id && !knownIds.has(p.id)).length;
    state.hasMore = data.length >= state.perPage;
    if (!reset && newCount === 0) state.hasMore = false; // 本页全是重复数据则停止

    state.lastId = state.posts.length ? state.posts[state.posts.length - 1].id : '';
    if (reset) state.lastUpdate = new Date();
    if (reset) refreshFavourites();
  } catch (e) {
    if (reqKey === state.activeSheetKey) state.error = e.message;
  } finally {
    state.loading = false;
    setLoadingUI(false);
    render();
  }
}

// 收藏 id 集合：一次会话内缓存，避免每次 reset 都串行翻完最多 100 页
const FAV_CACHE_TTL = 60000; // 毫秒
let favFetchedAt = 0;
let favFetching = null;

async function refreshFavourites(force) {
  if (!force && state.favLoaded && Date.now() - favFetchedAt < FAV_CACHE_TTL) return;
  if (favFetching) return favFetching; // 并发调用合流，避免重复爬取
  favFetching = (async () => {
    const ids = new Set();
    let lastId = '';
    try {
      for (let guard = 0; guard < 100; guard++) {
        const params = new URLSearchParams({ per_page: '20' });
        if (lastId) params.set('last_id', lastId);
        const res = await fetch('/api/favourites?' + params.toString());
        let data;
        try { data = await res.json(); } catch (_) { data = null; }
        if (!res.ok) throw new Error((data && data.message) || `HTTP ${res.status}`);
        if (!Array.isArray(data)) break;
        data.forEach((p) => { if (p && p.id) ids.add(p.id); });
        lastId = data.length ? data[data.length - 1].id : '';
        if (data.length < 20) break;
      }
    } catch (_) { /* 收藏状态获取失败时静默忽略 */ }
    state.favIds = ids;
    state.favLoaded = true;
    favFetchedAt = Date.now();
    state.posts.forEach((p) => { p.is_favourited = ids.has(p.id); });
    render();
  })();
  try { await favFetching; } finally { favFetching = null; }
}

const LIKE_COOLDOWN_MS = 1000;

async function toggleAction(post, kind, el) {
  if (post._liking) return;
  const now = Date.now();
  if (post._likeAt && now - post._likeAt < LIKE_COOLDOWN_MS) {
    toast('操作过快，请稍后再试');
    return;
  }
  const isLike = kind === 'like';
  const flag = isLike ? 'is_voted' : 'is_favourited';
  const on = !!post[flag];
  const name = isLike ? '点赞' : '收藏';
  post._liking = true;
  if (el) {
    el.classList.add('busy');
    const inp = el.querySelector('.action-check');
    if (inp) inp.disabled = true;
  }
  try {
    const res = await fetch(isLike ? '/api/votes' : '/api/favourites', {
      method: on ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: post.id }),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      throw new Error(res.status === 401 ? '登录已失效：请更新 config.json 中的 token' : ((data && data.message) || `HTTP ${res.status}`));
    }
    let applied = false;
    if (data && typeof data === 'object') {
      if (typeof data.is_voted === 'boolean') { post.is_voted = data.is_voted; applied = true; }
      if (typeof data.is_favourited === 'boolean') { post.is_favourited = data.is_favourited; applied = true; }
      if (typeof data.votes_count === 'number') post.votes_count = data.votes_count;
    }
    // 上游没回状态字段（或回了个数组之类）时，按「取反」本地更新，界面不会卡在旧状态
    if (!applied) post[flag] = !on;
    if (flag === 'is_favourited') {
      if (post.is_favourited) state.favIds.add(post.id);
      else state.favIds.delete(post.id);
      favFetchedAt = Date.now(); // 本地已同步，缓存继续有效
    }
    // 从「原帖详情」操作时 post 是单帖对象的副本，把它同步回表格里的同一条帖子
    const row = state.posts.find((p) => p && p.id === post.id);
    if (row && row !== post) {
      if (typeof post.is_voted === 'boolean') row.is_voted = post.is_voted;
      if (typeof post.is_favourited === 'boolean') row.is_favourited = post.is_favourited;
    }
    render();
    toast((post[flag] ? '已' : '取消') + name);
  } catch (e) {
    toast(name + '失败：' + e.message);
  } finally {
    post._liking = false;
    post._likeAt = Date.now();
    if (el) {
      el.classList.remove('busy');
      const inp = el.querySelector('.action-check');
      if (inp) inp.disabled = false;
    }
  }
}

function toggleLike(post, el) { return toggleAction(post, 'like', el); }
function toggleFavourite(post, el) { return toggleAction(post, 'favourite', el); }

function setLoadingUI(loading) {
  refreshBtn.disabled = loading;
  const label = refreshBtn.querySelector('span');
  if (label) label.textContent = loading ? '加载中…' : '刷新';
  updateStatusMode(); // 删除模式 / 删除中时状态栏显示对应提示
}

/* ---------------- 懒加载 ---------------- */
function updateSentinel() {
  const searching = !!state.search.trim();
  if (state.loading) {
    loadMoreBtn.textContent = '加载中…';
    loadMoreBtn.disabled = true;
  } else if (!state.hasMore) {
    loadMoreBtn.textContent = '已加载全部';
    loadMoreBtn.disabled = true;
  } else if (searching) {
    // 搜索结果行数少，自动翻页会一搜就连续拉取，这里暂停（仍可手动点）
    loadMoreBtn.textContent = '搜索中：已暂停自动加载（可点击手动加载更多）';
    loadMoreBtn.disabled = false;
  } else {
    loadMoreBtn.textContent = '滚动到底部自动加载更多（也可点击）';
    loadMoreBtn.disabled = false;
  }
}

function maybeLoadMore() {
  if (state.loading || !state.hasMore) return;
  if (state.search.trim()) return; // 搜索状态下不自动翻页
  const wrap = document.querySelector('.sheet-wrap');
  const wrapRect = wrap.getBoundingClientRect();
  const rect = sentinel.getBoundingClientRect();
  // 加载标记进入可视区域（含 200px 预加载余量）就翻页
  if (rect.top <= wrapRect.bottom + 200) fetchPage(false);
}

/* ---------------- 视图 ---------------- */
function visibleColumns() {
  return COLUMNS.filter((c) => state.visible.has(c.key));
}

/* ---------------- 列对齐（左对齐 / 居中 / 右对齐） ---------------- */
function defaultAlign(col) {
  if (col.align) return col.align;
  if (col.numeric) return 'right';
  return 'left';
}

// 某列的当前对齐：用户设置过的优先，否则用列自身的默认对齐
function alignOf(col) {
  return state.align[col.key] || defaultAlign(col);
}

// 对齐按钮的作用范围：选中了某一列就只改这一列，否则改所有可见列
function alignTargets() {
  const key = state.selectedColKey;
  const col = key && COLUMNS.find((c) => c.key === key);
  if (col && state.visible.has(col.key)) return { cols: [col], label: `「${col.label}」列` };
  const cols = visibleColumns();
  return { cols, label: `全部 ${cols.length} 列` };
}

function applyAlign(value) {
  const target = alignTargets();
  if (!target.cols.length) { toast('没有可对齐的列'); return; }
  target.cols.forEach((c) => { state.align[c.key] = value; });
  saveViewPrefs();
  render(); // render → updateSelectionUI → updateAlignUI，按钮高亮随之刷新
  toast(`${target.label}：${ALIGN_LABEL[value]}`);
}

// 按钮高亮：作用范围内所有列的对齐一致时才点亮对应按钮
function updateAlignUI() {
  const target = alignTargets();
  const vals = target.cols.map(alignOf);
  const cur = vals.length && vals.every((v) => v === vals[0]) ? vals[0] : '';
  Object.keys(ALIGN_BTNS).forEach((k) => {
    const btn = ALIGN_BTNS[k];
    if (!btn) return;
    btn.classList.toggle('active', cur === k);
    btn.title = `对齐（作用于${target.label}）：${ALIGN_LABEL[k]}`;
  });
}

// 排序取值：点赞 / 收藏列展示的是「状态」（is_voted / is_favourited），
// 上游接口不返回 likes / favourites / votes_count 计数，所以排序也必须用状态字段
function sortValue(post, key) {
  if (key === 'likes') return post.is_voted ? 1 : 0;
  if (key === 'favourites') return post.is_favourited ? 1 : 0;
  return getVal(post, key);
}

function filteredPosts() {
  let list = state.posts;
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter((p) => {
      const hay = [p.id, getVal(p, 'user.nickname'), p.content, getVal(p, 'root_channel')]
        .filter((v) => v != null).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  if (state.sortKey) {
    const col = COLUMNS.find((c) => c.key === state.sortKey);
    const numericSort = !!(col && (col.numeric || col.likes || col.favourites));
    const dir = state.sortDir;
    list = [...list].sort((a, b) => {
      let va = sortValue(a, state.sortKey);
      let vb = sortValue(b, state.sortKey);
      if (numericSort) {
        va = Number(va) || 0;
        vb = Number(vb) || 0;
        return (va - vb) * dir;
      }
      va = va == null ? '' : String(va);
      vb = vb == null ? '' : String(vb);
      return va.localeCompare(vb, 'zh-CN') * dir;
    });
  }
  return list;
}

function renderHead() {
  const cols = visibleColumns();
  const tr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'row-num';
  corner.textContent = '';
  tr.appendChild(corner);
  // 删除模式：行号右侧插一列「删除」，表头是全选复选框（不参与排序 / 对齐 / 键盘导航）
  if (state.deleteMode) {
    const th = document.createElement('th');
    th.className = 'delete-col';
    th.dataset.colKey = DELETE_COL_KEY;
    th.style.width = DELETE_COL_WIDTH + 'px';
    th.title = '勾选 / 取消勾选当前显示的所有行';
    const label = document.createElement('label');
    label.className = 'action-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'deleteSelectAll';
    const box = document.createElement('span');
    box.className = 'box';
    label.appendChild(cb);
    label.appendChild(box);
    th.appendChild(label);
    tr.appendChild(th);
  }
  cols.forEach((col, i) => {
    const th = document.createElement('th');
    th.className = 'sortable';
    th.dataset.colKey = col.key;
    th.style.width = (state.colWidths[col.key] || col.width) + 'px';
    th.style.textAlign = alignOf(col);
    const letter = document.createElement('span');
    letter.className = 'col-letter';
    letter.textContent = letterOf(i);
    th.appendChild(letter);
    th.appendChild(document.createTextNode(col.label));
    if (state.sortKey === col.key) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = state.sortDir === 1 ? '▲' : '▼';
      th.appendChild(arrow);
    }
    const resizer = document.createElement('span');
    resizer.className = 'col-resizer';
    resizer.title = '拖动调整列宽';
    th.appendChild(resizer);
    th.addEventListener('click', (e) => {
      if (e.target.closest('.col-resizer')) return;
      if (state.sortKey === col.key) {
        state.sortDir = -state.sortDir;
      } else {
        state.sortKey = col.key;
        state.sortDir = 1;
      }
      render();
    });
    tr.appendChild(th);
  });
  sheetHead.replaceChildren(tr);
}

function renderBody() {
  const list = filteredPosts();
  const cols = visibleColumns();
  const frag = document.createDocumentFragment();

  if (list.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = cols.length + 1 + (state.deleteMode ? 1 : 0);
    td.textContent = state.loading ? '加载中…' : (state.posts.length ? '没有匹配的行' : '暂无数据，点击「手动刷新」开始加载');
    td.style.cssText = 'text-align:center;color:var(--text-disabled);padding:30px 0;';
    tr.appendChild(td);
    frag.appendChild(tr);
  } else {
    list.forEach((post, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.idx = String(idx);
      if (state.deleteMode && post.id && state.deleteIds.has(post.id)) tr.classList.add('to-delete');
      const num = document.createElement('td');
      num.className = 'row-num';
      num.textContent = String(idx + 1);
      tr.appendChild(num);
      // 删除模式：行号右侧的勾选列（放在数据列之前，不参与 renderCell 那套流程）
      if (state.deleteMode) {
        const td = document.createElement('td');
        td.className = 'delete-col';
        td.dataset.colKey = DELETE_COL_KEY;
        const label = document.createElement('label');
        label.className = 'action-toggle';
        label.title = '勾选后点「确认删除」批量删除';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'delete-check';
        cb.checked = !!(post.id && state.deleteIds.has(post.id));
        if (post.id) cb.dataset.postId = post.id;
        cb.disabled = !post.id;
        const box = document.createElement('span');
        box.className = 'box';
        label.appendChild(cb);
        label.appendChild(box);
        td.appendChild(label);
        // 勾选不应该顺带把这一行选中 / 触发其它行点击逻辑
        td.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (!post.id) return;
          if (cb.checked) state.deleteIds.add(post.id);
          else state.deleteIds.delete(post.id);
          tr.classList.toggle('to-delete', cb.checked);
          updateDeleteUI();
        });
        tr.appendChild(td);
      }
      cols.forEach((col) => {
        const cell = renderCell(col, post);
        const td = document.createElement('td');
        if (cell.html != null) {
          td.innerHTML = cell.html;
        } else {
          td.textContent = cell.text;
        }
        if (cell.title) td.title = cell.title;
        if (col.numeric) td.className = 'cell-num';
        if (col.key === 'content') td.className = 'cell-content';
        if (col.media) td.className = 'cell-media';
        if (col.avatar) td.className = 'cell-avatar';
        td.style.textAlign = alignOf(col); // 行内样式，优先级高于 cell-num / cell-action 等类的默认对齐
        td.dataset.raw = cell.title || cell.text;
        td.dataset.col = col.label;
        td.dataset.colKey = col.key;
        td.addEventListener('dblclick', () => {
          navigator.clipboard && navigator.clipboard.writeText(td.dataset.raw);
          toast(`已复制：${td.dataset.raw.slice(0, 40)}`);
        });
        if (col.avatar) {
          const av = td.querySelector('.avatar-link');
          if (av) {
            av.addEventListener('click', (e) => {
              // 必须阻止冒泡：切换工作表会重建 tbody，行点击处理器再跑就会写到已失效的行上
              e.stopPropagation();
              openUserSheet(post.user);
            });
          }
        }
        if (col.media) {
          td.querySelectorAll('[data-kind]').forEach((el) => {
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              openMedia(el);
            });
          });
        }
        if (col.likes || col.favourites) {
          td.className = 'cell-action';
          const toggle = td.querySelector('.action-toggle');
          if (toggle) {
            toggle.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (col.likes) toggleLike(post, toggle);
              else toggleFavourite(post, toggle);
            });
            toggle.addEventListener('dblclick', (e) => e.stopPropagation());
          }
        }
        tr.appendChild(td);
      });
      tr.addEventListener('click', (e) => {
        const cell = e.target.closest('td');
        state.selectedIdx = idx;
        state.selectedId = post.id;
        state.selectedPost = post;
        state.selectedColKey = cell && cell.dataset.colKey ? cell.dataset.colKey : null;
        updateSelectionUI();
        renderSelection();
        if (cell && cell.dataset.colKey === 'comments_count') {
          openComments(post);
        }
      });
      frag.appendChild(tr);
    });
  }
  sheetBody.replaceChildren(frag);
  renderSelection();

  statusCount.textContent = state.search
    ? `显示 ${list.length} / 已加载 ${state.posts.length} 行`
    : `${state.posts.length} 行`;
  renderSheetTabs();
  statusTime.textContent = state.lastUpdate ? '更新于 ' + fmtTime(state.lastUpdate) : '尚未刷新';
}

// 每次重新渲染前，用选中的帖子 id 重新定位行号：
// 这样排序 / 搜索 / 增删数据之后，选中的还是同一条帖子，而不会变成「同一行号上的另一条」
function syncSelectionFromId() {
  if (!state.selectedId) {
    state.selectedIdx = -1;
    state.selectedPost = null;
    return;
  }
  const list = filteredPosts();
  const i = list.findIndex((p) => p && p.id === state.selectedId);
  state.selectedIdx = i;
  state.selectedPost = i >= 0 ? list[i] : null;
}

function updateSelectionUI() {
  updateAlignUI(); // 选中列变化时，对齐按钮的高亮与作用范围要跟着变
  if (state.selectedPost == null) {
    nameBox.textContent = 'A1';
    formulaInput.value = '';
    formulaInput.title = '';
    return;
  }
  const rowNo = state.selectedIdx + 1;
  const cols = visibleColumns();
  const colIdx = cols.findIndex((c) => c.key === state.selectedColKey);
  const col = colIdx >= 0 ? cols[colIdx] : null;
  nameBox.textContent = col ? letterOf(colIdx) + rowNo : 'A' + rowNo;
  const cell = col ? renderCell(col, state.selectedPost) : { text: '' };
  formulaInput.value = cell.text || '';
  formulaInput.title = formulaInput.value;
}

function renderSelection() {
  sheetBody.querySelectorAll('tr.selected').forEach((tr) => tr.classList.remove('selected'));
  sheetBody.querySelectorAll('td.cell-active').forEach((td) => td.classList.remove('cell-active'));
  sheetHead.querySelectorAll('th.col-active').forEach((th) => th.classList.remove('col-active'));
  if (state.selectedIdx >= 0) {
    const tr = sheetBody.querySelector(`tr[data-idx="${state.selectedIdx}"]`);
    if (tr) tr.classList.add('selected');
    if (state.selectedColKey) {
      const td = tr.querySelector(`td[data-col-key="${state.selectedColKey}"]`);
      if (td) td.classList.add('cell-active');
      const th = sheetHead.querySelector(`th[data-col-key="${state.selectedColKey}"]`);
      if (th) th.classList.add('col-active');
    }
  }
}

/* ---------------- Excel 风格单元格键盘导航 ---------------- */
// 当前激活列在「显示列」中的下标（列被隐藏或未选列时回退到第一列）
function currentColIndex() {
  const cols = visibleColumns();
  const i = cols.findIndex((c) => c.key === state.selectedColKey);
  return i < 0 ? 0 : i;
}

function scrollActiveIntoView() {
  const td = sheetBody.querySelector('td.cell-active');
  if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// 选中指定单元格（行/列均会被夹取到有效范围）
function selectCell(row, col) {
  const list = filteredPosts();
  const cols = visibleColumns();
  if (!list.length || !cols.length) return;
  row = Math.max(0, Math.min(list.length - 1, row));
  col = Math.max(0, Math.min(cols.length - 1, col));
  state.selectedIdx = row;
  state.selectedId = list[row].id;
  state.selectedPost = list[row];
  state.selectedColKey = cols[col].key;
  updateSelectionUI();
  renderSelection();
  scrollActiveIntoView();
}

// 方向键移动：dRow 为行偏移、dCol 为列偏移
function moveSelection(dRow, dCol) {
  const list = filteredPosts();
  const cols = visibleColumns();
  if (!list.length || !cols.length) return;
  // 还没有选中任何单元格时，第一次按键落在 A1
  if (state.selectedIdx < 0) { selectCell(0, 0); return; }
  // 往下越过已加载数据时，尝试继续加载下一页
  if (dRow > 0 && state.selectedIdx + dRow > list.length - 1 && state.hasMore && !state.loading) {
    fetchPage(false);
  }
  const row = Math.max(0, Math.min(list.length - 1, state.selectedIdx + dRow));
  const col = Math.max(0, Math.min(cols.length - 1, currentColIndex() + dCol));
  selectCell(row, col);
}

// PageUp / PageDown 一次翻过大约一屏的行数
function pageRowStep() {
  const wrap = document.querySelector('.sheet-wrap');
  const tr = sheetBody.querySelector('tr');
  const rowH = tr ? tr.getBoundingClientRect().height : 0;
  if (!wrap || !rowH) return 10;
  return Math.max(1, Math.floor(wrap.clientHeight / rowH) - 1);
}

function setPageZoom(v) {
  state.pageZoom = Math.max(0.7, Math.min(1.5, Math.round(v * 100) / 100));
  document.documentElement.style.setProperty('--sheet-zoom', String(state.pageZoom));
  zoomPct.textContent = Math.round(state.pageZoom * 100) + '%';
  saveViewPrefs();
}

function renderError() {
  if (state.error) {
    errorBar.classList.remove('hidden');
    // state.error 可能来自上游响应，必须转义后再插入，避免被当作 HTML 解析
    errorBar.innerHTML = `<span>⚠ ${escapeHtml(state.error)}</span><button class="btn" id="errorClose">关闭</button>`;
    $('errorClose').addEventListener('click', () => {
      state.error = '';
      errorBar.classList.add('hidden');
    });
  } else {
    errorBar.classList.add('hidden');
  }
}

function render() {
  syncSelectionFromId();
  updateSelectionUI();
  renderHead();
  renderBody();
  renderError();
  updateSentinel();
  updateDeleteUI(); // 删除按钮的可用状态 / 勾选计数 / 表头全选随重渲染一起刷新
  // 每次渲染后检查是否还需要补页（处理首屏内容不够高、无法滚动的情况）
  requestAnimationFrame(() => {
    if (skipAutoLoadOnce) { skipAutoLoadOnce = false; return; } // 刚还原缓存，别急着补页
    maybeLoadMore();
  });
}

/* ---------------- 评论回复 ---------------- */
let commentReplyPrefix = '';
function commentReplyName(c) {
  const u = (c && c.user) || {};
  return u.nickname || u.id || '匿名';
}
function findCommentById(id) {
  for (const c of comments.list) {
    if (c && c.id === id) return c;
    if (c && Array.isArray(c.preview_replies)) {
      const r = c.preview_replies.find((x) => x && x.id === id);
      if (r) return r;
    }
  }
  return null;
}
function setReplyTarget(comment) {
  const oldPrefix = commentReplyPrefix;
  commentReplyPrefix = comment ? `回复${commentReplyName(comment)}：` : '';
  const cur = commentsInput.value;
  const bare = cur.startsWith(oldPrefix) ? cur.slice(oldPrefix.length) : cur;
  commentsInput.value = comment ? commentReplyPrefix + bare : bare;
  commentsInput.placeholder = comment ? '' : '写下你的评论…（Enter 发送，Shift+Enter 换行）';
  commentsInput.classList.toggle('replying-input', !!comment);
  comments.replyTo = comment || null;
  commentsList.querySelectorAll('.replying').forEach((el) => el.classList.remove('replying'));
  if (comment) {
    const el = commentsList.querySelector(`[data-comment-id="${comment.id}"]`);
    if (el) el.classList.add('replying');
    commentsInput.focus();
  }
}

/* ---------------- 评论弹窗 ---------------- */
function openComments(post, opts) {
  opts = opts || {};
  comments.post = post;
  commentsCount.textContent = '';
  commentsInput.value = '';
  setReplyTarget(null);
  // 返回按钮 + 原帖预览
  modalBack.classList.toggle('hidden', !opts.showBack);
  modalTitle.textContent = opts.showBack ? '原帖详情' : '帖子评论';
  if (opts.showPost) {
    postPreview.classList.remove('hidden');
    renderPostPreview(post);
  } else {
    postPreview.classList.add('hidden');
    postPreview.innerHTML = '';
  }
  modal.classList.remove('hidden');
  loadComments(post, true);
}

// 「原帖详情」里点赞 / 收藏按钮的图标（内联 SVG，颜色跟随主题）
const ICON_HEART = '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M6 10.6 1.9 6.5a2.6 2.6 0 0 1 3.7-3.7l.4.4.4-.4a2.6 2.6 0 1 1 3.7 3.7z"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="m6 .9 1.55 3.2 3.5.5-2.53 2.5.6 3.5L6 8.9l-3.12 1.7.6-3.5L.95 4.6l3.5-.5z"/></svg>';

// 原帖详情里的点赞 / 收藏按钮：状态取自帖子自身的 is_voted / is_favourited
function previewActionsHtml(post) {
  if (!post || !post.id) return '';
  const isLike = !!post.is_voted;
  const isFav = !!post.is_favourited;
  return `<div class="post-preview-actions">`
    + `<button type="button" class="pp-act${isLike ? ' on' : ''}" data-pp-action="like" title="${isLike ? '取消点赞' : '点赞'}">${ICON_HEART}<span>${isLike ? '已点赞' : '点赞'}</span></button>`
    + `<button type="button" class="pp-act${isFav ? ' on' : ''}" data-pp-action="favourite" title="${isFav ? '取消收藏' : '收藏'}">${ICON_STAR}<span>${isFav ? '已收藏' : '收藏'}</span></button>`
    + `</div>`;
}

// 只改按钮的样式和文案，不整体重渲染预览（避免把用户正在点的缩略图换成新节点）
function updatePreviewActions(post) {
  const box = postPreview.querySelector('.post-preview-actions');
  if (!box || !post) return;
  const paint = (btn, on, onText, offText, tipOn, tipOff) => {
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.title = on ? tipOn : tipOff;
    const label = btn.querySelector('span');
    if (label) label.textContent = on ? onText : offText;
  };
  paint(box.querySelector('[data-pp-action="like"]'), !!post.is_voted, '已点赞', '点赞', '取消点赞', '点赞');
  paint(box.querySelector('[data-pp-action="favourite"]'), !!post.is_favourited, '已收藏', '收藏', '取消收藏', '收藏');
}

function renderPostPreview(post) {
  if (!post || (!post.content && !post.media && !post.user)) {
    postPreview.innerHTML = '<div class="comments-empty">加载原帖中…</div>';
    return;
  }
  const u = post.user || {};
  const nick = u.nickname || u.id || '匿名';
  const time = fmtTime(post.created_at);
  const avatar = commentAvatarHtml(u);
  const mediaHtml = (Array.isArray(post.media) ? post.media : []).map(mediaItemHtml).join('');
  const contentHtml = post.content ? `<div class="post-preview-content">${escapeHtml(post.content)}</div>` : '';
  const metaHtml = `<div class="post-preview-meta"><span class="comment-name">${escAttr(nick)}</span><span class="comment-time">${escAttr(time)}</span></div>`;
  const headHtml = post.user ? `<div class="post-preview-head">${avatar}<div class="post-preview-info">${metaHtml}</div></div>` : '';
  postPreview.innerHTML = `${headHtml}${contentHtml}${mediaHtml ? `<div class="post-preview-media">${mediaHtml}</div>` : ''}${previewActionsHtml(post)}`;
}

// 预览已经渲染过同一条帖子时尽量不要再整体重渲染：把用户正在点的缩略图换成新节点会让
// 灯箱里的 items 指向脱离文档的旧元素。只有「当前缺了、新数据有」时才重渲。
function previewNeedsUpdate(cur, next) {
  if (!cur || !next || cur.id !== next.id) return true;
  const has = (v) => (Array.isArray(v) ? v.length > 0 : (v != null && v !== ''));
  if (!has(cur.content) && has(next.content)) return true;
  if (!has(cur.media) && has(next.media)) return true;
  if (!cur.user && next.user) return true;
  return false;
}

async function fetchPostById(id) {
  const res = await fetch('/api/posts/' + encodeURIComponent(id));
  let data;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) throw new Error((data && data.message) || `HTTP ${res.status}`);
  if (!data || !data.id) throw new Error('帖子数据格式异常');
  return data;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 评论 ---------------- */
let commentsReqId = 0;
const commentVotePending = new Set();

async function loadComments(post, reset) {
  const reqId = ++commentsReqId;
  comments.post = post;
  if (reset) {
    comments.list = [];
    comments.lastId = '';
    comments.hasMore = true;
  }
  if (comments.loading && !reset) return;
  comments.loading = true;
  commentsList.innerHTML = '<div class="comments-empty">加载中…</div>';
  const params = new URLSearchParams({ post_id: post.id, per_page: '10' });
  if (reset) params.set('refresh', '1');
  if (!reset && comments.lastId) params.set('last_id', comments.lastId);
  try {
    const res = await fetch('/api/comments?' + params.toString());
    let data;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) throw new Error(res.status === 401 ? '登录已失效：请更新 config.json 中的 token' : ((data && data.message) || `HTTP ${res.status}`));
    if (!Array.isArray(data)) throw new Error((data && data.message) || '响应格式异常');
    if (reqId !== commentsReqId) return;
    const seen = new Set(comments.list.map((c) => c.id));
    const fresh = data.filter((c) => c && c.id && !seen.has(c.id));
    comments.list = reset ? data.filter((c) => c && c.id) : comments.list.concat(fresh);
    comments.hasMore = data.length >= 10;
    comments.lastId = comments.list.length ? comments.list[comments.list.length - 1].id : '';
    comments.loading = false;
    renderComments();
  } catch (e) {
    if (reqId !== commentsReqId) return;
    commentsList.innerHTML = `<div class="comments-error">评论加载失败：${escapeHtml(e.message)}</div>`;
  } finally {
    if (reqId === commentsReqId) comments.loading = false;
  }
}

// 评论点赞按钮（一级评论与回复共用）
function commentVoteHtml(c) {
  const on = !!c.is_voted;
  const n = Number(c.votes_count);
  const count = Number.isFinite(n) && n > 0 ? `<span class="comment-vote-count">${n}</span>` : '';
  return `<button type="button" class="comment-vote${on ? ' voted' : ''}" data-vote-comment="${escAttr(c.id)}" title="${on ? '取消点赞' : '点赞'}">👍${count}</button>`;
}

// 评论 / 回复自带的图片、视频、语音（复用表格里的缩略图实现，点击可打开灯箱）
function commentMediaHtml(c) {
  const items = Array.isArray(c && c.media) ? c.media : [];
  if (!items.length) return '';
  const inner = items.map(mediaItemHtml).join('');
  return inner ? `<div class="comment-media">${inner}</div>` : '';
}

function commentHtml(c) {
  const u = c.user || {};
  const name = u.nickname || u.id || '匿名';
  const time = fmtTime(c.created_at);
  const badge = (c.is_pinned ? '<em class="comment-pin">置顶</em>' : '') + (c.is_owner ? '<em class="comment-mine">我</em>' : '');
  const avatar = commentAvatarHtml(u);
  let replies = '';
  if (Array.isArray(c.preview_replies) && c.preview_replies.length) {
    replies = `<div class="comment-replies">${c.preview_replies.map(replyHtml).join('')}</div>`;
  }
  return `<div class="comment-item" data-comment-id="${escAttr(c.id)}">${avatar}<div class="comment-main">
      <div class="comment-meta"><span class="comment-name">${escAttr(name)}</span>${badge}<span class="comment-time">${escAttr(time)}</span>${commentVoteHtml(c)}</div>
      <div class="comment-content">${escapeHtml(c.content || '')}</div>
      ${commentMediaHtml(c)}
      ${replies}
    </div></div>`;
}

function replyHtml(r) {
  const u = r.user || {};
  const name = u.nickname || u.id || '匿名';
  const time = fmtTime(r.created_at);
  const badge = r.is_owner ? '<em class="comment-mine">我</em>' : '';
  const avatar = commentAvatarHtml(u, 'comment-reply-avatar');
  return `<div class="comment-reply" data-comment-id="${escAttr(r.id)}">${avatar}<div class="comment-main">
      <div class="comment-meta"><span class="comment-name">${escAttr(name)}</span>${badge}<span class="comment-time">${escAttr(time)}</span>${commentVoteHtml(r)}</div>
      <div class="comment-content">${escapeHtml(r.content || '')}</div>
      ${commentMediaHtml(r)}
    </div></div>`;
}

// 评论区 / 点赞和回复列表里的头像：包一层可点击元素，点它跳到该用户的主页工作表
function commentAvatarHtml(user, extraClass) {
  const u = user || {};
  const name = u.nickname || u.id || '匿名';
  const bg = avatarBgStyle(u);
  const cls = 'comment-avatar' + (extraClass ? ' ' + extraClass : '');
  const inner = u.avatar_url
    ? `<img class="${cls}" src="${escAttr(mediaProxyUrl(thumbUrl(u.avatar_url, 80)))}" alt="" style="${bg}">`
    : `<span class="${cls} comment-avatar-fallback" style="${bg}">${escAttr(String(name[0] || '?').toUpperCase())}</span>`;
  if (!u.id) return inner;
  return `<span class="comment-avatar-link" data-user-id="${escAttr(u.id)}" data-user-name="${escAttr(u.nickname || '')}" title="查看 ${escAttr(name)} 的主页">${inner}</span>`;
}

// 点评论区 / 点赞和回复里的头像：先关掉所在弹窗，再跳到该用户的主页工作表
function bindAvatarJump(listEl, closeModal) {
  if (!listEl) return;
  listEl.addEventListener('click', (e) => {
    const link = e.target.closest('.comment-avatar-link');
    if (!link || !listEl.contains(link)) return;
    const uid = link.getAttribute('data-user-id');
    if (!uid) return;
    if (closeModal) closeModal();
    openUserSheet({ id: uid, nickname: link.getAttribute('data-user-name') || '' });
  });
}

function renderComments() {
  commentsCount.textContent = comments.list.length ? `（已加载 ${comments.list.length} 条）` : '';
  if (comments.list.length === 0) {
    commentsList.innerHTML = comments.loading ? '<div class="comments-empty">加载中…</div>' : '<div class="comments-empty">没有评论</div>';
  } else {
    commentsList.innerHTML = comments.list.map(commentHtml).join('');
  }
  commentsMore.classList.toggle('hidden', !comments.hasMore);
}

async function toggleCommentVote(c, btn) {
  if (!c || !c.id || commentVotePending.has(c.id)) return;
  const nextVoted = !c.is_voted;
  commentVotePending.add(c.id);
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/comment_votes', {
      method: nextVoted ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment_id: c.id }),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* 无响应体 */ }
    if (!res.ok) throw new Error(res.status === 401 ? '登录已失效：请更新 config.json 中的 token' : ((data && data.message) || `HTTP ${res.status}`));
    // 接口返回的 votes_count 可能仍是旧值，因此点赞状态与计数都按本次操作本地更新（2xx 即视为成功）
    c.is_voted = nextVoted;
    c.votes_count = Math.max(0, (Number(c.votes_count) || 0) + (nextVoted ? 1 : -1));
    updateCommentVoteBtn(btn, c);
    toast(c.is_voted ? '已点赞' : '已取消点赞');
  } catch (e) {
    toast('操作失败：' + e.message);
  } finally {
    commentVotePending.delete(c.id);
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

function updateCommentVoteBtn(btn, c) {
  if (!btn || !btn.isConnected) return;
  btn.classList.toggle('voted', !!c.is_voted);
  btn.title = c.is_voted ? '取消点赞' : '点赞';
  const n = Number(c.votes_count);
  let count = btn.querySelector('.comment-vote-count');
  if (Number.isFinite(n) && n > 0) {
    if (!count) {
      count = document.createElement('span');
      count.className = 'comment-vote-count';
      btn.appendChild(count);
    }
    count.textContent = String(n);
  } else if (count) {
    count.remove();
  }
}

async function sendComment() {
  if (!comments.post) return;
  const isReply = !!comments.replyTo;
  let content = commentsInput.value;
  if (isReply && commentReplyPrefix && content.startsWith(commentReplyPrefix)) {
    content = content.slice(commentReplyPrefix.length);
  }
  content = content.trim();
  if (!content) { toast(isReply ? '请输入回复内容' : '请输入评论内容'); return; }
  if (comments.sending) return;
  comments.sending = true;
  commentsSend.disabled = true;
  try {
    let res;
    if (isReply) {
      res = await fetch('/api/comments/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, comment_id: comments.replyTo.id }),
      });
    } else {
      res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, post_id: comments.post.id }),
      });
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(res.status === 401 ? '登录已失效：请更新 config.json 中的 token' : ((data && data.message) || `HTTP ${res.status}`));
    commentsInput.value = '';
    setReplyTarget(null);
    if (!isReply) comments.post.comments_count = (Number(comments.post.comments_count) || 0) + 1;
    await loadComments(comments.post, true); // 发送成功后自动刷新评论列表
    render();
    toast(isReply ? '回复已发送' : '评论已发送');
  } catch (e) {
    toast('发送失败：' + e.message);
  } finally {
    comments.sending = false;
    commentsSend.disabled = false;
  }
}

/* ---------------- 点赞和回复通知 ---------------- */
let notifyReqId = 0;
let previewReqId = 0;

const NOTIFY_ACTION_TEXT = {
  vote: '赞了你的帖子',
  comment_vote: '赞了你的评论',
  comment_reply: '回复了你的评论',
  comment: '评论了你的帖子',
  reply: '回复了你',
};

function openNotifications() {
  notifyModal.classList.remove('hidden');
  loadNotifications(true);
}

async function loadNotifications(reset) {
  const reqId = ++notifyReqId;
  if (reset) {
    notify.list = [];
    notify.lastId = '';
    notify.hasMore = true;
  }
  if (notify.loading && !reset) return;
  notify.loading = true;
  notifyList.innerHTML = '<div class="comments-empty">加载中…</div>';
  const params = new URLSearchParams({ per_page: '10' });
  if (reset) params.set('refresh', '1');
  if (!reset && notify.lastId) params.set('last_id', notify.lastId);
  try {
    const res = await fetch('/api/notifications?' + params.toString());
    let data;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) throw new Error(res.status === 401 ? '登录已失效：请更新 config.json 中的 token' : ((data && data.message) || `HTTP ${res.status}`));
    if (!Array.isArray(data)) throw new Error((data && data.message) || '响应格式异常');
    if (reqId !== notifyReqId) return;
    const seen = new Set(notify.list.map((n) => n && n.id));
    const fresh = data.filter((n) => n && n.id && !seen.has(n.id));
    notify.list = reset ? data.filter((n) => n && n.id) : notify.list.concat(fresh);
    notify.hasMore = data.length >= 10;
    notify.lastId = notify.list.length ? notify.list[notify.list.length - 1].id : '';
    notify.loading = false;
    renderNotifications();
  } catch (e) {
    if (reqId !== notifyReqId) return;
    notifyList.innerHTML = `<div class="comments-error">通知加载失败：${escapeHtml(e.message)}</div>`;
  } finally {
    if (reqId === notifyReqId) notify.loading = false;
  }
}

function notifyHtml(n) {
  const u = n.from_user || {};
  const name = u.nickname || u.id || '匿名';
  const time = fmtTime(n.created_at);
  const act = n.action || '';
  let actionText = NOTIFY_ACTION_TEXT[act] || n.from_content || String(act || '通知');
  const avatar = commentAvatarHtml(u);
  let quote = '';
  if (n.to_content) {
    quote = `<div class="notify-quote">${escapeHtml(n.to_content)}</div>`;
  }
  let content = '';
  if ((act === 'comment_reply' || act === 'comment' || act === 'reply') && n.from_content) {
    content = `<div class="comment-content">${escapeHtml(n.from_content)}</div>`;
  }
  const jumpBtn = n.post_id
    ? `<button class="notify-jump" data-post-id="${escAttr(n.post_id)}" title="查看原帖及评论">查看原帖</button>`
    : '';
  return `<div class="comment-item notify-item" data-notify-id="${escAttr(n.id)}">${avatar}<div class="comment-main">
      <div class="comment-meta"><span class="comment-name">${escAttr(name)}</span><span class="notify-action">${escAttr(actionText)}</span><span class="comment-time">${escAttr(time)}</span></div>
      ${quote}${content}${jumpBtn}
    </div></div>`;
}

function renderNotifications() {
  notifyCount.textContent = notify.list.length ? `（已加载 ${notify.list.length} 条）` : '';
  if (notify.list.length === 0) {
    notifyList.innerHTML = notify.loading ? '<div class="comments-empty">加载中…</div>' : '<div class="comments-empty">暂无点赞和回复</div>';
  } else {
    notifyList.innerHTML = notify.list.map(notifyHtml).join('');
  }
  notifyMore.classList.toggle('hidden', !notify.hasMore);
}

/* ---------------- 批量删除（只在「我的」工作表） ---------------- */
// 只有「我的」工作表能删自己的动态；其它工作表里按钮置灰
function canDeleteHere() {
  return activeSheet().source === 'mine';
}

// 当前显示中、且被勾选的行（按当前展示顺序；顺带过滤掉已不在列表里的陈旧 id）
function markedForDelete() {
  return filteredPosts().filter((p) => p && p.id && state.deleteIds.has(p.id));
}

function updateStatusMode() {
  if (state.deleting) { statusMode.textContent = '正在删除…'; return; }
  if (state.deleteMode) { statusMode.textContent = `删除模式：已勾选 ${state.deleteIds.size} 行`; return; }
  statusMode.textContent = state.loading ? '正在加载…' : (state.error ? '出错' : '就绪');
}

function updateDeleteUI() {
  if (!deleteBtn) return;
  const allowed = canDeleteHere();
  const n = state.deleteIds.size;
  deleteBtn.disabled = !allowed || state.deleting;
  deleteBtn.classList.toggle('active', state.deleteMode);
  deleteBtn.title = allowed
    ? (state.deleteMode ? '点击退出删除模式（会清空已勾选的行）' : '批量删除「我的」动态：先点这里，勾选要删的行，再点「确认删除」')
    : '只有「我的」工作表支持删除自己的动态';

  deleteConfirmBtn.classList.toggle('hidden', !state.deleteMode);
  deleteConfirmBtn.disabled = n === 0 || state.deleting;
  deleteConfirmBtn.title = state.deleting ? '正在删除…'
    : (n ? `删除已勾选的 ${n} 条动态（会再确认一次）` : '请先勾选要删除的行');
  const label = deleteConfirmBtn.querySelector('span');
  if (label) label.textContent = state.deleting ? '删除中…' : (n ? `确认删除(${n})` : '确认删除');
  deleteCancelBtn.classList.toggle('hidden', !state.deleteMode);
  deleteCancelBtn.disabled = state.deleting;

  // 表头「全选」按钮：反映当前显示行的勾选情况
  const all = sheetHead.querySelector('#deleteSelectAll');
  if (all) {
    const list = filteredPosts();
    const picked = list.filter((p) => state.deleteIds.has(p.id)).length;
    all.checked = list.length > 0 && picked === list.length;
    all.indeterminate = picked > 0 && picked < list.length;
    all.disabled = list.length === 0 || state.deleting;
  }
  updateStatusMode();
}

function enterDeleteMode() {
  if (!canDeleteHere()) { toast('删除只适用于「我的」工作表'); return; }
  state.deleteMode = true;
  state.deleteIds = new Set();
  render();
  toast('删除模式：勾选要删除的动态，再点「确认删除」');
}

function exitDeleteMode() {
  if (!state.deleteMode && !state.deleteIds.size) return;
  state.deleteMode = false;
  state.deleteIds = new Set();
  render();
  toast('已退出删除模式');
}

// 勾选「全选」：对当前显示的所有行批量勾选 / 取消
function toggleAllForDelete(checked) {
  filteredPosts().forEach((p) => {
    if (!p || !p.id) return;
    if (checked) state.deleteIds.add(p.id);
    else state.deleteIds.delete(p.id);
  });
  render();
}

/* ---------------- 二次确认弹窗 ---------------- */
let confirmResolve = null;

// 用法：const ok = await askConfirm({ title, message, items, okText })
function askConfirm(opts) {
  const o = opts || {};
  $('confirmTitle').textContent = o.title || '确认操作';
  $('confirmMessage').textContent = o.message || '';
  const listEl = $('confirmList');
  listEl.innerHTML = '';
  const items = Array.isArray(o.items) ? o.items : [];
  items.forEach((txt) => {
    const li = document.createElement('li');
    li.textContent = txt; // 内容可能来自上游数据，用 textContent 避免被当 HTML 解析
    listEl.appendChild(li);
  });
  listEl.classList.toggle('hidden', !items.length);
  $('confirmOk').textContent = o.okText || '确定';
  confirmModal.classList.remove('hidden');
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result) {
  confirmModal.classList.add('hidden');
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(result);
}

/* ---------------- 执行批量删除 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deletePostRequest(id) {
  const res = await fetch('/api/posts/' + encodeURIComponent(id), { method: 'DELETE' });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 上游成功时可能没有响应体 */ }
  if (res.ok) return { ok: true };
  return { ok: false, msg: (data && data.message) || `HTTP ${res.status}` };
}

// 上游对删除有频率限制（连发会返回「操作过快」），这类报错是瞬时的，隔一会儿再补一次
async function deleteWithRetry(id) {
  const r = await deletePostRequest(id);
  if (r.ok) return r;
  if (!/过快|频繁|too fast|too many|rate|限流|429/i.test(r.msg || '')) return r;
  await sleep(DELETE_RETRY_GAP_MS);
  return deletePostRequest(id);
}

function deletePreviewLine(p) {
  const nick = (p.user && p.user.nickname) || '我';
  const txt = String(p.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${nick}：${txt || '（无正文）'}`;
}

async function confirmBatchDelete() {
  if (state.deleting) return;
  const posts = markedForDelete();
  if (!posts.length) { toast('请先勾选要删除的行'); return; }
  const n = posts.length;

  // 二次确认：把即将删掉的内容列出来，让人再看一眼
  const agreed = await askConfirm({
    title: '确认删除',
    message: `即将删除 ${n} 条动态，删除后无法恢复。请最后确认：`,
    items: posts.slice(0, 5).map(deletePreviewLine).concat(n > 5 ? [`… 等共 ${n} 条`] : []),
    okText: `确认删除 ${n} 条`,
  });
  if (!agreed) return;

  state.deleting = true;
  updateDeleteUI();
  const deleted = [];
  const failed = [];
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    let r;
    try { r = await deleteWithRetry(p.id); } catch (e) { r = { ok: false, msg: e.message }; }
    if (r.ok) deleted.push(p.id);
    else failed.push({ id: p.id, msg: r.msg });
    if (i < posts.length - 1) await sleep(DELETE_GAP_MS); // 拉开节奏，避开上游的频率限制
  }

  // 删成功的直接从本地列表摘掉，界面立刻生效，不必再等一次网络刷新
  if (deleted.length) {
    const gone = new Set(deleted);
    state.posts = state.posts.filter((p) => !gone.has(p.id));
    deleted.forEach((id) => { state.deleteIds.delete(id); state.favIds.delete(id); });
  }
  state.deleting = false;

  if (failed.length) {
    // 失败的保持勾选，方便直接再点一次「确认删除」重试
    state.deleteIds = new Set(failed.map((f) => f.id));
    state.error = `有 ${failed.length} 条动态删除失败：${failed[0].msg}`;
    toast(`删除 ${deleted.length} 条，失败 ${failed.length} 条（${failed[0].msg}）`);
  } else {
    state.deleteMode = false;
    state.deleteIds = new Set();
    toast(`已删除 ${deleted.length} 条动态`);
  }

  // 本地列表被删空时补一页，避免表格空着
  if (deleted.length && !state.posts.length) {
    render();
    await fetchPage(true);
    return;
  }
  render();
}

/* ---------------- 导出 CSV ---------------- */
function exportCsv() {
  const list = filteredPosts();
  const cols = visibleColumns();
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [['行号', ...cols.map((c) => c.label)].map(esc).join(',')];
  list.forEach((post, i) => {
    lines.push([i + 1, ...cols.map((c) => {
      const cell = renderCell(c, post);
      return esc(cell.text || '');
    })].join(','));
  });
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const srcLabel = activeSheet().label || '数据';
  a.download = `simple_${srcLabel}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${list.length} 行`);
}

/* ---------------- 列选择面板 ---------------- */
function toggleColPanel() {
  const hidden = colPanel.classList.toggle('hidden');
  if (!hidden) {
    const rect = colBtn.getBoundingClientRect();
    const pw = colPanel.offsetWidth || 180;
    const ph = colPanel.offsetHeight || 200;
    colPanel.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - pw - 8)) + 'px';
    colPanel.style.top = Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - ph - 8)) + 'px';
  }
}

function buildColPanel() {
  colPanel.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">显示列</div>';
  COLUMNS.forEach((col) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.visible.has(col.key);
    cb.addEventListener('change', () => {
      if (cb.checked) state.visible.add(col.key);
      else state.visible.delete(col.key);
      try { localStorage.setItem('simple_sheet_cols', JSON.stringify([...state.visible])); } catch (_) {}
      render();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(col.label));
    colPanel.appendChild(label);
  });
}

/* ---------------- 登录 / 退出 ---------------- */
function updateAuthUI() {
  const info = $('userInfo');
  if (state.user && state.user.id) {
    info.textContent = `已登录：${state.user.nickname || state.user.id}（simple_id: ${state.user.simple_id ?? '-'}）`;
    loginBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
  } else {
    info.textContent = '未登录';
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
  }
}

async function openLoginModal() {
  loginTokenInput.value = '';
  loginCurrent.textContent = '检测中…';
  loginModal.classList.remove('hidden');
  loginTokenInput.focus();
  try {
    const res = await fetch('/api/login', { method: 'POST' });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.ok && data && data.id) {
      loginCurrent.textContent = `当前配置的账号：${data.nickname || data.id}（simple_id: ${data.simple_id ?? '-'}）`;
    } else {
      loginCurrent.textContent = '未检测到有效账号（token 可能已失效），可粘贴新 token 登录';
    }
  } catch (_) {
    loginCurrent.textContent = '未检测到有效账号，可粘贴新 token 登录';
  }
}

async function submitLogin() {
  const token = loginTokenInput.value.trim();
  loginSubmit.disabled = true;
  try {
    let res;
    if (token) {
      res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } else {
      res = await fetch('/api/login', { method: 'POST' });
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.message) || `HTTP ${res.status}`);
    state.user = data;
    updateAuthUI();
    loginModal.classList.add('hidden');
    await refreshFavourites(true); // 登录后 token 变了，强制重取
    render();
    toast(`已登录：${data.nickname || data.id}`);
  } catch (e) {
    toast('登录失败：' + e.message);
  } finally {
    loginSubmit.disabled = false;
  }
}

async function handleLogout() {
  try {
    const res = await fetch('/api/logout', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.user = null;
    state.favIds = new Set();
    state.favLoaded = false;
    favFetchedAt = 0;
    state.posts.forEach((p) => { p.is_favourited = false; });
    updateAuthUI();
    render();
    toast('已退出登录');
  } catch (e) {
    toast('退出失败：' + e.message);
  }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  refreshBtn.addEventListener('click', () => fetchPage(true));

  // 外观面板：白天/黑夜 + 配色
  themeToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    themePanel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!themePanel.classList.contains('hidden') && !themeMenu.contains(e.target)) {
      themePanel.classList.add('hidden');
    }
  });
  themeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    applyTheme(btn.dataset.mode);
    saveThemePrefs();
  });
  themeSwatches.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-swatch');
    if (!btn) return;
    applyTheme(null, btn.dataset.key);
    saveThemePrefs();
  });

  loginBtn.addEventListener('click', openLoginModal);
  logoutBtn.addEventListener('click', handleLogout);

  // 登录对话框
  const copyTokenCmdBtn = $('copyTokenCmdBtn');
  if (copyTokenCmdBtn) {
    copyTokenCmdBtn.addEventListener('click', async () => {
      const cmd = "copy(JSON.parse(JSON.parse(localStorage.getItem('flutter.UserInfo'))).token)";
      try {
        await navigator.clipboard.writeText(cmd);
        toast('命令已复制，去浏览器控制台粘贴并回车');
      } catch (_) {
        toast('复制失败，请手动选中复制');
      }
    });
  }
  loginSubmit.addEventListener('click', submitLogin);
  loginCancel.addEventListener('click', () => loginModal.classList.add('hidden'));
  loginModalClose.addEventListener('click', () => loginModal.classList.add('hidden'));
  loginModal.addEventListener('click', (e) => {
    if (e.target === loginModal) loginModal.classList.add('hidden');
  });

  // 关于弹窗
  aboutModalClose.addEventListener('click', () => aboutModal.classList.add('hidden'));
  aboutModal.addEventListener('click', (e) => {
    if (e.target === aboutModal) aboutModal.classList.add('hidden');
  });
  loginTokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitLogin();
    }
  });

  exportBtn.addEventListener('click', exportCsv);

  // 文件菜单
  fileMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!fileDropdown.classList.contains('hidden') && !fileDropdown.contains(e.target)) {
      fileDropdown.classList.add('hidden');
    }
  });
  fileDropdown.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    fileDropdown.classList.add('hidden');
    if (act === 'refresh') fetchPage(true);
    else if (act === 'export') exportCsv();
    else if (act === 'cols') toggleColPanel();
    else if (act === 'about') aboutModal.classList.remove('hidden');
  });

  // 菜单栏页签（仿真切换）
  menuBar.querySelectorAll('.menu-tab[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      menuBar.querySelectorAll('.menu-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });

  // 剪贴板
  copyRowBtn.addEventListener('click', () => {
    if (!state.selectedPost) { toast('请先点击表格中的一行'); return; }
    const cols = visibleColumns();
    const parts = cols.map((c) => { const cell = renderCell(c, state.selectedPost); return cell.text || ''; });
    const text = [(state.selectedIdx + 1), ...parts].join('\t');
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    toast(`已复制第 ${state.selectedIdx + 1} 行`);
  });
  pasteDemoBtn.addEventListener('click', () => toast('仿真按钮：仅用于界面展示'));
  brushDemoBtn.addEventListener('click', () => toast('仿真按钮：仅用于界面展示'));

  // 左对齐 / 居中 / 右对齐：作用于当前选中列，未选中任何单元格时作用于所有可见列
  Object.keys(ALIGN_BTNS).forEach((k) => {
    const btn = ALIGN_BTNS[k];
    if (btn) btn.addEventListener('click', () => applyAlign(k));
  });

  // 批量删除：只在「我的」工作表可用（其它工作表里按钮置灰）
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      if (!canDeleteHere()) { toast('删除只适用于「我的」工作表'); return; }
      if (state.deleteMode) exitDeleteMode();
      else enterDeleteMode();
    });
  }
  if (deleteConfirmBtn) deleteConfirmBtn.addEventListener('click', confirmBatchDelete);
  if (deleteCancelBtn) deleteCancelBtn.addEventListener('click', exitDeleteMode);
  // 表头「全选」：删除列是每次重渲染出来的，用事件委托接住
  sheetHead.addEventListener('change', (e) => {
    const cb = e.target && e.target.closest ? e.target.closest('#deleteSelectAll') : null;
    if (cb) toggleAllForDelete(cb.checked);
  });
  // 二次确认弹窗
  $('confirmOk').addEventListener('click', () => closeConfirm(true));
  $('confirmCancel').addEventListener('click', () => closeConfirm(false));
  $('confirmClose').addEventListener('click', () => closeConfirm(false));
  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) closeConfirm(false);
  });

  // 换行开关
  wrapBtn.addEventListener('click', () => {
    state.wrapContent = !state.wrapContent;
    applyWrap();
    saveViewPrefs();
    toast(state.wrapContent ? '内容列：自动换行' : '内容列：单行省略');
  });

  // 工作表页签：页签是动态生成的，用事件委托统一处理切换 / 关闭
  if (sheetTabsEl) {
    sheetTabsEl.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.sheet-tab-close');
      if (closeBtn) {
        e.stopPropagation();
        closeSheet(closeBtn.dataset.closeKey);
        return;
      }
      const tab = e.target.closest('.sheet-tab');
      if (tab && tab.dataset.sheetKey) switchSheet(tab.dataset.sheetKey);
    });
  }
  // 「＋」只是界面仿真：真正新增工作表的方式是点表格里的头像
  const addSheetTab = document.querySelector('.sheet-tab-add');
  if (addSheetTab) addSheetTab.addEventListener('click', () => toast('点击表格里的头像，即可把该用户的主页加成工作表'));

  // 页面缩放：状态栏按钮 + Ctrl+滚轮
  zoomOutPage.addEventListener('click', () => setPageZoom(state.pageZoom - 0.1));
  zoomInPage.addEventListener('click', () => setPageZoom(state.pageZoom + 0.1));
  document.querySelector('.sheet-wrap').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setPageZoom(state.pageZoom + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: false });

  colBtn.addEventListener('click', (e) => {
    toggleColPanel();
    e.stopPropagation();
  });

  // 点赞和回复
  notifyBtn.addEventListener('click', openNotifications);
  $('notifyClose').addEventListener('click', () => notifyModal.classList.add('hidden'));
  notifyModal.addEventListener('click', (e) => {
    if (e.target === notifyModal) notifyModal.classList.add('hidden');
  });
  notifyMore.addEventListener('click', () => loadNotifications(false));
  notifyRefresh.addEventListener('click', () => loadNotifications(true));
  // 点击「查看原帖」：关闭通知弹窗，打开原帖详情（含内容/媒体/评论）
  notifyList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.notify-jump');
    if (!btn) return;
    const postId = btn.getAttribute('data-post-id');
    if (!postId) return;
    const item = notify.list.find((n) => n && n.post_id === postId) || null;
    notifyModal.classList.add('hidden');
    const reqId = ++previewReqId;
    // 表格里若已有该帖，先用本地数据即时渲染（含媒体）
    const local = state.posts.find((p) => p.id === postId) || null;
    // 点赞 / 评论通知里的 to_content、to_media 就是原帖正文与媒体，可作兜底
    const postLevel = item && (item.action === 'vote' || item.action === 'comment');
    const cached = postLevel ? { id: postId, content: item.to_content || '', media: item.to_media || [] } : null;
    const initial = local || cached;
    openComments(initial || { id: postId }, { showBack: true, showPost: true });
    try {
      const full = await fetchPostById(postId);
      if (reqId !== previewReqId) return;
      // 单帖接口不返回 media / tags，用本地表格数据或通知里的原帖信息补齐，保证展示完整
      const merged = Object.assign({}, full);
      ['content', 'media', 'tags'].forEach((k) => {
        const cur = merged[k];
        const empty = Array.isArray(cur) ? !cur.length : (cur == null || cur === '');
        if (!empty) return;
        const src = (local && local[k]) || (cached && cached[k]);
        if (Array.isArray(src) ? src.length : (src != null && src !== '')) merged[k] = src;
      });
      const cur = comments.post; // openComments 已经把这次先渲染用的数据放进来了
      comments.post = merged;
      if (previewNeedsUpdate(cur, merged)) renderPostPreview(merged);
      else updatePreviewActions(merged); // 只同步点赞 / 收藏按钮，不动已经渲染好的媒体
    } catch (err) {
      if (reqId !== previewReqId || initial) return;
      postPreview.innerHTML = `<div class="comments-error">原帖加载失败：${escapeHtml(err.message)}</div>`;
    }
  });

  // 返回按钮：关闭评论弹窗，重新打开通知弹窗
  modalBack.addEventListener('click', () => {
    modal.classList.add('hidden');
    openNotifications();
  });

  // 原帖详情里的点赞 / 收藏（状态写回 comments.post，并同步到表格里的同一条帖子）
  postPreview.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pp-action]');
    if (!btn || btn.disabled) return;
    const post = comments.post;
    if (!post || !post.id) return;
    await toggleAction(post, btn.dataset.ppAction, btn);
    updatePreviewActions(post);
  });

  // 媒体点击的唯一入口：表格那一路自己 stopPropagation，不会走到这里；原帖详情 / 评论区 /
  // 通知列表等所有地方都靠这一处，新加的地方只要渲染出 [data-kind] 就能直接点开，不会漏绑。
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (imageModal.contains(t)) return; // 灯箱内部（视频控件、播放按钮）不重复处理
    const el = t.closest('[data-kind]');
    if (!el) return;
    openMedia(el, mediaScopeOf(el));
  });

  // 评论区 / 点赞和回复里的头像：关掉弹窗，跳到该用户的主页工作表
  const hideCommentsModal = () => modal.classList.add('hidden');
  const hideNotifyModal = () => notifyModal.classList.add('hidden');
  bindAvatarJump(commentsList, hideCommentsModal);   // 评论 / 回复的头像
  bindAvatarJump(notifyList, hideNotifyModal);       // 点赞和回复列表的头像
  bindAvatarJump(postPreview, hideCommentsModal);    // 原帖详情里作者的头像
  document.addEventListener('click', (e) => {
    if (!colPanel.classList.contains('hidden') && !colPanel.contains(e.target) && e.target !== colBtn) {
      colPanel.classList.add('hidden');
    }
  });

  // 列宽拖动调整（Excel 风格）
  sheetHead.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.col-resizer');
    if (!handle) return;
    const th = handle.closest('th');
    const colKey = th && th.dataset.colKey;
    const col = colKey && COLUMNS.find((c) => c.key === colKey);
    if (!col) return;
    e.preventDefault();
    e.stopPropagation();
    resize.active = true;
    resize.col = col;
    resize.th = th;
    resize.startX = e.clientX;
    resize.startW = state.colWidths[col.key] || col.width;
    document.body.classList.add('resizing-cols');
  });
  document.addEventListener('mousemove', (e) => {
    if (!resize.active) return;
    const scale = state.pageZoom || 1;
    const w = Math.max(COL_MIN_W, Math.min(COL_MAX_W, resize.startW + (e.clientX - resize.startX) / scale));
    resize.th.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!resize.active) return;
    resize.active = false;
    document.body.classList.remove('resizing-cols');
    const w = parseFloat(resize.th.style.width) || resize.startW;
    state.colWidths[resize.col.key] = w;
    try { localStorage.setItem('simple_sheet_col_widths', JSON.stringify(state.colWidths)); } catch (_) {}
  });

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchInput.value;
      render();
    }, 200);
  });

  $('modalClose').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  // 评论：发送 + 加载更多 + Enter 快捷发送
  commentsSend.addEventListener('click', sendComment);
  commentsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendComment();
    }
  });
  commentsMore.addEventListener('click', () => {
    if (comments.post) loadComments(comments.post, false);
  });

  // 评论点赞（一级评论与回复都支持）
  commentsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vote-comment]');
    if (!btn) return;
    const target = findCommentById(btn.getAttribute('data-vote-comment'));
    if (target) toggleCommentVote(target, btn);
  });

  // 点击评论进入回复模式，点击空白处取消
  commentsList.addEventListener('click', (e) => {
    // 点赞按钮、评论媒体（图片/视频/语音）、头像（跳用户主页）都不进入回复模式
    if (e.target.closest('[data-vote-comment]') || e.target.closest('[data-kind]') || e.target.closest('.comment-avatar-link')) return;
    const item = e.target.closest('.comment-item, .comment-reply');
    if (item && item.dataset.commentId) {
      const target = findCommentById(item.dataset.commentId);
      if (target) setReplyTarget(target);
    } else if (comments.replyTo) {
      setReplyTarget(null);
    }
  });

  // 媒体查看：点背景 / 关闭按钮 / Esc 关闭
  $('imageModalClose').addEventListener('click', closeImageModal);
  mediaPrev.addEventListener('click', () => mediaStep(-1));
  mediaNext.addEventListener('click', () => mediaStep(1));
  imageModal.addEventListener('click', (e) => {
    if (e.target === imageModal) closeImageModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 二次确认弹窗在最上层，Esc 先关它（等同于「取消」）
      if (!confirmModal.classList.contains('hidden')) { closeConfirm(false); return; }
      closeImageModal();
      modal.classList.add('hidden');
      aboutModal.classList.add('hidden');
      notifyModal.classList.add('hidden');
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (imageModal.classList.contains('hidden')) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      e.preventDefault();
      mediaStep(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  // 图片缩放：滚轮放大缩小（只在灯箱打开图片时生效）
  const stage = imageModalMedia;
  stage.addEventListener('wheel', (e) => {
    if (!zoomImg) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const ns = Math.max(1, Math.min(8, zoom.scale * factor));
    zoom.tx *= ns / zoom.scale;
    zoom.ty *= ns / zoom.scale;
    zoom.scale = ns;
    clampPan();
    applyZoom();
  }, { passive: false });

  // 双击图片重置缩放
  stage.addEventListener('dblclick', () => {
    if (zoomImg) resetZoom();
  });

  // 放大后拖拽平移
  stage.addEventListener('mousedown', (e) => {
    if (!zoomImg || zoom.scale <= 1) return;
    zoom.dragging = true;
    zoom.startX = e.clientX;
    zoom.startY = e.clientY;
    zoom.origTx = zoom.tx;
    zoom.origTy = zoom.ty;
    stage.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!zoom.dragging) return;
    zoom.tx = zoom.origTx + (e.clientX - zoom.startX);
    zoom.ty = zoom.origTy + (e.clientY - zoom.startY);
    clampPan();
    applyZoom();
  });
  window.addEventListener('mouseup', () => {
    zoom.dragging = false;
    stage.classList.remove('dragging');
  });

  // 缩放按钮
  zoomInBtn.addEventListener('click', () => {
    if (!zoomImg) return;
    zoom.scale = Math.min(8, zoom.scale * 1.2);
    clampPan();
    applyZoom();
  });
  zoomOutBtn.addEventListener('click', () => {
    if (!zoomImg) return;
    zoom.scale = Math.max(1, zoom.scale / 1.2);
    clampPan();
    applyZoom();
  });
  zoomResetBtn.addEventListener('click', () => {
    if (zoomImg) resetZoom();
  });

  // Excel 风格键盘导航：方向键在单元格间移动，Home/End 到首尾列，PgUp/PgDn 翻页，Enter 上下移动
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'Home') { e.preventDefault(); selectCell(0, 0); }
      else if (e.key === 'End') { e.preventDefault(); selectCell(filteredPosts().length - 1, visibleColumns().length - 1); }
      return;
    }
    if (e.altKey) return;
    const ae = document.activeElement;
    const tag = (ae && ae.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae && ae.isContentEditable)) return;
    // 弹窗打开时不干扰弹窗内的操作
    if (!imageModal.classList.contains('hidden') || !modal.classList.contains('hidden') ||
        !notifyModal.classList.contains('hidden') || !loginModal.classList.contains('hidden') ||
        !aboutModal.classList.contains('hidden') || !confirmModal.classList.contains('hidden')) return;
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); moveSelection(-1, 0); break;
      case 'ArrowDown': e.preventDefault(); moveSelection(1, 0); break;
      case 'ArrowLeft': e.preventDefault(); moveSelection(0, -1); break;
      case 'ArrowRight': e.preventDefault(); moveSelection(0, 1); break;
      case 'Home': e.preventDefault(); moveSelection(0, -visibleColumns().length); break;
      case 'End': e.preventDefault(); moveSelection(0, visibleColumns().length); break;
      case 'PageUp': e.preventDefault(); moveSelection(-pageRowStep(), 0); break;
      case 'PageDown': e.preventDefault(); moveSelection(pageRowStep(), 0); break;
      case 'Enter':
        // 焦点在按钮等控件上时，Enter 仍用于激活该控件
        if (ae && ae !== document.body && !ae.closest('.sheet-wrap')) return;
        e.preventDefault();
        moveSelection(e.shiftKey ? -1 : 1, 0);
        break;
      default: break;
    }
  });

  // 懒加载：滚动 + 底部按钮兜底
  document.querySelector('.sheet-wrap').addEventListener('scroll', () => maybeLoadMore(), { passive: true });
  loadMoreBtn.addEventListener('click', () => fetchPage(false));
}

/* ---------------- 初始化 ---------------- */
async function init() {
  try {
    const stored = localStorage.getItem('simple_sheet_cols');
    if (stored) {
      const keys = JSON.parse(stored);
      if (Array.isArray(keys) && keys.length) state.visible = new Set(keys.filter((k) => COLUMNS.some((c) => c.key === k)));
    }
  } catch (_) {}

  try {
    const widths = localStorage.getItem('simple_sheet_col_widths');
    if (widths) {
      const obj = JSON.parse(widths);
      if (obj && typeof obj === 'object') {
        state.colWidths = {};
        Object.keys(obj).forEach((k) => {
          const v = obj[k];
          if (COLUMNS.some((c) => c.key === k) && typeof v === 'number' && v >= COL_MIN_W && v <= COL_MAX_W) {
            state.colWidths[k] = v;
          }
        });
      }
    }
  } catch (_) {}

  // 新增列（点赞/头像）：首次加载默认显示，之后尊重用户的显隐选择
  try {
    if (!localStorage.getItem('simple_likes_col_init')) {
      state.visible.add('likes');
      localStorage.setItem('simple_sheet_cols', JSON.stringify([...state.visible]));
      localStorage.setItem('simple_likes_col_init', '1');
    }
    if (!localStorage.getItem('simple_avatar_col_init')) {
      state.visible.add('avatar');
      localStorage.setItem('simple_sheet_cols', JSON.stringify([...state.visible]));
      localStorage.setItem('simple_avatar_col_init', '1');
    }
  } catch (_) {}

  buildColPanel();
  bindEvents();
  loadViewPrefs();
  applyWrap();
  render();
  setPageZoom(state.pageZoom);

  // 首屏数据与登录态并行请求：不再被 /api/status、/api/me 串行挡住
  const firstPage = fetchPage(true);
  const bootstrap = (async () => {
    const [st, me] = await Promise.allSettled([
      fetch('/api/status').then((r) => r.json()),
      fetch('/api/me?refresh=1').then((r) => (r.ok ? r.json() : null)),
    ]);
    if (st.status === 'fulfilled' && st.value && !st.value.hasToken) {
      state.error = '尚未配置 token：请编辑 config.json';
      render();
    }
    if (me.status === 'fulfilled' && me.value) state.user = me.value;
    updateAuthUI();
  })();
  await Promise.all([firstPage, bootstrap]);
}

init();
