/**
 * 地图相机。DOM 标注和 WebGPU 地形用同一套投影，所以两者严格同步。
 *
 * 世界坐标：x 向东、y 向南（与屏幕同向），z 为海拔。相机看向地面上的 (x, y)，
 * 绕东西轴俯仰 tilt（0 = 正俯视的平面图）。焦距固定为 FOCAL 屏幕 px，
 * 相机距离 = FOCAL / zoom，所以 tilt = 0 时 1 世界单位恰好等于 zoom 个屏幕 px。
 */

export interface View {
  x: number;
  y: number;
  zoom: number;
  tilt: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 3.2;
/** 立体时再缩小，几乎整个视野都是被压扁的远景，看不清也最费 GPU */
export const MIN_ZOOM_3D = 0.42;
export const FOCAL = 1700;
/** 2.5D 时每单位地形高度对应的世界高度 */
export const RELIEF = 280;
export const TILT_3D = 0.92;

export const camera: {
  current: View;
  target: View;
  viewport: { w: number; h: number };
  reducedMotion: boolean;
} = {
  current: { x: 1000, y: 640, zoom: 0.5, tilt: 0 },
  target: { x: 1000, y: 640, zoom: 0.5, tilt: 0 },
  viewport: { w: 1440, h: 900 },
  reducedMotion: false,
};

/** 选中点与分区高亮，同样由地形着色器读取；focusStrength 由着色器侧的缓动回写 */
export const mapSignals = {
  focus: { x: 0, y: 0, on: false },
  focusStrength: 0,
  /** 9 个分区：x, y, 高度, 高亮(0/1) */
  regions: [] as [number, number, number, number][],
  /** 有插件的区域（minX, minY, maxX, maxY）；立体时网格只铺到它外面一圈 */
  bounds: [-1e5, -1e5, 1e5, 1e5] as [number, number, number, number],
};

type Listener = (view: View) => void;
const listeners = new Set<Listener>();
let raf = 0;
let last = 0;

/** 选中点在山顶上还会再隆起这么高（与 terrain.wgsl 的 focusPeak 一致） */
const FOCUS_PEAK = 0.28;
/** 相机至少高出最高峰这么多（世界单位） */
const CAMERA_CLEARANCE = 260;

/**
 * 立体时的最大放大倍数：相机高度 = (FOCAL / zoom) · cos(tilt)，必须高于最高峰，
 * 否则镜头会钻进山体里，画面只剩山的内壁。
 */
function maxZoomFor(tilt: number): number {
  if (tilt <= 0.1) return MAX_ZOOM;
  const peak = Math.max(0, ...mapSignals.regions.map((r) => r[2])) + FOCUS_PEAK;
  const minDistance = (peak * RELIEF + CAMERA_CLEARANCE) / Math.cos(tilt);
  return Math.min(MAX_ZOOM, FOCAL / minDistance);
}

const clampZoom = (z: number): number =>
  Math.min(
    maxZoomFor(camera.target.tilt),
    Math.max(camera.target.tilt > 0.1 ? MIN_ZOOM_3D : MIN_ZOOM, z),
  );

export function emitCamera(): void {
  for (const l of listeners) l(camera.current);
}

let emitQueued = 0;

/** 拖动时一帧可能来好几个 pointermove；标注更新合并到下一帧只做一次 */
function emitNextFrame(): void {
  if (emitQueued !== 0) return;
  emitQueued = requestAnimationFrame(() => {
    emitQueued = 0;
    emitCamera();
  });
}

function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const c = camera.current;
  const t = camera.target;
  const k = 1 - Math.exp(-dt * 6.5);
  c.x += (t.x - c.x) * k;
  c.y += (t.y - c.y) * k;
  c.zoom = Math.exp(Math.log(c.zoom) + (Math.log(t.zoom) - Math.log(c.zoom)) * k);
  c.tilt += (t.tilt - c.tilt) * (1 - Math.exp(-dt * 4));
  const settled =
    Math.abs(t.x - c.x) < 0.05 &&
    Math.abs(t.y - c.y) < 0.05 &&
    Math.abs(t.zoom - c.zoom) < 1e-4 &&
    Math.abs(t.tilt - c.tilt) < 1e-4;
  if (settled) Object.assign(c, t);
  emitCamera();
  raf = settled ? 0 : requestAnimationFrame(tick);
}

function run(): void {
  if (raf !== 0) return;
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

export function flyTo(view: Partial<View>, immediate = false): void {
  Object.assign(camera.target, view);
  camera.target.zoom = clampZoom(camera.target.zoom);
  if (immediate || camera.reducedMotion) {
    Object.assign(camera.current, camera.target);
    emitCamera();
  } else {
    run();
  }
}

/** 拖拽平移：跟手不缓动。俯仰时纵向被透视压缩，按 cos(tilt) 补回来 */
export function panBy(dx: number, dy: number): void {
  const c = camera.current;
  const wx = dx / c.zoom;
  const wy = dy / (c.zoom * Math.max(0.35, Math.cos(c.tilt)));
  for (const v of [camera.target, camera.current]) {
    v.x -= wx;
    v.y -= wy;
  }
  emitNextFrame();
}

/** 以屏幕上某点为锚缩放：锚点下的地面坐标尽量保持不动 */
export function zoomAt(sx: number, sy: number, factor: number): void {
  const t = camera.target;
  const zoom = clampZoom(t.zoom * factor);
  const ratio = t.zoom / zoom;
  // 俯仰时光标靠近地平线会对应到很远的地面，锚点限制在一个相机距离内，镜头不会被带跑
  const raw = screenToGround(sx, sy, t) ?? [t.x, t.y];
  const reach = FOCAL / t.zoom;
  const off = Math.hypot(raw[0] - t.x, raw[1] - t.y);
  const k = off > reach ? reach / off : 1;
  const anchor = [t.x + (raw[0] - t.x) * k, t.y + (raw[1] - t.y) * k] as const;
  flyTo({
    zoom,
    x: anchor[0] + (t.x - anchor[0]) * ratio,
    y: anchor[1] + (t.y - anchor[1]) * ratio,
  });
}

// ---------------------------------------------------------------- 投影

export interface CameraFrame {
  pos: [number, number, number];
  right: [number, number, number];
  down: [number, number, number];
  forward: [number, number, number];
  distance: number;
}

export function cameraFrame(v: View = camera.current): CameraFrame {
  const s = Math.sin(v.tilt);
  const c = Math.cos(v.tilt);
  const distance = FOCAL / v.zoom;
  return {
    pos: [v.x, v.y + distance * s, distance * c],
    right: [1, 0, 0],
    down: [0, c, -s],
    forward: [0, -s, -c],
    distance,
  };
}

/** 当前俯仰下的地形起伏量：平面图时为 0，立起来后才长出山 */
export function reliefOf(v: View = camera.current): number {
  const t = Math.min(1, Math.max(0, v.tilt / (TILT_3D * 0.6)));
  return RELIEF * t * t * (3 - 2 * t);
}

export interface Projected {
  x: number;
  y: number;
  /** 相机前方距离；<= 0 表示在相机后面 */
  depth: number;
  /** 相对平面图的透视缩放 */
  scale: number;
}

export function project(wx: number, wy: number, wz: number, v: View = camera.current): Projected {
  const f = cameraFrame(v);
  const dx = wx - f.pos[0];
  const dy = wy - f.pos[1];
  const dz = wz - f.pos[2];
  const xc = dx;
  const yc = dy * f.down[1] + dz * f.down[2];
  const zc = dy * f.forward[1] + dz * f.forward[2];
  const { w, h } = camera.viewport;
  return {
    x: w / 2 + (FOCAL * xc) / zc,
    y: h / 2 + (FOCAL * yc) / zc,
    depth: zc,
    scale: FOCAL / zc / v.zoom,
  };
}

/** 屏幕点 → 地面（z = 0）交点；看向天空时返回 null */
export function screenToGround(
  sx: number,
  sy: number,
  v: View = camera.current,
): [number, number] | null {
  const f = cameraFrame(v);
  const { w, h } = camera.viewport;
  const a = (sx - w / 2) / FOCAL;
  const b = (sy - h / 2) / FOCAL;
  const dir = [a, b * f.down[1] + f.forward[1], b * f.down[2] + f.forward[2]] as const;
  if (dir[2] >= -1e-6) return null;
  const t = -f.pos[2] / dir[2];
  return [f.pos[0] + dir[0] * t, f.pos[1] + dir[1] * t];
}

/** 选中某点后它的最终海拔（世界单位）：山体 + 选中隆起，按目标视角的起伏量 */
export function settledElevation(wx: number, wy: number, v: View = camera.target): number {
  return (mountainHeight(wx, wy) + FOCUS_PEAK) * reliefOf(v);
}

/** 让地面上 (wx, wy) 处、海拔 z 的点落在屏幕中心时，相机应看向的地面 y */
export function groundYFor(wy: number, z: number, tilt: number): number {
  return wy - z * Math.tan(tilt);
}

/** 与 terrain.wgsl 的 mountains() 一致：尖峰 + 宽山脚两层高斯 */
function mountainHeight(wx: number, wy: number): number {
  let h = 0;
  for (const [x, y, height] of mapSignals.regions) {
    const d2 = (wx - x) ** 2 + (wy - y) ** 2;
    const core = 70 + height * 120;
    const base = 150 + height * 260;
    h +=
      height * (0.6 * Math.exp(-d2 / (2 * core * core)) + 0.4 * Math.exp(-d2 / (2 * base * base)));
  }
  return h;
}

/** 与 terrain.wgsl 的山体部分一致（不含噪声，噪声在山上已被压到很小） */
export function groundHeight(wx: number, wy: number): number {
  const f = mapSignals.focus;
  const fd2 = (wx - f.x) ** 2 + (wy - f.y) ** 2;
  return (
    mountainHeight(wx, wy) + mapSignals.focusStrength * FOCUS_PEAK * Math.exp(-fd2 / (2 * 75 * 75))
  );
}

/** 地面上某点（含海拔）投到屏幕 */
export function projectGround(
  wx: number,
  wy: number,
  lift = 0,
  v: View = camera.current,
): Projected {
  return project(wx, wy, groundHeight(wx, wy) * reliefOf(v) + lift, v);
}

export function subscribeCamera(listener: Listener): () => void {
  listeners.add(listener);
  listener(camera.current);
  return () => listeners.delete(listener);
}

// 相机是全局单例，热替换会出现两份状态，改这里直接整页刷新。
import.meta.hot?.accept(() => location.reload());
