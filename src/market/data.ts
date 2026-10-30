import type { Catalog, Category, CategoryId, Plugin } from "../data/types.ts";

export interface Stats {
  downloads: number;
  downloads_7d: number;
  downloads_30d: number;
  likes: number;
  dislikes: number;
  rating: number;
  /** Decayed and shrunk toward the site mean; used only for ranking. */
  rating_score: number;
  rating_count: number;
  comments: number;
}
export interface MarketPlugin extends Plugin {
  stats?: Stats;
  updatedAt?: string;
  /** 最早一个版本的发布时间（上架时间）。 */
  publishedAt?: string | null;
  /** 至少两个正式版本时，最新正式版本的发布时间；否则为空。 */
  lastUpdateAt?: string | null;
  urls?: Record<string, string>;
}
interface PublicPlugin extends Stats {
  id: string;
  market_id: string;
  name: string;
  repository: string;
  updated_at: string;
  published_at?: string | null;
  last_update_at?: string | null;
  icon_url: string | null;
  manifest: {
    version?: string;
    description?: string;
    author?: { name?: string; url?: string };
    license?: string;
    host_application?: VersionRange;
    sdk?: VersionRange;
    keywords?: string[];
    categories?: string[];
    plugin_type?: string;
    type?: string;
    capabilities?: string[];
    urls?: Record<string, string>;
    manifest_version?: number;
  };
}
export interface PublicCatalog {
  items: PublicPlugin[];
  snapshot_at: number;
  catalog_synced_at: string;
}
export interface VersionRange {
  min_version?: string;
  max_version?: string;
}
export interface Release {
  version: string | null;
  tag: string | null;
  status: "published" | "prerelease" | "yanked" | "rejected" | "ignored";
  published_at: string | null;
  url: string;
  host: VersionRange;
  sdk: VersionRange;
  error: string | null;
  notes?: string;
  commit?: string;
}
export interface Releases {
  items: Release[];
  mode: string;
  catalog_synced_at: string;
}
export const types: Record<CategoryId, string> = {
  adapter: "适配器",
  tool: "工具",
  provider: "服务提供方",
  management: "管理",
  data: "数据与知识",
  media: "媒体",
  game: "游戏娱乐",
  integration: "外部集成",
  other: "其他",
  chat: "聊天",
  creative: "创作",
  automation: "自动化",
  deskpet: "桌宠",
};
export const statuses = {
  published: "已收录",
  prerelease: "预发布",
  yanked: "已撤回",
  rejected: "校验未通过",
  ignored: "标签未收录",
};

export type PublicManifest = PublicPlugin["manifest"];

// 分类只依据清单类型，避免根据描述推测未分类插件的用途。
export const categories: Category[] = (Object.entries(types) as [CategoryId, string][]).map(
  ([id, label]) => ({ id, label, description: label, count: 0 }),
);

export function categoryFor(manifest: PublicManifest): Category | null {
  const type = (manifest.plugin_type ?? manifest.type)?.trim().toLowerCase();
  if (!type || type === "extension") return null;
  const aliases: Record<string, CategoryId> = {
    knowledge: "data",
    entertainment: "game",
    search: "integration",
  };
  const id = aliases[type] ?? (Object.hasOwn(types, type) ? (type as CategoryId) : "other");
  return categories.find((category) => category.id === id) ?? null;
}

export function catalogFromLive(
  live: PublicCatalog | undefined,
): Omit<Catalog, "plugins"> & { plugins: MarketPlugin[] } {
  const plugins: MarketPlugin[] = (live?.items ?? []).map((entry, index) => {
    const m = entry.manifest;
    const author = entry.repository.split("/")[0] ?? "";
    const category = categoryFor(m);
    const icon = entry.icon_url;
    if (
      icon !== null &&
      icon !== undefined &&
      !/^\/api\/market\/icons\/[a-f0-9]{40}\/[A-Za-z0-9_.-]+\.webp$/.test(icon)
    )
      throw new Error("目录返回了无效的图标地址");
    return {
      id: entry.market_id,
      manifestId: entry.id,
      name: entry.name,
      description: m.description ?? "",
      version: m.version ?? null,
      authorName: m.author?.name ?? author,
      authorLogin: author,
      authorUrl: safeLink(m.author?.url) ?? `https://github.com/${author}`,
      license: m.license ?? null,
      repositoryUrl: `https://github.com/${entry.repository}`,
      categoryId: category?.id ?? null,
      primaryCategory: category?.label ?? "无类别",
      categories: m.categories ?? [],
      keywords: m.keywords ?? [],
      pluginType: category?.id ?? null,
      capabilities: m.capabilities ?? [],
      hostMin: m.host_application?.min_version ?? null,
      hostMax: m.host_application?.max_version ?? null,
      sdkMin: m.sdk?.min_version ?? null,
      sdkMax: m.sdk?.max_version ?? null,
      icon: icon ?? null,
      manifestVersion: m.manifest_version ?? null,
      hasDetails: Object.keys(m).length > 0,
      featured: false,
      catalogIndex: index,
      stats: entry,
      updatedAt: entry.updated_at,
      publishedAt: entry.published_at ?? null,
      lastUpdateAt: entry.last_update_at ?? null,
      urls: m.urls,
    };
  });
  return {
    generatedAt: live?.catalog_synced_at ?? "",
    featuredIds: [],
    plugins,
    categories: categories.map((c) => ({
      ...c,
      count: plugins.filter((p) => p.categoryId === c.id).length,
    })),
    counts: {
      plugins: plugins.length,
      details: plugins.filter((p) => p.hasDetails).length,
      icons: plugins.filter((p) => p.icon !== null).length,
      authors: new Set(plugins.map((p) => p.authorLogin.toLowerCase())).size,
    },
  };
}

// A user-entered host version is advisory; the target MaiBot rechecks actual compatibility.
const parts = (s: string) => s.replace(/^v/, "").split(".").map(Number);
export function compatible(version: string, min: string | null, max: string | null): boolean {
  const compare = (a: string, b: string) => {
    const x = parts(a),
      y = parts(b);
    for (let i = 0; i < 3; i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  return (!min || compare(version, min) >= 0) && (!max || compare(version, max) <= 0);
}

export function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
