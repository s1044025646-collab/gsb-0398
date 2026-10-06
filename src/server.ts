// HTTP API 服务（仅使用 Node 内置模块）
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { Store } from './store';
import {
  Command, SimError, computeEffective, schedulerPick, explainDonation, State,
} from './engine';

export function stateView(state: State) {
  const eff = computeEffective(state);
  return {
    threads: Object.values(state.threads).map((t) => ({
      id: t.id,
      base: t.base,
      effective: eff.get(t.id)!.effective,
      donationSource: eff.get(t.id)!.source,
      donationPath: eff.get(t.id)!.path,
      status: t.waitingOn === null ? 'ready' : 'waiting',
      waitingOn: t.waitingOn,
    })),
    locks: Object.values(state.locks).map((l) => ({
      id: l.id,
      holder: l.holder,
      waitQueue: l.queue,
    })),
    scheduler: schedulerPick(state),
  };
}

function diffStates(before: State, after: State) {
  const effB = computeEffective(before);
  const effA = computeEffective(after);
  const threads: unknown[] = [];
  for (const id of Object.keys(after.threads).map(Number)) {
    const b = before.threads[id]; const a = after.threads[id];
    const changes: Record<string, [unknown, unknown]> = {};
    if (b.base !== a.base) changes.base = [b.base, a.base];
    if (b.waitingOn !== a.waitingOn) changes.waitingOn = [b.waitingOn, a.waitingOn];
    const eb = effB.get(id)!.effective; const ea = effA.get(id)!.effective;
    if (eb !== ea) changes.effective = [eb, ea];
    if (Object.keys(changes).length) threads.push({ id, changes });
  }
  const locks: unknown[] = [];
  for (const id of Object.keys(after.locks).map(Number)) {
    const b = before.locks[id]; const a = after.locks[id];
    const changes: Record<string, [unknown, unknown]> = {};
    if (b.holder !== a.holder) changes.holder = [b.holder, a.holder];
    if (JSON.stringify(b.queue) !== JSON.stringify(a.queue)) changes.queue = [b.queue, a.queue];
    if (Object.keys(changes).length) locks.push({ id, changes });
  }
  return { threads, locks };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SimError('ERR_VALIDATION', '请求体不是合法 JSON');
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body, null, 2);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const body = req.method === 'POST' ? ((await readBody(req)) as Record<string, unknown>) : {};

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/scenarios') {
        return send(200, { scenarios: store.listScenarios() });
      }
      if (req.method === 'POST' && url.pathname === '/scenarios') {
        const threads = body.threads as Record<string, number> | Array<{ id: number; base: number }>;
        const locks = body.locks as number[];
        if (!threads || !Array.isArray(locks)) throw new SimError('ERR_VALIDATION', '需要 threads 与 locks 字段');
        const map: Record<number, number> = {};
        if (Array.isArray(threads)) for (const t of threads) map[t.id] = t.base;
        else for (const [k, v] of Object.entries(threads)) map[Number(k)] = v;
        const id = store.createScenario(String(body.name ?? 'scenario'), map, locks);
        return send(201, { id, state: stateView(store.getState(id).state) });
      }
      if (parts[0] === 'scenarios' && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new SimError('ERR_VALIDATION', '场景 id 非法');
        const sub = parts[2];
        if (req.method === 'GET' && parts.length === 2) {
          const { name, state } = store.getState(id);
          return send(200, { id, name, state: stateView(state) });
        }
        if (req.method === 'POST' && sub === 'commands') {
          const requestId = (body.requestId as string) ?? undefined;
          const { record, duplicate } = store.execute(id, body.command as Command, requestId);
          const status = record.ok ? 200 : 422;
          return send(status, {
            seq: record.seq, duplicate, ok: record.ok,
            error: record.ok ? null : { code: record.errorCode, message: record.errorMessage },
            result: record.result,
            state: stateView(store.getState(id).state),
          });
        }
        if (req.method === 'GET' && sub === 'commands' && parts.length === 3) {
          return send(200, { commands: store.history(id) });
        }
        if (req.method === 'GET' && sub === 'commands' && parts.length === 5 && parts[4] === 'diff') {
          const rec = store.getCommand(id, Number(parts[3]));
          return send(200, { seq: rec.seq, ok: rec.ok, diff: diffStates(rec.before, rec.after) });
        }
        if (req.method === 'GET' && sub === 'explain' && parts.length === 4) {
          const { state } = store.getState(id);
          return send(200, explainDonation(state, Number(parts[3])));
        }
        if (req.method === 'POST' && sub === 'fork') {
          const newId = store.fork(id, String(body.name ?? `fork-of-${id}`));
          return send(201, { id: newId, state: stateView(store.getState(newId).state) });
        }
        if (req.method === 'GET' && sub === 'export') {
          return send(200, store.exportReplay(id));
        }
      }
      return send(404, { error: { code: 'ERR_NOT_FOUND', message: '路由不存在' } });
    } catch (e) {
      if (e instanceof SimError) {
        const status = e.code === 'ERR_NOT_FOUND' ? 404
          : e.code === 'ERR_VALIDATION' || e.code === 'ERR_LIMIT' ? 400 : 422;
        return send(status, { error: { code: e.code, message: e.message, detail: e.detail ?? null } });
      }
      return send(500, { error: { code: 'ERR_INTERNAL', message: String(e) } });
    }
  });
}

export function findFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', () => {
      const s2 = net.createServer();
      s2.listen(0, '127.0.0.1', () => {
        const p = (s2.address() as net.AddressInfo).port;
        s2.close(() => resolve(p));
      });
      s2.once('error', reject);
    });
    srv.listen(preferred ?? 0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

async function main() {
  const portArg = process.env.PORT ? Number(process.env.PORT) : undefined;
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'pi-replay.db');
  const store = new Store(dbPath);
  const port = await findFreePort(portArg);
  const server = createServer(store);
  server.listen(port, '127.0.0.1', () => {
    require('node:fs').writeFileSync(path.join(process.cwd(), 'data', 'server.port'), String(port));
    console.log(`优先级继承回放服务已启动: http://127.0.0.1:${port}  (数据库: ${dbPath})`);
  });
  const shutdown = () => { server.close(); store.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
