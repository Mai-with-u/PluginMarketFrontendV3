const TOKEN_URL = "https://github.com/login/oauth/access_token";
const CALLBACK_URL = "https://plugin.maibot.chat/api/auth/github/callback";
const encoder = new TextEncoder();

function reply(status, data) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Internal OAuth operation, not a general-purpose proxy. Only our backend can
// sign the short-lived, body-bound request; the browser never receives tokens.
export async function exchangeGitHubToken(request, env) {
  if (request.method !== "POST" || new URL(request.url).search)
    return reply(404, { detail: "接口不存在" });
  if (
    !env.GITHUB_OAUTH_RELAY_KEY ||
    env.GITHUB_OAUTH_RELAY_KEY.length < 32 ||
    !env.GITHUB_OAUTH_CLIENT_ID ||
    !env.GITHUB_OAUTH_CLIENT_SECRET
  )
    return reply(503, { detail: "GitHub 登录服务尚未配置" });
  const timestamp = request.headers.get("X-OAuth-Timestamp") ?? "";
  const signature = request.headers.get("X-OAuth-Signature") ?? "";
  if (
    request.headers.has("Origin") ||
    request.headers.has("Cookie") ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return reply(401, { detail: "登录服务鉴权失败" });
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json")
    return reply(415, { detail: "需要 application/json" });

  const reader = request.body?.getReader();
  if (!reader) return reply(400, { detail: "无效请求" });
  const chunks = [];
  let size = 0;
  for (;;) {
    // Read sequentially so the body limit applies before buffering.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2048) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await reader.cancel();
      return reply(413, { detail: "请求过大" });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return reply(400, { detail: "无效请求" });
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.GITHUB_OAUTH_RELAY_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(`github-token-v1\n${timestamp}\n${body}`);
  const mac = Uint8Array.from(signature.match(/../g), (hex) => Number.parseInt(hex, 16));
  if (!(await crypto.subtle.verify("HMAC", key, mac, signed)))
    return reply(401, { detail: "登录服务鉴权失败" });
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return reply(400, { detail: "无效请求" });
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((field) => field !== "code" && field !== "verifier") ||
    typeof input.code !== "string" ||
    !/^[a-zA-Z0-9_-]{1,512}$/.test(input.code) ||
    typeof input.verifier !== "string" ||
    !/^[a-zA-Z0-9._~-]{43,128}$/.test(input.verifier)
  )
    return reply(400, { detail: "无效登录参数" });

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "MaiBot-Plugin-Developer",
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        redirect_uri: CALLBACK_URL,
        code: input.code,
        code_verifier: input.verifier,
      }),
    });
    // Do not forward redirects, headers, error descriptions or arbitrary fields
    // from GitHub. In particular, no OAuth credentials are logged or cached.
    if (response.status !== 200) return reply(503, { detail: "GitHub 登录服务暂不可用" });
    const data = await response.json();
    if (data?.error === "bad_verification_code")
      return reply(200, { error: "bad_verification_code" });
    if (
      data?.error ||
      data?.token_type?.toLowerCase() !== "bearer" ||
      typeof data?.access_token !== "string" ||
      !/^[a-zA-Z0-9_]{20,512}$/.test(data.access_token) ||
      (data.expires_in !== undefined &&
        (!Number.isInteger(data.expires_in) || data.expires_in <= 0))
    )
      return reply(503, { detail: "GitHub 登录响应无效，请检查应用配置" });
    return reply(200, {
      access_token: data.access_token,
      expires_in: Math.min(data.expires_in ?? 604800, 604800),
    });
  } catch {
    return reply(503, { detail: "GitHub 登录服务暂不可用，请重新发起登录" });
  }
}
