import { test } from "node:test";
import assert from "node:assert/strict";
import {
  State,
  emptyState,
  addThread,
  addLock,
  acquire,
  release,
  cancelWait,
  setBasePriority,
  computeEffective,
  enumerateEffective,
  pickRunnable,
  ApiError,
} from "../src/engine";

/** 构造 L/M/H/R 演示场景：L=1 持 X，M=3 持 Y 等 X，H=8 等 Y，R=6 就绪。 */
function demoState() {
  const s = emptyState();
  addThread(s, "L", 1); // 1
  addThread(s, "M", 3); // 2
  addThread(s, "H", 8); // 3
  addThread(s, "R", 6); // 4
  addLock(s, "X"); // 1
  addLock(s, "Y"); // 2
  acquire(s, 1, 1);
  acquire(s, 2, 2);
  acquire(s, 2, 1);
  acquire(s, 3, 2);
  return s;
}

test("传递继承：M 与 L 都继承到 8，L 先于 R=6 运行", () => {
  const s = demoState();
  const eff = computeEffective(s);
  assert.equal(eff.get(1)!.effective, 8);
  assert.equal(eff.get(2)!.effective, 8);
  assert.equal(eff.get(3)!.effective, 8);
  assert.equal(eff.get(4)!.effective, 6);
  assert.equal(pickRunnable(s, eff)!.thread, 1); // L 就绪且有效值 8 > R 的 6
});

test("释放后转交：X 交给 M，L 降回 1，M 仍受 H 捐赠", () => {
  const s = demoState();
  const r = release(s, 1, 1);
  assert.equal(r.handedTo, 2);
  const eff = computeEffective(s);
  assert.equal(eff.get(1)!.effective, 1);
  assert.equal(eff.get(2)!.effective, 8);
  assert.equal(s.threads.get(2)!.waitingOn, null);
  assert.equal(s.locks.get(1)!.holder, 2);
});

test("独立枚举核对：随机/构造场景下重算结果与枚举一致", () => {
  const s = demoState();
  // 再加一条独立链：P=2 持 Z，Q=9 等 Z -> P 继承 9
  addThread(s, "P", 2); // 5
  addThread(s, "Q", 9); // 6
  addLock(s, "Z"); // 3
  acquire(s, 5, 3);
  acquire(s, 6, 3);
  for (const id of s.threads.keys()) {
    assert.equal(
      computeEffective(s).get(id)!.effective,
      enumerateEffective(s, id),
      `线程 ${id} 的有效优先级与独立枚举不一致`
    );
  }
});

test("解释链真实存在：路径上的每条等待边都在状态中", () => {
  const s = demoState();
  const info = computeEffective(s).get(1)!;
  assert.equal(info.donation!.fromThread, 3);
  // 路径（从直接等待者到捐赠源头）: T2 --等X--> T1, T3 --等Y--> T2
  const path = info.donation!.path;
  assert.deepEqual(
    path.map((p) => [p.thread, p.waitsOnLock]),
    [
      [2, 1],
      [3, 2],
    ]
  );
  for (const p of path) {
    assert.equal(s.threads.get(p.thread)!.waitingOn, p.waitsOnLock);
    assert.ok(
      s.locks.get(p.waitsOnLock!)!.queue.some((q) => q.thread === p.thread)
    );
  }
});

test("双重捐赠：两个等待者向同一持有者捐赠，取最大", () => {
  const s = emptyState();
  addThread(s, "A", 2); // 1
  addThread(s, "B", 5); // 2
  addThread(s, "C", 7); // 3
  addLock(s, "X"); // 1
  addLock(s, "Y"); // 2
  acquire(s, 1, 1);
  acquire(s, 1, 2);
  acquire(s, 2, 1); // B 等 X
  acquire(s, 3, 2); // C 等 Y
  const eff = computeEffective(s);
  assert.equal(eff.get(1)!.effective, 7);
  // 取消 C 后，A 只保留 B 的捐赠
  cancelWait(s, 3);
  assert.equal(computeEffective(s).get(1)!.effective, 5);
});

test("取消等待：捐赠来源消失后高值不保留", () => {
  const s = demoState();
  cancelWait(s, 3); // H 取消等 Y
  const eff = computeEffective(s);
  // H 的 8 不再保留；M 回落到自身 3，L 继承 M 的 3
  assert.equal(eff.get(1)!.effective, 3);
  assert.equal(eff.get(2)!.effective, 3);
  cancelWait(s, 2); // M 也取消后，L 彻底回到基础值
  assert.equal(computeEffective(s).get(1)!.effective, 1);
  assert.equal(s.threads.get(3)!.waitingOn, null);
});

test("基础值变化：调高参与捐赠，调低立即回落", () => {
  const s = demoState();
  setBasePriority(s, 3, 4); // H 降到 4
  assert.equal(computeEffective(s).get(1)!.effective, 4);
  setBasePriority(s, 3, 9);
  assert.equal(computeEffective(s).get(1)!.effective, 9);
});

test("同级排队：有效值相同按入队次序转交", () => {
  const s = emptyState();
  addThread(s, "A", 1); // 1
  addThread(s, "B", 5); // 2
  addThread(s, "C", 5); // 3
  addLock(s, "X"); // 1
  acquire(s, 1, 1);
  acquire(s, 2, 1); // B 先排队
  acquire(s, 3, 1); // C 后排队
  const r = release(s, 1, 1);
  assert.equal(r.handedTo, 2); // 同级先入队者得
});

test("转交选择按有效优先级：高有效值等待者优先于先入队者", () => {
  const s = emptyState();
  addThread(s, "A", 1); // 1
  addThread(s, "B", 3); // 2 先入队
  addThread(s, "C", 2); // 3 后入队，但被 D=9 捐赠
  addThread(s, "D", 9); // 4
  addLock(s, "X"); // 1
  addLock(s, "Y"); // 2
  acquire(s, 1, 1);
  acquire(s, 3, 2); // C 持 Y
  acquire(s, 4, 2); // D 等 Y -> C 有效值 9
  acquire(s, 2, 1); // B 等 X
  acquire(s, 3, 1); // C 等 X（先释放? 不行，C 持有 Y 且等待 X）
  const r = release(s, 1, 1);
  assert.equal(r.handedTo, 3); // C 有效值 9 > B 的 3
});

test("非持有者释放被拒绝", () => {
  const s = demoState();
  assert.throws(() => release(s, 4, 1), (e: ApiError) => e.code === "NOT_HOLDER");
});

test("环路拒绝：展示成环路径且状态不变", () => {
  const s = emptyState();
  addThread(s, "A", 1); // 1
  addThread(s, "B", 2); // 2
  addLock(s, "X"); // 1
  addLock(s, "Y"); // 2
  acquire(s, 1, 1); // A 持 X
  acquire(s, 2, 2); // B 持 Y
  acquire(s, 1, 2); // A 等 Y
  const before = JSON.stringify([...s.locks.values()]);
  assert.throws(
    () => acquire(s, 2, 1), // B 等 X 将成环 A->Y->B->X->A
    (e: ApiError) => {
      assert.equal(e.code, "DEADLOCK_CYCLE");
      const cycle = (e.details as any).cycle;
      assert.deepEqual(
        cycle.map((c: any) => [c.thread, c.waitsOnLock]),
        [
          [2, 1],
          [1, 2],
          [2, 1],
        ]
      );
      return true;
    }
  );
  assert.equal(JSON.stringify([...s.locks.values()]), before);
  assert.equal(s.threads.get(2)!.waitingOn, null);
});

test("非法命令区分：等待中线程不能再申请；非递归重入被拒绝", () => {
  const s = demoState();
  assert.throws(() => acquire(s, 2, 2), (e: ApiError) => e.code === "THREAD_WAITING");
  assert.throws(
    () => acquire(s, 1, 1),
    (e: ApiError) => e.code === "NONRECURSIVE_LOCK"
  );
  assert.throws(() => cancelWait(s, 1), (e: ApiError) => e.code === "NOT_WAITING");
});

test("等待者不会被当作可运行", () => {
  const s = emptyState();
  addThread(s, "A", 1); // 1
  addThread(s, "B", 10); // 2 最高但等待
  addLock(s, "X");
  acquire(s, 1, 1);
  acquire(s, 2, 1);
  assert.equal(pickRunnable(s)!.thread, 1);
});
