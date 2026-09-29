// 数据模型（对应 DESIGN.md §7）

export type InputSource = "text" | "attachment" | "link";

export interface MeetingInput {
  id: string;
  source: InputSource;
  content: string;
  meta?: {
    fileName?: string;
    url?: string;
    mime?: string;
  };
}

export type BoundaryType = "目标" | "约束" | "反例" | "前提" | "盲区";

export const BOUNDARY_TYPES: BoundaryType[] = ["目标", "约束", "反例", "前提", "盲区"];

// 模型输出统一归一化为英文枚举，存储与统计不再直接依赖中文措辞
export type Confidence = "high" | "medium" | "low";

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** 裁决状态：保留 / 被合并（mergedInto 指向保留条目）/ 被否决（reason） */
export type BoundaryStatus =
  | { kind: "kept" }
  | { kind: "merged"; mergedInto: string; reason?: string }
  | { kind: "rejected"; reason: string };

export interface BoundaryItem {
  id: string;
  type: BoundaryType;
  description: string;
  confidence: Confidence;
  /** 来源标识：席位 id（forward/...）或 user */
  source: string;
  /** 具体模型名（用户条目为 "user"），便于审计多模型差异 */
  sourceModel: string;
  /** 产出轮次；用户追加为 0 */
  round: number;
  status: BoundaryStatus;
  /** 被合并进本条的其他条目 id */
  mergedFrom?: string[];
}

export interface BoundaryList {
  items: BoundaryItem[];
  rounds: number;
  convergence: "auto" | "user_stop" | "max_rounds";
  disputesResolved: number;
  tokenEstimate: number;
}

export type MeetingPhase =
  | "idle"
  | "interrogating"
  | "adjudicating"
  | "reviewing"
  | "finalizing"
  | "finalized"
  | "error";

export interface MeetingState {
  phase: MeetingPhase;
  round: number;
  startedAt?: string;
  finishedAt?: string;
  finalizedAt?: string;
  errorAt?: string;
  updatedAt: string;
}

export type SeatRole =
  | "coordinator"
  | "forward"
  | "reverse"
  | "counter"
  | "assumption"
  | "blindspot";

export const SEAT_ROLES: Exclude<SeatRole, "coordinator">[] = [
  "forward",
  "reverse",
  "counter",
  "assumption",
  "blindspot",
];

/** 勘探席运行期配置（席位 id 与角色同名，type 为该席绑定的边界类别） */
export interface SeatConfig {
  id: Exclude<SeatRole, "coordinator">;
  role: string;
  name: string;
  type: BoundaryType;
  provider: string;
  model: string;
}

// 会议事件（用于流式 / UI / 日志）
export type GoalType = "enumerate" | "judge" | "design" | "diagnose" | "other";

export type MeetingEvent =
  | { type: "opening"; topic: string; objective: string; scope: string; goalType: GoalType }
  | { type: "question"; round: number; seat: string; question: string }
  | { type: "reply_chunk"; round: number; seat: string; delta: string }
  | { type: "reply"; round: number; seat: string; content: string }
  | { type: "boundary"; round: number; item: BoundaryItem }
  | { type: "round"; round: number; newCount: number; tokenEstimate: number }
  | { type: "converged"; reason: "auto" | "user_stop" | "max_rounds"; rounds: number }
  | { type: "list"; list: BoundaryList }
  | { type: "user_message"; content: string; kind: "new_boundary" | "supplement" | "stop" | "other" }
  | { type: "final"; solution: string }
  /** 非致命的流程降级提示（如统筹者输出无法解析、裁决重试后仍失败） */
  | { type: "notice"; level: "warn" | "info"; message: string; seat?: string }
  | { type: "error"; message: string; seat?: string };

export interface UserTurnResult {
  kind: "new_boundary" | "supplement" | "stop" | "other";
  item?: { type: BoundaryType; description: string; confidence?: Confidence };
  supplement?: string;
}

/** 落盘快照（与 Orchestrator.snapshot 返回结构一致） */
export interface MeetingSnapshot {
  meetingId: string;
  question: string;
  topic?: string;
  objective?: string;
  scope?: string;
  goalType?: GoalType;
  state: MeetingState;
  items: BoundaryItem[];
  list: BoundaryList;
  events: MeetingEvent[];
  convergence: BoundaryList["convergence"] | null;
  rounds: number;
  tokenEstimate: number;
  finalSolution?: string;
  createdAt: string;
  updatedAt: string;
}
