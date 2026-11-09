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
 *
 * The command implementation itself lives in `rpc-command-surface.ts`, shared
 * with the socket transport an interactive session publishes. This module owns
 * only the stdio transport, the session-level services that surface needs, and
 * stdin/stdout lifecycle.
 */
import * as fs from "node:fs";
import { $env, isRecord, logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { theme, type Theme } from "@oh-my-pi/pi-tui/theme";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import type { MCPManager } from "../../mcp/manager";
import type { AgentSession } from "../../session/agent-session";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate } from "./host-tools";
import { RpcClientConnection, RpcClientRegistry } from "./client-connection";
import { isRpcHostUriResult } from "./host-uris";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import {
	requestRpcAskDialog,
	requestRpcConfirm,
	requestRpcDialog,
	requestRpcEditor,
	requestRpcInput,
	requestRpcSelect,
} from "./rpc-dialog-requests";
import { RpcBtwController } from "./rpc-btw";
import { loginOverRpc } from "./rpc-login";
import { RpcDictationBridge, type RpcDictationControllerFactory } from "./rpc-dictation";
import { RpcGoalController } from "./rpc-goal";
import { RpcLiveBridge, type RpcLiveSessionFactory } from "./rpc-live";
import { RpcOutputWriter } from "./rpc-output";
import { RpcExtensionUserMessageTracker, RpcPromptResults } from "./rpc-prompt-results";
import { RpcSessionEventForwarder } from "./rpc-session-events";
import type { RpcSessionSocket } from "./rpc-socket";
import { RpcSessionSettleWatcher, watchedScheduledTurnProbe } from "./rpc-session-settle";
import { RpcSubagentRegistry } from "./rpc-subagents";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriResult,
	RpcResponse,
} from "./rpc-types";
import {
	type PendingExtensionRequest,
	applyRpcQueueModeCommand,
	dispatchRpcSkillPrompt,
	fitAbortAndRestoreQueueResponse,
	fitRemoveQueuedMessageResponse,
	handleRpcCancelSubagent,
	handleRpcSessionChange,
	handleRpcSteerSubagent,
	isRpcExtensionUIResponse,
	openRpcSession,
	type RpcCommandSurface,
	RpcCommandSurface as RpcCommandSurfaceClass,
	type RpcHostCommandServices,
	RpcPendingExtensionRequests,
	type RpcQueueModeCommand,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
	type RpcSkillCommandResult,
	type RpcSkillCommandSession,
	type RpcSkillInvocation,
	type RpcOpenSessionSession,
	type RpcSubagentResetRegistry,
	type RpcOutput,
	RpcUserInputGate,
	RpcWordPredictor,
	publishSessionSocket,
	resolveRpcSkillInvocation,
	runRpcSkillCommand,
	tryRunRpcSkillCommand,
} from "./rpc-command-surface";
import {
	formatPersistenceDurabilityFailure,
	formatPersistenceFailure,
	formatPersistenceNotice,
} from "../persistence-failure";

// Re-export types for consumers
export type * from "./rpc-types";

export type {
	PendingExtensionRequest,
	RpcOpenSessionSession,
	RpcQueueModeCommand,
	RpcSessionChangeCommand,
	RpcSessionChangeResult,
	RpcSessionChangeSession,
	RpcSkillCommandResult,
	RpcSkillCommandSession,
	RpcSkillInvocation,
	RpcSubagentResetRegistry,
};
export {
	applyRpcQueueModeCommand,
	dispatchRpcSkillPrompt,
	fitAbortAndRestoreQueueResponse,
	fitRemoveQueuedMessageResponse,
	handleRpcCancelSubagent,
	handleRpcSessionChange,
	handleRpcSteerSubagent,
	openRpcSession,
	requestRpcAskDialog,
	requestRpcConfirm,
	requestRpcDialog,
	requestRpcEditor,
	requestRpcInput,
	requestRpcSelect,
	RpcPendingExtensionRequests,
	RpcUserInputGate,
	RpcWordPredictor,
	resolveRpcSkillInvocation,
	runRpcSkillCommand,
	tryRunRpcSkillCommand,
};

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

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed as RpcExtensionUIResponse);
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
 * starting or a long serial command; `abort_branch_summary` likewise overtakes
 * the `navigate_tree` whose summary it stops.
 * A Set, not a Record: `type` is untrusted input and must not hit prototype keys.
 */
const BACKGROUND_COMMANDS: ReadonlySet<string> = new Set<RpcCommand["type"]>([
	"bash",
	"predict_word",
	"live_start",
	"live_connect",
	"btw_cancel",
	"abort_branch_summary",
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
 * behind a keystroke. `live_start`, `live_connect` and `dictation_start` respond only once
 * connected or recording, so they are backgrounded and their stop commands can cancel them.
 * Response correlation is preserved via each command's `id`; ordering across
 * concurrent commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`, `predict_word`, `live_start`, `live_connect`, `dictation_start`, `prompt`, `steer`, `follow_up`, `steer_subagent`). Otherwise a promise that
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
		command.type === "dictation_start" ||
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

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
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
	subagentEventBus?: import("../../utils/event-bus").EventBus;
	input?: ReadableStream<Uint8Array>;
	/** Builds `live_start` sessions; defaults to the real {@link LiveSessionController}. */
	createLiveSession?: RpcLiveSessionFactory;
	/** Builds the native speech controller; tests may substitute the capture boundary. */
	createDictationController?: RpcDictationControllerFactory;
	/** The session's MCP manager, so `/mcp` builtins resolve and reconnect live servers. */
	mcpManager?: MCPManager;
	/**
	 * Session endpoint published for external attachment. Constructed at the
	 * shared `main.ts` mount point; this runner supplies the command surface and
	 * starts it. Absent in embedded hosts and tests that serve stdio only.
	 */
	sessionSocket?: RpcSessionSocket;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession, options: RpcModeOptions = {}): Promise<never> {
	const {
		setToolUIContext,
		headless = false,
		subagentEventBus,
		input = claimRpcInput(),
		createLiveSession,
		createDictationController,
		sessionSocket,
	} = options;
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
	// The writer can fail before the bridge is constructed.
	let dictationBridge: RpcDictationBridge | undefined = undefined;
	const outputWriter = new RpcOutputWriter(stdout, failure => {
		logger.error("RPC output delivery failed", { error: String(failure) });
		dictationBridge?.dispose();
		void session.dispose().finally(() => process.exit(1));
	});
	outputWriter.write(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			supportsBashExcludeFromContext: true,
		}),
	);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		outputWriter.write(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};
	const clients = new RpcClientRegistry();
	const stdioClient = new RpcClientConnection({ id: "stdio", send: output });
	clients.register(stdioClient);
	// Extension UI goes to one UI-capable client; every other frame keeps its transport-wide sink.
	const uiOutput: RpcOutput = frame => {
		if (isRecord(frame) && frame.type === "extension_ui_request") {
			clients.sendUi(frame);
			return;
		}
		output(frame);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();
	const btw = new RpcBtwController(session, output);
	// A continuation abandoned while waiting leaves nothing to end the activity stretch: re-check settlement.
	const goalController = new RpcGoalController(session, () => void settleWatcher.check());
	// A scheduled or held goal turn will start a turn: every settle report treats it as busy,
	// and any report of "not settled" for that reason is later closed by `session_settled`.
	const goalTurnScheduled = watchedScheduledTurnProbe(
		() => goalController.continuationPending,
		() => settleWatcher,
	);
	const settleWatcher = new RpcSessionSettleWatcher(session, output, goalTurnScheduled);
	const promptResults = new RpcPromptResults(session, output, goalTurnScheduled, {
		costCapRefusal: () => session.costCapRefusal,
		settledWithoutRun: () => void settleWatcher.check(),
	});
	const sessionEvents = new RpcSessionEventForwarder(output);

	const pendingExtensionRequests = new RpcPendingExtensionRequests(() => clients.activeUiConn());
	// Live frames go straight to `output`, so `set_event_filter` (session events only) never drops them.
	const liveBridge = new RpcLiveBridge(session, output, createLiveSession);
	let lastDictationError: { message: string } | undefined;
	const sessionDictationBridge = new RpcDictationBridge(
		session,
		frame => {
			output(frame);
			if (frame.type === "dictation_end" && frame.error) lastDictationError = { message: frame.error };
		},
		createDictationController,
	);
	dictationBridge = sessionDictationBridge;
	const stopDictationForSessionChange = async (): Promise<void> => {
		const previousError = lastDictationError;
		try {
			await sessionDictationBridge.stop();
		} catch (cause) {
			// Only a reported transcription failure after cleanup may leave the change proceeding.
			if (
				sessionDictationBridge.active ||
				!lastDictationError ||
				lastDictationError === previousError ||
				!(cause instanceof Error) ||
				cause.message !== lastDictationError.message
			)
				throw cause;
			logger.warn("Dictation failed while changing sessions", { error: String(cause) });
		}
	};
	let sessionChangesInProgress = 0;
	const withSessionChange = async <T>(change: () => Promise<T>): Promise<T> => {
		sessionChangesInProgress++;
		try {
			const result = await change();
			// The endpoint is named by the session it publishes; a switch or resume to
			// another session must move it, while attached connections stay attached.
			try {
				await sessionSocket?.rebind();
			} catch (rebindError) {
				logger.warn("RPC session socket rebind failed", { error: String(rebindError) });
			}
			return result;
		} finally {
			sessionChangesInProgress--;
		}
	};
	// Each attached view (the stdio client and any socket client) filters its own
	// subscription; the registry emits at the union so nothing leaks between views.
	const subagentRegistry = subagentEventBus
		? new RpcSubagentRegistry(subagentEventBus, frame => clients.broadcastSubagent(frame))
		: undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		readonly supportsEditor = true;
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
			return requestRpcConfirm(this.pendingRequests, this.output, title, message, dialogOptions);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcInput(this.pendingRequests, this.output, title, placeholder, dialogOptions);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		rerenderMessage(): void {
			// No transcript is drawn in RPC mode
		}

		refreshTranscript(): void {
			// No transcript is drawn in RPC mode
		}

		getLinkClicksAvailable(): boolean {
			return false;
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

		getEditorComponent() {
			return undefined;
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, uiOutput);
	setToolUIContext?.(rpcUiContext, true);
	const setAskDialog = (command: RpcCommand & { type: "set_ask_dialog" }): RpcResponse => {
		rpcUiContext.askDialogEnabled = command.enabled === true;
		return {
			id: command.id,
			type: "response",
			command: "set_ask_dialog",
			success: true,
			data: { enabled: rpcUiContext.askDialogEnabled },
		};
	};
	/**
	 * `login` needs the extension UI context of this transport (browser URL,
	 * prompt input), so it stays with the stdio runner and reaches the shared
	 * command surface as a host service.
	 */
	const loginViaRpc = (command: RpcCommand & { type: "login" }): Promise<RpcResponse> =>
		loginOverRpc({ session, command, pendingExtensionRequests, output: uiOutput });

	// Read stdin from now on: `session_start` may be waiting on a dialog only the client can answer. Until the
	// command loop below exists, a dialog answer and the ask-dialog opt-in are handled at once and every other
	// frame is held, in arrival order, for that loop.
	let heldFrames: unknown[] | undefined = [];
	const receiveFrame = (parsed: unknown): void => {
		if (!heldFrames) {
			inputDispatcher.dispatch(parsed);
		} else if (isRpcExtensionUIResponse(parsed)) {
			pendingExtensionRequests.get(parsed.id)?.resolve(parsed as RpcExtensionUIResponse);
		} else if (isRecord(parsed) && parsed.type === "set_ask_dialog") {
			output(setAskDialog(parsed as RpcCommand & { type: "set_ask_dialog" }));
		} else {
			heldFrames.push(parsed);
		}
	};
	// A transport error during startup must not be an unhandled rejection; the final await below still throws it.
	// Input ending while startup still runs means no client is left to answer a dialog it awaits: reject them.
	const inputRead = readRpcInputFrames(input, receiveFrame, message =>
		output({ id: undefined, type: "response", command: "parse", success: false, error: message }),
	);
	const rejectStartupDialogs = (): void => {
		if (heldFrames) pendingExtensionRequests.rejectAll("RPC client disconnected during startup");
	};
	inputRead.then(rejectStartupDialogs, rejectStartupDialogs);

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		mode: "rpc",
		// Extension-initiated session changes get the same goal quiesce/reattach as the commands below.
		wrapSessionChange: <T extends { cancelled: boolean }>(
			change: () => Promise<T>,
			{ detachesRun }: { detachesRun: boolean },
		): Promise<T> =>
			withSessionChange(async () => {
				await stopDictationForSessionChange();
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
			}),
		reportSendError: (action, err) => {
			output({ id: undefined, type: "response", command: action, success: false, error: err.message });
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
			dictationBridge.dispose();
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		// Headless hosts get the extension runner's no-op UI: hasUI=false, dialogs resolve to defaults.
		uiContext: headless ? undefined : rpcUiContext,
	});

	// Output all agent events as JSON; prompt results follow the frame that settled them.
	session.subscribe(event => sessionEvents.forward(event));
	const host: RpcHostCommandServices = {
		goal: goalController,
		settleWatcher,
		btw,
		live: liveBridge,
		dictation: sessionDictationBridge,
		sessionEvents,
		subagents: subagentRegistry,
		mcpManager: options.mcpManager,
		scheduledTurnPending: goalTurnScheduled,
		isSessionChanging: () => sessionChangesInProgress > 0,
		isShuttingDown: () => shutdownState.requested,
		stopDictationForSessionChange,
		withSessionChange,
		setAskDialog,
		login: loginViaRpc,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
	};
	const surface: RpcCommandSurface = new RpcCommandSurfaceClass({
		session,
		output,
		clients,
		defaultConn: stdioClient,
		maxResponseBytes: () => frameEncoder.maxResponseBytes,
		pendingExtensionRequests,
		promptResults,
		extensionUserMessageTracker,
		host,
	});
	surface.start();
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
	await surface.emitAvailableCommandsUpdate();

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
			dictationBridge.dispose();
			await liveBridge.stop();
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
		handleCommand: command => surface.handleCommand(command),
		output,
		errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => surface.hostToolBridge.handleResult(frame, stdioClient),
		onHostToolUpdate: frame => surface.hostToolBridge.handleUpdate(frame, stdioClient),
		onHostUriResult: frame => surface.hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
		acceptInput: command => surface.acceptInput(command),
	});

	const detachSessionSocket = sessionSocket ? await publishSessionSocket(sessionSocket, surface) : undefined;

	// Startup is over: run the frames held back meanwhile, then every later frame, through the dispatcher.
	// Side-channel frames dispatch immediately, ordinary commands serialize through inputDispatcher, and bash
	// remains background-dispatched so abort_bash can overtake it. readRpcInputFrames reads line-by-line so a
	// single malformed line is reported as an error frame and the loop keeps running instead of throwing out of
	// the reader and killing the whole process (issue #5194).
	const held = heldFrames;
	heldFrames = undefined;
	for (const parsed of held) inputDispatcher.dispatch(parsed);
	await inputRead;

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	stdioClient.close();
	// Dropping the connection drops its tools from the merged union the session can call.
	await session.refreshRpcHostTools(
		surface.hostToolBridge.removeClient(stdioClient, "RPC client disconnected before host tool execution completed"),
	);
	surface.hostUriBridge.clear("RPC client disconnected before host URI request completed");
	dictationBridge.dispose();
	await liveBridge.stop();
	await inputDispatcher.drain();
	// A backgrounded builtin (e.g. a /mcp reauth browser wait) must not park
	// the drain: tear it down now that the client is gone.
	surface.abortBuiltinCommands("RPC client disconnected");
	detachSessionSocket?.();
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
