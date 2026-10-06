import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { stateView } from "../src/engine";

function tmpDb() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-")),
    "test.db"
  );
}

function buildDemo(store: Store, sid: number) {
  const cmds: any[] = [
    { type: "addThread", name: "L", basePriority: 1 },
    { type: "addThread", name: "M", basePriority: 3 },
    { type: "addThread", name: "H", basePriority: 8 },
    { type: "addLock", name: "X" },
    { type: "addLock", name: "Y" },
    { type: "acquire", thread: 1, lock: 1 },
    { type: "acquire", thread: 2, lock: 2 },
    { type: "acquire", thread: 2, lock: 1 },
    { type: "acquire", thread: 3, lock: 2 },
  ];
  cmds.forEach((p, i) => store.applyCommand(sid, `r${i}`, p));
}

test("幂等：重复 requestId 返回原结果，不消耗排队序号", () => {
  const store = new Store(tmpDb());
  const sid = store.createScenario("s");
  store.applyCommand(sid, "a", { type: "addThread", name: "A", basePriority: 1 });
  store.applyCommand(sid, "b", { type: "addThread", name: "B", basePriority: 2 });
  store.applyCommand(sid, "c", { type: "addLock", name: "X" });
  store.applyCommand(sid, "d", { type: "acquire", thread: 1, lock: 1 });
  const first = store.applyCommand(sid, "e", { type: "acquire", thread: 2, lock: 1 });
  const again = store.applyCommand(sid, "e", { type: "acquire", thread: 2, lock: 1 });
  assert.equal(again.seq, first.seq);
  assert.deepEqual(again.result, first.result);
  // 队列中仍只有一个等待者
  const view = stateView(store.loadState(sid));
  assert.equal(view.locks[0].queue.length, 1);
  store.close();
});

test("失败回滚：失败命令不改变状态，也不消耗等待序号", () => {
  const store = new Store(tmpDb());
  const sid = store.createScenario("s");
  buildDemo(store, sid);
  const before = stateView(store.loadState(sid));
  const fail = store.applyCommand(sid, "bad", { type: "release", thread: 3, lock: 1 });
  assert.equal(fail.ok, false);
  assert.equal((fail.error as any).code, "NOT_HOLDER");
  const after = stateView(store.loadState(sid));
  assert.deepEqual(after, before);
  // 之后的正常命令拿到的等待序号连续（未被失败命令消耗）
  store.applyCommand(sid, "t4", { type: "addThread", name: "K", basePriority: 4 });
  const ok = store.applyCommand(sid, "acq4", { type: "acquire", thread: 4, lock: 2 });
  assert.equal((ok.result as any).waitSeq, 3); // 前两条等待边用了 1、2
  store.close();
});

test("重启一致：关闭后重开数据库，状态与命令历史完整", () => {
  const db = tmpDb();
  let store = new Store(db);
  const sid = store.createScenario("s");
  buildDemo(store, sid);
  const before = stateView(store.loadState(sid));
  const cmdCount = store.listCommands(sid).length;
  store.close();

  store = new Store(db);
  const after = stateView(store.loadState(sid));
  assert.deepEqual(after, before);
  assert.equal(store.listCommands(sid).length, cmdCount);
  // 重启后继续推进
  const rec = store.applyCommand(sid, "rel", { type: "release", thread: 1, lock: 1 });
  assert.equal((rec.result as any).handedTo, 2);
  store.close();
});

test("派生与导出：derive 复制当前状态，export 可重放复原", () => {
  const db = tmpDb();
  const store = new Store(db);
  const sid = store.createScenario("s");
  buildDemo(store, sid);
  const derived = store.deriveScenario(sid, "d");
  assert.deepEqual(
    stateView(store.loadState(derived)),
    stateView(store.loadState(sid))
  );
  // 场景隔离：派生场景推进不影响原场景
  store.applyCommand(derived, "x1", { type: "release", thread: 1, lock: 1 });
  assert.notDeepEqual(
    stateView(store.loadState(derived)),
    stateView(store.loadState(sid))
  );
  // 导出重放
  const replay = store.exportReplay(sid);
  const sid2 = store.createScenario("replayed");
  for (const c of replay.commands) store.applyCommand(sid2, c.requestId, c.payload);
  assert.deepEqual(
    stateView(store.loadState(sid2)),
    stateView(store.loadState(sid))
  );
  store.close();
});
