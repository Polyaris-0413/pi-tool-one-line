const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const cols = 200, rows = 50;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const shell = process.env.COMSPEC || "cmd.exe";
const { env, piArgs } = require("./env.cjs");
const child = pty.spawn(shell, piArgs(["--no-session"]), { name: "xterm-256color", cols, rows, cwd: __dirname, env });
const screen = () => { const b = term.buffer.active, o = []; for (let y = 0; y < rows; y++) { const l = b.getLine(b.baseY + y); o.push(l ? l.translateToString(true) : ""); } return o; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isSummary = (l) => /Thinking ×|\bBash ×/.test(l);
const isBashLabel = (l) => /^Bash\.\.\.$/.test(l.trim());
const click = (row) => { child.write(`\x1b[<0;3;${row + 1}M`); setTimeout(() => child.write(`\x1b[<0;3;${row + 1}m`), 40); };
/** 命令输出是独占一行的 `ZZZ1`；按整行比对，避免匹配到助手正文里提到的 ZZZ1。 */
const hasOutputRow = (s) => screen().some((l) => l.trim() === s);
const fail = (m) => { console.log("FAIL:", m); process.exitCode = 1; };
const pass = (m) => { if (!process.exitCode) console.log("PASS:", m); };
const finish = () => { try { child.kill(); } catch {} setTimeout(() => process.exit(process.exitCode ?? 0), 800); };
const dump = (label) => { console.log(`=== ${label} ===`); screen().forEach((l, i) => { if (i >= 14 && i <= 40) console.log(String(i).padStart(2) + "|" + l.replace(/\s+$/, "").slice(0, 100)); }); };
child.onData((d) => term.write(d));
(async () => {
	await wait(6000);
	child.write("运行 bash 命令 `for i in 1 2 3; do echo ZZZ$i; done`，然后一句话总结\r");
	let stable = 0, last = "";
	for (let i = 0; i < 600; i++) {
		await wait(150);
		const t = screen().join("\n");
		if (t === last) stable++; else stable = 0;
		last = t;
		if (screen().some(isSummary) && stable >= 30) break;
	}
	const s = screen().findIndex(isSummary);
	console.log("摘要行:", s);
	if (s < 0) {
		fail("模型没有产生工具调用：屏幕上没有摘要行");
		finish();
		return;
	}
	click(s);
	await wait(1200);
	const labelRow = screen().findIndex(isBashLabel);
	console.log("Bash 标签行:", labelRow);
	if (labelRow < 0) {
		dump("展开后没有条目行");
		fail("展开摘要后应有 Bash 条目行");
		finish();
		return;
	}
	click(labelRow);
	await wait(1500);
	dump("Bash 展开后");
	if (hasOutputRow("ZZZ1")) pass("展开 Bash 条目后能看到命令输出行 ZZZ1");
	else fail("展开 Bash 条目后看不到命令输出行 ZZZ1");
	click(s);
	await wait(1500);
	dump("摘要收回后");
	if (hasOutputRow("ZZZ1")) fail("收回摘要后命令输出行仍留在屏上（残行）");
	else pass("收回摘要后不留命令输出残行");
	finish();
})();
