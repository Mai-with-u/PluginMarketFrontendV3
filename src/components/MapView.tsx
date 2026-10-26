import { useEffect, useLayoutEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { CategoryId } from "../data/types.ts";
import {
  camera,
  FOCAL,
  panBy,
  projectGround,
  RELIEF,
  reliefOf,
  screenToGround,
  subscribeCamera,
  zoomAt,
} from "../map/camera.ts";
import type { Atlas, Region } from "../map/layout.ts";

const NICE_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000];
/** 2.5D 时测绘点立在细杆上，杆长（屏幕 px，按透视缩放） */
const STEM = 16;

const zoomCenter = (factor: number): void =>
  zoomAt(camera.viewport.w / 2, camera.viewport.h / 2, factor);

function lod(zoom: number): "far" | "mid" | "near" {
  if (zoom < 0.72) return "far";
  if (zoom < 1.3) return "mid";
  return "near";
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Anchor {
  el: HTMLElement;
  x: number;
  y: number;
  lift: number;
  /** 山名：平面时挂在北麓上方；立体时换到南麓下方，不会被自己的山挡住 */
  south: number | null;
  /** 上一帧写进 DOM 的值，没变就不写，避免每帧 300 多次样式失效 */
  last: { transform: string; fog: string; z: string; hidden: boolean; side: string; fade: string };
}

function write(a: Anchor, key: "transform" | "z", value: string): void {
  if (a.last[key] === value) return;
  a.last[key] = value;
  if (key === "transform") a.el.style.transform = value;
  else a.el.style.zIndex = value;
}

function writeVar(a: Anchor, key: "fog" | "fade", value: string): void {
  if (a.last[key] === value) return;
  a.last[key] = value;
  a.el.style.setProperty(`--${key}`, value);
}

function setHidden(a: Anchor, hidden: boolean): void {
  if (a.last.hidden === hidden) return;
  a.last.hidden = hidden;
  a.el.style.visibility = hidden ? "hidden" : "";
}

export function MapView({
  atlas,
  matchIds,
  selectedId,
  hoverId = null,
  activeRegion,
  onSelect,
  onHover,
  onRegion,
  onHoverRegion,
}: {
  atlas: Atlas;
  matchIds: ReadonlySet<string> | null;
  selectedId: string | null;
  hoverId?: string | null;
  activeRegion: CategoryId | null;
  onSelect: (id: string) => void;
  onHover?: (id: string | null) => void;
  onRegion: (region: Region) => void;
  onHoverRegion: (id: CategoryId | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const coordRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);

  // 相机 → 每个标注的屏幕位置、透视缩放、雾中淡出、前后层叠
  useLayoutEffect(() => {
    const root = rootRef.current;
    const layer = layerRef.current;
    if (root === null || layer === null) return;
    const anchors: Anchor[] = [...layer.querySelectorAll<HTMLElement>("[data-wx]")].map((el) => ({
      el,
      x: Number(el.dataset["wx"]),
      y: Number(el.dataset["wy"]),
      lift: Number(el.dataset["lift"] ?? 0),
      south: el.dataset["sy"] === undefined ? null : Number(el.dataset["sy"]),
      last: { transform: "", fog: "", z: "", hidden: false, side: "", fade: "" },
    }));

    const rootState = { stem: "", lod: "", relief: "" };
    return subscribeCamera((v) => {
      const distance = FOCAL / v.zoom;
      const relief = reliefOf(v);
      const rise = Math.min(1, relief / RELIEF);
      for (const a of anchors) {
        const southern = a.south !== null && rise >= 0.5;
        const p = projectGround(a.x, southern && a.south !== null ? a.south : a.y, a.lift * relief);
        if (a.south !== null) {
          // 换边时先淡出再淡入，看不到跳位
          const side = southern ? "south" : "north";
          if (a.last.side !== side) {
            a.last.side = side;
            a.el.dataset["side"] = side;
          }
          writeVar(a, "fade", Math.abs(rise * 2 - 1).toFixed(2));
        }
        if (p.depth <= distance * 0.08) {
          setHidden(a, true);
          continue;
        }
        const fog = 1 - smoothstep(distance * 1.2, distance * 2.05, p.depth);
        setHidden(a, fog < 0.02);
        write(
          a,
          "transform",
          `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) scale(${Math.min(1.4, Math.max(0.4, p.scale)).toFixed(3)})`,
        );
        writeVar(a, "fog", fog.toFixed(2));
        // 粗分档：深度变化不大时 z-index 不变，避免每帧重排 300 多个元素的层叠顺序
        write(a, "z", String(Math.round(2e5 / p.depth)));
      }
      // 根节点上的变量和属性一变，整棵标注子树都要重算样式，所以只在真变了时写
      const stem = `${(STEM * Math.min(1, relief / 100)).toFixed(0)}px`;
      if (rootState.stem !== stem) {
        rootState.stem = stem;
        root.style.setProperty("--stem", stem);
      }
      const level = lod(v.zoom);
      if (rootState.lod !== level) {
        rootState.lod = level;
        root.dataset["lod"] = level;
      }
      const reliefFlag = relief > 1 ? "on" : "off";
      if (rootState.relief !== reliefFlag) {
        rootState.relief = reliefFlag;
        root.dataset["relief"] = reliefFlag;
      }

      const scale = scaleRef.current;
      if (scale !== null) {
        const meters = NICE_STEPS.find((s) => s * v.zoom >= 64) ?? 2000;
        scale.style.setProperty("--bar", `${meters * v.zoom}px`);
        scale.dataset["label"] = `${meters} m`;
        scale.dataset["ratio"] = `1 : ${Math.round(1000 / v.zoom).toLocaleString("en-US")}`;
      }
    });
  }, []);

  // 滚轮缩放（触控板捏合带 ctrlKey，步长更大）
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const speed = e.ctrlKey ? 0.012 : 0.0017;
      const box = root.getBoundingClientRect();
      zoomAt(e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * speed));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest("button") !== null) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const coord = coordRef.current;
    if (coord !== null) {
      // 相机的屏幕坐标以地图容器左上角为原点，地图不一定铺满整个窗口
      const box = e.currentTarget.getBoundingClientRect();
      const ground = screenToGround(e.clientX - box.left, e.clientY - box.top);
      coord.textContent =
        ground === null
          ? "N ----  E ----"
          : `N ${String(Math.round(ground[1])).padStart(4, "0")}  E ${String(Math.round(ground[0])).padStart(4, "0")}`;
    }
    const g = drag.current;
    if (g === null) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 3) return;
    g.moved = true;
    g.x = e.clientX;
    g.y = e.clientY;
    panBy(dx, dy);
  };
  const onPointerUp = (): void => {
    drag.current = null;
  };

  return (
    <div
      ref={rootRef}
      className="map"
      data-lod="far"
      data-relief="off"
      data-searching={matchIds !== null}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div ref={layerRef} className="map__layer">
        {atlas.regions.map((r, i) => (
          <button
            key={r.id}
            type="button"
            className="region"
            data-wx={r.x}
            data-wy={r.y - r.radius - 30}
            data-sy={r.y + r.radius + 40}
            aria-label={`${r.label}，${r.count} 个插件`}
            data-active={activeRegion === r.id}
            data-pulse=""
            style={{ "--i": i }}
            onClick={() => onRegion(r)}
            onPointerEnter={() => onHoverRegion(r.id)}
            onPointerLeave={() => onHoverRegion(null)}
          >
            <span className="region__box">
              <span className="region__name">{r.label}</span>
              <span className="region__meta">
                <i>{r.latin}</i>
                <b>{r.count}</b>
              </span>
            </span>
          </button>
        ))}

        {atlas.pins.map((pin) => {
          const p = pin.plugin;
          const selected = p.id === selectedId;
          return (
            <button
              key={p.id}
              type="button"
              className="pin"
              data-wx={pin.x}
              data-wy={pin.y}
              data-featured={p.featured}
              data-synced={p.hasDetails}
              data-selected={selected}
              data-hot={p.id === hoverId}
              data-dim={matchIds !== null && !matchIds.has(p.id)}
              style={{ "--d": pin.rank }}
              tabIndex={selected ? 0 : -1}
              aria-label={`${p.name}，${pin.region.label}`}
              onClick={() => onSelect(p.id)}
              onPointerEnter={() => onHover?.(p.id)}
              onPointerLeave={() => onHover?.(null)}
            >
              <span className="pin__stem" />
              <span className="pin__dot" />
              <span className="pin__label" aria-hidden="true">
                <b>{p.name}</b>
                {p.version !== null && <i>▲ {p.version}</i>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="hud" aria-hidden="true">
        <div ref={scaleRef} className="hud__scale" />
        <span ref={coordRef} className="hud__coord">
          N 0000 E 0000
        </span>
      </div>
      <div className="zoomer">
        <button
          type="button"
          className="zoomer__btn"
          onClick={() => zoomCenter(1.4)}
          aria-label="放大"
        >
          +
        </button>
        <button
          type="button"
          className="zoomer__btn"
          onClick={() => zoomCenter(1 / 1.4)}
          aria-label="缩小"
        >
          −
        </button>
      </div>
    </div>
  );
}
