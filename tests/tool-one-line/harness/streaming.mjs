/**
 * 流式阶段的行为：工具调用一出现就归段（不先画 `Bash...`），
 * 同一消息的多次 update 不会把这一段切碎。
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
await emit("agent_start", {});

const theme = { italic: (s) => s, bold: (s) => s, fg: (_t, s) => s };
const renderers = pi.factory("bash", () => undefined);
const render = (callId, argsComplete = true) =>
	renderers
		.renderCall({ command: "ls" }, theme, {
			toolCallId: callId,
			expanded: false,
			argsComplete,
			lastComponent: undefined,
			invalidate() {},
			state: {},
			cwd: process.cwd(),
		})
		.render(100)
		.map(strip);

const msg = (content) => ({ role: "assistant", content, timestamp: Date.now() });

function assert(condition, message) {
	if (!condition) {
		console.error("FAIL:", message);
		process.exitCode = 1;
		throw new Error(message);
	}
}

const text = (t) => ({ type: "text", text: t });
const call = (id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "ls" } });

// 流式：先来文字，再来工具调用；同一消息多次 update
const m1 = 1_700_000_000_000;
const textOnly = msg([{ type: "thinking", thinking: "a" }, text("第一段")]);
textOnly.timestamp = m1;
await emit("message_update", { message: textOnly });

// 尚未归段的流式调用不应画出标签
assert(render("c-unknown", false).length === 0, "流式未归段调用不应渲染标签");

const withCall1 = msg([{ type: "thinking", thinking: "a" }, text("第一段"), call("c1")]);
withCall1.timestamp = m1;
await emit("message_update", { message: withCall1 });

const withCalls = msg([{ type: "thinking", thinking: "a" }, text("第一段"), call("c1"), call("c2")]);
withCalls.timestamp = m1;
await emit("message_update", { message: withCalls });
await emit("message_update", { message: withCalls });
await emit("message_end", { message: withCalls });

const c1 = render("c1");
const c2 = render("c2");
console.log("第一段:", JSON.stringify(c1), JSON.stringify(c2));
assert(c1.length === 1 && /Thinking ×1/.test(c1[0]) && /Bash ×2/.test(c1[0]), "同一条消息的多次 update 不应把本段切碎");
assert(c2.length === 0, "同段非首条应为 0 行");

// 下一段文字：封口一次，之后的调用另起一条摘要
const m2 = 1_700_000_010_000;
const nextText = msg([{ type: "thinking", thinking: "b" }, text("第二段")]);
nextText.timestamp = m2;
await emit("message_update", { message: nextText });
await emit("message_update", { message: nextText });
const nextCalls = msg([{ type: "thinking", thinking: "b" }, text("第二段"), call("c3")]);
nextCalls.timestamp = m2;
await emit("message_update", { message: nextCalls });
await emit("message_end", { message: nextCalls });

const c3 = render("c3");
console.log("第二段:", JSON.stringify(c3));
assert(/Thinking ×1/.test(c3[0]) && /Bash ×1/.test(c3[0]), "第二段应另起一条摘要");

console.log("ok: streaming calls are attributed before they can paint a label");
