import express, { type Request, type Response } from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Orchestrator } from "./orchestrator.js";
import { loadSeats } from "./config.js";
import { persistSnapshot, persistReport } from "./snapshot.js";
import type {
  BoundaryList,
  MeetingEvent,
  MeetingInput,
  UserTurnResult,
  BoundaryType,
  Confidence,
} from "./types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT ?? 3717);

interface MeetingRuntime {
  id: string;
  orch: Orchestrator;
  events: MeetingEvent[];
  pendingTurns: UserTurnResult[];
  list: BoundaryList | null;
  solution: string | null;
  finished: boolean;
  finalizing: boolean;
  subscribers: Set<Response>;
}

const meetings = new Map<string, MeetingRuntime>();

function pushEvent(rt: MeetingRuntime, e: MeetingEvent) {
  rt.events.push(e);
  for (const res of rt.subscribers) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
}

function startMeeting(input: MeetingInput): MeetingRuntime {
  const id = input.id ?? randomUUID();
  const seats = loadSeats();
  const rt: MeetingRuntime = {
    id,
    orch: new Orchestrator({
      seats,
      emit: (e) => pushEvent(rt, e),
    }),
    events: [],
    pendingTurns: [],
    list: null,
    solution: null,
    finished: false,
    finalizing: false,
    subscribers: new Set(),
  };
  meetings.set(id, rt);

  // 后台执行勘探（不阻塞响应）
  void (async () => {
    try {
      const list = await rt.orch.runExploration(input, {
        beforeRound: async () => {
          const turns = rt.pendingTurns.splice(0);
          return turns;
        },
      });
      rt.list = list;
      rt.finished = true;
      const snap = rt.orch.snapshot();
      snap.state = "reviewing";
      snap.createdAt = new Date().toISOString();
      snap.updatedAt = new Date().toISOString();
      persistSnapshot(id, snap);
    } catch (e) {
      pushEvent(rt, { type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  })();

  return rt;
}

function classifyTurn(content: string): UserTurnResult {
  const text = content.trim();
  if (text === "stop" || text === "停止" || text === "停止勘探") return { kind: "stop" };
  if (text.startsWith("边界:") || text.startsWith("边界：")) {
    const desc = text.replace(/^边界[:：]\s*/, "").trim();
    return {
      kind: "new_boundary",
      item: { type: "目标" as BoundaryType, description: desc, confidence: "高" as Confidence },
    };
  }
  return { kind: "supplement", supplement: text };
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(PUBLIC_DIR));

// 创建会议
app.post("/api/meetings", (req: Request, res: Response) => {
  const { content, source = "text", meta } = req.body ?? {};
  if (typeof content !== "string" || content.trim().length === 0) {
    res.status(400).json({ error: "content 必填" });
    return;
  }
  const input: MeetingInput = { id: randomUUID(), source, content, meta };
  const rt = startMeeting(input);
  res.json({ meetingId: rt.id });
});

// SSE 事件流
app.get("/api/meetings/:id/events", (req: Request, res: Response) => {
  const rt = meetings.get(req.params.id);
  if (!rt) {
    res.status(404).json({ error: "会议不存在" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  for (const e of rt.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  rt.subscribers.add(res);
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    rt.subscribers.delete(res);
  });
});

// 用户插话/补充/停止（勘探中入队；勘探后即时处理）
app.post("/api/meetings/:id/turn", async (req: Request, res: Response) => {
  const rt = meetings.get(req.params.id);
  if (!rt) {
    res.status(404).json({ error: "会议不存在" });
    return;
  }
  const { content, kind } = req.body ?? {};
  if (typeof content !== "string" || content.trim().length === 0) {
    res.status(400).json({ error: "content 必填" });
    return;
  }
  const turn = kind === "new_boundary" || kind === "supplement" || kind === "stop"
    ? ({ kind, ...(kind === "new_boundary" ? { item: { type: "目标" as BoundaryType, description: content, confidence: "高" as Confidence } } : kind === "supplement" ? { supplement: content } : {}) } as UserTurnResult)
    : classifyTurn(content);

  if (rt.finished && rt.list) {
    // 勘探已结束：即时处理
    if (turn.kind === "stop") {
      if (!rt.finalizing) {
        rt.finalizing = true;
        void (async () => {
          try {
            rt.solution = await rt.orch.finalSolution(rt.list!);
            persistReport(rt.id, rt.list!, rt.solution);
          } catch (e) {
            pushEvent(rt, { type: "error", message: e instanceof Error ? e.message : String(e) });
          } finally {
            rt.finalizing = false;
          }
        })();
      }
    } else if (turn.kind === "supplement") {
      rt.finished = false;
      void (async () => {
        try {
          rt.list = await rt.orch.continueWithSupplement(rt.list!, turn.supplement ?? "");
          rt.finished = true;
        } catch (e) {
          pushEvent(rt, { type: "error", message: e instanceof Error ? e.message : String(e) });
          rt.finished = true;
        }
      })();
    } else if (turn.kind === "new_boundary" && turn.item) {
      await rt.orch.addUserBoundary({ type: turn.item.type, description: turn.item.description });
      rt.list = await rt.orch.regenerateList(rt.list!);
      pushEvent(rt, { type: "list", list: rt.list });
    }
  } else {
    // 勘探中：入队，由 beforeRound 在下一轮开始前消费
    rt.pendingTurns.push(turn);
  }
  res.json({ ok: true, queued: !rt.finished });
});

// 显式触发最终方案
app.post("/api/meetings/:id/finalize", async (req: Request, res: Response) => {
  const rt = meetings.get(req.params.id);
  if (!rt) {
    res.status(404).json({ error: "会议不存在" });
    return;
  }
  if (!rt.list) {
    res.status(400).json({ error: "勘探尚未完成" });
    return;
  }
  if (rt.finalizing) {
    res.json({ ok: true, status: "finalizing" });
    return;
  }
  rt.finalizing = true;
  void (async () => {
    try {
      rt.solution = await rt.orch.finalSolution(rt.list!);
      persistReport(rt.id, rt.list!, rt.solution);
    } catch (e) {
      pushEvent(rt, { type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      rt.finalizing = false;
    }
  })();
  res.json({ ok: true });
});

// 当前清单
app.get("/api/meetings/:id/list", (req: Request, res: Response) => {
  const rt = meetings.get(req.params.id);
  if (!rt) {
    res.status(404).json({ error: "会议不存在" });
    return;
  }
  res.json({ list: rt.list, solution: rt.solution });
});

app.listen(PORT, () => {
  console.log(`Round-Table Agent UI: http://localhost:${PORT}`);
});
