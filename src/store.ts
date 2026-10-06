/**
 * SQLite 持久层：场景、线程、锁、等待队列、命令历史。
 * 每条命令在一个事务内完成：状态改写 + 命令记录 + 前后快照，原子提交。
 * 幂等：同一场景内 requestId 唯一，重复提交直接返回首次结果。
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ApiError,
  CommandPayload,
  State,
  applyCommand,
  emptyState,
  stateView,
} from "./engine";

export interface CommandRecord {
  seq: number;
  requestId: string;
  payload: CommandPayload;
  ok: boolean;
  result: unknown;
  error: { code: string; message: string; details?: unknown } | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        next_thread_id INTEGER NOT NULL DEFAULT 1,
        next_lock_id INTEGER NOT NULL DEFAULT 1,
        wait_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS threads (
        scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        id INTEGER NOT NULL,
        name TEXT NOT NULL,
        base_priority INTEGER NOT NULL,
        waiting_on INTEGER,
        PRIMARY KEY (scenario_id, id)
      );
      CREATE TABLE IF NOT EXISTS locks (
        scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        id INTEGER NOT NULL,
        name TEXT NOT NULL,
        holder INTEGER,
        PRIMARY KEY (scenario_id, id)
      );
      CREATE TABLE IF NOT EXISTS wait_queue (
        scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        lock_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        pos INTEGER NOT NULL,
        PRIMARY KEY (scenario_id, lock_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS commands (
        scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        ok INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        before_state TEXT NOT NULL,
        after_state TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scenario_id, seq),
        UNIQUE (scenario_id, request_id)
      );
    `);
  }

  close() {
    this.db.close();
  }

  createScenario(name: string): number {
    if (!name || typeof name !== "string") {
      throw new ApiError("INVALID_NAME", "场景名称不能为空", 400);
    }
    const r = this.db
      .prepare("INSERT INTO scenarios (name) VALUES (?)")
      .run(name);
    return Number(r.lastInsertRowid);
  }

  listScenarios() {
    return this.db
      .prepare("SELECT id, name, created_at AS createdAt FROM scenarios ORDER BY id")
      .all();
  }

  private scenarioRow(id: number) {
    const row = this.db
      .prepare(
        "SELECT id, name, next_thread_id AS nextThreadId, next_lock_id AS nextLockId, wait_seq AS waitSeq, created_at AS createdAt FROM scenarios WHERE id = ?"
      )
      .get(id) as
      | {
          id: number;
          name: string;
          nextThreadId: number;
          nextLockId: number;
          waitSeq: number;
          createdAt: string;
        }
      | undefined;
    if (!row) throw new ApiError("NO_SUCH_SCENARIO", `场景 ${id} 不存在`, 404);
    return row;
  }

  loadState(scenarioId: number): State {
    const sc = this.scenarioRow(scenarioId);
    const s = emptyState();
    s.nextThreadId = sc.nextThreadId;
    s.nextLockId = sc.nextLockId;
    s.waitSeq = sc.waitSeq;
    for (const r of this.db
      .prepare(
        "SELECT id, name, base_priority AS basePriority, waiting_on AS waitingOn FROM threads WHERE scenario_id = ? ORDER BY id"
      )
      .all(scenarioId) as Iterable<{
      id: number;
      name: string;
      basePriority: number;
      waitingOn: number | null;
    }>) {
      s.threads.set(r.id, {
        id: r.id,
        name: r.name,
        basePriority: r.basePriority,
        waitingOn: r.waitingOn,
      });
    }
    for (const r of this.db
      .prepare(
        "SELECT id, name, holder FROM locks WHERE scenario_id = ? ORDER BY id"
      )
      .all(scenarioId) as Iterable<{ id: number; name: string; holder: number | null }>) {
      s.locks.set(r.id, { id: r.id, name: r.name, holder: r.holder, queue: [] });
    }
    for (const r of this.db
      .prepare(
        "SELECT lock_id AS lockId, thread_id AS threadId, seq FROM wait_queue WHERE scenario_id = ? ORDER BY lock_id, pos"
      )
      .all(scenarioId) as Iterable<{ lockId: number; threadId: number; seq: number }>) {
      s.locks.get(r.lockId)!.queue.push({ thread: r.threadId, seq: r.seq });
    }
    return s;
  }

  private persistState(scenarioId: number, s: State) {
    this.db
      .prepare(
        "UPDATE scenarios SET next_thread_id = ?, next_lock_id = ?, wait_seq = ? WHERE id = ?"
      )
      .run(s.nextThreadId, s.nextLockId, s.waitSeq, scenarioId);
    this.db.prepare("DELETE FROM wait_queue WHERE scenario_id = ?").run(scenarioId);
    this.db.prepare("DELETE FROM threads WHERE scenario_id = ?").run(scenarioId);
    this.db.prepare("DELETE FROM locks WHERE scenario_id = ?").run(scenarioId);
    const insT = this.db.prepare(
      "INSERT INTO threads (scenario_id, id, name, base_priority, waiting_on) VALUES (?, ?, ?, ?, ?)"
    );
    for (const t of s.threads.values()) {
      insT.run(scenarioId, t.id, t.name, t.basePriority, t.waitingOn);
    }
    const insL = this.db.prepare(
      "INSERT INTO locks (scenario_id, id, name, holder) VALUES (?, ?, ?, ?)"
    );
    for (const l of s.locks.values()) {
      insL.run(scenarioId, l.id, l.name, l.holder);
    }
    const insQ = this.db.prepare(
      "INSERT INTO wait_queue (scenario_id, lock_id, thread_id, seq, pos) VALUES (?, ?, ?, ?, ?)"
    );
    for (const l of s.locks.values()) {
      l.queue.forEach((q, pos) => insQ.run(scenarioId, l.id, q.thread, q.seq, pos));
    }
  }

  /**
   * 应用一条命令。同一 (scenario, requestId) 重复提交返回首次记录的结果，
   * 不重复执行、不消耗排队序号。失败命令也记录（含前后相同快照），状态回滚。
   */
  applyCommand(
    scenarioId: number,
    requestId: string,
    payload: CommandPayload
  ): CommandRecord {
    if (!requestId || typeof requestId !== "string") {
      throw new ApiError("INVALID_REQUEST_ID", "requestId 不能为空", 400);
    }
    this.scenarioRow(scenarioId);
    const existing = this.db
      .prepare(
        "SELECT seq FROM commands WHERE scenario_id = ? AND request_id = ?"
      )
      .get(scenarioId, requestId) as { seq: number } | undefined;
    if (existing) {
      const rec = this.getCommand(scenarioId, existing.seq)!;
      return { ...rec, /* 标记为幂等重放 */ } as CommandRecord;
    }

    const state = this.loadState(scenarioId);
    const before = stateView(state);
    let ok = true;
    let result: unknown = null;
    let error: CommandRecord["error"] = null;
    try {
      result = applyCommand(state, payload);
    } catch (e) {
      ok = false;
      if (e instanceof ApiError) {
        error = { code: e.code, message: e.message, details: e.details ?? null };
      } else {
        error = { code: "INTERNAL", message: String(e) };
      }
    }
    const after = ok ? stateView(state) : before;

    this.db.exec("BEGIN");
    try {
      if (ok) this.persistState(scenarioId, state);
      const seqRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM commands WHERE scenario_id = ?"
        )
        .get(scenarioId) as { seq: number };
      this.db
        .prepare(
          `INSERT INTO commands (scenario_id, seq, request_id, payload, ok, result, error, before_state, after_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          scenarioId,
          seqRow.seq,
          requestId,
          JSON.stringify(payload),
          ok ? 1 : 0,
          JSON.stringify(result),
          error ? JSON.stringify(error) : null,
          JSON.stringify(before),
          JSON.stringify(after)
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.getCommand(scenarioId, undefined, requestId)!;
  }

  getCommand(
    scenarioId: number,
    seq?: number,
    requestId?: string
  ): CommandRecord | null {
    const row = (
      seq !== undefined
        ? this.db
            .prepare("SELECT * FROM commands WHERE scenario_id = ? AND seq = ?")
            .get(scenarioId, seq)
        : this.db
            .prepare(
              "SELECT * FROM commands WHERE scenario_id = ? AND request_id = ?"
            )
            .get(scenarioId, requestId as string)
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      seq: row.seq as number,
      requestId: row.request_id as string,
      payload: JSON.parse(row.payload as string),
      ok: (row.ok as number) === 1,
      result: row.result ? JSON.parse(row.result as string) : null,
      error: row.error ? JSON.parse(row.error as string) : null,
      before: JSON.parse(row.before_state as string),
      after: JSON.parse(row.after_state as string),
      createdAt: row.created_at as string,
    };
  }

  listCommands(scenarioId: number): CommandRecord[] {
    this.scenarioRow(scenarioId);
    const rows = this.db
      .prepare("SELECT seq FROM commands WHERE scenario_id = ? ORDER BY seq")
      .all(scenarioId) as Iterable<{ seq: number }>;
    return [...rows].map((r) => this.getCommand(scenarioId, r.seq)!);
  }

  /** 从当前已提交状态派生新场景（复制状态行，不复制命令历史）。 */
  deriveScenario(scenarioId: number, name: string): number {
    const state = this.loadState(scenarioId);
    const newId = this.createScenario(name);
    this.db.exec("BEGIN");
    try {
      this.persistState(newId, state);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return newId;
  }

  /** 导出回放：场景元信息 + 全部成功/失败命令（含 requestId，可原样重放）。 */
  exportReplay(scenarioId: number) {
    const sc = this.scenarioRow(scenarioId);
    return {
      format: "pi-replay/1",
      scenario: { id: sc.id, name: sc.name, createdAt: sc.createdAt },
      commands: this.listCommands(scenarioId).map((c) => ({
        seq: c.seq,
        requestId: c.requestId,
        payload: c.payload,
        ok: c.ok,
      })),
    };
  }
}
