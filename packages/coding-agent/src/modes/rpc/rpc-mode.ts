/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur (message frames stamped with `messageId`)
 * - Prompt completion: one `prompt_result` per accepted prompt, correlated by the command `id`
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { $env, isRecord, logger, postmortem, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionAskDialogSubmitResult,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
	timedOutAskDialogResult,
} from "../../extensibility/extensions";
import {
	type BuiltSkillPromptMessage,
	buildSkillPromptMessage,
	parseSkillInvocation,
	type Skill,
	type SkillPromptInput,
} from "../../extensibility/skills";
import { type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import {
	type WordCompletionEngine,
	type WordCompletionMethod,
	type WordCompletionQuery,
	wordCompletionQuery,
} from "@oh-my-pi/pi-tui/prompt/word-completion";
import { requestTextPrediction, textPredictionBackend } from "../../predict/client";
import { type AgentSession, SessionBusyError } from "../../session/agent-session";
import type { RestoredQueuedMessage } from "../../session/agent-session-types";
import { bindSessionMessaging } from "../../session/messaging-host";
import { claimSessionName } from "../../messaging/names";
import { CACHE_WARMING_MODES } from "../../session/cache-warmer";
import { findMostRecentNonEmptySession } from "../../session/session-listing";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { listLogoutAccounts, logoutCredential } from "../../slash-commands/helpers/logout";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { EventBus } from "../../utils/event-bus";
import { selectRpcEntries } from "./rpc-compat";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import {
	formatPersistenceDurabilityFailure,
	formatPersistenceFailure,
	formatPersistenceNotice,
} from "../persistence-failure";
import { initializeExtensions } from "../runtime-init";
import { cfgSpellingAutocomplete } from "../settings";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { RpcBtwController } from "./rpc-btw";
import { RpcGoalController } from "./rpc-goal";
import { RpcLiveBridge, type RpcLiveSessionFactory } from "./rpc-live";
import { RpcOutputWriter } from "./rpc-output";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
	type RpcPromptTicket,
	watchAndReportPromptResult,
} from "./rpc-prompt-results";
import { RpcSessionEventForwarder } from "./rpc-session-events";
import { isRpcSessionSettled, RpcSessionSettleWatcher, watchedScheduledTurnProbe } from "./rpc-session-settle";
import { RpcSubagentRegistry, readRpcSubagentTranscript, resolveOwnedLiveSubagent } from "./rpc-subagents";
import type {
	RpcAbortAndRestoreQueueResult,
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
	RpcOpenSessionResult,
	RpcRemoveQueuedMessageResult,
	RpcResponse,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

const INVALID_TEXT_CURSOR_ERROR = "cursor must be an integer UTF-16 offset within text";

function isTextCursor(text: unknown, cursor: unknown): text is string {
	return (
		typeof text === "string" &&
		typeof cursor === "number" &&
		Number.isInteger(cursor) &&
		cursor >= 0 &&
		cursor <= text.length
	);
}

/**
 * Composer ghost-text query at a UTF-16 cursor offset, gated like the TUI
 * editor's: only at the end of a line, and only for a prose word.
 */
function wordQueryAt(text: string, cursor: number): WordCompletionQuery | undefined {
	if (cursor < text.length && text[cursor] !== "\n") return undefined;
	const lines = text.split("\n");
	let cursorLine = 0;
	let lineStart = 0;
	while (lineStart + lines[cursorLine]!.length < cursor) lineStart += lines[cursorLine++]!.length + 1;
	return wordCompletionQuery(lines, cursorLine, cursor - lineStart);
}

interface QueuedWordPrediction {
	engine: WordCompletionEngine;
	query: WordCompletionQuery;
	resolve(suffix: string | null): void;
	reject(error: unknown): void;
}

/**
 * `predict_word` answers for one RPC session, with the TUI provider's flow
 * control: one engine request in flight, and a newer request replaces the one
 * waiting behind it (the replaced request answers `null`), so a burst of
 * typing costs the shared daemon at most two inferences.
 */
export class RpcWordPredictor {
	#busy = false;
	#queued: QueuedWordPrediction | undefined;
	readonly #request: typeof requestTextPrediction;

	/** `request` is a test seam. */
	constructor(request: typeof requestTextPrediction = requestTextPrediction) {
		this.#request = request;
	}

	/**
	 * Ghost-text suffix for the word ending at `cursor`, or `null` when the
	 * engine is off, nothing applies, or a newer request superseded this one.
	 * Rejects when the prediction daemon cannot answer.
	 */
	predict(method: WordCompletionMethod, text: string, cursor: number): Promise<string | null> {
		if (method === "off") return Promise.resolve(null);
		const query = wordQueryAt(text, cursor);
		if (!query) return Promise.resolve(null);
		if (!this.#busy) return this.#run(method, query);
		this.#queued?.resolve(null);
		const { promise, resolve, reject } = Promise.withResolvers<string | null>();
		this.#queued = { engine: method, query, resolve, reject };
		return promise;
	}

	async #run(engine: WordCompletionEngine, query: WordCompletionQuery): Promise<string | null> {
		this.#busy = true;
		try {
			const { suggestion } = await this.#request(engine, query.before, query.prefix);
			return suggestion?.suffix || null;
		} finally {
			this.#busy = false;
			const next = this.#queued;
			this.#queued = undefined;
			if (next) void this.#run(next.engine, next.query).then(next.resolve, next.reject);
		}
	}
}

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
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" } | { type: "fork" }
>;

export type RpcQueueModeCommand = Extract<
	RpcCommand,
	{ type: "set_steering_mode" } | { type: "set_follow_up_mode" } | { type: "set_interrupt_mode" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } }
	| { type: "fork"; data: { cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch" | "fork">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export interface RpcSkillInvocation extends SkillPromptInput {
	skill: Skill;
	queueChipText: string;
}

/**
 * Fast in-memory pre-check for a skill invocation: settings gate, text shape,
 * and skill lookup. Returns null when the message is not a runnable skill
 * command. Performs no I/O — safe to run on the RPC serial queue.
 */
export function resolveRpcSkillInvocation(session: RpcSkillCommandSession, text: string): RpcSkillInvocation | null {
	if (!session.skillsSettings?.enableSkillCommands) return null;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return null;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return null;
	return { skill, args: parsed.args, prompt: parsed.prompt, queueChipText: text };
}

/**
 * Slow half of a skill invocation: builds the skill prompt message (file I/O)
 * and dispatches it through the full prompt pipeline (usage preflight,
 * compaction checks, provider calls). Resolves once the turn is scheduled.
 * Must not run on the RPC serial queue's response path — register it with
 * watchAndReportPromptResult and answer the command once it is admitted.
 */
export async function runRpcSkillCommand(
	session: RpcSkillCommandSession,
	invocation: RpcSkillInvocation,
	streamingBehavior: "steer" | "followUp" = "steer",
	prebuilt?: BuiltSkillPromptMessage,
	onPromptAdmitted?: () => void,
	images?: ImageContent[],
): Promise<boolean> {
	const built = prebuilt ?? (await buildSkillPromptMessage(invocation.skill, invocation, "user"));
	return session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: images?.length ? [{ type: "text", text: built.message }, ...images] : built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior, queueChipText: invocation.queueChipText, onPromptAdmitted },
	);
}

/**
 * Skill branch of the `prompt` command: resolves the invocation cheaply, then
 * registers the slow dispatch with watchAndReportPromptResult and awaits
 * admission (or completion, for a message that settles without ever being
 * admitted) before answering. The caller still does not wait for the full
 * dispatch pipeline — building the skill prompt and running it (usage
 * preflight, compaction, provider calls) can outlast any client's prompt
 * timeout under provider stress; only queue admission gates the response.
 *
 * @returns `null` for a non-skill message, `"cancelled"` when `isCurrent`
 *   reports the submission was invalidated while the skill file was read.
 */
export async function dispatchRpcSkillPrompt(input: {
	ticket: RpcPromptTicket;
	session: RpcSkillCommandSession;
	message: string;
	streamingBehavior: "steer" | "followUp" | undefined;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	images?: ImageContent[];
	isCurrent?: () => boolean;
}): Promise<RpcSkillCommandResult | "cancelled" | null> {
	const invocation = resolveRpcSkillInvocation(input.session, input.message);
	if (!invocation) return null;
	// buildSkillPromptMessage is cheap file I/O and covers the failure the old
	// synchronous path reported immediately (a removed or unreadable SKILL.md);
	// keep that error contract by awaiting it before answering. The expensive
	// promptCustomMessage pipeline (usage preflight, compaction, provider
	// calls) is what moves behind the acknowledgement.
	const built = await buildSkillPromptMessage(invocation.skill, invocation, "user");
	if (input.isCurrent && !input.isCurrent()) return "cancelled";
	// A failure before admission still resolves this wait (without rejecting this
	// call) — reportPromptResult already routed it to onError and a failed prompt_result.
	await watchAndReportPromptResult({
		ticket: input.ticket,
		startPrompt: onPromptAdmitted =>
			runRpcSkillCommand(
				input.session,
				invocation,
				input.streamingBehavior ?? "steer",
				built,
				onPromptAdmitted,
				input.images,
			),
		results: input.results,
		onError: input.onError,
		extensionUserMessageTracker: input.extensionUserMessageTracker,
	});
	return { agentInvoked: true };
}

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
	images?: ImageContent[],
): Promise<RpcSkillCommandResult | false> {
	const invocation = resolveRpcSkillInvocation(session, text);
	if (!invocation) return false;
	await runRpcSkillCommand(session, invocation, streamingBehavior, undefined, undefined, images);
	return { agentInvoked: true };
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
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
 * Commands that skip the serial queue entirely; see {@link dispatchRpcInputFrame}.
 * (`prompt` and `steer_subagent` are also backgrounded there, but start through
 * the serial tail.) `btw_cancel` is synchronous and must overtake a `btw` still
 * starting or a long serial command.
 * A Set, not a Record: `type` is untrusted input and must not hit prototype keys.
 */
const BACKGROUND_COMMANDS: ReadonlySet<string> = new Set<RpcCommand["type"]>([
	"bash",
	"predict_word",
	"live_start",
	"btw_cancel",
]);

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * `bash`, `predict_word`, `prompt` and `steer_subagent` are dispatched in the
 * background so the caller can keep reading subsequent frames while one is
 * still settling: a `bash` command can run for a long time, and a `prompt`
 * command's response is held until the message is admitted, which can span
 * real wall-clock time (image normalization, a vision-model description call).
 * `steer_subagent` likewise holds its response until the subagent accepts the
 * message, which for a subagent between turns includes its whole
 * pre-`agent_start` setup. Backgrounding them lets a client send `abort_bash`
 * while a shell command runs, or `abort` (and `steer`/`follow_up`/`get_state`)
 * while a `prompt` or `steer_subagent` is still admitting. `predict_word` is
 * backgrounded too, so a cold prediction engine never stalls the command queue
 * behind a keystroke. `live_start` responds only once the realtime session is
 * connected and recording, so it is backgrounded and `live_stop` can cancel it.
 * Response correlation is preserved via each command's `id`; ordering across
 * concurrent commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`, `predict_word`, `live_start`, `prompt`, `steer`, `follow_up`, `steer_subagent`). Otherwise a promise that
 *   resolves once the response for the command has been emitted via `output`.
 *   Errors from `handleCommand` on a command dispatched inline propagate; the
 *   caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// `bash` can run for a long time, and `prompt`'s response is held until
	// admission (see PromptOptions.onPromptAdmitted), which can likewise span
	// real wall-clock time; `steer_subagent` waits for the subagent to accept.
	// Dispatch them in the background so a subsequent frame — `abort_bash` for
	// a running `bash`, or `abort`/`steer`/`follow_up`/`get_state` for an
	// admitting `prompt` — can be read and handled without waiting for the
	// earlier command to finish on its own. `predict_word` is backgrounded so a
	// cold prediction engine never stalls the command queue behind a keystroke.
	// The response is emitted when `handleCommand` resolves; clients correlate
	// via `command.id`.
	if (
		BACKGROUND_COMMANDS.has(command.type) ||
		command.type === "prompt" ||
		command.type === "steer" ||
		command.type === "follow_up" ||
		command.type === "steer_subagent"
	) {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, command.type, message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

const USER_INPUT_TYPES: Record<string, true> = {
	prompt: true,
	steer: true,
	follow_up: true,
	abort_and_prompt: true,
};

const SESSION_CHANGE_TYPES: Record<string, true> = {
	new_session: true,
	switch_session: true,
	branch: true,
	fork: true,
	open_session: true,
};

/**
 * Orders user input and decides whether an accepted frame is still wanted.
 *
 * Every user-input, abort and session-change frame gets a sequence number when it
 * is accepted (read from stdin), not when its handler runs. An abort invalidates
 * input accepted before it immediately. A session change invalidates input accepted
 * before the change frame, and only once the change succeeds: a vetoed change keeps
 * that input, and input pipelined after the change still runs in the new session.
 */
export class RpcUserInputGate {
	#tail: Promise<void> = Promise.resolve();
	#sequence = 0;
	#validFrom = 0;
	#acceptedAt = new WeakMap<object, number>();

	/** Call from {@link RpcInputDispatcher.dispatch} before the handler is queued. */
	accept(command: RpcCommand): void {
		const isAbort =
			command.type === "abort" || command.type === "abort_and_prompt" || command.type === "abort_and_restore_queue";
		if (
			!isAbort &&
			!Object.hasOwn(USER_INPUT_TYPES, command.type) &&
			!Object.hasOwn(SESSION_CHANGE_TYPES, command.type)
		) {
			return;
		}
		const sequence = ++this.#sequence;
		this.#acceptedAt.set(command, sequence);
		if (isAbort) this.#validFrom = sequence;
	}

	/** A session change succeeded: invalidate input accepted before its frame. */
	commitSessionChange(command: RpcCommand): void {
		const sequence = this.#acceptedAt.get(command);
		if (sequence !== undefined && sequence > this.#validFrom) this.#validFrom = sequence;
	}

	/** False when an abort, or a successful session change, accepted after this frame invalidated it. */
	isCurrent(command: RpcCommand): boolean {
		const sequence = this.#acceptedAt.get(command);
		return sequence !== undefined && sequence >= this.#validFrom;
	}

	/** Run user-input work in accept order. The tail releases when `work` settles, not when a model turn ends. */
	enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(work, work);
		this.#tail = run.then(
			() => {},
			() => {},
		);
		return run;
	}
}

/** Starts prompts, steers, follow-ups and `steer_subagent` after earlier ordinary commands, without
 * awaiting admission. Control frames, `bash` and `predict_word` dispatch immediately (see
 * dispatchRpcInputFrame). `acceptInput` runs synchronously in {@link dispatch}, before the
 * handler is queued, so an abort can invalidate a frame that has not started yet. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;
	readonly #acceptInput: ((command: RpcCommand) => void) | undefined;

	constructor(options: {
		deps: RpcInputFrameDeps;
		afterSerialCommand?: () => Promise<void>;
		acceptInput?: (command: RpcCommand) => void;
	}) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
		this.#acceptInput = options.acceptInput;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;
			const command = parsed as RpcCommand;
			this.#acceptInput?.(command);
			// Bash and predict_word retain their immediate side channel. Prompts,
			// steers, follow-ups and steer_subagent start through the serial tail, but
			// dispatchRpcInputFrame backgrounds their admission.
			if (BACKGROUND_COMMANDS.has(command.type)) {
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
 * not exit while a background-dispatched command (`bash`, `predict_word`,
 * `prompt` or `steer_subagent`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-command with no follow-up client
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

/** UTF-8 JSON size of `value`, as compared against `RpcFrameEncoder.maxResponseBytes`. */
function encodedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Build the `remove_queued_message` response within `maxBytes`. The message is already removed,
 * so an oversized response must not become a transport-limit error that loses it: its images are
 * omitted instead (`imagesDropped`).
 */
export function fitRemoveQueuedMessageResponse(
	id: string | undefined,
	removed: RestoredQueuedMessage | undefined,
	maxBytes: number,
): RpcResponse {
	const response = (data: RpcRemoveQueuedMessageResult): RpcResponse => ({
		id,
		type: "response",
		command: "remove_queued_message",
		success: true,
		data,
	});
	if (!removed?.images) return response({ removed: removed !== undefined });
	const full = response({ removed: true, images: removed.images });
	return encodedBytes(full) <= maxBytes ? full : response({ removed: true, imagesDropped: true });
}

/**
 * Build the `abort_and_restore_queue` response within `maxBytes`. The queue is already withdrawn,
 * so an oversized response must not become a transport-limit error that loses it: images go first
 * (`imagesDropped`, keeping every text), then the newest entries (`truncated`, keeping an
 * oldest-first prefix of steering then follow-ups).
 */
export function fitAbortAndRestoreQueueResponse(
	id: string | undefined,
	restored: RpcAbortAndRestoreQueueResult,
	maxBytes: number,
): RpcResponse {
	const response = (data: RpcAbortAndRestoreQueueResult): RpcResponse => ({
		id,
		type: "response",
		command: "abort_and_restore_queue",
		success: true,
		data,
	});
	const full = response(restored);
	if (encodedBytes(full) <= maxBytes) return full;
	const imagesDropped = [...restored.steering, ...restored.followUp].some(entry => entry.images?.length);
	const flags = imagesDropped ? { imagesDropped: true as const } : {};
	const textOnly = {
		steering: restored.steering.map(({ text }) => ({ text })),
		followUp: restored.followUp.map(({ text }) => ({ text })),
	};
	if (imagesDropped) {
		const withoutImages = response({ ...textOnly, ...flags });
		if (encodedBytes(withoutImages) <= maxBytes) return withoutImages;
	}
	const fitted: RpcAbortAndRestoreQueueResult = { steering: [], followUp: [], ...flags, truncated: true };
	// Exact: each entry adds its own JSON plus a comma after the first in its array.
	let remaining = maxBytes - encodedBytes(response(fitted));
	for (const queue of ["steering", "followUp"] as const) {
		for (const entry of textOnly[queue]) {
			const cost = encodedBytes(entry) + (fitted[queue].length > 0 ? 1 : 0);
			if (cost > remaining) return response(fitted);
			fitted[queue].push(entry);
			remaining -= cost;
		}
	}
	return response(fitted);
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

/**
 * Handle RPC `cancel_subagent`: hard-kill one of this session's running
 * subagents through the same path as the Agent Hub / collab `kill` command.
 * Aborting the live turn and releasing the registry ref as an `aborted`
 * tombstone settles the owning `task` call (foreground or background) with an
 * aborted result, and disposing the session cancels its nested children.
 *
 * Only ids this session reported as running are reachable (see
 * {@link resolveOwnedLiveSubagent}). Returns `false` (a no-op) for unknown,
 * finished, or already-cancelled subagents so hosts can treat cancelling a
 * vanished subagent as success. Rejects when the tombstone cannot be persisted
 * or the abort fails; the subagent is still detached and disposed.
 */
export async function handleRpcCancelSubagent(
	subagentRegistry: Pick<RpcSubagentRegistry, "getSubagents">,
	subagentId: string,
): Promise<boolean> {
	const owned = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (!owned) return false;
	// Start the release first: it publishes the `aborted` tombstone synchronously,
	// so the executor cannot accept the run's result (flipping the ref to idle)
	// while the abort below is still settling. Settle both together so a failed
	// tombstone write is reported here instead of escaping as an unhandled
	// rejection while the abort is pending.
	const [released, aborted] = await Promise.allSettled([
		AgentLifecycleManager.global().release(subagentId, owned.ref, { tombstone: true }),
		owned.session.abort({ reason: USER_INTERRUPT_LABEL }),
	]);
	if (released.status === "rejected") throw released.reason;
	if (aborted.status === "rejected") throw aborted.reason;
	return released.value;
}

/**
 * Handle RPC `steer_subagent`: send the host's message to a running subagent
 * as its user, the same way Agent Hub chat does: `AgentLifecycleManager.ensureLive`,
 * then `prompt(message, { streamingBehavior: "steer" })` on the subagent's own
 * session. A mid-turn subagent is steered at its next step boundary; one
 * between turns starts its next turn. Because this is `prompt()`, extension,
 * custom and file slash commands run and prompt templates expand as in Agent
 * Hub chat (unlike RPC `steer`, which rejects extension commands). The message
 * is recorded in the subagent's transcript, never attributed to the parent.
 *
 * Only running subagents this session lists in `get_subagents` are reachable
 * (see {@link resolveOwnedLiveSubagent}); one whose result the parent already
 * accepted is refused. A running ref always holds a live session, so
 * `ensureLive` never revives here; it only cancels an in-flight idle park.
 *
 * Resolves once the message is accepted: queued into a running turn, or the
 * subagent's new turn started (`agent_start`). A refusal before that —
 * including a prompt dropped by an abort, disposal or usage preflight — is
 * returned as the error; the rest of the turn is not awaited and later
 * failures are logged. Returns an error message, or `undefined` once accepted.
 */
export async function handleRpcSteerSubagent(
	subagentRegistry: Pick<RpcSubagentRegistry, "getSubagents">,
	subagentId: string,
	message: string,
): Promise<string | undefined> {
	const notRunning = `Subagent not running: ${subagentId}`;
	const owned = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (!owned) return notRunning;
	let session: AgentSession;
	try {
		session = await AgentLifecycleManager.global().ensureLive(subagentId);
	} catch {
		return notRunning;
	}
	// ensureLive awaits; the id may now belong to a different (same-name) agent,
	// or the subagent may have finished in the meantime.
	const current = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (current?.ref !== owned.ref || current.session !== session) return notRunning;

	const accepted = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_start") accepted.resolve();
	});
	session.prompt(message, { streamingBehavior: "steer", throwOnDrop: true }).then(
		() => accepted.resolve(),
		err => {
			accepted.reject(err);
			logger.warn("steer_subagent message failed", { subagentId, error: String(err) });
		},
	);
	try {
		await accepted.promise;
		return undefined;
	} catch (err) {
		return `Subagent refused the message: ${err instanceof Error ? err.message : String(err)}`;
	} finally {
		unsubscribe();
	}
}

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
	requestedModel?: Model,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const options = requestedModel ? { model: requestedModel } : undefined;
			const cancelled = !(await session.switchSession(command.sessionPath, options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}

		case "fork": {
			// RPC forks are snapshots: refuse while work could still write into the transcript.
			// fork() rechecks after its awaits; interactive /fork keeps carrying running bash across.
			const cancelled = !(await session.fork(command.entryId, { requireIdle: true }));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "fork", data: { cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

export type RpcOpenSessionSession = Pick<
	AgentSession,
	"newSession" | "switchSession" | "sessionFile" | "sessionId" | "messages" | "model" | "setModel"
>;

/**
 * Continue the newest non-empty session in `sessionDir`, or start a fresh one
 * there — the runtime equivalent of `--session-dir <dir> --continue`, so a host
 * can bind a pre-spawned process to a conversation it keys by directory.
 * Reopening the session that is already active is a no-op and does not abort a run.
 *
 * With `model`, the session uses that model instead of its saved one, like an
 * explicit `--model`; otherwise a saved model that cannot be restored fails the
 * switch (see {@link AgentSession.switchSession}).
 *
 * @throws Error when the process runs without session persistence (`--no-session`).
 */
export async function openRpcSession(
	session: RpcOpenSessionSession,
	sessionDir: string,
	subagentRegistry?: RpcSubagentResetRegistry,
	model?: Model,
): Promise<RpcOpenSessionResult> {
	if (!session.sessionFile) throw new Error("open_session requires session persistence (omit --no-session)");
	const dir = path.resolve(sessionDir);
	const latest = await findMostRecentNonEmptySession(dir);
	const current = path.resolve(session.sessionFile);
	const alreadyOpen = latest
		? current === path.resolve(latest)
		: path.dirname(current) === dir && session.messages.length === 0;
	let cancelled = false;
	if (!alreadyOpen) {
		cancelled = latest
			? !(await session.switchSession(latest, model ? { model } : undefined))
			: !(await session.newSession({ sessionDir: dir }));
		if (!cancelled) subagentRegistry?.clear();
	}
	// A resumed session is bound to the model by the switch; an already-open or
	// fresh one selects it as `set_model` would.
	if (!cancelled && model && !modelsAreEqual(session.model, model)) await session.setModel(model);
	return {
		cancelled,
		resumed: !cancelled && latest !== null,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
	};
}

type RpcModelLookupSession = Pick<AgentSession, "getAvailableModels" | "modelRegistry">;

/**
 * The available model with exactly this provider and id. Models missing from
 * the current catalog wait for in-flight background discovery first: on cold
 * start, discovery-backed providers (proxy / ollama / etc.) populate seconds
 * after session ready. Catalog hits skip the wait, so the RPC queue is not
 * stalled behind unrelated discovery.
 */
async function findRpcModel(session: RpcModelLookupSession, provider: string, modelId: string) {
	const find = () => session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
	const model = find();
	if (model) return model;
	await session.modelRegistry.awaitBackgroundRefresh();
	return find();
}

/** The optional `provider`/`modelId` pair of `open_session` or `switch_session`, validated like `set_model`. */
async function resolveRequestedRpcModel(
	session: RpcModelLookupSession,
	command: { provider?: string; modelId?: string },
): Promise<Model | undefined> {
	const { provider, modelId } = command;
	if (provider === undefined && modelId === undefined) return undefined;
	if (provider === undefined || modelId === undefined) throw new Error("provider and modelId must be given together");
	const model = await findRpcModel(session, provider, modelId);
	if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
	return model;
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
			readsSkillUris: tool.readsSkillUris,
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

/** Sends an RPC select request while retaining aligned option descriptions. */
export function requestRpcSelect(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
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
			timeout: dialogOptions?.timeout,
		},
		response => parseValueDialogResponse(response, dialogOptions),
	);
}

/** Validates `ask` answers against the questions; any mismatch throws instead of guessing. */
function parseAskDialogResponse(
	response: RpcExtensionUIResponse,
	questions: ExtensionAskDialogQuestion[],
	dialogOptions: ExtensionUIDialogOptions,
): ExtensionAskDialogSubmitResult | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions.onTimeout?.();
		return undefined;
	}
	const answers: unknown = "answers" in response ? response.answers : undefined;
	if (!Array.isArray(answers) || answers.length !== questions.length) {
		throw new Error(`Ask dialog response must carry ${questions.length} answers in question order`);
	}
	return {
		kind: "submit",
		results: questions.map((question, index) => {
			const answer: unknown = answers[index];
			if (!isRecord(answer) || answer.id !== question.id) {
				throw new Error(`Ask dialog answer ${index} must have id ${JSON.stringify(question.id)}`);
			}
			const labels = question.options.map(option => option.label);
			const multi = question.multi ?? false;
			const { selectedOptions, customInput } = answer;
			if (!Array.isArray(selectedOptions)) {
				throw new Error(`Ask dialog answer ${JSON.stringify(question.id)} must carry a selectedOptions array`);
			}
			const selected: string[] = [];
			for (const label of selectedOptions) {
				if (typeof label !== "string" || !labels.includes(label)) {
					throw new Error(
						`Ask dialog answer ${JSON.stringify(question.id)} selected unknown option ${JSON.stringify(label)}`,
					);
				}
				if (selected.includes(label)) {
					throw new Error(
						`Ask dialog answer ${JSON.stringify(question.id)} selected ${JSON.stringify(label)} twice`,
					);
				}
				selected.push(label);
			}
			if (customInput !== undefined && typeof customInput !== "string") {
				throw new Error(`Ask dialog answer ${JSON.stringify(question.id)} customInput must be a string`);
			}
			const custom = customInput?.trim() || undefined;
			if (!multi && (selected.length > 1 || (selected.length > 0 && custom !== undefined))) {
				throw new Error(
					`Ask dialog answer ${JSON.stringify(question.id)} is single-select but carries more than one answer`,
				);
			}
			return {
				id: question.id,
				question: question.question,
				options: labels,
				multi,
				selectedOptions: selected,
				customInput: custom,
			};
		}),
	};
}

/** Sends all ask questions as one RPC `ask` dialog; a timeout answers every question with its recommended option. */
export async function requestRpcAskDialog(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	questions: ExtensionAskDialogQuestion[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<ExtensionAskDialogResult | undefined> {
	let timedOut = false;
	const opts: ExtensionUIDialogOptions = {
		...dialogOptions,
		onTimeout: () => {
			timedOut = true;
			dialogOptions?.onTimeout?.();
		},
	};
	const result = await requestRpcDialog(
		pendingRequests,
		output,
		opts,
		undefined,
		{ method: "ask", questions, timeout: dialogOptions?.timeout },
		response => parseAskDialogResponse(response, questions, opts),
	);
	return timedOut ? timedOutAskDialogResult(questions) : result;
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
	// Tells the host to close a dialog omp has already settled, so a late answer
	// cannot look actionable after abort or timeout.
	const cancelHostDialog = () =>
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
	const onAbort = () => {
		cancelHostDialog();
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cancelHostDialog();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			try {
				resolve(parseResponse(response));
			} catch (err) {
				reject(err);
			}
		},
		reject,
	});
	output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}
/**
 * Applies a queue-mode RPC command to the calling session only. Owns the
 * `persist: false` contract (#11555) in one place so no dispatcher arm can
 * silently restore machine-global writes.
 */
export function applyRpcQueueModeCommand(session: AgentSession, command: RpcQueueModeCommand): void {
	switch (command.type) {
		case "set_steering_mode":
			session.setSteeringMode(command.mode, false);
			break;
		case "set_follow_up_mode":
			session.setFollowUpMode(command.mode, false);
			break;
		case "set_interrupt_mode":
			session.setInterruptMode(command.mode, false);
			break;
	}
}

/**
 * Report a store failure as an error `notice` frame and a session move as a
 * warning one (each with a stderr mirror) — issue #11493. Frames go straight
 * through the mode's `output` rather than `session.emitNotice`: dispose clears
 * the session's event listeners before it closes the store (agent-session.ts
 * `#doDispose`), so a failure latched during `close()` would have no subscriber
 * left to forward it and the client would see a nonzero exit with no notice at
 * all. `onFailure` records the failure for the mode's own teardown
 * attribution: a failure still latched at dispose is what makes
 * `session.dispose()` reject.
 */
export function registerRpcPersistenceSurface(
	session: Pick<AgentSession, "sessionManager">,
	output: (frame: object) => void,
	onFailure?: (error: Error) => void,
): () => void {
	const unsubscribeFailures = session.sessionManager.onPersistenceError(error => {
		onFailure?.(error);
		const message = formatPersistenceFailure(error.message);
		output({ type: "notice", level: "error", message, source: "session-persistence" });
		process.stderr.write(`${message}\n`);
	});
	const unsubscribeNotices = session.sessionManager.onPersistenceNotice(notice => {
		const message = formatPersistenceNotice(notice);
		output({ type: "notice", level: "warning", message, source: "session-persistence" });
		process.stderr.write(`${message}\n`);
	});
	return () => {
		unsubscribeFailures();
		unsubscribeNotices();
	};
}

/** Startup options for {@link runRpcMode}. */
export interface RpcModeOptions {
	/** `--mode rpc-ui`: route tool UI (e.g. ask) over the protocol, independently of headless extensions. */
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** `--no-ui`: extensions run with `hasUI=false` and no UI frames; tool UI and host-issued login are unaffected. */
	headless?: boolean;
	subagentEventBus?: EventBus;
	input?: ReadableStream<Uint8Array>;
	name?: string;
	/** Builds `live_start` sessions; defaults to the real {@link LiveSessionController}. */
	createLiveSession?: RpcLiveSessionFactory;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession, options: RpcModeOptions = {}): Promise<never> {
	const messaging = await bindSessionMessaging(session, { directPrint: false, exportProcessEnv: true });
	const cancelMessagingTeardown = postmortem.register("rpc-mode-messaging", () => messaging.dispose());
	try {
		if (options.name !== undefined) {
			const taken = new Set(
				(await session.messaging?.listSessions())?.flatMap(item => (item.name === null ? [] : [item.name])),
			);
			await session.sessionManager.setSessionName(claimSessionName(options.name, taken), "user");
		}
		return await runRpcModeCore(session, options, messaging);
	} finally {
		cancelMessagingTeardown();
		await messaging.dispose();
	}
}

async function runRpcModeCore(
	session: AgentSession,
	options: RpcModeOptions,
	messaging: { ready(): void; dispose(): Promise<void> },
): Promise<never> {
	const { setToolUIContext, headless = false, subagentEventBus, input = claimRpcInput(), createLiveSession } = options;
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	// Bun on Windows writes a piped process.stdout with a blocking WriteFile on the
	// JS thread and never reports backpressure, so a client that stops reading
	// stdout froze the whole worker, stdin reader included. An fd write stream
	// writes from the threadpool and reports backpressure, letting the writer spool.
	const stdout = process.platform === "win32" ? fs.createWriteStream("", { fd: 1, autoClose: false }) : process.stdout;
	const outputWriter = new RpcOutputWriter(stdout, failure => {
		logger.error("RPC output delivery failed", { error: String(failure) });
		void messaging
			.dispose()
			.then(() => session.dispose())
			.finally(() => process.exit(1));
	});
	outputWriter.write(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		}),
	);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		outputWriter.write(frameEncoder.encodeFrames(obj));
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
	const wordPredictor = new RpcWordPredictor();
	const btw = new RpcBtwController(session, output);
	// A continuation abandoned while waiting leaves nothing to end the activity stretch: re-check settlement.
	const goalController = new RpcGoalController(session, () => void settleWatcher.check());
	// A scheduled or held goal turn will start a turn: every settle report treats it as busy,
	// and any report of "not settled" for that reason is later closed by `session_settled`.
	const goalTurnScheduled = watchedScheduledTurnProbe(
		() => goalController.continuationPending,
		() => settleWatcher,
	);
	const promptResults = new RpcPromptResults(session, output, goalTurnScheduled);
	const sessionEvents = new RpcSessionEventForwarder(output);
	const settleWatcher = new RpcSessionSettleWatcher(session, output, goalTurnScheduled);

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	// Live frames go straight to `output`, so `set_event_filter` (session events only) never drops them.
	const liveBridge = new RpcLiveBridge(session, output, createLiveSession);
	const subagentRegistry = subagentEventBus ? new RpcSubagentRegistry(subagentEventBus, output) : undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		/** Set by `set_ask_dialog`; hosts that never opt in keep the select/editor ask fallback. */
		askDialogEnabled = false;

		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		get askDialog(): ExtensionUIContext["askDialog"] {
			if (!this.askDialogEnabled) return undefined;
			return (questions, dialogOptions) =>
				requestRpcAskDialog(this.pendingRequests, this.output, questions, dialogOptions);
		}

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
	const onPromptError = (id: string | undefined, command: string) => (promptError: Error) =>
		output(error(id, command, promptError.message));

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		mode: "rpc",
		// Extension-initiated session changes get the same goal quiesce/reattach as the commands below.
		wrapSessionChange: async <T extends { cancelled: boolean }>(
			change: () => Promise<T>,
			{ detachesRun }: { detachesRun: boolean },
		): Promise<T> => {
			await btw.close();
			await goalController.beginSessionChange();
			let result: T | undefined;
			try {
				result = await change();
				return result;
			} finally {
				// Reattaches only if the session actually changed, then re-checks settlement.
				// A change that throws may already have detached the run: count it as detached.
				await goalController.endSessionChange({ detachedRun: detachesRun && result?.cancelled !== true });
				if (result && !result.cancelled) {
					// As for the host's new/switch commands: a detached run never yields, so
					// close the prompts it was answering. Branch and navigation leave a live
					// run streaming to its normal yield.
					if (detachesRun) promptResults.abortOpen();
					void settleWatcher.check();
				}
			}
		},
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
		// Headless hosts get the extension runner's no-op UI: hasUI=false, dialogs resolve to defaults.
		uiContext: headless ? undefined : rpcUiContext,
	});

	// Output all agent events as JSON; prompt results follow the frame that settled them.
	session.subscribe(event => {
		sessionEvents.forward(event);
		// Before the prompt-result and settle reports: a goal continuation decided at this
		// agent_end is scheduled (and reported as pending) before either reads settlement.
		goalController.observe(event);
		promptResults.observe(event);
		settleWatcher.observe(event);
	});
	await goalController.reconcile();
	await goalController.settled();

	// Discriminates a store failure from any other dispose rejection below.
	let persistenceFailure: Error | undefined;
	registerRpcPersistenceSurface(
		session,
		frame => output(frame),
		error => {
			persistenceFailure = error;
		},
	);
	messaging.ready();

	/**
	 * Dispose the session, then end the process. A store failure still latched
	 * at dispose makes `dispose()` reject, and the `notice` frame it emits is
	 * queued on the asynchronous `outputWriter`: drain that writer before exiting
	 * or the client never learns the failure (review 3983906393). The durability
	 * loss is mirrored on stderr and the exit code is nonzero. A dispose
	 * rejection with no latched store failure still surfaces to the caller.
	 */
	const disposeAndExit = async (): Promise<never> => {
		try {
			// The process ends regardless; report an unsaved side answer instead of skipping dispose.
			await btw.close().catch(btwError => {
				const message = toError(btwError).message;
				logger.error(message);
				output({ type: "notice", level: "error", message, source: "btw-history" });
			});
			// Close the realtime call (microphone, socket) before the session it delegates into.
			await liveBridge.stop();
			await messaging.dispose();
			await session.dispose();
		} catch (error) {
			if (!persistenceFailure || error !== persistenceFailure) throw error;
			// The notice frame this failure queued must reach the client before the
			// process ends (review 3983906393).
			await outputWriter.close();
			try {
				if (!process.stderr.write(`${formatPersistenceDurabilityFailure(persistenceFailure.message)}\n`)) {
					const { promise, resolve } = Promise.withResolvers<void>();
					// A closed stream never emits `drain`; resolve on error/close too
					// so an undeliverable mirror cannot strand the exit.
					const settle = (): void => {
						process.stderr.off("drain", settle);
						process.stderr.off("error", settle);
						process.stderr.off("close", settle);
						resolve();
					};
					process.stderr.on("drain", settle);
					process.stderr.on("error", settle);
					process.stderr.on("close", settle);
					await promise;
				}
			} catch {
				// A mirror that cannot be written must not cost the exit code.
			}
			process.exit(1);
		}
		// A failure that already reported and then recovered still leaves its notice
		// queued here, so the success path drains the same queue before it exits.
		await outputWriter.close();
		process.exit(0);
	};

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		await session.refreshSkillsAndCommands();
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();

	const inputGate = new RpcUserInputGate();
	type OrderedUserInput = Extract<RpcCommand, { type: "prompt" | "steer" | "follow_up" | "abort_and_prompt" }>;
	type OrderedInputOutcome = "local" | "cancelled" | "admitted" | "builtin-agent";
	const dispatchOrderedUserInput = (
		command: OrderedUserInput,
		ticket: RpcPromptTicket | undefined,
	): Promise<OrderedInputOutcome> =>
		inputGate.enqueue(async () => {
			const sessionId = session.sessionId;
			const isCurrent = () =>
				inputGate.isCurrent(command) && !shutdownState.requested && session.sessionId === sessionId;
			if (!isCurrent()) return "cancelled";
			let text = command.message;
			let images = command.images;
			const runner = session.extensionRunner;
			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, images, "rpc");
				if (!isCurrent()) return "cancelled";
				if (result.handled) return "local";
				if (result.text !== undefined) text = result.text;
				if (result.images !== undefined) images = result.images;
			}
			if (!isCurrent()) return "cancelled";
			if (!text.trim() && !images?.length) return "local";
			if (command.type === "steer") {
				await session.steer(text, images);
				return "admitted";
			}
			if (command.type === "follow_up") {
				await session.followUp(text, images);
				return "admitted";
			}
			if (command.type === "prompt") {
				if (!ticket) return "cancelled";
				const skillResult = await dispatchRpcSkillPrompt({
					ticket,
					session,
					message: text,
					streamingBehavior: command.streamingBehavior,
					results: promptResults,
					onError: onPromptError(command.id, "prompt"),
					extensionUserMessageTracker,
					images,
					isCurrent,
				});
				if (skillResult === "cancelled") return "cancelled";
				if (skillResult) return "admitted";
				const builtinResult = await executeAcpBuiltinSlashCommand(text, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: commandOutput => output({ type: "command_output", text: commandOutput }),
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
				if (!isCurrent()) return "cancelled";
				if (builtinResult !== false) {
					if (!("prompt" in builtinResult)) {
						if (builtinResult.agentInvoked === true && ticket) {
							void session.waitForIdle().then(
								() => promptResults.settle(ticket),
								(idleError: unknown) =>
									promptResults.fail(
										ticket,
										idleError instanceof Error ? idleError.message : String(idleError),
									),
							);
							return "builtin-agent";
						}
						return "local";
					}
					text = builtinResult.prompt;
				}
			}
			if (!isCurrent() || !ticket) return "cancelled";
			await watchAndReportPromptResult({
				ticket,
				startPrompt: onPromptAdmitted =>
					session.prompt(text, {
						images,
						...(command.type === "prompt" ? { streamingBehavior: command.streamingBehavior } : {}),
						onPromptAdmitted,
					}),
				results: promptResults,
				onError: onPromptError(command.id, command.type),
				extensionUserMessageTracker,
			});
			return "admitted";
		});

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
				// Taken before any dispatch so a builtin that schedules a turn (e.g. `/retry`)
				// cannot start its run ahead of the prompt's event-stream position.
				const ticket = promptResults.begin(id);
				try {
					// Ack after admission, including hooks and skill image preparation, so a
					// queue edit sent after this response finds the message.
					const outcome = await dispatchOrderedUserInput(command, ticket);
					if (outcome === "local") {
						promptResults.discard(ticket);
						return success(id, "prompt", { agentInvoked: false });
					}
					if (outcome === "builtin-agent") return success(id, "prompt", { agentInvoked: true });
					if (outcome === "cancelled") {
						promptResults.settle(ticket);
						return success(id, "prompt");
					}
					return success(id, "prompt");
				} catch (promptSetupError) {
					promptResults.discard(ticket);
					throw promptSetupError;
				}
			}

			case "steer":
			case "follow_up": {
				await dispatchOrderedUserInput(command, undefined);
				return success(id, command.type);
			}

			case "remove_queued_message": {
				if (typeof command.message !== "string") {
					return error(id, "remove_queued_message", "message must be a string");
				}
				if (command.queue !== "steering" && command.queue !== "followUp") {
					return error(id, "remove_queued_message", 'queue must be "steering" or "followUp"');
				}
				return fitRemoveQueuedMessageResponse(
					id,
					session.takeQueuedMessage(command.message, command.queue),
					frameEncoder.maxResponseBytes,
				);
			}

			case "promote_queued_message": {
				if (typeof command.message !== "string") {
					return error(id, "promote_queued_message", "message must be a string");
				}
				return success(id, "promote_queued_message", { promoted: session.promoteQueuedMessage(command.message) });
			}

			case "abort": {
				goalController.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_restore_queue": {
				// Mirrors the TUI Esc restore: withdraw queued user input (including input the run
				// dequeued but never recorded) before aborting, so neither the aborted turn nor
				// abort()'s stranded-queue drain can run it.
				const restored = session.clearQueue({ forInterrupt: true });
				goalController.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return fitAbortAndRestoreQueueResponse(id, restored, frameEncoder.maxResponseBytes);
			}

			case "abort_and_prompt": {
				goalController.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				const ticket = promptResults.begin(id);
				void dispatchOrderedUserInput(command, ticket).then(
					outcome => {
						if (outcome === "cancelled") promptResults.settle(ticket);
						else if (outcome === "local") promptResults.completeLocal(ticket);
					},
					(cause: unknown) => {
						// Already acknowledged: owe the late same-id error and a failed prompt_result.
						const promptError = cause instanceof Error ? cause : new Error(String(cause));
						onPromptError(id, "abort_and_prompt")(promptError);
						promptResults.fail(ticket, promptError.message);
					},
				);
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch":
			case "fork": {
				// Fast refusal before the goal controller voids a waiting continuation;
				// fork() repeats the check after each of its own awaits.
				if (command.type === "fork" && session.isBusyForSnapshot) {
					return error(id, "fork", new SessionBusyError("fork the session").message, "session_busy");
				}
				const requestedModel =
					command.type === "switch_session" ? await resolveRequestedRpcModel(session, command) : undefined;
				// Validation first: a refused change must not cancel the running side question.
				await btw.close();
				await goalController.beginSessionChange();
				let result: RpcSessionChangeResult | undefined;
				try {
					result = await handleRpcSessionChange(session, command, subagentRegistry, requestedModel);
				} catch (err) {
					// fork() refuses when work started while its transition awaited.
					if (err instanceof SessionBusyError) return error(id, command.type, err.message, "session_busy");
					throw err;
				} finally {
					// Branch and fork switch files in-process without detaching a run (fork requires idle).
					await goalController.endSessionChange({
						detachedRun: command.type !== "branch" && command.type !== "fork" && result?.data.cancelled !== true,
					});
					// Respond only once this change's reattach (and any queued ahead of it) has run.
					await goalController.settled();
				}
				if (!result.data.cancelled) {
					inputGate.commitSessionChange(command);
					// `branch` leaves a live run streaming to its normal yield; new/switch detach it.
					if (command.type !== "branch" && command.type !== "fork") promptResults.abortOpen();
					// The detached run publishes no terminal agent_end to settle on.
					void settleWatcher.check();
					await emitAvailableCommandsUpdate();
				}
				return success(id, result.type, result.data);
			}

			case "open_session": {
				const requestedModel = await resolveRequestedRpcModel(session, command);
				const fileBeforeOpen = session.sessionFile;
				await btw.close();
				await goalController.beginSessionChange();
				let result: RpcOpenSessionResult | undefined;
				try {
					result = await openRpcSession(session, command.sessionDir, subagentRegistry, requestedModel);
				} finally {
					// Opening the session that is already open leaves a live run going (see below).
					await goalController.endSessionChange({ detachedRun: session.sessionFile !== fileBeforeOpen });
					// Respond only once this change's reattach (and any queued ahead of it) has run.
					await goalController.settled();
				}
				if (!result.cancelled) {
					inputGate.commitSessionChange(command);
					// Opening the session that is already open switches nothing and leaves a live run
					// going. Any real open (switch or new) changes the file, even when an aliased path
					// reopens a transcript with the same id.
					if (session.sessionFile !== fileBeforeOpen) promptResults.abortOpen();
					void settleWatcher.check();
					await emitAvailableCommandsUpdate();
				}
				return success(id, "open_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				// A goal exit triggered by the last turn restores tools asynchronously; report after it.
				await goalController.settled();
				const queuedMessages = session.getQueuedMessages();
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
					hasPendingAsyncWork: session.hasPendingAsyncWork(),
					// A scheduled goal continuation will start a turn: not settled.
					isSettled: isRpcSessionSettled(session, goalTurnScheduled),
					queuedMessages: { steering: [...queuedMessages.steering], followUp: [...queuedMessages.followUp] },
					todoPhases: session.getTodoPhases(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
					slowModeSupported: session.isSlowModeSupported(),
					slowModeEnabled: session.isSlowModeEnabled(),
					slowModeScope: session.getSlowModeScope(),
					usageLimit: session.getUsageLimitState(),
					messageCount: session.messages.length,
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
					goal: session.getGoalModeState() ?? null,
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

			case "set_slow_mode": {
				// A truthy non-boolean must not flip a persisted global setting.
				if (typeof command.enabled !== "boolean") {
					return error(id, "set_slow_mode", "set_slow_mode requires boolean enabled");
				}
				const supported = session.setSlowMode(command.enabled);
				if (command.enabled && !supported) {
					return error(id, "set_slow_mode", "Slow mode is unavailable for the current model.");
				}
				return success(id, "set_slow_mode", { enabled: session.isSlowModeEnabled() });
			}

			case "goal": {
				try {
					return success(id, "goal", await goalController.handle(command));
				} catch (goalError) {
					return error(id, "goal", goalError instanceof Error ? goalError.message : String(goalError));
				}
			}

			case "set_ask_dialog": {
				rpcUiContext.askDialogEnabled = command.enabled === true;
				return success(id, "set_ask_dialog", { enabled: rpcUiContext.askDialogEnabled });
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "get_entries": {
				try {
					return success(
						id,
						"get_entries",
						selectRpcEntries(
							session.sessionManager.getEntries(),
							session.sessionManager.getLeafId(),
							command.since,
						),
					);
				} catch (err) {
					return error(id, "get_entries", err instanceof Error ? err.message : String(err), "unknown_since");
				}
			}

			case "get_tree": {
				return success(id, "get_tree", {
					tree: session.sessionManager.getTree(),
					leafId: session.sessionManager.getLeafId(),
				});
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

			case "live_start": {
				try {
					return success(
						id,
						"live_start",
						await liveBridge.start({ voice: command.voice, instructions: command.instructions }),
					);
				} catch (err) {
					return error(id, "live_start", err instanceof Error ? err.message : String(err));
				}
			}

			case "live_stop": {
				await liveBridge.stop();
				return success(id, "live_stop");
			}

			case "live_mute": {
				try {
					return success(id, "live_mute", liveBridge.setMuted(command.muted));
				} catch (err) {
					return error(id, "live_mute", err instanceof Error ? err.message : String(err));
				}
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

			case "set_event_filter": {
				const events = command.events;
				if (
					events !== null &&
					(!Array.isArray(events) || !events.every(event => typeof event === "string" && event.length > 0))
				) {
					return error(id, "set_event_filter", "events must be null or an array of non-empty event type strings");
				}
				const messageUpdates = command.messageUpdates === undefined ? "full" : command.messageUpdates;
				if (messageUpdates !== "full" && messageUpdates !== "delta") {
					return error(id, "set_event_filter", 'messageUpdates must be "full" or "delta"');
				}
				return success(id, "set_event_filter", {
					events: sessionEvents.setFilter(events, messageUpdates),
					messageUpdates,
				});
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

			case "cancel_subagent": {
				if (!subagentRegistry) {
					return error(id, "cancel_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return error(id, "cancel_subagent", "`subagentId` must be a non-empty string.");
				}
				try {
					const cancelled = await handleRpcCancelSubagent(subagentRegistry, command.subagentId);
					return success(id, "cancel_subagent", { cancelled });
				} catch (err) {
					return error(id, "cancel_subagent", err instanceof Error ? err.message : String(err));
				}
			}

			case "steer_subagent": {
				if (!subagentRegistry) {
					return error(id, "steer_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return error(id, "steer_subagent", "`subagentId` must be a non-empty string.");
				}
				if (typeof command.message !== "string" || !command.message.trim()) {
					return error(id, "steer_subagent", "`message` is required for steer_subagent.");
				}
				const failure = await handleRpcSteerSubagent(subagentRegistry, command.subagentId, command.message);
				return failure ? error(id, "steer_subagent", failure) : success(id, "steer_subagent");
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const model = await findRpcModel(session, command.provider, command.modelId);
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

			case "get_available_thinking_levels": {
				// Pi-compatible discovery: the selectable levels for the live model,
				// including `off` (which `set_thinking_level` accepts but the
				// effort-only helper excludes). OMP-only `auto`/`inherit` are
				// intentionally omitted — that selector stays an OMP dialect.
				return success(id, "get_available_thinking_levels", {
					levels: [ThinkingLevel.Off, ...session.getAvailableThinkingLevels()],
				});
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				applyRpcQueueModeCommand(session, command);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				applyRpcQueueModeCommand(session, command);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				applyRpcQueueModeCommand(session, command);
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

			// =================================================================
			// Cache warming
			// =================================================================

			case "set_cache_warming": {
				if (!CACHE_WARMING_MODES.includes(command.mode)) {
					return error(id, "set_cache_warming", `Invalid cache warming mode: ${String(command.mode)}`);
				}
				const mode = session.setCacheWarmingMode(command.mode);
				return success(id, "set_cache_warming", { mode });
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
					authenticated:
						session.modelRegistry.authStorage.keys.source(provider.storeCredentialsAs ?? provider.id) !==
						undefined,
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
					await session.modelRegistry.authStorage.oauth.login(command.providerId, {
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
							if (prompt.secret) {
								throw new Error(
									`Provider '${command.providerId}' requires secret input, ` +
										"which is not supported in RPC mode. Use the terminal UI to log in.",
								);
							}
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
					await session.modelRegistry.refreshProvider(
						knownProvider.storeCredentialsAs ?? knownProvider.id,
						"online",
					);
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_logout_accounts": {
				// An absent provider would list every provider's credentials.
				if (typeof command.providerId !== "string") {
					return error(id, "get_logout_accounts", "providerId must be a string");
				}
				const accounts = await listLogoutAccounts(
					session.modelRegistry.authStorage,
					command.providerId,
					session.sessionId,
				);
				return success(id, "get_logout_accounts", { accounts });
			}

			case "logout": {
				if (typeof command.providerId !== "string" || !Number.isInteger(command.credentialId)) {
					return error(id, "logout", "providerId must be a string and credentialId an integer");
				}
				const { removed, remainingSource } = await logoutCredential(
					session.modelRegistry,
					command.providerId,
					command.credentialId,
					session.sessionId,
				);
				if (!removed) {
					return error(id, "logout", `Credential ${command.credentialId} is not stored for ${command.providerId}`);
				}
				return success(id, "logout", { remainingSource });
			}

			// =================================================================
			// Side questions (/btw)
			// =================================================================

			case "btw": {
				const record = await btw.ask(command.question, command.recordId);
				return success(id, "btw", { record });
			}

			case "btw_cancel":
				return success(id, "btw_cancel", { cancelled: btw.cancel(command.recordId) });

			case "get_btw_history":
				return success(id, "get_btw_history", { records: await btw.history() });

			// =================================================================
			// Word prediction
			// =================================================================

			case "predict_word": {
				if (!isTextCursor(command.text, command.cursor)) {
					return error(id, "predict_word", INVALID_TEXT_CURSOR_ERROR);
				}
				try {
					const method = cfgSpellingAutocomplete.get(session.settings);
					const suffix = await wordPredictor.predict(method, command.text, command.cursor);
					return success(id, "predict_word", { suffix });
				} catch (err: unknown) {
					return error(id, "predict_word", err instanceof Error ? err.message : String(err));
				}
			}

			case "predict_word_feedback": {
				if (!isTextCursor(command.text, command.cursor)) {
					return error(id, "predict_word_feedback", INVALID_TEXT_CURSOR_ERROR);
				}
				if (typeof command.suggestion !== "string" || typeof command.accepted !== "boolean") {
					return error(id, "predict_word_feedback", "suggestion must be a string and accepted a boolean");
				}
				const method = cfgSpellingAutocomplete.get(session.settings);
				if (method !== "off") {
					const query = wordQueryAt(command.text, command.cursor);
					if (query) {
						textPredictionBackend(method).feedback(
							query.before,
							query.prefix,
							command.suggestion,
							command.accepted,
						);
					}
				}
				return success(id, "predict_word_feedback");
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
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
			await disposeAndExit();
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
		acceptInput: command => inputGate.accept(command),
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
	await liveBridge.stop();
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	subagentRegistry?.dispose();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately. Returned rather than awaited: `runRpcMode` is typed
	// `Promise<never>`, and only returning the `Promise<never>` keeps this end
	// point unreachable for the compiler.
	return disposeAndExit();
}
