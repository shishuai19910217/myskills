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

export type Confidence = "高" | "中" | "低";

export interface BoundaryStatus {
  kind: "一致" | "有分歧";
  verdict?: string; // 统筹者裁决结论（保留 / 合并 / 否决）
  rejectedReason?: string;
}

export interface BoundaryItem {
  id: string;
  type: BoundaryType;
  description: string;
  proposer: string;
  source: string;
  confidence: Confidence;
  status: BoundaryStatus;
  counterExamples: string[];
  dedupKey: string;
}

export interface BoundaryList {
  meetingId: string;
  topic: string;
  objective: string;
  scope: string;
  items: BoundaryItem[];
  rounds: number;
  convergence: "auto" | "user_stop";
  disputesResolved: number;
  tokenEstimate: number;
}

export type MeetingState = "idle" | "opening" | "interrogating" | "adjudicating" | "convergence_check" | "list_generation" | "reviewing" | "final_solution" | "done";

export interface MeetingSnapshot {
  meetingId: string;
  state: MeetingState;
  boundaryPool: BoundaryItem[];
  roundNumber: number;
  coordinatorHistory: string[];
  userInterjections: string[];
  createdAt: string;
  updatedAt: string;
}

export type SeatRole =
  | "coordinator"
  | "forward"
  | "reverse"
  | "counter"
  | "assumption"
  | "blindspot";

export const SEAT_ROLES: SeatRole[] = ["forward", "reverse", "counter", "assumption", "blindspot"];

export interface Seat {
  role: SeatRole;
  label: string;
  provider: string;
}

// 会议事件（用于流式 / UI / 日志）
export type MeetingEvent =
  | { type: "opening"; topic: string; objective: string; scope: string }
  | { type: "question"; round: number; seat: string; question: string }
  | { type: "reply"; round: number; seat: string; content: string }
  | { type: "boundary"; round: number; item: BoundaryItem }
  | { type: "round"; round: number; newCount: number }
  | { type: "converged"; reason: "auto" | "user_stop"; rounds: number }
  | { type: "list"; list: BoundaryList }
  | { type: "user_message"; content: string; kind: "new_boundary" | "supplement" | "stop" | "other" }
  | { type: "final"; solution: string }
  | { type: "error"; message: string; seat?: string };

export interface UserTurnResult {
  kind: "new_boundary" | "supplement" | "stop";
  item?: { type: BoundaryType; description: string; confidence?: Confidence };
  supplement?: string;
}

// 席位返回的解析结果
export interface SeatReply {
  boundary: BoundaryItem | null;
  note?: string;
}
