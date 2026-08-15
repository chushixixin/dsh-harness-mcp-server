/**
 * dsh-harness-mcp-server — 在 Harness 内部启动 MCP server, 暴露 Harness 能力给 Hermes(大脑)。
 *
 * 工具集:
 *   - echo                : 验证 MCP server 连通
 *   - harness_list_tools  : 列出 Harness 工具注册表
 *   - agent_run           : 同步执行任务(改代码/分析/跑命令), 返回结构化结果
 *   - task_inbox          : Hermes push 结构化任务(任务+记忆上下文)到 Harness 队列, 异步执行, 返回 taskId
 *   - task_result         : 取回任务的结构化结果(changes/verification/leftovers)
 *   - attach_session      : 把会话归组到其 cwd 对应的工作区(手动补给站)
 *   - rename_session      : 给已有会话改名
 *
 * sessionId 续接: 指定 sessionId 时按 本进程池 → live 会话(UI 手开)→ 持久化 resume 三级接管,
 * 前两者都找不到才报错, 所以进程重启前/UI 手开的会话也能续接。
 * 工作区分组: cwd 先 realpath 规范化再 `workspaceRegistry.resolveByPath ?? create` + attachSession;
 * 启动时对存量未分组会话补挂一次(存量捞回)。
 *
 * 回路: Hermes 记忆 →(context)→ task_inbox → Harness agent 执行 → 结果进队列 → task_result → Hermes 持久化
 */
import { z } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import http from 'node:http';
import { resolve } from 'node:path';
/** Cordis 插件名 */
export const name = 'harness-mcp-server';
/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence', 'sessions'];
/** 运行时配置(apply 时从 config 初始化, 提供安全默认值) */
const runtimeConfig = {
    provider: 'deepseek-official',
    // 空字符串 = 不覆盖 model, 跟随 dsh 的用户/默认设置; 显式配置则覆盖
    model: '',
    preset: 'standard',
    maxQueue: 100,
    taskTtlMs: 10 * 60 * 1000,
    maxAgents: 8,
    authToken: '',
    workspaceRoots: [],
};
/** 工具回调统一返回 MCP text content */
function out(content) {
    return { content: [{ type: 'text', text: content }] };
}
/**
 * cwd realpath 规范化: 解析符号链接与 .. 段, 使 cwd 能与 workspace.path(存储时为 realpath 规范化值)
 * 精确比对——这是官方 attachSession 强校验通过的前提。目录不存在时回退 resolve 结果, 由调用方告警不阻断。
 */
async function canonicalCwd(raw) {
    try {
        return await realpath(raw);
    }
    catch {
        return resolve(raw);
    }
}
/** 官方 session.create RPC 同款姿势: resolveByPath ?? create, 幂等; 无 workspaceRegistry 时返回 undefined */
async function ensureWorkspace(ctx, canonical) {
    const registry = ctx.get('workspaceRegistry');
    if (!registry)
        return undefined;
    return (await registry.resolveByPath?.(canonical)) ?? (await registry.create?.(canonical));
}
/** 把会话挂名到其 cwd 对应的工作区。attachSession 内部强校验 realpath(header.cwd) 精确等于 workspace.path,
 *  所以 canonical 必须是 header.cwd 的 realpath 规范化值。失败告警不阻断任务(分组是锦上添花)。 */
async function attachToWorkspace(ctx, canonical, sessionId) {
    try {
        const ws = await ensureWorkspace(ctx, canonical);
        if (ws?.attachSession)
            await ws.attachSession(sessionId);
    }
    catch (e) {
        console.warn('[harness-mcp-server] workspace attach failed:', e?.message ?? e);
    }
}
/** 按会话 header 的 cwd(realpath 规范化后)补挂工作区; header 无 cwd 时静默跳过 */
async function attachSessionCwd(ctx, sessionId, cwd) {
    if (cwd === undefined)
        return;
    await attachToWorkspace(ctx, await canonicalCwd(cwd), sessionId);
}
/** 常驻 agent 会话(按 cwd 复用, 省 token: 避免每次全量加载项目上下文) */
const liveAgents = new Map();
/** sessionId → cwd 索引(支持按 session 续接: 指定 sessionId 时定位到对应 cwd 的常驻会话) */
const sessionToCwd = new Map();
/** 每个 cwd 的串行执行锁(防同一 agent 会话被并发 followup 冲突) */
const agentLocks = new Map();
/** 获取(或创建)指定 cwd 的常驻 agent 会话; 传 sessionId 时接管指定会话; 传 title 时给新会话命名 */
async function getAgent(ctx, cwd, sessionId, title) {
    // 指定 sessionId: 接管已有会话(长任务分多轮投喂 / 中断后恢复 / UI 手开的会话)
    if (sessionId) {
        // 先看本进程常驻池(指定 sessionId 时定位到对应 cwd 的常驻会话; 命中 LRU 移到末尾, 保留上游语义)
        const targetCwd = sessionToCwd.get(sessionId);
        if (targetCwd !== undefined) {
            const existing = liveAgents.get(targetCwd);
            if (existing) {
                liveAgents.delete(targetCwd);
                liveAgents.set(targetCwd, existing);
                return existing;
            }
        }
        const sid = SessionId(sessionId);
        // 不在常驻池: 看 live(UI 手开的、别的插件持有的会话), 直接接管、不持有 dispose(归其 owner)
        const live = ctx.agents.get(sid);
        if (live) {
            // live 会话也补挂工作区(幂等): 用户手开的会话若尚未归组, 这里一并挂名
            await attachSessionCwd(ctx, sid, live.session.header.cwd);
            // no-op dispose 兜底: executeTask 只在 disposeAfter 为 true 时调用 dispose
            return { sessionId: sid, handle: { agent: live, dispose: () => Promise.resolve() }, disposeAfter: false };
        }
        // live 也没有: 从持久化会话存储 resume 并接管(进程重启前的会话、LRU 淘汰后被释放的会话)
        let handle;
        try {
            handle = await ctx.agents.resume({
                resumeSessionId: sid,
                agentOptions: {
                    provider: runtimeConfig.provider,
                    // model 为空则省略, 让 dsh 跟随用户/默认设置; 显式配置则覆盖
                    ...(runtimeConfig.model ? { model: runtimeConfig.model } : {}),
                },
                setup: async (agentCtx) => {
                    // 同 create 路径: dsh rc.6 agent ctx 可能丢 scope tag, 检测不到就跳过挂载(降级为无工具 agent)
                    if (scopeOf(agentCtx) === undefined) {
                        console.warn('[harness-mcp-server] agent ctx unscoped (dsh rc.6 bug); preset mount skipped — upgrade dsh for full tool support');
                        return;
                    }
                    await ctx.agentPresets.mount(agentCtx, runtimeConfig.preset);
                },
            });
        }
        catch (e) {
            // 恢复失败返回明确错误(沿用上游错误风格): 不在常驻池、不是 live、持久化里也没有(或 resume 失败)
            throw new Error(`session not found for resume: ${sessionId} (not live and not persisted; ${e?.message ?? e})`);
        }
        await attachSessionCwd(ctx, sid, handle.agent.session.header.cwd);
        return { sessionId: sid, handle, disposeAfter: true };
    }
    const existing = liveAgents.get(cwd);
    if (existing) {
        // LRU: 命中则移到末尾(最近使用)
        liveAgents.delete(cwd);
        liveAgents.set(cwd, existing);
        // 自愈: 幂等补挂(已在花名册则 no-op; 首次挂名失败的池会话在此被捞回)
        await attachToWorkspace(ctx, await canonicalCwd(cwd), existing.sessionId);
        return existing;
    }
    // LRU 淘汰: 超过上限时逐出最久未用的会话
    while (liveAgents.size >= runtimeConfig.maxAgents) {
        const oldestKey = liveAgents.keys().next().value;
        if (oldestKey === undefined)
            break;
        const old = liveAgents.get(oldestKey);
        liveAgents.delete(oldestKey);
        if (old) {
            sessionToCwd.delete(String(old.sessionId));
            try {
                old.handle?.dispose?.();
            }
            catch { /* 忽略 */ }
        }
    }
    const newSessionId = SessionId(randomUUID());
    // cwd 先 realpath 规范化: session header 的 cwd 与 workspace.path 必须精确相等,
    // 否则 attachSession 强校验 reject(只会 create 注册而 UI 仍落未分组)
    const canonical = await canonicalCwd(cwd);
    const handle = await ctx.agents.create({
        sessionId: newSessionId,
        // 声明 preset: 为未来 Harness 版本消费 meta.agentPreset 做准备; 当前版本靠 setup 里手动 mount 兜底。
        meta: { cwd: canonical, agentPreset: runtimeConfig.preset },
        agentOptions: {
            provider: runtimeConfig.provider,
            // model 为空则省略, 让 dsh 跟随用户/默认设置; 显式配置则覆盖
            ...(runtimeConfig.model ? { model: runtimeConfig.model } : {}),
        },
        setup: async (agentCtx) => {
            // 关键: 通过 setup 挂载 preset(含 bash/fs/todo/web 等完整工具)。
            // dsh rc.6 的 agent-loop 有 bug: setup 收到的 agent ctx 丢失 scope tag,
            // 导致 mount 抛 'refusing to compose an unscoped context'。
            // 这里检测 scope, 无 scope 时跳过挂载(降级为无工具 agent), 避免 agent_run 整体崩溃。
            // master 及后续版本已修复, 会正常走 mount。
            if (scopeOf(agentCtx) === undefined) {
                console.warn('[harness-mcp-server] agent ctx unscoped (dsh rc.6 bug); preset mount skipped — upgrade dsh for full tool support');
                return;
            }
            await ctx.agentPresets.mount(agentCtx, runtimeConfig.preset);
        },
    });
    const rec = { sessionId: newSessionId, handle };
    liveAgents.set(cwd, rec);
    sessionToCwd.set(String(newSessionId), cwd);
    // 分组: 把会话归属到 cwd 对应的工作区(resolveByPath ?? create + attachSession; 可选依赖; headless 环境自动跳过)
    void (async () => {
        try {
            const ws = await ensureWorkspace(ctx, canonical);
            if (ws?.attachSession)
                await ws.attachSession(newSessionId);
        }
        catch (e) {
            console.warn('[harness-mcp-server] workspace attach failed:', String(e));
        }
    })();
    // title 命名(可选): 创建会话后立即命名(走 sessionTitle 服务的 rename)
    if (title) {
        try {
            const session = handle.agent.session;
            const st = ctx.get('sessionTitle');
            st?.rename?.(session, title);
        }
        catch (e) {
            console.warn('[harness-mcp-server] session title set failed:', String(e));
        }
    }
    return rec;
}
/** 同一 cwd 串行执行, 避免并发 followup 同一会话 */
async function withLock(cwd, fn) {
    const prev = agentLocks.get(cwd) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    agentLocks.set(cwd, next.catch(() => { }));
    return next;
}
/** 从 agent 最终回答里解析 changes/verification/leftovers(从后往前找候选, 更可靠) */
function parseSummary(assistantText) {
    const empty = { changes: '', verification: '', leftovers: '' };
    // 收集所有 {...} 候选(agent 被要求输出一行 summary JSON)
    const candidates = [];
    const re = /\{[\s\S]*?\}/g;
    let m;
    while ((m = re.exec(assistantText)) !== null) {
        candidates.push(m[0]);
    }
    // 从后往前: 最后出现的候选最可能是最终 summary, 逐个尝试解析
    for (let i = candidates.length - 1; i >= 0; i--) {
        try {
            const obj = JSON.parse(candidates[i]);
            const s = (v) => (typeof v === 'string' ? v : '');
            const changes = s(obj.changes) || s(obj.改动);
            const verification = s(obj.verification) || s(obj.验证);
            const leftovers = s(obj.leftovers) || s(obj.遗留) || s(obj.leftover);
            // 只要含任一 summary 字段就采纳, 否则继续尝试更早的候选
            if (changes || verification || leftovers) {
                return { changes, verification, leftovers };
            }
        }
        catch {
            // 非合法 JSON, 继续尝试下一个候选
        }
    }
    return empty;
}
/** 分字段限长, 保证返回的永远是完整合法 JSON(避免 slice(-16000) 截断开头导致非法 JSON) */
function truncateResult(result) {
    return {
        ...result,
        assistantText: result.assistantText.slice(0, 8000),
        toolCalls: result.toolCalls.slice(0, 50).map((c) => ({ ...c, args: c.args.slice(0, 2000) })),
        toolResults: result.toolResults.slice(0, 20).map((r) => r.slice(0, 2000)),
    };
}
/** 核心执行: 组装任务(注入记忆上下文+结构化要求) → agent 执行 → 读结构化结果 */
async function executeTask(ctx, task, context, cwd, resumeSessionId, title) {
    // 规范化 cwd: realpath 解析符号链接与 .. 段, 避免 /a、/a/.、相对路径、符号链接成为不同 Map key
    // 导致重复创建会话/并发冲突; 同时也是与 workspace.path 精确比对的唯一 canon
    const workdir = await canonicalCwd(cwd ? resolve(cwd) : process.cwd());
    // cwd 白名单: 配置了 workspaceRoots 时, 只允许在列出的目录下干活(防路径穿越)
    if (runtimeConfig.workspaceRoots.length > 0) {
        const allowed = runtimeConfig.workspaceRoots.some((root) => {
            const r = resolve(root);
            return workdir === r || workdir.startsWith(r + '/');
        });
        if (!allowed) {
            throw new Error(`cwd not allowed (outside workspaceRoots): ${workdir}`);
        }
    }
    // sessionId 用 session 锁, 否则用 cwd 锁——都防同一 agent 会话被并发 followup
    const lockKey = resumeSessionId ? `session:${resumeSessionId}` : workdir;
    return withLock(lockKey, async () => {
        const { sessionId, handle, disposeAfter } = await getAgent(ctx, workdir, resumeSessionId, title);
        const baseline = (handle.agent.session.log ?? []).length;
        // 组装完整任务文本: 记忆上下文 + 任务 + 结构化输出要求
        const fullTask = [
            context ? `【记忆/上下文(供参考, 来自 Hermes 大脑)】\n${context}\n` : '',
            `【任务】\n${task}\n`,
            `【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
            `{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`,
        ].filter(Boolean).join('\n');
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: fullTask }], source: { kind: 'plugin', plugin: 'harness-mcp-server' } }));
        await handle.agent.whenIdle();
        // 结构化读输出
        const result = {
            taskId: '', sessionId, assistantText: '', toolCalls: [], toolResults: [],
            changes: '', verification: '', leftovers: '',
        };
        try {
            const log = (handle.agent.session.log ?? []).slice(baseline);
            const extractText = (obj, out) => {
                if (Array.isArray(obj)) {
                    obj.forEach((x) => extractText(x, out));
                    return;
                }
                if (obj && typeof obj === 'object') {
                    const rec = obj;
                    if (typeof rec.text === 'string' && rec.text.trim())
                        out.push(rec.text);
                    if (typeof rec.content === 'string' && rec.content.trim())
                        out.push(rec.content);
                    for (const v of Object.values(rec))
                        extractText(v, out);
                }
            };
            for (const e of log) {
                const ev = e;
                if (ev.type === 'assistant/message') {
                    const d = ev.data;
                    const content = d?.message?.content;
                    if (content) {
                        const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text);
                        if (texts.length)
                            result.assistantText += texts.join('\n') + '\n';
                    }
                }
                else if (ev.type === 'tool/call') {
                    const d = ev.data;
                    result.toolCalls.push({
                        name: d?.name ?? '?',
                        args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? '').slice(0, 2000),
                    });
                }
                else if (ev.type === 'tool/result') {
                    const texts = [];
                    extractText(ev.data ?? ev, texts);
                    if (texts.length)
                        result.toolResults.push(texts.join('\n').slice(0, 3000));
                }
            }
        }
        catch (e) {
            result.assistantText = `[读输出异常] ${String(e)}`;
        }
        // 解析结构化 summary
        const summary = parseSummary(result.assistantText);
        result.changes = summary.changes;
        result.verification = summary.verification;
        result.leftovers = summary.leftovers;
        // resume 兜底分支: 尽力 flush 持久化, 再释放我们 resume 出来的句柄(不留给僵尸 live agent)
        if (disposeAfter) {
            try {
                await ctx.get('sessions')?.flush?.(handle.agent.session);
            }
            catch {
                /* flush 失败不阻断结果返回 */
            }
            try {
                await handle.dispose();
            }
            catch {
                /* 释放失败不影响结果 */
            }
        }
        return result;
    });
}
const taskQueue = new Map();
/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志) */
async function findSessionHeader(ctx, sessionId) {
    const sessions = ctx.get('sessions');
    const live = sessions?.get?.(sessionId);
    if (live !== undefined)
        return live.header;
    const persistence = ctx.get('sessionPersistence');
    for (const header of (await persistence?.list?.()) ?? []) {
        if (header.id === sessionId)
            return header;
    }
    return undefined;
}
/**
 * 存量捞回: 启动时把现存未分组的会话补挂到已注册工作区。
 * 条件: header.cwd 的 realpath 等于某已注册 workspace.path, 且该 sessionId 不在其花名册里。
 * 只补挂到"已注册"工作区, 不新建(避免把无关目录刷成新工作区); 单会话失败不影响其余。
 */
async function reattachOrphanSessions(ctx) {
    const registry = ctx.get('workspaceRegistry');
    const byPath = new Map();
    for (const ws of registry?.list?.() ?? [])
        byPath.set(ws.path, ws);
    if (byPath.size === 0)
        return { attached: 0, failed: 0 };
    // live + 持久化 header 合并(live 优先), 按 id 去重
    const headers = new Map();
    const sessions = ctx.get('sessions');
    for (const session of sessions?.list?.() ?? [])
        headers.set(session.header.id, session.header);
    const persistence = ctx.get('sessionPersistence');
    for (const header of (await persistence?.list?.()) ?? []) {
        if (!headers.has(header.id))
            headers.set(header.id, header);
    }
    let attached = 0;
    let failed = 0;
    for (const header of headers.values()) {
        if (header.cwd === undefined)
            continue;
        const canonical = await canonicalCwd(header.cwd);
        const ws = byPath.get(canonical);
        if (ws === undefined || !ws.attachSession)
            continue;
        if (ws.sessionIds.includes(header.id))
            continue;
        try {
            await ws.attachSession(header.id);
            attached++;
            console.log(`[harness-mcp-server] 存量捞回: session ${header.id} -> workspace ${ws.path}`);
        }
        catch (e) {
            failed++;
            console.warn(`[harness-mcp-server] 存量捞回失败 session ${header.id}:`, e?.message ?? e);
        }
    }
    return { attached, failed };
}
/** 在给定 McpServer 上注册工具 */
function registerTools(mcp, ctx) {
    mcp.tool('echo', '回显输入, 验证 MCP server 连通', { text: z.string() }, async ({ text }) => {
        return out(`收到: ${text} @ ${Date.now()}`);
    });
    mcp.tool('harness_list_tools', '列出 Harness 当前注册的所有工具名', {}, async () => {
        const tools = ctx.tools;
        const names = tools && typeof tools.keys === 'function' ? Array.from(tools.keys()) : [];
        return out(JSON.stringify(names));
    });
    // 同步执行任务(简单场景: Hermes 下发 → 立即拿结果)
    mcp.tool('agent_run', '同步执行任务(改代码/分析/跑命令), 返回结构化结果。可传 sessionId 续接已有会话(长任务分多轮投喂)。', {
        task: z.string().describe('要 Harness 执行的自然语言任务'),
        context: z.string().optional().describe('Hermes 记忆/上下文, 注入给 agent 参考'),
        cwd: z.string().optional().describe('工作目录(默认当前)'),
        sessionId: z.string().optional().describe('续接已有会话的 sessionId(来自上次 agent_run 结果里的 sessionId 字段)'),
        title: z.string().optional().describe('新会话的标题(创建时命名, 便于会话列表归档)'),
    }, async ({ task, context, cwd, sessionId, title }) => {
        const result = await executeTask(ctx, task, context ?? '', cwd ?? process.cwd(), sessionId, title);
        return out(JSON.stringify(truncateResult(result), null, 2));
    });
    // 异步 push 任务到队列(Hermes → Harness 任务入口)
    mcp.tool('task_inbox', 'Hermes 把结构化任务(任务+记忆上下文)推入 Harness 队列, 异步执行, 返回 taskId。记忆喂编码的入口。', {
        task: z.string().describe('任务内容'),
        context: z.string().optional().describe('Hermes 记忆/上下文, 随任务注入给 agent'),
        cwd: z.string().optional().describe('工作目录'),
        sessionId: z.string().optional().describe('续接已有会话的 sessionId(来自上次 agent_run 结果)'),
        title: z.string().optional().describe('新会话的标题(创建时命名)'),
    }, async ({ task, context, cwd, sessionId, title }) => {
        const now = Date.now();
        // TTL 清理: 删除已完成/失败且超时的任务
        for (const [tid, t] of taskQueue) {
            if ((t.status === 'done' || t.status === 'error') && t.finishedAt && now - t.finishedAt > runtimeConfig.taskTtlMs) {
                taskQueue.delete(tid);
            }
        }
        // 队列容量上限: 活动任务(排队+执行中)超过上限则拒绝
        let active = 0;
        for (const t of taskQueue.values())
            if (t.status === 'queued' || t.status === 'running')
                active++;
        if (active >= runtimeConfig.maxQueue) {
            return out(JSON.stringify({ error: `task queue full (${active}/${runtimeConfig.maxQueue})` }));
        }
        const id = randomUUID();
        const item = {
            id, task, context: context ?? '', cwd: cwd ?? process.cwd(), status: 'queued', createdAt: now,
            ...(sessionId ? { sessionId } : {}),
            ...(title ? { title } : {}),
        };
        taskQueue.set(id, item);
        // 异步执行(不阻塞 Hermes)
        void (async () => {
            item.status = 'running';
            try {
                item.result = await executeTask(ctx, item.task, item.context, item.cwd, item.sessionId, item.title);
                item.result.taskId = id;
                item.status = 'done';
            }
            catch (e) {
                item.error = String(e);
                item.status = 'error';
            }
            item.finishedAt = Date.now();
        })();
        return out(JSON.stringify({ taskId: id, status: 'queued' }));
    });
    // 取回任务结果(结构化 changes/verification/leftovers)
    mcp.tool('task_result', '取回 task_inbox 提交任务的结构化结果(changes/verification/leftovers)。', { taskId: z.string().describe('task_inbox 返回的 taskId') }, async ({ taskId }) => {
        const item = taskQueue.get(taskId);
        if (!item)
            return out(JSON.stringify({ error: `task not found: ${taskId}` }));
        return out(JSON.stringify({
            taskId: item.id,
            status: item.status,
            error: item.error,
            result: item.result ? truncateResult(item.result) : undefined,
        }, null, 2));
    });
    // 给已有会话改名(走 sessionTitle 服务, 便于会话列表归档)
    mcp.tool('rename_session', '给已有会话改名(走 sessionTitle 服务的 rename), 便于会话列表归档区分。', {
        sessionId: z.string().describe('要改名的会话 id(来自 agent_run 结果里的 sessionId 字段)'),
        title: z.string().describe('新标题'),
    }, async ({ sessionId, title }) => {
        try {
            const sessions = ctx.get('sessions');
            const session = sessions?.get?.(sessionId);
            if (!session)
                return out(JSON.stringify({ error: `session not found: ${sessionId}` }));
            const st = ctx.get('sessionTitle');
            if (!st?.rename)
                return out(JSON.stringify({ error: 'sessionTitle service unavailable' }));
            const snapshot = st.rename(session, title);
            return out(JSON.stringify({ ok: true, sessionId, title: snapshot?.title ?? title }));
        }
        catch (e) {
            return out(JSON.stringify({ error: String(e) }));
        }
    });
    // 手动归组补给站: 官方 UI 没有"移动会话到工作区"功能, 本工具供随时归组
    mcp.tool('attach_session', '把会话归组到工作区(补给站: 官方 UI 无移动会话功能)。path 缺省用该会话 header 的 cwd; 归组依赖官方 attachSession 的强校验——realpath(header.cwd) 必须与工作区路径精确相等, 不匹配会返回官方报错。', {
        sessionId: z.string().describe('要归组的会话 id(live 或已持久化)'),
        path: z.string().optional().describe('目标工作区目录(缺省: 会话 header 的 cwd)'),
    }, async ({ sessionId, path }) => {
        const sid = SessionId(sessionId);
        const header = await findSessionHeader(ctx, sid);
        if (header === undefined) {
            return out(JSON.stringify({ error: `session not found: ${sessionId}(live 与持久化里都没有)` }));
        }
        const target = path ?? header.cwd;
        if (target === undefined) {
            return out(JSON.stringify({ error: `session ${sessionId} 的 header 没有 cwd, 官方 attachSession 无法校验, 不能归组` }));
        }
        try {
            const canonical = await realpath(target); // 目标必须是存在的目录, 否则 ENOENT
            const ws = await ensureWorkspace(ctx, canonical);
            if (!ws?.attachSession)
                return out(JSON.stringify({ error: 'workspaceRegistry unavailable' }));
            if (ws.sessionIds.includes(sid)) {
                return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: false, note: 'already attached' }));
            }
            await ws.attachSession(sid);
            return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: true }));
        }
        catch (e) {
            return out(JSON.stringify({ error: `attach failed: ${e?.message ?? String(e)}` }));
        }
    });
}
/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 Harness 能力。
 */
export async function apply(ctx, config = {}) {
    // 初始化运行时配置(覆盖默认值)
    if (config.provider)
        runtimeConfig.provider = config.provider;
    if (config.model)
        runtimeConfig.model = config.model;
    if (config.preset)
        runtimeConfig.preset = config.preset;
    if (config.maxQueue !== undefined)
        runtimeConfig.maxQueue = config.maxQueue;
    if (config.taskTtlMs !== undefined)
        runtimeConfig.taskTtlMs = config.taskTtlMs;
    if (config.maxAgents !== undefined)
        runtimeConfig.maxAgents = config.maxAgents;
    if (config.authToken)
        runtimeConfig.authToken = config.authToken;
    if (config.workspaceRoots)
        runtimeConfig.workspaceRoots = config.workspaceRoots;
    const port = config.port ?? 8090;
    // 安全默认: 仅监听本机。暴露公网/局域网前必须自行加认证+反代+TLS(见 README 警告)
    const host = config.host ?? '127.0.0.1';
    console.log('[harness-mcp-server] apply called, port=', port);
    const servers = new Map();
    const transports = new Map();
    const server = http.createServer(async (req, res) => {
        // Bearer token 认证(配置了 authToken 时强制所有请求校验)
        if (runtimeConfig.authToken) {
            const auth = req.headers['authorization'];
            if (auth !== `Bearer ${runtimeConfig.authToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
                return;
            }
        }
        const sessionId = req.headers['mcp-session-id'] ?? undefined;
        const existing = sessionId ? transports.get(sessionId) : undefined;
        // 已有 session: GET/POST/DELETE 都路由到对应 transport(支持 SSE 流 + 会话终止)
        if (existing) {
            if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
                await existing.handleRequest(req, res);
                return;
            }
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Method not allowed' }, id: null }));
            return;
        }
        // 新 session 初始化(仅 POST 且无 session id)
        if (req.method === 'POST' && !sessionId) {
            const mcp = new McpServer({ name: 'harness', version: '0.1.9' });
            registerTools(mcp, ctx);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    transports.set(sid, transport);
                    servers.set(sid, mcp);
                },
            });
            // 会话关闭时清理映射(避免临时 key 泄漏 + 无效会话累积)
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                    transports.delete(sid);
                    servers.delete(sid);
                }
            };
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            return;
        }
        // 未知 session → 404(不新建 transport, 避免遗留对象)
        if (sessionId) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
            return;
        }
        // 无 session 的非初始化请求 → 400
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' }, id: null }));
    });
    server.listen(port, host, () => {
        console.log(`[harness-mcp-server] MCP server listening on ${host}:${port}`);
    });
    server.on('error', (e) => {
        console.error('[harness-mcp-server] HTTP server error:', e.message);
    });
    // 存量捞回: 启动后异步补挂未分组会话, 不阻塞启动; 全程兜底 try/catch 防 unhandled rejection
    void (async () => {
        try {
            const r = await reattachOrphanSessions(ctx);
            console.log(`[harness-mcp-server] 存量捞回完成: attached=${r.attached} failed=${r.failed}`);
        }
        catch (e) {
            console.warn('[harness-mcp-server] 存量捞回异常:', e?.message ?? e);
        }
    })();
    // 标准 cordis 生命周期: 用 ctx.effect 注册清理(卸载时关 server + 清空全部映射/会话/队列)
    ctx.effect(() => {
        return () => {
            server.close();
            transports.clear();
            servers.clear();
            liveAgents.clear();
            sessionToCwd.clear();
            agentLocks.clear();
            taskQueue.clear();
        };
    }, 'harness-mcp-server');
}
