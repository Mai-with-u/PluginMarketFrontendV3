import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../components/Icon.tsx";
import { ThemeSwitch } from "../components/ThemeSwitch.tsx";
import { ApiError, mutate, useResource } from "./api.ts";
import type { Inbox, Notice, Plugin, Resource, Session } from "./api.ts";
import { formatCount, percent, shortDate } from "./format.ts";
import { CLAIM_LABEL, InfoTip, Meter, PluginDetail, Stat } from "./PluginInsights.tsx";
import type { DetailTab } from "./PluginInsights.tsx";

import "./developer.css";

const SORTS = {
  downloads_7d: "按近 7 天下载",
  downloads_30d: "按近 30 天下载",
  downloads: "按累计下载",
  likes: "按点赞",
};
type SortKey = keyof typeof SORTS;
const isSortKey = (value: string): value is SortKey => value in SORTS;

const FILTERS = [
  { key: "all", label: "全部", test: () => true },
  { key: "pending", label: "审核中", test: (item: Plugin) => item.claim === "pending" },
  {
    key: "quiet",
    label: "7 天无下载",
    test: (item: Plugin) => item.claim === "active" && item.downloads_7d === 0,
  },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

/** Closes on an outside press or Escape, like a native menu. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function TopBar({ children }: { children: ReactNode }) {
  return (
    <header className="developer-topbar">
      <div className="developer-topbar-inner">
        <a className="developer-back" href="/">
          <Icon name="prev" size={14} />
          插件市场
        </a>
        <span className="developer-divider" aria-hidden="true" />
        <h1>开发者中心</h1>
        <div className="developer-topbar-actions">{children}</div>
      </div>
    </header>
  );
}

function NoticeBell({
  inbox,
  before,
  onBefore,
  onOpen,
}: {
  inbox: Resource<Inbox> | undefined;
  before: number | null;
  onBefore: (before: number | null) => void;
  onOpen: (notice: Notice) => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const unread = inbox?.data?.unread ?? 0;
  const next = inbox?.data?.next_before ?? null;
  return (
    <div className="developer-popover-anchor" ref={ref}>
      <button
        type="button"
        className="developer-icon-button"
        aria-label={`通知，${unread} 条未读`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="developer-badge" aria-hidden="true" />}
      </button>
      {open && (
        <section className="developer-popover developer-inbox" aria-label="通知">
          <div className="developer-popover-head">
            <strong>通知</strong>
            {unread > 0 && <span>{unread} 条未读</span>}
          </div>
          {inbox?.error && (
            <p className="developer-error" role="alert">
              {inbox.error.message}
            </p>
          )}
          {!inbox && <p className="developer-empty">正在读取通知…</p>}
          {inbox?.data?.items.length === 0 && <p className="developer-empty">暂无通知</p>}
          <ul>
            {inbox?.data?.items.map((notice) => (
              <li key={notice.id}>
                <button
                  type="button"
                  className="developer-inbox-item"
                  data-unread={notice.read_at === null}
                  onClick={() => {
                    setOpen(false);
                    onOpen(notice);
                  }}
                >
                  <span className="developer-dot" aria-hidden="true" />
                  <span className="developer-inbox-text">
                    {notice.message}
                    {notice.read_at === null && <span className="visually-hidden">，未读</span>}
                  </span>
                  <time dateTime={new Date(notice.created * 1000).toISOString()}>
                    {shortDate(notice.created)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
          {(before !== null || next !== null) && (
            <div className="developer-popover-foot">
              {before !== null && (
                <button
                  type="button"
                  className="developer-text-button"
                  onClick={() => onBefore(null)}
                >
                  最新通知
                </button>
              )}
              {next !== null && (
                <button
                  type="button"
                  className="developer-text-button"
                  onClick={() => onBefore(next)}
                >
                  更早通知
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function AccountMenu({
  login,
  status,
  busy,
  onSignOut,
}: {
  login: string;
  status: string;
  busy: boolean;
  onSignOut: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="developer-popover-anchor" ref={ref}>
      <button
        type="button"
        className="developer-avatar-button"
        aria-label={`账户 @${login}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="developer-avatar" aria-hidden="true">
          {login.slice(0, 1).toUpperCase()}
        </span>
      </button>
      {open && (
        <div className="developer-popover developer-account">
          <div className="developer-popover-head is-stacked">
            <strong>@{login}</strong>
            <span>{status}</span>
          </div>
          <button type="button" className="developer-menu-item" disabled={busy} onClick={onSignOut}>
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}

function Overview({ plugins, snapshotAt }: { plugins: Plugin[]; snapshotAt: number }) {
  const sum = (
    field: "downloads" | "downloads_7d" | "downloads_30d" | "likes" | "dislikes" | "comments",
  ) => plugins.reduce((total, plugin) => total + plugin[field], 0);
  const recent = sum("downloads_7d");
  const month = sum("downloads_30d");
  const likes = sum("likes");
  const dislikes = sum("dislikes");
  return (
    <section className="developer-overview" aria-label="数据概览">
      <dl className="developer-figures">
        <Stat
          label="近 7 天下载"
          value={formatCount(recent)}
          hint={`占近 30 天下载的 ${percent(recent, month)}`}
        >
          <Meter value={recent} max={month} />
        </Stat>
        <Stat label="近 30 天" value={formatCount(month)} />
        <Stat label="累计下载" value={formatCount(sum("downloads"))} />
        <Stat
          label="好评率"
          value={percent(likes, likes + dislikes)}
          hint={`${likes} 赞 · ${dislikes} 踩`}
        />
        <Stat label="评论" value={formatCount(sum("comments"))} />
      </dl>
      <p className="developer-updated">
        更新于 {shortDate(snapshotAt)}
        <InfoTip label="统计口径">
          汇总已认领且权限有效的插件。下载按市场去重规则计数，近 7 / 30 天为滚动时间范围。
        </InfoTip>
      </p>
    </section>
  );
}

function Dashboard({ session, signOut }: { session: Session; signOut: () => void }) {
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("downloads_7d");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("reviews");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [organizationPluginId, setOrganizationPluginId] = useState("");
  const [autoClaimMessage, setAutoClaimMessage] = useState("");
  const [autoClaimFailed, setAutoClaimFailed] = useState(false);
  const [autoClaiming, setAutoClaiming] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);
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
      setAutoClaimFailed(error !== undefined);
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
  const readNotice = (notice: Notice) => {
    void execute(`/api/developer/inbox/${notice.id}/read`, {}, "");
  };
  const select = (id: string) => {
    setSelectedId(id);
    // On a phone the detail stacks under the list, so bring it into view.
    if (matchMedia("(max-width: 760px)").matches)
      detailRef.current?.scrollIntoView({ block: "start" });
  };

  const all = plugins?.data?.items ?? [];
  const mine = all.filter((item) => item.claim !== null);
  const active = mine.filter((item) => item.claim === "active");
  const organizationCandidates = all.filter(
    (item) =>
      item.claim === null &&
      item.repository.split("/")[0]?.toLowerCase() !== session.login.toLowerCase(),
  );
  const notices = inbox?.data?.items ?? [];
  const unreadPlugins = new Set(
    notices.filter((notice) => notice.read_at === null).map((notice) => notice.plugin_id),
  );
  const chips = FILTERS.map((item) => ({ ...item, count: mine.filter(item.test).length })).filter(
    (item) => item.key === "all" || item.key === filter || item.count > 0,
  );
  const test = FILTERS.find((item) => item.key === filter)?.test ?? (() => true);
  const needle = query.trim().toLocaleLowerCase();
  const items = mine
    .filter(
      (item) =>
        test(item) &&
        `${item.name} ${item.id} ${item.repository}`.toLocaleLowerCase().includes(needle),
    )
    .toSorted((a, b) => b[sort] - a[sort]);
  const max = Math.max(0, ...items.map((item) => item[sort]));
  const selected = mine.find((item) => item.id === selectedId) ?? items[0];

  return (
    <>
      <TopBar>
        <NoticeBell
          inbox={inbox}
          before={before}
          onBefore={setBefore}
          onOpen={(notice) => {
            select(notice.plugin_id);
            setTab(notice.review_id === null ? "notices" : "reviews");
            if (notice.read_at === null) readNotice(notice);
          }}
        />
        <ThemeSwitch />
        <AccountMenu
          login={session.login}
          status={autoClaimMessage || "个人仓库会自动核验归属并同步"}
          busy={busy}
          onSignOut={() => {
            void execute("/api/auth/logout", {}, "", true);
          }}
        />
      </TopBar>
      <main className="developer-main">
        {message && <output className="developer-notice">{message}</output>}
        {plugins?.data && <Overview plugins={active} snapshotAt={plugins.data.snapshot_at} />}
        <div className="developer-workspace">
          <section className="developer-sidebar" aria-labelledby="developer-plugins-title">
            <div className="developer-sidebar-head">
              <h2 id="developer-plugins-title">我的插件</h2>
              {plugins?.data && <span className="developer-count">{mine.length}</span>}
              <label className="developer-sort">
                <span className="visually-hidden">排序方式</span>
                <select
                  value={sort}
                  onChange={(event) => {
                    if (isSortKey(event.target.value)) setSort(event.target.value);
                  }}
                >
                  {Object.entries(SORTS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={12} />
              </label>
            </div>
            <label className="developer-search">
              <Icon name="search" size={15} />
              <span className="visually-hidden">搜索插件</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索插件名、ID 或仓库"
              />
            </label>
            {chips.length > 1 && (
              <div className="developer-segments">
                {chips.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={filter === item.key}
                    onClick={() => setFilter(item.key)}
                  >
                    {item.label}
                    {item.key !== "all" && <span>{item.count}</span>}
                  </button>
                ))}
              </div>
            )}
            {autoClaiming && <output className="developer-sync">正在同步你的个人插件…</output>}
            {autoClaimFailed && (
              <p className="developer-error" role="alert">
                {autoClaimMessage}
              </p>
            )}
            {plugins?.error && (
              <p className="developer-error" role="alert">
                {plugins.error.message}
              </p>
            )}
            {!plugins && <p className="developer-empty">正在读取插件…</p>}
            {plugins?.data && items.length === 0 && (
              <p className="developer-empty">
                {mine.length === 0 ? "还没有认领的插件" : "没有匹配的插件"}
              </p>
            )}
            <ul className="developer-plugins">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="developer-row"
                    aria-pressed={item.id === selected?.id}
                    onClick={() => select(item.id)}
                  >
                    <span className="developer-row-title">{item.name}</span>
                    {unreadPlugins.has(item.id) && (
                      <>
                        <span className="developer-dot" aria-hidden="true" />
                        <span className="visually-hidden">有未读通知</span>
                      </>
                    )}
                    {item.claim && item.claim !== "active" && (
                      <span className="developer-status">{CLAIM_LABEL[item.claim]}</span>
                    )}
                    <span className="developer-row-metric">
                      <span data-zero={item[sort] === 0}>{formatCount(item[sort])}</span>
                      <Meter value={item[sort]} max={max} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="developer-org">
              <button
                type="button"
                className="developer-text-button is-muted"
                aria-expanded={organizationOpen}
                onClick={() => setOrganizationOpen(!organizationOpen)}
              >
                <Icon name="plus" size={14} />
                认领组织仓库的插件
              </button>
              {organizationOpen && (
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
                  <label className="visually-hidden" htmlFor="organization-plugin">
                    组织插件 ID
                  </label>
                  <div className="developer-org-row">
                    <input
                      id="organization-plugin"
                      list="organization-plugins"
                      value={organizationPluginId}
                      onChange={(event) => setOrganizationPluginId(event.target.value)}
                      placeholder="输入插件 ID 或选择插件"
                      required
                    />
                    <button
                      className="developer-button"
                      type="submit"
                      disabled={
                        busy ||
                        autoClaiming ||
                        !organizationCandidates.some((item) => item.id === organizationPluginId)
                      }
                    >
                      申请
                    </button>
                  </div>
                  <datalist id="organization-plugins">
                    {organizationCandidates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.repository}
                      </option>
                    ))}
                  </datalist>
                  <p className="developer-hint">需要你在该组织有维护权限，由管理员审核。</p>
                </form>
              )}
            </div>
          </section>
          <div className="developer-detail-slot" ref={detailRef}>
            {selected ? (
              <PluginDetail
                key={selected.id}
                plugin={selected}
                session={selected.claim === "active" ? session : undefined}
                revision={revision}
                tab={tab}
                onTab={setTab}
                notices={notices.filter((notice) => notice.plugin_id === selected.id)}
                busy={busy}
                onReadNotice={readNotice}
                totalDownloads={active.reduce((total, item) => total + item.downloads, 0)}
              />
            ) : (
              <section className="developer-detail is-empty">
                <p className="developer-empty">
                  {plugins?.data
                    ? "认领插件后，下载数据、版本和评论会显示在这里。"
                    : "正在读取插件…"}
                </p>
              </section>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

export default function DeveloperPage() {
  const [revision, setRevision] = useState(0);
  const session = useResource<Session>("/api/auth/session", revision);
  const needsLogin = session?.error instanceof ApiError && session.error.status === 401;
  if (session?.data)
    return (
      <div className="developer-page">
        <Dashboard session={session.data} signOut={() => setRevision((value) => value + 1)} />
      </div>
    );
  return (
    <div className="developer-page">
      <TopBar>
        <ThemeSwitch />
      </TopBar>
      <main className="developer-main">
        {!session && <p className="developer-empty">正在检查登录状态…</p>}
        {needsLogin && (
          <section className="developer-login">
            <h2>使用 GitHub 登录</h2>
            <p>登录后自动核验并认领你拥有的公开个人仓库。组织仓库需要手动申请和管理员审核。</p>
            <a className="developer-button" href="/api/auth/github/start">
              使用 GitHub 继续
            </a>
            <p className="developer-hint">无需授予私有仓库或代码写入权限。</p>
          </section>
        )}
        {session?.error && !needsLogin && (
          <section className="developer-login">
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
            <p className="developer-hint">插件市场索引可以继续使用。</p>
          </section>
        )}
      </main>
    </div>
  );
}
