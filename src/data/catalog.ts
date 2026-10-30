import type { Catalog, CatalogQuery, Category, CategoryId, Plugin, SortKey } from "./types.ts";

export function categoryById(catalog: Catalog, id: CategoryId): Category {
  const found = catalog.categories.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`未知分区 ${id}`);
  }
  return found;
}

export function sectorCode(catalog: Catalog, id: CategoryId): string {
  return `S-${String(catalog.categories.findIndex((c) => c.id === id) + 1).padStart(2, "0")}`;
}

function parseVersion(v: string | null): number[] {
  if (v === null) {
    return [];
  }
  return v
    .replace(/^v/i, "")
    .split(/[.\-+]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
}

export function compareVersion(a: string | null, b: string | null): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

function score(p: Plugin, tokens: string[]): number {
  let total = 0;
  const name = p.name.toLowerCase();
  const id = p.id.toLowerCase();
  const author = `${p.authorName} ${p.authorLogin}`.toLowerCase();
  const keywords = p.keywords.join(" ").toLowerCase();
  const description = p.description.toLowerCase();
  const manifestId = (p.manifestId ?? "").toLowerCase();
  for (const t of tokens) {
    let s = 0;
    if (name.startsWith(t)) s = 8;
    else if (name.includes(t)) s = 6;
    else if (id.includes(t) || manifestId.includes(t)) s = 5;
    else if (author.includes(t)) s = 4;
    else if (keywords.includes(t)) s = 3;
    else if (description.includes(t)) s = 2;
    if (s === 0) {
      return 0;
    }
    total += s;
  }
  return total;
}

export function queryCatalog(plugins: readonly Plugin[], query: CatalogQuery): Plugin[] {
  const tokens = query.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { p: Plugin; s: number }[] = [];
  for (const p of plugins) {
    if (query.cat !== null && p.categoryId !== query.cat) continue;
    if (query.iconOnly && p.icon === null) continue;
    if (query.syncedOnly && !p.hasDetails) continue;
    const s = tokens.length > 0 ? score(p, tokens) : 1;
    if (s > 0) {
      scored.push({ p, s });
    }
  }
  scored.sort((a, b) => {
    switch (query.sort) {
      case "featured":
        return (
          Number(b.p.featured) - Number(a.p.featured) ||
          b.s - a.s ||
          a.p.catalogIndex - b.p.catalogIndex
        );
      case "index":
        return b.s - a.s || a.p.catalogIndex - b.p.catalogIndex;
      case "name":
        return a.p.name.localeCompare(b.p.name, "zh-Hans-CN");
      case "version":
        return compareVersion(b.p.version, a.p.version) || a.p.catalogIndex - b.p.catalogIndex;
      case "capabilities":
        return (
          b.p.capabilities.length - a.p.capabilities.length || a.p.catalogIndex - b.p.catalogIndex
        );
    }
  });
  return scored.map((x) => x.p);
}

export function relatedPlugins(catalog: Catalog, plugin: Plugin, limit = 4): Plugin[] {
  const sameAuthor = catalog.plugins.filter(
    (p) => p.id !== plugin.id && p.authorLogin === plugin.authorLogin,
  );
  const sameCategory = catalog.plugins.filter(
    (p) =>
      p.id !== plugin.id &&
      p.authorLogin !== plugin.authorLogin &&
      plugin.categoryId !== null &&
      p.categoryId === plugin.categoryId &&
      p.hasDetails,
  );
  return [...sameAuthor.slice(0, 2), ...sameCategory].slice(0, limit);
}

export function hostRange(p: Plugin): string {
  if (p.hostMin === null && p.hostMax === null) return "未声明";
  if (p.hostMax === null) return `≥ ${p.hostMin}`;
  if (p.hostMin === null) return `≤ ${p.hostMax}`;
  if (p.hostMin === p.hostMax) return p.hostMin;
  return `${p.hostMin} – ${p.hostMax}`;
}

export function sdkRange(p: Plugin): string {
  if (p.sdkMin === null && p.sdkMax === null) return "未声明";
  return `${p.sdkMin ?? "?"} – ${p.sdkMax ?? "?"}`;
}

const graphemes = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function firstGrapheme(s: string): string | undefined {
  for (const { segment } of graphemes.segment(s)) return segment;
  return undefined;
}

/** 名称里第一个可见字符，用作无图标插件的字印。 */
export function monogram(p: Plugin): string {
  const cleaned = p.name.replace(/^[\s\p{P}\p{S}]+/u, "");
  return (firstGrapheme(cleaned) ?? firstGrapheme(p.id) ?? "?").toUpperCase();
}

export function isCategoryId(catalog: Catalog, value: string | null): value is CategoryId {
  return catalog.categories.some((c) => c.id === value);
}

const SORT_KEYS: ReadonlySet<string> = new Set<SortKey>([
  "featured",
  "index",
  "name",
  "version",
  "capabilities",
]);

export function isSortKey(value: string | null): value is SortKey {
  return value !== null && SORT_KEYS.has(value);
}

/** 插件代号：取 ID 的仓库名部分，去掉 maibot- 前缀和 -plugin 后缀，大写。 */
export function codename(p: Plugin): string {
  const dot = p.id.indexOf(".");
  const base = dot === -1 ? p.id : p.id.slice(dot + 1);
  const trimmed = base
    .replace(/^(maibot|maimbot|mai)[-_]/i, "")
    .replace(/[-_]?plugins?$/i, "")
    .replace(/[_.\s]+/g, "-")
    .toUpperCase();
  return trimmed === "" ? base.toUpperCase() : trimmed;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pad(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}
