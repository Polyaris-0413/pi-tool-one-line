/**
 * 消息之间的分隔空行不能被折叠掉。
 *
 * 这条曾经回归过：空行补丁原先对所有 Container 生效，只要前一个子组件渲染 0 行就丢掉
 * 它后面的 Spacer(1)。聊天容器里最后一条工具行折叠后正是 0 行，于是内核加在用户消息
 * 前的分隔空行被吞掉 —— 同一段折叠摘要，出现在用户消息上方时贴得很近，出现在下方时
 * 却空一行。
 *
 * 判别方法：折叠段前后各有一条用户消息时，上下间距必须一致。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

const PI = process.env.PI_PACKAGE_ROOT ?? "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const url = (rel) => pathToFileURL(path.join(PI, rel)).href;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();

const { initTheme, getMarkdownTheme } = await import(url("dist/modes/interactive/theme/theme.js"));
initTheme("dark");
const { AssistantMessageComponent } = await import(url("dist/modes/interactive/components/assistant-message.js"));

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import(path.join(process.cwd(), "ext.ts"));
const handlers = {};
mod.default({
	on(name, fn) {
		(handlers[name] ??= []).push(fn);
	},
	getAllTools: () => [],
	registerToolRenderer() {},
});
const ctx = {
	ui: { setHiddenThinkingLabel() {}, getToolsExpanded: () => false, setToolsExpanded() {} },
	sessionManager: { getBranch: () => [] },
};
for (const fn of handlers.agent_start ?? []) await fn({}, ctx);

const fail = (message) => {
	console.error(`FAIL: ${message}`);
	process.exitCode = 1;
};

/** 折叠后的非首条工具行：外壳为 self、内容为空，整行不占高度。 */
const collapsedToolRow = () => new Container();
/** 内核给每条用户消息加的 Spacer(1)，以及消息自带的上下留白（Markdown 的 outputPad）。 */
const userBlock = () => new Text("用户消息", 1, 1);

/** 上一处可见内容与用户消息之间隔了几个空行（用户消息自带的留白也算在内，共 2 行）。 */
const gapBeforeUser = (lines) => {
	const userRow = lines.findIndex((line) => line.includes("用户消息"));
	let previous = userRow - 1;
	while (previous >= 0 && lines[previous].trim() === "") previous--;
	return userRow - previous - 1;
};

// 一、对话层：折叠行之后的用户消息前，分隔空行必须保留
const chat = new Container();
chat.addChild(collapsedToolRow());
chat.addChild(new Spacer(1));
chat.addChild(userBlock());
const chatLines = chat.render(30).map(strip);
if (gapBeforeUser(chatLines) !== 2) {
	fail(`折叠行与用户消息之间应有 1 个分隔空行，实际行数：${JSON.stringify(chatLines)}`);
}

// 二、对照：折叠行只剩摘要（1 行）时，离用户消息的距离必须一样
const chatVisible = new Container();
chatVisible.addChild(new Text("摘要行", 0, 0));
chatVisible.addChild(new Spacer(1));
chatVisible.addChild(userBlock());
const visibleLines = chatVisible.render(30).map(strip);
if (gapBeforeUser(visibleLines) !== 2) {
	fail(`摘要行与用户消息之间的间距不该变，实际行数：${JSON.stringify(visibleLines)}`);
}

// 三、消息内层：隐藏思考块旁边的空行仍要压掉，只留消息开头那个分隔空行
const message = new AssistantMessageComponent(
	{ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "说明" }], stopReason: "stop" },
	true,
	getMarkdownTheme(),
	"",
	0,
	[],
);
const innerLines = message.render(30).map(strip);
const blanks = innerLines.filter((line) => line.trim() === "").length;
if (innerLines[0]?.trim() !== "" || blanks !== 1) {
	fail(`隐藏思考块仍应压掉它带来的空行，实际行数：${JSON.stringify(innerLines)}`);
}

// 四、整条消息只有隐藏思考块时仍不占任何行
const invisible = new AssistantMessageComponent(
	{ role: "assistant", content: [{ type: "thinking", thinking: "x" }], stopReason: "stop" },
	true,
	getMarkdownTheme(),
	"",
	0,
	[],
);
const invisibleLines = invisible.render(30).map(strip);
if (invisibleLines.length !== 0) {
	fail(`只有隐藏思考块的消息应渲染 0 行，实际行数：${JSON.stringify(invisibleLines)}`);
}

if (!process.exitCode) console.log("ok: 消息之间的分隔空行保留，消息内部的空行照旧压掉");
