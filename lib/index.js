import { z } from "zod";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { resolve } from "node:path";
//#region lib/types/index.js
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
/** Cordis 插件名 */
const name = "harness-mcp-server";
/** 声明依赖的核心服务 */
const inject = [
	"tools",
	"llm",
	"agents",
	"agentPresets"
];
/** 运行时配置(apply 时从 config 初始化, 提供安全默认值) */
const runtimeConfig = {
	provider: "deepseek-official",
	model: "deepseek-v4-flash",
	preset: "standard",
	maxQueue: 100,
	taskTtlMs: 600 * 1e3,
	maxAgents: 8
};
/** 工具回调统一返回 MCP text content */
function out(content) {
	return { content: [{
		type: "text",
		text: content
	}] };
}
/** 常驻 agent 会话(按 cwd 复用, 省 token: 避免每次全量加载项目上下文) */
const liveAgents = /* @__PURE__ */ new Map();
/** 每个 cwd 的串行执行锁(防同一 agent 会话被并发 followup 冲突) */
const agentLocks = /* @__PURE__ */ new Map();
/** 获取(或创建)指定 cwd 的常驻 agent 会话 */
async function getAgent(ctx, cwd) {
	const existing = liveAgents.get(cwd);
	if (existing) {
		liveAgents.delete(cwd);
		liveAgents.set(cwd, existing);
		return existing;
	}
	while (liveAgents.size >= runtimeConfig.maxAgents) {
		const oldestKey = liveAgents.keys().next().value;
		if (oldestKey === void 0) break;
		const old = liveAgents.get(oldestKey);
		liveAgents.delete(oldestKey);
		try {
			old?.handle?.dispose?.();
		} catch {}
	}
	const sessionId = SessionId(randomUUID());
	const rec = {
		sessionId,
		handle: await ctx.agents.create({
			sessionId,
			meta: { cwd },
			agentOptions: {
				provider: runtimeConfig.provider,
				model: runtimeConfig.model
			},
			setup: async (agentCtx) => {
				await ctx.agentPresets.mount(agentCtx, runtimeConfig.preset);
			}
		})
	};
	liveAgents.set(cwd, rec);
	return rec;
}
/** 同一 cwd 串行执行, 避免并发 followup 同一会话 */
async function withLock(cwd, fn) {
	const next = (agentLocks.get(cwd) ?? Promise.resolve()).then(fn, fn);
	agentLocks.set(cwd, next.catch(() => {}));
	return next;
}
/** 从 agent 最终回答里解析 changes/verification/leftovers(从后往前找候选, 更可靠) */
function parseSummary(assistantText) {
	const empty = {
		changes: "",
		verification: "",
		leftovers: ""
	};
	const candidates = [];
	const re = /\{[\s\S]*?\}/g;
	let m;
	while ((m = re.exec(assistantText)) !== null) candidates.push(m[0]);
	for (let i = candidates.length - 1; i >= 0; i--) try {
		const obj = JSON.parse(candidates[i]);
		const s = (v) => typeof v === "string" ? v : "";
		const changes = s(obj.changes) || s(obj.改动);
		const verification = s(obj.verification) || s(obj.验证);
		const leftovers = s(obj.leftovers) || s(obj.遗留) || s(obj.leftover);
		if (changes || verification || leftovers) return {
			changes,
			verification,
			leftovers
		};
	} catch {}
	return empty;
}
/** 分字段限长, 保证返回的永远是完整合法 JSON(避免 slice(-16000) 截断开头导致非法 JSON) */
function truncateResult(result) {
	return {
		...result,
		assistantText: result.assistantText.slice(0, 8e3),
		toolCalls: result.toolCalls.slice(0, 50).map((c) => ({
			...c,
			args: c.args.slice(0, 2e3)
		})),
		toolResults: result.toolResults.slice(0, 20).map((r) => r.slice(0, 2e3))
	};
}
/** 核心执行: 组装任务(注入记忆上下文+结构化要求) → agent 执行 → 读结构化结果 */
async function executeTask(ctx, task, context, cwd) {
	const workdir = cwd ? resolve(cwd) : process.cwd();
	return withLock(workdir, async () => {
		const { sessionId, handle } = await getAgent(ctx, workdir);
		const baseline = (handle.agent.session.log ?? []).length;
		const fullTask = [
			context ? `【记忆/上下文(供参考, 来自 Hermes 大脑)】\n${context}\n` : "",
			`【任务】\n${task}\n`,
			`【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
			`{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`
		].filter(Boolean).join("\n");
		handle.agent.followup(createUserMessage({
			content: [{
				type: "text",
				text: fullTask
			}],
			source: {
				kind: "plugin",
				plugin: "harness-mcp-server"
			}
		}));
		await handle.agent.whenIdle();
		const result = {
			taskId: "",
			sessionId,
			assistantText: "",
			toolCalls: [],
			toolResults: [],
			changes: "",
			verification: "",
			leftovers: ""
		};
		try {
			const log = (handle.agent.session.log ?? []).slice(baseline);
			const extractText = (obj, out) => {
				if (Array.isArray(obj)) {
					obj.forEach((x) => extractText(x, out));
					return;
				}
				if (obj && typeof obj === "object") {
					const rec = obj;
					if (typeof rec.text === "string" && rec.text.trim()) out.push(rec.text);
					if (typeof rec.content === "string" && rec.content.trim()) out.push(rec.content);
					for (const v of Object.values(rec)) extractText(v, out);
				}
			};
			for (const e of log) {
				const ev = e;
				if (ev.type === "assistant/message") {
					const content = ev.data?.message?.content;
					if (content) {
						const texts = content.filter((c) => c.type === "text" && c.text).map((c) => c.text);
						if (texts.length) result.assistantText += texts.join("\n") + "\n";
					}
				} else if (ev.type === "tool/call") {
					const d = ev.data;
					result.toolCalls.push({
						name: d?.name ?? "?",
						args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? "").slice(0, 2e3)
					});
				} else if (ev.type === "tool/result") {
					const texts = [];
					extractText(ev.data ?? ev, texts);
					if (texts.length) result.toolResults.push(texts.join("\n").slice(0, 3e3));
				}
			}
		} catch (e) {
			result.assistantText = `[读输出异常] ${String(e)}`;
		}
		const summary = parseSummary(result.assistantText);
		result.changes = summary.changes;
		result.verification = summary.verification;
		result.leftovers = summary.leftovers;
		return result;
	});
}
const taskQueue = /* @__PURE__ */ new Map();
/** 在给定 McpServer 上注册工具 */
function registerTools(mcp, ctx) {
	mcp.tool("echo", "回显输入, 验证 MCP server 连通", { text: z.string() }, async ({ text }) => {
		return out(`收到: ${text} @ ${Date.now()}`);
	});
	mcp.tool("harness_list_tools", "列出 Harness 当前注册的所有工具名", {}, async () => {
		const tools = ctx.tools;
		const names = tools && typeof tools.keys === "function" ? Array.from(tools.keys()) : [];
		return out(JSON.stringify(names));
	});
	mcp.tool("agent_run", "同步执行任务(改代码/分析/跑命令), 返回结构化结果。", {
		task: z.string().describe("要 Harness 执行的自然语言任务"),
		context: z.string().optional().describe("Hermes 记忆/上下文, 注入给 agent 参考"),
		cwd: z.string().optional().describe("工作目录(默认当前)")
	}, async ({ task, context, cwd }) => {
		const result = await executeTask(ctx, task, context ?? "", cwd ?? process.cwd());
		return out(JSON.stringify(truncateResult(result), null, 2));
	});
	mcp.tool("task_inbox", "Hermes 把结构化任务(任务+记忆上下文)推入 Harness 队列, 异步执行, 返回 taskId。记忆喂编码的入口。", {
		task: z.string().describe("任务内容"),
		context: z.string().optional().describe("Hermes 记忆/上下文, 随任务注入给 agent"),
		cwd: z.string().optional().describe("工作目录")
	}, async ({ task, context, cwd }) => {
		const now = Date.now();
		for (const [tid, t] of taskQueue) if ((t.status === "done" || t.status === "error") && t.finishedAt && now - t.finishedAt > runtimeConfig.taskTtlMs) taskQueue.delete(tid);
		let active = 0;
		for (const t of taskQueue.values()) if (t.status === "queued" || t.status === "running") active++;
		if (active >= runtimeConfig.maxQueue) return out(JSON.stringify({ error: `task queue full (${active}/${runtimeConfig.maxQueue})` }));
		const id = randomUUID();
		const item = {
			id,
			task,
			context: context ?? "",
			cwd: cwd ?? process.cwd(),
			status: "queued",
			createdAt: now
		};
		taskQueue.set(id, item);
		(async () => {
			item.status = "running";
			try {
				item.result = await executeTask(ctx, item.task, item.context, item.cwd);
				item.result.taskId = id;
				item.status = "done";
			} catch (e) {
				item.error = String(e);
				item.status = "error";
			}
			item.finishedAt = Date.now();
		})();
		return out(JSON.stringify({
			taskId: id,
			status: "queued"
		}));
	});
	mcp.tool("task_result", "取回 task_inbox 提交任务的结构化结果(changes/verification/leftovers)。", { taskId: z.string().describe("task_inbox 返回的 taskId") }, async ({ taskId }) => {
		const item = taskQueue.get(taskId);
		if (!item) return out(JSON.stringify({ error: `task not found: ${taskId}` }));
		return out(JSON.stringify({
			taskId: item.id,
			status: item.status,
			error: item.error,
			result: item.result ? truncateResult(item.result) : void 0
		}, null, 2));
	});
}
/**
* 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 Harness 能力。
*/
async function apply(ctx, config = {}) {
	if (config.provider) runtimeConfig.provider = config.provider;
	if (config.model) runtimeConfig.model = config.model;
	if (config.preset) runtimeConfig.preset = config.preset;
	if (config.maxQueue !== void 0) runtimeConfig.maxQueue = config.maxQueue;
	if (config.taskTtlMs !== void 0) runtimeConfig.taskTtlMs = config.taskTtlMs;
	if (config.maxAgents !== void 0) runtimeConfig.maxAgents = config.maxAgents;
	const port = config.port ?? 8090;
	const host = config.host ?? "127.0.0.1";
	console.log("[harness-mcp-server] apply called, port=", port);
	const servers = /* @__PURE__ */ new Map();
	const transports = /* @__PURE__ */ new Map();
	const server = http.createServer(async (req, res) => {
		const sessionId = req.headers["mcp-session-id"] ?? void 0;
		const existing = sessionId ? transports.get(sessionId) : void 0;
		if (existing) {
			if (req.method === "GET" || req.method === "POST" || req.method === "DELETE") {
				await existing.handleRequest(req, res);
				return;
			}
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32600,
					message: "Method not allowed"
				},
				id: null
			}));
			return;
		}
		if (req.method === "POST" && !sessionId) {
			const mcp = new McpServer({
				name: "harness",
				version: "0.1.3"
			});
			registerTools(mcp, ctx);
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sid) => {
					transports.set(sid, transport);
					servers.set(sid, mcp);
				}
			});
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
		if (sessionId) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32001,
					message: "Session not found"
				},
				id: null
			}));
			return;
		}
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32600,
				message: "Invalid request"
			},
			id: null
		}));
	});
	server.listen(port, host, () => {
		console.log(`[harness-mcp-server] MCP server listening on ${host}:${port}`);
	});
	server.on("error", (e) => {
		console.error("[harness-mcp-server] HTTP server error:", e.message);
	});
	ctx.effect(function* () {
		yield () => {
			server.close();
			transports.clear();
			servers.clear();
			liveAgents.clear();
			agentLocks.clear();
			taskQueue.clear();
		};
	}, "harness-mcp-server");
}
//#endregion
export { apply, inject, name };
