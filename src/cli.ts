// CLI：通过 HTTP 与本地服务交互。服务启动后会把端口写入 data/server.port。
import * as fs from 'node:fs';
import * as path from 'node:path';

function serverUrl(): string {
  if (process.env.SERVER_URL) return process.env.SERVER_URL;
  const portFile = path.join(process.cwd(), 'data', 'server.port');
  if (fs.existsSync(portFile)) {
    return `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').trim()}`;
  }
  return 'http://127.0.0.1:8787';
}

async function call(method: string, p: string, body?: unknown): Promise<unknown> {
  const res = await fetch(serverUrl() + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string } }).error;
    console.error(`错误 [${err?.code ?? res.status}] ${err?.message ?? res.statusText}`);
    process.exitCode = 1;
    return null;
  }
  return data;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  switch (cmd) {
    case 'list':
      return show(await call('GET', '/scenarios'));
    case 'create': {
      const [name, threadsSpec, locksSpec] = rest;
      const threads: Record<number, number> = {};
      for (const part of threadsSpec.split(',')) {
        const [id, base] = part.split(':').map(Number);
        threads[id] = base;
      }
      const locks = locksSpec.split(',').map(Number);
      return show(await call('POST', '/scenarios', { name, threads, locks }));
    }
    case 'state':
      return show(await call('GET', `/scenarios/${rest[0]}`));
    case 'cmd': {
      const [sid, requestId, type, ...kv] = rest;
      const command: Record<string, unknown> = { type };
      for (const token of kv) {
        const eq = token.indexOf('=');
        if (eq > 0) command[token.slice(0, eq)] = Number(token.slice(eq + 1));
      }
      return show(await call('POST', `/scenarios/${sid}/commands`, { requestId, command }));
    }
    case 'explain':
      return show(await call('GET', `/scenarios/${rest[0]}/explain/${rest[1]}`));
    case 'history':
      return show(await call('GET', `/scenarios/${rest[0]}/commands`));
    case 'diff':
      return show(await call('GET', `/scenarios/${rest[0]}/commands/${rest[1]}/diff`));
    case 'fork':
      return show(await call('POST', `/scenarios/${rest[0]}/fork`, { name: rest[1] }));
    case 'export':
      return show(await call('GET', `/scenarios/${rest[0]}/export`));
    default:
      console.log('用法: node dist/cli.js <命令> [参数]');
      console.log('  list                                   列出场景');
      console.log('  create <名> <线程:基础,...> <锁,...>     创建场景，如 create demo 1:1,2:3,3:8 10,11');
      console.log('  state <场景id>                          查看线程/锁/调度选择');
      console.log('  cmd <场景id> <请求编号> <类型> k=v...    推进命令');
      console.log('      类型: acquire thread=1 lock=10 | release thread=1 lock=10');
      console.log('            cancelWait thread=1 | setBase thread=1 priority=5');
      console.log('  explain <场景id> <线程id>               解释捐赠链');
      console.log('  history <场景id>                        命令流水（回放）');
      console.log('  diff <场景id> <命令序号>                查看该命令前后差异');
      console.log('  fork <场景id> <新名>                    从当前快照派生新场景');
      console.log('  export <场景id>                         导出回放脚本');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
