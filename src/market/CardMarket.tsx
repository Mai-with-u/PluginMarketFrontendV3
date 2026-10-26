import {
  memo,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { CategoryGlyph, Icon } from "../components/Icon.tsx";
import { Monogram } from "../components/parts.tsx";
import { ThemeSwitch } from "../components/ThemeSwitch.tsx";
import { queryCatalog } from "../data/catalog.ts";
import type { Catalog, CategoryId } from "../data/types.ts";
import { useReducedMotion, useSearchParams } from "../hooks.ts";
import { buildAtlas } from "../map/layout.ts";
import { compatible, mergeCatalog, types } from "./data.ts";
import type { MarketPlugin } from "./data.ts";
import { InstallButton } from "./InstallButton.tsx";
import { MarketMap } from "./MarketMap.tsx";
import type { MapMode } from "./MarketMap.tsx";
import { PluginDetail } from "./PluginDetail.tsx";
import { useMarketSnapshot } from "./useMarketSnapshot.ts";

import "../developer/developer.css";
import "./market.css";

const score = (p: MarketPlugin | undefined) =>
  Math.log10((p?.stats?.downloads ?? 0) + 1) * 4 +
  Math.log10((p?.stats?.likes ?? 0) + 1) * 3 +
  (p?.stats?.rating ?? 0) * Math.log10((p?.stats?.rating_count ?? 0) + 2) +
  Number(p?.featured ?? false);

const MAP_KEY = "market-map";
/** 窄于这个宽度没有侧栏地图，只能全屏打开 */
const WIDE = "(min-width: 1024px)";
const subscribeWide = (onChange: () => void) => {
  const query = matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const isWide = () => matchMedia(WIDE).matches;
const readMapPreference = () => {
  const saved = localStorage.getItem(MAP_KEY);
  return saved === "on" ? true : saved === "off" ? false : null;
};
const cardId = (id: string) => `market-card-${id}`;

const PluginCard = memo(function PluginCard({
  plugin: p,
  region,
  state,
  incompatible,
  onOpen,
  onLocate,
  onHover,
}: {
  plugin: MarketPlugin;
  region: string;
  state: "idle" | "hot" | "focus";
  incompatible: boolean;
  onOpen: (id: string) => void;
  onLocate: ((id: string) => void) | null;
  onHover: (id: string | null) => void;
}) {
  const place = (
    <>
      <CategoryGlyph id={p.categoryId} size={14} />
      {region}
    </>
  );
  return (
    <article
      id={cardId(p.id)}
      className="market-card"
      data-state={state}
      onPointerEnter={() => onHover(p.id)}
      onPointerLeave={() => onHover(null)}
    >
      <div className="market-card-head">
        <span className="market-card-tile">
          <Monogram plugin={p} size="md" />
          {p.featured && <span className="market-card-feat" aria-hidden="true" />}
        </span>
        <div className="market-card-title">
          <h2>
            <button type="button" title={p.name} onClick={() => onOpen(p.id)}>
              {p.name}
            </button>
          </h2>
          <p>
            {p.authorName} · <span>v{p.version ?? "—"}</span>
            {p.featured && <span className="visually-hidden">，精选</span>}
          </p>
        </div>
        {onLocate === null ? (
          <span className="market-locate">{place}</span>
        ) : (
          <button
            type="button"
            className="market-locate"
            aria-label={`在地图上定位，${region}`}
            onClick={() => onLocate(p.id)}
          >
            {place}
          </button>
        )}
      </div>
      <p className="market-description">{p.description || "作者尚未提供简介。"}</p>
      <div className="market-card-foot">
        <span title="累计下载">↓ {p.stats?.downloads.toLocaleString() ?? "—"}</span>
        <span title="点赞">♡ {p.stats?.likes.toLocaleString() ?? "—"}</span>
        <span title={p.stats ? `${p.stats.rating_count} 人评分` : "统计未加载"}>
          ★ {p.stats?.rating_count ? p.stats.rating.toFixed(1) : "—"}
        </span>
        {incompatible && <span className="market-incompatible">清单不兼容</span>}
        <InstallButton pluginId={p.id} label="安装" />
      </div>
    </article>
  );
});

export default function CardMarket({ catalog }: { catalog: Catalog }) {
  const [params, setParams] = useSearchParams();
  const [revision, setRevision] = useState(0);
  const { snapshot, refreshing } = useMarketSnapshot(revision);
  const liveData = snapshot?.catalog;
  const releases = snapshot?.releases;
  const plugins: MarketPlugin[] = useMemo(
    () => (liveData ? mergeCatalog(catalog, liveData) : catalog.plugins),
    [catalog, liveData],
  );
  const atlas = useMemo(() => buildAtlas(catalog), [catalog]);
  const regionLabel = useMemo(
    () => new Map(catalog.categories.map((c) => [c.id, c.label])),
    [catalog],
  );
  const q = params.get("q") ?? "";
  const search = useDeferredValue(q);
  const type = params.get("type") ?? "all";
  const sort = params.get("sort") ?? "recommended";
  const category = catalog.categories.find((c) => c.id === params.get("cat"))?.id ?? null;
  const mode: MapMode = params.get("mode") === "3d" ? "3d" : "2d";
  const requestedHost = params.get("host");
  const host = releases?.items.some((item) => item.version === requestedHost)
    ? (requestedHost ?? "")
    : (releases?.latest ?? "");
  const onlyCompatible = params.get("compatible") === "1";
  const update = useCallback(
    (key: string, value: string) => setParams((p) => (value ? p.set(key, value) : p.delete(key))),
    [setParams],
  );
  const selectedId = params.get("p");
  const selected =
    selectedId === null
      ? undefined
      : plugins.find((p) => p.id === selectedId || p.manifestId === selectedId);
  const canCheck = /^\d+\.\d+\.\d+$/.test(host);
  const isCompatible = (p: MarketPlugin) =>
    Number(p.manifestVersion) >= 2 && compatible(host, p.hostMin, p.hostMax);
  const matches = useMemo(() => {
    const found = queryCatalog(plugins, {
      q: search,
      cat: null,
      sort: "index",
      iconOnly: false,
      syncedOnly: false,
    });
    const filtered = found.filter(
      (p) =>
        (category === null || p.categoryId === category) &&
        (type === "all" || (p.pluginType ?? "extension") === type) &&
        (!onlyCompatible ||
          !canCheck ||
          (Number(p.manifestVersion) >= 2 && compatible(host, p.hostMin, p.hostMax))),
    );
    const stats = new Map(plugins.map((p) => [p.id, p]));
    return filtered
      .toSorted((a, b) => {
        const x = stats.get(a.id),
          y = stats.get(b.id);
        if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
        if (sort === "latest") return (y?.updatedAt ?? "").localeCompare(x?.updatedAt ?? "");
        if (sort === "downloads" || sort === "likes" || sort === "rating")
          return (y?.stats?.[sort] ?? -1) - (x?.stats?.[sort] ?? -1);
        return score(y) - score(x);
      })
      .map<MarketPlugin>((p) => stats.get(p.id) ?? p);
  }, [plugins, search, category, type, sort, host, onlyCompatible, canCheck]);
  const filtering =
    search.trim() !== "" || category !== null || type !== "all" || (onlyCompatible && canCheck);
  const matchIds = useMemo(
    () => (filtering ? new Set(matches.map((p) => p.id)) : null),
    [filtering, matches],
  );

  // 地图：宽屏默认开在右侧；没有 WebGPU 或要求减弱动态时默认关，用户的选择记在本机
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  const reducedMotion = useReducedMotion();
  const [mapPreference, setMapPreference] = useState(readMapPreference);
  const [fullscreen, setFullscreen] = useState(false);
  const [focusChoice, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // 选中项被筛选掉后不再高亮，筛选放宽回来时又会重新出现
  const focusId =
    focusChoice !== null && (matchIds === null || matchIds.has(focusChoice)) ? focusChoice : null;
  const mapOn = wide && (mapPreference ?? ("gpu" in navigator && !reducedMotion));
  const setMap = (on: boolean) => {
    localStorage.setItem(MAP_KEY, on ? "on" : "off");
    setMapPreference(on);
    if (!on) setFullscreen(false);
  };
  const open = useCallback((id: string) => update("p", id), [update]);
  const locate = useCallback((id: string) => setFocusId(id), []);
  const focusFromMap = useCallback((id: string | null) => {
    setFocusId(id);
    if (id !== null) document.getElementById(cardId(id))?.scrollIntoView({ block: "nearest" });
  }, []);
  const side = mapOn && selected === undefined;
  const showMap = selected === undefined && (mapOn || fullscreen);

  const results = (
    <>
      <div className="market-results">
        <strong>
          {onlyCompatible && !canCheck
            ? "等待版本信息"
            : category === null
              ? `${matches.length} 个插件`
              : `${regionLabel.get(category)} · ${matches.length} 个插件`}
        </strong>
        <span className="market-muted">
          {refreshing
            ? "正在刷新…"
            : liveData
              ? `统计更新于 ${new Date(liveData.snapshot_at * 1000).toLocaleTimeString()}`
              : "本地目录 · 统计不可用"}
        </span>
        {wide && !mapOn && (
          <span className="market-muted market-map-off">
            <Icon name="check" size={13} />
            地图已关闭，不加载 WebGPU
          </span>
        )}
      </div>
      {snapshot?.releasesError && (
        <p className="market-error" role="alert">
          {snapshot.releasesError.message}
          {releases ? "。当前保留上次加载的版本。" : "。请点击刷新重试。"}
        </p>
      )}
      {snapshot?.catalogError && (
        <p className="market-error" role="alert">
          最新数据暂不可用：{snapshot.catalogError.message}。
          {liveData ? "当前保留上次加载的目录与统计" : "当前显示本地目录，统计未显示"}
          ；可点击刷新重试。
        </p>
      )}
      {params.has("p") && !selected && <p role="alert">此插件未在当前目录中找到。</p>}
    </>
  );

  return (
    <main className="market-page" data-map={side ? "side" : "off"}>
      <header className="market-header">
        <div className="market-title">
          <a href="/" className="market-brand">
            麦麦插件
          </a>
          <p className="market-subtitle">
            Plugin Topography — {catalog.counts.plugins} entries surveyed across{" "}
            {catalog.categories.length} ranges
          </p>
        </div>
        <div className="market-actions">
          <a className="market-secondary" href="/developer">
            开发者中心 ↗
          </a>
          <InstallButton settings pluginId="" />
          <ThemeSwitch />
        </div>
      </header>
      {!snapshot ? (
        <output className="market-empty" aria-busy="true">
          正在加载插件目录、统计和版本信息…
        </output>
      ) : selected ? (
        <PluginDetail key={selected.id} plugin={selected} onClose={() => update("p", "")} />
      ) : (
        <>
          <section className="market-toolbar" aria-label="检索与筛选">
            <label className="market-search">
              <Icon name="search" size={16} />
              <span className="visually-hidden">检索插件</span>
              <input
                type="search"
                value={q}
                placeholder="检索插件、作者、标签或插件 ID"
                onChange={(e) => update("q", e.target.value)}
              />
            </label>
            <label className="market-select">
              <span className="visually-hidden">插件类型</span>
              <select value={type} onChange={(e) => update("type", e.target.value)}>
                <option value="all">全部类型</option>
                {Object.entries(types).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" size={12} />
            </label>
            <label className="market-select">
              <span className="visually-hidden">排序</span>
              <select value={sort} onChange={(e) => update("sort", e.target.value)}>
                {[
                  ["recommended", "推荐排序"],
                  ["latest", "最近发布"],
                  ["downloads", "下载最多"],
                  ["likes", "点赞最多"],
                  ["rating", "评分最高"],
                  ["name", "名称排序"],
                ].map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" size={12} />
            </label>
            <label className="market-select">
              <span className="visually-hidden">MaiBot 版本</span>
              <select
                value={host}
                onChange={(e) => update("host", e.target.value)}
                disabled={!releases}
              >
                {!releases && <option value="">版本加载失败</option>}
                {releases?.items.map((release) => (
                  <option key={release.version} value={release.version}>
                    MaiBot {release.tag}
                    {release.version === releases.latest ? "（最新）" : ""}
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" size={12} />
            </label>
            <label className="market-check">
              <input
                type="checkbox"
                checked={onlyCompatible}
                disabled={!canCheck && !onlyCompatible}
                onChange={(e) => update("compatible", e.target.checked ? "1" : "")}
              />
              仅兼容
            </label>
            <button
              type="button"
              className="market-icon-button"
              title="刷新统计"
              aria-label="刷新统计"
              disabled={refreshing}
              aria-busy={refreshing}
              onClick={() => setRevision((v) => v + 1)}
            >
              ↻
            </button>
            {wide && (
              <>
                <span className="market-divider" aria-hidden="true" />
                <button
                  type="button"
                  role="switch"
                  aria-checked={mapOn}
                  className="market-switch"
                  onClick={() => setMap(!mapOn)}
                >
                  <Icon name="map" size={16} />
                  地图
                  <span className="market-switch-track" aria-hidden="true" />
                </button>
              </>
            )}
          </section>
          <nav className="market-categories" aria-label="按分区筛选">
            <button
              type="button"
              aria-pressed={category === null}
              onClick={() => update("cat", "")}
            >
              全部<span>{catalog.counts.plugins}</span>
            </button>
            {catalog.categories.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={category === c.id}
                onClick={() => update("cat", category === c.id ? "" : c.id)}
              >
                <CategoryGlyph id={c.id} size={15} />
                {c.label}
                <span>{c.count}</span>
              </button>
            ))}
          </nav>
          <div className="market-workspace">
            <section className="market-list" aria-label="插件列表">
              {results}
              {onlyCompatible && !canCheck ? (
                <output className="market-notice">
                  版本信息暂不可用，无法筛选兼容插件。请刷新重试或取消兼容筛选。
                </output>
              ) : (
                matches.length === 0 && (
                  <div className="market-empty">
                    <h2>没有符合条件的插件</h2>
                    <button
                      type="button"
                      className="market-secondary"
                      onClick={() =>
                        setParams((p) => {
                          for (const key of ["q", "type", "compatible", "cat"]) p.delete(key);
                        })
                      }
                    >
                      清除筛选
                    </button>
                  </div>
                )
              )}
              <div className="market-grid">
                {(!onlyCompatible || canCheck) &&
                  matches.map((p) => (
                    <PluginCard
                      key={p.id}
                      plugin={p}
                      region={regionLabel.get(p.categoryId) ?? "其他"}
                      state={p.id === focusId ? "focus" : p.id === hoverId ? "hot" : "idle"}
                      incompatible={canCheck && !isCompatible(p)}
                      onOpen={open}
                      onLocate={showMap && atlas.pinById.has(p.id) ? locate : null}
                      onHover={setHoverId}
                    />
                  ))}
              </div>
            </section>
            {showMap && (
              <MarketMap
                atlas={atlas}
                matchIds={matchIds}
                focusId={focusId}
                hoverId={hoverId}
                category={category}
                mode={mode}
                fullscreen={fullscreen || !wide}
                onFocus={focusFromMap}
                onHover={setHoverId}
                onOpen={open}
                onCategory={(id: CategoryId) => update("cat", category === id ? "" : id)}
                onMode={(next) => update("mode", next === "3d" ? "3d" : "")}
                onFullscreen={(on) => (wide ? setFullscreen(on) : setFullscreen(false))}
                onClose={() => (wide ? setMap(false) : setFullscreen(false))}
              />
            )}
          </div>
          {!wide && !fullscreen && (
            <button type="button" className="market-map-fab" onClick={() => setFullscreen(true)}>
              <Icon name="map" size={17} />
              在地图中查看
            </button>
          )}
        </>
      )}
    </main>
  );
}
