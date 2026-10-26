import { hashString, monogram } from "../data/catalog.ts";
import type { Plugin } from "../data/types.ts";
import { useCopy } from "../hooks.ts";
import { Icon } from "./Icon.tsx";

const PATTERNS = ["hatch", "hatch-r", "grid", "rule"] as const;

/** 有图标用 webp；没有就用名称首字 + 作者哈希出的底纹，不用灰块道歉。 */
export function Monogram({ plugin, size }: { plugin: Plugin; size: "sm" | "md" | "xl" }) {
  if (plugin.icon !== null) {
    return (
      <span className={`mono-tile mono-tile--${size} mono-tile--image`}>
        <img
          src={`${import.meta.env.BASE_URL}icons/${plugin.icon}`}
          alt=""
          loading="lazy"
          decoding="async"
        />
      </span>
    );
  }
  const h = hashString(plugin.authorLogin);
  const pattern = PATTERNS[h % PATTERNS.length] ?? "hatch";
  return (
    <span className={`mono-tile mono-tile--${size} mono-tile--${pattern}`} aria-hidden="true">
      <span className="mono-tile__char">{monogram(plugin)}</span>
      <span className="mono-tile__code">{(h % 4096).toString(16).padStart(3, "0")}</span>
    </span>
  );
}

/** 由 ID 哈希出的条码，纯装饰。 */
export function Barcode({ value, bars = 38 }: { value: string; bars?: number }) {
  let h = hashString(value);
  const rects: { x: number; w: number }[] = [];
  let x = 0;
  for (let i = 0; i < bars; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const w = 1 + (h % 3);
    if (i % 2 === 0) rects.push({ x, w });
    x += w + 1;
  }
  return (
    <svg className="barcode" viewBox={`0 0 ${x} 20`} preserveAspectRatio="none" aria-hidden="true">
      {rects.map((r) => (
        <rect key={r.x} x={r.x} y="0" width={r.w} height="20" />
      ))}
    </svg>
  );
}

export function CopyRepoButton({
  url,
  variant = "signal",
  compact = false,
}: {
  url: string | null;
  variant?: "signal" | "ghost";
  compact?: boolean;
}) {
  const [state, copy] = useCopy();
  if (url === null) {
    return (
      <button type="button" className={`btn btn--${variant}`} disabled>
        无仓库地址
      </button>
    );
  }
  const label =
    state === "copied" ? "已复制" : state === "failed" ? "复制失败，请手动复制" : "复制仓库地址";
  return (
    <button
      type="button"
      className={`btn btn--${variant}${compact ? " btn--compact" : ""}`}
      data-state={state}
      data-pulse=""
      data-copy-repo=""
      onClick={() => copy(url)}
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={16} />
      <span aria-live="polite">{label}</span>
    </button>
  );
}
