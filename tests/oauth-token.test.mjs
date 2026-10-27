import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import worker from "../worker.mjs";

const origin = "https://plugin.maibot.chat";
const url = origin + "/api/internal/github/token";
const env = {
  GITHUB_OAUTH_RELAY_KEY: "relay-key-" + "a".repeat(40),
  GITHUB_OAUTH_CLIENT_ID: "our-client",
  GITHUB_OAUTH_CLIENT_SECRET: "private-client-secret",
};
function signed(input = { code: "one-use-code", verifier: "v".repeat(64) }, age = 0) {
  const body = JSON.stringify(input);
  const timestamp = String(Math.floor(Date.now() / 1000) - age);
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-OAuth-Timestamp": timestamp,
      "X-OAuth-Signature": createHmac("sha256", env.GITHUB_OAUTH_RELAY_KEY)
        .update(`github-token-v1\n${timestamp}\n${body}`)
        .digest("hex"),
    },
  });
}
test("only fresh backend-signed requests can exchange codes", async (t) => {
  const outbound = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not call GitHub");
  });
  for (const request of [new Request(url), signed(undefined, 90), signed(undefined, -90)])
    assert.ok([401, 404].includes((await worker.fetch(request, env)).status));
  const forged = signed();
  forged.headers.set("X-OAuth-Signature", "0".repeat(64));
  assert.equal((await worker.fetch(forged, env)).status, 401);
  const browser = signed();
  browser.headers.set("Origin", origin);
  assert.equal((await worker.fetch(browser, env)).status, 401);
  const tampered = new Request(url, {
    method: "POST",
    headers: signed().headers,
    body: '{"code":"changed"}',
  });
  assert.equal((await worker.fetch(tampered, env)).status, 401);
  assert.equal(outbound.mock.callCount(), 0);
});
test("exchange has a fixed destination, callback and application credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async (target, init) => {
    assert.equal(target, "https://github.com/login/oauth/access_token");
    assert.equal(init.redirect, "manual");
    assert.equal(init.body.get("client_id"), env.GITHUB_OAUTH_CLIENT_ID);
    assert.equal(init.body.get("client_secret"), env.GITHUB_OAUTH_CLIENT_SECRET);
    assert.equal(init.body.get("redirect_uri"), origin + "/api/auth/github/callback");
    assert.equal(init.body.get("code_verifier"), "v".repeat(64));
    assert.equal(new Headers(init.headers).get("X-OAuth-Signature"), null);
    return Response.json({
      access_token: "gho_" + "t".repeat(40),
      token_type: "bearer",
      expires_in: 28800,
      refresh_token: "never-forward",
    });
  });
  const response = await worker.fetch(signed(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    access_token: "gho_" + "t".repeat(40),
    expires_in: 28800,
  });
});
test("reject arbitrary destinations, malformed PKCE, oversized input and previews", async (t) => {
  const outbound = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not call GitHub");
  });
  assert.equal(
    (
      await worker.fetch(
        signed({ code: "x", verifier: "v".repeat(64), url: "https://evil.example" }),
        env,
      )
    ).status,
    400,
  );
  assert.equal((await worker.fetch(signed({ code: "x", verifier: "short" }), env)).status, 400);
  assert.equal(
    (await worker.fetch(signed({ code: "x".repeat(3000), verifier: "v".repeat(64) }), env)).status,
    413,
  );
  const request = signed();
  assert.equal(
    (
      await worker.fetch(
        new Request(url.replace(origin, "https://preview.workers.dev"), request),
        env,
      )
    ).status,
    403,
  );
  assert.equal(outbound.mock.callCount(), 0);
});
test("errors and redirects never disclose upstream secrets or headers", async (t) => {
  for (const upstream of [
    new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
    Response.json({ error: "incorrect_client_credentials", error_description: "private-detail" }),
    new Response("private-error", { status: 500 }),
  ]) {
    t.mock.method(globalThis, "fetch", async () => upstream);
    const response = await worker.fetch(signed(), env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Location"), null);
    assert.doesNotMatch(await response.text(), /private-|evil/);
  }
});
test("expired authorization codes are explicit and are never retried", async (t) => {
  const outbound = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "bad_verification_code", error_description: "sensitive" }),
  );
  const response = await worker.fetch(signed(), env);
  assert.deepEqual(await response.json(), { error: "bad_verification_code" });
  assert.equal(outbound.mock.callCount(), 1);
});
