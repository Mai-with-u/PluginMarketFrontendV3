import { useEffect, useRef, useState } from "react";

import { ThemeSwitch } from "../components/ThemeSwitch.tsx";
import { ApiError, mutate, useResource } from "./api.ts";
import type { Inbox, Plugin, Session } from "./api.ts";
import { FeedbackPanel } from "./FeedbackPanel.tsx";

import "./developer.css";

const CLAIM_LABEL = {
  active: "已认领",
  pending: "待管理员审核",
  revoked: "权限已撤销",
  rejected: "审核未通过",
};

function Dashboard({ session, signOut }: { session: Session; signOut: () => void }) {
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [onlyMine, setOnlyMine] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const [organizationPluginId, setOrganizationPluginId] = useState("");
  const [autoClaimMessage, setAutoClaimMessage] = useState("");
  const [autoClaiming, setAutoClaiming] = useState(false);
  const autoClaims = useRef({
    attempted: new Set<string>(),
    running: false,
    paused: false,
    nextAt: 0,
    claimed: 0,
    pending: 0,
    active: false,
  });
  const plugins = useResource<{ items: Plugin[]; snapshot_at: number }>(
    "/api/developer/plugins",
    revision,
  );
  const inbox = useResource<Inbox>(
    `/api/developer/inbox${before === null ? "" : `?before=${before}`}`,
    revision,
  );
  useEffect(() => {
    const progress = autoClaims.current;
    const eligible = (item: Plugin) =>
      item.claim === null &&
      item.repository.split("/")[0]?.toLowerCase() === session.login.toLowerCase() &&
      !progress.attempted.has(item.id);
    const finish = (error?: string) => {
      progress.active = false;
      setAutoClaiming(false);
      setAutoClaimMessage(
        error
          ? `自动同步已暂停：${error}。已完成 ${progress.claimed} 个个人插件，稍后重新打开页面可继续。`
          : `已自动同步 ${progress.claimed} 个个人插件。${progress.pending ? `另有 ${progress.pending} 个申请待管理员审核。` : ""}`,
      );
      // Refresh once for the whole batch, keeping the list and reply editor stable.
      setRevision((value) => value + 1);
    };
    const claimNext = async () => {
      if (progress.running || progress.paused || Date.now() < progress.nextAt) return;
      if (!plugins?.data) return;
      const candidate = plugins.data.items.find(eligible);
      if (!candidate) {
        if (progress.active) finish();
        return;
      }
      // The login match only discovers candidates. The backend verifies the numeric
      // GitHub owner ID and repository type before granting any permission.
      progress.attempted.add(candidate.id);
      progress.running = true;
      progress.nextAt = Date.now() + 3500;
      if (!progress.active) {
        progress.active = true;
        progress.claimed = 0;
        progress.pending = 0;
        setAutoClaiming(true);
        setAutoClaimMessage("正在后台同步你的个人插件…");
      }
      try {
        const result = await mutate("/api/developer/claims", session.csrf, "POST", {
          plugin_id: candidate.id,
        });
        if (result.status === "active") progress.claimed += 1;
        else if (result.status === "pending") progress.pending += 1;
        if (!plugins.data.items.some(eligible)) finish();
      } catch (error) {
        // Stop on failure instead of retrying in a loop or exhausting write limits.
        progress.paused = true;
        finish(error instanceof Error ? error.message : "请求失败");
      } finally {
        progress.running = false;
      }
    };
    // Deferring the first request also prevents duplicate mutations in StrictMode.
    const first = setTimeout(() => void claimNext(), 0);
    const timer = setInterval(() => void claimNext(), 3500);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [plugins?.data, session.csrf, session.login]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1);
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  const execute = async (path: string, body: unknown, success: string, logout = false) => {
    setBusy(true);
    setMessage("");
    try {
      await mutate(path, session.csrf, "POST", body);
      setMessage(success);
      if (logout) signOut();
      else setRevision((value) => value + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const selected = plugins?.data?.items.find((item) => item.id === selectedId);
  const organizationCandidates =
    plugins?.data?.items.filter(
      (item) =>
        item.claim === null &&
        item.repository.split("/")[0]?.toLowerCase() !== session.login.toLowerCase(),
    ) ?? [];
  const needle = query.trim().toLocaleLowerCase();
  const items =
    plugins?.data?.items.filter(
      (item) =>
        (!onlyMine || item.claim !== null) &&
        `${item.name} ${item.id} ${item.repository}`.toLocaleLowerCase().includes(needle),
    ) ?? [];
  return (
    <>
      <div className="developer-actions">
        <span>@{session.login}</span>
        <button
          type="button"
          className="developer-link"
          disabled={busy}
          onClick={() => {
            void execute("/api/auth/logout", {}, "", true);
          }}
        >
          退出登录
        </button>
      </div>
      {message && <output className="developer-notice">{message}</output>}
      <div className="developer-grid">
        <section className="developer-box">
          <div className="developer-actions">
            <h2>我的插件</h2>
            <button
              className="developer-link"
              type="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              刷新
            </button>
          </div>
          <p className="developer-muted">个人仓库会在后台自动核验归属并同步，无需逐个认领。</p>
          {autoClaimMessage && (
            <output className="developer-muted">
              {autoClaimMessage}
            </output>
          )}
          <label className="developer-search">
            搜索插件
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="插件名、ID 或仓库"
            />
          </label>
          <label className="developer-check">
            <input
              type="checkbox"
              checked={onlyMine}
              onChange={(event) => setOnlyMine(event.target.checked)}
            />
            只看我已认领或申请的插件
          </label>
          {plugins?.error && (
            <p className="developer-error" role="alert">
              {plugins.error.message}
            </p>
          )}
          {!plugins && <output>正在读取插件…</output>}
          {plugins?.data && items.length === 0 && (
            <p className="developer-muted">
              {autoClaiming
                ? "正在同步你的个人插件，请稍候…"
                : "没有符合条件的插件。组织仓库请使用下方的审核申请入口。"}
            </p>
          )}
          <ul className="developer-plugins">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="developer-plugin-name"
                  aria-pressed={selectedId === item.id}
                  onClick={() => setSelectedId(item.id)}
                >
                  {item.name}
                </button>
                <a
                  className="developer-muted"
                  href={`https://github.com/${item.repository}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {item.repository} ↗
                </a>
                <p className="developer-muted">
                  {item.likes} 赞 · {item.comments} 条评论
                </p>
                <div className="developer-actions">
                  {item.claim && <span className="developer-tag">{CLAIM_LABEL[item.claim]}</span>}
                </div>
              </li>
            ))}
          </ul>
          <details className="developer-organization">
            <summary>组织仓库申请审核</summary>
            <p className="developer-muted">仅用于你有维护权限的 GitHub 组织仓库，由管理员核验。</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!organizationCandidates.some((item) => item.id === organizationPluginId))
                  return;
                void execute(
                  "/api/developer/claims",
                  { plugin_id: organizationPluginId },
                  "审核申请已提交，请等待管理员处理。",
                );
              }}
            >
              <label className="developer-search">
                组织插件
                <input
                  list="organization-plugins"
                  value={organizationPluginId}
                  onChange={(event) => setOrganizationPluginId(event.target.value)}
                  placeholder="输入插件 ID 或选择插件"
                  required
                />
              </label>
              <datalist id="organization-plugins">
                {organizationCandidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.repository}
                  </option>
                ))}
              </datalist>
              <button
                className="developer-button"
                type="submit"
                disabled={
                  busy ||
                  autoClaiming ||
                  !organizationCandidates.some((item) => item.id === organizationPluginId)
                }
              >
                提交审核申请
              </button>
            </form>
          </details>
        </section>
        <div>
          <section className="developer-box">
            <h2>
              通知 <span className="developer-tag">{inbox?.data?.unread ?? "—"} 条未读</span>
            </h2>
            <p className="developer-muted">
              认领后开始记录。点赞显示两次同步之间的净变化；首次认领不会生成历史通知。
            </p>
            {inbox?.error && (
              <p className="developer-error" role="alert">
                {inbox.error.message}
              </p>
            )}
            {!inbox && <output>正在读取通知…</output>}
            {inbox?.data?.items.length === 0 && <p className="developer-muted">暂无通知。</p>}
            <ul className="developer-notifications">
              {inbox?.data?.items.map((notice) => (
                <li key={notice.id}>
                  <button
                    className="developer-plugin-name"
                    type="button"
                    onClick={() => setSelectedId(notice.plugin_id)}
                  >
                    {notice.message}
                    {notice.read_at === null && " · 未读"}
                  </button>
                  <p className="developer-muted">
                    {notice.plugin_id} · {new Date(notice.created * 1000).toLocaleString()}
                  </p>
                  {notice.read_at === null && (
                    <button
                      className="developer-link"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void execute(`/api/developer/inbox/${notice.id}/read`, {}, "已标记为已读");
                      }}
                    >
                      标为已读
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="developer-actions">
              {before !== null && (
                <button type="button" className="developer-link" onClick={() => setBefore(null)}>
                  最新通知
                </button>
              )}
              {inbox?.data?.next_before !== null && inbox?.data?.next_before !== undefined && (
                <button
                  type="button"
                  className="developer-link"
                  onClick={() => setBefore(inbox.data?.next_before ?? null)}
                >
                  更早通知
                </button>
              )}
            </div>
          </section>
          <section className="developer-box">
            <h2>{selected?.name ?? "插件评论"}</h2>
            {selected ? (
              <FeedbackPanel
                key={selected.id}
                pluginId={selected.id}
                session={selected.claim === "active" ? session : undefined}
              />
            ) : (
              <p className="developer-muted">选择左侧插件，查看评论并以开发者身份回复。</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

export default function DeveloperPage() {
  const [revision, setRevision] = useState(0);
  const session = useResource<Session>("/api/auth/session", revision);
  const needsLogin = session?.error instanceof ApiError && session.error.status === 401;
  return (
    <main className="developer-page">
      <header className="developer-header">
        <ThemeSwitch />
        <a className="developer-link" href="/">
          ← 返回插件市场
        </a>
        <p className="developer-eyebrow">MAIBOT / DEVELOPERS</p>
        <h1>开发者中心</h1>
        <p className="developer-muted">认领插件，接收反馈，与使用者交流。</p>
      </header>
      {!session && <output>正在检查登录状态…</output>}
      {needsLogin && (
        <section className="developer-box developer-login">
          <h2>使用 GitHub 登录</h2>
          <p>登录后自动核验并认领你拥有的公开个人仓库。组织仓库需要手动申请和管理员审核。</p>
          <a className="developer-button" href="/api/auth/github/start">
            使用 GitHub 继续
          </a>
          <p className="developer-muted">无需授予私有仓库或代码写入权限。</p>
        </section>
      )}
      {session?.error && !needsLogin && (
        <section className="developer-box">
          <p className="developer-error" role="alert">
            {session.error.message}
          </p>
          <button
            className="developer-button"
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </button>
          <p className="developer-muted">插件市场索引可以继续使用。</p>
        </section>
      )}
      {session?.data && (
        <Dashboard session={session.data} signOut={() => setRevision((value) => value + 1)} />
      )}
    </main>
  );
}
