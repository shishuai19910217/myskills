// M8 回灌机制：边界清单 → webnovel-deai-lint 模式库增补草案（DESIGN.md §12）
// 注意：只生成"草案"文件，不直接改写 SKILL.md —— 需用户确认后人工合入。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundaryItem, BoundaryList } from "./types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const MEETINGS_DIR = join(PROJECT_ROOT, "data", "meetings");

// 边界类型 → 目标维度粗分类（关键词启发式，草案阶段可接受）
const DIM_KEYWORDS: { dim: string; keywords: string[] }[] = [
  { dim: "D1 对话个性", keywords: ["对话", "口癖", "台词", "角色说话", "语言特征"] },
  { dim: "D2 用词独特性", keywords: ["用词", "词汇", "高频词", "成语", "书面", "句法", "句式"] },
  { dim: "D3 景物/场面描写", keywords: ["景物", "场面", "场景", "描写", "感官", "氛围"] },
  { dim: "D4 情感真实性", keywords: ["情感", "情绪", "心理", "抒情"] },
  { dim: "D5 动作多样性", keywords: ["动作", "行为", "身体", "微表情"] },
  { dim: "D6 叙事节奏", keywords: ["节奏", "转场", "结构", "篇幅", "开头", "结尾", "悬念"] },
  { dim: "D7 情节驱动方式", keywords: ["情节", "伏笔", "冲突", "巧合", "因果", "转折", "叙事"] },
];

function classifyDim(description: string): string {
  for (const d of DIM_KEYWORDS) {
    if (d.keywords.some((k) => description.includes(k))) return d.dim;
  }
  return "D2 用词独特性";
}

function toM1Row(item: BoundaryItem, idx: number): string {
  const dim = classifyDim(item.description);
  const name = item.description.slice(0, 18) + "…";
  const rule = item.description.slice(0, 60) + "…";
  const guidance = item.counterExamples.length
    ? `提示：判定时注意反例——${item.counterExamples.join("；").slice(0, 60)}`
    : "方向：参照圆桌产出，细化识别信号与方向指引写法。";
  return `| 模式编号（待定） | ${name} | ${rule} | ${guidance} |（来源边界 ${item.id}｜建议归入 ${dim}）`;
}

export function generateDraft(items: BoundaryItem[], topic: string): string {
  const concrete = items.filter((i) => i.type === "目标");
  const constraints = items.filter((i) => i.type === "约束");
  const counterExamples = items.filter((i) => i.type === "反例");
  const premises = items.filter((i) => i.type === "前提");
  const blindspots = items.filter((i) => i.type === "盲区");

  const lines: string[] = [];
  lines.push(`# 模式库增补草案（由圆桌会议回灌生成）`);
  lines.push(``);
  lines.push(`> 议题：${topic}`);
  lines.push(`> 状态：**草案，待人工确认后合入 webnovel-deai-lint/SKILL.md**`);
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## A. 建议新增 M1 模式（来自"目标"边界，共 ${concrete.length} 条）`);
  lines.push(``);
  lines.push(`| 模式编号 | 模式名 | 识别规则 & 典型命中 | 方向指引写法 |`);
  lines.push(`|---|---|---|---|`);
  concrete.forEach((b, i) => lines.push(toM1Row(b, i)));
  lines.push(``);
  lines.push(`## B. 建议新增 M3 禁区/判定红线（来自"约束"边界，共 ${constraints.length} 条）`);
  lines.push(``);
  constraints.forEach((b) =>
    lines.push(`- **M3-禁区（待编号）**：${b.description}（来源 ${b.id}）`),
  );
  lines.push(``);
  lines.push(`## C. 误判防护提示（来自"反例"边界，共 ${counterExamples.length} 条）`);
  lines.push(``);
  counterExamples.forEach((b) =>
    lines.push(`- **判定注意**：${b.description}（来源 ${b.id}）`),
  );
  lines.push(``);
  lines.push(`## D. 判定前提说明（来自"前提"边界，共 ${premises.length} 条）`);
  lines.push(``);
  premises.forEach((b) => lines.push(`- **前提**：${b.description}（来源 ${b.id}）`));
  lines.push(``);
  lines.push(`## E. 新维度候选（来自"盲区"边界，共 ${blindspots.length} 条）`);
  lines.push(``);
  blindspots.forEach((b) => lines.push(`- **盲区候选**：${b.description}（来源 ${b.id}）`));
  lines.push(``);
  return lines.join("\n");
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("用法：node dist/backfeed.js <快照json路径 或 meetingId>");
    process.exit(1);
  }
  let snapshot: { boundaryPool?: BoundaryItem[]; topic?: string } | null = null;
  const candidate =
    arg.includes(".json") || arg.includes("\\") || arg.includes("/") ? arg : join(MEETINGS_DIR, `${arg}-snapshot.json`);
  try {
    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as unknown;
    snapshot = parsed as { boundaryPool?: BoundaryItem[]; topic?: string };
  } catch (e) {
    console.error(`无法读取快照：${candidate}（${e instanceof Error ? e.message : String(e)}）`);
    process.exit(1);
  }
  const items = snapshot?.boundaryPool ?? [];
  const draft = generateDraft(items, snapshot?.topic ?? "");
  mkdirSync(MEETINGS_DIR, { recursive: true });
  const base = candidate.replace(/-snapshot\.json$/, "");
  const out = `${base}-patterns-draft.md`;
  writeFileSync(out, draft, "utf-8");
  console.log(`模式库增补草案已写入：${out}`);
  console.log(draft);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// 供模块化复用（server/CLI 可引用）
export type { BoundaryItem, BoundaryList };
