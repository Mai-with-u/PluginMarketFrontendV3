import type { MarketPlugin } from "./data.ts";

export interface PluginGroup {
  id: string;
  label: string;
  /** 匹配作者在清单里声明的名称、标签和类别（能力字段是宿主接口名，不代表主题，不参与）；不读简介，避免凭描述猜用途。 */
  terms: string[];
}

// 常用插件组按使用场景聚合，与「类型」互不干扰；新增一组只需在这里加一项。
export const pluginGroups: PluginGroup[] = [
  {
    id: "image",
    label: "生图",
    terms: [
      "生图",
      "绘图",
      "画图",
      "绘画",
      "文生图",
      "图生图",
      "图片生成",
      "图像生成",
      "image generation",
      "image-gen",
      "text2img",
      "txt2img",
      "stable diffusion",
      "comfyui",
      "midjourney",
      "novelai",
      "draw",
      "paint",
      "sd",
    ],
  },
  {
    id: "voice",
    label: "语音",
    terms: [
      "语音",
      "声音",
      "音色",
      "声线",
      "发声",
      "朗读",
      "配音",
      "语音合成",
      "语音识别",
      "tts",
      "stt",
      "asr",
      "voice",
      "speech",
      "text-to-speech",
      "speech-to-text",
      "audio",
    ],
  },
  {
    id: "memory",
    label: "记忆与人设",
    terms: [
      "记忆",
      "回忆",
      "人设",
      "人格",
      "好感",
      "印象",
      "知识库",
      "memory",
      "memorix",
      "persona",
      "affection",
      "rag",
    ],
  },
  {
    id: "moderation",
    label: "群管",
    terms: [
      "群管",
      "禁言",
      "宵禁",
      "踢人",
      "入群",
      "审核",
      "黑名单",
      "违禁",
      "moderation",
      "mute",
      "ban",
      "kick",
      "blacklist",
    ],
  },
  {
    id: "vision",
    label: "识图与视频",
    terms: ["识图", "看图", "图像识别", "图片识别", "视频", "视觉", "vision", "ocr", "video"],
  },
];

const escape = (s: string) => s.replaceAll(/\W/g, String.raw`\$&`);
// 英文词要求两侧不是字母数字，避免 "sd" 命中 "msdk"；中文词直接子串匹配。
const matcher = (terms: string[]) =>
  new RegExp(
    terms
      .map((t) => (/^[\x20-\x7e]+$/.test(t) ? `(?<![a-z0-9])${escape(t)}(?![a-z0-9])` : escape(t)))
      .join("|"),
    "i",
  );

const matchers = new Map(pluginGroups.map((g) => [g.id, matcher(g.terms)]));

export function inGroup(plugin: MarketPlugin, groupId: string): boolean {
  const re = matchers.get(groupId);
  if (re === undefined) return false;
  const haystack = [
    plugin.name,
    plugin.manifestId ?? "",
    ...plugin.keywords,
    ...plugin.categories,
  ].join("\n");
  return re.test(haystack);
}
