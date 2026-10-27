// Public registry images only: no arbitrary URLs, redirects, credentials or SVG.
export async function registryIcon(request) {
  const url = new URL(request.url);
  const match = /^\/api\/market\/icons\/([a-f0-9]{40})\/([A-Za-z0-9_.-]+\.webp)$/.exec(
    url.pathname,
  );
  if (!match || url.search || request.method !== "GET")
    return new Response("Not found", { status: 404 });
  try {
    const upstream = await fetch(
      `https://raw.githubusercontent.com/Mai-with-u/plugin-repo/${match[1]}/icons/${match[2]}`,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
        cf: { cacheTtl: 31536000, cacheEverything: true },
      },
    );
    if (upstream.status === 404) return new Response("Icon not found", { status: 404 });
    if (!upstream.ok || upstream.headers.get("Content-Type")?.split(";")[0] !== "image/webp")
      return new Response("Icon unavailable", { status: 502 });
    const reader = upstream.body?.getReader();
    if (!reader) return new Response("Icon unavailable", { status: 502 });
    const chunks = [];
    let length = 0;
    for (;;) {
      // Read sequentially to enforce the size cap before allocating the response.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 262144) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await reader.cancel();
        return new Response("Icon too large", { status: 502 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoder = new TextDecoder();
    if (
      length < 12 ||
      decoder.decode(bytes.subarray(0, 4)) !== "RIFF" ||
      decoder.decode(bytes.subarray(8, 12)) !== "WEBP"
    )
      return new Response("Invalid icon", { status: 502 });
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return new Response("Icon unavailable", { status: 503 });
  }
}
