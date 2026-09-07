/**
 * Shared `InteractiveModeContext` fixture for controller tests that drive
 * `EventController` / `MCPCommandController` / `UiHelpers` without booting
 * `InteractiveMode`.
 *
 * Defaults cover every member those paths read, using real components where
 * they are cheap (`TranscriptContainer`, `Container`, `SessionManager.inMemory`,
 * the `settings` singleton, `OAuthManualInputManager`) and inert stubs
 * elsewhere. Tests override only what they assert on:
 *
 * ```ts
 * const ctx = createInteractiveModeContext({
 * 	session: { getToolByName: () => tool },
 * 	streamingMessage: message,
 * 	streamingComponent: new AssistantMessageComponent(),
 * });
 * const controller = new EventController(ctx);
 * ```
 *
 * Overrides are partial at every depth. Plain-object overrides merge onto the
 * default (getters preserved), so `session: { isStreaming: true }` keeps the
 * stub's other members; class instances replace the default wholesale.
 * `viewSession` aliases `session` unless overridden separately. Function
 * members keep their real signature, so a signature drift in `AgentSession`
 * or `InteractiveModeContext` fails `bun check` here instead of at runtime
 * across every fixture.
 *
 * When a controller starts reading a new member, add its default here.
 * `settings` is the process-wide singleton when a test has run
 * `Settings.init({ inMemory: true })`, else an isolated instance — controllers
 * that also import the module-level `settings` need the global initialized.
 */
import { vi } from "bun:test";
import { isSettingsInitialized, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type Component, Container } from "@oh-my-pi/pi-tui";

type AnyFn = (...args: never[]) => unknown;

/** Partial at every depth; function members keep their exact signature. */
export type Deep<T> = T extends AnyFn ? T : T extends object ? { [K in keyof T]?: Deep<T[K]> } : T;

export type ContextOverrides = Deep<InteractiveModeContext>;
export type SessionOverrides = Deep<AgentSession>;
export type McpManagerOverrides = Deep<MCPManager>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Layer `overrides` onto `target`. A plain-object override whose target slot
 * already holds an object merges recursively; every other override (values,
 * getters, class instances, arrays, maps) replaces the slot via its own
 * property descriptor so accessor overrides survive.
 */
function layer(target: object, overrides: object, skip?: Record<string, true>): void {
	for (const key in overrides) {
		if (skip?.[key]) continue;
		const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
		if (descriptor === undefined) continue;
		const current = Object.getOwnPropertyDescriptor(target, key);
		if (
			"value" in descriptor &&
			isPlainObject(descriptor.value) &&
			current !== undefined &&
			"value" in current &&
			typeof current.value === "object" &&
			current.value !== null
		) {
			layer(current.value, descriptor.value);
			continue;
		}
		Object.defineProperty(target, key, { ...descriptor, configurable: true, enumerable: true });
	}
}

/** Inert `AgentSession` covering the members interactive controllers read. */
export function createSessionStub(
	sessionManager: SessionManager,
	sessionSettings: Settings,
	overrides?: SessionOverrides,
): AgentSession {
	if (overrides !== undefined && !isPlainObject(overrides)) return overrides as AgentSession;
	const stub = {
		sessionManager,
		settings: sessionSettings,
		isStreaming: false,
		isCompacting: false,
		isAborting: false,
		isRetrying: false,
		isTtsrAbortPending: false,
		retryAttempt: 0,
		messages: [],
		model: undefined,
		sessionFile: undefined,
		skills: [],
		ttsrManager: undefined,
		extensionRunner: undefined,
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		modelRegistry: {},
		getToolByName: () => undefined,
		hasBuiltInTool: () => true,
		getLastAssistantMessage: () => undefined,
		getEvalPreludes: () => [],
		getEnabledToolNames: () => [],
		getContextUsage: () => undefined,
		getGoalModeState: () => undefined,
		refreshMCPTools: vi.fn(async () => {}),
		setMCPPromptCommands: vi.fn(),
		setActiveToolsByName: vi.fn(async () => {}),
		runIdleCompaction: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
	} satisfies SessionOverrides;
	if (overrides) layer(stub, overrides);
	return stub as unknown as AgentSession;
}

// `waitForConnection` is only awaited by the controller; the resolved value is
// never inspected, so a shape-only connection keeps the default resolving.
const STUB_CONNECTION = {
	name: "stub",
	config: { type: "stdio", command: "stub" },
	serverInfo: { name: "stub", version: "0" },
	capabilities: {},
} as unknown as MCPServerConnection;

/** Inert `MCPManager` covering the members `MCPCommandController` reads. */
export function createMcpManagerStub(overrides?: McpManagerOverrides): MCPManager {
	if (overrides !== undefined && !isPlainObject(overrides)) return overrides as MCPManager;
	const emptyLoad = () => ({ tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] });
	const stub = {
		prepareConfig: vi.fn(async config => config),
		discoverAndConnect: vi.fn(async () => emptyLoad()),
		connectServers: vi.fn(async () => emptyLoad()),
		disconnectAll: vi.fn(async () => {}),
		disconnectServer: vi.fn(async () => {}),
		reconnectServer: vi.fn(async () => null),
		waitForConnection: vi.fn(async () => STUB_CONNECTION),
		getTools: vi.fn(() => []),
		getConnection: vi.fn(() => undefined),
		getConnectionStatus: vi.fn(() => "connected" as const),
		getConnectedServers: vi.fn(() => []),
		getAllServerNames: vi.fn(() => []),
		getSource: vi.fn(() => undefined),
		getServerConfig: vi.fn(() => undefined),
		getServerResources: vi.fn(() => undefined),
		getServerPrompts: vi.fn(() => undefined),
		getNotificationState: vi.fn(() => ({ enabled: false, subscriptions: new Map<string, ReadonlySet<string>>() })),
	} satisfies McpManagerOverrides;
	if (overrides) layer(stub, overrides);
	return stub as unknown as MCPManager;
}

function resolveSessionManager(override: ContextOverrides["sessionManager"]): SessionManager {
	if (override !== undefined && !isPlainObject(override)) return override as SessionManager;
	const manager = SessionManager.inMemory(process.cwd());
	if (override) layer(manager, override);
	return manager;
}

/** Plain-object overrides layer onto an isolated instance so the global singleton is never mutated. */
function resolveSettings(override: ContextOverrides["settings"]): Settings {
	if (override === undefined) return isSettingsInitialized() ? settings : Settings.isolated();
	if (!isPlainObject(override)) return override as Settings;
	const isolated = Settings.isolated();
	layer(isolated, override);
	return isolated;
}

const RESOLVED_AHEAD: Record<string, true> = { session: true, viewSession: true, sessionManager: true, settings: true };

/** Build a controller-ready context; see the module doc for override semantics. */
export function createInteractiveModeContext(overrides: ContextOverrides = {}): InteractiveModeContext {
	// Resolved ahead of layering; read individually so a rest-destructure does
	// not evaluate and freeze accessor overrides on the remaining keys.
	const sessionManager = resolveSessionManager(overrides.sessionManager);
	const contextSettings = resolveSettings(overrides.settings);
	const session = createSessionStub(sessionManager, contextSettings, overrides.session);
	const viewSession =
		overrides.viewSession === undefined
			? undefined
			: createSessionStub(sessionManager, contextSettings, overrides.viewSession);
	const chatContainer = new TranscriptContainer();
	const ui = {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		setFocus: vi.fn(),
		terminal: { setProgress: vi.fn() },
		imageBudget: undefined,
	};
	const mount = (content: Component | readonly Component[]): void => {
		for (const item of Array.isArray(content) ? content : [content as Component]) chatContainer.addChild(item);
		ui.requestRender();
	};
	const ctx = {
		ui,
		chatContainer,
		statusContainer: new Container(),
		editorContainer: new Container(),
		pendingMessagesContainer: new Container(),
		todoContainer: new Container(),
		editor: { getText: () => "", setText: vi.fn(), onEscape: undefined },
		statusLine: {
			invalidate: vi.fn(),
			markActivityStart: vi.fn(),
			markActivityEnd: vi.fn(),
			setSession: vi.fn(),
		},
		session,
		get viewSession() {
			return viewSession ?? this.session;
		},
		sessionManager,
		focusedAgentId: undefined,
		settings: contextSettings,
		mcpManager: undefined,
		oauthManualInput: new OAuthManualInputManager(),
		isInitialized: true,
		initialChatRendered: true,
		toolOutputExpanded: false,
		hideToolActivity: false,
		hideThinkingBlock: false,
		get effectiveHideThinkingBlock() {
			return this.hideThinkingBlock;
		},
		hasDisplayableThinkingContent: false,
		noteDisplayableThinkingContent: vi.fn(() => false),
		proseOnlyThinking: true,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		pendingBashComponents: [],
		bashComponent: undefined,
		pendingPythonComponents: [],
		pythonComponent: undefined,
		isBashMode: false,
		isPythonMode: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		lastAssistantUsage: undefined,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		optimisticUserMessageSignature: undefined,
		optimisticSkillMessagePending: false,
		locallySubmittedUserSignatures: new Set<string>(),
		mcpTestEscapeHandlers: new Set<() => void>(),
		todoPhases: [],
		init: vi.fn(async () => {}),
		present: vi.fn(mount),
		presentCommandOutput: vi.fn(mount),
		flushPendingCommandOutput: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showPinnedError: vi.fn(),
		clearPinnedError: vi.fn(),
		showHookInput: vi.fn(async () => undefined),
		showHookSelector: vi.fn(async () => undefined),
		addMessageToChat: vi.fn(() => []),
		rebuildChatFromMessages: vi.fn(),
		renderInitialMessages: vi.fn(async () => {}),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		setWorkingMessage: vi.fn(),
		syncRetryHintRow: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		clearOptimisticUserMessage: vi.fn(),
		replaceOptimisticUserMessage: vi.fn(),
		reconcileOptimisticSkillMessage: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
		flushPendingModelSwitch: vi.fn(async () => {}),
		reloadTodos: vi.fn(async () => {}),
		setTodos: vi.fn(),
		getUserMessageText: vi.fn(() => ""),
	} satisfies ContextOverrides;
	layer(ctx, overrides, RESOLVED_AHEAD);
	return ctx as unknown as InteractiveModeContext;
}
