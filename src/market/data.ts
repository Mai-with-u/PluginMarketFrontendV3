import type { Catalog, Plugin } from "../data/types.ts";

export interface Stats {
  downloads: number;
  downloads_7d: number;
  downloads_30d: number;
  likes: number;
  dislikes: number;
  rating: number;
  rating_count: number;
  comments: number;
}
export interface MarketPlugin extends Plugin {
  stats?: Stats;
  updatedAt?: string;
  urls?: Record<string, string>;
}
interface PublicPlugin extends Stats {
  id: string;
  market_id: string;
  name: string;
  repository: string;
  updated_at: string;
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
export const types: Record<string, string> = {
  adapter: "适配器",
  chat: "聊天",
  creative: "创作",
  provider: "服务提供方",
  management: "管理",
  search: "检索搜索",
  knowledge: "知识",
  media: "媒体",
  game: "游戏娱乐",
  security: "安全防护",
  automation: "自动化",
  extension: "通用扩展",
  other: "其他",
};
export const statuses = {
  published: "已收录",
  prerelease: "预发布",
  yanked: "已撤回",
  rejected: "校验未通过",
  ignored: "标签未收录",
};

export function mergeCatalog(catalog: Catalog, live: PublicCatalog): MarketPlugin[] {
  const originals = new Map(catalog.plugins.map((p) => [p.id.toLowerCase(), p]));
  return live.items.map((entry, index) => {
    const old = originals.get(entry.market_id.toLowerCase());
    const m = entry.manifest;
    const author = entry.repository.split("/")[0] ?? "";
    const category = catalog.categories.find((c) => m.categories?.includes(c.label));
    return {
      id: entry.market_id,
      manifestId: entry.id,
      name: entry.name,
      description: m.description ?? "",
      version: m.version ?? null,
      authorName: m.author?.name ?? author,
      authorLogin: author,
      authorUrl: `https://github.com/${author}`,
      license: m.license ?? null,
      repositoryUrl: `https://github.com/${entry.repository}`,
      categoryId: category?.id ?? old?.categoryId ?? "other",
      primaryCategory: category?.label ?? old?.primaryCategory ?? "其他",
      categories: m.categories ?? [],
      keywords: m.keywords ?? [],
      pluginType: m.plugin_type ?? "extension",
      capabilities: m.capabilities ?? [],
      hostMin: m.host_application?.min_version ?? null,
      hostMax: m.host_application?.max_version ?? null,
      sdkMin: m.sdk?.min_version ?? null,
      sdkMax: m.sdk?.max_version ?? null,
      icon: old?.icon ?? null,
      manifestVersion: m.manifest_version ?? null,
      hasDetails: Object.keys(m).length > 0,
      featured: old?.featured ?? false,
      catalogIndex: index,
      stats: entry,
      updatedAt: entry.updated_at,
      urls: m.urls,
    };
  });
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
