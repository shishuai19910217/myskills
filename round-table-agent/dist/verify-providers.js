// M0 前置验证：provider 连通性 + 同源探测 + 模型差异对比
import { loadConfig, enabledProviders } from "./config.js";
import { chat } from "./llm.js";
const PROBE_QUESTION = "请用一句话回答：网络小说里的'AI 味'通常指什么？";
async function probe(id, baseURL, model) {
    try {
        const text = await chat(id, [
            { role: "system", content: "你是评审助手，请简短回答。" },
            { role: "user", content: PROBE_QUESTION },
        ], { temperature: 0.2, maxTokens: 400, timeoutMs: 40_000 });
        return text.trim().slice(0, 200) || "（空响应）";
    }
    catch (e) {
        return `❌ ${e instanceof Error ? e.message : String(e)}`;
    }
}
async function main() {
    const cfg = loadConfig();
    const targets = enabledProviders(cfg);
    console.log("═══ M0 provider 探测 ═══\n");
    const results = {};
    for (const p of targets) {
        console.log(`▶ 探测 ${p.id}（${p.baseURL} / ${p.model}）...`);
        const r = await probe(p.id, p.baseURL, p.model);
        results[p.id] = r;
        console.log(`  ${r}\n`);
    }
    console.log("═══ 同源判定 ═══");
    const ok = Object.entries(results).filter(([, r]) => !r.startsWith("❌"));
    if (ok.length === 0) {
        console.log("所有 provider 均不可用。请检查本地代理与 auth.json。");
        process.exit(1);
    }
    if (ok.length < 2) {
        console.log(`可用 provider 不足 2 个（${ok.map(([k]) => k).join(", ")}），无法做多模型对比。`);
    }
    else {
        // 归一化比较（按前 60 字是否相近判断是否疑似同源）
        const normalized = ok.map(([k, r]) => [k, r.slice(0, 60)]);
        for (let i = 0; i < normalized.length; i++) {
            for (let j = i + 1; j < normalized.length; j++) {
                const [a, ra] = normalized[i];
                const [b, rb] = normalized[j];
                if (ra === rb)
                    console.log(`⚠ ${a} 与 ${b} 输出完全相同 → 疑似同源`);
                else
                    console.log(`✓ ${a} 与 ${b} 输出不同 → 基本判定非同源`);
            }
        }
    }
    console.log("\n提示：同源验证的严格结论还需用更长的差异化问题在正式对照实验中复核。");
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
