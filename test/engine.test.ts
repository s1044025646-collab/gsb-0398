import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  State, emptyState, applyCommand, computeEffective, computeEffectiveByPropagation,
  schedulerPick, explainDonation, SimError,
} from '../src/engine';

function makeState(threads: Record<number, number>, locks: number[]): State {
  const s = emptyState();
  for (const [id, base] of Object.entries(threads)) {
    s.threads[Number(id)] = { id: Number(id), base, waitingOn: null, queueSeq: null };
  }
  for (const id of locks) s.locks[id] = { id, holder: null, queue: [] };
  return s;
}

// 经典场景：L=1 持 X，M=3 持 Y 等 X，H=8 等 Y，R=6 就绪
function classic(): State {
  const s = makeState({ 1: 1, 2: 3, 3: 8, 4: 6 }, [10, 11]);
  applyCommand(s, { type: 'acquire', thread: 1, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 2, lock: 11 });
  applyCommand(s, { type: 'acquire', thread: 2, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 3, lock: 11 });
  return s;
}

test('传递捐赠：M 与 L 都继承到 8，与独立传播枚举一致', () => {
  const s = classic();
  const eff = computeEffective(s);
  assert.equal(eff.get(2)!.effective, 8);
  assert.equal(eff.get(1)!.effective, 8);
  const prop = computeEffectiveByPropagation(s);
  for (const [id, e] of eff) assert.equal(prop.get(id), e.effective, `线程 ${id}`);
});

test('调度选择：有效 8 的 L 优先于就绪的 R=6；等待者不参与', () => {
  const s = classic();
  const pick = schedulerPick(s)!;
  assert.equal(pick.thread, 1);
  assert.equal(pick.effective, 8);
  assert.match(pick.reason, /捐赠/);
});

test('解释链真实存在：L 的路径为 3 -> 2 -> 1，每跳有对应锁', () => {
  const s = classic();
  const ex = explainDonation(s, 1);
  assert.equal(ex.source, 3);
  assert.deepEqual(ex.path, [3, 2, 1]);
  assert.deepEqual(ex.hops, [
    { from: 3, to: 2, viaLock: 11 },
    { from: 2, to: 1, viaLock: 10 },
  ]);
  for (const h of ex.hops) {
    assert.equal(s.threads[h.from].waitingOn, h.viaLock);
    assert.equal(s.locks[h.viaLock].holder, h.to);
  }
});

test('释放转交：X 给 M，L 降回 1，M 仍受 H 捐赠', () => {
  const s = classic();
  const r = applyCommand(s, { type: 'release', thread: 1, lock: 10 });
  assert.equal(r.transferredTo, 2);
  const eff = computeEffective(s);
  assert.equal(eff.get(1)!.effective, 1);
  assert.equal(eff.get(2)!.effective, 8);
  assert.equal(s.locks[10].holder, 2);
  assert.equal(s.threads[2].waitingOn, null);
});

test('双重捐赠：两个等待者捐给同一线程取最大；取消后回落', () => {
  const s = makeState({ 1: 2, 2: 5, 3: 7 }, [10]);
  applyCommand(s, { type: 'acquire', thread: 1, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 2, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 3, lock: 10 });
  assert.equal(computeEffective(s).get(1)!.effective, 7);
  applyCommand(s, { type: 'cancelWait', thread: 3 });
  assert.equal(computeEffective(s).get(1)!.effective, 5);
  const prop = computeEffectiveByPropagation(s);
  for (const [id, e] of computeEffective(s)) assert.equal(prop.get(id), e.effective);
});

test('同级排队：释放时同有效优先级按入队次序转交', () => {
  const s = makeState({ 1: 1, 2: 4, 3: 4 }, [10]);
  applyCommand(s, { type: 'acquire', thread: 1, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 3, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 2, lock: 10 });
  const r = applyCommand(s, { type: 'release', thread: 1, lock: 10 });
  assert.equal(r.transferredTo, 3);
});

test('基础值变化：调低后捐赠消失即回落，调高立即生效', () => {
  const s = makeState({ 1: 1, 2: 9 }, [10]);
  applyCommand(s, { type: 'acquire', thread: 1, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 2, lock: 10 });
  assert.equal(computeEffective(s).get(1)!.effective, 9);
  applyCommand(s, { type: 'setBase', thread: 2, priority: 3 });
  assert.equal(computeEffective(s).get(1)!.effective, 3);
  applyCommand(s, { type: 'setBase', thread: 1, priority: 6 });
  assert.equal(computeEffective(s).get(1)!.effective, 6);
});

test('非持有者释放被拒绝，状态不变', () => {
  const s = classic();
  const before = JSON.stringify(s);
  assert.throws(
    () => applyCommand(s, { type: 'release', thread: 1, lock: 11 }),
    (e: unknown) => (e as SimError).code === 'ERR_NOT_HOLDER',
  );
  assert.equal(JSON.stringify(s), before);
});

test('环路拒绝：展示成环路径，原状态不变，不消耗排队序号', () => {
  const s = makeState({ 1: 1, 2: 2, 3: 3 }, [10, 11, 12]);
  applyCommand(s, { type: 'acquire', thread: 1, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 2, lock: 11 });
  applyCommand(s, { type: 'acquire', thread: 3, lock: 12 });
  applyCommand(s, { type: 'acquire', thread: 1, lock: 11 });
  applyCommand(s, { type: 'acquire', thread: 2, lock: 12 });
  const seqBefore = s.nextQueueSeq;
  const stateBefore = JSON.stringify(s);
  try {
    applyCommand(s, { type: 'acquire', thread: 3, lock: 10 });
    assert.fail('应当拒绝');
  } catch (e) {
    assert.ok(e instanceof SimError);
    assert.equal((e as SimError).code, 'ERR_CYCLE');
    assert.match((e as SimError).message, /3 -> 1 -> 2 -> 3/);
  }
  assert.equal(s.nextQueueSeq, seqBefore);
  assert.equal(JSON.stringify(s), stateBefore);
});

test('自锁与等待中再申请被拒绝', () => {
  const s = makeState({ 1: 1 }, [10, 11]);
  applyCommand(s, { type: 'acquire', thread: 1, lock: 10 });
  assert.throws(() => applyCommand(s, { type: 'acquire', thread: 1, lock: 10 }),
    (e: unknown) => (e as SimError).code === 'ERR_SELF_LOCK');
  const s2 = makeState({ 1: 1, 2: 2 }, [10, 11]);
  applyCommand(s2, { type: 'acquire', thread: 2, lock: 10 });
  applyCommand(s2, { type: 'acquire', thread: 1, lock: 10 });
  assert.throws(() => applyCommand(s2, { type: 'acquire', thread: 1, lock: 11 }),
    (e: unknown) => (e as SimError).code === 'ERR_ALREADY_WAITING');
});

test('取消等待后线程回到就绪并可被调度', () => {
  const s = makeState({ 1: 1, 2: 8 }, [10]);
  applyCommand(s, { type: 'acquire', thread: 1, lock: 10 });
  applyCommand(s, { type: 'acquire', thread: 2, lock: 10 });
  applyCommand(s, { type: 'cancelWait', thread: 2 });
  assert.equal(s.threads[2].waitingOn, null);
  assert.equal(s.locks[10].queue.length, 0);
  const pick = schedulerPick(s)!;
  assert.equal(pick.thread, 2);
});
