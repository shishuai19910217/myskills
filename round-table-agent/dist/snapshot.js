// M7 会议快照持久化 + 报告落盘（DESIGN.md §7.4 / §9）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const MEETINGS_DIR = join(PROJECT_ROOT, "data", "meetings");
function ensureDir() {
    mkdirSync(MEETINGS_DIR, { recursive: true });
}
export function persistSnapshot(meetingId, snapshot) {
    ensureDir();
    const file = join(MEETINGS_DIR, `${meetingId}-snapshot.json`);
    writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf-8");
    return file;
}
export function persistReport(meetingId, list, solution) {
    ensureDir();
    const file = join(MEETINGS_DIR, `${meetingId}-report.md`);
    const itemsText = list.items
        .map((b) => `- ${b.id} [${b.type}] ${b.description}（${b.proposer}，可信度:${b.confidence}` +
        `${b.status.kind === "有分歧" ? ` ｜ 裁决:${b.status.verdict ?? ""}${b.status.rejectedReason ? "（" + b.status.rejectedReason + "）" : ""}` : ""}）`)
        .join("\n");
    const md = `# 圆桌勘探报告 ${meetingId}

## 议题
${list.topic}

## 产出目标
${list.objective}

## 勘探范围
${list.scope}

## 边界约束清单（${list.items.length} 条）
${itemsText}

## 会议信息
- 轮数：${list.rounds}
- 收敛方式：${list.convergence === "auto" ? "自动收敛" : "用户停止"}
- 分歧裁决：${list.disputesResolved} 处
- token 估算：${list.tokenEstimate}

## 最终解决方案
${solution}
`;
    writeFileSync(file, md, "utf-8");
    return file;
}
