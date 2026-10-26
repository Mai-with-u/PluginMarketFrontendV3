import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../components/Icon.tsx";
import { loadCatalog } from "../data/catalog.ts";
import type { Catalog } from "../data/types.ts";
import { useResource } from "./api.ts";
import type { Notice, Plugin, Resource, Session } from "./api.ts";
import { FeedbackPanel } from "./FeedbackPanel.tsx";
import { formatCount, percent, shortDate } from "./format.ts";

type VersionRange = { min_version?: string; max_version?: string };
interface Release {
  version: string | null;
  tag: string | null;
  status: "published" | "prerelease" | "yanked" | "rejected" | "ignored";
  published_at: string | null;
  url: string;
  host: VersionRange;
  sdk: VersionRange;
  error: string | null;
}
interface Releases {
  items: Release[];
  mode: string;
  catalog_synced_at: string;
}
export type DetailTab = "reviews" | "releases" | "notices";

export const CLAIM_LABEL = {
  active: "已认领",
  pending: "审核中",
  revoked: "已撤销",
  rejected: "未通过",
};
const STATUS = {
  published: "已收录",
  prerelease: "预发布",
  yanked: "已撤回",
  rejected: "校验未通过",
  ignored: "标签未收录",
};
const range = (value: VersionRange) =>
  value.min_version || value.max_version
    ? `${value.min_version ?? "不限"} — ${value.max_version ?? "不限"}`
    : "未声明";

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="developer-tip">
      <button type="button" className="developer-ghost" aria-label={label} aria-describedby={id}>
        <Icon name="info" size={15} />
      </button>
      <span id={id} role="tooltip" className="developer-tip-body">
        {children}
      </span>
    </span>
  );
}

export function Meter({ value, max }: { value: number; max: number }) {
  const width = max > 0 && value > 0 ? Math.min(100, Math.max(4, (value / max) * 100)) : 0;
  return (
    <span className="developer-meter" aria-hidden="true">
      <span style={{ width: `${width}%` }} />
    </span>
  );
}

/** Secondary context lives in the hover hint and screen-reader text, not on the page. */
export function Stat({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="developer-stat" title={hint}>
      <dt>{label}</dt>
      <dd>
        {value}
        {hint && <span className="visually-hidden">，{hint}</span>}
        {children}
      </dd>
    </div>
  );
}

function useCatalogEntry(plugin: Plugin) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    let active = true;
    void loadCatalog().then(
      (value) => {
        if (active) setCatalog(value);
        return undefined;
      },
      // The market index only adds the category and version; the page works without it.
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);
  return catalog?.plugins.find(
    (entry) => entry.id === plugin.market_id || entry.manifestId === plugin.id,
  );
}

function ReleaseList({ releases }: { releases: Resource<Releases> | undefined }) {
  const [limit, setLimit] = useState(10);
  if (!releases) return <p className="developer-empty">正在读取发布记录…</p>;
  if (releases.error)
    return (
      <p className="developer-error" role="alert">
        {releases.error.message}
      </p>
    );
  const items = releases.data?.items ?? [];
  if (items.length === 0) return <p className="developer-empty">目录中暂无发布记录</p>;
  return (
    <>
      <ul className="developer-releases">
        {items.slice(0, limit).map((release) => (
          <li key={`${release.status}-${release.tag}-${release.version}`}>
            <a
              className="developer-release-version"
              href={release.url}
              target="_blank"
              rel="noreferrer"
            >
              {release.version ?? release.tag ?? "分支版本"}
            </a>
            <span className={`developer-release-status release-${release.status}`}>
              {STATUS[release.status]}
            </span>
            {release.tag && release.tag !== release.version && (
              <span className="developer-release-meta">{release.tag}</span>
            )}
            {release.published_at && (
              <time className="developer-release-meta" dateTime={release.published_at}>
                {new Date(release.published_at).toLocaleDateString()}
              </time>
            )}
            {(release.status === "published" ||
              release.status === "prerelease" ||
              release.status === "yanked") && (
              <span className="developer-release-range" title={`SDK ${range(release.sdk)}`}>
                MaiBot {range(release.host)}
                <span className="visually-hidden">，SDK {range(release.sdk)}</span>
              </span>
            )}
            {release.error && (
              <details className="developer-release-error">
                <summary>查看原因</summary>
                <pre>{release.error}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
      {items.length > limit && (
        <button
          type="button"
          className="developer-text-button developer-more"
          onClick={() => setLimit((value) => value + 10)}
        >
          显示更多（还有 {items.length - limit} 个）
        </button>
      )}
    </>
  );
}

function NoticeList({
  notices,
  busy,
  onRead,
}: {
  notices: Notice[];
  busy: boolean;
  onRead: (notice: Notice) => void;
}) {
  if (notices.length === 0) return <p className="developer-empty">还没有通知</p>;
  return (
    <ul className="developer-notices">
      {notices.map((notice) => (
        <li key={notice.id} data-unread={notice.read_at === null}>
          <span className="developer-dot" aria-hidden="true" />
          <span className="developer-notice-text">
            {notice.message}
            {notice.read_at === null && <span className="visually-hidden">，未读</span>}
          </span>
          <time dateTime={new Date(notice.created * 1000).toISOString()}>
            {shortDate(notice.created)}
          </time>
          {notice.read_at === null && (
            <button
              type="button"
              className="developer-ghost"
              aria-label="标为已读"
              disabled={busy}
              onClick={() => onRead(notice)}
            >
              <Icon name="check" size={14} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PluginDetail({
  plugin,
  session,
  revision,
  tab,
  onTab,
  notices,
  busy,
  onReadNotice,
  totalDownloads,
}: {
  plugin: Plugin;
  session?: Session;
  revision: number;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  notices: Notice[];
  busy: boolean;
  onReadNotice: (notice: Notice) => void;
  totalDownloads: number;
}) {
  const [pendingReviews, setPendingReviews] = useState(0);
  const entry = useCatalogEntry(plugin);
  const releases = useResource<Releases>(
    `/api/developer/plugins/${encodeURIComponent(plugin.id)}/releases`,
    revision,
  );
  const version =
    releases?.data?.items.find((release) => release.status === "published")?.version ??
    entry?.version;
  const tabs: [DetailTab, string, string, boolean][] = [
    ["reviews", "评论", formatCount(plugin.comments), pendingReviews > 0],
    ["releases", "版本", releases?.data ? String(releases.data.items.length) : "", false],
    ["notices", "通知", String(notices.length), notices.some((item) => item.read_at === null)],
  ];
  const tips = {
    reviews:
      "评论来自插件市场，约每分钟同步，署名不代表 GitHub 身份。你的回复会公开显示在评论下方。",
    releases: releases?.data
      ? `市场目录同步于 ${new Date(releases.data.catalog_synced_at).toLocaleString()}。${
          releases.data.mode === "branch" ? "当前使用分支版本。" : "状态以市场收录结果为准。"
        }`
      : "状态以市场收录结果为准。",
    notices: "认领后开始记录。点赞显示两次同步之间的净变化；首次认领不会生成历史通知。",
  };
  return (
    <section className="developer-detail" aria-labelledby="developer-detail-title">
      <div className="developer-detail-head">
        <div className="developer-detail-title">
          <h2 id="developer-detail-title">{plugin.name}</h2>
          <p>
            {version && <span className="developer-version">v{version}</span>}
            {entry && <span>{entry.primaryCategory}</span>}
            {plugin.claim && plugin.claim !== "active" && (
              <span className="developer-status">{CLAIM_LABEL[plugin.claim]}</span>
            )}
          </p>
        </div>
        <div className="developer-detail-links">
          <a
            className="developer-button is-quiet"
            href={`/?p=${encodeURIComponent(plugin.market_id)}`}
          >
            市场页
          </a>
          <a
            className="developer-button is-quiet"
            href={`https://github.com/${plugin.repository}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`在 GitHub 打开 ${plugin.repository}`}
          >
            GitHub
            <Icon name="external" size={12} />
          </a>
        </div>
      </div>
      <dl className="developer-stats">
        <Stat
          label="近 7 天"
          value={formatCount(plugin.downloads_7d)}
          hint={`占近 30 天下载的 ${percent(plugin.downloads_7d, plugin.downloads_30d)}`}
        />
        <Stat
          label="近 30 天"
          value={formatCount(plugin.downloads_30d)}
          hint={`日均 ${(plugin.downloads_30d / 30).toFixed(1)} 次`}
        />
        <Stat
          label="累计下载"
          value={formatCount(plugin.downloads)}
          hint={`占你全部插件下载的 ${percent(plugin.downloads, totalDownloads)}`}
        />
        <Stat
          label="好评率"
          value={percent(plugin.likes, plugin.likes + plugin.dislikes)}
          hint={`${plugin.likes} 赞 · ${plugin.dislikes} 踩`}
        />
      </dl>
      <div className="developer-tabs">
        {tabs.map(([id, label, count, attention]) => (
          <button
            key={id}
            type="button"
            className="developer-tab"
            aria-pressed={tab === id}
            onClick={() => onTab(id)}
          >
            {label}
            {count && <span className="developer-tab-count">{count}</span>}
            {attention && (
              <>
                <span className="developer-dot" aria-hidden="true" />
                <span className="visually-hidden">，需要处理</span>
              </>
            )}
          </button>
        ))}
        <InfoTip label="说明">{tips[tab]}</InfoTip>
      </div>
      <div className="developer-tab-panel">
        {tab === "reviews" && (
          <FeedbackPanel
            embedded
            pluginId={plugin.id}
            session={session}
            revision={revision}
            onPending={setPendingReviews}
          />
        )}
        {tab === "releases" && <ReleaseList releases={releases} />}
        {tab === "notices" && <NoticeList notices={notices} busy={busy} onRead={onReadNotice} />}
      </div>
    </section>
  );
}
