import { useEffect, useState } from "react";

import { api } from "../developer/api.ts";
import type { PublicCatalog } from "./data.ts";

interface HostReleases {
  latest: string;
  items: { version: string; tag: string }[];
}

interface Snapshot {
  revision: number;
  catalog?: PublicCatalog;
  releases?: HostReleases;
  catalogError?: Error;
  releasesError?: Error;
}

function requestError(result: PromiseSettledResult<unknown>): Error | undefined {
  if (result.status === "fulfilled") return undefined;
  return result.reason instanceof Error ? result.reason : new Error("请求失败");
}

export function useMarketSnapshot(revision: number) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  useEffect(() => {
    const controller = new AbortController();
    // Catalog statistics and the host version both affect the list. Publish them
    // together so network response order cannot change an already visible list.
    void Promise.allSettled([
      api<PublicCatalog>("/api/market/catalog", { signal: controller.signal }),
      api<HostReleases>("/api/market/host-releases", { signal: controller.signal }),
    ]).then(([catalog, releases]) => {
      if (controller.signal.aborted) return;
      setSnapshot((previous) => ({
        revision,
        catalog: catalog.status === "fulfilled" ? catalog.value : previous?.catalog,
        releases: releases.status === "fulfilled" ? releases.value : previous?.releases,
        catalogError: requestError(catalog),
        releasesError: requestError(releases),
      }));
    });
    return () => controller.abort();
  }, [revision]);
  return { snapshot, refreshing: snapshot?.revision !== revision };
}
