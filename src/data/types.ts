export type CategoryId =
  | "adapter"
  | "tool"
  | "provider"
  | "management"
  | "data"
  | "media"
  | "game"
  | "integration"
  | "other"
  | "chat"
  | "creative"
  | "automation"
  | "deskpet";

export type RegionId = CategoryId | "uncategorized";

export interface Category {
  id: CategoryId;
  label: string;
  description: string;
  count: number;
}

export interface Plugin {
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
  categoryId: CategoryId | null;
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

export interface Catalog {
  generatedAt: string;
  counts: { plugins: number; details: number; icons: number; authors: number };
  featuredIds: string[];
  categories: Category[];
  plugins: Plugin[];
}

export type SortKey = "featured" | "index" | "name" | "version" | "capabilities";

export interface CatalogQuery {
  q: string;
  cat: CategoryId | null;
  sort: SortKey;
  iconOnly: boolean;
  syncedOnly: boolean;
}
