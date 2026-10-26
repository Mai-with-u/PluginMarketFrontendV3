import { useEffect, useRef } from "react";

import { useReducedMotion } from "../hooks.ts";
import { getGpu } from "./device.ts";
import { startField } from "./field.ts";
import { usePipeline } from "./usePipeline.ts";

/** 铺满所在地图面板的 WebGPU 地形。WebGPU 不可用时只留 CSS 点阵底。 */
export function FieldBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const { webgpu } = usePipeline();

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const gpu = await getGpu();
      const canvas = canvasRef.current;
      if (cancelled || gpu === null || canvas === null) return;
      stop = startField(gpu, canvas, { reducedMotion });
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [reducedMotion]);

  return (
    <div className="field" data-state={webgpu} aria-hidden="true">
      <div className="field__fallback" />
      <canvas ref={canvasRef} className="field__canvas" />
    </div>
  );
}
