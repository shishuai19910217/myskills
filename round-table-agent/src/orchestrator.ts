import { chat, chatStream, type ChatMessage } from "./llm.js";
import { loadSeats, loadConfig, type SeatConfig } from "./config.js";
import {
  COORDINATOR_SYSTEM,
  SEAT_LABELS,
  SEAT_BOUNDARY_TYPE,
  seatSystemPrompt,
  seatUserPrompt,
  coordinatorOpenUser,
  coordinatorQuestionUser,
  coordinatorAdjudicateUser,
  coordinatorConvergeUser,
  coordinatorFinalUser,
} from "./prompts.js";
import type {
  BoundaryItem,
  BoundaryList,
  BoundaryType,
  MeetingEvent,
  MeetingInput,
  MeetingSnapshot,
  Seat,
  SeatRole,
  UserTurnResult,
} from "./types.js";
import { BOUNDARY_TYPES } from "./types.js";

export interface OrchestratorOptions {
  seats?: SeatConfig[];
  emit?: (e: MeetingEvent) => void;
  stream?: boolean;
  maxRounds?: number;
  convergenceN?: number;
  convergenceThreshold?: number;
  temperature?: number;
  maxTokens?: number;
}

interface OpenResult {
  topic: string;
  objective: string;
  scope: string;
}

interface SeatAnswer {
  boundary: BoundaryItem | null;
}

export class Orchestrator {
  private seats: Seat[];
  private emitFn: (e: MeetingEvent) => void;
  private stream: boolean;
  private maxRounds: number;
  private convergenceN: number;
  private convergenceThreshold: number;
  private temperature: number;
  private maxTokens: number;
  private pool: BoundaryItem[] = [];
  private coordHistory: string[] = [];
  private round = 0;
  private topic = "";
  private objective = "";
  private scope = "";
  private meetingId = "";
  private seq = 0;

  constructor(opts: OrchestratorOptions = {}) {
    const cfg = loadConfig();
    const seats = loadSeats(opts.seats);
    this.seats = seats
      .filter((s) => s.role !== "coordinator")
      .map((s) => ({ role: s.role as SeatRole, label: SEAT_LABELS[s.role as SeatRole], provider: s.provider }));
    const coord = seats.find((s) => s.role === "coordinator");
    this.coordinatorProvider = coord?.provider ?? cfg.providers[0]?.id ?? "omni";
    this.emitFn = opts.emit ?? (() => {});
    this.stream = opts.stream ?? false;
    this.maxRounds = opts.maxRounds ?? cfg.runtime.maxRounds;
    this.convergenceN = opts.convergenceN ?? cfg.runtime.convergenceN;
    this.convergenceThreshold = opts.convergenceThreshold ?? cfg.runtime.convergenceThreshold;
    this.temperature = opts.temperature ?? cfg.runtime.temperature;
    this.maxTokens = opts.maxTokens ?? cfg.runtime.maxTokens;
  }

  private coordinatorProvider: string;

  private emit(e: MeetingEvent) {
    this.emitFn(e);
  }

  private nextId(): string {
    this.seq += 1;
    return `B${String(this.seq).padStart(3, "0")}`;
  }

  private tokenEstimate(): number {
    // 粗估：中文约 1 字≈1 token 偏保守，用于成本指示
    let chars = this.topic.length + this.scope.length + this.coordHistory.join("").length;
    for (const b of this.pool) chars += b.description.length;
    return Math.round(chars / 1.5);
  }

  // ---- 底层调用 ----
  private async ask(providerId: string, system: string, user: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    if (this.stream) {
      let full = "";
      await chatStream(
        providerId,
        messages,
        (d) => {
          full += d;
        },
        { temperature: this.temperature, maxTokens: this.maxTokens },
      );
      return full;
    }
    return chat(providerId, messages, { temperature: this.temperature, maxTokens: this.maxTokens });
  }

  // ---- JSON 解析 ----
  private extractJson(text: string): unknown {
    // 剥离 Markdown 代码块围栏
    const cleaned = text.replace(/```(?:json)?/g, "").trim();
    // 找第一个 "{" 到最后一个 "}" 的平衡区间
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("未找到 JSON 对象");
    return JSON.parse(cleaned.slice(start, end + 1));
  }

  private extractJsonArray(text: string): unknown[] {
    const cleaned = text.replace(/```(?:json)?/g, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end <= start) throw new Error("未找到 JSON 数组");
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown[];
  }

  // ---- 去重 ----
  private normalizeKey(type: BoundaryType, description: string): string {
    return `${type}|${description.replace(/[，。、；：？！,.?!\s]/g, "").toLowerCase()}`;
  }

  private isDuplicate(candidate: BoundaryItem): boolean {
    return this.pool.some((b) => b.dedupKey === candidate.dedupKey);
  }

  // ---- R0 开题 ----
  private async open(input: MeetingInput): Promise<OpenResult> {
    const raw = await this.ask(this.coordinatorProvider, COORDINATOR_SYSTEM, coordinatorOpenUser(input.content));
    this.coordHistory.push(raw);
    const json = this.extractJson(raw) as Partial<OpenResult>;
    return {
      topic: json.topic ?? "（议题未复述成功）",
      objective: json.objective ?? "（产出目标未识别）",
      scope: json.scope ?? "（范围未圈定）",
    };
  }

  // ---- 统筹者盘问问题 ----
  private async askQuestion(seat: Seat): Promise<string> {
    const boundaryType = SEAT_BOUNDARY_TYPE[seat.role as Exclude<SeatRole, "coordinator">];
    const raw = await this.ask(
      this.coordinatorProvider,
      COORDINATOR_SYSTEM,
      coordinatorQuestionUser({
        topic: this.topic,
        objective: this.objective,
        scope: this.scope,
        seatLabel: seat.label,
        boundaryType,
        pool: this.pool,
        round: this.round,
      }),
    );
    this.coordHistory.push(raw);
    return raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  }

  // ---- 席位回答 ----
  private async seatAnswer(seat: Seat, question: string): Promise<SeatAnswer> {
    const boundaryType = SEAT_BOUNDARY_TYPE[seat.role as Exclude<SeatRole, "coordinator">];
    const system = seatSystemPrompt({ label: seat.label, boundaryType, topic: this.topic });
    const user = seatUserPrompt({
      topic: this.topic,
      scope: this.scope,
      objective: this.objective,
      pool: this.pool,
      round: this.round,
      question,
      boundaryType,
    });

    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.ask(seat.provider, system, user);
      this.emit({ type: "reply", round: this.round, seat: seat.label, content: raw });
      try {
        const json = this.extractJson(raw) as { boundary: unknown; confidence?: string };
        if (json.boundary === null || json.boundary === undefined) return { boundary: null };
        const b = json.boundary as Partial<BoundaryItem>;
        if (typeof b.description !== "string" || b.description.trim().length === 0) {
          lastError = "空描述";
          continue;
        }
        const item: BoundaryItem = {
          id: this.nextId(),
          type: boundaryType,
          description: b.description.trim(),
          proposer: seat.label,
          source: `模型:${seat.provider}`,
          confidence: (b.confidence ?? "中") as BoundaryItem["confidence"],
          status: { kind: "一致" },
          counterExamples: Array.isArray(b.counterExamples) ? b.counterExamples.map(String) : [],
          dedupKey: this.normalizeKey(boundaryType, b.description.trim()),
        };
        return { boundary: item };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(`席位 ${seat.label} 回答解析失败（${lastError}）`);
  }

  // ---- R2/R4 裁决 ----
  private async adjudicate(): Promise<void> {
    if (this.pool.length === 0) return;
    const raw = await this.ask(
      this.coordinatorProvider,
      COORDINATOR_SYSTEM,
      coordinatorAdjudicateUser({ topic: this.topic, items: this.pool }),
    );
    this.coordHistory.push(raw);
    let verdicts: { id: string; verdict: string; mergeInto?: string; reason?: string }[] = [];
    try {
      verdicts = this.extractJsonArray(raw) as typeof verdicts;
    } catch {
      return; // 裁决解析失败则全部保留
    }
    const byId = new Map(verdicts.map((v) => [v.id, v]));
    let disputes = 0;
    for (const item of this.pool) {
      const v = byId.get(item.id);
      if (!v) continue;
      if (v.verdict === "否决") {
        item.status = { kind: "有分歧", verdict: "否决", rejectedReason: v.reason ?? "统筹者否决" };
        disputes++;
      } else if (v.verdict === "合并" && v.mergeInto) {
        item.status = { kind: "有分歧", verdict: `合并至${v.mergeInto}`, rejectedReason: v.reason ?? "与既有条目重叠" };
        disputes++;
      }
    }
    this.disputesResolved = disputes;
  }

  private disputesResolved = 0;

  // ---- R3 收敛判定 ----
  private recentNewCounts: number[] = [];

  private async checkConvergence(): Promise<{ converged: boolean; reason: string }> {
    const recent = this.recentNewCounts.slice(-this.convergenceN);
    if (recent.length >= this.convergenceN && recent.every((n) => n <= this.convergenceThreshold)) {
      return { converged: true, reason: `连续 ${this.convergenceN} 轮新增边界 ≤${this.convergenceThreshold}` };
    }
    const raw = await this.ask(
      this.coordinatorProvider,
      COORDINATOR_SYSTEM,
      coordinatorConvergeUser({
        topic: this.topic,
        pool: this.pool,
        recentRounds: this.recentNewCounts.map((n, i) => ({ round: i + 1, newCount: n })),
      }),
    );
    this.coordHistory.push(raw);
    try {
      const json = this.extractJson(raw) as { converged?: boolean; reason?: string };
      return { converged: !!json.converged, reason: json.reason ?? "" };
    } catch {
      return { converged: false, reason: "收敛判定解析失败，继续勘探" };
    }
  }

  // ---- 一轮盘问 ----
  private async runRound(): Promise<{ newCount: number; newItems: BoundaryItem[] }> {
    this.round += 1;
    const newItems: BoundaryItem[] = [];
    for (const seat of this.seats) {
      const question = await this.askQuestion(seat);
      this.emit({ type: "question", round: this.round, seat: seat.label, question });
      let answer: SeatAnswer;
      try {
        answer = await this.seatAnswer(seat, question);
      } catch (e) {
        this.emit({ type: "error", message: e instanceof Error ? e.message : String(e), seat: seat.label });
        continue;
      }
      if (answer.boundary && !this.isDuplicate(answer.boundary)) {
        this.pool.push(answer.boundary);
        newItems.push(answer.boundary);
        this.emit({ type: "boundary", round: this.round, item: answer.boundary });
      }
    }
    this.recentNewCounts.push(newItems.length);
    this.emit({ type: "round", round: this.round, newCount: newItems.length });
    return { newCount: newItems.length, newItems };
  }

  // ---- 主流程：勘探（R0 → R1×N → R3 → R4） ----
  async runExploration(
    input: MeetingInput,
    hooks: {
      beforeRound?: (round: number) => Promise<UserTurnResult[]>; // 用户插话/补充/停止
      onStop?: () => Promise<void>;
    } = {},
  ): Promise<BoundaryList> {
    this.meetingId = input.id ?? `meeting-${Date.now()}`;
    const open = await this.open(input);
    this.topic = open.topic;
    this.objective = open.objective;
    this.scope = open.scope;
    this.emit({ type: "opening", topic: this.topic, scope: this.scope, objective: this.objective });

    let stopped = false;
    for (let r = 1; r <= this.maxRounds; r++) {
      if (hooks.beforeRound) {
        const turns = await hooks.beforeRound(r);
        for (const turn of turns) {
          if (turn.kind === "stop") {
            stopped = true;
            await hooks.onStop?.();
            break;
          }
          if (turn.kind === "new_boundary" && turn.item) {
            await this.addUserBoundary({
              type: turn.item.type,
              description: turn.item.description,
              confidence: turn.item.confidence,
            });
          }
          if (turn.kind === "supplement" && turn.supplement) {
            this.scope += `\n[用户补充] ${turn.supplement}`;
            this.emit({ type: "user_message", content: turn.supplement, kind: "supplement" });
          }
        }
        if (stopped) break;
      }

      await this.runRound();

      const conv = await this.checkConvergence();
      if (conv.converged) {
        this.emit({ type: "converged", reason: "auto", rounds: this.round });
        break;
      }
    }

    const convergence: "auto" | "user_stop" = stopped ? "user_stop" : "auto";
    if (stopped) this.emit({ type: "converged", reason: "user_stop", rounds: this.round });

    // R4 裁决 + 出清单
    await this.adjudicate();
    const list: BoundaryList = {
      meetingId: this.meetingId,
      topic: this.topic,
      objective: this.objective,
      scope: this.scope,
      items: [...this.pool].sort((a, b) => BOUNDARY_TYPES.indexOf(a.type) - BOUNDARY_TYPES.indexOf(b.type)),
      rounds: this.round,
      convergence,
      disputesResolved: this.disputesResolved,
      tokenEstimate: this.tokenEstimate(),
    };
    this.emit({ type: "list", list });
    return list;
  }

  // ---- R5 补充优化（同议题，非新议题） ----
  async regenerateList(prev: BoundaryList): Promise<BoundaryList> {
    await this.adjudicate();
    return {
      ...prev,
      scope: this.scope,
      items: [...this.pool].sort((a, b) => BOUNDARY_TYPES.indexOf(a.type) - BOUNDARY_TYPES.indexOf(b.type)),
      rounds: this.round,
      disputesResolved: this.disputesResolved,
      tokenEstimate: this.tokenEstimate(),
    };
  }

  async addUserBoundary(partial: {
    type: BoundaryType;
    description: string;
    confidence?: BoundaryItem["confidence"];
  }): Promise<BoundaryItem> {
    const item: BoundaryItem = {
      id: this.nextId(),
      type: partial.type,
      description: partial.description,
      proposer: "用户插话",
      source: "用户插话",
      confidence: partial.confidence ?? "中",
      status: { kind: "一致" },
      counterExamples: [],
      dedupKey: this.normalizeKey(partial.type, partial.description),
    };
    if (!this.isDuplicate(item)) {
      this.pool.push(item);
      this.emit({ type: "boundary", round: this.round, item });
    }
    return item;
  }

  async continueWithSupplement(list: BoundaryList, supplement: string, extraRounds = 2): Promise<BoundaryList> {
    this.scope += `\n[用户补充] ${supplement}`;
    this.emit({ type: "user_message", content: supplement, kind: "supplement" });
    const before = this.maxRounds;
    this.maxRounds = this.round + extraRounds;
    for (let r = this.round + 1; r <= this.maxRounds; r++) {
      await this.runRound();
      const conv = await this.checkConvergence();
      if (conv.converged) break;
    }
    this.maxRounds = before;
    await this.adjudicate();
    const newList: BoundaryList = {
      ...list,
      scope: this.scope,
      items: [...this.pool].sort((a, b) => BOUNDARY_TYPES.indexOf(a.type) - BOUNDARY_TYPES.indexOf(b.type)),
      rounds: this.round,
      disputesResolved: this.disputesResolved,
      tokenEstimate: this.tokenEstimate(),
    };    this.emit({ type: "list", list: newList });
    return newList;
  }

  // ---- 终局：最终方案 ----
  async finalSolution(list: BoundaryList): Promise<string> {
    const raw = await this.ask(
      this.coordinatorProvider,
      COORDINATOR_SYSTEM,
      coordinatorFinalUser({ topic: this.topic, objective: this.objective, scope: this.scope, list: list.items }),
    );
    this.emit({ type: "final", solution: raw });
    return raw;
  }

  // 供外部读取当前状态
  snapshot(): MeetingSnapshot {
    return {
      meetingId: this.meetingId,
      state: this.round === 0 ? "idle" : "interrogating",
      boundaryPool: [...this.pool],
      roundNumber: this.round,
      coordinatorHistory: [...this.coordHistory],
      userInterjections: [],
      createdAt: "",
      updatedAt: "",
    };
  }
}

export { BOUNDARY_TYPES };
