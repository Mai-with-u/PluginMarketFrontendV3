import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "../components/Icon.tsx";
import { MapView } from "../components/MapView.tsx";
import { Monogram } from "../components/parts.tsx";
import type { CategoryId } from "../data/types.ts";
import { FieldBackdrop } from "../gpu/FieldBackdrop.tsx";
import { useReducedMotion } from "../hooks.ts";
import {
  camera,
  flyTo,
  groundYFor,
  mapSignals,
  projectGround,
  reliefOf,
  settledElevation,
  subscribeCamera,
  TILT_3D,
} from "../map/camera.ts";
import type { Atlas, Pin, Region } from "../map/layout.ts";
import { InstallButton } from "./InstallButton.tsx";

export type MapMode = "2d" | "3d";

function overview(atlas: Atlas, immediate = false): void {
  const { w, h } = camera.viewport;
  const b = atlas.bounds;
  // 顶部留给标题和视图按钮
  const zoom = Math.min(w / (b.maxX - b.minX), (h - 96) / (b.maxY - b.minY));
  flyTo({ zoom, x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, immediate);
}

/** 选中点飞到画面正中；立体时点立在山上，按海拔把镜头往北补 */
function flyToPin(pin: Pin): void {
  const tilted = camera.target.tilt > 0.1;
  const zoom = Math.max(camera.target.zoom, tilted ? 1.1 : 1.3);
  const view = { ...camera.target, zoom };
  flyTo({ zoom, x: pin.x, y: groundYFor(pin.y, settledElevation(pin.x, pin.y, view), view.tilt) });
}

function flyToRegion(region: Region): void {
  const { w, h } = camera.viewport;
  const span = region.radius * 2 + 260;
  const zoom = Math.min(1.5, Math.max(0.5, Math.min(w / span, h / span)));
  flyTo({ zoom, x: region.x, y: region.y });
}

/** 选中点旁边的小卡片，跟着相机逐帧挪位置，始终留在面板里 */
function Callout({
  pin,
  onOpen,
  onClose,
}: {
  pin: Pin;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    return subscribeCamera(() => {
      const p = projectGround(pin.x, pin.y);
      const { w, h } = camera.viewport;
      // 点被平移出画面时卡片跟着藏起来，不贴在边上指向不存在的位置
      const outside = p.depth <= 0 || p.x < 0 || p.x > w || p.y < 0 || p.y > h;
      el.style.visibility = outside ? "hidden" : "";
      const lift = 16 * Math.min(1, reliefOf() / 100) * Math.min(1.4, Math.max(0.4, p.scale));
      const x = p.x < w * 0.62 ? p.x + 22 : p.x - 22 - width;
      const y = p.y - lift - height / 2;
      el.style.transform = `translate(${Math.round(Math.min(w - width - 12, Math.max(12, x)))}px, ${Math.round(Math.min(h - height - 12, Math.max(60, y)))}px)`;
    });
  }, [pin]);
  const plugin = pin.plugin;
  return (
    <section ref={ref} className="market-callout" aria-label={`地图上选中的插件：${plugin.name}`}>
      <div className="market-callout-head">
        <Monogram plugin={plugin} size="sm" />
        <span className="market-callout-title">
          <strong>{plugin.name}</strong>
          <span>
            {plugin.authorName} · {pin.region.label}
          </span>
        </span>
        <button type="button" className="market-ghost" aria-label="取消选中" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="market-callout-actions">
        <button type="button" className="market-text-button" onClick={() => onOpen(plugin.id)}>
          查看详情
          <Icon name="arrowRight" size={14} />
        </button>
        <InstallButton pluginId={plugin.id} label="安装" />
      </div>
    </section>
  );
}

/**
 * 首页右侧的地形图。相机按面板自身的像素工作，面板尺寸一变就跟着改视口；
 * 全屏只是把同一个面板铺满窗口，筛选和选中状态都不变。
 */
export function MarketMap({
  atlas,
  matchIds,
  focusId,
  hoverId,
  category,
  mode,
  fullscreen,
  onFocus,
  onHover,
  onOpen,
  onCategory,
  onMode,
  onFullscreen,
  onClose,
}: {
  atlas: Atlas;
  matchIds: ReadonlySet<string> | null;
  focusId: string | null;
  hoverId: string | null;
  category: CategoryId | null;
  mode: MapMode;
  fullscreen: boolean;
  onFocus: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onOpen: (id: string) => void;
  onCategory: (id: CategoryId) => void;
  onMode: (mode: MapMode) => void;
  onFullscreen: (on: boolean) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();
  const [hoverRegion, setHoverRegion] = useState<CategoryId | null>(null);
  const focus = focusId === null ? null : (atlas.pinById.get(focusId) ?? null);
  const region = category === null ? null : atlas.regions.find((r) => r.id === category);
  const activeRegion = hoverRegion ?? category ?? focus?.region.id ?? null;

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
      focus === null ? { ...mapSignals.focus, on: false } : { x: focus.x, y: focus.y, on: true };
  }, [focus]);

  // 第一次量到尺寸时取全图视角（链接里带了选中项就再飞过去），之后只跟随尺寸变化
  const initial = useRef({ mode, focus });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let framed = false;
    const sync = (): void => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (w === 0 || h === 0) return;
      camera.viewport = { w, h };
      if (framed) {
        flyTo({}, true);
        return;
      }
      framed = true;
      flyTo({ tilt: initial.current.mode === "3d" ? TILT_3D : 0 }, true);
      overview(atlas, true);
      if (initial.current.focus !== null) flyToPin(initial.current.focus);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    return () => observer.disconnect();
  }, [atlas]);

  // 选中、分区和视角的后续变化才需要镜头移动；挂载时的取景在上面已经做过
  const seen = useRef({ focus, region, mode });
  useEffect(() => {
    if (focus === seen.current.focus) return;
    seen.current.focus = focus;
    if (focus !== null) flyToPin(focus);
  }, [focus]);
  useEffect(() => {
    if (region === seen.current.region) return;
    seen.current.region = region;
    if (region === undefined || region === null) overview(atlas);
    else flyToRegion(region);
  }, [atlas, region]);
  useEffect(() => {
    if (mode === seen.current.mode) return;
    seen.current.mode = mode;
    flyTo({ tilt: mode === "3d" ? TILT_3D : 0 });
  }, [mode]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onFullscreen(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [fullscreen, onFullscreen]);

  const total = atlas.pins.length;
  return (
    <section
      ref={rootRef}
      className="market-map"
      data-fullscreen={fullscreen}
      aria-label="插件地形图"
    >
      <FieldBackdrop />
      <MapView
        atlas={atlas}
        matchIds={matchIds}
        selectedId={focusId}
        hoverId={hoverId}
        activeRegion={activeRegion}
        onSelect={(id) => onFocus(id === focusId ? null : id)}
        onHover={onHover}
        onRegion={(r) => onCategory(r.id)}
        onHoverRegion={setHoverRegion}
      />
      {focus !== null && (
        <Callout key={focus.plugin.id} pin={focus} onOpen={onOpen} onClose={() => onFocus(null)} />
      )}
      <div className="market-map-head">
        <p className="market-map-title">
          <span>地形图</span>
          <span>
            {matchIds === null ? `${total} 个测绘点` : `高亮 ${matchIds.size} / ${total}`}
          </span>
        </p>
        <div className="market-map-controls">
          <button
            type="button"
            aria-label="平面视图"
            aria-pressed={mode === "2d"}
            onClick={() => onMode("2d")}
          >
            <Icon name="plane" size={16} />
          </button>
          <button
            type="button"
            aria-label="立体视图"
            aria-pressed={mode === "3d"}
            onClick={() => onMode("3d")}
          >
            <Icon name="cube" size={16} />
          </button>
          <button
            type="button"
            aria-label={fullscreen ? "退出全屏" : "全屏地图"}
            onClick={() => onFullscreen(!fullscreen)}
          >
            <Icon name={fullscreen ? "collapse" : "expand"} size={16} />
          </button>
          <button type="button" aria-label="关闭地图" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
      <ul className="market-map-legend" aria-label="标记说明">
        <li>
          <i />
          清单已同步
        </li>
        <li>
          <i className="is-missing" />
          未同步
        </li>
      </ul>
    </section>
  );
}
