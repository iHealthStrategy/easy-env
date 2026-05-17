# easy-env daemon HTTP API

Daemon 是 easy-env 的长期常驻进程,拥有容器生命周期、registry、snapshot/diff 存储。
两类客户端通过同一套 HTTP API 与之交互:

1. **MCP server**(stdio thin client) — Claude Code 等 MCP client 拉起后,把 tool 调用转发给 daemon
2. **Web UI**(packages/web) — 浏览器中的只读管理界面(Phase 2 起逐步加写操作)

## 监听方式

- 默认:**TCP** `127.0.0.1:7193`(端口可通过 `EASY_ENV_DAEMON_PORT` 覆盖)
- 仅本机访问,**不绑定 0.0.0.0**
- Phase 2 可选支持 Unix socket(`~/.easy-env/daemon.sock`)以避免端口冲突

## 进程生命周期

- MCP server 启动时,先 HTTP GET `/api/health`;若失败(ECONNREFUSED),`spawn` 一个 detached daemon 子进程并轮询直到健康
- PID 文件:`~/.easy-env/daemon.pid`(daemon 启动时写,退出前删)
- 日志:`~/.easy-env/daemon.log`(滚动由后续决定,先用 append)
- 关闭:`easy-env-daemon stop` 或读 PID 文件后 `SIGTERM`;daemon 收到信号后停止所有容器再退出

## 错误响应

统一格式:

```json
{ "error": { "code": "envId-not-found", "message": "...", "details": {} } }
```

HTTP status:
- `400` — 输入验证失败(Zod 报错)
- `404` — 资源不存在(envId / snapshotId / diffId)
- `409` — 状态冲突(env 已 destroyed、容器已停止等)
- `500` — 内部错误(Docker 不可达、磁盘 IO 失败等)

成功响应直接返回 JSON 对象,不包再一层 `data` 字段。

## Endpoint 分类

### 1. 元信息

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/health` | 健康检查;返回 `{ok: true, version, uptime}` |
| GET | `/api/config` | 当前已加载的 `easy-env.json`,等价 `env.config` |

### 2. 通用工具入口(MCP thin client 专用)

MCP server 把所有 tool 调用转发到这个统一端点,daemon 内部分发。这样 MCP server 几乎不需要业务逻辑。

| Method | Path | Body | 返回 |
|--------|------|------|------|
| POST | `/api/tools/:toolName` | tool 入参(等同原 Zod schema) | tool 返回值 |

`toolName` 取值:`env.config` / `env.up` / `env.list` / `env.status` / `env.reset` / `env.down` / `db.seed` / `db.find` / `db.insert` / `db.update` / `db.delete` / `state.capture` / `scenario.settle` / `diff.compare` / `scenario.replay`

### 3. 资源端点(Web UI 友好)

Web UI 主要通过这些端点取数据,语义更清晰且支持 GET(便于浏览器/HTTP 缓存)。
内部可与上面的 tool 入口共享实现。

#### envs

| Method | Path | 等价 tool | 返回 |
|--------|------|-----------|------|
| GET | `/api/envs` | env.list | `{envs: ManagedEnv[], activeEnvId: string\|null}` |
| GET | `/api/envs/:envId` | env.status | `{env: ManagedEnv, health: {mongo, redis, app?}}` |
| POST | `/api/envs` | env.up | env.up 返回值(新 envId、端口等) |
| POST | `/api/envs/:envId/reset` | env.reset | 等价 tool 返回 |
| DELETE | `/api/envs/:envId` | env.down | 等价 tool 返回 |
| POST | `/api/envs/:envId/activate` | (新) | 设置 activeEnvId 指针 |

#### containers(实时状态)

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/envs/:envId/containers` | 列出该 env 下 Mongo/Redis 容器的 Docker 实时状态(running/exited、CPU、内存) |
| GET | `/api/envs/:envId/containers/:role/logs` | 读取容器日志(tail N 行,role = `mongo`\|`redis`) |

#### snapshots

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/snapshots` | 列出所有 snapshot(分页);可按 envId、scope、时间范围过滤 |
| GET | `/api/snapshots/:id` | 单个 snapshot 完整内容 |
| GET | `/api/snapshots/:id/summary` | 仅返回元信息和体积(不含 docs/keys 内容),用于列表预览 |

#### diffs

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/diffs` | 列出所有 diff |
| GET | `/api/diffs/:id` | 单个 diff 完整内容 |

#### db ops(Phase 1 主要给 MCP 用,Phase 2 Web 可加表单)

走 `/api/tools/db.find` 等通用入口即可,不再为它们造资源式端点。

### 4. 流式数据(Phase 2+)

预留 SSE/WebSocket:
- `GET /api/events` — 全局事件流(env 创建/销毁、settle 完成)
- `GET /api/envs/:envId/containers/:role/logs?stream=1` — 容器日志流

Phase 1 不实现,先用轮询。

## 兼容性

Phase 1 完成后,所有 15 个 MCP tool 行为**保持不变**(入参、出参、副作用);唯一区别是它们在 daemon 内执行而非 MCP 进程内。Smoke 测试用同一份断言验证。

## 安全

- 仅监听 127.0.0.1
- Phase 1 无 token / auth(单用户本机场景)
- Phase 2+ 若开放远程访问,引入 token (`EASY_ENV_DAEMON_TOKEN`) 通过 `Authorization: Bearer` 校验
