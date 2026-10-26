import { pad } from "../data/catalog.ts";
import type { Catalog } from "../data/types.ts";
import type { PipelineState } from "../gpu/device.ts";
import { LogoMark } from "./Icon.tsx";

/** 自检逐行出现到幕布开始收起的时长，AtlasView 据此安排镜头俯冲 */
export const BOOT_REVEAL_MS = 1500;
/** 幕布完全收起、可以卸载的时刻 */
export const BOOT_DONE_MS = 2200;

const PIPELINE_LABEL: Record<PipelineState, string> = {
  pending: "PENDING",
  online: "WEBGPU",
  unavailable: "CSS FALLBACK",
};

/** 进场测绘自检。纯 CSS 动画，由 AtlasView 按时卸载；减弱动态时不渲染。 */
export function BootSequence({ catalog, pipeline }: { catalog: Catalog; pipeline: PipelineState }) {
  const { counts } = catalog;
  const lines: [string, string, string][] = [
    ["读取社区索引", "INDEX", `${counts.plugins}`],
    ["校验插件清单", "MANIFEST", `${counts.details} / ${counts.plugins}`],
    ["测绘九座山体", "RANGES", pad(catalog.categories.length, 2)],
    ["启动渲染管线", "PIPELINE", PIPELINE_LABEL[pipeline]],
    ["地形就绪", "SURVEY", "READY"],
  ];

  return (
    <div className="bootseq" aria-hidden="true">
      <div className="bootseq__inner">
        <div className="bootseq__brand">
          <LogoMark size={40} />
          <div>
            <p className="bootseq__title">麦麦插件</p>
            <p className="bootseq__sub">Plugin Topography — surveying</p>
          </div>
        </div>
        <ol className="bootseq__log">
          {lines.map(([zh, code, value], i) => (
            <li key={code} style={{ "--n": i }}>
              <span className="bootseq__zh">{zh}</span>
              <span className="bootseq__code">{code}</span>
              <i />
              <b>{value}</b>
            </li>
          ))}
        </ol>
        <span className="bootseq__bar" />
      </div>
      <span className="bootseq__contours" />
    </div>
  );
}
