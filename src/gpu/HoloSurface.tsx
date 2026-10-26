import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useReducedMotion } from "../hooks.ts";
import { getGpu, markHtmlInCanvasFailed } from "./device.ts";
import { startHolo } from "./holo.ts";
import type { HoloController } from "./holo.ts";
import { usePipeline } from "./usePipeline.ts";

/**
 * 支持 HTML-in-Canvas 时，children 作为 drawable 子树放进 canvas，由 WebGPU 着色后画出；
 * 否则原样作为 DOM 渲染，用 CSS 扫描转场代替。两条路径的 DOM 完全相同。
 */
export function HoloSurface({ switchKey, children }: { switchKey: string; children: ReactNode }) {
  const { htmlInCanvas } = usePipeline();
  const reducedMotion = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const canvasMode = htmlInCanvas === "online" && !failed;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const controller = useRef<HoloController | null>(null);

  // canvas 不会被子元素撑高：跟随 drawable 子树的实际高度
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const card = cardRef.current;
    if (!canvasMode || canvas === null || card === null) return;
    const ro = new ResizeObserver(() => {
      canvas.style.height = `${card.offsetHeight}px`;
    });
    ro.observe(card);
    return () => ro.disconnect();
  }, [canvasMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const card = cardRef.current;
    if (!canvasMode || canvas === null || card === null) return;
    let cancelled = false;
    void (async () => {
      const gpu = await getGpu();
      if (cancelled || gpu === null) return;
      controller.current = startHolo(gpu, canvas, card, {
        reducedMotion,
        onFailure: (reason) => {
          console.warn("[holo] HTML-in-Canvas 路径失败，退回 DOM", reason);
          markHtmlInCanvasFailed();
          setFailed(true);
        },
      });
    })();
    return () => {
      cancelled = true;
      controller.current?.dispose();
      controller.current = null;
    };
  }, [canvasMode, reducedMotion]);

  const prevKey = useRef(switchKey);
  useLayoutEffect(() => {
    if (switchKey === prevKey.current) return;
    prevKey.current = switchKey;
    controller.current?.markSwitch();
  }, [switchKey]);

  if (canvasMode) {
    return (
      <div className="holo holo--canvas">
        <canvas ref={canvasRef} className="holo__canvas" content="drawable" layoutsubtree="">
          <div ref={cardRef} className="holo__card" drawable="">
            {children}
          </div>
        </canvas>
      </div>
    );
  }

  return (
    <div className="holo holo--dom">
      <div key={switchKey} className="holo__card">
        {children}
      </div>
    </div>
  );
}
