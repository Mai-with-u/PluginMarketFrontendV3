import assert from "node:assert/strict";
import { test } from "node:test";

import { registryIcon } from "../market-icons.mjs";

const path = "https://plugin.maibot.chat/api/market/icons/" + "a".repeat(40) + "/plugin.webp";
const valid = new TextEncoder().encode("RIFFxxxxWEBPtest");

test("icons are commit-pinned and never forward cookies or authorization", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(
      url,
      "https://raw.githubusercontent.com/Mai-with-u/plugin-repo/" +
        "a".repeat(40) +
        "/icons/plugin.webp",
    );
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, "manual");
    return new Response(valid, { headers: { "Content-Type": "image/webp" } });
  });
  const result = await registryIcon(
    new Request(path, { headers: { Cookie: "private", Authorization: "private" } }),
  );
  assert.equal(result.status, 200);
  assert.match(result.headers.get("Cache-Control"), /immutable/);
  assert.equal(result.headers.get("Content-Type"), "image/webp");
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), valid);
});

test("icon proxy rejects arbitrary targets before sending requests", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected fetch");
  });
  for (const url of [
    path + "?url=https://evil.test",
    path.replace("a".repeat(40), "main"),
    path.replace("plugin.webp", "x%2Fy.webp"),
    path.replace(".webp", ".svg"),
  ]) {
    assert.equal((await registryIcon(new Request(url))).status, 404);
  }
  assert.equal((await registryIcon(new Request(path, { method: "POST" }))).status, 404);
  assert.equal(mocked.mock.callCount(), 0);
});

test("missing, redirected, oversized and non-WebP assets never become cached HTML", async (t) => {
  for (const response of [
    new Response("", { status: 404 }),
    new Response("", { status: 302, headers: { Location: "https://evil.test" } }),
    new Response("<html>", { headers: { "Content-Type": "text/html" } }),
    new Response("not webp", { headers: { "Content-Type": "image/webp" } }),
    new Response(new Uint8Array(262145), { headers: { "Content-Type": "image/webp" } }),
  ]) {
    t.mock.method(globalThis, "fetch", async () => response);
    const result = await registryIcon(new Request(path));
    assert.ok([404, 502].includes(result.status));
    assert.equal(result.headers.get("Cache-Control"), null);
  }
});
