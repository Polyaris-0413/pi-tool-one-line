/**
 * tool-one-line 的一键测试。
 *
 *   node run-all.cjs                      纯组件测试（秒级，不联网、不调模型）
 *   node run-all.cjs --tui                再加真实 pi 的 TUI 用例（会调模型）
 *   node run-all.cjs --tui --with-reload  再加历史会话重载用例（不调模型）
 *
 * 纯组件测试需要一份带 node_modules 的临时目录；这里会自建到
 * <repo>/tmp/harness-run/，并在每次运行时刷新 ext.ts。
 * 退出码非 0 表示有失败。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TESTS = __dirname;
const REPO = path.resolve(TESTS, "../..");
const EXTENSION = path.join(REPO, "extensions", "tool-one-line.ts");
const WORK = path.join(REPO, "tmp", "harness-run");
const TUI = path.join(TESTS, "tui");

const wantTui = process.argv.includes("--tui");
const wantReload = process.argv.includes("--with-reload");

const HARNESS = ["thinking-only.mjs", "user-message.mjs", "separators.mjs", "segments.mjs", "streaming.mjs", "turns.mjs", "expand-levels.mjs", "repro.cjs", "lastcomponent.mjs", "snapshot-tools.mjs", "fuzz.mjs"];
const TUI_SUITES = [
	{ file: "suiteS.cjs", name: "用户消息上下的间距" },
	{ file: "suiteA.cjs", name: "展开/收回与行距" },
	{ file: "suiteD.cjs", name: "Thinking 行展开/收回" },
	{ file: "suiteP.cjs", name: "Bash 展开后收回不留残行" },
];

function piPackageRoot() {
	const candidates = [];
	if (process.env.PI_PACKAGE_ROOT) candidates.push(process.env.PI_PACKAGE_ROOT);
	const isWin = process.platform === "win32";
	const npmRoot = spawnSync(isWin ? process.env.COMSPEC || "cmd.exe" : "npm", isWin ? ["/c", "npm", "root", "-g"] : ["root", "-g"], { encoding: "utf8" });
	if (npmRoot.status === 0) candidates.push(path.join(npmRoot.stdout.trim(), "@earendil-works", "pi-coding-agent"));
	if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent"));
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(path.join(candidate, "node_modules", "jiti"))) return candidate;
	}
	throw new Error(`找不到 pi 的安装目录，可设置 PI_PACKAGE_ROOT 环境变量。尝试过：\n${candidates.join("\n")}`);
}

function link(target, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	if (fs.existsSync(dest)) return;
	fs.symlinkSync(target, dest, process.platform === "win32" ? "junction" : "dir");
}

function setupWorkdir() {
	const piRoot = piPackageRoot();
	fs.mkdirSync(WORK, { recursive: true });
	link(path.join(piRoot, "node_modules", "jiti"), path.join(WORK, "node_modules", "jiti"));
	link(path.join(piRoot, "node_modules", "@earendil-works", "pi-tui"), path.join(WORK, "node_modules", "@earendil-works", "pi-tui"));
	fs.copyFileSync(EXTENSION, path.join(WORK, "ext.ts"));
	for (const file of HARNESS) fs.copyFileSync(path.join(TESTS, "harness", file), path.join(WORK, file));
}

function run(file, cwd, timeoutMs) {
	const started = Date.now();
	const res = spawnSync(process.execPath, [file], { cwd, encoding: "utf8", timeout: timeoutMs });
	const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	const duration = ((Date.now() - started) / 1000).toFixed(1);
	const failed = res.error || res.status !== 0 || /\bFAIL\b/.test(out) || /MISMATCH/.test(out);
	const tail = out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !/^at |^Node\.js|AttachConsole|conpty_console|^\s*\^|var consoleProcessList/.test(l))
		.slice(-2)
		.join(" | ");
	return { file, failed, duration, tail, status: res.status, error: res.error?.message };
}

function ensureTuiDeps() {
	if (fs.existsSync(path.join(TUI, "node_modules", "node-pty"))) return true;
	console.log("> 安装 TUI 依赖（node-pty / @xterm/headless）…");
	const isWin = process.platform === "win32";
	const res = spawnSync(isWin ? process.env.COMSPEC || "cmd.exe" : "npm", isWin ? ["/c", "npm", "install", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"], {
		cwd: TUI,
		encoding: "utf8",
		timeout: 180_000,
	});
	if (res.status !== 0) {
		console.error("依赖安装失败：\n" + `${res.stdout ?? ""}${res.stderr ?? ""}`.trim());
		return false;
	}
	return true;
}

const results = [];
if (!fs.existsSync(EXTENSION)) {
	console.error(`FAILED: 找不到扩展 ${EXTENSION}`);
	process.exit(1);
}

console.log(`> 准备测试工作目录 ${WORK}`);
setupWorkdir();

console.log("\n[纯组件测试]");
for (const file of HARNESS) {
	const r = run(file, WORK, 120_000);
	results.push(r);
	console.log(`${r.failed ? "FAIL" : "ok  "} ${file.padEnd(20)} ${r.duration}s  ${r.tail}`);
	if (r.failed) break;
}

if (wantTui && !results.some((r) => r.failed)) {
	console.log("\n[真实 TUI]（会调用模型）");
	if (!ensureTuiDeps()) {
		results.push({ file: "npm install", failed: true, duration: "0", tail: "TUI 依赖安装失败", status: 1 });
	} else {
		for (const suite of TUI_SUITES) {
			const r = run(suite.file, TUI, 200_000);
			results.push(r);
			console.log(`${r.failed ? "FAIL" : "ok  "} ${suite.name.padEnd(20)} ${r.duration}s  ${r.tail}`);
			if (r.failed) break;
		}
		if (wantReload && !results.some((r) => r.failed)) {
			const gen = spawnSync(process.execPath, ["make-history.cjs"], { cwd: TUI, encoding: "utf8" });
			if (gen.status !== 0) {
				results.push({ file: "make-history.cjs", failed: true, duration: "0", tail: (gen.stderr ?? "").trim(), status: gen.status });
			} else {
				const r = run("suiteL.cjs", TUI, 150_000);
				results.push(r);
				console.log(`${r.failed ? "FAIL" : "ok  "} ${"重载历史会话后布局".padEnd(20)} ${r.duration}s  ${r.tail}`);
			}
		}
	}
}

const failed = results.filter((r) => r.failed);
console.log(`\n${failed.length ? "FAILED" : "ALL PASS"}: ${results.length - failed.length}/${results.length}`);
if (failed.length) {
	console.log(failed.map((r) => `- ${r.file}: exit=${r.status} ${r.error ?? ""}`).join("\n"));
	process.exit(1);
}
