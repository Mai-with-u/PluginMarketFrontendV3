import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Monogram, CopyRepoButton } from "../components/parts.tsx";
import { hostRange, sdkRange } from "../data/catalog.ts";
import { useResource } from "../developer/api.ts";
import { FeedbackPanel } from "../developer/FeedbackPanel.tsx";
import { safeLink, statuses } from "./data.ts";
import type { MarketPlugin, Releases } from "./data.ts";
import { InstallButton } from "./InstallButton.tsx";

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />
  ),
};

function Readme({ repository, commit }: { repository: string; commit?: string }) {
  const [result, setResult] = useState<{ text?: string; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    const ref = commit ? `?ref=${encodeURIComponent(commit)}` : "";
    void fetch(`https://api.github.com/repos/${repository}/readme${ref}`, {
      headers: { Accept: "application/vnd.github.raw+json" },
      signal: controller.signal,
      credentials: "omit",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "此版本没有 README。"
              : `GitHub 文档读取失败（${response.status}），可通过仓库链接查看。`,
          );
        const text = await response.text();
        if (!controller.signal.aborted) setResult({ text });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult({ error: error instanceof Error ? error.message : "文档读取失败" });
      });
    return () => controller.abort();
  }, [repository, commit]);
  if (!result) return <p>正在读取说明文档…</p>;
  if (result.error) return <p role="alert">{result.error}</p>;
  return (
    <div className="market-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={(url, key) => {
          try {
            return (
              safeLink(
                new URL(
                  url,
                  key === "src"
                    ? `https://raw.githubusercontent.com/${repository}/${commit ?? "HEAD"}/`
                    : `https://github.com/${repository}/blob/${commit ?? "HEAD"}/`,
                ).href,
              ) ?? ""
            );
          } catch {
            return "";
          }
        }}
      >
        {result.text}
      </Markdown>
    </div>
  );
}

export function PluginDetail({
  plugin: p,
  onClose,
}: {
  plugin: MarketPlugin;
  onClose: () => void;
}) {
  const releases = useResource<Releases>(
    `/api/market/plugins/${encodeURIComponent(p.manifestId ?? p.id)}/releases`,
  );
  const [version, setVersion] = useState("");
  const [tab, setTab] = useState("readme");
  const selected =
    releases?.data?.items.find((r) => r.tag === version) ??
    releases?.data?.items.find((r) => r.status === "published");
  const repository =
    p.repositoryUrl?.replace("https://github.com/", "").replace(/\.git$/, "") ?? "";
  return (
    <section className="market-detail" aria-label="插件详情">
      <button className="market-secondary" type="button" onClick={onClose}>
        ← 返回插件列表
      </button>
      <div className="market-detail-head">
        <Monogram plugin={p} size="xl" />
        <div>
          <h1>{p.name}</h1>
          <p>
            {p.authorName} · {p.manifestId ?? p.id}
          </p>
          <p>{p.description}</p>
        </div>
      </div>
      <div className="market-actions">
        <InstallButton pluginId={p.id} version={selected?.version ?? undefined} />
        <InstallButton pluginId={p.id} label="管理 / 评价此插件" detailOnly />
        <CopyRepoButton url={p.repositoryUrl} variant="ghost" />
        <a
          className="market-secondary"
          href={p.repositoryUrl ?? undefined}
          target="_blank"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
        {Object.entries(p.urls ?? {})
          .filter(([key, value]) => key !== "repository" && safeLink(value))
          .map(([key, value]) => (
            <a
              key={key}
              className="market-secondary"
              href={safeLink(value)}
              target="_blank"
              rel="noreferrer"
            >
              {(
                { homepage: "主页", documentation: "文档", issues: "反馈问题" } as Record<
                  string,
                  string
                >
              )[key] ?? key}{" "}
              ↗
            </a>
          ))}
      </div>
      <dl className="market-specs">
        {[
          ["版本", selected?.version ?? p.version ?? "未声明"],
          [
            "适用 MaiBot",
            selected
              ? `${selected.host.min_version ?? "不限"} — ${selected.host.max_version ?? "不限"}`
              : hostRange(p),
          ],
          [
            "SDK",
            selected
              ? `${selected.sdk.min_version ?? "不限"} — ${selected.sdk.max_version ?? "不限"}`
              : sdkRange(p),
          ],
          ["许可证", p.license ?? "未声明"],
          ["累计下载", p.stats?.downloads.toLocaleString() ?? "—"],
          ["近 7 天下载", p.stats?.downloads_7d.toLocaleString() ?? "—"],
          ["点赞 / 点踩", p.stats ? `${p.stats.likes} / ${p.stats.dislikes}` : "—"],
          [
            "评分",
            p.stats?.rating_count
              ? `${p.stats.rating.toFixed(1)} / 5（${p.stats.rating_count} 人）`
              : "暂无评分",
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="market-tabs" role="tablist" aria-label="插件详情栏目">
        {[
          ["readme", "说明文档"],
          ["releases", "版本与更新日志"],
          ["feedback", "评价与开发者回复"],
          ["permissions", "权限声明"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id ?? "readme")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="market-detail-body">
        {tab === "readme" && (
          <Readme
            key={`${repository}-${selected?.commit}`}
            repository={repository}
            commit={selected?.commit}
          />
        )}
        {tab === "feedback" && <FeedbackPanel pluginId={p.manifestId ?? p.id} />}
        {tab === "permissions" && (
          <>
            <h2>权限声明</h2>
            {p.capabilities.length ? (
              <ul className="market-permissions">
                {p.capabilities.map((cap) => (
                  <li key={cap}>
                    <code>{cap}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>此插件未声明权限。</p>
            )}
          </>
        )}
        {tab === "releases" && (
          <>
            {!releases && <p>正在读取版本…</p>}
            {releases?.error && <p role="alert">{releases.error.message}</p>}
            {releases?.data && (
              <>
                <p className="market-muted">
                  目录同步：{new Date(releases.data.catalog_synced_at).toLocaleString()} ·{" "}
                  {releases.data.mode === "branch" ? "使用分支版本" : "发布版本"}
                </p>
                {releases.data.items.length === 0 && <p>暂无 release 记录。</p>}
                {releases.data.items.some(
                  (r) => r.status === "published" || r.status === "prerelease",
                ) && (
                  <label>
                    选择版本{" "}
                    <select
                      value={version || selected?.tag || ""}
                      onChange={(e) => setVersion(e.target.value)}
                    >
                      {releases.data.items
                        .filter((r) => r.status === "published" || r.status === "prerelease")
                        .map((r) => (
                          <option key={r.tag} value={r.tag ?? ""}>
                            {r.version} · {statuses[r.status]}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {selected?.notes && (
                  <div className="market-markdown">
                    <Markdown remarkPlugins={[remarkGfm]}>{selected.notes}</Markdown>
                  </div>
                )}
                <ul className="market-release-list">
                  {releases.data.items.map((r) => (
                    <li key={`${r.status}-${r.tag}`}>
                      <div className="market-actions">
                        <a href={safeLink(r.url)} target="_blank" rel="noreferrer">
                          {r.version ?? r.tag} ↗
                        </a>
                        <span className="market-tag">{statuses[r.status]}</span>
                        {r.published_at && (
                          <time>{new Date(r.published_at).toLocaleDateString()}</time>
                        )}
                      </div>
                      {r.error && <pre>{r.error}</pre>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
