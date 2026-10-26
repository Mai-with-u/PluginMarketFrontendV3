// HUD 叠加层：屏幕空间的点阵、定位十字、扫描束、暗角与颗粒。
// 预乘混合：rgb 直接加亮，alpha 把底下的地形按比例压暗（暗角）。
import { hash2 } from "@vgpu/wgsl-std/hash";

struct Hud {
  resolution: vec2f,
  time: f32,
  dpr: f32,
}

@group(0) @binding(0) var<uniform> o: Hud;

const BONE = vec3f(0.92, 0.90, 0.85);
const SIGNAL = vec3f(1.0, 0.416, 0.122);

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = o.resolution;
  let p = uv * res;

  let g = 32.0;
  let cell = (fract(p / g) - 0.5) * g;
  let dotMask = 1.0 - smoothstep(0.5, 1.3, length(cell));
  let m = g * 4.0;
  let c = (fract(p / m + 0.5) - 0.5) * m;
  let armX = (1.0 - smoothstep(0.35, 0.9, abs(c.x))) * step(abs(c.y), 5.0);
  let armY = (1.0 - smoothstep(0.35, 0.9, abs(c.y))) * step(abs(c.x), 5.0);
  var rgb = BONE * (dotMask * 0.04 + max(armX, armY) * 0.055);

  let span = res.y + 360.0;
  let beamY = fract(o.time / 11.0) * span - 180.0;
  let dy = p.y - beamY;
  let beamLine = 1.0 - smoothstep(0.0, 1.0, abs(dy));
  rgb += SIGNAL * (beamLine * 0.2 + exp(-(dy * dy) / (2.0 * 26.0 * 26.0)) * 0.02);

  let v = length((uv - vec2f(0.5, 0.45)) * vec2f(1.0, 1.25));
  var shade = 0.5 * smoothstep(0.4, 1.1, v);

  let n = hash2(floor(uv * res * o.dpr) + vec2f(fract(o.time * 7.0) * 311.0, 0.0)).x - 0.5;
  rgb += vec3f(max(n, 0.0) * 0.022);
  shade += max(-n, 0.0) * 0.04;

  return vec4f(rgb, shade);
}
