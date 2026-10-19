/**
 * 事件序列 fuzz：随机排列 message_update / message_end / tool_execution_* /
 * agent_start / agent_end（含重复与错序），断言渲染不变量：
 *   1. 不抛异常；
 *   2. 折叠态下只有每段首条有 1 行摘要，其余 0 行；
 *   3. 摘要的 Thinking ×N == 展开后 Thinking 行数；
 *   4. 实时累积的结果与按会话重放重建的结果一致。
 */
import path from "node:path";
import { createJiti } from "jiti";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();
const summaryRe = /Thinking ×|\bBash ×|\bTool ×/;
const thinkingLine = /^Thinking\.\.\.$/;

function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import(path.join(process.cwd(), "ext.ts"));
const handlers = {};
const pi = {
	on: (n, f) => ((handlers[n] ??= []).push(f)),
	getAllTools: () => [{ name: "bash", sourceInfo: { path: "builtin:bash" } }],
	registerToolRenderer: (f) => (pi.factory = f),
};
mod.default(pi);
const theme = { italic: (s) => s, bold: (s) => s, fg: (_t, s) => s };
const renderers = pi.factory("bash", () => undefined);

let branch = [];
const ctx = {
	mode: "tui",
	ui: {
		setHiddenThinkingLabel() {},
		getToolsExpanded: () => false,
		setToolsExpanded() {},
		setWidget() {},
	},
	sessionManager: { getBranch: () => branch },
};
const emit = async (n, e) => {
	for (const f of handlers[n] ?? []) await f(e, ctx);
};

const emitUpdate = async (message) => emit("message_update", { message });
const emitEnd = async (message, extra = {}) => emit("message_end", { message, ...extra });

function renderLines(callId, expanded = false) {
	const c = renderers.renderCall({ command: "ls" }, theme, {
		toolCallId: callId,
		outputPad: 0,
		expanded,
		argsComplete: true,
		lastComponent: undefined,
		invalidate() {},
		state: {},
		cwd: process.cwd(),
	});
	return c.render(120).map(strip).map((l) => l.trim()).filter(Boolean);
}

function collapsedSummary(callId) {
	const lines = renderLines(callId);
	const summary = lines.find((l) => summaryRe.test(l));
	return { lines, summary };
}

function clickSummary(callId) {
	const c = renderers.renderCall({ command: "ls" }, theme, {
		toolCallId: callId,
		outputPad: 0,
		expanded: false,
		argsComplete: true,
		lastComponent: undefined,
		invalidate() {},
		state: {},
		cwd: process.cwd(),
	});
	c.handleMouse?.({ type: "click", button: "left", y: 0, x: 0, width: 120, height: 1 });
}

const withoutDuration = (summary) => (summary ?? "").replace(/ · [\d.]+(?:ms|s|m[\d.]+s)$/, "");

function checkInvariants(callIds, label) {
	const fail = (msg) => {
		throw new Error(`${label}: ${msg}`);
	};
	const leaders = [];
	for (const id of callIds) {
		const { lines, summary } = collapsedSummary(id);
		if (summary) {
			leaders.push({ id, summary });
			const extra = lines.filter((l) => !summaryRe.test(l));
			if (extra.length > 0) fail(`首条折叠态多出内容 ${JSON.stringify(extra)}`);
		} else if (lines.length !== 0) {
			fail(`非首条折叠态应 0 行，实际 ${JSON.stringify(lines)} (${id})`);
		}
	}
	for (const leader of leaders) {
		clickSummary(leader.id);
		const thinkingRows = callIds.reduce((n, id) => n + renderLines(id).filter((l) => thinkingLine.test(l)).length, 0);
		const count = Number((leader.summary.match(/Thinking ×(\d+)/) ?? [])[1] ?? 0);
		if (thinkingRows !== count) fail(`摘要 Thinking ×${count} 与展开行 ${thinkingRows} 不一致`);
		clickSummary(leader.id);
	}
	if (renderLines(callIds[0] ?? "", false).some((l) => thinkingLine.test(l))) fail("收回后仍有 Thinking 行");
}

function makeMessage(rng, seq, calls) {
	const content = [];
	if (rng() < 0.8) content.push({ type: "thinking", thinking: `t${seq}` });
	const hasText = rng() < 0.5;
	if (hasText) content.push({ type: "text", text: `text ${seq}` });
	const n = Math.floor(rng() * 3);
	for (let i = 0; i < n; i++) {
		const id = `c${calls.length}`;
		calls.push(id);
		content.push({ type: "toolCall", id, name: "bash", arguments: { command: `echo ${id}` } });
	}
	return {
		message: { role: "assistant", content, stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop", timestamp: 1_700_000_000_000 + seq * 1000 },
		hasText,
		callIds: content.filter((b) => b.type === "toolCall").map((b) => b.id),
	};
}

const scenarios = 40;
let checked = 0;

for (let seed = 1; seed <= scenarios; seed++) {
	const rng = mulberry32(seed * 7919);
	// 重置状态：空历史 session_start
	branch = [];
	await emit("session_start", {});
	branch = [];
	const calls = [];
	const recorded = [];
	const snapshots = [];
	let seq = 0;
	let turnOpen = true;
	await emit("agent_start", {});
	const ops = 8 + Math.floor(rng() * 8);
	const userMessage = async () => {
		const msg = { role: "user", content: "go", timestamp: 1_700_000_000_000 + seq++ * 1000 };
		recorded.push(msg);
		await emitEnd(msg);
	};

	for (let step = 0; step < ops; step++) {
		const roll = rng();
		if (!turnOpen) {
			// pi 里新的一轮一定由用户消息开启
			await userMessage();
			await emit("agent_start", {});
			turnOpen = true;
			continue;
		}
		if (roll < 0.18) {
			await emit("agent_end", {});
			turnOpen = false;
			continue;
		}
		if (roll < 0.3) {
			await userMessage();
			continue;
		}
		const { message, hasText, callIds } = makeMessage(rng, seq++, calls);
		recorded.push(message);
		// 文字先到，再带出调用；偶尔重复一次 update
		if (hasText) await emitUpdate({ ...message, content: message.content.filter((b) => b.type !== "toolCall") });
		await emitUpdate(message);
		if (rng() < 0.3) await emitUpdate(message);
		await emitEnd(message);
		if (rng() < 0.1) await emitEnd(message);
		for (const id of callIds) {
			await emit("tool_execution_start", { toolCallId: id, toolName: "bash" });
			recorded.push({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1_700_000_100_000 + seq * 1000 });
			await emit("tool_execution_end", { toolCallId: id });
			if (rng() < 0.2) await emit("tool_execution_end", { toolCallId: id });
		}
		snapshots.push({ calls: [...calls], summaries: calls.map((id) => collapsedSummary(id).summary).filter(Boolean) });
	}
	if (turnOpen) await emit("agent_end", {});

	checkInvariants(calls, `seed ${seed} 实时`);
	checked++;

	// 用同一批消息重建历史，摘要（去掉时长）应一致
	const live = calls.map((id) => collapsedSummary(id).summary).filter(Boolean).map(withoutDuration);
	branch = recorded
		.slice()
		.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
		.map((m) => ({ type: "message", timestamp: new Date(m.timestamp).toISOString(), message: m }));
	await emit("session_start", {});
	const replayed = calls.map((id) => collapsedSummary(id).summary).filter(Boolean).map(withoutDuration);
	if (JSON.stringify(live) !== JSON.stringify(replayed)) {
		throw new Error(`seed ${seed} 重放不一致\n实时: ${JSON.stringify(live)}\n重放: ${JSON.stringify(replayed)}`);
	}
	checkInvariants(calls, `seed ${seed} 重放`);
	checked++;
}

console.log(`ok: ${scenarios} 组随机事件序列，${checked} 次不变量检查全部通过`);
