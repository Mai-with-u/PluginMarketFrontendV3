# 麦麦插件商店 V3

麦麦（MaiBot）插件商店的前端展示页，使用 React、TypeScript 和 Vite，结合 WebGPU 与 WGSL 实现视觉效果。页面读取仓库内的插件目录快照，提供搜索、分类筛选与详情展示。

“平面 / 立体”左侧的太阳或月亮图标可一键切换白天与夜间模式，首次访问默认跟随系统。选择保存在当前浏览器，并在插件市场和开发者中心间共享；地图 WebGPU 渲染和无 WebGPU 时的背景都支持两种配色。

## 本地开发

需要 Node.js 24 或更高版本，以及 pnpm 12.4.2（版本固定在 `package.json` 的 `packageManager` 字段）。Cloudflare Workers Builds 应使用相同版本；若设置了 `PNPM_VERSION` 构建变量，请将其设为 `12.4.2`，避免旧版本覆盖仓库配置。

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

首页以地形图为主：宽屏（≥ 1024px）下插件列表在左侧单独滚动，地图占右侧剩余空间，两边共用检索、类型、排序、MaiBot Release 版本（默认最新正式版）、兼容和分区筛选。悬停卡片会在地图上亮出对应测绘点，点地图上的点会在列表里选中并滚到对应卡片；点卡片打开详情。地图可用工具栏开关关闭，选择保存在浏览器的 `market-map`；未设置时，浏览器不支持 WebGPU 或要求减弱动态则默认关闭。关闭后不挂载地图，也不初始化 WebGPU，列表铺满全宽。窄屏只显示列表，地图通过“在地图中查看”全屏打开。卡片展示作者、版本、简介、分区、下载、点赞和评分。最新公开目录和统计来自 `/api/market/catalog`；接口失败时保留随构建发布的目录并显示错误。分区计数和地图按实际展示的插件统计；随构建发布的目录里没有的新插件，按文字与已分区插件的相似度推断分区（仅供浏览，重新运行 `pnpm sync:data` 后由归一层结果取代）。版本详情读取独立公开只读接口。README 在版本信息返回后按版本 commit 从 `raw.githubusercontent.com` 读取，不占 GitHub API 的匿名额度，找不到常见文件名时才回退到 API，同一会话内缓存；内嵌 HTML 按 GitHub 的白名单过滤后渲染，不执行脚本、事件或内联样式。

「在 MaiBot 中安装」打开用户保存的 WebUI 地址，传递市场插件 ID 和可选版本。目标 MaiBot 必须已启动并更新到支持该入口的 WebUI；它重新核验市场目录、实际兼容性并显示安装确认，不通过跨站请求直接安装。安装状态、更新、卸载及点赞评分写入由目标实例处理。「MaiBot 地址」可修改浏览器持久化地址；从 WebUI 的「前往站点」进入时通过 fragment 带入实例 origin，不携带认证信息。

`/developer` 提供 GitHub 登录、插件认领、通知和回复。`src/developer/` 独立于目录加载；市场索引仍从 `public/data/catalog.json` 加载。评论反馈不可用时不会阻止目录搜索。

登录开发者中心后，前端会在后台自动发现并认领当前 GitHub 用户拥有的个人仓库插件，整批完成后统一刷新列表并显示汇总，不逐项提示，也不提供个人插件的手动认领按钮。候选发现通过独立的分页接口核验 GitHub 用户数字 ID，完全不依赖用户名匹配。后端持久化仓库数字 ID，支持用户和仓库改名；首次核验仅跟随 GitHub 官方仓库 API 的受限重定向。自动请求间隔至少 3.5 秒，失败后暂停并提示稍后重新打开页面继续，不自动恢复被撤销或拒绝的认领。组织仓库通过单独的折叠入口提交审核申请，由管理员核验。

后端位于独立仓库 `PluginMarketDeveloperBackend`，拥有自己的数据库和运行环境；具体部署、备份、权限核验与管理员审核见该仓库 README。原统计服务无需改动。

开发者概览汇总当前账号有效认领的插件数、累计下载、滚动近 7 / 30 天下载、点赞、点踩和评论数。搜索与列表筛选不改变概览范围，待审核、已撤销和审核未通过的插件不计入汇总。下载沿用市场的有效去重事件，统计约每分钟更新。

选择插件后可查看单个插件指标与版本发布记录，包括市场已收录、预发布、已撤回、校验未通过和未收录标签，以及发布时间、MaiBot / SDK 兼容范围和校验原因。记录来自市场目录快照，以显示的目录同步时间为准，不代表实时 GitHub 草稿或 CI 状态。版本明细通过独立的登录接口按插件加载，不随全量插件列表下发。

`worker.mjs` 只转发 `/api/auth/*`、已列明的 `/api/developer/*` 和只读 `/api/feedback/*`；未知 API 返回 404，不转发到原统计服务。静态文件由 `ASSETS` 提供，`wrangler.jsonc` 将 `/api/*` 配置为优先执行 Worker。

部署配置：

- 普通变量 `DEVELOPER_ORIGIN`：`https://developer-api.maibot.chat`。
- Worker Secret `DEVELOPER_INGRESS_KEY`：与独立后端的 `INGRESS_KEY` 一致。
- GitHub 登录令牌交换由 `oauth-token.mjs` 在 Worker 内调用 GitHub 官方固定接口。配置 Worker Secrets：`GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET`、`GITHUB_OAUTH_RELAY_KEY`；最后一个与后端同名变量一致，使用独立随机密钥，不复用 `DEVELOPER_INGRESS_KEY`。
- `/api/internal/github/token` 仅接受后端签名的 POST 请求（HMAC-SHA256、正文绑定、60 秒时间窗、2 KiB 上限），不接受任意目标地址或应用配置，不跟随 GitHub 重定向，不缓存或记录令牌。原有 state、PKCE、授权码单次使用、身份核验和加密会话存储保留在后端。
- GitHub Client Secret 仅保存在后端配置及 Worker Secrets；Fernet 密钥仅存在后端，不设置任何前端 `VITE_` Secret。浏览器授权仍在 GitHub 官方页面完成。
- OAuth 回调固定为 `https://plugin.maibot.chat/api/auth/github/callback`。预览域名默认不开放开发者 API。
- Worker invocation 日志默认关闭，防止记录 OAuth 查询参数；启用日志时先做好脱敏。

配置独立后端、DNS 和 Secret，并通过登录/权限验证后，再发布：

```bash
pnpm build
node --test tests/worker.test.mjs
npx wrangler deploy
```

上线前保存现有 Worker 版本号；回滚使用 Cloudflare 的上一版本。停止开发者后端不会影响现有统计后端和静态目录。不要将 `.dev.vars`、后端配置或任何密钥提交到仓库。

## 开发者后端源码与改名支持

独立 Python 服务源码、部署模板和安全测试位于 `services/developer/`，不打包进前端静态资源。该目录是后续后端变更的版本来源；服务器仍独立运行在 `/opt/maibot-developer`，Cloudflare 构建只部署前端和 Worker。

- `/api/developer/claim-candidates` 要求登录，按不可变插件 ID 游标分批发现个人仓库，每批最多核验 8 个未缓存仓库，已核验身份缓存 1 小时。首次建立索引可能需要数分钟，页面显示进度；失败不会授予权限。
- `repository_identities` 固定插件对应的 GitHub 仓库 ID；已有认领会从历史 `repo_id` 初始化。改名后使用 `/repositories/{id}` 查询，索引地址更新时也必须仍指向同一仓库 ID。
- 缓存仅用于发现候选。认领、回复和删除回复仍实时核验仓库与所有者数字 ID，组织仍需管理员审核，撤销或拒绝的申请不会被自动恢复。
- 尚未建立过身份记录，且旧地址已失去 GitHub 重定向的仓库，无法凭旧用户名安全恢复历史身份，需要管理员核实并修正市场索引。已有 ID 绑定不能自动改绑到另一个仓库。
- 发布顺序：备份开发者数据库及代码 → 更新后端 → 提交推送前端和 Worker。首次启动自动增加身份索引表，不改动原统计服务。回滚旧后端代码时可以保留这张新增表，无需覆盖在线数据。

后端验证：`cd services/developer && uv run pytest -q`。
