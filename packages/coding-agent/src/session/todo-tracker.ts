import type { Agent, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model, TextContent, ToolChoice } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt, stringProperty, truncate } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import eagerTaskPrompt from "../prompts/system/eager-task.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import midRunTodoNudgePrompt from "../prompts/system/mid-run-todo-nudge.md" with { type: "text" };
import todoStatePrompt from "../prompts/system/todo-state.md" with { type: "text" };
import {
	formatTodoSummary,
	getLatestTodoPhasesFromEntries,
	getLatestTodoSnapshotFromEntries,
	isTodoPhase,
	phasesToMarkdown,
	readTodoResultDetails,
	type TodoItem,
	type TodoPhase,
	type TodoStatus,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../tools/todo";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { AgentSessionEvent } from "./agent-session-events";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

const MID_RUN_NUDGE_MUTATION_THRESHOLD = 12;
const MID_RUN_NUDGE_MAX_PER_CYCLE = 2;
const MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};
const MID_RUN_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";
const TODO_STATE_MESSAGE_TYPE = "todo-state";
const TODO_STATE_MAX_PHASES = 12;
const TODO_STATE_MAX_TASKS = 24;
const TODO_STATE_MAX_LABEL_CHARS = 240;
const TODO_STATE_OPEN_STATUSES = ["in_progress", "blocked", "pending"] as const;
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
/**
 * A trailing question mark is the universal signal that a line is a question, but
 * the English word/pronoun gates above exist to filter incidental "?" out of prose
 * (e.g. a TypeScript `foo?: string` tail). Non-English text has no cheap word list,
 * yet any non-ASCII character in a "?"/"？"-terminated line reliably marks it as
 * genuine prose — CJK/Japanese/Korean, Spanish `¿…?`, accented Latin — so treat it
 * as a real user-directed question. Fixes non-Latin prompts going undetected (#7803).
 */
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

/** Capabilities the todo tracker borrows from its owning session. */
export interface TodoTrackerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	agentKind(): "main" | "sub";
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: { source: string; generation?: number }): void;
	promptGeneration(): number;
	hasPendingAsyncWake(): boolean;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	toolRegistry(): Map<string, AgentTool>;
	planModeEnabled(): boolean;
	/** Whether prewalk will hand off after its plan nudge owns todo creation. */
	prewalkWillHandoff(): boolean;
	consumeLastServedToolChoiceLabel(): string | undefined;
}

/** Owns canonical todo state, eager preludes, and completion reminders. */
export class TodoTracker {
	readonly #host: TodoTrackerHost;
	#phases: TodoPhase[] = [];
	#revision = 0;
	#completionBoundaryId: string | null = null;
	#reminderCount = 0;
	#reminderAwaitingProgress = false;
	#mutationsSinceLastTouch = 0;
	#midRunNudgeCount = 0;

	constructor(host: TodoTrackerHost) {
		this.#host = host;
	}

	/** Returns a defensive clone of the current todo phases. */
	get phases(): TodoPhase[] {
		return this.#clonePhases(this.#phases);
	}

	/** Replaces todo phases with a defensive clone. */
	setPhases(phases: TodoPhase[]): void {
		this.#phases = this.#clonePhases(phases);
		this.invalidateCompletions();
	}

	/** Rehydrates todo phases from the current transcript branch. */
	syncFromBranch(): void {
		this.#phases = getLatestTodoPhasesFromEntries(this.#host.sessionManager.getBranch());
		this.invalidateCompletions();
	}

	/** Invalidate child acceptance across a context clear without changing todo state. */
	invalidateCompletions(): void {
		this.#revision++;
		this.#completionBoundaryId = this.#host.sessionManager.getLeafId();
	}

	/** Returns a defensive clone suitable for snapshots and branch state. */
	clonePhases(phases: TodoPhase[]): TodoPhase[] {
		return this.#clonePhases(phases);
	}

	/**
	 * Bind one exact, unambiguous open task to an observed child run. Any external
	 * todo edit or branch restore invalidates the binding; a later child success
	 * must never overwrite a newer plan, an intentional clear, or a blocker.
	 */
	captureCompletion(content: string, parentToolCallId: string): (() => boolean) | undefined {
		const entries = this.#host.sessionManager.getBranch();
		let ownsCall = false;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			// A delayed start notification from before the latest edit/restore
			// cannot bind to an identically named item in a replacement plan.
			if (entry.id === this.#completionBoundaryId || entry.type === "reset_boundary") break;
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(block => block.type === "toolCall" && block.id === parentToolCallId)
			) {
				ownsCall = true;
				break;
			}
		}
		if (!ownsCall) return undefined;
		let target: { phase: number; task: number } | undefined;
		for (let phase = 0; phase < this.#phases.length; phase++) {
			for (let task = 0; task < this.#phases[phase].tasks.length; task++) {
				if (this.#phases[phase].tasks[task].content !== content) continue;
				if (target) return undefined;
				target = { phase, task };
			}
		}
		if (!target) return undefined;
		const task = this.#phases[target.phase].tasks[target.task];
		if (task.status !== "pending" && task.status !== "in_progress") return undefined;
		const revision = this.#revision;
		const sessionId = this.#host.sessionManager.getSessionId();
		const { phase: phaseIndex, task: taskIndex } = target;
		let consumed = false;
		return () => {
			if (consumed) return false;
			consumed = true;
			if (this.#revision !== revision || this.#host.sessionManager.getSessionId() !== sessionId) return false;
			const current = this.#phases[phaseIndex]?.tasks[taskIndex];
			if (!current || (current.status !== "pending" && current.status !== "in_progress")) return false;
			const next = this.phases;
			next[phaseIndex].tasks[taskIndex] = { content: current.content, status: "completed" };
			// Tool executions already journal their successful result. Only this
			// out-of-band mutation needs the existing explicit snapshot mechanism.
			this.#host.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: next });
			this.#phases = next;
			return true;
		};
	}

	/**
	 * Project at most one bounded canonical snapshot into a restored context.
	 * Never journal this derived prompt or reconstruct state from summary text.
	 */
	withRestoredContext(messages: AgentMessage[]): AgentMessage[] {
		const entries = this.#host.sessionManager.getBranch();
		const snapshot = getLatestTodoSnapshotFromEntries(entries);
		const priorReminders = messages.filter(
			message => message.role === "custom" && message.customType === TODO_STATE_MESSAGE_TYPE,
		);
		const withoutReminders =
			priorReminders.length > 0
				? messages.filter(message => message.role !== "custom" || message.customType !== TODO_STATE_MESSAGE_TYPE)
				: messages;
		// /clear deliberately removes all model context. Do not cross that boundary
		// to reintroduce old work; a later explicit todo update can establish state.
		if (
			!this.#host.settings.get("todo.enabled") ||
			!snapshot ||
			entries.findLastIndex(entry => entry.type === "reset_boundary") > entries.indexOf(snapshot.entry)
		) {
			return withoutReminders;
		}
		let summary: string | undefined;
		let markdown: string | undefined;
		const timestamp = Date.parse(snapshot.entry.timestamp);
		const source =
			snapshot.entry.type === "message" && snapshot.entry.message.role === "toolResult"
				? snapshot.entry.message
				: undefined;
		const nextEntry = entries[entries.indexOf(snapshot.entry) + 1];
		const legacyReminder =
			snapshot.entry.type === "custom" && nextEntry?.type === "message" && nextEntry.message.role === "developer"
				? nextEntry.message
				: undefined;
		for (const message of withoutReminders) {
			if (
				source &&
				message.role === "toolResult" &&
				message.toolCallId === source.toolCallId &&
				!message.isError &&
				!message.prunedAt &&
				readTodoResultDetails(message.toolName, message)
			) {
				summary ??= formatTodoSummary(snapshot.phases, []);
				if (
					message.content.some(
						block =>
							block.type === "text" &&
							(block.text === summary ||
								(snapshot.phases.length === 0 && block.text === formatTodoSummary([], [], true))),
					)
				) {
					return withoutReminders;
				}
			}
			// Retained /todo edit reminders already contain the complete checklist.
			// Do not infer state from prose or from a lossy compaction summary.
			if (
				(message.role === "custom" &&
					message.customType === USER_TODO_EDIT_CUSTOM_TYPE &&
					isRecord(message.details) &&
					message.details.todoSnapshotId === snapshot.entry.id) ||
				(message.role === "developer" && message === legacyReminder)
			) {
				markdown ??= snapshot.phases.length > 0 ? phasesToMarkdown(snapshot.phases).trimEnd() : "(empty)";
				const checklist = markdown;
				if (
					typeof message.content === "string"
						? message.content.includes(checklist)
						: message.content.some(block => block.type === "text" && block.text.includes(checklist))
				)
					return withoutReminders;
			}
		}
		const reminder = this.#buildStateReminder(snapshot.phases, snapshot.entry.id, timestamp);
		const previous = priorReminders.length === 1 ? priorReminders[0] : undefined;
		if (
			previous?.role === "custom" &&
			previous.content === reminder.content &&
			isRecord(previous.details) &&
			previous.details.todoSnapshotId === snapshot.entry.id
		) {
			return messages;
		}
		return [...withoutReminders, reminder];
	}

	#buildStateReminder(phases: TodoPhase[], entryId: string, timestamp: number): CustomMessage {
		const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, blocked: 0, completed: 0, abandoned: 0 };
		const phaseSummaries = phases.map((phase, index) => {
			const phaseCounts: Record<TodoStatus, number> = {
				pending: 0,
				in_progress: 0,
				blocked: 0,
				completed: 0,
				abandoned: 0,
			};
			for (const task of phase.tasks) {
				counts[task.status]++;
				phaseCounts[task.status]++;
			}
			return {
				index,
				name: truncate(phase.name, TODO_STATE_MAX_LABEL_CHARS),
				inProgress: phaseCounts.in_progress,
				pending: phaseCounts.pending,
				blocked: phaseCounts.blocked,
				completed: phaseCounts.completed,
				abandoned: phaseCounts.abandoned,
				rank: phaseCounts.in_progress > 0 ? 0 : phaseCounts.blocked > 0 ? 1 : phaseCounts.pending > 0 ? 2 : 3,
				tasks: [] as TodoItem[],
				omitted: phaseCounts.in_progress + phaseCounts.pending + phaseCounts.blocked,
			};
		});
		// Prefer current and blocked work over old closed phases, but present the
		// selected phases in canonical order so the reminder never renumbers work.
		const selected = phaseSummaries
			.sort((a, b) => a.rank - b.rank || a.index - b.index)
			.slice(0, TODO_STATE_MAX_PHASES)
			.sort((a, b) => a.index - b.index);
		let remaining = TODO_STATE_MAX_TASKS;
		for (const status of TODO_STATE_OPEN_STATUSES) {
			for (const phase of selected) {
				for (const task of phases[phase.index].tasks) {
					if (remaining === 0) break;
					if (task.status !== status) continue;
					phase.tasks.push({
						content: truncate(task.content, TODO_STATE_MAX_LABEL_CHARS),
						status,
						...(status === "blocked" && task.blocker !== undefined
							? { blocker: truncate(task.blocker, TODO_STATE_MAX_LABEL_CHARS) }
							: {}),
					});
					phase.omitted--;
					remaining--;
				}
			}
		}
		return {
			role: "custom",
			customType: TODO_STATE_MESSAGE_TYPE,
			content: prompt.render(todoStatePrompt, {
				counts,
				phases: selected,
				empty: phases.every(phase => phase.tasks.length === 0),
				omittedPhases: phases.length - selected.length,
				toolRefs: this.#buildEagerPreludeContext().toolRefs,
			}),
			details: { todoSnapshotId: entryId },
			display: false,
			attribution: "agent",
			timestamp,
		};
	}

	/** Resets per-prompt reminder and mutation budgets. */
	resetCycle(): void {
		this.#reminderCount = 0;
		this.#reminderAwaitingProgress = false;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount = 0;
	}

	/** Records a completed tool result before asynchronous event processing begins. */
	onToolResult(toolName: string, isError: boolean): void {
		if (toolName === "todo") {
			this.#mutationsSinceLastTouch = 0;
		} else if (!isError && MUTATING_TOOLS[toolName]) {
			this.#mutationsSinceLastTouch++;
		}
		this.#reminderAwaitingProgress = false;
	}

	/** Detects whether a successful todo result came from an init operation. */
	onTodoResultDetails(details: Record<string, unknown>, toolCallId: string | undefined): boolean {
		const phases = details.phases;
		if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return false;
		const detailOp = stringProperty(details, "op");
		if (detailOp) return detailOp === "init";
		if (!toolCallId) return false;
		for (let index = this.#host.agent.state.messages.length - 1; index >= 0; index--) {
			const message = this.#host.agent.state.messages[index];
			if (!message) continue;
			const op = toolCallOpFromMessage(message, toolCallId);
			if (op) return op === "init";
		}
		return false;
	}

	/** Builds the first-turn eager todo prelude and optional forced tool choice. */
	createEagerTodoPrelude(
		promptText: string | undefined,
	): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const mode = this.#host.settings.get("todo.eager");
		if (mode === "default" || !this.#host.settings.get("todo.enabled")) return undefined;
		if (this.#host.planModeEnabled() || this.#phases.length > 0) return undefined;
		// A cleared list is still an accepted snapshot, not permission to recreate it.
		if (getLatestTodoSnapshotFromEntries(this.#host.sessionManager.getBranch())) return undefined;
		// An actionable prewalk drives todo creation in a plan-first-then-todo order;
		// the forced eager prelude's "call todo first this turn" contradicts it (#10510).
		if (this.#host.prewalkWillHandoff()) return undefined;
		if (promptText !== undefined) {
			if (this.#host.agent.state.messages.some(message => message.role === "user")) return undefined;
			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) return undefined;
		}
		const activeToolNames = this.#host.getActiveToolNames();
		if (!activeToolNames.includes("todo")) {
			logger.warn("Eager todo enforcement skipped because todo is not active", { activeToolNames });
			return undefined;
		}
		const message: AgentMessage = {
			role: "custom",
			customType: "eager-todo-prelude",
			content: prompt.render(eagerTodoPrompt, { ...this.#buildEagerPreludeContext(), forced: mode === "always" }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		if (promptText === undefined || mode === "preferred") return { message };
		const model = this.#host.model();
		const toolChoice = buildNamedToolChoice("todo", model);
		if (!toolChoice) {
			logger.warn(
				"Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice",
				{ modelApi: model?.api, modelId: model?.id },
			);
			return { message };
		}
		return { message, toolChoice };
	}

	/** Builds the first-turn eager task-delegation prelude. */
	createEagerTaskPrelude(promptText: string | undefined): AgentMessage | undefined {
		if (this.#host.settings.get("task.eager") !== "always") return undefined;
		if (this.#host.agentKind() === "sub" || this.#host.planModeEnabled()) return undefined;
		if (promptText !== undefined) {
			if (this.#host.agent.state.messages.some(message => message.role === "user")) return undefined;
			const trimmed = promptText.trimEnd();
			if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
		}
		if (!this.#host.getEnabledToolNames().includes("task")) return undefined;
		return {
			role: "custom",
			customType: "eager-task-prelude",
			content: prompt.render(eagerTaskPrompt, this.#buildEagerPreludeContext()),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** Builds reminder-only eager preludes after compaction. */
	buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const todo = this.createEagerTodoPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.createEagerTaskPrelude(undefined);
		if (task) nudges.push(task);
		return nudges;
	}

	/** Checks a terminal assistant turn and schedules continuation for incomplete todos. */
	async checkCompletion(message: AssistantMessage): Promise<boolean> {
		if (this.#host.consumeLastServedToolChoiceLabel() === "user-force") return false;
		if (this.#host.planModeEnabled()) return false;
		if (this.#reminderAwaitingProgress) {
			logger.debug("Todo completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#reminderCount,
			});
			return false;
		}
		if (!this.#host.settings.get("todo.reminders") || !this.#host.settings.get("todo.enabled")) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const remindersMax = this.#host.settings.get("todo.remindersMax");
		if (this.#reminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#reminderCount });
			return false;
		}
		const phases = this.phases;
		if (phases.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map(task => ({ content: task.content, status: task.status })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		if (isAwaitingUserAnswer(message)) {
			logger.debug("Todo completion: assistant is waiting for user input; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}
		if (this.#host.hasPendingAsyncWake()) {
			logger.debug("Todo completion: async jobs in flight will re-wake the loop; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}
		this.#reminderCount++;
		const todoList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#reminderCount}/${remindersMax})\n` +
			`</system-reminder>`;
		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#reminderCount,
		});
		await this.#host.emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#reminderCount,
			maxAttempts: remindersMax,
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.#mutationsSinceLastTouch = 0;
		this.#reminderAwaitingProgress = true;
		this.#host.agent.appendMessage(reminderMessage);
		this.#host.sessionManager.appendMessage(reminderMessage);
		this.#host.scheduleAgentContinue({
			source: "todo-reminder",
			generation: this.#host.promptGeneration(),
		});
		return true;
	}

	/** Takes the next hidden mid-run reconciliation nudge, if its budget and guards allow. */
	takeMidRunNudge(): AgentMessage | null {
		if (this.#mutationsSinceLastTouch < MID_RUN_NUDGE_MUTATION_THRESHOLD) return null;
		if (this.#midRunNudgeCount >= MID_RUN_NUDGE_MAX_PER_CYCLE) return null;
		if (!this.#host.settings.get("todo.enabled") || !this.#host.settings.get("todo.reminders")) return null;
		if (this.#host.planModeEnabled() || !this.#host.getActiveToolNames().includes("todo")) return null;
		const incomplete = this.#phases
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (incomplete.length === 0) return null;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount++;
		const { toolRefs } = this.#buildEagerPreludeContext();
		const reminder = prompt.render(midRunTodoNudgePrompt, {
			toolRefs,
			incompleteCount: incomplete.length,
			plural: incomplete.length !== 1,
		});
		logger.debug("Mid-run todo nudge fired", {
			incomplete: incomplete.length,
			nudge: this.#midRunNudgeCount,
		});
		return {
			role: "custom",
			customType: MID_RUN_NUDGE_MESSAGE_TYPE,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildEagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		const wireName = (name: string): string => {
			const tool = this.#host.toolRegistry().get(name);
			return typeof tool?.customWireName === "string" ? tool.customWireName : name;
		};
		return {
			toolRefs: { task: wireName("task"), todo: wireName("todo") },
			taskBatch: this.#host.settings.get("task.batch"),
		};
	}

	#clonePhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task =>
				task.blocker !== undefined
					? { content: task.content, status: task.status, blocker: task.blocker }
					: { content: task.content, status: task.status },
			),
		}));
	}
}

function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? stringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map(content => content.text)
		.join("\n")
		.trim();
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line.trim().replace(MARKDOWN_PROMPT_PREFIX_RE, "").trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	return {
		text: withoutPromptLabel,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	const lastLine = text.split(/\r?\n/).at(-1)?.trim();
	return lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine));
}
