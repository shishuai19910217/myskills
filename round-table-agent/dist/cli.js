import readline from "readline";
import { Orchestrator } from "./orchestrator.js";
import { loadConfig } from "./config.js";
import { persistReport } from "./snapshot.js";
const convergenceLabel = {
    auto: "自动收敛",
    user_stop: "用户停止",
    max_rounds: "达到最大轮次",
};
async function main() {
    loadConfig();
    const question = process.argv.slice(2).join(" ") || "如何为 SaaS 产品制定年度增长策略？";
    const orchestrator = new Orchestrator({ stream: false });
    const meetingId = `meeting-${Date.now()}`;
    const pendingTurns = [];
    // R5 交互（勘探进行中也可输入）
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => {
        const v = line.trim();
        if (!v)
            return;
        if (v === "stop" || v === "停止" || v === "停止勘探") {
            // 立即中断当前进行中的模型调用
            orchestrator.requestStop();
            return;
        }
        if (v.startsWith("补充:")) {
            pendingTurns.push({ kind: "supplement", supplement: v.slice(3).trim() });
            return;
        }
        if (v.startsWith("边界:")) {
            pendingTurns.push({ kind: "new_boundary", item: { type: "盲区", description: v.slice(3).trim(), confidence: "high" } });
            return;
        }
        // 默认按补充并入
        pendingTurns.push({ kind: "supplement", supplement: v });
    });
    const handleEvent = (e) => {
        switch (e.type) {
            case "opening":
                console.log(`\n【开题】${e.topic}\n目标：${e.objective}（类型：${e.goalType}）\n范围：${e.scope}\n`);
                break;
            case "question":
                console.log(`R${e.round} 统筹者 → ${e.seat}: ${e.question}`);
                break;
            case "reply":
                console.log(`R${e.round} ${e.seat}: ${e.content.slice(0, 200)}`);
                break;
            case "boundary":
                console.log(`  + 新边界 [${e.item.type}] ${e.item.description}`);
                break;
            case "round":
                console.log(`── 第 ${e.round} 轮结束，新增 ${e.newCount} 条，累计约 ${e.tokenEstimate} token 当量\n`);
                break;
            case "converged":
                console.log(`\n勘探结束（${convergenceLabel[e.reason] ?? e.reason}），轮次：${e.rounds}\n`);
                break;
            case "notice":
                console.log(`${e.level === "warn" ? "[告警]" : "[提示]"}${e.seat ? ` ${e.seat}` : ""}: ${e.message}`);
                break;
            case "error":
                console.log(`[错误]${e.seat ? ` ${e.seat}` : ""}: ${e.message}`);
                break;
        }
    };
    let list = await orchestrator.runExploration({
        meetingId,
        question,
        emit: handleEvent,
        beforeRound: () => {
            const turns = pendingTurns.splice(0, pendingTurns.length);
            return turns;
        },
    });
    // R5：收敛后交互
    while (true) {
        const answer = await new Promise((resolve) => rl.question("\n输入“补充:xxx”继续勘探，或回车直接出最终方案（输入 清单 可查看当前清单）：", resolve));
        const v = answer.trim();
        if (v === "" || v === "stop" || v === "停止")
            break;
        if (v === "清单") {
            list = orchestrator.snapshot(meetingId).list;
            console.log(list.items
                .map((b) => {
                const tag = b.status.kind === "kept" ? "" : `（${b.status.kind}）`;
                return `${b.id} [${b.type}]${tag} ${b.description}`;
            })
                .join("\n"));
            continue;
        }
        const supplement = v.startsWith("补充:") ? v.slice(3).trim() : v;
        console.log("收到补充，继续勘探 2 轮…");
        const next = await orchestrator.continueWithSupplement(meetingId, supplement, handleEvent, () => pendingTurns.splice(0, pendingTurns.length));
        if (next)
            list = next;
    }
    rl.close();
    console.log("\n统筹者生成最终方案…");
    const solution = await orchestrator.finalSolution(meetingId);
    console.log("\n========== 最终方案 ==========\n");
    console.log(solution);
    // 统一走 snapshot.ts 落盘（与 Web 端一致）
    await persistReport(meetingId, () => orchestrator.snapshot(meetingId));
    console.log(`\n报告已保存到 data/meetings/ 目录（meetingId=${meetingId}）`);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
