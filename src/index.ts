/**
 * dsh-harness-mcp-server — 在 Harness 内部启动 MCP server, 暴露 Harness 能力给 Hermes(大脑)。
 *
 * 工具集:
 *   - echo                : 验证 MCP server 连通
 *   - harness_list_tools  : 列出 Harness 工具注册表
 *   - agent_run           : 同步执行任务(改代码/分析/跑命令), 返回结构化结果
 *   - task_inbox          : Hermes push 结构化任务(任务+记忆上下文)到 Harness 队列, 异步执行, 返回 taskId
 *   - task_result         : 取回任务的结构化结果(changes/verification/leftovers)
 *
 * 回路: Hermes 记忆 →(context)→ task_inbox → Harness agent 执行 → 结果进队列 → task_result → Hermes 持久化
 */

// ── Context 声明合并: 让 ctx.tools / ctx.llm / ctx.agents 有类型 ──
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import http from 'node:http'

/** Cordis 插件名 */
export const name = 'harness-mcp-server'

/** 声明依赖的核心服务 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets']

/** 插件配置 */
export interface Config {
  http?: boolean
  port?: number
  host?: string
}

/** 工具回调统一返回 MCP text content */
function out(content: string) {
  return { content: [{ type: 'text' as const, text: content }] }
}

/** 常驻 agent 会话(按 cwd 复用, 省 token: 避免每次全量加载项目上下文) */
const liveAgents = new Map<string, { sessionId: SessionId; handle: AgentHandle }>()

/** 每个 cwd 的串行执行锁(防同一 agent 会话被并发 followup 冲突) */
const agentLocks = new Map<string, Promise<unknown>>()

/** 获取(或创建)指定 cwd 的常驻 agent 会话 */
async function getAgent(ctx: Context, cwd: string): Promise<{ sessionId: SessionId; handle: AgentHandle }> {
  const existing = liveAgents.get(cwd)
  if (existing) return existing
  const sessionId = SessionId(randomUUID())
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: async (agentCtx) => {
      // 关键: 通过 setup 挂载 standard preset(含 bash/fs/todo/web 等完整工具)
      await ctx.agentPresets.mount(agentCtx, 'standard')
    },
  })
  const rec = { sessionId, handle }
  liveAgents.set(cwd, rec)
  return rec
}

/** 同一 cwd 串行执行, 避免并发 followup 同一会话 */
async function withLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentLocks.get(cwd) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  agentLocks.set(cwd, next.catch(() => {}))
  return next
}

/** 结构化任务结果 */
interface TaskResult {
  taskId: string
  sessionId: string
  assistantText: string
  toolCalls: { name: string; args: string }[]
  toolResults: string[]
  changes: string
  verification: string
  leftovers: string
}

/** 从 agent 最终回答里宽松解析 changes/verification/leftovers */
function parseSummary(assistantText: string): { changes: string; verification: string; leftovers: string } {
  const empty = { changes: '', verification: '', leftovers: '' }
  // 找第一个 {...} JSON 块(agent 被要求输出 summary JSON)
  const m = assistantText.match(/\{[\s\S]*?\}/)
  if (!m) return empty
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>
    const s = (v: unknown) => (typeof v === 'string' ? v : '')
    return {
      changes: s(obj.changes) || s(obj.改动) || '',
      verification: s(obj.verification) || s(obj.验证) || '',
      leftovers: s(obj.leftovers) || s(obj.遗留) || s(obj.leftover) || '',
    }
  } catch {
    return empty
  }
}

/** 核心执行: 组装任务(注入记忆上下文+结构化要求) → agent 执行 → 读结构化结果 */
async function executeTask(ctx: Context, task: string, context: string, cwd: string): Promise<TaskResult> {
  const workdir = cwd || process.cwd()
  return withLock(workdir, async () => {
    const { sessionId, handle } = await getAgent(ctx, workdir)
    const baseline = ((handle.agent.session as unknown as { log?: unknown[] }).log ?? []).length

    // 组装完整任务文本: 记忆上下文 + 任务 + 结构化输出要求
    const fullTask = [
      context ? `【记忆/上下文(供参考, 来自 Hermes 大脑)】\n${context}\n` : '',
      `【任务】\n${task}\n`,
      `【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
      `{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`,
    ].filter(Boolean).join('\n')

    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: fullTask }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()

    // 结构化读输出
    const result: TaskResult = {
      taskId: '', sessionId, assistantText: '', toolCalls: [], toolResults: [],
      changes: '', verification: '', leftovers: '',
    }
    try {
      const log = ((handle.agent.session as unknown as { log?: unknown[] }).log ?? []).slice(baseline)
      const extractText = (obj: unknown, out: string[]): void => {
        if (Array.isArray(obj)) { obj.forEach((x) => extractText(x, out)); return }
        if (obj && typeof obj === 'object') {
          const rec = obj as Record<string, unknown>
          if (typeof rec.text === 'string' && rec.text.trim()) out.push(rec.text)
          if (typeof rec.content === 'string' && rec.content.trim()) out.push(rec.content)
          for (const v of Object.values(rec)) extractText(v, out)
        }
      }
      for (const e of log) {
        const ev = e as {
          type?: string
          message?: { content?: { type?: string; text?: string }[] }
          data?: unknown
        }
        if (ev.type === 'assistant/message') {
          const d = ev.data as { message?: { content?: { type?: string; text?: string }[] } } | undefined
          const content = d?.message?.content
          if (content) {
            const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text)
            if (texts.length) result.assistantText += texts.join('\n') + '\n'
          }
        } else if (ev.type === 'tool/call') {
          const d = ev.data as { name?: string; arguments?: string; input?: unknown } | undefined
          result.toolCalls.push({
            name: d?.name ?? '?',
            args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? '').slice(0, 2000),
          })
        } else if (ev.type === 'tool/result') {
          const texts: string[] = []
          extractText(ev.data ?? ev, texts)
          if (texts.length) result.toolResults.push(texts.join('\n').slice(0, 3000))
        }
      }
    } catch (e) {
      result.assistantText = `[读输出异常] ${String(e)}`
    }

    // 解析结构化 summary
    const summary = parseSummary(result.assistantText)
    result.changes = summary.changes
    result.verification = summary.verification
    result.leftovers = summary.leftovers
    return result
  })
}

/** 异步任务队列(进程内存, 骨架阶段; 后续可持久化) */
interface TaskItem {
  id: string
  task: string
  context: string
  cwd: string
  status: 'queued' | 'running' | 'done' | 'error'
  result?: TaskResult
  error?: string
}
const taskQueue = new Map<string, TaskItem>()

/** 在给定 McpServer 上注册工具 */
function registerTools(mcp: McpServer, ctx: Context): void {
  mcp.tool('echo', '回显输入, 验证 MCP server 连通', { text: z.string() }, async ({ text }) => {
    return out(`收到: ${text} @ ${Date.now()}`)
  })

  mcp.tool('harness_list_tools', '列出 Harness 当前注册的所有工具名', {}, async () => {
    const tools = ctx.tools as unknown as { keys?: () => Iterable<string> } | null
    const names = tools && typeof tools.keys === 'function' ? Array.from(tools.keys()) : []
    return out(JSON.stringify(names))
  })

  // 同步执行任务(简单场景: Hermes 下发 → 立即拿结果)
  mcp.tool(
    'agent_run',
    '同步执行任务(改代码/分析/跑命令), 返回结构化结果。',
    {
      task: z.string().describe('要 Harness 执行的自然语言任务'),
      context: z.string().optional().describe('Hermes 记忆/上下文, 注入给 agent 参考'),
      cwd: z.string().optional().describe('工作目录(默认当前)'),
    },
    async ({ task, context, cwd }) => {
      const result = await executeTask(ctx, task, context ?? '', cwd ?? process.cwd())
      return out(JSON.stringify(result, null, 2).slice(-16000))
    },
  )

  // 异步 push 任务到队列(Hermes → Harness 任务入口)
  mcp.tool(
    'task_inbox',
    'Hermes 把结构化任务(任务+记忆上下文)推入 Harness 队列, 异步执行, 返回 taskId。记忆喂编码的入口。',
    {
      task: z.string().describe('任务内容'),
      context: z.string().optional().describe('Hermes 记忆/上下文, 随任务注入给 agent'),
      cwd: z.string().optional().describe('工作目录'),
    },
    async ({ task, context, cwd }) => {
      const id = randomUUID()
      const item: TaskItem = {
        id, task, context: context ?? '', cwd: cwd ?? process.cwd(), status: 'queued',
      }
      taskQueue.set(id, item)
      // 异步执行(不阻塞 Hermes)
      void (async () => {
        item.status = 'running'
        try {
          item.result = await executeTask(ctx, item.task, item.context, item.cwd)
          item.result.taskId = id
          item.status = 'done'
        } catch (e) {
          item.error = String(e)
          item.status = 'error'
        }
      })()
      return out(JSON.stringify({ taskId: id, status: 'queued' }))
    },
  )

  // 取回任务结果(结构化 changes/verification/leftovers)
  mcp.tool(
    'task_result',
    '取回 task_inbox 提交任务的结构化结果(changes/verification/leftovers)。',
    { taskId: z.string().describe('task_inbox 返回的 taskId') },
    async ({ taskId }) => {
      const item = taskQueue.get(taskId)
      if (!item) return out(JSON.stringify({ error: `task not found: ${taskId}` }))
      return out(JSON.stringify({
        taskId: item.id,
        status: item.status,
        error: item.error,
        result: item.result,
      }, null, 2).slice(-16000))
    },
  )
}

/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 Harness 能力。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const port = config.port ?? 8090
  const host = config.host ?? '0.0.0.0'
  console.log('[harness-mcp-server] apply called, port=', port)

  const servers = new Map<string, McpServer>()
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req as never, res as never)
        return
      }
      const mcp = new McpServer({ name: 'harness', version: '0.1.0' })
      registerTools(mcp, ctx)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport)
          servers.set(sid, mcp)
        },
      })
      transports.set(transport.sessionId ?? randomUUID(), transport)
      await mcp.connect(transport as never)
      await transport.handleRequest(req as never, res as never)
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('Method Not Allowed: use POST for MCP')
    }
  })

  server.listen(port, host, () => {
    console.log(`[harness-mcp-server] MCP server listening on ${host}:${port}`)
  })
  server.on('error', (e) => {
    console.error('[harness-mcp-server] HTTP server error:', e.message)
  })

  try {
    ;(ctx as unknown as { onDispose?: (fn: () => void) => void }).onDispose?.(() => {
      server.close()
    })
  } catch {
    // 忽略清理错误, 不阻断插件启动
  }
}
