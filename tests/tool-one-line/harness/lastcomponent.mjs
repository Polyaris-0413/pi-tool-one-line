/**
 * 内核自带渲染器（bash/read）会复用 context.lastComponent 并直接 setText；
 * 我们包了一层 Column，必须把它自己的组件还回去，否则会抛异常触发内核兜底渲染。
 */
import path from "node:path";
import { createJiti } from "jiti";
import { Container, Text } from "@earendil-works/pi-tui";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import(path.join(process.cwd(), "ext.ts"));
const handlers = {};
const pi = { on: (n, f) => ((handlers[n] ??= []).push(f)), getAllTools: () => [{ name: "bash", sourceInfo: { path: "builtin:bash" } }], registerToolRenderer: (f) => (pi.factory = f) };
mod.default(pi);
const ctx = { ui: { setHiddenThinkingLabel() {}, getToolsExpanded: () => false, setToolsExpanded() {} }, sessionManager: { getBranch: () => [] } };
const emit = async (n, e) => { for (const f of handlers[n] ?? []) await f(e, ctx); };
const theme = { italic: (s) => s, bold: (s) => s, fg: (_t, s) => s };

// 模拟内核 bash 渲染器：复用 lastComponent 当 Text
const base = {
	renderCall(args, _theme, context) {
		const text = context.lastComponent ?? new Text("", 0, 0);
		text.setText(`$ ${args.command}`);
		return text;
	},
	renderResult(result, options, _theme, context) {
		const component = context.lastComponent ?? new Container();
		component.clear();
		component.addChild(new Text(String(result.content?.[0]?.text ?? ""), 0, 0));
		return component;
	},
};
const renderers = pi.factory("bash", () => base);

await emit("agent_start", {});
const m = { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], timestamp: Date.now() };
await emit("message_update", { message: m });
await emit("message_end", { message: m });
await emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });

const renderCtx = {
	toolCallId: "c1",
	outputPad: 0,
	expanded: true,
	argsComplete: true,
	lastComponent: undefined,
	invalidate() {},
	state: {},
	cwd: process.cwd(),
	executionStarted: true,
	isPartial: true,
	showImages: false,
};

let error;
let first;
try {
	first = renderers.renderCall({ command: "ls" }, theme, renderCtx);
	// 展开本段（点摘要）
	first.handleMouse?.({ type: "click", button: "left", y: 0, x: 0, width: 80, height: 1 });
	// 内核会把我们返回的组件记成 lastComponent
	renderCtx.lastComponent = first;
	first = renderers.renderCall({ command: "ls -la" }, theme, renderCtx);
	renderCtx.lastComponent = first;
	renderers.renderResult({ content: [{ type: "text", text: "out" }] }, { expanded: true, isPartial: true }, theme, renderCtx);
} catch (e) {
	error = e;
}
const lines = (first?.render(80) ?? []).map(strip).map((l) => l.trim()).filter(Boolean);
console.log("渲染结果:", JSON.stringify(lines));
if (error) {
	console.error("FAIL: 复用 context 时抛错 ->", error.message);
	process.exitCode = 1;
} else if (!lines.some((l) => l.includes("$ ls -la"))) {
	console.error("FAIL: 原生渲染没有更新为最新命令");
	process.exitCode = 1;
} else {
	console.log("ok: 内核渲染器复用 lastComponent 时不再抛错，内容随参数更新");
}
