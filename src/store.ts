// SQLite 持久层：场景状态与命令流水原子提交，重启后从已提交状态继续。
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  State, Command, CommandResult, SimError, LIMITS,
  emptyState, cloneState, applyCommand,
} from './engine';

export interface CommandRecord {
  seq: number;
  requestId: string | null;
  command: Command;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  result: CommandResult | null;
  before: State;
  after: State;
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
        state_json TEXT NOT NULL,
        next_cmd_seq INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS commands (
        scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        request_id TEXT,
        command_json TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        result_json TEXT,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scenario_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_request
        ON commands (scenario_id, request_id) WHERE request_id IS NOT NULL;
    `);
  }

  close() { this.db.close(); }

  createScenario(name: string, threadBases: Record<number, number>, lockIds: number[]): number {
    if (!name || typeof name !== 'string') throw new SimError('ERR_VALIDATION', '场景名不能为空');
    const state = emptyState();
    const tids = Object.keys(threadBases).map(Number);
    if (tids.length === 0) throw new SimError('ERR_VALIDATION', '至少需要一个线程');
    if (tids.length > LIMITS.MAX_THREADS) throw new SimError('ERR_LIMIT', `线程数超过上限 ${LIMITS.MAX_THREADS}`);
    if (lockIds.length === 0) throw new SimError('ERR_VALIDATION', '至少需要一把锁');
    if (lockIds.length > LIMITS.MAX_LOCKS) throw new SimError('ERR_LIMIT', `锁数量超过上限 ${LIMITS.MAX_LOCKS}`);
    for (const id of tids) {
      const base = threadBases[id];
      if (!Number.isInteger(id) || id < 0) throw new SimError('ERR_VALIDATION', `非法线程编号 ${id}`);
      if (!Number.isInteger(base) || base < LIMITS.MIN_PRIO || base > LIMITS.MAX_PRIO) {
        throw new SimError('ERR_VALIDATION', `线程 ${id} 的基础优先级非法`);
      }
      state.threads[id] = { id, base, waitingOn: null, queueSeq: null };
    }
    for (const id of lockIds) {
      if (!Number.isInteger(id) || id < 0) throw new SimError('ERR_VALIDATION', `非法锁编号 ${id}`);
      if (state.locks[id]) throw new SimError('ERR_DUPLICATE_ID', `锁编号 ${id} 重复`);
      state.locks[id] = { id, holder: null, queue: [] };
    }
    const r = this.db.prepare(
      'INSERT INTO scenarios (name, state_json) VALUES (?, ?)'
    ).run(name, JSON.stringify(state));
    return Number(r.lastInsertRowid);
  }

  private loadRow(id: number): { name: string; state: State; nextSeq: number } {
    const row = this.db.prepare('SELECT name, state_json, next_cmd_seq FROM scenarios WHERE id = ?').get(id) as
      | { name: string; state_json: string; next_cmd_seq: number } | undefined;
    if (!row) throw new SimError('ERR_NOT_FOUND', `场景 ${id} 不存在`);
    return { name: row.name, state: JSON.parse(row.state_json) as State, nextSeq: row.next_cmd_seq };
  }

  getState(id: number): { name: string; state: State } {
    const { name, state } = this.loadRow(id);
    return { name, state };
  }

  listScenarios(): { id: number; name: string; createdAt: string }[] {
    const rows = this.db.prepare('SELECT id, name, created_at FROM scenarios ORDER BY id').all() as
      { id: number; name: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  // 执行命令：幂等（requestId 命中直接返回原结果），失败回滚不消耗序号。
  execute(id: number, cmd: Command, requestId?: string): { record: CommandRecord; duplicate: boolean } {
    this.validateCommand(cmd);
    if (requestId) {
      const dup = this.db.prepare(
        'SELECT * FROM commands WHERE scenario_id = ? AND request_id = ?'
      ).get(id, requestId) as Record<string, unknown> | undefined;
      if (dup) return { record: this.rowToRecord(dup), duplicate: true };
    }
    const { state, nextSeq } = this.loadRow(id);
    const before = cloneState(state);
    const work = cloneState(state);
    let ok = true, errCode: string | null = null, errMsg: string | null = null, result: CommandResult | null = null;
    try {
      result = applyCommand(work, cmd);
    } catch (e) {
      ok = false;
      if (e instanceof SimError) { errCode = e.code; errMsg = e.message; }
      else throw e;
    }
    const after = ok ? work : before; // 失败不留下半次状态
    this.db.exec('BEGIN');
    try {
      // 事务内再次检查 requestId，防并发重复
      if (requestId) {
        const dup = this.db.prepare(
          'SELECT * FROM commands WHERE scenario_id = ? AND request_id = ?'
        ).get(id, requestId) as Record<string, unknown> | undefined;
        if (dup) { this.db.exec('ROLLBACK'); return { record: this.rowToRecord(dup), duplicate: true }; }
      }
      this.db.prepare(`INSERT INTO commands
        (scenario_id, seq, request_id, command_json, ok, error_code, error_message, result_json, before_json, after_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, nextSeq, requestId ?? null, JSON.stringify(cmd), ok ? 1 : 0,
        errCode, errMsg, result ? JSON.stringify(result) : null,
        JSON.stringify(before), JSON.stringify(after),
      );
      // 命令流水序号始终前进（审计需要）；排队序号只在成功时随状态前进
      if (ok) {
        this.db.prepare('UPDATE scenarios SET state_json = ?, next_cmd_seq = ? WHERE id = ?')
          .run(JSON.stringify(after), nextSeq + 1, id);
      } else {
        this.db.prepare('UPDATE scenarios SET next_cmd_seq = ? WHERE id = ?')
          .run(nextSeq + 1, id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    const row = this.db.prepare('SELECT * FROM commands WHERE scenario_id = ? AND seq = ?')
      .get(id, nextSeq) as Record<string, unknown>;
    return { record: this.rowToRecord(row), duplicate: false };
  }

  private validateCommand(cmd: Command) {
    const valid = ['acquire', 'release', 'cancelWait', 'setBase'];
    if (!cmd || !valid.includes((cmd as Command).type)) {
      throw new SimError('ERR_VALIDATION', `未知命令类型，支持：${valid.join(', ')}`);
    }
    const c = cmd as Record<string, unknown>;
    for (const key of ['thread', 'lock'] ) {
      if (key in c && (!Number.isInteger(c[key]) || (c[key] as number) < 0)) {
        throw new SimError('ERR_VALIDATION', `字段 ${key} 必须是非负整数`);
      }
    }
  }

  history(id: number): CommandRecord[] {
    this.loadRow(id);
    const rows = this.db.prepare('SELECT * FROM commands WHERE scenario_id = ? ORDER BY seq').all(id) as
      Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  getCommand(id: number, seq: number): CommandRecord {
    const row = this.db.prepare('SELECT * FROM commands WHERE scenario_id = ? AND seq = ?').get(id, seq) as
      Record<string, unknown> | undefined;
    if (!row) throw new SimError('ERR_NOT_FOUND', `场景 ${id} 不存在命令序号 ${seq}`);
    return this.rowToRecord(row);
  }

  // 从当前快照派生新场景
  fork(id: number, name: string): number {
    const { state } = this.loadRow(id);
    const r = this.db.prepare('INSERT INTO scenarios (name, state_json) VALUES (?, ?)')
      .run(name, JSON.stringify(cloneState(state)));
    return Number(r.lastInsertRowid);
  }

  exportReplay(id: number): { name: string; initialThreads: Record<number, number>; locks: number[]; commands: { seq: number; requestId: string | null; command: Command; ok: boolean }[] } {
    const { name } = this.loadRow(id);
    const cmds = this.history(id);
    // 初始状态 = 第一条命令的 before；无命令时为当前状态
    let initial: State;
    if (cmds.length > 0) initial = cmds[0].before;
    else initial = this.loadRow(id).state;
    const threads: Record<number, number> = {};
    for (const t of Object.values(initial.threads)) threads[t.id] = t.base;
    return {
      name,
      initialThreads: threads,
      locks: Object.values(initial.locks).map((l) => l.id),
      commands: cmds.map((c) => ({ seq: c.seq, requestId: c.requestId, command: c.command, ok: c.ok })),
    };
  }

  private rowToRecord(row: Record<string, unknown>): CommandRecord {
    return {
      seq: row.seq as number,
      requestId: (row.request_id as string) ?? null,
      command: JSON.parse(row.command_json as string) as Command,
      ok: (row.ok as number) === 1,
      errorCode: (row.error_code as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      result: row.result_json ? JSON.parse(row.result_json as string) : null,
      before: JSON.parse(row.before_json as string) as State,
      after: JSON.parse(row.after_json as string) as State,
      createdAt: row.created_at as string,
    };
  }
}
