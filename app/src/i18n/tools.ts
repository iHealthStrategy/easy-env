// 中文版工具说明,Web UI 专用。MCP 客户端拿到的仍是原始英文描述。
// 若上游英文描述变化,这里需同步更新。
export const TOOL_DESCRIPTIONS_ZH: Record<string, string> = {
  'env.config':
    '加载并解析当前项目的 easy-env.json,返回配置文件路径和解析后的 URL/dbName。会探测后端版本,与声明版本不一致时给出警告(但不阻止运行)。',
  'env.up':
    '通过 Testcontainers 为本项目启动一个全新的隔离环境。镜像版本取自 easy-env.json(backends.mongo / backends.redis / backends.rabbit 的 image),分配动态端口。Mongo/Redis 默认启动,Rabbit 仅当 manifest 声明 backends.rabbit 时才启动(避免不需要队列的项目多吃 30s 启动时间)。返回 envId 及解析后的连接 URL,后续工具可通过 envId 引用。默认将该 env 设为 active。',
  'env.list':
    '列出本机上 easy-env 当前管理的所有环境,以及 active 指针指向哪个(其他工具未传 envId 时的默认目标)。可用于发现共享主机的其他 agent/session。',
  'env.status':
    '查看指定环境的详细状态:生命周期阶段、解析后的 URL、Mongo/Redis/Rabbit 的实时健康探针结果(Rabbit 是 TCP 探针,只看端口是否有人监听,不做 AMQP 握手)。',
  'env.reset':
    '把环境重置到干净状态。默认(recreate:false)走快速路径:对现有容器执行 dropDatabase + flushdb,毫秒级。recreate:true 时销毁并重建容器(新 envId,几秒,适合从损坏卷恢复)。',
  'env.down':
    '销毁一个环境:停止容器并从 registry 中移除。测试 session 结束时调用。即使 easy-env 异常退出,容器也会被 ryuk 自动回收;env.down 是协作式关闭路径。',
  'db.seed':
    '向受 easy-env 管理的环境的 Mongo 批量插入初始文档。入参格式:{ docs: { collection: [doc, ...] } }。',
  'db.find':
    '在受管环境中查询某个 collection。默认 limit 50,最大 100。仅限 easy-env 自己创建的 envId。',
  'db.insert':
    '向受管环境的某个 collection 插入一条或多条文档。',
  'db.update':
    '更新受管环境中的文档。`update` 必须是 Mongo 更新算子(如 { $set: {...} })。',
  'db.delete':
    '删除受管环境中的文档。multi:true 时删除所有匹配项,否则只删一条。',
  'state.capture':
    '跨配置的后端(Mongo collections + Redis keys)拍一次快照,持久化为 snapshotId 供 diff.compare 使用。',
  'scenario.settle':
    '阻塞直到被测系统达到显式静止条件(队列空、计数达标等)。返回证据,不做判定。',
  'diff.compare':
    '按 id 比对两个 snapshot,返回结构化的多后端 diff。可配噪声策略(忽略时间戳字段、Redis TTL 漂移等)。',
  'scenario.replay':
    '端到端跑一个场景:执行前置条件 → 拍 BEFORE 快照 → 触发动作 → 等待静止 → 拍 AFTER 快照 → 计算 diff → 持久化整个 run artifact。',
  'vars.list':
    '返回本项目所有环境变量的当前视图,每条带 source(user / container / unset)。AI 启动子进程前调用,把结果 spread 到子进程 env 即可。',
  'vars.set':
    '为某个用户态变量写值(必须先在 easy-env.json#variables 声明)。容器自动注入的名字(MONGO_URL 等)拒绝写入。',
  'vars.unset':
    '清除某个变量的用户态值,下一次 vars.list 该项变为 source: unset。声明不被删除。',
  'vars.init':
    '扫描项目(.env / docker-compose / 源码中的 process.env.X)产出变量名提议。dryRun:true 仅返回提议,dryRun:false 把新名合并写回 easy-env.json#variables。',
};

export function describeTool(name: string, fallback: string): string {
  return TOOL_DESCRIPTIONS_ZH[name] ?? fallback;
}
