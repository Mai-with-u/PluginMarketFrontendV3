import type { MarketPlugin } from "./data.ts";

// 默认排序与 MaiBot 本体的插件市场（MarketplaceTab.tsx 的 default 排序）保持一致：
// 下载、点赞、评分三项先除以全市场最大值再加权，再叠加上新、更新、新鲜度和飙升加成。
const SURPRISE_PLUGIN_COUNT = 4;
const SURPRISE_CANDIDATE_LIMIT = 20;
const DOWNLOAD_WEIGHT = 4;
const LIKE_WEIGHT = 3;
const RATING_WEIGHT = 2;
const FRESHNESS_BOOST_WEIGHT = 4;
const FRESHNESS_BOOST_WINDOW_DAYS = 120;
const LAUNCH_BOOST_WEIGHT = 12;
const LAUNCH_BOOST_FULL_HOURS = 24;
const LAUNCH_BOOST_DECAY_HOURS = 48;
const UPDATE_BOOST_WEIGHT = 3;
const UPDATE_BOOST_WINDOW_DAYS = 14;
const GROWTH_BOOST_RANK_LIMIT = 8;
const GROWTH_BOOST_WEIGHT_7D = 1;
const GROWTH_BOOST_WEIGHT_30D = 0.6;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** 上架时间：最早一个版本的发布时间。 */
const publishedTime = (p: MarketPlugin) => time(p.publishedAt);

/** 新鲜度时间：有上架时间用上架时间，否则退回最近更新时间。 */
export const freshness = (p: MarketPlugin) => publishedTime(p) || time(p.updatedAt);

const launchBoost = (p: MarketPlugin, now: number) => {
  const at = freshness(p);
  if (at <= 0) return 0;
  const hours = Math.max(0, (now - at) / MS_PER_HOUR);
  if (hours <= LAUNCH_BOOST_FULL_HOURS) return LAUNCH_BOOST_WEIGHT;
  if (hours >= LAUNCH_BOOST_DECAY_HOURS) return 0;
  const progress =
    (hours - LAUNCH_BOOST_FULL_HOURS) / (LAUNCH_BOOST_DECAY_HOURS - LAUNCH_BOOST_FULL_HOURS);
  return (1 - progress) * LAUNCH_BOOST_WEIGHT;
};

const freshnessBoost = (p: MarketPlugin, now: number) => {
  const at = freshness(p);
  if (at <= 0) return 0;
  const days = Math.max(0, (now - at) / MS_PER_DAY);
  return days >= FRESHNESS_BOOST_WINDOW_DAYS
    ? 0
    : (1 - days / FRESHNESS_BOOST_WINDOW_DAYS) * FRESHNESS_BOOST_WEIGHT;
};

const updateBoost = (p: MarketPlugin, now: number) => {
  const at = time(p.lastUpdateAt);
  if (at <= 0) return 0;
  const days = Math.max(0, (now - at) / MS_PER_DAY);
  return days >= UPDATE_BOOST_WINDOW_DAYS
    ? 0
    : (1 - days / UPDATE_BOOST_WINDOW_DAYS) * UPDATE_BOOST_WEIGHT;
};

/** 按窗口内下载量排出前几名；没有点赞增长数据，所以只计下载。 */
function growthRanks(plugins: MarketPlugin[], field: "downloads_7d" | "downloads_30d") {
  const ranks = new Map<MarketPlugin, number>();
  plugins
    .filter((p) => (p.stats?.[field] ?? 0) > 0)
    .toSorted((a, b) => (b.stats?.[field] ?? 0) - (a.stats?.[field] ?? 0))
    .slice(0, GROWTH_BOOST_RANK_LIMIT)
    .forEach((p, index) => ranks.set(p, index + 1));
  return ranks;
}

const normalize = (value: number, max: number, weight: number) =>
  max > 0 ? (value / max) * weight : 0;

const stableRank = (seed: string, p: MarketPlugin) => {
  const value = `${seed}:${p.manifestId}`;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/**
 * 默认（推荐）排序。`seed` 决定「惊喜推荐」位的抽选，同一会话内保持不变。
 * 评分项用衰减并收缩后的 rating_score，缺失时退回 rating。
 */
export function rankPlugins(plugins: MarketPlugin[], now: number, seed: string): MarketPlugin[] {
  const parts = plugins.map((p) => ({
    p,
    downloads: Math.log10((p.stats?.downloads ?? 0) + 1),
    likes: Math.log10((p.stats?.likes ?? 0) + 1),
    rating:
      (p.stats?.rating_score ?? p.stats?.rating ?? 0) *
      Math.log10((p.stats?.rating_count ?? 0) + 2),
  }));
  const max = (pick: (part: (typeof parts)[number]) => number) =>
    parts.reduce((best, part) => Math.max(best, pick(part)), 0);
  const maxDownloads = max((part) => part.downloads);
  const maxLikes = max((part) => part.likes);
  const maxRating = max((part) => part.rating);
  const rank7 = growthRanks(plugins, "downloads_7d");
  const rank30 = growthRanks(plugins, "downloads_30d");
  const growthOf = (rank: number | undefined, weight: number) =>
    rank === undefined
      ? 0
      : ((GROWTH_BOOST_RANK_LIMIT + 1 - rank) / GROWTH_BOOST_RANK_LIMIT) * weight;
  // 只取最强的一项，避免多个榜单的加成叠加。
  const growth = (p: MarketPlugin) =>
    Math.max(
      growthOf(rank7.get(p), GROWTH_BOOST_WEIGHT_7D),
      growthOf(rank30.get(p), GROWTH_BOOST_WEIGHT_30D),
    );
  const sorted = parts
    .map((part) => ({
      p: part.p,
      fresh: freshness(part.p),
      score:
        normalize(part.downloads, maxDownloads, DOWNLOAD_WEIGHT) +
        normalize(part.likes, maxLikes, LIKE_WEIGHT) +
        normalize(part.rating, maxRating, RATING_WEIGHT) +
        launchBoost(part.p, now) +
        updateBoost(part.p, now) +
        growth(part.p) +
        freshnessBoost(part.p, now),
    }))
    .toSorted(
      (a, b) => b.score - a.score || b.fresh - a.fresh || a.p.name.localeCompare(b.p.name, "zh-CN"),
    )
    .map((item) => item.p);
  if (sorted.length <= SURPRISE_PLUGIN_COUNT) return sorted;
  // 惊喜推荐：从较新的插件里按会话种子抽 4 个放在最前面。
  const candidates = Math.min(
    SURPRISE_CANDIDATE_LIMIT,
    Math.max(SURPRISE_PLUGIN_COUNT, Math.ceil(sorted.length * 0.3)),
  );
  const surprise = sorted
    .toSorted((a, b) => freshness(b) - freshness(a))
    .slice(0, candidates)
    .toSorted((a, b) => stableRank(seed, a) - stableRank(seed, b))
    .slice(0, SURPRISE_PLUGIN_COUNT);
  const chosen = new Set(surprise);
  return [...surprise, ...sorted.filter((p) => !chosen.has(p))];
}
