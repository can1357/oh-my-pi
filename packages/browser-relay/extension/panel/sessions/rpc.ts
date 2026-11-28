/**
 * Panel session over a worker-owned `omp --mode rpc` process behind the native host.
 *
 * The worker relays rpc JSON lines both ways (`rpcSend` request, `rpcLine` events); this adapter turns them into
 * the same {@link PanelSnapshot} collab-web's `GuestClient` builds from collab frames, so the panel renders either
 * source with one transcript. Committed transcript rows come from the session itself (`get_entries`, fetched
 * incrementally after every finished message), which also lets a panel that attaches late show the full history;
 * an `entry_patch` record a later read returns sets its fields on the rows earlier reads brought. The streaming
 * assistant message, running tools and liveness come from the event stream.
 *
 * High-rate events (`message_update`, `tool_execution_update`) are published at most once per animation frame;
 * everything else publishes synchronously.
 */
import type { ActiveTool, ConnectionPhase, Notice } from "@oh-my-pi/collab-web/src/lib/client";
import { repaintPatchedRows, type TranscriptLine } from "@oh-my-pi/collab-web/src/lib/entry-patch-rows";
import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	EntryPatchEntry,
	ImageContent,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import type {
	AbortAndRestoreQueueResult,
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	CommandOutputEvent,
	ConfigUpdateEvent,
	ConfiguredThinkingLevel,
	ExtensionError,
	ExtensionUiRequest,
	ExtensionUiResponse,
	ManualCompactionEndEvent,
	ManualCompactionStartEvent,
	ModelChangedEvent,
	ModelInfo,
	ModelPickerResult,
	NoticeEvent,
	PromptResultEvent,
	QueueUpdateEvent,
	ReadyEvent,
	RpcFrameErrorEvent,
	SessionState as RpcState,
	SessionInfoUpdateEvent,
	ThinkingLevelChangedEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "../../../../coding-agent/src/modes/rpc/wire/rpc-wire.generated";
import { EntryPatchReplay, isEntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";
import { errorMessage } from "@oh-my-pi/pi-utils/type-guards";
import type { RpcSessionInfo } from "../../messages";
import type { PanelModel, PanelSession, PanelSnapshot, PanelThinking, PanelWorker, QueuedDraft } from "../session";

const MAX_NOTICES = 50;
/** Coalescing window for high-rate events: about one display frame. */
const FRAME_MS = 16;
/** Session entry types the transcript renders (pi-wire's `SessionEntry` union). */
const WIRE_ENTRY_TYPES: Record<string, true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

/** Successful responses to the commands this adapter sends. */
type RpcOk =
	| { type: "response"; id?: string; command: "get_state"; success: true; data: RpcState }
	| {
			type: "response";
			id?: string;
			command: "get_entries";
			success: true;
			data: { entries: unknown[]; leafId: string | null };
	  }
	| { type: "response"; id?: string; command: "get_available_models"; success: true; data: { models: ModelInfo[] } }
	| { type: "response"; id?: string; command: "get_model_picker"; success: true; data: ModelPickerResult }
	| {
			type: "response";
			id?: string;
			command: "abort_and_restore_queue";
			success: true;
			data: AbortAndRestoreQueueResult;
	  }
	| {
			type: "response";
			id?: string;
			command:
				| "prompt"
				| "abort_and_deliver_queue"
				| "resume"
				| "set_model"
				| "set_thinking_level"
				| "compact"
				| "set_subagent_subscription";
			success: true;
			data?: unknown;
	  };

/** Failed response to any command. */
type RpcFail = { type: "response"; id?: string; command: string; success: false; error: string; code?: string };

/** Message lifecycle frames, read with pi-wire's message shapes (the same JSON a collab host forwards). */
type RpcMessageEvent = {
	type: "message_start" | "message_update" | "message_end";
	message: WireMessage;
	messageId?: string;
};

/** Every rpc stdout frame this adapter acts on; anything else is ignored. */
type RpcFrame =
	| RpcOk
	| RpcFail
	| ReadyEvent
	| AgentStartEvent
	| AgentEndEvent
	| RpcMessageEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| NoticeEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| ManualCompactionStartEvent
	| ManualCompactionEndEvent
	| ModelChangedEvent
	| ThinkingLevelChangedEvent
	| QueueUpdateEvent
	| PromptResultEvent
	| SessionInfoUpdateEvent
	| ConfigUpdateEvent
	| ExtensionUiRequest
	| ExtensionError
	| CommandOutputEvent
	| RpcFrameErrorEvent
	| { type: "subagent_lifecycle"; payload: SubagentLifecyclePayload }
	| { type: "subagent_progress"; payload: SubagentProgressPayload };

/** Commands this adapter sends, keyed by `type`. */
type RpcCommand =
	| { type: "get_state" }
	| { type: "get_entries"; since?: string }
	| { type: "get_available_models" }
	| { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior: "steer" | "followUp" }
	| { type: "abort_and_restore_queue" }
	| { type: "abort_and_deliver_queue" }
	| { type: "resume" }
	| { type: "get_model_picker"; query: string }
	| { type: "set_model"; provider: string; modelId: string; thinkingLevel?: ConfiguredThinkingLevel; role?: string }
	| { type: "set_thinking_level"; level: ConfiguredThinkingLevel }
	| { type: "compact" }
	| { type: "set_subagent_subscription"; level: "progress" };

/** An rpc dialog shown as a collab UI request; `method` decides how the answer is encoded. */
interface PendingUi {
	request: CollabUiRequest;
	rpcId: string;
	method: "select" | "confirm" | "input" | "editor";
}

/** A rejected rpc command; `code` is the server's machine-readable reason. */
class RpcCommandError extends Error {
	constructor(
		message: string,
		readonly code: string | undefined,
	) {
		super(message);
		this.name = "RpcCommandError";
	}
}

const CONFIRM_YES = "Yes";
const CONFIRM_NO = "No";

function isWireEntry(value: unknown): value is SessionEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.hasOwn(WIRE_ENTRY_TYPES, String(Reflect.get(value, "type"))) &&
		typeof Reflect.get(value, "id") === "string"
	);
}

/** Whether `value` is an `entry_patch` record: it sets fields on rows the panel holds and is never a row itself. */
function isPatchRecord(value: unknown): value is EntryPatchEntry {
	return typeof value === "object" && value !== null && isEntryPatchRecord(value);
}

function entryId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const id: unknown = Reflect.get(value, "id");
	return typeof id === "string" ? id : undefined;
}

/** {@link PanelSession} over one rpc session the worker owns. */
export class RpcPanelSession implements PanelSession {
	readonly kind = "rpc";
	readonly id: string;
	readonly #worker: PanelWorker;
	readonly #info: RpcSessionInfo;
	readonly #listeners = new Set<() => void>();
	readonly #pending = new Map<string, { resolve: (response: RpcOk) => void; reject: (error: Error) => void }>();
	readonly #idPrefix = `panel-${crypto.randomUUID().slice(0, 8)}-`;
	readonly #unsubscribeWorker: () => void;
	#seq = 0;
	#noticeSeq = 0;
	/** Set by {@link detach}: no more worker events, calls or publishes. */
	#detached = false;
	#uiSeq = 0;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#rpcState: RpcState | null = null;
	#working = false;
	#aborting = false;
	#queuedMessageCount = 0;
	#header: SessionHeader | null = null;
	#state: SessionState | null = null;
	#thinking: PanelThinking | undefined;
	#entries: readonly SessionEntry[] = [];
	/** Id of the last raw session entry fetched (any type); the `get_entries` cursor. */
	#cursor: string | undefined;
	/** The rows of {@link #entries} by id, and the `entry_patch` records later reads returned for them. */
	readonly #patches = new EntryPatchReplay<TranscriptLine>();
	#entriesBusy = false;
	#entriesDirty = false;
	#stateBusy = false;
	#stateDirty = false;
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	#uiRequests: readonly PendingUi[] = [];
	#notices: readonly Notice[] = [];
	#snapshot: PanelSnapshot;
	#frameTimer: Timer | null = null;
	/** In-flight or settled `get_available_models`; cleared when it fails. */
	#models: Promise<readonly PanelModel[]> | null = null;

	constructor(worker: PanelWorker, info: RpcSessionInfo) {
		this.#worker = worker;
		this.#info = info;
		this.id = info.sessionKey;
		this.#snapshot = this.#buildSnapshot();
		this.#unsubscribeWorker = worker.onEvent(event => {
			if (event.event === "rpcLine" && event.sessionKey === info.sessionKey) this.#applyLine(event.line);
			else if (event.event === "rpcSessions") {
				const session = event.sessions.find(candidate => candidate.sessionKey === info.sessionKey);
				if (!session) this.#end("the session was closed");
				else if (session.exited) this.#endExited(session.exited);
			}
		});
		if (info.exited) {
			this.#endExited(info.exited);
			return;
		}
		void this.#attach();
	}

	get title(): string {
		return (
			this.#rpcState?.sessionName ||
			this.#info.title ||
			this.#info.cwd.split(/[\\/]/).filter(Boolean).at(-1) ||
			"omp"
		);
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getSnapshot(): PanelSnapshot {
		return this.#snapshot;
	}

	prompt(text: string, images: readonly ImageContent[], options: { followUp?: boolean } = {}): void {
		this.#send(
			{
				type: "prompt",
				message: text,
				...(images.length > 0 ? { images: [...images] } : {}),
				streamingBehavior: options.followUp ? "followUp" : "steer",
			},
			"prompt failed",
		);
	}

	resume(): void {
		this.#send({ type: "resume" }, "couldn’t continue");
	}

	deliverQueue(): void {
		this.#send({ type: "abort_and_deliver_queue" }, "couldn’t interrupt");
	}

	/** Fire-and-forget `command`; a failure becomes an error notice led by `failure`. */
	#send(command: RpcCommand, failure: string): void {
		this.#call(command).catch(error => {
			this.#pushNotice("error", `${failure}: ${errorMessage(error)}`);
			this.#commit();
		});
	}

	async abort(): Promise<readonly QueuedDraft[]> {
		if (this.#phase === "ended") throw new Error(this.#endedReason ?? "the session has ended");
		this.#aborting = true;
		this.#rebuildState();
		this.#commit();
		try {
			const response = await this.#call({ type: "abort_and_restore_queue" });
			if (response.command !== "abort_and_restore_queue")
				throw new Error("unexpected response to abort_and_restore_queue");
			const { steering, followUp, imagesDropped, truncated } = response.data;
			if (truncated) this.#pushNotice("warning", "some queued messages were too large to hand back");
			else if (imagesDropped) this.#pushNotice("warning", "queued images were too large to hand back");
			return [...steering, ...followUp].map(message => ({ text: message.text, images: message.images ?? [] }));
		} finally {
			this.#aborting = false;
			this.#rebuildState();
			this.#commit();
		}
	}

	answer(reqId: number, value: CollabUiResponseValue): void {
		const pending = this.#uiRequests.find(candidate => candidate.request.reqId === reqId);
		if (!pending) return;
		this.#uiRequests = this.#uiRequests.filter(candidate => candidate !== pending);
		this.#commit();
		const id = pending.rpcId;
		let response: ExtensionUiResponse;
		if (value === undefined) response = { type: "extension_ui_response", id, cancelled: true };
		else if (pending.method === "confirm") response = { type: "extension_ui_response", id, confirmed: value === CONFIRM_YES };
		else response = { type: "extension_ui_response", id, value };
		this.#sendUiResponse(response);
	}

	#sendUiResponse(response: ExtensionUiResponse): void {
		this.#sendLine(JSON.stringify(response)).catch(error => {
			this.#pushNotice("error", `answer failed: ${errorMessage(error)}`);
			this.#commit();
		});
	}

	listModels(): Promise<readonly PanelModel[]> {
		// The catalog can run to thousands of models (megabytes over the native host): fetch it once per session.
		this.#models ??= this.#fetchModels().catch(error => {
			this.#models = null;
			throw error;
		});
		return this.#models;
	}

	async #fetchModels(): Promise<readonly PanelModel[]> {
		const response = await this.#call({ type: "get_available_models" });
		if (response.command !== "get_available_models") throw new Error("unexpected response to get_available_models");
		return response.data.models.map(model => ({ provider: model.provider, id: model.id, name: model.name }));
	}

	async pickModels(query: string): Promise<ModelPickerResult> {
		const response = await this.#call({ type: "get_model_picker", query });
		if (response.command !== "get_model_picker") throw new Error("unexpected response to get_model_picker");
		return response.data;
	}

	async setModel(
		model: PanelModel,
		options: { thinkingLevel?: ConfiguredThinkingLevel; role?: string } = {},
	): Promise<void> {
		await this.#call({ type: "set_model", provider: model.provider, modelId: model.id, ...options });
		this.#refreshState();
	}

	async setThinkingLevel(level: ConfiguredThinkingLevel): Promise<void> {
		await this.#call({ type: "set_thinking_level", level });
	}

	async compact(): Promise<void> {
		await this.#call({ type: "compact" });
		this.#refreshEntries();
		this.#refreshState();
	}

	detach(): void {
		if (this.#detached) return;
		this.#detached = true;
		this.#unsubscribeWorker();
		if (this.#frameTimer !== null) {
			clearTimeout(this.#frameTimer);
			this.#frameTimer = null;
		}
		const error = new Error("the panel left this session");
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#listeners.clear();
	}

	close(): void {
		this.#end("closed");
		this.detach();
		this.#worker.request("rpcClose", { sessionKey: this.#info.sessionKey }).catch(() => {});
	}

	/** Loads what a late joiner missed: session state and every committed entry. */
	async #attach(): Promise<void> {
		this.#call({ type: "set_subagent_subscription", level: "progress" }).catch(() => {});
		try {
			await Promise.all([this.#loadState(), this.#loadEntries()]);
		} catch (error) {
			this.#end(`could not load the session: ${errorMessage(error)}`);
			return;
		}
		if (this.#phase === "connecting") {
			this.#phase = "live";
			this.#commit();
		}
	}

	#sendLine(line: string): Promise<void> {
		return this.#worker.request("rpcSend", { sessionKey: this.#info.sessionKey, line });
	}

	/** Sends `command` and resolves with its successful response; rejects on failure or when the session ends. */
	#call(command: RpcCommand): Promise<RpcOk> {
		if (this.#phase === "ended") return Promise.reject(new Error(this.#endedReason ?? "the session has ended"));
		if (this.#detached) return Promise.reject(new Error("the panel left this session"));
		const id = `${this.#idPrefix}${++this.#seq}`;
		const { promise, resolve, reject } = Promise.withResolvers<RpcOk>();
		this.#pending.set(id, { resolve, reject });
		this.#sendLine(JSON.stringify({ id, ...command })).catch(error => {
			this.#pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
		return promise;
	}

	/** Single-flight `get_entries` fetch; a request while one runs schedules one more pass. */
	#refreshEntries(): void {
		this.#loadEntries().catch(error => {
			if (this.#phase === "ended") return;
			this.#pushNotice("warning", `could not refresh the transcript: ${errorMessage(error)}`);
			this.#commit();
		});
	}

	async #loadEntries(): Promise<void> {
		if (this.#entriesBusy) {
			this.#entriesDirty = true;
			return;
		}
		this.#entriesBusy = true;
		try {
			do {
				this.#entriesDirty = false;
				await this.#fetchEntries();
			} while (this.#entriesDirty && this.#phase !== "ended");
		} finally {
			this.#entriesBusy = false;
		}
	}

	async #fetchEntries(): Promise<void> {
		const since = this.#cursor;
		let response: RpcOk;
		try {
			response = await this.#call({ type: "get_entries", ...(since === undefined ? {} : { since }) });
		} catch (error) {
			// The cursor vanished (the session was replaced): start over from the whole transcript.
			if (!(error instanceof RpcCommandError) || error.code !== "unknown_since" || since === undefined) throw error;
			this.#cursor = undefined;
			response = await this.#call({ type: "get_entries" });
		}
		if (response.command !== "get_entries") throw new Error("unexpected response to get_entries");
		const replace = this.#cursor === undefined;
		const raw = response.data.entries;
		const lastId = entryId(raw.at(-1));
		if (lastId !== undefined) this.#cursor = lastId;
		const fresh = raw.filter(isWireEntry);
		// This read's entries carry the fields of its records already. A record sets them on the rows of earlier
		// reads only (`docs/rpc.md`), and its patch for an entry of this read is dropped: replayed there, it could
		// undo a later rewrite of that entry.
		let changed: readonly TranscriptLine[] = [];
		if (replace) this.#patches.clear();
		else {
			const records = raw.filter(isPatchRecord);
			if (records.length > 0) changed = this.#patches.add(records);
			for (const entry of fresh) this.#patches.forget(entry.id);
		}
		this.#patches.add(fresh);
		if (!replace && fresh.length === 0 && changed.length === 0) return;
		// A row a record changed goes back on screen as a new object, since the transcript memoizes rows by identity.
		const kept = changed.length > 0 ? repaintPatchedRows(this.#entries, changed) : this.#entries;
		this.#entries = replace ? fresh : [...kept, ...fresh];
		// The committed row supersedes the finished stream ghost.
		if (
			this.#streamDone &&
			fresh.some(entry => entry.type === "message" && entry.message.role === "assistant")
		) {
			this.#stream = null;
			this.#streamDone = false;
		}
		this.#commit();
	}

	/** Single-flight `get_state` fetch, as {@link #refreshEntries}. */
	#refreshState(): void {
		this.#loadState().catch(error => {
			if (this.#phase === "ended") return;
			this.#pushNotice("warning", `could not refresh the session state: ${errorMessage(error)}`);
			this.#commit();
		});
	}

	async #loadState(): Promise<void> {
		if (this.#stateBusy) {
			this.#stateDirty = true;
			return;
		}
		this.#stateBusy = true;
		try {
			do {
				this.#stateDirty = false;
				const response = await this.#call({ type: "get_state" });
				if (response.command !== "get_state") throw new Error("unexpected response to get_state");
				// Large dump fields are never shown; don't keep them alive.
				const { systemPrompt: _systemPrompt, dumpTools: _dumpTools, ...state } = response.data;
				this.#rpcState = state;
				this.#working = state.isStreaming === true;
				this.#queuedMessageCount = state.queuedMessageCount ?? 0;
				if (!this.#working) {
					// Idle implies no tool can be running.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				this.#rebuildState();
				this.#commit();
			} while (this.#stateDirty && this.#phase !== "ended");
		} finally {
			this.#stateBusy = false;
		}
	}

	#rebuildState(): void {
		const rpc = this.#rpcState;
		if (!rpc) return;
		const cwd = this.#info.cwd;
		this.#header = {
			type: "session",
			id: rpc.sessionId,
			title: rpc.sessionName,
			timestamp: new Date(this.#info.startedAt).toISOString(),
			cwd,
		};
		const model = rpc.model;
		const usage = rpc.contextUsage;
		this.#state = {
			isStreaming: this.#working,
			queuedMessageCount: this.#queuedMessageCount,
			sessionName: rpc.sessionName,
			cwd,
			model: model && { id: model.id, name: model.name, provider: model.provider, contextWindow: model.contextWindow },
			thinkingLevel: rpc.thinkingLevel,
			contextUsage: usage && { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent },
			participants: [],
			...(this.#aborting ? { isAborting: true } : {}),
		};
		const level = rpc.configuredThinkingLevel ?? rpc.thinkingLevel;
		this.#thinking = level === undefined ? undefined : { level, levels: rpc.thinkingLevels ?? [] };
	}

	#applyLine(line: string): void {
		let frame: RpcFrame;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		try {
			this.#applyFrame(frame);
		} catch (error) {
			console.warn("omp panel: failed to apply rpc frame", frame.type, error);
		}
	}

	#applyFrame(frame: RpcFrame): void {
		switch (frame.type) {
			case "response": {
				const id = frame.id;
				const pending = id === undefined ? undefined : this.#pending.get(id);
				if (!pending || id === undefined) return;
				this.#pending.delete(id);
				if (frame.success) pending.resolve(frame);
				else pending.reject(new RpcCommandError(frame.error, frame.code));
				return;
			}
			case "message_start":
			case "message_update":
				if (frame.message.role !== "assistant") return;
				this.#stream = frame.message;
				this.#streamDone = false;
				if (frame.type === "message_update") {
					this.#scheduleCommit();
					return;
				}
				break;
			case "message_end":
				if (frame.message.role === "assistant") {
					this.#stream = frame.message;
					this.#streamDone = true;
				}
				this.#refreshEntries();
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: frame.toolCallId,
					toolName: frame.toolName,
					args: frame.args,
					intent: frame.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(frame.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(frame.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: frame.partialResult }
					: {
							toolCallId: frame.toolCallId,
							toolName: frame.toolName,
							args: frame.args,
							partialResult: frame.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(frame.toolCallId, tool);
				this.#scheduleCommit();
				return;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(frame.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				this.#rebuildState();
				break;
			case "agent_end":
				// A non-terminal end is a pause inside a run that goes on.
				if (frame.isTerminal === false) return;
				this.#working = false;
				this.#activeTools = new Map();
				this.#rebuildState();
				this.#refreshEntries();
				this.#refreshState();
				break;
			case "notice":
				this.#pushNotice(frame.level, frame.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${frame.attempt}/${frame.maxAttempts}: ${frame.errorMessage}`);
				break;
			case "auto_retry_end":
				if (frame.success) return;
				this.#pushNotice("error", frame.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${frame.reason})`);
				break;
			case "manual_compaction_start":
				this.#pushNotice("info", "compacting context (manual)");
				break;
			case "auto_compaction_end":
			case "manual_compaction_end":
				if (!frame.skipped) {
					this.#pushNotice(
						"info",
						frame.aborted
							? "compaction aborted"
							: frame.errorMessage
								? `compaction failed: ${frame.errorMessage}`
								: "context compacted",
					);
				}
				this.#refreshEntries();
				this.#refreshState();
				break;
			case "model_changed":
				this.#refreshState();
				return;
			case "thinking_level_changed":
				if (!this.#rpcState) return;
				this.#rpcState = {
					...this.#rpcState,
					thinkingLevel: frame.thinkingLevel,
					configuredThinkingLevel: frame.configured ?? frame.thinkingLevel,
				};
				this.#rebuildState();
				break;
			case "queue_update":
				this.#queuedMessageCount = frame.steering.length + frame.followUp.length;
				this.#rebuildState();
				break;
			case "session_info_update":
				if (!this.#rpcState) return;
				this.#rpcState = { ...this.#rpcState, sessionName: frame.title };
				this.#rebuildState();
				break;
			case "config_update":
				if (!this.#rpcState) return;
				this.#rpcState = {
					...this.#rpcState,
					...(frame.model ? { model: frame.model } : {}),
					...(frame.thinkingLevel
						? { thinkingLevel: frame.thinkingLevel, configuredThinkingLevel: frame.thinkingLevel }
						: {}),
				};
				this.#rebuildState();
				// A new model accepts other thinking selectors.
				if (frame.model) this.#refreshState();
				break;
			case "prompt_result":
				if (frame.status !== "error" || !frame.error) return;
				this.#pushNotice("error", frame.error.message);
				break;
			case "extension_ui_request":
				this.#applyUiRequest(frame);
				break;
			case "extension_error":
				this.#pushNotice("error", `${frame.extensionPath}: ${frame.error}`);
				break;
			case "command_output":
				this.#pushNotice("info", frame.text);
				break;
			case "rpc_frame_error":
				this.#pushNotice("warning", `${frame.originalType ?? "an event"} was too large to deliver`);
				break;
			case "subagent_lifecycle":
				this.#applyLifecycle(frame.payload);
				break;
			case "subagent_progress":
				this.#progress = new Map(this.#progress).set(frame.payload.progress.id, frame.payload);
				this.#scheduleCommit();
				return;
			default:
				// ready, turn_start/turn_end, and frames this panel doesn't render.
				return;
		}
		this.#commit();
	}

	#applyUiRequest(request: ExtensionUiRequest): void {
		switch (request.method) {
			case "select":
				this.#queueUi(request.id, "select", {
					kind: "select",
					title: request.title,
					options: request.options.map((label, index) => {
						const description = request.optionDetails?.[index]?.description;
						return description ? { label, description } : label;
					}),
					initialIndex: request.initialIndex,
					selectionMarker: request.selectionMarker,
					checkedIndices: request.checkedIndices,
					markableCount: request.markableCount,
				});
				return;
			case "confirm":
				this.#queueUi(request.id, "confirm", {
					kind: "select",
					title: request.title,
					helpText: request.message,
					options: [CONFIRM_YES, CONFIRM_NO],
				});
				return;
			case "input":
				this.#queueUi(request.id, "input", { kind: "editor", title: request.title });
				return;
			case "editor":
				this.#queueUi(request.id, "editor", { kind: "editor", title: request.title, prefill: request.prefill });
				return;
			case "form":
				// The panel has no HTML form renderer; cancel so the caller does not wait on an unanswerable dialog.
				this.#sendUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
				return;
			case "cancel":
				this.#uiRequests = this.#uiRequests.filter(pending => pending.rpcId !== request.targetId);
				return;
			case "notify":
				this.#pushNotice(request.notifyType ?? "info", request.message);
				return;
			case "open_url":
				this.#pushNotice("info", `${request.instructions ?? "Open"}: ${request.launchUrl ?? request.url}`);
				return;
			default:
				// Status lines, widgets, titles and editor text belong to a TUI; `ask` is never enabled.
				return;
		}
	}

	#queueUi(rpcId: string, method: PendingUi["method"], draft: CollabUiRequestDraft): void {
		const request: CollabUiRequest = { ...draft, reqId: ++this.#uiSeq };
		this.#uiRequests = [...this.#uiRequests, { request, rpcId, method }];
	}

	#applyLifecycle(payload: SubagentLifecyclePayload): void {
		this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
		const now = Date.now();
		const existing = this.#agents.find(agent => agent.id === payload.id);
		const status: AgentSnapshot["status"] =
			payload.status === "started" ? "running" : payload.status === "aborted" ? "aborted" : "idle";
		const agent: AgentSnapshot = {
			id: payload.id,
			displayName: payload.description ?? payload.agent,
			kind: "sub",
			status,
			hasSessionFile: payload.sessionFile !== undefined,
			createdAt: existing?.createdAt ?? now,
			lastActivity: now,
		};
		this.#agents = existing
			? this.#agents.map(candidate => (candidate === existing ? agent : candidate))
			: [...this.#agents, agent];
	}

	#endExited(exited: NonNullable<RpcSessionInfo["exited"]>): void {
		const tail = exited.stderr.trim().split("\n").slice(-3).join("\n");
		const code = exited.code === null ? "a signal" : `code ${exited.code}`;
		this.#end(tail ? `omp exited with ${code}: ${tail}` : `omp exited with ${code}`);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#working = false;
		this.#activeTools = new Map();
		this.#uiRequests = [];
		this.#rebuildState();
		const error = new Error(reason);
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#commit();
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const next = [...this.#notices, { id: ++this.#noticeSeq, level, message, at: Date.now() }];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#buildSnapshot(): PanelSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			entries: this.#entries,
			state: this.#state,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: false,
			uiRequest: this.#uiRequests[0]?.request ?? null,
			notices: this.#notices,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			...(this.#thinking ? { thinking: this.#thinking } : {}),
		};
	}

	/** Publishes within one frame; a synchronous commit before then supersedes it. */
	#scheduleCommit(): void {
		if (this.#frameTimer !== null) return;
		this.#frameTimer = setTimeout(() => {
			this.#frameTimer = null;
			this.#commit();
		}, FRAME_MS);
	}

	#commit(): void {
		if (this.#detached) return;
		if (this.#frameTimer !== null) {
			clearTimeout(this.#frameTimer);
			this.#frameTimer = null;
		}
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
