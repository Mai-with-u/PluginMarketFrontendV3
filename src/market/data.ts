import type { Catalog, CategoryId, Plugin } from "../data/types.ts";

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

/** 英文单词整体算一个词，中文按相邻两字切分；标点和符号只当分隔 */
function terms(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length > 2) counts.set(word, (counts.get(word) ?? 0) + 1);
      continue;
    }
    for (let i = 0; i < word.length - 1; i++) {
      const pair = word.slice(i, i + 2);
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
  }
  return counts;
}

const describe = (name: string, keywords: string[], categories: string[], description: string) =>
  // 名称最能说明用途，重复一次提高权重
  [name, name, ...keywords, ...categories, description].join(" ");

/**
 * 随构建发布的目录之后才上架的插件没有归一层给的分区。按名称、关键词和简介，
 * 找文字最相近的 7 个已分区插件加权投票。拿已知插件留一法验证约七成准确，
 * 只用于浏览；目录重新同步后由归一层的结果取代。
 */
function rangeGuesser(catalog: Catalog): (text: string) => CategoryId {
  const docs = catalog.plugins.map((p) => ({
    range: p.categoryId,
    terms: terms(describe(p.name, p.keywords, p.categories, p.description)),
    weights: new Map<string, number>(),
    norm: 1,
  }));
  const df = new Map<string, number>();
  for (const doc of docs)
    for (const term of doc.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const weigh = (counts: Map<string, number>, out: Map<string, number>) => {
    let sum = 0;
    for (const [term, count] of counts) {
      const w =
        (1 + Math.log(count)) * (Math.log((docs.length + 1) / ((df.get(term) ?? 0) + 1)) + 1);
      out.set(term, w);
      sum += w * w;
    }
    return Math.sqrt(sum) || 1;
  };
  for (const doc of docs) doc.norm = weigh(doc.terms, doc.weights);
  return (text) => {
    const query = new Map<string, number>();
    const norm = weigh(terms(text), query);
    const nearest = docs
      .map((doc) => {
        let dot = 0;
        for (const [term, w] of query) dot += w * (doc.weights.get(term) ?? 0);
        return { range: doc.range, score: dot / (norm * doc.norm) };
      })
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 7);
    const votes = new Map<CategoryId, number>();
    for (const { range, score } of nearest) votes.set(range, (votes.get(range) ?? 0) + score);
    let best: CategoryId = "other";
    let top = 0;
    for (const [range, score] of votes)
      if (score > top) {
        best = range;
        top = score;
      }
    return best;
  };
}

export function mergeCatalog(catalog: Catalog, live: PublicCatalog): MarketPlugin[] {
  const originals = new Map(catalog.plugins.map((p) => [p.id.toLowerCase(), p]));
  const labels = new Map(catalog.categories.map((c) => [c.id, c.label]));
  let guess: ((text: string) => CategoryId) | undefined;
  return live.items.map((entry, index) => {
    const old = originals.get(entry.market_id.toLowerCase());
    const m = entry.manifest;
    const author = entry.repository.split("/")[0] ?? "";
    // 目录里已有的插件沿用归一层的分区；新插件先看清单是否直接写了分区名，再按相似插件推断
    const categoryId =
      old?.categoryId ??
      catalog.categories.find((c) => m.categories?.includes(c.label))?.id ??
      (guess ??= rangeGuesser(catalog))(
        describe(entry.name, m.keywords ?? [], m.categories ?? [], m.description ?? ""),
      );
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
      categoryId,
      primaryCategory: old?.primaryCategory ?? labels.get(categoryId) ?? "其他",
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
