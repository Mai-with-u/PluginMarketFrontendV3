import { clock, draw, effect, frameLoop, surface } from "vgpu";
import type { Gpu } from "vgpu";

import {
  camera,
  cameraFrame,
  emitCamera,
  FOCAL,
  mapSignals,
  reliefOf,
  screenToGround,
} from "../map/camera.ts";
import type { View } from "../map/camera.ts";
import { getResolvedTheme } from "../theme.ts";
import hudShader from "./hud.wgsl";
import terrainShader from "./terrain.wgsl";

/** 界面 → 背景场：从屏幕坐标推出一圈波纹。场没启动时写入也无副作用。 */
export const fieldSignals: { pulse: { x: number; y: number } | null } = { pulse: null };

export function pulseField(x: number, y: number): void {
  fieldSignals.pulse = { x, y };
}

export interface FieldOptions {
  reducedMotion: boolean;
}

/** 点击带 `data-pulse` 的元素时，从点击处推出一圈等高线波纹。 */
const PULSE_SELECTOR = "[data-pulse]";
/** 减弱动态时地形停在这一刻：扫描束在视口外，画面只剩静止等高线。 */
const FROZEN_TIME = 0.2;
const GRID = 220;
/** 背景每帧最多着色的像素数；大屏上自动降低像素密度 */
const PIXEL_BUDGET = 2.6e6;
const CLEAR: [number, number, number, number] = [0.047, 0.043, 0.039, 1];
const LIGHT_CLEAR: [number, number, number, number] = [245 / 255, 242 / 255, 235 / 255, 1];

type Vec4 = [number, number, number, number];

const vec4 = (v: readonly [number, number, number], w = 0): Vec4 => [v[0], v[1], v[2], w];

/** 尺寸量化到这个粒度，缩放时网格间距不会逐帧变化导致顶点“游动” */
const EXTENT_STEP = 256;
/** 与 terrain.wgsl 的 EDGE_FADE 一致 */
const EDGE_FADE = 1200;

/**
 * 网格要铺满的地面范围：把屏幕四角的视线投到地面上取外接框。
 * 看向天空的视线截在雾尽头；四周再留出余量，让屏幕外的高山也能探进画面。
 */
function visibleGround(
  v: View,
  relief: number,
): { origin: [number, number]; extent: [number, number] } {
  const { w, h } = camera.viewport;
  const distance = FOCAL / v.zoom;
  // 与 terrain.wgsl 的雾尽头（2.4 倍相机距离）对应的地面最远处；平面图没有远近，不设上限
  const farY = v.tilt > 0.05 ? v.y - distance * 2.6 * Math.sin(v.tilt) : -Infinity;
  const farHalfX = ((w / 2) * distance * 2.6) / FOCAL;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [sx, sy] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ] as const) {
    const g = screenToGround(sx, sy, v);
    if (g === null || g[1] < farY) {
      xs.push(v.x + (sx === 0 ? -farHalfX : farHalfX));
      ys.push(farY);
    } else {
      xs.push(g[0]);
      ys.push(g[1]);
    }
  }
  // 山最高约 1.5 × relief；俯仰时山脚在屏幕外、山顶仍可能露出来
  const margin = 260 + relief * 1.6 * Math.tan(v.tilt);
  // 立体时数据区外 EDGE_FADE 之外全是底色，没必要铺网格（远处被压扁的网格最费像素着色）
  const [bx0, by0, bx1, by1] = mapSignals.bounds;
  const pad = EDGE_FADE + 100;
  const tilted = v.tilt > 0.05;
  const clampX = (x: number): number => (tilted ? Math.min(bx1 + pad, Math.max(bx0 - pad, x)) : x);
  const minX = clampX(Math.min(...xs) - margin);
  const maxX = clampX(Math.max(...xs) + margin);
  const minY = tilted ? Math.max(by0 - pad, Math.min(...ys) - margin) : Math.min(...ys) - margin;
  // 相机身后的地面永远看不见，往南最多铺到相机脚下
  const cameraY = v.y + distance * Math.sin(v.tilt);
  const maxY = tilted
    ? Math.min(Math.max(...ys) + margin, cameraY, by1 + pad)
    : Math.max(...ys) + margin;
  const ex = Math.max(EXTENT_STEP, Math.ceil((maxX - minX) / EXTENT_STEP) * EXTENT_STEP);
  const ey = Math.max(EXTENT_STEP, Math.ceil((maxY - minY) / EXTENT_STEP) * EXTENT_STEP);
  const sx = ex / GRID;
  const sy = ey / GRID;
  return {
    origin: [Math.round((minX + maxX) / 2 / sx) * sx, Math.round((minY + maxY) / 2 / sy) * sy],
    extent: [ex, ey],
  };
}

/** 每帧随相机变化的地形 uniform */
function sceneValues(time: number) {
  const v = camera.current;
  const f = cameraFrame(v);
  const relief = reliefOf(v);
  const cover = visibleGround(v, relief);
  return {
    camRight: vec4(f.right),
    camDown: vec4(f.down),
    camForward: vec4(f.forward),
    camPos: vec4(f.pos, FOCAL),
    dataBounds: [...mapSignals.bounds],
    gridOrigin: cover.origin,
    gridExtent: cover.extent,
    zoom: v.zoom,
    relief,
    time,
    lightTheme: getResolvedTheme() === "light" ? 1 : 0,
  };
}

export function startField(gpu: Gpu, canvas: HTMLCanvasElement, opts: FieldOptions): () => void {
  const budgetDpr = Math.sqrt(PIXEL_BUDGET / Math.max(1, innerWidth * innerHeight));
  const dpr = Math.max(1, Math.min(1.5, devicePixelRatio, budgetDpr));
  const target = surface(gpu, canvas, { dpr, alphaMode: "opaque" });
  const regions: Vec4[] = Array.from({ length: 9 }, (_, i): Vec4 => [
    ...(mapSignals.regions[i] ?? [0, 0, 0, 0]),
  ]);
  const focus: Vec4 = [0, 0, 0, 0];
  const css = (): [number, number] => [target.size[0] / target.dpr, target.size[1] / target.dpr];

  const terrain = draw(gpu, {
    shader: terrainShader,
    label: "terrain",
    vertices: GRID * GRID * 6,
    set: {
      u: {
        ...sceneValues(0),
        regions,
        focus,
        resolution: css(),
        pointer: [canvas.clientWidth * 0.5, canvas.clientHeight * 0.5],
        pointerWorld: [camera.current.x, camera.current.y],
        pulseOrigin: [0, 0],
        dpr: target.dpr,
        pulseAge: 10,
        energy: 0,
      },
    },
  });
  const hud = effect(gpu, hudShader, {
    label: "hud",
    blend: "premultiplied",
    set: {
      o: {
        resolution: css(),
        time: 0,
        dpr: target.dpr,
        lightTheme: getResolvedTheme() === "light" ? 1 : 0,
      },
    },
  });

  // 场画在地图面板里，不一定铺满窗口；指针和波纹都换算成相对画布左上角的坐标
  let box = canvas.getBoundingClientRect();
  const remeasure = (): void => {
    box = canvas.getBoundingClientRect();
  };
  const unsubscribeResize = target.onResize((e) => {
    remeasure();
    terrain.set({ u: { resolution: css(), dpr: e.dpr } });
    hud.set({ o: { resolution: css(), dpr: e.dpr } });
  });

  const time = clock(gpu);
  const pointer = { x: box.width * 0.5, y: box.height * 0.5 };
  const smooth = { ...pointer };
  let energy = 0;
  let lastMove = performance.now();
  let pulse = { x: 0, y: 0, start: -100 };

  const onMove = (e: PointerEvent): void => {
    const now = performance.now();
    const dt = Math.max(1, now - lastMove);
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const speed = Math.hypot(x - pointer.x, y - pointer.y) / dt;
    energy = Math.min(1, energy + speed * 0.06);
    pointer.x = x;
    pointer.y = y;
    lastMove = now;
  };
  const onClick = (e: MouseEvent): void => {
    if (e.target instanceof Element && e.target.closest(PULSE_SELECTOR) !== null) {
      pulse = { x: e.clientX - box.left, y: e.clientY - box.top, start: time.time };
    }
  };
  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("click", onClick, { capture: true });
  // 列表区域滚动或布局变化会挪动画布，但不一定改变它的尺寸
  addEventListener("resize", remeasure);
  addEventListener("scroll", remeasure, { capture: true, passive: true });

  const loop = frameLoop(
    gpu,
    (frame) => {
      const dt = time.deltaTime;
      const t = opts.reducedMotion ? FROZEN_TIME : time.time;
      const k = opts.reducedMotion ? 1 : 1 - Math.exp(-dt * 6);
      smooth.x += (pointer.x - smooth.x) * k;
      smooth.y += (pointer.y - smooth.y) * k;
      energy *= Math.exp(-dt * 2.5);
      if (fieldSignals.pulse !== null) {
        pulse = { ...fieldSignals.pulse, start: time.time };
        fieldSignals.pulse = null;
      }

      // 选中点的山峰与分区高亮缓入缓出；山峰在 2.5D 下会顶起标注，所以变化时通知 DOM
      const ease = opts.reducedMotion ? 1 : 1 - Math.exp(-dt * 4);
      const f = mapSignals.focus;
      if (f.on) {
        focus[0] = f.x;
        focus[1] = f.y;
      }
      const before = focus[2];
      focus[2] += ((f.on ? 1 : 0) - focus[2]) * ease;
      mapSignals.focusStrength = focus[2];
      if (Math.abs(focus[2] - before) > 1e-3 && reliefOf() > 0) emitCamera();
      for (let i = 0; i < 9; i++) {
        const src = mapSignals.regions[i];
        const dst = regions[i];
        if (src === undefined || dst === undefined) continue;
        dst[0] = src[0];
        dst[1] = src[1];
        dst[2] = src[2];
        dst[3] += (src[3] - dst[3]) * ease;
      }

      const ground = screenToGround(smooth.x, smooth.y);
      terrain.set({
        u: {
          ...sceneValues(t),
          regions,
          focus,
          pointer: [smooth.x, smooth.y],
          pointerWorld: ground ?? [1e6, 1e6],
          pulseOrigin: [pulse.x, pulse.y],
          pulseAge: opts.reducedMotion ? 10 : time.time - pulse.start,
          energy,
        },
      });
      const lightTheme = getResolvedTheme() === "light";
      hud.set({ o: { time: t, lightTheme: lightTheme ? 1 : 0 } });
      frame.pass({ target, clear: lightTheme ? LIGHT_CLEAR : CLEAR }, (pass) => {
        pass.draw(terrain);
        pass.draw(hud);
      });
    },
    { fps: opts.reducedMotion ? 20 : 60 },
  );

  return () => {
    loop.stop();
    unsubscribeResize();
    removeEventListener("pointermove", onMove);
    removeEventListener("click", onClick, { capture: true });
    removeEventListener("resize", remeasure);
    removeEventListener("scroll", remeasure, { capture: true });
    target.dispose();
  };
}

// GPU 设备与 canvas 上下文是全局单例，热替换会在同一块 canvas 上再起一个设备，改这里直接整页刷新。
import.meta.hot?.accept(() => location.reload());
