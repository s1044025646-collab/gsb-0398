/** HTTP API 服务（node:http，无外部依赖）。 */
import * as http from "node:http";
import { ApiError, CommandPayload, computeEffective, stateView } from "./engine";
import { Store } from "./store";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_JSON", "请求体不是合法 JSON", 400);
  }
}

/** 前后快照差异：线程/锁字段级对比。 */
function diffView(before: any, after: any) {
  const threadChanges: any[] = [];
  const lockChanges: any[] = [];
  const bThreads = new Map((before.threads as any[]).map((t) => [t.id, t]));
  const aThreads = new Map((after.threads as any[]).map((t) => [t.id, t]));
  for (const [id, a] of aThreads as Map<number, any>) {
    const b = bThreads.get(id);
    if (!b) {
      threadChanges.push({ thread: id, change: "added", after: a });
      continue;
    }
    const delta: any = { thread: id };
    let changed = false;
    for (const k of ["basePriority", "effectivePriority", "state", "waitingOn"]) {
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
        delta[k] = { before: b[k], after: a[k] };
        changed = true;
      }
    }
    if (changed) threadChanges.push(delta);
  }
  for (const [id, b] of bThreads as Map<number, any>) {
    if (!aThreads.has(id)) threadChanges.push({ thread: id, change: "removed", before: b });
  }
  const bLocks = new Map((before.locks as any[]).map((l) => [l.id, l]));
  const aLocks = new Map((after.locks as any[]).map((l) => [l.id, l]));
  for (const [id, a] of aLocks as Map<number, any>) {
    const b = bLocks.get(id);
    if (!b) {
      lockChanges.push({ lock: id, change: "added", after: a });
      continue;
    }
    const delta: any = { lock: id };
    let changed = false;
    if (b.holder !== a.holder) {
      delta.holder = { before: b.holder, after: a.holder };
      changed = true;
    }
    if (JSON.stringify(b.queue) !== JSON.stringify(a.queue)) {
      delta.queue = { before: b.queue, after: a.queue };
      changed = true;
    }
    if (changed) lockChanges.push(delta);
  }
  for (const [id, b] of bLocks as Map<number, any>) {
    if (!aLocks.has(id)) lockChanges.push({ lock: id, change: "removed", before: b });
  }
  return {
    runnable: { before: before.runnable, after: after.runnable },
    threads: threadChanges,
    locks: lockChanges,
  };
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body =
        method === "POST" || method === "PUT" ? await readBody(req) : {};

      // POST /scenarios {name}
      if (method === "POST" && parts.length === 1 && parts[0] === "scenarios") {
        const id = store.createScenario(body.name);
        return send(res, 201, { id });
      }
      // GET /scenarios
      if (method === "GET" && parts.length === 1 && parts[0] === "scenarios") {
        return send(res, 200, store.listScenarios());
      }

      if (parts[0] === "scenarios" && parts.length >= 2) {
        const sid = Number(parts[1]);
        if (!Number.isInteger(sid)) {
          throw new ApiError("INVALID_ID", "场景 id 必须是整数", 400);
        }
        const sub = parts[2];

        // POST /scenarios/:id/commands {requestId, ...payload}
        if (method === "POST" && sub === "commands" && parts.length === 3) {
          const { requestId, ...payload } = body;
          const rec = store.applyCommand(sid, requestId, payload as CommandPayload);
          return send(res, rec.ok ? 200 : 409, {
            seq: rec.seq,
            requestId: rec.requestId,
            ok: rec.ok,
            result: rec.result,
            error: rec.error,
          });
        }
        // GET /scenarios/:id/commands | /commands/:seq | /commands/:seq/diff
        if (method === "GET" && sub === "commands") {
          if (parts.length === 3) return send(res, 200, store.listCommands(sid));
          const seq = Number(parts[3]);
          const rec = store.getCommand(sid, seq);
          if (!rec) {
            throw new ApiError("NO_SUCH_COMMAND", `命令 ${parts[3]} 不存在`, 404);
          }
          if (parts.length === 4) return send(res, 200, rec);
          if (parts.length === 5 && parts[4] === "diff") {
            return send(res, 200, diffView(rec.before as any, rec.after as any));
          }
        }
        // GET /scenarios/:id/state
        if (method === "GET" && sub === "state" && parts.length === 3) {
          return send(res, 200, stateView(store.loadState(sid)));
        }
        // GET /scenarios/:id/threads/:tid
        if (method === "GET" && sub === "threads" && parts.length === 4) {
          const view = stateView(store.loadState(sid));
          const t = view.threads.find((x) => x.id === Number(parts[3]));
          if (!t) throw new ApiError("NO_SUCH_THREAD", `线程 ${parts[3]} 不存在`, 404);
          return send(res, 200, t);
        }
        // GET /scenarios/:id/locks/:lid
        if (method === "GET" && sub === "locks" && parts.length === 4) {
          const view = stateView(store.loadState(sid));
          const l = view.locks.find((x) => x.id === Number(parts[3]));
          if (!l) throw new ApiError("NO_SUCH_LOCK", `锁 ${parts[3]} 不存在`, 404);
          return send(res, 200, l);
        }
        // GET /scenarios/:id/explain/:tid —— 捐赠链解释
        if (method === "GET" && sub === "explain" && parts.length === 4) {
          const state = store.loadState(sid);
          const eff = computeEffective(state);
          const tid = Number(parts[3]);
          const info = eff.get(tid);
          if (!info) throw new ApiError("NO_SUCH_THREAD", `线程 ${tid} 不存在`, 404);
          const t = state.threads.get(tid)!;
          return send(res, 200, {
            thread: tid,
            basePriority: t.basePriority,
            effectivePriority: info.effective,
            explanation: info.donation
              ? `有效优先级 ${info.effective} 来自线程 ${info.donation.fromThread} 的传递捐赠，路径：` +
                [...info.donation.path]
                  .reverse()
                  .map((p) => `T${p.thread} --等待锁${p.waitsOnLock}--> `)
                  .join("") +
                `T${tid}`
              : `有效优先级等于自身基础值 ${t.basePriority}，无捐赠`,
            donation: info.donation,
          });
        }
        // GET /scenarios/:id/scheduler —— 当前应先运行谁
        if (method === "GET" && sub === "scheduler" && parts.length === 3) {
          const view = stateView(store.loadState(sid));
          return send(res, 200, { runnable: view.runnable });
        }
        // POST /scenarios/:id/derive {name}
        if (method === "POST" && sub === "derive" && parts.length === 3) {
          const id = store.deriveScenario(sid, body.name ?? `derived-from-${sid}`);
          return send(res, 201, { id });
        }
        // GET /scenarios/:id/export
        if (method === "GET" && sub === "export" && parts.length === 3) {
          return send(res, 200, store.exportReplay(sid));
        }
      }

      throw new ApiError("NOT_FOUND", `未匹配的路由: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.status, {
          error: { code: e.code, message: e.message, details: e.details ?? null },
        });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

/** 启动服务；port 省略或传 0 时由系统分配空闲端口。 */
export function startServer(
  store: Store,
  port = 0
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}
