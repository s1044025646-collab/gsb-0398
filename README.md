# 互斥锁优先级继承与传递捐赠回放后端

教学用优先级继承（Priority Inheritance）模拟服务。纯后端：TypeScript + Node.js + SQLite（使用 Node 内置 `node:sqlite`，无原生编译依赖），Windows 本地直接运行，不依赖 Docker / WSL / 外部服务。

模拟对象：若干线程（只有**就绪 / 等待**两种状态，不执行真实线程、不调整操作系统优先级、无定时器与完整调度器）与若干**非递归互斥锁**。通过离散命令推进：申请、释放、取消等待、修改基础优先级。服务回答"当前谁应先运行，以及它为什么获得这个有效优先级"。

## 核心语义

- 优先级数值越大越高。有效优先级 = max(自身基础值, 所有有效捐赠)。
- 等待者把自己的**有效**优先级捐赠给所等锁的持有者；持有者若又在等其他锁，捐赠沿链继续传播（传递继承，不止一层）。每次命令后完整重算等待图。
- 捐赠来源消失（取消等待、释放转交、调低基础值）后高值立即回落，不永久保留。
- 线程可持有多把锁，但同时最多等待一把；重复申请自己持有的非递归锁被拒绝。
- 申请空闲锁立即取得；申请已占用锁进入该锁等待队列。
- 新增等待边若成环则拒绝并展示成环路径，原状态不变（不做死锁恢复）。
- 等待中的线程不能再发起其他申请；只有持有者可释放对应锁。
- 释放时把锁直接转交给**有效优先级最高**的等待者，平局按入队序号再按线程编号。
- 就绪选择：有效优先级最高、平局按编号小者优先；等待者不参与。
- 限制：线程不超过 64、锁不超过 64、捐赠链深不超过 64、优先级为 0..2^31-1 的整数。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部单元/集成测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # 运行内置演示场景（L/M/H/R 传递继承）
```

指定端口与数据目录（数据默认在项目内 `data/pi.db`）：

```powershell
node dist/src/cli.js serve --port 8080 --db data\my.db
```

## CLI 命令

```
node dist/src/cli.js serve [--port N] [--db PATH]   启动 HTTP 服务
node dist/src/cli.js demo                           运行演示场景
node dist/src/cli.js new <name> [--db PATH]         创建场景
node dist/src/cli.js cmd <sid> <requestId> <json>   执行一条命令
node dist/src/cli.js state <sid>                    查看完整状态
node dist/src/cli.js scheduler <sid>                当前应先运行谁
node dist/src/cli.js explain <sid> <threadId>       捐赠链解释
node dist/src/cli.js derive <sid> <name>            从当前快照派生新场景
node dist/src/cli.js export <sid>                   导出回放 JSON
node dist/src/cli.js replay <file>                  从导出文件重建场景
```

## HTTP API

所有响应均为 JSON。错误格式：`{ "error": { "code", "message", "details" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/scenarios` `{name}` | 创建场景 |
| GET | `/scenarios` | 列出场景 |
| POST | `/scenarios/:id/commands` `{requestId, ...payload}` | 执行命令（幂等） |
| GET | `/scenarios/:id/commands` | 命令历史（含前后快照） |
| GET | `/scenarios/:id/commands/:seq` | 单条命令记录 |
| GET | `/scenarios/:id/commands/:seq/diff` | 该命令前后差异 |
| GET | `/scenarios/:id/state` | 线程、锁、有效优先级、可运行者 |
| GET | `/scenarios/:id/threads/:tid` 与 `/locks/:lid` | 单个线程 / 锁 |
| GET | `/scenarios/:id/explain/:tid` | 捐赠链文字解释与路径 |
| GET | `/scenarios/:id/scheduler` | 当前应先运行的线程 |
| POST | `/scenarios/:id/derive` `{name}` | 从当前快照派生场景 |
| GET | `/scenarios/:id/export` | 导出回放（`pi-replay/1`） |

### 命令 payload

```json
{"type":"addThread","name":"L","basePriority":1}
{"type":"addLock","name":"X"}
{"type":"acquire","thread":1,"lock":1}
{"type":"release","thread":1,"lock":1}
{"type":"cancelWait","thread":2}
{"type":"setBasePriority","thread":3,"priority":9}
```

每条命令必须带唯一 `requestId`：同一场景内重复提交返回首次结果（相同 `seq`），不重复执行、不消耗排队序号。

### 主要错误码

| code | 含义 |
| --- | --- |
| `INVALID_PRIORITY` / `INVALID_JSON` / `INVALID_ID` / `INVALID_REQUEST_ID` | 参数校验失败（400） |
| `NO_SUCH_SCENARIO` / `NO_SUCH_THREAD` / `NO_SUCH_LOCK` / `NO_SUCH_COMMAND` | 对象不存在（404） |
| `LIMIT_THREADS` / `LIMIT_LOCKS` / `CHAIN_TOO_DEEP` | 超出数量 / 链深上限 |
| `THREAD_WAITING` | 等待中的线程发起新申请（409） |
| `NONRECURSIVE_LOCK` | 重复申请自己持有的非递归锁（409） |
| `DEADLOCK_CYCLE` | 申请会成环，已拒绝且状态未变，`details.cycle` 为环路径（409） |
| `NOT_HOLDER` | 非持有者释放锁（409） |
| `NOT_WAITING` | 取消一个不在等待的线程（409） |

## 持久化与一致性

- SQLite 表：`scenarios` / `threads` / `locks` / `wait_queue` / `commands`。
- 每条命令在一个事务内完成：状态改写 + 命令记录 + 前后快照，原子提交；失败命令只记录错误，不改状态、不消耗等待序号、不留半次转交。
- 重启后从已提交状态继续；场景之间完全隔离。

## 演示场景

`npm run demo` 复现：L=1 持 X，M=3 持 Y 并等待 X，H=8 等待 Y，另有 R=6 就绪。H 等待后 M 与 L 都继承到 8，L 先于 R 运行；L 释放 X 后锁转交 M，L 降回 1，M 仍受 H 捐赠保持 8。

## 测试覆盖（`npm test`，17 项）

传递继承、释放转交与回落、双重捐赠、取消等待、基础值变化、同级排队、按有效优先级选择等待者、非持有者释放、环路拒绝（含路径与状态不变）、等待中申请 / 非递归重入、等待者不可运行、独立枚举核对重算结果、解释链真实性、幂等重放、失败回滚、重启一致、派生与导出重放。

## 假设与限制

- 仅教学模拟：不执行真实线程，不做 CPU 调度、定时器与死锁恢复。
- 每次命令完整重算等待图，面向小规模场景，未做增量优化。
- 失败命令也会写入命令历史（`ok=false`，前后快照相同），便于审计。
- `node:sqlite` 在 Node 25 仍为实验特性，启动时会有 ExperimentalWarning，不影响功能；要求 Node 22.5 及以上（建议 24+）。
