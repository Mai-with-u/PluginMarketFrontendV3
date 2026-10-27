import type { Catalog, Category, CategoryId, Plugin } from "../data/types.ts";

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

export type PublicManifest = PublicPlugin["manifest"];

// UI taxonomy only. Membership and counts are derived from the current manifest.
export const categories: Category[] = [
  { id: "entertainment", label: "娱乐互动", description: "游戏和互动", count: 0 },
  { id: "moderation", label: "群管审核", description: "群管理和安全审核", count: 0 },
  { id: "utility", label: "工具实用", description: "日常工具", count: 0 },
  { id: "integration", label: "外部接入", description: "平台和服务接入", count: 0 },
  { id: "generation", label: "内容生成", description: "创作与内容生成", count: 0 },
  { id: "search", label: "搜索检索", description: "搜索和知识检索", count: 0 },
  { id: "media", label: "语音多媒体", description: "音频视频与多媒体", count: 0 },
  { id: "automation", label: "自动化", description: "自动任务和工作流", count: 0 },
  { id: "other", label: "其他", description: "未分类插件", count: 0 },
];

export function categoryFor(manifest: PublicManifest): Category {
  const explicit = categories.find((c) =>
    manifest.categories?.some((v) => v === c.id || v === c.label),
  );
  if (explicit) return explicit;
  const byType: Record<string, CategoryId> = {
    adapter: "integration",
    provider: "integration",
    management: "moderation",
    security: "moderation",
    search: "search",
    knowledge: "search",
    creative: "generation",
    media: "media",
    game: "entertainment",
    automation: "automation",
    tool: "utility",
  };
  // Undeclared categories are inferred from current metadata, never an old plugin list.
  const text = [
    ...(manifest.categories ?? []),
    ...(manifest.keywords ?? []),
    manifest.description ?? "",
  ].join(" ");
  const inferred =
    byType[manifest.plugin_type ?? ""] ??
    (/群管|审核|禁言|踢人/.test(text)
      ? "moderation"
      : /绘图|画图|文生图|图片生成|创作/.test(text)
        ? "generation"
        : /语音|音乐|视频|TTS/i.test(text)
          ? "media"
          : /搜索|检索|知识库/.test(text)
            ? "search"
            : /游戏|抽签|占卜|好感|戳一戳/.test(text)
              ? "entertainment"
              : /定时|日程|提醒|自动化/.test(text)
                ? "automation"
                : /适配器|平台接入|API接入/.test(text)
                  ? "integration"
                  : "other");
  const category = categories.find((c) => c.id === inferred);
  if (!category) throw new Error("未知分类");
  return category;
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
      categoryId: category.id,
      primaryCategory: category.label,
      categories: m.categories ?? [],
      keywords: m.keywords ?? [],
      pluginType: m.plugin_type ?? "extension",
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
