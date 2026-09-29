// M7 会议快照持久化 + 报告落盘（DESIGN.md §7.4 / §9）
// 统一以 thunk 形式取快照：调用方在异步流程中传 () => orchestrator.snapshot(id)，
// 本模块只在真正写盘时求值，避免拿到过期引用。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIDENCE_LABEL,
  type BoundaryItem,
  type GoalType,
  type MeetingSnapshot,
} from "./types.js";
import { MEETINGS_DIR } from "./runtime-paths.js";

export const meetingsDir = MEETINGS_DIR;
export type SnapshotThunk = () => MeetingSnapshot | null | undefined;

function ensureDir() {
  mkdirSync(MEETINGS_DIR, { recursive: true });
}

function resolve(getSnapshot: SnapshotThunk): MeetingSnapshot {
  const snap = getSnapshot();
  if (!snap) throw new Error("快照为空，无法持久化");
  return snap;
}

export function persistSnapshot(meetingId: string, getSnapshot: SnapshotThunk): string {
  ensureDir();
  const snapshot = resolve(getSnapshot);
  const file = join(MEETINGS_DIR, `${meetingId}-snapshot.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf-8");
  return file;
}

const CONVERGENCE_LABEL: Record<MeetingSnapshot["list"]["convergence"], string> = {
  auto: "自动收敛",
  user_stop: "用户停止",
  max_rounds: "达到最大轮次",
};

const GOAL_TYPE_LABEL: Record<GoalType, string> = {
  enumerate: "枚举完整清单",
  judge: "判断是否成立/可行",
  design: "设计可执行方案",
  diagnose: "诊断问题成因",
  other: "其他",
};

/** 转义 GFM 表格单元格内容：竖线转义、换行折叠为 <br> */
function cell(s: string | number | undefined): string {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function statusCell(b: BoundaryItem): string {
  switch (b.status.kind) {
    case "merged":
      return `合并→${b.status.mergedInto}${b.status.reason ? `（${b.status.reason}）` : ""}`;
    case "rejected":
      return `否决（${b.status.reason}）`;
    default:
      return "保留";
  }
}

/** 边界清单的 GFM 表格（保留/合并/否决全部入表） */
function renderListTable(items: BoundaryItem[]): string {
  if (items.length === 0) return "（无）";
  const header = [
    "| 编号 | 类别 | 边界描述 | 可信度 | 来源 | 轮次 | 裁决状态 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = items.map(
    (b) =>
      `| ${cell(b.id)} | ${cell(b.type)} | ${cell(b.description)} | ${CONFIDENCE_LABEL[b.confidence]} | ${cell(b.sourceModel)} | R${b.round} | ${cell(statusCell(b))} |`,
  );
  return [...header, ...rows].join("\n");
}

export function renderReport(snap: MeetingSnapshot): string {
  const list = snap.list;
  const kept = list.items.filter((b) => b.status.kind === "kept");

  const sections: string[] = [];
  sections.push(`# 圆桌勘探报告：${snap.topic ?? snap.question}`);
  sections.push("");
  sections.push(`> 会议 ID：${snap.meetingId}　｜　生成时间：${snap.updatedAt}`);
  sections.push("");
  sections.push("## 一、议题与目标");
  sections.push("");
  sections.push(`- **议题**：${snap.topic ?? snap.question}`);
  sections.push(`- **产出目标**：${snap.objective ?? "（未识别）"}`);
  if (snap.goalType) sections.push(`- **目标类型**：${GOAL_TYPE_LABEL[snap.goalType]}`);
  sections.push(`- **勘探范围**：${snap.scope ?? "（未界定）"}`);
  sections.push("");
  sections.push(
    `## 二、边界约束清单（共 ${list.items.length} 条，保留 ${kept.length} 条）`,
  );
  sections.push("");
  sections.push(renderListTable(list.items));
  sections.push("");
  sections.push(`## 三、会议信息`);
  sections.push("");
  sections.push(`| 项 | 值 |
| --- | --- |
| 轮数 | ${list.rounds} |
| 收敛方式 | ${CONVERGENCE_LABEL[list.convergence]} |
| 裁决处理（合并/否决） | ${list.disputesResolved} 处 |
| token 估算 | ${list.tokenEstimate} |
| 创建时间 | ${snap.createdAt} |
| 更新时间 | ${snap.updatedAt} |`);
  sections.push("");
  sections.push("## 四、最终解决方案");
  sections.push("");
  sections.push(snap.finalSolution ?? "（尚未生成，可在收敛后请求终局）");
  sections.push("");
  return sections.join("\n");
}

export function persistReport(meetingId: string, getSnapshot: SnapshotThunk): string {
  ensureDir();
  const snapshot = resolve(getSnapshot);
  const file = join(MEETINGS_DIR, `${meetingId}-report.md`);
  writeFileSync(file, renderReport(snapshot), "utf-8");
  return file;
}
