import { createInterface } from "node:readline";
import { Orchestrator } from "./orchestrator.js";
import { loadSeats } from "./config.js";
import { persistSnapshot, persistReport } from "./snapshot.js";
function printList(list) {
    console.log("\n════════ 边界约束清单 ════════");
    console.log(`议题：${list.topic}`);
    console.log(`产出目标：${list.objective}`);
    console.log(`勘探范围：${list.scope}`);
    console.log(`轮数：${list.rounds} ｜ 收敛：${list.convergence} ｜ 分歧裁决：${list.disputesResolved} 处 ｜ token 估算：${list.tokenEstimate}`);
    console.log("────────────────────────────");
    for (const b of list.items) {
        const mark = b.status.kind === "有分歧" ? `【${b.status.verdict ?? "有分歧"}】` : "";
        console.log(`- ${b.id} [${b.type}]${mark} ${b.description}（${b.proposer}，可信度:${b.confidence}）`);
    }
    console.log("════════════════════════════");
}
async function main() {
    const args = process.argv.slice(2);
    const roundsIdx = args.indexOf("--rounds");
    let rounds;
    if (roundsIdx >= 0 && args[roundsIdx + 1]) {
        rounds = Number(args[roundsIdx + 1]);
        args.splice(roundsIdx, 2);
    }
    let inputText = args.join(" ").trim();
    if (!inputText) {
        console.log("请输入要勘探的问题（或从 stdin 传入文本）：");
        const rl = createInterface({ input: process.stdin });
        inputText = (await new Promise((resolve) => {
            let all = "";
            rl.on("line", (l) => {
                if (l.trim() === "")
                    resolve(all.trim());
                else
                    all += l + "\n";
            });
        })).trim();
        rl.close();
        if (!inputText) {
            console.error("未提供输入，退出。");
            process.exit(1);
        }
    }
    const input = { id: `meeting-${Date.now()}`, source: "text", content: inputText };
    const seats = loadSeats();
    const orche = new Orchestrator({
        seats,
        maxRounds: rounds,
        emit: (e) => {
            switch (e.type) {
                case "opening":
                    console.log(`\n【开题】议题：${e.topic}`);
                    console.log(`产出目标：${e.objective}`);
                    console.log(`勘探范围：${e.scope}`);
                    break;
                case "question":
                    console.log(`\n── 第 ${e.round} 轮 ｜ ${e.seat} 盘问：${e.question}`);
                    break;
                case "reply":
                    console.log(`  ▸ ${e.seat}：${e.content.slice(0, 400)}${e.content.length > 400 ? "…" : ""}`);
                    break;
                case "boundary":
                    console.log(`  ✓ 新增边界 [${e.item.type}] ${e.item.description}`);
                    break;
                case "round":
                    console.log(`〔第 ${e.round} 轮结束，新增 ${e.newCount} 条〕`);
                    break;
                case "converged":
                    console.log(`\n⏸ 收敛：${e.reason}（${e.rounds} 轮）`);
                    break;
                case "error":
                    console.error(`  ⚠ ${e.seat ?? ""}:${e.message}`);
                    break;
            }
        },
    });
    let list = await orche.runExploration(input);
    // R5 交互循环
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const readLine = () => new Promise((resolve) => {
        rl.question("> ", resolve);
    });
    let eof = false;
    rl.on("close", () => {
        eof = true;
    });
    for (;;) {
        printList(list);
        console.log("\n[R5 审阅] 选项：");
        console.log("  stop / 停止  → 出最终方案");
        console.log("  补充: <内容> → 提交补充，继续圆桌（同议题）");
        console.log("  清单         → 重新打印清单");
        let answer;
        try {
            answer = (await readLine()).trim();
        }
        catch {
            eof = true;
            break; // stdin 已关闭（管道输入耗尽），视为停止
        }
        if (eof)
            break;
        if (answer === "stop" || answer === "停止" || answer === "s" || answer === "") {
            break;
        }
        if (answer === "清单" || answer === "list") {
            continue;
        }
        if (answer.startsWith("补充:") || answer.startsWith("补充：")) {
            const sup = answer.replace(/^补充[:：]\s*/, "").trim();
            if (sup) {
                list = await orche.continueWithSupplement(list, sup);
                continue;
            }
        }
        console.log("（未识别的指令，忽略）");
    }
    rl.close();
    console.log("\n════════ 最终解决方案 ════════");
    const solution = await orche.finalSolution(list);
    console.log(solution);
    const snap = orche.snapshot();
    snap.state = "done";
    snap.createdAt = new Date().toISOString();
    snap.updatedAt = new Date().toISOString();
    const snapFile = persistSnapshot(list.meetingId, snap);
    const reportFile = persistReport(list.meetingId, list, solution);
    console.log(`\n快照已写入：${snapFile}`);
    console.log(`报告已写入：${reportFile}`);
}
main().catch((e) => {
    console.error("运行失败：", e);
    process.exit(1);
});
