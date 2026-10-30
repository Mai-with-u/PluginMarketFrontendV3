import type { Catalog, Plugin, RegionId } from "../data/types.ts";

/**
 * 地形图布局。世界坐标单位是缩放为 1 时的 CSS px。
 * 每个分区是一座山：插件越多山越高、坡越宽；插件按黄金角螺旋（葵花籽排布）落在山上，
 * 越靠近山顶的越“重”（精选、清单完整、权限声明多）。
 */

export interface Region {
  id: RegionId;
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

/** 每个类别独立布局；无类别仅作为地图展示区域。 */
const SITES: Record<RegionId, { x: number; y: number; latin: string }> = {
  adapter: { x: 0, y: 0, latin: "Adapter" },
  tool: { x: 650, y: 0, latin: "Tool" },
  provider: { x: 1300, y: 0, latin: "Provider" },
  management: { x: 1950, y: 0, latin: "Management" },
  data: { x: 2600, y: 0, latin: "Data" },
  media: { x: 0, y: 700, latin: "Media" },
  game: { x: 650, y: 700, latin: "Game" },
  integration: { x: 1300, y: 700, latin: "Integration" },
  other: { x: 1950, y: 700, latin: "Other" },
  chat: { x: 2600, y: 700, latin: "Chat" },
  creative: { x: 0, y: 1400, latin: "Creative" },
  automation: { x: 650, y: 1400, latin: "Automation" },
  deskpet: { x: 1300, y: 1400, latin: "Deskpet" },
  uncategorized: { x: 2300, y: 1450, latin: "Uncategorized" },
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
  const unclassified = catalog.plugins.filter((p) => p.categoryId === null).length;
  const mapCategories = [
    ...catalog.categories,
    ...(unclassified
      ? [
          {
            id: "uncategorized" as const,
            label: "无类别",
            description: "未分类插件",
            count: unclassified,
          },
        ]
      : []),
  ];
  const max = Math.max(...mapCategories.map((c) => c.count));
  const regions: Region[] = mapCategories.map((c) => {
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
      .filter((p) => (p.categoryId ?? "uncategorized") === region.id)
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
