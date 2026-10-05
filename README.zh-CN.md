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
| `attach_session` | — | 把会话归组到其 cwd 对应的工作区（官方 UI 无此能力） |
| `rename_session` | — | 给已有会话改名，便于会话列表归档 |

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

通过 dsh 自带的插件命令装进目标 profile 最稳妥（它会同时写好 `dependencies` 并把 bundle 追加到 `dsh.profile.bundles`）：

```bash
dsh plugin --profile <profile> add @chushixixin/dsh-harness-mcp-server@latest
```

也可以只用 npm 装成普通依赖（此时需要自己把它加进 profile 的 `dsh.profile.bundles`）：

```bash
npm install @chushixixin/dsh-harness-mcp-server
```

> ⚠️ 请使用 **0.1.13 及以上**。0.1.10 及更早版本把 `@deepseek-ai/dsh-*` 写成了 `dependencies`，装进 profile 后会让 **dsh 无法启动**（详见下方「依赖声明规则」）；0.1.11 修好了 preset 挂载的 Symbol 问题；0.1.12 修好了会话格式 v4 的 source kind 拒绝；**0.1.13** 修好了模型路由（`{{model}}` 变量无值导致整轮 assembly 失败）。

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

## ⚠️ 依赖声明规则（违反会导致 dsh 无法启动）

**所有 `@deepseek-ai/dsh-*`（含 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-scope`）必须声明为 `peerDependencies`，绝不能写进 `dependencies`。**

这些包由 dsh 运行时自身提供。一旦写成 `dependencies`，pnpm 会把它们装进 profile 的 `node_modules`（profile 模板用 `nodeLinker: hoisted`），从而**顶替宿主机自己的核心包**。dsh 启动前会拿每个包声明的 `peerDependencies` 去比对唯一运行时版本（`getDshRuntimeVersion()`），对不上就禁用该行——于是 dsh 开始禁用**自己的核心行**：

```
dsh: disabling profile plugin row "llm":     Plugin @deepseek-ai/dsh-llm@0.0.1-rc.1 is incompatible with dsh 0.2.0-rc.2
dsh: disabling profile plugin row "session": Plugin @deepseek-ai/dsh-session@0.0.1-rc.1 is incompatible with dsh 0.2.0-rc.2
dsh: disabling profile plugin row "agent":   Plugin @deepseek-ai/dsh-agent@0.1.0-rc.6 is incompatible with dsh 0.2.0-rc.2
dsh: disabling profile plugin row "tools":   Plugin @deepseek-ai/dsh-tools@0.0.1-rc.1 is incompatible with dsh 0.2.0-rc.2
```

核心行被禁用后，**required** 的 `agent-loop` 再也拿不到 `agents / sessions / llm / tools`：

```
dsh: startup failed: 1 required plugin did not activate
```

**结果就是 dsh 完全起不来。** 0.1.11 已把它们全部移到 `peerDependencies`（并在 `devDependencies` 里锁精确版本供本地构建），并补上 `@deepseek-ai/dsh-scope`。

同理，`@deepseek-ai/dsh-scope` 还**必须保持 external、绝不能被 bundle 内联**：scope tag 以 `Symbol("dsh.scope")` 为键，`Symbol("x") !== Symbol("x")`，内联会生成第二个 Symbol 实例，导致 `scopeOf(agentCtx)` 恒为 `undefined` —— standard preset 永远挂不上，agent 没有任何工具（`toolCalls` / `toolResults` 恒空）。0.1.11 的 `lib/index.js` 已改为 `import { scopeOf } from '@deepseek-ai/dsh-scope'`。

## 排障

### 装完插件后 dsh 起不来，报 `startup failed: 1 required plugin did not activate`

profile 的 `node_modules` 里混进了陈旧的 `@deepseek-ai/*` 副本（见上一节）。恢复步骤：

```bash
# 1. 确认元凶：这里本不该有 @deepseek-ai 目录
ls "$DSH_HOME/profiles/<profile>/node_modules/@deepseek-ai"

# 2. 移除插件（同时清掉这些副本），再装修正后的版本
dsh plugin --profile <profile> remove @chushixixin/dsh-harness-mcp-server
dsh plugin --profile <profile> add @chushixixin/dsh-harness-mcp-server@latest
```

若暂时不想动插件，也可以删掉 profile 里那份**不属于宿主**的 `node_modules/@deepseek-ai`，或用 `dsh plugin allow-version` 给对应包开精确版本豁免。

### dsh 起来了，但 `agent_run` 报 `format v4 message requires a producer-owned source kind`

**0.1.12 已修复。** 插件原来给 user message 传的是**已废弃的 v3 source 包装**：

```js
source: { kind: 'plugin', plugin: 'harness-mcp-server' }   // ❌ v3 写法
```

而 dsh 的会话格式 v4 在落盘时**硬性拒绝** `kind: 'plugin'`：

```js
// dsh: session-format-v4 message-sources
if (!isObject(value) || typeof value.kind !== 'string' || value.kind.length === 0
    || value.kind === 'plugin')                                  // ← 命中
  throw new SessionFormatError('format v4 message requires a producer-owned source kind')
```

v3 包装会自动迁移成「生产者自有」的 kind（`producerKind()` 对第三方插件的 fallback 是 `` `plugin:${plugin}` ``，且丢掉 `plugin` 字段）。所以正确写法是：

```js
source: { kind: 'plugin:harness-mcp-server' }              // ✅ v4 写法
```

副作用是整轮运行直接失败（`本轮运行失败`），而且**会话日志里连一个 turn 事件都不会有**——事件在写盘前就被拒绝了。这也是为什么早期误判成「followup 死锁」：看起来像任务从未开始，实际是启动后被格式校验拦下。

> 排查提示：如果你在旧版本（≤ 0.1.11）里同时看到 `agent_run` 返回空壳 **和** UI 上 `本轮运行失败 … producer-owned source kind`，那就是这个问题。用了 0.1.11 及更早版本的会话会留下无法通过 v4 校验的历史消息，升级后建议新开会话（不要 `sessionId` 续接旧的）。

### `agent_run` 报 `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`

**0.1.13 已修复。** dsh 的 system prompt 里 persona 段落引用了 `{{model}}` / `{{provider}}` 两个变量，它们由 `installModelSelection()` 注册的 `system-prompt/assemble` 监听器注入 —— **只有 `selection.current` 有值时才注入**：

```js
const selected = selection.current;
const assembled = await next();
if (selected === void 0) return assembled;   // ← 没装 selection → 不注入 → {{model}} 无值 → 抛错
return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
```

而「装 model selection」是**创建 agent 的那一方**的责任。官方 `headless-runner`（即 `dsh headless "task"`）的写法就是标准答案：

```js
const selection = ctx.agentDefaultModel.currentSelection();   // 读部署/用户的默认模型
const agentOptions = { provider: selection.provider, model: selection.model };
const setup = (agentCtx) => installModelSelection(agentCtx, { current: selection, assembled: undefined });
await agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
```

老版本本插件只传了硬编码的 `provider: 'deepseek-official'`、省略 `model`，并且**从未调用 `installModelSelection`** → 变量无值 → 整轮 assembly 直接抛错。

0.1.13 起完全对齐官方写法：

- `provider` / `model` 默认**留空 = 跟随 dsh 的默认模型服务**（`ctx.agentDefaultModel.currentSelection()`，也就是你在 profile 里配的 `agent-default-model` 那一行）；
- 若在插件行上显式配置，`provider` 与 `model` **必须同时给全**，只给一个会在创建 agent 时明确报错（而不是拖到 assembly 阶段炸）；
- `setup` 里先 `installModelSelection(...)`，再挂 preset。

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
