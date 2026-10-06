// 核心模拟引擎：纯函数，不依赖 IO，便于独立测试与快照序列化。

export const LIMITS = {
  MAX_THREADS: 64,
  MAX_LOCKS: 64,
  MAX_CHAIN: 64, // 等待链最大深度
  MIN_PRIO: 0,
  MAX_PRIO: 1_000_000,
} as const;

export type ErrCode =
  | 'ERR_VALIDATION'
  | 'ERR_NOT_FOUND'
  | 'ERR_LIMIT'
  | 'ERR_DUPLICATE_ID'
  | 'ERR_SELF_LOCK'
  | 'ERR_ALREADY_WAITING'
  | 'ERR_NOT_HOLDER'
  | 'ERR_NOT_WAITING'
  | 'ERR_CYCLE'
  | 'ERR_STATE';

export class SimError extends Error {
  constructor(public code: ErrCode, message: string, public detail?: unknown) {
    super(message);
  }
}

export interface ThreadState {
  id: number;
  base: number;
  waitingOn: number | null; // 正在等待的锁 id；同时最多一把
  queueSeq: number | null; // 进入当前等待队列的序号（全局递增）
}

export interface LockState {
  id: number;
  holder: number | null;
  queue: number[]; // 等待线程 id，按到达顺序
}

export interface State {
  threads: Record<number, ThreadState>;
  locks: Record<number, LockState>;
  nextQueueSeq: number;
}

export function emptyState(): State {
  return { threads: {}, locks: {}, nextQueueSeq: 1 };
}

export function cloneState(s: State): State {
  return JSON.parse(JSON.stringify(s)) as State;
}

// ---------- 有效优先级计算（传递捐赠） ----------

export interface EffectiveInfo {
  effective: number;
  // 决定最大值的“基础线程”：若就是自身则 source === 线程自身
  source: number;
  // 捐赠路径：从 source 到该线程的线程 id 链（经过等待边），自身时为 [id]
  path: number[];
}

// 反向邻接：holder -> 直接等待它的线程列表
function waitersOf(state: State): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const t of Object.values(state.threads)) {
    if (t.waitingOn !== null) {
      const lock = state.locks[t.waitingOn];
      if (lock && lock.holder !== null) {
        const arr = m.get(lock.holder) ?? [];
        arr.push(t.id);
        m.set(lock.holder, arr);
      }
    }
  }
  return m;
}

// 对每个线程，枚举其全部“上游”（直接/间接等待它的线程），
// 有效优先级 = max(自身基础值, 所有上游线程基础值)。
// 这等价于沿等待链逐层捐赠有效优先级，因为 max 可交换。
export function computeEffective(state: State): Map<number, EffectiveInfo> {
  const rev = waitersOf(state);
  const out = new Map<number, EffectiveInfo>();
  for (const t of Object.values(state.threads)) {
    let best = t.base;
    let source = t.id;
    // BFS 上游，记录来源路径
    const parent = new Map<number, number>(); // child -> 它等待的持有者方向上的下一跳(靠近 t)
    const visited = new Set<number>([t.id]);
    const queue: number[] = [t.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const w of rev.get(cur) ?? []) {
        if (visited.has(w)) continue;
        visited.add(w);
        parent.set(w, cur);
        const wt = state.threads[w];
        if (wt.base > best) {
          best = wt.base;
          source = w;
        }
        queue.push(w);
      }
    }
    // 还原路径 source -> ... -> t
    const path: number[] = [];
    let cur: number | undefined = source;
    while (cur !== undefined) {
      path.push(cur);
      if (cur === t.id) break;
      cur = parent.get(cur);
    }
    out.set(t.id, { effective: best, source, path });
  }
  return out;
}

// 供测试/校验用：独立枚举实现（显式沿等待边逐层传播捐赠，取定点）
export function computeEffectiveByPropagation(state: State): Map<number, number> {
  const eff = new Map<number, number>();
  for (const t of Object.values(state.threads)) eff.set(t.id, t.base);
  for (let iter = 0; iter < LIMITS.MAX_CHAIN + 2; iter++) {
    let changed = false;
    for (const t of Object.values(state.threads)) {
      if (t.waitingOn === null) continue;
      const lock = state.locks[t.waitingOn];
      if (!lock || lock.holder === null) continue;
      const donor = eff.get(t.id)!;
      if (donor > eff.get(lock.holder)!) {
        eff.set(lock.holder, donor);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return eff;
}

// ---------- 命令 ----------

export type Command =
  | { type: 'acquire'; thread: number; lock: number }
  | { type: 'release'; thread: number; lock: number }
  | { type: 'cancelWait'; thread: number }
  | { type: 'setBase'; thread: number; priority: number };

export interface CommandResult {
  ok: boolean;
  detail: string;
  transferredTo?: number; // release 时锁被转交给谁
  acquired?: boolean; // acquire 是否立即取得
  queued?: boolean; // acquire 是否进入等待
  cyclePath?: number[]; // 成环路径（线程 id）
}

function getThread(state: State, id: number): ThreadState {
  const t = state.threads[id];
  if (!t) throw new SimError('ERR_NOT_FOUND', `线程 ${id} 不存在`);
  return t;
}
function getLock(state: State, id: number): LockState {
  const l = state.locks[id];
  if (!l) throw new SimError('ERR_NOT_FOUND', `锁 ${id} 不存在`);
  return l;
}

// 从 holder 沿“持有者等待的锁的持有者”走，若回到 requester 则成环
function findCycle(state: State, requester: number, lockId: number): number[] | null {
  const path: number[] = [requester];
  let curLock: number | null = lockId;
  const seen = new Set<number>([requester]);
  let depth = 0;
  while (curLock !== null) {
    if (++depth > LIMITS.MAX_CHAIN) {
      throw new SimError('ERR_LIMIT', `等待链超过最大深度 ${LIMITS.MAX_CHAIN}`);
    }
    const lock: LockState | undefined = state.locks[curLock];
    if (!lock || lock.holder === null) return null;
    const holder: number = lock.holder;
    path.push(holder);
    if (holder === requester) return path;
    if (seen.has(holder)) return null; // 已有环但不含 requester（不应发生）
    seen.add(holder);
    curLock = state.threads[holder].waitingOn;
  }
  return null;
}

export function applyCommand(state: State, cmd: Command): CommandResult {
  switch (cmd.type) {
    case 'acquire': {
      const t = getThread(state, cmd.thread);
      const lock = getLock(state, cmd.lock);
      if (lock.holder === t.id) {
        throw new SimError('ERR_SELF_LOCK', `线程 ${t.id} 已持有非递归锁 ${lock.id}，不能重复申请`);
      }
      if (t.waitingOn !== null) {
        throw new SimError('ERR_ALREADY_WAITING', `线程 ${t.id} 正在等待锁 ${t.waitingOn}，不能发起新申请`);
      }
      if (lock.holder === null) {
        lock.holder = t.id;
        return { ok: true, acquired: true, detail: `线程 ${t.id} 立即取得空闲锁 ${lock.id}` };
      }
      const cycle = findCycle(state, t.id, lock.id);
      if (cycle) {
        throw new SimError('ERR_CYCLE', `申请将形成等待环：${cycle.join(' -> ')} -> (锁 ${lock.id})`, { cyclePath: cycle });
      }
      lock.queue.push(t.id);
      t.waitingOn = lock.id;
      t.queueSeq = state.nextQueueSeq++;
      return { ok: true, queued: true, detail: `线程 ${t.id} 进入锁 ${lock.id} 的等待队列（位置 ${lock.queue.length}）` };
    }
    case 'release': {
      const t = getThread(state, cmd.thread);
      const lock = getLock(state, cmd.lock);
      if (lock.holder !== t.id) {
        throw new SimError('ERR_NOT_HOLDER', `线程 ${t.id} 不持有锁 ${lock.id}，不能释放`);
      }
      if (lock.queue.length === 0) {
        lock.holder = null;
        return { ok: true, detail: `锁 ${lock.id} 已释放，无等待者` };
      }
      // 选择有效优先级最高者；并列按入队序号，再按线程编号
      const eff = computeEffective(state);
      let bestIdx = 0;
      for (let i = 1; i < lock.queue.length; i++) {
        const cand = lock.queue[i];
        const best = lock.queue[bestIdx];
        const ce = eff.get(cand)!.effective;
        const be = eff.get(best)!.effective;
        if (ce > be) { bestIdx = i; continue; }
        if (ce === be) {
          const cs = state.threads[cand].queueSeq!;
          const bs = state.threads[best].queueSeq!;
          if (cs < bs || (cs === bs && cand < best)) bestIdx = i;
        }
      }
      const next = lock.queue.splice(bestIdx, 1)[0];
      const nt = state.threads[next];
      nt.waitingOn = null;
      nt.queueSeq = null;
      lock.holder = next;
      return {
        ok: true,
        transferredTo: next,
        detail: `锁 ${lock.id} 从线程 ${t.id} 转交给等待者 ${next}（有效优先级 ${eff.get(next)!.effective}）`,
      };
    }
    case 'cancelWait': {
      const t = getThread(state, cmd.thread);
      if (t.waitingOn === null) {
        throw new SimError('ERR_NOT_WAITING', `线程 ${t.id} 当前没有等待任何锁`);
      }
      const lock = getLock(state, t.waitingOn);
      lock.queue = lock.queue.filter((x) => x !== t.id);
      const lid = t.waitingOn;
      t.waitingOn = null;
      t.queueSeq = null;
      return { ok: true, detail: `线程 ${t.id} 已取消对锁 ${lid} 的等待` };
    }
    case 'setBase': {
      const t = getThread(state, cmd.thread);
      if (!Number.isInteger(cmd.priority) || cmd.priority < LIMITS.MIN_PRIO || cmd.priority > LIMITS.MAX_PRIO) {
        throw new SimError('ERR_VALIDATION', `基础优先级必须是 [${LIMITS.MIN_PRIO}, ${LIMITS.MAX_PRIO}] 的整数`);
      }
      const old = t.base;
      t.base = cmd.priority;
      return { ok: true, detail: `线程 ${t.id} 基础优先级 ${old} -> ${cmd.priority}` };
    }
  }
}

// ---------- 查询 ----------

export interface ThreadView extends ThreadState {
  effective: number;
  donationSource: number;
  donationPath: number[];
  runnable: boolean; // 就绪（未等待）
}

export interface SchedulerChoice {
  thread: number;
  effective: number;
  reason: string;
}

export function schedulerPick(state: State): SchedulerChoice | null {
  const eff = computeEffective(state);
  let pick: ThreadState | null = null;
  for (const t of Object.values(state.threads)) {
    if (t.waitingOn !== null) continue; // 等待者不可运行
    if (!pick) { pick = t; continue; }
    const e = eff.get(t.id)!.effective;
    const pe = eff.get(pick.id)!.effective;
    if (e > pe || (e === pe && t.id < pick.id)) pick = t;
  }
  if (!pick) return null;
  const info = eff.get(pick.id)!;
  const reason =
    info.source === pick.id
      ? `线程 ${pick.id} 以自身基础优先级 ${info.effective} 就绪`
      : `线程 ${pick.id} 有效优先级 ${info.effective} 来自线程 ${info.source} 沿路径 ${info.path.join(' -> ')} 的捐赠`;
  return { thread: pick.id, effective: info.effective, reason };
}

export function explainDonation(state: State, threadId: number): {
  thread: number; base: number; effective: number; source: number; path: number[];
  hops: { from: number; to: number; viaLock: number }[];
} {
  const t = getThread(state, threadId);
  const info = computeEffective(state).get(threadId)!;
  const hops: { from: number; to: number; viaLock: number }[] = [];
  for (let i = 0; i + 1 < info.path.length; i++) {
    const from = info.path[i];
    const to = info.path[i + 1];
    const viaLock = state.threads[from].waitingOn!;
    hops.push({ from, to, viaLock });
  }
  return { thread: threadId, base: t.base, effective: info.effective, source: info.source, path: info.path, hops };
}
