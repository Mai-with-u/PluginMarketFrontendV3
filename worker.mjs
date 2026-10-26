const ORIGIN = "https://plugin.maibot.chat";
const ROUTES = [
  ["GET", /^\/api\/auth\/(session|github\/(start|callback))$/],
  ["POST", /^\/api\/auth\/logout$/],
  ["GET", /^\/api\/developer\/(plugins|inbox)$/],
  ["POST", /^\/api\/developer\/claims$/],
  ["POST", /^\/api\/developer\/inbox\/\d+\/read$/],
  ["GET", /^\/api\/feedback\/[^/]+$/],
  ["PUT", /^\/api\/developer\/plugins\/[^/]+\/reviews\/[a-f0-9]{64}\/reply$/],
  ["DELETE", /^\/api\/developer\/plugins\/[^/]+\/reviews\/[a-f0-9]{64}\/reply$/],
];

function failure(status, detail) {
  return Response.json({ detail }, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    // Preview deployments must never share production login cookies or database writes.
    if (url.origin !== ORIGIN) return failure(403, "开发者服务仅在正式域名启用");
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return failure(400, "无效路径");
    }
    if (
      path.includes("\\") ||
      !ROUTES.some(([method, pattern]) => method === request.method && pattern.test(path))
    )
      return failure(404, "接口不存在");
    if (!env.DEVELOPER_ORIGIN || !env.DEVELOPER_INGRESS_KEY)
      return failure(503, "开发者服务尚未启用");
    const target = new URL(env.DEVELOPER_ORIGIN);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.pathname !== "/"
    )
      return failure(503, "开发者服务配置错误");
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = new Headers({
      "User-Agent": "MaiBotPluginMarket/1.0 (+https://plugin.maibot.chat)",
      "X-Market-Ingress": env.DEVELOPER_INGRESS_KEY,
      "X-Client-IP": request.headers.get("CF-Connecting-IP") ?? "unknown",
    });
    for (const key of ["Content-Type", "Origin", "X-CSRF-Token"]) {
      const value = request.headers.get(key);
      if (value) headers.set(key, value);
    }
    const cookies = (request.headers.get("Cookie") ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter((item) => /^__Host-pm_(session|oauth)=/.test(item));
    if (cookies.length) headers.set("Cookie", cookies.join("; "));
    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (headers.get("Origin") !== ORIGIN) return failure(403, "来源校验失败");
      if (headers.get("Content-Type")?.split(";")[0] !== "application/json")
        return failure(415, "需要 application/json");
      const reader = request.body?.getReader();
      const chunks = [];
      let length = 0;
      if (reader) {
        for (;;) {
          // Stream reads must remain sequential to enforce the size limit before buffering.
          // oxlint-disable-next-line eslint/no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 12288) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await reader.cancel();
            return failure(413, "请求过大");
          }
          chunks.push(value);
        }
      }
      body = new Uint8Array(length);
      let position = 0;
      for (const chunk of chunks) {
        body.set(chunk, position);
        position += chunk.byteLength;
      }
    }
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
      if (
        upstream.status >= 500 &&
        !upstream.headers.get("Content-Type")?.includes("application/json")
      )
        return failure(503, "开发者服务暂不可用");
      const response = new Response(upstream.body, upstream);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    } catch {
      return failure(503, "开发者服务暂不可用，请稍后重试");
    }
  },
};
