import type { Catalog, CategoryId, Plugin } from "../data/types.ts";

/**
 * 地形图布局。世界坐标单位是缩放为 1 时的 CSS px。
 * 每个分区是一座山：插件越多山越高、坡越宽；插件按黄金角螺旋（葵花籽排布）落在山上，
 * 越靠近山顶的越“重”（精选、清单完整、权限声明多）。
 */

export interface Region {
  id: CategoryId;
  label: string;
  latin: string;
  description: string;
  count: number;
  x: number;
  y: number;
  /** 插件分布半径 */
  radius: number;
  /** 着色器里的山体高度 */
  height: number;
}

export interface Pin {
  plugin: Plugin;
  region: Region;
  x: number;
  y: number;
  /** 区内序号，0 在山顶 */
  rank: number;
}

export interface Atlas {
  regions: Region[];
  pins: Pin[];
  pinById: Map<string, Pin>;
  /** 按分区、再按螺旋序排好的浏览顺序 */
  tour: Pin[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** 手工排的山脉走向：工具实用居中为主峰，“其他”是东边的小岛 */
const SITES: Record<CategoryId, { x: number; y: number; latin: string }> = {
  entertainment: { x: 248, y: 323, latin: "Entertainment" },
  moderation: { x: -56, y: 930, latin: "Moderation" },
  utility: { x: 1013, y: 640, latin: "Utility" },
  integration: { x: 1832, y: 996, latin: "Integration" },
  generation: { x: 1026, y: 6, latin: "Generation" },
  search: { x: 1805, y: 270, latin: "Search" },
  media: { x: 1092, y: 1274, latin: "Media" },
  automation: { x: 419, y: 1128, latin: "Automation" },
  other: { x: 2307, y: 627, latin: "Miscellany" },
};

const SPACING = 27;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function weight(p: Plugin): number {
  return (
    (p.featured ? 1000 : 0) +
    (p.hasDetails ? 100 : 0) +
    (p.icon !== null ? 40 : 0) +
    p.capabilities.length
  );
}

export function buildAtlas(catalog: Catalog): Atlas {
  if (catalog.plugins.length === 0)
    return {
      regions: [],
      pins: [],
      pinById: new Map(),
      tour: [],
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    };
  const max = Math.max(...catalog.categories.map((c) => c.count));
  const regions: Region[] = catalog.categories.map((c) => {
    const site = SITES[c.id];
    return {
      id: c.id,
      label: c.label,
      latin: site.latin,
      description: c.description,
      count: c.count,
      x: site.x,
      y: site.y,
      radius: SPACING * Math.sqrt(c.count + 1),
      height: 0.42 + 1.05 * Math.sqrt(c.count / max),
    };
  });

  const pins: Pin[] = [];
  const tour: Pin[] = [];
  regions.forEach((region, ri) => {
    const members = catalog.plugins
      .filter((p) => p.categoryId === region.id)
      .toSorted((a, b) => weight(b) - weight(a) || a.catalogIndex - b.catalogIndex);
    members.forEach((plugin, rank) => {
      const r = SPACING * Math.sqrt(rank + 0.5);
      const a = rank * GOLDEN_ANGLE + ri * 1.7;
      const pin = {
        plugin,
        region,
        rank,
        x: region.x + r * Math.cos(a),
        y: region.y + r * Math.sin(a),
      };
      pins.push(pin);
      tour.push(pin);
    });
  });

  const pad = 160;
  const bounds = {
    minX: Math.min(...regions.map((r) => r.x - r.radius)) - pad,
    minY: Math.min(...regions.map((r) => r.y - r.radius)) - pad,
    maxX: Math.max(...regions.map((r) => r.x + r.radius)) + pad,
    maxY: Math.max(...regions.map((r) => r.y + r.radius)) + pad,
  };

  return { regions, pins, pinById: new Map(pins.map((p) => [p.plugin.id, p])), tour, bounds };
}
