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
import type { Context } from '@deepseek-ai/cordis';
/** Cordis 插件名 */
export declare const name = "harness-mcp-server";
/** 声明依赖的核心服务 */
export declare const inject: string[];
/** 插件配置 */
export interface Config {
    http?: boolean;
    port?: number;
    host?: string;
    /** 后端 provider(默认 deepseek-official) */
    provider?: string;
    /** 执行任务的模型(默认 deepseek-v4-flash) */
    model?: string;
    /** 挂载的 agent preset(默认 standard) */
    preset?: string;
    /** 任务队列容量上限(默认 100) */
    maxQueue?: number;
    /** 已完成任务保留毫秒数(默认 10 分钟) */
    taskTtlMs?: number;
    /** 常驻 agent 会话上限(默认 8, LRU 淘汰) */
    maxAgents?: number;
}
/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 Harness 能力。
 */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map