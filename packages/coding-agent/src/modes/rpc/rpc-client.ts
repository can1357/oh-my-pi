/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { isPromise } from "node:util/types";
import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { isRecord, logger, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import type { FileSink } from "bun";
import type { BashResult } from "../../exec/bash-executor";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { BtwHistoryRecord } from "../../session/btw-history";
import type { CacheWarmingMode } from "../../session/cache-warmer";
import type { SessionEntry, SessionTreeNode } from "../../session/session-entries";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, type RpcProtocolVersion } from "./rpc-frame";
import type { RpcGoalOp, RpcGoalResult } from "./rpc-goal";
import {
	RPC_MESSAGES_PAGE_BUSY_ERROR,
	RPC_MESSAGES_PAGE_STALE_ERROR,
	type RpcMessagesPage,
	type RpcMessagesPageOptions,
} from "./rpc-messages";
import type {
	RpcAbortAndRestoreQueueResult,
	RpcAvailableCommandsUpdateFrame,
	RpcBtwDeltaFrame,
	RpcBtwRecordFrame,
	RpcAvailableSlashCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHandoffResult,
	RpcHostFrame,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcLiveFrame,
	RpcOpenSessionResult,
	RpcPreconditions,
	RpcPromptResultFrame,
	RpcRemoveQueuedMessageResult,
	RpcResponse,
	RpcSessionSettledFrame,
	RpcSessionState,
	RpcSubagentEventFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

/** Process transport consumed by {@link RpcClient}. */
export interface RpcAgentProcess {
	stdin: {
		write(data: string | Uint8Array): unknown;
	};
	stdout: ReadableStream<Uint8Array>;
	peekStderr(): string;
	kill(signal?: Parameters<ptree.ChildProcess["kill"]>[0], graceMs?: number): void;
	exited: Promise<number>;
	/**
	 * Protocol version the transport already established before `ready` (a
	 * session host `hello` with `protocolVersion: 2`). Frames may arrive v2
	 * chunked from the first one, and `start()` skips `negotiate_protocol`.
	 */
	protocolVersion?: RpcProtocolVersion;
}

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: `dist/cli.js`). */
	cliPath?: string;
	/**
	 * Agent launcher override. An argv prefix receives the normal RPC/model args
	 * appended; a builder receives those args and returns the complete argv.
	 * Builders support transports such as SSH that must quote the final argv.
	 * Ignored when {@link spawn} is provided.
	 */
	command?: string[] | ((agentArgs: string[]) => string[]);
	/**
	 * Spawn the RPC agent over a custom transport instead of a local child process.
	 * Takes precedence over {@link command}.
	 */
	spawn?: (agentArgs: string[]) => RpcAgentProcess | Promise<RpcAgentProcess>;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Session directory for the agent */
	sessionDir?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Grace period before escalating process termination (default: process utility default, 1000ms) */
	terminationGraceMs?: number;
	/** Custom tools owned by the embedding host and exposed over the RPC transport */
	customTools?: RpcClientCustomTool[];
}

export type RpcEventListener = (event: AgentEvent) => void;
export type RpcSessionEventListener = (event: AgentSessionEvent) => void;
export type RpcSubagentLifecycleListener = (payload: RpcSubagentLifecycleFrame["payload"]) => void;
export type RpcSubagentProgressListener = (payload: RpcSubagentProgressFrame["payload"]) => void;
export type RpcSubagentEventListener = (payload: RpcSubagentEventFrame["payload"]) => void;
export type RpcAvailableCommandsUpdateListener = (commands: RpcAvailableSlashCommand[]) => void;
export type RpcPromptResultListener = (result: RpcPromptResultFrame) => void;
export type RpcSessionSettledListener = () => void;
/** Receives every session-host frame; see {@link RpcClient.onHostFrame}. */
export type RpcHostFrameListener = (frame: RpcHostFrame) => void;
/** Receives the error that ended an established transport; see {@link RpcClient.onClose}. */
export type RpcCloseListener = (error: Error) => void;
/** Receives each `extension_ui_request` the host sends; see {@link RpcClient.onExtensionUiRequest}. */
export type RpcExtensionUiRequestListener = (request: RpcExtensionUIRequest) => void;
export type RpcLiveListener = (frame: RpcLiveFrame) => void;

export interface RpcClientToolContext<TDetails = unknown> {
	toolCallId: string;
	signal: AbortSignal;
	sendUpdate(partialResult: RpcClientToolResult<TDetails>): void;
}

export type RpcClientToolResult<TDetails = unknown> = AgentToolResult<TDetails> | string;

export interface RpcClientCustomTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
> extends Omit<RpcHostToolDefinition, "parameters"> {
	parameters: Record<string, unknown>;
	execute(
		params: TParams,
		context: RpcClientToolContext<TDetails>,
	): Promise<RpcClientToolResult<TDetails>> | RpcClientToolResult<TDetails>;
}

export function defineRpcClientTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
>(tool: RpcClientCustomTool<TParams, TDetails>): RpcClientCustomTool<TParams, TDetails> {
	return tool;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_stream_update",
	"tool_execution_end",
]);

const sessionEventTypes = new Set<AgentSessionEvent["type"]>([
	...agentEventTypes,
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"cache_warming_start",
	"cache_warming_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"model_changed",
	"goal_updated",
	"queue_update",
]);

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "response") return false;
	if (typeof value.command !== "string") return false;
	if (typeof value.success !== "boolean") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.success === false) {
		return typeof value.error === "string";
	}
	return true;
}

function supportsRpcProtocolV2(value: Record<string, unknown>): boolean {
	return (
		value.type === "ready" &&
		Array.isArray(value.supportedProtocolVersions) &&
		value.supportedProtocolVersions.includes(2) &&
		value.maxFrameBytes === MAX_RPC_FRAME_BYTES &&
		value.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES
	);
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return agentEventTypes.has(type as AgentEvent["type"]);
}

function isAgentSessionEvent(value: unknown): value is AgentSessionEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return sessionEventTypes.has(type as AgentSessionEvent["type"]);
}

function isRpcSubagentLifecycleFrame(value: unknown): value is RpcSubagentLifecycleFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_lifecycle" && isRecord(value.payload);
}

function isRpcSubagentProgressFrame(value: unknown): value is RpcSubagentProgressFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_progress" && isRecord(value.payload);
}

function isRpcSubagentEventFrame(value: unknown): value is RpcSubagentEventFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_event" && isRecord(value.payload);
}

function isRpcPromptResultFrame(value: unknown): value is RpcPromptResultFrame {
	if (!isRecord(value)) return false;
	return value.type === "prompt_result" && typeof value.agentInvoked === "boolean";
}

function isRpcSessionSettledFrame(value: unknown): value is RpcSessionSettledFrame {
	return isRecord(value) && value.type === "session_settled";
}

const LIVE_FRAME_TYPES: Record<string, true> = {
	live_phase: true,
	live_levels: true,
	live_transcript: true,
	live_end: true,
};

function isRpcLiveFrame(value: unknown): value is RpcLiveFrame {
	return isRecord(value) && typeof value.type === "string" && Object.hasOwn(LIVE_FRAME_TYPES, value.type);
}

function isRpcAvailableCommandsUpdateFrame(value: unknown): value is RpcAvailableCommandsUpdateFrame {
	if (!isRecord(value)) return false;
	return value.type === "available_commands_update" && Array.isArray(value.commands);
}

function isRpcBtwDeltaFrame(value: unknown): value is RpcBtwDeltaFrame {
	return (
		isRecord(value) &&
		value.type === "btw_delta" &&
		typeof value.recordId === "string" &&
		typeof value.delta === "string"
	);
}

function isRpcBtwRecordFrame(value: unknown): value is RpcBtwRecordFrame {
	return isRecord(value) && value.type === "btw_record" && isRecord(value.record);
}

/** The wire fields a session-host consumer reads; a frame missing one is not delivered rather than half-applied. */
function isSessionHostFrame(value: unknown): value is RpcHostFrame {
	if (!isRecord(value)) return false;
	switch (value.type) {
		case "attached":
			return (
				typeof value.hostId === "string" &&
				typeof value.clientId === "string" &&
				typeof value.epoch === "number" &&
				typeof value.seq === "number" &&
				isRecord(value.snapshot)
			);
		case "resumed":
			return typeof value.epoch === "number" && typeof value.replayed === "number";
		case "entry":
			return (
				isRecord(value.entry) &&
				typeof value.seq === "number" &&
				(value.leafId === undefined || value.leafId === null || typeof value.leafId === "string")
			);
		case "session_replaced":
			return typeof value.epoch === "number" && typeof value.seq === "number" && isRecord(value.snapshot);
		case "clients_changed":
			return Array.isArray(value.clients) && typeof value.seq === "number";
		case "command_output":
			return typeof value.text === "string";
		case "config_update":
			return (
				(value.model === undefined || isRecord(value.model)) &&
				(value.thinkingLevel === undefined || typeof value.thinkingLevel === "string")
			);
		case "session_info_update":
			return (
				typeof value.sessionId === "string" &&
				(value.title === undefined || typeof value.title === "string") &&
				(value.origin === undefined ||
					(isRecord(value.origin) &&
						typeof value.origin.cwd === "string" &&
						(value.origin.artifactsDir === null || typeof value.origin.artifactsDir === "string") &&
						typeof value.origin.localRoot === "string" &&
						typeof value.origin.sessionId === "string"))
			);
		default:
			return false;
	}
}

function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_tool_call" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments)
	);
}

function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_tool_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

function normalizeToolResult<TDetails>(result: RpcClientToolResult<TDetails>): AgentToolResult<TDetails> {
	if (typeof result === "string") {
		return {
			content: [{ type: "text", text: result }],
		};
	}
	return result;
}

/** Failed RPC command; `code` mirrors the server's machine-readable error code when present. */
export class RpcCommandError extends Error {
	/** `stale`: the host's current session epoch. */
	readonly epoch?: number;
	/** `stale`: the host's current session leaf. */
	readonly leafId?: string | null;
	/** `session_hosted`: the host that owns the requested session. */
	readonly hostId?: string;

	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
		details: { epoch?: number; leafId?: string | null; hostId?: string } = {},
	) {
		super(message);
		this.name = "RpcCommandError";
		this.epoch = details.epoch;
		this.leafId = details.leafId;
		this.hostId = details.hostId;
	}
}

/** True when a high-level `getMessages()` drain should discard partial pages and fall back to `get_messages`. */
function isPageFallbackError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof RpcCommandError && (error.code === "session_busy" || error.code === "stale_cursor"))
		return true;
	return error.message === RPC_MESSAGES_PAGE_BUSY_ERROR || error.message === RPC_MESSAGES_PAGE_STALE_ERROR;
}

/**
 * The write guard to put on a command: exactly `ifEpoch`/`ifLeaf`, each only when set. A caller's object may be a
 * structural subtype with more keys (`type`, `message`, `level`, ...), and those must never reach the command.
 */
function writeGuard(preconditions: RpcPreconditions | undefined): RpcPreconditions {
	const guard: RpcPreconditions = {};
	if (preconditions?.ifEpoch !== undefined) guard.ifEpoch = preconditions.ifEpoch;
	if (preconditions?.ifLeaf !== undefined) guard.ifLeaf = preconditions.ifLeaf;
	return guard;
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	#process: RpcAgentProcess | null = null;
	#reaping: Promise<void> | null = null;
	#eventListeners: RpcEventListener[] = [];
	#sessionEventListeners: RpcSessionEventListener[] = [];
	#subagentLifecycleListeners = new Set<RpcSubagentLifecycleListener>();
	#subagentProgressListeners = new Set<RpcSubagentProgressListener>();
	#subagentEventListeners = new Set<RpcSubagentEventListener>();
	#availableCommandsUpdateListeners = new Set<RpcAvailableCommandsUpdateListener>();
	#btwDeltaListeners = new Set<(frame: RpcBtwDeltaFrame) => void>();
	#btwRecordListeners = new Set<(record: BtwHistoryRecord) => void>();
	#promptResultListeners = new Set<RpcPromptResultListener>();
	#sessionSettledListeners = new Set<RpcSessionSettledListener>();
	#hostFrameListeners = new Set<RpcHostFrameListener>();
	#closeListeners = new Set<RpcCloseListener>();
	#liveListeners = new Set<RpcLiveListener>();
	/** `promptAndWait` completions keyed by request id; registered before the prompt is sent. */
	#promptResultWaiters = new Map<string, (result: RpcPromptResultFrame) => void>();
	/** Same-id failures that arrive after the success ack removed the pending request. */
	#promptErrorWaiters = new Map<string, (error: Error) => void>();
	#pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	#customTools: RpcClientCustomTool[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#requestId = 0;
	#protocolVersion: RpcProtocolVersion = 1;
	#extensionUiListeners: Set<RpcExtensionUiRequestListener> = new Set();
	#abortController = new AbortController();

	constructor(private options: RpcClientOptions = {}) {
		this.#customTools = [...(options.customTools ?? [])];
	}

	/**
	 * Start the RPC agent process.
	 *
	 * Safe to call again after {@link stop} on the same instance: a fresh
	 * {@link AbortController} is minted for each start, and any failure after
	 * the child spawn kills the child and clears internal state so callers may
	 * retry without leaking processes.
	 */
	async start(): Promise<void> {
		await this.#reaping;
		if (this.#process) {
			throw new Error("Client already started");
		}

		// Mint a fresh controller so a previous stop()'s abort does not
		// short-circuit the new stdout reader (issue #4079).
		this.#abortController = new AbortController();
		this.#protocolVersion = 1;

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.sessionDir) {
			args.push("--session-dir", this.options.sessionDir);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}
		const child = this.options.spawn
			? await this.options.spawn(args)
			: ptree.spawn(
					typeof this.options.command === "function"
						? this.options.command(args)
						: [...(this.options.command ?? ["bun", cliPath]), ...args],
					{
						cwd: this.options.cwd,
						env: { ...Bun.env, ...this.options.env },
						stdin: "pipe",
					},
				);
		this.#process = child;

		// Wait for the "ready" signal or process exit
		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;
		let protocolV2Supported = false;
		// A transport that established v2 can chunk the frames right behind `ready`.
		let protocolV2Enabled = "protocolVersion" in child && child.protocolVersion === 2;
		const frameDecoder = new RpcFrameDecoder();
		// True once start() has completed (ready, protocol negotiation, custom tools). `readySettled` flips earlier
		// than that, and a transport that fails during the rest of startup makes start() reject instead.
		let established = false;

		/** Tear down `child`'s client state after its output ended; `onClose` listeners hear of it only for an established session. */
		const reapAfterOutputFailure = async (error: Error) => {
			if (this.#process !== child) return;
			const notifyClose = established;

			this.#process = null;
			this.#abortController.abort(error);
			this.#rejectPromptWaiters(error);
			const pendingRequests = Array.from(this.#pendingRequests.values());
			this.#pendingRequests.clear();
			for (const pendingCall of this.#pendingHostToolCalls.values()) pendingCall.controller.abort(error);
			this.#pendingHostToolCalls.clear();

			try {
				child.kill(undefined, this.options.terminationGraceMs);
			} catch {
				// The process may already have exited.
			}
			await this.#waitForExit(child);
			for (const request of pendingRequests) request.reject(error);
			if (!notifyClose) return;
			for (const listener of this.#closeListeners) {
				try {
					listener(error);
				} catch (listenerError) {
					logger.warn("RPC close listener failed", { error: String(listenerError) });
				}
			}
		};

		// Process lines in background, intercepting the ready signal.
		const lines = readJsonl(child.stdout, this.#abortController.signal);
		void (async () => {
			for await (const line of lines) {
				if (!readySettled && isRecord(line) && line.type === "ready") {
					protocolV2Supported = supportsRpcProtocolV2(line);
					readySettled = true;
					readyResolve();
					continue;
				}
				if (isRecord(line) && line.type === "rpc_chunk" && !protocolV2Enabled)
					throw new Error("RPC chunk received before protocol negotiation");
				const decoded = frameDecoder.push(line);
				if (decoded) this.#handleLine(decoded);
			}
			// A closed stdout is terminal even if the child remains alive. Startup
			// failures are reaped by the readyPromise catch below; established
			// workers are reaped here so pending requests cannot hang indefinitely.
			if (!readySettled) {
				// Stdout can close before the exit reaper finishes draining stderr.
				// child.exited settles only after the stderr tail is complete (for
				// nonzero exits), so give it a bounded head start: the exit watcher
				// below was registered first and rejects with the real stderr text
				// instead of an empty "Stderr:" (flaked under full-suite load).
				await Promise.race([child.exited.catch(() => {}), Bun.sleep(250)]);
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent output stream ended before ready. Stderr: ${child.peekStderr()}`));
				return;
			}
			const exitResult = await Promise.race([
				child.exited.then(
					exitCode => ({ exitCode }),
					cause => ({ cause }),
				),
				Bun.sleep(100).then(() => null),
			]);
			const error =
				exitResult === null
					? new Error(`Agent output stream ended unexpectedly. Stderr: ${child.peekStderr()}`)
					: "exitCode" in exitResult
						? new Error(`Agent process exited with code ${exitResult.exitCode}. Stderr: ${child.peekStderr()}`)
						: new Error(`Agent output stream ended. Stderr: ${child.peekStderr()}`, {
								cause: exitResult.cause,
							});
			await reapAfterOutputFailure(error);
		})().catch(async (cause: unknown) => {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			if (!readySettled) {
				readySettled = true;
				readyReject(error);
				return;
			}
			await reapAfterOutputFailure(new Error(`Agent output reader failed: ${error.message}`, { cause: error }));
		});

		// Also race against process exit (in case stdout closes before we read it)
		void child.exited.then(
			(exitCode: number) => {
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited with code ${exitCode}. Stderr: ${child.peekStderr()}`));
			},
			(err: Error) => {
				// Killed or reaped without an exit code (e.g. stop() during
				// startup); surface it instead of leaking an unhandled rejection.
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited before ready. Stderr: ${child.peekStderr()}`, { cause: err }));
			},
		);

		// Timeout to prevent hanging forever
		const readyTimeout = this.#startTimeout(30000, () => {
			if (readySettled) return;
			readySettled = true;
			readyReject(new Error(`Timeout waiting for agent to become ready. Stderr: ${child.peekStderr()}`));
		});

		try {
			await readyPromise;
			if (protocolV2Enabled) {
				this.#protocolVersion = 2;
			} else if (protocolV2Supported) {
				protocolV2Enabled = true;
				const response = await this.#send({ type: "negotiate_protocol", protocolVersion: 2 });
				if (
					!response.success ||
					response.command !== "negotiate_protocol" ||
					!isRecord(response.data) ||
					response.data.protocolVersion !== 2
				)
					throw new Error("RPC protocol v2 negotiation failed");
				this.#protocolVersion = 2;
			}
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
			established = true;
		} catch (cause) {
			// Startup failed after spawning the child. Reap it before returning
			// so a retry cannot inherit a live worker or its session lock.
			const error = cause instanceof Error ? cause : new Error(String(cause));
			await reapAfterOutputFailure(error);
			throw cause;
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	stop(): Promise<void> {
		if (!this.#process) return this.#reaping ?? Promise.resolve();

		const error = new Error("Client stopped");
		const child = this.#process;
		try {
			child.kill(undefined, this.options.terminationGraceMs);
		} catch {
			// The process may already have exited; client state below must still be cleared.
		}
		this.#abortController.abort(error);
		this.#process = null;
		this.#rejectPromptWaiters(error);
		for (const request of this.#pendingRequests.values()) request.reject(error);
		this.#pendingRequests.clear();
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort(error);
		}
		this.#pendingHostToolCalls.clear();
		return this.#waitForExit(child);
	}

	/** Fail prompts that were acknowledged but whose `prompt_result` can no longer arrive. */
	#rejectPromptWaiters(error: Error): void {
		for (const [id, reject] of this.#promptErrorWaiters) {
			// Still-unacknowledged prompts fail through their pending request instead.
			if (!this.#pendingRequests.has(id)) reject(error);
		}
		this.#promptErrorWaiters.clear();
		this.#promptResultWaiters.clear();
	}

	/**
	 * Stop the RPC agent process and clean up resources.
	 */
	[Symbol.dispose](): void {
		void this.stop();
	}

	#waitForExit(child: RpcAgentProcess): Promise<void> {
		const reaping = child.exited.then(
			() => {},
			() => {},
		);
		this.#reaping = reaping;
		void reaping.then(() => {
			if (this.#reaping === reaping) this.#reaping = null;
		});
		return reaping;
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to all top-level session events, including non-core session state events.
	 */
	onSessionEvent(listener: RpcSessionEventListener): () => void {
		this.#sessionEventListeners.push(listener);
		return () => {
			const index = this.#sessionEventListeners.indexOf(listener);
			if (index !== -1) {
				this.#sessionEventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to subagent lifecycle frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentLifecycle(listener: RpcSubagentLifecycleListener): () => void {
		this.#subagentLifecycleListeners.add(listener);
		return () => this.#subagentLifecycleListeners.delete(listener);
	}

	/**
	 * Subscribe to aggregated subagent progress frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentProgress(listener: RpcSubagentProgressListener): () => void {
		this.#subagentProgressListeners.add(listener);
		return () => this.#subagentProgressListeners.delete(listener);
	}

	/**
	 * Subscribe to raw subagent session events. Call setSubagentSubscription(\"events\") to enable them server-side.
	 */
	onSubagentEvent(listener: RpcSubagentEventListener): () => void {
		this.#subagentEventListeners.add(listener);
		return () => this.#subagentEventListeners.delete(listener);
	}

	/**
	 * Subscribe to slash-command availability updates emitted by the RPC server.
	 */
	onAvailableCommandsUpdate(listener: RpcAvailableCommandsUpdateListener): () => void {
		this.#availableCommandsUpdateListeners.add(listener);
		return () => this.#availableCommandsUpdateListeners.delete(listener);
	}

	/** Subscribe to `btw_delta` frames: text appended to the running side question's answer. */
	onBtwDelta(listener: (frame: RpcBtwDeltaFrame) => void): () => void {
		this.#btwDeltaListeners.add(listener);
		return () => this.#btwDeltaListeners.delete(listener);
	}

	/** Subscribe to `btw_record` frames: a side question's full record on every lifecycle change. */
	onBtwRecord(listener: (record: BtwHistoryRecord) => void): () => void {
		this.#btwRecordListeners.add(listener);
		return () => this.#btwRecordListeners.delete(listener);
	}

	/** Subscribe to `prompt_result` frames: the terminal outcome of each prompt, correlated by request id. */
	onPromptResult(listener: RpcPromptResultListener): () => void {
		this.#promptResultListeners.add(listener);
		return () => {
			this.#promptResultListeners.delete(listener);
		};
	}

	/**
	 * Subscribe to `session_settled`: the session is done — the agent yielded and no
	 * background work remains that could inject messages and wake it again.
	 */
	onSessionSettled(listener: RpcSessionSettledListener): () => void {
		this.#sessionSettledListeners.add(listener);
		return () => {
			this.#sessionSettledListeners.delete(listener);
		};
	}

	/** Subscribe to live voice frames: `live_phase`, `live_levels`, `live_transcript`, `live_end`. */
	onLive(listener: RpcLiveListener): () => void {
		this.#liveListeners.add(listener);
		return () => {
			this.#liveListeners.delete(listener);
		};
	}

	/**
	 * Subscribe to session-host frames, in arrival order (the host's `seq` order for stamped frames; `seq` is
	 * kept): `attached`/`resumed`, `entry`, `session_replaced`, `clients_changed`, `command_output`,
	 * `config_update` and `session_info_update`. They reach no other listener. Register before {@link start}:
	 * the host sends `attached` right behind `ready`, and a frame with no listener is dropped.
	 */
	onHostFrame(listener: RpcHostFrameListener): () => void {
		this.#hostFrameListeners.add(listener);
		return () => {
			this.#hostFrameListeners.delete(listener);
		};
	}

	/**
	 * Subscribe to the end of an established transport that this client did not close: stdout EOF or a
	 * failed output reader (a socket the host closed or that broke). Each such close notifies once with
	 * the error that pending requests also reject with, after the client is already stopped. Not called for
	 * {@link stop}, {@link detach}, or {@link exit} (the caller ended it), nor for a {@link start} that fails,
	 * including a transport lost during protocol negotiation or custom-tool registration (`start` rejects).
	 * Listeners stay registered across restarts. A closed socket proves nothing about the host process: probe it separately.
	 */
	onClose(listener: RpcCloseListener): () => void {
		this.#closeListeners.add(listener);
		return () => {
			this.#closeListeners.delete(listener);
		};
	}

	/**
	 * Subscribe to the host's `extension_ui_request` frames (dialogs, `cancel`, notifications), in arrival order.
	 * A host sends them only to a client whose hello declared the `ui` capability. Answer a dialog with
	 * {@link sendExtensionUiResponse}; a `cancel` names a dialog to withdraw and expects no reply.
	 */
	onExtensionUiRequest(listener: RpcExtensionUiRequestListener): () => void {
		this.#extensionUiListeners.add(listener);
		return () => {
			this.#extensionUiListeners.delete(listener);
		};
	}

	/** Answer an `extension_ui_request` dialog. Throws when the client is not started. */
	sendExtensionUiResponse(response: RpcExtensionUIResponse): void {
		this.#writeFrame(response);
	}

	/**
	 * Opt in (or out) of the rich `ask` dialog. Every UI client of a host must opt in before the host's
	 * `ask` tool sends one `ask` request instead of a `select` per question.
	 */
	async setAskDialog(enabled: boolean): Promise<void> {
		this.#getData(await this.#send({ type: "set_ask_dialog", enabled }));
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns the request id once the message is admitted (dispatched, queued via
	 * `streamingBehavior` while the agent is busy, or routed to an extension command);
	 * use onEvent() to receive streaming events and onPromptResult() to observe its
	 * completion under that id.
	 *
	 * `preconditions` (here and on the other mutating controls below) are a session-host write guard: when
	 * the host's epoch or leaf no longer matches, nothing runs and the call rejects with an
	 * {@link RpcCommandError} (`code: "stale"`, carrying the host's current `epoch`/`leafId`). Stdio hosts ignore them.
	 */
	async prompt(
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
		preconditions?: RpcPreconditions,
	): Promise<string> {
		const response = await this.#send({
			type: "prompt",
			message,
			images,
			streamingBehavior,
			...writeGuard(preconditions),
		});
		this.#getData(response);
		return response.id ?? "";
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[], preconditions?: RpcPreconditions): Promise<void> {
		this.#getData(await this.#send({ type: "steer", message, images, ...writeGuard(preconditions) }));
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[], preconditions?: RpcPreconditions): Promise<void> {
		this.#getData(await this.#send({ type: "follow_up", message, images, ...writeGuard(preconditions) }));
	}

	/**
	 * Remove the first matching user message and its companions from one pending queue.
	 * A removed message's images are returned for restoring it to an editor.
	 * `options.match: "last"` removes the newest message whose queue-chip text is `message` instead, and
	 * `options.refuseAttachments` makes the host remove nothing (answering `refused: "attachments"`) when that message
	 * carries an image or other attachment that its chip text does not. A host that predates the options ignores
	 * them and removes the first match, so only send them to a host that reports `queueAttachments`.
	 */
	async removeQueuedMessage(
		message: string,
		queue: "steering" | "followUp",
		preconditions?: RpcPreconditions,
		options?: { match?: "first" | "last"; refuseAttachments?: boolean },
	): Promise<RpcRemoveQueuedMessageResult> {
		const response = await this.#send({
			type: "remove_queued_message",
			message,
			queue,
			...(options?.match !== undefined ? { match: options.match } : {}),
			...(options?.refuseAttachments !== undefined ? { refuseAttachments: options.refuseAttachments } : {}),
			...writeGuard(preconditions),
		});
		return this.#getData(response);
	}

	/**
	 * Move the first matching queued follow-up into steering.
	 * A missing target returns false; retrying may promote another occurrence.
	 */
	async promoteQueuedMessage(message: string): Promise<{ promoted: boolean }> {
		const response = await this.#send({ type: "promote_queued_message", message });
		return this.#getData(response);
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	/** Session host: leave the session running and close this client. */
	async detach(): Promise<void> {
		this.#getData(await this.#send({ type: "detach" }));
		await this.stop();
	}

	/** Session host: detach, or stop the host when this is its last client. */
	async exit(): Promise<void> {
		this.#getData(await this.#send({ type: "exit" }));
		await this.stop();
	}

	/**
	 * Abort current operation and immediately start a new turn with the given message.
	 */
	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "abort_and_prompt", message, images });
	}

	/**
	 * Withdraw queued user steering/follow-up messages, then abort (the TUI Esc path).
	 * Returns the withdrawn messages so the caller can restore them to its editor.
	 */
	async abortAndRestoreQueue(): Promise<RpcAbortAndRestoreQueueResult> {
		const response = await this.#send({ type: "abort_and_restore_queue" });
		return this.#getData(response);
	}

	/**
	 * Continue the newest session in `sessionDir`, or start a fresh one there.
	 * Lets a pre-spawned process bind to a host-keyed conversation. With `model`,
	 * the session uses it instead of its saved model; otherwise a saved model that
	 * cannot be restored rejects with `Could not restore model <provider/id>`.
	 */
	async openSession(sessionDir: string, model?: { provider: string; modelId: string }): Promise<RpcOpenSessionResult> {
		const response = await this.#send({ type: "open_session", sessionDir, ...model });
		return this.#getData(response);
	}

	/**
	 * Forward only the listed session event types (`null` forwards all).
	 * Responses, prompt results, and UI/host frames are never filtered.
	 */
	async setEventFilter(events: string[] | null): Promise<string[] | null> {
		const response = await this.#send({ type: "set_event_filter", events });
		return this.#getData<{ events: string[] | null }>(response).events;
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		const state = this.#getData<RpcSessionState>(response);
		return {
			...state,
			fastModeEnabled: state.fastModeEnabled === true,
			fastModeActive: state.fastModeActive === true,
			slowModeSupported: state.slowModeSupported === true,
			slowModeEnabled: state.slowModeEnabled === true,
			goal: state.goal ?? null,
			tokensPerSecond:
				typeof state.tokensPerSecond === "number" && Number.isFinite(state.tokensPerSecond)
					? state.tokensPerSecond
					: null,
		};
	}

	/**
	 * Enable or disable fast mode for the active model family.
	 */
	async setFastMode(enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
		const response = await this.#send({ type: "set_fast_mode", enabled });
		return this.#getData(response);
	}

	/**
	 * Enable or disable `/slow` for the active model: the flex tier for this
	 * session on OpenAI/Google, or the persisted Claude low-priority setting
	 * (`providers.anthropic.slowMode`) on Anthropic.
	 */
	async setSlowMode(enabled: boolean): Promise<boolean> {
		const response = await this.#send({ type: "set_slow_mode", enabled });
		return this.#getData<{ enabled: boolean }>(response).enabled;
	}

	/**
	 * Read or change goal mode. `get` never mutates or starts a turn; `create`/`resume`
	 * start a turn only when the server enables `goal.continuationModes: ["rpc"]`.
	 */
	async goal(op: RpcGoalOp, options?: { objective?: string; tokenBudget?: number }): Promise<RpcGoalResult> {
		const response = await this.#send({
			type: "goal",
			op,
			objective: options?.objective,
			token_budget: options?.tokenBudget,
		});
		return this.#getData(response);
	}

	/**
	 * Start a GPT live voice session bound to this session; resolves once it is connected
	 * and recording. `instructions` replaces the bundled live prompt (Handlebars:
	 * `{{username}}`, `{{firstName}}`). Frames arrive through {@link onLive}.
	 */
	async liveStart(options?: { voice?: string; instructions?: string }): Promise<{ voice: string }> {
		const response = await this.#send({
			type: "live_start",
			voice: options?.voice,
			instructions: options?.instructions,
		});
		return this.#getData(response);
	}

	/** Stop the live voice session, if any; resolves once it has stopped. */
	async liveStop(): Promise<void> {
		const response = await this.#send({ type: "live_stop" });
		this.#getData(response);
	}

	/** Set microphone mute, or toggle it when `muted` is omitted. Fails without an active session. */
	async liveMute(muted?: boolean): Promise<{ muted: boolean }> {
		const response = await this.#send({ type: "live_mute", muted });
		return this.#getData(response);
	}

	/**
	 * Configure subagent frames emitted by the RPC server. Servers default to "off".
	 * "progress" emits lifecycle/progress frames; "events" additionally emits raw subagent session events.
	 */
	async setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<RpcSubagentSubscriptionLevel> {
		const response = await this.#send({ type: "set_subagent_subscription", level });
		return this.#getData<{ level: RpcSubagentSubscriptionLevel }>(response).level;
	}

	/**
	 * Return the RPC server's current subagent snapshot.
	 */
	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#getData<{ subagents: RpcSubagentSnapshot[] }>(response).subagents;
	}

	/**
	 * Read persisted transcript entries for a tracked subagent session.
	 */
	async getSubagentMessages(selector: {
		subagentId?: string;
		sessionFile?: string;
		fromByte?: number;
	}): Promise<RpcSubagentMessagesResult> {
		const response = await this.#send({
			type: "get_subagent_messages",
			subagentId: selector.subagentId,
			sessionFile: selector.sessionFile,
			fromByte: selector.fromByte,
		});
		return this.#getData<RpcSubagentMessagesResult>(response);
	}

	/**
	 * Cancel one running subagent (foreground or background) without aborting
	 * the session. Resolves `false` when the subagent is unknown or already
	 * finished.
	 */
	async cancelSubagent(subagentId: string): Promise<boolean> {
		const response = await this.#send({ type: "cancel_subagent", subagentId });
		return this.#getData<{ cancelled: boolean }>(response).cancelled;
	}

	/**
	 * Send a message to a running subagent as its user, the same way Agent Hub
	 * chat does: a mid-turn subagent is steered at its next step boundary and one
	 * between turns starts its next turn. Resolves once the message is queued or
	 * the subagent's turn starts; rejects when the subagent is not running or the
	 * message is dropped or refused before that.
	 */
	async steerSubagent(subagentId: string, message: string): Promise<void> {
		this.#getData(await this.#send({ type: "steer_subagent", subagentId, message }));
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(
		provider: string,
		modelId: string,
		preconditions?: RpcPreconditions,
	): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId, ...writeGuard(preconditions) });
		return this.#getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(preconditions?: RpcPreconditions): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model", ...writeGuard(preconditions) });
		return this.#getData(response);
	}

	/**
	 * Get list of available models. The host sends complete `Model` records (the same shape `set_model` returns).
	 */
	async getAvailableModels(): Promise<Model[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: Model[] }>(response).models;
	}

	/**
	 * Get list of available slash commands.
	 */
	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		const response = await this.#send({ type: "get_available_commands" });
		return this.#getData<{ commands: RpcAvailableSlashCommand[] }>(response).commands;
	}

	/**
	 * Pi-compatible append-history read. Delegates to the canonical
	 * `SessionManager` on the server: no `since` returns all entries in append
	 * order, `since` returns entries strictly after the matching durable entry.
	 */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.#send({ type: "get_entries", since });
		return this.#getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * Pi-compatible raw session tree plus the current leaf id.
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.#send({ type: "get_tree" });
		return this.#getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * Selectable thinking levels for the live model, with `off` first.
	 * OMP-only `auto`/`inherit` selectors are omitted from discovery.
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.#send({ type: "get_available_thinking_levels" });
		return this.#getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel, preconditions?: RpcPreconditions): Promise<void> {
		this.#getData(await this.#send({ type: "set_thinking_level", level, ...writeGuard(preconditions) }));
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(preconditions?: RpcPreconditions): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level", ...writeGuard(preconditions) });
		return this.#getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.#send({ type: "compact", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	/** Set the session-scoped cache warming mode and return the effective mode. */
	async setCacheWarming(mode: CacheWarmingMode): Promise<CacheWarmingMode> {
		const response = await this.#send({ type: "set_cache_warming", mode });
		return this.#getData<{ mode: CacheWarmingMode }>(response).mode;
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command });
		return this.#getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	/**
	 * Ask a side question (`/btw`), or a follow-up in topic `recordId`. Resolves with the
	 * running record; the answer streams via {@link onBtwDelta} and {@link onBtwRecord}.
	 */
	async btw(question: string, recordId?: string): Promise<BtwHistoryRecord> {
		const response = await this.#send({ type: "btw", question, ...(recordId === undefined ? {} : { recordId }) });
		return this.#getData<{ record: BtwHistoryRecord }>(response).record;
	}

	/** Cancel the running side question (only if it is `recordId`, when given). */
	async cancelBtw(recordId?: string): Promise<boolean> {
		const response = await this.#send({ type: "btw_cancel", ...(recordId === undefined ? {} : { recordId }) });
		return this.#getData<{ cancelled: boolean }>(response).cancelled;
	}

	/** This session's side questions, newest first. */
	async getBtwHistory(): Promise<readonly BtwHistoryRecord[]> {
		const response = await this.#send({ type: "get_btw_history" });
		return this.#getData<{ records: readonly BtwHistoryRecord[] }>(response).records;
	}

	/**
	 * Summarize the session into a handoff document and compact it in place.
	 */
	async handoff(customInstructions?: string): Promise<RpcHandoffResult | null> {
		const response = await this.#send({ type: "handoff", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	/**
	 * Switch to a different session file, optionally with `model` instead of its saved one.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(
		sessionPath: string,
		model?: { provider: string; modelId: string },
	): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath, ...model });
		return this.#getData(response);
	}

	/**
	 * Branch from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	/**
	 * Fork into a new session file and switch to it: history up to and including
	 * `entryId`, or the whole session when omitted.
	 * @returns Object with `cancelled: true` if an extension cancelled the fork
	 */
	async fork(entryId?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "fork", entryId });
		return this.#getData(response);
	}

	/**
	 * Get messages available for branching.
	 */
	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	/**
	 * Ghost-text suffix for the prose word ending at `cursor` (a UTF-16 offset
	 * into `text`), from the `spelling.autocomplete` engine; `null` when none applies.
	 */
	async predictWord(text: string, cursor: number): Promise<string | null> {
		// The server runs one prediction at a time per session and holds at most one
		// more behind it, so this request may wait out an in-flight cold request
		// (up to 3 daemon-start rounds of 30s plus a 30s first completion) before
		// its own 30s completion: ~150s. Outlast that so the server's answer, not
		// our timeout, decides.
		const response = await this.#send({ type: "predict_word", text, cursor }, 155_000);
		return this.#getData<{ suffix: string | null }>(response).suffix;
	}

	/** Report a shown suggestion the user accepted or typed past, with the text and cursor it was shown at. */
	async predictWordFeedback(text: string, cursor: number, suggestion: string, accepted: boolean): Promise<void> {
		const response = await this.#send({ type: "predict_word_feedback", text, cursor, suggestion, accepted });
		this.#getData(response);
	}

	/**
	 * Get one stable, byte-bounded message page.
	 */
	async getMessagesPage(options: RpcMessagesPageOptions = {}): Promise<RpcMessagesPage> {
		const response = await this.#send({ type: "get_messages_page", ...options });
		return this.#getData<RpcMessagesPage>(response);
	}

	/** Get all messages, draining stable pages when protocol v2 is available. */
	async getMessages(): Promise<AgentMessage[]> {
		if (this.#protocolVersion === 2) {
			try {
				const messages: AgentMessage[] = [];
				const seenCursors = new Set<string>();
				let totalMessages: number | undefined;
				let cursor: string | undefined;
				do {
					const page = await this.getMessagesPage({ cursor, limit: 256 });
					if (
						!Number.isSafeInteger(page.totalMessages) ||
						page.totalMessages < 0 ||
						(totalMessages !== undefined && page.totalMessages !== totalMessages)
					)
						throw new Error("RPC message pagination returned an inconsistent total");
					totalMessages = page.totalMessages;
					messages.push(...page.messages);
					cursor = page.nextCursor;
					if (cursor && seenCursors.has(cursor)) throw new Error("RPC message pagination repeated a cursor");
					if (cursor) seenCursors.add(cursor);
				} while (cursor);
				if (messages.length !== totalMessages)
					throw new Error("RPC message pagination ended before the advertised total");
				return messages;
			} catch (error) {
				if (!isPageFallbackError(error)) throw error;
			}
		}
		const response = await this.#send({ type: "get_messages" });
		return this.#getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get list of OAuth providers available for login, with their current authentication status.
	 */
	async getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#getData<{
			providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
		}>(response).providers;
	}

	/**
	 * Trigger OAuth login for the given provider.
	 * The server will emit an `open_url` extension_ui_request for the auth URL.
	 * Providers that require pasted-code completion may then emit an `input`
	 * extension_ui_request; pass `onManualCodeInput` to satisfy it.
	 * Resolves when login completes or rejects on failure.
	 *
	 * @param onOpenUrl Called when the server emits the auth URL. The host must
	 *   open `url` in a browser. When the flow's callback server hosts a
	 *   `/launch` redirect, `launchUrl` is a short loopback URL that 302s to
	 *   `url` — hosts SHOULD surface it as the truncation-safe copy target so
	 *   terminal viewport clipping cannot corrupt trailing OAuth query
	 *   parameters (e.g. `code_challenge_method=S256`).
	 */
	async login(
		providerId: string,
		options?: {
			onOpenUrl?: (url: string, instructions?: string, launchUrl?: string) => void;
			onManualCodeInput?: (prompt: { title: string; placeholder?: string }) => string | Promise<string>;
		},
	): Promise<{ providerId: string }> {
		const { onManualCodeInput, onOpenUrl } = options ?? {};
		const listener =
			onOpenUrl || onManualCodeInput
				? (req: RpcExtensionUIRequest) => {
						if (req.method === "open_url") {
							onOpenUrl?.(req.url, req.instructions, req.launchUrl);
							return;
						}
						if (req.method !== "input" || !onManualCodeInput) return;
						// The prompt can outlive the agent (e.g. a broken stdin pipe stops the client); drop the reply
						// instead of throwing "Client not started" out of a detached promise chain.
						void Promise.resolve(onManualCodeInput({ title: req.title, placeholder: req.placeholder })).then(
							value => {
								if (this.#process) this.#writeFrame({ type: "extension_ui_response", id: req.id, value });
							},
							() => {
								if (this.#process) {
									this.#writeFrame({ type: "extension_ui_response", id: req.id, cancelled: true });
								}
							},
						);
					}
				: undefined;
		if (listener) this.#extensionUiListeners.add(listener);
		try {
			const response = await this.#send({ type: "login", providerId }, 600_000);
			return this.#getData<{ providerId: string }>(response);
		} finally {
			if (listener) this.#extensionUiListeners.delete(listener);
		}
	}

	/** List the stored credentials `logout()` can remove for a provider, active first. */
	async getLogoutAccounts(providerId: string): Promise<LogoutAccount[]> {
		const response = await this.#send({ type: "get_logout_accounts", providerId });
		return this.#getData<{ accounts: LogoutAccount[] }>(response).accounts;
	}

	/**
	 * Remove one stored credential. Rejects when it is no longer stored.
	 * `remainingSource` names what still authenticates the provider (another stored credential, env var, config).
	 */
	async logout(providerId: string, credentialId: number): Promise<{ remainingSource?: string }> {
		const response = await this.#send({ type: "logout", providerId, credentialId });
		return this.#getData<{ remainingSource?: string }>(response);
	}

	/**
	 * Replace the host-owned custom tools exposed to the RPC session.
	 * Changes take effect before the next model call.
	 */
	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = [...tools];
		if (!this.#process) {
			return this.#customTools.map(tool => tool.name);
		}
		const definitions: RpcHostToolDefinition[] = this.#customTools.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
			loadMode: tool.loadMode,
			readsSkillUris: tool.readsSkillUris,
		}));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve();
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			events.push(event);
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Wait until the session is done, not merely yielded: resolves at once when
	 * `get_state` reports it settled, otherwise at the next `session_settled`.
	 * Use after {@link promptAndWait} when background jobs may still wake the agent.
	 */
	async waitForSettled(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const unsubscribe = this.onSessionSettled(resolve);
		let timeoutId: NodeJS.Timeout | undefined;
		try {
			// Subscribed before asking, so a settle between the two cannot be missed.
			if ((await this.getState()).isSettled) return;
			timeoutId = this.#startTimeout(timeout, () => {
				reject(new Error(`Timeout waiting for session_settled. Stderr: ${this.#process?.peekStderr() ?? ""}`));
			});
			await promise;
		} finally {
			unsubscribe();
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Send a prompt and wait for its own `prompt_result`, returning the agent events
	 * streamed meanwhile. A local-only prompt answered synchronously resolves with
	 * the events seen so far.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const events: AgentEvent[] = [];
		const unsubscribe = this.onEvent(event => events.push(event));
		try {
			await this.promptToCompletion(message, { images, timeoutMs: timeout });
			return events;
		} finally {
			unsubscribe();
		}
	}

	/**
	 * {@link prompt}, resolving at its own `prompt_result`: once all work it caused has settled. A prompt the host
	 * answered locally (`agentInvoked: false`: a slash command, a handled input hook) has no result and resolves at
	 * its acknowledgement. Rejects when the result reports an error, or after `timeoutMs` (default: no limit).
	 */
	async promptToCompletion(
		message: string,
		options: {
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			preconditions?: RpcPreconditions;
			timeoutMs?: number;
		} = {},
	): Promise<void> {
		const { images, streamingBehavior, preconditions, timeoutMs } = options;
		// Registered under the id before sending: the result can never arrive unclaimed.
		const id = `req_${++this.#requestId}`;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#promptResultWaiters.set(id, result => {
			if (result.status === "error") reject(new Error(result.error?.message ?? "Prompt failed"));
			else resolve();
		});
		this.#promptErrorWaiters.set(id, reject);
		let timeoutId: NodeJS.Timeout | undefined;
		try {
			const response = await this.#send(
				{ type: "prompt", message, images, streamingBehavior, ...writeGuard(preconditions) },
				30_000,
				id,
			);
			const data = this.#getData<{ agentInvoked?: boolean } | undefined>(response);
			if (data?.agentInvoked === false) return;
			if (timeoutMs !== undefined) {
				timeoutId = this.#startTimeout(timeoutMs, () => {
					reject(new Error(`Timeout waiting for prompt_result. Stderr: ${this.#process?.peekStderr() ?? ""}`));
				});
			}
			await promise;
		} finally {
			clearTimeout(timeoutId);
			this.#promptResultWaiters.delete(id);
			this.#promptErrorWaiters.delete(id);
		}
	}

	// =========================================================================
	// Internal
	// =========================================================================

	#handleLine(data: unknown): void {
		// Check if it's a response to a pending request
		if (isRpcResponse(data)) {
			const id = data.id;
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				pending.resolve(data);
				return;
			}
			if (id && data.success === false) {
				const rejectLate = this.#promptErrorWaiters.get(id);
				if (rejectLate) {
					this.#promptErrorWaiters.delete(id);
					rejectLate(new RpcCommandError(data.error, data.command, data.code));
					return;
				}
			}
		}

		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}

		if (isRpcExtensionUiRequest(data)) {
			for (const listener of this.#extensionUiListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
			return;
		}

		if (isRpcSubagentLifecycleFrame(data)) {
			for (const listener of this.#subagentLifecycleListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentProgressFrame(data)) {
			for (const listener of this.#subagentProgressListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentEventFrame(data)) {
			for (const listener of this.#subagentEventListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcLiveFrame(data)) {
			for (const listener of this.#liveListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcSessionSettledFrame(data)) {
			for (const listener of this.#sessionSettledListeners) {
				listener();
			}
			return;
		}

		if (isRpcPromptResultFrame(data)) {
			if (data.id !== undefined) this.#promptResultWaiters.get(data.id)?.(data);
			for (const listener of this.#promptResultListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcAvailableCommandsUpdateFrame(data)) {
			for (const listener of this.#availableCommandsUpdateListeners) {
				listener(data.commands);
			}
			return;
		}

		if (isRpcBtwDeltaFrame(data)) {
			for (const listener of this.#btwDeltaListeners) listener(data);
			return;
		}

		if (isRpcBtwRecordFrame(data)) {
			for (const listener of this.#btwRecordListeners) listener(data.record);
			return;
		}

		if (isSessionHostFrame(data)) {
			for (const listener of this.#hostFrameListeners) {
				listener(data);
			}
			return;
		}

		if (!isAgentSessionEvent(data)) return;

		for (const listener of this.#sessionEventListeners) {
			listener(data);
		}

		if (!isAgentEvent(data)) return;

		for (const listener of this.#eventListeners) {
			listener(data);
		}
	}

	#send(command: RpcCommandBody, timeoutMs = 30_000, id = `req_${++this.#requestId}`): Promise<RpcResponse> {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}
		const fullCommand = { ...command, id } as RpcCommand;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId = this.#startTimeout(timeoutMs, () => {
			if (settled) return;
			this.#pendingRequests.delete(id);
			settled = true;
			reject(
				new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});

		this.#pendingRequests.set(id, {
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		});

		const fail = (err: Error) => {
			this.#pendingRequests.delete(id);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(err);
		};
		// Settle this promise on a synchronous throw too (e.g. a non-serializable command): the caller only
		// receives `promise`, so a later rejection routed through `fail` would otherwise be unhandled.
		try {
			this.#writeFrame(fullCommand, fail);
		} catch (err) {
			fail(err instanceof Error ? err : new Error(String(err)));
		}
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });

		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate);
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	#writeFrame(
		frame: RpcCommand | RpcExtensionUIResponse | RpcHostToolResult | RpcHostToolUpdate,
		onError?: (error: Error) => void,
	): void {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}
		const child = this.#process;
		const stdin = child.stdin;
		// Serialize first: a non-serializable frame is the caller's error, not a pipe failure.
		const line = `${JSON.stringify(frame)}\n`;
		// A broken stdin pipe is terminal: fail this frame's request, then stop so start() can relaunch.
		const failed = (err: unknown) => {
			onError?.(err instanceof Error ? err : new Error(String(err)));
			if (this.#process === child) void this.stop();
		};
		try {
			const write = stdin.write(line);
			if (isPromise(write)) write.catch(failed);
			if (!("flush" in stdin)) return;
			const flushResult = (stdin as FileSink).flush();
			if (isPromise(flushResult)) flushResult.catch(failed);
		} catch (err) {
			failed(err);
		}
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new RpcCommandError(errorResponse.error, errorResponse.command, errorResponse.code, errorResponse);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
