'use strict';

/* ---------------- 列定义 ---------------- */
const COLUMNS = [
  { key: 'user.nickname',   label: '昵称',     width: 120 },
  { key: 'avatar',          label: '头像',     width: 64, avatar: true },
  { key: 'created_at',      label: '发布时间', width: 168 },
  { key: 'user.gender',     label: '性别',     width: 64  },
  { key: 'content',         label: '内容',     width: 380 },
  { key: 'media',           label: '媒体',     width: 210, media: true },
  { key: 'tags',            label: '标签',     width: 140 },
  { key: 'comments_count',  label: '评论数',   width: 72, numeric: true },
  { key: 'likes',           label: '点赞',     width: 76, likes: true },
  { key: 'favourites',      label: '收藏',     width: 76, favourites: true },
];

const GENDER_MAP = { male: '男', female: '女' };

const COL_MIN_W = 40;
const COL_MAX_W = 800;
const resize = { active: false, col: null, th: null, startX: 0, startW: 0 };

/* ---------------- 状态 ---------------- */
const state = {
  source: 'posts',
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
  colWidths: {},
  pageZoom: 1,
  wrapContent: true,
  selectedIdx: -1,
  selectedPost: null,
  selectedColKey: null,
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

/* ---------------- 图片缩放状态 ---------------- */
const zoom = { scale: 1, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0, origTx: 0, origTy: 0 };
let zoomImg = null;

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const sheetHead = $('sheetHead');
const sheetBody = $('sheetBody');
const sentinel = $('sentinel');
const loadMoreBtn = $('loadMoreBtn');
const statusMode = $('statusMode');
const statusCount = $('statusCount');
const statusSource = $('statusSource');
const statusTime = $('statusTime');
const errorBar = $('errorBar');
const searchInput = $('searchInput');
const refreshBtn = $('refreshBtn');
const exportBtn = $('exportBtn');
const colBtn = $('colBtn');
const colPanel = $('colPanel');
const modal = $('detailModal');

const commentsPanel = $('commentsPanel');
const commentsList = $('commentsList');
const commentsCount = $('commentsCount');
const commentsMore = $('commentsMore');
const commentsInput = $('commentsInput');
const commentsSend = $('commentsSend');
const toastEl = $('toast');
const imageModal = $('imageModal');
const imageModalMedia = $('imageModalMedia');
const imageModalLink = $('imageModalLink');
const zoomLabel = $('zoomLabel');
const zoomInBtn = $('zoomInBtn');
const zoomOutBtn = $('zoomOutBtn');
const zoomResetBtn = $('zoomResetBtn');
const sheet = $('sheet');
const nameBox = $('nameBox');
const formulaInput = $('formulaInput');
const zoomOutPage = $('zoomOutPage');
const zoomInPage = $('zoomInPage');
const zoomPct = $('zoomPct');
const wrapBtn = $('wrapBtn');
const copyRowBtn = $('copyRowBtn');
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const loginModal = $('loginModal');
const loginCurrent = $('loginCurrent');
const loginTokenInput = $('loginTokenInput');
const loginSubmit = $('loginSubmit');
const loginCancel = $('loginCancel');
const loginModalClose = $('loginModalClose');
const pasteDemoBtn = $('pasteDemoBtn');
const brushDemoBtn = $('brushDemoBtn');
const sheetTabPlaza = $('sheetTabPlaza');
const fileMenuBtn = $('fileMenuBtn');
const fileDropdown = $('fileDropdown');
const menuBar = $('menuBar');

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
    const resized = raw + (raw.includes('?') ? '&' : '?') + 'imageView2/2/w/80';
    const html = raw
      ? `<img class="avatar-img" src="${escAttr(mediaProxyUrl(resized))}" alt="" title="${escAttr(nick)}">`
      : `<span class="avatar-img avatar-fallback" title="${escAttr(nick)}">${escAttr(String((nick || '?').charAt(0)).toUpperCase())}</span>`;
    return { text: nick, title: nick, html };
  }
  const v = getVal(post, col.key);
  if (v == null) return { text: '', title: '', html: null };
  if (col.key === 'created_at') return { text: fmtTime(v), title: v, html: null };
  if (col.key === 'user.gender') return { text: GENDER_MAP[v] || v || '', title: v, html: null };

  if (col.media) {
    const items = Array.isArray(v) ? v : [];
    let html = '';
    const urls = [];
    items.forEach((m) => {
      if (!m || !m.url) return;
      urls.push(m.url);
      if (m.type === 'image') {
        const thumb = mediaProxyUrl(m.url + '?imageView2/2/w/300');
        html += `<img class="thumb" loading="lazy" src="${escAttr(thumb)}" data-kind="image" data-url="${escAttr(m.url)}" alt="">`;
      } else if (m.type === 'video' || m.type === 'live_photo') {
        const posterRaw = m.thumbnail_url || m.url;
        const poster = mediaProxyUrl(posterRaw + '?imageView2/2/w/300');
        html += `<span class="thumb-wrap" data-kind="${m.type}" data-url="${escAttr(m.url)}" data-poster="${escAttr(m.thumbnail_url || '')}">`
          + `<img class="thumb" loading="lazy" src="${escAttr(poster)}" alt="">`
          + `<i class="play-badge">▶</i>`
          + `<b class="type-label">${m.type === 'live_photo' ? '实况' : '视频'}</b>`
          + `</span>`;
      } else if (m.type === 'audio') {
        html += `<span class="thumb-audio" data-kind="audio" data-url="${escAttr(m.url)}">♪ 音频</span>`;
      } else {
        html += `<span class="media-tag">${escAttr(m.type)}</span>`;
      }
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
  if (col.key === 'root_channel') {
    const t = typeof v === 'object' && v ? (v.name || v.id || '') : v;
    return { text: String(t), title: String(t), html: null };
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

function openMedia(el) {
  const kind = el.dataset.kind;
  const url = el.dataset.url;
  const poster = el.dataset.poster || '';
  let inner = '';
  if (kind === 'image') {
    inner = `<img src="${escAttr(mediaProxyUrl(url))}" alt="原图">`;
  } else if (kind === 'video' || kind === 'live_photo') {
    inner = `<video src="${escAttr(mediaProxyUrl(url))}"${poster ? ` poster="${escAttr(mediaProxyUrl(poster))}"` : ''} controls autoplay playsinline></video>`;
  } else if (kind === 'audio') {
    inner = `<audio src="${escAttr(mediaProxyUrl(url))}" controls autoplay></audio>`;
  }
  imageModalMedia.innerHTML = inner;
  if (kind === 'image') {
    setupImageZoom(imageModalMedia.querySelector('img'));
  } else {
    zoomImg = null;
    zoomLabel.textContent = '×1.0';
    imageModalMedia.classList.remove('zoomed', 'dragging');
  }
  imageModalLink.href = mediaProxyUrl(url);
  imageModal.classList.remove('hidden');
}

function closeImageModal() {
  imageModal.classList.add('hidden');
  imageModalMedia.innerHTML = '';
  zoomImg = null;
  zoom.dragging = false;
  zoomLabel.textContent = '×1.0';
}

/* ---------------- 数据 ---------------- */
async function fetchPage(reset) {
  if (state.loading) return;
  if (!reset && !state.hasMore) return;
  state.loading = true;
  state.error = '';
  setLoadingUI(true);
  updateSentinel();

  const params = new URLSearchParams({ source: state.source, per_page: String(state.perPage) });
  if (reset) params.set('refresh', '1'); // 手动刷新绕过服务端缓存
  if (!reset && state.lastId) params.set('last_id', state.lastId);

  try {
    const res = await fetch('/api/posts?' + params.toString());
    let data;
    try { data = await res.json(); } catch (_) { data = null; }
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
    state.error = e.message;
  } finally {
    state.loading = false;
    setLoadingUI(false);
    render();
  }
}

async function refreshFavourites() {
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
  state.posts.forEach((p) => { p.is_favourited = ids.has(p.id); });
  render();
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
    if (data && typeof data === 'object') {
      if (typeof data.is_voted === 'boolean') post.is_voted = data.is_voted;
      if (typeof data.is_favourited === 'boolean') post.is_favourited = data.is_favourited;
      if (typeof data.votes_count === 'number') post.votes_count = data.votes_count;
    } else {
      post[flag] = !on;
    }
    if (flag === 'is_favourited') {
      if (post.is_favourited) state.favIds.add(post.id);
      else state.favIds.delete(post.id);
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
  statusMode.textContent = loading ? '正在加载…' : (state.error ? '出错' : '就绪');
}

/* ---------------- 懒加载 ---------------- */
function updateSentinel() {
  if (state.loading) {
    loadMoreBtn.textContent = '加载中…';
    loadMoreBtn.disabled = true;
  } else if (!state.hasMore) {
    loadMoreBtn.textContent = '已加载全部';
    loadMoreBtn.disabled = true;
  } else {
    loadMoreBtn.textContent = '滚动到底部自动加载更多（也可点击）';
    loadMoreBtn.disabled = false;
  }
}

function maybeLoadMore() {
  if (state.loading || !state.hasMore) return;
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
    const dir = state.sortDir;
    list = [...list].sort((a, b) => {
      let va = getVal(a, state.sortKey);
      let vb = getVal(b, state.sortKey);
      if (col && col.numeric) {
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
  cols.forEach((col, i) => {
    const th = document.createElement('th');
    th.className = 'sortable';
    th.dataset.colKey = col.key;
    th.style.width = (state.colWidths[col.key] || col.width) + 'px';
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
    td.colSpan = cols.length + 1;
    td.textContent = state.loading ? '加载中…' : (state.posts.length ? '没有匹配的行' : '暂无数据，点击「手动刷新」开始加载');
    td.style.cssText = 'text-align:center;color:#999;padding:30px 0;';
    tr.appendChild(td);
    frag.appendChild(tr);
  } else {
    list.forEach((post, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.idx = String(idx);
      const num = document.createElement('td');
      num.className = 'row-num';
      num.textContent = String(idx + 1);
      tr.appendChild(num);
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
        td.dataset.raw = cell.title || cell.text;
        td.dataset.col = col.label;
        td.dataset.colKey = col.key;
        td.addEventListener('dblclick', () => {
          navigator.clipboard && navigator.clipboard.writeText(td.dataset.raw);
          toast(`已复制：${td.dataset.raw.slice(0, 40)}`);
        });
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
  statusSource.textContent = '广场';
  statusTime.textContent = state.lastUpdate ? '更新于 ' + fmtTime(state.lastUpdate) : '尚未刷新';
}

function updateSelectionUI() {
  if (state.selectedPost == null) return;
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

function setPageZoom(v) {
  state.pageZoom = Math.max(0.7, Math.min(1.5, v));
  document.documentElement.style.setProperty('--sheet-zoom', String(state.pageZoom));
  zoomPct.textContent = Math.round(state.pageZoom * 100) + '%';
}

function renderError() {
  if (state.error) {
    errorBar.classList.remove('hidden');
    errorBar.innerHTML = `<span>⚠ ${state.error}</span><button class="btn" id="errorClose">关闭</button>`;
    $('errorClose').addEventListener('click', () => {
      state.error = '';
      errorBar.classList.add('hidden');
    });
  } else {
    errorBar.classList.add('hidden');
  }
}

function render() {
  renderHead();
  renderBody();
  renderError();
  updateSentinel();
  // 每次渲染后检查是否还需要补页（处理首屏内容不够高、无法滚动的情况）
  requestAnimationFrame(maybeLoadMore);
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
function openComments(post) {
  comments.post = post;
  commentsCount.textContent = '';
  commentsInput.value = '';
  setReplyTarget(null);
  modal.classList.remove('hidden');
  if (!Number(post.comments_count)) {
    comments.list = [];
    comments.lastId = '';
    comments.hasMore = false;
    commentsList.innerHTML = '<div class="comments-empty">没有评论</div>';
    commentsMore.classList.add('hidden');
    return;
  }
  loadComments(post, true);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 评论 ---------------- */
let commentsReqId = 0;

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
    renderComments();
  } catch (e) {
    if (reqId !== commentsReqId) return;
    commentsList.innerHTML = `<div class="comments-error">评论加载失败：${escapeHtml(e.message)}</div>`;
  } finally {
    if (reqId === commentsReqId) comments.loading = false;
  }
}

function commentHtml(c) {
  const u = c.user || {};
  const name = u.nickname || u.id || '匿名';
  const time = fmtTime(c.created_at);
  const badge = (c.is_pinned ? '<em class="comment-pin">置顶</em>' : '') + (c.is_owner ? '<em class="comment-mine">我</em>' : '');
  const avatar = u.avatar_url
    ? `<img class="comment-avatar" src="${escAttr(mediaProxyUrl(u.avatar_url))}" alt="">`
    : `<span class="comment-avatar comment-avatar-fallback">${escAttr(String(name[0] || '?').toUpperCase())}</span>`;
  let replies = '';
  if (Array.isArray(c.preview_replies) && c.preview_replies.length) {
    replies = `<div class="comment-replies">${c.preview_replies.map(replyHtml).join('')}</div>`;
  }
  return `<div class="comment-item" data-comment-id="${escAttr(c.id)}">${avatar}<div class="comment-main">
      <div class="comment-meta"><span class="comment-name">${escAttr(name)}</span>${badge}<span class="comment-time">${escAttr(time)}</span></div>
      <div class="comment-content">${escapeHtml(c.content || '')}</div>
      ${replies}
    </div></div>`;
}

function replyHtml(r) {
  const u = r.user || {};
  const name = u.nickname || u.id || '匿名';
  const time = fmtTime(r.created_at);
  const badge = r.is_owner ? '<em class="comment-mine">我</em>' : '';
  const avatar = u.avatar_url
    ? `<img class="comment-avatar comment-reply-avatar" src="${escAttr(mediaProxyUrl(u.avatar_url))}" alt="">`
    : `<span class="comment-avatar comment-reply-avatar comment-avatar-fallback">${escAttr(String(name[0] || '?').toUpperCase())}</span>`;
  return `<div class="comment-reply" data-comment-id="${escAttr(r.id)}">${avatar}<div class="comment-main">
      <div class="comment-meta"><span class="comment-name">${escAttr(name)}</span>${badge}<span class="comment-time">${escAttr(time)}</span></div>
      <div class="comment-content">${escapeHtml(r.content || '')}</div>
    </div></div>`;
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
  a.download = `simple_广场_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
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
    await refreshFavourites();
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

  loginBtn.addEventListener('click', openLoginModal);
  logoutBtn.addEventListener('click', handleLogout);

  // 登录对话框
  loginSubmit.addEventListener('click', submitLogin);
  loginCancel.addEventListener('click', () => loginModal.classList.add('hidden'));
  loginModalClose.addEventListener('click', () => loginModal.classList.add('hidden'));
  loginModal.addEventListener('click', (e) => {
    if (e.target === loginModal) loginModal.classList.add('hidden');
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
    else if (act === 'about') toast('Simple 广场 · 仿真 WPS 表格');
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

  // 换行开关
  wrapBtn.addEventListener('click', () => {
    state.wrapContent = !state.wrapContent;
    sheet.classList.toggle('wrap-off', !state.wrapContent);
    wrapBtn.classList.toggle('active', state.wrapContent);
    toast(state.wrapContent ? '内容列：自动换行' : '内容列：单行省略');
  });

  // 工作表页签
  sheetTabPlaza.addEventListener('click', () => fetchPage(true));

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

  // 点击评论进入回复模式，点击空白处取消
  commentsList.addEventListener('click', (e) => {
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
  imageModal.addEventListener('click', (e) => {
    if (e.target === imageModal) closeImageModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeImageModal();
      modal.classList.add('hidden');
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
  render();
  setPageZoom(1);

  try {
    const st = await fetch('/api/status');
    const stj = await st.json();
    if (!stj.hasToken) {
      state.error = '尚未配置 token：请编辑 config.json';
      render();
    }
  } catch (_) {}

  try {
    const me = await fetch('/api/me?refresh=1');
    if (me.ok) {
      const u = await me.json();
      state.user = u;
    }
  } catch (_) {}
  updateAuthUI();

  fetchPage(true);
}

init();