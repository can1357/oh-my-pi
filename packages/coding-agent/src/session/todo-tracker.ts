import * as path from "node:path";
import type { Agent, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model, TextContent, ToolChoice } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt, stringProperty } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import eagerTaskPrompt from "../prompts/system/eager-task.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import midRunTodoNudgePrompt from "../prompts/system/mid-run-todo-nudge.md" with { type: "text" };
import todoCompletionReminderPrompt from "../prompts/system/todo-completion-reminder.md" with { type: "text" };
import { resolveLeadingCdChain } from "../tools/shell-tokenize";
import { resolveToCwd } from "../tools/path-utils";
import { getLatestTodoPhasesFromEntries, isTodoPhase, type TodoItem, type TodoPhase } from "../tools/todo";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { AgentSessionEvent } from "./agent-session-events";
import type { SessionManager } from "./session-manager";
import {
	isParentVerifyCwdInMergedTree,
	isTautologicalParentVerifyCommand,
	isTrivialParentVerifyEvalCode,
	MERGED_UNVERIFIED_MARKER,
} from "./settle-gates";

const PARENT_VERIFY_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	lsp: true,
};

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
/** Match default async job retention so finished-id poisoning cannot outlive reuse. */
const FINISHED_VERIFY_JOB_TTL_MS = 5 * 60 * 1000;
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

interface VerifyStartSnap {
	generation: number;
	command?: string;
	/** Eval cell source snapped at tool start (trivial expressions must not clear). */
	code?: string;
	/** Resolved bash/eval working directory when known at tool start. */
	cwd?: string;
	/**
	 * Leading `cd` was present but not safely extractable (redirects, expansion).
	 * The shell still changes directory — never treat session/structured cwd as verify.
	 */
	bashCwdUnresolvable?: boolean;
	/**
	 * LSP diagnostics target snapped at tool start (`*` = workspace-wide).
	 * Absolute or cwd-resolved; outside the merged tree must not clear the latch.
	 */
	lspFile?: string;
}

/** Capabilities the todo tracker borrows from its owning session. */
export interface TodoTrackerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	agentKind(): "main" | "sub";
	/** Session working directory — parent bash verify must run inside this tree. */
	cwd(): string;
	/** Optional git/jj repo root when it differs from {@link cwd}. */
	repoRoot?(): string | undefined;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: { source: string; generation?: number }): void;
	promptGeneration(): number;
	hasPendingAsyncWake(): boolean;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	toolRegistry(): Map<string, AgentTool>;
	planModeEnabled(): boolean;
	consumeLastServedToolChoiceLabel(): string | undefined;
	hasUnverifiedMerge?(): boolean;
	unverifiedMergeGeneration?(): number;
	clearUnverifiedMergeIfGeneration?(generationAtStart: number): void;
}

/** Owns canonical todo state, eager preludes, and completion reminders. */
export class TodoTracker {
	readonly #host: TodoTrackerHost;
	#phases: TodoPhase[] = [];
	#reminderCount = 0;
	#reminderAwaitingProgress = false;
	#mutationsSinceLastTouch = 0;
	#midRunNudgeCount = 0;
	/** Merge generation (and bash command) observed when a parent-verify tool started. */
	readonly #verifyStart = new Map<string, VerifyStartSnap>();
	/**
	 * Tool-call ids for bash/eval verify snaps that have not yet received a
	 * running-ack re-key (or a sync terminal). Early async terminals may only
	 * be stashed while this set is non-empty — a job-keyed snap waiting for its
	 * own terminal must not authorize stashing unrelated job ids.
	 */
	readonly #awaitingJobRekeys = new Set<string>();
	/**
	 * Job ids whose verify terminal was already applied (or deliberately
	 * skipped). Blocks duplicate hub deliveries from being stashed under a
	 * reused id while another tool call still awaits re-key. Entries expire
	 * after {@link FINISHED_VERIFY_JOB_TTL_MS} so post-retention id reuse can
	 * race early again.
	 */
	readonly #finishedVerifyJobIds = new Map<string, number>();
	/**
	 * Async job terminals that arrived before the toolResult re-keyed the verify
	 * snap under the job id (delivery race). Keyed by the sole tool-call still
	 * awaiting re-key when possible; otherwise by job id when multiple awaits
	 * are in flight. Applied on re-key only when the job id matches.
	 */
	readonly #earlyAsyncTerminals = new Map<
		string,
		{
			jobId: string;
			jobType: string | undefined;
			status: "running" | "completed" | "failed" | "cancelled" | undefined;
		}
	>();

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
	}

	/** Rehydrates todo phases from the current transcript branch. */
	syncFromBranch(): void {
		this.setPhases(getLatestTodoPhasesFromEntries(this.#host.sessionManager.getBranch()));
	}

	/** Returns a defensive clone suitable for snapshots and branch state. */
	clonePhases(phases: TodoPhase[]): TodoPhase[] {
		return this.#clonePhases(phases);
	}

	/** Resets per-prompt reminder and mutation budgets. */
	resetCycle(): void {
		this.#reminderCount = 0;
		this.#reminderAwaitingProgress = false;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount = 0;
	}

	/** Drop verify-start snapshots owned by the previous logical session. */
	resetVerifyState(): void {
		this.#verifyStart.clear();
		this.#awaitingJobRekeys.clear();
		this.#finishedVerifyJobIds.clear();
		this.#earlyAsyncTerminals.clear();
	}

	/** Snapshots the merge generation when a parent-verify tool begins executing. */
	onToolExecutionStart(toolName: string, toolCallId: string, args?: unknown): void {
		if (!PARENT_VERIFY_TOOLS[toolName] || !toolCallId) return;
		const command =
			toolName === "bash" && isRecord(args) && typeof args.command === "string" ? args.command : undefined;
		const code = toolName === "eval" && isRecord(args) && typeof args.code === "string" ? args.code : undefined;
		const bashCwd =
			toolName === "bash"
				? this.#resolveBashStartCwd(args)
				: toolName === "eval"
					? { cwd: this.#resolveEvalStartCwd(args) }
					: {};
		const lspFile = toolName === "lsp" ? this.#resolveLspDiagnosticsTarget(args) : undefined;
		this.#verifyStart.set(toolCallId, {
			generation: this.#host.unverifiedMergeGeneration?.() ?? 0,
			command,
			code,
			cwd: bashCwd.cwd,
			bashCwdUnresolvable: bashCwd.unresolvable,
			lspFile,
		});
		// Bash/eval may auto-background; track until running-ack re-keys or sync settles.
		if (toolName === "bash" || toolName === "eval") {
			this.#awaitingJobRekeys.add(toolCallId);
		}
	}

	/**
	 * Resolve bash cwd the same way the bash tool does: structured `cwd`, else a
	 * leading `cd <path> &&|; …` chain (last target wins). When both are present,
	 * the leading `cd` chain wins — `BashTool` leaves that prefix for the shell
	 * whenever `cwd` is set, so `{ cwd: "/repo", command: "cd /tmp && bun test" }`
	 * actually runs in `/tmp`. Unextractable leading `cd` (redirects/expansion)
	 * marks the snap unresolvable. Paths go through {@link resolveToCwd} so `~` expands.
	 */
	#resolveBashStartCwd(args: unknown): { cwd?: string; unresolvable?: boolean } {
		if (!isRecord(args)) return {};
		if (typeof args.command === "string") {
			const chain = resolveLeadingCdChain(args.command);
			if (chain.unresolvable) return { unresolvable: true };
			if (chain.path !== undefined) {
				// Relative `cd` targets are relative to the process cwd the bash tool
				// sets first (structured `cwd`, else session cwd) — e.g.
				// `{ cwd: "/tmp", command: "cd project && …" }` runs in `/tmp/project`.
				const processCwd =
					typeof args.cwd === "string" && args.cwd.trim() !== ""
						? resolveToCwd(args.cwd.trim(), this.#host.cwd())
						: this.#host.cwd();
				return { cwd: resolveToCwd(chain.path, processCwd) };
			}
		}
		if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
			return { cwd: resolveToCwd(args.cwd.trim(), this.#host.cwd()) };
		}
		return {};
	}

	/**
	 * Eval runs in the session cwd (no structured cwd on the tool). Use an
	 * explicit arg when present; otherwise the host cwd where the cell executed.
	 */
	#resolveEvalStartCwd(args: unknown): string {
		if (isRecord(args) && typeof args.cwd === "string" && args.cwd.trim() !== "") {
			return resolveToCwd(args.cwd.trim(), this.#host.cwd());
		}
		return this.#host.cwd();
	}

	/** Resolve LSP diagnostics `file` (`*` stays workspace-wide; else cwd-resolved). */
	#resolveLspDiagnosticsTarget(args: unknown): string | undefined {
		if (!isRecord(args) || typeof args.file !== "string") return undefined;
		const file = args.file.trim();
		if (file === "") return undefined;
		if (file === "*") return "*";
		return resolveToCwd(file, this.#host.cwd());
	}

	/** Records a completed tool result before asynchronous event processing begins. */
	onToolResult(toolName: string, isError: boolean, details?: Record<string, unknown>, toolCallId?: string): void {
		if (toolName === "todo") {
			this.#mutationsSinceLastTouch = 0;
		} else if (!isError && MUTATING_TOOLS[toolName]) {
			this.#mutationsSinceLastTouch++;
		}
		const start = toolCallId ? this.#verifyStart.get(toolCallId) : undefined;
		const detailCwd = typeof details?.cwd === "string" ? details.cwd : undefined;
		const detailLspFile = this.#resolveLspDiagnosticsTarget(lspDiagnosticsRequestFromDetails(details));
		const evalCode = toolName === "eval" ? (start?.code ?? evalCodeFromDetails(details)) : undefined;
		// Prefer the start snap for bash cwd: result `details.cwd` echoes the structured
		// cwd arg and can hide a leading `cd /tmp && …` that actually ran out of tree.
		const verifyCwd = toolName === "bash" ? (start?.cwd ?? detailCwd) : (detailCwd ?? start?.cwd);
		if (
			PARENT_VERIFY_TOOLS[toolName] &&
			!(toolName === "bash" && start?.bashCwdUnresolvable) &&
			this.#isSuccessfulParentVerify(
				toolName,
				isError,
				details,
				start?.command,
				verifyCwd,
				start?.lspFile ?? detailLspFile,
				evalCode,
			)
		) {
			// Prefer the generation snapped at tool start. Missing start (tests /
			// missed event) falls back to the current generation so a post-start
			// verify still clears, while a start-before-merge snap of 0 never clears.
			const generationAtStart =
				start?.generation ?? (toolCallId ? 0 : (this.#host.unverifiedMergeGeneration?.() ?? 0));
			if (toolCallId) {
				this.#verifyStart.delete(toolCallId);
				this.#awaitingJobRekeys.delete(toolCallId);
				this.#earlyAsyncTerminals.delete(toolCallId);
			}
			if (generationAtStart > 0) {
				this.#host.clearUnverifiedMergeIfGeneration?.(generationAtStart);
			}
		} else if (toolCallId) {
			// Auto-backgrounded bash/eval: the initial toolResult is only a
			// "running" ack. Terminal completion arrives later via
			// `#deliverAsyncJobResult` as an async-result follow-up — re-key the
			// snapshotted generation under the job id so that path can clear.
			const asyncMeta = isRecord(details?.async) ? details.async : undefined;
			const asyncState = asyncMeta ? stringProperty(asyncMeta, "state") : undefined;
			const jobId = asyncMeta ? stringProperty(asyncMeta, "jobId") : undefined;
			if (asyncState === "running" && jobId) {
				const snapped = this.#verifyStart.get(toolCallId);
				this.#verifyStart.delete(toolCallId);
				this.#awaitingJobRekeys.delete(toolCallId);
				if (snapped !== undefined) {
					// Prefer the start snap's cwd (includes leading `cd` resolution).
					// Running-ack `details.cwd` echoes the structured cwd arg and can
					// overwrite an out-of-tree start snap (async `{ cwd: /repo, command: "cd /tmp && …" }`).
					const withCwd =
						snapped.cwd === undefined &&
						!snapped.bashCwdUnresolvable &&
						detailCwd !== undefined &&
						detailCwd.trim() !== ""
							? { ...snapped, cwd: path.resolve(detailCwd) }
							: snapped;
					// New incarnation of this job id — allow a fresh early terminal.
					this.#finishedVerifyJobIds.delete(jobId);
					const early =
						this.#takeEarlyAsyncTerminal(toolCallId, jobId) ??
						this.#takeEarlyAsyncTerminal(jobId, jobId);
					if (early !== undefined) {
						this.#markFinishedVerifyJob(jobId);
						this.#applyAsyncVerifyClear(withCwd, early.jobType, early.status);
					} else {
						this.#verifyStart.set(jobId, withCwd);
					}
				}
			} else {
				this.#verifyStart.delete(toolCallId);
				this.#awaitingJobRekeys.delete(toolCallId);
				this.#earlyAsyncTerminals.delete(toolCallId);
			}
		}
		this.#reminderAwaitingProgress = false;
	}

	/**
	 * Clears an unverified-merge latch when a background bash/eval job finishes
	 * successfully. Called from async-result delivery — not another toolResult.
	 */
	onAsyncJobTerminal(
		jobId: string,
		jobType: string | undefined,
		status: "running" | "completed" | "failed" | "cancelled" | undefined,
	): void {
		const start = this.#verifyStart.get(jobId);
		if (start === undefined) {
			// Terminal beat the toolResult re-key — stash until re-key applies it.
			if (jobType !== "bash" && jobType !== "eval") return;
			if (this.#awaitingJobRekeys.size === 0) return;
			if (this.#isFinishedVerifyJob(jobId) && this.#awaitingJobRekeys.size !== 1) {
				// Multi-await: refuse finished ids so a hub redelivery cannot sit
				// under `bg_N` for a later reuse. Sole-await uses tool-call
				// correlation below and checks jobId on re-key instead.
				return;
			}
			if (this.#awaitingJobRekeys.size === 1) {
				// Unique pending ack — bind to that tool call; re-key checks jobId.
				const toolCallId = this.#awaitingJobRekeys.values().next().value;
				if (toolCallId !== undefined && !this.#earlyAsyncTerminals.has(toolCallId)) {
					this.#earlyAsyncTerminals.set(toolCallId, { jobId, jobType, status });
				}
				return;
			}
			// Multiple awaits: stash by job id only when not already finished.
			if (!this.#isFinishedVerifyJob(jobId) && !this.#earlyAsyncTerminals.has(jobId)) {
				this.#earlyAsyncTerminals.set(jobId, { jobId, jobType, status });
			}
			return;
		}
		this.#verifyStart.delete(jobId);
		this.#markFinishedVerifyJob(jobId);
		this.#earlyAsyncTerminals.delete(jobId);
		this.#applyAsyncVerifyClear(start, jobType, status);
	}

	#takeEarlyAsyncTerminal(
		key: string,
		expectedJobId: string,
	):
		| {
				jobId: string;
				jobType: string | undefined;
				status: "running" | "completed" | "failed" | "cancelled" | undefined;
		  }
		| undefined {
		const early = this.#earlyAsyncTerminals.get(key);
		if (early === undefined) return undefined;
		this.#earlyAsyncTerminals.delete(key);
		if (early.jobId !== expectedJobId) return undefined;
		return early;
	}

	#isFinishedVerifyJob(jobId: string): boolean {
		const at = this.#finishedVerifyJobIds.get(jobId);
		if (at === undefined) return false;
		if (Date.now() - at > FINISHED_VERIFY_JOB_TTL_MS) {
			this.#finishedVerifyJobIds.delete(jobId);
			return false;
		}
		return true;
	}

	#markFinishedVerifyJob(jobId: string): void {
		this.#finishedVerifyJobIds.set(jobId, Date.now());
	}

	#applyAsyncVerifyClear(
		start: VerifyStartSnap,
		jobType: string | undefined,
		status: "running" | "completed" | "failed" | "cancelled" | undefined,
	): void {
		if (start.generation <= 0) return;
		if (jobType === "bash" && start.bashCwdUnresolvable) {
			return;
		}
		if (jobType === "bash" && start.command !== undefined && isTautologicalParentVerifyCommand(start.command)) {
			return;
		}
		if (jobType === "bash" && !isParentVerifyCwdInMergedTree(start.cwd, this.#host.cwd(), this.#host.repoRoot?.())) {
			return;
		}
		if (jobType === "eval") {
			if (start.cwd === undefined || start.cwd.trim() === "") return;
			if (!isParentVerifyCwdInMergedTree(start.cwd, this.#host.cwd(), this.#host.repoRoot?.())) {
				return;
			}
			if (isTrivialParentVerifyEvalCode(start.code)) return;
		}
		if ((jobType === "bash" || jobType === "eval") && status === "completed") {
			this.#host.clearUnverifiedMergeIfGeneration?.(start.generation);
		}
	}

	#isSuccessfulParentVerify(
		toolName: string,
		isError: boolean,
		details: Record<string, unknown> | undefined,
		command?: string,
		cwd?: string,
		lspFile?: string,
		evalCode?: string,
	): boolean {
		if (isError) return false;
		// Background bash/eval: the initial toolResult is not a completed check.
		const asyncState = isRecord(details?.async) ? stringProperty(details.async, "state") : undefined;
		if (asyncState === "running") return false;
		if (toolName === "bash" && command !== undefined && isTautologicalParentVerifyCommand(command)) {
			return false;
		}
		if (toolName === "bash" && !isParentVerifyCwdInMergedTree(cwd, this.#host.cwd(), this.#host.repoRoot?.())) {
			return false;
		}
		// Eval runs in the session cwd. Require non-trivial source so `1+1` cannot
		// clear the latch; cwd defaults to the host tree where the cell executed.
		if (toolName === "eval") {
			if (cwd === undefined || cwd.trim() === "") return false;
			if (!isParentVerifyCwdInMergedTree(cwd, this.#host.cwd(), this.#host.repoRoot?.())) {
				return false;
			}
			if (isTrivialParentVerifyEvalCode(evalCode)) return false;
			return true;
		}
		if (toolName === "lsp") {
			const action = typeof details?.action === "string" ? details.action : undefined;
			if (action !== "diagnostics") return false;
			if (details?.success !== true) return false;
			// Require an explicit clean count — missing means the tool did not
			// report diagnostics (e.g. workspace path before the field existed).
			if (typeof details.diagnosticErrorCount !== "number" || details.diagnosticErrorCount !== 0) {
				return false;
			}
			// Partial LS failures must not clear the latch even when success:true.
			const failedServers = typeof details.failedServerCount === "number" ? details.failedServerCount : 0;
			if (failedServers !== 0) return false;
			// Same spirit as bash cwd-in-tree: `/tmp/clean.ts` must not clear.
			// Workspace-wide `*` is in-tree by definition.
			if (lspFile !== undefined && lspFile !== "*") {
				if (!isParentVerifyCwdInMergedTree(lspFile, this.#host.cwd(), this.#host.repoRoot?.())) {
					return false;
				}
			}
			return true;
		}
		return true;
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
		// The unverified-merge gate is an acceptance latch, not a todo nudge: it
		// must fire even when a prior reminder is still awaiting progress, the
		// reminder budget is exhausted, or the terminal turn follows a user-forced
		// task — otherwise the session would settle while the merge remains unverified.
		// If the parent has no bash/eval/lsp among active tools (SDK restrictToolNames,
		// disabled builtins), nothing can clear the latch — settle rather than loop.
		const latched = this.#host.hasUnverifiedMerge?.() === true;
		const activeTools = this.#host.getActiveToolNames();
		const canParentVerify =
			activeTools.includes("bash") || activeTools.includes("eval") || activeTools.includes("lsp");
		if (latched && !canParentVerify) {
			logger.warn("Unverified merge latch armed but no parent verify tools are active; settling without gate", {
				activeToolNames: activeTools,
			});
		}
		const unverifiedMerge = latched && canParentVerify;
		// user-force suppresses todo reminders only; an armed merge latch still gates settle.
		if (this.#host.consumeLastServedToolChoiceLabel() === "user-force" && !unverifiedMerge) return false;
		if (this.#host.planModeEnabled()) return false;
		if (this.#reminderAwaitingProgress && !unverifiedMerge) {
			logger.debug("Todo completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#reminderCount,
			});
			return false;
		}
		const remindersMax = this.#host.settings.get("todo.remindersMax");
		if (this.#reminderCount >= remindersMax && !unverifiedMerge) {
			logger.debug("Todo completion: max reminders reached", { count: this.#reminderCount });
			return false;
		}
		// Must fire even when todo.reminders/todo.enabled are off, or disabling
		// reminders would silently disable merge verification. Only the
		// todo-driven reminder path below consults the todo settings.
		if (
			!unverifiedMerge &&
			(!this.#host.settings.get("todo.reminders") || !this.#host.settings.get("todo.enabled"))
		) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const phases = this.phases;
		if (phases.length === 0 && !unverifiedMerge) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" | "abandoned" } =>
							task.status === "pending" ||
							task.status === "in_progress" ||
							// Model-abandoned work is still incomplete; a user `/todo drop`
							// stamps `droppedBy: "user"` and is an explicit cancel.
							(task.status === "abandoned" && task.droppedBy !== "user"),
					)
					.map(task => ({ content: task.content, status: task.status })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0 && !unverifiedMerge) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return false;
		}
		// Awaiting-user skips ordinary todo reminders only — an armed merge latch
		// must still require parent verify (questions must not settle unverified).
		if (isAwaitingUserAnswer(message) && !unverifiedMerge) {
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
			.map(
				phase =>
					`- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}${task.status === "abandoned" ? " (dropped)" : ""}`).join("\n")}`,
			)
			.join("\n");
		const reminder = prompt.render(todoCompletionReminderPrompt, {
			incompleteCount: incomplete.length,
			todoList,
			unverifiedMerge,
			unverifiedMarker: MERGED_UNVERIFIED_MARKER,
			attempt: this.#reminderCount,
			remindersMax,
		});
		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#reminderCount,
		});
		await this.#host.emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#reminderCount,
			maxAttempts: remindersMax,
			unverifiedMerge: unverifiedMerge || undefined,
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
			tasks: phase.tasks.map(task => {
				const cloned: TodoItem = { content: task.content, status: task.status };
				if (task.blocker !== undefined) cloned.blocker = task.blocker;
				if (task.droppedBy === "user") cloned.droppedBy = "user";
				return cloned;
			}),
		}));
	}
}

/** LSP `request` payload from tool details — used when start-args snap was missed. */
function lspDiagnosticsRequestFromDetails(details: Record<string, unknown> | undefined): unknown {
	if (typeof details?.file === "string") return { file: details.file };
	return isRecord(details?.request) ? details.request : undefined;
}

/** Eval source from tool details when the start-args snap was missed. */
function evalCodeFromDetails(details: Record<string, unknown> | undefined): string | undefined {
	if (typeof details?.code === "string") return details.code;
	const cells = details?.cells;
	if (!Array.isArray(cells) || cells.length === 0) return undefined;
	const parts: string[] = [];
	for (const cell of cells) {
		if (isRecord(cell) && typeof cell.code === "string") parts.push(cell.code);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
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
