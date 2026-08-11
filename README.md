# Simple 广场 · 仿真 Excel

用浏览器登录态读取 [simple.imsummer.cn/web](https://simple.imsummer.cn/web) 的广场数据，做成一个带 Excel 风格表格的本地网页：支持手动刷新、滚动懒加载、排序、筛选、列显隐和 CSV 导出。

## 快速开始

1. 安装 Node.js（>= 18）。
2. 确认 `config.json` 里已有 token（本仓库已配置，若失效请重新提取）。
3. 启动：

```powershell
node server.js
```

4. 浏览器打开 <http://localhost:3000>

## 功能

- **手动刷新**：工具栏「⟳ 手动刷新」重新拉取第一页。
- **懒加载**：滚动到底部自动用 `last_id` 游标翻页，和源站行为一致。
- **广场帖子**：直接读取 全部tie，表格内显示图片缩略图，点击可查看原图。
- **点赞 / 收藏**：表格「点赞」「收藏」列以复选框形式点赞 / 取消点赞、收藏 / 取消收藏，即时反馈状态。
- **排序**：点击列头按该列排序（再点切换升/降序）。
- **列宽**：拖拽列头右侧手柄可像 Excel 一样调整每列宽度，内容自动换行，宽度会记住。
- **搜索**：右上角按昵称 / 内容 / ID 过滤当前已加载数据。
- **列显隐**：「☰ 列」勾选要显示的列（选择会记住）。
- **行详情**：点击任意行弹出完整字段。
- **复制单元格**：双击单元格复制内容。
- **导出 CSV**：导出当前筛选结果为 Excel 可打开的 CSV。

## 架构

```
浏览器 (localhost:3000)
   │ 同源，无 CORS 问题
   ▼
server.js（Node，零依赖）
   │ 注入 Authorization token，转发
   ▼
https://simple.imsummer.cn/api/v2/posts/...
```

- `server.js`：静态文件服务 + API 代理（`/api/posts`、`/api/me`、`/api/status`）。
- `public/`：纯 HTML/CSS/JS 前端，无需构建。
- `config.json`：登录 token（已加入 `.gitignore`，勿提交）。

## Token 获取与更新

- 在浏览器 [simple.imsummer.cn/web](https://simple.imsummer.cn/web) 页面 F12 控制台执行

  ```js
  JSON.parse(JSON.parse(localStorage.getItem('flutter.UserInfo'))).token
  ```

  想自动复制到剪贴板，用 `copy(...)` 包一层：
  ```js
  copy(JSON.parse(JSON.parse(localStorage.getItem('flutter.UserInfo'))).token)
  ```

  把结果贴进本工具「登录」对话框（会自动写入 config.json），或直接写入 `config.json` 的 `token` 字段。
  若返回 `undefined`，先在控制台执行 `Object.keys(localStorage)` 确认实际存储 key，以及 `JSON.parse(localStorage.getItem('flutter.UserInfo'))` 里对象是否含 `token` 字段。


接口返回 401 时前端会提示“登录已失效”，按上面任一种方式更新即可。


## 注意事项

- 这是个人工具：用自己的账号读取自己的数据，请勿高频抓取或公开分发。
- Token 等于账号登录态，不要把它贴到公开场合；`config.json` 已 gitignore。
- 源站接口偶发较慢（首包可能 20 秒左右），界面会显示加载状态。
