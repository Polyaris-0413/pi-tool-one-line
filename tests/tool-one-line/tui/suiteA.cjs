/**
 * 折叠态只有摘要行；点它展开本段的条目行，行距一致且不影响其它段；再点收回不留残行。
 *
 * 这里不假设模型分几段：模型可能中途插话（分成多段），也可能连着调完再说话（合成一段），
 * 两种都是正确行为。分段的正确性由 `harness/segments.mjs` 用合成消息确定性覆盖，
 * 真机只负责它不可替代的部分——点击链路、行距、收回后不留残行。
 */
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const cols = 200, rows = 50;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const shell = process.env.COMSPEC || "cmd.exe";
const { env, piArgs } = require("./env.cjs");
const child = pty.spawn(shell, piArgs(["--no-session"]), { name: "xterm-256color", cols, rows, cwd: __dirname, env });
const screen = () => { const b = term.buffer.active, o = []; for (let y = 0; y < rows; y++) { const l = b.getLine(b.baseY + y); o.push(l ? l.translateToString(true) : ""); } return o; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isSummary = (l) => /Thinking ×|\bBash ×|\bRead ×|\bEdit ×|\bTool ×/.test(l);
const isEntry = (l) => /^(Bash|Read|Edit|Tool|Write)\.\.\.$/.test(l.trim()) || /^Thinking\.\.\.$/.test(l.trim());
const click = (row) => { child.write(`\x1b[<0;3;${row + 1}M`); setTimeout(() => child.write(`\x1b[<0;3;${row + 1}m`), 40); };
const count = (lines, pred) => lines.filter(pred).length;
const fail = (m) => { console.log("FAIL:", m); process.exitCode = 1; };
const pass = (m) => { if (!process.exitCode) console.log("PASS:", m); };
const dump = (label, around) => {
	console.log(`=== ${label} ===`);
	screen().forEach((l, i) => {
		if (i >= Math.max(0, around - 2) && i <= around + 10) console.log(String(i).padStart(2) + "|" + l.replace(/\s+$/, "").slice(0, 80));
	});
};
const finish = () => { try { child.kill(); } catch {} setTimeout(() => process.exit(process.exitCode ?? 0), 800); };
child.onData((d) => term.write(d));
(async () => {
	await wait(6000);
	child.write("依次运行 ls 和 date 两条命令（两条命令之间不要输出任何文字），最后用一句话总结。\r");
	let stable = 0, last = "";
	for (let i = 0; i < 500; i++) {
		await wait(150);
		const t = screen().join("\n");
		if (t === last) stable++; else stable = 0;
		last = t;
		if (screen().some(isSummary) && stable >= 20) break;
	}
	let lines = screen();
	const first = lines.findIndex(isSummary);
	if (first < 0) {
		dump("没有摘要", rows - 1);
		fail("模型没有产生工具调用：屏幕上没有摘要行（重跑一次，或检查模型输出）");
		finish();
		return;
	}
	const summaries = count(lines, isSummary);
	console.log("折叠态摘要行:", first, "摘要数:", summaries);
	click(first);
	await wait(1500);
	lines = screen();
	dump("展开后", first);
	if (!isSummary(lines[first] || "")) fail("展开后摘要行本身消失了");
	if ((lines[first + 1] || "").trim() !== "") fail("摘要与首条条目行之间应有 1 个空行");
	const entryRows = lines.map((l, i) => (isEntry(l) ? i : -1)).filter((i) => i >= 0);
	if (entryRows.length === 0) fail("展开后没有条目行");
	else {
		if (entryRows[0] !== first + 2) fail(`首条条目行应在摘要下第 2 行，实际在第 ${entryRows[0]} 行`);
		for (let k = 1; k < entryRows.length; k++) {
			if (entryRows[k] - entryRows[k - 1] !== 2) fail(`条目行行距不一致：${entryRows[k - 1]} -> ${entryRows[k]}`);
		}
	}
	if (count(lines, isSummary) !== summaries) fail(`展开一段改变了摘要数：${summaries} -> ${count(lines, isSummary)}`);
	pass(`条目行 ${entryRows.length} 行，行距均为 2，摘要数 ${summaries} 未变`);
	click(first);
	await wait(1500);
	lines = screen();
	dump("收回后", first);
	if (lines.some(isEntry)) fail("收回后仍有条目行");
	if (count(lines, isSummary) !== summaries) fail(`收回一段改变了摘要数：${summaries} -> ${count(lines, isSummary)}`);
	pass("收回后没有条目行，摘要数不变");
	finish();
})();
