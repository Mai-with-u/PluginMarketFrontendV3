import assert from "node:assert/strict";
import { test } from "node:test";

import { rankPlugins } from "../src/market/ranking.ts";

const NOW = Date.parse("2026-10-30T00:00:00Z");
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const plugin = (id, stats, extra = {}) => ({
  id,
  manifestId: id,
  name: id,
  stats: {
    downloads: 0,
    downloads_7d: 0,
    downloads_30d: 0,
    likes: 0,
    dislikes: 0,
    rating: 0,
    rating_score: 0,
    rating_count: 0,
    comments: 0,
    ...stats,
  },
  ...extra,
});

test("a plugin listed within 24 hours outranks an established one", () => {
  const veteran = plugin(
    "veteran",
    { downloads: 10000, likes: 500, rating: 5, rating_score: 5, rating_count: 50 },
    {
      publishedAt: day(400),
      updatedAt: day(400),
    },
  );
  const fresh = plugin("fresh", {}, { publishedAt: day(0.1), updatedAt: day(0.1) });
  // Up to four plugins skip the random surprise slots, so the order is the pure score order.
  assert.deepEqual(
    rankPlugins([veteran, fresh], NOW, "seed").map((p) => p.id),
    ["fresh", "veteran"],
  );
  assert.deepEqual(
    rankPlugins([fresh, veteran], NOW + 3 * 86400000, "seed").map((p) => p.id),
    ["veteran", "fresh"],
  );
});

test("update boost only applies to a recent second stable release", () => {
  const updated = plugin(
    "updated",
    { downloads: 100 },
    { publishedAt: day(300), updatedAt: day(2), lastUpdateAt: day(2) },
  );
  const stale = plugin("stale", { downloads: 100 }, { publishedAt: day(300), updatedAt: day(300) });
  const [first, second] = rankPlugins([stale, updated], NOW, "seed");
  assert.equal(first.id, "updated");
  assert.equal(second.id, "stale");
});

test("top download growth earns a small boost; ranking is deterministic per seed", () => {
  const hot = plugin(
    "hot",
    { downloads: 100, downloads_7d: 90 },
    { publishedAt: day(300), updatedAt: day(300) },
  );
  const cold = plugin("cold", { downloads: 100 }, { publishedAt: day(300), updatedAt: day(300) });
  assert.equal(rankPlugins([cold, hot], NOW, "a")[0].id, "hot");
  const many = Array.from({ length: 12 }, (_, i) =>
    plugin("p" + i, { downloads: i * 10 }, { publishedAt: day(100 + i) }),
  );
  assert.deepEqual(
    rankPlugins(many, NOW, "s").map((p) => p.id),
    rankPlugins(many, NOW, "s").map((p) => p.id),
  );
});

test("a plugin with an icon edges ahead of an otherwise identical one", () => {
  const base = { publishedAt: day(300), updatedAt: day(300) };
  const plain = plugin("plain", { downloads: 100 }, { ...base, icon: null });
  const iconic = plugin(
    "iconic",
    { downloads: 100 },
    { ...base, icon: "/api/market/icons/x/y.webp" },
  );
  assert.deepEqual(
    rankPlugins([plain, iconic], NOW, "seed").map((p) => p.id),
    ["iconic", "plain"],
  );
});
