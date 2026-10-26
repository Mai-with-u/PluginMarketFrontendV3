# 麦麦插件商店 V3

麦麦（MaiBot）插件商店的前端展示页，使用 React、TypeScript 和 Vite，结合 WebGPU 与 WGSL 实现视觉效果。页面读取仓库内的插件目录快照，提供搜索、分类筛选与详情展示。

“平面 / 立体”左侧的太阳或月亮图标可一键切换白天与夜间模式，首次访问默认跟随系统。选择保存在当前浏览器，并在插件市场和开发者中心间共享；地图 WebGPU 渲染和无 WebGPU 时的背景都支持两种配色。

## 本地开发

需要 Node.js 24 或更高版本，以及 pnpm。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发地址为 `http://localhost:5180`。仓库已包含 `public/data/catalog.json` 和插件图标，可直接启动。

## 检查与构建

```bash
pnpm check
pnpm build
pnpm preview
```

`pnpm check` 依次检查格式、Lint、TypeScript 类型和 WGSL 着色器。构建产物位于 `dist/`，预览服务使用端口 `5180`。

## 更新插件数据

`scripts/sync-data.ts` 从独立的 `maibot-plugin-market` 数据目录生成插件快照，并替换 `public/icons/` 下的图标。默认读取相邻目录 `../maibot-plugin-market/data`：

```bash
pnpm sync:data
```

也可以指定数据目录：

```bash
MAIBOT_MARKET_DATA=/path/to/maibot-plugin-market/data pnpm sync:data
```

源目录需要包含 `normalized/plugins.json`、`normalized/categories.json`、`normalized/authors.json` 和 `icons/`。同步后的 `public/data/catalog.json` 和 `public/icons/` 需要一起提交；日常开发和构建不需要重新同步。

## 目录

- `src/components/`：页面和交互组件。
- `src/data/`：目录类型、读取、搜索与排序。
- `src/map/`：地图布局与相机交互。
- `src/gpu/`：WebGPU 渲染和 WGSL 着色器。
- `src/styles/`：样式与设计变量。
- `public/`：随构建发布的插件快照、图标等静态资源。
- `scripts/`：数据同步脚本。

## 开发者中心与 Worker

`/developer` 提供 GitHub 登录、插件认领、通知和回复。`src/developer/` 独立于目录加载；市场索引仍从 `public/data/catalog.json` 加载。评论反馈不可用时不会阻止目录搜索。

登录开发者中心后，前端会在后台自动发现并认领当前 GitHub 用户拥有的个人仓库插件，整批完成后统一刷新列表并显示汇总，不逐项提示，也不提供个人插件的手动认领按钮。后端仍以 GitHub 用户数字 ID 和仓库类型核验权限；用户名匹配本身不授予权限。自动请求间隔至少 3.5 秒，失败后暂停并提示稍后重新打开页面继续，不自动恢复被撤销或拒绝的认领。组织仓库通过单独的折叠入口提交审核申请，由管理员核验。

后端位于独立仓库 `PluginMarketDeveloperBackend`，拥有自己的数据库和运行环境；具体部署、备份、权限核验与管理员审核见该仓库 README。原统计服务无需改动。

`worker.mjs` 只转发 `/api/auth/*`、已列明的 `/api/developer/*` 和只读 `/api/feedback/*`；未知 API 返回 404，不转发到原统计服务。静态文件由 `ASSETS` 提供，`wrangler.jsonc` 将 `/api/*` 配置为优先执行 Worker。

部署配置：

- 普通变量 `DEVELOPER_ORIGIN`：`https://developer-api.maibot.chat`。
- Worker Secret `DEVELOPER_INGRESS_KEY`：与独立后端的 `INGRESS_KEY` 一致。
- GitHub Client Secret、Fernet 密钥仅存在后端，不设置任何前端 `VITE_` Secret。
- OAuth 回调固定为 `https://plugin.maibot.chat/api/auth/github/callback`。预览域名默认不开放开发者 API。
- Worker invocation 日志默认关闭，防止记录 OAuth 查询参数；启用日志时先做好脱敏。

配置独立后端、DNS 和 Secret，并通过登录/权限验证后，再发布：

```bash
pnpm build
node --test tests/worker.test.mjs
npx wrangler deploy
```

上线前保存现有 Worker 版本号；回滚使用 Cloudflare 的上一版本。停止开发者后端不会影响现有统计后端和静态目录。不要将 `.dev.vars`、后端配置或任何密钥提交到仓库。
