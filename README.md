# dsh-harness-mcp-server

> Expose [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent capabilities as an **MCP server**, so an external MCP client (e.g. [Hermes](https://hermes-agent.nousresearch.com/)) can drive Harness to execute real coding tasks.

**Hermes = brain (pro), Harness = arms (flash). 1+1>2.**

## What it does

This is a [Cordis plugin](https://github.com/deepseek-ai/deepseek-harness) that runs **inside** Harness and starts a real MCP server (StreamableHTTP) on port `8090`. Through `ctx`, it bridges Harness's core services — `ctx.agents`, `ctx.agentPresets`, `ctx.tools` — and exposes them to any MCP client.

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
| `agent_run` | Hermes → Harness | Run a task synchronously, return structured result |
| `task_inbox` | Hermes → Harness | Push a structured task (`task + memory context + cwd`) to an async queue |
| `task_result` | Hermes ← Harness | Poll a queued task's structured result |

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

This closes the loop between the client's persistent memory and Harness's coding: memory is fed into the task as `context`, and the result (changes/verification/leftovers) can be persisted back to the client's memory for the next run.

## Install

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

## Run

```bash
export DEEPSEEK_API_KEY=...
corepack pnpm dsh web --patch ./packages/mcp/harness-mcp-server/cordis.yml
```

The MCP server listens on `0.0.0.0:8090` (StreamableHTTP). Point any MCP client at `http://127.0.0.1:8090/mcp`.

### Hermes client config

```bash
printf 'n\nY\n' | hermes mcp add harness_plugin --url http://127.0.0.1:8090/mcp
```

## cordis.yml (patch format)

```yaml
- insert:
    - id: harness-mcp-server
      name: '@deepseek-ai/dsh-harness-mcp-server'
      config: { http: true, port: 8090, host: 0.0.0.0 }
```

## Notes / positioning

This is best used as a **fallback tool**, not a daily driver: for everyday code edits, drive your primary agent directly. Reach for this when you need context isolation (huge refactors that would blow the client's context) or parallel execution of unrelated tasks.

- The agent session is **reused per cwd** (avoids re-loading project context every call — ~15-20x cheaper than one-shot `dsh headless`).
- Bash runs sandboxed (`workspace-write`): install `bubblewrap` on the host, or the sandbox will refuse write commands.
- Each new MCP session gets its own `McpServer` + transport (MCP `McpServer` connects to a single transport).

## License

MIT
