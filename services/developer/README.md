# MaiBot 插件开发者服务

独立于现有插件统计后端的 GitHub 登录、认领、通知和开发者回复服务。

## 边界

```text
浏览器 → plugin.maibot.chat
  /、前端脚本 → Worker Static Assets
  /api/market/icons/{commit}/{file}.webp → Worker → 官方注册仓库的版本化图标
  /api/market/*、/api/auth/*、/api/developer/*、/api/feedback/*
    → Worker（固定路由、密钥）→ 专用 Cloudflare Tunnel
      → 127.0.0.1:10061 → 开发者 SQLite

原统计服务 :10059 → 原 SQLite
                   ↓ 每分钟只读导出去标识化快照
              开发者服务只读快照
```

原统计服务的代码、索引生成、游客统计接口和数据库表均不需要修改。新服务不直接访问原数据库；只有独立导出任务读取评价和投票。网页版公开目录也由实时只读接口提供，不再发布构建时目录和图标。服务故障时网页明确显示加载失败；原统计服务和 MaiBot 本地插件市场不受影响。

## 已实现

- GitHub OAuth，空 scope，只访问公开资料与公开仓库。PKCE S256、一次性 state 与浏览器 Cookie 绑定。
- Cookie 为 `__Host-`、Secure、HttpOnly、SameSite=Lax。数据库只保存会话摘要；GitHub token 使用 Fernet 加密存储，密钥不在数据库内。
- 个人仓库按 GitHub 数字用户 ID 自动认领；组织仓库申请待审核，本地管理员核实后批准。组织申请者还需具备 GitHub 返回的仓库 push 权限。
- 回复前实时检查仓库数字 ID、所有者 ID 和权限；转移或删除重建的仓库不能继承旧授权。
- 通知记录新评论、评论更新及点赞净变化，后台每分钟收集。首次认领只建立基线，最多保留每个账号最近 1000 条通知。
- 评论 ID 使用服务器 HMAC，将原游客 ID 隐藏；评论修订使用摘要。评论修改、删除后旧回复不会作为当前回复展示。
- CSRF、Origin 校验，固定 API 转发白名单，入口密钥校验，分层速率限制和 12 KiB 请求上限。前端按纯文本显示评论/回复。
- 同步数据库/文件工作位于 FastAPI 同步端点或 `asyncio.to_thread` 中。systemd 单独限制资源与文件写入范围。

## 已知边界

### 评论折叠申请（仅存储）

已认领且具有当前管理权限的开发者可在评论下申请折叠，必填理由（最多 1000 字）。
申请写入独立开发者数据库的 `comment_fold_requests` 表，保存插件 ID、评论 ID/修订、
申请人 GitHub 数字 ID 与当时用户名、仓库/所有者 ID、理由、评论快照、创建时间和 `pending` 状态。
同一开发者对同一评论修订只能申请一次，重复提交返回原记录，不覆盖理由或重复记审计日志。
评论修改后可对新修订重新申请，旧申请和原始证据保留。

`POST /api/developer/plugins/{plugin_id}/reviews/{review_id}/fold-request` 要求会话、Origin、CSRF、
有效认领及 GitHub 实时权限，并受写入速率限制。申请状态仅通过开发者专用反馈接口返回给本人。
普通 `/api/feedback/{plugin_id}` 不含申请数据，申请不会改变评论、评分、计数或 MaiBot WebUI 展示。

本阶段没有管理员审核接口、通知发送或实际折叠逻辑。管理员后续可基于该表实现审核，
目前可在服务器本地只读查询待审核记录：

```sql
SELECT id, plugin_id, review_id, revision, user_id, requester_login,
       reason, review_snapshot, created
FROM comment_fold_requests WHERE status = 'pending' ORDER BY created, id;
```

原系统的游客 user_id 可以由客户端提供，因此旧反馈不能被视为经过 GitHub 验证的用户身份。本服务不会以它授予任何管理权限，也不会替原系统补造点赞事件。

快照间隔约 60 秒，原评论删除/修改的可见性因此可能有同等延迟。超过 5 分钟未更新时拒绝读取与回复。通知代表采样间的净变化，采样间发生并撤销的行为不会记录。通知时间是收集时间。审核不是自动确认组织所有权，仍需要管理员验证申请背景。

SQLite WAL 只读连接有时需要创建协调文件，所以导出任务允许原 data 目录的协调文件写入，但原数据库主文件及目录快照被 systemd 挂载为只读，连接同时使用 `mode=ro` 和 `query_only=ON`。

## GitHub OAuth Worker 令牌交换

生产后端通过 `https://plugin.maibot.chat/api/internal/github/token` 完成令牌交换，GitHub 用户身份和仓库核验仍由后端直接访问官方 API。浏览器仍在 GitHub 官方站点授权，回调地址不变。

后端 `GITHUB_OAUTH_RELAY_KEY` 与 Worker 同名 Secret 一致，独立于入口密钥。请求只包含授权码和 PKCE verifier，用 HMAC-SHA256 签名绑定协议标识、时间戳与原始 JSON 正文；Worker 允许 60 秒时差及最多 2 KiB 正文，拒绝浏览器 Origin/Cookie、任意 URL 和其他字段。Worker 自己读取 `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET` Secrets，并只请求 GitHub 固定令牌接口，不跟随重定向、不记录或缓存凭据。

后端在调用前消费浏览器绑定的单次 state，GitHub 授权码也只能兑换一次。失败不自动重试、不切回服务器直连，也不创建会话；用户需重新发起登录。只有明确移除后端 relay key 才恢复旧直连方式。签名时间窗仅限制请求有效期，单次使用由 state 和 GitHub 授权码共同保证。

更换 OAuth 应用或 Client Secret 时，需同步更新后端配置和 Worker Secrets；`configure_oauth.py` 仅更新服务器。Fernet 密钥不传给 Worker。服务器与 Worker 应保持时钟同步。

上线前备份：`/root/plugin-market-backups/before-worker-oauth-20261027T063526Z`（代码、service.env、SQLite 在线备份，完整性检查通过）。回滚时恢复该目录中的 `developer/app.py`、`developer/storage.py`、`service.env` 并只重启 `maibot-developer.service`，数据库无结构改动，不需要恢复数据库。Worker 上线前版本为 `a2ee1748-95d1-4d3f-a37c-a15336405cab`。

## 本地验证

```powershell
uv sync --python 3.10 --frozen
uv run pytest -q
uv export --frozen --no-dev --no-emit-project --format requirements-txt --output-file requirements.txt
```

`pyproject.toml` 定义依赖，`uv.lock` 锁定依赖，`requirements.txt` 是供服务器 pip 安装的带哈希导出。测试使用临时数据库，不访问线上账号或数据库。

## 部署

代码放 `/opt/maibot-developer`，使用独立 `.venv`；首次运行：

```bash
sudo /opt/py310/bin/python /opt/maibot-developer/deploy/install.py
```

安装器不覆盖已有 secret，不改旧服务。新服务：

- `maibot-developer.service`：仅监听 127.0.0.1:10061，系统用户 `maibot-developer`。
- `maibot-developer-export.timer`：每分钟导出公开反馈。
- `maibot-developer-notifications.timer`：每分钟收集通知。
- `cloudflared-maibot-developer.service`：独立隧道，需先配置 `/etc/maibot-developer/tunnel.token` 和 `cloudflared.yml`，然后手动 enable。

数据：`/var/lib/maibot-developer/developer.sqlite3`；只读快照：`/var/lib/maibot-developer-source/market.json`。配置：`/etc/maibot-developer/service.env`（root:root 0600）。示例见 `deploy/service.env.example`。

### GitHub OAuth

在 <https://github.com/settings/applications/new> 创建 OAuth App：

- Homepage URL：`https://plugin.maibot.chat`
- Authorization callback URL：`https://plugin.maibot.chat/api/auth/github/callback`
- 不开启 Device Flow；无需 repo/user:email 权限。

生成 Client Secret 后，在服务器交互式填写（输入 Secret 时不显示，也不会进入 shell 历史）：

```bash
sudo /opt/maibot-developer/.venv/bin/python /opt/maibot-developer/deploy/configure_oauth.py
```

该命令只重启新开发者服务。不要将 Secret 放入前端 `VITE_` 变量、Git、聊天或截图。

### Cloudflare

Tunnel ID：`72ca3cbb-7977-4c96-956e-f8752c6da92b`，账户内名称 `maibot-plugin-developer`。

DNS：`developer-api.maibot.chat` 的 CNAME 指向 `72ca3cbb-7977-4c96-956e-f8752c6da92b.cfargotunnel.com`，开启代理。隧道只转发此 hostname 到 127.0.0.1:10061，其余返回 404。

前端 Worker 需设置：

- `DEVELOPER_ORIGIN=https://developer-api.maibot.chat`
- Secret `DEVELOPER_INGRESS_KEY` = 后端 `INGRESS_KEY`。两者由部署工具私下传递，不写入 Git。

Worker 不转发旧统计写入或管理端点。预览域名的开发者 API 默认禁用，防止共用生产 Cookie/数据库。关闭 Worker invocation 日志并禁用 uvicorn access log，避免 OAuth code 出现在 URL 日志中。启用其他代理或日志系统时也应去除 OAuth 查询参数。

### 管理员审核

在服务器加载配置后运行 CLI，仅限拥有服务器管理权限的人：

```bash
sudo sh -c 'set -a; . /etc/maibot-developer/service.env; set +a; cd /opt/maibot-developer; .venv/bin/python admin.py list'
sudo sh -c 'set -a; . /etc/maibot-developer/service.env; set +a; cd /opt/maibot-developer; .venv/bin/python admin.py approve --plugin PLUGIN_ID --user GITHUB_NUMERIC_ID --reason verified-with-maintainer'
```

`reject` / `revoke` 使用同样参数。所有决策写审计记录，CLI 不提供公共 HTTP 接口。申请人授权过期时需先重新登录再审核。

撤销或拒绝后，申请者不能自行重新认领。管理员复核后可使用 `reopen --plugin PLUGIN_ID --user GITHUB_NUMERIC_ID --reason REASON` 重新开放申请；个人仓库仍须重新通过 GitHub 所有者验证，组织仓库仍需批准。

## 2026-10-26 安全复查

已修复匿名署名摘要的字典猜测风险、重新认领绕过撤销、GitHub 核验期间权限变化的写入竞态、仓库映射变化、异常 Unicode/整数参数引发 500、已限流 IP 消耗全局额度，以及网页缺少防嵌入保护的问题。匿名修订标识现使用 HMAC；部署时执行 `deploy/migrate_revision_hashes.py`，保留回复关联和通知基线。该迁移必须在新开发者服务和两项定时任务停止时执行，旧统计服务无需停止。

cryptography 升至 50.0.2，开发测试依赖 pytest 升至 9.1.1；前端通过 pnpm overrides 将间接 MCP server 依赖升至 2.3.0。复查结果和范围见 `deploy/security-review.json`。未将依赖扫描等同于完整渗透测试；旧游客统计接口的身份与防刷机制仍需另行兼容改造。

## 验证与回滚

### 开发者统计与发布记录

网页版卡片市场另提供公开只读的 `/api/market/catalog` 和 `/api/market/plugins/{plugin_id}/releases`。前者只返回公开清单与汇总统计，不含评论正文、认领状态、用户身份或下载指纹；后者复用版本投影。所有请求仍要求 Worker 入口密钥并执行限流，公开浏览不要求 GitHub 登录。原统计库仍仅通过导出器只读访问。上线前备份位于 `/root/plugin-market-backups/before-card-market-20261026T111532Z`。

导出器以只读事务批量汇总 `plugin_download_events` 的 `counted = 1` 事件，提供累计、滚动近 7 天和近 30 天下载数；近期时间按 UTC 时间戳比较并排除未来事件。沿用原插件 canonical ID 与去重口径，不导出下载者身份、指纹或 IP。投票与评论仍使用原快照逻辑，回复 HMAC 标识不变。

版本信息从市场 bundle 的 versions 收录数据投影，仅包含公开版本、标签、收录状态、日期、兼容范围和校验原因；GitHub 链接由已验证的仓库和编码标签构造。`GET /api/developer/plugins/{plugin_id}/releases` 要求入口密钥与登录，返回目录同步时间。插件列表排除完整版本历史，前端仅汇总 active 认领插件。

更新导出器时先停止 `maibot-developer-export.timer` 并等待当前 export service 停止，安装后运行导出并核验新字段，再重启独立开发者服务，最后恢复定时器。旧统计服务始终无需停止。此功能不更改任何数据库表。

本次上线前代码、配置、快照和两个数据库备份：`/root/plugin-market-backups/before-insights-20261026T105942Z`，数据库完整性检查通过。

新服务 `/health` 必须返回 200；未带入口密钥的 `/api/auth/session` 必须为 403，带入口密钥但未登录必须为 401。还需在生产域名实际完成登录、本人认领、回复、退出，再发布完整功能。

回滚前端使用 Cloudflare 上一版本；新服务可单独停止：

```bash
sudo systemctl disable --now maibot-developer.service maibot-developer-export.timer maibot-developer-notifications.timer cloudflared-maibot-developer.service
```

旧统计服务不需要回滚或重启。不要删除新数据库、配置或 export.key；恢复依赖这些文件。数据库在线备份使用 `sqlite3.Connection.backup`，不要直接复制活动 WAL 数据库。

首次原系统备份：`/root/plugin-market-backups/20261026T082623Z-before-developer-service`。含代码 tar、原 systemd 单元、SQLite 在线备份（integrity_check=ok）、目录数据和 SHA-256 清单。另已下载到本机 `C:/Users/Sengoku/.codex/backups/plugin-market-20261026/before-developer.tar.gz`。前端历史备份位于本项目被忽略的 `frontend-before-developer.bundle`。

公开接口 `/api/market/host-releases` 从 Mai-with-u/MaiBot 的 GitHub Releases 读取最新正式版及最近 100 条发布中的正式版本，排除草稿与预发布，内存缓存 15 分钟。同步端点在线程池运行，不访问统计数据库；失败明确返回 503。网页版默认采用 latest，手动选择写入 URL 的 host 参数。
