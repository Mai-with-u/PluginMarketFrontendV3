// 精选档案：HTML-in-Canvas 快照经此着色。静止时逐像素还原 DOM；
// 切换时自上而下解码（新档案在扫描线之上，旧档案在之下），扫描线附近块化成信号橙。
import { hash2 } from "@vgpu/wgsl-std/hash";

struct Holo {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
  reveal: f32,
  energy: f32,
  hover: f32,
}

@group(0) @binding(0) var<uniform> u: Holo;
@group(0) @binding(1) var cur: texture_2d<f32>;
@group(0) @binding(2) var prev: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

const SIGNAL = vec3f(1.0, 0.416, 0.122);
const BONE = vec3f(0.92, 0.90, 0.85);
const BAND = 0.16;

fn split(tex: texture_2d<f32>, uv: vec2f, amount: f32) -> vec4f {
  let base = textureSampleLevel(tex, samp, uv, 0.0);
  let r = textureSampleLevel(tex, samp, uv + vec2f(amount, 0.0), 0.0);
  let b = textureSampleLevel(tex, samp, uv - vec2f(amount, 0.0), 0.0);
  return vec4f(r.r, base.g, b.b, max(base.a, max(r.a, b.a)));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = uv * u.resolution;

  // 横向切片错位：只在 energy > 0 时出现
  let row = floor(uv.y * 54.0);
  let g = hash2(vec2f(row, floor(u.time * 18.0)));
  let sliced = step(1.0 - 0.3 * u.energy, g.x);
  let suv = uv + vec2f((g.y - 0.5) * 0.05 * u.energy * sliced, 0.0);
  let ca = 0.006 * u.energy;

  let front = u.reveal * (1.0 + BAND * 2.0) - BAND;
  let ahead = uv.y - front;

  let fresh = split(cur, suv, ca);
  let stale = split(prev, suv, ca);

  // 解码带：块尺寸随离扫描线距离变大，按块哈希决定显隐
  let t = clamp(ahead / BAND, 0.0, 1.0);
  let block = mix(3.0, 22.0, t);
  let cellId = floor(px / block);
  let quv = (cellId + 0.5) * block / u.resolution;
  let coarse = textureSampleLevel(cur, samp, quv, 0.0);
  let lit = step(t, hash2(cellId + vec2f(u.reveal * 37.0, 0.0)).x);
  let tint = mix(coarse.rgb, SIGNAL * coarse.a, 0.55 + 0.45 * t);
  let decoding = vec4f(tint * lit, coarse.a * lit);

  let dimmed = vec4f(stale.rgb * 0.8, stale.a);
  var out = dimmed;
  if (ahead < 0.0) {
    out = fresh;
  } else if (ahead < BAND) {
    out = mix(decoding, dimmed, smoothstep(0.55, 1.0, t));
  }

  // 扫描线本体与余辉
  let edgePx = abs(ahead) * u.resolution.y;
  let running = step(0.001, u.reveal) * step(u.reveal, 0.999);
  let glow = (exp(-edgePx / 1.4) + exp(-edgePx / 26.0) * 0.28) * running;
  out = vec4f(out.rgb + SIGNAL * glow * max(out.a, 0.35), max(out.a, glow * 0.8));

  // 悬停时跟随指针的斜向高光
  let sweep = exp(-pow((uv.x + uv.y * 0.35) - (u.pointer.x + u.pointer.y * 0.35), 2.0) / 0.012);
  out = vec4f(out.rgb + BONE * sweep * 0.05 * u.hover * out.a, out.a);

  // 扫描纹：悬停时每 3 物理像素压暗一行，离开后完全还原 DOM
  let scan = 1.0 - 0.045 * step(2.0, px.y % 3.0) * u.hover;
  return vec4f(out.rgb * scan, out.a);
}
