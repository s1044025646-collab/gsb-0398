// 演示脚本：在内存数据库上启动临时服务，跑题目要求的经典场景。
import { Store } from './store';
import { createServer, findFreePort } from './server';

async function main() {
  const store = new Store(':memory:');
  const port = await findFreePort();
  const server = createServer(store);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, b: unknown) => (await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  })).json();
  const get = async (p: string) => (await fetch(base + p)).json();
  const show = (label: string, x: unknown) =>
    console.log(`\n=== ${label} ===\n${JSON.stringify(x, null, 2)}`);

  // 线程: 1=L(基1) 2=M(基3) 3=H(基8) 4=R(基6)；锁: 10=X 11=Y
  const sc = (await post('/scenarios', {
    name: 'demo', threads: { 1: 1, 2: 3, 3: 8, 4: 6 }, locks: [10, 11],
  })) as { id: number };
  const id = sc.id;
  const cmd = (req: string, command: unknown) =>
    post(`/scenarios/${id}/commands`, { requestId: req, command });

  await cmd('c1', { type: 'acquire', thread: 1, lock: 10 }); // L 拿 X
  await cmd('c2', { type: 'acquire', thread: 2, lock: 11 }); // M 拿 Y
  await cmd('c3', { type: 'acquire', thread: 2, lock: 10 }); // M 等 X
  await cmd('c4', { type: 'acquire', thread: 3, lock: 11 }); // H 等 Y
  show('H 等 Y、M 等 X 后的状态（M 与 L 都应继承到 8，L 应先运行）', await get(`/scenarios/${id}`));
  show('L 的捐赠链解释', await get(`/scenarios/${id}/explain/1`));
  show('L 释放 X（应转交给 M，L 降回 1，M 仍受 H 捐赠）',
    await cmd('c5', { type: 'release', thread: 1, lock: 10 }));
  show('该命令前后差异', await get(`/scenarios/${id}/commands/5/diff`));
  show('非持有者释放（应拒绝）', await cmd('c6', { type: 'release', thread: 1, lock: 11 }));
  show('重复请求编号 c5（幂等返回原结果）',
    await cmd('c5', { type: 'release', thread: 1, lock: 10 }));
  show('导出回放', await get(`/scenarios/${id}/export`));

  server.close();
  store.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
