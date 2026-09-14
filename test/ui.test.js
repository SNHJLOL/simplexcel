/*
 * 前端回归测试：用 jsdom 加载真实的 index.html + app.js 跑一遍关键交互。
 * 运行：npm test（首次需先 npm install，jsdom 是 devDependency，不影响运行时零依赖）
 * 覆盖：评论区媒体渲染 / 点赞·收藏列排序 / 排序·搜索后选区跟随同一条帖子 /
 *       搜索时暂停自动加载 / 方向键与 Home 导航 / 视频·实况照片打开即播放 /
 *       「查看原帖」的原帖详情媒体与点赞·收藏按钮 / 外观面板（白天黑夜 + 七套配色）
 */
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', 'public');
const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
// 把外链样式内联，这样 jsdom 能解析出 z-index 等计算样式（用于验证弹窗层级）
const html = rawHtml.replace(/<link[^>]*href="style\.css"[^>]*>/, '<style>' + css + '</style>');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:3000/' });
const { window } = dom;
window.Element.prototype.scrollIntoView = function () {};

/* ---- jsdom 没有实现媒体播放，补一个可控的桩 ----
   play() 正常返回 resolved promise；把 playFail 设成 'NotAllowedError' 可模拟浏览器拦下自动播放。
   顺带消掉 jsdom 的 "Not implemented: HTMLMediaElement.prototype.play/pause" 报错噪音。 */
const playCalls = [];
const pauseCalls = [];
const loadCalls = [];
let playFail = null;
window.HTMLMediaElement.prototype.play = function () {
  playCalls.push(this);
  if (playFail) return Promise.reject(new window.DOMException('play blocked', playFail));
  this.paused = false;
  return Promise.resolve();
};
window.HTMLMediaElement.prototype.pause = function () {
  pauseCalls.push(this);
  this.paused = true;
};
// 切到转码后的地址时会调 load()，jsdom 同样没实现，这里补掉噪音
window.HTMLMediaElement.prototype.load = function () { loadCalls.push(this); };

/* ---- 假数据 ---- */
const P = (id, nick, voted, faved, media, tags, count) => ({
  id, is_timed_post: false, visibility: 'public_visibility', is_pinned: false,
  comments_count: count, post_type: 'public_post', comment_permission: 'public_comments',
  created_at: '2026-09-10T10:00:00+08:00', content: '正文 ' + nick, is_voted: voted,
  is_favourited: faved, user: { id: 'u' + id, nickname: nick, gender: 'female', avatar_color: 'abcdef', avatar_url: 'https://static-simple.imsummer.cn/a.png' },
  is_owner: false, is_show: true, is_reviewing: false, media: media || [], tags: tags || [],
});
const POSTS = [
  P('p1', '阿一', true, false, [{ url: 'https://static-simple.imsummer.cn/1.jpg', type: 'image' }], [{ id: 't1', name: '标签A' }], 5),
  P('p2', '阿二', false, true, [], [], 1),
  P('p3', '阿三', false, false, [
    { url: 'https://static-simple.imsummer.cn/1/post/v.mp4', type: 'video', thumbnail_url: 'https://static-simple.imsummer.cn/1/post/v.png' },
    { url: 'https://static-simple.imsummer.cn/1/post/lp.mp4', type: 'live_photo', thumbnail_url: 'https://static-simple.imsummer.cn/1/post/lp.png' },
  ], [], 9),
];
const COMMENTS = [
  { id: 'c1', created_at: '2026-09-10T11:00:00+08:00', content: '带图的评论', is_pinned: false, is_voted: false, is_owner: false, replies_count: 1,
    media: [{ url: 'https://static-simple.imsummer.cn/v.m4a', type: 'audio' }, { url: 'https://static-simple.imsummer.cn/2.jpg', type: 'image' }],
    user: { id: 'u9', nickname: '评论者', avatar_url: 'https://static-simple.imsummer.cn/b.png' },
    preview_replies: [{ id: 'r1', created_at: '2026-09-10T11:05:00+08:00', content: '回复带图', is_owner: false, is_voted: false,
      media: [{ url: 'https://static-simple.imsummer.cn/3.jpg', type: 'image' }],
      user: { id: 'u8', nickname: '回复者', avatar_url: 'https://static-simple.imsummer.cn/c.png' } }] },
  { id: 'c2', created_at: '2026-09-10T11:10:00+08:00', content: '纯文字评论', is_pinned: false, is_voted: false, is_owner: true, replies_count: 0, media: [],
    user: { id: 'u7', nickname: '我', avatar_url: '' } },
];

const calls = [];
// 删除请求（DELETE /api/posts/:id）单独记录；deleted 用于让桩在删除后真的不再返回那条
const delCalls = [];
// /api/open-media 的请求体（HEVC 兜底：用系统播放器打开）
const openMediaCalls = [];
// HEVC → H.264 本机转码相关：装 ffmpeg 的请求、转码请求
const ffmpegInstallCalls = [];
const transcodedCalls = [];
let ffmpegAvailable = false;      // 桩里模拟「本机有没有 ffmpeg」
let ffmpegInstalling = false;     // 桩里模拟「正在下载安装 ffmpeg」
let ffmpegError = '';             // 桩里模拟「安装失败的原因」
let transcodeReadyAfter = 1;      // 第几次 check=1 才回报 ready
let transcodeChecks = 0;
const deleted = new Set();
let postPages = 0;
const MINE_POSTS = [
  P('m1', '我', false, false, [], [], 2),
  P('m2', '我', true, false, [], [], 4),
];
// 某位用户主页的帖子：user.id 固定为 up1，用于验证「点头像 → 开该用户主页工作表」
// 造 25 条（> 前端 perPage=20），并让桩按 last_id 分页，验证 profile 工作表能滚动加载
const PROFILE_POSTS = [];
for (let i = 1; i <= 25; i++) PROFILE_POSTS.push(P('u' + i, '阿一', i % 2 === 0, false, [], [], i));
PROFILE_POSTS.forEach((p) => { p.user.id = 'up1'; });
// 「点赞和回复」弹窗的数据：前两条给头像跳转用；后三条给「查看原帖」用
const NOTIFY = [
  { id: 'n1', created_at: '2026-09-11T10:00:00+08:00', action: 'vote', post_id: 'p1', to_content: '被赞的原帖',
    from_user: { id: 'fan1', nickname: '粉丝一', avatar_url: 'https://static-simple.imsummer.cn/f1.png' } },
  { id: 'n2', created_at: '2026-09-11T10:05:00+08:00', action: 'comment_reply', post_id: 'p2', from_content: '回复你的评论', to_content: '我的评论',
    from_user: { id: 'fan2', nickname: '回复者一', avatar_url: '' } },
  // vote 通知自带原帖正文与媒体（to_media）→ 原帖详情要能用它兜底渲染
  { id: 'n3', created_at: '2026-09-11T10:10:00+08:00', action: 'vote', post_id: 'notifypost1', to_content: '带实况的原帖',
    to_media: [
      { url: 'https://static-simple.imsummer.cn/1/post/np1.mp4', type: 'live_photo', thumbnail_url: 'https://static-simple.imsummer.cn/1/post/np1.png' },
      { url: 'https://static-simple.imsummer.cn/1/post/np2.jpg', type: 'image' },
    ],
    from_user: { id: 'fan3', nickname: '粉丝三', avatar_url: '' } },
  // comment_reply 通知没有 to_media（真实上游就是这样）→ 靠单帖接口补齐，用这条测点赞/收藏按钮
  { id: 'n4', created_at: '2026-09-11T10:15:00+08:00', action: 'comment_reply', post_id: 'notifypost2', from_content: '回你的', to_content: '我的评论',
    from_user: { id: 'fan4', nickname: '粉丝四', avatar_url: '' } },
  // 指向表格里已有的帖子 → 用来验证「原帖详情里的点赞/收藏会同步回表格」
  { id: 'n5', created_at: '2026-09-11T10:20:00+08:00', action: 'comment_reply', post_id: 'p1', from_content: '回你的', to_content: '表格里的原帖',
    from_user: { id: 'fan5', nickname: '粉丝五', avatar_url: '' } },
];
// 单帖详情接口：通知「查看原帖」用它补齐正文 / 媒体。
// notifypost1 故意不带 media、带正文为空，用来验证「通知里的 to_media 兜底」这条路。
const SINGLE_POST = {
  notifypost1: { id: 'notifypost1', content: '', media: [], created_at: '2026-09-10T09:00:00+08:00',
    is_voted: false, is_favourited: false, user: { id: 'u1', nickname: '原帖作者' } },
  notifypost2: { id: 'notifypost2', content: '可以被点赞收藏的原帖', media: [], created_at: '2026-09-10T09:00:00+08:00',
    is_voted: true, is_favourited: false, user: { id: 'u1', nickname: '原帖作者' } },
};
// 按「请求里的 per_page + last_id」切页，模拟上游的游标分页
const profileSlice = (u) => {
  const q = new URLSearchParams(u.split('?')[1] || '');
  const per = Number(q.get('per_page')) || 20;
  const after = q.get('last_id');
  const start = after ? PROFILE_POSTS.findIndex((p) => p.id === after) + 1 : 0;
  return PROFILE_POSTS.slice(start, start + per);
};
window.fetch = (url, opts) => {
  const u = String(url);
  calls.push(u);
  // 删帖：DELETE /api/posts/:id
  if (opts && opts.method === 'DELETE') {
    const id = decodeURIComponent(u.replace(/^\/api\/posts\//, ''));
    delCalls.push(id);
    deleted.add(id);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  }
  // 用系统播放器打开媒体（HEVC 兜底）
  if (u.startsWith('/api/open-media')) {
    try { openMediaCalls.push(JSON.parse((opts && opts.body) || '{}')); } catch (_) { openMediaCalls.push({}); }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, mode: 'player-file', player: 'PotPlayer' }) });
  }
  // HEVC → H.264 本机转码：可用状态由 ffmpegAvailable 控制，避免依赖真实机器环境
  if (u.startsWith('/api/ffmpeg/install')) {
    ffmpegInstallCalls.push(u);
    ffmpegInstalling = true; // 之后的 check=1 会回报「安装中」
    return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve(
      ffmpegAvailable ? { ok: true, available: true, already: true } : { ok: true, installing: true, phase: 'download', downloaded: 1024, total: 4096 }) });
  }
  if (u.startsWith('/api/transcoded')) {
    transcodedCalls.push(u);
    if (u.indexOf('check=1') >= 0) {
      transcodeChecks++;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
        ready: transcodeChecks >= transcodeReadyAfter,
        ffmpeg: ffmpegAvailable,
        installing: ffmpegInstalling,
        phase: ffmpegInstalling ? 'download' : 'idle',
        downloaded: ffmpegInstalling ? 1024 : 0,
        total: ffmpegInstalling ? 4096 : 0,
        error: ffmpegError,
      }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  }
  let body = {};
  if (u.startsWith('/api/status')) body = { hasToken: true, ok: true, ffmpeg: ffmpegAvailable };
  else if (u.startsWith('/api/me')) body = { id: 'me', nickname: '我', simple_id: 1 };
  else if (u.startsWith('/api/posts?')) {
    postPages++;
    let src;
    if (/source=profile/.test(u)) src = profileSlice(u);
    else if (/source=mine/.test(u)) src = MINE_POSTS;
    else src = POSTS;
    // 已删掉的帖子不再出现在后续的列表响应里（贴近真实上游）
    body = src.filter((p) => !deleted.has(p.id));
  }
  else if (u.startsWith('/api/posts/')) {
    const pid = decodeURIComponent(u.slice('/api/posts/'.length).split('?')[0]);
    body = SINGLE_POST[pid] || POSTS[0];
  }
  else if (u.startsWith('/api/favourites')) body = [{ id: 'p2' }];
  else if (u.startsWith('/api/comments')) body = COMMENTS;
  else if (u.startsWith('/api/notifications')) body = NOTIFY;
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};

const src = appJs + '\n;window.__t = { state, render, openComments, filteredPosts, comments, visibleColumns, selectCell, moveSelection, switchSource, switchSheet, openUserSheet, closeSheet, activeSheet, BUILTIN_SHEETS, canDeleteHere, enterDeleteMode, exitDeleteMode, markedForDelete, toggleAllForDelete, DELETE_COL_KEY };\n';
// 预置视图偏好，验证 init 时会读取并应用（单行省略 + 120% 缩放）
window.localStorage.setItem('simple_sheet_view_prefs', JSON.stringify({ wrap: false, zoom: 1.2 }));
window.eval(src);
const t = window.__t;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const rowIds = () => Array.from(doc.querySelectorAll('#sheetBody tr[data-idx]')).map((tr) => tr.dataset.idx + ':' + (t.filteredPosts()[Number(tr.dataset.idx)] || {}).id);
const selectedId = () => {
  const tr = doc.querySelector('#sheetBody tr.selected');
  if (!tr) return null;
  return (t.filteredPosts()[Number(tr.dataset.idx)] || {}).id;
};
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const key = (k, extra) => doc.dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {})));
const zOf = (sel) => Number(window.getComputedStyle(doc.querySelector(sel)).zIndex || 0);

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (info ? '  -> ' + info : '')); } };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(400);
  console.log('\n=== 1) 评论媒体渲染 ===');
  const rows = doc.querySelectorAll('#sheetBody tr[data-idx]');
  ok('表格已渲染 3 行', rows.length === 3, 'rows=' + rows.length);
  click(rows[0].querySelector('td[data-col-key="comments_count"]')); // 点「评论数」单元格打开评论区
  await wait(120);
  ok('评论区已打开并渲染', doc.querySelectorAll('#commentsList .comment-item').length === 2,
    'items=' + doc.querySelectorAll('#commentsList .comment-item').length);
  const mediaBox = doc.querySelector('#commentsList .comment-media');
  ok('评论媒体容器存在', !!mediaBox);
  ok('评论里渲染出音频块 + 图片缩略图', !!mediaBox && !!mediaBox.querySelector('.thumb-audio') && mediaBox.querySelectorAll('img.thumb').length === 1,
    mediaBox ? mediaBox.innerHTML.slice(0, 120) : '无');
  const replyMedia = doc.querySelector('#commentsList .comment-reply .comment-media');
  ok('二级回复也渲染媒体', !!replyMedia && replyMedia.querySelectorAll('img.thumb').length === 1);
  ok('头像走缩略图参数(w80)', /imageView2\/2\/w\/80/.test(decodeURIComponent(doc.querySelector('#commentsList .comment-avatar').getAttribute('src') || '')),
    decodeURIComponent(doc.querySelector('#commentsList .comment-avatar').getAttribute('src') || ''));
  // 点媒体应打开灯箱，而不是进入回复模式
  click(mediaBox.querySelector('.thumb-audio'));
  await wait(60);
  ok('点媒体打开灯箱', !$('imageModal').classList.contains('hidden'));
  ok('点媒体不会误进回复模式', t.comments.replyTo === null, 'replyTo=' + (t.comments.replyTo && t.comments.replyTo.id));
  ok('灯箱内同组媒体共 2 个', doc.getElementById('mediaPos').textContent === '1/2', doc.getElementById('mediaPos').textContent);
  // 灯箱在 DOM 里排在评论弹窗前面，必须靠更高的 z-index 才不会“躲”在评论弹窗背后
  ok('此刻评论弹窗是打开的（层级比较才有意义）', !$('detailModal').classList.contains('hidden'));
  ok('灯箱层级高于评论弹窗（否则点开看不见）', zOf('#imageModal') > zOf('#detailModal'),
    'image=' + zOf('#imageModal') + ' detail=' + zOf('#detailModal'));
  ok('灯箱层级高于通知弹窗', zOf('#imageModal') > zOf('#notifyModal'),
    'image=' + zOf('#imageModal') + ' notify=' + zOf('#notifyModal'));
  ok('灯箱内的翻页提示(toast)仍在灯箱之上', zOf('.toast') > zOf('#imageModal'),
    'toast=' + zOf('.toast') + ' image=' + zOf('#imageModal'));
  click($('imageModalClose'));

  console.log('\n=== 2) 点赞/收藏列排序 ===');
  console.log('  初始顺序 ' + rowIds().join(' | '));
  const thLikes = doc.querySelector('#sheetHead th[data-col-key="likes"]');
  click(thLikes); await wait(60);
  console.log('  asc 后   ' + rowIds().join(' | '));
  ok('按点赞升序：未赞(p2,p3) 在前，已赞(p1) 在后', t.filteredPosts().map((p) => p.id).join(',') === 'p2,p3,p1');
  click(thLikes); await wait(60);
  console.log('  desc 后  ' + rowIds().join(' | '));
  ok('再次点击按点赞降序（同值保持原序）', t.filteredPosts().map((p) => p.id).join(',') === 'p1,p2,p3');
  const thFav = doc.querySelector('#sheetHead th[data-col-key="favourites"]');
  click(thFav); await wait(60);
  ok('按收藏升序：只有 p2 收藏，排最后', t.filteredPosts().map((p) => p.id).join(',') === 'p1,p3,p2', t.filteredPosts().map((p) => p.id).join(','));
  click(thFav); await wait(60);
  ok('按收藏降序：p2 排最前', t.filteredPosts().map((p) => p.id).join(',') === 'p2,p1,p3', t.filteredPosts().map((p) => p.id).join(','));

  console.log('\n=== 4) 排序/搜索后选区跟随同一条帖子 ===');
  t.state.sortKey = ''; t.state.sortDir = 1; t.render();
  await wait(60);
  const list0 = t.filteredPosts().map((p) => p.id);
  const idxP2 = list0.indexOf('p2');
  t.selectCell(idxP2, 1);
  await wait(60);
  ok('已选中 p2', t.state.selectedId === 'p2', 'selectedId=' + t.state.selectedId);
  const sortKey = 'comments_count';
  click(doc.querySelector('#sheetHead th[data-col-key="comments_count"]')); await wait(80);
  ok('排序后选区仍指向 p2（不是同一行号的另一条）', selectedId() === 'p2', 'selected=' + selectedId() + ' order=' + t.filteredPosts().map((p) => p.id).join(','));
  ok('formula 栏同步为新位置的内容', (t.state.selectedPost || {}).id === 'p2');
  // 搜索把 p2 过滤掉 -> 选区消失但不报错；清空搜索后恢复
  const si = $('searchInput');
  si.value = '阿一'; si.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(320);
  ok('搜索命中 1 行', t.filteredPosts().length === 1, 'n=' + t.filteredPosts().length);
  ok('选中的 p2 被过滤掉后不再高亮', selectedId() === null);
  si.value = ''; si.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(320);
  ok('清空搜索后选区自动恢复为 p2', selectedId() === 'p2', 'selected=' + selectedId());

  console.log('\n=== 6) 搜索时暂停自动加载 ===');
  // 直接把 search 置位（等价于搜索生效后的状态），再触发 render
  t.state.search = 'zzz';
  t.state.hasMore = true;
  const before = postPages;
  t.render();
  await wait(180);
  ok('搜索状态下自动翻页被拦截', postPages === before, 'before=' + before + ' after=' + postPages);
  ok('底部按钮提示已暂停自动加载', /暂停自动加载/.test($('loadMoreBtn').textContent), $('loadMoreBtn').textContent);
  // 反向验证：非搜索状态确实会自动翻页（证明拦截来自搜索判断）
  t.state.search = '';
  t.state.hasMore = true;
  t.render();
  await wait(180);
  ok('非搜索状态仍会自动翻页', postPages > before, 'postPages=' + postPages);
  si.value = ''; si.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(320);

  console.log('\n=== 方向键导航回归（上一轮功能） ===');
  click($('modalClose')); // 先关掉详情弹窗，否则键盘事件会被弹窗判断挡住
  await wait(60);
  ok('详情弹窗已关闭', $('detailModal').classList.contains('hidden'));
  click(doc.querySelector('#sheetBody tr[data-idx] td.row-num'));
  await wait(60);
  key('ArrowRight'); await wait(30);
  const activeTd = doc.querySelector('#sheetBody td.cell-active');
  ok('方向键右移后仍有激活单元格', !!activeTd, activeTd ? activeTd.dataset.colKey : 'none');
  ok('名称框随右移变成 B1', /^B1$/.test($('nameBox').textContent), $('nameBox').textContent);
  key('ArrowDown'); await wait(30);
  ok('下移后变成 B2', /^B2$/.test($('nameBox').textContent), $('nameBox').textContent);
  key('Home'); await wait(30);
  ok('Home 回到首列 A2', /^A2$/.test($('nameBox').textContent), $('nameBox').textContent);

  console.log('\n=== 8) 错误提示不再被当 HTML 解析 ===');
  t.state.error = '<img src=x onerror="window.__xss=1"><b>加粗</b>';
  t.render();
  await wait(30);
  ok('错误条里的标签被转义成纯文本', doc.querySelector('#errorBar img') === null && doc.querySelector('#errorBar b') === null,
    $('errorBar').innerHTML.slice(0, 120));
  ok('转义后的原文仍可见', $('errorBar').textContent.includes('<img src=x'));
  ok('未执行注入脚本', window.__xss === undefined);
  click($('errorClose'));
  await wait(30);
  ok('点关闭后错误条隐藏', $('errorBar').classList.contains('hidden'));

  console.log('\n=== 9) 视图偏好持久化（换行 / 缩放） ===');
  ok('启动时读取到"单行省略"', t.state.wrapContent === false && doc.querySelector('.sheet').classList.contains('wrap-off'),
    'wrapContent=' + t.state.wrapContent);
  ok('启动时读取到 120% 缩放', doc.documentElement.style.getPropertyValue('--sheet-zoom') === '1.2' && $('zoomPct').textContent === '120%',
    $('zoomPct').textContent + ' / ' + doc.documentElement.style.getPropertyValue('--sheet-zoom'));
  click($('wrapBtn'));
  await wait(30);
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem('simple_sheet_view_prefs')); } catch (_) {}
  ok('点换行开关后偏好被写回 localStorage', saved.wrap === true && !doc.querySelector('.sheet').classList.contains('wrap-off'),
    JSON.stringify(saved));
  click($('zoomInPage'));
  await wait(30);
  try { saved = JSON.parse(window.localStorage.getItem('simple_sheet_view_prefs')); } catch (_) {}
  ok('调缩放后偏好被写回 localStorage', saved.zoom === 1.3, JSON.stringify(saved));

  console.log('\n=== 10) 左对齐 / 居中 / 右对齐 ===');
  const alignOf = (colKey) => {
    const td = doc.querySelector('#sheetBody td[data-col-key="' + colKey + '"]');
    return td ? td.style.textAlign : null;
  };
  const thAlignOf = (colKey) => {
    const th = doc.querySelector('#sheetHead th[data-col-key="' + colKey + '"]');
    return th ? th.style.textAlign : null;
  };
  ok('默认对齐未被破坏：评论数（数值列）右对齐', alignOf('comments_count') === 'right', String(alignOf('comments_count')));
  ok('默认对齐未被破坏：点赞列居中', alignOf('likes') === 'center', String(alignOf('likes')));
  ok('默认对齐未被破坏：内容列左对齐', alignOf('content') === 'left', String(alignOf('content')));

  // 未选中任何单元格 → 作用于所有可见列
  t.state.selectedColKey = null; t.state.selectedId = null; t.state.selectedIdx = -1; t.state.selectedPost = null;
  t.render();
  await wait(60);
  click($('alignCenterBtn'));
  await wait(60);
  ok('未选中列时点「居中」：所有可见列都居中',
    t.visibleColumns().every((c) => alignOf(c.key) === 'center'),
    t.visibleColumns().map((c) => c.key + '=' + alignOf(c.key)).join(' '));
  ok('「居中」按钮点亮', $('alignCenterBtn').classList.contains('active'));
  ok('「左对齐」按钮未点亮', !$('alignLeftBtn').classList.contains('active'));
  ok('toast 说明作用范围是全部列', /全部\s*\d+\s*列/.test($('toast').textContent), $('toast').textContent);

  // 选中「内容」列 → 只改这一列
  const contentIdx = t.visibleColumns().findIndex((c) => c.key === 'content');
  t.selectCell(0, contentIdx);
  await wait(60);
  click($('alignRightBtn'));
  await wait(60);
  ok('选中内容列后点「右对齐」：内容列变右对齐', alignOf('content') === 'right', String(alignOf('content')));
  ok('其它列不受影响（仍为上一次的居中）', alignOf('tags') === 'center' && alignOf('created_at') === 'center',
    'tags=' + alignOf('tags') + ' created_at=' + alignOf('created_at'));
  ok('表头同步应用了该列的对齐', thAlignOf('content') === 'right', String(thAlignOf('content')));
  ok('toast 说明作用范围是内容列', /「内容」列/.test($('toast').textContent), $('toast').textContent);
  ok('按钮高亮跟随选中列（内容列当前右对齐）', $('alignRightBtn').classList.contains('active') && !$('alignCenterBtn').classList.contains('active'));

  // 切到别的列，按钮高亮应跟着变
  const tagsIdx = t.visibleColumns().findIndex((c) => c.key === 'tags');
  t.selectCell(0, tagsIdx);
  await wait(60);
  ok('切到标签列后按钮高亮变为「居中」', $('alignCenterBtn').classList.contains('active'), $('alignCenterBtn').className);

  // 持久化
  let vp = {};
  try { vp = JSON.parse(window.localStorage.getItem('simple_sheet_view_prefs')); } catch (_) {}
  ok('对齐设置写入 localStorage', vp.align && vp.align.content === 'right' && vp.align.tags === 'center',
    JSON.stringify(vp.align));
  ok('对齐设置与换行 / 缩放共存（未互相覆盖）', typeof vp.wrap === 'boolean' && typeof vp.zoom === 'number',
    JSON.stringify(vp));

  console.log('\n=== 11) 工作表页签（广场 / 关注 / 我的） ===');
  const tabEl = (key) => doc.querySelector('.sheet-tab[data-sheet-key="' + key + '"]');
  const tabActive = (key) => { const el = tabEl(key); return !!el && el.classList.contains('active'); };
  const tabLabels = () => Array.from(doc.querySelectorAll('.sheet-tab')).map((el) => el.textContent.trim());
  ok('页签由 JS 渲染出三个', doc.querySelectorAll('.sheet-tab').length === 3, tabLabels().join('/'));
  ok('三个页签文案是 广场 / 关注 / 我的', tabLabels().join(',') === '广场,关注,我的', tabLabels().join(','));
  ok('内置工作表里登记了 mine 源', t.BUILTIN_SHEETS.some((x) => x.source === 'mine' && x.label === '我的'));
  ok('当前是「广场」页签点亮', tabActive('posts') && !tabActive('mine'));
  ok('内置页签没有关闭按钮', !tabEl('posts').querySelector('.sheet-tab-close'));

  calls.length = 0;
  click(tabEl('mine'));
  await wait(200);
  ok('点击后数据源切到 mine', t.state.source === 'mine', t.state.source);
  const mineReq = calls.find((u) => u.startsWith('/api/posts?'));
  ok('请求带上 source=mine', !!mineReq && /source=mine/.test(mineReq), mineReq || '（无请求）');
  ok('请求里带上了分页参数 per_page', !!mineReq && /per_page=/.test(mineReq), mineReq || '');
  ok('「我的」页签点亮、其它页签熄灭', tabActive('mine') && !tabActive('posts') && !tabActive('followings'));
  ok('表格渲染的是 mine 的数据', t.filteredPosts().map((p) => p.id).sort().join(',') === 'm1,m2',
    t.filteredPosts().map((p) => p.id).join(','));
  ok('行数统计已更新', /2 行/.test($('statusCount').textContent), $('statusCount').textContent);

  // 切回广场：数据源、页签、数据都要回来
  calls.length = 0;
  click(tabEl('posts'));
  await wait(200);
  ok('切回「广场」后数据源恢复', t.state.source === 'posts', t.state.source);
  ok('切回后页签高亮也恢复', tabActive('posts') && !tabActive('mine'));
  ok('切回后表格是广场数据', t.filteredPosts().map((p) => p.id).sort().join(',') === 'p1,p2,p3',
    t.filteredPosts().map((p) => p.id).join(','));

  console.log('\n=== 12) 点头像打开用户主页工作表 ===');
  const avatarOf = (postId) => {
    const list = t.filteredPosts();
    const i = list.findIndex((p) => p.id === postId);
    const tr = doc.querySelector('#sheetBody tr[data-idx="' + i + '"]');
    return tr ? tr.querySelector('td[data-col-key="avatar"] .avatar-link') : null;
  };
  const av1 = avatarOf('p1');
  ok('头像渲染成可点击元素', !!av1, av1 ? av1.tagName : 'missing');
  ok('头像带上 data-user-id', av1 && av1.dataset.userId === 'up1', av1 ? av1.dataset.userId : '');
  ok('点赞 / 收藏等其它列不受影响（未加 avatar-link）',
    !doc.querySelector('#sheetBody td[data-col-key="content"] .avatar-link'));

  // jsdom 里元素尺寸恒为 0，「加载标记是否进入视口」永远为真 → render() 会一路自动翻页到底。
  // 先伪装成「表格很高、加载标记远在视口下方」关掉自动翻页，专门验证手动翻页；之后恢复再验证自动翻页。
  const wrapEl = doc.querySelector('.sheet-wrap');
  const sentinelEl = $('sentinel');
  const fakeTallTable = () => {
    wrapEl.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 });
    sentinelEl.getBoundingClientRect = () => ({ top: 5000, bottom: 5000, left: 0, right: 800, width: 800, height: 0 });
  };
  const restoreGeometry = () => {
    delete wrapEl.getBoundingClientRect;
    delete sentinelEl.getBoundingClientRect;
  };

  calls.length = 0;
  const sheetCountBefore = t.state.sheets.length;
  fakeTallTable();
  click(av1);
  await wait(250);
  ok('新增了一张工作表', t.state.sheets.length === sheetCountBefore + 1, t.state.sheets.length + '');
  const userSheet = t.state.sheets.find((s) => s.key === 'user:up1');
  ok('新工作表的 key 是 user:<user_id>', !!userSheet, t.state.sheets.map((s) => s.key).join(','));
  ok('工作表用昵称命名', !!userSheet && userSheet.label === '阿一', userSheet ? userSheet.label : '');
  ok('工作表标记为不回退到内置源', !!userSheet && userSheet.source === 'profile' && userSheet.userId === 'up1');
  ok('切到了新工作表', t.state.activeSheetKey === 'user:up1', t.state.activeSheetKey);
  ok('页签数量变成 4', doc.querySelectorAll('.sheet-tab').length === 4, tabLabels().join('/'));
  ok('新页签点亮、广场页签熄灭', tabActive('user:up1') && !tabActive('posts'));
  ok('新页签有关闭按钮', !!tabEl('user:up1').querySelector('.sheet-tab-close'));
  const profReq = calls.find((u) => u.startsWith('/api/posts?'));
  ok('请求带上 source=profile', !!profReq && /source=profile/.test(profReq), profReq || '（无请求）');
  ok('请求带上该用户的 user_id', !!profReq && /user_id=up1(&|$)/.test(profReq), profReq || '');
  ok('表格渲染的是该用户帖子的第一页', t.filteredPosts().length === 20, t.filteredPosts().length + '');
  ok('首页首条是 u1、末条是 u20',
    t.filteredPosts()[0].id === 'u1' && t.filteredPosts()[19].id === 'u20',
    t.filteredPosts()[0].id + '…' + t.filteredPosts()[19].id);
  ok('首页请求带了 per_page', /per_page=/.test(profReq || ''), profReq || '');
  ok('还有更多时底部提示可继续加载', /加载更多/.test($('loadMoreBtn').textContent) && !$('loadMoreBtn').disabled,
    $('loadMoreBtn').textContent);

  // 用户主页也要能手动翻页
  calls.length = 0;
  click($('loadMoreBtn'));
  await wait(250);
  ok('点「加载更多」拉到第二页', t.filteredPosts().length === 25, t.filteredPosts().length + '');
  const profPageReq = calls.find((u) => u.startsWith('/api/posts?'));
  ok('翻页请求带上 last_id（游标=上一页末条）', !!profPageReq && /last_id=u20(&|$)/.test(profPageReq),
    profPageReq || '（无请求）');
  ok('翻页请求仍带 source=profile 与 user_id',
    !!profPageReq && /source=profile/.test(profPageReq) && /user_id=up1(&|$)/.test(profPageReq), profPageReq || '');
  ok('两页数据无重复（去重后 25 条）', new Set(t.filteredPosts().map((p) => p.id)).size === 25, '');
  ok('第二页数据接在第一页后面（顺序稳定）',
    t.filteredPosts().slice(18, 22).map((p) => p.id).join(',') === 'u19,u20,u21,u22',
    t.filteredPosts().slice(18, 22).map((p) => p.id).join(','));
  ok('到底后提示已加载全部', /已加载全部/.test($('loadMoreBtn').textContent) && $('loadMoreBtn').disabled,
    $('loadMoreBtn').textContent);

  // 恢复真实几何（jsdom 全 0）后，用户主页同样能「滚动到底自动加载」
  restoreGeometry();
  calls.length = 0;
  click(tabEl('user:up1')); // 点当前页签 = 重新加载
  await wait(400);
  ok('自动加载对用户主页同样生效（一次拉完 25 条）', t.filteredPosts().length === 25, t.filteredPosts().length + '');
  ok('自动翻页也带 last_id 游标', calls.some((u) => /source=profile/.test(u) && /last_id=u20(&|$)/.test(u)),
    calls.filter((u) => u.startsWith('/api/posts?')).join(' | ') || '（无请求）');

  // 点同一个头像应复用页签，不再新增
  const beforeReuse = t.state.sheets.length;
  click(tabEl('posts'));
  await wait(250);
  click(avatarOf('p1'));
  await wait(250);
  ok('再次点同一头像复用已有页签', t.state.sheets.length === beforeReuse, t.state.sheets.length + '');
  ok('复用后仍切到该页签', t.state.activeSheetKey === 'user:up1', t.state.activeSheetKey);

  // 关闭用户工作表
  calls.length = 0;
  click(tabEl('user:up1').querySelector('.sheet-tab-close'));
  await wait(250);
  ok('关闭后页签被移除', !tabEl('user:up1') && doc.querySelectorAll('.sheet-tab').length === 3,
    tabLabels().join('/'));
  ok('关闭当前页签后回落到相邻工作表', t.state.activeSheetKey !== 'user:up1', t.state.activeSheetKey);
  ok('回落后的数据源与页签一致', t.state.source === t.activeSheet().source, t.state.source);

  // 点击自己的头像 → 走「我的」
  const meAvatar = { id: 'me', nickname: '我' };
  calls.length = 0;
  t.openUserSheet(meAvatar);
  await wait(250);
  ok('点自己的头像不会新建页签', !t.state.sheets.some((s) => s.key === 'user:me'), t.state.sheets.map((s) => s.key).join(','));
  ok('点自己的头像切到「我的」工作表', t.state.activeSheetKey === 'mine', t.state.activeSheetKey);

  // 打开评论区的媒体不应触发头像跳转（回归：stopPropagation 未误伤）
  click(tabEl('posts'));
  await wait(250);
  ok('切回广场后页签数与数据源都正常',
    doc.querySelectorAll('.sheet-tab').length === 3 && t.state.source === 'posts' && t.filteredPosts().length === 3,
    doc.querySelectorAll('.sheet-tab').length + ' / ' + t.state.source + ' / ' + t.filteredPosts().length);

  console.log('\n=== 12.5) 切换 / 关闭页签不再自动刷新内容 ===');
  const postReqs = () => calls.filter((u) => u.startsWith('/api/posts?'));
  const idsOf = () => t.filteredPosts().map((p) => p.id).join(',');
  // 前面的用例可能留下了排序状态，这里只关心「是不是同一批数据」，不关心顺序
  const idSetOf = () => t.filteredPosts().map((p) => p.id).sort().join(',');
  ok('前置：当前在「广场」且已渲染 3 行', t.state.activeSheetKey === 'posts' && idSetOf() === 'p1,p2,p3',
    t.state.activeSheetKey + ' / ' + idsOf());

  // 已经加载过的工作表：切过去直接还原，不再发请求
  calls.length = 0;
  click(tabEl('mine'));
  await wait(250);
  ok('切到已加载过的「我的」：一条列表请求都没发', postReqs().length === 0, postReqs().join(' | '));
  ok('显示的就是上次那份数据（m1,m2）', idsOf() === 'm1,m2', idsOf());
  ok('页签高亮跟着切到「我的」', tabActive('mine') && !tabActive('posts'));

  calls.length = 0;
  click(tabEl('posts'));
  await wait(250);
  ok('切回「广场」同样不发请求', postReqs().length === 0, postReqs().join(' | '));
  ok('广场数据原样恢复', idSetOf() === 'p1,p2,p3', idsOf());

  // 从没打开过的工作表：只有第一次切过去才拉数据
  calls.length = 0;
  click(tabEl('followings'));
  await wait(250);
  ok('第一次打开的工作表才请求数据', postReqs().length > 0, 'requests=' + postReqs().length);
  ok('请求带 source=followings', /source=followings/.test(postReqs()[0] || ''), postReqs()[0] || '（无请求）');
  calls.length = 0;
  click(tabEl('posts'));
  await wait(200);
  click(tabEl('followings'));
  await wait(250);
  ok('再次打开同一张工作表不再请求', postReqs().length === 0, postReqs().join(' | '));

  // 翻过页的内容不会因为来回切换被丢掉
  calls.length = 0;
  click(tabEl('posts'));
  await wait(250);
  click(avatarOf('p1'));
  await wait(400); // 自动翻页会把该用户主页全部 25 条拉完
  ok('用户主页已加载多于一页的数据', t.filteredPosts().length === 25, t.filteredPosts().length + '');
  const profileIds = idsOf();
  calls.length = 0;
  click(tabEl('posts'));
  await wait(250);
  ok('离开后先看的是广场数据', idSetOf() === 'p1,p2,p3', idsOf());
  click(tabEl('user:up1'));
  await wait(300);
  ok('切回用户主页：那 25 条还在，没有被重新加载', idsOf() === profileIds, idsOf());
  ok('来回切换过程没有产生任何列表请求', postReqs().length === 0, postReqs().join(' | '));

  // 关闭页签：回落到相邻工作表，也不重新拉取
  calls.length = 0;
  click(tabEl('user:up1').querySelector('.sheet-tab-close'));
  await wait(300);
  ok('关闭后回落到相邻工作表', t.state.activeSheetKey === 'mine', t.state.activeSheetKey);
  ok('关闭页签没有触发任何列表请求', postReqs().length === 0, postReqs().join(' | '));
  ok('回落的那张表也是用缓存还原的（m1,m2）', idsOf() === 'm1,m2', idsOf());
  ok('关闭后页签只剩三个', doc.querySelectorAll('.sheet-tab').length === 3, tabLabels().join('/'));

  // 手动刷新入口仍在：点当前页签 = 显式重新加载
  calls.length = 0;
  click(tabEl('mine'));
  await wait(300);
  ok('点当前页签仍是一次显式刷新（手动更新入口保留）', postReqs().length > 0, 'requests=' + postReqs().length);
  ok('刷新带 refresh=1（绕过服务端缓存）', postReqs().some((u) => /refresh=1/.test(u)), postReqs().join(' | '));
  ok('刷新后仍是这批数据', idsOf() === 'm1,m2', idsOf());
  click(tabEl('posts'));
  await wait(250);

  console.log('\n=== 13) 评论区 / 点赞和回复里的头像也能跳用户主页 ===');
  // 13-1 点赞和回复弹窗
  const notifyAvatar = () => doc.querySelector('#notifyList .comment-avatar-link');
  click($('notifyBtn'));
  await wait(250);
  ok('点赞和回复弹窗已打开', !$('notifyModal').classList.contains('hidden'));
  ok('列表里的通知都渲染了头像', doc.querySelectorAll('#notifyList .comment-avatar-link').length === NOTIFY.length,
    doc.querySelectorAll('#notifyList .comment-avatar-link').length + '');
  ok('通知头像带 data-user-id', !!notifyAvatar() && notifyAvatar().dataset.userId === 'fan1',
    notifyAvatar() ? notifyAvatar().dataset.userId : 'missing');
  ok('通知头像带昵称（用于页签命名）', !!notifyAvatar() && notifyAvatar().dataset.userName === '粉丝一',
    notifyAvatar() ? notifyAvatar().dataset.userName : '');
  const sheetsBeforeNotify = t.state.sheets.length;
  click(notifyAvatar());
  await wait(250);
  ok('点通知头像后弹窗关闭', $('notifyModal').classList.contains('hidden'));
  ok('打开了对应用户的 sheet', t.state.activeSheetKey === 'user:fan1', t.state.activeSheetKey);
  ok('新工作表用昵称命名', (t.activeSheet().label) === '粉丝一', t.activeSheet().label);
  ok('新增了一张工作表', t.state.sheets.length === sheetsBeforeNotify + 1, t.state.sheets.length + '');

  // 13-2 评论区（一级评论 + 二级回复）
  click(tabEl('posts'));
  await wait(250);
  const row0 = doc.querySelector('#sheetBody tr[data-idx]');
  click(row0.querySelector('td[data-col-key="comments_count"]'));
  await wait(200);
  ok('评论区已打开', !$('detailModal').classList.contains('hidden') && doc.querySelectorAll('#commentsList .comment-item').length === 2);
  const cAvatar = doc.querySelector('#commentsList .comment-item > .comment-avatar-link');
  ok('一级评论头像可点击', !!cAvatar && cAvatar.dataset.userId === 'u9', cAvatar ? cAvatar.dataset.userId : 'missing');
  ok('二级回复头像也可点击', doc.querySelectorAll('#commentsList .comment-reply .comment-avatar-link').length === 1,
    doc.querySelectorAll('#commentsList .comment-reply .comment-avatar-link').length + '');
  click(cAvatar);
  await wait(250);
  ok('点评论头像后评论弹窗关闭', $('detailModal').classList.contains('hidden'));
  ok('跳到了评论者 u9 的主页工作表', t.state.activeSheetKey === 'user:u9', t.state.activeSheetKey);
  ok('点评论头像不会进入回复模式', t.comments.replyTo === null, 'replyTo=' + (t.comments.replyTo && t.comments.replyTo.id));

  // 13-3 点二级回复头像 → 跳该回复者
  click(tabEl('posts'));
  await wait(250);
  click(doc.querySelector('#sheetBody tr[data-idx] td[data-col-key="comments_count"]'));
  await wait(200);
  click(doc.querySelector('#commentsList .comment-reply .comment-avatar-link'));
  await wait(250);
  ok('点回复头像后评论弹窗关闭', $('detailModal').classList.contains('hidden'));
  ok('跳到了回复者 u8 的主页工作表', t.state.activeSheetKey === 'user:u8', t.state.activeSheetKey);

  // 13-4 回归：点头像跳转不能影响「点正文进入回复模式」
  click(tabEl('posts'));
  await wait(250);
  click(doc.querySelector('#sheetBody tr[data-idx] td[data-col-key="comments_count"]'));
  await wait(200);
  click(doc.querySelector('#commentsList .comment-item .comment-content'));
  await wait(80);
  ok('点评论正文仍会进入回复模式（回归）', t.comments.replyTo !== null, 'replyTo=' + (t.comments.replyTo && t.comments.replyTo.id));
  ok('点正文不会跳转工作表', t.state.activeSheetKey === 'posts' && $('detailModal').classList.contains('hidden') === false,
    t.state.activeSheetKey);

  // 13-5 没有头像图（只有首字母兜底）的头像同样可点
  click($('notifyBtn'));
  await wait(250);
  const fallbackAvatar = doc.querySelectorAll('#notifyList .comment-avatar-link')[1];
  ok('兜底（无头像图）的头像也可点', !!fallbackAvatar && fallbackAvatar.querySelector('.comment-avatar-fallback') !== null,
    fallbackAvatar ? fallbackAvatar.innerHTML.slice(0, 80) : 'missing');
  click(fallbackAvatar);
  await wait(250);
  ok('兜底头像跳到了 fan2 的主页', t.state.activeSheetKey === 'user:fan2', t.state.activeSheetKey);
  ok('弹窗同样被关闭', $('notifyModal').classList.contains('hidden'));

  console.log('\n=== 14) 「我的」工作表：批量删除 ===');
  const deleteColHead = () => doc.querySelector('#sheetHead th.delete-col');
  const deleteColCells = () => Array.from(doc.querySelectorAll('#sheetBody td.delete-col'));
  const deleteChecks = () => Array.from(doc.querySelectorAll('#sheetBody td.delete-col .delete-check'));
  const markByIndex = (i, on) => {
    const cb = deleteChecks()[i];
    cb.checked = on !== false;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  // 14-1 非「我的」工作表：按钮置灰、点不动、也不会冒出删除列
  click($('modalClose')); // 关掉上一节遗留的评论弹窗，后面的「不会打开评论区」断言才有意义
  await wait(80);
  click(tabEl('posts'));
  await wait(250);
  ok('上一节遗留的弹窗已关闭', $('detailModal').classList.contains('hidden'));
  ok('广场工作表里删除按钮置灰', $('deleteBtn').disabled, 'disabled=' + $('deleteBtn').disabled);
  ok('广场工作表里没有删除列', !deleteColHead() && deleteColCells().length === 0);
  click($('deleteBtn'));
  await wait(120);
  ok('广场工作表里点删除不会进入删除模式', t.state.deleteMode === false);
  ok('提示了删除只适用于「我的」', /「我的」/.test($('toast').textContent), $('toast').textContent);

  // 14-2 切到「我的」：按钮可用，但还没进入删除模式
  click(tabEl('mine'));
  await wait(250);
  ok('已切到「我的」工作表', t.state.source === 'mine' && t.state.activeSheetKey === 'mine', t.state.activeSheetKey);
  ok('「我的」里删除按钮可用', !$('deleteBtn').disabled);
  ok('未进入删除模式时不显示删除列', !deleteColHead() && deleteColCells().length === 0);
  ok('未进入删除模式时不显示「确认删除」', $('deleteConfirmBtn').classList.contains('hidden'));
  ok('未进入删除模式时不显示「取消」', $('deleteCancelBtn').classList.contains('hidden'));
  ok('canDeleteHere() 在「我的」返回 true', t.canDeleteHere() === true);

  // 14-3 进入删除模式 → 多出一列勾选框
  click($('deleteBtn'));
  await wait(150);
  ok('进入删除模式', t.state.deleteMode === true);
  ok('表头多出删除列（带全选）', !!deleteColHead() && !!doc.querySelector('#deleteSelectAll'));
  ok('每一行都有勾选框', deleteChecks().length === 2, deleteChecks().length + '');
  ok('删除按钮点亮', $('deleteBtn').classList.contains('active'));
  ok('「确认删除」出现了', !$('deleteConfirmBtn').classList.contains('hidden'));
  ok('未勾选时「确认删除」不可点', $('deleteConfirmBtn').disabled);
  ok('「取消」出现了', !$('deleteCancelBtn').classList.contains('hidden'));
  ok('状态栏提示删除模式', /删除模式/.test($('statusMode').textContent), $('statusMode').textContent);

  // 勾选不应把行选中 / 打开评论
  t.state.selectedId = null; t.state.selectedIdx = -1; t.state.selectedPost = null;
  t.render();
  await wait(60);
  deleteColCells()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(60);
  ok('点删除列的单元格不会选中该行', doc.querySelector('#sheetBody tr.selected') === null);
  ok('点删除列的单元格不会打开评论区', $('detailModal').classList.contains('hidden'));

  // 14-4 勾选一行
  markByIndex(0, true);
  await wait(60);
  ok('勾选后进入待删集合', t.state.deleteIds.has('m1'), [...t.state.deleteIds].join(','));
  ok('「确认删除」显示勾选条数', /确认删除\(1\)/.test($('deleteConfirmBtn').textContent), $('deleteConfirmBtn').textContent);
  ok('勾选后「确认删除」可点', !$('deleteConfirmBtn').disabled);
  ok('被勾选的行标红(to-delete)', doc.querySelectorAll('#sheetBody tr.to-delete').length === 1,
    doc.querySelectorAll('#sheetBody tr.to-delete').length + '');
  ok('状态栏显示已勾选行数', /已勾选 1 行/.test($('statusMode').textContent), $('statusMode').textContent);

  // 14-5 表头全选 / 取消全选
  const selAll = doc.querySelector('#deleteSelectAll');
  selAll.checked = true;
  selAll.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(80);
  ok('全选勾上当前显示的所有行', t.state.deleteIds.size === 2, t.state.deleteIds.size + '');
  ok('全选后表头复选框为选中态', doc.querySelector('#deleteSelectAll').checked);
  ok('两行都被标红', doc.querySelectorAll('#sheetBody tr.to-delete').length === 2);
  const selAll2 = doc.querySelector('#deleteSelectAll');
  selAll2.checked = false;
  selAll2.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(80);
  ok('取消全选清空勾选', t.state.deleteIds.size === 0, t.state.deleteIds.size + '');
  ok('表头复选框回到未选中', !doc.querySelector('#deleteSelectAll').checked);
  ok('取消全选后没有行被标红', doc.querySelectorAll('#sheetBody tr.to-delete').length === 0);

  // 14-6 点真实复选框也能勾上（走 jsdom 的 click 激活行为）
  deleteChecks()[1].click();
  await wait(80);
  ok('直接点击复选框即可勾选（走真实点击路径）', t.state.deleteIds.has('m2'), [...t.state.deleteIds].join(','));
  deleteChecks()[1].click();
  await wait(80);
  ok('再点一次取消勾选', t.state.deleteIds.size === 0, [...t.state.deleteIds].join(','));

  // 14-7 「取消」按钮退出删除模式
  markByIndex(0, true);
  await wait(60);
  click($('deleteCancelBtn'));
  await wait(120);
  ok('点「取消」退出删除模式', t.state.deleteMode === false);
  ok('退出后清空勾选', t.state.deleteIds.size === 0);
  ok('退出后删除列消失', !deleteColHead() && deleteColCells().length === 0);

  // 14-8 取消二次确认 → 一个请求都不该发出
  click($('deleteBtn'));
  await wait(120);
  markByIndex(0, true);
  markByIndex(1, true);
  await wait(60);
  delCalls.length = 0;
  click($('deleteConfirmBtn'));
  await wait(150);
  ok('点「确认删除」弹出二次确认框', !$('confirmModal').classList.contains('hidden'));
  ok('确认框写明了要删的条数', /2 条/.test($('confirmMessage').textContent), $('confirmMessage').textContent);
  ok('确认框列出了待删内容预览', doc.querySelectorAll('#confirmList li').length === 2,
    doc.querySelectorAll('#confirmList li').length + '');
  ok('确认框出现时还没有发出任何删除请求', delCalls.length === 0, delCalls.join(','));
  click($('confirmCancel'));
  await wait(150);
  ok('点「取消」关闭确认框', $('confirmModal').classList.contains('hidden'));
  ok('取消后仍然没有发过删除请求', delCalls.length === 0, delCalls.join(','));
  ok('取消后勾选保留，可直接再确认', t.state.deleteIds.size === 2, t.state.deleteIds.size + '');
  ok('取消后仍在删除模式', t.state.deleteMode === true);

  // 14-9 Esc 关闭二次确认（同样不发请求）
  click($('deleteConfirmBtn'));
  await wait(150);
  key('Escape');
  await wait(150);
  ok('Esc 也能关掉二次确认框', $('confirmModal').classList.contains('hidden'));
  ok('Esc 取消后没有发出删除请求', delCalls.length === 0, delCalls.join(','));

  // 14-10 真正确认 → 逐条 DELETE，删完自动退出删除模式
  delCalls.length = 0;
  click($('deleteConfirmBtn'));
  await wait(150);
  click($('confirmOk'));
  await wait(1500); // 两条之间会隔 400ms，留足时间
  ok('两条删除请求都发到了 /api/posts/:id', delCalls.join(',') === 'm1,m2', delCalls.join(','));
  ok('确认框已关闭', $('confirmModal').classList.contains('hidden'));
  ok('被删的行从表格移除', t.filteredPosts().length === 0, t.filteredPosts().length + '');
  ok('删空后给出空表提示', /暂无数据|没有匹配的行/.test(doc.querySelector('#sheetBody td').textContent),
    doc.querySelector('#sheetBody td').textContent);
  ok('删除完成后自动退出删除模式', t.state.deleteMode === false);
  ok('删除列已消失', !deleteColHead() && deleteColCells().length === 0);
  ok('toast 提示删除条数', /已删除 2 条/.test($('toast').textContent), $('toast').textContent);

  // 14-11 回到广场：一切照旧，删除按钮重新置灰
  click(tabEl('posts'));
  await wait(250);
  ok('切回广场后数据与删除按钮都恢复正常',
    t.state.source === 'posts' && t.filteredPosts().length === 3 && $('deleteBtn').disabled,
    t.state.source + ' / ' + t.filteredPosts().length + ' / disabled=' + $('deleteBtn').disabled);
  ok('广场工作表里没有残留的删除列', !deleteColHead() && deleteColCells().length === 0);

  console.log('\n=== 15) 视频 / 实况照片：打开即播放 ===');
  const rowOf = (id) => Array.from(doc.querySelectorAll('#sheetBody tr[data-idx]'))
    .find((tr) => (t.filteredPosts()[Number(tr.dataset.idx)] || {}).id === id);
  const thumbOf = (kind) => {
    const tr = rowOf('p3');
    return tr ? tr.querySelector('td[data-col-key="media"] [data-kind="' + kind + '"]') : null;
  };
  ok('媒体列渲染出视频 + 实况缩略图', !!thumbOf('video') && !!thumbOf('live_photo'));

  // 15-1 点视频：灯箱里应是 <video>，并且真的调用了 play()
  playCalls.length = 0;
  pauseCalls.length = 0;
  click(thumbOf('video').querySelector('img.thumb')); // 点首帧图，事件冒泡到 wrapper
  await wait(60);
  let v = doc.querySelector('#imageModalMedia video');
  ok('灯箱里渲染出 video 元素', !!v);
  ok('带 controls / playsinline', !!v && v.controls === true && v.hasAttribute('playsinline'));
  ok('带首帧 poster', !!v && /v\.png/.test(decodeURIComponent(v.getAttribute('poster') || '')),
    v && decodeURIComponent(v.getAttribute('poster') || ''));
  ok('视频地址走本地代理', !!v && /^\/media\?url=/.test(v.getAttribute('src') || ''), v && v.getAttribute('src'));
  ok('打开视频时调用了 play()（不再只靠 autoplay 属性）', playCalls.indexOf(v) >= 0, 'play=' + playCalls.length);
  ok('普通视频不循环播放', !!v && v.loop === false);

  // 15-2 实况照片：同样是 video，但循环播放
  playCalls.length = 0;
  click(thumbOf('live_photo'));
  await wait(60);
  const lp = doc.querySelector('#imageModalMedia video');
  ok('实况照片也走 video 播放', !!lp && lp !== v);
  ok('实况照片循环播放', !!lp && lp.loop === true);
  ok('打开实况照片同样调用 play()', playCalls.indexOf(lp) >= 0);

  // 15-3 自动播放被浏览器拦下：先带声音失败 → 自动静音重试 → 仍失败才摆播放按钮
  playFail = 'NotAllowedError';
  playCalls.length = 0;
  click(thumbOf('video'));
  await wait(60);
  const v2 = doc.querySelector('#imageModalMedia video');
  ok('被拦下后自动静音重试（共尝试两次）', playCalls.length === 2, 'play=' + playCalls.length);
  ok('重试时已静音', !!v2 && v2.muted === true);
  const overlay = doc.querySelector('#imageModalMedia .media-play-overlay');
  ok('静音也被拦时才出现播放按钮', !!overlay);

  playFail = null;
  click(overlay); // 用户手动点播放
  await wait(30);
  ok('点播放按钮后恢复带声音播放', playCalls[playCalls.length - 1] === v2 && v2.muted === false, 'muted=' + (v2 && v2.muted));
  ok('手动播放后按钮消失', !doc.querySelector('#imageModalMedia .media-play-overlay'));

  // 15-4 翻页 / 关闭必须停掉上一段，否则两段声音会重叠
  playCalls.length = 0;
  pauseCalls.length = 0;
  click(thumbOf('video'));
  await wait(40);
  const first = doc.querySelector('#imageModalMedia video');
  click($('mediaNext'));
  await wait(40);
  const second = doc.querySelector('#imageModalMedia video');
  ok('翻页时暂停上一段视频', pauseCalls.indexOf(first) >= 0, 'pause=' + pauseCalls.length);
  ok('翻页后新的一段开始播放', second !== first && playCalls.indexOf(second) >= 0);

  click($('imageModalClose'));
  ok('关闭灯箱时暂停播放', pauseCalls.indexOf(second) >= 0);
  ok('关闭后灯箱内容清空', $('imageModalMedia').children.length === 0);

  console.log('\n=== 16) 「点赞和回复」→ 查看原帖：媒体能点开并播放 ===');
  click($('notifyBtn'));
  await wait(250);
  ok('点赞和回复弹窗已打开，通知都渲染出来了',
    !$('notifyModal').classList.contains('hidden') && doc.querySelectorAll('#notifyList .notify-item').length === NOTIFY.length,
    doc.querySelectorAll('#notifyList .notify-item').length + '');

  // 16-1 vote 通知自带 to_media：单帖接口正文为空也不给 media，两边都得靠兜底
  click(doc.querySelector('#notifyList .notify-item[data-notify-id="n3"] .notify-jump'));
  await wait(300);
  ok('通知弹窗已关闭、原帖详情已打开',
    $('notifyModal').classList.contains('hidden') && !$('detailModal').classList.contains('hidden'));
  const pmedia = doc.querySelector('#postPreview .post-preview-media');
  ok('原帖详情里渲染出媒体块（走通知的 to_media 兜底）', !!pmedia);
  ok('媒体块里有实况照片缩略图', !!pmedia && !!pmedia.querySelector('[data-kind="live_photo"]'));
  ok('媒体块里也有图片缩略图', !!pmedia && !!pmedia.querySelector('[data-kind="image"]'));

  // 16-2 点实况缩略图 → 灯箱里是 <video>，而且真的在播
  playCalls.length = 0;
  click(pmedia.querySelector('[data-kind="live_photo"]'));
  await wait(80);
  const pv = doc.querySelector('#imageModalMedia video');
  ok('灯箱里是 video 元素（实况照片）', !!pv);
  ok('打开就调用了 play()', !!pv && playCalls.indexOf(pv) >= 0, 'play=' + playCalls.length);
  ok('实况照片循环播放', !!pv && pv.loop === true);
  ok('灯箱层级高于原帖详情弹窗', zOf('#imageModal') > zOf('#detailModal'));
  ok('翻页范围就是这一段媒体（2 条）', $('mediaPos').textContent === '1/2', $('mediaPos').textContent);

  // 16-3 翻到下一张（图片）
  click($('mediaNext'));
  await wait(60);
  ok('翻页后换成图片（不再有 video）',
    !!doc.querySelector('#imageModalMedia img') && !doc.querySelector('#imageModalMedia video'));
  ok('翻页提示更新为 2/2', $('mediaPos').textContent === '2/2', $('mediaPos').textContent);
  click($('imageModalClose'));
  await wait(30);
  ok('关闭灯箱后内容清空', $('imageModalMedia').children.length === 0);

  // 16-4 媒体文件本身加载失败时要有可读提示（否则只看到一块黑屏，以为「点了没反应」）
  click(thumbOf('video'));
  await wait(60);
  const errV = doc.querySelector('#imageModalMedia video');
  errV.dispatchEvent(new window.Event('error'));
  await wait(30);
  ok('加载失败时出现可读提示', !!doc.querySelector('#imageModalMedia .media-error'),
    doc.querySelector('#imageModalMedia .media-error') ? doc.querySelector('#imageModalMedia .media-error').textContent : '无');
  click($('imageModalClose'));

  console.log('\n=== 17) 原帖详情里的点赞 / 收藏 ===');
  // 17-1 comment_reply 通知没有 to_media，正文与状态都来自单帖接口
  click($('modalBack'));
  await wait(250);
  click(doc.querySelector('#notifyList .notify-item[data-notify-id="n4"] .notify-jump'));
  await wait(300);
  const acts = doc.querySelector('#postPreview .post-preview-actions');
  ok('原帖详情里有点赞 + 收藏两个按钮', !!acts && acts.querySelectorAll('.pp-act').length === 2);
  const likeBtn = acts && acts.querySelector('.pp-act[data-pp-action="like"]');
  const favBtn = acts && acts.querySelector('.pp-act[data-pp-action="favourite"]');
  ok('按钮状态取自帖子（这条已点赞、未收藏）',
    !!likeBtn && likeBtn.classList.contains('on') && !!favBtn && !favBtn.classList.contains('on'),
    (likeBtn ? likeBtn.textContent : '') + ' / ' + (favBtn ? favBtn.textContent : ''));

  // 17-2 点收藏 → POST /api/favourites
  const favBefore = calls.length;
  click(favBtn);
  await wait(200);
  ok('点收藏发出了 POST /api/favourites', calls.slice(favBefore).some((u) => u.startsWith('/api/favourites')),
    calls.slice(favBefore).join(' '));
  ok('收藏按钮变成「已收藏」', favBtn.classList.contains('on') && /已收藏/.test(favBtn.textContent), favBtn.textContent);

  // 17-3 再点点赞 → DELETE /api/votes（原本已赞）。上游有 1s 冷却，等一会儿再点
  await wait(1100);
  const likeBefore = calls.length;
  click(likeBtn);
  await wait(200);
  ok('再点点赞发出了 DELETE /api/votes', calls.slice(likeBefore).some((u) => u.startsWith('/api/votes')),
    calls.slice(likeBefore).join(' '));
  ok('点赞按钮变回「点赞」', !likeBtn.classList.contains('on') && /点赞/.test(likeBtn.textContent), likeBtn.textContent);

  // 17-4 详情里的操作要同步回表格里的同一条帖子（通知 n5 指向表格里的 p1）
  click($('modalClose'));
  await wait(80);
  click($('notifyBtn'));
  await wait(250);
  click(doc.querySelector('#notifyList .notify-item[data-notify-id="n5"] .notify-jump'));
  await wait(300);
  const favCell = () => rowOf('p1').querySelector('td[data-col-key="favourites"] .action-check').checked;
  const favCellBefore = favCell();
  click(doc.querySelector('#postPreview .pp-act[data-pp-action="favourite"]'));
  await wait(200);
  ok('表格里 p1 原本未收藏', favCellBefore === false, favCellBefore + '');
  ok('在详情里收藏后，表格同一条帖子也变成已收藏', favCell() === true, favCell() + '');

  console.log('\n=== 18) 只有声音、画面不动（HEVC 缺解码器）：静默转码，不弹任何提示 ===');
  // 上游实况/视频多为 H.265(HEVC)。浏览器没装 HEVC 解码器时会跳过视频轨只播音频，
  // 屏幕停在首帧封面图上 —— 这时不再解释原因、也不给按钮，直接在本机转成 H.264 播。
  const undecodable = (v) => { // 模拟「能播但拿不到画面尺寸」
    Object.defineProperty(v, 'readyState', { value: 4, configurable: true });
    v.dispatchEvent(new window.Event('playing'));
  };
  const hintNow = () => doc.querySelector('#imageModalMedia .media-unsupported');

  // 18-1 正常能解码（拿得到画面尺寸）→ 不转码、不提示
  ffmpegAvailable = true;
  ffmpegInstalling = false;
  ffmpegError = '';
  transcodeReadyAfter = 1;
  transcodeChecks = 0;
  transcodedCalls.length = 0;
  click(thumbOf('video'));
  await wait(60);
  const okV = doc.querySelector('#imageModalMedia video');
  Object.defineProperty(okV, 'videoWidth', { value: 640, configurable: true });
  Object.defineProperty(okV, 'videoHeight', { value: 480, configurable: true });
  okV.dispatchEvent(new window.Event('playing'));
  await wait(250);
  ok('能解出画面时不弹任何提示', !hintNow());
  ok('能解出画面时不发起转码', transcodedCalls.length === 0, transcodedCalls.join(' '));
  ok('能解出画面时仍走原来的代理地址', /^\/media\?url=/.test(okV.getAttribute('src') || ''), okV.getAttribute('src'));

  // 18-2 解不出画面 → 不弹提示条、不弹按钮，自动转码并在就绪后切源
  click($('imageModalClose'));
  await wait(30);
  click(thumbOf('video'));
  await wait(60);
  const badV = doc.querySelector('#imageModalMedia video');
  transcodedCalls.length = 0;
  loadCalls.length = 0;
  playCalls.length = 0;
  undecodable(badV);
  await wait(250);
  ok('解不出画面时不再弹 HEVC 提示条', !hintNow());
  ok('灯箱里没有多出任何说明性文字块', doc.querySelectorAll('#imageModalMedia div').length === 0,
    doc.querySelectorAll('#imageModalMedia div').length + '');
  ok('不用点任何按钮就自动开始转码', transcodedCalls.some((u) => /check=1/.test(u)), transcodedCalls.join(' '));
  ok('转码就绪后视频源切到 /api/transcoded',
    /^\/api\/transcoded\?url=/.test(badV.getAttribute('src') || ''), badV.getAttribute('src'));
  ok('转码地址带的是原始 CDN 地址（不是代理地址）',
    decodeURIComponent(badV.getAttribute('src') || '').indexOf('https://static-simple.imsummer.cn/1/post/v.mp4') >= 0,
    badV.getAttribute('src'));
  ok('换源后调用了 load()', loadCalls.length > 0, 'n=' + loadCalls.length);
  ok('换源后尝试自动播放', playCalls.length > 0, 'n=' + playCalls.length);

  // 18-3 实况照片同样自动转；转好后轮询要停下来
  click($('mediaNext'));
  await wait(60);
  const badLp = doc.querySelector('#imageModalMedia video');
  ok('翻页后换成了实况照片', !!badLp && badLp.loop === true);
  transcodedCalls.length = 0;
  undecodable(badLp);
  await wait(250);
  ok('实况照片同样自动转码', /^\/api\/transcoded\?url=/.test(badLp.getAttribute('src') || ''), badLp.getAttribute('src'));
  const idleBefore = transcodedCalls.length;
  await wait(900);
  ok('转码完成后不再继续轮询', transcodedCalls.length === idleBefore, `${idleBefore} → ${transcodedCalls.length}`);

  // 18-4 已经确认本机解不了 HEVC：后面的实况 / 视频直接吃转码版
  click($('imageModalClose'));
  await wait(30);
  click(thumbOf('video'));
  await wait(60);
  const prefV = doc.querySelector('#imageModalMedia video');
  ok('后续视频直接用转码地址打开', /^\/api\/transcoded\?url=/.test(prefV.getAttribute('src') || ''), prefV.getAttribute('src'));
  prefV.dispatchEvent(new window.Event('error'));
  await wait(60);
  ok('转码版取不到时静默退回代理地址', /^\/media\?url=/.test(prefV.getAttribute('src') || ''), prefV.getAttribute('src'));
  ok('退回时不弹「媒体加载失败」', !doc.querySelector('#imageModalMedia .media-error'));
  prefV.dispatchEvent(new window.Event('error'));
  await wait(30);
  ok('原文件也失败时才会提示加载失败', !!doc.querySelector('#imageModalMedia .media-error'));

  console.log('\n=== 19) 本机没有 ffmpeg：自动装一个再转，同样不给提示 ===');
  ffmpegAvailable = false;
  ffmpegInstalling = false;
  ffmpegError = '';
  transcodeReadyAfter = 99;
  transcodedCalls.length = 0;
  ffmpegInstallCalls.length = 0;
  click($('imageModalClose'));
  await wait(30);
  click(thumbOf('video'));
  await wait(60);
  const nv = doc.querySelector('#imageModalMedia video');
  nv.dispatchEvent(new window.Event('error')); // 转码地址此时取不到 → 先退回原文件
  await wait(60);
  undecodable(nv);
  await wait(250);
  ok('没 ffmpeg 时自动发出安装请求（不用点按钮）', ffmpegInstallCalls.length === 1, 'n=' + ffmpegInstallCalls.length);
  ok('没 ffmpeg 时同样不弹提示条', !hintNow());
  const instCallsAfterStart = ffmpegInstallCalls.length;
  await wait(900);
  ok('安装期间不会重复发安装请求', ffmpegInstallCalls.length === instCallsAfterStart,
    `${instCallsAfterStart} → ${ffmpegInstallCalls.length}`);
  ok('安装期间持续轮询转码进度', transcodedCalls.filter((u) => /check=1/.test(u)).length >= 2,
    transcodedCalls.length + '');

  // 19-2 装好后自动接着转，不需要重开灯箱
  ffmpegAvailable = true;
  ffmpegInstalling = false;
  transcodeReadyAfter = transcodeChecks + 1;
  loadCalls.length = 0;
  await wait(1200);
  ok('装好后自动接着转码', /^\/api\/transcoded\?url=/.test(nv.getAttribute('src') || ''), nv.getAttribute('src'));
  ok('装好后切源时调用了 load()', loadCalls.length > 0, 'n=' + loadCalls.length);

  // 19-3 装不上就安静收手：不再无限重试
  ffmpegAvailable = false;
  ffmpegInstalling = false;
  ffmpegError = '下载失败（测试桩）';
  transcodeReadyAfter = 99;
  transcodedCalls.length = 0;
  ffmpegInstallCalls.length = 0;
  click($('imageModalClose'));
  await wait(30);
  click(thumbOf('video'));
  await wait(60);
  const fv = doc.querySelector('#imageModalMedia video');
  fv.dispatchEvent(new window.Event('error'));
  await wait(60);
  undecodable(fv);
  await wait(1000);
  ok('安装失败时不再反复请求转码', transcodedCalls.length <= 2, 'n=' + transcodedCalls.length);
  ok('安装失败时不再反复发安装请求', ffmpegInstallCalls.length <= 1, 'n=' + ffmpegInstallCalls.length);
  ok('安装失败时同样不弹提示条', !hintNow());

  click($('imageModalClose'));
  await wait(30);
  ok('关闭后灯箱内容清空', $('imageModalMedia').children.length === 0);

  console.log('\n=== 20) 外观面板：白天/黑夜 + 配色 ===');
  const htmlEl = doc.documentElement;
  const themeBtn = $('themeToggleBtn');
  const themePanel = $('themePanel');
  const swatches = () => Array.from(doc.querySelectorAll('#themeSwatches .theme-swatch'));
  const swatchOf = (k) => swatches().find((b) => b.dataset.key === k);
  const modeBtn = (m) => doc.querySelector('#themeSeg button[data-mode="' + m + '"]');

  // 20-1 默认状态：面板收起，页面上没有 data-accent（即 :root 的原始森林绿）
  ok('外观面板默认是收起的', themePanel.classList.contains('hidden'));
  ok('启动时没有设置 data-accent（默认森林绿）', !htmlEl.hasAttribute('data-accent'));
  ok('七套配色的色块都渲染出来了', swatches().length === 7, 'n=' + swatches().length);
  ok('默认点亮的是森林绿', !!swatchOf('green') && swatchOf('green').classList.contains('active'));

  // 20-2 JS 清单里的每个配色，在 style.css 里都要有白天 + 黑夜两套色值（防止两边脱节）
  const extraKeys = swatches().map((b) => b.dataset.key).filter((k) => k !== 'green');
  const noLight = extraKeys.filter((k) => !new RegExp('\\[data-accent="' + k + '"\\]\\s*\\{').test(css));
  const noDark = extraKeys.filter((k) => !new RegExp('\\[data-theme="dark"\\]\\[data-accent="' + k + '"\\]\\s*\\{').test(css));
  ok('每套配色都有白天色值', noLight.length === 0, noLight.join(','));
  ok('每套配色都有黑夜色值', noDark.length === 0, noDark.join(','));

  // 20-3 打开面板 → 选配色
  click(themeBtn);
  ok('点按钮打开外观面板', !themePanel.classList.contains('hidden'));
  click(swatchOf('violet'));
  ok('选紫罗兰后 html 带上 data-accent=violet', htmlEl.getAttribute('data-accent') === 'violet', htmlEl.getAttribute('data-accent'));
  ok('配色写进了 localStorage', window.localStorage.getItem('simple_accent') === 'violet', window.localStorage.getItem('simple_accent'));
  ok('选中态转移到紫罗兰', swatchOf('violet').classList.contains('active') && !swatchOf('green').classList.contains('active'));
  ok('选完配色面板不自动关闭（可以接着比）', !themePanel.classList.contains('hidden'));

  // 20-4 白天 / 黑夜：切换模式后配色保持不变
  ok('白天按钮默认高亮', modeBtn('light').classList.contains('active'));
  click(modeBtn('dark'));
  ok('切到黑夜后 html 有 data-theme=dark', htmlEl.getAttribute('data-theme') === 'dark');
  ok('切黑夜不影响已选配色', htmlEl.getAttribute('data-accent') === 'violet');
  ok('黑夜按钮变为高亮', modeBtn('dark').classList.contains('active') && !modeBtn('light').classList.contains('active'));
  ok('按钮图标跟着换成太阳', /☀️/.test(themeBtn.textContent), themeBtn.textContent);
  ok('白天/黑夜也持久化了', window.localStorage.getItem('simple_theme') === 'dark');

  click(modeBtn('light'));
  ok('切回白天后 data-theme 被移除', !htmlEl.hasAttribute('data-theme'));

  // 20-5 切回默认配色 → 移除 data-accent，回落到 :root 的原始色板
  click(swatchOf('green'));
  ok('切回森林绿后 data-accent 被移除', !htmlEl.hasAttribute('data-accent'));
  ok('森林绿色块重新点亮', swatchOf('green').classList.contains('active'));

  // 20-6 点面板外面收起，且不会误改外观
  click($('docTitle'));
  ok('点面板外部收起面板', themePanel.classList.contains('hidden'));
  ok('收起面板不会误改外观', !htmlEl.hasAttribute('data-accent') && !htmlEl.hasAttribute('data-theme'));

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
