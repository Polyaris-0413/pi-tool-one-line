// SPDX-License-Identifier: GPL-3.0-only

/**
 * 工具调用按「一段文字」压成一行，并保留两级展开。
 *
 * 段 = 一条带文字的 assistant 消息之后的那些工具调用，直到下一条带文字的消息。
 * 第 0 级（默认）：一段里的所有工具调用只在第一条的位置留一行摘要，例如
 *   `Thinking ×9 · Bash ×6 · Edit ×3 · 12.4s`
 *   其余调用整行不占高度（self 外壳 + 空内容 = 0 行，工具块自带的空行也一并消失）。
 * 第 1 级：点摘要行 → 本段每个工具显示一行标签（`Bash...` / `Edit...`）。
 * 第 2 级：点某条标签 → 只有这一条换成内置渲染，命令、输出、diff、计时器与平时一致。
 *
 * 折叠的思考块由内核绘制，其标签被置空后只剩 ANSI 序列，`Text` 的空值判断
 * （`text.trim() === ""`）不成立，会让每条思考白占一行；见 patchEmptyThemeText。
 * 标签被压成 0 行后，内核仍会在消息开头和思考块后面留 `Spacer(1)`；内容不可见的消息
 * 会因此白占一行，见 patchContainerSpacers。
 * 思考在摘要里计数；展开某段后，属于该段的思考各占一行 `Thinking...`，点它展开正文。
 *
 * 只注册渲染器，不重注册工具：`execute`、`description`、`parameters`、
 * 输出截断策略都留在内核手里，模型收到的 `result.content` 与未安装本扩展时完全一致。
 *
 * ## 三处内核补丁的出处
 *
 * 均按 pi 1.3.0 的内核实现核对（本仓库开发时的版本）；上游既无对应修复，也未提 issue，
 * 所以只能在本扩展里打补丁。升级 pi 后若折叠态又开始出现空行、或标签突然不生效，按这三条核对：
 * - 隐藏思考标签置空后仍占一行：`dist/modes/interactive/components/assistant-message.js`
 *   用 `new Text(theme.italic(theme.fg(...)))` 画标签，而 `Text.render()` 用 `trim() === ""` 判空。
 * - 0 行内容旁边留下 `Spacer(1)`：同一文件里的 `contentContainer`。
 * - CLI 把 pi-tui 内联进 bundle，扩展 `import` 到的类与内核实际使用的不是同一个：
 *   `dist/modes/interactive/components/tool-execution.js` 的 self 外壳。
 * 补丁失效时不会报错，只会在会话内首次发生异常时提示一次（见 `reportOnce`）。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";

/**
 * 最小设计源：本扩展输出的固定文案。颜色一律引用 pi 主题 token，不在此定义。
 * 代码只引用这里的取值，不内联字面量。
 */
const DESIGN = {
	/** 非核心工具（扩展、MCP、SDK 注册的工具）的统称。 */
	otherToolLabel: "Tool",
	/** 条目行标签后缀，表示该行可展开。 */
	toolLabelSuffix: "...",
	thinking: { summaryLabel: "Thinking", rowLabel: "Thinking..." },
	summary: { separator: " · ", countPrefix: "×" },
} as const;

/** 主题实例挂在这个全局符号上，跨打包边界共享（内核与扩展看到同一对象）。 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** 一段：一条带文字的 assistant 消息之后的工具调用，到下一条带文字的消息为止。 */
interface Run {
	leaderCallId: string;
	callIds: string[];
	toolNames: string[];
	/** 本段是否展开成条目列表。 */
	expanded: boolean;
	startedAt: number;
	endedAt?: number;
}

interface RunState {
	current?: Run;
	/** 已计入摘要、还没挂到调用行上的思考正文，等本消息的首条调用接手。 */
	pendingThinkingTexts: string[];
	/** callId -> 该行之前属于同一消息的思考正文。 */
	thinkingByCall: Map<string, string[]>;
	/** `callId:index` -> 这条思考正文是否已展开。 */
	thinkingExpanded: Map<string, boolean>;
	/** 已经因文字封过口的流式消息时间戳；同一消息的多次 update 只封一次。 */
	textClosedFor?: number;
	/** 已经计过思考的消息时间戳；重复的 message_end 不重复计数。 */
	thinkingCountedFor?: number;
	runByLeader: Map<string, Run>;
	runByCall: Map<string, Run>;
	/** 每条调用所属 ToolExecutionComponent 的重绘入口，展开/收起时逐条失效。 */
	invalidateByCall: Map<string, () => void>;
	/** 内核自带渲染器上次返回的组件：它们会复用 lastComponent（bash 直接 setText）。 */
	baseCallByCall: Map<string, Component>;
	baseResultByCall: Map<string, Component>;
	coreByTool: Map<string, boolean>;
	ctx?: ExtensionContext;
	/** 内核 TUI 实例：折叠/展开后强制全量重绘，清除终端里残留的旧行。 */
	tui?: { requestRender?: (force?: boolean) => void };
}

/**
 * 会话级单例：TUI 模式下同时只会有一个会话，因此不按会话分桶。
 * 多会话共存的模式（RPC 的 new_session 会先结束旧会话）不在支持范围内；
 * 渲染上下文里也没有会话标识，无法在 `renderCall` 中区分。
 * 按 callId 建索引的几张表与 transcript 同量级（内核本身也持有这些行），
 * 因此在 `session_start`/`session_shutdown` 两个口子上整体丢弃即可。
 */

const state: RunState = {
	current: undefined,
	pendingThinkingTexts: [],
	thinkingByCall: new Map(),
	thinkingExpanded: new Map(),
	textClosedFor: undefined,
	runByLeader: new Map(),
	runByCall: new Map(),
	invalidateByCall: new Map(),
	baseCallByCall: new Map(),
	baseResultByCall: new Map(),
	coreByTool: new Map(),
	ctx: undefined,
	tui: undefined,
};

function resetRuns(): void {
	state.current = undefined;
	state.pendingThinkingTexts = [];
	state.thinkingByCall.clear();
	state.thinkingExpanded.clear();
	state.baseCallByCall.clear();
	state.baseResultByCall.clear();
	state.invalidateByCall.clear();
	state.coreByTool.clear();
	state.textClosedFor = undefined;
	state.thinkingCountedFor = undefined;
	state.runByLeader.clear();
	state.runByCall.clear();
	reported.clear();
}

/** 同一条故障每次会话只说一次：渲染路径会被高频调用，重复提示会淹没对话。 */
const reported = new Set<string>();

/**
 * 捕获的异常统一在这里落地一次。默认只弹一条 warning，不写文件；
 * 需要细节时设 `TOOL_ONE_LINE_DEBUG=1`，把原始异常打到 stderr。
 */
function reportOnce(key: string, reason: string, error?: unknown): void {
	if (reported.has(key)) return;
	reported.add(key);
	const detail = error instanceof Error ? `${reason}：${error.message}` : reason;
	if (process.env.TOOL_ONE_LINE_DEBUG) console.error(`[tool-one-line] ${key} — ${detail}`, error);
	try {
		state.ctx?.ui?.notify?.(`tool-one-line: ${detail}`, "warning");
	} catch {
		// 非 TUI 模式（print/json/rpc）可能没有可用的通知端，日志已经尽力
	}
}

/**
 * 核心工具由内核注册，`sourceInfo.path` 恰好是 `builtin:<工具名>`
 * （`dist/core/agent-session.js` 的 `_refreshToolRegistry`）。
 * 扩展、MCP、SDK 工具不满足该等式，因此不需要维护名单。
 */
function labelOf(pi: ExtensionAPI, toolName: string): string {
	const cached = state.coreByTool.get(toolName);
	if (cached !== undefined) return cached ? titleOf(toolName) : DESIGN.otherToolLabel;
	let core = true;
	try {
		const info = pi.getAllTools().find((tool) => tool.name === toolName);
		core = info?.sourceInfo.path === `builtin:${toolName}`;
	} catch (error) {
		// 拿不到工具清单时按核心工具处理：显示自身名字比压成同一个词更不容易误导
		reportOnce("tools", "读不到工具清单，核心工具按名字显示", error);
	}
	state.coreByTool.set(toolName, core);
	return core ? titleOf(toolName) : DESIGN.otherToolLabel;
}

function titleOf(toolName: string): string {
	return `${toolName.charAt(0).toUpperCase()}${toolName.slice(1)}`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function ensureRun(callId: string, startedAt = Date.now()): Run {
	if (state.current) return state.current;
	const run: Run = {
		leaderCallId: callId,
		callIds: [],
		toolNames: [],
		expanded: false,
		startedAt,
	};
	state.current = run;
	state.runByLeader.set(callId, run);
	return run;
}

function addCall(run: Run, callId: string, toolName: string): void {
	run.callIds.push(callId);
	run.toolNames.push(toolName);
	state.runByCall.set(callId, run);
}

/** 展开/收起时，本段每一行都要重建；内核只重绘被点的那一行。 */
function invalidateRun(run: Run): void {
	for (const callId of run.callIds) state.invalidateByCall.get(callId)?.();
}

/**
 * 秒数只在重绘时才会变。本段未封口期间定期失效摘要行，
 * 否则要等到下一条工具事件（往往是下一次工具结束）才跳动。
 */
let ticker: ReturnType<typeof setInterval> | undefined;

function startRunTicker(): void {
	if (ticker) return;
	ticker = setInterval(() => {
		const run = state.current;
		if (!run) return;
		state.invalidateByCall.get(run.leaderCallId)?.();
	}, 400);
	(ticker as unknown as { unref?: () => void }).unref?.();
}

function stopRunTicker(): void {
	if (!ticker) return;
	clearInterval(ticker);
	ticker = undefined;
}

/** 记录一条调用；历史重放与实时路径都可能先到，重复到达时不再计数。 */
function startCall(callId: string, toolName: string, startedAt = Date.now()): void {
	if (state.runByCall.has(callId)) return;
	addCall(ensureRun(callId, startedAt), callId, toolName);
}

/** 思考块没有工具调用与之配对时先存着，等这一轮的第一个工具调用把它接手。 */
function addThinking(text: string): void {
	state.pendingThinkingTexts.push(text);
}

/** 把本消息的思考挂到它的首条调用上：展开时按顺序显示在该条前面。 */
function attachThinking(calls: Array<{ id: string }>): void {
	if (calls.length === 0 || state.pendingThinkingTexts.length === 0) return;
	state.thinkingByCall.set(calls[0].id, [...state.pendingThinkingTexts]);
	state.pendingThinkingTexts = [];
}

/** 摘要行末尾的耗时算到本段真正结束（下一条文字出现或本轮结束），而不是最后一条工具结束。 */
function summaryText(pi: ExtensionAPI, run: Run, theme: Theme): string {
	const parts: string[] = [];
	// 计数直接来自已挂到调用行上的思考正文：摘要与展开列表不会对不上
	const thinkingRows = run.callIds.reduce((sum, callId) => sum + (state.thinkingByCall.get(callId)?.length ?? 0), 0);
	if (thinkingRows > 0) {
		const label = theme.italic(theme.fg("thinkingText", DESIGN.thinking.summaryLabel));
		parts.push(`${label} ${theme.fg("dim", `${DESIGN.summary.countPrefix}${thinkingRows}`)}`);
	}
	const counts = new Map<string, number>();
	for (const toolName of run.toolNames) {
		const label = labelOf(pi, toolName);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	for (const [label, count] of counts) {
		parts.push(`${theme.italic(theme.fg("thinkingText", label))} ${theme.fg("dim", `${DESIGN.summary.countPrefix}${count}`)}`);
	}
	// 只有本段已封口才停在 endedAt；否则最后一条工具一结束计时器就冻住
	const end = state.current === run ? Date.now() : (run.endedAt ?? Date.now());
	parts.push(theme.fg("dim", formatDuration(end - run.startedAt)));
	return parts.join(theme.fg("dim", DESIGN.summary.separator));
}

type ThemeLike = Record<string, any>;

/**
 * 内核用 `new Text(theme.italic(theme.fg(token, label)))` 画折叠的思考块。标签置空后
 * 只剩 ANSI 序列，`Text.render()` 用 `text.trim() === ""` 判空，转义序列让这个判断不成立，
 * 于是每条思考白占一行。
 *
 * 主题里所有「把文本装饰成 ANSI」的方法都以文本作为最后一个字符串参数（`fg`/`bg` 的文本在
 * 颜色之后），按这个形状识别而不是枚举方法名：枚举会漏掉 `bg` 这类同类方法，内核新增
 * 装饰器时还得再改一次。只有文本为空白时才返回空串，其余调用原样转发。
 */
function guardEmptyThemeText(target: ThemeLike): void {
	if (target.emptyTextPatched) return;
	for (const name of Object.getOwnPropertyNames(target)) {
		// `constructor` 也是函数，替换它会破坏原型；装饰器不会叫这个名字
		if (name === "constructor") continue;
		const descriptor = Object.getOwnPropertyDescriptor(target, name);
		if (!descriptor || typeof descriptor.value !== "function") continue;
		const original = descriptor.value as (...args: unknown[]) => unknown;
		target[name] = function (...args: unknown[]) {
			for (let index = args.length - 1; index >= 0; index--) {
				const arg = args[index];
				if (typeof arg !== "string") continue;
				if (arg.trim() === "") return "";
				break;
			}
			return original.apply(this, args);
		};
	}
	Object.defineProperty(target, "emptyTextPatched", { value: true, configurable: true });
}

/**
 * `/reload` 会换掉主题实例（新实例没有旧补丁），所以原型和当前实例都要补：
 * 原型覆盖之后新建的实例，实例兜住自身挂载的方法。
 */
function patchEmptyThemeText(): void {
	const theme = (globalThis as Record<symbol, unknown>)[THEME_KEY] as ThemeLike | undefined;
	if (!theme) return;
	const proto = Object.getPrototypeOf(theme) as ThemeLike | null;
	if (proto && proto !== Object.prototype) guardEmptyThemeText(proto);
	guardEmptyThemeText(theme);
}

/**
 * 内核给每条消息的内容容器开头添一个 `Spacer(1)`，折叠后内容变成 0 行时它就只剩空白：
 * 纯思考 + 工具调用的消息每条都白留一行。这里只修两种「空行旁边没有可分隔的东西」：
 * - 紧跟 0 行兄弟的 Spacer（隐藏思考块后面那个）；
 * - 整个容器只渲染出一行空白、且第一块是 Spacer（整条消息都不可见）。
 * 有可见内容时的间距保持内核原样。
 */
interface ContainerPrototype {
	children: Component[];
	render(width: number): string[];
	spacerPatchApplied?: true;
}

/** 内核 bundle 里的 Spacer 与扩展 import 的不是同一个类，只能靠类名识别。 */
function isSpacer(component: Component): boolean {
	return component instanceof Spacer || component?.constructor?.name === "Spacer";
}

function patchContainerSpacers(proto: ContainerPrototype): void {
	if (proto.spacerPatchApplied) return;
	const originalRender = proto.render;
	proto.render = function (this: ContainerPrototype, width: number): string[] {
		// 主题实例可能刚被 /reload 换掉，先在子组件渲染前把补丁兑现
		patchEmptyThemeText();
		const children = this.children;
		const dropped: number[] = [];
		for (let i = 1; i < children.length; i++) {
			if (isSpacer(children[i]) && children[i - 1].render(width).length === 0) dropped.push(i);
		}
		if (dropped.length > 0) this.children = children.filter((_, index) => !dropped.includes(index));
		try {
			const lines = originalRender.call(this, width);
			if (
				dropped.length === 0 &&
				children.length > 1 &&
				lines.length === 1 &&
				lines[0].trim() === "" &&
				isSpacer(children[0])
			) {
				return [];
			}
			return lines;
		} finally {
			this.children = children;
		}
	};
	proto.spacerPatchApplied = true;
}

/**
 * pi 的 CLI 把 pi-tui 内联进了自己的 bundle，扩展 `import` 到的 Container 与内核实际使用的
 * 不是同一个类，原型补丁碰不到内核。用 widget 工厂拿到内核的 TUI 实例，沿原型链找到
 * 内核真正在用的 Container 原型再打补丁。
 */
function findContainerPrototype(tui: unknown): ContainerPrototype | undefined {
	let proto = Object.getPrototypeOf(tui as object) as ContainerPrototype | null;
	while (proto && proto !== Object.prototype) {
		if (
			Object.prototype.hasOwnProperty.call(proto, "render") &&
			Object.prototype.hasOwnProperty.call(proto, "addChild") &&
			Object.prototype.hasOwnProperty.call(proto, "clear")
		) {
			return proto;
		}
		proto = Object.getPrototypeOf(proto) as ContainerPrototype | null;
	}
	return undefined;
}

/** TUI 实例在进程生命周期内不变，缓存到全局，重载时不必再借 widget 探一次。 */
const TUI_KEY = Symbol.for("tool-one-line:tui");

function patchCoreContainer(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const cached = (globalThis as Record<symbol, unknown>)[TUI_KEY] as RunState["tui"] | undefined;
	if (cached) {
		state.tui = cached;
		return;
	}
	const key = "tool-one-line:probe";
	try {
		ctx.ui.setWidget(key, (tui) => {
			const proto = findContainerPrototype(tui);
			if (proto) patchContainerSpacers(proto);
			(globalThis as Record<symbol, unknown>)[TUI_KEY] = tui;
			state.tui = tui as RunState["tui"];
			return { render: () => [], invalidate() {} };
		});
	} catch (error) {
		// 拿不到内核实例就只保留对外部 pi-tui 的补丁
		reportOnce("patch-container", "拿不到内核 TUI 实例，空行补丁可能只在外部 pi-tui 上生效", error);
	} finally {
		try {
			ctx.ui.setWidget(key, undefined);
		} catch {
			// 清不掉探针 widget 只影响一行空白，不影响渲染，保持静默
		}
	}
}

/** 强制下一次渲染走全量重绘：列表变矮时内核的差异渲染会留下空白残行。 */
function forceRepaint(): void {
	state.tui?.requestRender?.(true);
}

/** 折叠态隐藏思考块标签；始终置空，否则展开一段会让全项目的思考行同时现身。 */
function syncThinkingLabel(): void {
	if (!state.ctx) return;
	patchEmptyThemeText();
	state.ctx.ui.setHiddenThinkingLabel("");
}

class TurnSummary implements Component {
	private readonly pi: ExtensionAPI;
	private readonly run: Run;
	private readonly theme: Theme;
	private readonly outputPad: number;
	/** 内核注入的重绘入口；不能叫 invalidate，否则会覆盖组件生命周期方法并形成失效递归。 */
	private readonly requestInvalidate: () => void;

	constructor(pi: ExtensionAPI, run: Run, theme: Theme, requestInvalidate: () => void, outputPad: number) {
		this.pi = pi;
		this.run = run;
		this.theme = theme;
		this.requestInvalidate = requestInvalidate;
		this.outputPad = outputPad;
	}

	render(width: number): string[] {
		return new Text(summaryText(this.pi, this.run, this.theme), this.outputPad, 0).render(width);
	}

	invalidate(): void {}

	/** 第一行是摘要，点它切换本轮展开；其余行交给外层 MouseRegion（切换单条展开）。 */
	handleMouse(event: { type?: string; button?: string; y?: number }): { handled: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		this.run.expanded = !this.run.expanded;
		// 思考标签始终隐藏，切换时无需重建整个记录；全量重绘会清掉残行
		invalidateRun(this.run);
		this.requestInvalidate();
		forceRepaint();
		return { handled: true };
	}
}

/** 展开后条目列表里的思考行；点一下展开该段思考正文，正文沿用内核的 thinkingText token。 */
class ThinkingRow implements Component {
	private readonly text: string;
	private readonly theme: Theme;
	private readonly key: string;
	private readonly outputPad: number;
	private readonly requestInvalidate: () => void;

	constructor(text: string, theme: Theme, key: string, requestInvalidate: () => void, outputPad: number) {
		this.text = text;
		this.theme = theme;
		this.key = key;
		this.requestInvalidate = requestInvalidate;
		this.outputPad = outputPad;
	}

	render(width: number): string[] {
		const text = this.theme.italic(this.theme.fg("thinkingText", DESIGN.thinking.rowLabel));
		const label = new Text(text, this.outputPad, 0).render(width);
		if (state.thinkingExpanded.get(this.key) !== true || this.text === "") return label;
		const body = new Text(this.theme.italic(this.theme.fg("thinkingText", this.text)), this.outputPad, 0).render(width);
		return [...label, ...body];
	}

	invalidate(): void {}

	handleMouse(event: { type?: string; button?: string }): { handled: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		state.thinkingExpanded.set(this.key, state.thinkingExpanded.get(this.key) !== true);
		this.requestInvalidate();
		return { handled: true };
	}
}

/** 一条调用前面要补的思考行；末尾带一个空行，保证和条目行行距一致。 */
function thinkingRows(callId: string, theme: Theme, requestInvalidate: () => void, outputPad: number): Component[] {
	const texts = state.thinkingByCall.get(callId);
	if (!texts || texts.length === 0) return [];
	const rows: Component[] = [];
	texts.forEach((text, index) => {
		rows.push(new ThinkingRow(text, theme, `${callId}:${index}`, requestInvalidate, outputPad), new Spacer(1));
	});
	return rows;
}

/** 内核渲染器会复用 `context.lastComponent`（bash/read 直接 `setText`），必须还给它自己上次的组件。 */
function withBaseComponent<T extends { toolCallId: string }>(context: T, cache: Map<string, Component>): T {
	return { ...context, lastComponent: cache.get(context.toolCallId) };
}

function nativeCall(base: any, args: unknown, theme: Theme, context: any, toolName: string): Component | undefined {
	if (!base?.renderCall) return undefined;
	try {
		const component = base.renderCall(args, theme, withBaseComponent(context, state.baseCallByCall));
		state.baseCallByCall.set(context.toolCallId, component);
		return component;
	} catch (error) {
		// 参数异常时退回我们自己的标签，不要让内核用 `bash command: ...` 兜底
		reportOnce(`native-call:${toolName}`, `内核 renderCall 抛错（${toolName}），该行改用单条标签`, error);
		return undefined;
	}
}

function nativeResult(base: any, result: unknown, options: unknown, theme: Theme, context: any, toolName: string): Component | undefined {
	if (!base?.renderResult) return undefined;
	try {
		const component = base.renderResult(result, options, theme, withBaseComponent(context, state.baseResultByCall));
		state.baseResultByCall.set(context.toolCallId, component);
		return component;
	} catch (error) {
		reportOnce(`native-result:${toolName}`, `内核 renderResult 抛错（${toolName}），输出退回纯文本`, error);
		return undefined;
	}
}

/** 竖直拼接若干组件；用 pi-tui 的 Container，不重复实现它的 render/invalidate/handleMouse。 */
function stack(children: Component[]): Container {
	const container = new Container();
	for (const child of children) container.addChild(child);
	return container;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }, theme: Theme, outputPad: number): Text {
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	return new Text(theme.fg("toolOutput", text), outputPad, 0);
}

/** 带文字的 assistant 消息给上一段封口，它之后的工具调用另起一条摘要。 */
function closeRun(endedAt = Date.now()): void {
	if (!state.current) return;
	// 本段时长算到真正结束（下一段文字出现 / 本轮结束），而不是最后一条工具结束
	state.current.endedAt = endedAt;
	state.current = undefined;
}

/** 流式阶段只封一次：文字先到、工具调用后到，它们属于同一段。 */
function closeOnText(message: { role?: string; content?: unknown; timestamp?: number }): void {
	if (!hasText(message)) return;
	if (state.textClosedFor !== undefined && state.textClosedFor === message.timestamp) return;
	state.textClosedFor = message.timestamp;
	closeRun();
}

/** 助手消息是否带思考块；与内置折叠标签一一对应。 */
function hasThinking(message: { role?: string; content?: unknown }): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	return (message.content as Array<{ type?: string; thinking?: string }>).some(
		(block) => block?.type === "thinking" && (block.thinking ?? "").trim().length > 0,
	);
}

/** 助手消息是否带文字块；文字是折叠段的分界。 */
function hasText(message: { role?: string; content?: unknown }): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	return (message.content as Array<{ type?: string; text?: string }>).some(
		(block) => block?.type === "text" && (block.text ?? "").trim().length > 0,
	);
}

/** 助手消息里的思考正文；同一消息的多个思考块合并成一段。 */
function thinkingTextOf(message: { content?: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return (message.content as Array<{ type?: string; thinking?: string }>)
		.filter((block) => block?.type === "thinking" && (block.thinking ?? "").trim().length > 0)
		.map((block) => (block.thinking ?? "").trim())
		.join("\n\n");
}

/** 助手消息里的工具调用块；实时路径与历史重放共用。 */
function toolCallsOf(message: { content?: unknown }): Array<{ id: string; name: string }> {
	if (!Array.isArray(message.content)) return [];
	const calls: Array<{ id: string; name: string }> = [];
	for (const block of message.content as Array<{ type?: string; id?: unknown; name?: unknown }>) {
		if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
			calls.push({ id: block.id, name: block.name });
		}
	}
	return calls;
}

/** 重放历史：会话恢复后，过去的工具调用同样按段聚合，而不是退回逐条显示。 */
function reconstructRuns(ctx: ExtensionContext): void {
	resetRuns();
	let lastTimestamp: number | undefined;
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as {
				role?: string;
				content?: unknown;
				toolCallId?: string;
			};
			const at = Date.parse(entry.timestamp);
			const timestamp = Number.isFinite(at) ? at : undefined;
			if (timestamp !== undefined) lastTimestamp = timestamp;
			if (message.role === "user") {
				// 与实时路径的 agent_start 对齐：上一轮收尾的思考不带进下一轮
				state.pendingThinkingTexts = [];
				closeRun(timestamp ?? Date.now());
				continue;
			}
			if (message.role === "assistant" && Array.isArray(message.content)) {
				// 与实时路径一致：先按文字封口，再让本条的思考属于下一段
				if (hasText(message)) closeRun(timestamp ?? Date.now());
				if (hasThinking(message)) addThinking(thinkingTextOf(message));
				const calls = toolCallsOf(message);
				for (const call of calls) startCall(call.id, call.name, timestamp ?? Date.now());
				attachThinking(calls);
				continue;
			}
			if (message.role === "toolResult" && typeof message.toolCallId === "string" && timestamp !== undefined) {
				const run = state.runByCall.get(message.toolCallId);
				if (run) run.endedAt = timestamp;
			}
		}
	} catch (error) {
		// 历史读不出来就退回逐条标签显示，不影响实时聚合
		reportOnce("history", "历史会话解析失败，过去的工具调用退回逐条标签", error);
		resetRuns();
	}
	if (state.current) state.current.endedAt = lastTimestamp ?? Date.now();
	state.current = undefined;
}

export default function (pi: ExtensionAPI) {
	patchEmptyThemeText();
	patchContainerSpacers(Container.prototype as ContainerPrototype);

	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		// 先清空上一会话的残留，再打补丁：补丁失败时的提示不会随即被清掉
		reconstructRuns(ctx);
		patchCoreContainer(ctx);
		syncThinkingLabel();
	});

	pi.on("agent_start", async (_event, ctx) => {
		state.ctx = ctx;
		closeRun();
		// 上一轮收尾的那次思考（结束时没有调用可挂）不能带到这一轮
		state.pendingThinkingTexts = [];
		state.textClosedFor = undefined;
		startRunTicker();
		// `/reload` 与设置变更会把标签恢复成默认值，每轮开头重申一次
		syncThinkingLabel();
		// 新的一轮一律从折叠态开始：pi 的展开是全局开关，
		// 一旦被打开，之后每个新工具行都会以完整展开态创建
		if (ctx.ui.getToolsExpanded()) ctx.ui.setToolsExpanded(false);
	});

	pi.on("agent_end", async () => {
		closeRun();
		state.pendingThinkingTexts = [];
		state.textClosedFor = undefined;
		stopRunTicker();
		forceRepaint();
	});

	// 会话结束即丢弃本轮所有索引与缓存：否则切会话/退出后仍留着上一轮的组件与重绘回调
	pi.on("session_shutdown", async () => {
		stopRunTicker();
		resetRuns();
		state.ctx = undefined;
	});

	// 流式阶段就归段：不等 message_end，工具行一出现就知道自己属于哪一段，
	// 不会先画一行 `Bash...` 再变成摘要。
	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		closeOnText(event.message);
		for (const call of toolCallsOf(event.message)) startCall(call.id, call.name);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "user") {
			// 新一轮（或介入消息）开始：上一轮收尾的思考不带进来
			state.pendingThinkingTexts = [];
			closeRun();
			return;
		}
		// 文字切开折叠段；本条消息的思考属于文字之后的下一段
		closeOnText(event.message);
		const stamp = (event.message as { timestamp?: number }).timestamp;
		if (hasThinking(event.message) && (stamp === undefined || state.thinkingCountedFor !== stamp)) {
			if (stamp !== undefined) state.thinkingCountedFor = stamp;
			addThinking(thinkingTextOf(event.message));
		}
		const calls = toolCallsOf(event.message);
		for (const call of calls) startCall(call.id, call.name);
		attachThinking(calls);
	});

	pi.on("tool_execution_start", async (event) => {
		startCall(event.toolCallId, event.toolName);
		// 内核可能在我们的处理器之前就建好了行，重绘一次让首条立即变成摘要
		state.invalidateByCall.get(event.toolCallId)?.();
	});

	pi.on("tool_execution_end", async (event) => {
		const run = state.runByCall.get(event.toolCallId);
		if (run) run.endedAt = Date.now();
	});

	pi.registerToolRenderer((toolName, next) => {
		const base = next();

		return {
			// self 外壳：内容为空时整行（含工具块自带的空行）都不渲染。
			// 默认外壳无论内容多少都会占一行，无法把非首条调用真正隐藏。
			renderShell: "self",

			renderCall(args, theme, context) {
				state.invalidateByCall.set(context.toolCallId, context.invalidate);
				const run = state.runByCall.get(context.toolCallId);
				if (!run) {
					// 参数还在流式输出时不要画标签，否则摘要下面会闪出一行 `Bash...`；
					// 历史导出等真正无法归段的调用才退回单条标签。
					if (context.expanded) return nativeCall(base, args, theme, context, toolName) ?? new Container();
					if (!context.argsComplete) return new Container();
					const label = new Text(theme.italic(theme.fg("thinkingText", `${labelOf(pi, toolName)}${DESIGN.toolLabelSuffix}`)), context.outputPad, 0);
					return label;
				}

				const label = new Text(theme.italic(theme.fg("thinkingText", `${labelOf(pi, toolName)}${DESIGN.toolLabelSuffix}`)), context.outputPad, 0);
				const isLeader = run.leaderCallId === context.toolCallId;
				// 首条的原生渲染也受本轮展开控制：否则收起摘要时它自己的输出会留在屏上
				const native = context.expanded && (!isLeader || run.expanded) ? nativeCall(base, args, theme, context, toolName) : undefined;

				if (isLeader) {
					// 首条：摘要行常驻，展开后依次是思考行、它自己的条目行和原生渲染
					const children: Component[] = [new TurnSummary(pi, run, theme, context.invalidate, context.outputPad)];
					// 条目行的间距由内核自带的空行提供，首条在摘要下面，补同样的空行
					if (run.expanded) {
						children.push(new Spacer(1), ...thinkingRows(context.toolCallId, theme, context.invalidate, context.outputPad), label);
					}
					if (native) children.push(native);
					return stack(children);
				}

				if (!run.expanded) return new Container();
				const thinking = thinkingRows(context.toolCallId, theme, context.invalidate, context.outputPad);
				return thinking.length === 0 ? (native ?? label) : stack([...thinking, native ?? label]);
			},

			renderResult(result, options, theme, context) {
				if (!options.expanded) return new Container();
				const run = state.runByCall.get(context.toolCallId);
				if (run && !run.expanded) return new Container();
				return nativeResult(base, result, options, theme, context, toolName) ?? textOf(result, theme, context.outputPad);
			},
		};
	});
}
