/**
 * CLI 入口：
 *   node dist/src/cli.js serve [--port N] [--db PATH]
 *   node dist/src/cli.js demo
 *   node dist/src/cli.js new <name> [--db PATH]
 *   node dist/src/cli.js cmd <scenarioId> <requestId> <jsonPayload> [--db PATH]
 *   node dist/src/cli.js state|scheduler|export <scenarioId> [--db PATH]
 *   node dist/src/cli.js explain <scenarioId> <threadId> [--db PATH]
 *   node dist/src/cli.js derive <scenarioId> <name> [--db PATH]
 *   node dist/src/cli.js replay <file> [--db PATH]   从导出文件重建场景
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "./store";
import { startServer } from "./server";
import { CommandPayload, computeEffective, stateView } from "./engine";

const DEFAULT_DB = path.join(process.cwd(), "data", "pi.db");

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function openStore(args: string[]): Store {
  return new Store(argValue(args, "--db") ?? process.env.PI_DB ?? DEFAULT_DB);
}

function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve": {
      const port = Number(argValue(rest, "--port") ?? process.env.PORT ?? 0);
      const store = openStore(rest);
      const { port: actual } = await startServer(store, port);
      console.log(`PI 模拟服务已启动: http://127.0.0.1:${actual}`);
      break;
    }
    case "demo": {
      const dbPath = path.join(process.cwd(), "data", "demo.db");
      fs.rmSync(dbPath, { force: true });
      const store = new Store(dbPath);
      runDemo(store);
      store.close();
      break;
    }
    case "new": {
      const store = openStore(rest);
      print({ id: store.createScenario(rest[0]) });
      store.close();
      break;
    }
    case "cmd": {
      const store = openStore(rest);
      const [sid, requestId, json] = rest;
      const payload = JSON.parse(json) as CommandPayload;
      print(store.applyCommand(Number(sid), requestId, payload));
      store.close();
      break;
    }
    case "state": {
      const store = openStore(rest);
      print(stateView(store.loadState(Number(rest[0]))));
      store.close();
      break;
    }
    case "scheduler": {
      const store = openStore(rest);
      print(stateView(store.loadState(Number(rest[0]))).runnable);
      store.close();
      break;
    }
    case "explain": {
      const store = openStore(rest);
      const state = store.loadState(Number(rest[0]));
      const tid = Number(rest[1]);
      const info = computeEffective(state).get(tid);
      print({ thread: tid, ...info });
      store.close();
      break;
    }
    case "derive": {
      const store = openStore(rest);
      print({ id: store.deriveScenario(Number(rest[0]), rest[1]) });
      store.close();
      break;
    }
    case "export": {
      const store = openStore(rest);
      print(store.exportReplay(Number(rest[0])));
      store.close();
      break;
    }
    case "replay": {
      const file = rest[0];
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const store = openStore(rest);
      const sid = store.createScenario(`${data.scenario?.name ?? "replay"}-replay`);
      for (const c of data.commands) {
        store.applyCommand(sid, c.requestId, c.payload);
      }
      print({ id: sid, state: stateView(store.loadState(sid)) });
      store.close();
      break;
    }
    default:
      console.error(
        "用法: serve|demo|new|cmd|state|scheduler|explain|derive|export|replay（见 README.md）"
      );
      process.exitCode = 1;
  }
}

/** 演示：L=1 持 X，M=3 持 Y 等 X，H=8 等 Y，另有 R=6 就绪。 */
function runDemo(store: Store) {
  const sid = store.createScenario("demo-pi");
  let n = 0;
  const run = (payload: CommandPayload) => {
    const rec = store.applyCommand(sid, `demo-${++n}`, payload);
    const view = stateView(store.loadState(sid));
    console.log(`\n#${n} ${JSON.stringify(payload)}`);
    console.log(`  -> ${JSON.stringify(rec.result ?? rec.error)}`);
    console.log(
      `  有效优先级: ${view.threads
        .map((t) => `${t.name}=${t.effectivePriority}(base ${t.basePriority})`)
        .join(", ")} | 应先运行: ${
        view.runnable
          ? view.threads.find((t) => t.id === view.runnable!.thread)?.name
          : "无"
      }`
    );
    return rec;
  };
  run({ type: "addThread", name: "L", basePriority: 1 });
  run({ type: "addThread", name: "M", basePriority: 3 });
  run({ type: "addThread", name: "H", basePriority: 8 });
  run({ type: "addThread", name: "R", basePriority: 6 });
  run({ type: "addLock", name: "X" });
  run({ type: "addLock", name: "Y" });
  run({ type: "acquire", thread: 1, lock: 1 }); // L 持 X
  run({ type: "acquire", thread: 2, lock: 2 }); // M 持 Y
  run({ type: "acquire", thread: 2, lock: 1 }); // M 等 X
  run({ type: "acquire", thread: 3, lock: 2 }); // H 等 Y -> M、L 继承到 8
  run({ type: "release", thread: 1, lock: 1 }); // X 转交 M，L 降回 1
  run({ type: "release", thread: 2, lock: 2 }); // Y 转交 H
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  });
}
