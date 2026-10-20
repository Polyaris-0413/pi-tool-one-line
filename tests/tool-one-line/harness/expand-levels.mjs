/**
 * 二级展开的形态必须统一：点开一条标签，这条标签就被它的正文替换掉（不再残留 `Bash...`）。
 *
 * 同一段里三条拼接路径（首条 / 非首条 / 思考行）曾经各自为政：
 * 首条保留标签再加原生渲染，思考行保留 `Thinking...` 再加正文，只有非首条是替换。
 */
import path from "node:path";
import { createJiti } from "jiti";
import { Text } from "@earendil-works/pi-tui";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();
const toolLabel = /^(Bash|Edit|Read|Write|Tool)\.\.\.$/;
const thinkingLabel = /^Thinking\.\.\.$/;

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import(path.join(process.cwd(), "ext.ts"));
const handlers = {};
const pi = {
	on: (n, f) => ((handlers[n] ??= []).push(f)),
	getAllTools: () => [{ name: "bash", sourceInfo: { path: "builtin:bash" } }],
	registerToolRenderer: (f) => (pi.factory = f),
};
mod.default(pi);
const theme = { italic: (s) => s, bold: (s) => s, fg: (_t, s) => s };
const ctx = {
	ui: { setHiddenThinkingLabel() {}, getToolsExpanded: () => false, setToolsExpanded() {} },
	sessionManager: { getBranch: () => [] },
};
const emit = async (n, e) => {
	for (const f of handlers[n] ?? []) await f(e, ctx);
};

/** 模拟内核自带渲染器：调用行与结果各一行，内容能对上具体调用。 */
const base = {
	renderCall: (args) => new Text(`$ ${args.command}`, 0, 0),
	renderResult: (result) => new Text(`out: ${result.content[0].text}`, 0, 0),
};
const renderers = pi.factory("bash", () => base);

function component(callId, expanded) {
	return renderers.renderCall({ command: callId }, theme, {
		toolCallId: callId,
		outputPad: 0,
		expanded,
		argsComplete: true,
		lastComponent: undefined,
		invalidate() {},
		state: {},
		cwd: process.cwd(),
	});
}

/** 渲染成非空行：空行（Spacer 与工具块自带的空行）不参与形态判断。 */
const rows = (callId, expanded) =>
	component(callId, expanded)
		.render(120)
		.map(strip)
		.map((line) => line.trim())
		.filter(Boolean);

const findThinkingRow = (callId, expanded) =>
	component(callId, expanded).children.find((child) => child.constructor.name === "ThinkingRow");

function assert(condition, message) {
	if (condition) return;
	console.error("FAIL:", message);
	process.exitCode = 1;
	throw new Error(message);
}

const click = (row, y = 0) => row.handleMouse({ type: "click", button: "left", y });

await emit("agent_start", {});
const message = {
	role: "assistant",
	timestamp: 1_700_000_000_000,
	content: [
		{ type: "thinking", thinking: "思考内容" },
		{ type: "text", text: "说明文字" },
		{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
		{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "date" } },
	],
	stopReason: "toolUse",
};
await emit("message_end", { message });
for (const id of ["c1", "c2"]) await emit("tool_execution_start", { toolCallId: id, toolName: "bash" });

// 0 级：只有首条一行摘要
const collapsed = rows("c1", false);
assert(collapsed.length === 1 && /Thinking ×1/.test(collapsed[0]), `折叠态应只有 1 行摘要，实际 ${JSON.stringify(collapsed)}`);
assert(rows("c2", false).length === 0, "同段非首条折叠态应 0 行");

// 1 级：每个调用一行标签
click(component("c1", false).children[0]);
const level1 = { c1: rows("c1", false), c2: rows("c2", false) };
assert(level1.c1.includes("Thinking...") && level1.c1.includes("Bash..."), `首条 1 级应含思考行与标签，实际 ${JSON.stringify(level1.c1)}`);
assert(JSON.stringify(level1.c2) === JSON.stringify(["Bash..."]), `非首条 1 级应只有标签，实际 ${JSON.stringify(level1.c2)}`);

// 2 级（非首条）：标签换成原生渲染
const level2 = rows("c2", true);
assert(level2.includes("$ c2"), `非首条 2 级应显示原生渲染，实际 ${JSON.stringify(level2)}`);
assert(!level2.some((line) => toolLabel.test(line)), `非首条 2 级不应残留类型标签，实际 ${JSON.stringify(level2)}`);

// 2 级（首条）：同样只有原生渲染，摘要与未展开的思考行保留
const leaderExpanded = rows("c1", true);
assert(leaderExpanded.some((line) => line.includes("Thinking ×1")), "首条 2 级仍应保留摘要行");
assert(leaderExpanded.includes("$ c1"), `首条 2 级应显示原生渲染，实际 ${JSON.stringify(leaderExpanded)}`);
assert(!leaderExpanded.some((line) => toolLabel.test(line)), `首条 2 级不应残留类型标签，实际 ${JSON.stringify(leaderExpanded)}`);
assert(leaderExpanded.includes("Thinking..."), "未展开的思考行仍应显示 Thinking... 标签");

// 2 级（思考行）：标签换成思考正文
const thinkingRow = findThinkingRow("c1", true);
assert(thinkingRow !== undefined, "首条展开后应有 Thinking 行");
click(thinkingRow);
const thinkingExpanded = rows("c1", true);
assert(thinkingExpanded.some((line) => line.includes("思考内容")), `展开思考后应显示正文，实际 ${JSON.stringify(thinkingExpanded)}`);
assert(!thinkingExpanded.some((line) => thinkingLabel.test(line)), `展开思考后不应残留 Thinking... 标签，实际 ${JSON.stringify(thinkingExpanded)}`);

// 再点一次收回，标签回来
click(findThinkingRow("c1", true));
assert(rows("c1", true).includes("Thinking..."), "再点思考行应收回成 Thinking... 标签");

// 收回本段：不再有条目行
click(component("c1", false).children[0]);
assert(rows("c2", false).length === 0, "收回本段后非首条应回到 0 行");
assert(rows("c1", false).length === 1, "收回本段后首条应回到 1 行摘要");

console.log("ok: 二级展开统一为「标签换成正文」，首条/非首条/思考行一致");
