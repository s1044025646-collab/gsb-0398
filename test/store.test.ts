import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../src/store';
import { computeEffective } from '../src/engine';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-')), 'test.db');
}

test('幂等：重复 requestId 返回原结果，不产生新记录', () => {
  const store = new Store(tmpDb());
  const id = store.createScenario('t', { 1: 1, 2: 5 }, [10]);
  const r1 = store.execute(id, { type: 'acquire', thread: 1, lock: 10 }, 'req-1');
  const r2 = store.execute(id, { type: 'acquire', thread: 1, lock: 10 }, 'req-1');
  assert.equal(r2.duplicate, true);
  assert.equal(r1.record.seq, r2.record.seq);
  assert.equal(store.history(id).length, 1);
  store.close();
});

test('失败回滚：失败命令不留下半次转交，状态与失败前一致', () => {
  const store = new Store(tmpDb());
  const id = store.createScenario('t', { 1: 1, 2: 2, 3: 3 }, [10, 11, 12]);
  store.execute(id, { type: 'acquire', thread: 1, lock: 10 });
  store.execute(id, { type: 'acquire', thread: 2, lock: 11 });
  store.execute(id, { type: 'acquire', thread: 3, lock: 12 });
  store.execute(id, { type: 'acquire', thread: 1, lock: 11 });
  store.execute(id, { type: 'acquire', thread: 2, lock: 12 });
  const before = store.getState(id).state;
  const r = store.execute(id, { type: 'acquire', thread: 3, lock: 10 });
  assert.equal(r.record.ok, false);
  assert.equal(r.record.errorCode, 'ERR_CYCLE');
  assert.deepEqual(store.getState(id).state, before);
  const ok = store.execute(id, { type: 'release', thread: 3, lock: 12 });
  assert.equal(ok.record.ok, true);
  assert.equal(ok.record.result!.transferredTo, 2);
  store.close();
});

test('重启一致：关闭后重开数据库，状态与历史完整恢复', () => {
  const db = tmpDb();
  let store = new Store(db);
  const id = store.createScenario('t', { 1: 1, 2: 3, 3: 8 }, [10, 11]);
  store.execute(id, { type: 'acquire', thread: 1, lock: 10 });
  store.execute(id, { type: 'acquire', thread: 2, lock: 11 });
  store.execute(id, { type: 'acquire', thread: 2, lock: 10 });
  store.execute(id, { type: 'acquire', thread: 3, lock: 11 });
  const stateBefore = store.getState(id).state;
  const histBefore = store.history(id);
  store.close();

  store = new Store(db);
  const stateAfter = store.getState(id).state;
  assert.deepEqual(stateAfter, stateBefore);
  assert.equal(store.history(id).length, histBefore.length);
  const eff = computeEffective(stateAfter);
  assert.equal(eff.get(1)!.effective, 8);
  const r = store.execute(id, { type: 'release', thread: 1, lock: 10 });
  assert.equal(r.record.result!.transferredTo, 2);
  store.close();
});

test('fork 与 export：快照派生独立场景，导出包含完整回放', () => {
  const store = new Store(tmpDb());
  const id = store.createScenario('t', { 1: 1, 2: 5 }, [10]);
  store.execute(id, { type: 'acquire', thread: 1, lock: 10 });
  store.execute(id, { type: 'acquire', thread: 2, lock: 10 });
  const forkId = store.fork(id, 'forked');
  store.execute(forkId, { type: 'release', thread: 1, lock: 10 });
  assert.equal(store.getState(forkId).state.locks[10].holder, 2);
  assert.equal(store.getState(id).state.locks[10].holder, 1);
  const exp = store.exportReplay(id);
  assert.deepEqual(exp.initialThreads, { 1: 1, 2: 5 });
  assert.deepEqual(exp.locks, [10]);
  assert.equal(exp.commands.length, 2);
  store.close();
});

test('数量限制：超过线程上限被拒绝', () => {
  const store = new Store(tmpDb());
  const threads: Record<number, number> = {};
  for (let i = 0; i < 100; i++) threads[i] = 1;
  assert.throws(() => store.createScenario('big', threads, [1]),
    (e: unknown) => (e as { code: string }).code === 'ERR_LIMIT');
  store.close();
});
