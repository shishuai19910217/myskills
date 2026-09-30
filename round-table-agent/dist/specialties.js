// 专项模板：配置化入口，未来加新专项只需在 data/specialties.json 增条目
import { readFileSync } from "node:fs";
import { SPECIALTIES_PATH } from "./runtime-paths.js";
let cache = null;
/** 加载全部专项模板（带缓存） */
export function loadSpecialties() {
    if (cache)
        return cache;
    const raw = readFileSync(SPECIALTIES_PATH, "utf-8");
    cache = JSON.parse(raw);
    return cache;
}
/** 强制重新读盘（编辑 specialties.json 后调用） */
export function reloadSpecialties() {
    cache = null;
    return loadSpecialties();
}
/** 按 id 取专项模板；未找到时返回 undefined（调用方决定是否回退到 general） */
export function getSpecialty(id) {
    return loadSpecialties().find((s) => s.id === id);
}
/** 把 seedDimensions 渲染为可塞进 prompt 的紧凑文本（带分类分组） */
export function renderSeedDimensions(tpl) {
    if (tpl.seedDimensions.length === 0)
        return "";
    // 按 category 分组（无 category 的归到「核心维度」）
    const groups = new Map();
    for (const d of tpl.seedDimensions) {
        const key = d.category ?? "核心维度";
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(d);
    }
    const parts = [];
    for (const [cat, items] of groups) {
        parts.push(`【${cat}】`);
        for (const d of items) {
            const w = d.weight != null ? `（权重${d.weight}）` : "";
            parts.push(`- ${d.name}${w}｜${d.aspect}：${d.signal}`);
        }
    }
    return parts.join("\n");
}
