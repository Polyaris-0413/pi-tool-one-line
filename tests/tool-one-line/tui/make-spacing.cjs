/**
 * 生成一个用于空行测试的合成会话：两段「思考 + 两条调用」被一条用户消息隔开。
 *
 * 折叠后每段只剩一行摘要，于是屏幕上出现用户消息上下各有一行摘要的布局。
 * 两侧离用户消息的距离必须一致（各 1 个分隔空行）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const file = path.join(__dirname, "history-spacing.jsonl");
const base = Date.parse("2026-10-19T02:00:00.000Z");

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const meta = { api: "deepseek", provider: "deepseek", model: "deepseek-flash", usage };

let parentId = null;
const entries = [];
const id = () => crypto.randomBytes(4).toString("hex");
const push = (entry) => {
	entries.push(entry);
	parentId = entry.id;
};
const at = (ms) => new Date(ms).toISOString();

let t = base;
push({ type: "session", version: 3, id: id(), timestamp: at(t), cwd: __dirname });
push({ type: "model_change", id: id(), parentId, timestamp: at(t), provider: "deepseek", modelId: "deepseek-flash" });
push({ type: "thinking_level_change", id: id(), parentId, timestamp: at(t), thinkingLevel: "high" });

/** 一轮 = 思考 + 两条调用（折叠后是同一条摘要）+ 两个结果。 */
const turn = (label, callIds) => {
	t += 2000;
	push({
		type: "message",
		id: id(),
		parentId,
		timestamp: at(t),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `${label}：先各跑一条命令。` },
				...callIds.map((callId) => ({ type: "toolCall", id: callId, name: "bash", arguments: { command: `echo ${callId}` } })),
			],
			stopReason: "toolUse",
			...meta,
			timestamp: t,
		},
	});
	for (const callId of callIds) {
		t += 500;
		push({
			type: "message",
			id: id(),
			parentId,
			timestamp: at(t),
			message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: callId }], isError: false, timestamp: t },
		});
	}
};

t += 1000;
push({ type: "message", id: id(), parentId, timestamp: at(t), message: { role: "user", content: [{ type: "text", text: "第一条：跑两条命令" }], timestamp: t } });
turn("第一段", ["call_a1", "call_a2"]);

t += 1000;
push({ type: "message", id: id(), parentId, timestamp: at(t), message: { role: "user", content: [{ type: "text", text: "第二条：再跑两条命令" }], timestamp: t } });
turn("第二段", ["call_b1", "call_b2"]);

t += 2000;
push({
	type: "message",
	id: id(),
	parentId,
	timestamp: at(t),
	message: { role: "assistant", content: [{ type: "thinking", thinking: "汇总。" }, { type: "text", text: "两段都跑完了。" }], stopReason: "stop", ...meta, timestamp: t },
});

fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
console.log(`wrote ${file} (${entries.length} entries)`);
