import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
const PI = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const url = (rel) => pathToFileURL(path.join(PI, rel)).href;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();
const { initTheme, getMarkdownTheme } = await import(url("dist/modes/interactive/theme/theme.js"));
initTheme("dark");
const { AssistantMessageComponent } = await import(url("dist/modes/interactive/components/assistant-message.js"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import(path.join(process.cwd(), "ext.ts"));
mod.default({ on() {}, getAllTools: () => [], registerToolRenderer() {} });

const mk = (content) => new AssistantMessageComponent({ role: "assistant", content, stopReason: "toolUse" }, true, getMarkdownTheme(), "", 0, []);
const cases = {
	"纯思考 + 工具调用": [{ type: "thinking", thinking: "x" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }],
	"思考 + 文字 + 工具调用": [{ type: "thinking", thinking: "x" }, { type: "text", text: "说明" }, { type: "toolCall", id: "c2", name: "bash", arguments: {} }],
	"只有文字": [{ type: "text", text: "说明" }],
	"只有工具调用": [{ type: "toolCall", id: "c3", name: "bash", arguments: {} }],
};
for (const [name, content] of Object.entries(cases)) {
	const lines = mk(content).render(100).map(strip);
	console.log(`${name}: ${lines.length} 行 ${JSON.stringify(lines)}`);
}
