/**
 * /goal 扩展 — 目标管理 + Autopilot 自动推进
 *
 * 用法:
 *   /goal                   列出所有目标（含任务要点）
 *   /goal add <文本>        添加目标
 *   /goal mission <文本>    设置任务要点（总纲，全局方向锚）
 *   /goal mission clear     清除任务要点
 *   /goal done <n>          手动标记完成
 *   /goal undo <n>          撤销完成
 *   /goal rm <n>            删除目标
 *   /goal clear             清空所有已完成目标
 *   /goal on|off            开/关「每轮注入未完成目标到上下文」(默认开)
 *   /goal auto              查看 autopilot 状态
 *   /goal auto on [N]       开启自动推进: 目标未完成就持续自动跑，最多 N 轮 (默认 10)
 *   /goal auto off          关闭自动推进
 *
 * Autopilot 规则:
 *   - 每轮 agent 结束后检查未完成目标，有则自动发起下一轮
 *   - agent 完成目标后调用 goal_complete 工具标记，全部完成即停止
 *   - 任务要点（mission）随每一轮注入上下文最前方，autopilot 每轮重申，防止跑偏
 *   - 安全阀: 达到最大轮数 / 连续 3 轮无进展 / 模型报错或被打断 → 自动停止
 *   - autopilot 状态不持久化，重启后默认关闭
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface Goal {
	id: number;
	text: string;
	done: boolean;
	createdAt: number;
	doneAt?: number;
}

interface GoalState {
	goals: Goal[];
	nextId: number;
	inject: boolean;
	/** 任务要点（总纲）: 原始任务的浓缩总结，全局可见，防止长会话/autopilot 跑偏 */
	mission: string;
}

interface AutopilotState {
	enabled: boolean;
	maxRounds: number;
	rounds: number;
	noProgressStreak: number;
	doneSnapshot: number;
}

const STATE_TYPE = "goal-state";
const STATUS_KEY = "goal";
const AUTOPILOT_STOP_STREAK = 3;

/** 注意: 必须用函数每次生成全新状态，浅拷贝会共享 goals 数组引用导致实例间污染 */
const createEmptyState = (): GoalState => ({ goals: [], nextId: 1, inject: true, mission: "" });
const createEmptyAutopilot = (): AutopilotState => ({
	enabled: false,
	maxRounds: 0, // 0 = 无限轮次，仅在用户显式指定轮数时限制
	rounds: 0,
	noProgressStreak: 0,
	doneSnapshot: 0,
});

/**
 * UI 组件: 目标列表 (Esc 关闭)
 */
class GoalListComponent {
	private goals: Goal[];
	private mission: string;
	private autopilot: boolean;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(goals: Goal[], mission: string, autopilot: boolean, theme: Theme, onClose: () => void) {
		this.goals = goals;
		this.mission = mission;
		this.autopilot = autopilot;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " 🎯 Goals ") + (this.autopilot ? th.fg("success", " [🚀 AUTOPILOT]") : "");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 14)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.mission) {
			lines.push(truncateToWidth(`  ${th.fg("warning", "📌 任务要点")}: ${th.fg("text", this.mission)}`, width));
			lines.push("");
		}

		if (this.goals.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "还没有目标。用 /goal add <文本> 添加一个吧。")}`, width));
		} else {
			const done = this.goals.filter((g) => g.done).length;
			const total = this.goals.length;
			const pct = Math.round((done / total) * 100);
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} 完成 · ${pct}%`)}`, width));
			lines.push("");

			for (const goal of this.goals) {
				const check = goal.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${goal.id}`);
				const text = goal.done ? th.fg("dim", goal.text) : th.fg("text", goal.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", "Esc 关闭 · /goal add <文本> 添加 · /goal done <n> 完成 · /goal auto on 自动推进")}`,
				width,
			),
		);
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// 内存状态 (从会话 entries 恢复)
	let state: GoalState = createEmptyState();
	// autopilot 运行时状态 (不持久化)
	let autopilot: AutopilotState = createEmptyAutopilot();

	const doneCount = () => state.goals.filter((g) => g.done).length;
	const remainingGoals = () => state.goals.filter((g) => !g.done);

	/** 从会话条目重建状态 (取最后一个 goal-state 条目) */
	const reconstructState = (ctx: ExtensionContext) => {
		let found: GoalState | null = null;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				found = entry.data as GoalState;
			}
		}
		state = found
			? { goals: found.goals, nextId: found.nextId, inject: found.inject, mission: found.mission ?? "" }
			: createEmptyState();
		autopilot = createEmptyAutopilot(); // 重启/换会话后 autopilot 必须关
		updateStatus(ctx);
	};

	/** 持久化状态 */
	const save = () => {
		pi.appendEntry(STATE_TYPE, {
			goals: state.goals,
			nextId: state.nextId,
			inject: state.inject,
			mission: state.mission,
		} satisfies GoalState);
	};

	/** 轮次显示: maxRounds=0 表示无限 */
	const roundsLabel = () => (autopilot.maxRounds > 0 ? `${autopilot.rounds}/${autopilot.maxRounds}` : `${autopilot.rounds}∞`);

	/** 更新底部状态栏 */
	const updateStatus = (ctx?: ExtensionContext) => {
		if (!ctx?.hasUI) return;
		const done = doneCount();
		const total = state.goals.length;
		const base =
			(total === 0 ? "🎯 无目标" : `🎯 ${done}/${total}`) + (state.mission ? " 📌" : "");
		ctx.ui.setStatus(STATUS_KEY, autopilot.enabled ? `${base} 🚀${roundsLabel()}` : base);
	};

	/** 展示目标列表 */
	const showGoals = async (ctx: ExtensionContext) => {
		if (ctx.hasUI) {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new GoalListComponent(state.goals, state.mission, autopilot.enabled, theme, () => done());
			});
		} else {
			const done = doneCount();
			const total = state.goals.length;
			const lines = state.goals.map((g) => `[${g.done ? "x" : " "}] #${g.id} ${g.text}`);
			console.log(
				`Goals (${done}/${total})${autopilot.enabled ? ` [AUTOPILOT ${roundsLabel()}]` : ""}:\n` +
					(lines.join("\n") || "  (none)"),
			);
		}
	};

	// =========================================================================
	// 核心操作函数 (命令与 agent 工具共用)
	// =========================================================================

	/** 添加目标，返回新目标 */
	const addGoal = (text: string, ctx?: ExtensionContext): Goal | null => {
		const trimmed = text.trim();
		if (!trimmed) return null;
		const goal: Goal = { id: state.nextId++, text: trimmed, done: false, createdAt: Date.now() };
		state.goals.push(goal);
		save();
		updateStatus(ctx);
		return goal;
	};

	/** 设置任务要点（总纲），空文本 = 清除 */
	const setMission = (text: string, ctx?: ExtensionContext): string => {
		const trimmed = text.trim();
		state.mission = trimmed;
		save();
		updateStatus(ctx);
		return trimmed ? `📌 任务要点已更新: ${trimmed}` : "📌 任务要点已清除";
	};

	/** 标记完成，返回 (成功?, 消息) */
	const completeGoal = (id: number, ctx?: ExtensionContext): [boolean, string] => {
		const goal = state.goals.find((g) => g.id === id);
		if (!goal) return [false, `目标 #${id} 不存在，可用编号: ${state.goals.map((g) => g.id).join(", ") || "无"}`];
		if (goal.done) return [false, `目标 #${goal.id} 已经是完成状态`];
		goal.done = true;
		goal.doneAt = Date.now();
		save();
		updateStatus(ctx);
		return [true, `✅ 目标 #${goal.id} 已标记完成（剩余 ${remainingGoals().length} 个未完成目标）`];
	};

	/** 撤销完成，返回 (成功?, 消息) */
	const undoGoal = (id: number, ctx?: ExtensionContext): [boolean, string] => {
		const goal = state.goals.find((g) => g.id === id);
		if (!goal) return [false, `目标 #${id} 不存在`];
		if (!goal.done) return [false, `目标 #${goal.id} 不是完成状态，无需撤销`];
		goal.done = false;
		goal.doneAt = undefined;
		save();
		updateStatus(ctx);
		return [true, `↩️ 目标 #${goal.id} 已恢复未完成: ${goal.text}`];
	};

	/** 删除目标 */
	const removeGoal = (id: number, ctx?: ExtensionContext): [boolean, string] => {
		const goal = state.goals.find((g) => g.id === id);
		if (!goal) return [false, `目标 #${id} 不存在`];
		state.goals = state.goals.filter((g) => g.id !== id);
		save();
		updateStatus(ctx);
		return [true, `🗑️ 目标 #${goal.id} 已删除: ${goal.text}`];
	};

	/** 清空已完成目标 */
	const clearDoneGoals = (ctx?: ExtensionContext): string => {
		const count = state.goals.filter((g) => g.done).length;
		state.goals = state.goals.filter((g) => !g.done);
		save();
		updateStatus(ctx);
		return count > 0 ? `🧹 已清空 ${count} 个已完成目标` : "没有已完成的目标";
	};

	/** 开启 autopilot (maxRounds<=0 = 无限)，立即触发第一轮 */
	const startAutopilot = async (maxRounds: number, ctx?: ExtensionContext): Promise<string> => {
		if (remainingGoals().length === 0) {
			const msg = "没有未完成目标，先添加目标";
			ctx?.ui.notify?.(msg, "error");
			return msg;
		}
		autopilot = {
			enabled: true,
			// 未指定轮数 → 0 (无限)，由完成检测/无进展检测兜底停止
			maxRounds: isNaN(maxRounds) || maxRounds < 1 ? 0 : maxRounds,
			rounds: 0,
			noProgressStreak: 0,
			doneSnapshot: doneCount(),
		};
		save();
		updateStatus(ctx);
		const msg =
			autopilot.maxRounds > 0
				? `🚀 autopilot 开启: 最多 ${autopilot.maxRounds} 轮，目标未完成将持续自动推进`
				: `🚀 autopilot 开启: 不限轮数，将一直推进到目标全部完成（连续无进展时自动停止）`;
		ctx?.ui.notify?.(msg, "info");
		// 立即触发第一轮
		await pi.sendUserMessage(buildAutopilotPrompt(), { deliverAs: "followUp" });
		return msg;
	};

	/** 关闭 autopilot */
	const stopAutopilot = (ctx?: ExtensionContext): string => {
		autopilot.enabled = false;
		updateStatus(ctx);
		return "⏹️ autopilot 已关闭";
	};

	/** 构造自动推进轮次的用户消息 */
	const buildAutopilotPrompt = (): string => {
		const remaining = remainingGoals();
		const lines = remaining.map((g) => `- [#${g.id}] ${g.text}`).join("\n");
		// 每轮自动推进都重申任务方向，防止模型在长跑中迷失
		const mission = state.mission ? `\n总任务方向（不可偏离）: ${state.mission}\n` : "";
		return (
			`[自动推进模式] ${mission}请持续推进以下未完成目标：\n${lines}\n\n规则：\n` +
			`1. 直接用工具执行达成目标所需的工作，不要只做规划。\n` +
			`2. 每完成一个目标，立即调用 goal_complete 工具标记（goalId=编号）。\n` +
			`3. 全部目标完成 → 总结汇报并停止。\n` +
			`4. 无法推进（缺关键信息 / 需要用户决策 / 反复失败）→ 说明原因并停止，禁止空转。`
		);
	};

	/** 从 agent_end 消息中统计工具调用次数 */
	const countToolCalls = (messages: unknown[]): number => {
		let n = 0;
		for (const m of messages as Array<{ role?: string; content?: Array<{ type?: string }> }>) {
			if (m.role !== "assistant") continue;
			for (const c of m.content ?? []) {
				if (c.type === "toolCall") n++;
			}
		}
		return n;
	};

	/** 从 agent_end 消息中取最后一个 assistant 消息的 stopReason */
	const lastStopReason = (messages: unknown[]): string | undefined => {
		for (let i = (messages as unknown[]).length - 1; i >= 0; i--) {
			const m = messages[i] as { role?: string; stopReason?: string };
			if (m.role === "assistant" && m.stopReason) return m.stopReason;
		}
		return undefined;
	};

	// 会话事件: 恢复状态
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// 每轮对话前: 记录快照 + 注入目标上下文
	pi.on("before_agent_start", async (event, ctx) => {
		autopilot.doneSnapshot = doneCount();
		updateStatus(ctx);
		if (!state.inject) return;
		const active = remainingGoals();
		if (active.length === 0) return;
		const lines = active.map((g) => `- [#${g.id}] ${g.text}`).join("\n");

		let extra = "";
		// 任务要点永远放在最前面: 它是方向锚，防止模型在长会话/上下文压缩/多轮 autopilot 中跑偏
		if (state.mission) {
			extra += `\n\n## 📌 任务要点（总纲，全局方向，不可偏离）\n${state.mission}\n`;
		}
		extra += `\n## 当前目标（用户用 /goal 管理）\n${lines}\n`;
		if (autopilot.enabled) {
			extra +=
				`\n[自动推进模式已开启] 本轮必须通过工具推进目标：` +
				`完成一个目标后立即调用 goal_complete 工具标记；` +
				`无法推进时说明原因并停止。`;
		} else {
			extra +=
				`\n目标仅作背景上下文，遵守以下规则：\n` +
				`- 用户请求与目标相关时，优先围绕目标推进，但完成一个目标后先汇报结果，不要未经确认连续执行下一个。\n` +
				`- 用户请求与目标无关时，按正常方式处理，不要擅自展开目标工作。\n` +
				`- 目标全部完成或用户变更目标时，提醒用户。`;
		}
		return { systemPrompt: event.systemPrompt + extra };
	});

	// 每轮 agent 结束后: autopilot 续跑判定
	pi.on("agent_end", async (event, ctx) => {
		if (!autopilot.enabled) return;
		updateStatus(ctx);

		// 安全阀 1: 模型报错 / 被用户中断 → 停止
		const stopReason = lastStopReason(event.messages);
		if (stopReason === "error" || stopReason === "abort") {
			autopilot.enabled = false;
			ctx.ui.notify(`⏹️ autopilot 停止（模型异常或被打断: ${stopReason}）`, "error");
			return;
		}

		// 安全阀 2: 全部目标完成 → 停止
		const remaining = remainingGoals();
		if (remaining.length === 0) {
			autopilot.enabled = false;
			ctx.ui.notify("🎉 所有目标已完成，autopilot 结束", "info");
			return;
		}

		// 安全阀 3: 达到最大轮数 → 停止 (仅在用户指定轮数时生效，0 = 无限)
		autopilot.rounds++;
		if (autopilot.maxRounds > 0 && autopilot.rounds >= autopilot.maxRounds) {
			autopilot.enabled = false;
			ctx.ui.notify(
				`⏹️ 达到最大轮数 ${autopilot.maxRounds}，autopilot 停止（剩余 ${remaining.length} 个目标，/goal auto on 可继续）`,
				"info",
			);
			return;
		}

		// 安全阀 4: 连续多轮无进展 → 停止
		const toolCalls = countToolCalls(event.messages);
		const progressed = toolCalls > 0 || doneCount() > autopilot.doneSnapshot;
		autopilot.noProgressStreak = progressed ? 0 : autopilot.noProgressStreak + 1;
		if (autopilot.noProgressStreak >= AUTOPILOT_STOP_STREAK) {
			autopilot.enabled = false;
			ctx.ui.notify(
				`⏹️ 连续 ${AUTOPILOT_STOP_STREAK} 轮无进展（无工具调用、无目标完成），autopilot 停止`,
				"info",
			);
			return;
		}

		// 继续推进
		ctx.ui.notify(`🔁 第 ${roundsLabel()} 轮完成，继续推进（剩余 ${remaining.length} 个目标）`, "info");
		await pi.sendUserMessage(buildAutopilotPrompt(), { deliverAs: "followUp" });
	});

	// 注册 goal_complete 工具: agent 完成目标后调用
	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description:
			"标记指定编号的目标为已完成。仅在目标真正达成时调用；autopilot 模式下每完成一个目标都必须调用。",
		promptSnippet: "Mark a numbered goal as completed",
		parameters: Type.Object({
			goalId: Type.Number({ description: "要标记完成的目标编号" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const goal = state.goals.find((g) => g.id === params.goalId);
			if (!goal) {
				return {
					content: [{ type: "text", text: `目标 #${params.goalId} 不存在，可用编号: ${state.goals.map((g) => g.id).join(", ") || "无"}` }],
					details: {},
				};
			}
			if (goal.done) {
				return {
					content: [{ type: "text", text: `目标 #${goal.id} 已经是完成状态` }],
					details: {},
				};
			}
			goal.done = true;
			goal.doneAt = Date.now();
			save();
			const remaining = remainingGoals().length;
			return {
				content: [
					{
						type: "text",
						text: `✅ 目标 #${goal.id} 已标记完成（剩余 ${remaining} 个未完成目标）`,
					},
				],
				details: {},
			};
		},
	});

	// 注册 agent 工具: 目标管理与 autopilot 控制 (agent 可直接调用，无需 TUI)
	pi.registerTool({
		name: "goal_set_mission",
		label: "Goal Set Mission",
		description:
			"设置/更新任务要点（总纲）: 把原始任务浓缩成一句话/一段话的全局方向锚，注入到每一轮上下文，防止长会话或多轮 autopilot 执行中丢方向。在拆解目标（goal_add）之前先调用。传空字符串可清除。",
		promptSnippet: "Set the global mission (task summary)",
		parameters: Type.Object({
			text: Type.String({ description: "任务要点文本（原始任务的浓缩总结）" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const msg = setMission(params.text, ctx);
			return { content: [{ type: "text", text: msg }], details: { mission: state.mission } };
		},
	});

	pi.registerTool({
		name: "goal_add",
		label: "Goal Add",
		description:
			"添加一个新目标（autopilot 将围绕未完成目标自动推进）。返回新目标编号。拆解任务前建议先调用 goal_set_mission 记录总任务要点，防止方向丢失。",
		promptSnippet: "Add a numbered goal",
		parameters: Type.Object({
			text: Type.String({ description: "目标文本，应包含明确的达成标准" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const goal = addGoal(params.text, ctx);
			if (!goal) return { content: [{ type: "text", text: "目标文本不能为空" }], details: {} };
			return { content: [{ type: "text", text: `🎯 目标 #${goal.id} 已添加: ${goal.text}` }], details: { goalId: goal.id } };
		},
	});

	pi.registerTool({
		name: "goal_list",
		label: "Goal List",
		description: "列出所有目标及完成状态（含 autopilot 运行状态）。",
		promptSnippet: "List goals",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const done = doneCount();
			const total = state.goals.length;
			const lines = state.goals.map((g) => `[${g.done ? "x" : " "}] #${g.id} ${g.text}`).join("\n") || "  (none)";
			const autopilotLine = autopilot.enabled ? `🚀 AUTOPILOT 运行中: 第 ${roundsLabel()} 轮` : "autopilot 关闭";
			const missionLine = state.mission ? `📌 任务要点: ${state.mission}\n` : "";
			return {
				content: [{ type: "text", text: `Goals (${done}/${total}) · ${autopilotLine}:\n${missionLine}${lines}` }],
				details: {
					goals: state.goals,
					mission: state.mission,
					autopilot: { enabled: autopilot.enabled, maxRounds: autopilot.maxRounds, rounds: autopilot.rounds },
				},
			};
		},
	});

	pi.registerTool({
		name: "goal_auto_on",
		label: "Goal Autopilot On",
		description:
			"开启 autopilot 自动推进：每轮 agent 结束后自动发起下一轮，直到所有目标完成。maxRounds 缺省或 <=0 = 无限轮（连续 3 轮无进展自动停）。开启后立即触发第一轮。",
		promptSnippet: "Start autopilot (unlimited rounds)",
		parameters: Type.Object({
			maxRounds: Type.Optional(Type.Number({ description: "最大轮数，缺省 = 无限" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const msg = await startAutopilot(params.maxRounds ?? 0, ctx);
			return { content: [{ type: "text", text: msg }], details: {} };
		},
	});

	pi.registerTool({
		name: "goal_auto_off",
		label: "Goal Autopilot Off",
		description: "关闭 autopilot 自动推进。",
		promptSnippet: "Stop autopilot",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: stopAutopilot(ctx) }], details: {} };
		},
	});

	pi.registerTool({
		name: "goal_undo",
		label: "Goal Undo",
		description: "撤销指定目标的完成状态。",
		promptSnippet: "Undo a completed goal",
		parameters: Type.Object({
			goalId: Type.Number({ description: "要撤销的目标编号" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const [ok, msg] = undoGoal(params.goalId, ctx);
			return { content: [{ type: "text", text: ok ? msg : `⚠️ ${msg}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "goal_rm",
		label: "Goal Remove",
		description: "删除指定目标（不会标记完成）。",
		promptSnippet: "Remove a goal",
		parameters: Type.Object({
			goalId: Type.Number({ description: "要删除的目标编号" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const [ok, msg] = removeGoal(params.goalId, ctx);
			return { content: [{ type: "text", text: ok ? msg : `⚠️ ${msg}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "goal_clear_done",
		label: "Goal Clear Done",
		description: "清空所有已完成目标（未完成保留）。",
		promptSnippet: "Clear completed goals",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: clearDoneGoals(ctx) }], details: {} };
		},
	});

	// 注册 /goal 命令 (复用核心函数)
	pi.registerCommand("goal", {
		description: "管理目标: /goal | add | done|undo|rm <n> | clear | on|off | auto [on N|off]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			const cmd = parts[0]?.toLowerCase();

			// 无参数: 列出
			if (!cmd) {
				await showGoals(ctx);
				return;
			}

			switch (cmd) {
				case "add": {
					const text = trimmed.slice(cmd.length).trim();
					if (!text) {
						ctx.ui.notify("用法: /goal add <目标文本>", "error");
						return;
					}
					const goal = addGoal(text, ctx);
					if (goal) ctx.ui.notify(`🎯 目标 #${goal.id} 已添加: ${goal.text}`, "info");
					return;
				}

				case "done":
				case "undo":
				case "rm": {
					const id = parseInt(parts[1] ?? "", 10);
					if (isNaN(id)) {
						ctx.ui.notify(`用法: /goal ${cmd} <目标编号>`, "error");
						return;
					}
					const [ok, msg] =
						cmd === "done"
							? completeGoal(id, ctx)
							: cmd === "undo"
								? undoGoal(id, ctx)
								: removeGoal(id, ctx);
					ctx.ui.notify(msg, ok ? "info" : "error");
					return;
				}

				case "clear": {
					ctx.ui.notify(clearDoneGoals(ctx), "info");
					return;
				}

				case "on":
				case "off": {
					state.inject = cmd === "on";
					save();
					ctx.ui.notify(`目标上下文注入: ${state.inject ? "✅ 开" : "⛔ 关"}`, "info");
					return;
				}

				case "mission": {
					const sub = parts[1]?.toLowerCase();
					if (sub === "clear") {
						ctx.ui.notify(setMission("", ctx), "info");
						return;
					}
					const text = trimmed.slice("mission".length).trim();
					if (!text) {
						ctx.ui.notify(
							state.mission ? `📌 当前任务要点: ${state.mission}` : "用法: /goal mission <任务要点> | /goal mission clear",
						"info",
					);
					return;
				}
				ctx.ui.notify(setMission(text, ctx), "info");
				return;
			}

				case "auto": {
					const sub = parts[1]?.toLowerCase();
					if (!sub) {
						ctx.ui.notify(
							autopilot.enabled
								? `🚀 autopilot 运行中: 第 ${roundsLabel()} 轮，剩余 ${remainingGoals().length} 个目标`
								: `autopilot 关闭。用 /goal auto on [最大轮数] 开启`,
							"info",
						);
						return;
					}
					if (sub === "on") {
						const maxRounds = parseInt(parts[2] ?? "", 10);
						await startAutopilot(isNaN(maxRounds) ? 0 : maxRounds, ctx);
						return;
					}
					if (sub === "off") {
						ctx.ui.notify(stopAutopilot(ctx), "info");
						return;
					}
					ctx.ui.notify("用法: /goal auto on [最大轮数] | /goal auto off", "error");
					return;
				}

				default:
					ctx.ui.notify(
						`未知子命令: ${cmd}\n可用: add / mission / done / undo / rm / clear / on / off / auto`,
						"error",
					);
					return;
			}
		},
	});
}
