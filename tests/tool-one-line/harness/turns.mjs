/**
 * 跨轮不串味：上一轮结尾那次思考（没有调用可挂）不能出现在下一轮的条目列表里。
 */
import path from "node:path";
import { createJiti } from "jiti";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import(path.join(process.cwd(), "ext.ts"));
const handlers = {};
const pi = {
	on: (n, f) => ((handlers[n] ??= []).push(f)),
	getAllTools: () => [{ name: "bash", sourceInfo: { path: "builtin:bash" } }],
	registerToolRenderer: (f) => (pi.factory = f),
};
mod.default(pi);
const ctx = {
	ui: { setHiddenThinkingLabel() {}, getToolsExpanded: () => false, setToolsExpanded() {} },
	sessionManager: { getBranch: () => [] },
};
const emit = async (n, e) => {
	for (const f of handlers[n] ?? []) await f(e, ctx);
};
const theme = { italic: (s) => s, bold: (s) => s, fg: (_t, s) => s };
const renderers = pi.factory("bash", () => undefined);
let ts = 1_700_000_000_000;
const msg = (content) => ({ role: "assistant", content, timestamp: (ts += 1000) });
const T = (t) => ({ type: "thinking", thinking: t });
const X = (t) => ({ type: "text", text: t });
const C = (id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "ls" } });

const component = (callId, expanded = false) => {
	const renderCtx = {
		toolCallId: callId,
		outputPad: 0,
		expanded,
		lastComponent: undefined,
		invalidate() {},
		state: {},
		cwd: process.cwd(),
	};
	return renderers.renderCall({ command: "ls" }, theme, renderCtx);
};
const lines = (callId) => component(callId).render(100).map(strip);

// 第一轮：一次调用 + 结尾一条「思考 + 正文」
await emit("agent_start", {});
const m1 = msg([T("a"), C("c1")]);
await emit("message_update", { message: m1 });
await emit("message_end", { message: m1 });
const m2 = msg([T("b"), X("done")]);
await emit("message_update", { message: m2 });
await emit("message_end", { message: m2 });
await emit("agent_end", {});

// 第二轮：新调用
await emit("agent_start", {});
const m3 = msg([T("c"), C("c2")]);
await emit("message_update", { message: m3 });
await emit("message_end", { message: m3 });

// 展开这一段的摘要（模拟点击），再重建组件读取条目列表
component("c2").handleMouse?.({ type: "click", button: "left", y: 0, x: 0, width: 100, height: 1 });
const expanded = lines("c2");
const thinkingRows = expanded.filter((l) => l.trim() === "Thinking...").length;
const toolRows = expanded.filter((l) => l.trim() === "Bash...").length;
console.log("展开后的条目:", JSON.stringify(expanded.map((l) => l.trim()).filter(Boolean)));
console.log(`Thinking 行=${thinkingRows} Bash 行=${toolRows}`);

if (thinkingRows !== 1) {
	console.error("FAIL: 第二轮只应有它自己的 1 条思考，实际", thinkingRows);
	process.exitCode = 1;
} else if (toolRows !== 1) {
	console.error("FAIL: 第二轮应有 1 条 Bash 条目");
	process.exitCode = 1;
} else {
	console.log("ok: 上一轮结尾的思考没有带到下一轮");
}
