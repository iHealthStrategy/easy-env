// In-app usage guide. easy-env's whole flow is AI-driven over MCP, which is
// opaque to a first-time user opening this control panel — this page explains
// the model, the one-time setup, and what each page shows.
import { Link } from 'react-router-dom';

export function Help() {
  return (
    <div className="page">
      <div className="page-header">
        <h2>使用帮助</h2>
        <span className="meta">easy-env 是怎么用的</span>
      </div>
      <div className="page-body">
        <div className="card help-card">
          <h3>easy-env 是什么</h3>
          <p>
            easy-env 让 AI 助手帮你把一个项目<strong>可复现地跑起来</strong>。AI 读你的项目
            (<code>easy-env.json</code>、源码、docker-compose 等),判断它需要哪些环境变量和
            数据服务,通过 MCP 把这些信息交给 easy-env 的守护进程;守护进程负责按需启动
            Mongo / Redis / RabbitMQ 容器、保存变量值。<strong>这个应用本身是个控制台</strong>
            ——查看与管理状态,真正的配置动作由你的 AI 会话发起。
          </p>
        </div>

        <div className="card help-card">
          <h3>准备工作(一次性)</h3>
          <p className="help-sub">前置:本机已安装并<strong>正在运行 Docker</strong>,且 PATH 上有 <strong>Node 18+</strong>。</p>
          <ol className="help-steps">
            <li>到 <Link to="/settings">设置</Link> 页,<strong>启动守护进程</strong>。</li>
            <li>打开<strong>安装 Claude Code 技能</strong>——AI 才知道怎么使用 easy-env。</li>
            <li>打开<strong>注册 MCP 服务器</strong>——AI 才能调用 easy-env 的工具。</li>
          </ol>
          <p className="help-note">三项的实时状态都显示在设置页;左下角也常驻守护进程状态。</p>
        </div>

        <div className="card help-card">
          <h3>配置一个项目</h3>
          <p>在你的 AI 会话(Claude Code)里,对着目标项目说一句:</p>
          <pre className="help-quote">用 easy-env 配好这个项目的环境</pre>
          <p>AI 会自动走这套流程:</p>
          <ol className="help-steps">
            <li>读 <code>easy-env.json</code> 和源码,<strong>声明项目用到的数据服务</strong>(env.init)。</li>
            <li>找出项目需要的环境变量并提交(vars.declare)。</li>
            <li>启动环境——<strong>只起被声明的服务</strong>(env.up)。</li>
            <li>核对变量,把还没填的(<code>unset</code>)补齐(vars.list / vars.set)。</li>
            <li>用解析好的变量启动你的项目。</li>
          </ol>
          <p className="help-note">
            数据服务是<strong>按需的</strong>:项目只用 Redis 就只起 Redis,什么都不用就不起容器。
          </p>
        </div>

        <div className="card help-card">
          <h3>各页面看什么</h3>
          <dl className="help-dl">
            <dt><Link to="/">环境</Link></dt>
            <dd>当前运行的环境;点进去看容器、解析后的连接 URL;每行可「清除」销毁。</dd>
            <dt><Link to="/vars">变量</Link></dt>
            <dd>按项目查看变量,补齐 <code>unset</code> 的值,或删除整个项目的配置。</dd>
            <dt><Link to="/mcp">MCP 服务</Link></dt>
            <dd>可用工具一览,以及最近的工具调用记录与统计。</dd>
            <dt><Link to="/settings">设置</Link></dt>
            <dd>守护进程 / 技能 / MCP 开关,关闭按钮行为,以及关键路径。</dd>
          </dl>
        </div>

        <div className="card help-card">
          <h3>遇到问题</h3>
          <dl className="help-dl">
            <dt>提示 <code>node not found</code> 或版本过低</dt>
            <dd>安装 Node 18+(推荐 LTS 20 / 22)并确认它在 PATH 上。</dd>
            <dt>env.up 报端口被占用</dt>
            <dd>释放该端口,或在项目的 <code>easy-env.json</code> 改 <code>backends.&lt;x&gt;.port</code> 后重新 env.init。</dd>
            <dt>顶部出现 Docker 警告条</dt>
            <dd>Docker 未安装或未运行;装好并启动 Docker Desktop 后再试。</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
