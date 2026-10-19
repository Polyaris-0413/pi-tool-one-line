/**
 * 复现 tool-one-line 的崩溃：点击摘要行（或任何一次 invalidate）触发无限递归。
 *
 * 模拟内核 ToolExecutionComponent 的失效级联：
 *   context.invalidate() -> ToolExecutionComponent.invalidate()
 *     -> super.invalidate()（Container 遍历子组件）
 *     -> MouseRegion.invalidate() -> 渲染组件.invalidate()
 */
const path = require("node:path");
const { createJiti } = require("jiti");
const { MouseRegion, Text } = require("@earendil-works/pi-tui");

async function main() {
	const jiti = createJiti(path.join(__dirname, "repro.cjs"), { moduleCache: false });
	const mod = await jiti.import(path.join(__dirname, "ext.ts"));
	const install = mod.default;

	const handlers = {};
	const pi = {
		on(name, fn) {
			(handlers[name] ??= []).push(fn);
		},
		getAllTools() {
			return [{ name: "bash", sourceInfo: { path: "builtin:bash" } }];
		},
		registerToolRenderer(factory) {
			pi._factory = factory;
		},
	};
	install(pi);

	const theme = {
		italic: (s) => s,
		bold: (s) => s,
		fg: (_token, s) => s,
	};

	const extCtx = {
		ui: {
			setHiddenThinkingLabel() {},
			getToolsExpanded: () => false,
			setToolsExpanded() {},
		},
		sessionManager: { getBranch: () => [] },
	};
	const emit = async (name, event) => {
		for (const fn of handlers[name] ?? []) await fn(event, extCtx);
	};

	await emit("agent_start", {});
	await emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });

	const base = {
		renderShell: "default",
		renderCall: () => new Text("native call", 0, 0),
		renderResult: () => new Text("native result", 0, 0),
	};
	const renderers = pi._factory("bash", () => base);

	let coreInvalidations = 0;
	let component;
	let liveCtx;
	const region = new MouseRegion(
		{ render: (w) => component.render(w), invalidate: () => component.invalidate(), handleMouse: (e) => component.handleMouse?.(e) },
		() => undefined,
	);
	const core = {
		invalidate() {
			coreInvalidations += 1;
			region.invalidate(); // super.invalidate()：内核 Container 的级联
			component = renderers.renderCall({ command: "ls" }, theme, liveCtx); // updateDisplay()
		},
	};
	const ctx = {
		toolCallId: "c1",
		outputPad: 0,
		expanded: true,
		lastComponent: undefined,
		invalidate: () => core.invalidate(),
		state: {},
		cwd: process.cwd(),
	};
	liveCtx = ctx;

	component = renderers.renderCall({ command: "ls" }, theme, ctx);
	const before = component.render(80).length;

	let clickError;
	try {
		region.handleMouse({
			type: "click",
			button: "left",
			x: 0,
			y: 0,
			width: 80,
			height: component.render(80).length,
			screenX: 0,
			screenY: 0,
		});
	} catch (error) {
		clickError = error;
	}

	assert(clickError === undefined, `点击摘要行不应抛错，实际：${clickError && clickError.message}`);
	assert(coreInvalidations >= 1, "点击后应请求重绘");
	assert(component.render(80).length > before, "点击后应展开出条目行");

	const beforeInvalidations = coreInvalidations;
	let invalidateError;
	try {
		region.invalidate();
	} catch (error) {
		invalidateError = error;
	}
	assert(invalidateError === undefined, `失效不应抛错，实际：${invalidateError && invalidateError.message}`);
	assert(coreInvalidations === beforeInvalidations, `失效不应回灌内核，实际从 ${beforeInvalidations} 变成 ${coreInvalidations}`);

	console.log("ok: click expands without recursion, invalidate does not loop");
}

function assert(condition, message) {
	if (!condition) {
		console.error("FAIL:", message);
		process.exitCode = 1;
		throw new Error(message);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
