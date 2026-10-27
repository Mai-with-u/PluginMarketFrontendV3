import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
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
  // README 里写的 width / height 要保留，徽章和 logo 才不会按原图尺寸铺开
  img: ({ src, alt, width, height, title }) => (
    <img
      src={src}
      alt={alt ?? ""}
      width={width}
      height={height}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  ),
};

/** raw.githubusercontent.com 区分大小写，依次试常见写法 */
const README_NAMES = ["README.md", "readme.md", "Readme.md"];
const readmes = new Map<string, Promise<string>>();

function cached(key: string): string | null {
  try {
    return sessionStorage.getItem(`readme:${key}`);
  } catch {
    return null;
  }
}

function remember(key: string, text: string): string {
  try {
    sessionStorage.setItem(`readme:${key}`, text);
  } catch {
    // 存储满了或被禁用时只靠内存缓存
  }
  return text;
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, credentials: "omit" });
  } catch {
    throw new Error("无法连接 GitHub，可稍后重试。");
  }
}

/**
 * 先读 raw.githubusercontent.com：不占 GitHub API 每个 IP 每小时 60 次的匿名额度，
 * MaiBot 自带的插件市场也是这样读的。文件名都对不上时才用 API 查找。
 */
async function fetchReadme(repository: string, ref: string, key: string): Promise<string> {
  const saved = cached(key);
  if (saved !== null) return saved;
  let found: Response | undefined;
  for (const name of README_NAMES) {
    // 依次尝试，命中即停，不需要并发
    // oxlint-disable-next-line eslint/no-await-in-loop
    const response = await get(`https://raw.githubusercontent.com/${repository}/${ref}/${name}`);
    if (response.ok) {
      found = response;
      break;
    }
    if (response.status !== 404) throw new Error(`GitHub 文档读取失败（${response.status}）。`);
  }
  if (found) return remember(key, await found.text());
  const query = ref === "HEAD" ? "" : `?ref=${encodeURIComponent(ref)}`;
  const response = await get(`https://api.github.com/repos/${repository}/readme${query}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  if (response.ok) return remember(key, await response.text());
  if (response.status === 404) throw new Error("此版本没有 README。");
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    const minutes = Math.max(1, Math.ceil((reset - Date.now()) / 60000));
    throw new Error(`GitHub 访问次数已达上限，约 ${minutes} 分钟后恢复。`);
  }
  throw new Error(`GitHub 文档读取失败（${response.status}）。`);
}

/** 同一仓库同一版本只读一次，本次会话内重复打开直接用缓存；失败的不缓存，下次可重试 */
function loadReadme(repository: string, ref: string): Promise<string> {
  const key = `${repository}@${ref}`;
  let pending = readmes.get(key);
  if (pending === undefined) {
    pending = fetchReadme(repository, ref, key);
    readmes.set(key, pending);
    void pending.then(undefined, () => readmes.delete(key));
  }
  return pending;
}

function Readme({ repository, commit }: { repository: string; commit?: string }) {
  const ref = commit ?? "HEAD";
  const [result, setResult] = useState<{ text?: string; error?: string }>();
  useEffect(() => {
    if (!repository) return;
    // 不随卸载中止请求：请求是共享缓存的，开发模式下的重复挂载也只发一次
    let active = true;
    void loadReadme(repository, ref).then(
      (text) => {
        if (active) setResult({ text });
        return undefined;
      },
      (error: unknown) => {
        if (active) setResult({ error: error instanceof Error ? error.message : "文档读取失败" });
      },
    );
    return () => {
      active = false;
    };
  }, [repository, ref]);
  if (!repository) return <p>插件没有登记 GitHub 仓库地址。</p>;
  if (!result) return <p>正在读取说明文档…</p>;
  if (result.error)
    return (
      <p role="alert">
        {result.error}{" "}
        <a href={`https://github.com/${repository}#readme`} target="_blank" rel="noreferrer">
          在 GitHub 查看 ↗
        </a>
      </p>
    );
  return (
    <div className="market-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // README 里的 HTML 按 GitHub 的白名单过滤：保留 align、width、details 等排版，去掉脚本、事件和样式
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
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
  revision,
}: {
  plugin: MarketPlugin;
  onClose: () => void;
  revision: number;
}) {
  const releases = useResource<Releases>(
    `/api/market/plugins/${encodeURIComponent(p.manifestId ?? p.id)}/releases`,
    revision,
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
        {tab === "readme" &&
          // 等版本信息回来再读，免得先按最新代码读一遍、拿到版本提交后再读一遍
          (releases ? (
            <Readme
              key={`${repository}-${selected?.commit}`}
              repository={repository}
              commit={selected?.commit}
            />
          ) : (
            <p>正在读取说明文档…</p>
          ))}
        {tab === "feedback" && (
          <FeedbackPanel pluginId={p.manifestId ?? p.id} revision={revision} />
        )}
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
