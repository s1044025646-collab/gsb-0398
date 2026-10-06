# 互斥锁优先级继承与传递捐赠回放后端

教学用模拟服务：输入若干线程（基础优先级）与非递归互斥锁，通过离散命令模拟申请、释放、取消等待、修改基础优先级，实时回答“当前谁应先运行、为什么”。纯后端（HTTP API + CLI），TypeScript + Node.js + SQLite，Windows 本地运行，零外部运行时依赖（使用 Node 内置 node:sqlite 与 node:http），不需要 Docker、WSL 或任何在线服务。

说明：本服务不执行真实线程、不调整操作系统优先级、不实现定时器或完整 CPU 调度器。线程只有“就绪 / 等待”两种状态；优先级数值越大越高。

## 快速开始

    npm install        # 安装开发依赖（typescript、@types/node）
    npm run build      # 编译到 dist/
    npm test           # 编译并运行全部测试（node:test）
    npm start          # 启动服务（默认自动选择空闲端口，可用 PORT=xxxx 指定）
    npm run demo       # 内存数据库上演示题目经典场景（L/M/H/R + 锁 X/Y）
    npm run cli -- list

数据目录为项目内 data/（数据库 data/pi-replay.db，端口文件 data/server.port，可用环境变量 DB_PATH 覆盖）。重启服务后从已提交状态继续。

## 模型与规则

- 线程可同时持有多把锁，但同时最多等待一把锁；等待中的线程不能再发起申请。
- 申请空闲锁立即取得；申请已占用锁进入该锁等待队列（入队序号全局递增）。
- 再次申请自己持有的非递归锁：ERR_SELF_LOCK。
- 新增等待边若成环：ERR_CYCLE，响应中给出成环路径，原状态不变。
- 只有持有者可释放对应锁，否则 ERR_NOT_HOLDER。
- 释放时从等待者中选有效优先级最高者直接转交；并列按入队序号、再按线程编号。
- 传递捐赠：等待者把有效优先级捐给所等锁的持有者，沿等待链传播；有效优先级 = 自身基础值与所有上游等待者基础值的最大值。每次命令后对小规模等待图完整重算，捐赠来源消失（取消等待、释放、调低基础值）后立即回落。
- 就绪线程选择：有效优先级最高、再按固定编号；等待者不参与。
- 上限：线程 64、锁 64、等待链深 64（src/engine.ts 中 LIMITS）。

## HTTP API

统一错误格式：{ "error": { "code", "message", "detail" } }。
错误码：ERR_VALIDATION(400)、ERR_LIMIT(400)、ERR_NOT_FOUND(404)、ERR_SELF_LOCK / ERR_ALREADY_WAITING / ERR_NOT_HOLDER / ERR_NOT_WAITING / ERR_CYCLE / ERR_STATE(422)。

- GET  /health                            健康检查
- POST /scenarios                         创建场景 {name, threads:{id:base}, locks:[id]}
- GET  /scenarios                         列出场景
- GET  /scenarios/:id                     查询线程/锁/有效优先级/调度选择及原因
- POST /scenarios/:id/commands            推进命令 {requestId, command}，幂等
- GET  /scenarios/:id/commands            命令流水（含每次前后快照）
- GET  /scenarios/:id/commands/:seq/diff  该命令前后差异
- GET  /scenarios/:id/explain/:thread     捐赠链解释（来源线程、路径、每跳经由的锁）
- POST /scenarios/:id/fork                从当前快照派生独立新场景
- GET  /scenarios/:id/export              导出回放（初始状态 + 命令序列）

命令类型：

    {"type":"acquire","thread":1,"lock":10}
    {"type":"release","thread":1,"lock":10}
    {"type":"cancelWait","thread":1}
    {"type":"setBase","thread":1,"priority":5}

相同 requestId 重复提交返回原结果（duplicate: true），不重复执行；失败命令整体回滚，不消耗排队序号、不留下半次转交（失败会作为审计记录保存，ok:false，不改变场景状态）。

## CLI

服务启动后（端口写入 data/server.port，也可用 SERVER_URL 指定）：

    npm run cli -- create demo 1:1,2:3,3:8,4:6 10,11
    npm run cli -- cmd 1 c1 acquire thread=1 lock=10
    npm run cli -- cmd 1 c2 acquire thread=2 lock=11
    npm run cli -- cmd 1 c3 acquire thread=2 lock=10
    npm run cli -- cmd 1 c4 acquire thread=3 lock=11
    npm run cli -- state 1            # L 有效优先级 8，应先运行
    npm run cli -- explain 1 1        # 捐赠链 3 -> 2 -> 1
    npm run cli -- cmd 1 c5 release thread=1 lock=10
    npm run cli -- diff 1 5           # 查看该命令前后差异
    npm run cli -- history 1
    npm run cli -- fork 1 分支A
    npm run cli -- export 1

## 持久化与原子性

SQLite（WAL）中两张表：scenarios（当前状态快照 JSON + 下一命令序号）与 commands（序号、请求编号、命令、结果、前后快照）。每条命令在一个事务中完成“校验、应用、写命令记录、更新状态”，失败即回滚；requestId 有唯一索引，事务内二次检查保证并发幂等。重启后从已提交状态继续。

## 测试

npm test 运行 16 个用例，覆盖：传递捐赠与独立传播枚举交叉核对、调度选择、解释链真实性、释放转交与回落、双重捐赠、取消等待、基础值变化、同级排队、非持有者释放、环路拒绝（状态不变、不消耗序号）、幂等重放、失败回滚、重启一致性、fork/export、数量上限。

## 限制

- 单进程服务，面向教学与小规模场景（每次命令全量重算等待图）。
- 不实现死锁恢复、超时、定时器与真实调度；成环仅拒绝新增边。
- node:sqlite 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning，不影响功能）。
