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
const has = (s) => screen().some((l) => l.includes(s));
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
	click(s);
	await wait(1200);
	const labelRow = screen().findIndex(isBashLabel);
	console.log("Bash 标签行:", labelRow);
	click(labelRow);
	await wait(1500);
	console.log("展开后能看到 ZZZ1:", has("ZZZ1"));
	dump("Bash 展开后");
	click(s);
	await wait(1500);
	console.log("收回后还能看到 ZZZ1:", has("ZZZ1"));
	dump("摘要收回后");
	try { child.kill(); } catch {}
	setTimeout(() => process.exit(0), 800);
})();
