/**
 * HTML-in-Canvas × WebGPU：把 canvas 里的真实 DOM 快照成纹理，再经 holo.wgsl 着色画回同一块 canvas。
 * DOM 仍然可聚焦、可点击、可被读屏。
 *
 * 两代接口都支持（https://github.com/WICG/html-in-canvas）：
 * - 现行草案：`content="drawable"` + `paint` 事件 + `requestPaint()` + `queue.drawElementImageToTexture`
 * - Chrome 145 前后的旧版：`layoutsubtree` + `queue.copyElementImageToTexture(el, w, h, dest)`，
 *   没有 paint 事件，改由 rAF 驱动，只在 DOM 或指针有变化时上传快照。
 */
import { effect, frame, sampler, surface, texture } from "vgpu";
import type { Gpu, Texture } from "vgpu";

import holoShader from "./holo.wgsl";

interface PaintEvent extends Event {
  readonly changedElements?: readonly Element[];
}

interface PaintingCanvas extends HTMLCanvasElement {
  requestPaint(): void;
  onpaint: ((event: PaintEvent) => void) | null;
  updateElementGeometry?(element: Element, options: { canvasTransform: DOMMatrixInit }): void;
}

type TextureDest = { texture: GPUTexture };

interface ElementImageQueue extends GPUQueue {
  drawElementImageToTexture?(
    source: { source: Element },
    destination: TextureDest & { size: { width: number; height: number } },
  ): void;
  copyElementImageToTexture?: ((
    element: Element,
    width: number,
    height: number,
    destination: TextureDest,
  ) => void) &
    ((
      source: { source: Element },
      destination: { destination: TextureDest; width: number; height: number },
    ) => void);
}

type Upload = (element: HTMLElement, target: GPUTexture, width: number, height: number) => void;

export interface HoloOptions {
  reducedMotion: boolean;
  onFailure: (reason: unknown) => void;
}

export interface HoloController {
  /** 下一次快照视为换档：当前画面挪进 prev，播放解码转场。 */
  markSwitch(): void;
  dispose(): void;
}

const REVEAL_SECONDS = 1.05;
const FIRST_UPLOAD_TIMEOUT = 2000;
/** 旧版接口下，任何 DOM/指针变化之后继续逐帧上传的时长，覆盖 CSS 过渡 */
const SETTLE_MS = 450;

function isPaintingCanvas(canvas: HTMLCanvasElement): canvas is PaintingCanvas {
  return "requestPaint" in canvas && "onpaint" in canvas;
}

function pickUpload(queue: ElementImageQueue): Upload | null {
  const draw = queue.drawElementImageToTexture?.bind(queue);
  if (draw !== undefined) {
    return (el, t, width, height) => draw({ source: el }, { texture: t, size: { width, height } });
  }
  const copy = queue.copyElementImageToTexture?.bind(queue);
  if (copy === undefined) return null;
  let positional = true;
  return (el, t, width, height) => {
    if (positional) {
      try {
        copy(el, width, height, { texture: t });
        return;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        positional = false;
      }
    }
    copy({ source: el }, { destination: { texture: t }, width, height });
  };
}

export function startHolo(
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  element: HTMLElement,
  opts: HoloOptions,
): HoloController {
  const queue: ElementImageQueue = gpu.gpu.queue;
  const upload = pickUpload(queue);
  if (upload === null) throw new Error("GPUQueue 上没有 HTML-in-Canvas 上传接口");

  const sizeNow = (): [number, number] => [
    Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)),
    Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio)),
  ];

  // surface() 会给 canvas 拿 webgpu 上下文；旧版接口要求宿主 canvas 先有上下文才能快照
  let size = sizeNow();
  const target = surface(gpu, canvas, { size });
  const makeTexture = (label: string): Texture =>
    texture(gpu, {
      kind: "2d",
      size,
      format: "rgba8unorm",
      usage: ["texture_binding", "copy_dst", "copy_src", "render_attachment"],
      label,
    });
  let cur = makeTexture("holo-cur");
  let prev = makeTexture("holo-prev");

  const fx = effect(gpu, holoShader, {
    label: "holo",
    blend: "premultiplied",
    set: {
      u: { resolution: size, pointer: [0.5, 0.5], time: 0, reveal: 0, energy: 0.6, hover: 0 },
      cur,
      prev,
      samp: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
    },
  });

  let revealStart = performance.now();
  let pendingSwitch = false;
  let needsUpload = true;
  let uploaded = false;
  let disposed = false;
  let lastFrame = performance.now();
  const pointer = { x: 0.5, y: 0.5, hover: 0, hoverTarget: 0, energy: 0.6 };

  const fail = (reason: unknown): void => {
    if (disposed) return;
    disposed = true;
    opts.onFailure(reason);
  };

  const snapshotToPrev = (): void => {
    const encoder = gpu.gpu.createCommandEncoder({ label: "holo-snapshot" });
    encoder.copyTextureToTexture({ texture: cur.gpu }, { texture: prev.gpu }, size);
    queue.submit([encoder.finish()]);
  };

  const resize = (): void => {
    const next = sizeNow();
    if (next[0] === size[0] && next[1] === size[1]) return;
    size = next;
    target.resize(size);
    const oldCur = cur;
    const oldPrev = prev;
    cur = makeTexture("holo-cur");
    prev = makeTexture("holo-prev");
    fx.set({ cur, prev, u: { resolution: size } });
    oldCur.destroy();
    oldPrev.destroy();
    needsUpload = true;
  };

  const revealProgress = (): number =>
    opts.reducedMotion ? 1 : Math.min(1, (performance.now() - revealStart) / 1000 / REVEAL_SECONDS);

  /** 上传（按需）+ 着色一帧。返回是否还有动画要继续。 */
  const renderFrame = (changed: boolean): boolean => {
    resize();
    if (pendingSwitch && uploaded) {
      snapshotToPrev();
      revealStart = performance.now();
      pointer.energy = Math.max(pointer.energy, 0.55);
    }
    pendingSwitch = false;
    if (changed || needsUpload) {
      upload(element, cur.gpu, size[0], size[1]);
      uploaded = true;
      needsUpload = false;
    }

    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    pointer.hover += (pointer.hoverTarget - pointer.hover) * (1 - Math.exp(-dt * 10));
    pointer.energy *= Math.exp(-dt * 3.2);
    const reveal = revealProgress();
    const energy = opts.reducedMotion ? 0 : pointer.energy;

    fx.set({
      u: {
        pointer: [pointer.x, pointer.y],
        time: now / 1000,
        reveal,
        energy,
        hover: pointer.hover,
      },
    });
    frame(gpu, (f) => {
      f.pass({ target, clear: [0, 0, 0, 0] }, (pass) => pass.draw(fx));
    });
    return reveal < 1 || energy > 0.004 || Math.abs(pointer.hoverTarget - pointer.hover) > 0.004;
  };

  // ---- 驱动：现行草案走 paint 事件，旧版走 rAF + 脏标记
  let kick: () => void;
  let stopDriver: () => void;

  if (isPaintingCanvas(canvas)) {
    canvas.onpaint = (event) => {
      if (disposed) return;
      try {
        const animating = renderFrame((event.changedElements?.length ?? 1) > 0);
        canvas.updateElementGeometry?.(element, { canvasTransform: new DOMMatrix() });
        if (animating) canvas.requestPaint();
      } catch (error) {
        fail(error);
      }
    };
    kick = () => canvas.requestPaint();
    stopDriver = () => {
      canvas.onpaint = null;
    };
  } else {
    let raf = 0;
    let dirtyUntil = 0;
    const loop = (): void => {
      raf = 0;
      if (disposed) return;
      const dirty = performance.now() < dirtyUntil;
      try {
        const animating = renderFrame(dirty);
        if (animating || performance.now() < dirtyUntil) raf = requestAnimationFrame(loop);
      } catch (error) {
        // 首帧前快照可能还没生成，先重试；已经成功过再出错才算失败
        if (uploaded) fail(error);
        else raf = requestAnimationFrame(loop);
      }
    };
    kick = () => {
      dirtyUntil = performance.now() + SETTLE_MS;
      if (raf === 0) raf = requestAnimationFrame(loop);
    };
    const mo = new MutationObserver(kick);
    mo.observe(element, { subtree: true, childList: true, characterData: true, attributes: true });
    const domEvents = ["focusin", "focusout", "pointerdown", "pointerup", "load"] as const;
    for (const type of domEvents) element.addEventListener(type, kick, true);
    void document.fonts.ready.then(kick);
    stopDriver = () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      for (const type of domEvents) element.removeEventListener(type, kick, true);
    };
  }

  const onMove = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const speed = Math.hypot(x - pointer.x, y - pointer.y);
    pointer.x = x;
    pointer.y = y;
    pointer.hoverTarget = 1;
    pointer.energy = Math.min(0.5, pointer.energy + speed * 0.9);
    kick();
  };
  const onLeave = (): void => {
    pointer.hoverTarget = 0;
    kick();
  };
  const host = canvas.parentElement ?? canvas;
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeave);

  // 偶发的轻微信号抖动，让静止的档案像在实时投影
  const idleTimer = opts.reducedMotion
    ? undefined
    : setInterval(() => {
        pointer.energy = Math.max(pointer.energy, 0.18);
        kick();
      }, 6800);

  const watchdog = setTimeout(() => {
    if (!uploaded) fail(new Error("快照迟迟没有生成，HTML-in-Canvas 不可用"));
  }, FIRST_UPLOAD_TIMEOUT);

  kick();

  return {
    markSwitch() {
      pendingSwitch = true;
      kick();
    },
    dispose() {
      disposed = true;
      stopDriver();
      clearTimeout(watchdog);
      clearInterval(idleTimer);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      target.dispose();
      cur.destroy();
      prev.destroy();
    },
  };
}

// GPU 设备与 canvas 上下文是全局单例，热替换会在同一块 canvas 上再起一个设备，改这里直接整页刷新。
import.meta.hot?.accept(() => location.reload());
