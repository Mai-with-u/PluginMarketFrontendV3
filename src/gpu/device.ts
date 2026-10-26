import { init } from "vgpu";
import type { Gpu } from "vgpu";

export type PipelineState = "pending" | "online" | "unavailable";

export interface PipelineSnapshot {
  webgpu: PipelineState;
  htmlInCanvas: PipelineState;
  adapter: string | null;
}

let snapshot: PipelineSnapshot = { webgpu: "pending", htmlInCanvas: "pending", adapter: null };
const listeners = new Set<() => void>();

function publish(next: Partial<PipelineSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
}

export function subscribePipeline(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPipelineSnapshot(): PipelineSnapshot {
  return snapshot;
}

/** `?hic=0` 强制走 DOM 回退，方便对照两条路径。 */
function htmlInCanvasForcedOff(): boolean {
  return new URLSearchParams(location.search).get("hic") === "0";
}

/**
 * HTML-in-Canvas（WICG 提案）只在 Chromium 打开
 * chrome://flags/#canvas-draw-element 后可用。
 * 现行草案（requestPaint）和 Chrome 145 前后的旧版（layoutSubtree）都认。
 */
export function detectHtmlInCanvas(): boolean {
  if (htmlInCanvasForcedOff()) return false;
  if (typeof HTMLCanvasElement === "undefined" || typeof GPUQueue === "undefined") return false;
  const canvas = HTMLCanvasElement.prototype;
  const queue = GPUQueue.prototype;
  return (
    ("requestPaint" in canvas || "layoutSubtree" in canvas) &&
    ("drawElementImageToTexture" in queue || "copyElementImageToTexture" in queue)
  );
}

export function markHtmlInCanvasFailed(): void {
  publish({ htmlInCanvas: "unavailable" });
}

let gpuPromise: Promise<Gpu | null> | null = null;

/** 全页共用一个 device，打开地图时才初始化；关掉地图的访客不会启动 WebGPU。 */
export function getGpu(): Promise<Gpu | null> {
  gpuPromise ??= (async () => {
    if (!("gpu" in navigator)) {
      publish({ webgpu: "unavailable", htmlInCanvas: "unavailable" });
      return null;
    }
    try {
      const gpu = await init({ powerPreference: "low-power" });
      const info = gpu.gpu.adapterInfo;
      const adapter = [info.vendor, info.architecture].filter(Boolean).join(" / ") || null;
      publish({
        webgpu: "online",
        adapter,
        htmlInCanvas: detectHtmlInCanvas() ? "online" : "unavailable",
      });
      gpu.gpu.lost
        .then(() => publish({ webgpu: "unavailable", htmlInCanvas: "unavailable" }))
        .catch(() => undefined);
      return gpu;
    } catch (error) {
      console.warn("[gpu] WebGPU 初始化失败，退回 CSS 背景", error);
      publish({ webgpu: "unavailable", htmlInCanvas: "unavailable" });
      return null;
    }
  })();
  return gpuPromise;
}

// GPU 设备与 canvas 上下文是全局单例，热替换会在同一块 canvas 上再起一个设备，改这里直接整页刷新。
import.meta.hot?.accept(() => location.reload());
