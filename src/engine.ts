/**
 * 优先级继承 / 传递捐赠模拟引擎（纯内存、无副作用）。
 * 所有函数接收并返回普通 State 对象，持久化由 store 层负责。
 */

export const MAX_THREADS = 64;
export const MAX_LOCKS = 64;
export const MAX_CHAIN_DEPTH = 64;
export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 2 ** 31 - 1;

export interface WaitEntry {
  thread: number;
  seq: number; // 进入该等待队列的全局单调序号，用于同级排队裁决
}

export interface ThreadState {
  id: number;
  name: string;
  basePriority: number;
  waitingOn: number | null; // 正在等待的锁 id；null 表示就绪
}

export interface LockState {
  id: number;
  name: string;
  holder: number | null;
  queue: WaitEntry[]; // 按入队次序排列
}

export interface State {
  threads: Map<number, ThreadState>;
  locks: Map<number, LockState>;
  nextThreadId: number;
  nextLockId: number;
  waitSeq: number; // 已发放的等待序号计数
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown
  ) {
    super(message);
  }
}

export function emptyState(): State {
  return {
    threads: new Map(),
    locks: new Map(),
    nextThreadId: 1,
    nextLockId: 1,
    waitSeq: 0,
  };
}

export function cloneState(s: State): State {
  return {
    threads: new Map(
      [...s.threads].map(([k, t]) => [k, { ...t }])
    ),
    locks: new Map(
      [...s.locks].map(([k, l]) => [
        k,
        { ...l, queue: l.queue.map((q) => ({ ...q })) },
      ])
    ),
    nextThreadId: s.nextThreadId,
    nextLockId: s.nextLockId,
    waitSeq: s.waitSeq,
  };
}

export function validatePriority(p: unknown, field = "basePriority"): number {
  if (
    typeof p !== "number" ||
    !Number.isInteger(p) ||
    p < MIN_PRIORITY ||
    p > MAX_PRIORITY
  ) {
    throw new ApiError(
      "INVALID_PRIORITY",
      `${field} 必须是 ${MIN_PRIORITY}..${MAX_PRIORITY} 的整数`,
      400,
      { value: p }
    );
  }
  return p;
}

export function addThread(s: State, name: string, basePriority: number): ThreadState {
  if (s.threads.size >= MAX_THREADS) {
    throw new ApiError("LIMIT_THREADS", `线程数量超过上限 ${MAX_THREADS}`, 400);
  }
  validatePriority(basePriority);
  const id = s.nextThreadId++;
  const t: ThreadState = { id, name, basePriority, waitingOn: null };
  s.threads.set(id, t);
  return t;
}

export function addLock(s: State, name: string): LockState {
  if (s.locks.size >= MAX_LOCKS) {
    throw new ApiError("LIMIT_LOCKS", `锁数量超过上限 ${MAX_LOCKS}`, 400);
  }
  const id = s.nextLockId++;
  const l: LockState = { id, name, holder: null, queue: [] };
  s.locks.set(id, l);
  return l;
}

function mustThread(s: State, id: number): ThreadState {
  const t = s.threads.get(id);
  if (!t) throw new ApiError("NO_SUCH_THREAD", `线程 ${id} 不存在`, 404);
  return t;
}

function mustLock(s: State, id: number): LockState {
  const l = s.locks.get(id);
  if (!l) throw new ApiError("NO_SUCH_LOCK", `锁 ${id} 不存在`, 404);
  return l;
}

/** 捐赠来源说明：最终提供最大值的基础线程与等待路径。 */
export interface DonationSource {
  fromThread: number; // 提供该有效优先级的基础线程
  basePriority: number;
  // 路径：fromThread --等待 lock--> holder --等待 lock--> ... --> 目标线程
  path: Array<{ thread: number; waitsOnLock: number | null }>;
}

export interface EffectiveInfo {
  effective: number;
  // 若有效值来自捐赠，记录来源；若等于自身基础值则为 null
  donation: DonationSource | null;
}

/**
 * 完整重算所有线程的有效优先级。
 * eff(t) = max(base(t), max{ eff(w) | w 等待 t 持有的某把锁 })
 * 等待图无环（申请时已拒绝成环），DFS + 记忆化即可。
 */
export function computeEffective(s: State): Map<number, EffectiveInfo> {
  const memo = new Map<number, EffectiveInfo>();

  function effOf(tid: number, depth: number): EffectiveInfo {
    const hit = memo.get(tid);
    if (hit) return hit;
    if (depth > MAX_CHAIN_DEPTH) {
      throw new ApiError(
        "CHAIN_TOO_DEEP",
        `捐赠链深度超过上限 ${MAX_CHAIN_DEPTH}`,
        400
      );
    }
    const t = mustThread(s, tid);
    let best: EffectiveInfo = { effective: t.basePriority, donation: null };
    for (const lock of s.locks.values()) {
      if (lock.holder !== tid) continue;
      for (const entry of lock.queue) {
        const w = effOf(entry.thread, depth + 1);
        if (w.effective > best.effective) {
          const path: DonationSource["path"] = [
            { thread: entry.thread, waitsOnLock: lock.id },
            ...(w.donation ? w.donation.path : []),
          ];
          best = {
            effective: w.effective,
            donation: {
              fromThread: w.donation ? w.donation.fromThread : entry.thread,
              basePriority: w.effective,
              path,
            },
          };
        }
      }
    }
    memo.set(tid, best);
    return best;
  }

  for (const id of s.threads.keys()) effOf(id, 0);
  return memo;
}

/** 独立枚举实现（用于测试核对）：收集 t 的全部上游等待者基础优先级取最大。 */
export function enumerateEffective(s: State, tid: number): number {
  const t = mustThread(s, tid);
  let best = t.basePriority;
  const visited = new Set<number>();
  const stack = [tid];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const lock of s.locks.values()) {
      if (lock.holder !== cur) continue;
      for (const entry of lock.queue) {
        if (visited.has(entry.thread)) continue;
        visited.add(entry.thread);
        const w = mustThread(s, entry.thread);
        if (w.basePriority > best) best = w.basePriority;
        stack.push(entry.thread);
      }
    }
  }
  return best;
}

/** 当前应先运行的就绪线程（有效优先级最高，平局按编号小者优先）。 */
export function pickRunnable(
  s: State,
  eff?: Map<number, EffectiveInfo>
): { thread: number; effective: number } | null {
  const effMap = eff ?? computeEffective(s);
  let best: { thread: number; effective: number } | null = null;
  for (const t of s.threads.values()) {
    if (t.waitingOn !== null) continue; // 等待者不可运行
    const e = effMap.get(t.id)!.effective;
    if (!best || e > best.effective || (e === best.effective && t.id < best.thread)) {
      best = { thread: t.id, effective: e };
    }
  }
  return best;
}

/** 检查 tid 等待 lock 是否成环；若成环返回环路径（线程/锁交替），否则返回 null。 */
export function findCycle(
  s: State,
  tid: number,
  lockId: number
): Array<{ thread: number; waitsOnLock: number }> | null {
  const path: Array<{ thread: number; waitsOnLock: number }> = [];
  let cur: number | null = mustLock(s, lockId).holder;
  let guard = 0;
  while (cur !== null) {
    if (cur === tid) {
      // 闭合边：tid 正试图等待的正是 lockId
      path.push({ thread: cur, waitsOnLock: lockId });
      return path;
    }
    const t = mustThread(s, cur);
    if (t.waitingOn === null) return null;
    path.push({ thread: cur, waitsOnLock: t.waitingOn });
    cur = mustLock(s, t.waitingOn).holder;
    if (++guard > MAX_CHAIN_DEPTH) {
      throw new ApiError("CHAIN_TOO_DEEP", "等待链深度超过上限", 400);
    }
  }
  return null;
}

export interface AcquireResult {
  outcome: "acquired" | "waiting";
  thread: number;
  lock: number;
  waitSeq?: number;
}

export function acquire(s: State, tid: number, lockId: number): AcquireResult {
  const t = mustThread(s, tid);
  const lock = mustLock(s, lockId);
  if (t.waitingOn !== null) {
    throw new ApiError(
      "THREAD_WAITING",
      `线程 ${tid} 正在等待锁 ${t.waitingOn}，不能发起新的申请`,
      409,
      { waitingOn: t.waitingOn }
    );
  }
  if (lock.holder === tid) {
    throw new ApiError(
      "NONRECURSIVE_LOCK",
      `线程 ${tid} 已持有非递归锁 ${lockId}，重复申请被拒绝`,
      409
    );
  }
  if (lock.holder === null) {
    lock.holder = tid;
    return { outcome: "acquired", thread: tid, lock: lockId };
  }
  const cycle = findCycle(s, tid, lockId);
  if (cycle) {
    throw new ApiError("DEADLOCK_CYCLE", "该申请会形成等待环，已拒绝，状态未变", 409, {
      cycle: [{ thread: tid, waitsOnLock: lockId }, ...cycle],
    });
  }
  const seq = ++s.waitSeq;
  lock.queue.push({ thread: tid, seq });
  t.waitingOn = lockId;
  return { outcome: "waiting", thread: tid, lock: lockId, waitSeq: seq };
}

export interface ReleaseResult {
  thread: number;
  lock: number;
  handedTo: number | null; // 直接转交的等待者
}

export function release(s: State, tid: number, lockId: number): ReleaseResult {
  mustThread(s, tid);
  const lock = mustLock(s, lockId);
  if (lock.holder !== tid) {
    throw new ApiError(
      "NOT_HOLDER",
      `线程 ${tid} 不持有锁 ${lockId}，不能释放`,
      409,
      { holder: lock.holder }
    );
  }
  if (lock.queue.length === 0) {
    lock.holder = null;
    return { thread: tid, lock: lockId, handedTo: null };
  }
  // 在转交前按当前有效优先级选择等待者：最高有效值，平局按入队序号，再按编号
  const eff = computeEffective(s);
  let bestIdx = 0;
  for (let i = 1; i < lock.queue.length; i++) {
    const cand = lock.queue[i];
    const best = lock.queue[bestIdx];
    const ce = eff.get(cand.thread)!.effective;
    const be = eff.get(best.thread)!.effective;
    if (
      ce > be ||
      (ce === be &&
        (cand.seq < best.seq ||
          (cand.seq === best.seq && cand.thread < best.thread)))
    ) {
      bestIdx = i;
    }
  }
  const [chosen] = lock.queue.splice(bestIdx, 1);
  const wt = mustThread(s, chosen.thread);
  wt.waitingOn = null;
  lock.holder = chosen.thread;
  return { thread: tid, lock: lockId, handedTo: chosen.thread };
}

export function cancelWait(s: State, tid: number): { thread: number; lock: number } {
  const t = mustThread(s, tid);
  if (t.waitingOn === null) {
    throw new ApiError("NOT_WAITING", `线程 ${tid} 不在等待任何锁`, 409);
  }
  const lock = mustLock(s, t.waitingOn);
  const idx = lock.queue.findIndex((q) => q.thread === tid);
  if (idx >= 0) lock.queue.splice(idx, 1);
  const lockId = t.waitingOn;
  t.waitingOn = null;
  return { thread: tid, lock: lockId };
}

export function setBasePriority(
  s: State,
  tid: number,
  priority: number
): { thread: number; basePriority: number } {
  const t = mustThread(s, tid);
  validatePriority(priority);
  t.basePriority = priority;
  return { thread: tid, basePriority: priority };
}

export type CommandPayload =
  | { type: "addThread"; name?: string; basePriority: number }
  | { type: "addLock"; name?: string }
  | { type: "acquire"; thread: number; lock: number }
  | { type: "release"; thread: number; lock: number }
  | { type: "cancelWait"; thread: number }
  | { type: "setBasePriority"; thread: number; priority: number };

export function applyCommand(s: State, cmd: CommandPayload): unknown {
  switch (cmd.type) {
    case "addThread":
      return addThread(s, cmd.name ?? `T${s.nextThreadId}`, cmd.basePriority);
    case "addLock":
      return addLock(s, cmd.name ?? `L${s.nextLockId}`);
    case "acquire":
      return acquire(s, cmd.thread, cmd.lock);
    case "release":
      return release(s, cmd.thread, cmd.lock);
    case "cancelWait":
      return cancelWait(s, cmd.thread);
    case "setBasePriority":
      return setBasePriority(s, cmd.thread, cmd.priority);
    default:
      throw new ApiError("UNKNOWN_COMMAND", `未知命令类型`, 400, { cmd });
  }
}

/** 可序列化的状态视图（含有效优先级与捐赠解释）。 */
export function stateView(s: State) {
  const eff = computeEffective(s);
  const runnable = pickRunnable(s, eff);
  return {
    threads: [...s.threads.values()].map((t) => {
      const e = eff.get(t.id)!;
      return {
        id: t.id,
        name: t.name,
        basePriority: t.basePriority,
        effectivePriority: e.effective,
        state: t.waitingOn === null ? "ready" : "waiting",
        waitingOn: t.waitingOn,
        donation: e.donation,
      };
    }),
    locks: [...s.locks.values()].map((l) => ({
      id: l.id,
      name: l.name,
      holder: l.holder,
      queue: l.queue.map((q) => ({
        thread: q.thread,
        seq: q.seq,
        effectivePriority: eff.get(q.thread)!.effective,
      })),
    })),
    runnable,
  };
}
