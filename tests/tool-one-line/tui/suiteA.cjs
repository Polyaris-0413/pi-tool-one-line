const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const cols = 200, rows = 50;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const shell = process.env.COMSPEC || "cmd.exe";
const { env, piArgs } = require("./env.cjs");
const child = pty.spawn(shell, piArgs(["--no-session"]), { name: "xterm-256color", cols, rows, cwd: __dirname, env });
const screen = () => { const b = term.buffer.active, o = []; for (let y = 0; y < rows; y++) { const l = b.getLine(b.baseY + y); o.push(l ? l.translateToString(true) : ""); } return o; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isSummary = (l) => /Thinking ×|\bBash ×|\bRead ×/.test(l);
const isLabel = (l) => /^(Bash|Read|Edit|Tool|Write)\.\.\.$/.test(l.trim());
const click = (row) => { child.write(`\x1b[<0;3;${row + 1}M`); setTimeout(() => child.write(`\x1b[<0;3;${row + 1}m`), 40); };
const fail = (m) => { console.log("FAIL:", m); process.exitCode = 1; };
child.onData((d) => term.write(d));
(async () => {
	await wait(6000);
	child.write("先用一句话说明你要看目录，然后运行 ls；再用一句话说明你要看时间，然后运行 date；最后总结一句。\r");
	let stable = 0, last = "";
	for (let i = 0; i < 500; i++) {
		await wait(150);
		const t = screen().join("\n");
		if (t === last) stable++; else stable = 0;
		last = t;
		if (screen().filter(isSummary).length >= 2 && stable >= 20) break;
	}
	let lines = screen();
	const first = lines.findIndex(isSummary);
	console.log("折叠态摘要行:", first);
	if (first < 0) { fail("没有摘要行"); process.exit(1); }
	click(first);
	await wait(1500);
	lines = screen();
	console.log("=== 展开后 ===");
	lines.forEach((l, i) => console.log(String(i).padStart(2) + "|" + l.replace(/\s+$/, "").slice(0, 80)));
	if (!isLabel(lines[first + 2] || "") && !/^Thinking...$/.test((lines[first + 2] || "").trim())) fail("摘要下应有一个空行后跟条目行");
	if ((lines[first + 1] || "").trim() !== "") fail("摘要与首条标签之间应有 1 个空行");
	const labelRows = lines.map((l, i) => (isLabel(l) || /^Thinking...$/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
	for (let k = 1; k < labelRows.length; k++) {
		if (labelRows[k] - labelRows[k - 1] !== 2) fail(`标签行距不一致：${labelRows[k - 1]} -> ${labelRows[k]}`);
	}
	const summary2 = lines.findIndex((l, i) => i > first && isSummary(l));
	if (summary2 < 0) fail("第二段摘要消失");
	else if (lines.slice(first, summary2).some((l) => isLabel(l)) === false) fail("本段没有标签");
	console.log(`PASS: 标签 ${labelRows.length} 行，行距均为 2；第二段摘要仍在第 ${summary2} 行`);
	click(first);
	await wait(1500);
	lines = screen();
	console.log("=== 收回后 ===");
	lines.forEach((l, i) => { if (i >= first - 2 && i <= first + 6) console.log(String(i).padStart(2) + "|" + l.replace(/\s+$/, "").slice(0, 80)); });
	if (lines.some(isLabel)) fail("收回后仍有标签行");
	else console.log("PASS: 收回后没有标签行");
	try { child.kill(); } catch {}
	setTimeout(() => process.exit(0), 800);
})();
