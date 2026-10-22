/**
 * 用户消息上下各有一次折叠段时，两侧离消息的距离必须一样。
 *
 * 这条曾经回归过：空行补丁把内核加在用户消息前的 `Spacer(1)` 当成「多余空行」丢掉，
 * 于是上方的摘要贴着用户消息、下方却隔着一个空行。
 *
 * 确定性用例：`make-spacing.cjs` 生成两段「思考 + 两条调用」，中间夹一条用户消息，
 * 不调用模型。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");

const cols = 200, rows = 50;
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
const shell = process.env.COMSPEC || "cmd.exe";
const session = "history-spacing.jsonl";
if (!fs.existsSync(path.join(__dirname, session))) {
	execFileSync(process.execPath, ["make-spacing.cjs"], { cwd: __dirname });
}
const { env, piArgs } = require("./env.cjs");
const child = pty.spawn(shell, piArgs(["--session", session]), {
	name: "xterm-256color", cols, rows, cwd: __dirname, env,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isSummary = (line) => /Thinking ×1 ·\s*Bash ×2/.test(line);
const USER_TEXT = "第二条：再跑两条命令";

/** 整段回滚缓冲（含视口外的行），用来算空行数而不必依赖光标位置。 */
const scrollback = () => {
	const buffer = term.buffer.active;
	const lines = [];
	for (let y = 0; y < buffer.length; y++) {
		const line = buffer.getLine(y);
		lines.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
	}
	return lines;
};

/** 从某行往上数连续空行。 */
const blanksAbove = (lines, row) => {
	let count = 0;
	for (let i = row - 1; i >= 0 && lines[i] === ""; i--) count++;
	return count;
};

const measure = () => {
	const lines = scrollback();
	const userRow = lines.findIndex((line) => line.includes(USER_TEXT));
	if (userRow < 0) return null;
	const above = lines.slice(0, userRow).map((line, i) => (isSummary(line) ? i : -1)).filter((i) => i >= 0).pop();
	const below = lines.slice(userRow + 1).findIndex(isSummary);
	const belowRow = below < 0 ? -1 : userRow + 1 + below;
	if (above === undefined || belowRow < 0) return null;
	return {
		above,
		below: belowRow,
		gapAbove: blanksAbove(lines, userRow),
		gapBelow: blanksAbove(lines, belowRow),
	};
};

child.onData((data) => term.write(data));
(async () => {
	let result = null;
	for (let i = 0; i < 30 && !result; i++) {
		await wait(1000);
		result = measure();
	}
	if (!result) {
		console.log("FAIL: 屏幕上没找到两段摘要夹着用户消息的布局");
	} else {
		console.log("布局:", JSON.stringify(result));
		// 用户消息自带 1 行上下留白（内核给 Markdown 的 paddingY），再加 1 行消息间隔
		const ok = result.gapAbove === 2 && result.gapBelow === 2;
		if (!ok) {
			const lines = scrollback();
			for (let i = Math.max(0, result.above - 1); i <= result.below + 1; i++) console.log(`${String(i).padStart(3)}|${lines[i].slice(0, 60)}`);
		}
		console.log(ok ? "PASS: 用户消息上下的摘要各隔 1 个空行 + 1 行消息留白" : `FAIL: 上方 ${result.gapAbove} 个空行、下方 ${result.gapBelow} 个空行，距离不一致`);
		process.exitCode = ok ? 0 : 1;
	}
	try { child.kill(); } catch {}
	setTimeout(() => process.exit(process.exitCode ?? 0), 800);
})();
