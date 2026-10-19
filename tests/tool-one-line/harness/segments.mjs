/**
 * 校验折叠段的分界：带文字的 assistant 消息切开分组，每段各一条摘要；
 * 历史重放走同一套分界规则。
 */
import path from "node:path";
import { createJiti } from "jiti";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();

async function install(branchEntries) {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const mod = await jiti.import(path.join(process.cwd(), "ext.ts"));
	const handlers = {};
	const pi = {
		on(name, fn) {
			(handlers[name] ??= []).push(fn);
		},
		getAllTools: () => [{ name: "bash", sourceInfo: { path: "builtin:bash" } }],
		registerToolRenderer(factory) {
			pi.factory = factory;
		},
	};
	mod.default(pi);
	const theme = { italic: (s) => s, bold: (s) => s, fg: (_t, s) => s };
	const ctx = {
		ui: { setHiddenThinkingLabel() {}, getToolsExpanded: () => false, setToolsExpanded() {} },
		sessionManager: { getBranch: () => branchEntries },
	};
	const emit = async (name, event) => {
		for (const fn of handlers[name] ?? []) await fn(event, ctx);
	};
	const renderers = pi.factory("bash", () => undefined);
	const render = (callId) => {
		const renderCtx = {
			toolCallId: callId,
			expanded: true,
			lastComponent: undefined,
			invalidate() {},
			state: {},
			cwd: process.cwd(),
		};
		return renderers.renderCall({ command: "ls" }, theme, renderCtx).render(100).map(strip);
	};
	return { emit, render };
}

const live = async () => {
	const { emit, render } = await install([]);
	await emit("agent_start", {});
	const msgA = {
		role: "assistant",
		timestamp: 1700000000000,
		content: [
			{ type: "thinking", thinking: "A" },
			{ type: "text", text: "第一段" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
			{ type: "toolCall", id: "c2", name: "bash", arguments: {} },
		],
		stopReason: "toolUse",
	};
	const msgB = {
		role: "assistant",
		timestamp: 1700000001000,
		content: [
			{ type: "thinking", thinking: "B" },
			{ type: "text", text: "第二段" },
			{ type: "toolCall", id: "c3", name: "bash", arguments: {} },
		],
		stopReason: "toolUse",
	};
	await emit("message_end", { message: msgA });
	await emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
	await emit("tool_execution_start", { toolCallId: "c2", toolName: "bash" });
	await emit("message_end", { message: msgB });
	await emit("tool_execution_start", { toolCallId: "c3", toolName: "bash" });
	return { render };
};

const history = async () => {
	const entry = (message) => ({ type: "message", timestamp: new Date().toISOString(), message });
	const branch = [
		entry({ role: "user", content: "go" }),
		{
			...entry({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "A" },
					{ type: "text", text: "第一段" },
					{ type: "toolCall", id: "c1", name: "bash", arguments: {} },
					{ type: "toolCall", id: "c2", name: "bash", arguments: {} },
				],
				stopReason: "toolUse",
			}),
		},
		entry({ role: "toolResult", toolCallId: "c1", content: [] }),
		entry({ role: "toolResult", toolCallId: "c2", content: [] }),
		{
			...entry({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "B" },
					{ type: "text", text: "第二段" },
					{ type: "toolCall", id: "c3", name: "bash", arguments: {} },
				],
				stopReason: "toolUse",
			}),
		},
		entry({ role: "toolResult", toolCallId: "c3", content: [] }),
	];
	const { emit, render } = await install(branch);
	await emit("session_start", {});
	return { render };
};

function assert(condition, message) {
	if (!condition) {
		console.error("FAIL:", message);
		process.exitCode = 1;
		throw new Error(message);
	}
}

for (const [name, build] of [
	["实时", live],
	["历史", history],
]) {
	const { render } = await build();
	const c1 = render("c1");
	const c2 = render("c2");
	const c3 = render("c3");
	console.log(`${name}: c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)} c3=${JSON.stringify(c3)}`);
	assert(c1.length === 1, `${name}: 第一段应有摘要行`);
	assert(/Thinking ×1/.test(c1[0]) && /Bash ×2/.test(c1[0]), `${name}: 第一段摘要应只含本段计数`);
	assert(c2.length === 0, `${name}: 同段非首条应 0 行`);
	assert(c3.length === 1, `${name}: 第二段应另起一条摘要`);
	assert(/Thinking ×1/.test(c3[0]) && /Bash ×1/.test(c3[0]), `${name}: 第二段摘要应只含本段计数`);
}

console.log("ok: segments split on assistant text, live and replayed alike");
