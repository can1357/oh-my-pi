/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { once } from "node:events";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { type Theme, theme } from "../../modes/theme/theme";
import { type PlanApprovalDetails, resolveApprovedPlan } from "../../plan-mode/approved-plan";
import { listPlanFiles, readPlanFile } from "../../plan-mode/plan-files";
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { ToolError } from "../../tools/tool-errors";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcExtensionUISelectOptionDetail,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcResponse,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<RpcSkillCommandResult | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string, code?: string) => RpcResponse;
	/**
	 * Required, not optional: background commands run for minutes and are the
	 * only work `drain()` cannot see, so an embedder that forgets this silently
	 * loses all shutdown coverage for exactly the work that most needs it.
	 */
	trackBackgroundTask: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Bash commands are dispatched in the background so the caller can keep reading
 * subsequent frames while a shell command is still running. This lets a client
 * send `abort_bash` while a long-running `bash` is in flight. Response
 * correlation is preserved via each command's `id`; ordering across concurrent
 * commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on non-`bash` commands propagate; the caller is expected to wrap them.
 */
/**
 * Commands dispatched off the serial queue.
 *
 * Long-running work that must not hold the door shut against the frames meant
 * to interrupt it. Each one owes two things in return: it catches its own
 * dispatch errors, and it has a dedicated cancel command (`abort_bash`,
 * `abort_compact`).
 */
const BACKGROUND_RPC_COMMANDS = new Set<RpcCommand["type"]>(["bash", "compact"]);

export function isBackgroundRpcCommand(command: RpcCommand): boolean {
	return BACKGROUND_RPC_COMMANDS.has(command.type);
}

/**
 * Machine-readable codes for the ways a compaction can decline.
 *
 * The engine raises these as prose, and a client that wants to tell "there was
 * nothing to do" from "something broke" would otherwise have to match on the
 * sentences — which is exactly the trade this protocol has a `code` field to
 * avoid. Mapped here, at the boundary, rather than reshaping the engine's
 * errors.
 */
function compactionErrorCode(error: unknown): string | undefined {
	/*
	 * Cancellation is asked of the type, not of the prose. The others are
	 * anchored sentences the engine writes; this one used to be an unanchored
	 * `/cancel/i`, which claimed any failure whose message merely mentioned the
	 * word — a provider error about a cancelled upstream request, say — and told
	 * the client the operator had stopped it.
	 */
	if (error instanceof CompactionCancelledError) return "cancelled";

	const text = (error instanceof Error ? error.message : String(error)).trim();
	if (/^Already compacted$/i.test(text)) return "already_compacted";
	if (/^Nothing to compact\b/i.test(text)) return "nothing_to_compact";
	if (/^Compaction already in progress$/i.test(text)) return "compaction_in_progress";
	if (/^No model selected$/i.test(text)) return "no_model";
	if (/^No configured compaction method/i.test(text)) return "no_method";
	return undefined;
}

export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	/*
	 * `bash` and `compact` both run for a long time, and both are dispatched in
	 * the background so the frames that would interrupt them — `abort_bash`,
	 * `abort_compact` — can still be read and handled instead of queueing behind
	 * the very operation they are meant to stop.
	 *
	 * The try/catch is not decoration. A backgrounded command's promise has no
	 * caller to await it, so a throw from `handleCommand` becomes an unhandled
	 * rejection and takes the process down. Pressing compact twice did exactly
	 * that: the second press threw "Already compacted" — `prepareCompaction`
	 * finding nothing left to do — and the refusal had nowhere to go. (A truly
	 * concurrent second press throws "Compaction already in progress" instead;
	 * both used to be fatal.)
	 */
	if (isBackgroundRpcCommand(command)) {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				const code = command.type === "compact" ? compactionErrorCode(err) : undefined;
				deps.output(deps.errorResponse(command.id, command.type, message, code));
			}
		})();
		deps.trackBackgroundTask(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;

	constructor(options: { deps: RpcInputFrameDeps; afterSerialCommand?: () => Promise<void> }) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			/*
			 * Off the serial queue — one predicate, shared with
			 * `dispatchRpcInputFrame`, because two copies of a concurrency rule is
			 * how the next long-running command gets added to one and not the other.
			 *
			 * `bash` was always here because it is long-running and concurrent by
			 * design. `compact` joins it for a sharper reason: it runs for minutes
			 * and it is the one operation an operator most wants to be able to stop,
			 * but `abort` travels through this very queue — so a compaction handled
			 * serially holds the door shut against the command meant to interrupt
			 * it, and against the `get_state` that would show it running.
			 *
			 * Both are backgrounded inside `dispatchRpcInputFrame`, which owns the
			 * try/catch they need: nothing here awaits the task, so an escaping
			 * rejection would have no handler at all.
			 *
			 * The response contract does not change: it still resolves with the
			 * `CompactionResult` when the work is done.
			 */
			if (isBackgroundRpcCommand(command)) {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, tool.loadMode),
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

/**
 * Sends an RPC select request while retaining aligned option descriptions.
 *
 * `extra` rides on the frame untouched. It exists for the one caller that has
 * something to show alongside the choices — a plan review, where approving
 * without seeing the plan is not a decision — and stays out of
 * `ExtensionUIContext`, whose `select` is implemented by the TUI and ACP too and
 * needs none of this.
 */
export function requestRpcSelect(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
	extra?: { message?: string; planFilePath?: string },
): Promise<string | undefined> {
	const labels = new Array<string>(options.length);
	let optionDetails: RpcExtensionUISelectOptionDetail[] | undefined;
	for (let index = 0; index < options.length; index++) {
		const option = options[index]!;
		labels[index] = getExtensionUISelectOptionLabel(option);
		if (typeof option === "string") continue;
		const description = option.description?.trim();
		if (!description) continue;
		optionDetails ??= Array.from({ length: options.length }, () => ({}));
		optionDetails[index] = { description };
	}

	return requestRpcDialog(
		pendingRequests,
		output,
		dialogOptions,
		undefined,
		{
			method: "select",
			title,
			options: labels,
			...(optionDetails ? { optionDetails } : {}),
			...(extra?.message ? { message: extra.message } : {}),
			...(extra?.planFilePath ? { planFilePath: extra.planFilePath } : {}),
			timeout: dialogOptions?.timeout,
		},
		response => parseValueDialogResponse(response, dialogOptions),
	);
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/** Sends an RPC extension dialog and cancels the remote presentation when its signal aborts. */
export function requestRpcDialog<T>(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		opts?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			resolve(parseResponse(response));
		},
		reject,
	});
	output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}

/** The part of {@link AgentSession} that leaving plan mode touches. */
export interface RpcPlanModeExitTarget {
	readonly isStreaming: boolean;
	abort(options?: { reason?: string }): Promise<void>;
	runModeExitTeardown(teardown: () => Promise<void>): Promise<void>;
	setPlanMode(enabled: boolean, options?: { restoreTools?: string[] }): Promise<string[]>;
}

/**
 * Leave plan mode, stopping the turn still running under the plan-mode toolset
 * when the exit is the user deciding to stop planning.
 *
 * Not every exit is. Approving a plan leaves plan mode from inside the very
 * turn that wrote to `xd://propose`, so an abort there kills the execution the
 * approval exists to start. Both RPC exits share one door on purpose —
 * `planPreviousTools` used to be cleared by one and left behind by the other,
 * and the next enable read the leftover as a re-entry — so the door itself has
 * to carry the difference. The terminal splits the same way: its `/plan`
 * toggle exits with `interruptActiveTurn`, `#approvePlan` without it.
 *
 * The abort sits inside `runModeExitTeardown` for the reason the interactive
 * path gives: a steer queued behind the aborted turn would otherwise start a
 * fresh run while the plan-mode tools are still live, and then have them
 * removed underneath it.
 */
export async function exitRpcPlanMode(
	session: RpcPlanModeExitTarget,
	options: { restoreTools: string[] | undefined; interruptActiveTurn: boolean },
): Promise<void> {
	const tearDown = async () => {
		await session.setPlanMode(false, { restoreTools: options.restoreTools });
	};
	// Nothing streaming is nothing to interrupt, and an abort raised over an idle
	// session is an interruption event the client would have to explain away.
	if (!options.interruptActiveTurn || !session.isStreaming) {
		await tearDown();
		return;
	}
	await session.runModeExitTeardown(async () => {
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await tearDown();
	});
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	subagentEventBus?: EventBus,
	input: ReadableStream<Uint8Array> = claimRpcInput(),
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	// Ordered stdout writer honoring backpressure: chunked v2 frames are produced
	// lazily by the encoder and written one physical line at a time, so a near-limit
	// logical frame never materializes its full base64 transport in memory.
	let stdoutQueue: Promise<void> = Promise.resolve();
	const writeFrames = (frames: Iterable<string>) => {
		stdoutQueue = stdoutQueue
			.then(async () => {
				for (const line of frames) {
					if (!process.stdout.write(line)) await once(process.stdout, "drain");
				}
			})
			// stdout gone (host exited) — nothing left to deliver; keep the queue alive.
			.catch(() => {});
	};
	writeFrames(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		}),
	);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeFrames(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = subagentEventBus ? new RpcSubagentRegistry(subagentEventBus, output) : undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcSelect(this.pendingRequests, this.output, title, options, dialogOptions);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	/*
	 * Plan mode, for a client that has no terminal.
	 *
	 * Approval is the piece that was missing entirely: without a proposal
	 * handler an `xd://propose` write throws "No plan is awaiting approval",
	 * so an RPC client could strand the agent inside plan mode with no way out.
	 * This mirrors the ACP handler — the other front-end that had to solve
	 * approving a plan without a TUI — and routes the choice through the same
	 * extension-UI channel the `ask` tool uses, which every RPC client already
	 * has to render.
	 */
	const planLocalOptions = {
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
	};
	const APPROVE_OPTION = "Approve and execute";
	const REFINE_OPTION = "Refine plan";

	const handleRpcPlanProposal = async (title: string) => {
		const state = session.getPlanModeState();
		if (!state?.enabled) throw new ToolError("Plan mode is not active.");

		const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: (url: string) =>
				readPlanFile(url, { localProtocolOptions: planLocalOptions, cwd: session.sessionManager.getCwd() }),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions: planLocalOptions }),
		});
		const details: PlanApprovalDetails = { planFilePath, title: resolvedTitle, planExists: true };

		/*
		 * The plan travels with the request. A client that only receives a title
		 * and two buttons is asking you to approve something you cannot read — the
		 * TUI shows the plan in a full-screen review, and this is the equivalent
		 * for a client that has no terminal.
		 *
		 * `planFilePath` on the frame is not decoration either: it is what tells a
		 * client this `message` is markdown, and not the prose of an `ask`.
		 *
		 * Sent through `requestRpcSelect` rather than `rpcUiContext.select` because
		 * the extra fields are RPC's own; the shared `ExtensionUIContext` that the
		 * TUI and ACP also implement stays untouched.
		 */
		const planMarkdown = await readPlanFile(planFilePath, {
			localProtocolOptions: planLocalOptions,
			cwd: session.sessionManager.getCwd(),
		}).catch(() => null);

		planReviewCancel = new AbortController();
		const choice = await requestRpcSelect(
			pendingExtensionRequests,
			output,
			`Plan Review — ${resolvedTitle}`,
			[
				{ label: APPROVE_OPTION, description: "Leave plan mode and carry it out" },
				{ label: REFINE_OPTION, description: "Keep planning; the agent revises the plan file" },
			],
			// No timeout: a plan review waits for a person. `ask` does the same thing
			// while plan mode is on, for the same reason. The signal is the way back
			// out of that wait — a review that no one answers otherwise pins the turn
			// it blocks, and with it anything waiting for that turn to stop.
			{ signal: planReviewCancel.signal },
			planMarkdown ? { message: planMarkdown, planFilePath } : undefined,
		);

		if (choice !== APPROVE_OPTION) {
			/*
			 * Refine, or a dismissal. Plan mode stays on for another planning turn;
			 * promote the reviewed path so the next turn targets the plan just seen.
			 *
			 * Re-read rather than write back the copy captured at entry: a review
			 * blocks on a person, and plan mode can be turned off from anywhere
			 * while the dialog is up — spreading the stale copy would carry
			 * `enabled: true` back in and silently switch it on again.
			 */
			const current = session.getPlanModeState();
			if (current?.enabled && current.planFilePath !== planFilePath) {
				session.setPlanModeState({ ...current, planFilePath });
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan refinement requested. Update the plan file, then write ${resolvedTitle} to xd://propose again when ready.`,
					},
				],
				details,
			};
		}

		session.setPlanReferencePath(planFilePath);
		/*
		 * Through the same door as every other exit. Calling `session.setPlanMode`
		 * directly restored the tools but left `planPreviousTools` defined, so the
		 * next enable read it as a re-entry and sent the wrong plan-mode context to
		 * a session that had never been in plan mode this time round.
		 *
		 * Without `interruptActiveTurn`, and that is not an oversight: an approval
		 * is a request to start executing, and when it arrives from the `write` to
		 * `xd://propose` the turn it would stop is the one carrying it out. Only the
		 * client toggling the mode off is asking for a turn to end.
		 */
		await setRpcPlanMode(false, { interruptActiveTurn: false });
		return {
			content: [
				{
					type: "text" as const,
					text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
				},
			],
			details,
		};
	};

	/** The tool set to hand back when plan mode ends. */
	let planPreviousTools: string[] | undefined;

	/**
	 * The plan review currently on a client's screen, if any.
	 *
	 * It is the one dialog in the process that survives an abort: `ask` is handed
	 * the tool call's own signal, while a plan-proposal handler is handed no
	 * signal at all, so leaving plan mode has to supply one.
	 */
	let planReviewCancel: AbortController | undefined;

	/*
	 * `interruptActiveTurn` is required, not optional, and that is the point: the
	 * two exits differ only in this flag, so a default would let one of them be
	 * deleted as tidying — "both go through the same door, why does one pass a
	 * flag?" — and the deletion would be silent. Made mandatory, each caller has
	 * to state which kind of exit it is, and removing that no longer compiles.
	 */
	const setRpcPlanMode = async (enabled: boolean, options: { interruptActiveTurn: boolean }): Promise<void> => {
		if (enabled) {
			if (session.getPlanModeState()?.enabled) return;
			planPreviousTools = await session.setPlanMode(true, { reentry: planPreviousTools !== undefined });
			session.setPlanProposalHandler(handleRpcPlanProposal);
			return;
		}
		if (!session.getPlanModeState()?.enabled) return;
		/*
		 * The review goes first, and it has to: `abort()` waits for the agent loop,
		 * and the loop is inside the `write` that is waiting on the review dialog.
		 * A client that toggles the mode off instead of answering would hold the
		 * serial command queue against every later frame — `abort` included — with
		 * nothing left able to release it.
		 */
		if (options.interruptActiveTurn) planReviewCancel?.abort();
		await exitRpcPlanMode(session, {
			restoreTools: planPreviousTools,
			interruptActiveTurn: options.interruptActiveTurn,
		});
		planPreviousTools = undefined;
	};

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		mode: "rpc",
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		uiContext: rpcUiContext,
	});

	// Output all agent events as JSON
	session.subscribe(event => {
		output(event);
	});

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		await session.refreshSkills();
		session.setSlashCommands(
			await loadSlashCommands({
				cwd,
				extensionRoots: session.effectiveExtensionRoots,
			}),
		);
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 2)
					return error(id, "negotiate_protocol", `Unsupported RPC protocol version: ${command.protocolVersion}`);
				return success(id, "negotiate_protocol", { protocolVersion: 2 });
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				const skillResult = await tryRunRpcSkillCommand(session, command.message, command.streamingBehavior);
				if (skillResult) {
					return success(id, "prompt", skillResult);
				}
				const builtinResult = await executeAcpBuiltinSlashCommand(command.message, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: text => output({ type: "command_output", text }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: reloadPluginState,
					runCommandInBackground: task => shutdownCoordinator.track(task()),
					notifyTitleChanged: async () => {
						output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
					},
					notifyConfigChanged: async () => {
						output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				});
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () => session.prompt(builtinResult.prompt, { images: command.images }),
							output,
							onError: promptError => output(error(id, "prompt", promptError.message)),
							extensionUserMessageTracker,
						});
						return success(id, "prompt");
					}
					// A consumed builtin is normally local-only, but some (e.g.
					// `/retry`) schedule an agent turn whose events stream after
					// this response. Report that so the host does not finalize the
					// request as non-agent work while the agent is running.
					return success(id, "prompt", { agentInvoked: builtinResult.agentInvoked === true });
				}

				/*
				 * Title the session, the way every other front-end does.
				 *
				 * The TUI calls this per submission (input-controller.ts) and the CLI
				 * bootstrap calls it too (main.ts); `rpc-ui` was the only surface that
				 * never did, so a session driven from a GUI never got a name and every
				 * list fell back to its raw first message.
				 *
				 * Safe to call on every prompt: it stands down when the session is
				 * already named, when a generation is in flight, when the message is a
				 * local extension command, and when the text carries too little signal
				 * to name anything (`isLowSignalTitleInput`). That last one is what
				 * keeps "hola" from being given an invented title.
				 */
				session.maybeStartTitleGeneration(command.message);

				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				watchAndReportLocalOnlyPromptResult({
					id,
					startPrompt: () =>
						session.prompt(command.message, {
							images: command.images,
							streamingBehavior: command.streamingBehavior,
						}),
					output,
					onError: promptError => output(error(id, "prompt", promptError.message)),
					extensionUserMessageTracker,
				});
				return success(id, "prompt");
			}

			case "steer": {
				// A steer is a user message too, so it can name a session the first
				// prompt was too thin to name.
				session.maybeStartTitleGeneration(command.message);
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				session.maybeStartTitleGeneration(command.message);
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch": {
				const result = await handleRpcSessionChange(session, command, subagentRegistry);
				if (!result.data.cancelled) await emitAvailableCommandsUpdate();
				return success(id, result.type, result.data);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					planMode: (() => {
						const plan = session.getPlanModeState();
						return plan ? { enabled: plan.enabled, planFilePath: plan.planFilePath } : { enabled: false };
					})(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
					messageCount: session.messages.length,
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
				};
				return success(id, "get_state", state);
			}

			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported) {
					return error(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
				}
				return success(id, "set_fast_mode", {
					enabled: session.isFastModeEnabled(),
					active: session.isFastModeActive(),
				});
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				let models = session.getAvailableModels();
				let model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					// Model not in the current catalog. Wait for in-flight
					// background discovery before declaring it missing: on cold
					// start, discovery-backed providers (proxy / ollama / etc.)
					// populate seconds after session ready. Models already in
					// the bundled catalog skip this await entirely so the RPC
					// queue is not stalled behind unrelated discovery.
					await session.modelRegistry.awaitBackgroundRefresh();
					models = session.getAvailableModels();
					model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				}
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				await session.modelRegistry.awaitBackgroundRefresh();
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			case "abort_compact": {
				// Awaited, so the acknowledgement means the session has finished
				// unwinding. Answering first let a `get_state` that followed it report
				// `isCompacting: true`, a second `compact` come back
				// `compaction_in_progress`, and the desktop re-enable its button on a
				// session that was not ready for it.
				await session.abortCompaction();
				return success(id, "abort_compact");
			}

			// =================================================================
			// Plan mode
			// =================================================================

			case "set_plan_mode": {
				if (!session.settings.get("plan.enabled")) {
					return error(id, "set_plan_mode", "Plan mode is disabled. Enable it in settings (plan.enabled).");
				}
				/*
				 * Turning it off is the user saying stop planning, so the turn still
				 * running under the plan-mode toolset stops with it. Without that, the
				 * plan-mode block the turn started under kept the model planning until
				 * it produced a plan, long after the client had been told the mode was
				 * off — the same thing the terminal's `/plan` toggle was fixed for in
				 * #9699. The approval exit shares this helper and does not pass the
				 * flag.
				 */
				await setRpcPlanMode(command.enabled, { interruptActiveTurn: true });
				return success(id, "set_plan_mode", { enabled: session.getPlanModeState()?.enabled === true });
			}

			case "plan_review": {
				if (!session.getPlanModeState()?.enabled) {
					return error(id, "plan_review", "Plan mode is not active.");
				}
				/*
				 * Fire and forget: the review is a blocking UI request, and awaiting
				 * it here would hold the serial command queue for as long as a person
				 * takes to read a plan — including against the `abort` that would
				 * cancel it.
				 */
				shutdownCoordinator.track(
					handleRpcPlanProposal("")
						.then(() => {})
						.catch(err => {
							/*
							 * A notice, not a response frame.
							 *
							 * This command answers `success` immediately — it has to, or the
							 * serial queue is held for as long as a person takes to read a
							 * plan. So by the time this fires the request is settled, and a
							 * second frame carrying its id matches nothing a client is
							 * waiting on. It went out with `id: undefined` before, which
							 * matched even less. Notices are the channel for exactly this:
							 * out-of-band conditions the user should see.
							 */
							session.emitNotice(
								"error",
								`Plan review failed: ${err instanceof Error ? err.message : String(err)}`,
								"plan",
							);
						}),
				);
				return success(id, "plan_review");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = session.messages;
				try {
					return success(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
							},
							{ cursor: command.cursor, limit: command.limit },
						),
					);
				} catch (pageError) {
					return error(
						id,
						"get_messages_page",
						pageError instanceof Error ? pageError.message : String(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			await session.dispose();
			process.exit(0);
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash remains
	// background-dispatched so abort_bash can overtake it. Frames are read
	// line-by-line by readRpcInputFrames so a single malformed line is reported
	// as an error frame and the loop keeps running instead of throwing out of
	// the reader and killing the whole process (issue #5194).
	await readRpcInputFrames(
		input ?? Bun.stdin.stream(),
		parsed => inputDispatcher.dispatch(parsed),
		message => output(error(undefined, "parse", message)),
	);

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	/*
	 * And the compaction, for the same reason as the three above: it is
	 * background work that can run for minutes, and there is no longer anyone to
	 * receive its result. Without this, closing the client left the sidecar
	 * summarising a transcript nobody would read, then writing the response into
	 * a dead pipe before exiting — indistinguishable, from outside, from a hang.
	 */
	session.abortCompaction();
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	subagentRegistry?.dispose();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately.
	await session.dispose();
	process.exit(0);
}
