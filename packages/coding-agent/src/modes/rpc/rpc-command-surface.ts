/**
 * The RPC command surface: one implementation of every command an attached
 * client may issue, shared by the stdio runner (`rpc-mode.ts`) and the socket
 * transport (`rpc-socket.ts`). Extracted so the two transports cannot drift:
 * `runRpcMode` and an interactive TUI's published endpoint both serve
 * {@link RpcCommandSurface.handleCommand}.
 *
 * The surface holds no transport. Responses, prompt results and host-tool
 * traffic go to the connection that accepted the command; unsolicited frames
 * the surface itself originates go to its `output` sink (stdio stdout or the
 * socket broadcast). Session-level machinery the surface cannot own — the goal
 * continuation driver, live voice, dictation, /btw, subagent subscription,
 * extension-UI login and session transitions — arrives as
 * {@link RpcHostCommandServices}. A surface mounted without a host (the
 * terminal UI) refuses those commands instead of half-running them.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { wordCompletionQuery } from "@oh-my-pi/pi-tui/prompt/word-completion";
import type {
	WordCompletionEngine,
	WordCompletionMethod,
	WordCompletionQuery,
} from "@oh-my-pi/pi-tui/prompt/word-completion";
import { isRecord, logger, Snowflake } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type BuiltSkillPromptMessage,
	loadSkillPrompt,
	parseSkillInvocation,
	type Skill,
	type SkillPromptInput,
	type SkillRediscoverySource,
} from "../../extensibility/skills";
import type { MCPManager } from "../../mcp/manager";
import { reconnectMcpManagerServer } from "../../mcp/oauth-reauth";
import { requestTextPrediction, textPredictionBackend } from "../../predict/client";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentSession, type NavigateTreeResult, SessionBusyError } from "../../session/agent-session";
import type { AgentSessionHandle } from "../../session/agent-session-handle";
import type { RestoredQueuedMessage } from "../../session/agent-session-types";
import { CACHE_WARMING_MODES } from "../../session/cache-warmer";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { findMostRecentNonEmptySession, findRecentSessionContinuation } from "../../session/session-listing";
import { probeSessionLeases } from "../../session/session-storage";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { listLogoutAccounts, logoutCredential } from "../../slash-commands/helpers/logout";
import { cfgSttEnabled } from "../../stt/settings";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { cfgSpellingAutocomplete } from "../settings";
import {
	requestRpcAskDialog,
	requestRpcConfirm,
	requestRpcEditor,
	requestRpcInput,
	requestRpcSelect,
} from "./rpc-dialog-requests";
import type { DialogFirstResponder, DialogRequestHandle, DialogSocketBridge } from "./dialog-first-responder";
import { RpcBtwController } from "./rpc-btw";
import type { RpcClientConn } from "./client-connection";
import { RpcClientConnection, RpcClientRegistry } from "./client-connection";
import { selectRpcEntries } from "./rpc-compat";
import { RpcDictationBridge } from "./rpc-dictation";
import { MAX_RPC_FRAME_BYTES } from "./rpc-frame";
import { RpcGoalController } from "./rpc-goal";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { loginOverRpc } from "./rpc-login";
import { RpcLiveBridge } from "./rpc-live";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
	type RpcPromptTicket,
	watchAndReportPromptResult,
} from "./rpc-prompt-results";
import { RpcSessionEventForwarder } from "./rpc-session-events";
import type { RpcSessionSocket, RpcSessionSocketSurface } from "./rpc-socket";
import { RpcSessionSettleWatcher, watchedScheduledTurnProbe } from "./rpc-session-settle";
import { getRpcSessionState } from "./rpc-state";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { EventBus } from "../../utils/event-bus";
import { RpcSubagentRegistry, readRpcSubagentTranscript, resolveOwnedLiveSubagent } from "./rpc-subagents";
import type {
	RpcAbortAndRestoreQueueResult,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcMessageUpdates,
	RpcOpenSessionResult,
	RpcProjectedSessionEventFrame,
	RpcRemoveQueuedMessageResult,
	RpcResponse,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

export type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
	/** Client that received the request; set when the pending map knows its UI owner. */
	conn?: RpcClientConn;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;
	#resolveOwner: (() => RpcClientConn | undefined) | undefined;

	constructor(resolveOwner?: () => RpcClientConn | undefined) {
		super();
		this.#resolveOwner = resolveOwner;
	}

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, { ...request, conn: request.conn ?? this.#resolveOwner?.() });
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

	/** Reject only the requests one client owned; other clients keep their pending dialogs. */
	rejectFor(conn: RpcClientConn, message: string): void {
		const error = new Error(message);
		const requests = Array.from(this.entries()).filter(([, request]) => request.conn === conn);
		for (const [id] of requests) this.delete(id);
		for (const [, request] of requests) request.reject(error);
	}
}

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

export type RpcSkillCommandSession = Pick<
	AgentSession,
	"buildUserSkillPrompt" | "renderUserSkillPrompt" | "promptCustomMessage" | "skills" | "skillsSettings"
> &
	SkillRediscoverySource;
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
	const built = prebuilt ?? (await session.buildUserSkillPrompt(invocation.skill, invocation));
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
	// Read the skill before acknowledging the command so a missing SKILL.md
	// still fails immediately (a stale one is read from its rediscovered
	// replacement first). Rendering (and authorizing model tags) happens
	// only after the in-flight submission survives the currentness check.
	const loaded = await loadSkillPrompt(invocation.skill, input.session);
	if (input.isCurrent && !input.isCurrent()) return "cancelled";
	const built = input.session.renderUserSkillPrompt(loaded.skill, invocation, loaded.body);
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
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in `RpcExtensionUIResponse` — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
export function isRpcExtensionUIResponse(value: unknown): value is { type: "extension_ui_response"; id: string } {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

export function rpcSuccess<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export function rpcError(id: string | undefined, command: string, message: string, code?: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
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
	let session: AgentSessionHandle;
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
 * can bind a pre-spawned process to a conversation it keys by directory. Like
 * `--continue`, it opens the copy the conversation went on in when that session
 * moved off its file (see {@link findRecentSessionContinuation}).
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
	const recent = await findMostRecentNonEmptySession(dir);
	const latest = recent ? ((await findRecentSessionContinuation(recent))?.session.path ?? recent) : null;
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

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
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

/** Commands a session transition needs the host's session machinery to accept. */
export const SESSION_CHANGE_TYPES: Readonly<Record<string, true>> = {
	new_session: true,
	switch_session: true,
	branch: true,
	fork: true,
	open_session: true,
};

/**
 * Commands only the process that owns the session's RPC runner can serve:
 * session transitions it must coordinate with the goal/dictation/socket
 * machinery, the goal continuation driver, live voice, dictation, /btw,
 * event filtering, extension-UI login, and the terminal-owned tree/handoff
 * paths. A TUI-hosted surface has no such runner, so it refuses them instead
 * of half-running them. Subagent reads, steering, cancellation and the
 * per-view subscription are not here: both surfaces serve them from the
 * session's subagent registry.
 */
const HOST_COMMANDS: Readonly<Record<string, true>> = {
	new_session: true,
	switch_session: true,
	branch: true,
	fork: true,
	open_session: true,
	navigate_tree: true,
	abort_branch_summary: true,
	handoff: true,
	goal: true,
	set_ask_dialog: true,
	login: true,
	live_start: true,
	live_connect: true,
	live_stop: true,
	live_mute: true,
	dictation_start: true,
	dictation_stop: true,
	btw: true,
	btw_cancel: true,
	get_btw_history: true,
	set_event_filter: true,
};

const NO_SCHEDULED_TURN = () => false;

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

const USER_INPUT_TYPES: Record<string, true> = {
	prompt: true,
	steer: true,
	follow_up: true,
	abort_and_prompt: true,
};

/**
 * Session-level services the surface cannot own. Supplied by the RPC runner
 * (`runRpcMode`); absent for a TUI-hosted surface, which then refuses
 * {@link HOST_COMMANDS}.
 */
export interface RpcHostCommandServices {
	readonly goal: RpcGoalController;
	readonly settleWatcher: RpcSessionSettleWatcher;
	readonly btw: RpcBtwController;
	readonly live: RpcLiveBridge;
	readonly dictation: RpcDictationBridge;
	/** The single stdio forwarder; a socket publication filters per connection instead. */
	readonly sessionEvents?: RpcSessionEventForwarder;
	readonly subagents?: RpcSubagentRegistry;
	readonly mcpManager?: MCPManager;
	/** Whether a goal continuation turn is scheduled or held; `session_settled` accounts for it. */
	scheduledTurnPending: () => boolean;
	isSessionChanging: () => boolean;
	isShuttingDown: () => boolean;
	stopDictationForSessionChange: () => Promise<void>;
	/** Wrap a session-changing command: reattach the goal driver, rebind the endpoint. */
	withSessionChange: <T>(change: () => Promise<T>) => Promise<T>;
	setAskDialog: (command: RpcCommand & { type: "set_ask_dialog" }) => RpcResponse;
	login: (command: RpcCommand & { type: "login" }) => Promise<RpcResponse>;
	/** Track builtin slash-command work that outlives its response (e.g. `/mcp reauth`). */
	trackBackgroundTask: (task: Promise<void>) => void;
}

export interface RpcCommandSurfaceOptions {
	session: AgentSession;
	/** Transport-wide sink for frames the surface originates (stdio stdout or socket broadcast). */
	output: RpcOutput;
	clients: RpcClientRegistry;
	/** Host-tool UI owner used for commands that arrive without a connection (stdio). */
	defaultConn: RpcClientConn;
	/** Wire limit for fitted responses; read per command because stdio negotiates v2 mid-stream. */
	maxResponseBytes: () => number;
	pendingExtensionRequests: RpcPendingExtensionRequests;
	promptResults: RpcPromptResults;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	host?: RpcHostCommandServices;
	/**
	 * Commands this transport must refuse even when a host exists. A shared
	 * bound session socket uses it for the transitions that would swap the
	 * transcript out from under sibling viewers.
	 */
	refusedCommands?: Readonly<Record<string, true>>;
	/**
	 * Per-connection session-event filtering for a transport with no single
	 * forwarder (a terminal-hosted publication). Returns the active selection.
	 */
	eventFilter?: (
		conn: RpcClientConn | undefined,
		events: readonly string[] | null,
		messageUpdates: RpcMessageUpdates,
	) => readonly string[] | null;
	/**
	 * Subagent registry owned by this surface's transport when it has no RPC
	 * runner (a terminal-hosted publication). The stdio runner supplies its own
	 * through `host.subagents`; a client's subscription is filtered per view by
	 * `clients` either way.
	 */
	subagents?: RpcSubagentRegistry;
}

/**
 * One RPC command surface for one live session.
 *
 * Two callers share it: the stdio dispatcher (no connection; responses leave
 * through its `output`) and every socket connection (responses, prompt results
 * and host-tool traffic go back to that connection alone). `dispatch` is the
 * socket entry point, `createSocketSurface` binds a connection, and
 * `handleCommand` is the command implementation both transports run.
 */
export class RpcCommandSurface {
	readonly hostToolBridge: RpcHostToolBridge;
	readonly hostUriBridge: RpcHostUriBridge;
	readonly promptResults: RpcPromptResults;
	readonly extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	readonly wordPredictor = new RpcWordPredictor();
	readonly #session: AgentSession;
	readonly #output: RpcOutput;
	readonly #clients: RpcClientRegistry;
	readonly #defaultConn: RpcClientConn;
	readonly #maxResponseBytes: () => number;
	readonly #pendingExtensionRequests: RpcPendingExtensionRequests;
	readonly #host: RpcHostCommandServices | undefined;
	readonly #subagents: RpcSubagentRegistry | undefined;
	readonly #refusedCommands: Readonly<Record<string, true>> | undefined;
	readonly #eventFilter:
		| ((
				conn: RpcClientConn | undefined,
				events: readonly string[] | null,
				messageUpdates: RpcMessageUpdates,
		  ) => readonly string[] | null)
		| undefined;
	readonly #inputGate = new RpcUserInputGate();
	readonly #builtinCommandAborts = new Set<AbortController>();
	readonly #socketLogins = new Map<
		RpcClientConn,
		{ controller: AbortController; pendingRequests: RpcPendingExtensionRequests }
	>();
	#unsubscribeObserve: (() => void) | undefined;
	#unsubscribeCommandMetadata: (() => void) | undefined;

	constructor(options: RpcCommandSurfaceOptions) {
		this.#session = options.session;
		this.#output = options.output;
		this.#clients = options.clients;
		this.#defaultConn = options.defaultConn;
		this.#maxResponseBytes = options.maxResponseBytes;
		this.#pendingExtensionRequests = options.pendingExtensionRequests;
		this.promptResults = options.promptResults;
		this.extensionUserMessageTracker = options.extensionUserMessageTracker;
		this.#host = options.host;
		this.#subagents = options.subagents;
		this.#refusedCommands = options.refusedCommands;
		this.#eventFilter = options.eventFilter;
		this.hostToolBridge = new RpcHostToolBridge(options.defaultConn);
		this.hostUriBridge = new RpcHostUriBridge(options.output);
	}

	/** Subscribe to the session and announce the current command list. */
	start(): void {
		this.#unsubscribeObserve = this.#session.subscribe(event => this.observe(event));
		this.#unsubscribeCommandMetadata = this.#session.subscribeCommandMetadataChanged(() => {
			void this.emitAvailableCommandsUpdate();
		});
	}

	dispose(): void {
		this.#unsubscribeObserve?.();
		this.#unsubscribeObserve = undefined;
		this.#unsubscribeCommandMetadata?.();
		this.#unsubscribeCommandMetadata = undefined;
		for (const login of this.#socketLogins.values()) {
			login.controller.abort("RPC session closed");
			login.pendingRequests.rejectAll("RPC session closed");
		}
	}

	/** Number an accepted frame at read time so a later abort can invalidate it. */
	acceptInput(command: RpcCommand): void {
		this.#inputGate.accept(command);
	}

	/** Route one session event to the parts of the surface that read it. */
	observe(event: AgentSessionEvent): void {
		this.#host?.goal.observe(event);
		this.promptResults.observe(event);
		this.#host?.settleWatcher.observe(event);
	}

	async emitAvailableCommandsUpdate(): Promise<void> {
		this.#output({ type: "available_commands_update", commands: await buildAvailableSlashCommands(this.#session) });
	}

	/** Builtin work that outlives its prompt response; aborted on host abort and disconnect. */
	abortBuiltinCommands(reason: string): void {
		for (const controller of this.#builtinCommandAborts) controller.abort(reason);
		this.#builtinCommandAborts.clear();
	}

	/**
	 * Bind one attached socket connection: its own command responses, prompt
	 * results and host-tool registration. Closing it detaches only these, never
	 * the session.
	 */
	createSocketSurface(conn: RpcClientConn): RpcSessionSocketSurface {
		this.#clients.register(conn);
		return {
			dispatch: frame => {
				if (isRpcHostToolResult(frame)) {
					this.hostToolBridge.handleResult(frame, conn);
					return;
				}
				if (isRpcHostToolUpdate(frame)) {
					this.hostToolBridge.handleUpdate(frame, conn);
					return;
				}
				if (isRpcHostUriResult(frame)) {
					this.hostUriBridge.handleResult(frame);
					return;
				}
				if (isRpcExtensionUIResponse(frame)) {
					const loginRequest = this.#socketLogins.get(conn)?.pendingRequests.get(frame.id);
					if (loginRequest) {
						loginRequest.resolve(frame as RpcExtensionUIResponse);
						return;
					}
					this.#pendingExtensionRequests.get(frame.id)?.resolve(frame as RpcExtensionUIResponse);
					return;
				}
				const command = frame as RpcCommand;
				// Accept at read time, exactly like stdio: an abort or session change read
				// after this frame invalidates it even while it waits in the ordered tail.
				this.#inputGate.accept(command);
				void this.#dispatchCommand(command, conn);
			},
			close: reason => {
				const login = this.#socketLogins.get(conn);
				login?.controller.abort(reason);
				login?.pendingRequests.rejectAll(reason);
				this.#clients.unregister(conn);
				this.#syncSubagentEmission();
				void this.#session.refreshRpcHostTools(this.hostToolBridge.removeClient(conn, reason));
			},
		};
	}

	/**
	 * Keep the shared bus emitting at the union of the attached views' levels;
	 * each view still receives only the frames its own level covers.
	 */
	#syncSubagentEmission(): void {
		const subagents = this.#subagents ?? this.#host?.subagents;
		if (!subagents) return;
		subagents.setSubscriptionLevel(this.#clients.maxSubagentSubscription());
	}

	/** Serve one command; the caller owns the response sink (stdio) or receives it here (socket). */
	async handleCommand(command: RpcCommand, conn?: RpcClientConn): Promise<RpcResponse> {
		const run = () => this.#handleCommandImpl(command, conn);
		const response =
			this.#host && Object.hasOwn(SESSION_CHANGE_TYPES, command.type)
				? await this.#host.withSessionChange(run)
				: await run();
		// The stdio dispatcher owns its response sink; a socket client gets its own
		// answer here, so two clients can reuse an id without crossing wires.
		conn?.send(response);
		return response;
	}

	async #dispatchCommand(command: RpcCommand, conn: RpcClientConn): Promise<void> {
		try {
			await this.handleCommand(command, conn);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			conn.send(rpcError(command.id, command.type, message));
		}
	}

	#refuseHostCommand(command: RpcCommand): RpcResponse {
		return rpcError(
			command.id,
			command.type,
			`${command.type} is not available on an attached socket: the terminal session owns this command surface`,
		);
	}

	#refuseSharedSessionCommand(command: RpcCommand): RpcResponse {
		return rpcError(
			command.id,
			command.type,
			`${command.type} is not available on the shared session socket: the terminal session is bound to its transcript and sibling viewers must not have it swapped. Run it in the terminal.`,
			"shared_session_bound",
		);
	}

	async #reloadPluginState(): Promise<void> {
		const cwd = this.#session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		await this.#session.refreshSkillsAndCommands();
		await this.emitAvailableCommandsUpdate();
	}

	/**
	 * Ordered user input (prompt/steer/follow_up/abort_and_prompt). Every
	 * submission accepted on any transport passes this one gate, so prompts
	 * arrive in acceptance order across stdio and all socket clients.
	 */
	#dispatchOrderedUserInput(
		command: Extract<RpcCommand, { type: "prompt" | "steer" | "follow_up" | "abort_and_prompt" }>,
		ticket: RpcPromptTicket | undefined,
		conn?: RpcClientConn,
	): Promise<"local" | "cancelled" | "admitted" | "builtin-agent"> {
		return this.#inputGate.enqueue(async () => {
			const session = this.#session;
			const sessionId = session.sessionId;
			const isShuttingDown = this.#host?.isShuttingDown() ?? false;
			const isCurrent = () =>
				this.#inputGate.isCurrent(command) && !isShuttingDown && session.sessionId === sessionId;
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
					results: this.promptResults,
					onError: this.#onPromptError(command.id, "prompt", conn),
					extensionUserMessageTracker: this.extensionUserMessageTracker,
					images,
					isCurrent,
				});
				if (skillResult === "cancelled") return "cancelled";
				if (skillResult) return "admitted";
				const builtinAbort = new AbortController();
				this.#builtinCommandAborts.add(builtinAbort);
				let backgroundedBuiltin = false;
				const host = this.#host;
				const builtinResult = await executeAcpBuiltinSlashCommand(text, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: commandOutput => this.#output({ type: "command_output", text: commandOutput }),
					refreshCommands: () => this.emitAvailableCommandsUpdate(),
					reloadPlugins: () => this.#reloadPluginState(),
					mcpManager: host?.mcpManager,
					reconnectMcpServer: host?.mcpManager
						? async (mcpName, selected) => {
								const manager = host.mcpManager!;
								const state = await reconnectMcpManagerServer(manager, mcpName, selected);
								if (state) {
									// RPC mode wires no tools-changed callback; refresh the
									// session binding so later prompts see the recovered tools.
									await session.refreshMCPTools(manager.getTools());
								}
								return state;
							}
						: undefined,
					signal: builtinAbort.signal,
					runCommandInBackground: task => {
						backgroundedBuiltin = true;
						const tracked = task().finally(() => this.#builtinCommandAborts.delete(builtinAbort));
						host?.trackBackgroundTask(tracked);
					},
					notifyTitleChanged: async () => {
						this.#output({
							type: "session_info_update",
							title: session.sessionName,
							sessionId: session.sessionId,
						});
					},
					notifyConfigChanged: async () => {
						this.#output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				});
				if (!backgroundedBuiltin) this.#builtinCommandAborts.delete(builtinAbort);
				if (!isCurrent()) return "cancelled";
				if (builtinResult !== false) {
					if (!("prompt" in builtinResult)) {
						if (builtinResult.agentInvoked === true && ticket) {
							void session.waitForIdle().then(
								() => this.promptResults.settle(ticket),
								(idleError: unknown) =>
									this.promptResults.fail(
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
				results: this.promptResults,
				onError: this.#onPromptError(command.id, command.type, conn),
				extensionUserMessageTracker: this.extensionUserMessageTracker,
			});
			return "admitted";
		});
	}

	#onPromptError(id: string | undefined, command: string, conn?: RpcClientConn) {
		return (promptError: Error) =>
			(conn ? (frame: RpcResponse) => conn.send(frame) : this.#output)(rpcError(id, command, promptError.message));
	}

	async #handleCommandImpl(command: RpcCommand, conn?: RpcClientConn): Promise<RpcResponse> {
		const session = this.#session;
		const host = this.#host;
		const id = command.id;
		const maxResponseBytes = this.#maxResponseBytes();

		if (this.#refusedCommands?.[command.type]) return this.#refuseSharedSessionCommand(command);
		if (!host && Object.hasOwn(HOST_COMMANDS, command.type)) return this.#refuseHostCommand(command);

		switch (command.type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 2)
					return rpcError(
						id,
						"negotiate_protocol",
						`Unsupported RPC protocol version: ${command.protocolVersion}`,
					);
				return rpcSuccess(id, "negotiate_protocol", { protocolVersion: 2 });
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Taken before any dispatch so a builtin that schedules a turn (e.g. `/retry`)
				// cannot start its run ahead of the prompt's event-stream position.
				const ticket = this.promptResults.begin(id, conn ? frame => conn.send(frame) : undefined);
				try {
					// Ack after admission, including hooks and skill image preparation, so a
					// queue edit sent after this response finds the message.
					const outcome = await this.#dispatchOrderedUserInput(command, ticket, conn);
					if (outcome === "local") {
						this.promptResults.discard(ticket);
						return rpcSuccess(id, "prompt", { agentInvoked: false });
					}
					if (outcome === "builtin-agent") return rpcSuccess(id, "prompt", { agentInvoked: true });
					if (outcome === "cancelled") {
						this.promptResults.settle(ticket);
						return rpcSuccess(id, "prompt");
					}
					return rpcSuccess(id, "prompt");
				} catch (promptSetupError) {
					this.promptResults.discard(ticket);
					throw promptSetupError;
				}
			}

			case "steer":
			case "follow_up": {
				await this.#dispatchOrderedUserInput(command, undefined, conn);
				return rpcSuccess(id, command.type);
			}

			case "remove_queued_message": {
				if (typeof command.message !== "string") {
					return rpcError(id, "remove_queued_message", "message must be a string");
				}
				if (command.queue !== "steering" && command.queue !== "followUp") {
					return rpcError(id, "remove_queued_message", 'queue must be "steering" or "followUp"');
				}
				return fitRemoveQueuedMessageResponse(
					id,
					session.takeQueuedMessage(command.message, command.queue),
					maxResponseBytes,
				);
			}

			case "promote_queued_message": {
				if (typeof command.message !== "string") {
					return rpcError(id, "promote_queued_message", "message must be a string");
				}
				return rpcSuccess(id, "promote_queued_message", {
					promoted: session.promoteQueuedMessage(command.message),
				});
			}

			case "abort": {
				host?.goal.stopForHostAbort();
				this.abortBuiltinCommands("RPC command aborted by host");
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return rpcSuccess(id, "abort");
			}

			case "abort_and_restore_queue": {
				// Mirrors the TUI Esc restore: withdraw queued user input (including input the run
				// dequeued but never recorded) before aborting, so neither the aborted turn nor
				// abort()'s stranded-queue drain can run it.
				const restored = session.clearQueue({ forInterrupt: true });
				host?.goal.stopForHostAbort();
				this.abortBuiltinCommands("RPC command aborted by host");
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return fitAbortAndRestoreQueueResponse(id, restored, maxResponseBytes);
			}

			case "abort_and_prompt": {
				host?.goal.stopForHostAbort();
				this.abortBuiltinCommands("RPC command aborted by host");
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				const ticket = this.promptResults.begin(id, conn ? frame => conn.send(frame) : undefined);
				void this.#dispatchOrderedUserInput(command, ticket, conn).then(
					outcome => {
						if (outcome === "cancelled") this.promptResults.settle(ticket);
						else if (outcome === "local") this.promptResults.completeLocal(ticket);
					},
					(cause: unknown) => {
						// Already acknowledged: owe the late same-id error and a failed prompt_result.
						const promptError = cause instanceof Error ? cause : new Error(String(cause));
						this.#onPromptError(id, "abort_and_prompt", conn)(promptError);
						this.promptResults.fail(ticket, promptError.message);
					},
				);
				return rpcSuccess(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch":
			case "fork": {
				// Fast refusal before the goal controller voids a waiting continuation;
				// fork() repeats the check after each of its own awaits.
				if (command.type === "fork" && session.isBusyForSnapshot) {
					return rpcError(id, "fork", new SessionBusyError("fork the session").message, "session_busy");
				}
				const requestedModel =
					command.type === "switch_session" ? await resolveRequestedRpcModel(session, command) : undefined;
				// Validation first: a refused change must not cancel the running side question.
				await host!.stopDictationForSessionChange();
				await host!.btw.close();
				await host!.goal.beginSessionChange();
				let result: RpcSessionChangeResult | undefined;
				try {
					result = await handleRpcSessionChange(session, command, host!.subagents, requestedModel);
				} catch (err) {
					// fork() refuses when work started while its transition awaited.
					if (err instanceof SessionBusyError) return rpcError(id, command.type, err.message, "session_busy");
					throw err;
				} finally {
					// Branch and fork switch files in-process without detaching a run (fork requires idle).
					await host!.goal.endSessionChange({
						detachedRun: command.type !== "branch" && command.type !== "fork" && result?.data.cancelled !== true,
					});
					// Respond only once this change's reattach (and any queued ahead of it) has run.
					await host!.goal.settled();
				}
				if (!result.data.cancelled) {
					this.#inputGate.commitSessionChange(command);
					// `branch` leaves a live run streaming to its normal yield; new/switch detach it.
					if (command.type !== "branch" && command.type !== "fork") this.promptResults.abortOpen();
					// The detached run publishes no terminal agent_end to settle on.
					void host!.settleWatcher.check();
					await this.emitAvailableCommandsUpdate();
				}
				return rpcSuccess(id, result.type, result.data);
			}

			case "navigate_tree": {
				if (typeof command.entryId !== "string") return rpcError(id, "navigate_tree", "entryId must be a string");
				// Validation first: a refused navigation must not cancel the running side question or touch the goal.
				if (!session.sessionManager.getEntry(command.entryId)) {
					return rpcError(id, "navigate_tree", `Entry ${command.entryId} not found`, "entry_not_found");
				}
				// As `fork`: a run would keep writing into the branch the leaf just left.
				if (session.isBusyForSnapshot) {
					const busy = new SessionBusyError("navigate the session tree");
					return rpcError(id, "navigate_tree", busy.message, "session_busy");
				}
				await host!.btw.close();
				// A goal continuation waiting to start is held until the navigation ends, then resumes (same session).
				await host!.goal.beginSessionChange();
				let result: NavigateTreeResult;
				try {
					result = await session.navigateTree(command.entryId, {
						summarize: command.summarize === true,
						customInstructions:
							typeof command.customInstructions === "string" ? command.customInstructions : undefined,
						// Only to detect a re-answer, which moves nothing yet: refused below, since it needs a picker here.
						allowAskReopen: true,
						// Rechecked after the summary: work may have started while it ran.
						requireIdle: true,
					});
				} catch (err) {
					if (err instanceof SessionBusyError) return rpcError(id, "navigate_tree", err.message, "session_busy");
					throw err;
				} finally {
					await host!.goal.endSessionChange();
					// Respond only once a resumed continuation is scheduled.
					await host!.goal.settled();
				}
				if (result.reopenAsk) {
					return rpcError(
						id,
						"navigate_tree",
						"Re-answering an ask is not available over RPC; select another entry",
						"ask_reanswer_unsupported",
					);
				}
				return rpcSuccess(id, "navigate_tree", {
					cancelled: result.cancelled,
					aborted: result.aborted,
					editorText: result.editorText,
				});
			}

			case "abort_branch_summary": {
				session.abortBranchSummary();
				return rpcSuccess(id, "abort_branch_summary");
			}

			case "set_label": {
				if (typeof command.entryId !== "string") return rpcError(id, "set_label", "entryId must be a string");
				if (command.label !== undefined && typeof command.label !== "string") {
					return rpcError(id, "set_label", "label must be a string");
				}
				session.sessionManager.appendLabelChange(command.entryId, command.label);
				return rpcSuccess(id, "set_label");
			}

			case "open_session": {
				const requestedModel = await resolveRequestedRpcModel(session, command);
				await host!.stopDictationForSessionChange();
				const fileBeforeOpen = session.sessionFile;
				await host!.btw.close();
				await host!.goal.beginSessionChange();
				let result: RpcOpenSessionResult | undefined;
				try {
					result = await openRpcSession(session, command.sessionDir, host!.subagents, requestedModel);
				} finally {
					// Opening the session that is already open leaves a live run going (see below).
					await host!.goal.endSessionChange({ detachedRun: session.sessionFile !== fileBeforeOpen });
					// Respond only once this change's reattach (and any queued ahead of it) has run.
					await host!.goal.settled();
				}
				if (!result.cancelled) {
					this.#inputGate.commitSessionChange(command);
					// Opening the session that is already open switches nothing and leaves a live run
					// going. Any real open (switch or new) changes the file, even when an aliased path
					// reopens a transcript with the same id.
					if (session.sessionFile !== fileBeforeOpen) this.promptResults.abortOpen();
					void host!.settleWatcher.check();
					await this.emitAvailableCommandsUpdate();
				}
				return rpcSuccess(id, "open_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				// A goal exit triggered by the last turn restores tools asynchronously; report after it.
				await host?.goal.settled();
				return rpcSuccess(
					id,
					"get_state",
					getRpcSessionState(session, host?.scheduledTurnPending ?? NO_SCHEDULED_TURN),
				);
			}

			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported) {
					return rpcError(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
				}
				return rpcSuccess(id, "set_fast_mode", {
					enabled: session.isFastModeEnabled(),
					active: session.isFastModeActive(),
				});
			}

			case "set_slow_mode": {
				// A truthy non-boolean must not flip a persisted global setting.
				if (typeof command.enabled !== "boolean") {
					return rpcError(id, "set_slow_mode", "set_slow_mode requires boolean enabled");
				}
				const supported = session.setSlowMode(command.enabled);
				if (command.enabled && !supported) {
					return rpcError(id, "set_slow_mode", "Slow mode is unavailable for the current model.");
				}
				return rpcSuccess(id, "set_slow_mode", { enabled: session.isSlowModeEnabled() });
			}

			case "goal": {
				try {
					return rpcSuccess(id, "goal", await host!.goal.handle(command));
				} catch (goalError) {
					return rpcError(id, "goal", goalError instanceof Error ? goalError.message : String(goalError));
				}
			}

			case "set_ask_dialog":
				return host!.setAskDialog(command);

			case "get_available_commands": {
				return rpcSuccess(id, "get_available_commands", {
					commands: await buildAvailableSlashCommands(session),
				});
			}

			case "get_entries": {
				try {
					return rpcSuccess(
						id,
						"get_entries",
						selectRpcEntries(
							session.sessionManager.getEntries(),
							session.sessionManager.getLeafId(),
							command.since,
						),
					);
				} catch (err) {
					return rpcError(id, "get_entries", err instanceof Error ? err.message : String(err), "unknown_since");
				}
			}

			case "get_tree": {
				return rpcSuccess(id, "get_tree", {
					tree: session.sessionManager.getTree(),
					leafId: session.sessionManager.getLeafId(),
				});
			}

			case "set_todos": {
				session.commitTodoPhases(command.phases);
				const phases = session.getTodoPhases();
				return rpcSuccess(id, "set_todos", { todoPhases: phases });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = this.hostToolBridge.setTools(tools, conn);
				await session.refreshRpcHostTools(rpcTools);
				return rpcSuccess(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "live_start":
			case "live_connect": {
				const sdpOffer = command.type === "live_connect" ? command.sdpOffer : undefined;
				// The frame is untyped input: without an offer, live_connect would open the host microphone.
				if (command.type === "live_connect" && (typeof sdpOffer !== "string" || !sdpOffer.trim())) {
					return rpcError(id, command.type, "live_connect requires a non-empty sdpOffer");
				}
				if (host!.dictation.active) return rpcError(id, command.type, "End dictation before starting live voice");
				if (host!.isSessionChanging() || host!.isShuttingDown())
					return rpcError(id, command.type, "Session is changing or shutting down");
				try {
					return rpcSuccess(
						id,
						command.type,
						await host!.live.start({ voice: command.voice, instructions: command.instructions, sdpOffer }),
					);
				} catch (err) {
					return rpcError(id, command.type, err instanceof Error ? err.message : String(err));
				}
			}

			case "live_stop": {
				await host!.live.stop();
				return rpcSuccess(id, "live_stop");
			}

			case "live_mute": {
				try {
					return rpcSuccess(id, "live_mute", host!.live.setMuted(command.muted));
				} catch (err) {
					return rpcError(id, "live_mute", err instanceof Error ? err.message : String(err));
				}
			}

			case "dictation_start": {
				if (host!.live.active) return rpcError(id, "dictation_start", "End live voice before starting dictation");
				if (host!.isSessionChanging() || host!.isShuttingDown())
					return rpcError(id, "dictation_start", "Session is changing or shutting down");
				if (!cfgSttEnabled.get(session.settings))
					return rpcError(id, "dictation_start", "Speech-to-text is disabled. Enable it in settings: stt.enabled");
				await host!.dictation.start(command.captureId);
				return rpcSuccess(id, "dictation_start");
			}

			case "dictation_stop": {
				return rpcSuccess(id, "dictation_stop", await host!.dictation.stop());
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = this.hostUriBridge.setSchemes(command.schemes);
					return rpcSuccess(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return rpcError(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				const subagents = this.#subagents ?? host?.subagents;
				if (!subagents) {
					return rpcError(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return rpcError(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				// Streaming is a view preference: the caller's own level changes, the
				// bus only ever rises to the union so no other view starts receiving.
				const view = conn ?? this.#defaultConn;
				this.#clients.setSubagentSubscription(view, command.level);
				subagents.setSubscriptionLevel(this.#clients.maxSubagentSubscription());
				return rpcSuccess(id, "set_subagent_subscription", {
					level: this.#clients.getSubagentSubscription(view),
				});
			}

			case "set_event_filter": {
				const events = command.events;
				if (
					events !== null &&
					(!Array.isArray(events) || !events.every(event => typeof event === "string" && event.length > 0))
				) {
					return rpcError(
						id,
						"set_event_filter",
						"events must be null or an array of non-empty event type strings",
					);
				}
				const messageUpdates = command.messageUpdates === undefined ? "full" : command.messageUpdates;
				if (messageUpdates !== "full" && messageUpdates !== "delta") {
					return rpcError(id, "set_event_filter", 'messageUpdates must be "full" or "delta"');
				}
				const eventFilter = host?.sessionEvents;
				if (eventFilter) {
					return rpcSuccess(id, "set_event_filter", {
						events: eventFilter.setFilter(events, messageUpdates),
						messageUpdates,
					});
				}
				if (!this.#eventFilter) {
					return rpcError(id, "set_event_filter", "Session event filtering is unavailable on this transport");
				}
				return rpcSuccess(id, "set_event_filter", {
					events: this.#eventFilter(conn, events, messageUpdates),
					messageUpdates,
				});
			}

			case "get_subagents": {
				const subagents = this.#subagents ?? host?.subagents;
				if (!subagents) {
					return rpcError(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return rpcSuccess(id, "get_subagents", { subagents: subagents.getSubagents() });
			}

			case "get_subagent_messages": {
				const subagents = this.#subagents ?? host?.subagents;
				if (!subagents) {
					return rpcError(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return rpcError(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagents.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return rpcSuccess(id, "get_subagent_messages", transcript);
				} catch (err) {
					return rpcError(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			case "cancel_subagent": {
				const subagents = this.#subagents ?? host?.subagents;
				if (!subagents) {
					return rpcError(id, "cancel_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return rpcError(id, "cancel_subagent", "`subagentId` must be a non-empty string.");
				}
				try {
					const cancelled = await handleRpcCancelSubagent(subagents, command.subagentId);
					return rpcSuccess(id, "cancel_subagent", { cancelled });
				} catch (err) {
					return rpcError(id, "cancel_subagent", err instanceof Error ? err.message : String(err));
				}
			}

			case "steer_subagent": {
				const subagents = this.#subagents ?? host?.subagents;
				if (!subagents) {
					return rpcError(id, "steer_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return rpcError(id, "steer_subagent", "`subagentId` must be a non-empty string.");
				}
				if (typeof command.message !== "string" || !command.message.trim()) {
					return rpcError(id, "steer_subagent", "`message` is required for steer_subagent.");
				}
				const failure = await handleRpcSteerSubagent(subagents, command.subagentId, command.message);
				return failure ? rpcError(id, "steer_subagent", failure) : rpcSuccess(id, "steer_subagent");
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const model = await findRpcModel(session, command.provider, command.modelId);
				if (!model) {
					return rpcError(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return rpcSuccess(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return rpcSuccess(id, "cycle_model", null);
				}
				return rpcSuccess(id, "cycle_model", result);
			}

			case "get_available_models": {
				await session.modelRegistry.awaitBackgroundRefresh();
				const models = session.getAvailableModels();
				return rpcSuccess(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return rpcSuccess(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return rpcSuccess(id, "cycle_thinking_level", null);
				}
				return rpcSuccess(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				// Pi-compatible discovery: the selectable levels for the live model,
				// including `off` (which `set_thinking_level` accepts but the
				// effort-only helper excludes). OMP-only `auto`/`inherit` are
				// intentionally omitted — that selector stays an OMP dialect.
				return rpcSuccess(id, "get_available_thinking_levels", {
					levels: [ThinkingLevel.Off, ...session.getAvailableThinkingLevels()],
				});
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				applyRpcQueueModeCommand(session, command);
				return rpcSuccess(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				applyRpcQueueModeCommand(session, command);
				return rpcSuccess(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				applyRpcQueueModeCommand(session, command);
				return rpcSuccess(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return rpcSuccess(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return rpcSuccess(id, "set_auto_compaction");
			}

			// =================================================================
			// Cache warming
			// =================================================================

			case "set_cache_warming": {
				if (!CACHE_WARMING_MODES.includes(command.mode)) {
					return rpcError(id, "set_cache_warming", `Invalid cache warming mode: ${String(command.mode)}`);
				}
				const mode = session.setCacheWarmingMode(command.mode);
				return rpcSuccess(id, "set_cache_warming", { mode });
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return rpcSuccess(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return rpcSuccess(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				// Reject rather than coerce: a falsy non-boolean such as `null` would silently share the output.
				if (command.excludeFromContext !== undefined && typeof command.excludeFromContext !== "boolean") {
					return rpcError(id, "bash", "excludeFromContext must be a boolean");
				}
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
				});
				return rpcSuccess(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return rpcSuccess(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return rpcSuccess(id, "get_session_stats", stats);
			}

			case "get_session_lease": {
				const { sessionIds } = command;
				if (!Array.isArray(sessionIds) || !sessionIds.every(sessionId => typeof sessionId === "string")) {
					return rpcError(id, "get_session_lease", "sessionIds must be an array of strings");
				}
				return rpcSuccess(id, "get_session_lease", probeSessionLeases(sessionIds));
			}

			case "export_html": {
				const outputPath = await session.exportToHtml(command.outputPath);
				return rpcSuccess(id, "export_html", { path: outputPath });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return rpcSuccess(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return rpcSuccess(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return rpcError(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return rpcError(id, "set_session_name", "Session name cannot be empty");
				}
				return rpcSuccess(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return rpcError(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return rpcSuccess(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return rpcSuccess(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return rpcError(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = session.messages;
				try {
					return rpcSuccess(
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
					return rpcError(
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
				return rpcSuccess(id, "get_login_providers", { providers });
			}

			case "login": {
				if (!conn) return host!.login(command);
				if (this.#socketLogins.has(conn)) {
					return rpcError(id, "login", "A login is already in progress on this connection");
				}
				const controller = new AbortController();
				const pendingRequests = new RpcPendingExtensionRequests(() => conn);
				this.#socketLogins.set(conn, { controller, pendingRequests });
				try {
					return await loginOverRpc({
						session,
						command,
						pendingExtensionRequests: pendingRequests,
						output: frame => {
							if (conn.isOpen && !controller.signal.aborted) conn.send(frame);
						},
						signal: controller.signal,
					});
				} finally {
					this.#socketLogins.delete(conn);
				}
			}

			case "get_logout_accounts": {
				// An absent provider would list every provider's credentials.
				if (typeof command.providerId !== "string") {
					return rpcError(id, "get_logout_accounts", "providerId must be a string");
				}
				const accounts = await listLogoutAccounts(
					session.modelRegistry.authStorage,
					command.providerId,
					session.sessionId,
				);
				return rpcSuccess(id, "get_logout_accounts", { accounts });
			}

			case "logout": {
				if (typeof command.providerId !== "string" || !Number.isInteger(command.credentialId)) {
					return rpcError(id, "logout", "providerId must be a string and credentialId an integer");
				}
				const { removed, remainingSource } = await logoutCredential(
					session,
					command.providerId,
					command.credentialId,
				);
				if (!removed) {
					return rpcError(
						id,
						"logout",
						`Credential ${command.credentialId} is not stored for ${command.providerId}`,
					);
				}
				return rpcSuccess(id, "logout", { remainingSource });
			}

			// =================================================================
			// Side questions (/btw)
			// =================================================================

			case "btw": {
				const record = await host!.btw.ask(command.question, command.recordId);
				return rpcSuccess(id, "btw", { record });
			}

			case "btw_cancel":
				return rpcSuccess(id, "btw_cancel", { cancelled: host!.btw.cancel(command.recordId) });

			case "get_btw_history":
				return rpcSuccess(id, "get_btw_history", { records: await host!.btw.history() });

			// =================================================================
			// Word prediction
			// =================================================================

			case "predict_word": {
				if (!isTextCursor(command.text, command.cursor)) {
					return rpcError(id, "predict_word", INVALID_TEXT_CURSOR_ERROR);
				}
				try {
					const method = cfgSpellingAutocomplete.get(session.settings);
					const suffix = await this.wordPredictor.predict(method, command.text, command.cursor);
					return rpcSuccess(id, "predict_word", { suffix });
				} catch (err: unknown) {
					return rpcError(id, "predict_word", err instanceof Error ? err.message : String(err));
				}
			}

			case "predict_word_feedback": {
				if (!isTextCursor(command.text, command.cursor)) {
					return rpcError(id, "predict_word_feedback", INVALID_TEXT_CURSOR_ERROR);
				}
				if (typeof command.suggestion !== "string" || typeof command.accepted !== "boolean") {
					return rpcError(id, "predict_word_feedback", "suggestion must be a string and accepted a boolean");
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
				return rpcSuccess(id, "predict_word_feedback");
			}

			default: {
				const unknownCommand = command as { type: string };
				return rpcError(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	}
}

/**
 * Serve this surface to every client attaching at the session endpoint, and
 * re-publish when the process-level wake-up (SIGUSR2) says the session moved.
 * Returns a detach callback for the SIGUSR2 listener. `intercept` sees each
 * frame before command dispatch and claims the ones this transport owns.
 */
export async function publishSessionSocket(
	socket: RpcSessionSocket,
	surface: RpcCommandSurface,
	intercept?: (frame: unknown, conn: RpcClientConn) => boolean,
): Promise<() => void> {
	await socket.listen(conn => {
		const bound = surface.createSocketSurface(conn);
		if (!intercept) return bound;
		return {
			...bound,
			dispatch: frame => {
				if (intercept(frame, conn)) return;
				bound.dispatch(frame);
			},
		};
	});
	const rebind = () => void socket.rebind().catch(() => {});
	process.on("SIGUSR2", rebind);
	return () => process.off("SIGUSR2", rebind);
}

/**
 * Transport-local request from an attaching terminal mirror. It is not an
 * `RpcCommand`: only a publication that owns a broker PTY accepts it, so it
 * never becomes a host capability for ordinary RPC clients.
 */
export interface InteractiveTerminalRefreshFrame {
	readonly type: "terminal_refresh";
	readonly id: string;
	readonly sessionId: string;
	readonly generation: string;
}

export interface InteractiveTerminalRefreshedFrame {
	readonly type: "terminal_refreshed";
	readonly id: string;
	readonly sessionId: string;
	readonly generation: string;
}

export interface InteractiveTerminalRefreshErrorFrame {
	readonly type: "terminal_refresh_error";
	readonly id: string;
	readonly message: string;
}

/** The broker-owner attachment this publication accepts refreshes for. */
export interface InteractiveTerminalControl {
	/** Broker generation that owns this publication; a refresh for another generation is refused. */
	readonly generation: string;
	/** Restart this session's renderer and force a full repaint for the new terminal. */
	refresh(): void;
}

function terminalRefreshFrame(frame: unknown): InteractiveTerminalRefreshFrame | undefined {
	if (typeof frame !== "object" || frame === null) return undefined;
	const candidate = frame as Partial<InteractiveTerminalRefreshFrame>;
	if (candidate.type !== "terminal_refresh") return undefined;
	if (typeof candidate.id !== "string" || typeof candidate.sessionId !== "string") return undefined;
	if (typeof candidate.generation !== "string") return undefined;
	return candidate as InteractiveTerminalRefreshFrame;
}

export interface ServedSessionSocket {
	readonly surface: RpcCommandSurface;
	/** Detach the listener and unsubscribe the surface from the session. */
	close(): Promise<void>;
}

/**
 * One attached view's session-event pipeline. The forwarder both stamps
 * message ids and applies `set_event_filter`, so each view keeps its own
 * message ids and its own selection; `project` captures the frame the
 * forwarder would emit for this event.
 */
class SocketEventView {
	#capture: ((frame: RpcProjectedSessionEventFrame) => void) | undefined;
	readonly forwarder = new RpcSessionEventForwarder(frame => this.#capture?.(frame));

	project(event: object): object | undefined {
		let projected: RpcProjectedSessionEventFrame | undefined;
		this.#capture = frame => {
			projected = frame;
		};
		try {
			this.forwarder.forward(event as AgentSessionEvent);
		} finally {
			this.#capture = undefined;
		}
		return projected;
	}

	setFilter(events: readonly string[] | null, messageUpdates: RpcMessageUpdates): string[] | null {
		return this.forwarder.setFilter(events, messageUpdates);
	}
}

/**
 * Commands a shared, bound session socket must refuse: they replace the
 * transcript identity, which would swap the file out from under the terminal
 * and every sibling viewer. Everything inside the bound session's tree (branch
 * navigation, btw, goals, live voice, dictation, login, event filters) is
 * served by the same host services the stdio runner uses.
 */
const SHARED_SESSION_REFUSED_COMMANDS: Readonly<Record<string, true>> = {
	new_session: true,
	switch_session: true,
	open_session: true,
	fork: true,
	handoff: true,
};

/**
 * Publish a terminal-hosted (interactive) session's command surface on its
 * endpoint. Negotiation, state reads, prompts/steers, host tools, per-client
 * authentication and the session-scoped host commands (branch navigation,
 * /btw, goals, live voice, dictation, login, per-view event filters) are
 * served; session swaps (`new_session`, `switch_session`, `open_session`,
 * `fork`, `handoff`) are refused because this socket is bound to one transcript.
 * The session itself is never owned by a client: closing the endpoint or losing
 * a client leaves the session and its turn running.
 *
 * Dialogs raced by the served surface are issued to an attached
 * {@link DialogFirstResponder}; a pending request is only cancelled by the
 * client's own dismissal or by this publication closing, never by a sibling
 * view disconnecting.
 */
export async function serveInteractiveSessionSocket(options: {
	session: AgentSession;
	socket: RpcSessionSocket;
	/** Present only when this publication owns a broker PTY that a mirror can attach to. */
	terminalControl?: InteractiveTerminalControl;
	/**
	 * The session tree's own subagent event bus, so a client sees exactly the
	 * roster the terminal sees. Absent means this publication serves no
	 * subagent read/control and refuses those commands.
	 */
	subagentEventBus?: EventBus;
	/** The session's live MCP manager; the publication has no host to supply it. */
	mcpManager?: MCPManager;
	/** The terminal's dialog fanout, so socket clients can answer terminal dialogs. */
	firstResponder?: DialogFirstResponder;
	/** The terminal's shutdown state; `new_session`-free surfaces report it verbatim. */
	isShuttingDown?: () => boolean;
}): Promise<ServedSessionSocket> {
	const session = options.session;
	const clients = new RpcClientRegistry();
	const output: RpcOutput = frame => clients.broadcast(frame);
	const defaultConn = new RpcClientConnection({ id: "interactive", send: frame => clients.broadcast(frame) });
	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();
	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const eventViews = new WeakMap<RpcClientConn, SocketEventView>();
	const eventView = (conn: RpcClientConn): SocketEventView => {
		let view = eventViews.get(conn);
		if (!view) {
			view = new SocketEventView();
			eventViews.set(conn, view);
		}
		return view;
	};
	options.socket.setEventProjector((event, conn) => eventView(conn).project(event));

	const btw = new RpcBtwController(session, output);
	const goal = new RpcGoalController(session, () => void settleWatcher.check());
	const goalTurnScheduled = watchedScheduledTurnProbe(
		() => goal.continuationPending,
		() => settleWatcher,
	);
	const settleWatcher = new RpcSessionSettleWatcher(session, output, goalTurnScheduled);
	const promptResults = new RpcPromptResults(session, output, goalTurnScheduled, {
		costCapRefusal: () => session.costCapRefusal,
		settledWithoutRun: () => void settleWatcher.check(),
	});
	const live = new RpcLiveBridge(session, output);
	const dictation = new RpcDictationBridge(session, output);
	const subagents = options.subagentEventBus
		? new RpcSubagentRegistry(options.subagentEventBus, frame => clients.broadcastSubagent(frame))
		: undefined;

	let sessionChanges = 0;
	const withSessionChange = async <T>(change: () => Promise<T>): Promise<T> => {
		sessionChanges++;
		try {
			return await change();
		} finally {
			sessionChanges--;
		}
	};
	const backgroundTasks = new Set<Promise<void>>();
	const trackBackgroundTask = (task: Promise<void>): void => {
		backgroundTasks.add(task);
		void task
			.catch(error => logger.warn("Interactive socket background command failed", { error: String(error) }))
			.finally(() => backgroundTasks.delete(task));
	};

	const broadcastDialogCancel = (targetId: string): void => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId,
		} as RpcExtensionUIRequest);
	};
	const issueDialog = <T>(issue: (issued: (id: string) => void) => Promise<T>): DialogRequestHandle<T> => {
		let requestId: string | undefined;
		const promise = issue(id => {
			requestId = id;
		});
		return {
			id: requestId,
			promise,
			cancel: () => {
				if (requestId !== undefined) broadcastDialogCancel(requestId);
			},
		};
	};
	const firstResponder = options.firstResponder;
	const dialogBridge: DialogSocketBridge | undefined = firstResponder
		? {
				hasClients: () => clients.hasOpenClients(),
				select: (title, selectOptions, dialogOptions) =>
					issueDialog(issued =>
						requestRpcSelect(pendingExtensionRequests, output, title, selectOptions, dialogOptions, issued),
					),
				confirm: (title, message, dialogOptions) =>
					issueDialog(issued =>
						requestRpcConfirm(pendingExtensionRequests, output, title, message, dialogOptions, issued),
					),
				input: (title, placeholder, dialogOptions) =>
					issueDialog(issued =>
						requestRpcInput(pendingExtensionRequests, output, title, placeholder, dialogOptions, issued),
					),
				editor: (title, prefill, dialogOptions, editorOptions) =>
					issueDialog(issued =>
						requestRpcEditor(
							pendingExtensionRequests,
							output,
							title,
							prefill,
							dialogOptions,
							editorOptions,
							issued,
						),
					),
				ask: (questions, dialogOptions) =>
					issueDialog(issued =>
						requestRpcAskDialog(pendingExtensionRequests, output, questions, dialogOptions, issued),
					),
				dismiss: broadcastDialogCancel,
			}
		: undefined;
	if (dialogBridge) firstResponder?.attach(dialogBridge);

	const setAskDialog = (command: RpcCommand & { type: "set_ask_dialog" }): RpcResponse => {
		const enabled = command.enabled === true;
		firstResponder?.setAskDialogEnabled(enabled);
		return rpcSuccess(command.id, "set_ask_dialog", { enabled });
	};
	const surface = new RpcCommandSurface({
		session,
		output,
		clients,
		defaultConn,
		maxResponseBytes: () => MAX_RPC_FRAME_BYTES,
		pendingExtensionRequests,
		promptResults,
		extensionUserMessageTracker,
		subagents,
		refusedCommands: SHARED_SESSION_REFUSED_COMMANDS,
		eventFilter: (conn, events, messageUpdates) => eventView(conn ?? defaultConn).setFilter(events, messageUpdates),
		host: {
			goal,
			settleWatcher,
			btw,
			live,
			dictation,
			subagents,
			mcpManager: options.mcpManager,
			scheduledTurnPending: goalTurnScheduled,
			isSessionChanging: () => sessionChanges > 0,
			isShuttingDown: options.isShuttingDown ?? (() => false),
			stopDictationForSessionChange: async () => {
				await dictation.stop();
			},
			withSessionChange,
			setAskDialog,
			login: command => loginOverRpc({ session, command, pendingExtensionRequests, output }),
			trackBackgroundTask,
		},
	});
	await goal.reconcile();
	surface.start();
	const terminalControl = options.terminalControl;
	const detachWake = await publishSessionSocket(options.socket, surface, (frame, conn) => {
		const refresh = terminalRefreshFrame(frame);
		if (!refresh) return false;
		if (!terminalControl) {
			const reply: InteractiveTerminalRefreshErrorFrame = {
				type: "terminal_refresh_error",
				id: refresh.id,
				message: "terminal refresh unavailable: this publication has no broker attachment",
			};
			conn.send(reply);
			return true;
		}
		const sessionId = session.sessionId;
		if (refresh.sessionId !== sessionId || refresh.generation !== terminalControl.generation) {
			const reply: InteractiveTerminalRefreshErrorFrame = {
				type: "terminal_refresh_error",
				id: refresh.id,
				message: `terminal refresh refused: session ${refresh.sessionId} generation ${refresh.generation} is not this attachment`,
			};
			conn.send(reply);
			return true;
		}
		try {
			terminalControl.refresh();
		} catch (error) {
			const reply: InteractiveTerminalRefreshErrorFrame = {
				type: "terminal_refresh_error",
				id: refresh.id,
				message: `terminal refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			};
			conn.send(reply);
			return true;
		}
		const reply: InteractiveTerminalRefreshedFrame = {
			type: "terminal_refreshed",
			id: refresh.id,
			sessionId,
			generation: terminalControl.generation,
		};
		conn.send(reply);
		return true;
	});
	let publishedSessionId = session.sessionId;
	const unsubscribeIdentity = session.subscribe(() => {
		const sessionId = session.sessionId;
		if (sessionId === publishedSessionId) return;
		publishedSessionId = sessionId;
		subagents?.clear();
		void options.socket.rebind().catch(rebindError => {
			logger.warn("RPC session socket rebind failed", { error: String(rebindError) });
		});
	});
	return {
		surface,
		close: async () => {
			unsubscribeIdentity();
			detachWake();
			if (dialogBridge) firstResponder?.detach(dialogBridge);
			options.socket.setEventProjector(undefined);
			surface.dispose();
			subagents?.dispose();
			dictation.dispose();
			await Promise.allSettled([btw.close(), live.stop(), ...backgroundTasks]);
			await options.socket.close();
		},
	};
}
