// 地形网格：顶点按地形函数抬升（2.5D 时 relief > 0），片元逐像素重算等高线与坡面光照。
// 世界坐标 x 向东、y 向南，z 为海拔。相机只做俯仰（tilt），始终面朝北，
// 所以网格按行从北往南画即可正确遮挡，不需要深度缓冲。
import { fbmSimplex2d } from "@vgpu/wgsl-std/noise/simplex";

struct Scene {
  regions: array<vec4f, 14>,
  focus: vec4f,
  // 有插件的区域 minX, minY, maxX, maxY；立体时区域外渐隐，网格也只铺到外面一圈
  dataBounds: vec4f,
  camRight: vec4f,
  camDown: vec4f,
  camForward: vec4f,
  // xyz 相机位置，w 焦距（屏幕 px）
  camPos: vec4f,
  resolution: vec2f,
  pointer: vec2f,
  pointerWorld: vec2f,
  pulseOrigin: vec2f,
  gridOrigin: vec2f,
  gridExtent: vec2f,
  time: f32,
  zoom: f32,
  relief: f32,
  dpr: f32,
  pulseAge: f32,
  energy: f32,
  lightTheme: f32,
}

@group(0) @binding(0) var<uniform> u: Scene;

const GRID: u32 = 220u;
const EDGE_FADE: f32 = 1200.0;

const GRAPHITE = vec3f(0.047, 0.043, 0.039);
const BONE = vec3f(0.92, 0.90, 0.85);
const SIGNAL = vec3f(1.0, 0.416, 0.122);

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec2f,
  @location(1) depth: f32,
}

// 山体：尖峰 + 宽山脚两层高斯。返回 (高度, 山脚覆盖度, 分区高亮)。
// 与 src/map/camera.ts 的 mountainHeight 保持一致，DOM 标注才能立在坡上。
fn mountains(w: vec2f) -> vec3f {
  var h = 0.0;
  var mass = 0.0;
  var glow = 0.0;
  for (var i = 0u; i < 14u; i++) {
    let r = u.regions[i];
    let d = w - r.xy;
    let d2 = dot(d, d);
    let core = 70.0 + r.z * 120.0;
    let base = 150.0 + r.z * 260.0;
    let kc = exp(-d2 / (2.0 * core * core));
    let kb = exp(-d2 / (2.0 * base * base));
    h += r.z * (0.6 * kc + 0.4 * kb);
    mass += kb;
    glow = max(glow, r.w * kb);
  }
  return vec3f(h, mass, glow);
}

fn focusPeak(w: vec2f) -> f32 {
  let fd = distance(w, u.focus.xy);
  return u.focus.z * 0.28 * exp(-(fd * fd) / (2.0 * 75.0 * 75.0));
}

fn noiseAt(w: vec2f) -> f32 {
  let drift = vec2f(u.time * 0.009, u.time * 0.004);
  return fbmSimplex2d(w * 0.0019 + drift, 4, 2.03, 0.5) * 0.46;
}

// 几何用的海拔：山上的噪声压到很小，标注用纯高斯就能对齐
fn groundAt(m: vec3f, noise: f32, w: vec2f) -> f32 {
  return m.x + focusPeak(w) + noise * (1.0 - 0.85 * smoothstep(0.05, 0.5, m.y));
}

fn project(p: vec3f) -> vec4f {
  let v = p - u.camPos.xyz;
  let xc = dot(v, u.camRight.xyz);
  let yc = dot(v, u.camDown.xyz);
  let zc = dot(v, u.camForward.xyz);
  let half = u.resolution * 0.5;
  // 近裁剪面放在相机距离的 8% 处：再近的顶点透视放大过头，会拉成巨大的三角形。
  // 相机始终高出最高峰（见 camera.ts 的 maxZoomFor），山坡不会进入这个范围
  let near = 0.08 * u.camPos.w / u.zoom;
  return vec4f(xc * u.camPos.w / half.x, -yc * u.camPos.w / half.y, (zc - near) * 0.5, zc);
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  var corners = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u),
  );
  let cell = vi / 6u;
  let g = vec2f(vec2u(cell % GRID, cell / GRID) + corners[vi % 6u]);
  let stride = u.gridExtent / f32(GRID);
  let w = u.gridOrigin + (g - f32(GRID) * 0.5) * stride;

  var out: VOut;
  // 平面图时不需要抬升，省掉噪声
  var h = 0.0;
  if (u.relief > 0.0) {
    h = groundAt(mountains(w), noiseAt(w), w);
  }
  out.pos = project(vec3f(w, h * u.relief));
  out.world = w;
  out.depth = out.pos.w;
  return out;
}

fn contour(x: f32) -> f32 {
  let d = abs(fract(x + 0.5) - 0.5);
  return 1.0 - smoothstep(0.0, fwidth(x) * 1.15, d);
}

@fragment fn fs_main(in: VOut) -> @location(0) vec4f {
  let res = u.resolution;
  let p = in.pos.xy / u.dpr;
  let uv = p / res;
  let rise = clamp(u.relief / 200.0, 0.0, 1.0);

  var col = GRAPHITE + vec3f(0.020, 0.015, 0.010) * (1.0 - uv.y);

  let m = mountains(in.world);
  let noise = noiseAt(in.world);
  let h = groundAt(m, noise, in.world);

  // 指针处的地形在着色时轻微隆起，等高线绕着光标走（不改几何，标注不受影响）
  let pw = distance(in.world, u.pointerWorld);
  let level = (h + 0.14 * exp(-(pw * pw) / (2.0 * 130.0 * 130.0))) * 9.5;
  let minor = contour(level);
  let major = contour(level / 5.0);

  // 坡面法线逐像素求：把几何里压平的噪声加回来，只用于光照，山体就有岩面起伏
  let shadeH = h + noise * 0.85 * smoothstep(0.05, 0.5, m.y) * 0.9;
  let surface = vec3f(in.world, shadeH * u.relief);
  var n = normalize(cross(dpdx(surface), dpdy(surface)));
  n = n * sign(n.z + 1e-6);

  let span = res.y + 360.0;
  let beamY = fract(u.time / 11.0) * span - 180.0;
  let dy = p.y - beamY;
  let beam = exp(-(dy * dy) / (2.0 * 26.0 * 26.0));
  let trail = select(0.0, exp(dy / 240.0), dy < 0.0);

  let pd = distance(p, u.pointer);
  let near = exp(-(pd * pd) / (2.0 * 230.0 * 230.0));

  let rd = distance(p, u.pulseOrigin) - u.pulseAge * 1100.0;
  let ring = exp(-(rd * rd) / (2.0 * 34.0 * 34.0)) * clamp(1.0 - u.pulseAge / 1.4, 0.0, 1.0);

  let fd = distance(in.world, u.focus.xy) * u.zoom;
  let focusHeat = u.focus.z * exp(-(fd * fd) / (2.0 * 150.0 * 150.0));

  let heat = clamp(
    beam * 0.9 + trail * 0.3 + near * (0.45 + u.energy * 0.7) + ring + m.z * 0.75 + focusHeat,
    0.0,
    1.0,
  );

  // ---- 2.5D 才生效的山体表现；平面图时 rise = 0，与原平面图完全一致
  // 分层设色：每条主等高线一个台阶，越高越亮越暖
  let band = floor(level / 5.0) / 4.0;
  col += vec3f(0.11, 0.085, 0.06) * clamp(band, 0.0, 1.6) * rise;
  // 西北来光的坡面明暗
  let light = normalize(vec3f(-0.55, -0.75, 0.62));
  let lambert = dot(n, light);
  col *= mix(1.0, clamp(0.42 + lambert * 1.05, 0.22, 1.9), rise);
  // 低处压暗，像谷底的环境遮蔽
  col *= mix(1.0, 0.62 + 0.38 * smoothstep(0.0, 0.9, h), rise);
  // 逆光轮廓：贴着视线的坡面亮一圈，山脊线从背景里跳出来
  let view = normalize(u.camPos.xyz - vec3f(in.world, h * u.relief));
  let rim = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 3.0);
  col += BONE * rim * 0.12 * rise;

  let lineAmt = (minor * 0.055 + major * 0.13) * (0.55 + heat * 1.7) * (1.0 + rise * 0.6);
  col = mix(col, mix(BONE, SIGNAL, heat), lineAmt);

  let pulse = fract(u.time * 0.45);
  let r1 = fd - (14.0 + pulse * 70.0);
  col += SIGNAL * exp(-(r1 * r1) / 3.0) * (1.0 - pulse) * u.focus.z * 0.6;

  // 远处融进底色，2.5D 时地平线不会露出网格边缘
  let distance0 = u.camPos.w / u.zoom;
  let fog = smoothstep(distance0 * 1.3, distance0 * 2.4, in.depth);
  let b = u.dataBounds;
  let outside = max(max(b.x - in.world.x, in.world.x - b.z), max(b.y - in.world.y, in.world.y - b.w));
  let edge = smoothstep(0.0, EDGE_FADE, outside) * rise;
  var background = GRAPHITE;
  if (u.lightTheme > 0.5) {
    // 白天使用纸色山体和墨色等高线；保留地形、扫描和选中反馈。
    background = vec3f(245.0, 242.0, 235.0) / 255.0;
    let ink = vec3f(0.30, 0.26, 0.21);
    let ochre = vec3f(0.725, 0.263, 0.043);
    col = background - vec3f(0.08, 0.09, 0.10) * clamp(band, 0.0, 1.6) * rise;
    col *= 1.0 - (1.0 - lambert) * 0.08 * rise;
    col = mix(col, mix(ink, ochre, heat), lineAmt * 1.3);
    let ringInk = exp(-(r1 * r1) / 3.0) * (1.0 - pulse) * u.focus.z * 0.6;
    col = mix(col, ochre, ringInk);
  }
  col = mix(col, background, max(fog, edge));

  return vec4f(col, 1.0);
}
