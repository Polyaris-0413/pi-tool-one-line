/**
 * 重载历史会话后布局不变：摘要与正文之间应当只有 1 个空行。
 * 需要先跑 `node make-history.cjs` 生成 history-synthetic.jsonl。
 */
const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");

const cols = 200, rows = 50;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const shell = process.env.COMSPEC || "cmd.exe";
const session = "history-synthetic.jsonl";
if (!fs.existsSync(path.join(__dirname, session))) {
	console.error("FAIL: 缺少 history-synthetic.jsonl，请先运行 node make-history.cjs");
	process.exit(1);
}
const { env, piArgs } = require("./env.cjs");
const child = pty.spawn(shell, piArgs(["--session", session]), {
	name: "xterm-256color", cols, rows, cwd: __dirname, env,
});
const screen = () => {
	const b = term.buffer.active, o = [];
	for (let y = 0; y < rows; y++) {
		const l = b.getLine(b.baseY + y);
		o.push(l ? l.translateToString(true) : "");
	}
	return o;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isSummary = (l) => /Thinking ×12|\bBash ×12/.test(l);
const measure = () => {
	const lines = screen();
	const s = lines.findIndex(isSummary);
	if (s < 0) return null;
	const textRow = lines.findIndex((l, i) => i > s && l.includes("十二轮检查完成"));
	if (textRow < 0) return { s, textRow: -1 };
	return { s, textRow, distance: textRow - s };
};
const find = async () => {
	for (let i = 0; i < 15; i++) {
		const m = measure();
		if (m && m.textRow >= 0) return m;
		child.write("\x1b[5~"); // PageUp
		await wait(400);
	}
	return measure();
};
child.onData((d) => term.write(d));
(async () => {
	await wait(12000);
	const before = await find();
	console.log("重载前:", JSON.stringify(before));
	child.write("/reload\r");
	await wait(8000);
	child.write("\x1b[1;5F"); // Ctrl+End
	await wait(600);
	const after = await find();
	console.log("重载后:", JSON.stringify(after));
	const ok = before && after && before.distance <= 3 && after.distance <= 3;
	console.log(ok ? "PASS: 重载前后摘要与正文之间都只有 1 个空行" : "FAIL: 重载前后布局不一致");
	try { child.kill(); } catch {}
	setTimeout(() => process.exit(ok ? 0 : 1), 800);
})();
