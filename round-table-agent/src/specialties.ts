// 专项模板：配置化入口，未来加新专项只需在 data/specialties.json 增条目
import { readFileSync } from "node:fs";
import { SPECIALTIES_PATH } from "./runtime-paths.js";

/** 种子维度：注入 R0 开题，作为「已知值得勘探的方向」种子 */
export interface SeedDimension {
  /** 维度名（如 "D1 语言" 或 "读者体感与情绪报偿"） */
  name: string;
  /** 主要方面 / 检查重点 */
  aspect: string;
  /** AI 正信号 / 苏格拉底问题要点 / 检查项要点 */
  signal: string;
  /** 评分卡权重（追读评分卡用；AI 味不用） */
  weight?: number;
  /** 分类标签（如 "评分卡" / "检查表-A 读者体感"） */
  category?: string;
}

export interface SpecialtyTemplate {
  /** "general" | "ai-flavor" | "reading-health" */
  id: string;
  /** 显示名 */
  name: string;
  /** 一句话说明 */
  description: string;
  /** 图标 emoji */
  icon: string;
  /** textarea placeholder */
  placeholder: string;
  /** 种子维度（注入 R0 开题；每条 100-250 字精准描述，整体渲染控制在约 2500-3500 字） */
  seedDimensions: SeedDimension[];
  /** 终局 Markdown 模板（占位符见下方约定） */
  finalTemplate: string;
  /** R0 开题追加段落（拼接到 coordinatorOpeningUser 之后） */
  openingHint?: string;
  /** 席位 prompt 追加段落（含章节定位 + 修改建议格式要求） */
  seatHint?: string;
  /** 润色文本退出提示（AI 味专项：检测到润色信号后提示退出） */
  exitSignal?: string;
}

let cache: SpecialtyTemplate[] | null = null;

/** 加载全部专项模板（带缓存） */
export function loadSpecialties(): SpecialtyTemplate[] {
  if (cache) return cache;
  const raw = readFileSync(SPECIALTIES_PATH, "utf-8");
  cache = JSON.parse(raw) as SpecialtyTemplate[];
  return cache;
}

/** 强制重新读盘（编辑 specialties.json 后调用） */
export function reloadSpecialties(): SpecialtyTemplate[] {
  cache = null;
  return loadSpecialties();
}

/** 按 id 取专项模板；未找到时返回 undefined（调用方决定是否回退到 general） */
export function getSpecialty(id: string): SpecialtyTemplate | undefined {
  return loadSpecialties().find((s) => s.id === id);
}

/** 把 seedDimensions 渲染为可塞进 prompt 的紧凑文本（带分类分组） */
export function renderSeedDimensions(tpl: SpecialtyTemplate): string {
  if (tpl.seedDimensions.length === 0) return "";
  // 按 category 分组（无 category 的归到「核心维度」）
  const groups = new Map<string, SeedDimension[]>();
  for (const d of tpl.seedDimensions) {
    const key = d.category ?? "核心维度";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }
  const parts: string[] = [];
  for (const [cat, items] of groups) {
    parts.push(`【${cat}】`);
    for (const d of items) {
      const w = d.weight != null ? `（权重${d.weight}）` : "";
      parts.push(`- ${d.name}${w}｜${d.aspect}：${d.signal}`);
    }
  }
  return parts.join("\n");
}
