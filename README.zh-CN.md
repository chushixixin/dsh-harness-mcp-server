# dsh-harness-mcp-server

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent 能力暴露成一个 **MCP server**，让任意 MCP 客户端（如 [Hermes](https://hermes-agent.nousresearch.com/)）都能驱动 Harness 执行真实的编码任务。

**Hermes 是大脑（pro），Harness 是胳膊（flash）—— 1+1>2。**

[![npm version](https://img.shields.io/npm/v/@chushixixin/dsh-harness-mcp-server)](https://www.npmjs.com/package/@chushixixin/dsh-harness-mcp-server)
[![license](https://img.shields.io/npm/l/@chushixixin/dsh-harness-mcp-server)](./LICENSE)

> 📖 [English](./README.md) · 中文（当前页）

## 为什么需要它

Harness 自带强大的 agent 运行时（工具、LLM、agent、会话），但它本身是一个 **Cordis 应用**，别的 agent 无法直接调用。这个插件把 Harness「由内向外」翻转：在 Harness **内部**启动一个真正的 **MCP server**（StreamableHTTP），通过 `ctx` 桥接 Harness 的核心服务 —— `ctx.agents`、`ctx.agentPresets`、`ctx.tools` —— 让外部的「大脑」能把真实工作交给 Harness 的「胳膊」。

```
Hermes (MCP 客户端, 大脑)
   │  agent_run / task_inbox (HTTP)
   ▼
dsh-harness-mcp-server (MCP server, :8090)
   │  ctx.agents.create → 挂载 'standard' preset
   ▼
Harness agent (flash) — 完整工具集: bash、fs、todo、web…
```

## 工具

| 工具 | 方向 | 用途 |
|------|-----------|---------|
| `echo` | — | 验证 MCP 连通性 |
| `harness_list_tools` | — | 列出 Harness 已注册的工具名 |
| `agent_run` | Hermes → Harness | 同步执行任务，返回结构化结果 |
| `task_inbox` | Hermes → Harness | 把结构化任务（任务 + 记忆上下文 + cwd）推入异步队列 |
| `task_result` | Hermes ← Harness | 取回队列任务的结构化结果 |

每个任务结果都是**结构化**的：

```json
{
  "sessionId": "...",
  "assistantText": "最终回答",
  "toolCalls": [{ "name": "bash", "args": "..." }],
  "toolResults": ["命令输出"],
  "changes": "改了什么",
  "verification": "怎么验证的",
  "leftovers": "遗留问题"
}
```

这打通了「客户端持久记忆 ↔ Harness 编码」的回路：记忆作为 `context` 喂给每个任务，结果（`changes` / `verification` / `leftovers`）可以写回客户端记忆，供下次续用。

## 安装

### 方式 A —— 从 npm（推荐）

```bash
npm install @chushixixin/dsh-harness-mcp-server
```

然后在你的 Harness workspace 里引用该插件（见下方 cordis patch）。

### 方式 B —— 从源码

把本仓库 clone 到 Harness workspace 的 `packages/mcp/harness-mcp-server/` 下（pnpm workspace 匹配 `packages/*/*`，两级深）：

```bash
cd /path/to/deepseek-harness
mkdir -p packages/mcp/harness-mcp-server
# 复制本仓库文件进去，然后：
corepack pnpm install
```

在 `tsconfig.host.json` 的 references 和 `tsconfig.base.json` 的 paths 里注册（见 Harness 插件文档），然后构建：

```bash
corepack pnpm exec tsc -b packages/mcp/harness-mcp-server
corepack pnpm run build:lib:host
```

## 运行

```bash
export DEEPSEEK_API_KEY=...
corepack pnpm dsh web --patch ./packages/mcp/harness-mcp-server/cordis.yml
```

MCP server 监听 `127.0.0.1:8090`（StreamableHTTP）。任意 MCP 客户端指向 `http://127.0.0.1:8090/mcp` 即可。

> ⚠️ **安全警告**：默认只监听 `127.0.0.1`（本机）。它暴露的是**未鉴权的远程代码执行**能力——在没有加认证、TLS 和反向代理之前，**不要**绑定 `0.0.0.0` 或暴露到公网/局域网。

### Hermes 客户端配置

```bash
printf 'n\nY\n' | hermes mcp add harness_plugin --url http://127.0.0.1:8090/mcp
```

## cordis.yml（patch 格式）

```yaml
- insert:
    - id: harness-mcp-server
      name: '@chushixixin/dsh-harness-mcp-server'
      config:
        http: true
        port: 8090
        host: 127.0.0.1        # 默认仅本机; 暴露前必须加认证
        # authToken: 'your-secret-token'     # 可选: Bearer token 认证
        # workspaceRoots: ['/workspace']      # 可选: cwd 白名单
```

## 定位

它最适合当**备用工具**，而不是日常主力：日常改代码直接驱动你的主 agent 即可。当需要**上下文隔离**（大型重构会把客户端上下文撑爆）或**并行执行**互不相干的任务时，再启用它。

- agent 会话**按 cwd 复用**（避免每次调用都重新加载项目上下文——比一次性 `dsh headless` 省约 15–20 倍）。
- bash 走沙箱（`workspace-write`）：请在宿主机安装 `bubblewrap`，否则沙箱会拒绝写命令。
- 每个新的 MCP 会话拥有独立的 `McpServer` + transport（一个 MCP `McpServer` 只能连接一个 transport）。

## License

MIT
