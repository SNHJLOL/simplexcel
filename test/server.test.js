/*
 * 服务端回归测试：用假的 https 层拦下所有上游请求，只验证本机服务器的行为。
 * 运行：npm run test:server（不需要网络、不需要真实 token）
 * 覆盖：/media 白名单与报错文案 / 默认只监听本机 / per_page 上限收敛 / 工作表数据源路由（广场·关注·我的·用户主页）/ 静态资源与 /api/status
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (info ? '  -> ' + info : '')); }
};

/* ---------- 1. 用假的 https 层替换真实上游 ---------- */
const https = require('https');
const upstreamCalls = [];

function fakeIncomingMessage(status, body, headers) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = headers || { 'content-type': 'application/json' };
  res.pipe = (dest) => { if (dest && typeof dest.end === 'function' && !dest.writableEnded) dest.end(); };
  res.destroy = () => {};
  process.nextTick(() => {
    res.emit('data', Buffer.from(body));
    res.emit('end');
  });
  return res;
}

function fakeRequest(url, opts, cb) {
  upstreamCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = () => {};
  req.end = () => {
    const u = String(url);
    // id 为 not-found 的帖子模拟上游「不存在」，用于验证报错文案的翻译
    if (/\/api\/v3\/posts\/not-found/.test(u)) {
      if (typeof cb === 'function') cb(fakeIncomingMessage(404, '{"code":404,"message":"Translation missing: zh-CN.errors.post.not_found"}'));
      return;
    }
    // 当前用户接口按固定 id 返回，供「我的」工作表自动补 user_id 使用
    const payload = /\/api\/v2\/current_user/.test(u) ? '{"id":"user-123","nickname":"测试"}' : '[]';
    if (typeof cb === 'function') cb(fakeIncomingMessage(200, payload));
  };
  process.nextTick(() => { /* 不触发 error，保持请求正常结束 */ });
  return req;
}
https.request = fakeRequest;
https.get = (url, opts, cb) => fakeRequest(url, opts, cb);

/* ---------- 2. 启动服务器 ---------- */
const PORT = 39000 + Math.floor(Math.random() * 900);
process.env.PORT = String(PORT);
process.env.SIMPLE_NO_OPEN = '1';
// 转码兜底的「一键安装 ffmpeg」在测试里只做模拟，不真的下载 90MB
process.env.SIMPLE_NO_FFMPEG_INSTALL = '1';
// 「本机有没有 ffmpeg」必须与真实机器无关：把 ffmpeg 的查找目录指向一个空目录，并清空 PATH。
// 否则同一份测试在装过 / 没装 ffmpeg 的机器上结论会不一样。
const FAKE_APPDATA = path.join(os.tmpdir(), 'simple-test-appdata-' + process.pid);
fs.mkdirSync(FAKE_APPDATA, { recursive: true });
process.env.LOCALAPPDATA = FAKE_APPDATA;
process.env.PATH = '';
delete process.env.SIMPLE_HOST; // 验证默认绑定
delete process.env.SIMPLE_TOKEN;
// 让 config.json 里的 token 有确定值
require(path.join(__dirname, '..', 'server.js'));

/* ---------- 3. 请求辅助 ---------- */
const request = (method, p, options) => new Promise((resolve) => {
  const req = http.request(Object.assign({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 8000 }, options || {}), (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', (e) => resolve({ status: 0, body: '', error: e.code || e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'TIMEOUT' }); });
  req.end((options && options.body) || undefined);
});

const get = (p, options) => request('GET', p, options);
const del = (p, options) => request('DELETE', p, options);
const postJson = (p, obj) => request('POST', p, {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj || {}),
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(400);

  console.log('\n=== 1) /media 白名单与报错文案 ===');
  const bad = await get('/media?url=' + encodeURIComponent('https://evil.example.com/x.jpg'));
  ok('非白名单域名被拒绝(400)', bad.status === 400, 'status=' + bad.status);
  let badMsg = '';
  try { badMsg = JSON.parse(bad.body).message || ''; } catch (_) {}
  ok('拒绝原因是可读中文，不再是 ????', !!badMsg && !/^[?？]+$/.test(badMsg) && /[一-龥]/.test(badMsg), JSON.stringify(badMsg));

  const httpScheme = await get('/media?url=' + encodeURIComponent('http://static-simple.imsummer.cn/x.jpg'));
  ok('非 https 协议被拒绝(400)', httpScheme.status === 400, 'status=' + httpScheme.status);

  const noUrl = await get('/media');
  ok('缺少 url 参数被拒绝(400)', noUrl.status === 400, 'status=' + noUrl.status);

  const goodSub = await get('/media?url=' + encodeURIComponent('https://static-simple.imsummer.cn/x.jpg'));
  ok('白名单子域放行（不再被硬编码单域名挡住）', goodSub.status !== 400, 'status=' + goodSub.status);

  const goodApex = await get('/media?url=' + encodeURIComponent('https://cdn-new.imsummer.cn/y.png'));
  ok('新增 CDN 子域同样放行', goodApex.status !== 400, 'status=' + goodApex.status);

  const lookalike = await get('/media?url=' + encodeURIComponent('https://imsummer.cn.evil.com/x.jpg'));
  ok('形似域名 imsummer.cn.evil.com 仍被拒绝', lookalike.status === 400, 'status=' + lookalike.status);

  console.log('\n=== 2) per_page 上限收敛 ===');
  upstreamCalls.length = 0;
  await get('/api/posts?per_page=99999&source=posts');
  const postCall = upstreamCalls.find((c) => c.url.includes('/api/v2/posts?'));
  ok('请求列表时 per_page 被收敛到 100 上限', !!postCall && /per_page=100(&|$)/.test(postCall.url), postCall ? postCall.url : 'not called');

  upstreamCalls.length = 0;
  await get('/api/comments?post_id=p1&per_page=5000');
  const cmtCall = upstreamCalls.find((c) => c.url.includes('/api/v2/comments?'));
  ok('评论 per_page 同样收敛到 100', !!cmtCall && /per_page=100(&|$)/.test(cmtCall.url), cmtCall ? cmtCall.url : 'not called');

  upstreamCalls.length = 0;
  await get('/api/posts?per_page=abc&source=posts');
  const defCall = upstreamCalls.find((c) => c.url.includes('/api/v2/posts?'));
  ok('非法 per_page 回落到默认 20', !!defCall && /per_page=20(&|$)/.test(defCall.url), defCall ? defCall.url : 'not called');

  console.log('\n=== 3) 默认只监听本机 ===');
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)[0];
  ok('本机回环可访问', (await get('/api/status')).status === 200);
  if (lan) {
    const viaLan = await get('/api/status', { host: lan });
    ok('局域网地址访问被拒绝（未绑 0.0.0.0）', viaLan.status === 0, `${lan} -> status=${viaLan.status} ${viaLan.error || ''}`);
  } else {
    console.log('  SKIP  未找到局域网 IPv4，跳过对外暴露检查');
  }
  const st = await get('/api/status');
  let stj = {};
  try { stj = JSON.parse(st.body); } catch (_) {}
  ok('/api/status 返回 hasToken 字段', typeof stj.hasToken === 'boolean', st.body);

  console.log('\n=== 4) 静态资源 ===');
  const idx = await get('/');
  ok('/ 返回页面(200)', idx.status === 200 && /<html/i.test(idx.body), 'status=' + idx.status);
  const js = await get('/app.js');
  ok('/app.js 返回(200)', js.status === 200);
  const escapeTest = await get('/../server.js');
  ok('路径穿越被挡住（非 200 页面内容）', !(escapeTest.status === 200 && /require\(/.test(escapeTest.body)), 'status=' + escapeTest.status);

  console.log('\n=== 5) 工作表数据源路由 ===');
  upstreamCalls.length = 0;
  await get('/api/posts?source=mine&per_page=10');
  const mineCall = upstreamCalls.find((c) => c.url.includes('/api/v3/posts/mine'));
  ok('source=mine 走 /api/v3/posts/mine', !!mineCall, upstreamCalls.map((c) => c.url).join(' | ') || 'not called');
  ok('「我的」自动补上当前用户的 user_id', !!mineCall && /user_id=user-123(&|$)/.test(mineCall.url), mineCall ? mineCall.url : '');
  ok('透传 per_page', !!mineCall && /per_page=10(&|$)/.test(mineCall.url), mineCall ? mineCall.url : '');

  upstreamCalls.length = 0;
  await get('/api/posts?source=mine&user_id=explicit-id&per_page=3');
  const mineExplicit = upstreamCalls.find((c) => c.url.includes('/api/v3/posts/mine'));
  ok('显式传入的 user_id 优先生效', !!mineExplicit && /user_id=explicit-id(&|$)/.test(mineExplicit.url), mineExplicit ? mineExplicit.url : '');

  upstreamCalls.length = 0;
  await get('/api/posts?source=followings&per_page=3');
  const folCall = upstreamCalls.find((c) => c.url.includes('/api/v3/posts/followings'));
  ok('source=followings 仍走 /api/v3/posts/followings', !!folCall, upstreamCalls.map((c) => c.url).join(' | ') || 'not called');
  ok('关注源仍带 user_scope=normal', !!folCall && /user_scope=normal/.test(folCall.url), folCall ? folCall.url : '');
  ok('关注源不会被误加 user_id', !!folCall && !/user_id=/.test(folCall.url), folCall ? folCall.url : '');

  upstreamCalls.length = 0;
  await get('/api/posts?source=posts&per_page=3');
  const plazaCall = upstreamCalls.find((c) => c.url.includes('/api/v2/posts?'));
  ok('source=posts 仍走 /api/v2/posts', !!plazaCall, upstreamCalls.map((c) => c.url).join(' | ') || 'not called');

  upstreamCalls.length = 0;
  const bogusRes = await get('/api/posts?source=bogus&per_page=9');
  const bogusCall = upstreamCalls.find((c) => c.url.includes('/api/v2/posts?'));
  ok('未知 source 安全回退到广场接口', !!bogusCall, upstreamCalls.map((c) => c.url).join(' | ') || 'not called');
  ok('未知 source 仍返回 200 与数组', bogusRes.status === 200 && bogusRes.body.trim() === '[]', bogusRes.status + ' ' + bogusRes.body.slice(0, 60));

  console.log('\n=== 6) 用户主页数据源（source=profile） ===');
  upstreamCalls.length = 0;
  await get('/api/posts?source=profile&user_id=other-user&per_page=20');
  const profCall = upstreamCalls.find((c) => c.url.includes('/api/v3/posts/profile'));
  ok('source=profile 走 /api/v3/posts/profile', !!profCall, upstreamCalls.map((c) => c.url).join(' | ') || 'not called');
  ok('透传目标用户的 user_id', !!profCall && /user_id=other-user(&|$)/.test(profCall.url), profCall ? profCall.url : '');
  ok('透传 per_page（该接口支持翻页）', !!profCall && /per_page=20/.test(profCall.url), profCall ? profCall.url : '');
  ok('不带 last_id 时不会凭空补一个', !!profCall && !/last_id=/.test(profCall.url), profCall ? profCall.url : '');

  upstreamCalls.length = 0;
  await get('/api/posts?source=profile&user_id=p1&per_page=20&last_id=abc');
  const profPage2 = upstreamCalls.find((c) => c.url.includes('/api/v3/posts/profile'));
  ok('翻页时 last_id 会原样上送', !!profPage2 && /last_id=abc/.test(profPage2.url), profPage2 ? profPage2.url : '');

  upstreamCalls.length = 0;
  const noUidProf = await get('/api/posts?source=profile');
  const profNoUid = upstreamCalls.find((c) => c.url.includes('/api/v3/posts/profile'));
  ok('缺少 user_id 时不打上游、直接 400', noUidProf.status === 400 && !profNoUid, 'status=' + noUidProf.status + ' upstream=' + (profNoUid ? profNoUid.url : 'none'));
  let noUidMsg = '';
  try { noUidMsg = JSON.parse(noUidProf.body).message || ''; } catch (_) {}
  ok('缺少 user_id 的报错是可读中文', /user_id/.test(noUidMsg) && /[一-龥]/.test(noUidMsg), JSON.stringify(noUidMsg));

  upstreamCalls.length = 0;
  await get('/api/posts?source=profile&user_id=p1&per_page=99');
  const profDirty = upstreamCalls.find((c) => c.url.includes('/api/v3/posts/profile'));
  ok('profile 的 per_page 收敛到 30（上游 >30 直接 400）', !!profDirty && /per_page=30(&|$)/.test(profDirty.url), profDirty ? profDirty.url : '');

  upstreamCalls.length = 0;
  await get('/api/posts?source=profile&user_id=p1&per_page=abc');
  const profBad = upstreamCalls.find((c) => c.url.includes('/api/v3/posts/profile'));
  ok('profile 的 per_page 非法值回落到 20', !!profBad && /per_page=20(&|$)/.test(profBad.url), profBad ? profBad.url : '');

  console.log('\n=== 7) 删帖代理（DELETE /api/posts/:id） ===');
  upstreamCalls.length = 0;
  const delRes = await del('/api/posts/p1');
  const delCall = upstreamCalls.find((c) => c.method === 'DELETE');
  ok('DELETE /api/posts/p1 转发到上游 /api/v3/posts/p1',
    !!delCall && /\/api\/v3\/posts\/p1(&|$)/.test(delCall.url),
    upstreamCalls.map((c) => c.method + ' ' + c.url).join(' | ') || 'not called');
  ok('删除成功返回 200', delRes.status === 200, 'status=' + delRes.status);

  // 其余方法不能顺带把帖子删了
  upstreamCalls.length = 0;
  const postToPost = await request('POST', '/api/posts/p1');
  ok('POST /api/posts/:id 不会触发删除', !upstreamCalls.some((c) => c.method === 'DELETE'), upstreamCalls.map((c) => c.method + ' ' + c.url).join(' | ') || 'none');
  ok('POST /api/posts/:id 不返回 200', postToPost.status !== 200, 'status=' + postToPost.status);

  // 单帖详情仍是 GET
  upstreamCalls.length = 0;
  await get('/api/posts/p1');
  const getCall = upstreamCalls.find((c) => /\/api\/v3\/posts\/p1/.test(c.url));
  ok('GET /api/posts/:id 仍走 GET（详情没被删帖分支抢走）', !!getCall && getCall.method === 'GET',
    upstreamCalls.map((c) => c.method + ' ' + c.url).join(' | ') || 'not called');

  // 删除成功后列表缓存必须失效，否则刷新还能看到已删的帖子
  upstreamCalls.length = 0;
  await get('/api/posts?source=posts&per_page=3');
  ok('首次列表请求打上游（写入缓存）', upstreamCalls.filter((c) => c.url.includes('/api/v2/posts?')).length === 1,
    'n=' + upstreamCalls.filter((c) => c.url.includes('/api/v2/posts?')).length);
  upstreamCalls.length = 0;
  await get('/api/posts?source=posts&per_page=3');
  ok('缓存生效：同样的列表请求不再打上游', upstreamCalls.filter((c) => c.url.includes('/api/v2/posts?')).length === 0,
    upstreamCalls.map((c) => c.url).join(' | ') || 'none');
  upstreamCalls.length = 0;
  await del('/api/posts/p1');
  upstreamCalls.length = 0;
  await get('/api/posts?source=posts&per_page=3');
  ok('删除后列表缓存被清掉，重新打上游', upstreamCalls.filter((c) => c.url.includes('/api/v2/posts?')).length === 1,
    upstreamCalls.map((c) => c.url).join(' | ') || 'none');

  // 上游 i18n 占位文案要换成可读中文
  const del404 = await del('/api/posts/not-found');
  ok('上游 404 原样返回状态码', del404.status === 404, 'status=' + del404.status);
  let del404Msg = '';
  try { del404Msg = JSON.parse(del404.body).message || ''; } catch (_) {}
  ok('404 报错换成可读中文（不再暴露 Translation missing）',
    /[一-龥]/.test(del404Msg) && !/Translation missing/i.test(del404Msg), JSON.stringify(del404Msg));

  console.log('\n=== 8) 用系统播放器打开媒体（HEVC 兜底 /api/open-media） ===');
  upstreamCalls.length = 0;
  const openBad = await postJson('/api/open-media', { url: 'https://evil.example.com/x.mp4' });
  ok('非白名单地址被拒绝(400)', openBad.status === 400, 'status=' + openBad.status);
  let openBadMsg = '';
  try { openBadMsg = JSON.parse(openBad.body).message || ''; } catch (_) {}
  ok('拒绝原因是可读中文', /[一-龥]/.test(openBadMsg), JSON.stringify(openBadMsg));

  const openHttp = await postJson('/api/open-media', { url: 'http://static-simple.imsummer.cn/x.mp4' });
  ok('非 https 协议被拒绝(400)', openHttp.status === 400, 'status=' + openHttp.status);

  const openNone = await postJson('/api/open-media', {});
  ok('缺少 url 被拒绝(400)', openNone.status === 400, 'status=' + openNone.status);

  const openGet = await get('/api/open-media?url=' + encodeURIComponent('https://static-simple.imsummer.cn/x.mp4'));
  ok('GET 不被接受(405，避免被预取误触发本机程序)', openGet.status === 405, 'status=' + openGet.status);

  // 测试环境带 SIMPLE_NO_OPEN=1：只做校验，不真的拉起播放器
  const openOk = await postJson('/api/open-media', { url: 'https://static-simple.imsummer.cn/1/post/v.mp4' });
  ok('白名单地址放行(200)', openOk.status === 200, 'status=' + openOk.status);
  let openData = {};
  try { openData = JSON.parse(openOk.body); } catch (_) {}
  ok('返回里带上打开方式', openData.ok === true && !!openData.mode, JSON.stringify(openData));
  ok('SIMPLE_NO_OPEN=1 时不做真实打开（标记 simulated）', openData.simulated === true, JSON.stringify(openData));

  // 能力探测：/api/status 顺带告诉前端本机有没有可用播放器
  const statusRes = await get('/api/status');
  let statusData = {};
  try { statusData = JSON.parse(statusRes.body); } catch (_) {}
  ok('/api/status 带 player 字段（无则为 null）',
    statusRes.status === 200 && Object.prototype.hasOwnProperty.call(statusData, 'player'), JSON.stringify(statusData));
  ok('/api/status 带 ffmpeg 字段（前端据此决定要不要引导安装）',
    Object.prototype.hasOwnProperty.call(statusData, 'ffmpeg'), JSON.stringify(statusData));

  console.log('\n=== 9) HEVC → H.264 本机转码与一键装 ffmpeg ===');
  const GOOD = 'https://static-simple.imsummer.cn/1/post/v.mp4';

  // 9-1 地址白名单同样生效，避免被当成「任意 https 地址都能转」的口子
  const tcBad = await get('/api/transcoded?url=' + encodeURIComponent('https://evil.example.com/x.mp4'));
  ok('转码接口拒绝白名单外的地址', tcBad.status === 400, 'status=' + tcBad.status);
  const tcHttp = await get('/api/transcoded?url=' + encodeURIComponent('http://static-simple.imsummer.cn/x.mp4'));
  ok('转码接口拒绝 http 明文地址', tcHttp.status === 400, 'status=' + tcHttp.status);
  const tcNone = await get('/api/transcoded');
  ok('缺少 url 参数时报 400', tcNone.status === 400, 'status=' + tcNone.status);

  // 9-2 只在 GET 上提供（避免被当作副作用的入口）
  ok('转码接口只接受 GET', (await postJson('/api/transcoded', { url: GOOD })).status === 405,
    'status=' + (await postJson('/api/transcoded', { url: GOOD })).status);

  // 9-3 本机没有 ffmpeg 时，给一句人看得懂的中文（测试环境里确实没有）
  const upBefore = upstreamCalls.length;
  const tcNoFf = await get('/api/transcoded?url=' + encodeURIComponent(GOOD));
  let tcNoFfData = {};
  try { tcNoFfData = JSON.parse(tcNoFf.body); } catch (_) {}
  ok('没有 ffmpeg 时返回 412 且中文可读',
    tcNoFf.status === 412 && /ffmpeg/.test(tcNoFfData.message), 'status=' + tcNoFf.status + ' ' + tcNoFf.body);
  ok('没有 ffmpeg 时不调用上游（不会白等）', upstreamCalls.length === upBefore,
    `before=${upBefore} after=${upstreamCalls.length}`);

  // 9-4 check=1 只回报进度：不发文件、也不该 5xx
  const tcCheck = await get('/api/transcoded?check=1&url=' + encodeURIComponent(GOOD));
  let tcCheckData = {};
  try { tcCheckData = JSON.parse(tcCheck.body); } catch (_) {}
  ok('check=1 返回 200', tcCheck.status === 200, 'status=' + tcCheck.status);
  ok('check=1 回报 ready / ffmpeg / installing 三个字段',
    typeof tcCheckData.ready === 'boolean'
    && typeof tcCheckData.ffmpeg === 'boolean'
    && typeof tcCheckData.installing === 'boolean', JSON.stringify(tcCheckData));

  // 9-5 ffmpeg 状态查询
  const ffStatus = await get('/api/ffmpeg/status');
  let ffData = {};
  try { ffData = JSON.parse(ffStatus.body); } catch (_) {}
  ok('/api/ffmpeg/status 返回 200', ffStatus.status === 200, 'status=' + ffStatus.status);
  ok('状态里带 available / dir / installing',
    typeof ffData.available === 'boolean' && typeof ffData.dir === 'string'
    && typeof ffData.installing === 'boolean', JSON.stringify(ffData));

  // 9-6 安装入口：只接受 POST；SIMPLE_NO_FFMPEG_INSTALL=1 时不做真实下载
  ok('安装接口只接受 POST', (await get('/api/ffmpeg/install')).status === 405,
    'status=' + (await get('/api/ffmpeg/install')).status);
  const instRes = await postJson('/api/ffmpeg/install', {});
  let instData = {};
  try { instData = JSON.parse(instRes.body); } catch (_) {}
  ok('SIMPLE_NO_FFMPEG_INSTALL=1 时不真的下载', instRes.status === 200 && instData.simulated === true,
    'status=' + instRes.status + ' ' + instRes.body);
  ok('未知 ffmpeg 子操作返回 404', (await get('/api/ffmpeg/nope')).status === 404,
    'status=' + (await get('/api/ffmpeg/nope')).status);

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', (e && e.stack) || e); process.exit(1); });
