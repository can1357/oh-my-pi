/**
 * Extension runner - executes extensions and manages their lifecycle.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
	type AgentMessage,
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	isNonBlankContext,
	joinAdditionalContext,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	CredentialDisabledEvent,
	ImageContent,
	Model,
	ProviderResponseMetadata,
	TextContent,
} from "@oh-my-pi/pi-ai";
import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import {
	clearContextHistoryIndex,
	getContextHistoryIndex,
	markPerCallContextMessage,
	setContextHistoryIndex,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { refreshShellConfigCache } from "@oh-my-pi/pi-utils/procmgr";
import { MAIN_AGENT_RULE_NAME } from "../../capability/rule";
import type { ModelRegistry } from "../../config/model-registry";
import { type Settings, withActiveSettings } from "../../config/settings";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { MemoryRuntimeContext } from "../../memory-backend";
import { type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import type { AsyncJobSnapshot, SendUserMessageOptions } from "../../session/agent-session";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { SessionManager } from "../../session/session-manager";
import { addFileDeleteFallback, addFileWriteFallback } from "../../tools/file-write-fallback";
import type { BranchHandler, NavigateTreeHandler, NewSessionHandler } from "../session-handler-types";
import { accumulateToolCallResult, buildAggregatedToolCallResult } from "../shared-events";
import {
	assistantContentAsCopied,
	copyHandlerResult,
	copyHostData,
	HandedSignals,
	handAsIs,
	handHostFacade,
	handHostModel,
	handHostSchema,
	handSessionFacade,
	sessionCall,
	sessionHostCall,
} from "./boundary-data";
import { providerCallGate } from "./callback-ownership";
import { ManagedTimers } from "./managed-timers";
import {
	type ExtensionModelRegistry,
	type ExtensionSessionManager,
	CONTEXT_ANSWERS,
	handAgentIdentity,
	handAnnotations,
	handLiveStart,
	handLocalProtocolOptions,
	handMemory,
	handModelRegistry,
	handSessionManager,
	handSessionModes,
	handTheme,
	handUIContext,
} from "./context-surfaces";
import { createExtensionModelQuery } from "./model-api";
import { trackUserWaits, type UserWaitTracker } from "./user-wait";
import type { ComposerShapeDefinition } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import { extensionLinkClicksAvailable } from "@oh-my-pi/pi-tui/render/extension-links";
import { pinInputScope, type ToolRendererScope } from "@oh-my-pi/pi-tui/tools/renderer-scope";
import type {
	AfterProviderResponseEvent,
	AssistantMessageRewriteEvent,
	AssistantMessageRewriteResult,
	AssistantTextRenderer,
	AssistantThinkingRenderer,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BeforeSubagentSpawnEvent,
	BeforeSubagentSpawnEventResult,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	Extension,
	ExtensionActions,
	ExtensionCallbackOwner,
	ExtensionAgentIdentity,
	ExtensionAnnotationsAPI,
	ExtensionAnnotationsFactory,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionSessionGeneration,
	ExtensionSessionModes,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	InputEvent,
	InputEventResult,
	CacheWarmingAction,
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
	LinkActivateEvent,
	McpNotificationEvent,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	SessionStopEvent,
	SessionStopEventResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolInfo,
	ToolRegistrationListener,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
	UserPythonEvent,
	UserPythonEventResult,
} from "./types";

import { cfgExtensionAssistantTextRenderers, cfgExtensionHandlersToolCallTimeoutMs } from "../settings";
import { ownAcceptedCallbacks } from "./loader";

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string[];
}

export type ExtensionErrorListener = (error: ExtensionError) => void;

export interface ToolCallPreflight {
	before?: (
		toolCallId: string,
		tool: AgentTool,
		args: unknown,
		context?: AgentToolContext,
	) => Promise<{ block?: boolean; reason?: string } | undefined> | { block?: boolean; reason?: string } | undefined;
	after?: (
		toolCallId: string,
		result: AgentToolResult,
		context?: AgentToolContext,
	) => Promise<AgentToolResult | undefined> | AgentToolResult | undefined;
	cancel?: (toolCallId: string) => void;
}

export const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;
let extensionHandlerTimeoutMs = EXTENSION_HANDLER_TIMEOUT_MS;

function throwUnsupportedServiceTierAction(): never {
	throw new Error("This extension host does not support service-tier actions");
}

export function testSetExtensionHandlerTimeoutMs(timeoutMs: number): void {
	extensionHandlerTimeoutMs = timeoutMs;
}

function normalizeHandlerTimeout(timeoutMs: number): number {
	return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : EXTENSION_HANDLER_TIMEOUT_MS;
}

/**
 * Dedicated cap for `session_shutdown` handlers. The generic 30s budget is
 * appropriate for events extensions can observe (e.g. `session_start`,
 * `before_provider_request`), but `session_shutdown` is fire-and-forget
 * teardown — extensions receive no result and the user has already asked to
 * leave. A hung handler (e.g. an extension waiting on a stuck IPC pipe to a
 * companion app) MUST NOT hold Ctrl+C / `/exit` hostage for the full window.
 * See issue #2600.
 */
export const SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 2_000;
let sessionShutdownHandlerTimeoutMs = SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS;

export function testSetSessionShutdownHandlerTimeoutMs(timeoutMs: number): void {
	sessionShutdownHandlerTimeoutMs = timeoutMs;
}

/** Per-event handler budget. Defaults to the generic cap; `session_shutdown`
 *  uses its own short cap so teardown stays prompt. */
function handlerTimeoutForEvent(eventType: string): number {
	return eventType === "session_shutdown" ? sessionShutdownHandlerTimeoutMs : extensionHandlerTimeoutMs;
}

const EXTENSION_HANDLER_TIMEOUT = Symbol("extensionHandlerTimeout");
const EXTENSION_HANDLER_ABORTED = Symbol("extensionHandlerAborted");

/** One dispatch, as `ExtensionRunner.#runDispatched` keeps it: the session it was made for, whether
 *  that session was live when it began, the handlers of it running now, and the hold that keeps
 *  the session's disposal waiting until the dispatch is over. */
interface DispatchRecord {
	readonly session: ExtensionCallbackOwner;
	readonly live: boolean;
	running: number;
	hold: PromiseWithResolvers<void> | undefined;
}

/** Events after which the session file and id may differ from what child shells last saw. */
const SESSION_IDENTITY_EVENTS: Record<string, true> = {
	session_start: true,
	session_switch: true,
	session_branch: true,
};

interface HandlerTimeoutBudget {
	pause(): void;
	resume(): void;
}

function attachHandlerSignal(
	dialogOptions: ExtensionUIDialogOptions | undefined,
	handlerSignal: AbortSignal,
): ExtensionUIDialogOptions {
	if (!dialogOptions) return { signal: handlerSignal };
	if (!dialogOptions.signal) return { ...dialogOptions, signal: handlerSignal };
	if (dialogOptions.signal === handlerSignal) return dialogOptions;
	return { ...dialogOptions, signal: AbortSignal.any([dialogOptions.signal, handlerSignal]) };
}

function createHandlerUIContext(
	ui: ExtensionUIContext,
	handlerSignal: AbortSignal,
	timeoutBudget?: HandlerTimeoutBudget,
): ExtensionUIContext {
	const runDialog = async <T>(dialog: () => Promise<T>): Promise<T> => {
		timeoutBudget?.pause();
		try {
			return await dialog();
		} finally {
			timeoutBudget?.resume();
		}
	};
	const dialogMethods = {
		select: (title, options, dialogOptions) =>
			runDialog(() => ui.select(title, options, attachHandlerSignal(dialogOptions, handlerSignal))),
		confirm: (title, message, dialogOptions) =>
			runDialog(() => ui.confirm(title, message, attachHandlerSignal(dialogOptions, handlerSignal))),
		input: (title, placeholder, dialogOptions) =>
			runDialog(() => ui.input(title, placeholder, attachHandlerSignal(dialogOptions, handlerSignal))),
		// Read when asked for, as the UI they wrap reads them: a host can offer one later (RPC's
		// `set_ask_dialog`), and a handler that started before it did sees it then.
		get askDialog(): ExtensionUIContext["askDialog"] {
			const askDialog = ui.askDialog;
			return (
				askDialog &&
				((questions, dialogOptions) =>
					runDialog(() => askDialog.call(ui, questions, attachHandlerSignal(dialogOptions, handlerSignal))))
			);
		},
		get approve(): ExtensionUIContext["approve"] {
			const approve = ui.approve;
			return (
				approve &&
				((prompt, dialogOptions) =>
					runDialog(() => approve.call(ui, prompt, attachHandlerSignal(dialogOptions, handlerSignal))))
			);
		},
		custom: async (factory, options) => {
			let customSettled = false;
			let componentReady = false;
			try {
				return await ui.custom(
					async (...args) => {
						const component = await factory(...args);
						if (!customSettled) {
							timeoutBudget?.pause();
							componentReady = true;
						}
						return component;
					},
					{
						...options,
						signal: options?.signal ? AbortSignal.any([options.signal, handlerSignal]) : handlerSignal,
					},
				);
			} finally {
				customSettled = true;
				if (componentReady) timeoutBudget?.resume();
			}
		},
		editor: (title, prefill, dialogOptions, editorOptions) =>
			runDialog(() => ui.editor(title, prefill, attachHandlerSignal(dialogOptions, handlerSignal), editorOptions)),
	} satisfies Pick<ExtensionUIContext, "select" | "confirm" | "input" | "askDialog" | "approve" | "custom" | "editor">;
	// Bound once per function the UI answers with, not once per name: a member answered afresh
	// later — a host's replacement, a getter's new function — is bound afresh, never served stale.
	const delegatedMethods = new WeakMap<Function, unknown>();

	return new Proxy(ui, {
		get(target, property) {
			if (Object.hasOwn(dialogMethods, property)) {
				return Reflect.get(dialogMethods, property, dialogMethods);
			}
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			let delegated = delegatedMethods.get(value);
			if (!delegated) {
				delegated = value.bind(target);
				delegatedMethods.set(value, delegated);
			}
			return delegated;
		},
	});
}

/**
 * Scope `ctx` to a single handler run without spreading it: `{ ...ctx }` would
 * snapshot live accessors (notably the `model` getter), so a handler calling
 * `pi.setModel()` and then reading `ctx.model` would see a stale model.
 * Prototype delegation keeps every getter live while overriding `ui` — itself read from `ctx` when
 * asked for, so a handler running across a host rebind dialogs through the UI the host has now,
 * wrapped once per UI object so it compares equal to itself.
 */
function createHandlerContext(
	ctx: ExtensionContext,
	handlerSignal: AbortSignal,
	timeoutBudget?: HandlerTimeoutBudget,
): ExtensionContext {
	const scoped: ExtensionContext = Object.create(ctx);
	const handlerUIs = new WeakMap<ExtensionUIContext, ExtensionUIContext>();
	Object.defineProperty(scoped, "ui", {
		get: () => {
			const ui = ctx.ui;
			let handlerUI = handlerUIs.get(ui);
			if (!handlerUI) {
				handlerUI = createHandlerUIContext(ui, handlerSignal, timeoutBudget);
				handlerUIs.set(ui, handlerUI);
			}
			return handlerUI;
		},
		enumerable: true,
		configurable: true,
	});
	return scoped;
}

/**
 * Race `work` against a `timeoutMs` budget and optional cancellation signal,
 * clearing the timer and abort listener as soon as one branch settles.
 *
 * We deliberately avoid `Bun.sleep(timeoutMs).then(...)` here: that leaves an
 * uncancellable timer registered with the event loop, so every successful
 * handler race leaks a timer that keeps the process alive until the deadline
 * fires — up to the default 30s cap, which stalls non-interactive CLI exit
 * after any subscribed `tool_call`/`tool_result` handler runs (issue #3948
 * review, `chatgpt-codex-connector[bot]`). `setTimeout` returns a handle we
 * can `clearTimeout` on the winning branch.
 */
async function raceHandlerWithTimeout<T>(
	work: (handlerSignal: AbortSignal, timeoutBudget: HandlerTimeoutBudget) => Promise<T> | T,
	timeoutMs: number,
	signal?: AbortSignal,
	/** Receives the callback itself, which outlives the race below when the timeout wins. */
	track?: (handlerWork: Promise<unknown>) => void,
): Promise<T | typeof EXTENSION_HANDLER_TIMEOUT | typeof EXTENSION_HANDLER_ABORTED> {
	if (signal?.aborted) return EXTENSION_HANDLER_ABORTED;

	const timeoutController = new AbortController();
	const handlerSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
	const { promise: interruptPromise, resolve: resolveInterrupt } = Promise.withResolvers<
		typeof EXTENSION_HANDLER_TIMEOUT | typeof EXTENSION_HANDLER_ABORTED
	>();
	const onAbort = () => resolveInterrupt(EXTENSION_HANDLER_ABORTED);
	signal?.addEventListener("abort", onAbort, { once: true });
	let timer: Timer | undefined;
	let remainingMs = timeoutMs;
	let activeSince = performance.now();
	let pauseDepth = 0;
	let settled = false;
	const clearTimer = () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};
	const expire = () => {
		if (settled) return;
		settled = true;
		clearTimer();
		timeoutController.abort(new DOMException(`Handler timed out after ${timeoutMs}ms`, "TimeoutError"));
		resolveInterrupt(EXTENSION_HANDLER_TIMEOUT);
	};
	const armTimer = () => {
		if (settled || pauseDepth > 0) return;
		activeSince = performance.now();
		timer = setTimeout(expire, Math.max(0, remainingMs));
	};
	const settle = () => {
		if (settled) return;
		settled = true;
		clearTimer();
	};
	const timeoutBudget: HandlerTimeoutBudget = {
		pause: () => {
			if (settled) return;
			pauseDepth++;
			if (pauseDepth !== 1) return;
			remainingMs = Math.max(0, remainingMs - (performance.now() - activeSince));
			clearTimer();
			if (remainingMs <= 0) expire();
		},
		resume: () => {
			if (settled || pauseDepth === 0) return;
			pauseDepth--;
			if (pauseDepth === 0) armTimer();
		},
	};
	armTimer();
	try {
		if (signal?.aborted) return EXTENSION_HANDLER_ABORTED;
		const workPromise = Promise.resolve(work(handlerSignal, timeoutBudget));
		track?.(workPromise);
		const result = await Promise.race([workPromise, interruptPromise]);
		if (result === EXTENSION_HANDLER_TIMEOUT) {
			await Promise.race([
				workPromise.then(
					() => undefined,
					() => undefined,
				),
				Bun.sleep(0),
			]);
		}
		return result;
	} finally {
		settle();
		signal?.removeEventListener("abort", onAbort);
	}
}

const MAX_PENDING_CREDENTIAL_DISABLED = 32;

/**
 * Buffer cap for `mcp_notification` events received before {@link ExtensionRunner.initialize}
 * has run. Sized to match the manager-side buffer in `MCPManager.NOTIFICATION_BUFFER_CAP` so
 * the two layers can't drop different amounts of the same burst — the pipe drains, or it
 * spills, but it does so consistently at both ends. Drop-oldest under pressure.
 */
const MAX_PENDING_MCP_NOTIFICATIONS = 100;

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| CacheWarmingDecisionEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeBranchResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_branch" }
		? SessionBeforeBranchResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: TEvent extends { type: "session.compacting" }
					? SessionCompactingResult | undefined
					: TEvent extends { type: "session_stop" }
						? SessionStopEventResult | undefined
						: undefined;

// Session-lifecycle handler types live once in session-handler-types (imported
// above for local use); re-exported here to keep this module's public API stable.
export type { BranchHandler, NavigateTreeHandler, NewSessionHandler };

export type SwitchSessionHandler = (sessionPath: string) => Promise<{ cancelled: boolean }>;

export type ShutdownHandler = () => void;

/**
 * Emit `session_shutdown`, dispose file-write-fallback registrations, and clear
 * timers owned by an extension runner.
 *
 * Returns whether any shutdown handlers were present. Fallback disposal and timer
 * cleanup run even when a handler fails so extension background work — and a
 * fallback bound to this session's context — cannot outlive its host.
 */
export async function emitSessionShutdownEvent(extensionRunner: ExtensionRunner | undefined): Promise<boolean> {
	if (!extensionRunner) return false;
	try {
		if (!extensionRunner.hasHandlers("session_shutdown")) return false;
		await extensionRunner.emit({
			type: "session_shutdown",
		});
		return true;
	} finally {
		extensionRunner.disposeFileFallbacks();
		extensionRunner.clearManagedTimers();
	}
}

/** The UI of a runner no host gave one: one object for every such runner, so frozen — nothing
 *  holding it changes what another runner does. An extension is never handed it, only a facade
 *  over it (`handUIContext`). */
const noOpUIContext: ExtensionUIContext = Object.freeze<ExtensionUIContext>({
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	rerenderMessage: () => {},
	// A subagent's runner has no UI of its own, yet its links are picked from the interactive screen
	// while its transcript is focused: answer as the interactive UI does.
	getLinkClicksAvailable: extensionLinkClicksAvailable,
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: (_theme: string | Theme) => Promise.resolve({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
});

interface ToolRegistrationScope {
	pending: Set<Promise<void>>;
	signal?: AbortSignal;
	closed: boolean;
}

/** Identity reported by a session that is not a subagent and received no explicit identity. */
export const TOP_LEVEL_AGENT: ExtensionAgentIdentity = Object.freeze({
	kind: "main",
	id: MAIN_AGENT_ID,
	name: MAIN_AGENT_RULE_NAME,
	depth: 0,
});

/** `ctx.annotations` for hosts that inject no implementation: every call rejects. A facade of its
 *  own (`handHostFacade`), so the rejection is the boundary's copy, and frozen: one for every
 *  context. */
export const UNAVAILABLE_ANNOTATIONS: ExtensionAnnotationsAPI = Object.freeze(
	handHostFacade<ExtensionAnnotationsAPI>({
		submit: () => Promise.reject(new Error("ctx.annotations is not available in this host.")),
		open: () => Promise.reject(new Error("ctx.annotations is not available in this host.")),
	}),
);

export class ExtensionRunner {
	#uiContext: ExtensionUIContext;
	#mode: ExtensionMode = "print";
	#toolApprovalPreviewWaiter?: (toolCallId: string) => Promise<void>;
	/** Grant keys (see `sessionApprovalScope`) approved "for this session", each prefixed by the session it covers. */
	#sessionApprovals = new Set<string>();
	#trackUserWait?: UserWaitTracker;
	#errorListeners: Set<ExtensionErrorListener> = new Set();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasPendingMessagesFn: () => boolean = () => false;
	#getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	#compactFn: (instructionsOrOptions?: string | CompactOptions) => Promise<void> = async () => {};
	#getSystemPromptFn: () => string[] = () => [];
	#runEphemeralTurnFn?: ExtensionContextActions["runEphemeralTurn"];
	#startLiveFn?: ExtensionContextActions["startLive"];
	#ephemeralTurnBlocker = new AsyncLocalStorage<string | undefined>();
	#getAsyncJobSnapshotFn: () => AsyncJobSnapshot | null = () => null;
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	#switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	#reloadHandler: () => Promise<void> = async () => {};
	#shutdownHandler: ShutdownHandler = () => {};
	#resolvePlanReviewFn: NonNullable<ExtensionContextActions["resolvePlanReview"]> = () => false;
	#getPendingPlanReviewFn: NonNullable<ExtensionContextActions["getPendingPlanReview"]> = () => undefined;
	#openPlanReviewFn: NonNullable<ExtensionContextActions["openPlanReview"]> = async () => false;
	#sessionModes?: ExtensionContextActions["sessionModes"];
	#getMemoryFn?: () => MemoryRuntimeContext | undefined;
	#createAnnotations?: ExtensionAnnotationsFactory;
	#commandDiagnostics: Array<{ type: string; message: string; path: string }> = [];
	/** Link schemes already reported as claimed by more than one extension. */
	#warnedLinkSchemes = new Set<string>();
	#toolRegistrationScope = new AsyncLocalStorage<ToolRegistrationScope>();
	#toolRegistrationBarrier: Promise<void> | undefined;
	#initialized = false;
	/** Full load order, captured on the first {@link setSuspendedExtensions} call. */
	#loadOrder: Extension[] | undefined;
	#suspendedExtensions = new Set<Extension>();
	/** Per-extension listener factories from {@link onToolRegistered}, applied to late-added extensions too. */
	#toolRegistrationSubscribers = new Set<(extension: Extension) => ToolRegistrationListener>();
	/** {@link onComposerShapesChanged} subscriptions, applied to late-added extensions too. */
	#composerShapeSubscribers = new Set<(extension: Extension) => void>();
	/** The session each dispatch context was made for ({@link createContext}), and whether it was
	 *  live then: what decides whether a dispatch runs to its end ({@link #runDispatched}). */
	readonly #dispatchSessions = new WeakMap<object, DispatchRecord>();
	/** Latest `session_start` broadcast, replayed to extensions added afterwards. */
	#sessionStartEvent: RunnerEmitEvent | undefined;
	/** Notified after {@link setSuspendedExtensions} suspends or resumes any extension. */
	#suspensionListeners = new Set<() => void>();
	/** Main runner whose suspensions this runner's drawing follows; see {@link followSuspension}. */
	#suspensionParent: ExtensionRunner | undefined;
	/** {@link rendererScope}, made once it is first asked for. */
	#rendererScope: ToolRendererScope | undefined;
	/** {@link rendererScope}'s `pin`: one scope per session generation, made when first asked for. */
	#pinnedScopes = new WeakMap<ExtensionSessionGeneration, ToolRendererScope>();
	/** The host services a context hands this session's extensions (`context-surfaces.ts`), each
	 *  made once per host object, so every context hands the same one. */
	#handedSessionManager = new WeakMap<ExtensionCallbackOwner, ExtensionSessionManager>();
	#handedModelRegistry = new WeakMap<ExtensionCallbackOwner, ExtensionModelRegistry>();
	#handedLocalProtocolOptions = new WeakMap<ExtensionCallbackOwner, LocalProtocolOptions>();
	readonly #handedUI = new WeakMap<ExtensionCallbackOwner, WeakMap<ExtensionUIContext, ExtensionUIContext>>();
	readonly #handedMemory = new WeakMap<ExtensionCallbackOwner, WeakMap<MemoryRuntimeContext, MemoryRuntimeContext>>();
	readonly #handedSessionModes = new WeakMap<
		ExtensionCallbackOwner,
		WeakMap<ExtensionSessionModes, ExtensionSessionModes>
	>();
	/**
	 * Buffer for `credential_disabled` events received via {@link emitCredentialDisabled}
	 * before {@link initialize} has run. Drained through {@link emit} once initialize sets
	 * up the runtime context, so extension handlers see a populated UI/runtime context
	 * rather than the constructor's no-op default. Bounded at
	 * {@link MAX_PENDING_CREDENTIAL_DISABLED}; oldest entries are dropped under pressure.
	 */
	#pendingCredentialDisabled: CredentialDisabledEvent[] = [];

	/**
	 * Buffer for `mcp_notification` events received via {@link emitMcpNotification} before
	 * {@link initialize} has run. Two-layer race: `MCPManager` also buffers frames until
	 * its first `addNotificationListener` subscriber attaches, but the sdk.ts bridge is
	 * registered inside `createAgentSession` — BEFORE the mode controller calls
	 * `ExtensionRunner.initialize()`. Without this second buffer, the manager's drain
	 * arrives at the bridge → the bridge calls `emitMcpNotification` → the runner drops
	 * the frame because `#initialized === false`, and the frame evaporates a second time.
	 * Bounded at {@link MAX_PENDING_MCP_NOTIFICATIONS}; oldest entries are dropped under
	 * pressure. Drained in {@link initialize} once the runtime/UI context is wired.
	 */
	#pendingMcpNotifications: Array<Omit<McpNotificationEvent, "type">> = [];

	/**
	 * Timers scheduled by extensions through the sanctioned `ctx.setInterval` /
	 * `ctx.setTimeout` helpers. Callbacks run with the same isolation as handler
	 * dispatch — a throw is logged and routed through {@link onError} instead of
	 * escaping to the process `uncaughtException` handler and tearing down the
	 * whole session (issue #5664). Handles are `unref`'d and every outstanding
	 * timer is cleared on session teardown via {@link clearManagedTimers}. Each callback is owned
	 * by the session whose context scheduled it (`createContext`), not by whichever session the
	 * runtime serves when it is scheduled.
	 */
	#managedTimers = new ManagedTimers((event, error, stack) =>
		this.emitError({ extensionPath: "<timer>", event, error, stack }),
	);
	/**
	 * Disposers for the trampolines installed via {@link addFileWriteFallback} and
	 * {@link addFileDeleteFallback} — one per extension per seam it registered for.
	 * Installed during {@link initialize} (after the UI/runtime context is live, so
	 * the bound handler sees a working `ctx.ui`) and drained by
	 * {@link disposeFileFallbacks} on session shutdown so a handler from a
	 * torn-down session can never fire for a later one sharing the same process.
	 *
	 * Each trampoline re-reads its extension's handler list at call time rather than
	 * closing over a snapshot, matching how `ext.handlers` is re-read on every emit,
	 * so an extension that already had a handler for that seam at `initialize` picks
	 * up later additions to it. A seam the extension registered NOTHING for gets no
	 * trampoline at all, which keeps the registry empty for a host with no fallbacks;
	 * the cost is that a first registration for that seam after `initialize` never
	 * takes effect, which is why the API documents load-time registration.
	 */
	#fileFallbackDisposers: Array<() => void> = [];
	/**
	 * Dedup markers for `tool_call` emission, keyed `${toolCallId}:${toolName}`.
	 * The agent loop emits `tool_call` at arg-prep time (before scheduling and
	 * `tool_execution_start`) via the session's `beforeToolCall` wiring; the
	 * marker tells `ExtensionToolWrapper.execute` not to emit a second event for
	 * the same dispatch. Keyed by call id + tool name because a nested xd://
	 * device dispatch reuses the model's toolCallId under a different tool name
	 * and must still emit its own event. Bounded: markers for calls whose
	 * execute path never runs (policy deny, validation failure) would otherwise
	 * accumulate for the session's lifetime.
	 */
	#emittedToolCalls = new Set<string>();
	#loopToolCalls = new Set<string>();

	/** Records that the loop already emitted `tool_call` for this dispatch. */
	markToolCallEmitted(toolCallId: string, toolName: string): void {
		if (this.#emittedToolCalls.size >= 512) {
			const oldest = this.#emittedToolCalls.values().next().value;
			if (oldest !== undefined) this.#emittedToolCalls.delete(oldest);
		}
		this.#emittedToolCalls.add(`${toolCallId}:${toolName}`);
	}

	/** Consumes a {@link markToolCallEmitted} marker; true when the loop already emitted. */
	consumeToolCallEmitted(toolCallId: string, toolName: string): boolean {
		return this.#emittedToolCalls.delete(`${toolCallId}:${toolName}`);
	}

	/** Marks every dispatch prepared by the agent loop, independent of extension handlers. */
	markLoopToolCall(toolCallId: string, toolName: string): void {
		if (this.#loopToolCalls.size >= 512) {
			const oldest = this.#loopToolCalls.values().next().value;
			if (oldest !== undefined) this.#loopToolCalls.delete(oldest);
		}
		this.#loopToolCalls.add(`${toolCallId}:${toolName}`);
	}

	/** Clears a loop marker when pre-dispatch blocked execution before the wrapper ran. */
	clearLoopToolCall(toolCallId: string, toolName: string): void {
		this.#loopToolCalls.delete(`${toolCallId}:${toolName}`);
	}

	/** Consumes the marker for a loop dispatch; false means non-loop execution. */
	consumeLoopToolCall(toolCallId: string, toolName: string): boolean {
		return this.#loopToolCalls.delete(`${toolCallId}:${toolName}`);
	}

	/**
	 * Resolves a tool NAME to its native built-in implementation (the pre-extension-override,
	 * unwrapped tool) plus a factory for the `AgentToolContext` that native tool expects, or
	 * undefined when no native built-in of that name exists. Set by the SDK; backs same-tool
	 * `invokeTool`. The context factory is the same one the agent loop uses for tool execution, so a
	 * delegated native call sees the ordinary session tool context (ui, cwd, snapshot state, etc.).
	 */
	#nativeToolResolver?: (name: string) => { tool: AgentTool; makeContext: () => AgentToolContext } | undefined;
	#toolCallPreflight?: ToolCallPreflight;

	/** Wires the native-tool resolver used by {@link invokeNativeTool}. */
	setNativeToolResolver(
		resolve: (name: string) => { tool: AgentTool; makeContext: () => AgentToolContext } | undefined,
	): void {
		this.#nativeToolResolver = resolve;
	}

	setToolCallPreflight(preflight: ToolCallPreflight | undefined): void {
		this.#toolCallPreflight = preflight;
	}

	async runToolCallPreflightBefore(
		toolCallId: string,
		tool: AgentTool,
		args: unknown,
		context?: AgentToolContext,
	): Promise<{ block?: boolean; reason?: string } | undefined> {
		return this.#toolCallPreflight?.before?.(toolCallId, tool, args, context);
	}

	async runToolCallPreflightAfter(
		toolCallId: string,
		result: AgentToolResult,
		context?: AgentToolContext,
	): Promise<AgentToolResult | undefined> {
		return this.#toolCallPreflight?.after?.(toolCallId, result, context);
	}

	cancelToolCallPreflight(toolCallId: string): void {
		this.#toolCallPreflight?.cancel?.(toolCallId);
	}

	/** Whether a native built-in of `name` is available to delegate to. */
	hasNativeTool(name: string): boolean {
		return this.#nativeToolResolver?.(name) !== undefined;
	}

	/** Guidance a same-name replacement inherits from the native `name` tool it can delegate to. */
	getNativeDelegationGuidance(name: string): string {
		return this.#nativeToolResolver?.(name)?.tool.delegationGuidance ?? "";
	}

	/**
	 * Run the native built-in of `name` with `params` and return its result — the delegation target
	 * of a same-tool `ctx.invokeTool`. Calls the unwrapped native `execute` directly with the loop's
	 * ordinary tool context, so it inherits the caller's already-granted approval (the caller is the
	 * same tool) rather than re-running the gate. `depth` guards a wrapper that recurses into itself;
	 * it is per call chain (threaded from the caller), not session-global, so concurrent independent
	 * delegations do not interfere.
	 */
	async invokeNativeTool<TDetails = unknown>(
		name: string,
		params: Record<string, unknown>,
		options?: {
			signal?: AbortSignal;
			onUpdate?: AgentToolUpdateCallback<TDetails>;
			depth?: number;
			/**
			 * The caller tool's own context. Reused for the native call so metadata the native tool
			 * reads — `toolCall` (write/edit LSP batch flushing) and provider metadata /
			 * `providerSafetyApproved` (computer) — is preserved. Falls back to a fresh session tool
			 * context only when the caller had none.
			 */
			callerContext?: AgentToolContext;
		},
	): Promise<AgentToolResult<TDetails>> {
		const resolved = this.#nativeToolResolver?.(name);
		if (!resolved) throw new Error(`invokeTool: no native built-in named "${name}" to delegate to`);
		const depth = options?.depth ?? 0;
		if (depth >= 8) {
			throw new Error(`invokeTool: delegation depth exceeded 8 (recursive invokeTool for "${name}"?)`);
		}
		const toolCallId = `invoke-${name}-${Date.now().toString(36)}-${depth}`;
		return (await resolved.tool.execute(
			toolCallId,
			params as never,
			options?.signal,
			options?.onUpdate as never,
			options?.callerContext ?? resolved.makeContext(),
		)) as AgentToolResult<TDetails>;
	}

	constructor(
		private readonly extensions: Extension[],
		private readonly runtime: ExtensionRuntime,
		/** Ignored: `cwd` is always read live via the `cwd` getter below, not cached here. */
		_initialCwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
		getMemory?: () => MemoryRuntimeContext | undefined,
		private readonly settings?: Settings,
		private readonly localProtocolOptions?: LocalProtocolOptions,
		getAsyncJobSnapshot?: () => AsyncJobSnapshot | null,
		/** Identity of the agent this runner's session runs; defaults to the top-level agent. */
		private readonly agent: ExtensionAgentIdentity = TOP_LEVEL_AGENT,
		/** Builds `ctx.annotations`; supplied by the host that wires the bundled `/annotate` command. */
		createAnnotations?: ExtensionAnnotationsFactory,
	) {
		this.#uiContext = noOpUIContext;
		this.#getMemoryFn = getMemory;
		this.#createAnnotations = createAnnotations;
		this.#getAsyncJobSnapshotFn = getAsyncJobSnapshot ?? (() => null);
		this.#ownEveryDispatch();
	}

	/** Ownership of the GAP inside a broadcast, not of callback lifetimes — those belong to
	 *  {@link runScoped}, which every path that invokes extension code goes through. Several
	 *  emitters (`emitInput`, `emitBeforeAgentStart`, `emitUserBash`, `emitResourcesDiscover`,
	 *  `emitToolResult`, …) run their own sequential handler loops, and between two handlers of
	 *  such a loop no callback is executing while work that was registered all along has not
	 *  started; a caller asking "is extension work outstanding?" in that gap would get the wrong
	 *  answer. Hooking the surface those loops share, rather than hand-listing them, keeps a new
	 *  emitter from reopening that hole — but it is a convention over method names, so it is the
	 *  weaker of the two layers and never the one that owns a callback. */
	#ownEveryDispatch(): void {
		const prototype = ExtensionRunner.prototype as unknown as Record<string, unknown>;
		for (const name of Object.getOwnPropertyNames(prototype)) {
			if (!name.startsWith("emit")) continue;
			if (typeof Object.getOwnPropertyDescriptor(prototype, name)?.value !== "function") continue;
			Object.defineProperty(this, name, {
				configurable: true,
				writable: true,
				value: (...args: unknown[]): unknown => {
					// Resolved at call time, not captured here: a spy or patch installed on the
					// prototype after construction must still be the thing that runs.
					const emitter = prototype[name] as (...rest: unknown[]) => unknown;
					// The session the dispatch is made for is the one before its first handler runs:
					// a handler can end it, and the dispatch stays its work.
					const work = this.#workOf();
					const result = emitter.apply(this, args);
					// Synchronous emitters finish inside this call and own no gap.
					if (result instanceof Promise) this.#track(work.dispatches, result);
					return result;
				},
			});
		}
	}

	/**
	 * Live session directory, not a session-start snapshot: `/move`
	 * (`SessionManager.moveTo()`) relocates the owning session by updating
	 * `sessionManager`'s own `#cwd`, not a process-global. Reading it here
	 * via the getter — instead of caching the constructor-time value in a
	 * field — keeps every `ExtensionContext` built below in sync with this
	 * session's actual, current directory. Deliberately `sessionManager.getCwd()`
	 * rather than `getProjectDir()`: the latter is a single process-wide value
	 * that only the interactive TUI's `/move` handler happens to also update
	 * (`InteractiveModeContext#applyCwdChange`) — an SDK/ACP host running
	 * several concurrent sessions each with their own `cwd` (see
	 * `CreateAgentSessionOptions.cwd`) must never have one session's move
	 * leak into another's `ctx.cwd` by reading a shared global.
	 */
	get cwd(): string {
		return this.sessionManager.getCwd();
	}

	/**
	 * Stable id of the session this runner serves. Read through `sessionManager`
	 * for the same reason as {@link cwd}: it is this session's own, never a
	 * process-global, so a subagent runner reports itself and not its parent.
	 *
	 * Used to attribute a denied file write or delete to the session that issued
	 * it, since the fallback registry those handlers live in is process-wide.
	 */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/**
	 * Session settings this runner was constructed with. Used when a direct
	 * `tool.execute()` omits execute-time context so approval still sees the
	 * user's configured mode (schema default `yolo`) instead of fail-closed.
	 */
	get sessionSettings(): Settings | undefined {
		return this.settings;
	}

	initialize(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		commandContextActions?: ExtensionCommandContextActions,
		uiContext?: ExtensionUIContext,
		mode: ExtensionMode = "print",
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this). What a read
		// answers with is a copy: the host keeps its own lists and records, and an extension editing
		// what it was handed must not edit what the host acts on.
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.getActiveTools = () => copyHostData(actions.getActiveTools());
		// Each tool's `parameters` is the host's own (a registered tool's is the copy taken at
		// registration), and the host validates and builds requests against it. A JSON Schema is
		// copied as data. A callable schema is code, so a copy of the record drops it; it is handed
		// deliberately, as `ToolInfo.parameters` declares it, through a frozen schema of its own
		// (`handHostSchema`) whose calls reach the host's: the host's object, a built-in tool's
		// included, is never handed, so nothing the extension sets on what it holds reaches it.
		this.runtime.getAllTools = () =>
			actions.getAllTools().map(info => {
				const parameters: unknown = info.parameters;
				return {
					...copyHostData(info),
					parameters:
						typeof parameters === "function"
							? (handHostSchema(parameters) as ToolInfo["parameters"])
							: copyHostData(info.parameters),
				};
			});
		this.runtime.setActiveTools = async toolNames => {
			const registrationBarrier = this.#toolRegistrationBarrier;
			if (registrationBarrier) await registrationBarrier;
			await actions.setActiveTools(toolNames);
		};
		this.runtime.getCommands = () => copyHostData(actions.getCommands());
		// The session that hands a model over owns it: the copy is taken inside its admission, and a
		// `resolveHeaders` the model brings runs as its work (`runExtensionSetModel`).
		this.runtime.setModel = model => actions.setModel(model, this.runtime);
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		const getServiceTiers = actions.getServiceTiers;
		this.runtime.getServiceTiers = getServiceTiers
			? () => copyHostData(getServiceTiers())
			: throwUnsupportedServiceTierAction;
		this.runtime.setServiceTier = actions.setServiceTier ?? throwUnsupportedServiceTierAction;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setSessionName = actions.setSessionName;
		// The session goes with the configuration here too. `initialize()` replaces the queue
		// with a direct registration, and that is the path a real SDK extension takes: without
		// this the registry would have no owner to ask before calling the provider, and a
		// withdrawal would take away a sibling session's registration along with this one's.
		// A provider registered while a session runs is that session's (`forAcceptance`), and comes
		// out of the registry when the session ends; one registered at load serves every session.
		this.runtime.registerProvider = (name, config, sourceId) => {
			const accepting = this.runtime.forAcceptance?.();
			const session = accepting !== undefined && accepting !== this.runtime ? accepting : undefined;
			this.modelRegistry.registerProvider(name, config, sourceId, session ?? this.runtime);
			session?.whenSessionEnds?.(() => this.modelRegistry.unregisterProvider(name, session, "session"));
		};
		// A withdrawal is the extension's: every registration of the name it made, at load or in any
		// of its sessions.
		this.runtime.unregisterProvider = name => {
			this.modelRegistry.unregisterProvider(name, this.runtime);
		};

		// Context actions (required)
		this.#getModel = contextActions.getModel;
		this.#isIdleFn = contextActions.isIdle;
		this.#abortFn = contextActions.abort;
		this.#hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.#shutdownHandler = contextActions.shutdown;
		if (contextActions.resolvePlanReview) this.#resolvePlanReviewFn = contextActions.resolvePlanReview;
		if (contextActions.getPendingPlanReview) this.#getPendingPlanReviewFn = contextActions.getPendingPlanReview;
		if (contextActions.openPlanReview) this.#openPlanReviewFn = contextActions.openPlanReview;
		// Assigned unconditionally: a headless rebind must not inherit a previous host's controls.
		this.#sessionModes = contextActions.sessionModes;
		this.#getContextUsageFn = contextActions.getContextUsage;
		this.#compactFn = contextActions.compact;
		this.#getSystemPromptFn = contextActions.getSystemPrompt;
		this.#runEphemeralTurnFn = contextActions.runEphemeralTurn;
		this.#startLiveFn = contextActions.startLive;

		// Command context actions (optional, only for interactive mode)
		if (commandContextActions) {
			this.#waitForIdleFn = commandContextActions.waitForIdle;
			this.#newSessionHandler = commandContextActions.newSession;
			this.#branchHandler = commandContextActions.branch;
			this.#navigateTreeHandler = commandContextActions.navigateTree;
			this.#switchSessionHandler = commandContextActions.switchSession;
			this.#reloadHandler = commandContextActions.reload;
			this.#getContextUsageFn = commandContextActions.getContextUsage;
			this.#compactFn = commandContextActions.compact;
		}

		this.#uiContext =
			uiContext && this.#trackUserWait
				? trackUserWaits(uiContext, this.#trackUserWait)
				: (uiContext ?? noOpUIContext);
		this.#mode = mode;
		this.#initialized = true;

		// Re-initialize (e.g. a mode switch rewiring UI/runtime actions) must not
		// accumulate duplicate global registrations — drop the prior generation before
		// installing this one's trampolines.
		this.disposeFileFallbacks();
		// Suspended extensions keep a (gated) trampoline so resuming them needs no rewire.
		for (const ext of this.getLoadedExtensions()) this.#installFileFallbacks(ext);

		// Drain events buffered by emitCredentialDisabled() before initialize ran. The
		// spread adds the `type` discriminator — `event` is the pi-ai shape (no `type`).
		// Deferred by one microtask so callers that register an onError listener
		// synchronously after initialize() see handler errors routed through it.
		const pending = this.#pendingCredentialDisabled.splice(0);
		queueMicrotask(() => {
			for (const event of pending) {
				this.emit({ type: "credential_disabled", ...event }).catch((error: unknown) => {
					logger.warn("credential_disabled handler threw during initialize flush", {
						provider: event.provider,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});

		// Drain events buffered by emitMcpNotification() before initialize ran, using the
		// same deferred-microtask ordering as the credential-disabled drain above so any
		// onError listener registered synchronously after initialize() still catches
		// handler errors during flush.
		const pendingMcp = this.#pendingMcpNotifications.splice(0);
		queueMicrotask(() => {
			for (const event of pendingMcp) {
				this.emit({ type: "mcp_notification", ...event }).catch((error: unknown) => {
					logger.warn("mcp_notification handler threw during initialize flush", {
						server: event.server,
						method: event.method,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});
	}

	/**
	 * Forward a `credential_disabled` event from `AuthStorage` to extension handlers.
	 *
	 * If {@link initialize} has not yet run, the event is buffered and replayed once
	 * initialize wires the runtime/UI context. This matters because mode controllers
	 * (interactive, RPC, ACP, print, subagent) call `initialize()` AFTER `createAgentSession`
	 * returns, but `AuthStorage` can fire `credential_disabled` during startup model probes
	 * inside `createAgentSession()`. Without deferral, extension handlers would observe
	 * `hasUI=false`, an unset model, and no-op runtime actions on exactly the headline
	 * "OAuth invalid_grant during startup" path the event was designed to surface.
	 *
	 * Always returns; never throws. Errors from handlers are routed through
	 * {@link onError} via {@link emit}'s normal isolation.
	 */
	async emitCredentialDisabled(event: CredentialDisabledEvent): Promise<void> {
		if (!this.#initialized) {
			if (this.#pendingCredentialDisabled.length >= MAX_PENDING_CREDENTIAL_DISABLED) {
				this.#pendingCredentialDisabled.shift();
			}
			this.#pendingCredentialDisabled.push(event);
			return;
		}
		await this.emit({ type: "credential_disabled", ...event });
	}

	/**
	 * Forward an MCP server notification to extension handlers.
	 *
	 * If {@link initialize} has not yet run, the notification is buffered and replayed
	 * once initialize wires the runtime/UI context. Matches the credential-disabled
	 * deferral above: the sdk.ts bridge registers `MCPManager.addNotificationListener`
	 * inside `createAgentSession` — BEFORE the mode controller calls `initialize()` on
	 * this runner — so notification frames drained by the manager (either fresh
	 * arrivals or replay from its own startup buffer) can reach us pre-init. Without
	 * this buffer they would evaporate for a second time here.
	 *
	 * Bounded at {@link MAX_PENDING_MCP_NOTIFICATIONS}; oldest entries drop under
	 * pressure. Never throws; per-handler errors are routed through {@link onError}
	 * via {@link emit}'s normal isolation.
	 */
	async emitMcpNotification(event: Omit<McpNotificationEvent, "type">): Promise<void> {
		if (!this.#initialized) {
			if (this.#pendingMcpNotifications.length >= MAX_PENDING_MCP_NOTIFICATIONS) {
				this.#pendingMcpNotifications.shift();
			}
			this.#pendingMcpNotifications.push(event);
			return;
		}
		await this.emit({ type: "mcp_notification", ...event });
	}

	/** Emits a session stop pass that can be cancelled with the active settle signal. */
	async emitSessionStop(event: Omit<SessionStopEvent, "type">): Promise<SessionStopEventResult | undefined> {
		if (event.signal.aborted) return undefined;
		return await this.emit({ type: "session_stop", ...event });
	}

	/**
	 * Asks extensions to override a prompt-cache warming decision. The last
	 * handler returning an action wins; handler failures are reported through
	 * the extension error listeners and leave the warmer's decision standing.
	 */
	async emitCacheWarmingDecision(event: CacheWarmingDecisionEvent): Promise<CacheWarmingAction> {
		let action = event.action;
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;
			const ctx = this.createContext();
			for (const handler of handlers) {
				const result = (await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					handlerTimeoutForEvent(event.type),
				)) as CacheWarmingDecisionEventResult | undefined;
				if (result?.action !== undefined) action = result.action;
			}
		}
		return action;
	}
	/** Registers the interactive transcript gate that must settle before a tool approval is presented. */
	setToolApprovalPreviewWaiter(waiter: (toolCallId: string) => Promise<void>): () => void {
		this.#toolApprovalPreviewWaiter = waiter;
		return () => {
			if (this.#toolApprovalPreviewWaiter === waiter) this.#toolApprovalPreviewWaiter = undefined;
		};
	}

	/**
	 * Runs each dialog of the UI context the next {@link initialize} receives (tool approvals, extension prompts) as a
	 * wait for the user.
	 */
	setUserWaitTracker(track: UserWaitTracker): void {
		this.#trackUserWait = track;
	}

	/** Waits until the interactive transcript can show the tool call being approved. */
	async waitForToolApprovalPreview(toolCallId: string): Promise<void> {
		await this.#toolApprovalPreviewWaiter?.(toolCallId);
	}

	/** Whether the user approved `key` for the current session; a new or switched session starts with none. */
	hasSessionApproval(key: string): boolean {
		return this.#sessionApprovals.has(`${this.sessionId}\0${key}`);
	}

	grantSessionApproval(key: string): void {
		this.#sessionApprovals.add(`${this.sessionId}\0${key}`);
	}

	getUIContext(): ExtensionUIContext {
		return this.#uiContext;
	}

	/** `ui` as this session's extensions are handed it (`handUIContext`): this runner's own UI in
	 *  every context it creates, and a UI another host lends a handler (a focused subagent's
	 *  transcript, a tool's `onSession`). One per UI object and session: the session is the one
	 *  served now — or the admitted call's on this stack — and the facade is that session's alone
	 *  (`ExtensionCallbackOwner.forSession`), so a `ctx.ui` a session held is refused once it has
	 *  gone, even while the runtime serves the next session. */
	handedUIContext(ui: ExtensionUIContext, session: ExtensionCallbackOwner = this.#sessionOwner()): ExtensionUIContext {
		let bySession = this.#handedUI.get(session);
		if (!bySession) {
			bySession = new WeakMap();
			this.#handedUI.set(session, bySession);
		}
		let handed = bySession.get(ui);
		if (!handed) {
			handed = handUIContext(ui, session, pinInputScope(this.rendererScope));
			bySession.set(ui, handed);
		}
		return handed;
	}

	/** This runtime as the session served now (`forSession`), or the runtime itself for one with no
	 *  sessions of its own. A facade made for it stays that session's. */
	#sessionOwner(): ExtensionCallbackOwner {
		return this.runtime.forSession?.() ?? this.runtime;
	}

	/** The value `cache` holds for `session`, made by `make` the first time it is asked for. */
	#onceFor<V>(cache: WeakMap<ExtensionCallbackOwner, V>, session: ExtensionCallbackOwner, make: () => V): V {
		let value = cache.get(session);
		if (value === undefined) {
			value = make();
			cache.set(session, value);
		}
		return value;
	}

	hasUI(): boolean {
		return this.#uiContext !== noOpUIContext;
	}

	/**
	 * Install this extension's file-mutation fallback trampolines.
	 *
	 * Nothing registered by this extension means no trampoline, so a host with
	 * no fallback-registering extension leaves the seam genuinely empty and
	 * `hasFileWriteFallback()`/`hasFileDeleteFallback()` false — the invariant
	 * the whole feature rests on. Each seam is checked separately, so an
	 * extension that only brokers writes never appears in the delete registry.
	 *
	 * One trampoline per extension per seam, not per handler: the list is walked
	 * at mutation time so a handler this extension adds later still takes effect,
	 * and `createContext()` takes no extension argument, so within one invocation
	 * a single context is all any of this extension's handlers would have
	 * received anyway.
	 *
	 * The context is built PER INVOCATION rather than captured here, matching
	 * every other dispatch site. `createContext()` materializes `cwd` and
	 * `hasUI` as values, so a trampoline holding one context for the life of the
	 * session would keep handing handlers the workspace this runner initialized
	 * in — wrong the moment `SessionManager.moveTo()` relocates the session
	 * (`/move`), and a handler that scopes or prompts against `ctx.cwd` would
	 * then allow the old workspace and deny the new one. A denied mutation is a
	 * rare path, so the extra object costs nothing that matters.
	 *
	 * Isolation is per HANDLER, not per extension. The registry only sees one
	 * trampoline per extension, so a throw escaping this loop would advance the
	 * registry to the NEXT extension and skip every later handler this one
	 * registered — breaking both the documented "a throwing handler is skipped"
	 * contract and registration order for a backup-handler setup.
	 */
	#installFileFallbacks(ext: Extension): void {
		if (ext.fileWriteFallbackHandlers.length > 0) {
			this.#fileFallbackDisposers.push(
				addFileWriteFallback(async req => {
					if (this.#suspendedExtensions.has(ext)) return false;
					const ctx = this.createContext();
					const named = { extensionPath: ext.path, event: "file_write_fallback" };
					for (const handler of ext.fileWriteFallbackHandlers) {
						try {
							// Through runScoped like every other extension callback: invoked straight
							// from the filesystem helper, it would otherwise run unowned. Handed a copy: the
							// helper rethrows `req.cause` as the original error once no handler took it.
							if (await this.#runDispatched(ctx, named, () => handler(copyHostData(req), ctx))) return true;
						} catch (error) {
							logger.warn("Extension file write fallback handler threw; trying next handler", {
								extension: ext.path,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
					return false;
				}),
			);
		}
		if (ext.fileDeleteFallbackHandlers.length > 0) {
			this.#fileFallbackDisposers.push(
				addFileDeleteFallback(async req => {
					if (this.#suspendedExtensions.has(ext)) return false;
					const ctx = this.createContext();
					const named = { extensionPath: ext.path, event: "file_delete_fallback" };
					for (const handler of ext.fileDeleteFallbackHandlers) {
						try {
							if (await this.#runDispatched(ctx, named, () => handler(copyHostData(req), ctx))) return true;
						} catch (error) {
							logger.warn("Extension file delete fallback handler threw; trying next handler", {
								extension: ext.path,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
					return false;
				}),
			);
		}
	}

	/**
	 * Append extensions bound after this runner was built (startup-deferred
	 * extensions binding into the live session runtime). They join last, so they
	 * win name collisions as any later-loaded extension does. Tools their
	 * factories registered reach every {@link onToolRegistered} subscriber, file
	 * fallbacks install when the runner is already initialized, and a
	 * `session_start` that already went out is replayed to them alone. Resolves
	 * once those tool activations and handlers settle.
	 */
	async addExtensions(added: readonly Extension[]): Promise<void> {
		if (added.length === 0) return;
		this.extensions.push(...added);
		this.#loadOrder?.push(...added);
		if (this.#initialized) {
			for (const extension of added) this.#installFileFallbacks(extension);
		}
		for (const extension of added) {
			for (const attach of this.#composerShapeSubscribers) attach(extension);
			const scope: ToolRegistrationScope = {
				pending: new Set(),
				closed: false,
				signal: AbortSignal.timeout(extensionHandlerTimeoutMs),
			};
			this.#toolRegistrationScope.run(scope, () => {
				for (const attach of this.#toolRegistrationSubscribers) {
					const listener = attach(extension);
					for (const toolName of extension.tools.keys()) listener(toolName);
				}
			});
			scope.closed = true;
			try {
				await this.#flushToolRegistrations(scope.pending);
			} catch (error) {
				this.emitError({
					extensionPath: extension.path,
					event: "tool_registration",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
		if (this.#sessionStartEvent) await this.#emitTo(added, this.#sessionStartEvent);
	}

	getExtensionPaths(): string[] {
		return this.extensions.map(e => e.path);
	}

	/** Every extension this runner loaded, in load order, including suspended ones. */
	getLoadedExtensions(): readonly Extension[] {
		return this.#loadOrder ?? this.extensions;
	}

	/** Whether the extension loaded from `extensionPath` is present and not suspended. */
	isExtensionActive(extensionPath: string): boolean {
		return this.extensions.some(ext => ext.path === extensionPath);
	}

	/**
	 * Suspend or resume loaded extensions in place (e.g. after a live `disabledExtensions`
	 * edit). A suspended extension keeps its module state but stops contributing event
	 * handlers, commands, tools, message renderers, link schemes, shortcuts, flags, and file
	 * fallbacks until resumed. Returns the extensions whose state changed, after notifying
	 * {@link onSuspensionChange} listeners when there are any.
	 */
	setSuspendedExtensions(shouldSuspend: (extension: Extension) => boolean): {
		suspended: Extension[];
		resumed: Extension[];
	} {
		this.#loadOrder ??= [...this.extensions];
		const suspended: Extension[] = [];
		const resumed: Extension[] = [];
		for (const extension of this.#loadOrder) {
			const suspend = shouldSuspend(extension);
			if (suspend === this.#suspendedExtensions.has(extension)) continue;
			if (suspend) {
				this.#suspendedExtensions.add(extension);
				suspended.push(extension);
			} else {
				this.#suspendedExtensions.delete(extension);
				resumed.push(extension);
			}
		}
		if (suspended.length > 0 || resumed.length > 0) {
			const active = this.#loadOrder.filter(extension => !this.#suspendedExtensions.has(extension));
			this.extensions.splice(0, this.extensions.length, ...active);
			for (const listener of this.#suspensionListeners) listener();
		}
		return { suspended, resumed };
	}

	/**
	 * Call `listener` whenever {@link setSuspendedExtensions} suspends or resumes an extension, so
	 * a UI can redraw what their renderers and link schemes drew. Returns the unsubscribe.
	 */
	onSuspensionChange(listener: () => void): () => void {
		this.#suspensionListeners.add(listener);
		return () => this.#suspensionListeners.delete(listener);
	}

	/** Get all registered tools from all extensions. */
	getAllRegisteredTools(): RegisteredTool[] {
		const tools: RegisteredTool[] = [];
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				tools.push(tool);
			}
		}
		return tools;
	}

	/** Get the effective registered tool for a name using normal last-extension-wins precedence. */
	getRegisteredTool(name: string): RegisteredTool | undefined {
		for (let index = this.extensions.length - 1; index >= 0; index -= 1) {
			const tool = this.extensions[index]?.tools.get(name);
			if (tool) return tool;
		}
		return undefined;
	}

	/**
	 * Observe tools registered after extension factories have loaded. Listener
	 * promises are drained before the lifecycle handler that registered them
	 * completes, keeping the model tool snapshot and system prompt coherent.
	 */
	onToolRegistered(listener: (tool: RegisteredTool, signal?: AbortSignal) => void | Promise<void>): () => void {
		const subscriptions: Array<{ extension: Extension; listener: ToolRegistrationListener }> = [];
		const attach = (extension: Extension): ToolRegistrationListener => {
			const trackRegistration = (pending: Promise<void>): void => {
				const registrationBarrier = pending.then(
					() => undefined,
					() => undefined,
				);
				this.#toolRegistrationBarrier = registrationBarrier;
				void registrationBarrier.then(() => {
					if (this.#toolRegistrationBarrier === registrationBarrier) this.#toolRegistrationBarrier = undefined;
				});
				const scope = this.#toolRegistrationScope.getStore();
				if (scope && !scope.closed) {
					scope.pending.add(pending);
					void pending.then(
						() => scope.pending.delete(pending),
						() => {},
					);
					return;
				}
				void pending.catch(error => {
					this.emitError({
						extensionPath: extension.path,
						event: "tool_registration",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				});
			};
			const wrapped: ToolRegistrationListener = toolName => {
				const tool = extension.tools.get(toolName);
				if (!tool) return;
				try {
					const scope = this.#toolRegistrationScope.getStore();
					const registrationSignal =
						scope && !scope.closed ? scope.signal : AbortSignal.timeout(extensionHandlerTimeoutMs);
					const pending = listener(tool, registrationSignal);
					if (pending) trackRegistration(pending);
				} catch (error) {
					trackRegistration(Promise.reject(error));
				}
			};
			extension.toolRegistrationListeners ??= new Set();
			extension.toolRegistrationListeners.add(wrapped);
			subscriptions.push({ extension, listener: wrapped });
			return wrapped;
		};
		for (const extension of this.extensions) attach(extension);
		this.#toolRegistrationSubscribers.add(attach);
		return () => {
			this.#toolRegistrationSubscribers.delete(attach);
			for (const subscription of subscriptions) {
				subscription.extension.toolRegistrationListeners?.delete(subscription.listener);
			}
		};
	}

	async #flushToolRegistrations(pendingRegistrations: Set<Promise<void>>): Promise<void> {
		let firstFailure: PromiseRejectedResult | undefined;
		while (pendingRegistrations.size > 0) {
			const pending = Array.from(pendingRegistrations);
			const settled = await Promise.allSettled(pending);
			for (let index = 0; index < settled.length; index += 1) {
				pendingRegistrations.delete(pending[index]);
				const result = settled[index];
				if (!firstFailure && result?.status === "rejected") firstFailure = result;
			}
		}
		if (firstFailure) throw firstFailure.reason;
	}

	/** Composer shapes the extensions have registered — at load, or by a session still running —
	 *  with later extensions winning id collisions. */
	getComposerShapes(): ComposerShapeDefinition[] {
		const shapes = new Map<string, ComposerShapeDefinition>();
		for (const extension of this.extensions) {
			for (const [id, shape] of extension.composerShapes) shapes.set(id, shape);
		}
		return [...shapes.values()];
	}

	/** Calls `listener` whenever an extension's composer shapes change after load — a session
	 *  registers one, or its end withdraws one — including extensions added later. A host that
	 *  installed {@link getComposerShapes} reinstalls them. Answers what unsubscribes. */
	onComposerShapesChanged(listener: () => void): () => void {
		const attached = new Set<Extension>();
		const attach = (extension: Extension): void => {
			extension.composerShapeListeners ??= new Set();
			extension.composerShapeListeners.add(listener);
			attached.add(extension);
		};
		for (const extension of this.extensions) attach(extension);
		this.#composerShapeSubscribers.add(attach);
		return () => {
			this.#composerShapeSubscribers.delete(attach);
			for (const extension of attached) extension.composerShapeListeners?.delete(listener);
		};
	}

	/**
	 * Aggregate the registered CLI flags across a set of extensions (last write
	 * wins on name collision). Static so callers that need the flag set before a
	 * runner exists — e.g. the CLI resolving `@file`/flag args before session
	 * creation — share this exact logic instead of duplicating it.
	 */
	static aggregateFlags(extensions: readonly Extension[]): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of extensions) {
			for (const [name, flag] of ext.flags) {
				allFlags.set(name, flag);
			}
		}
		return allFlags;
	}

	getFlags(): Map<string, ExtensionFlag> {
		return ExtensionRunner.aggregateFlags(this.extensions);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	static readonly #RESERVED_SHORTCUTS: Record<string, true> = {
		"ctrl+c": true,
		"ctrl+d": true,
		"ctrl+z": true,
		"ctrl+k": true,
		"ctrl+p": true,
		"ctrl+l": true,
		"ctrl+o": true,
		"ctrl+t": true,
		"ctrl+g": true,
		"alt+m": true,
		// Default chord for `app.message.followUp` (Windows Terminal can't deliver Ctrl+Enter; #1903).
		"ctrl+q": true,
		"shift+tab": true,
		"shift+ctrl+p": true,
		"alt+enter": true,
		escape: true,
		enter: true,
	};

	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		const allShortcuts = new Map<KeyId, ExtensionShortcut>();
		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				if (ExtensionRunner.#RESERVED_SHORTCUTS[normalizedKey]) {
					logger.warn("Extension shortcut conflicts with built-in shortcut", {
						key,
						extensionPath: shortcut.extensionPath,
					});
					continue;
				}

				const existing = allShortcuts.get(normalizedKey);
				if (existing) {
					logger.warn("Extension shortcut conflict", {
						key,
						extensionPath: shortcut.extensionPath,
						existingExtensionPath: existing.extensionPath,
					});
				}
				allShortcuts.set(normalizedKey, shortcut);
			}
		}
		return allShortcuts;
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The renderer an extension registered for `customType`, as a host may call it: inside
	 * {@link runScoped} on copies of the message and options, `undefined` once the session has
	 * gone, and carrying {@link rendererScope}, which the host mounts the returned component in
	 * (`FramedMessageComponent`). The component is the extension's live code; it is not copied.
	 */
	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				const admitted: MessageRenderer = (message, options, theme) =>
					this.runScoped(() => renderer(copyHostData(message), copyHostData(options), handTheme(theme)));
				return Object.assign(admitted, { rendererScope: this.rendererScope });
			}
		}
		return undefined;
	}

	/** The thinking renderers extensions registered, each as {@link getMessageRenderer} hands one:
	 *  admitted, on a copy of its context, carrying the scope its component is mounted in. The
	 *  context's `requestRender` is the one callable it declares, so it is handed deliberately: it
	 *  asks the host for a frame, and does nothing once the session has gone. */
	getAssistantThinkingRenderers(): AssistantThinkingRenderer[] {
		return this.extensions.flatMap(ext =>
			ext.assistantThinkingRenderers.map(renderer => {
				const admitted: AssistantThinkingRenderer = (context, theme) => {
					const scope = this.rendererScope;
					const handed = {
						...copyHostData(context),
						requestRender: () => {
							if (scope.live) context.requestRender();
						},
					};
					return this.runScoped(() => renderer(handed, handTheme(theme)));
				};
				return Object.assign(admitted, { rendererScope: this.rendererScope });
			}),
		);
	}

	/**
	 * Draw with what `parent` (the main session's runner) leaves active: a subagent's runner loads
	 * its own copies of the extensions, and a live `disabledExtensions` edit suspends only the main
	 * copies. While this runner's transcript is on screen, its renderers, link schemes and link
	 * clicks skip every extension `parent` has suspended. `undefined` draws with all of its own.
	 */
	followSuspension(parent: ExtensionRunner | undefined): void {
		this.#suspensionParent = parent === this ? undefined : parent;
	}

	/** Whether the extension loaded from `resolvedPath` is loaded here and suspended. */
	isExtensionSuspended(resolvedPath: string): boolean {
		for (const extension of this.#suspendedExtensions) if (extension.resolvedPath === resolvedPath) return true;
		return false;
	}

	/** Active extensions that draw: those {@link followSuspension}'s parent has not suspended. */
	#drawingExtensions(): Extension[] {
		const parent = this.#suspensionParent;
		return parent ? this.extensions.filter(ext => !parent.isExtensionSuspended(ext.resolvedPath)) : this.extensions;
	}

	/**
	 * Registered assistant text renderers; none while `extensionRenderers.assistantText` is off.
	 * Each runs inside {@link runScoped} on a copy of its context and answers `undefined` once the
	 * session has gone, so the host draws the block's own text; what it answers is a string.
	 */
	getAssistantTextRenderers(): AssistantTextRenderer[] {
		if (!this.settings || !cfgExtensionAssistantTextRenderers.get(this.settings)) return [];
		return this.#drawingExtensions().flatMap(ext =>
			ext.assistantTextRenderers.map(renderer => {
				const admitted: AssistantTextRenderer = context => this.runScoped(() => renderer(copyHostData(context)));
				return Object.assign(admitted, { rendererScope: this.rendererScope });
			}),
		);
	}

	/** Link schemes claimed with `registerLinkScheme`; none while `extensionRenderers.assistantText` is off. */
	getLinkSchemes(): string[] {
		if (!this.settings || !cfgExtensionAssistantTextRenderers.get(this.settings)) return [];
		const owners = new Map<string, Extension>();
		for (const ext of this.#drawingExtensions()) {
			for (const scheme of ext.linkSchemes) {
				const owner = owners.get(scheme);
				if (!owner) owners.set(scheme, ext);
				else if (owner !== ext && !this.#warnedLinkSchemes.has(scheme)) {
					this.#warnedLinkSchemes.add(scheme);
					logger.warn("Link scheme claimed by several extensions; the first loaded gets its clicks", {
						scheme,
						owner: owner.path,
						ignored: ext.path,
					});
				}
			}
		}
		return [...owners.keys()];
	}

	/**
	 * Deliver a click on `url` as `link_activate` to the extension that claimed its scheme (the first
	 * one in load order, when several did). Returns whether an extension owns the link.
	 *
	 * `ui` is the UI that drew the link, for a runner that has none of its own: a subagent's runner
	 * runs headless, but its transcript can be on screen while that subagent is focused, and the
	 * handler's `ctx.ui.rerenderMessage` must reach that screen.
	 *
	 * Like a command or shortcut, a click is the user's own action, and its handler may open a
	 * dialog: it runs without the event-handler timeout. A failure is reported, not thrown.
	 */
	async emitLinkActivate(url: string, ui?: ExtensionUIContext): Promise<boolean> {
		if (!this.settings || !cfgExtensionAssistantTextRenderers.get(this.settings)) return false;
		const colon = url.indexOf(":");
		if (colon <= 0) return false;
		const scheme = url.slice(0, colon).toLowerCase();
		const owner = this.#drawingExtensions().find(ext => ext.linkSchemes.includes(scheme));
		if (!owner) return false;
		const handlers = owner.handlers.get("link_activate");
		if (!handlers || handlers.length === 0) return true;
		const event: LinkActivateEvent = { type: "link_activate", url, scheme };
		const base = this.createContext();
		const ctx: ExtensionContext =
			ui && ui !== this.#uiContext
				? Object.create(base, { ui: { value: this.handedUIContext(ui) }, hasUI: { value: true } })
				: base;
		for (const handler of handlers) {
			try {
				await this.#runDispatched(base, { extensionPath: owner.path, event: event.type }, () =>
					handler(event, ctx),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn("link_activate handler failed", { extensionPath: owner.path, url, error: message });
				this.emitError({
					extensionPath: owner.path,
					event: event.type,
					error: message,
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
		return true;
	}

	getRegisteredCommands(reserved?: ReadonlySet<string>): RegisteredCommand[] {
		this.#commandDiagnostics = [];

		const commands = new Map<string, RegisteredCommand>();
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				if (reserved?.has(command.name)) {
					const message = `Extension command '${command.name}' from ${ext.path} conflicts with built-in commands. Skipping.`;
					this.#commandDiagnostics.push({ type: "warning", message, path: ext.path });
					if (!this.hasUI()) {
						logger.warn(message);
					}
					continue;
				}

				commands.set(command.name, command);
			}
		}
		return [...commands.values()];
	}

	getCommandDiagnostics(): Array<{ type: string; message: string; path: string }> {
		return this.#commandDiagnostics;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (let index = this.extensions.length - 1; index >= 0; index -= 1) {
			const command = this.extensions[index]?.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	/**
	 * Run an extension-owned callback within this session's settings scope, so a
	 * synchronous `SettingsManager.create(ctx.cwd)` inside it resolves THIS
	 * session's manager rather than a same-cwd sibling's.
	 *
	 * This is the invoker for everything this runner calls — event handlers, slash commands,
	 * keyboard shortcuts, link activations, tool execution, the file write/delete fallbacks — so
	 * it owns those invocations: refused once the session is retired (a `pi.on` handler stored
	 * before disposal must not run after it, however the dispatch reaches it), counted while it
	 * runs, and executed inside the acceptance scope so a subscription the callback makes is
	 * attributed to this session rather than to whoever is on the stack. It is entered as the
	 * session's admitted work (`runOwned`), so what the callback registers, and what its
	 * continuations do after the session has gone, belong to that session.
	 */
	runScoped<T>(fn: () => T): T | undefined {
		const owner = this.#scopeOwner;
		if (!owner) return withActiveSettings(this.settings, fn);
		if (owner.isRetired) return undefined;
		return owner.runOwned(() => withActiveSettings(this.settings, fn));
	}

	/**
	 * Runs one handler of a dispatch made with `ctx` ({@link createContext}). A dispatch that began
	 * while its session was live runs to its end, as that session's work: its session ending while
	 * an earlier handler awaited does not skip the handlers after it — a load-time handler serves
	 * every session, this one's last dispatch included, and its result reaches the host — while a
	 * callback that session registered refuses on its own (`ownCallback`). A dispatch that began
	 * after its session had gone runs nothing — one a finishing handler starts included, since
	 * finishing never starts anything — and says so through {@link onError} for each handler it
	 * skips (`handler` names it), so a result the host expected is never lost in silence.
	 *
	 * The dispatch is one piece of its session's work: held from its first handler until a turn of
	 * the event loop after its last, so the session's disposal, which waits for work under way, does
	 * not finish in the gap between two handlers and leave the next to run after it. A dispatch loop
	 * moves from one handler to the next within that turn. The hold is that session's alone: the
	 * disposal of a session after it does not wait for it.
	 */
	#runDispatched<T>(
		ctx: ExtensionContext,
		handler: { readonly extensionPath: string; readonly event: string },
		fn: () => T,
	): T | undefined {
		// A handler's context may derive from the dispatch's (`Object.create`, a lent `ui`).
		let dispatch: DispatchRecord | undefined;
		for (let at: object | null = ctx; at !== null && dispatch === undefined; at = Object.getPrototypeOf(at)) {
			dispatch = this.#dispatchSessions.get(at);
		}
		const finish = dispatch?.session.finishOwned;
		if (!this.#scopeOwner || !dispatch || !finish) return this.runScoped(fn);
		if (!dispatch.live) {
			this.emitError({
				...handler,
				error: "Not run: the session this dispatch was made for had ended before it began",
			});
			return undefined;
		}
		const record = dispatch;
		if (record.running === 0 && record.hold === undefined) {
			const hold = Promise.withResolvers<void>();
			record.hold = hold;
			record.session.trackCallback(hold.promise);
		}
		record.running++;
		const settled = (): void => {
			record.running--;
			if (record.running > 0) return;
			setImmediate(() => {
				if (record.running > 0 || record.hold === undefined) return;
				const hold = record.hold;
				record.hold = undefined;
				hold.resolve();
			});
		};
		let result: T;
		try {
			result = Reflect.apply(finish, record.session, [() => withActiveSettings(this.settings, fn)]) as T;
		} catch (error) {
			settled();
			throw error;
		}
		Promise.resolve(result).then(settled, settled);
		return result;
	}

	/**
	 * The scope a host runs this session's extension renderers in, and the components they return
	 * (`ToolRendererScope`, `@oh-my-pi/pi-tui/tools/renderer-scope`, which cannot import this
	 * admission): {@link runScoped}, refused once the session has retired. One per runner. A
	 * runner whose callbacks run as the host's own never retires.
	 *
	 * It answers for whichever session the runtime serves, so a runner reused for the next session
	 * renders for that one. What a session leaves behind — a component bound to the TUI's input, an
	 * overlay it showed — is pinned to that session instead (`pin`): one scope per session
	 * generation (`ExtensionRuntime.sessionGeneration`), which never becomes live again once the
	 * session has gone, so the next session's lease does not revive it before the TUI's sweep.
	 */
	get rendererScope(): ToolRendererScope {
		if (this.#rendererScope) return this.#rendererScope;
		const retired = (): boolean => this.#scopeOwner?.isRetired === true;
		const runScoped = <T>(call: () => T): T | undefined => this.runScoped(call);
		const pin = (): ToolRendererScope => {
			const generation = this.#scopeOwner?.sessionGeneration;
			// `ExtensionRuntime` always answers one, before its first session too. A runner whose
			// callbacks run as the host's own, or an embedder's runtime with no session generations,
			// has no session lifetime to pin to: its scope is the only one it has.
			if (generation === undefined) return scope;
			let pinned = this.#pinnedScopes.get(generation);
			if (!pinned) {
				pinned = {
					get live() {
						return !generation.isRetired;
					},
					run<T>(call: () => T): T {
						if (generation.isRetired) {
							throw new Error("Extension session retired; its renderers are no longer callable");
						}
						// Not retired, so this generation is the runtime's current one and `runScoped` runs it.
						return runScoped(call) as T;
					},
				};
				this.#pinnedScopes.set(generation, pinned);
			}
			return pinned;
		};
		const scope: ToolRendererScope = {
			get live() {
				return !retired();
			},
			run<T>(call: () => T): T {
				if (retired()) throw new Error("Extension session retired; its renderers are no longer callable");
				// Live, so `runScoped` runs `call` and answers what it returned.
				return runScoped(call) as T;
			},
			pin,
		};
		this.#rendererScope = scope;
		return scope;
	}

	/** The owner {@link runScoped} runs callbacks as. Feature-tested, like every other reach into a
	 *  host-supplied object here: embedders and this repo's tests pass runtimes that implement only
	 *  what they use, and one without `ownCallback` runs its callbacks as the host's own. */
	get #scopeOwner(): ExtensionRuntime | undefined {
		return typeof this.runtime?.ownCallback === "function" ? this.runtime : undefined;
	}

	/**
	 * The lifetime a signal handed to a callback this runner admits follows (`AdmittedSignal`,
	 * `HandedSignals`): this session's, or none for a runner whose callbacks run as the host's
	 * own, which hand the caller's signal itself. Used by the hooks here and by the tool adapter,
	 * whose `execute` runs inside the tool wrapper's {@link runScoped}.
	 */
	get callbackGate(): ProviderCallGate | undefined {
		const owner = this.#scopeOwner;
		return owner ? providerCallGate(owner) : undefined;
	}

	/**
	 * Creates an extension context, optionally scoped to a provider request model.
	 *
	 * `delegation` wires the same-tool `ctx.invokeTool` for a re-registered built-in: when `toolName`
	 * names an existing native built-in, the context carries an `invokeTool` that runs it (see
	 * {@link invokeNativeTool}). The rest inherits the wrapper's own call so a bare
	 * `ctx.invokeTool(params)` behaves like the outer call — `context` preserves `toolCall`/provider
	 * metadata, `signal`/`onUpdate` default to the wrapper's own channels so aborting the outer tool
	 * call stops the native one and native progress still streams, and `depth` bounds recursion per
	 * call chain. Explicit options passed to `invokeTool` override the inherited `signal`/`onUpdate`.
	 *
	 * `agent` replaces this runner's identity as `ctx.agent` for work done on behalf of another
	 * agent that shares the runner (the advisor's toolset, see `ExtensionToolWrapper`).
	 */
	createContext(
		model?: Model,
		delegation?: {
			toolName: string;
			depth?: number;
			context?: AgentToolContext;
			signal?: AbortSignal;
			onUpdate?: AgentToolUpdateCallback;
		},
		agent: ExtensionAgentIdentity = this.agent,
	): ExtensionContext {
		// Every member the host can change after this context is made — its UI and mode on a rebind
		// (`initialize`), its model, its cwd after a relocation, its memory backend, the actions it
		// wires — is read when the extension asks for it: a context saved across the change answers
		// as the host does now. What is captured here is captured on purpose: `model`, `delegation`
		// and `agent` are what this one call was made with, and `madeWith` is what `mode` and `hasUI`
		// answer once the context's session has gone.
		const runner = this;
		// The session this context is made for: its facades are that session's, so a context a
		// session saved is refused once it has gone, even while the runtime serves the next one.
		const session = this.#sessionOwner();
		const madeWith = { mode: this.#mode, hasUI: this.hasUI() };
		const getModel = model ? () => model : () => this.#getModel();
		const sendUserMessage = (text: string, options?: SendUserMessageOptions): void =>
			this.runtime.sendUserMessage(text, options);
		const getSessionModes = () => this.#sessionModes;
		const handSessionModesOnce = (modes: ExtensionSessionModes | undefined): ExtensionSessionModes | undefined => {
			if (!modes) return undefined;
			let bySession = this.#handedSessionModes.get(session);
			if (!bySession) {
				bySession = new WeakMap();
				this.#handedSessionModes.set(session, bySession);
			}
			let handed = bySession.get(modes);
			if (!handed) {
				handed = handSessionModes(modes, session);
				bySession.set(modes, handed);
			}
			return handed;
		};
		// The tool call's own channel, never the host's function itself: handed a string, called on
		// the call's context as the host defined it.
		const toolCallContext = delegation?.context;
		const addToolCallContext = toolCallContext?.addAdditionalContext;
		const addAdditionalContext =
			addToolCallContext &&
			((text: string): void => {
				Reflect.apply(addToolCallContext, toolCallContext, [String(text)]);
			});
		const context: ExtensionContext = {
			// The host's services, each as `context-surfaces.ts` hands it: named members calling the
			// host's object, copies in and out. The host keeps acting on its own objects — the
			// approval prompt, the registry's rows and credentials, the history — so an extension
			// is never handed them.
			get ui() {
				return runner.handedUIContext(runner.#uiContext, session);
			},
			// The runner's now while the session is live; once it has gone, what it was when this
			// context was made — never the host the runner was rebound to for the next session.
			get mode() {
				return session.isRetired ? madeWith.mode : runner.#mode;
			},
			// What a read answers with is a copy (`handSessionFacade`), here as on `pi`: the host's
			// prompt, its pending plan review and its job records are what it keeps acting on.
			getContextUsage: () => this.#getContextUsageFn(),
			// `ctx` accepts callbacks too (`compact({ onError })`), and a continuation an extension
			// hands over here outlives the command that made the call. Owned at acceptance, like
			// everything the `pi` surface takes.
			compact: instructionsOrOptions =>
				this.#compactFn(ownAcceptedCallbacks(instructionsOrOptions, session) as typeof instructionsOrOptions),
			getAsyncJobSnapshot: () => this.#getAsyncJobSnapshotFn(),
			get hasUI() {
				return session.isRetired ? madeWith.hasUI : runner.hasUI();
			},
			get cwd() {
				return runner.cwd;
			},
			sessionManager: this.#onceFor(this.#handedSessionManager, session, () =>
				handSessionManager(this.sessionManager, session),
			),
			modelRegistry: this.#onceFor(this.#handedModelRegistry, session, () =>
				handModelRegistry(this.modelRegistry, session),
			),
			isProjectTrusted: () => true,
			// The fields the host's identity declares, read once now onto a record of the context's
			// own: nothing of the host's object is reached again.
			agent: handAgentIdentity(agent),
			// A copy on every read, as `ctx.models` hands them (`handHostModel`): the host keeps building
			// requests from its model after the handler returns — the credential it chooses by
			// `provider`, the endpoint `baseUrl` names — so an edit to the one handed over must stay on
			// it, whether the host holds a registry row or a class an SDK caller selected. Its
			// `resolveHeaders` is the session's call. The host's getter may throw: as every member's
			// host call (`handSessionFacade`), its failure crosses as a copy, as the model does.
			get model() {
				const model = getModel();
				return model && handHostModel(model, sessionCall(session));
			},
			models: createExtensionModelQuery(this.modelRegistry, this.settings, getModel, session),
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			hasPendingMessages: () => this.#hasPendingMessagesFn(),
			shutdown: () => this.#shutdownHandler(),
			resolvePlanReview: (reviewId, choice, input) => this.#resolvePlanReviewFn(reviewId, choice, input),
			getPendingPlanReview: () => this.#getPendingPlanReviewFn(),
			openPlanReview: () => this.#openPlanReviewFn(),
			// Live: a context saved before or across a host rebind sees the current controls.
			get sessionModes() {
				return handSessionModesOnce(getSessionModes());
			},
			getSystemPrompt: () => this.#getSystemPromptFn(),
			get runEphemeralTurn(): ExtensionContext["runEphemeralTurn"] {
				const runEphemeralTurn = runner.#runEphemeralTurnFn;
				return (
					runEphemeralTurn &&
					(async options => {
						if (runner.#ephemeralTurnBlocker.getStore()) {
							throw new Error("runEphemeralTurn cannot be called recursively from an ephemeral turn hook");
						}
						// Resolve at call time so a running handler's cancellation is inherited.
						// A saved context must not retain a completed handler's stale signal.
						const registrationScope = runner.#toolRegistrationScope.getStore();
						const signals = [
							options.signal,
							delegation?.signal,
							registrationScope && !registrationScope.closed ? registrationScope.signal : undefined,
						].filter((signal): signal is AbortSignal => signal !== undefined);
						// Only hooks reached inside the side-turn pipeline are blocked. The caller's own
						// delivery callback runs outside the guard so work it starts (lazy subscriptions,
						// timers) does not inherit a permanent block on later consultations.
						const onTextDelta = options.onTextDelta;
						const request = {
							...options,
							onTextDelta: onTextDelta
								? (delta: string) => runner.#ephemeralTurnBlocker.exit(() => onTextDelta(delta))
								: undefined,
							signal: signals.length ? AbortSignal.any(signals) : undefined,
						};
						return runner.#ephemeralTurnBlocker.run("ephemeral turn", () => runEphemeralTurn(request));
					})
				);
			},
			get startLive(): ExtensionContext["startLive"] {
				const startLive = runner.#startLiveFn;
				return startLive && handLiveStart(startLive, session);
			},
			// The runner's options are fixed at construction; the facade reads their answers per call.
			localProtocolOptions:
				this.localProtocolOptions &&
				this.#onceFor(this.#handedLocalProtocolOptions, session, () =>
					handLocalProtocolOptions(this.localProtocolOptions as LocalProtocolOptions, session),
				),
			get memory() {
				const memory = runner.#getMemoryFn?.();
				if (!memory) return undefined;
				let bySession = runner.#handedMemory.get(session);
				if (!bySession) {
					bySession = new WeakMap();
					runner.#handedMemory.set(session, bySession);
				}
				let handed = bySession.get(memory);
				if (!handed) {
					handed = handMemory(memory, session);
					bySession.set(memory, handed);
				}
				return handed;
			},
			// A getter, not a value: `createHandlerContext` scopes a handler via `Object.create(ctx)`, and
			// `this` here is that receiver, so the overlay mounts through the handler's timeout-aware `ui`.
			get annotations(): ExtensionAnnotationsAPI {
				const createAnnotations = runner.#createAnnotations;
				// What the annotations deliver is the session's message: refused once it has gone. The
				// host's annotations object is its own; the session is handed a facade over it.
				return createAnnotations
					? handAnnotations(
							createAnnotations(
								() => this,
								(text, options) => sessionHostCall(session, () => sendUserMessage(text, options)),
							),
							session,
						)
					: UNAVAILABLE_ANNOTATIONS;
			},
			// Owned by this context's session: scheduled after it has gone, refused; scheduled while it
			// is live, inert once it has gone, whichever session the runtime serves when it fires. The
			// handle is the platform's own, handed as it is: `clearTimer` takes it back, and it can do
			// no more than cancel or keep alive a timer of this session's.
			setInterval: (callback, ms, ...args) =>
				handAsIs(this.#managedTimers.setInterval(session.ownCallback(callback), ms, ...args)),
			setTimeout: (callback, ms, ...args) =>
				handAsIs(this.#managedTimers.setTimeout(session.ownCallback(callback), ms, ...args)),
			clearTimer: timer => this.#managedTimers.clear(timer),
			addAdditionalContext,
			invokeTool:
				delegation !== undefined && this.hasNativeTool(delegation.toolName)
					? (params, options) =>
							this.invokeNativeTool(delegation.toolName, params, {
								// Inherit the wrapper's own channels so a bare `ctx.invokeTool(params)` aborts
								// and streams with the outer call. Explicit options win.
								signal: options?.signal ?? delegation.signal,
								onUpdate: options?.onUpdate ?? delegation.onUpdate,
								depth: (delegation.depth ?? 0) + 1,
								callerContext: delegation.context,
							})
					: undefined,
		};
		// Every member that calls the host is this session's host call: refused once the session has
		// gone, even while the runtime serves the next — and whichever host `initialize` has bound
		// the runner to since, so a context kept across a rebind drives neither host.
		handSessionFacade(context, session, CONTEXT_ANSWERS);
		this.#dispatchSessions.set(context, { session, live: !session.isRetired, running: 0, hold: undefined });
		return context;
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 */
	shutdown(): void {
		this.#shutdownHandler();
	}

	/**
	 * Clear every timer scheduled through `ctx.setInterval` / `ctx.setTimeout`.
	 * Called during session teardown so extension background work does not
	 * outlive the session (a self-scheduling interval would otherwise keep
	 * firing against a disposed session).
	 */
	clearManagedTimers(): void {
		this.#managedTimers.clearAll();
	}

	/**
	 * Remove every file write and delete fallback this runner installed into the
	 * process-wide registries. Called on session shutdown (and before reinstalling
	 * on a re-{@link initialize}) so a handler bound to a torn-down session's
	 * context can never fire for another session sharing this process.
	 */
	disposeFileFallbacks(): void {
		for (const dispose of this.#fileFallbackDisposers.splice(0)) dispose();
	}

	createCommandContext(): ExtensionCommandContext {
		// Delegates to the context rather than spreading it: a spread reads each getter once, here —
		// `model`, `annotations` — and a command that switched models would go on seeing the old one.
		const base = this.createContext();
		const session = this.#dispatchSessions.get(base)?.session ?? this.#sessionOwner();
		const context: ExtensionContext = Object.create(base);
		// Each is a host call of the context's session, refused once it has gone, as the base's are.
		return Object.assign(
			context,
			handSessionFacade(
				{
					waitForIdle: () => this.#waitForIdleFn(),
					newSession: (options?: Parameters<ExtensionCommandContext["newSession"]>[0]) =>
						this.#newSessionHandler(options),
					branch: (entryId: string) => this.#branchHandler(entryId),
					navigateTree: (targetId: string, options?: Parameters<ExtensionCommandContext["navigateTree"]>[1]) =>
						this.#navigateTreeHandler(targetId, options),
					switchSession: (sessionPath: string) => this.#switchSessionHandler(sessionPath),
					reload: () => this.#reloadHandler(),
					compact: (instructionsOrOptions?: string | CompactOptions) =>
						this.#compactFn(ownAcceptedCallbacks(instructionsOrOptions, session) as typeof instructionsOrOptions),
				},
				session,
			),
		);
	}

	#isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_branch" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}
	#isSessionShutdownEvent(event: RunnerEmitEvent): event is Extract<RunnerEmitEvent, { type: "session_shutdown" }> {
		return event.type === "session_shutdown";
	}

	/** Each session's work this runner started, by its generation (`ExtensionRuntime.sessionGeneration`):
	 *  what that session's disposal waits for, and nothing a session before it left running.
	 *
	 *  `handlerWork` is the handler callbacks still executing. {@link #runHandlerWithTimeout} RACES
	 *  each one against its timeout, so a dispatch that times out returns while its callback keeps
	 *  running — and that callback can still touch host resources (resolve a credential, write a
	 *  file). A caller that needs the extension work itself to be over waits on
	 *  {@link waitForPendingHandlerWork}, never on the dispatch.
	 *
	 *  `dispatches` is the broadcasts still fanning out. A broadcast runs its handlers one after
	 *  another, so between two of them nothing is executing while work that is already registered
	 *  has not started. {@link hasPendingHandlerWork} reports that gap; the wait deliberately does
	 *  not block on it, or a caller waiting from inside one handler would wait for its own
	 *  siblings. */
	readonly #sessionWork = new WeakMap<
		object,
		{ readonly handlerWork: Set<Promise<unknown>>; readonly dispatches: Set<Promise<unknown>> }
	>();

	/** Settles whenever a tracked promise is added or removed, so a caller can wait for the next
	 *  change instead of sampling for it. */
	#workChanged: PromiseWithResolvers<void> | undefined;

	/** The session work is counted for: the one named, else the admitted call's on this stack, else
	 *  the one the runtime serves now — the session `createContext` makes a context for. A runtime
	 *  with no session generations has one lifetime, this runner's. */
	#workOf(session?: ExtensionSessionGeneration) {
		const generation: object = session ?? this.runtime?.sessionGeneration ?? this;
		let work = this.#sessionWork.get(generation);
		if (!work) {
			work = { handlerWork: new Set(), dispatches: new Set() };
			this.#sessionWork.set(generation, work);
		}
		return work;
	}

	#track(set: Set<Promise<unknown>>, work: Promise<unknown>): void {
		const tracked: Promise<void> = work.then(
			() => undefined,
			() => undefined,
		);
		set.add(tracked);
		this.#notifyWorkChanged();
		void tracked.finally(() => {
			set.delete(tracked);
			this.#notifyWorkChanged();
		});
	}

	#notifyWorkChanged(): void {
		const changed = this.#workChanged;
		this.#workChanged = undefined;
		changed?.resolve();
	}

	#trackHandlerWork(handlerWork: Promise<unknown>): void {
		this.#track(this.#workOf().handlerWork, handlerWork);
	}

	/** Whether extension work of `session` (by default the session a context is made for here) is
	 *  outstanding: a callback of it executing (see {@link ExtensionRuntime}'s pending-callback set —
	 *  timers and `pi.events` subscriptions report there too, not only this runner's own
	 *  invocations), a raced-out handler, or a broadcast between two of its handlers. Cheap check for
	 *  a caller that must not declare itself settled while extension work runs, but cannot afford to
	 *  wait for it. */
	hasPendingHandlerWork(session?: ExtensionSessionGeneration): boolean {
		const work = this.#workOf(session);
		return work.handlerWork.size > 0 || work.dispatches.size > 0 || this.runtime.hasPendingCallbacks(session);
	}

	/** Resolves once every extension callback of `session` (as {@link hasPendingHandlerWork} names
	 *  it) that is executing has returned, including ones whose dispatch already gave up on them and
	 *  ones a timer or the event bus invoked. Unbounded by design: a callback that never returns
	 *  keeps whatever its caller is holding, which is safer than releasing under it.
	 *
	 *  A broadcast between two of its handlers is not awaited — a caller waiting from inside one
	 *  handler would wait for its own siblings — but neither is it polled: this waits for the next
	 *  change in the tracked sets, which is either that broadcast's next callback starting or the
	 *  broadcast ending. A caller looping on {@link hasPendingHandlerWork} therefore makes one wait
	 *  per real event rather than one per turn of the event loop. */
	async waitForPendingHandlerWork(session?: ExtensionSessionGeneration): Promise<void> {
		const work = this.#workOf(session);
		while (work.handlerWork.size > 0 || this.runtime.hasPendingCallbacks(session)) {
			await Promise.all([...work.handlerWork, this.runtime.waitForPendingCallbacks(session)]);
		}
		if (work.dispatches.size > 0) {
			this.#workChanged ??= Promise.withResolvers<void>();
			await Promise.race([this.#workChanged.promise, this.runtime.whenCallbacksChange()]);
		}
	}

	/** Claims this runner's extension callbacks for a session that is starting, and returns the
	 *  only way to give that claim back. A host may build one runner and hand it to several
	 *  sessions in turn, so the claim — not the runner's own lifetime — is what keeps its
	 *  callbacks live.
	 *
	 *  There is deliberately no separate "retire" method: a release that is not a handle from a
	 *  claim can be called by a caller that never claimed, and that retires a live sibling
	 *  session's surface. Waiting for work this runner can see is not enough on its own — a
	 *  facility it never told can still enter a disposed session — which is why the claim exists
	 *  at all. See `ExtensionCallbackOwner`. */
	claimExtensionCallbacks(): (() => void) | undefined {
		if (typeof this.runtime?.beginSession !== "function") return undefined;
		return this.runtime.beginSession();
	}

	/** The owner a facility uses to own an invocation of a callback this session accepted. Exposed
	 *  because the invoker — not this runner — is the party that knows when its call starts. */
	get callbackOwner(): ExtensionRuntime {
		return this.runtime;
	}

	/**
	 * Runs one handler inside this session's admission, bounded by `timeoutMs`.
	 *
	 * Both directions of the boundary are crossed here, for every emitter: the handler is handed a
	 * copy of the event, so an edit in place or an installed getter changes nothing the host reads
	 * from its own records afterwards (`eventIsCopy` when the emitter built a fresh copy for this
	 * handler itself), and what the handler returns is copied by the event's schema
	 * (`copyHandlerResult`) before the admitted call settles — every later read by the emitter is of
	 * the host's copy, and a result the host never reads is never touched. A signal the event
	 * carries is handed as the one this admission aborts (`HandedSignals`), let go of when the
	 * handler's own work is over, so a listener the handler installs runs as the session's work and
	 * never after it.
	 */
	async #runHandlerWithTimeout<TEvent extends { type: string }, R>(
		handler: (event: TEvent, ctx: ExtensionContext) => Promise<R | undefined> | R | undefined,
		event: TEvent,
		ctx: ExtensionContext,
		ext: Extension,
		timeoutMs: number,
		onFailure?: (kind: "timeout" | "error", message: string) => R,
		outerSignal?: AbortSignal,
		eventIsCopy = false,
	): Promise<R | undefined> {
		// `session_stop` carries its own signal on the event; `tool_call` receives
		// the outer dispatch signal (loop request or wrapper execute) so an abort
		// while a handler awaits a human dialog cancels the dialog and settles the
		// gate without executing the underlying tool. Compose whichever apply.
		const sessionStopSignal =
			event.type === "session_stop" && "signal" in event && event.signal instanceof AbortSignal
				? event.signal
				: undefined;
		const signals = [outerSignal, sessionStopSignal].filter((s): s is AbortSignal => s !== undefined);
		const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
		if (signal?.aborted) return undefined;
		const registrationScope: ToolRegistrationScope = { pending: new Set(), closed: false };
		let handlerResult: R | typeof EXTENSION_HANDLER_TIMEOUT | typeof EXTENSION_HANDLER_ABORTED | undefined;
		let handlerFailure: { error: unknown } | undefined;
		try {
			handlerResult = await this.#runDispatched(ctx, { extensionPath: ext.path, event: event.type }, () =>
				raceHandlerWithTimeout(
					async (handlerSignal, budget) => {
						registrationScope.signal = handlerSignal;
						let result: R | undefined;
						const handedSignals = new HandedSignals(this.callbackGate);
						try {
							const handlerContext = createHandlerContext(
								ctx,
								handlerSignal,
								event.type === "tool_call" ? budget : undefined,
							);
							const produced = await this.#toolRegistrationScope.run(registrationScope, () =>
								handler(eventIsCopy ? event : copyHostData(event, handedSignals), handlerContext),
							);
							result = copyHandlerResult(event.type, produced, ext.path) as R | undefined;
						} catch (error) {
							handlerFailure = { error };
						} finally {
							handedSignals.release();
							registrationScope.closed = true;
						}
						try {
							await this.#flushToolRegistrations(registrationScope.pending);
						} catch (error) {
							handlerFailure ??= { error };
						}
						return result;
					},
					timeoutMs,
					signal,
					handlerWork => this.#trackHandlerWork(handlerWork),
				),
			);
		} catch (error) {
			handlerFailure = { error };
		} finally {
			registrationScope.closed = true;
		}
		if (handlerResult === EXTENSION_HANDLER_ABORTED) return undefined;
		if (handlerResult === EXTENSION_HANDLER_TIMEOUT) {
			const error = `handler timed out after ${timeoutMs}ms`;
			logger.warn("Extension handler timed out", {
				extensionPath: ext.path,
				event: event.type,
				timeoutMs,
			});
			this.emitError({
				extensionPath: ext.path,
				event: event.type,
				error,
			});
			return onFailure?.("timeout", error);
		}
		if (handlerFailure) {
			const message =
				handlerFailure.error instanceof Error ? handlerFailure.error.message : String(handlerFailure.error);
			const stack = handlerFailure.error instanceof Error ? handlerFailure.error.stack : undefined;
			this.emitError({
				extensionPath: ext.path,
				event: event.type,
				error: message,
				stack,
			});
			return onFailure?.("error", message);
		}
		return handlerResult as R | undefined;
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const result = await this.#emitTo(this.extensions, event);
		// Recorded once the broadcast ends: an extension added mid-broadcast is
		// reached by the live iteration, one added later gets the replay.
		if (event.type === "session_start") this.#sessionStartEvent = event;
		return result;
	}

	/** Tracked as one unit: a broadcast runs its handlers one after another, so a caller that waits
	 *  only on the callbacks currently executing can return in the gap between two of them and miss
	 *  a handler that was registered before it ever asked. */
	#emitTo<TEvent extends RunnerEmitEvent>(
		extensions: readonly Extension[],
		event: TEvent,
	): Promise<RunnerEmitResult<TEvent>> {
		const work = this.#workOf();
		const broadcast = this.#emitToHandlers(extensions, event);
		this.#track(work.dispatches, broadcast);
		return broadcast;
	}

	async #emitToHandlers<TEvent extends RunnerEmitEvent>(
		extensions: readonly Extension[],
		event: TEvent,
	): Promise<RunnerEmitResult<TEvent>> {
		// Defer the per-event context allocation (and the Promise.race/Bun.sleep
		// timeout machinery) to the first matching handler. Streaming sessions emit
		// message_update / tool_execution_* per delta with usually no extension
		// subscribed; building `ctx` for a zero-handler event is pure waste.
		let ctx: ExtensionContext | undefined;
		let result: SessionBeforeEventResult | SessionCompactingResult | SessionStopEventResult | undefined;

		if (this.#isSessionShutdownEvent(event)) {
			const timeoutMs = handlerTimeoutForEvent(event.type);
			const promises: Promise<unknown>[] = [];
			for (const ext of extensions) {
				const handlers = ext.handlers.get(event.type);
				if (!handlers || handlers.length === 0) continue;
				ctx ??= this.createContext();
				for (const handler of handlers) {
					promises.push(this.#runHandlerWithTimeout(handler, event, ctx, ext, timeoutMs));
				}
			}
			if (promises.length > 0) await Promise.all(promises);
			return result as RunnerEmitResult<TEvent>;
		}

		for (const ext of extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;
			ctx ??= this.createContext();

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					handlerTimeoutForEvent(event.type),
				);

				if (this.#isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult as SessionBeforeEventResult;
					if (result.cancel) {
						return result as RunnerEmitResult<TEvent>;
					}
				}

				if (event.type === "session.compacting" && handlerResult) {
					result = handlerResult as SessionCompactingResult;
				}

				if (event.type === "session_stop" && handlerResult) {
					const stopResult = handlerResult as SessionStopEventResult;
					if (stopResult.decision === "block") {
						return stopResult as RunnerEmitResult<TEvent>;
					}
					const continuationContext = stopResult.additionalContext || stopResult.reason;
					if (stopResult.continue === true && continuationContext) {
						if (result) {
							const prior = result as SessionStopEventResult;
							result = {
								continue: true,
								additionalContext: `${prior.additionalContext || prior.reason}\n\n${continuationContext}`,
							};
						} else {
							result = stopResult;
						}
					}
				}
			}
		}

		// Handlers for these events export session-scoped environment (a session
		// id, per-session tool config). The shell spawn environment is a cached
		// copy that may predate them or belong to the previous session, so capture
		// process.env for it as soon as they have run. Only the main agent's events
		// do this: in-process subagents share process.env, and a subagent's session
		// start must not hand its values to the parent's commands. A process that
		// hosts several top-level sessions (ACP) still has one spawn environment,
		// which follows the latest of their events.
		if (ctx !== undefined && this.agent.kind === "main" && SESSION_IDENTITY_EVENTS[event.type] === true) {
			refreshShellConfigCache();
		}

		return result as RunnerEmitResult<TEvent>;
	}

	/**
	 * Run extension rewrites on a detached finalized assistant message. Text may
	 * change only in its original block position; all other metadata and blocks
	 * remain unchanged. Text replay signatures are tied to their original text.
	 *
	 * Handlers are handed a copy (the dispatch copies every event), but the result
	 * is rebuilt from the original blocks: unchanged blocks keep their identity
	 * and symbol-keyed provider markers (e.g. `kCursorExecResolved`, which no copy
	 * carries and without which agent-loop re-runs Cursor-settled tool calls).
	 */
	async emitAssistantMessage(
		message: AssistantMessage,
		signal?: AbortSignal,
	): Promise<AssistantMessage["content"] | undefined> {
		if (!this.hasHandlers("assistant_message")) return undefined;
		const ctx = this.createContext();
		const original = message.content;
		// Accepted text per block position; every other field comes from `original`.
		const texts = original.map(block => (block.type === "text" ? block.text : undefined));
		const isRewritten = (index: number) => {
			const block = original[index];
			return block?.type === "text" && texts[index] !== block.text;
		};
		const currentContent = (): AssistantMessage["content"] =>
			original.map((block, index) => {
				if (block.type !== "text" || !isRewritten(index)) return block;
				const { textSignature: _stale, ...rest } = block;
				return { ...rest, text: texts[index] as string };
			});
		const textMetadata = (block: TextContent) => {
			const { text: _text, textSignature: _textSignature, ...metadata } = block;
			return metadata;
		};

		extensions: for (const ext of this.extensions) {
			const handlers = ext.handlers.get("assistant_message");
			if (!handlers?.length) continue;
			for (const handler of handlers) {
				if (signal?.aborted) break extensions;
				// The dispatch hands the handler a copy of the whole message, not just `content`:
				// in-place edits to `usage` or other fields must not leak into the finalized message.
				const event: AssistantMessageRewriteEvent = {
					type: "assistant_message",
					message: { ...message, content: currentContent() },
				};
				const result = (await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
					undefined,
					signal,
				)) as AssistantMessageRewriteResult | undefined;
				if (signal?.aborted) break extensions;
				if (result?.content === undefined) continue;
				const replacement = result.content;
				// Compare against the current content as the copy of a replacement reads it: the
				// fields a block declares, without the host's markers.
				const expected = assistantContentAsCopied(currentContent());
				if (
					!Array.isArray(replacement) ||
					replacement.length !== expected.length ||
					replacement.some((block, index) => {
						const previous = expected[index];
						if (!block || typeof block !== "object" || block.type !== previous?.type) return true;
						if (block.type !== "text") return !Bun.deepEquals(block, previous);
						return (
							typeof block.text !== "string" ||
							previous?.type !== "text" ||
							!Bun.deepEquals(textMetadata(block), textMetadata(previous))
						);
					})
				) {
					this.emitError({
						extensionPath: ext.path,
						event: "assistant_message",
						error: "content replacement may only change text in existing blocks; block positions, non-text blocks, and other metadata must remain unchanged",
					});
					continue;
				}
				for (const [index, block] of replacement.entries()) {
					if (block.type === "text") texts[index] = block.text;
				}
			}
		}
		return original.some((_block, index) => isRewritten(index)) ? currentContent() : undefined;
	}

	/**
	 * Emit `tool_result` to every subscribed extension. Returns the full
	 * `content`/`details`/`isError` triple only when a handler modified the
	 * result; joined `additionalContext` rides along whenever any handler set it.
	 */
	async emitToolResult(
		event: ToolResultEvent,
		agent?: ExtensionAgentIdentity,
	): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext(undefined, undefined, agent);
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;
		const contexts: string[] = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = (await this.#runHandlerWithTimeout(
					handler,
					currentEvent,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				)) as ToolResultEventResult | undefined;
				if (!handlerResult) continue;

				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					modified = true;
				}
				if (handlerResult.details !== undefined) {
					currentEvent.details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
				if (isNonBlankContext(handlerResult.additionalContext)) {
					contexts.push(handlerResult.additionalContext);
				}
			}
		}

		const additionalContext = joinAdditionalContext(contexts);
		if (!modified) return additionalContext === undefined ? undefined : { additionalContext };

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
			...(additionalContext !== undefined ? { additionalContext } : {}),
		};
	}

	/**
	 * Emit a `tool_call` event to every subscribed extension before the tool executes.
	 *
	 * Each handler is bounded by `extensionHandlers.toolCallTimeoutMs` (default
	 * 30s). This matches the timeout policy already applied to `emitToolResult` and every
	 * other handler routed through `#runHandlerWithTimeout`; without it a single
	 * hung extension (unresolved `await`, network call with no timeout) would
	 * park `ExtensionToolWrapper.execute` indefinitely and freeze tool
	 * dispatch — see issue #3948.
	 *
	 * On-timeout policy: **fail-closed** (return `{ block: true }`). This is
	 * symmetric with the existing error path below and safer for a
	 * pre-execution gate — an unresponsive extension MUST NOT be treated as
	 * silent consent to run the tool.
	 *
	 * `agent` overrides `ctx.agent` when the tool runs for another agent sharing this runner.
	 */
	async emitToolCall(
		event: ToolCallEvent,
		signal?: AbortSignal,
		agent?: ExtensionAgentIdentity,
	): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext(undefined, undefined, agent);
		const timeoutMs = normalizeHandlerTimeout(
			(this.settings ? cfgExtensionHandlersToolCallTimeoutMs.get(this.settings) : undefined) ??
				extensionHandlerTimeoutMs,
		);
		let result: ToolCallEventResult | undefined;
		const aggregated = { input: undefined as ToolCallEventResult["input"], additionalContext: [] as string[] };

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = (await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					timeoutMs,
					(kind, message) => ({
						block: true,
						reason:
							kind === "timeout"
								? `Extension ${ext.path} timed out after ${timeoutMs}ms`
								: `Extension ${ext.path} failed: ${message}`,
					}),
					signal,
				)) as ToolCallEventResult | undefined;

				if (!handlerResult) continue;
				if (handlerResult.block) {
					return handlerResult;
				}
				const { additionalContext: _context, input: _input, ...controlResult } = handlerResult;
				accumulateToolCallResult(aggregated, handlerResult);
				result = controlResult;
			}
		}

		if (signal?.aborted) {
			return { block: true, reason: `Tool execution was cancelled while an extension handler was pending` };
		}
		return buildAggregatedToolCallResult(result, aggregated);
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return this.emitUserEvent<UserBashEventResult>(event, "user_bash");
	}

	async emitUserPython(event: UserPythonEvent): Promise<UserPythonEventResult | undefined> {
		return this.emitUserEvent<UserPythonEventResult>(event, "user_python");
	}

	private async emitUserEvent<R>(
		event: UserBashEvent | UserPythonEvent,
		eventName: "user_bash" | "user_python",
	): Promise<R | undefined> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventName);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult) {
					return handlerResult as R;
				}
			}
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				const result = handlerResult as ResourcesDiscoverResult | undefined;

				if (result?.skillPaths?.length) {
					skillPaths.push(...result.skillPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.promptPaths?.length) {
					promptPaths.push(...result.promptPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.themePaths?.length) {
					themePaths.push(...result.themePaths.map(path => ({ path, extensionPath: ext.path })));
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: "interactive" | "rpc" | "extension",
	): Promise<InputEventResult> {
		if (!this.hasHandlers("input")) return {};
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("input") ?? []) {
				const event: InputEvent = { type: "input", text: currentText, images: currentImages, source };
				const result = (await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs)) as
					| InputEventResult
					| undefined;
				if (result?.handled) return result;
				if (result?.text !== undefined) currentText = result.text;
				if (result?.images !== undefined) currentImages = result.images;
			}
		}
		const transformed: InputEventResult = {};
		if (currentText !== text) transformed.text = currentText;
		if (currentImages !== images) transformed.images = currentImages;
		return transformed;
	}

	async emitContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		// Check if any extensions actually have context handlers before building
		// the context object or cloning; this runs on every provider request.
		if (!this.hasHandlers("context")) return messages;
		const ctx = this.createContext();

		// The host's working copy: `copyHostData` copies what `structuredClone` cannot (a function in a
		// tool result's details), so no handler is ever handed a live history message.
		let currentMessages: AgentMessage[] = copyHostData(messages);
		for (let index = 0; index < currentMessages.length; index++) {
			const message = currentMessages[index];
			if (message) setContextHistoryIndex(message, index);
		}

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				// Each handler gets its own copy, carrying the history position the dispatch's generic
				// copy would drop: an edit in place reaches neither the working copy nor history.
				const presented = currentMessages.map(message => {
					const copy = copyHostData(message);
					const historyIndex = getContextHistoryIndex(message);
					if (historyIndex !== undefined) setContextHistoryIndex(copy, historyIndex);
					return copy;
				});
				const event: ContextEvent = { type: "context", messages: presented };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
					undefined,
					signal,
					true,
				);

				if (handlerResult && (handlerResult as ContextEventResult).messages) {
					const nextMessages = (handlerResult as ContextEventResult).messages!;
					for (let index = 0; index < nextMessages.length; index++) {
						const message = nextMessages[index];
						if (!message || getContextHistoryIndex(message) !== undefined) continue;
						const previousMessage = currentMessages[index];
						if (!previousMessage) continue;
						const historyIndex = getContextHistoryIndex(previousMessage);
						if (historyIndex === undefined) continue;
						setContextHistoryIndex(message, historyIndex);
						if (!Bun.deepEquals(message, previousMessage)) clearContextHistoryIndex(message);
					}
					currentMessages = nextMessages;
				}
			}
		}

		for (const message of currentMessages) {
			const historyIndex = getContextHistoryIndex(message);
			const historyMessage = historyIndex === undefined ? undefined : messages[historyIndex];
			if (historyMessage && historyIndex !== undefined) setContextHistoryIndex(historyMessage, historyIndex);
			const unchanged = historyMessage !== undefined && Bun.deepEquals(message, historyMessage);
			clearContextHistoryIndex(message);
			if (historyMessage) clearContextHistoryIndex(historyMessage);
			if (!unchanged) markPerCallContextMessage(message);
		}
		for (const message of messages) clearContextHistoryIndex(message);
		// An aborted handler is skipped and its input kept unchanged. Never hand that
		// untransformed (possibly unredacted) context back to a caller as if every hook ran.
		signal?.throwIfAborted();
		return currentMessages;
	}

	/** Runs request payload hooks with the model used for that provider request. */
	async emitBeforeProviderRequest(
		payload: unknown,
		model?: Model,
		signal?: AbortSignal,
	): Promise<BeforeProviderRequestEventResult> {
		if (!this.hasHandlers("before_provider_request")) return payload;
		const ctx = this.createContext(model);
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeProviderRequestEvent = {
					type: "before_provider_request",
					payload: currentPayload,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
					undefined,
					signal,
				);
				if (handlerResult !== undefined) {
					currentPayload = handlerResult;
				}
			}
		}

		return currentPayload;
	}

	/** Runs response hooks with the model that produced that provider response. */
	async emitAfterProviderResponse(
		response: ProviderResponseMetadata,
		model?: Model,
		signal?: AbortSignal,
	): Promise<void> {
		if (!this.hasHandlers("after_provider_response")) return;
		const ctx = this.createContext(model);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("after_provider_response");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: AfterProviderResponseEvent = {
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
					requestId: response.requestId,
					metadata: response.metadata,
				};
				await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs, undefined, signal);
			}
		}
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string[],
		reason: BeforeAgentStartEvent["reason"] = "prompt",
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		if (!this.hasHandlers("before_agent_start")) return undefined;
		const ctx = this.createContext();
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let currentSystemPrompt = systemPrompt;
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					reason,
					prompt,
					images,
					systemPrompt: currentSystemPrompt,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult) {
					const result = handlerResult as BeforeAgentStartEventResult;
					if (result.message) {
						messages.push(result.message);
					}
					if (result.systemPrompt !== undefined) {
						currentSystemPrompt =
							typeof result.systemPrompt === "string" ? [result.systemPrompt] : result.systemPrompt;
						systemPromptModified = true;
					}
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}

	/**
	 * Runs `before_subagent_spawn` handlers; a `block` short-circuits, the last defined `model` wins.
	 * `signal` (the spawn's abort signal) cancels an awaiting handler instead of parking until the timeout.
	 */
	async emitBeforeSubagentSpawn(
		event: BeforeSubagentSpawnEvent,
		signal?: AbortSignal,
	): Promise<BeforeSubagentSpawnEventResult | undefined> {
		if (!this.hasHandlers("before_subagent_spawn")) return undefined;
		const ctx = this.createContext();
		let chosen: Pick<BeforeSubagentSpawnEventResult, "model" | "note"> | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_subagent_spawn");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
					undefined,
					signal,
				);
				if (!handlerResult) continue;
				const result = handlerResult as BeforeSubagentSpawnEventResult;
				if (result.block) return result;
				if (result.model !== undefined) chosen = { model: result.model, note: result.note };
			}
		}

		return chosen;
	}
}
