/**
 * Session-wide RPC state: extension UI, prompt/settle bookkeeping, goal mode, user-input
 * ordering, subagent feed, shutdown, and the command switch. Each client is an
 * {@link RpcConnection}; `runRpcMode` serves one over stdio.
 */
import * as path from "node:path";
import { type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { $env, isRecord, logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import { resolveLocalRoot } from "../../internal-urls";
import { textPredictionBackend } from "../../predict/client";
import { type AgentSession, SessionBusyError } from "../../session/agent-session";
import { CACHE_WARMING_MODES } from "../../session/cache-warmer";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { listLogoutAccounts, logoutCredential } from "../../slash-commands/helpers/logout";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { initializeExtensions } from "../runtime-init";
import { cfgSpellingAutocomplete } from "../settings";
import { selectRpcEntries } from "./rpc-compat";
import { RpcConnection, type RpcConnectionOptions, type RpcConnectionTransport } from "./rpc-connection";
import { RpcGoalController } from "./rpc-goal";
import { RpcLiveBridge, type RpcLiveSessionFactory } from "./rpc-live";
import { RpcBtwController } from "./rpc-btw";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import {
	applyRpcQueueModeCommand,
	dispatchRpcSkillPrompt,
	fitAbortAndRestoreQueueResponse,
	fitRemoveQueuedMessageResponse,
	handleRpcCancelSubagent,
	handleRpcSessionChange,
	handleRpcSteerSubagent,
	isRpcExtensionUIResponse,
	openRpcSession,
	type PendingExtensionRequest,
	parseValueDialogResponse,
	registerRpcPersistenceSurface,
	requestRpcAskDialog,
	requestRpcDialog,
	requestRpcEditor,
	requestRpcSelect,
	resolveRpcOpenTarget,
	RpcInputDispatcher,
	RpcPendingExtensionRequests,
	RpcSerialTail,
	type RpcSessionChangeResult,
	RpcShutdownCoordinator,
	RpcUserInputGate,
	wordQueryAt,
} from "./rpc-mode";
import { RpcExtensionUserMessageTracker, type RpcPromptTicket, watchAndReportPromptResult } from "./rpc-prompt-results";
import { RpcMessageIdStamper } from "./rpc-session-events";
import { isSessionSettled } from "../../session/session-settle";
import { type RpcScheduledTurnProbe, RpcSessionSettleWatcher, watchedScheduledTurnProbe } from "./rpc-session-settle";
import { RpcSubagentRegistry, readRpcSubagentTranscript, subagentFrameVisible } from "./rpc-subagents";
import type {
	RpcAttachedFrame,
	RpcClientInfo,
	RpcClientsChangedFrame,
	RpcCommand,
	RpcCommandOutputFrame,
	RpcConfigUpdateFrame,
	RpcEntryFrame,
	RpcExtensionUIRequest,
	RpcHostToolDefinition,
	RpcResponse,
	RpcResumedFrame,
	RpcSessionInfoUpdateFrame,
	RpcSessionOrigin,
	RpcSessionReplacedFrame,
	RpcSessionState,
	RpcSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

const INVALID_TEXT_CURSOR_ERROR = "cursor must be an integer UTF-16 offset within text";

// ponytail: fixed cap, make it a setting if real clients hit it.
const SOCKET_MAX_SPOOL_BYTES = 64 * 1024 * 1024;

/** Broadcast frames kept for `attach` resumes. */
// ponytail: count-bounded ring, byte-bound it if snapshots stay cheaper than replay
const RING_LIMIT = 4096;

/** One broadcast frame in the ring; `replay` delivers it, `seq` included, through a connection's audience and projection. */
interface RpcRingSlot {
	seq: number;
	replay: (conn: RpcConnection) => void;
}

/** `entry`, `session_replaced`, `clients_changed`: stdio never sees them. */
const toSequenced = (conn: RpcConnection, frame: object): void => {
	if (conn.options.sequenced) conn.send(frame);
};
/** Clients whose unsent draft the host must not interrupt: sequenced (socket) clients that render UI. */
const tracksIdleActivity = (conn: RpcConnection): boolean => conn.options.sequenced && conn.options.ui;
/** Extension UI frames: only clients that render UI. */
const toUi = (conn: RpcConnection, frame: object): void => {
	if (conn.options.ui) conn.send(frame);
};

/** The replacement reason each session-changing command reports. */
const SESSION_CHANGE_REASONS = {
	new_session: "new",
	switch_session: "resume",
	branch: "fork",
	fork: "fork",
	open_session: "resume",
} as const satisfies Record<string, RpcSessionReplacedFrame["reason"]>;

type OrderedUserInput = Extract<RpcCommand, { type: "prompt" | "steer" | "follow_up" | "abort_and_prompt" }>;

/**
 * How ordered user input ended. `local`: handled without a model turn; `cancelled`: an abort or session change
 * invalidated it; `builtin-agent`: a builtin command scheduled an agent turn.
 */
type OrderedInputOutcome = "local" | "cancelled" | "admitted" | "builtin-agent";

/** Commands that never take a precondition. A Set: `type` is untrusted input and must not hit prototype keys. */
const PRECONDITION_EXEMPT: ReadonlySet<string> = new Set([
	"abort",
	"abort_bash",
	"abort_retry",
	"detach",
	"exit",
	"negotiate_protocol",
	"set_event_filter",
	"set_subagent_subscription",
	"set_ask_dialog",
	"set_host_tools",
	"set_host_uri_schemes",
	"predict_word",
	"predict_word_feedback",
	"live_start",
	"live_stop",
	"live_mute",
]);

/** `switch_session`/`open_session` refused: another host owns the target session. */
function sessionHosted(id: string | undefined, command: string, hostId: string): RpcResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		code: "session_hosted",
		error: `Session is open in host ${hostId}`,
		hostId,
	};
}

/** A `stale` failure when `command` carries an `ifEpoch`/`ifLeaf` the session no longer matches. */
function preconditionFailure(server: RpcServer, command: RpcCommand): RpcResponse | undefined {
	// A non-string `type` skips preconditions and reaches the switch's `Unknown command` arm.
	if (typeof command.type !== "string" || PRECONDITION_EXEMPT.has(command.type) || command.type.startsWith("get_"))
		return undefined;
	if (command.ifEpoch !== undefined && command.ifEpoch !== server.epoch)
		return {
			id: command.id,
			type: "response",
			command: command.type,
			success: false,
			code: "stale",
			error: `Session changed (epoch ${server.epoch})`,
			epoch: server.epoch,
		};
	const leafId = server.session.sessionManager.getLeafId();
	if (command.ifLeaf !== undefined && command.ifLeaf !== leafId)
		return {
			id: command.id,
			type: "response",
			command: command.type,
			success: false,
			code: "stale",
			error: "Session tree moved",
			leafId,
		};
	return undefined;
}

/** The `get_state` payload; also the `state` of every snapshot. `scheduledTurn`: a host-scheduled goal turn makes the session not settled. */
function buildRpcSessionState(session: AgentSession, scheduledTurn: RpcScheduledTurnProbe): RpcSessionState {
	const queuedMessages = session.getQueuedMessages();
	return {
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
		isSettled: isSessionSettled(session, scheduledTurn),
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
}

function isTextCursor(text: unknown, cursor: unknown): text is string {
	return (
		typeof text === "string" &&
		typeof cursor === "number" &&
		Number.isInteger(cursor) &&
		cursor >= 0 &&
		cursor <= text.length
	);
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	const normalized = tools.map((tool, index) => {
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
	if (new Set(normalized.map(tool => tool.name)).size !== normalized.length) {
		throw new Error("RPC host tool names must be unique");
	}
	return normalized;
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

/** Each tool name resolves to its most recent registrant; `sets` iterate oldest registration first. */
function mergeHostTools(sets: Iterable<AgentTool[]>): AgentTool[] {
	const byName = new Map<string, AgentTool>();
	for (const tools of sets) {
		for (const tool of tools) byName.set(tool.name, tool);
	}
	return [...byName.values()];
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

/**
 * Extension UI context that uses the RPC protocol.
 */
class RpcExtensionUIContext implements ExtensionUIContext {
	/** Set by `set_ask_dialog`; hosts that never opt in keep the select/editor ask fallback. */
	askDialogEnabled = false;

	constructor(
		private pendingRequests: Map<string, PendingExtensionRequest>,
		private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		private emitTitles: boolean,
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

	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
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
		if (!this.emitTitles) return;
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

/** Result of {@link RpcServer.dispose}: the store failure that made `session.dispose()` reject, if any. */
export interface RpcDisposeResult {
	persistenceFailure?: Error;
}

export interface RpcServerOptions {
	/** `--mode rpc-ui`: route tool UI (e.g. ask) over the protocol, independently of headless extensions. */
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** `--no-ui`: extensions run with `hasUI=false` and no UI frames; tool UI and host-issued login are unaffected. */
	headless?: boolean;
	subagentEventBus?: EventBus;
	/**
	 * Runs after an extension's `pi.shutdown()` request: every owed response was
	 * written and the session is disposed. The caller ends the process.
	 */
	onShutdown?: (disposed: RpcDisposeResult) => Promise<void>;
	/** Session host id, reported in `attached` frames. */
	hostId?: string;
	/** Builds `live_start` sessions; defaults to the real {@link LiveSessionController}. */
	createLiveSession?: RpcLiveSessionFactory;
}

export interface RpcDisconnectOptions {
	/** Error for the connection's in-flight host tool calls. */
	hostToolError?: string;
	/** Error for its in-flight host URI requests. */
	hostUriError?: string;
	/**
	 * Leave `conn` registered, so frames emitted while its commands drain and the
	 * session disposes (e.g. a persistence `notice`) still reach it. stdio's
	 * final teardown: the process exits right after.
	 */
	keepOutput?: boolean;
}

export class RpcServer {
	readonly session: AgentSession;
	readonly #options: RpcServerOptions;
	readonly #connections = new Set<RpcConnection>();
	readonly #dispatchers = new Map<RpcConnection, RpcInputDispatcher>();
	readonly #emitRpcTitles = shouldEmitRpcTitles();
	readonly #extensionUserMessageTracker = new RpcExtensionUserMessageTracker();
	readonly #settleWatcher: RpcSessionSettleWatcher;
	/**
	 * Session-wide goal mode: the goal tool's place in the active tool set, completion exit, reattach after a
	 * session change, and opt-in continuation. One controller serves every connection.
	 */
	readonly #goal: RpcGoalController;
	/** Session-wide side questions (`/btw`): one running question and history; frames reach every connection. */
	readonly #btw: RpcBtwController;
	/** A scheduled or held goal turn will start a turn: every settle report treats it as busy. */
	readonly #goalTurnScheduled: RpcScheduledTurnProbe;
	/** One acceptance order for every connection's user input, aborts and session changes. */
	readonly #inputGate = new RpcUserInputGate();
	/** Frames held back until {@link init} finishes, in arrival order; `undefined` once it has (see {@link #serve}). */
	#deferred: Array<() => void> | undefined = [];
	/** Host-wide message ids: every connection sees the same id for a message. */
	readonly #messageIds = new RpcMessageIdStamper();
	readonly #pendingExtensionRequests = new RpcPendingExtensionRequests();
	readonly #subagentRegistry: RpcSubagentRegistry | undefined;
	/** Open extension dialogs by request id; the first answer from any connection settles one. */
	readonly #uiPending = new Map<string, RpcExtensionUIRequest>();
	/**
	 * The latest `setStatus`/`setWidget` per key that still shows something. They are fire-and-forget, so a client that
	 * attaches later (extensions set most statuses at boot, before any client) gets them from its snapshot.
	 */
	readonly #uiState = new Map<string, RpcExtensionUIRequest>();
	/** Each connection's `set_host_tools` adapters, oldest registration first. */
	#hostToolSets = new Map<RpcConnection, AgentTool[]>();
	/** The host's one live voice session; its frames go to the connection that started it, bypassing event filters. */
	readonly #live: RpcLiveBridge;
	#liveOwner: RpcConnection | undefined;
	/** Connections that called `set_host_uri_schemes`, oldest registration first; a scheme belongs to its latest registrant. */
	readonly #hostUriRegistrants = new Set<RpcConnection>();
	readonly #serialTail = new RpcSerialTail();
	readonly #uiContext: RpcExtensionUIContext;
	readonly #shutdownCoordinator: RpcShutdownCoordinator;
	#shutdownRequested = false;
	/** Discriminates a store failure from any other dispose rejection; see {@link dispose}. */
	#persistenceFailure: Error | undefined;
	/** Seeded from the clock, so a respawned host never accepts a resume minted against an earlier one. */
	#epoch = Date.now();
	#seq = 0;
	/** Slot `seq % RING_LIMIT` holds broadcast frame `seq`. */
	readonly #ring: Array<RpcRingSlot | undefined> = [];
	/** Off until the first sequenced client: nothing earlier can be resumed from, so stdio-only servers keep no ring. */
	#ringActive = false;
	/** Reason the in-flight session-changing command reports; changes from elsewhere report `resume`. */
	#pendingReason: RpcSessionReplacedFrame["reason"] | undefined;
	/** The latest `session_replaced` broadcast; session-changing commands respond after it. */
	#replacing: Promise<void> = Promise.resolve();
	/**
	 * Resolves once the goal controller has reattached the session change in progress (or none is). A
	 * `session_replaced` snapshot waits for it, so it carries the new session's goal, not the previous one's.
	 */
	#goalReattached: Promise<void> | undefined;
	readonly #unsubscribeEntries: () => void;
	readonly #unsubscribeRelocated: () => void;
	/** Targets a command arm already got the host's approval for, until its switch ends: the switch guard stands down. */
	readonly #vetted = new Set<string>();
	/**
	 * Host hook: veto a switch to a file another host owns. Asked once per switch, before anything changes, by the
	 * `switch_session` and `open_session` commands and by any other switch of the session (extension action,
	 * custom command); a switch it lets through is followed by {@link onSwitchSettled}.
	 */
	onBeforeSwitch?: (sessionFile: string) => Promise<{ hostId: string } | undefined>;
	/** Host hook: session file or epoch changed. */
	onEpochChanged?: (epoch: number, sessionFile: string | undefined) => void;
	/**
	 * Host hook: a switch that `onBeforeSwitch` let through finished, whether it switched, was cancelled, or threw.
	 * A switch's `onEpochChanged` has already run.
	 */
	onSwitchSettled?: () => void;
	/**
	 * Host hook: an input of {@link isIdleActivityBlocked} may have changed (a UI client connected or left, a client
	 * reported its draft, the session was replaced), or the session settled after a scheduled turn went away. Runs
	 * after the state it reports is in place; carries no data, so read the getters. Never throws into the server.
	 */
	onIdleActivityChanged?: () => void;
	/**
	 * Host hook: the session was relocated (`/move`, `/wt`): same id, new file and/or cwd, no epoch change. Runs after
	 * sequenced clients were told. Not called for a refused move.
	 */
	onSessionRelocated?: (sessionFile: string | undefined, cwd: string) => void;
	/**
	 * Host hook: `conn` sent `detach` or `exit`; runs once the success response
	 * is queued on `conn`. Unset (stdio), both are unknown commands.
	 */
	onLeave?: (conn: RpcConnection, command: "detach" | "exit") => void;

	/** Use {@link RpcServer.start}, or call {@link init} once a host has wired its hooks and is reachable. */
	constructor(session: AgentSession, options: RpcServerOptions) {
		this.session = session;
		this.#options = options;
		this.#unsubscribeEntries = session.sessionManager.subscribeEntryAppended((entry, leafId) =>
			this.#broadcast({ type: "entry", entry, leafId } satisfies Omit<RpcEntryFrame, "seq">, toSequenced),
		);
		this.#unsubscribeRelocated = session.sessionManager.subscribeRelocated(() => this.#announceRelocation());
		// Every switch is held to the host's ownership check, whichever path starts it (extension action, custom
		// command). The RPC commands check first, so they can answer `session_hosted` before the goal quiesce.
		session.setSessionSwitchGuard((target, proceed) =>
			this.onBeforeSwitch ? this.#switchGuarded(target, proceed) : proceed(),
		);
		session.registerSessionChangeCallback(() => {
			this.#replacing = this.#replace(this.#pendingReason ?? "resume", this.#goalReattached);
		});
		// A continuation abandoned while waiting leaves nothing to end the activity stretch: re-check settlement.
		this.#goal = new RpcGoalController(session, () => void this.#settleWatcher.check());
		// Every "not settled" report for a pending goal turn is later closed by `session_settled`.
		this.#goalTurnScheduled = watchedScheduledTurnProbe(
			() => this.#goal.continuationPending,
			() => this.#settleWatcher,
		);
		this.#settleWatcher = new RpcSessionSettleWatcher(
			session,
			frame => {
				this.#broadcast(frame);
				// A scheduled goal turn that never started is closed by this frame: pending idle work may resume.
				this.#notifyIdleActivityChanged();
			},
			this.#goalTurnScheduled,
		);
		this.#subagentRegistry = options.subagentEventBus
			? new RpcSubagentRegistry(options.subagentEventBus, frame => {
					for (const conn of this.#connections) {
						if (subagentFrameVisible(conn.subagentLevel, frame.type)) conn.send(frame);
					}
				})
			: undefined;
		this.#live = new RpcLiveBridge(session, frame => this.#liveOwner?.send(frame), options.createLiveSession);
		this.#btw = new RpcBtwController(session, frame => this.#broadcast(frame));
		// A single shared instance routes every extension UI response to the
		// correct waiting promise regardless of which code path created the request.
		this.#uiContext = new RpcExtensionUIContext(
			this.#pendingExtensionRequests,
			// The dialog helpers only ever emit extension_ui_request frames.
			frame => this.#sendUi(frame as RpcExtensionUIRequest),
			this.#emitRpcTitles,
		);
		// Deferred shutdown (pi.shutdown() from an extension) must not kill the
		// process while a background-dispatched bash still owes the client its
		// response frame. The coordinator drains tracked tasks before exiting and
		// re-checks the request as each task settles.
		this.#shutdownCoordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => this.#shutdownRequested,
			performShutdown: async () => {
				// Route through the idempotent session.dispose() so the browser
				// reaper (releaseTabsForOwner) and other bounded teardown run before
				// the process exits. dispose() also emits `session_shutdown`, so we
				// must NOT emit it separately here or the event fires twice. Skipping
				// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
				const disposed = await this.#disposeSession();
				await this.#options.onShutdown?.(disposed);
			},
		});
	}

	/**
	 * Initialize extensions and start serving. `first` is registered before
	 * extension startup, so it receives the startup frames (extension UI,
	 * `available_commands_update`) right after its `ready`, as stdio always has;
	 * it can answer a startup dialog, and its commands run once startup finishes.
	 */
	static async start(session: AgentSession, options: RpcServerOptions, first?: RpcConnection): Promise<RpcServer> {
		const server = new RpcServer(session, options);
		if (first) {
			first.scheduledTurn = server.#goalTurnScheduled;
			server.#connections.add(first);
			server.#serve(first);
			// Read from now on: a transport error during startup must not be an unhandled rejection. The caller
			// still observes it through its own `inputClosed`.
			void first.inputClosed.catch(() => {});
		}
		await server.init();
		return server;
	}

	/**
	 * Initialize extensions and the session feed. Connections made before it finishes are read at once, but only
	 * dialog answers and `set_ask_dialog` are handled: an extension's `session_start` may be waiting on a dialog.
	 * Every other frame waits for startup. Rejects, leaving those frames unhandled, if startup fails.
	 */
	async init(): Promise<void> {
		await this.#init();
		const deferred = this.#deferred;
		this.#deferred = undefined;
		for (const run of deferred ?? []) run();
	}

	get connections(): ReadonlySet<RpcConnection> {
		return this.#connections;
	}

	/** Open extension dialog requests by id: sent, not yet answered, cancelled, or timed out. */
	get uiPending(): ReadonlyMap<string, RpcExtensionUIRequest> {
		return this.#uiPending;
	}

	/** Bumped on every session replacement; `ifEpoch` is checked against it. */
	get epoch(): number {
		return this.#epoch;
	}

	/**
	 * True while a connected sequenced UI client may be mid-draft: it is composing, or has not reported for the
	 * current session epoch (a report belongs to the epoch it was made in). Stdio and non-UI clients never block,
	 * and no connection at all is not blocked.
	 */
	get isIdleActivityBlocked(): boolean {
		for (const conn of this.#connections) {
			if (!tracksIdleActivity(conn)) continue;
			const report = conn.idleActivity;
			if (!report || report.epoch !== this.#epoch || report.isComposing) return true;
		}
		return false;
	}

	/** A host-scheduled goal turn has been decided but not yet admitted: the session is about to run again. */
	get hasScheduledTurn(): boolean {
		return this.#goalTurnScheduled();
	}

	#notifyIdleActivityChanged(): void {
		try {
			this.onIdleActivityChanged?.();
		} catch (error) {
			logger.warn("RPC idle activity hook failed", { error: String(error) });
		}
	}

	/** Monotonic; incremented for every broadcast frame. */
	get seq(): number {
		return this.#seq;
	}

	/** Connected sequenced clients, as `snapshot` and `clients_changed` list them. */
	get clients(): RpcClientInfo[] {
		const clients: RpcClientInfo[] = [];
		for (const conn of this.#connections) {
			const { sequenced, clientId, client } = conn.options;
			if (sequenced) clients.push({ clientId, kind: client?.kind ?? "unknown", label: client?.label });
		}
		return clients;
	}

	/**
	 * The session as a newly attached client sees it: what the entry frames have announced so far (see
	 * `SessionManager.snapshotForReplication`'s `announcedOnly`), so an atomic batch that is still publishing shows up
	 * once, as its announcements after the commit, and not at all if it rolls back.
	 */
	snapshot(): RpcSnapshot {
		const { session } = this;
		const message = session.agent.state.streamMessage;
		const messageId = this.#messageIds.openMessageId();
		// The entries are serialized into the frame as they stand: no copy needed.
		const announced = session.sessionManager.snapshotForReplication(value => value, { announcedOnly: true });
		return {
			state: {
				...buildRpcSessionState(session, this.#goalTurnScheduled),
				sessionName: announced.sessionName,
			},
			header: announced.header,
			entries: announced.entries,
			leafId: announced.leafId,
			streaming: message && messageId !== undefined ? { messageId, message } : undefined,
			pendingUi: [...this.#uiPending.values()],
			uiState: [...this.#uiState.values()],
			clients: this.clients,
			queueAttachments: session.getQueuedMessageAttachments(),
			origin: this.#origin(),
		};
	}

	/** Report {@link clients} to every sequenced connection, through the ring. */
	broadcastClients(): void {
		this.#broadcast(
			{ type: "clients_changed", clients: this.clients } satisfies Omit<RpcClientsChangedFrame, "seq">,
			toSequenced,
		);
	}

	/**
	 * Send a just-connected sequenced client its first frame and return it. A
	 * resume in the current epoch whose `lastSeq + 1` is still in the ring gets
	 * `resumed`, followed by every ring frame after `lastSeq` through `conn`'s
	 * projection; anything else gets `attached` with a snapshot. Call it in the
	 * same tick as {@link connect}, so no broadcast falls between them.
	 */
	attach(conn: RpcConnection, resume?: { epoch: number; lastSeq: number }): RpcAttachedFrame | RpcResumedFrame {
		if (resume?.epoch === this.#epoch) {
			const { lastSeq } = resume;
			if (lastSeq === this.#seq || this.#ring[(lastSeq + 1) % RING_LIMIT]?.seq === lastSeq + 1) {
				const resumed: RpcResumedFrame = { type: "resumed", epoch: this.#epoch, replayed: this.#seq - lastSeq };
				conn.send(resumed);
				for (let seq = lastSeq + 1; seq <= this.#seq; seq++) this.#ring[seq % RING_LIMIT]?.replay(conn);
				return resumed;
			}
		}
		const attached: RpcAttachedFrame = {
			type: "attached",
			hostId: this.#options.hostId ?? "",
			clientId: conn.options.clientId,
			epoch: this.#epoch,
			seq: this.#seq,
			snapshot: this.snapshot(),
		};
		conn.send(attached);
		return attached;
	}

	/**
	 * Start reading frames from a client transport; returns once the connection
	 * is registered. Its spool is capped (default {@link SOCKET_MAX_SPOOL_BYTES});
	 * an output failure, the cap included, drops the connection, never the session.
	 */
	connect(transport: RpcConnectionTransport, options: RpcConnectionOptions): RpcConnection {
		const conn = new RpcConnection(
			this.session,
			transport,
			{ ...options, maxSpoolBytes: options.maxSpoolBytes ?? SOCKET_MAX_SPOOL_BYTES },
			failure => void this.disconnect(conn, failure.message),
		);
		conn.scheduledTurn = this.#goalTurnScheduled;
		this.#connections.add(conn);
		if (options.sequenced) this.#ringActive = true;
		// A UI client that has not opted into the ask dialog withdraws it from the shared context.
		this.#uiContext.askDialogEnabled = this.#allUiConnectionsAskEnabled();
		this.#serve(conn);
		if (tracksIdleActivity(conn)) this.#notifyIdleActivityChanged();
		return conn;
	}

	/** Reject every active and future extension UI request. */
	rejectPendingUi(message: string): void {
		this.#pendingExtensionRequests.rejectAll(message);
		this.#uiPending.clear();
	}

	/**
	 * Stop serving `conn`: fail its in-flight host tool and URI calls, hand its
	 * URI schemes back to the newest remaining registrant, then finish every
	 * command it already sent. Unless `keepOutput`, it is also dropped: its
	 * transport is ended without flushing queued output, no further frames
	 * reach it, its later input is ignored, work waiting on it (a login prompt)
	 * is released, its host tools leave the merged set, and the ask-dialog
	 * opt-in is recomputed. Shared extension dialogs stay pending for the
	 * remaining (or a future) UI client. Never disposes the session; repeated
	 * calls are no-ops.
	 */
	async disconnect(
		conn: RpcConnection,
		reason: string,
		{
			hostToolError = "host tool client disconnected",
			hostUriError = "host URI client disconnected",
			keepOutput = false,
		}: RpcDisconnectOptions = {},
	): Promise<void> {
		const dispatcher = this.#dispatchers.get(conn);
		if (!keepOutput) {
			if (!this.#connections.delete(conn)) return;
			this.#dispatchers.delete(conn);
			this.#uiContext.askDialogEnabled = this.#allUiConnectionsAskEnabled();
			this.#syncSubagentEventFeed();
			if (tracksIdleActivity(conn)) this.#notifyIdleActivityChanged();
			logger.debug("RPC client disconnected", { clientId: conn.options.clientId, reason });
			// Before the drain: a dropped client's login prompt must not hold the shared command queue.
			conn.drop();
		}
		// Fail pending side-channel requests first so active/queued commands can settle.
		conn.hostTools.close(hostToolError);
		const schemes = conn.hostUris.getSchemes();
		conn.hostUris.clear(hostUriError);
		this.#hostUriRegistrants.delete(conn);
		this.#reclaimHostUriSchemes(schemes);
		// The realtime call (microphone, socket) belongs to the client that started it.
		if (this.#liveOwner === conn) await this.#live.stop();
		await dispatcher?.drain();
		if (keepOutput || !this.#hostToolSets.has(conn)) return;
		// Through the command FIFO, so the re-merge cannot interleave with a `set_host_tools` refresh.
		await this.#serialTail
			.run(async () => {
				this.#hostToolSets.delete(conn);
				await this.session.refreshRpcHostTools(mergeHostTools(this.#hostToolSets.values()));
			})
			.catch(error => logger.warn("RPC host tool re-merge failed", { reason, error: String(error) }));
	}

	/**
	 * Finish backgrounded commands, stop the subagent feed, and dispose the
	 * session. Rejects unless the only failure is the latched store failure,
	 * which resolves as `persistenceFailure`.
	 */
	async dispose(): Promise<RpcDisposeResult> {
		await this.#shutdownCoordinator.drain();
		this.#subagentRegistry?.dispose();
		return this.#disposeSession();
	}

	async #disposeSession(): Promise<RpcDisposeResult> {
		try {
			// The process ends regardless; report an unsaved side answer instead of skipping dispose.
			await this.#btw.close().catch(btwError => {
				const message = toError(btwError).message;
				logger.error(message);
				this.#broadcast({ type: "notice", level: "error", message, source: "btw-history" });
			});
			// Close the realtime call (microphone, socket) before the session it delegates into.
			await this.#live.stop();
			await this.session.dispose();
		} catch (error) {
			if (!this.#persistenceFailure || error !== this.#persistenceFailure) throw error;
			return { persistenceFailure: this.#persistenceFailure };
		} finally {
			this.#unsubscribeEntries();
			this.#unsubscribeRelocated();
		}
		return {};
	}

	async #init(): Promise<void> {
		const { session } = this;
		const { setToolUIContext, headless = false } = this.#options;
		// Wire up UI context for tool execution (ask tool, etc.) and extensions.
		setToolUIContext?.(this.#uiContext, true);

		// Set up extensions with RPC-based UI context
		await initializeExtensions(session, {
			mode: "rpc",
			// Extension-initiated session changes get the same goal quiesce/reattach as the commands. Not
			// `settled()`: this may run inside the extension notification of a reconcile in progress.
			wrapSessionChange: async <T extends { cancelled: boolean }>(
				change: () => Promise<T>,
				{ detachesRun }: { detachesRun: boolean },
			): Promise<T> => {
				await this.#btw.close();
				// A change that throws may already have detached the run: count it as detached.
				const result = await this.#withGoalReattach(
					change,
					partial => detachesRun && partial?.cancelled !== true,
					false,
				);
				if (!result.cancelled) {
					// As for the host's new/switch commands: a detached run never yields, so
					// close the prompts it was answering. Branch and navigation leave a live
					// run streaming to its normal yield.
					if (detachesRun) this.#abortOpenPrompts();
					void this.#settleWatcher.check();
				}
				return result;
			},
			reportSendError: (action, err) => {
				this.#broadcast(rpcError(undefined, action, err.message));
			},
			reportRuntimeError: err => {
				this.#broadcast({
					type: "extension_error",
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			},
			onShutdown: () => {
				this.#shutdownRequested = true;
			},
			trackAgentInvokingMessage: task => {
				this.#extensionUserMessageTracker.trackAgentMessageTask(task);
			},
			// Headless hosts get the extension runner's no-op UI: hasUI=false, dialogs resolve to defaults.
			uiContext: headless ? undefined : this.#uiContext,
		});

		// Output all agent events as JSON; prompt results follow the frame that settled them.
		session.subscribe(event => {
			const frame = this.#messageIds.stamp(event);
			// Only sequenced clients are told which queued chips carry an attachment, as of the tick the chips were
			// built in: the stdio line is the event it always was.
			const attachments = event.type === "queue_update" ? session.getQueuedMessageAttachments() : undefined;
			this.#broadcast(frame, (conn, all) =>
				conn.events.forward(
					attachments !== undefined && conn.options.sequenced && all.type === "queue_update"
						? { ...all, attachments }
						: all,
				),
			);
			// Before the prompt-result and settle reports: a goal continuation decided at this
			// agent_end is scheduled (and reported as pending) before either reads settlement.
			this.#goal.observe(event);
			for (const conn of this.#connections) conn.promptResults.observe(event);
			this.#settleWatcher.observe(event);
		});
		await this.#goal.reconcile();
		await this.#goal.settled();

		registerRpcPersistenceSurface(
			session,
			frame => this.#broadcast(frame),
			error => {
				this.#persistenceFailure = error;
			},
		);

		session.subscribeCommandMetadataChanged(() => {
			void this.#emitAvailableCommandsUpdate();
		});
		await this.#emitAvailableCommandsUpdate();
	}

	/**
	 * Keep the reader moving: side-channel frames dispatch immediately, ordinary
	 * commands serialize through the shared tail, and bash remains
	 * background-dispatched so abort_bash can overtake it.
	 */
	#serve(conn: RpcConnection): void {
		const dispatcher = new RpcInputDispatcher({
			deps: {
				handleCommand: command => this.handleCommand(conn, command),
				output: frame => {
					conn.send(frame);
					// Only after the response is queued may the host flush and close the connection.
					if (!isRecord(frame) || frame.type !== "response" || frame.success !== true) return;
					if (frame.command === "detach" || frame.command === "exit") this.onLeave?.(conn, frame.command);
				},
				errorResponse: rpcError,
				trackBackgroundTask: task => this.#shutdownCoordinator.track(task),
				pendingExtensionRequests: this.#pendingExtensionRequests,
				onHostToolResult: frame => conn.hostTools.handleResult(frame),
				onHostToolUpdate: frame => conn.hostTools.handleUpdate(frame),
				onHostUriResult: frame => conn.hostUris.handleResult(frame),
			},
			afterSerialCommand: () => this.#shutdownCoordinator.checkShutdownRequested(),
			tail: this.#serialTail,
			acceptInput: command => this.#inputGate.accept(command),
		});
		this.#dispatchers.set(conn, dispatcher);
		const receive = (parsed: unknown): void => {
			// A dropped connection's later input is ignored.
			if (this.#dispatchers.get(conn) !== dispatcher) return;
			dispatcher.dispatch(parsed);
			// First answer wins: withdraw the dialog from every other UI client. A late answer finds nothing pending.
			if (!isRpcExtensionUIResponse(parsed) || !this.#uiPending.delete(parsed.id)) return;
			this.#broadcast(
				{ type: "extension_ui_request", id: Snowflake.next() as string, method: "cancel", targetId: parsed.id },
				toUi,
				conn,
			);
		};
		conn.listen(
			parsed => {
				// While startup runs, a connection may answer a dialog `session_start` awaits and set its own dialog
				// preference (a hosted client sends it while attaching); everything else waits.
				const now =
					isRpcExtensionUIResponse(parsed) ||
					(isRecord(parsed) && (parsed.type === "set_ask_dialog" || parsed.type === "set_idle_activity"));
				if (this.#deferred && !now) this.#deferred.push(() => receive(parsed));
				else receive(parsed);
			},
			message => conn.send(rpcError(undefined, "parse", message)),
		);
	}

	/**
	 * Frames with no originating client, through each connection's `deliver`
	 * (audience and projection), skipping `except`. Sequenced connections get
	 * `{...frame, seq}`, which the ring keeps for resumes.
	 */
	#broadcast<F extends object>(
		frame: F,
		deliver: (conn: RpcConnection, frame: F) => void = (conn, all) => conn.send(all),
		except?: RpcConnection,
	): void {
		const seq = ++this.#seq;
		let stamped: F | undefined;
		if (this.#ringActive) {
			const ringFrame: F = { ...frame, seq };
			stamped = ringFrame;
			this.#ring[seq % RING_LIMIT] = { seq, replay: conn => deliver(conn, ringFrame) };
		}
		for (const conn of this.#connections) {
			if (conn !== except) deliver(conn, conn.options.sequenced ? (stamped ??= { ...frame, seq }) : frame);
		}
	}

	/**
	 * The session changed identity: bump the epoch, then hand sequenced clients the new snapshot. Waits for
	 * `goalReattached` (the goal bracket of the change that caused this) after the transition, so the snapshot's
	 * goal is the target session's.
	 */
	async #replace(reason: RpcSessionReplacedFrame["reason"], goalReattached?: Promise<void>): Promise<void> {
		try {
			await this.session.waitForSessionTransition();
			await goalReattached;
			const epoch = ++this.#epoch;
			const { sessionFile } = this.session;
			this.#broadcast(
				{ type: "session_replaced", epoch, sessionFile, reason, snapshot: this.snapshot() },
				toSequenced,
			);
			this.onEpochChanged?.(epoch, sessionFile);
			this.#notifyIdleActivityChanged();
		} catch (error) {
			logger.warn("RPC session replacement broadcast failed", { reason, error: String(error) });
		}
	}

	/**
	 * Run `change` between the goal controller's quiesce and reattach. Any `session_replaced` it causes is held
	 * until the reattach has run. `detachedRun` is read after `change` settles (`undefined`: it threw).
	 * `waitForReattach` also waits for queued reconciles: host commands only, never inside an extension
	 * notification (see {@link RpcGoalController.settled}); `endSessionChange` itself queues instead of waiting
	 * for a reconcile that may have started this change.
	 */
	async #withGoalReattach<T>(
		change: () => Promise<T>,
		detachedRun: (result: T | undefined) => boolean,
		waitForReattach: boolean,
	): Promise<T> {
		await this.#goal.beginSessionChange();
		const reattached = Promise.withResolvers<void>();
		this.#goalReattached = reattached.promise;
		let result: T | undefined;
		try {
			result = await change();
			return result;
		} finally {
			try {
				await this.#goal.endSessionChange({ detachedRun: detachedRun(result) });
				if (waitForReattach) await this.#goal.settled();
			} finally {
				if (this.#goalReattached === reattached.promise) this.#goalReattached = undefined;
				reattached.resolve();
			}
		}
	}

	/**
	 * Run a session-changing command whose replacement reports `reason`; settles after its `session_replaced`,
	 * which follows the goal reattach. `detachedRun`: whether the change stopped the running agent.
	 */
	async #changeSession<T>(
		reason: RpcSessionReplacedFrame["reason"],
		change: () => Promise<T>,
		detachedRun: (result: T | undefined) => boolean,
	): Promise<T> {
		try {
			return await this.#withGoalReattach(
				async () => {
					this.#pendingReason = reason;
					try {
						return await change();
					} finally {
						this.#pendingReason = undefined;
					}
				},
				detachedRun,
				true,
			);
		} finally {
			await this.#replacing;
		}
	}

	/** The session was replaced: no client's open prompt can settle on the old run. */
	#abortOpenPrompts(): void {
		for (const conn of this.#connections) conn.promptResults.abortOpen();
	}

	/** Where the host session lives now; see {@link RpcSessionOrigin}. */
	#origin(): RpcSessionOrigin {
		const { sessionManager } = this.session;
		return {
			cwd: sessionManager.getCwd(),
			artifactsDir: sessionManager.getArtifactsDir(),
			// The host's own `local://` mapping, as its tools resolve it (an in-memory session maps under the host's temp dir).
			localRoot: resolveLocalRoot({
				getArtifactsDir: () => sessionManager.getArtifactsDir(),
				getSessionId: () => sessionManager.getSessionId(),
			}),
			sessionId: sessionManager.getSessionId(),
		};
	}

	/** `moveTo` relocated the session: sequenced clients learn where it lives now, then the host hook runs. */
	#announceRelocation(): void {
		const { session } = this;
		this.#broadcast(
			{
				type: "session_info_update",
				title: session.sessionName,
				sessionId: session.sessionId,
				origin: this.#origin(),
			} satisfies Omit<RpcSessionInfoUpdateFrame, "seq">,
			toSequenced,
		);
		this.onSessionRelocated?.(session.sessionManager.getSessionFile(), session.sessionManager.getCwd());
	}

	/** The session switch guard: refuse a target another host owns; settle the host's claim once the switch is done. */
	async #switchGuarded(target: string, proceed: () => Promise<boolean>): Promise<boolean> {
		// A command arm that asked already settles its own claim.
		if (this.#vetted.has(path.resolve(target))) return proceed();
		const hosted = await this.#vetSwitch(target);
		if (hosted) {
			logger.warn("Refused a session switch: the session is open in another host", {
				sessionFile: target,
				hostId: hosted.hostId,
			});
			return false;
		}
		try {
			return await proceed();
		} finally {
			// After the replacement ran `onEpochChanged`, which adopts the claim.
			void this.#replacing.finally(() => this.#settleSwitch(target));
		}
	}

	/**
	 * Ask the host whether this process may switch to `sessionFile`, before anything changes (so a refusal costs no goal
	 * quiesce). An approved target stays vetted until {@link #settleSwitch}.
	 */
	async #vetSwitch(sessionFile: string): Promise<{ hostId: string } | undefined> {
		const file = path.resolve(sessionFile);
		const hosted = await this.onBeforeSwitch?.(file);
		if (!hosted) this.#vetted.add(file);
		return hosted;
	}

	/** The switch {@link #vetSwitch} approved is over: tell the host. */
	#settleSwitch(sessionFile: string): void {
		this.#vetted.delete(path.resolve(sessionFile));
		this.onSwitchSettled?.();
	}

	/** Released schemes fall back to their newest remaining registrant, if any. */
	#reclaimHostUriSchemes(schemes: readonly string[]): void {
		const newestFirst = [...this.#hostUriRegistrants].reverse();
		for (const scheme of schemes) {
			for (const owner of newestFirst) {
				if (owner.hostUris.reclaim(scheme)) break;
			}
		}
	}

	/** Extension UI frames: every connection that renders UI receives them. Open dialogs are tracked in {@link uiPending}. */
	#sendUi(frame: RpcExtensionUIRequest): void {
		switch (frame.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
			case "ask":
				this.#uiPending.set(frame.id, frame);
				break;
			case "cancel":
				this.#uiPending.delete(frame.targetId);
				break;
			case "setStatus":
				if (frame.statusText === undefined) this.#uiState.delete(`status:${frame.statusKey}`);
				else this.#uiState.set(`status:${frame.statusKey}`, frame);
				break;
			case "setWidget":
				if (frame.widgetLines === undefined) this.#uiState.delete(`widget:${frame.widgetKey}`);
				else this.#uiState.set(`widget:${frame.widgetKey}`, frame);
				break;
		}
		this.#broadcast(frame, toUi);
	}

	/** The shared UI context offers `askDialog` only when every UI connection opted in (and one exists). */
	#allUiConnectionsAskEnabled(): boolean {
		let anyUi = false;
		for (const conn of this.#connections) {
			if (!conn.options.ui) continue;
			if (!conn.askDialogEnabled) return false;
			anyUi = true;
		}
		return anyUi;
	}

	/** The raw subagent event channel is observed only while some connection is subscribed at `events`. */
	#syncSubagentEventFeed(): void {
		let wanted = false;
		for (const conn of this.#connections) wanted ||= conn.subagentLevel === "events";
		this.#subagentRegistry?.setEventFeed(wanted);
	}

	#reloadPluginState = async (): Promise<void> => {
		const cwd = this.session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		await this.session.refreshSkillsAndCommands();
		await this.#emitAvailableCommandsUpdate();
	};

	#emitAvailableCommandsUpdate = async (): Promise<void> => {
		this.#broadcast({ type: "available_commands_update", commands: await buildAvailableSlashCommands(this.session) });
	};

	/** `config_update` with the live model and thinking level, to every connection or only `deliver`'s audience. */
	#broadcastConfigUpdate(deliver?: (conn: RpcConnection, frame: object) => void): void {
		const { session } = this;
		this.#broadcast(
			{
				type: "config_update",
				model: session.model,
				thinkingLevel: session.thinkingLevel,
			} satisfies RpcConfigUpdateFrame,
			deliver,
		);
	}

	/**
	 * Admit one prompt, steer, follow-up or abort_and_prompt in accept order across every connection. Native
	 * `input` hooks run in submission order and hold later input through skill image preparation, not through
	 * the model turn. `ticket` is the prompt's open result on `conn` (none for steer and follow_up).
	 */
	#dispatchOrderedUserInput(
		conn: RpcConnection,
		command: OrderedUserInput,
		ticket: RpcPromptTicket | undefined,
	): Promise<OrderedInputOutcome> {
		const { session } = this;
		const onError = (promptError: Error) => conn.send(rpcError(command.id, command.type, promptError.message));
		return this.#inputGate.enqueue(async () => {
			const sessionId = session.sessionId;
			const isCurrent = () =>
				this.#inputGate.isCurrent(command) && !this.#shutdownRequested && session.sessionId === sessionId;
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
					results: conn.promptResults,
					onError,
					extensionUserMessageTracker: this.#extensionUserMessageTracker,
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
					output: commandOutput =>
						conn.send({ type: "command_output", text: commandOutput } satisfies RpcCommandOutputFrame),
					refreshCommands: this.#emitAvailableCommandsUpdate,
					reloadPlugins: this.#reloadPluginState,
					runCommandInBackground: task => this.#shutdownCoordinator.track(task()),
					notifyTitleChanged: async () => {
						this.#broadcast({
							type: "session_info_update",
							title: session.sessionName,
							sessionId: session.sessionId,
						} satisfies RpcSessionInfoUpdateFrame);
					},
					notifyConfigChanged: async () => {
						this.#broadcastConfigUpdate();
					},
				});
				if (!isCurrent()) return "cancelled";
				if (builtinResult !== false) {
					if (!("prompt" in builtinResult)) {
						// A consumed builtin is normally local-only, but some (e.g. `/retry`) schedule an
						// agent turn whose events stream after this response. Report that so the host does
						// not finalize the request as non-agent work while the agent is running; the turn's
						// prompt_result follows once the session settles.
						if (builtinResult.agentInvoked === true) {
							void session.waitForIdle().then(
								() => conn.promptResults.settle(ticket),
								(idleError: unknown) =>
									conn.promptResults.fail(
										ticket,
										idleError instanceof Error ? idleError.message : String(idleError),
									),
							);
							return "builtin-agent";
						}
						// Completed synchronously: `data.agentInvoked: false` is the completion signal.
						return "local";
					}
					text = builtinResult.prompt;
				}
			}
			if (!isCurrent() || !ticket) return "cancelled";
			// Await admission only, not the full turn — events still stream after this response.
			// Extension commands run immediately; file prompt templates expand; while streaming and
			// a streamingBehavior is given, this queues via steer/followUp.
			await watchAndReportPromptResult({
				ticket,
				startPrompt: onPromptAdmitted =>
					session.prompt(text, {
						images,
						...(command.type === "prompt" ? { streamingBehavior: command.streamingBehavior } : {}),
						onPromptAdmitted,
					}),
				results: conn.promptResults,
				onError,
				extensionUserMessageTracker: this.#extensionUserMessageTracker,
			});
			return "admitted";
		});
	}

	/** Handle a single command from `conn`. */
	async handleCommand(conn: RpcConnection, command: RpcCommand): Promise<RpcResponse> {
		const { session } = this;
		const subagentRegistry = this.#subagentRegistry;
		const id = command.id;
		// Write preconditions are a sequenced-client contract; stdio ignores the fields as before.
		if (conn.options.sequenced) {
			const stale = preconditionFailure(this, command);
			if (stale) return stale;
		}

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

			// Session host lifetime; the host acts in `onLeave` once this response is queued.
			case "detach":
			case "exit": {
				if (!this.onLeave) return rpcError(id, command.type, `Unknown command: ${command.type}`);
				return rpcSuccess(id, command.type);
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Taken before any dispatch so a builtin that schedules a turn (e.g. `/retry`)
				// cannot start its run ahead of the prompt's event-stream position.
				const ticket = conn.promptResults.begin(id);
				try {
					// Ack after admission, including hooks and skill image preparation, so a
					// queue edit sent after this response finds the message. `prompt` is
					// dispatched off the serial command chain, so this wait never holds up a
					// later `abort`, `steer`, or `get_state`.
					const outcome = await this.#dispatchOrderedUserInput(conn, command, ticket);
					if (outcome === "local") {
						conn.promptResults.discard(ticket);
						return rpcSuccess(id, "prompt", { agentInvoked: false });
					}
					if (outcome === "builtin-agent") return rpcSuccess(id, "prompt", { agentInvoked: true });
					if (outcome === "cancelled") {
						conn.promptResults.settle(ticket);
						return rpcSuccess(id, "prompt");
					}
					return rpcSuccess(id, "prompt");
				} catch (promptSetupError) {
					// Rejected before acceptance: the error response is the only answer.
					conn.promptResults.discard(ticket);
					throw promptSetupError;
				}
			}

			case "steer":
			case "follow_up": {
				await this.#dispatchOrderedUserInput(conn, command, undefined);
				return rpcSuccess(id, command.type);
			}

			case "remove_queued_message": {
				if (typeof command.message !== "string") {
					return rpcError(id, "remove_queued_message", "message must be a string");
				}
				if (command.queue !== "steering" && command.queue !== "followUp") {
					return rpcError(id, "remove_queued_message", 'queue must be "steering" or "followUp"');
				}
				if (command.match !== undefined && command.match !== "first" && command.match !== "last") {
					return rpcError(id, "remove_queued_message", 'match must be "first" or "last"');
				}
				if (command.refuseAttachments !== undefined && typeof command.refuseAttachments !== "boolean") {
					return rpcError(id, "remove_queued_message", "refuseAttachments must be a boolean");
				}
				// The check and the removal share one tick, so nothing can be queued or delivered between them.
				if (
					command.refuseAttachments &&
					session.queuedMessageHasAttachments(command.message, command.queue, { match: command.match })
				) {
					return rpcSuccess(id, "remove_queued_message", { removed: false, refused: "attachments" });
				}
				return fitRemoveQueuedMessageResponse(
					id,
					session.takeQueuedMessage(command.message, command.queue, { match: command.match }),
					conn.encoder.maxResponseBytes,
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
				this.#goal.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return rpcSuccess(id, "abort");
			}

			case "abort_and_restore_queue": {
				// Mirrors the TUI Esc restore: withdraw queued user input (including input the run
				// dequeued but never recorded) before aborting, so neither the aborted turn nor
				// abort()'s stranded-queue drain can run it.
				const restored = session.clearQueue({ forInterrupt: true });
				this.#goal.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return fitAbortAndRestoreQueueResponse(id, restored, conn.encoder.maxResponseBytes);
			}

			case "abort_and_prompt": {
				this.#goal.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				// After the abort so the aborted run's terminal agent_end cannot settle this prompt.
				const ticket = conn.promptResults.begin(id);
				void this.#dispatchOrderedUserInput(conn, command, ticket).then(
					outcome => {
						if (outcome === "cancelled") conn.promptResults.settle(ticket);
						else if (outcome === "local") conn.promptResults.completeLocal(ticket);
					},
					(cause: unknown) => {
						// Already acknowledged: owe the late same-id error and a failed prompt_result.
						const promptError = cause instanceof Error ? cause : new Error(String(cause));
						conn.send(rpcError(id, "abort_and_prompt", promptError.message));
						conn.promptResults.fail(ticket, promptError.message);
					},
				);
				return rpcSuccess(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch":
			case "fork": {
				const requestedModel =
					command.type === "switch_session" ? await resolveRequestedRpcModel(session, command) : undefined;
				const vetted = command.type === "switch_session" && this.onBeforeSwitch ? command.sessionPath : undefined;
				if (vetted !== undefined) {
					const hosted = await this.#vetSwitch(vetted);
					if (hosted) return sessionHosted(id, "switch_session", hosted.hostId);
				}
				// Fast refusal before the goal controller voids a waiting continuation;
				// fork() repeats the check after each of its own awaits.
				if (command.type === "fork" && session.isBusyForSnapshot) {
					return rpcError(id, "fork", new SessionBusyError("fork the session").message, "session_busy");
				}
				// Validation first: a refused change must not cancel the running side question.
				await this.#btw.close();
				let result: RpcSessionChangeResult | undefined;
				try {
					const change = this.#changeSession(
						SESSION_CHANGE_REASONS[command.type],
						() => handleRpcSessionChange(session, command, subagentRegistry, requestedModel),
						// Branch and fork switch files in-process without detaching a run (fork requires idle).
						partial => command.type !== "branch" && command.type !== "fork" && partial?.data.cancelled !== true,
					);
					result = await (vetted !== undefined ? change.finally(() => this.#settleSwitch(vetted)) : change);
				} catch (err) {
					// fork() refuses when work started while its transition awaited.
					if (err instanceof SessionBusyError) return rpcError(id, command.type, err.message, "session_busy");
					throw err;
				}
				if (!result.data.cancelled) {
					this.#inputGate.commitSessionChange(command);
					// `branch` leaves a live run streaming to its normal yield; new/switch detach it.
					if (command.type !== "branch" && command.type !== "fork") this.#abortOpenPrompts();
					// The detached run publishes no terminal agent_end to settle on.
					void this.#settleWatcher.check();
					await this.#emitAvailableCommandsUpdate();
				}
				return rpcSuccess(id, result.type, result.data);
			}

			case "open_session": {
				const requestedModel = await resolveRequestedRpcModel(session, command);
				const fileBeforeOpen = session.sessionFile;
				// Resolved once, so the ownership check and the switch name the same file.
				const target = await resolveRpcOpenTarget(session, command.sessionDir);
				// The same host check as switch_session; a fresh or already-open session has no file to claim.
				const vetted = target.latest && !target.alreadyOpen && this.onBeforeSwitch ? target.latest : undefined;
				if (vetted !== undefined) {
					const hosted = await this.#vetSwitch(vetted);
					if (hosted) return sessionHosted(id, "open_session", hosted.hostId);
				}
				// Validation first: a refused change must not cancel the running side question.
				await this.#btw.close();
				// Opening the session that is already open leaves a live run going (see below).
				const change = this.#changeSession(
					SESSION_CHANGE_REASONS.open_session,
					() => openRpcSession(session, command.sessionDir, subagentRegistry, target, requestedModel),
					() => session.sessionFile !== fileBeforeOpen,
				);
				const result = await (vetted !== undefined ? change.finally(() => this.#settleSwitch(vetted)) : change);
				if (!result.cancelled) {
					this.#inputGate.commitSessionChange(command);
					// Opening the session that is already open switches nothing and leaves a live run
					// going. Any real open (switch or new) changes the file, even when an aliased path
					// reopens a transcript with the same id.
					if (session.sessionFile !== fileBeforeOpen) this.#abortOpenPrompts();
					void this.#settleWatcher.check();
					await this.#emitAvailableCommandsUpdate();
				}
				return rpcSuccess(id, "open_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				// A goal exit triggered by the last turn restores tools asynchronously; report after it.
				await this.#goal.settled();
				return rpcSuccess(id, "get_state", buildRpcSessionState(session, this.#goalTurnScheduled));
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
					return rpcSuccess(id, "goal", await this.#goal.handle(command));
				} catch (goalError) {
					return rpcError(id, "goal", goalError instanceof Error ? goalError.message : String(goalError));
				}
			}

			case "set_ask_dialog": {
				conn.askDialogEnabled = command.enabled === true;
				this.#uiContext.askDialogEnabled = this.#allUiConnectionsAskEnabled();
				return rpcSuccess(id, "set_ask_dialog", { enabled: conn.askDialogEnabled });
			}

			case "set_idle_activity": {
				// Socket clients only: stdio has no scheduler to report to and nothing to block.
				if (!conn.options.sequenced) {
					return rpcError(id, "set_idle_activity", "set_idle_activity needs a session-host connection");
				}
				if (typeof command.isComposing !== "boolean") {
					return rpcError(id, "set_idle_activity", "isComposing must be a boolean");
				}
				// An unchanged report is only acknowledged: notifying would restart every idle deadline, so a client
				// that repeats itself more often than the delay would postpone idle work forever.
				const known = conn.idleActivity;
				if (known?.epoch !== this.#epoch || known.isComposing !== command.isComposing) {
					conn.idleActivity = { epoch: this.#epoch, isComposing: command.isComposing };
					this.#notifyIdleActivityChanged();
				}
				return rpcSuccess(id, "set_idle_activity", { isComposing: command.isComposing });
			}

			case "get_available_commands": {
				return rpcSuccess(id, "get_available_commands", { commands: await buildAvailableSlashCommands(session) });
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
				session.setTodoPhases(command.phases);
				return rpcSuccess(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const sets = new Map(this.#hostToolSets);
				// Re-registering makes `conn` the most recent registrant of every tool it lists.
				sets.delete(conn);
				sets.set(conn, conn.hostTools.setTools(tools));
				await session.refreshRpcHostTools(mergeHostTools(sets.values()));
				this.#hostToolSets = sets;
				return rpcSuccess(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "live_start": {
				try {
					// A start refused because a call is already active keeps that call's owner.
					if (!this.#live.active) this.#liveOwner = conn;
					return rpcSuccess(
						id,
						"live_start",
						await this.#live.start({ voice: command.voice, instructions: command.instructions }),
					);
				} catch (err) {
					return rpcError(id, "live_start", err instanceof Error ? err.message : String(err));
				}
			}

			case "live_stop": {
				await this.#live.stop();
				return rpcSuccess(id, "live_stop");
			}

			case "live_mute": {
				try {
					return rpcSuccess(id, "live_mute", this.#live.setMuted(command.muted));
				} catch (err) {
					return rpcError(id, "live_mute", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_host_uri_schemes": {
				try {
					const previous = conn.hostUris.getSchemes();
					const schemes = conn.hostUris.setSchemes(command.schemes);
					this.#hostUriRegistrants.delete(conn);
					this.#hostUriRegistrants.add(conn);
					this.#reclaimHostUriSchemes(previous.filter(scheme => !schemes.includes(scheme)));
					return rpcSuccess(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return rpcError(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return rpcError(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return rpcError(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				conn.subagentLevel = command.level;
				this.#syncSubagentEventFeed();
				return rpcSuccess(id, "set_subagent_subscription", { level: conn.subagentLevel });
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
				return rpcSuccess(id, "set_event_filter", {
					events: conn.events.setFilter(events, messageUpdates),
					messageUpdates,
				});
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return rpcError(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return rpcSuccess(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return rpcError(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return rpcError(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return rpcSuccess(id, "get_subagent_messages", transcript);
				} catch (err) {
					return rpcError(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			case "cancel_subagent": {
				if (!subagentRegistry) {
					return rpcError(id, "cancel_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return rpcError(id, "cancel_subagent", "`subagentId` must be a non-empty string.");
				}
				try {
					const cancelled = await handleRpcCancelSubagent(subagentRegistry, command.subagentId);
					return rpcSuccess(id, "cancel_subagent", { cancelled });
				} catch (err) {
					return rpcError(id, "cancel_subagent", err instanceof Error ? err.message : String(err));
				}
			}

			case "steer_subagent": {
				if (!subagentRegistry) {
					return rpcError(id, "steer_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return rpcError(id, "steer_subagent", "`subagentId` must be a non-empty string.");
				}
				if (typeof command.message !== "string" || !command.message.trim()) {
					return rpcError(id, "steer_subagent", "`message` is required for steer_subagent.");
				}
				const failure = await handleRpcSteerSubagent(subagentRegistry, command.subagentId, command.message);
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
				this.#broadcastConfigUpdate(toSequenced);
				return rpcSuccess(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return rpcSuccess(id, "cycle_model", null);
				}
				this.#broadcastConfigUpdate(toSequenced);
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
				this.#broadcastConfigUpdate(toSequenced);
				return rpcSuccess(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return rpcSuccess(id, "cycle_thinking_level", null);
				}
				this.#broadcastConfigUpdate(toSequenced);
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
				const result = await session.executeBash(command.command);
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

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return rpcSuccess(id, "export_html", { path });
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
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return rpcError(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(
					this.#pendingExtensionRequests,
					frame => conn.send(frame),
					this.#emitRpcTitles,
				);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.oauth.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							conn.send({
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
							const code = await uiCtx.input(prompt.message, prompt.placeholder, {
								timeout: 600_000,
								signal: conn.dropped,
							});
							// The client that would paste the code is gone: fail the login instead of submitting "".
							conn.dropped.throwIfAborted();
							return code ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(
						knownProvider.storeCredentialsAs ?? knownProvider.id,
						"online",
					);
					return rpcSuccess(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return rpcError(id, "login", err instanceof Error ? err.message : String(err));
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
					session.modelRegistry,
					command.providerId,
					command.credentialId,
					session.sessionId,
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
				const record = await this.#btw.ask(command.question, command.recordId);
				return rpcSuccess(id, "btw", { record });
			}

			case "btw_cancel":
				return rpcSuccess(id, "btw_cancel", { cancelled: this.#btw.cancel(command.recordId) });

			case "get_btw_history":
				return rpcSuccess(id, "get_btw_history", { records: await this.#btw.history() });

			// =================================================================
			// Word prediction
			// =================================================================

			case "predict_word": {
				if (!isTextCursor(command.text, command.cursor)) {
					return rpcError(id, "predict_word", INVALID_TEXT_CURSOR_ERROR);
				}
				try {
					const method = cfgSpellingAutocomplete.get(session.settings);
					const suffix = await conn.wordPredictor.predict(method, command.text, command.cursor);
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
