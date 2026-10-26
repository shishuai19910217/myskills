import { getRuntime, getSeatConfigs } from "./config.js";
import { chat, chatStream } from "./llm.js";
import { coordinatorSystemPrompt, coordinatorOpeningUser, coordinatorQuestionUser, coordinatorBatchQuestionUser, coordinatorConvergeUser, coordinatorAdjudicateUser, coordinatorSupplementUser, coordinatorFinalTemplateUser, SEGMENT_SECTIONS_MARKER, coordinatorClassifyUserTurnUser, seatSystemPrompt, } from "./prompts.js";
import { persistSnapshot, persistReport, meetingsDir } from "./snapshot.js";
import { getSpecialty, renderSeedDimensions } from "./specialties.js";
import { readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
/**
 * 通用并发控制器：worker 池模型。
 * concurrency=1 串行；concurrency>=items.length 全并行。
 * signal.aborted 时未启动的 worker 退出，已完成的结果保留。
 */
async function parallelMap(items, fn, concurrency, signal) {
    if (concurrency <= 1) {
        const results = [];
        for (let i = 0; i < items.length; i++) {
            if (signal?.aborted) {
                results.push(undefined);
                continue;
            }
            results.push(await fn(items[i], i));
        }
        return results;
    }
    const results = new Array(items.length).fill(undefined);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            if (signal?.aborted)
                return;
            const i = next++;
            try {
                results[i] = await fn(items[i], i);
            }
            catch {
                results[i] = undefined;
            }
        }
    }
    const n = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
}
/** 括号平衡的 JSON 提取：从首个 { 或 [ 开始扫描，处理字符串与转义，返回首个平衡片段 */
export function extractJson(raw) {
    const startObj = raw.indexOf("{");
    const startArr = raw.indexOf("[");
    let start = -1;
    let openCh = "{";
    if (startObj === -1 && startArr === -1)
        return null;
    if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
        start = startObj;
        openCh = "{";
    }
    else {
        start = startArr;
        openCh = "[";
    }
    const closeCh = openCh === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (inStr) {
            if (ch === "\\")
                i++;
            else if (ch === '"')
                inStr = false;
            continue;
        }
        if (ch === '"')
            inStr = true;
        else if (ch === openCh)
            depth++;
        else if (ch === closeCh) {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(raw.slice(start, i + 1));
                }
                catch {
                    return null;
                }
            }
        }
    }
    return null;
}
/** 扫描章节边界：中文章节、Markdown 标题、Chapter N；首字符前视为「开头」边界 */
export function findChapterBoundaries(text) {
    const out = [{ start: 0, end: text.length, label: "开头" }];
    const headingRe = /(^|\n)[ \t]*(?:第[一二三四五六七八九十百千零0-9]+[章节回][^\n]{0,40}|#{1,3}[ \t]+[^\n]{1,40}|Chapter\s+\d+[^\n]{0,40})/gim;
    let m;
    while ((m = headingRe.exec(text))) {
        const lineStart = m.index + (m[1] ? m[1].length : 0);
        if (lineStart === 0) {
            out[0] = { start: 0, end: text.length, label: text.slice(0, 80).split("\n")[0].trim() };
            continue;
        }
        const lineEnd = text.indexOf("\n", lineStart);
        out.push({
            start: lineStart,
            end: lineEnd === -1 ? text.length : lineEnd,
            label: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().replace(/^#{1,3}[ \t]+/, ""),
        });
    }
    out.sort((a, b) => a.start - b.start);
    // 去重（同一行可能多正则命中）
    return out.filter((b, i) => i === 0 || b.start !== out[i - 1].start);
}
/**
 * 单段切出（章节边界优先）：从 cursor 起，以 targetChars 为目标，
 * 先找不超过 maxChars 的最近章节边界；无边界则硬切（回退到标点/换行）。
 * targetChars 可在调用间调整（首段试探后降档）。
 */
export function cutSegment(text, heads, cursor, opts = {}) {
    const target = opts.targetChars ?? 4000;
    const max = opts.maxChars ?? 6000;
    const hardEnd = Math.min(cursor + max, text.length);
    // 段标签取「本段起始处所属章节」（cursor 之前最近的标题），而非段尾切到的下一章
    let startHead;
    for (const h of heads) {
        if (h.start <= cursor)
            startHead = h;
        else
            break;
    }
    // 候选章节起点：(cursor, hardEnd] 之间的边界
    const candidates = heads.filter((h) => h.start > cursor && h.start <= hardEnd);
    let end = -1;
    if (candidates.length) {
        // 优先取最接近 cursor+target 的边界（在 max 内）
        let best = candidates[0];
        let bestDist = Infinity;
        for (const c of candidates) {
            const d = Math.abs(c.start - (cursor + target));
            if (d < bestDist) {
                bestDist = d;
                best = c;
            }
        }
        end = best.start;
    }
    let label = startHead?.label;
    if (end === -1 || end - cursor < 200) {
        // 无章节边界或段过短：硬切到 target（不超过 max）
        let cut = Math.min(cursor + target, text.length);
        if (cut < text.length) {
            const window = text.slice(cursor, hardEnd);
            const rel = window.lastIndexOf("\n\n");
            if (rel >= target * 0.5)
                cut = cursor + rel;
            else {
                const tail = window.slice(0, Math.min(target, window.length));
                const punct = Math.max(tail.lastIndexOf("。"), tail.lastIndexOf("\n"), tail.lastIndexOf("！"), tail.lastIndexOf("？"));
                if (punct >= target * 0.5)
                    cut = cursor + punct + 1;
            }
        }
        end = cut;
    }
    return { text: text.slice(cursor, end).trim(), start: cursor, end, label };
}
/** 全文一次性分段（range 补全为「第 N 段（标签｜约 X 字）」）；供预检/测试使用 */
export function segmentText(text, opts = {}) {
    const heads = findChapterBoundaries(text);
    const raw = [];
    let cursor = 0;
    while (cursor < text.length) {
        const seg = cutSegment(text, heads, cursor, opts);
        if (seg.text)
            raw.push(seg);
        cursor = seg.end;
    }
    return raw.map((s, i) => ({
        text: s.text,
        start: s.start,
        end: s.end,
        range: `第 ${i + 1} 段（${s.label ? s.label.slice(0, 30) : "无标题段落"}｜约${s.text.length}字）`,
    }));
}
function normalizeConfidence(v) {
    if (v === "high" || v === "高")
        return "high";
    if (v === "low" || v === "低")
        return "low";
    if (v === "medium" || v === "中")
        return "medium";
    return "medium";
}
const GOAL_TYPES = ["enumerate", "judge", "design", "diagnose", "other"];
function normalizeGoalType(v) {
    return typeof v === "string" && GOAL_TYPES.includes(v) ? v : "other";
}
/**
 * 流式明文化：扫描累计文本中指定字符串字段「已生成部分」解码后的明文
 * （允许字符串尚未闭合，典型场景为 maxTokens 截断的残损 JSON）。
 */
export function scanStringFieldPrefix(raw, field) {
    const objStart = raw.indexOf("{");
    if (objStart === -1)
        return "";
    const m = new RegExp(`\\{\\s*"${field}"\\s*:\\s*"`, "y");
    m.lastIndex = objStart;
    if (!m.test(raw))
        return "";
    let out = "";
    for (let i = m.lastIndex; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '"')
            return out; // 字段闭合：完整明文
        if (ch === "\\") {
            const next = raw[i + 1];
            if (next === undefined)
                break; // 转义符刚生成，等后续字符
            const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/" };
            if (next === "u") {
                const hex = raw.slice(i + 2, i + 6);
                if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                    out += JSON.parse(`"\\u${hex}"`);
                    i += 5;
                }
                else
                    break;
            }
            else {
                out += map[next] ?? next;
                i += 1;
            }
        }
        else {
            out += ch;
        }
    }
    return out;
}
/** 流式渲染专用：抠 description 字段明文 */
export function scanDescriptionPrefix(raw) {
    return scanStringFieldPrefix(raw, "description");
}
/** 把截断在句尾的文本裁到最后一个完整分句（逗号/顿号/分号处），避免挽救出半句话 */
function trimToLastClause(s) {
    const m = /^[\s\S]*[，、；,;]/.exec(s.trim());
    return (m ? m[0].slice(0, -1) : s).trim();
}
const CJK_RE = /[一-鿿]/g;
/** 统计汉字数量，用于识别「英文思考链」式输出 */
function cjkCount(s) {
    return (s.match(CJK_RE) ?? []).length;
}
/** 从一段文本中取出首个长度足够的完整中文句子（到中文句号/问号/引号为止） */
function firstChineseSentence(s, minLen = 10) {
    const m = /[一-鿿][\s\S]{8,}?[。！？…”」』]/.exec(s);
    const sentence = m?.[0]?.trim();
    return sentence && sentence.length >= minLen ? sentence : "";
}
/**
 * 弱模型常先输出大段英文思考链、最后用 `Description: "..."`（或「描述：」）给出答案。
 * 取最后一个标注之后的内容，优先引号内，否则取首个完整中文句子。
 */
function salvageLabeledDescription(raw) {
    const labels = [...raw.matchAll(/description|描述|边界描述/gi)];
    for (let k = labels.length - 1; k >= 0; k--) {
        const tail = raw.slice(labels[k].index + labels[k][0].length);
        const m = /^\s*[：:]\s*["“']?\s*([\s\S]*)$/.exec(tail);
        if (!m)
            continue;
        // 直接在标注后的整段文本上找首个完整中文句子（结尾标点不会与描述内部的开引号 “ 冲突）
        const sentence = firstChineseSentence(m[1], 10);
        if (sentence)
            return sentence;
        const rest = m[1].trim();
        if (cjkCount(rest) >= 10)
            return rest.replace(/\s+/g, " ").slice(0, 500);
    }
    return "";
}
/**
 * 引号污染容忍解析：
 * 模型常在 description 正文里直接写未转义的 ASCII 双引号（如 （如"三天后""再遇"）），
 * 导致 JSON.parse 失败，前缀扫描又会在第一个内部引号处截断成残句。
 * 锚定字段边界——description 的结束引号必然是「后面紧跟 ,"confidence"」的那个引号——
 * 从而把完整正文取出，并将正文内部残留的 ASCII 引号归一为中文引号。
 */
function tolerantSeatJson(raw) {
    const m = /"description"\s*:\s*"([\s\S]*?)"\s*,\s*"confidence"\s*:\s*"(high|medium|low|高|中|低)"/i.exec(raw);
    if (!m)
        return null;
    const desc = m[1].replace(/\s+/g, " ").trim();
    if (desc.length < 8 || cjkCount(desc) < 6)
        return null;
    // 正文内部残留的 ASCII 引号按出现顺序配对替换为中文开/闭引号
    let openQuote = true;
    const normalized = desc.replace(/"/g, () => {
        const q = openQuote ? "“" : "”";
        openQuote = !openQuote;
        return q;
    });
    return { description: normalized.slice(0, 500), confidence: normalizeConfidence(m[2]) };
}
/**
 * 解析席位作答，优先级：
 * ① 协议 JSON；② 引号污染容忍解析（正文含未转义引号但字段完整）；
 * ③ 截断导致引号未闭合的 description 明文片段；
 * ④ 标注答案（Description:/描述：，常见于夹带英文思考链的输出）；
 * ⑤ 以中文为主的纯文本正文（英文思考链占比过高则拒绝）。
 */
function parseSeatReply(raw) {
    const parsed = extractJson(raw);
    if (parsed && typeof parsed.description === "string" && parsed.description.trim()) {
        return {
            description: parsed.description.trim().slice(0, 500),
            confidence: normalizeConfidence(parsed.confidence),
            salvaged: false,
        };
    }
    // 引号污染：字段都在，仅正文内部引号未转义
    const tolerant = tolerantSeatJson(raw);
    if (tolerant) {
        return { description: tolerant.description, confidence: tolerant.confidence, salvaged: true, repaired: true };
    }
    // 残损 JSON（多为 maxTokens 截断）：挽救 description 已生成部分
    const prefix = scanDescriptionPrefix(raw).trim();
    if (prefix.length >= 10 && cjkCount(prefix) >= 6) {
        return { description: prefix.slice(0, 500), confidence: "medium", salvaged: true };
    }
    // 标注答案（思考链末尾的 Description: "..."）
    const labeled = salvageLabeledDescription(raw);
    if (labeled) {
        return { description: labeled.slice(0, 500), confidence: "medium", salvaged: true };
    }
    // 纯文本：去掉代码块围栏；要求以中文为主，避免把英文思考链收入清单
    const prose = raw.replace(/```(?:json)?/gi, "").trim();
    if (prose.length >= 10 && !prose.startsWith("{")) {
        const cjk = cjkCount(prose);
        if (cjk >= 10 && cjk / prose.length >= 0.3) {
            return { description: prose.slice(0, 500), confidence: "medium", salvaged: true };
        }
    }
    return null;
}
/** 统筹者未按 JSON 输出问题时的挽救：
 *  ① 最后一个带问号的中文问句；
 *  ② 「问题：/请问/请(提出|补充|指出|说明)…」引导的陈述式指令句（弱模型常漏问号）。 */
function salvageQuestion(raw) {
    const matches = [...raw.matchAll(/[一-鿿][^。！？\n\r]{6,200}[？?]/g)];
    const q = matches[matches.length - 1]?.[0]?.trim();
    if (q && q.length >= 12)
        return q;
    // 陈述式挽救：取「问题：」「请问」「请补充/请指出/请说明/请提出」之后的内容
    const labeled = [...raw.matchAll(/(?:问题\s*[：:]|请问|请(?:提出|补充|指出|说明|给出))\s*([一-鿿][^\n\r。！？*"{}]{8,180})/g)];
    const tail = labeled[labeled.length - 1]?.[1]?.trim();
    if (tail && tail.length >= 12)
        return tail;
    return "";
}
export class Orchestrator {
    meetings = new Map();
    streams = new Set();
    stream;
    // 运行期状态
    state = { phase: "idle", round: 0, updatedAt: "" };
    startedAt;
    finishedAt;
    finalizedAt;
    errorAt;
    stopRequested = false;
    runController = null;
    tokensUsed = 0;
    /** 自上次裁决后边界池是否有变更（新增/合并/用户追加） */
    adjudicateDirty = true;
    constructor(opts) {
        this.stream = opts?.stream ?? false;
    }
    /** 从磁盘快照恢复最近一次的会议（服务重启后调用） */
    restoreLatestSnapshot(meetingsDir) {
        try {
            const files = readdirSync(meetingsDir)
                .filter((f) => f.endsWith("-snapshot.json"))
                .map((f) => {
                const path = join(meetingsDir, f);
                const stat = statSync(path);
                return { name: f, path, mtime: stat.mtimeMs };
            })
                .sort((a, b) => b.mtime - a.mtime); // 最新的在前
            if (files.length === 0)
                return null;
            const latest = files[0];
            const raw = readFileSync(latest.path, "utf-8");
            const snap = JSON.parse(raw);
            // 恢复 MeetingRecord
            const meeting = {
                meetingId: snap.meetingId,
                question: snap.question,
                topic: snap.topic,
                objective: snap.objective,
                scope: snap.scope,
                goalType: snap.goalType ?? "other",
                specialty: snap.specialty,
                // 愈合：丢弃空方案的 final 事件（旧版本空返回也会落事件，回放会显示空的「最终解决方案」块）
                events: (snap.events ?? []).filter((e) => e.type !== "final" || !!e.solution?.trim()),
                items: snap.items ?? [],
                coordHistory: [], // 快照里没有，置空
                newPerRound: [], // 快照里没有，置空
                convergence: snap.convergence,
                rounds: snap.rounds,
                tokenEstimate: snap.tokenEstimate ?? 0,
                finalSolution: snap.finalSolution,
                batch: snap.batch,
                seedDimensionsText: snap.seedDimensionsText,
                pendingTurns: [],
                seats: getSeatConfigs(),
                config: getRuntime(),
            };
            this.meetings.set(snap.meetingId, meeting);
            // 恢复 phase 状态；中间态归一：旧版本会在裁决阶段落盘（phase=adjudicating），
            // 但 convergence 已非空说明勘探实际已结束，恢复时归一到 reviewing，
            // 否则恢复的会议会被 finalize/turn 端点当成「勘探尚未结束」
            let phase = snap.state?.phase ?? "reviewing";
            if ((phase === "adjudicating" || phase === "interrogating") && snap.convergence) {
                phase = "reviewing";
            }
            // 终局中断愈合：正在生成中（服务重启）或已标记完成但方案为空（旧版本空返回 bug），退回 reviewing
            if (phase === "finalizing" || (phase === "finalized" && !snap.finalSolution?.trim())) {
                phase = "reviewing";
            }
            // 分段流水线中途重启无法续跑：归一到 reviewing，用户可基于已完成段提前汇总
            if (snap.batch && !snap.batch.finished)
                phase = "reviewing";
            this.setState(phase, snap.rounds);
            this.startedAt = snap.state?.startedAt;
            this.finishedAt = snap.state?.finishedAt;
            this.finalizedAt = snap.state?.finalizedAt;
            this.tokensUsed = snap.tokenEstimate ?? 0;
            return { meetingId: snap.meetingId, snapshot: snap };
        }
        catch (err) {
            console.error("恢复快照失败:", err);
            return null;
        }
    }
    setState(phase, round) {
        if (phase === "interrogating" && !this.startedAt)
            this.startedAt = new Date().toISOString();
        if (phase === "reviewing")
            this.finishedAt = new Date().toISOString();
        if (phase === "finalized")
            this.finalizedAt = new Date().toISOString();
        if (phase === "error")
            this.errorAt = new Date().toISOString();
        this.state = {
            phase,
            round: round ?? this.state.round,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            finalizedAt: this.finalizedAt,
            errorAt: this.errorAt,
            updatedAt: new Date().toISOString(),
        };
    }
    /** 请求停止：立即中断当前进行中的模型调用（R2 中也生效） */
    requestStop() {
        this.stopRequested = true;
        this.runController?.abort(new Error("用户停止勘探"));
    }
    /** 粗略 token 计数：输入输出统一按约 1.5 字符/token 累计（CJK 主导文本） */
    recordCall(inputChars, output) {
        this.tokensUsed += Math.ceil(inputChars / 1.5) + Math.ceil(output.length / 1.5);
    }
    /** 落盘失败不影响会议主流程 */
    saveSnapshot(meetingId) {
        try {
            persistSnapshot(meetingId, () => this.snapshot(meetingId));
        }
        catch {
            /* 忽略持久化失败 */
        }
    }
    /** 统筹者对话：provider/模型覆盖均取自会议配置快照 */
    coordChat(meeting, messages, opts) {
        return this.chat(meeting.config.coordinatorProvider, messages, {
            ...opts,
            model: meeting.config.coordinatorModel,
        });
    }
    async chat(providerId, messages, opts) {
        const input = messages.reduce((n, m) => n + m.content.length, 0);
        const out = await chat(providerId, messages, { ...opts, signal: this.runController?.signal });
        this.recordCall(input, out);
        return out;
    }
    async chatStream(providerId, messages, onChunk, opts) {
        const input = messages.reduce((n, m) => n + m.content.length, 0);
        const out = await chatStream(providerId, messages, onChunk, { ...opts, signal: this.runController?.signal });
        this.recordCall(input, out);
        return out;
    }
    onEvent(fn) {
        this.streams.add(fn);
        return () => this.streams.delete(fn);
    }
    getMeeting(meetingId) {
        return this.meetings.get(meetingId);
    }
    getEvents(meetingId) {
        return this.meetings.get(meetingId)?.events ?? [];
    }
    nextId(items) {
        const n = items.length + 1;
        return `B${String(n).padStart(3, "0")}`;
    }
    dedupKey(description) {
        return description.trim().replace(/[，。,.\s]/g, "").slice(0, 40);
    }
    /** R0 开题 */
    async runExploration(opts) {
        const { meetingId, question, emit, beforeRound } = opts;
        const specialty = opts.specialty || "general";
        this.runController = new AbortController();
        this.stopRequested = false;
        this.tokensUsed = 0;
        this.adjudicateDirty = true;
        const meeting = {
            meetingId,
            question,
            goalType: "other",
            specialty,
            events: [],
            items: [],
            coordHistory: [],
            newPerRound: [],
            convergence: null,
            rounds: 0,
            tokenEstimate: 0,
            pendingTurns: [],
            seats: getSeatConfigs(),
            config: getRuntime(),
            activeSegment: opts.activeSegment,
        };
        this.meetings.set(meetingId, meeting);
        this.setState("interrogating", 0);
        const localEmit = async (e) => {
            meeting.events.push(e);
            await emit(e);
        };
        try {
            // 专项模板加载 + 种子维度渲染（红队项5：token 预算控制）
            // 阶段2 用硬编码上下文窗口预估值 32000；阶段3 改为从 providers.json.runtime 读取
            const CONTEXT_WINDOW_ESTIMATE = 32000;
            const tpl = specialty === "general" ? undefined : getSpecialty(specialty);
            let seedDimensionsText = tpl ? renderSeedDimensions(tpl) : "";
            const openingHint = tpl?.openingHint;
            if (seedDimensionsText) {
                // 粗略 token 估算：1 token ≈ 1.5 字符（CJK 主导）
                const sysLen = coordinatorSystemPrompt().length;
                const totalChars = sysLen + question.length + seedDimensionsText.length;
                const estTokens = Math.ceil(totalChars / 1.5);
                if (estTokens / CONTEXT_WINDOW_ESTIMATE > 0.6) {
                    // 压缩为维度名列表（保留分类标签，去掉 aspect/signal 详描）
                    const dimNames = tpl.seedDimensions
                        .map((d) => `- ${d.name}${d.category ? `（${d.category}）` : ""}`)
                        .join("\n");
                    await localEmit({
                        type: "notice",
                        level: "info",
                        message: `种子维度注入超过上下文预算 60%（约 ${estTokens} / ${CONTEXT_WINDOW_ESTIMATE} tokens），已压缩为维度名列表（${tpl.seedDimensions.length} 维）。`,
                    });
                    seedDimensionsText = dimNames;
                }
            }
            meeting.seedDimensionsText = seedDimensionsText || undefined;
            // 统筹者开题（首次）
            let openingRaw = await this.coordChat(meeting, [
                { role: "system", content: coordinatorSystemPrompt() },
                {
                    role: "user",
                    content: coordinatorOpeningUser({
                        question,
                        seedDimensionsText: seedDimensionsText || undefined,
                        openingHint,
                    }),
                },
            ], { temperature: 0.2, maxTokens: 15000, timeoutMs: 300_000 });
            let opening = extractJson(openingRaw);
            // 解析失败：针对性重试一次
            if (!opening) {
                openingRaw = await this.coordChat(meeting, [
                    { role: "system", content: coordinatorSystemPrompt() },
                    {
                        role: "user",
                        content: coordinatorOpeningUser({
                            question,
                            seedDimensionsText: seedDimensionsText || undefined,
                            openingHint,
                        }) +
                            '\n\n上一次输出无法解析为 JSON。请严格只输出 JSON 对象本身：{"topic":"...","objective":"...","goalType":"enumerate|judge|design|diagnose|other","scope":"..."}，不要 Markdown 代码块、不要任何解释文字。',
                    },
                ], { temperature: 0.2, maxTokens: 15000, timeoutMs: 300_000 });
                opening = extractJson(openingRaw);
            }
            // 仍失败（多为思考链占满 token 导致 JSON 截断）：从残片里逐字段正则挽救
            if (!opening) {
                console.warn("[opening] 两次解析失败 raw=", openingRaw.slice(0, 600));
                const grab = (key) => {
                    const m = openingRaw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\]){4,})`, "i"));
                    if (!m?.[1])
                        return undefined;
                    try {
                        return JSON.parse(`"${m[1].slice(0, 300)}"`);
                    }
                    catch {
                        return m[1].replace(/\\(.)/g, "$1").slice(0, 300);
                    }
                };
                const goalRaw = openingRaw.match(/"goalType"\s*:\s*"(enumerate|judge|design|diagnose|other)"/i)?.[1];
                if (grab("topic") || grab("objective") || goalRaw) {
                    opening = {
                        topic: grab("topic"),
                        objective: grab("objective"),
                        scope: grab("scope"),
                        goalType: goalRaw,
                    };
                }
            }
            meeting.goalType = normalizeGoalType(opening?.goalType);
            meeting.topic = opening?.topic?.slice(0, 80) ?? question.slice(0, 80);
            meeting.objective = opening?.objective ?? `澄清：${question}`;
            meeting.scope = opening?.scope ?? "通用领域";
            if (!opening || !opening.topic || !opening.objective) {
                await localEmit({
                    type: "notice",
                    level: "warn",
                    message: "统筹者开题输出无法解析为 JSON，已使用议题原文兜底，目标类型按“其他”处理。",
                });
            }
            await localEmit({
                type: "opening",
                topic: meeting.topic,
                objective: meeting.objective,
                scope: meeting.scope,
                goalType: meeting.goalType,
            });
            // R1-R4 轮询
            let stopped = false;
            let convergence = null;
            for (let r = 1; r <= meeting.config.maxRounds; r++) {
                this.setState("interrogating", r);
                // 用户插话（每轮开始前消费）
                if (beforeRound) {
                    const turns = beforeRound();
                    for (const t of turns) {
                        meeting.pendingTurns.push(t);
                        await localEmit({
                            type: "user_message",
                            content: t.supplement ?? t.item?.description ?? "",
                            kind: t.kind,
                        });
                        if (t.kind === "new_boundary" && t.item) {
                            this.addUserBoundary(meeting, t.item.type, t.item.description, t.item.confidence);
                        }
                        else if (t.kind === "supplement" && t.supplement) {
                            meeting.scope += `；用户补充：${t.supplement}`;
                        }
                        else if (t.kind === "stop") {
                            stopped = true;
                        }
                    }
                }
                if (stopped || this.stopRequested) {
                    stopped = true;
                    break;
                }
                const { newCount } = await this.runRound(meeting, r, localEmit);
                meeting.newPerRound.push(newCount);
                meeting.rounds = r;
                meeting.tokenEstimate = this.tokensUsed;
                await localEmit({ type: "round", round: r, newCount, tokenEstimate: this.tokensUsed });
                // R3 收敛判定
                const converged = await this.checkConvergence(meeting);
                if (converged) {
                    convergence = "auto";
                    break;
                }
            }
            if (!convergence)
                convergence = stopped ? "user_stop" : "max_rounds";
            meeting.convergence = convergence;
            await localEmit({ type: "converged", reason: convergence, rounds: meeting.rounds });
            // R2 裁决（循环结束后统一执行；不再使用可能已被取消的 runController 信号）
            this.runController = null;
            this.setState("adjudicating", meeting.rounds);
            // 裁决失败（如模型请求超时）不得阻断清单下发：边界已在勘探阶段入池，必须保证清单可见、可落盘
            try {
                await this.adjudicate(meeting, localEmit);
            }
            catch (adjErr) {
                await localEmit({
                    type: "notice",
                    level: "warn",
                    message: `自动裁决请求失败（${adjErr.message}），全部边界暂按「保留」入清单，可稍后人工复核或重新出方案。`,
                });
            }
            const list = this.regenerateList(meeting);
            await localEmit({ type: "list", list });
            // 先置 reviewing 再落盘：快照相位必须是终态，否则重启恢复后会被当成「勘探未完成」
            this.setState("reviewing", meeting.rounds);
            this.saveSnapshot(meeting.meetingId);
            return list;
        }
        catch (err) {
            if (this.stopRequested) {
                meeting.convergence = "user_stop";
                await localEmit({ type: "converged", reason: "user_stop", rounds: meeting.rounds });
                this.runController = null;
                this.setState("adjudicating", meeting.rounds);
                await this.adjudicate(meeting, localEmit).catch(() => { });
                const list = this.regenerateList(meeting);
                await localEmit({ type: "list", list });
                this.setState("reviewing", meeting.rounds);
                this.saveSnapshot(meeting.meetingId);
                return list;
            }
            this.setState("error", meeting.rounds);
            await localEmit({ type: "error", message: `勘探失败：${err.message}` });
            throw err;
        }
        finally {
            this.runController = null;
        }
    }
    // ============ 分段流水线 ============
    /**
     * 长文分段诊断流水线：
     * 动态分段（首段 4000 字试探 → 弱响应降档 3000 → 上限 6000，章节边界优先）；
     * 每段是一场独立子会议（MeetingId 为 `${outerId}#${n}`），段结束后：
     * 裁决保留的条目重编全局 ID、打上 segment 归属，累积到外层会议 BatchContext，
     * 随后释放子会议记录与临时快照。外层 events 只留 batch_progress（供 SSE 回放）。
     */
    async runBatchExploration(opts) {
        const { meetingId, question, emit } = opts;
        const specialty = opts.specialty || "general";
        const text = question.trim();
        this.runController = new AbortController();
        this.stopRequested = false;
        this.tokensUsed = 0;
        let globalSeq = 0;
        // 预检：按初始 4000 目标估算总段数（实际段长按试探结果动态调整）
        const total = Math.max(1, segmentText(text, { targetChars: 4000, maxChars: 6000 }).length);
        const tpl0 = specialty === "general" ? undefined : getSpecialty(specialty);
        const seedText0 = tpl0 ? renderSeedDimensions(tpl0) : "";
        const outer = {
            meetingId,
            question,
            topic: text.slice(0, 60).replace(/\s+/g, " "),
            objective: "分段诊断：产出逐段问题清单、全局共性问题与修改优先级（只诊断不改写）",
            scope: `全文约 ${text.length} 字，预估 ${total} 段`,
            goalType: "diagnose",
            specialty,
            events: [],
            items: [],
            coordHistory: [],
            newPerRound: [],
            convergence: null,
            rounds: 0,
            tokenEstimate: 0,
            pendingTurns: [],
            seats: getSeatConfigs(),
            config: getRuntime(),
            batch: { total, completed: 0, segmentRanges: [], finished: false },
            seedDimensionsText: seedText0 || undefined,
        };
        this.meetings.set(meetingId, outer);
        this.setState("interrogating", 0);
        const outerEmit = async (e) => {
            outer.events.push(e);
            await emit(e);
        };
        const heads = findChapterBoundaries(text);
        let cursor = 0;
        let target = 4000;
        let segNo = 0;
        try {
            while (cursor < text.length) {
                if (this.stopRequested)
                    break;
                const seg = cutSegment(text, heads, cursor, { targetChars: target, maxChars: 6000 });
                if (!seg.text) {
                    cursor = seg.end;
                    continue;
                }
                segNo += 1;
                const range = `第 ${segNo} 段（${seg.label ? seg.label.slice(0, 30) : "无标题段落"}｜约${seg.text.length}字）/共 ${total} 段`;
                const subId = `${meetingId}#${segNo}`;
                await outerEmit({
                    type: "batch_progress",
                    current: segNo - 1,
                    total,
                    segmentRange: range,
                    itemsSoFar: outer.items.length,
                });
                // 子会议：独立 MeetingRecord，从空池起步（全局编号在段结束时统一重排）
                let weakSignals = 0;
                try {
                    await this.runExploration({
                        meetingId: subId,
                        question: `请诊断以下文本段（${range}）：\n\n${seg.text}`,
                        specialty,
                        stream: this.stream,
                        activeSegment: { range, text: seg.text },
                        emit: async (e) => {
                            // 弱响应信号：截断挽救 / 非 JSON 挽救 / 空返回重试
                            if (e.type === "notice" &&
                                e.level === "warn" &&
                                /截断|挽救|空返回|无法解析/.test(e.message)) {
                                weakSignals++;
                            }
                            // 子会议级生命周期事件不下发外层：开题/收敛/清单由分段流水线统一给出，
                            // 避免直播流与 SSE 回放（只保留 batch_progress/外层事件）不一致
                            if (e.type === "opening" || e.type === "converged" || e.type === "list")
                                return;
                            await emit(e);
                        },
                    });
                }
                catch (err) {
                    if (this.stopRequested)
                        break;
                    await outerEmit({
                        type: "notice",
                        level: "warn",
                        message: `${range} 勘探失败（${err.message}），该段跳过，可在最终报告后针对该段重跑。`,
                    });
                    cursor = seg.end;
                    continue;
                }
                // 累积裁决保留条目：全局重编号 + 段归属
                const sub = this.meetings.get(subId);
                if (sub) {
                    for (const it of sub.items) {
                        if (it.status.kind !== "kept")
                            continue;
                        globalSeq += 1;
                        outer.items.push({
                            ...it,
                            id: `B${String(globalSeq).padStart(3, "0")}`,
                            segment: segNo,
                            status: { kind: "kept" },
                        });
                    }
                }
                // 释放子会议与临时快照（段间内存控制）
                this.meetings.delete(subId);
                try {
                    rmSync(join(meetingsDir, `${subId}-snapshot.json`), { force: true });
                }
                catch {
                    /* 忽略 */
                }
                outer.batch.completed = segNo;
                outer.batch.segmentRanges.push(range);
                cursor = seg.end;
                // 首段试探：出现弱响应信号则后续降档到 3000
                if (segNo === 1 && weakSignals > 0 && target > 3000) {
                    target = 3000;
                    await outerEmit({
                        type: "notice",
                        level: "info",
                        message: "首段勘探出现截断/格式挽救信号，后续段落目标长度降档为 3000 字。",
                    });
                }
                outer.tokenEstimate = this.tokensUsed;
                this.saveSnapshot(meetingId);
                await outerEmit({
                    type: "batch_progress",
                    current: segNo,
                    total,
                    segmentRange: range,
                    itemsSoFar: outer.items.length,
                });
            }
            outer.batch.finished = true;
            outer.convergence = this.stopRequested ? "user_stop" : "auto";
            await outerEmit({
                type: "converged",
                reason: outer.convergence ?? "auto",
                rounds: outer.batch.completed,
            });
            const outerList = this.regenerateList(outer);
            await outerEmit({ type: "list", list: outerList });
            this.setState("reviewing", 0);
            this.saveSnapshot(meetingId);
            return outerList;
        }
        catch (err) {
            this.setState("error", 0);
            await outerEmit({ type: "error", message: `分段流水线失败：${err.message}` });
            throw err;
        }
        finally {
            this.runController = null;
        }
    }
    /** 提前汇总/最终汇总：partial=true 仅基于已完成段；规模过大时自动拆分（代码生成逐段清单） */
    async batchSummarize(meetingId, partial = false, emit) {
        const m = this.meetings.get(meetingId);
        if (!m?.batch)
            throw new Error("会议不存在或非分段会议");
        if (!m.batch.finished && partial === false) {
            throw new Error("分段勘探尚未结束，请使用「提前汇总」");
        }
        const completed = m.batch.completed;
        const total = m.batch.total;
        // 规模阈值：条目文本超过约 4 万字则拆分为「LLM 归并共性 + 代码生成逐段清单」
        const itemsText = m.items.map((b) => b.description).join("");
        const splitMode = itemsText.length > 40000;
        let llmItems = m.items;
        if (splitMode) {
            // 按 dedupKey 跨段归并；描述前缀【第N段】标注首个出现位置，每类保留一条代表
            const groups = new Map();
            for (const it of m.items) {
                const key = this.dedupKey(it.description);
                if (!groups.has(key)) {
                    groups.set(key, {
                        ...it,
                        description: `【第${it.segment ?? 1}段】${it.description}`,
                    });
                }
            }
            llmItems = [...groups.values()].slice(0, 300);
        }
        const tpl = getSpecialty(m.specialty ?? "general") ?? getSpecialty("general");
        const user = coordinatorFinalTemplateUser({
            topic: m.topic ?? "",
            objective: m.objective ?? "",
            template: this.buildFinalTemplate(m, tpl.finalTemplate, { partial, splitMode }),
            list: llmItems,
            partial,
            completed,
            total,
            splitMode,
            seedDimensionsText: m.seedDimensionsText,
        });
        let content = (await this.coordChat(m, [
            { role: "system", content: coordinatorSystemPrompt() },
            { role: "user", content: user },
        ], { temperature: 0.5, maxTokens: 81920, timeoutMs: 600_000 })).trim();
        if (!content) {
            content = (await this.coordChat(m, [
                { role: "system", content: coordinatorSystemPrompt() },
                {
                    role: "user",
                    content: user +
                        "\n\n上一次返回内容为空。请不要进行长段思考，依据报告模板骨架直接输出完整 Markdown 正文，并替换其中全部占位符。",
                },
            ], { temperature: 0.5, maxTokens: 81920, timeoutMs: 600_000 })).trim();
        }
        if (!content)
            throw new Error("汇总模型连续两次空返回，请稍后重试或更换统筹者模型");
        if (splitMode) {
            const sections = this.renderSegmentSections(m, partial ? completed : undefined);
            if (content.includes(SEGMENT_SECTIONS_MARKER)) {
                content = content.replace(SEGMENT_SECTIONS_MARKER, sections.trim());
            }
            else {
                // LLM 未保留标记：兜底追加
                content = `${content.trim()}\n\n${sections.trim()}`;
            }
        }
        // 最终汇总落 final 事件；提前汇总走独立事件（可被后续 final 覆盖）
        let ev;
        if (!partial) {
            m.finalSolution = content;
            ev = { type: "final", solution: content };
            m.events.push(ev);
            this.setState("finalized", m.rounds);
        }
        else {
            ev = { type: "batch_summarized", solution: content, partial: true, current: completed, total };
            m.events.push(ev);
        }
        if (emit)
            await emit(ev);
        this.saveSnapshot(meetingId);
        try {
            persistReport(meetingId, () => this.snapshot(meetingId));
        }
        catch {
            /* 忽略报告落盘失败 */
        }
        return content;
    }
    /** 代码生成「逐段问题清单」章节（拆分模式；条目描述已含定位与建议）；limit 限定只渲染前 N 段（提前汇总） */
    renderSegmentSections(m, limit) {
        const lines = ["## 逐段问题清单"];
        const ranges = m.batch.segmentRanges;
        const maxN = limit ?? ranges.length;
        for (let n = 1; n <= maxN; n++) {
            const segItems = m.items.filter((b) => b.segment === n);
            lines.push("", `### ${ranges[n - 1] ?? `第 ${n} 段`}`);
            if (segItems.length === 0) {
                lines.push("", "（本段未产生裁决保留的诊断条目）");
                continue;
            }
            for (const it of segItems) {
                lines.push("", `- **${it.id}｜${it.type}**（可信度：${it.confidence}）：${it.description}`);
            }
        }
        return lines.join("\n");
    }
    /**
     * 单轮（三阶段）：批量出题 → 并行作答 → 串行入池。
     * seatConcurrency=1 时退化为串行（等同改前行为）。
     * 用户停止时 abort 全部在飞请求，已完成的入池，未完成的跳过。
     */
    async runRound(meeting, round, emit) {
        let newCount = 0;
        const concurrency = meeting.config.seatConcurrency ?? 5;
        const signal = this.runController?.signal;
        // ── 阶段 A：统筹者批量出题 ──
        if (this.stopRequested)
            return { newCount };
        const questions = await this.askCoordinatorBatch(meeting, round, emit);
        if (this.stopRequested)
            return { newCount };
        // 下发 5 个 question 事件
        for (const { seat, question } of questions) {
            await emit({ type: "question", round, seat: seat.id, question });
        }
        // ── 阶段 B：并行/串行作答 ──
        const results = await parallelMap(questions, async ({ seat, question }, _i) => {
            if (this.stopRequested || signal?.aborted)
                return undefined;
            try {
                let reply = await this.askSeat(meeting, seat, round, question, emit);
                let parsedReply = parseSeatReply(reply);
                // 首次解析失败：区分空返回与格式不合规
                let retried = false;
                if (!parsedReply && !this.stopRequested) {
                    retried = true;
                    const emptyFirst = !reply.trim();
                    console.warn(`[seatReply:first] seat=${seat.id} round=${round} empty=${emptyFirst} raw=`, reply.slice(0, 300));
                    await emit({
                        type: "notice",
                        level: "warn",
                        seat: seat.id,
                        message: emptyFirst
                            ? `「${seat.name}」第 ${round} 轮模型空返回（可能为上游限流或思考预算耗尽），正在重试一次。`
                            : `「${seat.name}」第 ${round} 轮发言未按 JSON 协议输出，正在要求其重答一次。`,
                    });
                    reply = await this.askSeat(meeting, seat, round, question, emit, true);
                    parsedReply = parseSeatReply(reply);
                }
                if (retried && (!parsedReply || parsedReply.salvaged) && !this.stopRequested) {
                    console.warn(`[seatReply:retry] seat=${seat.id} round=${round} empty=${!reply.trim()} salvaged=${!!parsedReply} raw=`, reply.slice(0, 500));
                }
                // 即时下发 reply（交错到达，前端按 seat 标签渲染）
                if (parsedReply?.salvaged) {
                    await emit({
                        type: "notice",
                        level: parsedReply.repaired ? "info" : "warn",
                        seat: seat.id,
                        message: parsedReply.repaired
                            ? `「${seat.name}」第 ${round} 轮发言的 JSON 正文内含未转义引号，已自动修复并完整收录（保留原可信度）。`
                            : `「${seat.name}」第 ${round} 轮发言仍非标准 JSON，已按原文挽救收录（可信度降为「中」）。`,
                    });
                }
                await emit({ type: "reply", round, seat: seat.id, content: reply });
                return { seat, parsedReply, reply };
            }
            catch (err) {
                if (this.stopRequested)
                    return undefined;
                await emit({
                    type: "error",
                    message: `席位 ${seat.name} 本轮失败：${err.message}`,
                    seat: seat.id,
                });
                return undefined;
            }
        }, concurrency, signal);
        // ── 阶段 C：串行入池（消除并发竞态） ──
        for (const result of results) {
            if (!result)
                continue;
            const { seat, parsedReply } = result;
            if (parsedReply) {
                const added = this.addBoundary(meeting, {
                    type: seat.type,
                    description: parsedReply.description,
                    confidence: parsedReply.confidence,
                    source: seat.id,
                    sourceModel: seat.model,
                    round,
                });
                if (added) {
                    newCount++;
                    await emit({ type: "boundary", round, item: added });
                }
            }
            else {
                await emit({
                    type: "notice",
                    level: "warn",
                    seat: seat.id,
                    message: `「${seat.name}」第 ${round} 轮两次发言均无法解析且无可用内容，本轮该席无新增边界。`,
                });
            }
        }
        return { newCount };
    }
    poolDescription(meeting) {
        if (meeting.items.length === 0)
            return "（暂无）";
        return meeting.items
            .map((b) => `- [${b.type}] ${b.description}`)
            .join("\n");
    }
    /** 统筹者向某席生成针对性问题（解析失败时针对性重试一次，仍失败则通用问题兜底并告警） */
    async askCoordinator(meeting, seat, round, emit) {
        const user = coordinatorQuestionUser({
            round,
            seatName: seat.name,
            seatRole: seat.role,
            seatType: seat.type,
            topic: meeting.topic ?? "",
            scope: meeting.scope ?? "",
            goalType: meeting.goalType,
            pool: this.poolDescription(meeting),
            coordHistory: meeting.coordHistory,
        }) + (meeting.activeSegment
            ? `\n\n本次只诊断以下文本段（范围：${meeting.activeSegment.range}），提问必须针对该段原文中的具体问题，不要问段外内容：\n-----\n${meeting.activeSegment.text}\n-----`
            : this.sourceTextBlock(meeting));
        let raw = await this.coordChat(meeting, [
            { role: "system", content: coordinatorSystemPrompt() },
            { role: "user", content: user },
        ], { temperature: 0.2, maxTokens: 20480, timeoutMs: 300_000 });
        let parsed = extractJson(raw);
        if (!parsed?.question) {
            raw = await this.coordChat(meeting, [
                { role: "system", content: coordinatorSystemPrompt() },
                { role: "user", content: user + "\n\n上一次输出无法解析为 JSON。请严格只输出 {\"question\":\"...\"}。" },
            ], { temperature: 0.2, maxTokens: 20480, timeoutMs: 300_000 });
            parsed = extractJson(raw);
        }
        // 两次 JSON 均失败（或 question 为空串/纯空白）：
        // ① 先从截断 JSON 的 "question" 字段挽救已生成明文；② 再找自由文本问句；③ 通用兜底
        const parsedQuestion = typeof parsed?.question === "string" ? parsed.question.trim() : "";
        let fieldSalvaged = "";
        if (!parsedQuestion) {
            fieldSalvaged = trimToLastClause(scanStringFieldPrefix(raw, "question"));
            if (fieldSalvaged.length < 12)
                fieldSalvaged = "";
        }
        const salvagedQuestion = !parsedQuestion && !fieldSalvaged ? salvageQuestion(raw) : "";
        const fallback = !parsedQuestion && !fieldSalvaged && !salvagedQuestion;
        if (fallback) {
            // 留证：把模型原始返回（截断）打到服务端日志，便于定位是思考链截断还是格式跑偏
            console.warn(`[askCoordinator] 两次解析失败 seat=${seat.id} round=${round} raw=`, raw.slice(0, 500));
        }
        const q = parsedQuestion ||
            fieldSalvaged ||
            salvagedQuestion ||
            `（第${round}轮）请补充一条当前尚未提及的、与「${seat.type}」有关的具体方面或边界。`;
        if (fieldSalvaged) {
            await emit({
                type: "notice",
                level: "warn",
                seat: seat.id,
                message: `统筹者对「${seat.name}」第 ${round} 轮的盘问输出被截断，已从原文挽救问题。`,
            });
        }
        else if (salvagedQuestion) {
            await emit({
                type: "notice",
                level: "warn",
                seat: seat.id,
                message: `统筹者对「${seat.name}」第 ${round} 轮的盘问未按 JSON 输出，已从原文挽救问句。`,
            });
        }
        else if (fallback) {
            await emit({
                type: "notice",
                level: "warn",
                seat: seat.id,
                message: `统筹者对「${seat.name}」第 ${round} 轮的盘问两次均无法解析，已使用通用问题兜底。`,
            });
        }
        meeting.coordHistory.push(`R${round} 致${seat.name}：${q}`);
        return q;
    }
    /**
     * 批量出题：统筹者一次为全部 5 席各产出 1 个盘问问题。
     * 挽救链：解析失败→重试→逐字段挽救→缺失席位通用兜底。
     * 返回与 meeting.seats 顺序一致的 { seat, question } 数组。
     */
    async askCoordinatorBatch(meeting, round, emit) {
        const seats = meeting.seats;
        const fallbackQ = (seat) => `（第${round}轮）请补充一条当前尚未提及的、与「${seat.type}」有关的具体方面或边界。`;
        const user = coordinatorBatchQuestionUser({
            round,
            seats: seats.map((s) => ({ id: s.id, name: s.name, role: s.role, type: s.type })),
            topic: meeting.topic ?? "",
            scope: meeting.scope ?? "",
            goalType: meeting.goalType,
            pool: this.poolDescription(meeting),
            coordHistory: meeting.coordHistory,
        }) + (meeting.activeSegment
            ? `\n\n本次只诊断以下文本段（范围：${meeting.activeSegment.range}），提问必须针对该段原文中的具体问题，不要问段外内容：\n-----\n${meeting.activeSegment.text}\n-----`
            : this.sourceTextBlock(meeting));
        let raw = await this.coordChat(meeting, [
            { role: "system", content: coordinatorSystemPrompt() },
            { role: "user", content: user },
        ], { temperature: 0.2, maxTokens: 20480, timeoutMs: 300_000 });
        let parsed = extractJson(raw);
        if (!parsed?.questions?.length) {
            // 重试一次
            raw = await this.coordChat(meeting, [
                { role: "system", content: coordinatorSystemPrompt() },
                { role: "user", content: user + "\n\n上一次输出无法解析为 JSON。请严格只输出 {\"questions\":[{\"seat\":\"...\",\"question\":\"...\"},...]}。" },
            ], { temperature: 0.2, maxTokens: 20480, timeoutMs: 300_000 });
            parsed = extractJson(raw);
        }
        // 逐字段挽救：从截断 JSON 中提取已生成的 question 字段
        if (!parsed?.questions?.length) {
            console.warn(`[askCoordinatorBatch] 两次解析失败 round=${round} raw=`, raw.slice(0, 600));
        }
        // 构建结果：按 seats 顺序匹配，缺失的用通用兜底
        const questionMap = new Map();
        if (parsed?.questions) {
            for (const q of parsed.questions) {
                if (q.seat && q.question?.trim()) {
                    questionMap.set(q.seat, q.question.trim());
                }
            }
        }
        const results = seats.map((seat) => ({
            seat,
            question: questionMap.get(seat.id) || fallbackQ(seat),
        }));
        // 通知挽救情况
        const salvagedCount = seats.length - questionMap.size;
        if (salvagedCount > 0) {
            await emit({
                type: "notice",
                level: "warn",
                message: `统筹者第 ${round} 轮批量出题中 ${salvagedCount} 个席位的问题未能解析，已使用通用兜底问题。`,
            });
        }
        // 记录 coordHistory
        for (const { seat, question } of results) {
            meeting.coordHistory.push(`R${round} 致${seat.name}：${question}`);
        }
        return results;
    }
    /** 勘探席作答；流式时通过 reply_chunk 实时推送增量。remind=true 为解析失败后的非流式重试 */
    async askSeat(meeting, seat, round, question, emit, remind = false) {
        // 专项注入：席位 prompt 主体不变，仅追加 seatHint；segmentRange 阶段2 全填"全文"
        const seatSpecialty = meeting.specialty && meeting.specialty !== "general"
            ? getSpecialty(meeting.specialty)
            : undefined;
        const messages = [
            {
                role: "system",
                content: seatSystemPrompt(seat, meeting.goalType, {
                    seatHint: seatSpecialty?.seatHint,
                    segmentRange: meeting.activeSegment?.range ?? "全文",
                }),
            },
            {
                role: "user",
                content: `议题：${meeting.topic}\n范围：${meeting.scope}\n第${round}轮，统筹者向你提问：${question}\n请严格按输出协议作答。` +
                    (meeting.activeSegment
                        ? `\n\n本次只诊断以下文本段（范围：${meeting.activeSegment.range}），只针对该段原文作答，不要涉及段外内容：\n-----\n${meeting.activeSegment.text}\n-----`
                        : this.sourceTextBlock(meeting)) +
                    (remind
                        ? '\n\n上一次输出无法解析为 JSON。本次必须只输出 JSON 对象本身：{"description":"一句话边界描述","confidence":"high|medium|low"}，不要 Markdown 代码块、不要任何解释文字。'
                        : ""),
            },
        ];
        // 席位统一走非流式：部分上游代理（如 free 通道）的 SSE 会间歇挂起或只吐 [DONE]，
        // 非流式稳定可靠；发言内容仍通过 reply 事件整体下发，前端无逐字增量但结果一致。
        return this.chat(seat.provider, messages, { temperature: 0.2, maxTokens: 30000, model: seat.model, timeoutMs: 300_000 });
    }
    /**
     * 单场专项诊断（非分段、非 general）时，把待诊断原文整体注入席位/统筹者上下文。
     * 分段场景由 activeSegment 注入；general 议题没有待诊断原文。
     */
    sourceTextBlock(meeting) {
        if (meeting.activeSegment || !meeting.specialty || meeting.specialty === "general")
            return "";
        return `\n\n以下是待诊断的完整原文，所有提问与作答必须针对原文中的具体内容，禁止声称原文未提供：\n-----\n${meeting.question}\n-----`;
    }
    addBoundary(meeting, b) {
        const key = this.dedupKey(b.description);
        if (meeting.items.some((x) => this.dedupKey(x.description) === key))
            return null;
        this.adjudicateDirty = true;
        const item = {
            id: this.nextId(meeting.items),
            ...b,
            status: { kind: "kept" },
        };
        meeting.items.push(item);
        return item;
    }
    addUserBoundary(meeting, type, description, confidence = "high") {
        this.adjudicateDirty = true;
        const item = {
            id: this.nextId(meeting.items),
            type,
            description,
            confidence,
            source: "user",
            sourceModel: "user",
            round: 0,
            status: { kind: "kept" },
        };
        meeting.items.push(item);
        return item;
    }
    /** R3 收敛判定：先本地规则，再 LLM 复核 */
    async checkConvergence(meeting) {
        const recent = meeting.newPerRound.slice(-meeting.config.convergenceWindowN);
        if (recent.length < meeting.config.convergenceWindowN)
            return false;
        // 判据为「每席每轮新增率」；threshold>=1 视为旧版绝对条数配置，自动换算为比率
        const seatCount = Math.max(1, meeting.seats.length);
        const limit = meeting.config.convergenceThreshold >= 1
            ? meeting.config.convergenceThreshold / seatCount
            : meeting.config.convergenceThreshold;
        const localConverged = recent.every((n) => n / seatCount <= limit);
        if (!localConverged)
            return false;
        const raw = await this.coordChat(meeting, [
            { role: "system", content: coordinatorSystemPrompt() },
            {
                role: "user",
                content: coordinatorConvergeUser({
                    rounds: meeting.rounds,
                    newPerRound: meeting.newPerRound,
                    pool: this.poolDescription(meeting),
                }),
            },
        ], { temperature: 0.1, maxTokens: 8000, timeoutMs: 300_000 });
        return /true|是|收敛/.test(raw) && !/false|否|继续/.test(raw);
    }
    /** R2 裁决：保留 / 合并 / 否决，校验合并目标合法性 */
    async adjudicate(meeting, emit) {
        if (meeting.items.length === 0)
            return;
        const itemsPayload = meeting.items.map((b) => ({
            id: b.id,
            type: b.type,
            description: b.description,
        }));
        const messages = [
            { role: "system", content: coordinatorSystemPrompt() },
            { role: "user", content: coordinatorAdjudicateUser({ items: itemsPayload }) },
        ];
        let decisions = extractJson(await this.coordChat(meeting, messages, { temperature: 0.2, maxTokens: 40960, timeoutMs: 300_000 }));
        if (!Array.isArray(decisions)) {
            // 重试一次：强调只输出 JSON 数组
            decisions = extractJson(await this.coordChat(meeting, [
                ...messages,
                {
                    role: "user",
                    content: "上一次输出无法解析为 JSON 数组。请严格只输出 JSON 数组本身，不要 Markdown 代码块、不要任何解释文字，且必须覆盖全部条目。",
                },
            ], { temperature: 0.1, maxTokens: 40960, timeoutMs: 300_000 }));
        }
        if (!Array.isArray(decisions)) {
            // 裁决两次均失败：全部条目暂按保留处理，并显式告警（不再静默）
            await emit({
                type: "notice",
                level: "warn",
                message: "统筹者裁决输出两次均无法解析，全部条目暂按保留处理。",
            });
            return;
        }
        const validIds = new Set(meeting.items.map((b) => b.id));
        // 第一遍：确定每条的结论，非法裁决一律降级为"保留"
        const verdictOf = new Map();
        for (const d of decisions) {
            if (!d.id || !validIds.has(d.id))
                continue;
            if (d.verdict === "否决") {
                verdictOf.set(d.id, { kind: "rejected", reason: d.reason });
            }
            else if (d.verdict === "合并") {
                verdictOf.set(d.id, { kind: "merged", mergeInto: d.mergeInto ?? "", reason: d.reason });
            }
            else {
                verdictOf.set(d.id, { kind: "kept" });
            }
        }
        // 第二遍：校验合并目标（必须存在且为保留），否则降级为保留
        for (const [id, v] of verdictOf) {
            if (v.kind === "merged") {
                const target = v.mergeInto ? verdictOf.get(v.mergeInto) : undefined;
                if (!v.mergeInto || !validIds.has(v.mergeInto) || !target || target.kind !== "kept") {
                    verdictOf.set(id, { kind: "kept" });
                }
            }
        }
        for (const item of meeting.items) {
            const v = verdictOf.get(item.id);
            if (!v) {
                item.status = { kind: "kept" };
                continue;
            }
            if (v.kind === "rejected") {
                item.status = { kind: "rejected", reason: v.reason ?? "统筹者否决" };
            }
            else if (v.kind === "merged" && v.mergeInto) {
                const target = meeting.items.find((b) => b.id === v.mergeInto);
                item.status = { kind: "merged", mergedInto: v.mergeInto, reason: v.reason };
                if (target && !target.mergedFrom?.includes(item.id)) {
                    target.mergedFrom = [...(target.mergedFrom ?? []), item.id];
                }
            }
            else {
                item.status = { kind: "kept" };
            }
        }
        this.adjudicateDirty = false;
    }
    regenerateList(meeting) {
        const typeOrder = { 目标: 0, 约束: 1, 反例: 2, 前提: 3, 盲区: 4 };
        const items = [...meeting.items].sort((a, b) => {
            const statusOrder = (s) => s.kind === "kept" ? 0 : s.kind === "merged" ? 1 : 2;
            return (statusOrder(a.status) - statusOrder(b.status) ||
                typeOrder[a.type] - typeOrder[b.type] ||
                a.id.localeCompare(b.id));
        });
        return {
            items,
            rounds: meeting.rounds,
            convergence: meeting.convergence ?? "auto",
            disputesResolved: items.filter((b) => b.status.kind !== "kept").length,
            tokenEstimate: this.tokensUsed,
        };
    }
    /** 重新生成清单（池有变更时先重裁），供补充/手动追加后调用 */
    async regenerateListAsync(meeting) {
        if (this.adjudicateDirty) {
            this.runController = null; // 评审期调用不受勘探中断信号影响
            await this.adjudicate(meeting, async () => { });
        }
        return this.regenerateList(meeting);
    }
    // ============ R5 ============
    /** 手动追加一条用户边界（绕过模型） */
    addUserBoundaryById(meetingId, type, description, confidence = "high") {
        const m = this.meetings.get(meetingId);
        if (!m)
            return null;
        return this.addUserBoundary(m, type, description, confidence);
    }
    /**
     * 用户插话的语义分类（统筹者 LLM 判定）。
     * 显式 kind 优先；无法判定返回 other，由调用方向用户澄清，不擅自处理。
     */
    async classifyUserTurn(meetingId, content, explicit) {
        if (explicit)
            return explicit;
        const m = this.meetings.get(meetingId);
        if (!m)
            return { kind: "other" };
        const raw = await this.coordChat(m, [
            { role: "system", content: coordinatorSystemPrompt() },
            { role: "user", content: coordinatorClassifyUserTurnUser({ topic: m.topic ?? m.question, content }) },
        ], { temperature: 0.1, maxTokens: 8000, timeoutMs: 300_000 }).catch(() => "");
        const parsed = extractJson(raw);
        const kind = parsed?.kind;
        if (kind === "stop")
            return { kind: "stop" };
        if (kind === "supplement" && content.trim())
            return { kind: "supplement", supplement: content.trim().slice(0, 500) };
        if (kind === "new_boundary") {
            const rawType = parsed?.boundaryType;
            const type = ["目标", "约束", "反例", "前提", "盲区"].includes(rawType)
                ? rawType
                : "盲区";
            const desc = (parsed?.description || content).trim().slice(0, 300);
            return { kind: "new_boundary", item: { type, description: desc, confidence: "high" } };
        }
        return { kind: "other" };
    }
    /** 收敛后用户补充：并入议题，再跑 extraRounds 轮（同样支持即时停止与插话） */
    async continueWithSupplement(meetingId, supplement, emit, beforeRound) {
        const m = this.meetings.get(meetingId);
        if (!m)
            return null;
        this.runController = new AbortController();
        this.stopRequested = false;
        const localEmit = async (e) => {
            m.events.push(e);
            await emit(e);
        };
        const user = coordinatorSupplementUser({ topic: m.topic ?? "", scope: m.scope ?? "", supplement });
        const raw = await this.coordChat(m, [
            { role: "system", content: coordinatorSystemPrompt() },
            { role: "user", content: user },
        ], { temperature: 0.2, maxTokens: 12000, timeoutMs: 300_000 });
        const parsed = extractJson(raw);
        m.scope = parsed?.scope ?? `${m.scope}；补充：${supplement}`;
        m.objective += `；补充澄清：${supplement}`;
        await localEmit({ type: "user_message", content: supplement, kind: "supplement" });
        this.saveSnapshot(meetingId);
        let stopped = false;
        for (let i = 1; i <= m.config.extraRounds; i++) {
            const round = m.rounds + i;
            this.setState("interrogating", round);
            if (beforeRound) {
                for (const t of beforeRound()) {
                    m.pendingTurns.push(t);
                    await localEmit({
                        type: "user_message",
                        content: t.supplement ?? t.item?.description ?? "",
                        kind: t.kind,
                    });
                    if (t.kind === "new_boundary" && t.item) {
                        this.addUserBoundary(m, t.item.type, t.item.description, t.item.confidence);
                    }
                    else if (t.kind === "supplement" && t.supplement) {
                        m.scope += `；用户补充：${t.supplement}`;
                    }
                    else if (t.kind === "stop") {
                        stopped = true;
                    }
                }
            }
            if (stopped || this.stopRequested)
                break;
            const { newCount } = await this.runRound(m, round, localEmit);
            m.newPerRound.push(newCount);
            m.rounds = round;
            m.tokenEstimate = this.tokensUsed;
            await localEmit({ type: "round", round, newCount, tokenEstimate: this.tokensUsed });
        }
        m.convergence = this.stopRequested || stopped ? "user_stop" : "auto";
        await localEmit({ type: "converged", reason: m.convergence, rounds: m.rounds });
        this.runController = null;
        this.setState("adjudicating", m.rounds);
        // 与主勘探路径一致：裁决失败也要保证清单下发与落盘
        try {
            await this.adjudicate(m, localEmit);
        }
        catch (adjErr) {
            await localEmit({
                type: "notice",
                level: "warn",
                message: `自动裁决请求失败（${adjErr.message}），全部边界暂按「保留」入清单，可稍后人工复核或重新出方案。`,
            });
        }
        const list = this.regenerateList(m);
        await localEmit({ type: "list", list });
        this.saveSnapshot(meetingId);
        this.setState("reviewing", m.rounds);
        return list;
    }
    /**
     * 代码预填 finalTemplate：把代码可算的占位符（范围/轮数/统计/拆分章节标记等）先替换掉，
     * 其余 {{xxx}} 留给终局 LLM。partial=true 时范围按已完成段收敛。
     */
    buildFinalTemplate(m, template, opts) {
        const totalItems = m.items.length;
        let keptCount = 0;
        let mergedCount = 0;
        let rejectedCount = 0;
        let coveredSeg;
        for (const it of m.items) {
            if (opts.partial && it.segment != null) {
                if (coveredSeg == null || it.segment > coveredSeg)
                    coveredSeg = it.segment;
            }
            if (it.status.kind === "kept")
                keptCount++;
            else if (it.status.kind === "merged")
                mergedCount++;
            else
                rejectedCount++;
        }
        // 范围描述：分段会议拼接已完成段范围，单场会议用勘探 scope
        let scope;
        let segmentRange;
        if (m.batch) {
            const n = opts.partial ? coveredSeg ?? m.batch.completed : m.batch.segmentRanges.length;
            const ranges = m.batch.segmentRanges.slice(0, n);
            scope = opts.partial
                ? `已完成 ${n}/${m.batch.total} 段`
                : `全文 ${m.batch.total} 段（约 ${m.question.length} 字）`;
            segmentRange = ranges.length
                ? ranges.map((r, i) => `${i + 1}. ${r}`).join("\n")
                : "（暂无已完成段）";
        }
        else {
            scope = m.scope ?? m.question.slice(0, 80);
            segmentRange = "全文";
        }
        const values = {
            topic: m.topic ?? "",
            objective: m.objective ?? "",
            scope,
            segmentRange,
            rounds: String(m.rounds),
            totalItems: String(totalItems),
            keptCount: String(keptCount),
            mergedCount: String(mergedCount),
            rejectedCount: String(rejectedCount),
        };
        let out = template.replace(/\{\{(\w+)\}\}/g, (whole, key) => key in values ? values[key] : whole);
        // 拆分模式：逐段/逐章清单由代码生成，占位为稳定标记
        if (opts.splitMode) {
            let replaced = false;
            out = out.replace(/\{\{(?:chapterIssues|highRiskSegments)\}\}/g, () => {
                replaced = true;
                return SEGMENT_SECTIONS_MARKER;
            });
            // 模板中没有对应占位符时，追加到末尾
            if (!replaced)
                out = `${out.trimEnd()}\n\n${SEGMENT_SECTIONS_MARKER}\n`;
        }
        return out;
    }
    /** R5 终局：只把裁决保留（kept）的边界喂给终局，否决/合并不作为依据 */
    async finalSolution(meetingId) {
        const m = this.meetings.get(meetingId);
        if (!m)
            throw new Error("会议不存在");
        this.setState("finalizing", m.rounds);
        const kept = m.items.filter((b) => b.status.kind === "kept");
        const tpl = getSpecialty(m.specialty ?? "general") ?? getSpecialty("general");
        const baseMessages = [
            { role: "system", content: coordinatorSystemPrompt() },
            {
                role: "user",
                content: coordinatorFinalTemplateUser({
                    topic: m.topic ?? "",
                    objective: m.objective ?? "",
                    template: this.buildFinalTemplate(m, tpl.finalTemplate, { partial: false }),
                    list: kept,
                    sourceText: !m.batch && m.specialty && m.specialty !== "general" ? m.question : undefined,
                    seedDimensionsText: m.seedDimensionsText,
                }),
            },
        ];
        try {
            // maxTokens 给足 81920：free 通道后端模型随机且思考链与正文共享预算，预算不足时正文可能为空
            let content = (await this.coordChat(m, baseMessages, {
                temperature: 0.5,
                maxTokens: 81920,
                timeoutMs: 600_000,
            })).trim();
            // 空返回兜底：重试一次并强调直接输出正文
            if (!content) {
                console.warn(`[finalSolution] seat=coordinator meeting=${meetingId} 首次空返回，重试一次`);
                content = (await this.coordChat(m, [
                    ...baseMessages,
                    {
                        role: "user",
                        content: "上一次返回内容为空（可能思考过程耗尽了输出额度）。请不要再进行长段思考，依据报告模板骨架直接输出完整的 Markdown 报告正文，并替换其中全部占位符。",
                    },
                ], { temperature: 0.5, maxTokens: 81920, timeoutMs: 600_000 })).trim();
            }
            if (!content) {
                throw new Error("终局模型连续两次空返回（思考预算耗尽或上游异常），请稍后重试，或更换统筹者模型");
            }
            m.finalSolution = content;
            m.events.push({ type: "final", solution: content });
            this.setState("finalized", m.rounds);
            this.saveSnapshot(meetingId);
            return content;
        }
        catch (err) {
            // 任何失败（网络/超时/空返回）都必须回滚相位，否则会议卡死在 finalizing：
            // 不重启服务就无法再次出方案，重绑/刷新后还会被当成「勘探尚未结束」
            this.setState("reviewing", m.rounds);
            this.saveSnapshot(meetingId);
            throw err;
        }
    }
    /** 会议快照（状态与时间戳由编排器内部维护） */
    snapshot(meetingId) {
        const m = this.meetings.get(meetingId);
        if (!m)
            return null;
        return {
            meetingId: m.meetingId,
            question: m.question,
            topic: m.topic,
            objective: m.objective,
            scope: m.scope,
            goalType: m.goalType,
            specialty: m.specialty,
            state: this.state,
            items: m.items,
            list: this.regenerateList(m),
            events: m.events,
            convergence: m.convergence,
            rounds: m.rounds,
            // 分段会议：子会议勘探会重置 tokensUsed，快照须取会议自身累计值
            tokenEstimate: m.batch ? m.tokenEstimate : this.tokensUsed,
            finalSolution: m.finalSolution,
            batch: m.batch,
            seedDimensionsText: m.seedDimensionsText,
            createdAt: this.state.startedAt ?? new Date().toISOString(),
            updatedAt: this.state.updatedAt || new Date().toISOString(),
        };
    }
}
