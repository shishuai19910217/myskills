import express from "express";
import { randomUUID } from "crypto";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import { createRequire } from "node:module";
import { Orchestrator } from "./orchestrator.js";
import { persistReport, persistSnapshot, renderReport, meetingsDir } from "./snapshot.js";
import {
  getProviderViews,
  getSeatAssignments,
  loadConfig,
  saveProvidersAndSeats,
} from "./config.js";
import type { ProviderInput, SeatAssignment } from "./config.js";
import type { MeetingEvent, UserTurnResult, BoundaryType } from "./types.js";
import { IS_SEA } from "./runtime-paths.js";

loadConfig(); // 启动即校验配置

const app = express();
app.use(express.json({ limit: "1mb" }));

// 静态页面：SEA 单文件模式从内嵌 asset 提供；普通 node 运行从 public/ 目录读盘
let indexHtmlAsset: Buffer | null = null;
if (IS_SEA) {
  try {
    const seaRequire = createRequire(import.meta.url);
    const sea = seaRequire("node:sea") as { getAsset?: (key: string) => Buffer };
    indexHtmlAsset = sea.getAsset?.("index.html") ?? null;
  } catch {
    indexHtmlAsset = null;
  }
  app.get(["/", "/index.html"], (_req, res) => {
    if (indexHtmlAsset) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(indexHtmlAsset);
    } else {
      res.status(500).send("内嵌页面资源缺失");
    }
  });
  app.get("/favicon.ico", (_req, res) => res.status(204).end());
} else {
  app.use(express.static("public"));
}

// Web 端开启真流式（席位发言逐 chunk 推送）
const orchestrator = new Orchestrator({ stream: true });

interface ServerMeeting {
  id: string;
  question: string;
  finished: boolean;
  finalizing: boolean;
  finalSolution?: string;
  pendingTurns: UserTurnResult[];
  listeners: Set<(e: MeetingEvent) => void>;
  events: MeetingEvent[]; // 供 SSE 晚加入者回放（不含 reply_chunk 碎片）
  createdAt: number;
  lastActive: number;
}

const meetings = new Map<string, ServerMeeting>();
const REPLAY_EVENT_LIMIT = 1000;

function broadcast(m: ServerMeeting, e: MeetingEvent) {
  // reply_chunk 仅实时推送，不进回放（完整内容在 reply 事件里）
  if (e.type !== "reply_chunk") m.events.push(e);
  if (m.events.length > REPLAY_EVENT_LIMIT) m.events.splice(0, m.events.length - REPLAY_EVENT_LIMIT);
  m.lastActive = Date.now();
  for (const fn of m.listeners) fn(e);
}

// 定期清理 30 分钟无活动且无 SSE 订阅的已结束会议，避免内存无界增长
setInterval(() => {
  const now = Date.now();
  for (const [id, m] of meetings) {
    if (m.finished && m.listeners.size === 0 && now - m.lastActive > 30 * 60 * 1000) {
      meetings.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

/**
 * 懒重绑：server 层 Map 里没有（被上面的定时清理移除）但 orchestrator 内
 * 仍保留该会议（且磁盘有快照）时，从快照重建 ServerMeeting。
 * 保证「恢复上次会议后挂了半小时，再点继续/出方案」不会 404。
 */
function rebindMeeting(id: string): ServerMeeting | null {
  const existing = meetings.get(id);
  if (existing) return existing;
  const snap = orchestrator.snapshot(id);
  if (!snap) return null;
  const meeting: ServerMeeting = {
    id,
    question: snap.question,
    finished: snap.state.phase === "reviewing" || snap.state.phase === "finalized",
    finalizing: false,
    finalSolution: snap.finalSolution,
    pendingTurns: [],
    listeners: new Set(),
    events: snap.events ?? [],
    createdAt: new Date(snap.createdAt).getTime(),
    lastActive: Date.now(),
  };
  meetings.set(id, meeting);
  return meeting;
}

/** 读取模型配置：供应商接入信息（不含明文密钥）+ 席位绑定 */
app.get("/api/config", (_req, res) => {
  res.json({ providers: getProviderViews(), seats: getSeatAssignments() });
});

/** 全量保存供应商接入信息与席位绑定，写回 providers.json */
app.put("/api/config", (req, res) => {
  const body = req.body as { providers?: unknown; seats?: unknown };
  if (!Array.isArray(body?.providers)) return res.status(400).json({ error: "缺少 providers 数组" });
  if (!Array.isArray(body?.seats)) return res.status(400).json({ error: "缺少 seats 数组" });

  const inputs: ProviderInput[] = body.providers.map((raw) => {
    const p = raw as { id?: unknown; baseURL?: unknown; model?: unknown; apiKey?: unknown; disabled?: unknown };
    return {
      id: String(p?.id ?? ""),
      baseURL: String(p?.baseURL ?? ""),
      model: String(p?.model ?? ""),
      apiKey: p?.apiKey == null ? "" : String(p.apiKey),
      disabled: !!p?.disabled,
    };
  });

  const validRoles = new Set(["coordinator", "forward", "reverse", "counter", "assumption", "blindspot"]);
  const seen = new Set<string>();
  const assignments: SeatAssignment[] = [];
  for (const raw of body.seats) {
    const s = raw as { role?: unknown; provider?: unknown; model?: unknown };
    const role = String(s?.role ?? "");
    if (!validRoles.has(role)) return res.status(400).json({ error: `非法席位: ${role}` });
    if (seen.has(role)) return res.status(400).json({ error: `席位重复: ${role}` });
    seen.add(role);
    assignments.push({
      role,
      provider: String(s?.provider ?? ""),
      model: s?.model == null ? "" : String(s.model).trim(),
    });
  }
  if (seen.size !== validRoles.size) return res.status(400).json({ error: "需提交全部 6 个席位（含统筹者）" });

  try {
    saveProvidersAndSeats(inputs, assignments);
  } catch (err) {
    return res.status(400).json({ error: `保存失败：${(err as Error).message}` });
  }
  res.json({ ok: true, providers: getProviderViews(), seats: getSeatAssignments() });
});

app.post("/api/meetings", (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) return res.status(400).json({ error: "缺少 question" });

  const id = `meeting-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const meeting: ServerMeeting = {
    id,
    question,
    finished: false,
    finalizing: false,
    pendingTurns: [],
    listeners: new Set(),
    events: [],
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  meetings.set(id, meeting);

  // 后台异步运行勘探（HTTP 立即返回，前端走 SSE 订阅）
  void (async () => {
    try {
      await orchestrator.runExploration({
        meetingId: id,
        question,
        emit: (e) => broadcast(meeting, e),
        beforeRound: () => {
          const turns = meeting.pendingTurns;
          meeting.pendingTurns = [];
          return turns;
        },
      });
    } catch (err) {
      broadcast(meeting, { type: "error", message: (err as Error).message });
    } finally {
      meeting.finished = true;
      meeting.lastActive = Date.now();
    }
  })();

  res.json({ meetingId: id });
});

/** SSE：先回放历史事件（排除碎片 chunk），再订阅实时事件 */
app.get("/api/meetings/:id/events", (req, res) => {
  const m = rebindMeeting(req.params.id);
  if (!m) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  for (const e of m.events) res.write(`data: ${JSON.stringify(e)}\n\n`);

  const listener = (e: MeetingEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  m.listeners.add(listener);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    m.listeners.delete(listener);
  });
});

function toUserTurn(content: string, kind?: string, boundaryType?: string): UserTurnResult | null {
  const text = content.trim();
  if (!text) return null;
  if (kind === "stop") return { kind: "stop" };
  if (kind === "supplement") return { kind: "supplement", supplement: text.slice(0, 500) };
  if (kind === "new_boundary") {
    const type = (["目标", "约束", "反例", "前提", "盲区"] as BoundaryType[]).includes(boundaryType as BoundaryType)
      ? (boundaryType as BoundaryType)
      : "盲区";
    return { kind: "new_boundary", item: { type, description: text.slice(0, 300), confidence: "high" } };
  }
  return null;
}

app.post("/api/meetings/:id/turn", async (req, res) => {
  const m = rebindMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: "会议不存在" });
  const content = String(req.body?.content ?? "").trim();
  if (!content) return res.status(400).json({ error: "缺少 content" });

  // 显式类型优先；未指定时由统筹者 LLM 判定语义
  let turn = toUserTurn(content, req.body?.kind, req.body?.boundaryType);
  if (!turn) {
    turn = await orchestrator.classifyUserTurn(m.id, content).catch(() => ({ kind: "other" }) as UserTurnResult);
  }

  if (turn.kind === "other") {
    // 无法判定：不擅自处理，请用户澄清
    return res.json({
      ok: true,
      unrecognized: true,
      message: "没能理解这条内容的意图，请用“补充说明 / 追加边界（选类型）/ 停止”重新发送。",
    });
  }

  // 相位对齐：orchestrator 已到 reviewing/finalized 但包装器 finally 尚未置 finished 时，
  // 视为已结束——否则此窗口内的补充会被塞进 pendingTurns 而无人消费
  if (!m.finished) {
    const phase = orchestrator.snapshot(m.id)?.state.phase;
    if (phase === "reviewing" || phase === "finalized") m.finished = true;
  }

  if (!m.finished) {
    // 勘探进行中（含补充轮）：停止即时生效，其余入队在下一轮前消费
    if (turn.kind === "stop") {
      orchestrator.requestStop();
    } else {
      m.pendingTurns.push(turn);
    }
    return res.json({ ok: true, queued: turn.kind !== "stop", kind: turn.kind });
  }

  // 已收敛
  if (turn.kind === "stop") {
    return res.status(409).json({ error: "勘探已结束，如要出方案请点击“出最终方案”" });
  }
  if (m.finalizing) return res.status(409).json({ error: "正在生成最终方案，暂不能追加" });

  if (turn.kind === "new_boundary" && turn.item) {
    orchestrator.addUserBoundaryById(m.id, turn.item.type, turn.item.description, turn.item.confidence);
    const rec = orchestrator.getMeeting(m.id);
    if (rec) {
      const list = await orchestrator.regenerateListAsync(rec);
      broadcast(m, { type: "user_message", content: turn.item.description, kind: "new_boundary" });
      broadcast(m, { type: "list", list });
      try {
        persistSnapshot(m.id, () => orchestrator.snapshot(m.id));
      } catch {
        /* 落盘失败不影响接口响应 */
      }
    }
    return res.json({ ok: true });
  }

  if (turn.kind === "supplement" && turn.supplement) {
    m.finished = false;
    m.pendingTurns = [];
    void (async () => {
      try {
        await orchestrator.continueWithSupplement(
          m.id,
          turn.supplement as string,
          (e) => broadcast(m, e),
          () => {
            const queued = m.pendingTurns;
            m.pendingTurns = [];
            return queued;
          },
        );
      } catch (err) {
        broadcast(m, { type: "error", message: (err as Error).message });
      } finally {
        m.finished = true;
      }
    })();
    return res.json({ ok: true, mode: "extra_rounds" });
  }

  res.status(400).json({ error: "无法处理该输入" });
});

app.get("/api/meetings/:id", (req, res) => {
  const snap = orchestrator.snapshot(req.params.id);
  if (!snap) return res.status(404).json({ error: "会议不存在" });
  const m = meetings.get(req.params.id);
  res.json({ ...snap, finished: m?.finished, finalizing: m?.finalizing });
});

app.post("/api/meetings/:id/finalize", async (req, res) => {
  const m = rebindMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: "会议不存在" });
  // m.finished 由异步包装器的 finally 置位，比 orchestrator 相位晚一个事件循环；
  // 相位已到 reviewing/finalized 即视为勘探结束，避免「页面已显示收敛但点击出方案 409」的竞态
  if (!m.finished) {
    const phase = orchestrator.snapshot(m.id)?.state.phase;
    if (phase !== "reviewing" && phase !== "finalized") {
      return res.status(409).json({ error: "勘探尚未结束" });
    }
  }
  if (m.finalizing) return res.status(409).json({ error: "最终方案生成中" });
  if (m.finalSolution) return res.json({ solution: m.finalSolution, cached: true });

  m.finalizing = true;
  try {
    const solution = await orchestrator.finalSolution(m.id);
    m.finalSolution = solution;
    // finalSolution 已向会议事件流写入 final，这里只推给 SSE 订阅者
    for (const fn of m.listeners) fn({ type: "final", solution });
    m.lastActive = Date.now();
    // 与 CLI / stop 路径一致：终局后落盘报告
    const snap = orchestrator.snapshot(m.id);
    if (snap) {
      try {
        persistReport(m.id, () => snap);
      } catch {
        /* 落盘失败不影响接口响应 */
      }
    }
    res.json({ solution });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    m.finalizing = false;
    m.lastActive = Date.now();
  }
});

// 下载当前会议的 Markdown 报告（按最新快照实时渲染，无需先落盘）
app.get("/api/meetings/:id/report.md", (req, res) => {
  const snap = orchestrator.snapshot(req.params.id);
  if (!snap) return res.status(404).json({ error: "会议不存在" });
  const md = renderReport(snap);
  const base = snap.topic ? `${snap.topic}-${req.params.id}` : req.params.id;
  const filename = encodeURIComponent(base.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80));
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
  res.send(md);
});

// 列出 data/meetings/ 目录下所有持久化文件
app.get("/api/meetings-files", (_req, res) => {
  try {
    const files = readdirSync(meetingsDir).filter((f) => /\.(json|md)$/.test(f)).sort();
    const details = files.map((f) => {
      const stat = statSync(join(meetingsDir, f));
      return { name: f, size: stat.size, mtime: stat.mtimeMs };
    });
    res.json({ files: details });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 清空 data/meetings/ 目录下所有文件（snapshot + report）
// 查询参数 keep=reports 时仅清 snapshot，保留 report.md
app.delete("/api/meetings-files", (req, res) => {
  try {
    const keep = String(req.query.keep ?? "");
    const keepReports = keep === "reports";
    const files = readdirSync(meetingsDir).filter((f) => /\.(json|md)$/.test(f));
    let removed = 0;
    for (const f of files) {
      if (keepReports && f.endsWith(".md")) continue;
      unlinkSync(join(meetingsDir, f));
      removed++;
    }
    res.json({ removed, total: files.length, keepReports });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const PORT = Number(process.env.PORT ?? 9600);
app.listen(PORT, () => {
  console.log(`圆桌勘探 Web 服务：http://localhost:${PORT}`);

  // 启动时恢复最近一次的会议快照
  const restored = orchestrator.restoreLatestSnapshot(meetingsDir);
  if (restored) {
    console.log(`已从快照恢复会议：${restored.meetingId}（${restored.snapshot.topic ?? restored.snapshot.question}）`);
    // 在 server 层也注册这个会议，让前端可以订阅；
    // 相位以 orchestrator 恢复后的为准（中间态已归一），不能直接用磁盘快照原值
    const phase = orchestrator.snapshot(restored.meetingId)?.state.phase ?? restored.snapshot.state.phase;
    const meeting: ServerMeeting = {
      id: restored.meetingId,
      question: restored.snapshot.question,
      finished: phase === "reviewing" || phase === "finalized",
      finalizing: phase === "finalizing",
      finalSolution: restored.snapshot.finalSolution,
      pendingTurns: [],
      listeners: new Set(),
      events: restored.snapshot.events ?? [],
      createdAt: new Date(restored.snapshot.createdAt).getTime(),
      lastActive: Date.now(),
    };
    meetings.set(restored.meetingId, meeting);
  }

  // SEA 双击启动：自动打开默认浏览器（设置 RTA_NO_BROWSER=1 可关闭）
  if (IS_SEA && process.env.RTA_NO_BROWSER !== "1") {
    const url = `http://localhost:${PORT}`;
    const cmd =
      process.platform === "win32"
        ? `cmd /c start "" "${url}"`
        : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd, () => {
      /* 浏览器拉起失败不影响服务 */
    });
  }
});
