import { getRuntime, getSeatConfigs } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { chat, chatStream } from "./llm.js";
import {
  coordinatorSystemPrompt,
  coordinatorOpeningUser,
  coordinatorQuestionUser,
  coordinatorConvergeUser,
  coordinatorAdjudicateUser,
  coordinatorSupplementUser,
  coordinatorFinalUser,
  coordinatorClassifyUserTurnUser,
  seatSystemPrompt,
} from "./prompts.js";
import { persistSnapshot } from "./snapshot.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  BoundaryItem,
  BoundaryList,
  BoundaryType,
  Confidence,
  GoalType,
  MeetingEvent,
  MeetingState,
  MeetingSnapshot,
  SeatConfig,
  UserTurnResult,
} from "./types.js";

interface MeetingRecord {
  meetingId: string;
  question: string;
  objective?: string;
  scope?: string;
  topic?: string;
  goalType: GoalType;
  events: MeetingEvent[];
  items: BoundaryItem[];
  coordHistory: string[];
  newPerRound: number[];
  convergence: BoundaryList["convergence"] | null;
  rounds: number;
  tokenEstimate: number;
  finalSolution?: string;
  pendingTurns: UserTurnResult[];
  /** 本会议开跑时的配置快照：页面改配置不影响进行中的会议 */
  seats: SeatConfig[];
  config: RuntimeConfig;
}

export interface ExplorationOptions {
  meetingId: string;
  question: string;
  emit: (e: MeetingEvent) => void | Promise<void>;
  beforeRound?: () => UserTurnResult[];
  stream?: boolean;
}

/** 括号平衡的 JSON 提取：从首个 { 或 [ 开始扫描，处理字符串与转义，返回首个平衡片段 */
export function extractJson(raw: string): unknown | null {
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  let start = -1;
  let openCh = "{";
  if (startObj === -1 && startArr === -1) return null;
  if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
    start = startObj;
    openCh = "{";
  } else {
    start = startArr;
    openCh = "[";
  }
  const closeCh = openCh === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeConfidence(v: unknown): Confidence {
  if (v === "high" || v === "高") return "high";
  if (v === "low" || v === "低") return "low";
  if (v === "medium" || v === "中") return "medium";
  return "medium";
}

const GOAL_TYPES: GoalType[] = ["enumerate", "judge", "design", "diagnose", "other"];

function normalizeGoalType(v: unknown): GoalType {
  return typeof v === "string" && (GOAL_TYPES as string[]).includes(v) ? (v as GoalType) : "other";
}

/**
 * 流式明文化：扫描累计文本中指定字符串字段「已生成部分」解码后的明文
 * （允许字符串尚未闭合，典型场景为 maxTokens 截断的残损 JSON）。
 */
export function scanStringFieldPrefix(raw: string, field: string): string {
  const objStart = raw.indexOf("{");
  if (objStart === -1) return "";
  const m = new RegExp(`\\{\\s*"${field}"\\s*:\\s*"`, "y");
  m.lastIndex = objStart;
  if (!m.test(raw)) return "";
  let out = "";
  for (let i = m.lastIndex; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') return out; // 字段闭合：完整明文
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break; // 转义符刚生成，等后续字符
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/" };
      if (next === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += (JSON.parse(`"\\u${hex}"`) as string);
          i += 5;
        } else break;
      } else {
        out += map[next] ?? next;
        i += 1;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** 流式渲染专用：抠 description 字段明文 */
export function scanDescriptionPrefix(raw: string): string {
  return scanStringFieldPrefix(raw, "description");
}

/** 把截断在句尾的文本裁到最后一个完整分句（逗号/顿号/分号处），避免挽救出半句话 */
function trimToLastClause(s: string): string {
  const m = /^[\s\S]*[，、；,;]/.exec(s.trim());
  return (m ? m[0].slice(0, -1) : s).trim();
}

interface ParsedSeatReply {
  description: string;
  confidence: Confidence;
  /** true = 非协议 JSON，系从残损 JSON/标注答案/纯文本挽救而来 */
  salvaged: boolean;
  /** true = 引号污染容忍修复：正文与可信度均完整恢复，无需降级提示 */
  repaired?: boolean;
}

const CJK_RE = /[一-鿿]/g;

/** 统计汉字数量，用于识别「英文思考链」式输出 */
function cjkCount(s: string): number {
  return (s.match(CJK_RE) ?? []).length;
}

/** 从一段文本中取出首个长度足够的完整中文句子（到中文句号/问号/引号为止） */
function firstChineseSentence(s: string, minLen = 10): string {
  const m = /[一-鿿][\s\S]{8,}?[。！？…”」』]/.exec(s);
  const sentence = m?.[0]?.trim();
  return sentence && sentence.length >= minLen ? sentence : "";
}

/**
 * 弱模型常先输出大段英文思考链、最后用 `Description: "..."`（或「描述：」）给出答案。
 * 取最后一个标注之后的内容，优先引号内，否则取首个完整中文句子。
 */
function salvageLabeledDescription(raw: string): string {
  const labels = [...raw.matchAll(/description|描述|边界描述/gi)];
  for (let k = labels.length - 1; k >= 0; k--) {
    const tail = raw.slice(labels[k].index! + labels[k][0].length);
    const m = /^\s*[：:]\s*["“']?\s*([\s\S]*)$/.exec(tail);
    if (!m) continue;
    // 直接在标注后的整段文本上找首个完整中文句子（结尾标点不会与描述内部的开引号 “ 冲突）
    const sentence = firstChineseSentence(m[1], 10);
    if (sentence) return sentence;
    const rest = m[1].trim();
    if (cjkCount(rest) >= 10) return rest.replace(/\s+/g, " ").slice(0, 500);
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
function tolerantSeatJson(raw: string): { description: string; confidence: Confidence } | null {
  const m = /"description"\s*:\s*"([\s\S]*?)"\s*,\s*"confidence"\s*:\s*"(high|medium|low|高|中|低)"/i.exec(
    raw,
  );
  if (!m) return null;
  const desc = m[1].replace(/\s+/g, " ").trim();
  if (desc.length < 8 || cjkCount(desc) < 6) return null;
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
function parseSeatReply(raw: string): ParsedSeatReply | null {
  const parsed = extractJson(raw) as { description?: unknown; confidence?: unknown } | null;
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
function salvageQuestion(raw: string): string {
  const matches = [...raw.matchAll(/[一-鿿][^。！？\n\r]{6,200}[？?]/g)];
  const q = matches[matches.length - 1]?.[0]?.trim();
  if (q && q.length >= 12) return q;
  // 陈述式挽救：取「问题：」「请问」「请补充/请指出/请说明/请提出」之后的内容
  const labeled = [...raw.matchAll(/(?:问题\s*[：:]|请问|请(?:提出|补充|指出|说明|给出))\s*([一-鿿][^\n\r。！？*"{}]{8,180})/g)];
  const tail = labeled[labeled.length - 1]?.[1]?.trim();
  if (tail && tail.length >= 12) return tail;
  return "";
}

export class Orchestrator {
  private meetings = new Map<string, MeetingRecord>();
  private streams = new Set<(e: MeetingEvent) => void>();
  readonly stream: boolean;

  // 运行期状态
  private state: MeetingState = { phase: "idle", round: 0, updatedAt: "" };
  private startedAt?: string;
  private finishedAt?: string;
  private finalizedAt?: string;
  private errorAt?: string;
  private stopRequested = false;
  private runController: AbortController | null = null;
  private tokensUsed = 0;
  /** 自上次裁决后边界池是否有变更（新增/合并/用户追加） */
  private adjudicateDirty = true;

  constructor(opts?: { stream?: boolean }) {
    this.stream = opts?.stream ?? false;
  }

  /** 从磁盘快照恢复最近一次的会议（服务重启后调用） */
  restoreLatestSnapshot(meetingsDir: string): { meetingId: string; snapshot: MeetingSnapshot } | null {
    try {
      const files = readdirSync(meetingsDir)
        .filter((f) => f.endsWith("-snapshot.json"))
        .map((f) => {
          const path = join(meetingsDir, f);
          const stat = statSync(path);
          return { name: f, path, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime); // 最新的在前

      if (files.length === 0) return null;

      const latest = files[0];
      const raw = readFileSync(latest.path, "utf-8");
      const snap = JSON.parse(raw) as MeetingSnapshot;

      // 恢复 MeetingRecord
      const meeting: MeetingRecord = {
        meetingId: snap.meetingId,
        question: snap.question,
        topic: snap.topic,
        objective: snap.objective,
        scope: snap.scope,
        goalType: snap.goalType ?? "other",
        // 愈合：丢弃空方案的 final 事件（旧版本空返回也会落事件，回放会显示空的「最终解决方案」块）
        events: (snap.events ?? []).filter((e) => e.type !== "final" || !!(e as { solution?: string }).solution?.trim()),
        items: snap.items ?? [],
        coordHistory: [], // 快照里没有，置空
        newPerRound: [], // 快照里没有，置空
        convergence: snap.convergence,
        rounds: snap.rounds,
        tokenEstimate: snap.tokenEstimate ?? 0,
        finalSolution: snap.finalSolution,
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
      this.setState(phase, snap.rounds);
      this.startedAt = snap.state?.startedAt;
      this.finishedAt = snap.state?.finishedAt;
      this.finalizedAt = snap.state?.finalizedAt;
      this.tokensUsed = snap.tokenEstimate ?? 0;

      return { meetingId: snap.meetingId, snapshot: snap };
    } catch (err) {
      console.error("恢复快照失败:", err);
      return null;
    }
  }

  private setState(phase: MeetingState["phase"], round?: number) {
    if (phase === "interrogating" && !this.startedAt) this.startedAt = new Date().toISOString();
    if (phase === "reviewing") this.finishedAt = new Date().toISOString();
    if (phase === "finalized") this.finalizedAt = new Date().toISOString();
    if (phase === "error") this.errorAt = new Date().toISOString();
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
  private recordCall(inputChars: number, output: string) {
    this.tokensUsed += Math.ceil(inputChars / 1.5) + Math.ceil(output.length / 1.5);
  }

  /** 落盘失败不影响会议主流程 */
  private saveSnapshot(meetingId: string) {
    try {
      persistSnapshot(meetingId, () => this.snapshot(meetingId));
    } catch {
      /* 忽略持久化失败 */
    }
  }

  /** 统筹者对话：provider/模型覆盖均取自会议配置快照 */
  private coordChat(meeting: MeetingRecord, messages: { role: "system" | "user" | "assistant"; content: string }[], opts?: {
    temperature?: number;
    maxTokens?: number;
    fallbackReasoning?: boolean;
    timeoutMs?: number;
  }): Promise<string> {
    return this.chat(meeting.config.coordinatorProvider, messages, {
      ...opts,
      model: meeting.config.coordinatorModel,
    });
  }

  async chat(providerId: string, messages: { role: "system" | "user" | "assistant"; content: string }[], opts?: {
    temperature?: number;
    maxTokens?: number;
    fallbackReasoning?: boolean;
    model?: string;
    timeoutMs?: number;
  }): Promise<string> {
    const input = messages.reduce((n, m) => n + m.content.length, 0);
    const out = await chat(providerId, messages, { ...opts, signal: this.runController?.signal });
    this.recordCall(input, out);
    return out;
  }

  async chatStream(
    providerId: string,
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    onChunk: (delta: string) => void,
    opts?: { temperature?: number; maxTokens?: number; model?: string; timeoutMs?: number },
  ): Promise<string> {
    const input = messages.reduce((n, m) => n + m.content.length, 0);
    const out = await chatStream(providerId, messages, onChunk, { ...opts, signal: this.runController?.signal });
    this.recordCall(input, out);
    return out;
  }

  onEvent(fn: (e: MeetingEvent) => void) {
    this.streams.add(fn);
    return () => this.streams.delete(fn);
  }

  getMeeting(meetingId: string): MeetingRecord | undefined {
    return this.meetings.get(meetingId);
  }

  getEvents(meetingId: string): MeetingEvent[] {
    return this.meetings.get(meetingId)?.events ?? [];
  }

  private nextId(items: BoundaryItem[]): string {
    const n = items.length + 1;
    return `B${String(n).padStart(3, "0")}`;
  }

  private dedupKey(description: string): string {
    return description.trim().replace(/[，。,.\s]/g, "").slice(0, 40);
  }

  /** R0 开题 */
  async runExploration(opts: ExplorationOptions): Promise<BoundaryList> {
    const { meetingId, question, emit, beforeRound } = opts;
    this.runController = new AbortController();
    this.stopRequested = false;
    this.tokensUsed = 0;
    this.adjudicateDirty = true;

    const meeting: MeetingRecord = {
      meetingId,
      question,
      goalType: "other",
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
    };
    this.meetings.set(meetingId, meeting);
    this.setState("interrogating", 0);

    const localEmit = async (e: MeetingEvent) => {
      meeting.events.push(e);
      await emit(e);
    };

    try {
      // 统筹者开题（首次）
      let openingRaw = await this.coordChat(
        meeting,
        [
          { role: "system", content: coordinatorSystemPrompt() },
          { role: "user", content: coordinatorOpeningUser({ question }) },
        ],
        { temperature: 0.2, maxTokens: 15000, timeoutMs: 300_000 },
      );
      let opening = extractJson(openingRaw) as
        | { topic?: string; objective?: string; scope?: string; goalType?: unknown }
        | null;
      // 解析失败：针对性重试一次
      if (!opening) {
        openingRaw = await this.coordChat(
          meeting,
          [
            { role: "system", content: coordinatorSystemPrompt() },
            {
              role: "user",
              content:
                coordinatorOpeningUser({ question }) +
                '\n\n上一次输出无法解析为 JSON。请严格只输出 JSON 对象本身：{"topic":"...","objective":"...","goalType":"enumerate|judge|design|diagnose|other","scope":"..."}，不要 Markdown 代码块、不要任何解释文字。',
            },
          ],
          { temperature: 0.2, maxTokens: 15000, timeoutMs: 300_000 },
        );
        opening = extractJson(openingRaw) as
          | { topic?: string; objective?: string; scope?: string; goalType?: unknown }
          | null;
      }
      // 仍失败（多为思考链占满 token 导致 JSON 截断）：从残片里逐字段正则挽救
      if (!opening) {
        console.warn("[opening] 两次解析失败 raw=", openingRaw.slice(0, 600));
        const grab = (key: string): string | undefined => {
          const m = openingRaw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\]){4,})`, "i"));
          if (!m?.[1]) return undefined;
          try {
            return JSON.parse(`"${m[1].slice(0, 300)}"`);
          } catch {
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
      let convergence: BoundaryList["convergence"] | null = null;
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
            } else if (t.kind === "supplement" && t.supplement) {
              meeting.scope += `；用户补充：${t.supplement}`;
            } else if (t.kind === "stop") {
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

      if (!convergence) convergence = stopped ? "user_stop" : "max_rounds";
      meeting.convergence = convergence;
      await localEmit({ type: "converged", reason: convergence, rounds: meeting.rounds });

      // R2 裁决（循环结束后统一执行；不再使用可能已被取消的 runController 信号）
      this.runController = null;
      this.setState("adjudicating", meeting.rounds);
      // 裁决失败（如模型请求超时）不得阻断清单下发：边界已在勘探阶段入池，必须保证清单可见、可落盘
      try {
        await this.adjudicate(meeting, localEmit);
      } catch (adjErr) {
        await localEmit({
          type: "notice",
          level: "warn",
          message: `自动裁决请求失败（${(adjErr as Error).message}），全部边界暂按「保留」入清单，可稍后人工复核或重新出方案。`,
        });
      }

      const list = this.regenerateList(meeting);
      await localEmit({ type: "list", list });
      // 先置 reviewing 再落盘：快照相位必须是终态，否则重启恢复后会被当成「勘探未完成」
      this.setState("reviewing", meeting.rounds);
      this.saveSnapshot(meeting.meetingId);

      return list;
    } catch (err) {
      if (this.stopRequested) {
        meeting.convergence = "user_stop";
        await localEmit({ type: "converged", reason: "user_stop", rounds: meeting.rounds });
        this.runController = null;
        this.setState("adjudicating", meeting.rounds);
        await this.adjudicate(meeting, localEmit).catch(() => {});
        const list = this.regenerateList(meeting);
        await localEmit({ type: "list", list });
        this.setState("reviewing", meeting.rounds);
        this.saveSnapshot(meeting.meetingId);
        return list;
      }
      this.setState("error", meeting.rounds);
      await localEmit({ type: "error", message: `勘探失败：${(err as Error).message}` });
      throw err;
    } finally {
      this.runController = null;
    }
  }

  /** 单轮：统筹者对每席生成问题 → 席位回答 → 入池。用户停止时立即中断。 */
  private async runRound(
    meeting: MeetingRecord,
    round: number,
    emit: (e: MeetingEvent) => Promise<void>,
  ): Promise<{ newCount: number }> {
    let newCount = 0;
    for (const seat of meeting.seats) {
      if (this.stopRequested) break;
      try {
        const question = await this.askCoordinator(meeting, seat, round, emit);
        await emit({ type: "question", round, seat: seat.id, question });

        let reply = await this.askSeat(meeting, seat, round, question, emit);
        let parsedReply = parseSeatReply(reply);

        // 首次解析失败：区分「空返回」（思考预算耗尽/上游异常）与「格式不合规」
        let retried = false;
        if (!parsedReply && !this.stopRequested) {
          retried = true;
          const emptyFirst = !reply.trim();
          // 首次失败即留证 raw：重答成功的病例（首败次成）此前完全无据可查
          console.warn(
            `[seatReply:first] seat=${seat.id} round=${round} empty=${emptyFirst} raw=`,
            reply.slice(0, 300),
          );
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
        // 重答后仍非标准 JSON（含仅靠原文挽救）：留证 raw，便于定位思考链/截断/纯文本
        if (retried && (!parsedReply || parsedReply.salvaged) && !this.stopRequested) {
          console.warn(
            `[seatReply:retry] seat=${seat.id} round=${round} empty=${!reply.trim()} salvaged=${!!parsedReply} raw=`,
            reply.slice(0, 500),
          );
        }

        if (parsedReply) {
          if (parsedReply.salvaged) {
            await emit({
              type: "notice",
              level: parsedReply.repaired ? "info" : "warn",
              seat: seat.id,
              message: parsedReply.repaired
                ? `「${seat.name}」第 ${round} 轮发言的 JSON 正文内含未转义引号，已自动修复并完整收录（保留原可信度）。`
                : `「${seat.name}」第 ${round} 轮发言仍非标准 JSON，已按原文挽救收录（可信度降为「中」）。`,
            });
          }
          // 用最终可解析的原文校正发言块（重试时前端无流式块，直接展示）
          await emit({ type: "reply", round, seat: seat.id, content: reply });
          const added = this.addBoundary(meeting, {
            type: seat.type, // 类型以席位绑定为准，忽略模型自报
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
        } else {
          // 两次均无有效内容：显式告知，避免发言静默丢失
          await emit({ type: "reply", round, seat: seat.id, content: "" });
          await emit({
            type: "notice",
            level: "warn",
            seat: seat.id,
            message: `「${seat.name}」第 ${round} 轮两次发言均无法解析且无可用内容，本轮该席无新增边界。`,
          });
        }
      } catch (err) {
        if (this.stopRequested) break;
        await emit({
          type: "error",
          message: `席位 ${seat.name} 本轮失败：${(err as Error).message}`,
          seat: seat.id,
        });
      }
    }
    return { newCount };
  }

  private poolDescription(meeting: MeetingRecord): string {
    if (meeting.items.length === 0) return "（暂无）";
    return meeting.items
      .map((b) => `- [${b.type}] ${b.description}`)
      .join("\n");
  }

  /** 统筹者向某席生成针对性问题（解析失败时针对性重试一次，仍失败则通用问题兜底并告警） */
  private async askCoordinator(
    meeting: MeetingRecord,
    seat: SeatConfig,
    round: number,
    emit: (e: MeetingEvent) => Promise<void>,
  ): Promise<string> {
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
    });
    let raw = await this.coordChat(
      meeting,
      [
        { role: "system", content: coordinatorSystemPrompt() },
        { role: "user", content: user },
      ],
      { temperature: 0.2, maxTokens: 20480, timeoutMs: 300_000 },
    );
    let parsed = extractJson(raw) as { question?: string } | null;
    if (!parsed?.question) {
      raw = await this.coordChat(
        meeting,
        [
          { role: "system", content: coordinatorSystemPrompt() },
          { role: "user", content: user + "\n\n上一次输出无法解析为 JSON。请严格只输出 {\"question\":\"...\"}。" },
        ],
        { temperature: 0.2, maxTokens: 20480, timeoutMs: 300_000 },
      );
      parsed = extractJson(raw) as { question?: string } | null;
    }
    // 两次 JSON 均失败（或 question 为空串/纯空白）：
    // ① 先从截断 JSON 的 "question" 字段挽救已生成明文；② 再找自由文本问句；③ 通用兜底
    const parsedQuestion = typeof parsed?.question === "string" ? parsed.question.trim() : "";
    let fieldSalvaged = "";
    if (!parsedQuestion) {
      fieldSalvaged = trimToLastClause(scanStringFieldPrefix(raw, "question"));
      if (fieldSalvaged.length < 12) fieldSalvaged = "";
    }
    const salvagedQuestion = !parsedQuestion && !fieldSalvaged ? salvageQuestion(raw) : "";
    const fallback = !parsedQuestion && !fieldSalvaged && !salvagedQuestion;
    if (fallback) {
      // 留证：把模型原始返回（截断）打到服务端日志，便于定位是思考链截断还是格式跑偏
      console.warn(`[askCoordinator] 两次解析失败 seat=${seat.id} round=${round} raw=`, raw.slice(0, 500));
    }
    const q =
      parsedQuestion ||
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
    } else if (salvagedQuestion) {
      await emit({
        type: "notice",
        level: "warn",
        seat: seat.id,
        message: `统筹者对「${seat.name}」第 ${round} 轮的盘问未按 JSON 输出，已从原文挽救问句。`,
      });
    } else if (fallback) {
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

  /** 勘探席作答；流式时通过 reply_chunk 实时推送增量。remind=true 为解析失败后的非流式重试 */
  private async askSeat(
    meeting: MeetingRecord,
    seat: SeatConfig,
    round: number,
    question: string,
    emit: (e: MeetingEvent) => Promise<void>,
    remind = false,
  ): Promise<string> {
    const messages = [
      { role: "system" as const, content: seatSystemPrompt(seat, meeting.goalType) },
      {
        role: "user" as const,
        content:
          `议题：${meeting.topic}\n范围：${meeting.scope}\n第${round}轮，统筹者向你提问：${question}\n请严格按输出协议作答。` +
          (remind
            ? '\n\n上一次输出无法解析为 JSON。本次必须只输出 JSON 对象本身：{"description":"一句话边界描述","confidence":"high|medium|low"}，不要 Markdown 代码块、不要任何解释文字。'
            : ""),
      },
    ];
    if (this.stream && !remind) {
      // 累计原始输出，仅把 description 字段的明文增量推给前端（不裸渲 JSON）
      let raw = "";
      let emitted = "";
      return this.chatStream(
        seat.provider,
        messages,
        (delta) => {
          raw += delta;
          const plain = scanDescriptionPrefix(raw);
          if (plain.length > emitted.length) {
            void emit({ type: "reply_chunk", round, seat: seat.id, delta: plain.slice(emitted.length) });
            emitted = plain;
          }
        },
        { temperature: 0.2, maxTokens: 30000, model: seat.model, timeoutMs: 300_000 },
      );
    }
    return this.chat(seat.provider, messages, { temperature: 0.2, maxTokens: 30000, model: seat.model, timeoutMs: 300_000 });
  }

  private addBoundary(meeting: MeetingRecord, b: Omit<BoundaryItem, "id" | "status">): BoundaryItem | null {
    const key = this.dedupKey(b.description);
    if (meeting.items.some((x) => this.dedupKey(x.description) === key)) return null;
    this.adjudicateDirty = true;
    const item: BoundaryItem = {
      id: this.nextId(meeting.items),
      ...b,
      status: { kind: "kept" },
    };
    meeting.items.push(item);
    return item;
  }

  private addUserBoundary(
    meeting: MeetingRecord,
    type: BoundaryType,
    description: string,
    confidence: Confidence = "high",
  ): BoundaryItem {
    this.adjudicateDirty = true;
    const item: BoundaryItem = {
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
  private async checkConvergence(meeting: MeetingRecord): Promise<boolean> {
    const recent = meeting.newPerRound.slice(-meeting.config.convergenceWindowN);
    if (recent.length < meeting.config.convergenceWindowN) return false;
    // 判据为「每席每轮新增率」；threshold>=1 视为旧版绝对条数配置，自动换算为比率
    const seatCount = Math.max(1, meeting.seats.length);
    const limit =
      meeting.config.convergenceThreshold >= 1
        ? meeting.config.convergenceThreshold / seatCount
        : meeting.config.convergenceThreshold;
    const localConverged = recent.every((n) => n / seatCount <= limit);
    if (!localConverged) return false;
    const raw = await this.coordChat(
      meeting,
      [
        { role: "system", content: coordinatorSystemPrompt() },
        {
          role: "user",
          content: coordinatorConvergeUser({
            rounds: meeting.rounds,
            newPerRound: meeting.newPerRound,
            pool: this.poolDescription(meeting),
          }),
        },
      ],
      { temperature: 0.1, maxTokens: 8000, timeoutMs: 300_000 },
    );
    return /true|是|收敛/.test(raw) && !/false|否|继续/.test(raw);
  }

  /** R2 裁决：保留 / 合并 / 否决，校验合并目标合法性 */
  private async adjudicate(meeting: MeetingRecord, emit: (e: MeetingEvent) => Promise<void>) {
    if (meeting.items.length === 0) return;
    const itemsPayload = meeting.items.map((b) => ({
      id: b.id,
      type: b.type,
      description: b.description,
    }));
    const messages = [
      { role: "system" as const, content: coordinatorSystemPrompt() },
      { role: "user" as const, content: coordinatorAdjudicateUser({ items: itemsPayload }) },
    ];
    let decisions = extractJson(
      await this.coordChat(meeting, messages, { temperature: 0.2, maxTokens: 40960, timeoutMs: 300_000 }),
    ) as { id?: string; verdict?: string; mergeInto?: string; reason?: string }[] | null;
    if (!Array.isArray(decisions)) {
      // 重试一次：强调只输出 JSON 数组
      decisions = extractJson(
        await this.coordChat(
          meeting,
          [
            ...messages,
            {
              role: "user" as const,
              content:
                "上一次输出无法解析为 JSON 数组。请严格只输出 JSON 数组本身，不要 Markdown 代码块、不要任何解释文字，且必须覆盖全部条目。",
            },
          ],
          { temperature: 0.1, maxTokens: 40960, timeoutMs: 300_000 },
        ),
      ) as { id?: string; verdict?: string; mergeInto?: string; reason?: string }[] | null;
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
    const verdictOf = new Map<string, { kind: "kept" | "merged" | "rejected"; mergeInto?: string; reason?: string }>();
    for (const d of decisions) {
      if (!d.id || !validIds.has(d.id)) continue;
      if (d.verdict === "否决") {
        verdictOf.set(d.id, { kind: "rejected", reason: d.reason });
      } else if (d.verdict === "合并") {
        verdictOf.set(d.id, { kind: "merged", mergeInto: d.mergeInto ?? "", reason: d.reason });
      } else {
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
      } else if (v.kind === "merged" && v.mergeInto) {
        const target = meeting.items.find((b) => b.id === v.mergeInto);
        item.status = { kind: "merged", mergedInto: v.mergeInto, reason: v.reason };
        if (target && !target.mergedFrom?.includes(item.id)) {
          target.mergedFrom = [...(target.mergedFrom ?? []), item.id];
        }
      } else {
        item.status = { kind: "kept" };
      }
    }
    this.adjudicateDirty = false;
  }

  private regenerateList(meeting: MeetingRecord): BoundaryList {
    const typeOrder: Record<BoundaryType, number> = { 目标: 0, 约束: 1, 反例: 2, 前提: 3, 盲区: 4 };
    const items = [...meeting.items].sort((a, b) => {
      const statusOrder = (s: BoundaryItem["status"]) =>
        s.kind === "kept" ? 0 : s.kind === "merged" ? 1 : 2;
      return (
        statusOrder(a.status) - statusOrder(b.status) ||
        typeOrder[a.type] - typeOrder[b.type] ||
        a.id.localeCompare(b.id)
      );
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
  async regenerateListAsync(meeting: MeetingRecord): Promise<BoundaryList> {
    if (this.adjudicateDirty) {
      this.runController = null; // 评审期调用不受勘探中断信号影响
      await this.adjudicate(meeting, async () => {});
    }
    return this.regenerateList(meeting);
  }

  // ============ R5 ============

  /** 手动追加一条用户边界（绕过模型） */
  addUserBoundaryById(
    meetingId: string,
    type: BoundaryType,
    description: string,
    confidence: Confidence = "high",
  ): BoundaryItem | null {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    return this.addUserBoundary(m, type, description, confidence);
  }

  /**
   * 用户插话的语义分类（统筹者 LLM 判定）。
   * 显式 kind 优先；无法判定返回 other，由调用方向用户澄清，不擅自处理。
   */
  async classifyUserTurn(meetingId: string, content: string, explicit?: UserTurnResult): Promise<UserTurnResult> {
    if (explicit) return explicit;
    const m = this.meetings.get(meetingId);
    if (!m) return { kind: "other" };
    const raw = await this.coordChat(
      m,
      [
        { role: "system", content: coordinatorSystemPrompt() },
        { role: "user", content: coordinatorClassifyUserTurnUser({ topic: m.topic ?? m.question, content }) },
      ],
      { temperature: 0.1, maxTokens: 8000, timeoutMs: 300_000 },
    ).catch(() => "");
    const parsed = extractJson(raw) as
      | { kind?: string; boundaryType?: string; description?: string }
      | null;
    const kind = parsed?.kind;
    if (kind === "stop") return { kind: "stop" };
    if (kind === "supplement" && content.trim()) return { kind: "supplement", supplement: content.trim().slice(0, 500) };
    if (kind === "new_boundary") {
      const rawType = parsed?.boundaryType;
      const type = (["目标", "约束", "反例", "前提", "盲区"] as BoundaryType[]).includes(rawType as BoundaryType)
        ? (rawType as BoundaryType)
        : "盲区";
      const desc = (parsed?.description || content).trim().slice(0, 300);
      return { kind: "new_boundary", item: { type, description: desc, confidence: "high" } };
    }
    return { kind: "other" };
  }

  /** 收敛后用户补充：并入议题，再跑 extraRounds 轮（同样支持即时停止与插话） */
  async continueWithSupplement(
    meetingId: string,
    supplement: string,
    emit: (e: MeetingEvent) => void | Promise<void>,
    beforeRound?: () => UserTurnResult[],
  ): Promise<BoundaryList | null> {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    this.runController = new AbortController();
    this.stopRequested = false;

    const localEmit = async (e: MeetingEvent) => {
      m.events.push(e);
      await emit(e);
    };

    const user = coordinatorSupplementUser({ topic: m.topic ?? "", scope: m.scope ?? "", supplement });
    const raw = await this.coordChat(
      m,
      [
        { role: "system", content: coordinatorSystemPrompt() },
        { role: "user", content: user },
      ],
      { temperature: 0.2, maxTokens: 12000, timeoutMs: 300_000 },
    );
    const parsed = extractJson(raw) as { scope?: string; note?: string } | null;
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
          } else if (t.kind === "supplement" && t.supplement) {
            m.scope += `；用户补充：${t.supplement}`;
          } else if (t.kind === "stop") {
            stopped = true;
          }
        }
      }
      if (stopped || this.stopRequested) break;

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
    } catch (adjErr) {
      await localEmit({
        type: "notice",
        level: "warn",
        message: `自动裁决请求失败（${(adjErr as Error).message}），全部边界暂按「保留」入清单，可稍后人工复核或重新出方案。`,
      });
    }
    const list = this.regenerateList(m);
    await localEmit({ type: "list", list });
    this.saveSnapshot(meetingId);
    this.setState("reviewing", m.rounds);
    return list;
  }

  /** R5 终局：只把裁决保留（kept）的边界喂给终局，否决/合并不作为依据 */
  async finalSolution(meetingId: string): Promise<string> {
    const m = this.meetings.get(meetingId);
    if (!m) throw new Error("会议不存在");
    this.setState("finalizing", m.rounds);
    const kept = m.items.filter((b) => b.status.kind === "kept");
    const baseMessages = [
      { role: "system" as const, content: coordinatorSystemPrompt() },
      {
        role: "user" as const,
        content: coordinatorFinalUser({
          topic: m.topic ?? "",
          objective: m.objective ?? "",
          scope: m.scope ?? "",
          list: kept,
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
        content = (
          await this.coordChat(
            m,
            [
              ...baseMessages,
              {
                role: "user",
                content:
                  "上一次返回内容为空（可能思考过程耗尽了输出额度）。请不要再进行长段思考，直接输出完整的 Markdown 方案正文，立即从「## 方案概述」开始。",
              },
            ],
            { temperature: 0.5, maxTokens: 81920, timeoutMs: 600_000 },
          )
        ).trim();
      }
      if (!content) {
        throw new Error("终局模型连续两次空返回（思考预算耗尽或上游异常），请稍后重试，或更换统筹者模型");
      }
      m.finalSolution = content;
      m.events.push({ type: "final", solution: content });
      this.setState("finalized", m.rounds);
      this.saveSnapshot(meetingId);
      return content;
    } catch (err) {
      // 任何失败（网络/超时/空返回）都必须回滚相位，否则会议卡死在 finalizing：
      // 不重启服务就无法再次出方案，重绑/刷新后还会被当成「勘探尚未结束」
      this.setState("reviewing", m.rounds);
      this.saveSnapshot(meetingId);
      throw err;
    }
  }

  /** 会议快照（状态与时间戳由编排器内部维护） */
  snapshot(meetingId: string) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    return {
      meetingId: m.meetingId,
      question: m.question,
      topic: m.topic,
      objective: m.objective,
      scope: m.scope,
      goalType: m.goalType,
      state: this.state,
      items: m.items,
      list: this.regenerateList(m),
      events: m.events,
      convergence: m.convergence,
      rounds: m.rounds,
      tokenEstimate: this.tokensUsed,
      finalSolution: m.finalSolution,
      createdAt: this.state.startedAt ?? new Date().toISOString(),
      updatedAt: this.state.updatedAt || new Date().toISOString(),
    };
  }
}
