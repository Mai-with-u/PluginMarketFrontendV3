import { useEffect, useState } from "react";

import type { PublicManifest } from "../market/data.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * 调用方的取消信号和 15 秒超时合成一个信号。不用 AbortSignal.any / timeout：
 * 它们分别要 Chrome 116、103 以上，一些手机浏览器的内核更旧，请求会在发出前就报错。
 */
async function fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);
  const forward = (): void => controller.abort();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener("abort", forward, { once: true });
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ApiError(0, "请求超时，请稍后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", forward);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithTimeout(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(response.status, "开发者服务尚未启用或暂不可用，请稍后重试。");
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail =
      typeof data === "object" && data !== null && "detail" in data ? data.detail : undefined;
    throw new ApiError(
      response.status,
      typeof detail === "string" ? detail : "请求未完成，请刷新后重试。",
    );
  }
  // The API contract is shared with our backend; caller types describe its JSON response.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return data as T;
}

export interface Resource<T> {
  path: string;
  revision: number;
  data?: T;
  error?: Error;
}

export function useResource<T>(path: string | null, revision = 0): Resource<T> | undefined {
  const [state, setState] = useState<Resource<T>>();
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    void api<T>(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ path, revision, data });
        return undefined;
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            path,
            revision,
            error: error instanceof Error ? error : new Error("请求失败"),
          });
      },
    );
    return () => controller.abort();
  }, [path, revision]);
  // Keep mounted editors during background refresh so an in-progress reply is not lost.
  return state?.path === path ? state : undefined;
}

export function mutate(
  path: string,
  csrf: string,
  method: "POST" | "PUT" | "DELETE",
  body: unknown = {},
) {
  return api<{ ok?: boolean; status?: string }>(path, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  });
}

export interface Session {
  id: number;
  login: string;
  csrf: string;
}
export interface Plugin {
  manifest?: PublicManifest;
  id: string;
  market_id: string;
  name: string;
  repository: string;
  likes: number;
  dislikes: number;
  comments: number;
  downloads: number;
  downloads_7d: number;
  downloads_30d: number;
  claim: "active" | "pending" | "revoked" | "rejected" | null;
}
export interface Review {
  id: string;
  revision: string;
  comment: string;
  rating: number | null;
  username: string | null;
  created_at: string;
  updated_at: string;
  reply: { body: string; login: string; updated: number } | null;
  fold_request?: {
    id: number;
    status: "pending" | "approved" | "rejected";
    created: number;
  } | null;
}
export interface Feedback {
  plugin_id: string;
  likes: number;
  dislikes: number;
  snapshot_at: number;
  items: Review[];
  total: number;
  next_offset: number | null;
}
export interface Notice {
  id: number;
  plugin_id: string;
  kind: string;
  message: string;
  review_id: string | null;
  created: number;
  read_at: number | null;
}
export interface Inbox {
  items: Notice[];
  unread: number;
  next_before: number | null;
}
