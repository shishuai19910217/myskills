// 对照实验：单模型基线 vs 多模型圆桌 的边界覆盖度对比（验证 C1）
import { chat } from "./llm.js";
import { loadConfig, enabledProviders } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import type { MeetingInput } from "./types.js";

function countItems(text: string): number {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*•\d.、]/.test(l) && l.length > 4);
  return lines.length;
}

async function singleModelBaseline(topic: string, providerId: string): Promise<{ raw: string; count: number }> {
  const raw = await chat(
    providerId,
    [
      {
        role: "system",
        content: "你是领域分析专家。请穷尽式地列出该问题的所有维度/方面，每条一行，不要遗漏。",
      },
      { role: "user", content: `请穷尽式列举："${topic}" 包含哪些维度或方面？` },
    ],
    { temperature: 0.3, maxTokens: 2048, timeoutMs: 90_000 },
  );
  return { raw, count: countItems(raw) };
}

async function roundTable(topic: string, seats: { role: string; provider: string }[], maxRounds: number) {
  const input: MeetingInput = { id: `exp-${Date.now()}`, source: "text", content: topic };
  const orche = new Orchestrator({ seats, maxRounds, stream: false });
  const list = await orche.runExploration(input);
  return { list, count: list.items.length };
}

async function main() {
  const topic = process.argv[2] ?? "小说AI味表现哪些方面";
  const cfg = loadConfig();
  console.log(`═══ 对照实验：${topic} ═══\n`);

  // 单模型基线（用第一个可用 provider）
  const available = enabledProviders(cfg);
  const providerId = available[0].id;
  console.log(`▶ 单模型基线（${providerId}）...`);
  const baseline = await singleModelBaseline(topic, providerId);
  console.log(`  产出条目数（粗估）：${baseline.count}`);
  console.log(baseline.raw.slice(0, 800));
  console.log("\n──\n");

  // 多模型圆桌（完整 6 席，最多 3 轮）
  console.log("▶ 多模型圆桌（6 席，最多 3 轮）...");
  const { list, count } = await roundTable(topic, cfg.defaultSeats, 3);
  console.log(`  圆桌边界条目数：${count}`);
  const concrete = list.items.filter((b) => b.type === "目标").length;
  const meta = list.items.filter((b) => b.type !== "目标").length;
  for (const b of list.items) console.log(`    - [${b.type}] ${b.description}`);
  console.log("\n──\n");

  console.log("═══ 结论 ═══");
  console.log(`单模型条目数：${baseline.count} ｜ 圆桌条目数：${count}`);
  console.log(`圆桌细分：具体维度(${concrete}) + 元边界/反例/前提/盲区(${meta})`);
  console.log(`——注意：条数不可直接对比（基线为一次性穷举，圆桌受席位×轮数限制）`);
  if (meta > 0) {
    console.log(`✓ 圆桌产出了单模型结构上产不出的边界类型（反例/前提/盲区/约束，共 ${meta} 条）`);
    console.log("→ C1 假设在'非平面维度覆盖'上得到支持：多模型圆桌补的是扁平列举够不到的边界。");
  } else {
    console.log("→ 圆桌未产出元边界，C1 假设未获支持，需排查提示词。");
  }
  const ratio = concrete / Math.max(baseline.count, 1);
  console.log(`具体维度/基线条目 ≈ ${ratio.toFixed(2)}（若 <1，说明具体维度还须靠更多轮次/席位补齐）`);
}

main().catch((e) => {
  console.error("实验失败：", e);
  process.exit(1);
});
