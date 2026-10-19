/**
 * 生成一个用于重载测试的合成会话：12 条「思考 + 一次调用」的消息，
 * 最后是一条带思考的正文。重载后如果隐藏思考块又占行，摘要与正文之间
 * 会多出十几到二十几行空白。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const file = path.join(__dirname, "history-synthetic.jsonl");
const base = Date.parse("2026-10-19T02:00:00.000Z");
const rounds = 12;

/** 会话里的 assistant 消息必须带 usage，否则页脚统计会崩。 */
const usage = (n) => ({
	input: 100 * n,
	output: 20 * n,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120 * n,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistantMeta = (n) => ({
	api: "deepseek",
	provider: "deepseek",
	model: "deepseek-flash",
	usage: usage(n),
});

let parentId = null;
const entries = [];
const id = () => crypto.randomBytes(4).toString("hex");
const push = (entry) => {
	entries.push(entry);
	parentId = entry.id;
};

push({
	type: "session",
	version: 3,
	id: id(),
	timestamp: new Date(base).toISOString(),
	cwd: __dirname,
});
push({ type: "model_change", id: id(), parentId, timestamp: new Date(base).toISOString(), provider: "deepseek", modelId: "deepseek-flash" });
push({ type: "thinking_level_change", id: id(), parentId, timestamp: new Date(base).toISOString(), thinkingLevel: "high" });

let t = base + 1000;
push({
	type: "message",
	id: id(),
	parentId,
	timestamp: new Date(t).toISOString(),
	message: { role: "user", content: [{ type: "text", text: "请分 12 轮逐个检查，每个文件单独调用一次 bash，最后汇总。" }], timestamp: t },
});

for (let i = 0; i < rounds; i++) {
	t += 2000;
	const callId = `call_${i}`;
	push({
		type: "message",
		id: id(),
		parentId,
		timestamp: new Date(t).toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `第 ${i + 1} 轮：先看一下文件 ${i + 1}。` },
				{ type: "toolCall", id: callId, name: "bash", arguments: { command: `echo ${i + 1}` } },
			],
			stopReason: "toolUse",
			...assistantMeta(i + 1),
			timestamp: t,
		},
	});
	t += 500;
	push({
		type: "message",
		id: id(),
		parentId,
		timestamp: new Date(t).toISOString(),
		message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: String(i + 1) }], isError: false, timestamp: t },
	});
}

t += 2000;
push({
	type: "message",
	id: id(),
	parentId,
	timestamp: new Date(t).toISOString(),
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "汇总一下。" },
			{ type: "text", text: "十二轮检查完成，这里是最终汇总。" },
		],
		stopReason: "stop",
		...assistantMeta(20),
		timestamp: t,
	},
});

fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`wrote ${file} (${entries.length} entries)`);
