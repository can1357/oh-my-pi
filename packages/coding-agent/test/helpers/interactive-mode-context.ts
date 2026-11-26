/**
 * Shared `InteractiveModeContext` fixture for controller tests that drive
 * controllers (`EventController`, `MCPCommandController`, `ExtensionUiController`,
 * `UiHelpers`, …) without booting `InteractiveMode`.
 *
 * Defaults cover every member those paths read, using real parts where they
 * are cheap (an {@link AppFrame}: the pi-tui `Shell`, the `Composer` mounted in
 * its slot and every dock HUD model; `SessionManager.inMemory`, the `settings`
 * singleton, `OAuthManualInputManager`, an in-memory `KeybindingsManager`) and
 * inert stubs elsewhere. The shell is never started: blocks, slots and
 * overlays mount and focus moves, but nothing paints. Tests override only
 * what they assert on:
 *
 * ```ts
 * const ctx = createInteractiveModeContext({
 * 	session: { getToolByName: () => tool },
 * 	streamingMessage: message,
 * });
 * const controller = new EventController(ctx);
 * ```
 *
 * - `present(factory, { live, before })` appends to `shell.transcript` (before
 *   `before`), settled unless `live`; `presentCommandOutput` appends settled.
 * - `showEditorAreaDialog(factory, options)` opens the view as a shell overlay
 *   (focus moves in; closing restores it).
 * - Working rows keep real state: `working` follows `showWorking` /
 *   `clearWorking` / `ensureWorkingRow` (all `vi.fn`).
 * - Display flags (`toolOutputExpanded`, `hideToolActivity`, `hideThinkingBlock`,
 *   `proseOnlyThinking`, `expandThinkingBlocks`) are signals behind plain
 *   properties ({@link contextDisplay} returns them).
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
import type { FigureCell } from "../../src/ui/transcript/figures/svg";
import { isSettingsInitialized, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPDroppedServer } from "@oh-my-pi/pi-coding-agent/mcp/transforms";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AppFrame } from "../../src/modes/interactive/frame";
import { TranscriptPresenter } from "../../src/modes/interactive/transcript";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import { cfgTerminalShowImages } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type {
	InteractiveModeContext,
	PresentOptions,
	StatusLineModel,
	WorkingKind,
} from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ServedModelTracker } from "@oh-my-pi/pi-coding-agent/session/transcript/served-model-marker";
import { getAssistantMessageLinkTargets } from "../../src/session/transcript/link-targets";
import type { BlockOptions, InputInterceptor, OverlayOptions } from "../../src/ui/shell";
import { ViewList } from "../../src/ui/shell/views";
import type { StatusFacts, StatusLineSettings } from "@oh-my-pi/pi-coding-agent/ui/status/facts";
import { TokenRateMeter } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { type JSXNode, type KeyEvent, type Signal, signal } from "@oh-my-pi/pi-tui";
import type { InputEvent } from "@oh-my-pi/pi-tui/driver/index";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";

type AnyFn = (...args: never[]) => unknown;

/** Partial at every depth; function members keep their exact signature. */
export type Deep<T> = T extends AnyFn ? T : T extends object ? { [K in keyof T]?: Deep<T[K]> } : T;

export type ContextOverrides = Omit<Deep<InteractiveModeContext>, "viewSession"> & { viewSession?: Deep<AgentSession> };
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
		Object.defineProperty(target, key, {
			...descriptor,
			configurable: true,
			enumerable: true,
		});
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
		hasPostPromptWork: false,
		queuedMessageCount: 0,
		isTtsrAbortPending: false,
		retryAttempt: 0,
		messages: [],
		model: undefined,
		sessionFile: undefined,
		skills: [],
		ttsrManager: undefined,
		extensionRunner: undefined,
		effectiveExtensionRoots: {
			explicit: [],
			mode: "merge",
			configured: [],
			configuredLevel: "user",
		},
		modelRegistry: {},
		getToolByName: () => undefined,
		hasBuiltInTool: () => true,
		getLastAssistantMessage: () => undefined,
		agent: {
			state: { streamMessage: null },
			getPendingToolResults: () => [],
			metadataForProvider: () => undefined,
		},
		getEvalPreludes: () => [],
		getActiveToolNames: () => [],
		getEnabledToolNames: () => [],
		getContextUsage: () => undefined,
		getGoalModeState: () => undefined,
		refreshMCPTools: vi.fn(async () => {}),
		setMCPPromptCommands: vi.fn(),
		setActiveToolsByName: vi.fn(async () => {}),
		runIdleCompaction: vi.fn(async () => {}),
		waitForIdle: async () => {},
		isRunActive: false,
		wakeSources: undefined,
		waitForRunEnd: async () => {},
		getAsyncJobSnapshot: () => null,
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
	const emptyLoad = () => ({
		tools: [],
		errors: new Map<string, string>(),
		connectedServers: [],
		exaApiKeys: [],
	});
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
		getBuiltinDrops: vi.fn(() => new Map<string, MCPDroppedServer>()),
		getServerConfig: vi.fn(() => undefined),
		getServerResources: vi.fn(() => undefined),
		getServerPrompts: vi.fn(() => undefined),
		getNotificationState: vi.fn(() => ({
			enabled: false,
			subscriptions: new Map<string, ReadonlySet<string>>(),
		})),
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

const RESOLVED_AHEAD: Record<string, true> = {
	session: true,
	viewSession: true,
	sessionManager: true,
	settings: true,
};

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
	const frame = new AppFrame({ version: "test", shape: "box", quiet: true });
	const shell = frame.shell;
	shell.setHome(frame.composer.field);
	shell.focus(frame.composer.field);
	const display = createDisplay();
	const input: ContextInput = { interceptors: [], globalKeys: [] };
	let working: WorkingKind | undefined;
	const statusLine: StatusLineModel = {
		facts: () =>
			({
				context: { tokens: 0, window: 0, percent: null },
			}) as unknown as StatusFacts,
		settings: () => ({}) as StatusLineSettings,
		refresh: vi.fn(),
		refreshVcs: vi.fn(),
		resetActiveTime: vi.fn(),
		markActivityStart: vi.fn(),
		markActivityEnd: vi.fn(),
		setHookStatus: vi.fn(),
		setAwaitingAnswer: vi.fn(),
		setCollabStatus: vi.fn(),
		setRunningSubagents: vi.fn(() => false),
		setSession: vi.fn(),
		previewSettings: vi.fn(),
	};
	const present = (factory: () => JSXNode, options?: PresentOptions) => {
		const block = options?.before
			? shell.transcript.insertBefore(options.before, factory, options)
			: shell.transcript.append(factory, options);
		if (!options?.live) shell.transcript.settle(block);
		return block;
	};
	const ctx = {
		shell,
		composer: frame.composer,
		hud: frame.hud,
		statusLine,
		interceptInput: vi.fn((handler: InputInterceptor) => register(input.interceptors, handler)),
		addGlobalKeyHandler: vi.fn((handler: (key: KeyEvent) => boolean) => register(input.globalKeys, handler)),
		suspend: <R>(run: () => Promise<R>) => run(),
		dialogVim: vi.fn(() => undefined),
		setTerminalProgress: vi.fn(),
		showEditorAreaDialog: vi.fn((factory: () => JSXNode, options?: OverlayOptions) =>
			shell.overlays.show(factory, options),
		),
		closeLinkBrowser: vi.fn(),
		syncComposerShape: vi.fn(),
		syncExtensionLinks: vi.fn(),
		rerenderInLinkBrowser: vi.fn(),
		redrawTranscriptBlocks: vi.fn(),
		refreshTranscriptPresentation: vi.fn(),
		presentAssistant: vi.fn((...args: Parameters<TranscriptPresenter["presentAssistant"]>) =>
			presenter().presentAssistant(...args),
		),
		presentToolCall: vi.fn((...args: Parameters<TranscriptPresenter["presentToolCall"]>) =>
			presenter().presentToolCall(...args),
		),
		presentReadGroup: vi.fn((...args: Parameters<TranscriptPresenter["presentReadGroup"]>) =>
			presenter().presentReadGroup(...args),
		),
		transcriptEntry: vi.fn((...args: Parameters<TranscriptPresenter["transcriptEntry"]>) =>
			presenter().transcriptEntry(...args),
		),
		presentMessage: vi.fn((...args: Parameters<TranscriptPresenter["presentMessage"]>) =>
			presenter().presentMessage(...args),
		),
		presentExecRun: vi.fn((...args: Parameters<TranscriptPresenter["presentExecRun"]>) =>
			presenter().presentExecRun(...args),
		),
		flushPendingExecRuns: vi.fn(() => presenter().flushPendingExecRuns()),
		clearPendingExecRuns: vi.fn(() => presenter().clearPendingExecRuns()),
		resolveAssistantMessageLinkHrefs: vi.fn(async () => new Map<string, string>()),
		get working() {
			return working;
		},
		showWorking: vi.fn((kind: WorkingKind) => {
			working = kind;
		}),
		clearWorking: vi.fn((kind?: WorkingKind) => {
			if (working === undefined || (kind !== undefined && working !== kind)) return false;
			working = undefined;
			return true;
		}),
		ensureWorkingRow: vi.fn(() => {
			working ??= "turn";
		}),
		maintenanceInterruptKey: () => "escape",
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
		get toolOutputExpanded() {
			return display.toolOutputExpanded();
		},
		set toolOutputExpanded(value: boolean) {
			display.toolOutputExpanded.set(value);
		},
		get hideToolActivity() {
			return display.hideToolActivity();
		},
		set hideToolActivity(value: boolean) {
			display.hideToolActivity.set(value);
		},
		get hideThinkingBlock() {
			return display.hideThinkingBlock();
		},
		set hideThinkingBlock(value: boolean) {
			display.hideThinkingBlock.set(value);
		},
		get proseOnlyThinking() {
			return display.proseOnlyThinking();
		},
		set proseOnlyThinking(value: boolean) {
			display.proseOnlyThinking.set(value);
		},
		get expandThinkingBlocks() {
			return display.expandThinkingBlocks();
		},
		set expandThinkingBlocks(value: boolean) {
			display.expandThinkingBlocks.set(value);
		},
		get effectiveHideThinkingBlock() {
			return this.hideThinkingBlock;
		},
		get assistantImagesVisible() {
			return cfgTerminalShowImages.get(contextSettings);
		},
		tableChartsVisible: true,
		hasDisplayableThinkingContent: false,
		noteDisplayableThinkingContent: vi.fn(() => false),
		transcriptBlocks: new WeakMap(),
		pendingTools: new Map(),
		bashRun: undefined,
		pythonRun: undefined,
		isBashMode: false,
		isPythonMode: false,
		isBtwMode: false,
		streaming: undefined,
		streamingMessage: undefined,
		lastAssistantUsage: undefined,
		servedModelTracker: new ServedModelTracker(),
		tokenRate: new TokenRateMeter(text => text.length),
		optimisticUserMessageSignature: undefined,
		optimisticSkillMessagePending: false,
		locallySubmittedUserSignatures: new Set<string>(),
		mcpTestEscapeHandlers: new Set<() => void>(),
		keybindings: KeybindingsManager.inMemory(),
		dictationSpaceHold: vi.fn(),
		hookSelector: undefined,
		hookInput: undefined,
		hookEditor: undefined,
		composerOwner: undefined,
		approvalOwnsComposer: false,
		todoPhases: [],
		init: vi.fn(async () => {}),
		present: vi.fn(present),
		presentCommandOutput: vi.fn((factory: () => JSXNode, options?: BlockOptions) => {
			present(factory, options);
		}),
		flushPendingCommandOutput: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showModelCycleTrack: vi.fn(),
		showPinnedError: vi.fn(),
		clearPinnedError: vi.fn(),
		showHookInput: vi.fn(async () => undefined),
		showHookSelector: vi.fn(async () => undefined),
		addMessageToChat: vi.fn(() => []),
		showCommandReport: vi.fn(),
		requestShutdown: vi.fn(),
		restoreCompactionQueueToEditor: vi.fn(),
		runYieldCompaction: vi.fn(),
		handlePlanApproval: vi.fn(async () => {}),
		yieldCompaction: undefined,
		compactionQueuedMessages: [],
		shutdownRequested: false,
		rebuildChatFromMessages: vi.fn(),
		renderInitialMessages: vi.fn(async () => {}),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		syncIdleMaintenanceView: vi.fn(),
		setWorkingMessage: vi.fn(),
		syncRetryHintRow: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		prepareSessionSwitch: vi.fn(async () => {}),
		clearOptimisticUserMessage: vi.fn(),
		replaceOptimisticUserMessage: vi.fn(),
		reconcileOptimisticSkillMessage: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
		flushPendingModelSwitch: vi.fn(async () => {}),
		reloadTodos: vi.fn(async () => {}),
		setTodos: vi.fn(),
	} satisfies ContextOverrides;
	layer(ctx, overrides, RESOLVED_AHEAD);
	displays.set(ctx, display);
	inputs.set(ctx, input);
	// The real transcript presenter over the fixture's shell, view session and display flags.
	let transcriptPresenter: TranscriptPresenter | undefined;
	const presenter = (): TranscriptPresenter => {
		const built = ctx as unknown as InteractiveModeContext;
		transcriptPresenter ??= new TranscriptPresenter({
			shell,
			get viewSession() {
				return built.viewSession;
			},
			display: {
				toolOutputExpanded: display.toolOutputExpanded,
				hideToolActivity: display.hideToolActivity,
				hideThinking: display.hideThinkingBlock,
				proseOnlyThinking: display.proseOnlyThinking,
				expandThinkingBlocks: display.expandThinkingBlocks,
				showImages: signal(cfgTerminalShowImages.get(contextSettings)),
				renderSvg: signal(false),
				renderEmbeds: signal(false),
				figureCell: signal<FigureCell | undefined>(undefined),
				tableCharts: signal(true),
				shellVisualization: signal(true),
				mcpMarkdown: signal(false),
				readPreview: signal(false),
			},
			pendingShellRuns: new ViewList(),
			linkTargets: () => getAssistantMessageLinkTargets(built),
			messages: {
				expanded: () => display.toolOutputExpanded(),
				activityVisible: () => !display.hideToolActivity(),
				advisorCollapsedLines: () => 0,
				renderer: customType => built.viewSession.extensionRunner?.getMessageRenderer(customType),
				onRenderError: () => {},
				imageLinks: () => undefined,
				skillPath: () => undefined,
				actions: () => false,
				hour12: () => undefined,
				promptZones: () => false,
				magicKeywords: () => [],
				onUserAction: () => {},
			},
		});
		return transcriptPresenter;
	};
	return ctx as unknown as InteractiveModeContext;
}

/** The display flags behind a fixture context's flag properties. */
export interface ContextDisplay {
	readonly toolOutputExpanded: Signal<boolean>;
	readonly hideToolActivity: Signal<boolean>;
	readonly hideThinkingBlock: Signal<boolean>;
	readonly proseOnlyThinking: Signal<boolean>;
	readonly expandThinkingBlocks: Signal<boolean>;
}

const displays = new WeakMap<object, ContextDisplay>();

function createDisplay(): ContextDisplay {
	return {
		toolOutputExpanded: signal(false),
		hideToolActivity: signal(false),
		hideThinkingBlock: signal(false),
		proseOnlyThinking: signal(true),
		expandThinkingBlocks: signal(false),
	};
}

/** The display-flag signals of a context built by {@link createInteractiveModeContext}. */
export function contextDisplay(ctx: InteractiveModeContext): ContextDisplay {
	const display = displays.get(ctx);
	if (!display) throw new Error("not a createInteractiveModeContext() context");
	return display;
}

/** The context's transcript as plain terminal rows (escapes stripped, trailing blanks trimmed). */
export function renderTranscript(ctx: InteractiveModeContext, columns = 120): string[] {
	const term = createTestTerminal(() => ({ main: ctx.shell.transcript.nodes }), { columns, rows: 1000 });
	const rows = term.screen();
	while (rows.length > 0 && rows.at(-1) === "") rows.pop();
	return rows;
}

/** Input hooks a fixture context's controllers registered (`interceptInput`, `addGlobalKeyHandler`). */
interface ContextInput {
	readonly interceptors: InputInterceptor[];
	readonly globalKeys: ((key: KeyEvent) => boolean)[];
}

const inputs = new WeakMap<object, ContextInput>();

function register<T>(list: T[], handler: T): () => void {
	list.push(handler);
	return () => {
		const at = list.indexOf(handler);
		if (at !== -1) list.splice(at, 1);
	};
}

/**
 * Run the context's shell on an in-memory terminal: frames paint on input, keys reach the
 * shell's focused node after the context's input interceptors (newest first; a replacement
 * continues through the older ones), and unconsumed keys reach its global key handlers — as the
 * interactive mode's host routes them. `ctx.shell.input(event)` routes through the same path.
 */
export function attachTerminal(
	ctx: InteractiveModeContext,
	options: { columns?: number; rows?: number } = {},
): TestTerminal {
	const input = inputs.get(ctx);
	if (!input) throw new Error("not a createInteractiveModeContext() context");
	const intercept = (event: InputEvent, from: number): boolean => {
		const list = [...input.interceptors];
		for (let i = Math.min(from, list.length - 1); i >= 0; i--) {
			const result = list[i]!(event);
			if (result === true) return true;
			if (result === false) continue;
			for (const next of result) if (!intercept(next, i - 1)) term.backend.dispatch(next);
			return true;
		}
		return false;
	};
	const term = createTestTerminal(() => ({}), {
		columns: options.columns ?? 100,
		rows: options.rows ?? 40,
		surface: ctx.shell.surface,
		intercept: event => intercept(event, input.interceptors.length - 1),
		onKey: key => input.globalKeys.toReversed().some(handler => handler(key)),
	});
	Object.assign(ctx.shell, {
		input: (event: InputEvent, routing?: { readonly after?: InputInterceptor }) => {
			const at = routing?.after ? input.interceptors.indexOf(routing.after) : -1;
			if (!intercept(event, at === -1 ? input.interceptors.length - 1 : at - 1)) term.backend.dispatch(event);
			term.render();
		},
	});
	return term;
}
