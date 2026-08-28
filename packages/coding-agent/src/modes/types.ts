import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Usage, UsageReport } from "@oh-my-pi/pi-ai";
import type { Component, Container, EditorTheme, Loader, Spacer, Text, TUI } from "@oh-my-pi/pi-tui";
import type { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import type { KeybindingsManager } from "../config/keybindings";
import type { Settings } from "../config/settings";
import type {
	AutocompleteProviderFactory,
	ExtensionCustomOptions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { MCPManager } from "../mcp";
import type { PlanApprovalDetails } from "../plan-mode/approved-plan";
import type { AgentSession } from "../session/agent-session";
import type { CompactMode } from "../session/compact-modes";
import type { ForeignSessionSource } from "../session/foreign-session-store";
import type { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import type { LspStartupServerInfo } from "../tools";
import type { EventBus } from "../utils/event-bus";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import type { CustomEditor } from "./components/custom-editor";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent, HookSelectorOptions } from "./components/hook-selector";
import type { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import type { TranscriptContainer } from "./components/transcript-container";
import type { RecentSession } from "./components/welcome";
import type { EventController } from "./controllers/event-controller";
import type { LoopLimitRuntime } from "./loop-limit";
import type { OAuthManualInputManager } from "./oauth-manual-input";
import type { Theme } from "./theme/theme";

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
};

export type SubmittedUserInput = {
	text: string;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
	customType?: string;
	/** Route through `session.prompt(text, { synthetic: true })` so the text lands
	 *  as a hidden agent-authored `developer` message rather than a visible user
	 *  turn. Used by the `c`/`.` continue shortcut. */
	synthetic?: boolean;
	/** Marks this submission as a deliberate user resume (set by the `.`/`c`
	 *  continue shortcut, which is also `synthetic`). Forwarded to
	 *  `session.prompt({ userInitiated })` so it clears advisor auto-resume
	 *  suppression even though it is synthetic. */
	userInitiated?: boolean;
	display?: boolean;
	/** Queue intent if the session is (or becomes) busy when this submission is
	 *  dispatched: "steer" (interrupt the active turn) or "followUp" (process after
	 *  it). Normal user Enter carries "steer" to match the streaming-branch Enter;
	 *  background/continuation submits omit it and default to "followUp". */
	streamingBehavior?: "steer" | "followUp";
	cancelled: boolean;
	started: boolean;
};

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export type TodoItem = {
	content: string;
	status: TodoStatus;
	details?: string;
	notes?: string[];
};

export type TodoPhase = {
	name: string;
	tasks: TodoItem[];
};

export interface InteractiveModeInitOptions {
	suppressWelcomeIntro?: boolean;
	clearInitialTerminalHistory?: boolean;
	/** Recent-session rows loaded by the prepaint composer while runtime modules initialized. */
	recentSessions?: Promise<RecentSession[] | undefined>;
}

export type InteractiveSelectorDialogOptions = ExtensionUIDialogOptions & Pick<HookSelectorOptions, "disabledIndices">;

export interface RenderSessionContextOptions {
	updateFooter?: boolean;
	reuseSettledComponents?: boolean;
	/** Tool calls whose existing live component remains the sole render owner across a rebuild. */
	preservedLiveToolCallIds?: ReadonlySet<string>;
}

export interface InteractiveModeContext {
	// UI access
	ui: TUI;
	chatContainer: TranscriptContainer;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	subagentContainer: Container;
	btwContainer: Container;
	omfgContainer: Container;
	cleanseContainer: Container;
	errorBannerContainer: Container;
	modelCycleContainer: Container;
	deferredCommandContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;
	syncComposerShape(): void;
	syncEditorSpelling(): void;

	// Session access
	session: AgentSession;
	sessionManager: SessionManager;
	/** The current session display name / title. */
	readonly sessionName: string | undefined;
	/** Session the transcript/editor/status are attached to: the focused agent's, else `session`. */
	readonly viewSession: AgentSession;
	/** Id of the focused agent, undefined when the main session is attached. */
	readonly focusedAgentId: string | undefined;
	/** Focus the main view on an agent's live session (delegates to SessionFocusController.focusAgent). */
	focusAgentSession(id: string): Promise<void>;
	/** Focus the focused agent's parent session, falling back to main (delegates to focusParent). */
	focusParentSession(): Promise<void>;
	/** Return the view to the main session (delegates to SessionFocusController.unfocus). */
	unfocusSession(): Promise<void>;
	/** Clear loader, transient HUD/pending containers, streaming state, and pending tools. */
	clearTransientSessionUi(): void;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: AgentSession["agent"];
	historyStorage?: HistoryStorage;
	mcpManager?: MCPManager;
	lspServers?: LspStartupServerInfo[];
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;
	eventController: EventController;
	eventBus?: EventBus;

	// State
	isInitialized: boolean;
	/**
	 * `true` once `renderInitialMessages` has rendered the session transcript
	 * into `chatContainer` at least once.
	 *
	 * Extension chat-rebuilds (`ExtensionUiController.#applyCustomMessageDisplay`)
	 * are gated on this: rebuilding before the initial render would plant a
	 * session-derived component into the chat that `renderInitialMessages` then
	 * both re-renders from session entries AND re-appends via
	 * `preserveExistingChat`, duplicating the message (issue #1955).
	 */
	initialChatRendered: boolean;
	isBashMode: boolean;
	toolOutputExpanded: boolean;
	hideToolActivity: boolean;
	todoExpanded: boolean;
	planModeEnabled: boolean;
	vibeModeEnabled: boolean;
	goalModeEnabled: boolean;
	goalModePaused: boolean;
	loopModeEnabled: boolean;
	loopModePaused: boolean;
	loopPrompt?: string;
	loopLimit?: LoopLimitRuntime;
	planModePlanFilePath?: string;
	hideThinkingBlock: boolean;
	/**
	 * Effective thinking-block visibility: true when hidden by user setting OR
	 * thinking level is "off" before the session has produced displayable
	 * thinking content.
	 */
	readonly effectiveHideThinkingBlock: boolean;
	/** Whether this visible session has produced thinking content the user can reveal. */
	readonly hasDisplayableThinkingContent: boolean;
	/** Record a message whose thinking content makes Ctrl+T meaningful even at thinking level "off"; returns true on first observation. */
	noteDisplayableThinkingContent(message: AgentMessage): boolean;
	proseOnlyThinking: boolean;
	compactionQueuedMessages: CompactionQueuedMessage[];
	/** Settled user/assistant components reusable across post-compaction transcript rebuilds. */
	transcriptMessageComponents: WeakMap<AgentMessage, Component>;
	pendingTools: Map<string, ToolExecutionHandle>;
	pendingBashComponents: BashExecutionComponent[];
	bashComponent: BashExecutionComponent | undefined;
	pendingPythonComponents: EvalExecutionComponent[];
	pythonComponent: EvalExecutionComponent | undefined;
	isPythonMode: boolean;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	/**
	 * Usage of the most recently rendered assistant turn, used to detect a
	 * prompt-cache invalidation on the next turn (cache footprint collapse).
	 * Reseeded by `renderSessionContext` on every rebuild/session switch.
	 */
	lastAssistantUsage: Usage | undefined;
	loadingAnimation: Loader | undefined;
	autoCompactionLoader: Loader | undefined;
	retryLoader: Loader | undefined;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined;
	locallySubmittedUserSignatures: Set<string>;
	lastSigintTime: number;
	lastEscapeTime: number;
	/** Owns Esc for every `/mcp test` that is active or whose cancellation hint may still be visible. */
	mcpTestEscapeHandlers: Set<() => void>;
	lastLeftTapTime: number;
	shutdownRequested: boolean;
	/** True once `shutdown()` has started. Read-only from the context;
	 *  controllers use this to skip work that races with teardown. */
	readonly isShuttingDown: boolean;
	hookSelector: HookSelectorComponent | undefined;
	hookInput: HookInputComponent | undefined;
	hookEditor: HookEditorComponent | undefined;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: Text | undefined;
	fileSlashCommands: Set<string>;
	skillCommands: Map<string, Skill>;
	oauthManualInput: OAuthManualInputManager;
	todoPhases: TodoPhase[];

	// Lifecycle
	init(options?: InteractiveModeInitOptions): Promise<void>;
	playWelcomeIntro(): void;
	shutdown(): Promise<void>;
	checkShutdownRequested(): Promise<void>;

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void;
	/** Stack extension autocomplete behavior on top of the built-in editor provider. */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;

	// UI helpers
	/**
	 * Mount transcript content and repaint once. The single sink for "show this in
	 * chat": producers build and return a `Component` (or a `ChatBlock` carrying
	 * its own lifecycle) and hand it here instead of touching `chatContainer` /
	 * `ui.requestRender()` directly. `ChatBlock`s are mounted (their `onMount`
	 * runs) so their timers/subscriptions start.
	 */
	present(content: Component | readonly Component[]): void;
	/**
	 * Mount command output immediately while idle, or defer it until the active
	 * agent turn ends so a growing live block cannot push duplicate rows into
	 * native scrollback.
	 */
	presentCommandOutput(content: Component | readonly Component[]): void;
	/** Mount command output deferred by {@link presentCommandOutput}. */
	flushPendingCommandOutput(): void;
	/**
	 * Dispose every live block in the transcript (stopping timers/subscriptions)
	 * and clear it. Used before a full rebuild so animated/streaming blocks do not
	 * leak.
	 */
	resetTranscript(): void;
	showStatus(message: string, options?: { dim?: boolean }): void;
	showModelCycleTrack(track: string): void;
	showError(message: string): void;
	showPinnedError(message: string): void;
	clearPinnedError(): void;
	showWarning(message: string, options?: { hideWithToolActivity?: boolean }): void;
	showNewVersionNotification(newVersion: string): void;
	clearEditor(): void;
	updatePendingMessagesDisplay(): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	flushPendingBashComponents(): void;
	flushPendingModelSwitch(): Promise<void>;
	setWorkingMessage(message?: string): void;
	applyPendingWorkingMessage(): void;
	ensureLoadingAnimation(): void;
	startPendingSubmission(input: {
		text: string;
		images?: ImageContent[];
		imageLinks?: (string | undefined)[];
		customType?: string;
		display?: boolean;
		streamingBehavior?: "steer" | "followUp";
	}): SubmittedUserInput;
	cancelPendingSubmission(): boolean;
	markPendingSubmissionStarted(input: SubmittedUserInput): boolean;
	finishPendingSubmission(input: SubmittedUserInput): void;
	/**
	 * Marks a locally-initiated user submission so the eventual `message_start`
	 * event for that user message does not clobber the editor draft (see #783).
	 * Returns a dispose function that removes the signature; call it on
	 * delivery failure so a retry can be re-marked cleanly.
	 */
	recordLocalSubmission(text: string, imageCount?: number): () => void;
	/**
	 * Wraps `fn` in a `recordLocalSubmission` marker that is automatically
	 * removed if `fn` rejects. Use this for the common case where a thrown
	 * delivery error should leave the signature set untouched.
	 */
	withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T>;
	/** Clears bookkeeping for an optimistic local user message once the matching session event arrives. */
	clearOptimisticUserMessage(): void;
	/** Replaces the raw optimistic user render with the canonical message emitted by the session. */
	replaceOptimisticUserMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void;
	/** True while an optimistically-rendered `/skill:` row awaits its canonical `message_start`. */
	optimisticSkillMessagePending: boolean;
	/** Optimistically renders a user-invoked `/skill:` row before its awaited dispatch (issue #8895). */
	renderOptimisticSkillMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void;
	/** Swaps the optimistic `/skill:` row for the canonical message emitted by the session. */
	reconcileOptimisticSkillMessage(message: AgentMessage): void;
	/** Drops the optimistic `/skill:` row when dispatch fails or bails before reaching the agent. */
	clearOptimisticSkillMessage(): void;
	isKnownSlashCommand(text: string): boolean;
	addMessageToChat(
		message: AgentMessage,
		options?: {
			imageLinks?: readonly (string | undefined)[];
			reuseSettledComponent?: boolean;
		},
	): Component[];
	renderSessionContext(sessionContext: SessionContext, options?: RenderSessionContextOptions): void;
	/** Render a session context in bounded chunks so terminal input runs between transcript paints. */
	renderSessionContextIncrementally(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		renderChunk?: () => void,
	): Promise<void>;
	renderInitialMessages(options?: { preserveExistingChat?: boolean; clearTerminalHistory?: boolean }): Promise<void>;
	/**
	 * In-place transcript rewind: drop the rendered components at/after
	 * `message` when none of their rows reached native scrollback. Returns
	 * false when the caller must fall back to a destructive
	 * `renderInitialMessages({ clearTerminalHistory: true })` replay.
	 */
	truncateTranscriptFromMessage(message: AgentMessage): boolean;
	getUserMessageText(message: Message): string;
	findLastAssistantMessage(): AssistantMessage | undefined;
	extractAssistantText(message: AssistantMessage): string;
	/** Refresh the running-subagents status badge from the active local or collab registry. */
	syncRunningSubagentBadge(): void;
	updateEditorBorderColor(): void;
	rebuildChatFromMessages(options?: { reuseSettledComponents?: boolean }): void;
	setTodos(todos: TodoItem[] | TodoPhase[]): void;
	reloadTodos(source?: AgentSession): Promise<void>;
	toggleTodoExpansion(): void;

	// Command handling
	handleExportCommand(text: string): Promise<void>;
	handleShareCommand(): Promise<void>;
	handleTodoCommand(args: string): Promise<void>;
	handleSessionCommand(): Promise<void>;
	handleAdvisorStatusCommand(): Promise<void>;
	handleJobsCommand(): Promise<void>;
	handleUsageCommand(reports?: UsageReport[] | null): Promise<void>;
	handleChangelogCommand(showFull?: boolean): Promise<void>;
	handleHotkeysCommand(): void;
	handleToolsCommand(): void;
	handleContextCommand(): void;
	handleDumpCommand(): Promise<void>;
	handleAdvisorDumpCommand(isRaw?: boolean): void;
	handleDebugTranscriptCommand(): Promise<void>;
	handleClearCommand(): Promise<void>;
	handleFreshCommand(): Promise<void>;
	handleResetContextCommand(): Promise<void>;
	handleDropCommand(): Promise<void>;
	handleForkCommand(): Promise<void>;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void>;
	handleMCPCommand(text: string): Promise<void>;
	handleSSHCommand(text: string): Promise<void>;
	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
	): Promise<CompactionOutcome>;
	handleHandoffCommand(customInstructions?: string): Promise<void>;
	handleShakeCommand(mode: ShakeMode): Promise<void>;
	handleMoveCommand(targetPath?: string): Promise<void>;
	handleRenameCommand(title: string): Promise<void>;
	handleMemoryCommand(text: string): Promise<void>;
	handleSTTToggle(): Promise<void>;
	/** Start or stop the Codex-backed realtime voice session. */
	handleLiveCommand(): Promise<void>;
	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome>;
	openInBrowser(urlOrPath: string): void;
	refreshSlashCommandState(cwd?: string): Promise<void>;
	/** Reload session skills and derived `/skill:<name>` commands. */
	refreshSkillState(): Promise<void>;
	applyCwdChange(newCwd: string): Promise<boolean>;

	// Selector handling
	showSettingsSelector(): void;
	showAdvisorConfigure(): void;
	showHistorySearch(): void;
	showExtensionsDashboard(): void;
	showAgentsDashboard(): void;
	/** Open the fullscreen git UI, optionally pinned to a revision (`/git <rev>`). */
	showGitUi(revision?: string): void;
	showModelSelector(options?: { temporaryOnly?: boolean }): void;
	showPluginSelector(mode?: "install" | "uninstall"): void;
	showUserMessageSelector(): void;
	showCopySelector(): void;
	showTreeSelector(): void;
	showSessionSelector(source?: ForeignSessionSource): void;
	handleResumeSession(sessionPath: string): Promise<void>;
	handleSessionDeleteCommand(): Promise<void>;
	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void>;
	showSessionPinSelector(): Promise<void>;
	showResetUsageSelector(): Promise<void>;
	showProviderSetup(): Promise<void>;
	showHookConfirm(title: string, message: string): Promise<boolean>;
	showDebugSelector(): Promise<void>;
	showAgentHub(options?: { requireContent?: boolean; armCloseTap?: boolean }): void;
	resetObserverRegistry(): void;

	// Input handling
	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;
	/** Re-query terminal appearance for an explicit display reset, then immediately replay the display. */
	resetDisplayAfterAppearanceRefresh(): void;
	handleDequeue(): void;
	handleImagePaste(): Promise<boolean>;
	/** Queue a message for delivery only after the active agent turn would stop. */
	handleQueueCommand(message: string): Promise<void>;
	handleBtwCommand(question: string): Promise<void>;
	handleTanCommand(work: string): Promise<void>;
	hasActiveBtw(): boolean;
	handleBtwEscape(): boolean;
	handleBtwBranchKey(): Promise<boolean>;
	canBranchBtw(): boolean;
	handlesBtwBranchKey(): boolean;
	canCopyBtw(): boolean;
	handleBtwCopyKey(): Promise<boolean>;
	handleBtwBranch(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<void>;
	handleOmfgCommand(complaint: string): Promise<void>;
	hasActiveOmfg(): boolean;
	handleOmfgEscape(): boolean;
	handleCleanseCommand(args: string): Promise<void>;
	hasActiveCleanse(): boolean;
	handleCleanseEscape(): boolean;
	cycleThinkingLevel(): void;
	cycleRoleModel(direction?: "forward" | "backward"): Promise<void>;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
	toggleThinkingBlockVisibility(): void;
	handlePlanModeCommand(
		initialPrompt?: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean>;
	handleVibeModeCommand(
		initialPrompt?: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean>;
	handleGoalModeCommand(rest?: string, input?: Pick<SubmittedUserInput, "images" | "imageLinks">): Promise<boolean>;
	handleGuidedGoalCommand(rest?: string, input?: Pick<SubmittedUserInput, "images" | "imageLinks">): Promise<boolean>;
	handleLoopCommand(args?: string): Promise<string | undefined>;
	setLoopPrompt(prompt: string): void;
	disableLoopMode(message?: string): void;
	cancelGoalContinuation(): void;
	disableGoalMode(message?: string): void;
	pauseLoop(): void;
	handlePlanApproval(details: PlanApprovalDetails): Promise<void>;
	openPlanReview(): Promise<void>;

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void>;
	/**
	 * The live `ExtensionUIContext` (picker/dialog primitives) used for tool
	 * execution, `undefined` before hooks have initialized. `/tree` `ask`
	 * re-answer (issue #5642) reuses it to drive a standalone
	 * `AskTool.execute()` call.
	 */
	getToolUIContext(): ExtensionUIContext | undefined;
	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void>;
	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
	setHookStatus(key: string, text: string | undefined): void;
	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
	): Promise<string | undefined>;
	hideHookSelector(): void;
	showHookInput(title: string, placeholder?: string): Promise<string | undefined>;
	hideHookInput(): void;
	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;
	hideHookEditor(): void;
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void;
	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: ExtensionCustomOptions,
	): Promise<T>;
	showExtensionError(extensionPath: string, error: string): void;
	showToolError(toolName: string, error: string): void;
}
