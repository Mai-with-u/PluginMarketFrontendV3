import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAtlas } from "../src/map/layout.ts";
import { catalogFromLive } from "../src/market/data.ts";

const item = {
  id: "test",
  market_id: "test",
  name: "live name",
  repository: "new-owner/new-repo",
  icon_url: "/api/market/icons/" + "a".repeat(40) + "/test.webp",
  manifest: {
    version: "2.0.0",
    description: "live description",
    author: { name: "new author" },
    categories: ["语音多媒体"],
    host_application: { min_version: "1.3.0" },
  },
  downloads: 123,
};
const live = (items) => ({ items, snapshot_at: 123, catalog_synced_at: "2026-10-28T00:00:00Z" });

test("all plugin metadata and icon revision come exclusively from live catalog", () => {
  const first = catalogFromLive(live([item]));
  assert.equal(first.plugins[0].icon, item.icon_url);
  assert.equal(first.plugins[0].version, "2.0.0");
  assert.equal(first.plugins[0].authorName, "new author");
  assert.equal(first.plugins[0].categoryId, "media");
  assert.equal(first.plugins[0].featured, false);
  assert.equal(first.counts.icons, 1);
  const changed = {
    ...item,
    icon_url: item.icon_url.replace("a".repeat(40), "b".repeat(40)),
    manifest: { ...item.manifest, version: "3.0.0", categories: ["工具实用"] },
  };
  const second = catalogFromLive(live([changed]));
  assert.notEqual(first.plugins[0].icon, second.plugins[0].icon);
  assert.equal(second.plugins[0].categoryId, "utility");
  assert.equal(second.categories.find((c) => c.id === "media").count, 0);
  assert.equal(second.plugins[0].version, "3.0.0");
  assert.equal(catalogFromLive(live([{ ...item, icon_url: null }])).counts.icons, 0);
});

test("missing and removed catalog entries cannot reappear from bundled data", () => {
  assert.equal(catalogFromLive(undefined).plugins.length, 0);
  assert.equal(catalogFromLive(live([])).plugins.length, 0);
  assert.deepEqual(buildAtlas(catalogFromLive(live([]))).pins, []);
  assert.throws(() => catalogFromLive(live([{ ...item, icon_url: "https://evil.test/icon.svg" }])));
});
