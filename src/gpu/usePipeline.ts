import { useSyncExternalStore } from "react";

import { getPipelineSnapshot, subscribePipeline } from "./device.ts";
import type { PipelineSnapshot } from "./device.ts";

export function usePipeline(): PipelineSnapshot {
  return useSyncExternalStore(subscribePipeline, getPipelineSnapshot, getPipelineSnapshot);
}
