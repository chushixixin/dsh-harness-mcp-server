# dsh-harness-mcp-server

> Expose [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent capabilities as an **MCP server**, letting any MCP client (e.g. [Hermes](https://hermes-agent.nousresearch.com/)) drive Harness to execute real coding tasks.

**Hermes is the brain (pro), Harness is the arms (flash) — 1+1>2.**

[![npm version](https://img.shields.io/npm/v/@chushixixin/dsh-harness-mcp-server)](https://www.npmjs.com/package/@chushixixin/dsh-harness-mcp-server)
[![license](https://img.shields.io/npm/l/@chushixixin/dsh-harness-mcp-server)](./LICENSE)

## Why this exists

Harness ships a powerful agent runtime (tools, LLM, agents, sessions), but it is a **Cordis app**, not something another agent can call. This plugin turns Harness inside-out: it starts a real **MCP server** (StreamableHTTP) *inside* Harness and bridges Harness's core services — `ctx.agents`, `ctx.agentPresets`, `ctx.tools` — so an external "brain" can delegate real work to Harness's "arms".

```
Hermes (MCP client, brain)
   │  agent_run / task_inbox (HTTP)
   ▼
dsh-harness-mcp-server (MCP server, :8090)
   │  ctx.agents.create → mount 'standard' preset
   ▼
Harness agent (flash) — full toolset: bash, fs, todo, web…
```

## Tools

| Tool | Direction | Purpose |
|------|-----------|---------|
| `echo` | — | Verify MCP connectivity |
| `harness_list_tools` | — | List Harness's registered tool names |
| `agent_run` | Hermes → Harness | Run a task synchronously and return a structured result |
| `task_inbox` | Hermes → Harness | Push a structured task (task + memory context + cwd) to an async queue |
| `task_result` | Hermes ← Harness | Poll a queued task's structured result |
| `attach_session` | — | Attach a session to the workspace matching its cwd (the official UI cannot do this) |
| `rename_session` | — | Rename an existing session for easier list filing |

Every task result is **structured**:

```json
{
  "sessionId": "...",
  "assistantText": "final answer",
  "toolCalls": [{ "name": "bash", "args": "..." }],
  "toolResults": ["command output"],
  "changes": "what was changed",
  "verification": "how it was verified",
  "leftovers": "open issues"
}
```

This closes the loop between the client's persistent memory and Harness's coding: memory is fed into each task as `context`, and the result (`changes` / `verification` / `leftovers`) can be persisted back to the client's memory for the next run.

## Install

### Option A — from npm (recommended)

Install it into the target profile with dsh's own plugin command (it also writes `dependencies` and appends the bundle to `dsh.profile.bundles`):

```bash
dsh plugin --profile <profile> add @chushixixin/dsh-harness-mcp-server@latest
```

You can also install it as a plain dependency, in which case you must add it to the profile's `dsh.profile.bundles` yourself:

```bash
npm install @chushixixin/dsh-harness-mcp-server
```

> ⚠️ Use **0.1.13 or newer**. 0.1.10 and earlier declared the `@deepseek-ai/dsh-*` runtime packages as regular `dependencies`, which **stops dsh from starting** once installed into a profile (see "Dependency declaration rule" below); 0.1.11 fixed the preset-mount Symbol bug; 0.1.12 fixed the session-format-v4 source-kind rejection; **0.1.13** fixed model routing (an unbound `{{model}}` prompt variable that failed every prompt assembly).

### Option B — from source

Clone this repo inside your Harness workspace under `packages/mcp/harness-mcp-server/` (the pnpm workspace matches `packages/*/*`, two levels deep):

```bash
cd /path/to/deepseek-harness
mkdir -p packages/mcp/harness-mcp-server
# copy this repo's files there, then:
corepack pnpm install
```

Register it in `tsconfig.host.json` references and `tsconfig.base.json` paths (see the Harness plugin docs), then build:

```bash
corepack pnpm exec tsc -b packages/mcp/harness-mcp-server
corepack pnpm run build:lib:host
```

## ⚠️ Dependency declaration rule (violating it stops dsh from starting)

**Every `@deepseek-ai/dsh-*` package (including `@deepseek-ai/cordis` and `@deepseek-ai/dsh-scope`) must be a `peerDependencies` entry — never a `dependencies` entry.**

Those packages are provided by the dsh runtime itself. Declared as `dependencies`, pnpm installs them into the profile's `node_modules` (profile templates use `nodeLinker: hoisted`), where they **shadow the installation's own core packages**. Before importing a plugin, dsh checks each package's declared `peerDependencies` against the single runtime version (`getDshRuntimeVersion()`) and disables rows that do not match — so dsh starts disabling **its own core rows**:

```
dsh: disabling profile plugin row "llm":     Plugin @deepseek-ai/dsh-llm@0.0.1-rc.1 is incompatible with dsh 0.2.0-rc.2
dsh: disabling profile plugin row "session": Plugin @deepseek-ai/dsh-session@0.0.1-rc.1 is incompatible with dsh 0.2.0-rc.2
dsh: disabling profile plugin row "agent":   Plugin @deepseek-ai/dsh-agent@0.1.0-rc.6 is incompatible with dsh 0.2.0-rc.2
dsh: disabling profile plugin row "tools":   Plugin @deepseek-ai/dsh-tools@0.0.1-rc.1 is incompatible with dsh 0.2.0-rc.2
```

With the core rows disabled, the **required** `agent-loop` plugin can no longer reach `agents / sessions / llm / tools`:

```
dsh: startup failed: 1 required plugin did not activate
```

**dsh then refuses to start at all.** 0.1.11 moves all of them to `peerDependencies` (with exact versions pinned in `devDependencies` for local builds) and adds the previously undeclared `@deepseek-ai/dsh-scope`.

For the same reason `@deepseek-ai/dsh-scope` must stay **external and never be inlined into the bundle**: scope tags are keyed by `Symbol("dsh.scope")`, and `Symbol("x") !== Symbol("x")`. Inlining creates a second Symbol instance, so `scopeOf(agentCtx)` is always `undefined`, the `standard` preset never mounts, and the agent runs with **no tools at all** (`toolCalls` / `toolResults` permanently empty). 0.1.11 ships `import { scopeOf } from '@deepseek-ai/dsh-scope'` in `lib/index.js`.

## Troubleshooting

### dsh will not start after installing the plugin — `startup failed: 1 required plugin did not activate`

Stale `@deepseek-ai/*` copies leaked into the profile's `node_modules` (see the previous section). To recover:

```bash
# 1. Confirm the culprit — this directory should not exist
ls "$DSH_HOME/profiles/<profile>/node_modules/@deepseek-ai"

# 2. Remove the plugin (which clears those copies), then install the fixed version
dsh plugin --profile <profile> remove @chushixixin/dsh-harness-mcp-server
dsh plugin --profile <profile> add @chushixixin/dsh-harness-mcp-server@latest
```

If you would rather not touch the plugin, delete only the profile-local `node_modules/@deepseek-ai` copies that the installation does not own, or grant an exact-version exemption with `dsh plugin allow-version`.

### dsh starts, but `agent_run` fails with `format v4 message requires a producer-owned source kind`

**Fixed in 0.1.12.** The plugin used to attach a **retired v3 source wrapper** to its user message:

```js
source: { kind: 'plugin', plugin: 'harness-mcp-server' }   // ❌ v3 form
```

The dsh session format v4 **hard-refuses** `kind: 'plugin'` on admission:

```js
// dsh: session-format-v4 message-sources
if (!isObject(value) || typeof value.kind !== 'string' || value.kind.length === 0
    || value.kind === 'plugin')                                  // ← matches
  throw new SessionFormatError('format v4 message requires a producer-owned source kind')
```

V3 wrappers are migrated to a **producer-owned** kind (`producerKind()` falls back to `` `plugin:${plugin}` `` for third-party plugins and drops the `plugin` field), so the correct form is:

```js
source: { kind: 'plugin:harness-mcp-server' }              // ✅ v4 form
```

The symptom is a whole-run failure (`本轮运行失败`) with **zero turn events in the session log** — the event is rejected before it is written to disk. That is also why it was earlier misdiagnosed as a "followup deadlock": it looked like the task never started, when in fact it started and was rejected by format validation.

> Diagnostic hint: if an older version (≤ 0.1.11) shows both an empty `agent_run` shell **and** `本轮运行失败 … producer-owned source kind` in the UI, this is that bug. Sessions written by ≤ 0.1.11 can contain messages that fail v4 admission, so after upgrading start a fresh session rather than resuming an old `sessionId`.

### `agent_run` fails with `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`

**Fixed in 0.1.13.** The dsh system prompt's persona section references `{{model}}` / `{{provider}}`, and those variables are injected by the `system-prompt/assemble` listener that `installModelSelection()` registers — **only when `selection.current` has a value**:

```js
const selected = selection.current;
const assembled = await next();
if (selected === void 0) return assembled;   // ← no selection installed → no variables → {{model}} unbound → throw
return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
```

Installing that selection is the job of **whoever creates the agent**. dsh's own `headless-runner` (i.e. `dsh headless "task"`) is the reference implementation:

```js
const selection = ctx.agentDefaultModel.currentSelection();   // deployment/user default model
const agentOptions = { provider: selection.provider, model: selection.model };
const setup = (agentCtx) => installModelSelection(agentCtx, { current: selection, assembled: undefined });
await agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
```

Older versions of this plugin passed a hard-coded `provider: 'deepseek-official'`, omitted `model`, and **never called `installModelSelection`** — so the variables were unbound and every prompt assembly threw.

From 0.1.13 the plugin matches the official pattern:

- `provider` / `model` default to **empty = follow dsh's default model service** (`ctx.agentDefaultModel.currentSelection()`, i.e. the `agent-default-model` row configured in your profile);
- if you configure them on the plugin row, **both must be set**; supplying only one fails loudly when the agent is created instead of surfacing later as an assembly error;
- `setup` installs the model selection first, then mounts the preset.

## Run

```bash
export DEEPSEEK_API_KEY=...
corepack pnpm dsh web --patch ./packages/mcp/harness-mcp-server/cordis.yml
```

The MCP server listens on `127.0.0.1:8090` (StreamableHTTP). Point any MCP client at `http://127.0.0.1:8090/mcp`.

> ⚠️ **Security**: by default the server binds to `127.0.0.1` only. It exposes **unauthenticated remote code execution** — do **not** bind it to `0.0.0.0` or expose it to the internet/LAN without adding authentication, TLS, and a reverse proxy first.

### Hermes client config

```bash
printf 'n\nY\n' | hermes mcp add harness_plugin --url http://127.0.0.1:8090/mcp
```

## cordis.yml (patch format)

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

## Positioning

This is best used as a **fallback tool**, not a daily driver: for everyday code edits, drive your primary agent directly. Reach for this when you need **context isolation** (huge refactors that would blow the client's context) or **parallel execution** of unrelated tasks.

- The agent session is **reused per cwd** (avoids re-loading project context on every call — roughly 15–20× cheaper than one-shot `dsh headless`).
- Bash runs sandboxed (`workspace-write`): install `bubblewrap` on the host, or the sandbox will refuse write commands.
- Each new MCP session gets its own `McpServer` + transport (an MCP `McpServer` connects to a single transport).

## License

MIT
