import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../worker.mjs";

const env = {
  ASSETS: { fetch: async () => new Response("static market") },
  DEVELOPER_ORIGIN: "https://backend.example",
  DEVELOPER_INGRESS_KEY: "private-ingress-key",
};
const origin = "https://plugin.maibot.chat";

test("static catalog is independent of the API configuration", async () => {
  const result = await worker.fetch(new Request(origin + "/data/catalog.json"), {
    ASSETS: env.ASSETS,
  });
  assert.equal(await result.text(), "static market");
});

test("preview, unknown paths and unauthenticated writes are rejected", async () => {
  assert.equal(
    (await worker.fetch(new Request("https://preview.workers.dev/api/auth/session"), env)).status,
    403,
  );
  assert.equal((await worker.fetch(new Request(origin + "/api/stats/rate"), env)).status, 404);
  assert.equal(
    (
      await worker.fetch(
        new Request(origin + "/api/developer/claims", { method: "POST", body: "{}" }),
        env,
      )
    ).status,
    403,
  );
  assert.equal((await worker.fetch(new Request(origin + "/api/feedback/x%2Fy"), env)).status, 404);
});

test("proxy replaces trusted headers, strips unrelated cookies and does not follow OAuth redirects", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.hostname, "backend.example");
    assert.equal(init.headers.get("x-market-ingress"), env.DEVELOPER_INGRESS_KEY);
    assert.equal(init.headers.get("x-client-ip"), "1.2.3.4");
    assert.equal(init.headers.get("cookie"), "__Host-pm_session=known");
    assert.equal(init.headers.get("authorization"), null);
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: {
        Location: "https://github.com/login/oauth/authorize",
        "Set-Cookie": "__Host-pm_oauth=state; Path=/; Secure; HttpOnly; SameSite=Lax",
      },
    });
  });
  const response = await worker.fetch(
    new Request(origin + "/api/auth/github/start", {
      headers: {
        "X-Market-Ingress": "forged",
        "X-Client-IP": "forged",
        "CF-Connecting-IP": "1.2.3.4",
        Cookie: "unrelated=private; __Host-pm_session=known",
        Authorization: "Bearer forged",
      },
    }),
    env,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
});

test("oversized bodies and unavailable origins fail safely", async (t) => {
  const request = new Request(origin + "/api/developer/claims", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "x".repeat(13000),
  });
  assert.equal((await worker.fetch(request, env)).status, 413);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("private-network-details");
  });
  const response = await worker.fetch(new Request(origin + "/api/auth/session"), env);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private-network-details"));
});
