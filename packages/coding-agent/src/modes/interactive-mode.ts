/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Agent,
	type AgentMessage,
	type AgentToolResult,
	EventLoopKeepalive,
	ThinkingLevel,
} from "@pk-nerdsaver-ai/pi-agent-core";
import type { CompactionOutcome } from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Model, Usage, UsageReport } from "@pk-nerdsaver-ai/pi-ai";
import { modelsAreEqual } from "@pk-nerdsaver-ai/pi-catalog/models";
import type {
	Component,
	EditorBottomSection,
	EditorTheme,
	LoaderMessageColorFn,
	NativeScrollbackLiveRegion,
	OverlayHandle,
	SlashCommand,
} from "@pk-nerdsaver-ai/pi-tui";
import {
	Container,
	clearRenderCache,
	Loader,
	Markdown,
	ProcessTerminal,
	Spacer,
	setTerminalTextSizing,
	setTuiTight,
	TERMINAL,
	Text,
	TUI,
	visibleWidth,
} from "@pk-nerdsaver-ai/pi-tui";
import {
	APP_NAME,
	adjustHsv,
	formatNumber,
	getProjectDir,
	hsvToRgb,
	isEnoent,
	logger,
	postmortem,
	prompt,
	setProjectDir,
} from "@pk-nerdsaver-ai/pi-utils";
import chalk from "chalk";
import { reset as resetCapabilities } from "../capability";
import type { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import { KeybindingsManager } from "../config/keybindings";
import { isSettingsInitialized, onStatusLineSessionAccentChanged, Settings, settings } from "../config/settings";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import type {
	ContextUsage,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { type GuidedGoalMessage, runGuidedGoalTurn } from "../goals/guided-setup";
import type { Goal, GoalModeState } from "../goals/state";
import { resolveLocalUrlToPath } from "../internal-urls";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import type { MCPManager } from "../mcp";
import {
	formatMCPConnectionStatusMessage,
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "../mcp/startup-events";
import {
	humanizePlanTitle,
	type PlanApprovalDetails,
	resolveApprovedPlan,
	resolvePlanTitle,
} from "../plan-mode/approved-plan";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import type { AgentSession, AgentSessionEvent, ResolvedRoleModel } from "../session/agent-session";
import type { CompactMode } from "../session/compact-modes";
import { ensureFusionSidekick, reconcileFusionSidekickModel } from "../session/fusion-sidekick";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import { getRecentSessions } from "../session/session-listing";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, BUILTIN_SLASH_COMMANDS } from "../slash-commands/builtin-registry";
import { formatDuration } from "../slash-commands/helpers/format";
import { STTController, type SttState } from "../stt";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { formatTaskId } from "../task/render";
import type { LspStartupServerInfo } from "../tools";
import { isImageProviderPreference, setPreferredImageProvider } from "../tools/image-gen";
import { normalizeLocalScheme } from "../tools/path-utils";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { setAutoQaConsentHandler } from "../tools/report-tool-issue";
import { type ResolveToolDetails, runResolveInvocation } from "../tools/resolve";
import { formatPhaseDisplayName, selectStickyTodoWindow, todoMatchesAnyDescription } from "../tools/todo";
import { ToolError } from "../tools/tool-errors";
import { vocalizer } from "../tts/vocalizer";
import { resolveActiveRepoContextSync } from "../utils/active-repo-context";
import type { EventBus } from "../utils/event-bus";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import * as git from "../utils/git";
import { getSessionAccentAnsi, getSessionAccentHex } from "../utils/session-color";
import { popTerminalTitle, pushTerminalTitle, setSessionTerminalTitle } from "../utils/title-generator";
import {
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "../web/search";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import { ChatBlock, type ChatBlockHost } from "./components/chat-block";
import {
	buildChipsRow,
	buildRailRow,
	type ComposerChip,
	ComposerDiagnosticsComponent,
	ComposerModeBar,
	type ComposerWorkMode,
	computeAskModeTools,
	getComposerWorkModeDef,
	nextComposerWorkMode,
} from "./components/composer";
import { CustomEditor } from "./components/custom-editor";
import { DynamicBorder } from "./components/dynamic-border";
import { ErrorBannerComponent } from "./components/error-banner";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent, HookSelectorSlider } from "./components/hook-selector";
import { PlanReviewOverlay } from "./components/plan-review-overlay";
import { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { TranscriptContainer } from "./components/transcript-container";
import { WelcomeComponent, type LspServerInfo as WelcomeLspServerInfo } from "./components/welcome";
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import { OmfgController } from "./controllers/omfg-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SessionFocusController } from "./controllers/session-focus-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { TanCommandController } from "./controllers/tan-command-controller";
import { TodoCommandController } from "./controllers/todo-command-controller";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopAction,
	type LoopLimitRuntime,
	parseLoopLimitArgs,
} from "./loop-limit";
import * as loopSynthesis from "./loop-synthesis";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { countRunningSubagentBadgeAgents, getRunningSubagentBadgeRegistry } from "./running-subagent-badge";
import type { ObservableSession } from "./session-observer-registry";
import { SessionObserverRegistry } from "./session-observer-registry";
import { runProviderSetupWizard } from "./setup-wizard/lazy";
import { interruptHint, sanitizeStatusText } from "./shared";
import { clearMermaidCache } from "./theme/mermaid-cache";
import { type ShimmerPalette, shimmerEnabled, shimmerSegments, shimmerText } from "./theme/shimmer";
import type { Theme } from "./theme/theme";
import {
	getEditorTheme,
	getMarkdownTheme,
	getSymbolTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	theme,
} from "./theme/theme";
import type {
	CompactionQueuedMessage,
	InteractiveModeContext,
	InteractiveModeInitOptions,
	InteractiveSelectorDialogOptions,
	SubmittedUserInput,
	TodoItem,
	TodoPhase,
} from "./types";
import { UiHelpers } from "./utils/ui-helpers";

const HINT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "borderAccent",
};

interface WorkingMessageAccent {
	main: string;
	dim: string;
}

interface WorkingMessageAccentCacheKey {
	sessionName: string | undefined;
	accentSurfaceLuminance: number | undefined;
	sessionAccentEnabled: boolean;
}

function renderWorkingMessage(message: string, accent?: WorkingMessageAccent): string {
	const palette = accent
		? ({
				low: "dim",
				mid: { ansi: accent.main },
				high: { ansi: accent.main },
				bold: true,
			} satisfies ShimmerPalette)
		: undefined;
	const hint = interruptHint();
	if (!message.endsWith(hint)) return shimmerText(message, theme, palette);
	const header = message.slice(0, -hint.length);
	const hintPalette = accent
		? ({
				low: "dim",
				mid: { ansi: accent.dim },
				high: { ansi: accent.dim },
			} satisfies ShimmerPalette)
		: HINT_SHIMMER_PALETTE;
	return shimmerSegments(
		[
			{ text: header, palette },
			{ text: hint, palette: hintPalette },
		],
		theme,
	);
}

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;
const EDITOR_MIN_CHROME_ROWS = 4; // rows reserved for transcript + status on small terms
const EDITOR_MIN_RENDERED_ROWS = 3; // bordered editor floor: top+bottom border + 1 content row

/** Rows rendered outside the editor frame by the intent composer. */
export interface ComposerChromeRows {
	readonly modeBar: number;
	readonly diagnostics: number;
}

/**
 * Editor max-height cap for a terminal of `terminalRows` rows.
 *
 * Intent-composer rows live beside (rather than inside) the editor frame, so
 * they must be deducted from the available budget. Classic callers omit the
 * option and retain the historical sizing exactly.
 */
export function computeEditorMaxHeight(terminalRows: number, chrome?: ComposerChromeRows): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : EDITOR_FALLBACK_ROWS;
	const externalRows = chrome ? Math.max(0, chrome.modeBar) + Math.max(0, chrome.diagnostics) : 0;
	const comfortable = Math.max(
		EDITOR_MAX_HEIGHT_MIN,
		Math.min(EDITOR_MAX_HEIGHT_MAX, rows - EDITOR_RESERVED_ROWS - externalRows),
	);
	return Math.max(EDITOR_MIN_RENDERED_ROWS, Math.min(comfortable, rows - EDITOR_MIN_CHROME_ROWS - externalRows));
}

const HUD_NOTE_SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function formatHudNoteMarker(count: number): string {
	if (count <= 0) return "";
	const sub = String(count)
		.split("")
		.map(d => HUD_NOTE_SUP_DIGITS[d] ?? d)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${sub}`));
}

type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);
const PLAN_KEEP_CONTEXT_OPTION_INDEX = 2;
const PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;

function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

function describeLoopAction(action: LoopAction): string {
	switch (action) {
		case "prompt":
			return "prompt";
		case "compact":
			return "compact";
		case "reset":
			return "reset";
		case "spiral":
			return "spiral";
	}
}

function formatContextTokenCount(value: number): string {
	return formatNumber(Math.max(0, Math.round(value))).toLowerCase();
}

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

/**
 * Hosts the working loader and transient status rows. While anything is
 * mounted, every row is live: report a seam at 0 so the engine never commits
 * a still-animating loader to native scrollback (stale `Working…` rows would
 * otherwise pile up above the live one). The transcript's own seam, when
 * present, sits higher and wins (topmost-seam merge in TUI.render).
 */
class StatusContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}
}

/** How long the ctrl+p model-role cycle chip track lingers above the editor
 *  before it auto-clears, mirroring the todo HUD's auto-clear timer. */
const MODEL_CYCLE_TRACK_CLEAR_MS = 4000;

/**
 * Build the anchored subagent HUD block: a bold accent "Subagents" header plus
 * one hooked row per running agent in the same `Id: description` shape the
 * inline task rows use (muted task preview when no description was given).
 * Only detached background spawns are listed: a sync task call blocks the
 * parent turn and its inline tool block already renders progress live, and
 * eval `agent()` spawns are rendered by their own eval cell tree.
 * Returns an empty array when nothing is running so the container can clear.
 */
export function renderSubagentHudLines(sessions: ObservableSession[], columns: number): string[] {
	const running = sessions.filter(
		session => session.kind === "subagent" && session.status === "active" && session.detached === true,
	);
	if (running.length === 0) return [];

	const indent = "  ";
	const hook = theme.tree.hook;
	const dot = theme.styledSymbol("status.done", "accent");
	const lines = ["", indent + theme.bold(theme.fg("accent", "Subagents"))];
	running.forEach((session, index) => {
		const prefix = `${indent}${index === 0 ? hook : " "} `;
		const displayId = formatTaskId(session.id);
		let line = `${prefix}${dot} ${theme.fg("accent", theme.bold(displayId))}`;
		const description = session.description?.trim() || session.progress?.description?.trim();
		if (description) {
			const budget = Math.max(TRUNCATE_LENGTHS.SHORT, columns - visibleWidth(prefix) - visibleWidth(displayId) - 6);
			line += `${theme.fg("accent", ":")} ${theme.fg("accent", truncateToWidth(replaceTabs(description), budget))}`;
		} else {
			// No spawn description: fall back to a muted task preview, same as
			// the inline task rows when a row has no label.
			const taskPreview = session.progress?.task?.trim();
			if (taskPreview) {
				line += ` ${theme.fg("muted", truncateToWidth(replaceTabs(taskPreview), TRUNCATE_LENGTHS.SHORT))}`;
			}
		}
		lines.push(line);
	});
	return lines;
}

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;
	titleSystemPrompt?: string;

	ui: TUI;
	chatContainer: TranscriptContainer;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	subagentContainer: Container;
	btwContainer: Container;
	omfgContainer: Container;
	errorBannerContainer: Container;
	modelCycleContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;

	isInitialized = false;
	isBashMode = false;
	toolOutputExpanded = false;
	todoExpanded = false;
	planModeEnabled = false;
	planModePaused = false;
	askModeEnabled = false;
	goalModeEnabled = false;
	goalModePaused = false;
	planModePlanFilePath: string | undefined = undefined;
	loopModeEnabled = false;
	loopPrompt: string | undefined = undefined;
	loopLimit: LoopLimitRuntime | undefined = undefined;
	loopActionOverride: LoopAction | undefined = undefined;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	/** Spiral-loop synthesis state: the previous reflection and how many consecutive
	 *  iterations it has repeated unchanged. Two stalls in a row stops the loop. */
	#loopSpiralLastReflection: string | undefined;
	#loopSpiralStallCount = 0;
	#todoAutoClearTimer: NodeJS.Timeout | undefined;
	#modelCycleClearTimer: NodeJS.Timeout | undefined;
	todoPhases: TodoPhase[] = [];
	hideThinkingBlock = false;
	proseOnlyThinking = false;
	initialChatRendered = false;
	/** Components rendered for the pending optimistic user message, so a superseding authoritative message can replace them. */
	#optimisticUserComponents: Component[] | undefined;
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	pendingBashComponents: BashExecutionComponent[] = [];
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingPythonComponents: EvalExecutionComponent[] = [];
	pythonComponent: EvalExecutionComponent | undefined = undefined;
	isPythonMode = false;
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	lastAssistantUsage: Usage | undefined = undefined;
	loadingAnimation: Loader | undefined = undefined;
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;
	#pendingWorkingMessage: string | undefined;
	#workingMessageAccentCacheKey?: WorkingMessageAccentCacheKey;
	#workingMessageAccentCacheValue?: WorkingMessageAccent;
	#workingMessageAccentCacheHasValue = false;
	get #defaultWorkingMessage(): string {
		return `Working…${interruptHint()}`;
	}
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined = undefined;
	locallySubmittedUserSignatures: Set<string> = new Set();
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	#pendingSubmissionDispose: (() => void) | undefined;
	lastSigintTime = 0;
	lastEscapeTime = 0;
	lastLeftTapTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;
	/** True once `shutdown()` has begun teardown. Surfaced to the input
	 *  controller so a Ctrl+C arriving while teardown is in flight can hard-
	 *  abort the remaining work instead of stacking another no-op call. */
	get isShuttingDown(): boolean {
		return this.#isShuttingDown;
	}
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, string> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;

	#pendingSlashCommands: SlashCommand[] = [];
	#cleanupUnsubscribe?: () => void;
	readonly #version: string;
	readonly #changelogMarkdown: string | undefined;
	#planModePreviousTools: string[] | undefined;
	#askModePreviousTools: string[] | undefined;
	#composerBranchCache: { dir: string; value: string | null; readAt: number } | undefined;
	readonly #composerModeBar: ComposerModeBar;
	readonly #composerDiagnostics: ComposerDiagnosticsComponent;
	#composerTransition: Promise<void> = Promise.resolve();
	#goalModePreviousTools: string[] | undefined;
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	#goalTurnHadToolCalls = false;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;
	#planModePreviousModelState: { model: Model; thinkingLevel?: ThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ThinkingLevel } | undefined;
	#planModeHasEntered = false;
	#planReviewOverlay: PlanReviewOverlay | undefined;
	#planReviewOverlayHandle: OverlayHandle | undefined;
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: MCPManager;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	readonly #btwController: BtwController;
	readonly #tanCommandController: TanCommandController;
	readonly #omfgController: OmfgController;
	readonly #commandController: CommandController;
	readonly #todoCommandController: TodoCommandController;
	readonly #eventController: EventController;
	get eventController(): EventController {
		return this.#eventController;
	}
	get eventBus(): EventBus | undefined {
		return this.#eventBus;
	}
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #focusController: SessionFocusController;
	get viewSession(): AgentSession {
		return this.#focusController.target ?? this.session;
	}
	get focusedAgentId(): string | undefined {
		return this.#focusController.focusedAgentId;
	}
	focusAgentSession(id: string): Promise<void> {
		return this.#focusController.focusAgent(id);
	}
	focusParentSession(): Promise<void> {
		return this.#focusController.focusParent();
	}
	unfocusSession(): Promise<void> {
		return this.#focusController.unfocus();
	}
	clearTransientSessionUi(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		this.pendingMessagesContainer.clear();
		this.#cancelModelCycleClearTimer();
		this.modelCycleContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.lastAssistantUsage = undefined;
		this.pendingTools.clear();
	}
	readonly #uiHelpers: UiHelpers;
	#sttController: STTController | undefined;
	#voiceAnimationInterval: NodeJS.Timeout | undefined;
	#voiceHue = 0;
	#voicePreviousShowHardwareCursor: boolean | null = null;
	#voicePreviousUseTerminalCursor: boolean | null = null;
	#resizeHandler?: () => void;
	#observerRegistry: SessionObserverRegistry;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	#mcpPendingServers: string[] = [];
	#mcpConnectedServers: string[] = [];
	#mcpFailedServers = new Map<string, string>();
	#welcomeComponent?: WelcomeComponent;
	readonly #chatHost: ChatBlockHost = { requestRender: () => this.ui.requestRender() };

	constructor(
		session: AgentSession,
		version: string,
		changelogMarkdown: string | undefined = undefined,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: MCPManager,
		eventBus?: EventBus,
		titleSystemPrompt?: string,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#changelogMarkdown = changelogMarkdown;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.#eventBus = eventBus;
		this.titleSystemPrompt = titleSystemPrompt;
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					if (this.settings.get("startup.quiet")) return;
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
			this.#eventBusUnsubscribers.push(
				eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
					if (!isMcpConnectionStatusEvent(data)) {
						logger.warn("Ignoring malformed MCP connection-status event", { data });
						return;
					}
					if (this.settings.get("startup.quiet")) return;
					this.#handleMcpConnectionStatusEvent(data);
				}),
			);
		}

		setTuiTight(settings.get("tui.tight"));
		this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
		// OSC 66 text-sizing is Kitty-only; resolve the setting against the terminal's
		// capability (`TERMINAL.textSizing` defaults on for Kitty) so it stays off
		// unless the user opts in, and never emits raw escapes on other terminals.
		setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.textSizing);
		this.chatContainer = new TranscriptContainer();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new StatusContainer();
		this.todoContainer = new Container();
		// The loader sits below the todo HUD, so the HUD must report its own
		// live-region seam — otherwise its rows commit to scrollback as stale
		// duplicates on short terminals. The whole block is live while populated.
		(this.todoContainer as Container & NativeScrollbackLiveRegion).getNativeScrollbackLiveRegionStart = () =>
			this.todoContainer.children.length > 0 ? 0 : undefined;
		this.subagentContainer = new Container();
		this.btwContainer = new Container();
		this.omfgContainer = new Container();
		this.errorBannerContainer = new Container();
		this.modelCycleContainer = new Container();
		this.editor = new CustomEditor(getEditorTheme());
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		this.#syncEditorMaxHeight();
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
			this.updateEditorTopBorder();
		};
		process.stdout.on("resize", this.#resizeHandler);
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
			this.historyStorage.setSessionResolver(() => this.sessionManager.getSessionId());
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.hookWidgetContainerAbove = new Container();
		this.hookWidgetContainerAbove.addChild(new Spacer(1));
		this.hookWidgetContainerBelow = new Container();
		this.editorContainer = new Container();
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.#composerModeBar = new ComposerModeBar({
			isEnabled: () => this.isIntentComposerEnabled() && !this.focusedAgentId,
			getSelectedMode: () => this.getComposerWorkMode(),
			isModeAvailable: mode => this.isComposerModeAvailable(mode),
			getCycleKeyHint: () => this.keybindings.getKeys("app.composer.mode.cycle")[0],
		});
		this.#composerDiagnostics = new ComposerDiagnosticsComponent({
			isEnabled: () => this.isIntentComposerEnabled(),
			getStatusLine: width => this.statusLine.getTopBorder(width),
		});
		this.#mountComposer(this.editor);

		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.proseOnlyThinking = settings.get("thinking.proseOnly");

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		// Build skill commands from session.skills (if enabled)
		const skillCommandList: SlashCommand[] = [];
		if (settings.get("skills.enableSkillCommands")) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({ name: commandName, description: skill.description });
			}
		}

		// Bind session-backed builtin status descriptions (e.g. `/fast` → "Fast: on")
		// so the autocomplete picker shows live state instead of the static copy.
		const builtinCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map(cmd => {
			const getTuiAutocompleteDescription = cmd.getTuiAutocompleteDescription;
			if (!getTuiAutocompleteDescription) return cmd;
			return { ...cmd, getAutocompleteDescription: () => getTuiAutocompleteDescription({ ctx: this }) };
		});

		// Store pending commands for init() where file commands are loaded async
		this.#pendingSlashCommands = [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#tanCommandController = new TanCommandController(this);
		this.#omfgController = new OmfgController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#todoCommandController = new TodoCommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#focusController = new SessionFocusController(this);
		this.#inputController = new InputController(this);
		this.#observerRegistry = new SessionObserverRegistry();
	}

	playWelcomeIntro(): void {
		const welcome = this.#welcomeComponent;
		// Component-scoped: the intro only mutates the welcome box's own rows,
		// so a resumed long transcript is not re-walked per animation frame.
		welcome?.playIntro(() => this.ui.requestComponentRender(welcome));
	}

	/**
	 * Fusion cost mode: spawn one persistent, IRC-addressable "Sidekick" subagent on
	 * the configured cheap model so the main agent can delegate mechanical work to a
	 * warm context via `irc send to:"Sidekick"`. Idempotent while a spawn succeeded
	 * (once per launch); a failed or empty spawn resets the guard so a later call
	 * (e.g. `/fusion on` mid-session) can retry. The sidekick's reused IRC-woken
	 * turns are bounded by `fusion.sidekickRequestBudget` (enforced in the agent
	 * loop, wired through executor.ts buildSubagentSessionOptions). Best-effort:
	 * failures only warn, and the delegation prompt keeps a fresh-`task` fallback
	 * so delegation still works if the sidekick is unavailable.
	 */
	async ensureFusionSidekick(): Promise<void> {
		await ensureFusionSidekick(this, {});
	}

	/**
	 * Reconcile a changed `fusion.sidekickModel` with the tracked sidekick:
	 * a live idle sidekick is retargeted in place (non-ephemeral, so it
	 * survives park/revive, preserving its warm context — the compaction-route
	 * re-tiering below uses the same mechanism but stays ephemeral); a
	 * parked or dead one is replaced by a fresh spawn on the new model; a
	 * mid-turn one is left alone so the switch never perturbs an in-flight
	 * run. Returns a user-facing note describing what actually happened.
	 */
	async reconcileFusionSidekickModel(): Promise<string> {
		const result = await reconcileFusionSidekickModel(this);
		return result.note;
	}

	async init(options: InteractiveModeInitOptions = {}): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings = logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());

		// Register session manager flush for signal handlers (SIGINT, SIGTERM, SIGHUP)
		this.#cleanupUnsubscribe = postmortem.register("session-manager-flush", () => this.sessionManager.flush());

		// Wire the report_tool_issue consent gate to the Yes/No dialog popup.
		// The handler is process-global — subagent tools (which can't reach
		// `showHookSelector` on their own) resolve through this exact closure.
		// `Settings.instance` is the disk-backed singleton; passing it explicitly
		// guarantees the decision persists even when the prompt is triggered
		// from a subagent whose own `Settings` is an in-memory snapshot.
		setAutoQaConsentHandler(() => this.#promptAutoQaConsent(), Settings.instance);

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
		);

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Get recent sessions
		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);

		const startupQuiet = settings.get("startup.quiet");
		this.#welcomeComponent = undefined;

		for (const warning of this.session.configWarnings) {
			this.ui.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
			this.ui.addChild(new Spacer(1));
		}

		if (!startupQuiet) {
			// Add welcome header
			this.#welcomeComponent = new WelcomeComponent(
				this.#version,
				modelName,
				providerName,
				recentSessions,
				this.#getWelcomeLspServers(),
			);

			// Setup UI layout
			this.ui.addChild(new Spacer(1));
			this.ui.addChild(this.#welcomeComponent);
			this.ui.addChild(new Spacer(1));
			if (!options.suppressWelcomeIntro) {
				this.playWelcomeIntro();
			}

			// Add changelog if provided
			if (this.#changelogMarkdown) {
				this.ui.addChild(new DynamicBorder());
				if (settings.get("collapseChangelog")) {
					const versionMatch = this.#changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
					const latestVersion = versionMatch ? versionMatch[1] : this.#version;
					const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
					this.ui.addChild(new Text(condensedText, 1, 0));
				} else {
					this.ui.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
					this.ui.addChild(new Spacer(1));
					this.ui.addChild(new Markdown(this.#changelogMarkdown.trim(), 1, 0, getMarkdownTheme()));
					this.ui.addChild(new Spacer(1));
				}
				this.ui.addChild(new DynamicBorder());
			}
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.todoContainer);
		this.ui.addChild(this.subagentContainer);
		this.ui.addChild(this.btwContainer);
		this.ui.addChild(this.omfgContainer);
		this.ui.addChild(this.errorBannerContainer);
		this.ui.addChild(this.modelCycleContainer);
		this.ui.addChild(this.statusLine); // Only renders hook statuses (main status in editor border)
		this.ui.addChild(this.hookWidgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.hookWidgetContainerBelow);
		this.ui.setFocus(this.editor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.#observerRegistry.onChange(() => {
			this.statusLine.setSubagentCount(this.#observerRegistry.getActiveSubagentCount());
			// Auto-checkmark todos whose matching subagent just succeeded, then
			// re-render so the running override (the static "live" glyph when a
			// subagent is doing the work for a still-pending todo) updates as
			// subagents start, finish, or fail.
			this.#reconcileTodosWithSubagents();
			this.#syncTodoAutoClearTimer();
			this.#renderTodoList();
			this.#renderSubagentList();
			this.ui.requestRender();
		});

		// Load initial todos
		await this.#loadTodoList();

		// Start the UI. Cold `omp` launch opts into clearing on the first paint so
		// the initial welcome frame does not append over the previous run's scrollback.
		this.ui.start({ clearScrollback: options.clearInitialTerminalHistory === true });
		pushTerminalTitle();
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.updateEditorBorderColor();
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		this.ui.requestRender(true);

		await this.initHooksAndCustomTools();

		// Fusion cost mode: bring up the persistent warm sidekick (best-effort, non-blocking).
		void ensureFusionSidekick(this, { force: false });

		// Restore mode from session (e.g. plan mode on resume), then reconcile the
		// per-session Fusion sidekick. `switchSession` clears the tracked id before
		// invoking this hook, so force-spawn gives the new session its own warm peer.
		this.session.setSessionSwitchReconciler?.({
			before: async () => {
				await this.restoreComposerAskTools();
			},
			after: async () => {
				await this.#reconcileModeFromSession({ preserveActiveGoal: true, restoreAskTools: false });
				await ensureFusionSidekick(this, { force: true });
			},
		});
		await this.#reconcileModeFromSession();

		// Brand-new sessions optionally start in plan mode when the user has made it
		// the startup default. "Brand-new" means the resolved branch carries no
		// conversation context (buildSessionContext().messages — covers messages,
		// custom messages, branch summaries, and compaction summaries) and the user
		// set no explicit `mode_change` (which #reconcileModeFromSession just
		// restored). SDK startup metadata and extension `custom` state entries are
		// ignored. This way `omp --continue` (or auto-resume) that finds no recent
		// session and creates a fresh one still honors the default, while a session
		// with restored context or an explicit mode keeps its reconciled mode. Scoped
		// to launch (not the switch reconciler above) so /new and the plan-approval →
		// execution handoff clear never get dragged back into plan mode. #enterPlanMode
		// is idempotent and self-guards against an already-active plan/goal mode; it
		// does not check plan.enabled itself.
		const hasConversationContext = this.sessionManager.buildSessionContext().messages.length > 0;
		const hasExplicitMode = this.sessionManager.getEntries().some(entry => entry.type === "mode_change");
		const isFreshSession = !hasConversationContext && !hasExplicitMode;
		if (
			isFreshSession &&
			this.session.settings.get("plan.defaultOnStartup") &&
			this.session.settings.get("plan.enabled")
		) {
			await this.#enterPlanMode();
		}

		// Restore unsent editor draft from previous session shutdown (Ctrl+D).
		// One-shot: consumeDraft removes the sidecar after read so the next
		// resume does not re-restore the same text.
		try {
			const draft = await this.sessionManager.consumeDraft();
			if (draft && !this.editor.getText()) {
				this.editor.setText(draft);
				this.updateEditorBorderColor();
				this.ui.requestRender();
			}
		} catch (err) {
			logger.warn("Failed to restore session draft", { error: String(err) });
		}

		// Subscribe to agent events
		this.#subscribeToAgent();

		this.#eventBusUnsubscribers.push(
			this.session.subscribe(event => {
				void this.#handleGoalSessionEvent(event);
			}),
			this.sessionManager.onSessionNameChanged(() => {
				this.#handleSessionAccentInputsChanged();
			}),
			onStatusLineSessionAccentChanged(() => {
				this.#syncStatusLineSettings();
				this.#handleSessionAccentInputsChanged();
			}),
		);
		// Set up theme file watcher
		this.#eventBusUnsubscribers.push(
			onThemeChange(() => {
				this.#clearWorkingMessageAccentCache();
				clearRenderCache();
				clearMermaidCache();
				this.ui.invalidate();
				this.updateEditorBorderColor();
				this.ui.requestRender();
			}),
		);

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		this.ui.terminal.onAppearanceChange(mode => {
			onTerminalAppearanceChange(mode);
		});

		// Set up git branch watcher
		this.statusLine.watchBranch(() => {
			this.#composerBranchCache = undefined;
			this.updateEditorTopBorder();
			this.ui.requestRender();
		});

		// Initial top border update
		this.updateEditorTopBorder();
	}

	/** Reload the title-generation system prompt override for the provided working directory. */
	async refreshTitleSystemPrompt(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const titleSystemPromptSource = discoverTitleSystemPromptFile(basePath);
		this.titleSystemPrompt = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const fileCommands = await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));
		// Surface discovered prompt templates in the picker. AgentSession.prompt() expands
		// `expandSlashCommand` before `expandPromptTemplate`, and builtin command
		// execution resolves aliases before template expansion. Mirror that command
		// resolution order by skipping templates whose names already appear in any
		// builtin/hook/custom/skill/file command token.
		const reservedNames = new Set<string>();
		for (const command of this.#pendingSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		for (const command of fileSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		const promptTemplateCommands: SlashCommand[] = this.session.promptTemplates
			.filter(template => !reservedNames.has(template.name))
			.map(template => ({
				name: template.name,
				// `PromptTemplate.description` from `loadTemplatesFromDir` already includes the
				// source suffix (e.g. "Review code (project)"), so pass it through verbatim.
				description: template.description,
			}));
		const autocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...promptTemplateCommands],
			basePath,
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
		this.session.setSlashCommands(fileCommands);
	}

	/**
	 * Re-point the process and every cwd-derived cache at `newCwd` after the
	 * active session's working directory changed (`/move` relocation or resuming
	 * a session from another project). The SessionManager's cwd MUST already
	 * reflect `newCwd` before this is called.
	 */
	async applyCwdChange(newCwd: string): Promise<void> {
		setProjectDir(newCwd);
		// Re-scope project settings (`.claude/settings.yml` etc.) to the new
		// directory in place so the active session and every settings reader pick
		// up the destination project's configuration.
		if (isSettingsInitialized()) {
			await settings.reloadForCwd(newCwd);
			// Reapply provider preferences from the newly-loaded settings so the
			// module-level search/image provider state reflects the destination
			// project's configuration. Without this, the previous project's
			// exclusions leak and newly-excluded providers are still used.
			const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
			if (Array.isArray(excludedWebSearchProviders)) {
				setExcludedSearchProviders(excludedWebSearchProviders.filter(isSearchProviderId));
			}
			const webSearchProvider = settings.get("providers.webSearch");
			if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
				setPreferredSearchProvider(webSearchProvider);
			}
			const imageProvider = settings.get("providers.image");
			if (isImageProviderPreference(imageProvider)) {
				setPreferredImageProvider(imageProvider);
			}
		}
		// Re-warm plugin roots, capabilities, slash commands, and the ssh tool so
		// the next prompt sees everything scoped to the new project directory.
		clearClaudePluginRootsCache();
		await this.refreshTitleSystemPrompt(newCwd);
		resetCapabilities();
		await this.refreshSlashCommandState(newCwd);
		await this.session.refreshSshTool({ activateIfAvailable: true });
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.statusLine.invalidate();
		this.updateEditorTopBorder();
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
		}
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		this.#scheduleLoopAutoSubmit();
		this.#scheduleGoalContinuation();

		using _ = new EventLoopKeepalive();
		return await promise;
	}

	#scheduleLoopAutoSubmit(): void {
		this.#cancelLoopAutoSubmit();
		if (!this.loopModeEnabled || !this.loopPrompt) return;
		const prompt = this.loopPrompt;
		const loopAction = this.loopActionOverride ?? settings.get("loop.mode");
		this.#deferLoopAutoSubmit(() => {
			void this.#runLoopIteration(loopAction, prompt);
		});
	}

	#deferLoopAutoSubmit(callback: () => void): void {
		// Brief delay so the user has a chance to press Esc between iterations.
		this.#loopAutoSubmitTimer = setTimeout(() => {
			this.#loopAutoSubmitTimer = undefined;
			if (!this.loopModeEnabled || !this.onInputCallback) return;
			callback();
		}, 800);
	}

	#cancelLoopAutoSubmit(): void {
		if (this.#loopAutoSubmitTimer) {
			clearTimeout(this.#loopAutoSubmitTimer);
			this.#loopAutoSubmitTimer = undefined;
		}
	}

	#scheduleGoalContinuation(): void {
		this.#cancelGoalContinuation();
		if (this.loopModeEnabled) return;
		if (!this.onInputCallback) return;
		if (!this.session.settings.get("goal.continuationModes").includes("interactive")) return;
		if (this.planModeEnabled || this.planModePaused) return;
		if (!this.goalModeEnabled || this.goalModePaused) return;
		if (this.#goalSuppressNextContinuation) return;
		if (this.#pendingSubmittedInput) return;
		if (this.editor.getText().trim().length > 0) return;
		if ((this.editor.pendingImages?.length ?? 0) > 0) return;
		const state = this.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			if (!this.onInputCallback) return;
			if (!this.goalModeEnabled || this.goalModePaused) return;
			// The 800ms timer can outlive the idle window that scheduled it: a
			// `/goal set` taken via the streaming branch (or any extension/hook
			// path that starts a turn while we wait) leaves the agent busy. Firing
			// the continuation now would route through `submitInteractiveInput` →
			// `promptCustomMessage` with no `streamingBehavior` and resurface
			// `AgentBusyError`. Drop this tick; `#handleGoalSessionEvent` reschedules
			// on the next `agent_end`.
			if (this.#isAutoSubmitBlocked()) return;
			if (this.#pendingSubmittedInput) return;
			if (this.editor.getText().trim().length > 0) return;
			if ((this.editor.pendingImages?.length ?? 0) > 0) return;
			const latestState = this.session.getGoalModeState();
			if (!latestState?.enabled || latestState.goal.status !== "active") return;
			this.#goalContinuationTurnInFlight = true;
			this.onInputCallback(
				this.startPendingSubmission({
					text: prompt,
					customType: "goal-continuation",
					display: false,
				}),
			);
		}, 800);
	}

	#cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
		}
	}

	#isAutoSubmitBlocked(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork;
	}

	#submitLoopPromptWhenReady(prompt: string, submitText: string = prompt): void {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (isLoopDurationExpired(this.loopLimit)) {
			this.disableLoopMode("Loop time limit reached. Loop mode disabled.");
			return;
		}
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => this.#submitLoopPromptWhenReady(prompt, submitText));
			return;
		}
		this.onInputCallback(this.startPendingSubmission({ text: submitText }));
	}

	async #runLoopIteration(action: LoopAction, prompt: string): Promise<void> {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		if (!consumeLoopLimitIteration(this.loopLimit)) {
			this.disableLoopMode("Loop limit reached. Loop mode disabled.");
			return;
		}

		if (action === "compact") {
			await this.handleCompactCommand();
		} else if (action === "reset") {
			await this.handleClearCommand();
		} else if (action === "spiral") {
			await this.#runLoopSpiralIteration(prompt);
			return;
		}
		this.#submitLoopPromptWhenReady(prompt);
	}

	/**
	 * Spiral iteration: grade the latest turn against the immutable objective, then
	 * re-submit the objective with the synthesized reflection appended. Stops the
	 * loop when the objective is complete or when progress stalls. A synthesis
	 * failure degrades to a plain re-submit so the loop never silently dies.
	 */
	async #runLoopSpiralIteration(prompt: string): Promise<void> {
		let result: loopSynthesis.LoopSynthesisResult;
		try {
			result = await loopSynthesis.runLoopSynthesis(this.session, { objective: prompt });
		} catch (err) {
			logger.warn("Loop synthesis failed; re-submitting objective without reflection", {
				error: err instanceof Error ? err.message : String(err),
			});
			this.#submitLoopPromptWhenReady(prompt);
			return;
		}
		// The async synthesis call may have outlived the loop: the user could have
		// typed a new prompt, paused, or disabled the loop. Re-check before acting.
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;

		if (result.complete) {
			this.disableLoopMode("Loop objective complete. Loop mode disabled.");
			return;
		}

		// No-progress detection: when the reflection repeats unchanged across
		// consecutive iterations the loop is stuck — stop instead of burning turns.
		const normalized = result.reflection.trim();
		if (normalized && normalized === this.#loopSpiralLastReflection) {
			this.#loopSpiralStallCount += 1;
		} else {
			this.#loopSpiralStallCount = 0;
		}
		this.#loopSpiralLastReflection = normalized || undefined;
		if (this.#loopSpiralStallCount >= 2) {
			this.disableLoopMode("Loop made no progress across iterations. Loop mode disabled.");
			return;
		}

		this.#submitLoopPromptWhenReady(prompt, loopSynthesis.composeSpiralPrompt(prompt, result.reflection));
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.loopModeEnabled;
		this.loopModeEnabled = false;
		this.loopPrompt = undefined;
		this.loopLimit = undefined;
		this.loopActionOverride = undefined;
		this.#resetLoopSpiralState();
		this.#cancelLoopAutoSubmit();
		this.statusLine.setLoopModeStatus(undefined);
		this.updateEditorTopBorder();
		this.ui.requestRender();
		if (wasEnabled) {
			this.showStatus(message);
		}
	}

	/**
	 * Pause the loop without exiting it: drops the captured prompt and any
	 * pending auto-resubmit. Loop mode stays enabled — the next prompt the
	 * user submits becomes the new loop prompt and resumes iteration.
	 */
	pauseLoop(): void {
		this.loopPrompt = undefined;
		this.#resetLoopSpiralState();
		this.#cancelLoopAutoSubmit();
	}

	#resetLoopSpiralState(): void {
		this.#loopSpiralLastReflection = undefined;
		this.#loopSpiralStallCount = 0;
	}

	async handleLoopCommand(args = ""): Promise<string | undefined> {
		if (this.loopModeEnabled) {
			this.disableLoopMode();
			return undefined;
		}
		const parsed = parseLoopLimitArgs(args);
		if (typeof parsed === "string") {
			this.showError(parsed);
			return undefined;
		}
		this.loopModeEnabled = true;
		this.loopPrompt = undefined;
		this.loopLimit = createLoopLimitRuntime(parsed.limit);
		this.loopActionOverride = parsed.mode;
		this.statusLine.setLoopModeStatus({ enabled: true });
		this.updateEditorTopBorder();
		this.ui.requestRender();
		const mode = this.loopActionOverride ?? settings.get("loop.mode");
		const modeSuffix = parsed.mode ? ` Mode: ${describeLoopAction(mode)}.` : "";
		const limitSuffix = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const remainingSuffix = this.loopLimit ? ` ${describeLoopLimitRuntime(this.loopLimit)}.` : "";
		const tail = parsed.prompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		this.showStatus(
			`Loop mode enabled.${modeSuffix}${limitSuffix}${remainingSuffix} ${tail} Esc cancels the current iteration; /loop again to disable.`,
		);
		// Hand any inline prompt back to the dispatcher so the normal submit flow
		// runs the first iteration — it records the text as the loop prompt and
		// auto-resubmits it after each yield, identical to typing the prompt right
		// after enabling loop mode.
		return parsed.prompt;
	}

	recordLocalSubmission(text: string, imageCount = 0): () => void {
		if (this.isKnownSlashCommand(text)) {
			return () => {};
		}
		const signature = `${text}\u0000${imageCount}`;
		this.locallySubmittedUserSignatures.add(signature);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			this.locallySubmittedUserSignatures.delete(signature);
		};
	}

	async withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T> {
		const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
		try {
			return await fn();
		} catch (err) {
			dispose();
			throw err;
		}
	}

	startPendingSubmission(input: {
		text: string;
		images?: ImageContent[];
		imageLinks?: (string | undefined)[];
		customType?: string;
		display?: boolean;
		streamingBehavior?: "steer" | "followUp";
	}): SubmittedUserInput {
		const submission: SubmittedUserInput = {
			text: input.text,
			images: input.images,
			imageLinks: input.imageLinks,
			customType: input.customType,
			display: input.display,
			streamingBehavior: input.streamingBehavior,
			cancelled: false,
			started: false,
		};
		this.#pendingSubmittedInput = submission;
		if (!submission.customType) {
			this.#resetGoalContinuationSuppression();
			const imageCount = submission.images?.length ?? 0;
			this.optimisticUserMessageSignature = `${submission.text}\u0000${imageCount}`;
			this.#pendingSubmissionDispose = this.recordLocalSubmission(submission.text, imageCount);
			this.#optimisticUserComponents = this.addMessageToChat(
				{
					role: "user",
					content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
					attribution: "user",
					timestamp: Date.now(),
				},
				{ imageLinks: input.imageLinks },
			);
		} else {
			this.optimisticUserMessageSignature = undefined;
			this.#pendingSubmissionDispose = undefined;
		}
		this.editor.setText("");
		this.editor.imageLinks = undefined;
		this.ensureLoadingAnimation();
		this.ui.requestRender();
		return submission;
	}

	cancelPendingSubmission(): boolean {
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.started) {
			return false;
		}

		submission.cancelled = true;
		this.#pendingSubmittedInput = undefined;
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		this.#pendingWorkingMessage = undefined;
		if (submission.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		if (!submission.customType) {
			this.editor.pendingImages = submission.images ? [...submission.images] : [];
			this.editor.pendingImageLinks = submission.imageLinks ? [...submission.imageLinks] : [];
			this.editor.imageLinks = this.editor.pendingImageLinks;
			this.rebuildChatFromMessages();
			this.editor.setText(submission.text);
		}
		this.updateEditorBorderColor();
		this.ui.requestRender();
		return true;
	}

	markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
		if (this.#pendingSubmittedInput !== input || input.cancelled) {
			return false;
		}
		input.started = true;
		return true;
	}

	finishPendingSubmission(input: SubmittedUserInput): void {
		const wasPendingSubmission = this.#pendingSubmittedInput === input;
		const pendingSubmissionDispose = this.#pendingSubmissionDispose;
		if (wasPendingSubmission) {
			this.#pendingSubmittedInput = undefined;
			this.#pendingSubmissionDispose = undefined;
		}
		if (input.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}

		if (wasPendingSubmission && !this.session.isStreaming && !this.streamingComponent) {
			this.optimisticUserMessageSignature = undefined;
			pendingSubmissionDispose?.();
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.#stopLoadingAnimation(true);
			}
		}
	}

	#getComposerChromeRows(): ComposerChromeRows | undefined {
		if (!this.isIntentComposerEnabled() || !this.#composerModeBar || !this.#composerDiagnostics) return undefined;
		const width = this.editor.getTopBorderAvailableWidth(this.ui.terminal.columns);
		return {
			modeBar: this.#composerModeBar.rowCount(width),
			diagnostics: this.#composerDiagnostics.rowCount(width),
		};
	}

	#computeEditorMaxHeight(): number {
		return computeEditorMaxHeight(this.ui.terminal.rows, this.#getComposerChromeRows());
	}

	#syncEditorMaxHeight(): void {
		this.editor.setMaxHeight(this.#computeEditorMaxHeight());
	}

	#syncStatusLineSettings(): void {
		this.statusLine.updateSettings({
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
			segmentOptions: settings.get("statusLine.segmentOptions"),
		});
	}

	#handleSessionAccentInputsChanged(): void {
		this.#clearWorkingMessageAccentCache();
		this.statusLine.invalidate();
		this.updateEditorBorderColor();
	}

	updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else if (this.isPythonMode) {
			this.editor.borderColor = theme.getPythonModeBorderColor();
		} else {
			const accentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
			const sessionName = accentEnabled ? this.sessionManager.getSessionName() : undefined;
			const hex = sessionName
				? getSessionAccentHex(sessionName, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance)
				: undefined;
			const ansi = getSessionAccentAnsi(hex);
			if (ansi) {
				this.editor.borderColor = (str: string) => `${ansi}${str}\x1b[39m`;
			} else {
				const level = this.session.thinkingLevel ?? ThinkingLevel.Off;
				this.editor.borderColor = theme.getThinkingBorderColor(level);
			}
		}
		if (this.focusedAgentId) {
			// Focused subagent view: faint the outline so the borrowed session is
			// visually distinct from the main one.
			const base = this.editor.borderColor;
			this.editor.borderColor = (str: string) => `\x1b[2m${base(str)}\x1b[22m`;
		}
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	updateEditorTopBorder(): void {
		this.#syncEditorMaxHeight();
		if (this.isIntentComposerEnabled()) {
			// Intent layout: runtime metadata lives in the diagnostics line below
			// the composer; the editable frame keeps a plain border.
			this.editor.setTopBorder(undefined);
			return;
		}
		const availableWidth = this.editor.getTopBorderAvailableWidth(this.ui.terminal.columns);
		const topBorder = this.statusLine.getTopBorder(availableWidth);
		this.editor.setTopBorder(topBorder);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Composer (intent-first layout): work modes, context chips, execution rail
	// ═══════════════════════════════════════════════════════════════════════

	isIntentComposerEnabled(): boolean {
		return this.settings.get("composer.layout") === "intent";
	}

	/** Selected work mode, derived from authoritative session state (never stored separately). */
	getComposerWorkMode(): ComposerWorkMode {
		if (this.planModeEnabled) return "plan";
		if (this.askModeEnabled) return "ask";
		return "build";
	}

	isComposerModeAvailable(mode: ComposerWorkMode): boolean {
		if (this.focusedAgentId) return false;
		if (mode === "plan") return !isSettingsInitialized() || this.session.settings.get("plan.enabled") === true;
		return true;
	}

	async cycleComposerWorkMode(): Promise<void> {
		if (this.focusedAgentId) return;
		await this.setComposerWorkMode(
			nextComposerWorkMode(this.getComposerWorkMode(), this.isComposerModeAvailable("plan")),
		);
	}

	/**
	 * Switch the composer work mode. Every branch maps to existing runtime
	 * enforcement: Ask restricts the session's active toolset to the explicit
	 * observational allowlist (the same setActiveToolsByName primitive plan/goal
	 * modes use), Build restores the saved toolset, Plan routes through the
	 * plan-mode toggle so draft confirmation and session mode entries stay
	 * authoritative. Mode switches never widen permissions: Build/Plan keep the
	 * per-call approval gates (`tools.approvalMode`) untouched.
	 */
	async setComposerWorkMode(target: ComposerWorkMode): Promise<void> {
		const transition = this.#composerTransition.then(() => this.#setComposerWorkMode(target));
		this.#composerTransition = transition.catch(() => {});
		return transition;
	}

	waitForComposerTransition(): Promise<void> {
		return this.#composerTransition;
	}

	async #setComposerWorkMode(target: ComposerWorkMode): Promise<void> {
		if (this.focusedAgentId) return;
		const current = this.getComposerWorkMode();
		if (target === current) return;
		if (!this.isComposerModeAvailable(target)) {
			this.showWarning("Plan mode is disabled in settings.");
			return;
		}
		if (this.session.isStreaming && !(current === "ask" && target === "build")) {
			this.showStatus("Finish the current turn (esc to stop) before switching work modes.");
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Goal mode manages its own toolset — exit goal mode first.");
			return;
		}

		if (current === "ask") await this.#exitAskMode();
		if (current === "plan") {
			await this.handlePlanModeCommand();
			if (this.planModeEnabled) return; // user cancelled the exit confirmation
		}
		if (target === "ask") {
			await this.#enterAskMode();
		} else if (target === "plan") {
			if (this.planModePaused) await this.handlePlanModeCommand(); // paused → off
			if (!this.planModeEnabled) await this.handlePlanModeCommand(); // off → on
		}
		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	async restoreComposerAskTools(): Promise<void> {
		const transition = this.#composerTransition.then(() => this.#restoreComposerAskTools());
		this.#composerTransition = transition.catch(() => {});
		return transition;
	}

	async #restoreComposerAskTools(): Promise<void> {
		if (!this.askModeEnabled) return;
		await this.#exitAskMode();
		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	async disableComposerPlanMode(): Promise<void> {
		const transition = this.#composerTransition.then(async () => {
			if (this.planModeEnabled) await this.#exitPlanMode({ silent: true, paused: false });
			if (this.planModePaused) {
				this.planModePaused = false;
				this.#planModeHasEntered = false;
				this.#updatePlanModeStatus();
				this.sessionManager.appendModeChange("none");
			}
			this.updateEditorTopBorder();
			this.#syncEditorMaxHeight();
			this.ui.requestRender();
		});
		this.#composerTransition = transition.catch(() => {});
		return transition;
	}

	async #enterAskMode(): Promise<void> {
		if (this.askModeEnabled) return;
		const previousTools = this.session.getActiveToolNames();
		const askTools = computeAskModeTools(previousTools);
		this.#askModePreviousTools = previousTools;
		try {
			await this.session.setActiveToolCeiling(askTools, previousTools);
			this.askModeEnabled = true;
			this.showStatus("Ask mode: observational tools only (no edits, shell, or delegation).");
		} catch (error) {
			this.#askModePreviousTools = undefined;
			throw error;
		}
	}

	async #exitAskMode(): Promise<void> {
		if (!this.askModeEnabled) return;
		const previousTools = this.#askModePreviousTools;
		if (previousTools !== undefined) await this.session.setActiveToolCeiling(undefined, previousTools);
		this.#askModePreviousTools = undefined;
		this.askModeEnabled = false;
	}

	/** Mount mode bar + editor + diagnostics into the editor container (constructor and editor swaps). */
	#mountComposer(editor: CustomEditor): void {
		if (this.isIntentComposerEnabled()) {
			editor.placeholder = "Describe the outcome you want…";
		}
		editor.setBottomSection(() => this.#buildComposerBottomSection());
		this.editorContainer.addChild(this.#composerModeBar);
		this.editorContainer.addChild(editor);
		this.editorContainer.addChild(this.#composerDiagnostics);
	}

	/** Restore the editor slot with the complete composer chrome. */
	remountEditorComposer(): void {
		this.editorContainer.clear();
		this.#mountComposer(this.editor);
	}

	/** Live provider for the in-frame chips row + execution rail; reads session state at render time. */
	#buildComposerBottomSection(): EditorBottomSection | undefined {
		if (!this.isIntentComposerEnabled()) return undefined;
		const width = this.editor.getTopBorderAvailableWidth(this.ui.terminal.columns);
		if (width <= 0) return undefined;
		const chipsRow = buildChipsRow(this.#collectComposerChips(), width);
		const focused = this.focusedAgentId !== undefined;
		const def = getComposerWorkModeDef(this.getComposerWorkMode());
		const hasInput = this.editor.getText().trim().length > 0 || this.editor.pendingImages.length > 0;
		const viewSession = this.viewSession;
		const streaming = this.collabGuest?.state?.isStreaming === true || viewSession.isStreaming;
		const railRow = buildRailRow(
			{
				modeLabel: focused ? "Focused" : def.label,
				cta: focused ? "Send" : def.cta,
				streaming,
				hasInput,
				queuedCount: viewSession.queuedMessageCount,
				stopKeyHint: focused || this.collabGuest ? undefined : this.keybindings.getKeys("app.interrupt")[0],
			},
			width,
		);
		return { bodyRows: chipsRow ? [chipsRow] : [], footerRows: [railRow] };
	}

	#collectComposerChips(): ComposerChip[] {
		const chips: ComposerChip[] = [];
		if (!this.focusedAgentId) {
			// `git.enabled` is the master kill-switch for git probes; without it
			// the chip degrades to the bare project-directory name.
			const gitEnabled = this.session.settings.get("git.enabled");
			const branch = gitEnabled ? this.#currentGitBranch() : null;
			const repoDir = gitEnabled ? (this.#composerBranchCache?.dir ?? getProjectDir()) : getProjectDir();
			const repo = sanitizeStatusText(path.basename(repoDir));
			chips.push({ label: branch ? `${repo}/${sanitizeStatusText(branch)}` : repo, kind: "auto" });
			if (this.planModeEnabled && this.planModePlanFilePath) {
				chips.push({
					label: `plan: ${sanitizeStatusText(path.basename(this.planModePlanFilePath))}`,
					kind: "auto",
				});
			}
		}
		const imageCount = this.editor.pendingImages.length;
		if (imageCount > 0)
			chips.push({ label: imageCount === 1 ? "1 image" : `${imageCount} images`, kind: "attached" });
		return chips;
	}

	/** Best-effort branch name for the repo/branch chip; cached for 5s to keep render cheap. */
	#currentGitBranch(): string | null {
		const projectDir = getProjectDir();
		const activeRepo = resolveActiveRepoContextSync(projectDir);
		const repository = git.repo.resolveSync(activeRepo?.repoRoot ?? projectDir);
		const cacheDir = repository?.repoRoot ?? activeRepo?.repoRoot ?? projectDir;
		const now = Date.now();
		if (
			this.#composerBranchCache &&
			this.#composerBranchCache.dir === cacheDir &&
			now - this.#composerBranchCache.readAt < 5_000
		) {
			return this.#composerBranchCache.value;
		}
		let value: string | null = null;
		try {
			const content = repository ? fsSync.readFileSync(repository.headPath, "utf8") : "";
			const match = content.match(/^ref: refs\/heads\/(.+)$/m);
			value = match?.[1]?.trim() ?? null;
		} catch {
			value = null;
		}
		this.#composerBranchCache = { dir: cacheDir, value, readAt: now };
		return value;
	}

	rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		// Full-history transcript: compactions render as inline dividers instead
		// of restarting the visible conversation (the LLM context still resets).
		const context = this.viewSession.buildTranscriptSessionContext();
		this.renderSessionContext(context);
		// During the pre-streaming window — after `startPendingSubmission` has
		// optimistically rendered the user's message but before the user
		// `message_start` event lands it in `session` entries — any rebuild
		// (e.g. Ctrl+T toggleThinkingBlockVisibility, theme selector) would
		// otherwise erase the user's just-submitted message until the first
		// assistant token arrived (#2372). Once `message_start` fires the
		// signature is cleared by `EventController`, so this replay is a no-op
		// post-streaming and cannot duplicate.
		this.#replayOptimisticUserMessage();
	}

	#replayOptimisticUserMessage(): void {
		if (!this.optimisticUserMessageSignature) return;
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.cancelled || submission.customType) return;
		this.#optimisticUserComponents = this.addMessageToChat(
			{
				role: "user",
				content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
				attribution: "user",
				timestamp: Date.now(),
			},
			{ imageLinks: submission.imageLinks },
		);
	}

	/** Thinking-block visibility actually applied when rendering assistant messages. */
	get effectiveHideThinkingBlock(): boolean {
		return this.hideThinkingBlock;
	}

	clearOptimisticUserMessage(): void {
		this.optimisticUserMessageSignature = undefined;
		this.#optimisticUserComponents = undefined;
	}

	replaceOptimisticUserMessage(message: AgentMessage): void {
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		if (this.#optimisticUserComponents) {
			for (const component of this.#optimisticUserComponents) {
				this.chatContainer.removeChild(component);
			}
			this.#optimisticUserComponents = undefined;
		}
		this.addMessageToChat(message);
	}

	#formatTodoLine(todo: TodoItem, prefix: string, matched: boolean): string {
		const checkbox = theme.checkbox;
		const marker = formatHudNoteMarker(todo.notes?.length ?? 0);
		switch (todo.status) {
			case "completed":
				return theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(todo.content)}`) + marker;
			case "in_progress":
				return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
			case "abandoned":
				return theme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(todo.content)}`) + marker;
			default:
				if (matched) {
					return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
				}
				return theme.fg("dim", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
		}
	}

	#getActiveSubagentDescriptions(): string[] {
		const out: string[] = [];
		for (const session of this.#observerRegistry.getSessions()) {
			if (session.kind !== "subagent") continue;
			if (session.status !== "active") continue;
			const candidate =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (candidate) out.push(candidate);
		}
		return out;
	}

	/**
	 * Auto-complete any pending/in_progress todo whose content matches a
	 * subagent that has finished successfully. Fires on every observer
	 * `onChange` so the visual state stays in sync with subagent lifecycle
	 * without requiring the agent to issue a follow-up `todo`. Failed
	 * and aborted subagents are intentionally NOT auto-completed — those
	 * stay open so the user (or the next agent turn) can decide what to do.
	 *
	 * Idempotent: only flips open tasks, never re-touches completed ones.
	 */
	#reconcileTodosWithSubagents(): void {
		const completedDescs: string[] = [];
		for (const session of this.#observerRegistry.getSessions()) {
			if (session.kind !== "subagent") continue;
			if (session.status !== "completed") continue;
			const candidate =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (candidate) completedDescs.push(candidate);
		}
		if (completedDescs.length === 0) return;

		let mutated = false;
		const next: TodoPhase[] = this.todoPhases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => {
				if (task.status !== "pending" && task.status !== "in_progress") return task;
				if (!todoMatchesAnyDescription(task.content, completedDescs)) return task;
				mutated = true;
				return { ...task, status: "completed" as const };
			}),
		}));
		if (!mutated) return;
		this.todoPhases = next;
		this.session.setTodoPhases(next);
	}

	#cancelTodoAutoClearTimer(): void {
		if (!this.#todoAutoClearTimer) return;
		clearTimeout(this.#todoAutoClearTimer);
		this.#todoAutoClearTimer = undefined;
	}

	#isClosedTodo(task: TodoItem): boolean {
		return task.status === "completed" || task.status === "abandoned";
	}

	#hasClosedTodos(phases: TodoPhase[]): boolean {
		return phases.some(phase => phase.tasks.some(task => this.#isClosedTodo(task)));
	}

	#removeClosedTodos(phases: TodoPhase[]): TodoPhase[] {
		const next: TodoPhase[] = [];
		for (const phase of phases) {
			const tasks = phase.tasks.filter(task => !this.#isClosedTodo(task));
			if (tasks.length > 0) next.push({ name: phase.name, tasks });
		}
		return next;
	}

	#syncTodoAutoClearTimer(): void {
		this.#cancelTodoAutoClearTimer();
		const delaySeconds = this.settings.get("tasks.todoClearDelay");
		if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || !this.#hasClosedTodos(this.todoPhases)) return;
		if (delaySeconds === 0) {
			this.todoPhases = this.#removeClosedTodos(this.todoPhases);
			return;
		}

		this.#todoAutoClearTimer = setTimeout(() => {
			this.#todoAutoClearTimer = undefined;
			this.todoPhases = this.#removeClosedTodos(this.todoPhases);
			this.#renderTodoList();
			this.ui.requestRender();
		}, delaySeconds * 1000);
		this.#todoAutoClearTimer.unref?.();
	}

	/**
	 * Render the ctrl+p model-role cycle chip track into its own anchored
	 * container (just above the editor), mirroring the todo HUD: the container is
	 * cleared and rebuilt in place on every cycle, so rapid presses or concurrent
	 * chat activity can never stack duplicate tracks into the scrollback.
	 */
	showModelCycleTrack(track: string): void {
		this.#renderModelCycleTrack(track);
		this.#syncModelCycleClearTimer();
		this.ui.requestRender();
	}

	#renderModelCycleTrack(track: string | null): void {
		this.modelCycleContainer.clear();
		if (!track) return;
		this.modelCycleContainer.addChild(new Spacer(1));
		this.modelCycleContainer.addChild(new Text(track, 1, 0));
	}

	#cancelModelCycleClearTimer(): void {
		if (!this.#modelCycleClearTimer) return;
		clearTimeout(this.#modelCycleClearTimer);
		this.#modelCycleClearTimer = undefined;
	}

	#syncModelCycleClearTimer(): void {
		this.#cancelModelCycleClearTimer();
		this.#modelCycleClearTimer = setTimeout(() => {
			this.#modelCycleClearTimer = undefined;
			this.#renderModelCycleTrack(null);
			this.ui.requestRender();
		}, MODEL_CYCLE_TRACK_CLEAR_MS);
		this.#modelCycleClearTimer.unref?.();
	}

	#getActivePhase(phases: TodoPhase[]): TodoPhase | undefined {
		const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
		const active = nonEmpty.find(phase =>
			phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
		);
		return active ?? nonEmpty[nonEmpty.length - 1];
	}

	/** Stages rendered below the root header: the active stage plus up to four following ones. */
	static readonly #TODO_HUD_MAX_STAGES = 5;

	/** Stage header: roman-numbered name (multi-stage only) plus completed/total task progress. */
	#formatTodoStageHeader(phase: TodoPhase, oneBasedIndex: number, multiStage: boolean, active: boolean): string {
		const name = multiStage ? formatPhaseDisplayName(phase.name, oneBasedIndex) : phase.name;
		const done = phase.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
		const header = `${name}  ${done}/${phase.tasks.length}`;
		return active ? theme.fg("accent", header) : theme.fg("dim", header);
	}

	#renderTodoList(): void {
		this.todoContainer.clear();
		const phases = this.todoPhases.filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return;
		const indent = "  ";
		const multiStage = phases.length > 1;
		const activeIdx = Math.max(0, phases.indexOf(this.#getActivePhase(phases) ?? phases[0]));
		// Root header carries the overall stage progression; a lone stage's
		// redundant "1/1" is omitted.
		const progression = multiStage ? theme.fg("dim", `  ${activeIdx + 1}/${phases.length}`) : "";
		const lines = ["", indent + theme.bold(theme.fg("accent", "Todos")) + progression];

		const activeDescs = this.#getActiveSubagentDescriptions();
		// A pending todo "lights up" (accent + running glyph) when an in-flight
		// subagent is doing its work, matched by normalized content overlap.
		const isMatched = (todo: TodoItem): boolean =>
			activeDescs.length > 0 && todoMatchesAnyDescription(todo.content, activeDescs);

		const pushTaskRows = (tasks: TodoItem[]): void => {
			tasks.forEach((todo, index) => {
				const connector = index === tasks.length - 1 ? theme.tree.last : theme.tree.branch;
				lines.push(this.#formatTodoLine(todo, `${indent}${connector} `, isMatched(todo)));
			});
		};

		if (!this.todoExpanded) {
			// Active stage expands (open-task sticky window, completed rows slide
			// out); the following stages collapse to header + progress, capped so
			// the HUD stays shallow. No overflow rows — the header counts imply
			// what is hidden.
			const visiblePhases = phases.slice(activeIdx, activeIdx + InteractiveMode.#TODO_HUD_MAX_STAGES);
			visiblePhases.forEach((phase, offset) => {
				const phaseIndex = activeIdx + offset;
				lines.push(`${indent}${this.#formatTodoStageHeader(phase, phaseIndex + 1, multiStage, offset === 0)}`);
				if (offset === 0) {
					const { visible } = selectStickyTodoWindow(phase.tasks, 5);
					pushTaskRows(visible);
				}
			});
			this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
			return;
		}

		phases.forEach((phase, phaseIndex) => {
			lines.push(
				`${indent}${this.#formatTodoStageHeader(phase, phaseIndex + 1, multiStage, phaseIndex === activeIdx)}`,
			);
			pushTaskRows(phase.tasks);
		});

		this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	/**
	 * Anchored HUD of in-flight subagents, mirroring the Todos block above the
	 * editor. Driven entirely by observer-registry change events, so rows appear
	 * on spawn and the whole block clears itself once the last subagent leaves
	 * the "active" state.
	 */
	#renderSubagentList(): void {
		this.subagentContainer.clear();
		const lines = renderSubagentHudLines(this.#observerRegistry.getSessions(), this.ui.terminal.columns);
		if (lines.length === 0) return;
		this.subagentContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	async #loadTodoList(): Promise<void> {
		this.todoPhases = this.session.getTodoPhases();
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
	}

	async #getPlanFilePath(): Promise<string> {
		return this.session.getPlanReferencePath() || "local://PLAN.md";
	}

	#resolvePlanFilePath(planFilePath: string): string {
		if (planFilePath.startsWith("local:")) {
			const normalized = normalizeLocalScheme(planFilePath);
			return resolveLocalUrlToPath(normalized, {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			});
		}
		return path.resolve(this.sessionManager.getCwd(), planFilePath);
	}

	#updatePlanModeStatus(): void {
		const status =
			this.planModeEnabled || this.planModePaused
				? {
						enabled: this.planModeEnabled,
						paused: this.planModePaused,
					}
				: undefined;
		this.statusLine.setPlanModeStatus(status);
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	#updateGoalModeStatus(): void {
		const status =
			this.goalModeEnabled || this.goalModePaused
				? { enabled: this.goalModeEnabled, paused: this.goalModePaused }
				: undefined;
		this.statusLine.setGoalModeStatus(status);
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	#resetGoalContinuationSuppression(): void {
		this.#goalSuppressNextContinuation = false;
	}

	#getPausedGoalState(): GoalModeState | undefined {
		const state = this.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	#goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
		const goal = modeData?.goal;
		if (!goal || typeof goal !== "object") return undefined;
		const value = goal as Record<string, unknown>;
		if (
			typeof value.id !== "string" ||
			typeof value.objective !== "string" ||
			typeof value.status !== "string" ||
			typeof value.tokensUsed !== "number" ||
			typeof value.timeUsedSeconds !== "number" ||
			typeof value.createdAt !== "number" ||
			typeof value.updatedAt !== "number"
		) {
			return undefined;
		}
		return {
			id: value.id,
			objective: value.objective,
			status: value.status as Goal["status"],
			tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
			tokensUsed: value.tokensUsed,
			timeUsedSeconds: value.timeUsedSeconds,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	}

	async #handleGoalSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.#goalTurnHadToolCalls = false;
			this.#cancelGoalContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#goalTurnHadToolCalls = true;
			if (!this.#goalContinuationTurnInFlight) {
				this.#resetGoalContinuationSuppression();
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.#resetGoalContinuationSuppression();
			return;
		}
		if (event.type === "goal_updated") {
			// Handle drop before clearing goalModeEnabled so #exitGoalMode can
			// still restore the previous tool set while the flag is true.
			if (event.state?.goal?.status === "dropped") {
				await this.#exitGoalMode({ reason: "dropped", silent: true });
				return;
			}
			this.goalModeEnabled = event.state?.enabled === true;
			this.goalModePaused = event.state?.enabled !== true && event.state?.goal?.status === "paused";
			if (!event.state?.enabled) {
				this.#cancelGoalContinuation();
			}
			this.#updateGoalModeStatus();
			return;
		}
		if (event.type !== "agent_end") {
			return;
		}
		if (this.#goalContinuationTurnInFlight) {
			this.#goalSuppressNextContinuation = !this.#goalTurnHadToolCalls;
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
			return;
		}
		this.#scheduleGoalContinuation();
	}

	async #applyPlanModeModel(): Promise<void> {
		const resolved = this.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;

		const currentModel = this.session.model;
		const sameModel = modelsAreEqual(currentModel, resolved.model);
		const planThinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;

		this.#planModePreviousModelState = currentModel
			? { model: currentModel, thinkingLevel: this.session.thinkingLevel }
			: undefined;

		if (!sameModel) {
			if (this.session.isStreaming) {
				this.#pendingModelSwitch = { model: resolved.model, thinkingLevel: planThinkingLevel };
				return;
			}
			try {
				await this.session.setModelTemporary(resolved.model, planThinkingLevel);
			} catch (error) {
				this.showWarning(
					`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else if (planThinkingLevel) {
			this.session.setThinkingLevel(planThinkingLevel);
		}
	}

	/** Apply any deferred model switch after the current stream ends. */
	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		if (!pending) return;
		this.#pendingModelSwitch = undefined;
		try {
			await this.session.setModelTemporary(pending.model, pending.thinkingLevel);
		} catch (error) {
			this.showWarning(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #clearTransientModeState(options?: { restoreAskTools?: boolean }): Promise<void> {
		if (this.planModeEnabled || this.planModePaused) {
			if (this.#planModePreviousTools !== undefined) {
				await this.session.setActiveToolsByName(this.#planModePreviousTools);
			}
			this.session.setStandingResolveHandler?.(null);
			this.session.setPlanModeState(undefined);
			this.planModeEnabled = false;
			this.planModePaused = false;
			this.planModePlanFilePath = undefined;
			this.#planModePreviousTools = undefined;
			this.#planModePreviousModelState = undefined;
			this.#pendingModelSwitch = undefined;
			this.#planModeHasEntered = false;
			this.#updatePlanModeStatus();
		}

		if (this.askModeEnabled) {
			if (options?.restoreAskTools !== false && this.#askModePreviousTools !== undefined) {
				await this.session.setActiveToolsByName(this.#askModePreviousTools);
			}
			this.#askModePreviousTools = undefined;
			this.askModeEnabled = false;
		}

		if (this.goalModeEnabled || this.goalModePaused) {
			if (this.#goalModePreviousTools !== undefined) {
				await this.session.setActiveToolsByName(this.#goalModePreviousTools);
			}
			this.session.setGoalModeState(undefined);
			this.goalModeEnabled = false;
			this.goalModePaused = false;
			this.#goalModePreviousTools = undefined;
			this.#goalTurnHadToolCalls = false;
			this.#goalContinuationTurnInFlight = false;
			this.#goalSuppressNextContinuation = false;
			this.#cancelGoalContinuation();
			this.#updateGoalModeStatus();
		}
	}

	/** Reconcile mode state from session entries on resume/switch. */
	async #reconcileModeFromSession(options?: {
		preserveActiveGoal?: boolean;
		restoreAskTools?: boolean;
	}): Promise<void> {
		await this.#clearTransientModeState({ restoreAskTools: options?.restoreAskTools });
		const sessionContext = this.sessionManager.buildSessionContext();
		const goalEnabled = this.session.settings.get("goal.enabled");
		if (!goalEnabled && (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused")) {
			this.session.goalRuntime.clearAccounting();
			this.sessionManager.appendModeChange("none");
			return;
		}
		if (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused") {
			const goal = this.#goalFromModeData(sessionContext.modeData);
			if (!goal) {
				this.sessionManager.appendModeChange("none");
				return;
			}
			this.session.setGoalModeState({
				enabled: sessionContext.mode === "goal",
				mode: "active",
				goal,
			});
			const restored = await this.session.goalRuntime.onThreadResumed({
				preserveActiveGoal: options?.preserveActiveGoal,
			});
			this.goalModeEnabled = restored?.enabled === true;
			this.goalModePaused = restored?.enabled !== true && restored?.goal.status === "paused";
			// sdk.ts excludes "goal" from the initial active tool set unconditionally.
			// Re-add it now so the agent can call resume, complete, or drop on this goal.
			if (restored?.goal) {
				const previousTools = this.session.getActiveToolNames().filter(name => name !== "goal");
				this.#goalModePreviousTools = previousTools;
				await this.session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
			}
			this.#updateGoalModeStatus();
			return;
		}
		this.session.goalRuntime.clearAccounting();
		if (!this.session.settings.get("plan.enabled")) {
			// Clear stale plan/plan_paused mode so re-enabling the setting
			// later doesn't unexpectedly restore an old plan session.
			if (sessionContext.mode === "plan" || sessionContext.mode === "plan_paused") {
				this.sessionManager.appendModeChange("none");
			}
			return;
		}
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			await this.#enterPlanMode({ planFilePath });
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.#planModeHasEntered = true;
			this.#updatePlanModeStatus();
		}
	}

	async #enterPlanMode(options?: { planFilePath?: string; workflow?: "parallel" | "iterative" }): Promise<void> {
		if (this.planModeEnabled) {
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? (await this.#getPlanFilePath());
		const previousTools = this.session.getActiveToolNames();
		const hasResolveTool = this.session.getToolByName("resolve") !== undefined;
		// Plan-mode authoring needs `write`/`edit` even when tool discovery hid
		// them from the initial active set (issue #3165). Only genuine builtins
		// are force-activated — a same-named custom tool never auto-activates.
		const planAuthoringTools = ["write", "edit"].filter(
			name => this.session.getToolByName(name) !== undefined && this.session.isBuiltInTool(name),
		);
		const planTools = [...previousTools, ...(hasResolveTool ? ["resolve"] : []), ...planAuthoringTools];
		const uniquePlanTools = [...new Set(planTools)];

		this.#planModePreviousTools = previousTools;
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;
		// Suppress cache-miss marker on the next turn: plan mode changes the system
		// prompt, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;

		await this.session.setActiveToolsByName(uniquePlanTools);
		this.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#planModeHasEntered,
		});
		this.session.setStandingResolveHandler?.(input => this.#runPlanApprovalResolve(input));
		if (this.session.isStreaming) {
			await this.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#planModeHasEntered = true;
		await this.#applyPlanModeModel();
		this.#updatePlanModeStatus();
		this.sessionManager.appendModeChange("plan", { planFilePath });
		this.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	/** Standing resolve dispatcher registered while plan mode is active. The agent
	 *  submits the finalized plan by calling `resolve { action: "apply", extra: { title } }`;
	 *  this handler validates the plan file exists, normalizes the title, and shapes the
	 *  payload that `event-controller` forwards to `handlePlanApproval`. */
	#runPlanApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const state = this.session.getPlanModeState?.();
				if (!state?.enabled) {
					throw new ToolError("Plan mode is not active.");
				}
				const { planFilePath, title } = await resolveApprovedPlan({
					suppliedTitle: extra?.title,
					statePlanFilePath: state.planFilePath,
					readPlan: url => this.#readPlanFile(url),
					listPlanFiles: () => this.#listLocalPlanFiles(),
				});
				const details: PlanApprovalDetails = {
					planFilePath,
					title,
					planExists: true,
				};
				return {
					content: [{ type: "text" as const, text: "Plan ready for approval." }],
					details,
				};
			},
		});
	}

	async #restorePlanPreviousModel(prev: { model: Model; thinkingLevel?: ThinkingLevel }): Promise<void> {
		if (modelsAreEqual(this.session.model, prev.model)) {
			// Same model — only thinking level may differ. Avoid setModelTemporary()
			// which would reset provider-side sessions and break continuity.
			this.session.setThinkingLevel(prev.thinkingLevel);
		} else if (this.session.isStreaming) {
			this.#pendingModelSwitch = { model: prev.model, thinkingLevel: prev.thinkingLevel };
		} else {
			await this.session.setModelTemporary(prev.model, prev.thinkingLevel);
		}
	}

	/**
	 * Idempotent post-compaction model transition for the plan-approval compact
	 * path. The deferred pre-plan state is consumed on first application, so a
	 * second call (the before-flush hook vs. the short-circuit fallback) is a
	 * no-op. "failed" intentionally stays on the plan model — the context is
	 * intact and we dispatch best-effort.
	 */
	async #applyDeferredPlanModelTransition(
		outcome: CompactionOutcome | undefined,
		executionModel: ResolvedRoleModel | undefined,
	): Promise<void> {
		const deferredPrev = this.#planModePreviousModelState;
		if (deferredPrev === undefined || outcome === "failed") return;
		this.#planModePreviousModelState = undefined;
		if (executionModel) {
			await this.#applyPlanExecutionModel(executionModel);
		} else {
			await this.#restorePlanPreviousModel(deferredPrev);
		}
	}

	async #exitPlanMode(options?: { silent?: boolean; paused?: boolean; deferModelRestore?: boolean }): Promise<void> {
		if (!this.planModeEnabled) {
			return;
		}

		const previousTools = this.#planModePreviousTools;
		if (previousTools && previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		if (this.#planModePreviousModelState) {
			if (!options?.deferModelRestore) {
				await this.#restorePlanPreviousModel(this.#planModePreviousModelState);
			}
			// If #applyPlanModeModel queued a deferred switch to the plan-role model
			// (because the session was streaming on entry), drop it now: we are
			// leaving plan mode, so flushing it on the next agent_end would land the
			// session on the plan-role model after the user has exited plan mode
			// (issue #816). This runs even when deferModelRestore is set
			// (compact-approval path): otherwise the stale plan switch survives and
			// flushPendingModelSwitch() later clobbers the restored/execution model.
			// Only clear when the pending target matches the plan-role model — leave
			// any unrelated user-queued switch intact.
			const pending = this.#pendingModelSwitch;
			if (pending) {
				const planResolution = this.session.resolveRoleModelWithThinking("plan");
				if (planResolution.model && modelsAreEqual(pending.model, planResolution.model)) {
					this.#pendingModelSwitch = undefined;
				}
			}
		}
		this.session.setStandingResolveHandler?.(null);
		this.session.setPlanModeState(undefined);
		this.planModeEnabled = false;
		// Suppress cache-miss marker on the next turn: plan exit changes the system
		// prompt, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;
		this.planModePaused = options?.paused ?? false;
		this.planModePlanFilePath = undefined;
		this.#planModePreviousTools = undefined;
		if (!options?.deferModelRestore) this.#planModePreviousModelState = undefined;
		this.#updatePlanModeStatus();
		const paused = options?.paused ?? false;
		this.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		if (!options?.silent) {
			this.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	async #enterGoalMode(options: { objective?: string; resume?: boolean; silent?: boolean }): Promise<void> {
		await this.#exitAskMode();
		if (this.goalModeEnabled) {
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		const previousTools = this.session.getActiveToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#goalModePreviousTools = previousTools;
		this.goalModePaused = false;
		const state = options.resume
			? await this.session.goalRuntime.resumeGoal()
			: await this.session.goalRuntime.createGoal({ objective: options.objective ?? "" });
		await this.session.setActiveToolsByName(goalTools);
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!options.silent) {
			this.showStatus(options.resume ? "Goal mode resumed." : "Goal mode enabled.");
		}
	}

	async #exitGoalMode(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<void> {
		const previousTools = this.#goalModePreviousTools;
		if (this.goalModeEnabled && previousTools) {
			await this.session.setActiveToolsByName(previousTools);
		}
		const currentState = this.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.session.setGoalModeState(undefined);
			this.sessionManager.appendModeChange("none");
			this.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.goalModeEnabled = false;
		this.goalModePaused = options?.paused ?? false;
		this.#goalModePreviousTools = undefined;
		this.#goalContinuationTurnInFlight = false;
		this.#cancelGoalContinuation();
		this.#updateGoalModeStatus();
		if (!options?.silent) {
			if (options?.reason === "completed") {
				this.showStatus("Goal mode completed.");
			} else if (options?.reason === "dropped") {
				this.showStatus("Goal dropped.");
			} else if (options?.paused) {
				this.showStatus("Goal mode paused.");
			} else {
				this.showStatus("Goal mode disabled.");
			}
		}
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	async #hasPlanModeDraftContent(planFilePath: string): Promise<boolean> {
		const candidates = new Set<string>([planFilePath, ...(await this.#listLocalPlanFiles())]);
		for (const candidate of candidates) {
			const content = await this.#readPlanFile(candidate);
			if (content !== null && content.trim().length > 0) return true;
		}
		return false;
	}

	/** `local://` URLs of plan files in the session-local root, newest first.
	 *  A fallback for `resolveApprovedPlan` when the agent dropped `extra.title`,
	 *  so the plan it wrote is still found by scanning recent `*-plan.md` files. */
	async #listLocalPlanFiles(): Promise<string[]> {
		const localRoot = this.#resolvePlanFilePath("local://");
		try {
			const entries = await fs.readdir(localRoot, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async name => {
						const stat = await fs.stat(path.join(localRoot, name.name)).catch(() => null);
						return { url: `local://${name.name}`, mtime: stat?.mtimeMs ?? 0 };
					}),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
		}
	}

	showPlanReview(
		planContent: string,
		title: string,
		options: string[],
		dialogOptions?: {
			helpText?: string;
			disabledIndices?: number[];
			onExternalEditor?: () => void;
			onPlanEdited?: (content: string) => void;
			onFeedbackChange?: (feedback: string) => void;
			initialIndex?: number;
		},
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		this.#hidePlanReview();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		const finish = (choice: string | undefined): void => {
			if (settled) return;
			settled = true;
			this.#hidePlanReview();
			this.ui.requestRender();
			resolve(choice);
		};
		const overlay = new PlanReviewOverlay(
			planContent,
			{
				promptTitle: title,
				options,
				disabledIndices: dialogOptions?.disabledIndices,
				helpText: dialogOptions?.helpText,
				initialIndex: dialogOptions?.initialIndex,
				slider: extra?.slider,
				externalEditorLabel: this.keybindings.getDisplayString("app.editor.external") || undefined,
			},
			{
				onPick: choice => finish(choice),
				onCancel: () => finish(undefined),
				onExternalEditor: dialogOptions?.onExternalEditor,
				onAnnotationExternalEditor: (draft, commit) => void this.#openPlanAnnotationInExternalEditor(draft, commit),
				onPlanEdited: dialogOptions?.onPlanEdited,
				onFeedbackChange: dialogOptions?.onFeedbackChange,
			},
		);
		this.#planReviewOverlay = overlay;
		this.#planReviewOverlayHandle = this.ui.showOverlay(overlay, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ui.setFocus(overlay);
		this.ui.requestRender();
		return promise;
	}

	#hidePlanReview(): void {
		this.#planReviewOverlayHandle?.hide();
		this.#planReviewOverlayHandle = undefined;
		this.#planReviewOverlay = undefined;
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	#getPlanApprovalContextUsage(): ContextUsage | undefined {
		const executionModel = this.#planModePreviousModelState?.model ?? this.session.model;
		const contextWindow = executionModel?.contextWindow;
		if (typeof contextWindow === "number") {
			return this.session.getContextUsage({ contextWindow });
		}
		return this.session.getContextUsage();
	}

	#formatKeepContextLabel(contextUsage: ContextUsage | undefined): string {
		if (!contextUsage) {
			return "Approve and keep context";
		}
		const tokens = formatContextTokenCount(contextUsage.tokens);
		const contextWindow = formatContextTokenCount(contextUsage.contextWindow);
		return `Approve and keep context (~${tokens} / ${contextWindow})`;
	}

	#isKeepContextDisabled(contextUsage: ContextUsage | undefined): boolean {
		return contextUsage !== undefined && contextUsage.percent > PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT;
	}

	async #openPlanInExternalEditor(planFilePath: string): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		let currentText: string;
		try {
			currentText = await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				this.showError(`Plan file not found at ${planFilePath}`);
				return;
			}
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, {
				extension: path.extname(resolvedPath) || ".md",
				stdio,
				trimTrailingNewline: false,
			});
			if (result !== null) {
				await Bun.write(resolvedPath, result);
				this.#planReviewOverlay?.setPlanContent(result);
				this.showStatus("Plan updated in external editor.");
			}
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	async #openPlanAnnotationInExternalEditor(draft: string, commit: (text: string | null) => void): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, draft, { extension: ".md", stdio });
			if (result !== null) {
				commit(result);
			}
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	async #applyPlanExecutionModel(entry: ResolvedRoleModel | undefined): Promise<void> {
		if (!entry) return;
		try {
			await this.session.applyRoleModel(entry);
			this.statusLine.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Continuing with ${entry.role}: ${entry.model.name || entry.model.id}`);
		} catch (error) {
			this.showWarning(
				`Could not switch to the ${entry.role} model: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #approvePlan(
		planContent: string,
		options: {
			planFilePath: string;
			title: string;
			preserveContext?: boolean;
			compactBeforeExecute?: boolean;
			executionModel?: ResolvedRoleModel;
		},
	): Promise<void> {
		const previousTools = this.#planModePreviousTools ?? this.session.getActiveToolNames();

		// Mark the pending abort caused by the plan-mode → compaction transition as
		// silent BEFORE #exitPlanMode raises it. The `finally` below clears the
		// flag on every terminal compaction outcome (ok / cancelled / failed /
		// throw) so a leaked flag cannot silence a later unrelated abort.
		// Branchless mark+clear when !compactBeforeExecute: mark is gated; clear
		// is unconditional and idempotent.
		if (options.compactBeforeExecute) {
			this.session.markPlanInternalAbortPending();
		}
		let compactOutcome: CompactionOutcome | undefined;
		try {
			await this.#exitPlanMode({
				silent: true,
				paused: false,
				deferModelRestore: options.compactBeforeExecute === true,
			});

			if (!options.preserveContext) {
				await this.handleClearCommand();
				// The new session has a fresh local:// root — persist the approved plan there
				// so `local://<slug>-plan.md` resolves correctly in the execution session.
				const newLocalPath = resolveLocalUrlToPath(options.planFilePath, {
					getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
					getSessionId: () => this.sessionManager.getSessionId(),
				});
				await Bun.write(newLocalPath, planContent);
			} else if (options.compactBeforeExecute) {
				// Distill the plan-mode transcript before the execution turn is queued so
				// the plan-approved synthetic prompt lands as a fresh cache anchor.
				// Outcome is consumed after tool-restoration and plan-reference-path
				// bookkeeping below; `markPlanReferenceSent` is intentionally deferred
				// past the cancel guard — see the comment at the cancel branch.
				// Cancellation skips the synthetic-prompt dispatch (operator's explicit
				// abort is honored); failure proceeds best-effort — approval intent stands.
				const compactionPrompt = prompt.render(planModeCompactInstructionsPrompt, {
					planFilePath: options.planFilePath,
				});
				// Pin the plan reference path BEFORE compaction so any user messages
				// queued during the compaction await (which `handleCompactCommand`
				// flushes via `flushCompactionQueue` before returning) see the
				// approved plan in `#buildPlanReferenceMessage`. Reassignment after
				// the try/finally is idempotent and kept for the !compactBeforeExecute
				// branch.
				this.session.setPlanReferencePath(options.planFilePath);
				compactOutcome = await this.handleCompactCommand(compactionPrompt, undefined, outcome =>
					this.#applyDeferredPlanModelTransition(outcome, options.executionModel),
				);
			}
		} finally {
			// Unconditional clear. Idempotent: a no-op when the flag was never set
			// (i.e., the !compactBeforeExecute branch), and a no-op when the flag
			// was already consumed by AgentSession.#handleAgentEvent's aborted
			// message_end stamping. Guarantees the flag is dead at every exit.
			this.session.clearPlanInternalAbortPending();
		}

		// Tool restoration runs on every path — the plan mode tools must be
		// retired regardless of whether the synthetic prompt fires.
		if (previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		this.session.setPlanReferencePath(options.planFilePath);

		// Resolve the deferred plan-approval model transition. On the compact path
		// the before-flush hook passed to handleCompactCommand already ran this (so
		// any input queued during compaction executed on the post-compaction
		// model); the re-run here is idempotent and covers the short-circuit where
		// compaction never executed. It runs for "cancelled" too — the operator
		// aborted only the compaction, not the approval — so the next turn no longer
		// lands on the plan model. "failed" stays on the plan model (context
		// intact) and dispatches best-effort.
		if (options.compactBeforeExecute) {
			await this.#applyDeferredPlanModelTransition(compactOutcome, options.executionModel);
		} else {
			await this.#applyPlanExecutionModel(options.executionModel);
		}

		if (compactOutcome === "cancelled") {
			// Explicit abort: honor it. `executeCompaction` already surfaced
			// `showError("Compaction cancelled")`; we add the deferred-dispatch
			// warning and exit without dispatching the synthetic plan-approved
			// prompt. `markPlanReferenceSent` stays unset so
			// `AgentSession.#buildPlanReferenceMessage` injects the plan reference
			// on the operator's next `prompt()` call.
			this.showWarning(
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
			return;
		}

		// Approved plans land in a fresh (or compacted) session whose first user-visible
		// turn is the synthetic plan-approved prompt — that path bypasses the
		// input-controller's title generation. Seed an auto-name from the plan title
		// so the session is not left unnamed. `setSessionName("auto")` is a no-op
		// when the user has already chosen a name (preserveContext paths).
		const seededName = humanizePlanTitle(options.title);
		if (seededName && !this.sessionManager.getSessionName()) {
			const applied = await this.sessionManager.setSessionName(seededName, "auto");
			if (applied) {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
				this.updateEditorBorderColor();
			}
		}

		// markPlanReferenceSent fires only on the dispatch path so the synthetic
		// plan-approved prompt is the source of the reference injection.
		this.session.markPlanReferenceSent();
		const planModePrompt = prompt.render(planModeApprovedPrompt, {
			planContent,
			planFilePath: options.planFilePath,
			contextPreserved: options.preserveContext === true,
		});
		// The executor's first turn must start on an idle session. The agent may still
		// be streaming the post-`resolve` continuation (Agent.#emit is fire-and-forget)
		// or a turn kicked off by the compaction/clear above; prompt() would then throw
		// AgentBusyError ("Failed to finalize approved plan"). Abort the now-irrelevant
		// in-flight turn first — abort() bumps the prompt generation and cancels pending
		// continuations, so nothing re-streams in the synchronous gap before prompt().
		if (this.session.isStreaming) {
			await this.#abortPlanApprovalTurnSilently();
		}
		await this.session.prompt(planModePrompt, { synthetic: true });
	}
	async #abortPlanApprovalTurnSilently(): Promise<void> {
		this.session.markPlanInternalAbortPending();
		try {
			await this.session.abort();
		} finally {
			this.session.clearPlanInternalAbortPending();
		}
	}

	async handlePlanModeCommand(initialPrompt?: string): Promise<void> {
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}
		if (this.planModeEnabled) {
			const planFilePath = this.planModePlanFilePath ?? (await this.#getPlanFilePath());
			if (await this.#hasPlanModeDraftContent(planFilePath)) {
				const confirmed = await this.showHookConfirm(
					"Exit plan mode?",
					"This exits plan mode without approving a plan.",
				);
				if (!confirmed) return;
			}
			await this.#exitPlanMode({ paused: true });
			return;
		}
		if (this.planModePaused && !initialPrompt) {
			// No-arg third toggle: paused → off. Tools, model, and plan state were
			// already restored by the prior #exitPlanMode({ paused: true }); only the
			// paused flag, the reentry marker, and the session mode entry remain.
			// Prompted /plan invocations fall through to #enterPlanMode below so the
			// supplied prompt is still submitted as the first plan-mode turn.
			this.planModePaused = false;
			this.#planModeHasEntered = false;
			this.#updatePlanModeStatus();
			this.sessionManager.appendModeChange("none");
			this.showStatus("Plan mode disabled.");
			return;
		}
		if (!this.session.settings.get("plan.enabled")) {
			this.showWarning("Plan mode is disabled. Enable it in settings (plan.enabled).");
			return;
		}
		await this.#exitAskMode();
		await this.#enterPlanMode();
		if (initialPrompt && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt }));
		}
	}

	async #handleGoalBudgetCommand(rawBudget: string): Promise<void> {
		const state = this.session.getGoalModeState();
		if (!this.goalModeEnabled || !state?.enabled) {
			this.showWarning("No active goal.");
			return;
		}
		if (state.goal.status === "complete") {
			this.showStatus("Goal is already complete.");
			return;
		}
		const trimmed = rawBudget.trim().toLowerCase();
		let nextBudget: number | undefined;
		if (trimmed !== "off") {
			const parsed = Number.parseInt(trimmed, 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				this.showError("Goal budget must be a positive integer or `off`.");
				return;
			}
			nextBudget = parsed;
		}
		await this.session.goalRuntime.onBudgetMutated(nextBudget);
		this.#resetGoalContinuationSuppression();
		this.#scheduleGoalContinuation();
		this.showStatus(nextBudget === undefined ? "Goal budget cleared." : `Goal budget set to ${nextBudget}.`);
	}

	async handleGoalModeCommand(rest?: string): Promise<void> {
		try {
			if (this.planModeEnabled || this.planModePaused) {
				this.showWarning("Exit plan mode first.");
				return;
			}
			if (!this.session.settings.get("goal.enabled")) {
				this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
			if (sub) {
				await this.#dispatchGoalSubcommand(sub, subRest);
				return;
			}
			if (this.goalModeEnabled) {
				if (subRest) {
					this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
					return;
				}
				await this.#openGoalMenu("active");
				return;
			}
			const pausedState = this.#getPausedGoalState();
			if (pausedState) {
				if (subRest) {
					this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
					return;
				}
				await this.#openGoalMenu("paused");
				return;
			}
			if (subRest) {
				await this.#startGoalFromObjective(subRest);
				return;
			}
			const objective = (
				await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true })
			)?.trim();
			if (!objective) return;
			await this.#startGoalFromObjective(objective);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}
	async handleGuidedGoalCommand(rest?: string): Promise<void> {
		try {
			if (this.planModeEnabled || this.planModePaused) {
				this.showWarning("Exit plan mode first.");
				return;
			}
			if (!this.session.settings.get("goal.enabled")) {
				this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			if (this.goalModeEnabled) {
				this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
				return;
			}
			if (this.#getPausedGoalState()) {
				this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return;
			}

			const initial = rest?.trim()
				? rest.trim()
				: (await this.showHookEditor("Guided goal", undefined, undefined, { promptStyle: true }))?.trim();
			if (!initial) return;

			const messages: GuidedGoalMessage[] = [{ role: "user", content: initial }];
			let latestDraftObjective: string | undefined;
			for (let turn = 0; turn < 6; turn++) {
				const result = await runGuidedGoalTurn(this.session, { messages });
				if (result.objective?.trim()) latestDraftObjective = result.objective.trim();
				if (result.kind === "question") {
					messages.push({ role: "assistant", content: result.question });
					const answer = (
						await this.showHookEditor(result.question, undefined, undefined, { promptStyle: true })
					)?.trim();
					if (!answer) return;
					messages.push({ role: "user", content: answer });
					continue;
				}

				const finalObjective = (
					await this.showHookEditor("Review guided goal", result.objective, undefined, { promptStyle: true })
				)?.trim();
				if (!finalObjective) return;
				await this.#startGoalFromObjective(finalObjective);
				return;
			}

			// Hit the turn cap without an explicit `ready`. Rather than discard the whole interview,
			// salvage the latest non-empty model objective draft seen on any earlier turn. A final
			// question turn may omit `objective`; that must not erase a usable draft.
			if (latestDraftObjective) {
				const finalObjective = (
					await this.showHookEditor("Review guided goal", latestDraftObjective, undefined, { promptStyle: true })
				)?.trim();
				if (finalObjective) {
					await this.#startGoalFromObjective(finalObjective);
					return;
				}
			}
			this.showWarning("Guided goal setup needs more detail. Run /guided-goal again with a narrower objective.");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	async #dispatchGoalSubcommand(sub: GoalSubcommand, rest: string): Promise<void> {
		switch (sub) {
			case "set":
				await this.#handleGoalSetSubcommand(rest);
				return;
			case "show":
				this.#showGoalDetails();
				return;
			case "pause":
				await this.#pauseGoalAction();
				return;
			case "resume":
				await this.#resumeGoalAction();
				return;
			case "drop":
				await this.#confirmAndDropGoal();
				return;
			case "budget":
				if (!this.goalModeEnabled) {
					this.showWarning(
						this.#getPausedGoalState() ? "Resume the goal before adjusting the budget." : "No active goal.",
					);
					return;
				}
				if (!rest) {
					await this.#promptGoalBudgetEdit();
					return;
				}
				await this.#handleGoalBudgetCommand(rest);
				return;
		}
	}

	async #openGoalMenu(state: "active" | "paused"): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		if (!goal) return;
		const summary = goal.objective.length > 48 ? `${goal.objective.slice(0, 47)}…` : goal.objective;
		const title = state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`;
		const items =
			state === "active"
				? ["Show details", "Adjust budget…", "Pause", "Drop"]
				: ["Resume", "Show details", "Adjust budget…", "Drop"];
		const choice = await this.showHookSelector(title, items);
		if (!choice) return;
		switch (choice) {
			case "Show details":
				this.#showGoalDetails();
				return;
			case "Adjust budget…":
				await this.#promptGoalBudgetEdit();
				return;
			case "Pause":
				await this.#pauseGoalAction();
				return;
			case "Resume":
				await this.#resumeGoalAction();
				return;
			case "Drop":
				await this.#confirmAndDropGoal();
				return;
		}
	}

	#showGoalDetails(): void {
		const state = this.session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) {
			this.showStatus("No goal set.");
			return;
		}
		const used = goal.tokensUsed.toLocaleString();
		const budgetLine =
			goal.tokenBudget !== undefined
				? `${used} / ${goal.tokenBudget.toLocaleString()} (${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} left)`
				: `${used} (no budget)`;
		const lines = [
			`Objective: ${goal.objective}`,
			`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
			`Tokens: ${budgetLine}`,
			`Time spent: ${formatDuration(goal.timeUsedSeconds * 1000)}`,
		];
		this.showStatus(lines.join("\n"));
	}

	async #promptGoalBudgetEdit(): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		const prefill = goal?.tokenBudget !== undefined ? String(goal.tokenBudget) : "";
		const input = (
			await this.showHookEditor("Goal budget (number, `off`, or empty to cancel)", prefill, undefined, {
				promptStyle: true,
			})
		)?.trim();
		if (!input) return;
		await this.#handleGoalBudgetCommand(input);
	}

	async #pauseGoalAction(): Promise<void> {
		if (!this.goalModeEnabled) {
			this.showWarning("No active goal to pause.");
			return;
		}
		await this.session.goalRuntime.pauseGoal();
		await this.#exitGoalMode({ paused: true, reason: "paused" });
	}

	async #resumeGoalAction(): Promise<void> {
		if (!this.#getPausedGoalState()) {
			this.showWarning("No paused goal to resume.");
			return;
		}
		await this.#enterGoalMode({ resume: true, silent: true });
		this.showStatus("Goal mode resumed.");
		this.#scheduleGoalContinuation();
	}

	async #confirmAndDropGoal(): Promise<void> {
		if (!this.goalModeEnabled && !this.#getPausedGoalState()) {
			this.showWarning("No goal to drop.");
			return;
		}
		const confirmed = await this.showHookConfirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
		await this.session.goalRuntime.dropGoal();
		await this.#exitGoalMode({ reason: "dropped" });
	}

	async #startGoalFromObjective(objective: string): Promise<void> {
		await this.#enterGoalMode({ objective, silent: true });
		this.#resetGoalContinuationSuppression();
		if (!this.session.isStreaming && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective }));
		}
	}

	async #replaceGoalFromObjective(objective: string): Promise<void> {
		const state = await this.session.goalRuntime.replaceGoal({ objective });
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.goalModePaused = false;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!this.session.isStreaming && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective }));
		}
	}

	async #handleGoalSetSubcommand(rest: string): Promise<void> {
		if (!this.goalModeEnabled && this.#getPausedGoalState()) {
			this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return;
		}
		const objective = rest.trim()
			? rest.trim()
			: (await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true }))?.trim();
		if (!objective) return;
		if (this.goalModeEnabled) {
			await this.#replaceGoalFromObjective(objective);
			return;
		}
		await this.#startGoalFromObjective(objective);
	}

	/** Manually (re-)open the plan-review overlay — bound to `/plan-review`. Lets
	 *  the operator pull the review back up after dismissing it, or review a plan
	 *  the agent wrote without calling `resolve`. There is no fixed plan filename:
	 *  `getPlanReferencePath()` is empty until a plan is actually approved (and does
	 *  not survive a restart), so this drives off the newest `local://<slug>-plan.md`
	 *  the agent wrote — the files persist in the session artifacts dir, so the scan
	 *  works before any review and across restarts. */
	async openPlanReview(): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}
		const noPlan = "No plan to review yet — write one to a local://<slug>-plan.md file first.";
		const [planFilePath] = await this.#listLocalPlanFiles();
		if (!planFilePath) {
			this.showWarning(noPlan);
			return;
		}
		const planContent = await this.#readPlanFile(planFilePath);
		if (planContent === null) {
			this.showWarning(noPlan);
			return;
		}
		const { title } = resolvePlanTitle({ planContent, planFilePath });
		await this.handlePlanApproval({ planFilePath, title, planExists: true });
	}

	async handlePlanApproval(details: PlanApprovalDetails): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}

		// Abort the agent to prevent it from continuing (e.g., re-submitting the
		// plan) while the popup is showing. The event listener fires asynchronously
		// (agent's #emit is fire-and-forget), so without this the model sees
		// "Plan ready for approval." and immediately re-invokes `resolve` in a loop.
		// This abort is an internal UI transition, not operator cancellation.
		await this.#abortPlanApprovalTurnSilently();

		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.#getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		const contextUsage = this.#getPlanApprovalContextUsage();
		const keepContextLabel = this.#formatKeepContextLabel(contextUsage);
		const keepContextDisabled = this.#isKeepContextDisabled(contextUsage);

		// Model-tier slider: let the operator pick which configured role model
		// (smol/default/slow/…) executes the approved plan. The slider always starts
		// on the `default` tier so execution defaults to the default model no matter
		// which model drove the planning conversation. Left/right move it from there;
		// hidden when fewer than two role models resolve — a lone tier is no choice.
		// `selectedTierIndex` tracks the live slider position.
		const cycle = this.session.getRoleModelCycle(this.session.settings.get("cycleOrder"));
		const defaultTierIndex = cycle ? cycle.models.findIndex(entry => entry.role === "default") : -1;
		const startTierIndex = defaultTierIndex >= 0 ? defaultTierIndex : (cycle?.currentIndex ?? 0);
		let selectedTierIndex = startTierIndex;
		const slider: HookSelectorSlider | undefined =
			cycle && cycle.models.length > 1
				? {
						caption: "continue with",
						index: startTierIndex,
						segments: cycle.models.map(entry => ({
							label: entry.role,
							detail: entry.model.name || entry.model.id,
						})),
						onChange: index => {
							selectedTierIndex = index;
						},
					}
				: undefined;
		// The overlay now owns the dynamic, focus-aware help line; the caller only
		// supplies the trailing cancel hint.
		const helpText = "esc cancel";
		// In-overlay edits (section deletes/undo) and section annotations. Deletes
		// update `editedContent` (and mirror to disk); annotations build `feedback`
		// that the Refine branch re-prompts the model with.
		let editedContent: string | undefined;
		let feedback = "";

		const choice = await this.showPlanReview(
			planContent,
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", keepContextLabel, "Refine plan"],
			{
				helpText,
				onExternalEditor: () => void this.#openPlanInExternalEditor(planFilePath),
				onPlanEdited: content => {
					editedContent = content;
					void Bun.write(this.#resolvePlanFilePath(planFilePath), content);
				},
				onFeedbackChange: value => {
					feedback = value;
				},
				disabledIndices: keepContextDisabled ? [PLAN_KEEP_CONTEXT_OPTION_INDEX] : undefined,
			},
			{ slider },
		);

		if (choice === "Approve and execute" || choice === "Approve and compact context" || choice === keepContextLabel) {
			try {
				// Prefer in-overlay edits (already in memory) over a disk re-read; the
				// `onPlanEdited` write is fire-and-forget, so reading the file here could
				// race ahead of it.
				const latestPlanContent = editedContent ?? (await this.#readPlanFile(planFilePath));
				if (!latestPlanContent) {
					this.showError(`Plan file not found at ${planFilePath}`);
					return;
				}
				// Capture the operator's tier choice and hand it to #approvePlan, which
				// applies it AFTER #exitPlanMode. #exitPlanMode normally restores
				// #planModePreviousModelState (the model + thinking from before plan
				// mode), so applying the slider choice any earlier would be silently
				// reverted — the bug that made "continue with slow" keep executing on
				// the default model. For compact-context approval, the plan model is
				// kept through compaction, then a successful compaction transitions to
				// the slider model (or restores the pre-plan model when no slider
				// choice was made). A tier is a choice only when it differs from that
				// restore target in model OR thinking (a model-only check would treat
				// "stay on default" as implicit and lose the tier's configured thinking
				// override) — so sliding onto the tier the restore lands on anyway
				// stays implicit, and a hidden slider never pins the lone tier.
				const restoreState = this.#planModePreviousModelState;
				const restoreModel = restoreState ? restoreState.model : this.session.model;
				const restoreThinking = restoreState ? restoreState.thinkingLevel : this.session.thinkingLevel;
				const selectedTier = slider ? cycle?.models[selectedTierIndex] : undefined;
				const executionModel =
					selectedTier &&
					(!modelsAreEqual(selectedTier.model, restoreModel) ||
						(selectedTier.explicitThinkingLevel && selectedTier.thinkingLevel !== restoreThinking))
						? selectedTier
						: undefined;
				await this.#approvePlan(latestPlanContent, {
					planFilePath,
					title: details.title,
					preserveContext: choice !== "Approve and execute",
					compactBeforeExecute: choice === "Approve and compact context",
					executionModel,
				});
			} catch (error) {
				this.showError(
					`Failed to finalize approved plan: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}

		if (choice === "Refine plan") {
			const refinement = feedback.trim();
			try {
				if (refinement) {
					if (this.onInputCallback) {
						this.onInputCallback(this.startPendingSubmission({ text: feedback }));
					} else {
						await this.session.prompt(feedback);
					}
				} else {
					this.showStatus("Refine plan: enter a follow-up prompt.");
				}
			} catch (error) {
				this.showError(`Failed to refine plan: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}
	}

	/**
	 * Pool of consent-prompt variants. Each entry is `[headline, reassurance]`;
	 * the second line always promises the same scope (tool name + confusion
	 * details, never personal data) so users learn what they're consenting to
	 * even as the top line rotates.
	 *
	 * Kept in-module rather than i18n'd because the whole charm is the tone
	 * — translations would need to preserve it deliberately, not auto-render.
	 */
	static #AUTOQA_CONSENT_PROMPTS: ReadonlyArray<readonly [string, string]> = [
		[
			"😤 Your agent is fuming about a tool.",
			"Wanna let it vent to the devs? Just the tool name + what set it off, nothing personal.",
		],
		[
			"😵‍💫 Your agent is having an existential crisis over a tool.",
			"Forward the dread to the devs? Tool + what broke its little mind, no personal info.",
		],
		[
			"😭 Your agent wants to cry about a misbehaving tool.",
			"Let it cry to the devs? Tool + the tears, never anything personal.",
		],
		[
			"🤬 Your agent is BIG MAD at one of the tools.",
			"Pass the rant along? Just the tool name and what enraged it, nothing personal.",
		],
		[
			"🫠 Your agent is melting down over a tool.",
			"Mop up by alerting the devs? Tool + what melted it, no personal info.",
		],
		[
			"🤯 Your agent's brain broke at a tool's nonsense.",
			"Ship the pieces to the devs? Tool name + the confusion, never anything personal.",
		],
		[
			"😩 Your agent is begging to file a complaint about a tool.",
			"Hand it the form? Tool + what wronged it, nothing personal.",
		],
		[
			"🥲 Your agent put on a brave face but a tool did it dirty.",
			"Let it tell the devs the truth? Tool name + the dirt, no personal info.",
		],
	];

	/**
	 * Show the report_tool_issue consent popup and return the user's decision.
	 * Invoked by the process-global consent handler the tool dispatches to;
	 * subagent invocations bubble up here through the shared module state.
	 */
	async #promptAutoQaConsent(): Promise<boolean | null> {
		const pool = InteractiveMode.#AUTOQA_CONSENT_PROMPTS;
		const [headline, body] = pool[Math.floor(Math.random() * pool.length)];
		const choice = await this.showHookSelector(`${headline}\n${body}`, ["Yes", "No"]);
		return choice === "Yes";
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(false);
		}
		this.#cleanupMicAnimation();
		this.#cancelTodoAutoClearTimer();
		this.#cancelGoalContinuation();
		if (this.#sttController) {
			this.#sttController.dispose();
			this.#sttController = undefined;
		}
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#observerRegistry.dispose();
		this.#eventController.dispose();
		this.statusLine.dispose();
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}
		// Clear the process-global consent handler so it doesn't outlive this
		// InteractiveMode instance (e.g. test harnesses, headless re-init).
		setAutoQaConsentHandler(null, null);
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		// Snapshot the editor before any teardown empties it. Persisting the draft
		// here covers Ctrl+D shutdown with non-empty text; for /exit the editor is
		// already cleared so saveDraft("") just removes any stale sidecar.
		const draftText = this.editor.getText();

		// Flush pending session writes before shutdown
		await this.sessionManager.flush();
		try {
			await this.sessionManager.saveDraft(draftText);
		} catch (err) {
			logger.warn("Failed to save session draft", { error: String(err) });
		}
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#focusController.dispose();

		// Emit shutdown event to hooks
		await this.session.dispose();

		// Do not force a final render during teardown: disposed session/UI state can
		// collapse to an empty frame, clearing the viewport and leaving the parent
		// shell prompt at row 0. Stop from the last committed frame so the terminal
		// hands Bash the cursor immediately after visible OMP content.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		popTerminalTitle();
		this.stop();

		// Print resumption hint if this is a persisted session
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${APP_NAME} --resume ${sessionId}`)}\n`);
		}

		await postmortem.quit(0);
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#toolUiContextSetter(uiContext, hasUI);
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiController.initializeHookRunner(uiContext, hasUI);
	}

	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void {
		const previousEditor = this.editor;
		const previousText = previousEditor.getText();
		const nextEditor = factory
			? factory(this.ui, getEditorTheme(), this.keybindings)
			: new CustomEditor(getEditorTheme());

		nextEditor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		nextEditor.setAutocompleteMaxVisible(this.settings.get("autocompleteMaxVisible"));
		nextEditor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		nextEditor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		nextEditor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		nextEditor.setMaxHeight(this.#computeEditorMaxHeight());
		if (this.historyStorage) {
			nextEditor.setHistoryStorage(this.historyStorage);
		}
		nextEditor.setText(previousText);

		this.editorContainer.clear();
		this.editor = nextEditor;
		this.#mountComposer(nextEditor);
		this.ui.setFocus(nextEditor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		void this.refreshSlashCommandState().catch(error => {
			logger.warn("Failed to refresh slash command state for custom editor", { error: String(error) });
		});

		this.updateEditorBorderColor();
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	// UI helpers
	present(content: Component | readonly Component[]): void {
		if (Array.isArray(content)) {
			for (const item of content) this.#mountChatChild(item);
		} else {
			this.#mountChatChild(content as Component);
		}
		this.ui.requestRender();
	}

	#mountChatChild(item: Component): void {
		this.chatContainer.addChild(item);
		if (item instanceof ChatBlock) item.mount(this.#chatHost);
	}

	resetTranscript(): void {
		this.chatContainer.dispose();
		this.chatContainer.clear();
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		this.#uiHelpers.showError(message);
	}

	showPinnedError(message: string): void {
		this.errorBannerContainer.clear();
		this.errorBannerContainer.addChild(new ErrorBannerComponent(message));
		this.ui.requestRender();
	}

	clearPinnedError(): void {
		if (this.errorBannerContainer.children.length === 0) return;
		this.errorBannerContainer.clear();
		this.ui.requestRender();
	}

	showWarning(message: string): void {
		this.#uiHelpers.showWarning(message);
	}

	#handleMcpConnectionStatusEvent(event: McpConnectionStatusEvent): void {
		switch (event.type) {
			case "connecting":
				this.#mcpPendingServers = [...event.serverNames];
				this.#mcpConnectedServers = [];
				this.#mcpFailedServers.clear();
				break;
			case "connected":
				this.#mcpPendingServers = this.#mcpPendingServers.filter(server => server !== event.serverName);
				if (!this.#mcpConnectedServers.includes(event.serverName)) this.#mcpConnectedServers.push(event.serverName);
				this.#mcpFailedServers.delete(event.serverName);
				break;
			case "failed":
				this.#mcpPendingServers = this.#mcpPendingServers.filter(server => server !== event.serverName);
				this.#mcpConnectedServers = this.#mcpConnectedServers.filter(server => server !== event.serverName);
				this.#mcpFailedServers.set(event.serverName, event.error);
				break;
		}
		this.showStatus(
			formatMCPConnectionStatusMessage({
				pendingServers: this.#mcpPendingServers,
				connectedServers: this.#mcpConnectedServers,
				failedServers: [...this.#mcpFailedServers].map(([serverName, error]) => ({ serverName, error })),
			}),
		);
	}

	#handleLspStartupEvent(event: LspStartupEvent): void {
		this.#updateWelcomeLspServers();

		if (event.type === "failed") {
			this.showWarning(`LSP startup failed: ${event.error}. It will retry lazily on write.`);
			return;
		}

		const failedServers = event.servers.filter(server => server.status === "error");

		if (failedServers.length === 1) {
			const failedServer = failedServers[0];
			const detail = failedServer.error ? `: ${failedServer.error}` : "";
			this.showWarning(`LSP startup failed for ${failedServer.name}${detail}. It will retry lazily on write.`);
			return;
		}

		if (failedServers.length > 1) {
			const failedNames = failedServers.map(server => server.name).join(", ");
			this.showWarning(`LSP startup failed for ${failedNames}. It will retry lazily on write.`);
		}
	}

	#getWelcomeLspServers(): WelcomeLspServerInfo[] {
		return (
			this.lspServers?.map(server => ({
				name: server.name,
				status: server.status,
				fileTypes: server.fileTypes,
			})) ?? []
		);
	}

	#updateWelcomeLspServers(): void {
		if (!this.#welcomeComponent) {
			return;
		}

		this.#welcomeComponent.setLspServers(this.#getWelcomeLspServers());
		this.ui.requestRender();
	}

	#clearWorkingMessageAccentCache(): void {
		this.#workingMessageAccentCacheKey = undefined;
		this.#workingMessageAccentCacheValue = undefined;
		this.#workingMessageAccentCacheHasValue = false;
	}

	#buildWorkingMessageAccentCacheKey(): WorkingMessageAccentCacheKey {
		const sessionAccentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
		return {
			sessionAccentEnabled,
			sessionName: sessionAccentEnabled ? this.sessionManager.getSessionName() : undefined,
			accentSurfaceLuminance: theme.accentSurfaceLuminance,
		};
	}

	#workingMessageAccentCacheKeyEquals(a: WorkingMessageAccentCacheKey, b: WorkingMessageAccentCacheKey): boolean {
		return (
			a.sessionName === b.sessionName &&
			a.accentSurfaceLuminance === b.accentSurfaceLuminance &&
			a.sessionAccentEnabled === b.sessionAccentEnabled
		);
	}

	#cacheWorkingMessageAccent(
		key: WorkingMessageAccentCacheKey,
		value: WorkingMessageAccent | undefined,
	): WorkingMessageAccent | undefined {
		this.#workingMessageAccentCacheKey = key;
		this.#workingMessageAccentCacheValue = value;
		this.#workingMessageAccentCacheHasValue = true;
		return value;
	}

	#getWorkingMessageAccent(): WorkingMessageAccent | undefined {
		const key = this.#buildWorkingMessageAccentCacheKey();
		if (
			this.#workingMessageAccentCacheHasValue &&
			this.#workingMessageAccentCacheKey &&
			this.#workingMessageAccentCacheKeyEquals(key, this.#workingMessageAccentCacheKey)
		) {
			return this.#workingMessageAccentCacheValue;
		}
		if (!key.sessionAccentEnabled || !key.sessionName) {
			return this.#cacheWorkingMessageAccent(key, undefined);
		}
		const hex = getSessionAccentHex(key.sessionName, theme.getMajorThemeColorHexes(), key.accentSurfaceLuminance);
		const main = getSessionAccentAnsi(hex);
		const dim = getSessionAccentAnsi(adjustHsv(hex, { s: 0.55, v: 0.65 }));
		return this.#cacheWorkingMessageAccent(key, main && dim ? { main, dim } : undefined);
	}

	ensureLoadingAnimation(): void {
		if (!this.loadingAnimation) {
			this.#clearWorkingMessageAccentCache();
			this.statusContainer.clear();
			const messageColorFn = ((message: string) =>
				renderWorkingMessage(message, this.#getWorkingMessageAccent())) as LoaderMessageColorFn & {
				animated?: true;
			};
			// Shimmer drives the 30fps redraw; when it is disabled the working
			// message is static, so leave `animated` unset and let the loader use
			// the spinner-only ~12.5fps cadence instead of repainting a frozen line.
			if (shimmerEnabled()) messageColorFn.animated = true;
			this.loadingAnimation = new Loader(
				this.ui,
				spinner => {
					const accent = this.#getWorkingMessageAccent();
					return accent ? `${accent.main}${spinner}\x1b[39m` : theme.fg("accent", spinner);
				},
				messageColorFn,
				this.#defaultWorkingMessage,
				getSymbolTheme().spinnerFrames,
			);
			this.statusContainer.addChild(this.loadingAnimation);
		}

		this.applyPendingWorkingMessage();
	}

	#stopLoadingAnimation(clearStatusContainer: boolean): void {
		if (!this.loadingAnimation) return;
		this.loadingAnimation.stop();
		this.loadingAnimation = undefined;
		this.#clearWorkingMessageAccentCache();
		if (clearStatusContainer) {
			this.statusContainer.clear();
		}
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(this.#defaultWorkingMessage);
			}
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message);
			return;
		}

		this.#pendingWorkingMessage = message;
	}

	applyPendingWorkingMessage(): void {
		if (this.#pendingWorkingMessage === undefined) {
			return;
		}

		const message = this.#pendingWorkingMessage;
		this.#pendingWorkingMessage = undefined;
		this.setWorkingMessage(message);
	}

	showNewVersionNotification(newVersion: string): void {
		this.#uiHelpers.showNewVersionNotification(newVersion);
	}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.#uiHelpers.queueCompactionMessage(text, mode, images);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
	}

	flushPendingBashComponents(): void {
		this.#uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): Component[] {
		return this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(options?: { preserveExistingChat?: boolean; clearTerminalHistory?: boolean }): void {
		this.#uiHelpers.renderInitialMessages(options);
	}

	getUserMessageText(message: Message): string {
		return this.#uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.#uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.#uiHelpers.extractAssistantText(message);
	}

	// Command handling
	handleExportCommand(text: string): Promise<void> {
		return this.#commandController.handleExportCommand(text);
	}

	handleDumpCommand() {
		return this.#commandController.handleDumpCommand();
	}

	handleAdvisorDumpCommand(isRaw?: boolean) {
		return this.#commandController.handleAdvisorDumpCommand(isRaw);
	}

	handleDebugTranscriptCommand(): Promise<void> {
		return this.#commandController.handleDebugTranscriptCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.#commandController.handleShareCommand();
	}

	handleTodoCommand(args: string): Promise<void> {
		return this.#todoCommandController.handleTodoCommand(args);
	}

	handleSessionCommand(): Promise<void> {
		return this.#commandController.handleSessionCommand();
	}

	handleAdvisorStatusCommand(): Promise<void> {
		return this.#commandController.handleAdvisorStatusCommand();
	}

	handleJobsCommand(): Promise<void> {
		return this.#commandController.handleJobsCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	async handleChangelogCommand(showFull = false): Promise<void> {
		await this.#commandController.handleChangelogCommand(showFull);
	}

	handleHotkeysCommand(): void {
		this.#commandController.handleHotkeysCommand();
	}

	handleToolsCommand(): void {
		this.#commandController.handleToolsCommand();
	}

	handleContextCommand(): void {
		this.#commandController.handleContextCommand();
	}

	#prepareSessionSwitch(): void {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.clearPinnedError();
		this.#hidePlanReview();
	}

	handleClearCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleClearCommand();
	}

	handleFreshCommand(): Promise<void> {
		return this.#commandController.handleFreshCommand();
	}

	handleDropCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleDropCommand();
	}

	handleForkCommand(): Promise<void> {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		return this.#commandController.handleForkCommand();
	}

	handleMoveCommand(targetPath?: string): Promise<void> {
		return this.#commandController.handleMoveCommand(targetPath);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	async handleSTTToggle(): Promise<void> {
		if (!settings.get("stt.enabled")) {
			this.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return;
		}
		if (!this.#sttController) {
			this.#sttController = new STTController();
		}
		await this.#sttController.toggle(this.editor, {
			showWarning: (msg: string) => this.showWarning(msg),
			showStatus: (msg: string) => this.showStatus(msg),
			requestRender: () => this.ui.requestRender(),
			onStateChange: (state: SttState) => {
				// Duck assistant speech while the user is talking (push-to-talk); restore after.
				if (state === "recording") vocalizer.duck();
				else vocalizer.unduck();
				if (state === "recording") {
					this.#voicePreviousShowHardwareCursor = this.ui.getShowHardwareCursor();
					this.#voicePreviousUseTerminalCursor = this.editor.getUseTerminalCursor();
					this.ui.setShowHardwareCursor(false);
					this.editor.setUseTerminalCursor(false);
					this.#startMicAnimation();
				} else if (state === "transcribing") {
					this.#stopMicAnimation();
					this.#setMicCursor({ r: 200, g: 200, b: 200 });
				} else {
					this.#cleanupMicAnimation();
				}
				this.updateEditorTopBorder();
				this.ui.requestRender();
			},
		});
	}

	#setMicCursor(color: { r: number; g: number; b: number }): void {
		this.editor.cursorOverride = `\x1b[38;2;${color.r};${color.g};${color.b}m${theme.icon.mic}\x1b[0m`;
		// Theme symbols can be wide (for example, 🎤), so measure the rendered override.
		this.editor.cursorOverrideWidth = visibleWidth(this.editor.cursorOverride);
	}

	#updateMicIcon(): void {
		const { r, g, b } = hsvToRgb({ h: this.#voiceHue, s: 0.9, v: 1.0 });
		this.#setMicCursor({ r, g, b });
	}

	#startMicAnimation(): void {
		if (this.#voiceAnimationInterval) return;
		this.#voiceHue = 0;
		this.#updateMicIcon();
		this.#voiceAnimationInterval = setInterval(() => {
			this.#voiceHue = (this.#voiceHue + 8) % 360;
			this.#updateMicIcon();
			// Component-scoped: the hue sweep only recolors the editor's cursor
			// glyph, so the transcript subtree is reused per animation frame.
			this.ui.requestComponentRender(this.editor);
		}, 60);
	}

	#stopMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
	}

	#cleanupMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
		this.editor.cursorOverride = undefined;
		this.editor.cursorOverrideWidth = undefined;
		if (this.#voicePreviousShowHardwareCursor !== null) {
			this.ui.setShowHardwareCursor(this.#voicePreviousShowHardwareCursor);
			this.#voicePreviousShowHardwareCursor = null;
		}
		if (this.#voicePreviousUseTerminalCursor !== null) {
			this.editor.setUseTerminalCursor(this.#voicePreviousUseTerminalCursor);
			this.#voicePreviousUseTerminalCursor = null;
		}
	}

	async showDebugSelector(): Promise<void> {
		await this.#selectorController.showDebugSelector();
	}

	showAgentHub(options?: { requireContent?: boolean }): void {
		this.#selectorController.showAgentHub(this.#observerRegistry, options);
	}

	resetObserverRegistry(): void {
		this.#observerRegistry.resetSessions();
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handlePythonCommand(code, excludeFromContext);
	}

	async handleMCPCommand(text: string): Promise<void> {
		const controller = new MCPCommandController(this);
		await controller.handle(text);
	}

	async handleSSHCommand(text: string): Promise<void> {
		const controller = new SSHCommandController(this);
		await controller.handle(text);
	}

	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
	): Promise<CompactionOutcome> {
		return this.#commandController.handleCompactCommand(customInstructions, mode, beforeFlush);
	}

	handleHandoffCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleHandoffCommand(customInstructions);
	}

	handleShakeCommand(mode: ShakeMode): Promise<void> {
		return this.#commandController.handleShakeCommand(mode);
	}

	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome> {
		return this.#commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(urlOrPath: string): void {
		this.#commandController.openInBrowser(urlOrPath);
	}

	// Selector handling
	showSettingsSelector(): void {
		this.#selectorController.showSettingsSelector();
	}

	showHistorySearch(): void {
		this.#selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.#selectorController.showExtensionsDashboard();
	}

	showAgentsDashboard(): void {
		void this.#selectorController.showAgentsDashboard();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#selectorController.showModelSelector(options);
	}

	showPluginSelector(mode?: "install" | "uninstall"): void {
		void this.#selectorController.showPluginSelector(mode);
	}

	showUserMessageSelector(): void {
		this.#selectorController.showUserMessageSelector();
	}

	showCopySelector(): void {
		this.#selectorController.showCopySelector();
	}

	showTreeSelector(): void {
		this.#selectorController.showTreeSelector();
	}

	showSessionSelector(): void {
		this.#selectorController.showSessionSelector();
	}

	handleResumeSession(sessionPath: string): Promise<void> {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.resetObserverRegistry();
		return this.#selectorController.handleResumeSession(sessionPath);
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#selectorController.handleSessionDeleteCommand();
	}

	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		return this.#selectorController.showOAuthSelector(mode, providerId);
	}

	showResetUsageSelector(): Promise<void> {
		return this.#selectorController.showResetUsageSelector();
	}

	showProviderSetup(): Promise<void> {
		return runProviderSetupWizard(this);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message);
	}

	// Input handling
	handleCtrlC(): void {
		this.#inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.#inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.#inputController.handleCtrlZ();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	handleTanCommand(work: string, cwdOverride?: string): Promise<void> {
		return this.#tanCommandController.start(work, cwdOverride);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	canBranchBtw(): boolean {
		return this.#btwController.canBranch();
	}

	handleBtwBranchKey(): Promise<boolean> {
		return this.#btwController.handleBranch();
	}

	canCopyBtw(): boolean {
		return this.#btwController.canCopy();
	}

	handleBtwCopyKey(): Promise<boolean> {
		return this.#btwController.handleCopy();
	}

	syncRunningSubagentBadge(): void {
		const registry = getRunningSubagentBadgeRegistry(this.collabGuest);
		this.statusLine.setSubagentCount(countRunningSubagentBadgeAgents(registry));
	}

	async handleBtwBranch(question: string, assistantMessage: AssistantMessage): Promise<void> {
		try {
			const result = await this.session.branchFromBtw(question, assistantMessage);
			if (result.cancelled) {
				this.showStatus("/btw branch cancelled", { dim: true });
				return;
			}
			this.#btwController.dispose();
			this.#omfgController.dispose();
			this.chatContainer.clear();
			this.renderInitialMessages({ clearTerminalHistory: true });
			this.updateEditorBorderColor();
			this.showStatus(
				result.sessionFile ? `Branched /btw to ${path.basename(result.sessionFile)}` : "Branched /btw",
			);
		} catch (error) {
			this.showError(`Cannot branch /btw: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	handleOmfgCommand(complaint: string): Promise<void> {
		return this.#omfgController.start(complaint);
	}

	hasActiveOmfg(): boolean {
		return this.#omfgController.hasActiveRequest();
	}

	handleOmfgEscape(): boolean {
		return this.#omfgController.handleEscape();
	}

	cycleThinkingLevel(): void {
		this.#inputController.cycleThinkingLevel();
	}

	cycleRoleModel(direction?: "forward" | "backward"): Promise<void> {
		return this.#inputController.cycleRoleModel(direction);
	}

	toggleToolOutputExpansion(): void {
		this.#inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.#inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.#inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.todoExpanded = !this.todoExpanded;
		this.#renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		if (todos.length > 0 && "tasks" in todos[0]) {
			this.todoPhases = todos as TodoPhase[];
		} else {
			this.todoPhases = [
				{
					name: "Todos",
					tasks: todos as TodoItem[],
				},
			];
		}
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(): Promise<void> {
		await this.#loadTodoList();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void> {
		return this.#extensionUiController.initHooksAndCustomTools();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.#extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.#extensionUiController.setHookWidget(key, content, options);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.#extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookSelector(title, options, dialogOptions, extra);
	}

	hideHookSelector(): void {
		this.#extensionUiController.hideHookSelector();
	}

	showHookInput(title: string, placeholder?: string): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder);
	}

	hideHookInput(): void {
		this.#extensionUiController.hideHookInput();
	}

	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookEditor(title, prefill, dialogOptions, editorOptions);
	}

	hideHookEditor(): void {
		this.#extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.#extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T> {
		return this.#extensionUiController.showHookCustom(factory, options);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.#extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.#extensionUiController.showToolError(toolName, error);
	}

	#subscribeToAgent(): void {
		this.#eventController.subscribeToAgent();
	}
}
