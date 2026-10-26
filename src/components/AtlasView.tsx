import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { pad, queryCatalog } from "../data/catalog.ts";
import type { Catalog, CategoryId } from "../data/types.ts";
import { HoloSurface } from "../gpu/HoloSurface.tsx";
import { usePipeline } from "../gpu/usePipeline.ts";
import { useReducedMotion, useSearchParams } from "../hooks.ts";
import {
  camera,
  flyTo,
  FOCAL,
  groundYFor,
  mapSignals,
  project,
  projectGround,
  reliefOf,
  settledElevation,
  subscribeCamera,
  TILT_3D,
  zoomAt,
} from "../map/camera.ts";
import { buildAtlas } from "../map/layout.ts";
import type { Pin, Region } from "../map/layout.ts";
import { BOOT_DONE_MS, BOOT_REVEAL_MS, BootSequence } from "./BootSequence.tsx";
import { DetailCard } from "./DetailCard.tsx";
import { CategoryGlyph, Icon } from "./Icon.tsx";
import { MapView } from "./MapView.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";

const PANEL_W = 420;
const LEGEND_W = 260;
const NARROW = 760;

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** 选中点飞到“左侧剩余区域”的中心，给右侧详情栏让位 */
function flyToPin(pin: Pin): void {
  const tilted = camera.target.tilt > 0.1;
  const zoom = Math.max(camera.target.zoom, tilted ? 1.1 : 1.45);
  const { w, h } = camera.viewport;
  // 立体时点立在山上，按海拔把镜头往北补，点才会落在画面中间
  const view = { ...camera.target, zoom };
  const z = settledElevation(pin.x, pin.y, view);
  const y = groundYFor(pin.y, z, view.tilt);
  if (w < NARROW) {
    flyTo({ zoom, x: pin.x, y: y + (h * 0.22) / zoom });
    return;
  }
  // 放到图例与详情栏之间空地的正中；点离镜头越近透视放大越多，按深度换算回世界距离
  const depth = project(pin.x, pin.y, z, { ...view, x: pin.x, y }).depth;
  const freeCenter = (LEGEND_W + 34 + (w - PANEL_W - 24)) / 2;
  flyTo({ zoom, x: pin.x - ((freeCenter - w / 2) * depth) / FOCAL, y });
}

function flyToRegion(region: Region): void {
  const { w, h } = camera.viewport;
  const span = region.radius * 2 + 260;
  const zoom = Math.min(1.5, Math.max(0.7, Math.min((w - LEGEND_W) / span, h / span)));
  flyTo({ zoom, x: region.x - (w < NARROW ? 0 : LEGEND_W / 2 / zoom), y: region.y });
}

function overview(atlas: ReturnType<typeof buildAtlas>, immediate = false, scale = 1): void {
  const { w, h } = camera.viewport;
  const b = atlas.bounds;
  const usable = w < NARROW ? w : w - LEGEND_W;
  const zoom = Math.min(usable / (b.maxX - b.minX), (h - 80) / (b.maxY - b.minY)) * scale;
  flyTo(
    {
      zoom,
      x: (b.minX + b.maxX) / 2 - (w < NARROW ? 0 : LEGEND_W / 2 / zoom),
      y: (b.minY + b.maxY) / 2,
    },
    immediate,
  );
}

function LeaderLine({ pin }: { pin: Pin | null }) {
  const pathRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);

  useLayoutEffect(() => {
    if (pin === null) return;
    // 详情栏的位置缓存起来；每帧读 getBoundingClientRect 会在大量样式写入后强制同步布局
    const panel = document.querySelector(".detail");
    let rect = panel?.getBoundingClientRect() ?? null;
    const remeasure = (): void => {
      rect = panel?.getBoundingClientRect() ?? null;
    };
    const settle = setTimeout(remeasure, 700);
    addEventListener("resize", remeasure);
    const unsubscribe = subscribeCamera(() => {
      const path = pathRef.current;
      const dot = dotRef.current;
      if (path === null || dot === null || rect === null) return;
      const stem = 16 * Math.min(1, reliefOf() / 100);
      const g = projectGround(pin.x, pin.y);
      const x = g.x;
      const y = g.y - stem * Math.min(1.4, Math.max(0.4, g.scale));
      const r = rect;
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      if (camera.viewport.w < NARROW) {
        path.setAttribute("d", `M${x} ${y + 10} V${r.top}`);
        return;
      }
      const elbowY = Math.min(Math.max(y - 34, r.top + 30), r.bottom - 30);
      const elbowX = x + Math.abs(y - elbowY);
      path.setAttribute("d", `M${x + 8} ${y - 6} L${elbowX} ${elbowY} H${r.left}`);
    });
    return () => {
      unsubscribe();
      clearTimeout(settle);
      removeEventListener("resize", remeasure);
    };
  }, [pin]);

  if (pin === null) return null;
  return (
    <svg className="leader" aria-hidden="true">
      <path ref={pathRef} />
      <circle ref={dotRef} r="12" />
    </svg>
  );
}

export function AtlasView({ catalog }: { catalog: Catalog }) {
  const atlas = useMemo(() => buildAtlas(catalog), [catalog]);
  const [params, setParams] = useSearchParams();
  const reducedMotion = useReducedMotion();
  // boot：测绘自检盖住画面；reveal：幕布收起、镜头俯冲、地名浮现；done：卸载幕布
  const [phase, setPhase] = useState<"boot" | "reveal" | "done">(reducedMotion ? "done" : "boot");
  const booting = useRef(phase === "boot");
  useEffect(() => {
    if (!booting.current) return;
    const reveal = setTimeout(() => setPhase("reveal"), BOOT_REVEAL_MS);
    const done = setTimeout(() => setPhase("done"), BOOT_DONE_MS);
    return () => {
      clearTimeout(reveal);
      clearTimeout(done);
    };
  }, []);
  const { webgpu, htmlInCanvas } = usePipeline();
  const searchRef = useRef<HTMLInputElement>(null);
  const [hoverRegion, setHoverRegion] = useState<CategoryId | null>(null);
  const [cursor, setCursor] = useState(0);

  const q = params.get("q") ?? "";
  const deferredQ = useDeferredValue(q);
  const matches = useMemo(
    () =>
      deferredQ.trim() === ""
        ? null
        : queryCatalog(catalog.plugins, {
            q: deferredQ,
            cat: null,
            sort: "index",
            iconOnly: false,
            syncedOnly: false,
          }),
    [catalog.plugins, deferredQ],
  );
  const matchIds = useMemo(
    () => (matches === null ? null : new Set(matches.map((p) => p.id))),
    [matches],
  );

  const mode = params.get("mode") === "3d" ? "3d" : "2d";
  const selectedId = params.get("p");
  const selected = selectedId === null ? null : (atlas.pinById.get(selectedId) ?? null);
  const activeRegion = hoverRegion ?? selected?.region.id ?? null;

  // ---- 地图状态写入着色器信号
  useLayoutEffect(() => {
    camera.reducedMotion = reducedMotion;
  }, [reducedMotion]);

  useLayoutEffect(() => {
    mapSignals.regions = atlas.regions.map((r) => [
      r.x,
      r.y,
      r.height,
      r.id === activeRegion ? 1 : 0,
    ]);
    const b = atlas.bounds;
    mapSignals.bounds = [b.minX, b.minY, b.maxX, b.maxY];
  }, [atlas, activeRegion]);

  useLayoutEffect(() => {
    mapSignals.focus =
      selected === null
        ? { ...mapSignals.focus, on: false }
        : { x: selected.x, y: selected.y, on: true };
  }, [selected]);

  // ---- 视口与开场：从高空俯冲到全图（或链接里指定的插件）
  const initial = useRef(selected);
  const initialMode = useRef(mode);
  useLayoutEffect(() => {
    const sync = (): void => {
      camera.viewport = { w: innerWidth, h: innerHeight };
    };
    sync();
    flyTo({ tilt: initialMode.current === "3d" ? TILT_3D : 0 }, true);
    overview(atlas, true, 0.55);
    const start = initial.current;
    const id = setTimeout(
      () => (start === null ? overview(atlas) : flyToPin(start)),
      booting.current ? BOOT_REVEAL_MS : 120,
    );
    const onResize = (): void => {
      sync();
      flyTo({}, true);
    };
    addEventListener("resize", onResize);
    return () => {
      clearTimeout(id);
      removeEventListener("resize", onResize);
    };
  }, [atlas]);

  const select = useCallback(
    (id: string | null) => {
      setParams((p) => (id === null ? p.delete("p") : p.set("p", id)));
      const pin = id === null ? null : atlas.pinById.get(id);
      if (pin !== undefined && pin !== null) flyToPin(pin);
    },
    [atlas, setParams],
  );

  const setMode = useCallback(
    (next: "2d" | "3d") => {
      setParams((p) => (next === "2d" ? p.delete("mode") : p.set("mode", next)));
      flyTo({ tilt: next === "3d" ? TILT_3D : 0 });
    },
    [setParams],
  );

  const setQuery = useCallback(
    (value: string) => {
      setCursor(0);
      setParams((p) => (value === "" ? p.delete("q") : p.set("q", value)));
    },
    [setParams],
  );

  // ← → 沿“巡览顺序”走：有搜索结果就走结果，否则按分区、螺旋序走遍全图
  const tour = useMemo(
    () =>
      matches === null
        ? atlas.tour
        : matches.map((p) => atlas.pinById.get(p.id)).filter((p): p is Pin => p !== undefined),
    [atlas, matches],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !isTyping(e.target))) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = selected === null ? -1 : tour.findIndex((p) => p.plugin.id === selected.plugin.id);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        const next = tour[(at + 1) % tour.length];
        if (next !== undefined) select(next.plugin.id);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        const next = tour[(at - 1 + tour.length) % tour.length];
        if (next !== undefined) select(next.plugin.id);
      } else if (e.key === "Escape") {
        select(null);
        overview(atlas);
      } else if (e.key === "v" || e.key === "V") {
        setMode(mode === "3d" ? "2d" : "3d");
      } else if (e.key === "=" || e.key === "+") {
        zoomAt(camera.viewport.w / 2, camera.viewport.h / 2, 1.4);
      } else if (e.key === "-") {
        zoomAt(camera.viewport.w / 2, camera.viewport.h / 2, 1 / 1.4);
      } else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [atlas, mode, select, selected, setMode, tour]);

  const results = matches?.slice(0, 7) ?? [];

  return (
    <div className="atlas" data-panel={selected !== null} data-phase={phase}>
      {phase !== "done" && <BootSequence catalog={catalog} pipeline={webgpu} />}
      <MapView
        atlas={atlas}
        matchIds={matchIds}
        selectedId={selected?.plugin.id ?? null}
        activeRegion={activeRegion}
        onSelect={select}
        onRegion={flyToRegion}
        onHoverRegion={setHoverRegion}
      />

      <LeaderLine pin={selected} />

      <header className="masthead">
        <h1 className="masthead__title">麦麦插件</h1>
        <p className="masthead__sub">
          Plugin Topography — {catalog.counts.plugins} entries surveyed across{" "}
          {atlas.regions.length} ranges
        </p>
      </header>

      <search className="finder">
        <label className="finder__field">
          <Icon name="search" size={17} />
          <span className="visually-hidden">检索插件</span>
          <input
            ref={searchRef}
            type="search"
            value={q}
            placeholder="检索插件、作者或仓库 ID"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, results.length - 1));
              else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
              else if (e.key === "Enter") {
                const hit = results[cursor];
                if (hit !== undefined) select(hit.id);
              } else if (e.key === "Escape") setQuery("");
              else return;
              e.preventDefault();
            }}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        {matches !== null && (
          <div className="finder__results">
            <p className="finder__count">
              {matches.length === 0 ? "没有匹配的测绘点" : `${pad(matches.length)} 个测绘点已标出`}
            </p>
            <ul>
              {results.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="finder__hit"
                    data-cursor={i === cursor}
                    onClick={() => select(p.id)}
                  >
                    <b>{p.name}</b>
                    <span>
                      {p.authorName} · {atlas.pinById.get(p.id)?.region.label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </search>

      <nav className="legend" aria-label="分区图例">
        <ul className="legend__ranges">
          {atlas.regions.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="legend__range"
                data-active={activeRegion === r.id}
                onClick={() => flyToRegion(r)}
                onPointerEnter={() => setHoverRegion(r.id)}
                onPointerLeave={() => setHoverRegion(null)}
              >
                <CategoryGlyph id={r.id} size={15} />
                <span>{r.label}</span>
                <b>{r.count}</b>
              </button>
            </li>
          ))}
        </ul>
        <ul className="legend__marks" aria-label="标记说明">
          <li>
            <i className="mark mark--featured" />
            精选插件
          </li>
          <li>
            <i className="mark" />
            清单已同步
          </li>
          <li>
            <i className="mark mark--missing" />
            清单未同步
          </li>
        </ul>
        <p className="legend__keys">拖拽平移 · 滚轮缩放 · ← → 巡览 · V 立体 · Esc 全图</p>
      </nav>

      <div className="view-controls">
        <ThemeSwitch />
        <fieldset className="modeswitch">
          <legend className="visually-hidden">视图</legend>
          {(["2d", "3d"] as const).map((m) => (
            <label key={m} className="modeswitch__opt">
              <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
              <span>{m === "2d" ? "平面" : "立体"}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <p className="status" aria-hidden="true">
        <span data-state={webgpu}>WebGPU</span>
        <span data-state={htmlInCanvas}>HTML-in-Canvas</span>
      </p>

      {selected !== null && (
        <aside className="detail" aria-label="插件详情">
          <HoloSurface switchKey={selected.plugin.id}>
            <DetailCard catalog={catalog} pin={selected} onClose={() => select(null)} />
          </HoloSurface>
        </aside>
      )}
    </div>
  );
}
