/**
 * 用户消息要渲染成一整块蓝底：空行也必须带背景。
 *
 * 这条曾经回归过：空文本补丁一度按「最后一个字符串参数是空白就返回空串」统一拦截，
 * 把 `bg` 也算进去了。内核给用户消息的每一行（含补齐到整宽的空格）都套 `userMessageBg`，
 * 返回空串就把整行背景抹掉，一条消息被切成一截一截。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const PI = process.env.PI_PACKAGE_ROOT ?? "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const url = (rel) => pathToFileURL(path.join(PI, rel)).href;
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const hasBackground = (line) => /\x1b\[(4[0-9]|10[0-9]|48;)/.test(line);

const { initTheme, getMarkdownTheme } = await import(url("dist/modes/interactive/theme/theme.js"));
initTheme("dark");
const { UserMessageComponent } = await import(url("dist/modes/interactive/components/user-message.js"));

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
// 补丁是在 agent_start 里兑现的，必须先走一遍再渲染
for (const fn of handlers.agent_start ?? []) await fn({}, ctx);

const text = "第一段\n\n第二段还在同一块里\n第三行\n\n第四段\n\n第五段";
const lines = new UserMessageComponent(text, getMarkdownTheme(), 0, []).render(60);
const gaps = lines.map((line, index) => (hasBackground(line) ? null : index)).filter((index) => index !== null);
console.log(`用户消息 ${lines.length} 行，无背景色的行：${JSON.stringify(gaps)}`);
if (gaps.length > 0) {
	console.error(`FAIL: 用户消息被空行切成了多块（第 ${gaps.join(", ")} 行没有背景色）`);
	process.exitCode = 1;
}

// 同一个补丁仍要让隐藏的思考标签变成真正的 0 行
const theme = globalThis[THEME_KEY];
if (theme.fg("thinkingText", "") !== "") {
	console.error("FAIL: 空文本补丁失效，隐藏的思考标签会重新占一行");
	process.exitCode = 1;
}

if (!process.exitCode) console.log("ok: 用户消息整块着色，空文本装饰仍返回空串");
