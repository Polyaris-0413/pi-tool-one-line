/**
 * 工具清单只在事件路径读一次：换会话后旧的渲染行仍可能被画（此时 pi 已被内核置为
 * stale），渲染路径若再去 `getAllTools()` 就会把内核的失效错误变成用户可见的 warning。
 * 这里断言：session_start 之后，renderCall / 摘要行渲染都不再访问 pi。
 */
import path from "node:path";
import { createJiti } from "jiti";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();
const fail = (message) => {
	console.log(`FAIL: ${message}`);
	process.exit(1);
};

const BRANCH = [
	{
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			timestamp: 1700000000000,
			content: [
				{ type: "text", text: "开始" },
				{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
				{ type: "toolCall", id: "c2", name: "mcp__fs__read", arguments: {} },
			],
		},
	},
	{
		type: "message",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "toolResult", toolCallId: "c1", content: [] },
	},
	{
		type: "message",
		timestamp: "2026-01-01T00:00:02.000Z",
		message: { role: "toolResult", toolCallId: "c2", content: [] },
	},
];

async function install() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const mod = await jiti.import(path.join(process.cwd(), "ext.ts"));
	const handlers = {};
	const calls = { tools: 0, stale: false };
	const tools = [
		{ name: "bash", sourceInfo: { path: "builtin:bash" } },
		{ name: "mcp__fs__read", sourceInfo: { path: "C:/some-extension.js" } },
	];
	const pi = {
		on(name, fn) {
			(handlers[name] ??= []).push(fn);
		},
		getAllTools() {
			calls.tools += 1;
			if (calls.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return tools;
		},
		registerToolRenderer(factory) {
			pi.factory = factory;
		},
	};
	mod.default(pi);
	const theme = { italic: (s) => s, bold: (s) => s, fg: (_t, s) => s };
	const notifications = [];
	const ctx = {
		mode: "print",
		ui: {
			setHiddenThinkingLabel() {},
			getToolsExpanded: () => false,
			setToolsExpanded() {},
			notify: (message) => notifications.push(message),
		},
		sessionManager: { getBranch: () => BRANCH },
	};
	const emit = async (name, event) => {
		for (const fn of handlers[name] ?? []) await fn(event, ctx);
	};
	const render = (callId, toolName) => {
		const renderers = pi.factory(toolName, () => undefined);
		const renderCtx = {
			toolCallId: callId,
			outputPad: 0,
			expanded: true,
			argsComplete: true,
			lastComponent: undefined,
			invalidate() {},
			state: {},
			cwd: process.cwd(),
		};
		return renderers.renderCall({ command: "ls" }, theme, renderCtx).render(100).map(strip);
	};
	return { calls, emit, render, notifications, tools };
}

const { calls, emit, render, notifications, tools } = await install();
await emit("session_start", { reason: "startup" });
if (calls.tools === 0) fail("session_start 应当读一次工具清单来建快照");

calls.tools = 0;
const folded = render("c1", "bash").join("\n");
if (!/Bash ×1/.test(folded)) fail(`核心工具应显示自身名字，实际：${JSON.stringify(folded)}`);
if (!/Tool ×1/.test(folded)) fail(`非核心工具应折叠成 Tool，实际：${JSON.stringify(folded)}`);
if (calls.tools !== 0) fail(`渲染路径不应再读工具清单，实际读了 ${calls.tools} 次`);

// 换会话后旧行仍在画：此时清单调用会抛 stale，渲染必须不碰它
calls.stale = true;
const afterSwitch = render("c1", "bash").join("\n");
if (!/Bash ×1/.test(afterSwitch)) fail(`pi 失效后渲染应照常出摘要，实际：${JSON.stringify(afterSwitch)}`);
if (notifications.length > 0) fail(`渲染路径不应弹通知，实际：${JSON.stringify(notifications)}`);

// 快照之后才注册的工具：事件路径补记一次
calls.stale = false;
calls.tools = 0;
tools.push({ name: "later__tool", sourceInfo: { path: "C:/later.js" } });
await emit("tool_execution_start", { toolCallId: "c3", toolName: "later__tool" });
if (calls.tools === 0) fail("事件路径遇到未知工具时应补查一次清单");

console.log("ok: 清单只在事件路径读取，渲染与摘要行不再访问 pi");
