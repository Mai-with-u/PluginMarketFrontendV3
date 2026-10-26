/**
 * 从 maibot-plugin-market 的归一层生成本项目运行时读取的 catalog.json，并拷贝图标。
 *
 *   node scripts/sync-data.ts
 *   MAIBOT_MARKET_DATA=/path/to/data node scripts/sync-data.ts
 *
 * 归一层的口径说明见 maibot-plugin-market/data/normalized/README.md。
 */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface NormalizedPlugin {
  id: string;
  manifestId: string | null;
  name: string;
  description: string;
  version: string | null;
  authorName: string;
  authorUrl: string;
  authorLogin: string;
  license: string | null;
  repositoryUrl: string | null;
  primaryCategory: string;
  categories: string[];
  keywords: string[];
  pluginType: string | null;
  capabilities: string[];
  hostMin: string | null;
  hostMax: string | null;
  sdkMin: string | null;
  sdkMax: string | null;
  icon: string | null;
  manifestVersion: number | string | null;
  hasDetails: boolean;
  featured: boolean;
  catalogIndex: number;
}

interface NormalizedPlugins {
  generatedAt: string;
  featuredIds: string[];
  plugins: NormalizedPlugin[];
}

interface NormalizedCategories {
  taxonomy: { id: string; label: string; description: string; pluginCount: number }[];
}

interface NormalizedAuthors {
  counts: { authors: number };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(
  process.env["MAIBOT_MARKET_DATA"] ?? path.join(root, "../maibot-plugin-market/data"),
);

async function readJson<T>(file: string): Promise<T> {
  // 归一层是我们自己生成的产物，形状见其 README；这里只做读取。
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(await readFile(path.join(source, file), "utf8")) as T;
}

const plugins = await readJson<NormalizedPlugins>("normalized/plugins.json");
const categories = await readJson<NormalizedCategories>("normalized/categories.json");
const authors = await readJson<NormalizedAuthors>("normalized/authors.json");

const categoryIdByLabel = new Map(categories.taxonomy.map((c) => [c.label, c.id]));

const catalog = {
  generatedAt: plugins.generatedAt,
  counts: {
    plugins: plugins.plugins.length,
    details: plugins.plugins.filter((p) => p.hasDetails).length,
    icons: plugins.plugins.filter((p) => p.icon !== null).length,
    authors: authors.counts.authors,
  },
  featuredIds: plugins.featuredIds,
  categories: categories.taxonomy.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    count: c.pluginCount,
  })),
  plugins: plugins.plugins.map((p) => {
    const categoryId = categoryIdByLabel.get(p.primaryCategory);
    if (categoryId === undefined) {
      throw new Error(`未知主类 ${p.primaryCategory}（${p.id}）`);
    }
    return Object.assign(p, { categoryId });
  }),
};

const publicDir = path.join(root, "public");
await mkdir(path.join(publicDir, "data"), { recursive: true });
await writeFile(path.join(publicDir, "data/catalog.json"), JSON.stringify(catalog));

const iconsOut = path.join(publicDir, "icons");
await rm(iconsOut, { recursive: true, force: true });
await mkdir(iconsOut, { recursive: true });
const icons = (await readdir(path.join(source, "icons"))).filter((f) => f.endsWith(".webp"));
await Promise.all(
  icons.map((f) => copyFile(path.join(source, "icons", f), path.join(iconsOut, f))),
);

console.log(
  `catalog.json: ${catalog.counts.plugins} 插件 / ${catalog.counts.details} 详情 / ${icons.length} 图标 / ${catalog.counts.authors} 作者`,
);
