import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

export type UpdateParams = (update: (params: URLSearchParams) => void) => void;

const URL_SYNC_MS = 300;

/**
 * 查询参数以 React 状态为准，URL 只是防抖后的镜像。
 * 连续滚轮每秒会换十几次卡，逐次 replaceState 会被 Chrome 限流并静默丢弃，
 * 若状态从 URL 读回就会卡住，所以这里只在停下 300ms 后写一次。
 */
export function useSearchParams(): [URLSearchParams, UpdateParams] {
  const [search, setSearch] = useState(() => location.search);

  useEffect(() => {
    const onPop = (): void => setSearch(location.search);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (search === location.search) return;
    const id = setTimeout(() => {
      history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
    }, URL_SYNC_MS);
    return () => clearTimeout(id);
  }, [search]);

  const update = useCallback<UpdateParams>((fn) => {
    setSearch((prev) => {
      const next = new URLSearchParams(prev);
      fn(next);
      const qs = next.toString();
      return qs === "" ? "" : `?${qs}`;
    });
  }, []);

  const params = useMemo(() => new URLSearchParams(search), [search]);
  return [params, update];
}

const motionQuery = "(prefers-reduced-motion: reduce)";

function subscribeMotion(cb: () => void): () => void {
  const mq = matchMedia(motionQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => matchMedia(motionQuery).matches,
    () => false,
  );
}

export function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export type CopyState = "idle" | "copied" | "failed";

export function useCopy(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    clearTimeout(timer.current);
    navigator.clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );
    timer.current = setTimeout(() => setState("idle"), 2000);
  }, []);
  return [state, copy];
}

/** 数字从 0 爬到目标值；减弱动态时直接给终值。 */
export function useCountUp(target: number, durationMs = 1400, delayMs = 0): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    const start = performance.now() + delayMs;
    const tick = (now: number): void => {
      const t = Math.min(1, Math.max(0, (now - start) / durationMs));
      setValue(Math.round(target * (1 - (1 - t) ** 4)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, delayMs, reduced]);
  return reduced ? target : value;
}
