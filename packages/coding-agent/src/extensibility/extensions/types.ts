/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */

import type { type as ArkType } from "@oh-my-pi/omptype";
import type * as TypeBox from "@oh-my-pi/omptype/typebox";
import type * as zod from "@oh-my-pi/omptype/zod";
import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolApproval,
	ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	ModelSpec,
	ProviderResponseMetadata,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	SimpleStreamOptions,
	Static,
	TextContent,
	TSchema,
	UsageProvider,
} from "@oh-my-pi/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	ComposerStyle,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@oh-my-pi/pi-tui";
import type { logger as PiLogger } from "@oh-my-pi/pi-utils";
import type { KeybindingsManager } from "../../config/keybindings";
import type { ModelRegistry } from "../../config/model-registry";
import type { EditToolDetails } from "../../edit";
import type { PythonResult } from "../../eval/py/executor";
import type { BashResult } from "../../exec/bash-executor";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type * as PiCodingAgent from "../../index";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { MemoryRuntimeContext } from "../../memory-backend";
import type { CustomEditor } from "../../modes/components/custom-editor";
import type { Theme } from "../../modes/theme/theme";
import type { AsyncJobSnapshot } from "../../session/agent-session";
import type { CompactMode } from "../../session/compact-modes";
import type { CustomMessage, CustomMessagePayload } from "../../session/messages";
import type { ReadonlySessionManager, SessionManager } from "../../session/session-manager";
import type {
	BashToolDetails,
	BashToolInput,
	GlobToolDetails,
	GlobToolInput,
	GrepToolDetails,
	GrepToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../../tools";
import type { ApprovalMode } from "../../tools/approval";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import type { EventBus } from "../../utils/event-bus";
import type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	ContextEvent,
	GoalUpdatedEvent,
	RetryFallbackAppliedEvent,
	RetryFallbackSucceededEvent,
	SessionBeforeBranchEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionBranchEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
	SessionEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionStopEvent,
	SessionStopEventResult,
	SessionSwitchEvent,
	SessionTreeEvent,
	TodoReminderEvent,
	ToolCallEventResult,
	ToolResultEventResult,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";
import type { SlashCommandInfo } from "../slash-commands";

export type { OverlayHandle, OverlayOptions } from "@oh-my-pi/pi-tui";
export type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";
export type { ExecOptions, ExecResult } from "../../exec/exec";
export type { AgentToolResult, AgentToolUpdateCallback };

// ============================================================================
// UI Context
// ============================================================================

export interface ExtensionUISelectOption {
	label: string;
	description?: string;
}

export type ExtensionUISelectItem = string | ExtensionUISelectOption;

export interface ExtensionAskDialogOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface ExtensionAskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: ExtensionAskDialogOption[];
	multi?: boolean;
	recommended?: number;
}

export interface ExtensionAskDialogResultItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
}

export interface ExtensionAskDialogSubmitResult {
	kind: "submit";
	results: ExtensionAskDialogResultItem[];
}

/** Chat-redirect result: the user chose "Chat about this" instead of
 *  answering. Distinct from `undefined` (cancel) so AskTool can hand off to
 *  the chat loop rather than aborting. */
export interface ExtensionAskDialogChatResult {
	kind: "chat";
}

export type ExtensionAskDialogResult = ExtensionAskDialogSubmitResult | ExtensionAskDialogChatResult;

export function getExtensionUISelectOptionLabel(option: ExtensionUISelectItem): string {
	return typeof option === "string" ? option : option.label;
}

/**
 * UI dialog options for extensions.
 */
export interface ExtensionUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
	/** Invoked when the UI times out while waiting for a selection/input */
	onTimeout?: () => void;
	/** Invoked when the UI-managed timeout countdown starts */
	onTimeoutStart?: () => void;
	/** Invoked when user input resets a UI-managed timeout countdown */
	onTimeoutReset?: () => void;
	/** Initial cursor position for select dialogs (0-indexed) */
	initialIndex?: number;
	/** Render an outlined list for select dialogs */
	outline?: boolean;
	/** Invoked when user presses left arrow in select dialogs */
	onLeft?: () => void;
	/** Invoked when user presses right arrow in select dialogs */
	onRight?: () => void;
	/** Invoked when user presses the external editor shortcut in select dialogs */
	onExternalEditor?: () => void;
	/** Optional footer hint text rendered by interactive selector */
	helpText?: string;
	/** Render a leading radio/checkbox marker before each markable option in
	 *  select dialogs (matches the ask transcript). "radio" fills the cursor row
	 *  for single-choice; "checkbox" reflects `checkedIndices` per row for
	 *  multi-select. Options beyond `markableCount` keep the plain cursor. */
	selectionMarker?: "radio" | "checkbox";
	/** For `selectionMarker: "checkbox"`: option indices currently checked. */
	checkedIndices?: readonly number[];
	/** Number of leading options that receive a selection marker; the remaining
	 *  trailing options (e.g. "Other"/"Done" actions) keep the plain cursor.
	 *  Defaults to all options when `selectionMarker` is set. */
	markableCount?: number;
}

/** Raw terminal input listener for extensions. */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

export type ExtensionUiComponent = Component & { dispose?(): void };
export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;
export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

/** Options for `ExtensionUIContext.custom()` (overlay rendering of a custom component). */
export interface ExtensionCustomOptions {
	/** Render the component as an overlay over the transcript instead of replacing the editor area. */
	overlay?: boolean;
	/** Static or lazily resolved overlay positioning/sizing options forwarded to `showOverlay`. */
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	/** Invoked with the overlay handle once the overlay is created (overlay mode only). */
	onHandle?: (handle: OverlayHandle) => void;
	/** Abort the custom UI and reject its promise. */
	signal?: AbortSignal;
}

/** Wrap the current autocomplete provider with additional behavior (pi-compatible). */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
// fallow-ignore-next-line code-duplication
// Parallel to HookUIContext: extensions expose a strictly larger UI surface
// (custom editor component, header/footer, widgets, theming, terminal input)
// and may be invoked from event handlers that have already taken the agent
// loop's lock — hooks intentionally cannot.
export interface ExtensionUIContext {
	/** True when selector timeouts start only after the dialog is presented. */
	timeoutStartsOnPresentation?: boolean;
	/** Show a selector and return the selected label, even when an option also includes a description. */
	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show the rich ask dialog when the interactive TUI surface is available. */
	askDialog?(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined>;

	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** Set status text in the footer/status bar. Pass undefined to clear. */
	setStatus(key: string, text: string | undefined): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	setWorkingMessage(message?: string): void;

	/** Set a widget to display above or below the editor. Accepts string array or component factory. */
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;

	/** Set a custom footer component, or undefined to restore the built-in footer. */
	setFooter(factory: ExtensionUiComponentFactory | undefined): void;

	/** Set a custom header component, or undefined to restore the built-in header. */
	setHeader(factory: ExtensionUiComponentFactory | undefined): void;

	/** Set the terminal window/tab title. */
	setTitle(title: string): void;

	/** Show a custom component with keyboard focus. */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		options?: ExtensionCustomOptions,
	): Promise<T>;

	/** Set the text in the core input editor. */
	setEditorText(text: string): void;

	/**
	 * Paste text into the core input editor.
	 *
	 * Interactive mode should route through the editor's paste handling (e.g. large paste markers).
	 * Non-interactive modes may fall back to replacing the editor text.
	 */
	pasteToEditor(text: string): void;

	/** Get the current text from the core input editor. */
	getEditorText(): string;

	/** Show a multi-line editor for text editing. */
	editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;

	/**
	 * Stack additional autocomplete behavior on top of the built-in provider
	 * (pi-compatible). Interactive mode rebuilds the editor's provider through
	 * every registered factory, in registration order; headless modes (print,
	 * RPC, ACP, subagents) accept and ignore the factory.
	 */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * Set a custom editor component via factory function, or `undefined` to restore the default editor.
	 *
	 * The factory must return a {@link CustomEditor} subclass. Plain `EditorComponent`/`Editor`
	 * instances do not implement the action-keys, escape callbacks, and custom-key-handler surface
	 * required by interactive mode.
	 */
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;

	/** Get the current theme for styling. */
	readonly theme: Theme;

	/** Get all available themes with names and paths. */
	getAllThemes(): Promise<{ name: string; path: string | undefined }[]>;

	/** Load a theme by name without switching to it. */
	getTheme(name: string): Promise<Theme | undefined>;

	/** Set the current theme by name or Theme object. */
	setTheme(theme: string | Theme): Promise<{ success: boolean; error?: string }>;

	/** Get current tool output expansion state. */
	getToolsExpanded(): boolean;

	/** Set tool output expansion state. */
	setToolsExpanded(expanded: boolean): void;
}

/** Visual composer style and selector copy registered by an extension. */
export interface ComposerShapeDefinition {
	/** User-facing name shown in composer-shape selectors. */
	label: string;
	/** Optional detail shown under the selector label. */
	description?: string;
	/** Renderer contract; its id becomes the persisted `composer.shape` value. */
	style: ComposerStyle;
}

// ============================================================================
// Extension Context
// ============================================================================

export interface ContextUsage {
	/** Estimated context tokens. */
	tokens: number;
	contextWindow: number;
	/** Context usage as percentage of context window. */
	percent: number;
}

export interface CompactOptions {
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
	/**
	 * Force a one-off compaction mode for this invocation, replacing the
	 * configured `compaction.methodOrder` (`/compact soft`, `remote`, or
	 * `snapcompact`). Omitted = configured preference order.
	 */
	mode?: CompactMode;
	/**
	 * Internal summarizer guidance — piped only to native summarization, never
	 * exposed as `customInstructions` on the `session_before_compact` extension
	 * hook. Used by plan-mode "Approve and compact context" so extensions that
	 * treat `customInstructions` as user focus don't mistake plan-mode
	 * boilerplate for the operator's intent (issue #4359).
	 *
	 * When both `customInstructions` and `internalGuidance` are set, the
	 * summarizer uses `internalGuidance`; the hook still sees only the public
	 * `customInstructions`.
	 */
	internalGuidance?: string;
}

/**
 * Context passed to extension event handlers.
 */
// fallow-ignore-next-line code-duplication
// Parallel to HookContext: extensions expose a strictly larger runtime
// surface (model registry, system prompt, shutdown, full session manager
// access). Field overlap is incidental; merging into a base would require
// hooks to widen their public contract.
/**
 * Read-only model query facade exposed at `ctx.models`. Lets an extension select a
 * model the same way core does — list authenticated models, read the session model,
 * resolve a model string or role alias, and compare model families — without reaching
 * into the mutable registry or re-implementing matching/family heuristics.
 */
export interface ExtensionModelQuery {
	/** Authenticated models available this session (the same set `--model` selection sees). */
	list(): Model[];
	/** The current session model, if one is set. */
	current(): Model | undefined;
	/**
	 * Resolve a model string (`provider/id`, bare id) or role alias (`@slow`, a
	 * configured role) to a Model, using the same settings-backed aliases and match
	 * preferences as core selection. Thinking/routing suffixes are accepted and resolved
	 * to the base model (pass effort separately). Returns undefined when nothing matches.
	 */
	resolve(spec: string): Model | undefined;
	/**
	 * Opaque lineage token for "are these the same family?" comparisons — every Claude
	 * point release shares a token, Claude and GPT differ. Backed by catalog canonical
	 * identity. Compare it; do not persist it (the vocabulary tracks new releases).
	 */
	family(model: Model): string;
}

/** Runtime host mode exposed to Pi-compatible extensions. */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionContext {
	/** UI methods for user interaction */
	ui: ExtensionUIContext;
	/** Current run mode. Use `"tui"` to guard terminal-only UI such as custom components. */
	mode: ExtensionMode;
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;
	/** Get a read-only snapshot of async jobs owned by this session. */
	getAsyncJobSnapshot(): AsyncJobSnapshot | null;
	/** Compact the session context (interactive mode shows UI). */
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
	/** Whether UI is available (false in print/RPC mode) */
	hasUI: boolean;
	/** Current working directory */
	cwd: string;
	/** Session manager (read-only) */
	sessionManager: ReadonlySessionManager;
	/** Model registry for API key resolution */
	modelRegistry: ModelRegistry;
	/** Calling session's `local://` root mapping for external tool bridges. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Current model (may be undefined) */
	model: Model | undefined;
	/** Read-only model query facade: list / current / resolve / family. */
	models: ExtensionModelQuery;
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Abort the current agent operation */
	abort(): void;
	/** Whether there are queued messages waiting */
	hasPendingMessages(): boolean;
	/** Gracefully shutdown and exit. */
	shutdown(): void;
	/** Get the current effective system prompt. */
	getSystemPrompt(): string[];
	/** Structured memory runtime for status/search/save across the configured backend. */
	memory?: MemoryRuntimeContext;
	/**
	 * Schedule a repeating callback whose throws are contained. Unlike raw
	 * `setInterval`, a synchronous throw or rejected promise from `callback` is
	 * logged and surfaced through the extension error channel instead of
	 * escaping as a process-fatal `uncaughtException` — one misbehaving timer
	 * can no longer take down the whole session. The handle is `unref`'d and
	 * cleared automatically on `session_shutdown`. Prefer this over raw
	 * `setInterval` for any extension background work.
	 */
	setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer;
	/**
	 * Schedule a one-shot callback whose throws are contained, mirroring
	 * {@link setInterval}. Cleared automatically on `session_shutdown` if it has
	 * not yet fired.
	 */
	setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer;
	/** Clear a timer scheduled via {@link setInterval} or {@link setTimeout}. */
	clearTimer(timer: Timer): void;
	/**
	 * Run the NATIVE built-in implementation of the tool this handler re-registered, with `params`,
	 * and return its result. Lets a tool that re-registers a built-in (e.g. wrapping `write` to add
	 * logging or a policy check) delegate to the original instead of reimplementing it — the native
	 * tool performs its own side effects and internal bookkeeping.
	 *
	 * Delegation is same-tool only: it invokes the built-in of the SAME name as the registering tool,
	 * never an arbitrary target, so it cannot escalate past the approval already granted for this
	 * call. Present only when a native built-in of that name exists (undefined otherwise, e.g. for a
	 * net-new tool that shadows no built-in). Recursion is depth-guarded per call chain.
	 */
	invokeTool?<TDetails = unknown>(
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback<TDetails> },
	): Promise<AgentToolResult<TDetails>>;

	/**
	 * Whether project-local inputs for the current working directory (extensions, settings,
	 * skills, resources) are trusted. Upstream `@earendil-works/pi-coding-agent` (>=0.79) asks the
	 * user once per directory before loading project-local inputs and exposes the saved decision
	 * here; extensions written against that API (e.g. Plannotator) feature-detect this method to
	 * decide whether project-local config is safe to load, and warn when it is absent.
	 *
	 * OMP has no equivalent per-directory trust gate: `.omp/extensions`, `.omp/config.yml`, and
	 * other project-local inputs are already discovered and loaded unconditionally (see
	 * `docs/extension-loading.md`). This method exists for compatibility with that upstream surface
	 * and always returns `true`, truthfully reflecting that OMP already trusts project-local inputs
	 * by default -- it does not narrow or widen OMP's own security model.
	 */
	isProjectTrusted(): boolean;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
// fallow-ignore-next-line code-duplication
// Parallel to HookCommandContext: same method names, different invariants —
// extension commands additionally permit `switchSession` and `reload`,
// which hooks must not call to avoid deadlocking the agent loop.
export interface ExtensionCommandContext extends ExtensionContext {
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;

	/** Wait for the agent to finish streaming */
	waitForIdle(): Promise<void>;

	/** Start a new session, optionally with initialization. */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** Branch from a specific entry, creating a new session file. */
	branch(entryId: string): Promise<{ cancelled: boolean }>;

	/** Navigate to a different point in the session tree. */
	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;

	/** Switch to a different session file. */
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;

	/** Reload the current session/runtime state. */
	reload(): Promise<void>;

	/** Compact the session context (interactive mode shows UI). */
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
}

// ============================================================================
// Tool Types
// ============================================================================

/** Rendering options for tool results */
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/** Session event for tool onSession lifecycle */
export interface ToolSessionEvent {
	/** Reason for the session event */
	reason: "start" | "switch" | "branch" | "tree" | "shutdown";
	/** Previous session file path, or undefined for "start" and "shutdown" */
	previousSessionFile: string | undefined;
}

/** Shell invocation details supplied to a registered tool's environment hook. */
export interface ToolShellEnvironmentContext {
	command: string;
	cwd: string;
	env: Record<string, string | undefined>;
}

/** Supplies environment values for a user-initiated shell invocation. */
export type ToolShellEnvironmentHook = (context: ToolShellEnvironmentContext) => Record<string, string> | undefined;

/**
 * Tool definition for registerTool().
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	/** Tool name (used in LLM tool calls) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** Description for LLM */
	description: string;
	/** Parameter schema (Zod, or TypeBox for legacy/extension compat). */
	parameters: TParams;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool is registered but not auto-included in the initial active set.
	 *  The registering extension is responsible for activating/deactivating it via setActiveTools(). */
	defaultInactive?: boolean;
	/** How this tool is presented when enabled. See {@link ToolLoadMode}. Extension tools default to `"discoverable"`; set `"essential"` to stay top-level. */
	loadMode?: ToolLoadMode;
	/** If true, tool may stage deferred changes that require explicit resolve/discard. */
	deferrable?: boolean;
	/** Tool approval tier. Defaults to `"exec"` when omitted.
	 *  `"read"`: read-only operations. `"write"`: mutations. `"exec"`: code execution. */
	approval?: ToolApproval;
	/** Structured-output strict grammar opt-in/out. `false` is meaningful: OpenAI-family
	 *  serializers preserve an explicit `strict: false` on the wire (#4336/#4340). */
	strict?: boolean;
	/** MCP server name for discovery/search metadata when this tool fronts an MCP server. */
	mcpServerName?: string;
	/** Original MCP tool name for discovery/search metadata. */
	mcpToolName?: string;
	/** Optional environment hook applied when the interactive user shell invokes this tool's shell surface. */
	shellEnv?: ToolShellEnvironmentHook;
	/** Authoritative originating file for a discovered custom-tool module. */
	sourcePath?: string;
	/** Execute the tool. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** Called on session lifecycle events - use to reconstruct state or cleanup resources */
	onSession?: (event: ToolSessionEvent, ctx: ExtensionContext) => void | Promise<void>;

	/** Custom rendering for tool call display */
	renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component;

	/** Custom rendering for tool result display */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}

/** Whether a tool's source is scoped to the user, the project, or a transient runtime session. */
export type SourceScope = "user" | "project" | "temporary";

/** Whether a tool's source came from an installed package or a top-level (loose) file. */
export type SourceOrigin = "package" | "top-level";

/**
 * Provenance metadata describing where a registered tool came from. Mirrors the
 * `@earendil-works/pi-coding-agent` `SourceInfo` contract so extensions authored
 * against upstream pi (e.g. gentle-pi) can read `sourceInfo.source` unchanged.
 */
export interface SourceInfo {
	/** Synthetic or on-disk identifier for the tool's origin (e.g. `<builtin:read>`). */
	path: string;
	/** Origin class: `"builtin"`, `"sdk"`, `"mcp"`, or `"extension"`. */
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
}

/** Tool metadata returned by {@link ExtensionAPI.getAllTools}: identity, schema, and source provenance. */
export interface ToolInfo {
	name: string;
	description: string;
	parameters: TSchema;
	promptGuidelines?: string[];
	sourceInfo: SourceInfo;
}

// ============================================================================
// Resource Events
// ============================================================================

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** Result from resources_discover event handler */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// Session Events (shared with hooks subsystem)
// ============================================================================

export type {
	SessionBeforeBranchEvent,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionBranchEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	TreePreparation,
} from "../shared-events";

// ============================================================================
// Agent Events
// ============================================================================

export type { ContextEvent } from "../shared-events";

/** Fired before a provider request is sent. Can replace the payload. */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/** Fired after a provider response is received, before its stream body is consumed. */
export interface AfterProviderResponseEvent extends ProviderResponseMetadata {
	type: "after_provider_response";
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string[];
}

export type {
	AgentEndEvent,
	AgentStartEvent,
	SessionStopEvent,
	SessionStopEventResult,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/**
 * Fired when a message ends. Notification-only: the message is a detached
 * snapshot, so in-place changes do not rewrite agent or provider context.
 */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** Fired when a tool starts executing */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult: unknown;
}

/** Fired when a tool finishes executing */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

export type {
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	RetryFallbackAppliedEvent,
	RetryFallbackSucceededEvent,
	TodoReminderEvent,
	TtsrTriggeredEvent,
} from "../shared-events";

/** Fired when AuthStorage automatically soft-disables a credential (e.g. OAuth `invalid_grant`). Not fired for user-initiated `remove()` or duplicate-credential dedup. */
export interface CredentialDisabledEvent {
	type: "credential_disabled";
	/** Provider id whose credential was disabled (e.g. "anthropic"). */
	provider: string;
	/** Verbatim error captured for forensics (truncated upstream). */
	disabledCause: string;
}

// ============================================================================
// MCP Events
// ============================================================================

/**
 * Fired for every JSON-RPC notification received from a connected MCP server,
 * AFTER the runtime's own handling of known list/update methods. Unknown or
 * server-custom methods are delivered too — extensions can bridge them into
 * session behavior by inspecting `method`/`params` and injecting a follow-up
 * via `pi.sendMessage(..., { deliverAs })` or `pi.sendUserMessage(...)`.
 */
export interface McpNotificationEvent {
	type: "mcp_notification";
	/**
	 * Server name as declared in the MCP config (raw, unsanitized). Note this
	 * differs from the sanitized prefix used in `mcp__<sanitized_server>_<tool>`
	 * tool names — filter by this raw name, not by tool-name prefix matching.
	 */
	server: string;
	/** JSON-RPC method (e.g. `notifications/tools/list_changed`, or server-custom). */
	method: string;
	/** JSON-RPC params, opaque to the runtime. */
	params: unknown;
}

// ============================================================================
// User Bash Events
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix */
export interface UserBashEvent {
	type: "user_bash";
	/** The command to execute */
	command: string;
	/** True if !! prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// User Python Events
// ============================================================================

/** Fired when user executes Python code via $ or $$ prefix */
export interface UserPythonEvent {
	type: "user_python";
	/** The Python code to execute */
	code: string;
	/** True if $$ prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// Input Events
// ============================================================================

/** Fired when the user submits input (interactive mode only). */
export interface InputEvent {
	type: "input";
	text: string;
	images?: ImageContent[];
	source: "interactive" | "rpc" | "extension";
}

// ============================================================================
// Tool Events
// ============================================================================

export interface ToolApprovalRequestedEvent {
	type: "tool_approval_requested";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	reason?: string;
	approvalMode: ApprovalMode;
}

export interface ToolApprovalResolvedEvent {
	type: "tool_approval_resolved";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	approved: boolean;
	reason?: string;
}

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: Record<string, unknown>;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface GlobToolCallEvent extends ToolCallEventBase {
	toolName: "glob";
	input: GlobToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/** Fired before a tool executes. Can block. */
export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| GlobToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface GlobToolResultEvent extends ToolResultEventBase {
	toolName: "glob";
	details: GlobToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| GlobToolResultEvent
	| CustomToolResultEvent;

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "glob", event: ToolCallEvent): event is GlobToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** Union of all event types */
export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| SessionStopEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| RetryFallbackAppliedEvent
	| RetryFallbackSucceededEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| GoalUpdatedEvent
	| CredentialDisabledEvent
	| McpNotificationEvent
	| UserBashEvent
	| UserPythonEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent
	| ToolApprovalRequestedEvent
	| ToolApprovalResolvedEvent;

// ============================================================================
// Event Results
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export type { ToolCallEventResult } from "../shared-events";

/** Result from input event handler */
export interface InputEventResult {
	/** If true, the input was handled and should not continue through normal flow */
	handled?: boolean;
	/** Replace the input text */
	text?: string;
	/** Replace any pending images */
	images?: ImageContent[];
}

/** Result from user_bash event handler */
export interface UserBashEventResult {
	/** Full replacement: extension handled execution, use this result */
	result?: BashResult;
}

/** Result from user_python event handler */
export interface UserPythonEventResult {
	/** Full replacement: extension handled execution, use this result */
	result?: PythonResult;
}

export type { ToolResultEventResult } from "../shared-events";

export interface BeforeAgentStartEventResult {
	message?: CustomMessagePayload;
	/** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
	systemPrompt?: string[];
}

export type {
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
} from "../shared-events";

// ============================================================================
// Message Rendering
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface AssistantThinkingRenderContext {
	contentIndex: number;
	thinkingIndex: number;
	text: string;
	requestRender(): void;
}

export type AssistantThinkingRenderer = (
	context: AssistantThinkingRenderContext,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// Command Registration
// ============================================================================

// fallow-ignore-next-line code-duplication
// Parallel to HookAPI's RegisteredCommand: extensions add
// `getArgumentCompletions` and bind handlers to ExtensionCommandContext.
export interface RegisteredCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ============================================================================
// Extension API
// ============================================================================

/** Handler function type for events */
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/** Service tiers accepted by each provider family. */
export type ExtensionServiceTier<Family extends ServiceTierFamily> = Family extends "anthropic"
	? "priority"
	: Family extends "google"
		? "flex" | "priority"
		: ServiceTier;

/**
 * ExtensionAPI passed to extension factory functions.
 */
export interface ExtensionAPI {
	// =========================================================================
	// Module Access
	// =========================================================================

	/** File logger for error/warning/debug messages */
	logger: typeof PiLogger;

	/** Injected TypeBox shim for legacy `Type.Object(...)` parameter authoring. */
	typebox: typeof TypeBox;

	/** Injected omptype schema builder for extension tools. */
	arktype: typeof ArkType;

	/** Injected Zod-compatible omptype builder for extension tools. */
	zod: typeof zod;

	/** Injected pi-coding-agent exports for accessing SDK utilities */
	pi: typeof PiCodingAgent;

	// =========================================================================
	// Event Subscription
	// =========================================================================

	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(
		event: "session_before_branch",
		handler: ExtensionHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>,
	): void;
	on(event: "session_branch", handler: ExtensionHandler<SessionBranchEvent>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session.compacting", handler: ExtensionHandler<SessionCompactingEvent, SessionCompactingResult>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "session_stop", handler: ExtensionHandler<SessionStopEvent, SessionStopEventResult>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "auto_compaction_start", handler: ExtensionHandler<AutoCompactionStartEvent>): void;
	on(event: "auto_compaction_end", handler: ExtensionHandler<AutoCompactionEndEvent>): void;
	on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartEvent>): void;
	on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndEvent>): void;
	on(event: "retry_fallback_applied", handler: ExtensionHandler<RetryFallbackAppliedEvent>): void;
	on(event: "retry_fallback_succeeded", handler: ExtensionHandler<RetryFallbackSucceededEvent>): void;
	on(event: "ttsr_triggered", handler: ExtensionHandler<TtsrTriggeredEvent>): void;
	on(event: "todo_reminder", handler: ExtensionHandler<TodoReminderEvent>): void;
	on(event: "goal_updated", handler: ExtensionHandler<GoalUpdatedEvent>): void;
	on(event: "credential_disabled", handler: ExtensionHandler<CredentialDisabledEvent>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	on(event: "tool_approval_requested", handler: ExtensionHandler<ToolApprovalRequestedEvent>): void;
	on(event: "tool_approval_resolved", handler: ExtensionHandler<ToolApprovalResolvedEvent>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "user_python", handler: ExtensionHandler<UserPythonEvent, UserPythonEventResult>): void;
	on(event: "mcp_notification", handler: ExtensionHandler<McpNotificationEvent>): void;

	// =========================================================================
	// Tool Registration
	// =========================================================================

	/** Register a tool that the LLM can call. */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;

	/**
	 * Register a fallback writer consulted when a native `write`/`edit` byte-write is
	 * denied with a permission error (`EPERM`/`EACCES`/`EROFS`). Every other write
	 * error is unaffected. Handlers run in registration order; the first one to
	 * resolve `true` counts as the bytes being durably on disk, and the native tool
	 * continues as if its own write had succeeded — including recording its file
	 * snapshot under the real destination path, so a later hashline `edit` on that
	 * path keeps working. Intended for a host embedding the agent inside a sandbox
	 * that denies direct filesystem writes but exposes a privileged write channel.
	 *
	 * A denial that `Bun.write` masks as `ENOENT` — a write into a directory the host
	 * may not create — also diverts here, with `req.dst`'s parent absent and the
	 * handler responsible for creating it.
	 *
	 * `req.dst` is symlink-RESOLVED: the path the failed write itself acted on, not
	 * the one the tool was given. A link anywhere in a lexical path redirects the
	 * bytes while still passing a prefix allowlist, so treat `req.dst` as
	 * authoritative. A destination that cannot be resolved is never brokered.
	 *
	 * Call this during extension load, like the other `register*` methods: handlers
	 * are installed when the runner initializes, so an extension that has registered
	 * none by then is skipped and a first registration made later never takes effect.
	 *
	 * The underlying registry is process-wide, so a handler may be consulted for a
	 * denied write from any session in the process, not only its own.
	 * `req.sessionId` names the session that issued the write and
	 * `ctx.sessionManager.getSessionId()` names the handler's own; compare them
	 * before prompting, because `ctx.ui` belongs to the latter. See
	 * `docs/extensions.md`.
	 */
	registerFileWriteFallback(handler: FileWriteFallbackHandler): void;

	/**
	 * Register a fallback deleter consulted when a native `edit`/`apply_patch` unlink is
	 * denied with a permission error (`EPERM`/`EACCES`/`EROFS`). Covers `edit`'s `REM`,
	 * the source side of a hashline `MV`, and `apply_patch`'s delete op. Return `true`
	 * once `dst` is gone from disk.
	 *
	 * A handler MUST remove `dst` with a plain unlink and MUST NOT fall back to a
	 * recursive removal. `unlink` on a directory reports `EPERM` on Darwin, so the seam
	 * checks the target before diverting — but when the target's own metadata is behind
	 * the same boundary that denied the unlink, which is the common sandbox case, that
	 * check cannot be resolved and `dst` may be a directory. `req.confirmedFile` says
	 * which situation the handler is in.
	 *
	 * `req.dst` resolves every component ABOVE the last, for the same reason the
	 * write seam resolves all of them; the last is left alone because `unlink`
	 * removes a link rather than its target, so `req.dst` may name a link.
	 *
	 * Separate from {@link registerFileWriteFallback} on purpose. A write handler
	 * brokers `req.content` to `req.dst`, so a delete request reaching it with no
	 * content invites brokering an empty write and truncating the file instead of
	 * removing it. Registering for deletes is therefore an explicit opt-in, and the
	 * same load-time and process-wide notes above apply.
	 */
	registerFileDeleteFallback(handler: FileDeleteFallbackHandler): void;

	// =========================================================================
	// Command, Shortcut, Flag Registration
	// =========================================================================

	/** Register a custom command. */
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void;

	/** Register a keyboard shortcut. */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** Register a CLI flag. */
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;

	/** Set the display label for this extension, or set a label on a specific entry. */
	setLabel(entryIdOrLabel: string, label?: string | undefined): void;

	/** Get the value of a registered CLI flag. */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// Message Rendering
	// =========================================================================

	/** Register a custom renderer for CustomMessageEntry. */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	/** Register a renderer for assistant thinking blocks. Rendered after the original thinking text. */
	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void;

	/**
	 * Register a composer shape for the interactive editor.
	 *
	 * Registration happens during extension load. Built-in ids cannot be
	 * replaced; when extensions reuse an id, the later extension wins.
	 */
	registerComposerShape(definition: ComposerShapeDefinition): void;

	// =========================================================================
	// Actions
	// =========================================================================

	/**
	 * Send a custom message to the session.
	 *
	 * `deliverAs: "nextTurn"` keeps the message hidden from the editable pending-message UI.
	 * If `triggerTurn` is also true while the current turn is still unwinding, the session schedules
	 * an internal continuation that consumes the message on the next turn.
	 */
	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/** Send a user prompt: idle starts a turn; streaming queues as steer unless deliverAs is set. */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;

	/** Append a custom entry to the session for state persistence (not sent to LLM). */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	/** Execute a shell command. */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** Get the list of currently active tool names. */
	getActiveTools(): string[];

	/** Get all configured tools (built-in + extension tools) with schema and source metadata. */
	getAllTools(): ToolInfo[];

	/** Set the active tools by name. */
	setActiveTools(toolNames: string[]): Promise<void>;

	/** Get available slash commands in the current session. */
	getCommands(): SlashCommandInfo[];

	/** Set the current model. Returns false if no API key available. */
	setModel(model: Model): Promise<boolean>;

	/** Get current thinking level. */
	getThinkingLevel(): ThinkingLevel | undefined;

	/** Set thinking level for the current session. */
	setThinkingLevel(level: ThinkingLevel): void;

	/** Get a snapshot of the current session's per-family service tiers. */
	getServiceTiers(): Readonly<ServiceTierByFamily>;

	/**
	 * Set one provider family's service tier for subsequent requests, or clear
	 * its session override with `undefined`.
	 */
	setServiceTier<Family extends ServiceTierFamily>(
		family: Family,
		tier: ExtensionServiceTier<Family> | undefined,
	): void;

	/** Get the current session name. */
	getSessionName(): string | undefined;

	/** Set the session name. Persists to the session file. */
	setSessionName(name: string): Promise<void>;

	// =========================================================================
	// Provider Registration
	// =========================================================================

	/**
	 * Register or override a model provider.
	 *
	 * If `models` is provided: replaces all existing models for this provider.
	 * If only `baseUrl` is provided: overrides the URL for existing models.
	 * If `streamSimple` is provided: registers a custom API stream handler.
	 *
	 * @example
	 * // Register a new provider with custom models and streaming
	 * pi.registerProvider("google-vertex-claude", {
	 *   baseUrl: "https://us-east5-aiplatform.googleapis.com",
	 *   apiKey: "GOOGLE_CLOUD_PROJECT",
	 *   api: "vertex-claude-api",
	 *   streamSimple: myStreamFunction,
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4@20250514",
	 *       name: "Claude Sonnet 4 (Vertex)",
	 *       reasoning: true,
	 *       thinking: { mode: "anthropic-adaptive", efforts: ["minimal", "low", "medium", "high"] },
	 *       input: ["text", "image"],
	 *       cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	 *       contextWindow: 200000,
	 *       maxTokens: 64000,
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 */
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * Unregister a provider previously registered by an extension.
	 *
	 * Removes extension-provided models and restores overridden built-in models.
	 * Has no effect when the provider is not registered.
	 */
	unregisterProvider(name: string): void;

	/** Shared event bus for extension communication. */
	events: EventBus;
}

// ============================================================================
// Provider Registration Types
// ============================================================================

/** Configuration for registering a provider via pi.registerProvider(). */
export interface ProviderConfig {
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key or environment variable name. Required when defining models unless oauth is provided. */
	apiKey?: string;
	/** API type identifier. Required when registering streamSimple or when models don't specify one. */
	api?: Api;
	/** Custom streaming function for non-built-in APIs. */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
	/** Optional normalized usage fetcher used by AuthStorage for this provider. */
	usage?: UsageProvider;
	/** OAuth provider for /login support. */
	oauth?: {
		/** Display name in login UI. */
		name: string;
		/** Run the provider login flow and return credentials (or a plain API key) to persist. */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		/** Refresh expired credentials. */
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		/** Convert credentials to an API key string for requests. */
		getApiKey?(credentials: OAuthCredentials): string;
		/** Optional model rewrite hook for credential-aware routing (e.g., enterprise URLs). */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
	/**
	 * Async factory that fetches the live model list from the provider endpoint.
	 * Runs through the same SQLite model-cache as built-in providers (keyed by
	 * provider name, default 24 h TTL). Receives the resolved API key (undefined
	 * when unauthenticated). When combined with `models`, the static models remain as fallbacks
	 * alongside the live catalog.
	 */
	fetchDynamicModels?: (apiKey: string | undefined) => Promise<readonly ProviderModelConfig[]>;
}

/** Configuration for a model within a provider. */
export interface ProviderModelConfig {
	/** Model ID (e.g., "claude-sonnet-4@20250514"). */
	id: string;
	/** Display name (e.g., "Claude Sonnet 4 (Vertex)"). */
	name: string;
	/** API type override for this model. */
	api?: Api;
	/** Whether the model supports extended thinking at all. */
	reasoning: boolean;
	/** Optional canonical thinking capability metadata for per-model effort support. */
	thinking?: Model["thinking"];
	/** Supported input types. */
	input: ("text" | "image")[];
	/** Cost per million tokens. */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Premium Copilot requests charged per user-initiated request. */
	premiumMultiplier?: number;
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Whether Codex requests should prefer WebSocket transport. */
	preferWebsockets?: boolean;
	/** Custom headers for this model. */
	headers?: Record<string, string>;
	/** OpenAI compatibility settings. */
	compat?: ModelSpec<Api>["compat"];
}

/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// ============================================================================
// Loaded Extension Types
// ============================================================================

export interface RegisteredTool<TParams extends TSchema = TSchema, TDetails = unknown> {
	definition: ToolDefinition<TParams, TDetails>;
	extensionPath: string;
}

/** Internal observer invoked when an already-loaded extension registers or replaces a tool. */
export type ToolRegistrationListener = (toolName: string) => void;

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: CustomMessagePayload<T>,
	/**
	 * `deliverAs: "nextTurn"` queues hidden custom context for the next turn.
	 * When paired with `triggerTurn: true` during prompt teardown, the session schedules
	 * an internal continuation without surfacing the message in the editable pending queue.
	 */
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp" },
) => void;

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export type GetActiveToolsHandler = () => string[];

export type GetAllToolsHandler = () => ToolInfo[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => Promise<void>;

export type SetModelHandler = (model: Model) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel | undefined;

export type SetThinkingLevelHandler = (level: ThinkingLevel, persist?: boolean) => void;

export type GetServiceTiersHandler = () => ServiceTierByFamily;

export type SetServiceTierHandler = (family: ServiceTierFamily, tier: ServiceTier | undefined) => void;

/** Shared state created by loader, used during registration and runtime. */
export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	/** Provider registrations queued during extension loading, processed during session initialization */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }>;
	/** Queue a provider registration until initialization, then apply it immediately. */
	registerProvider(name: string, config: ProviderConfig, sourceId: string): void;
	/** Remove a queued or initialized provider registration. */
	unregisterProvider(name: string, sourceId: string): void;
}

/** Action implementations for ExtensionAPI methods. */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setLabel: (targetId: string, label: string | undefined) => void;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
	getServiceTiers?: GetServiceTiersHandler;
	setServiceTier?: SetServiceTierHandler;
	getSessionName: () => string | undefined;
	setSessionName: (name: string) => Promise<void>;
}

/** Actions for ExtensionContext (ctx.* in event handlers). */
export interface ExtensionContextActions {
	getModel: () => Model | undefined;
	isIdle: () => boolean;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (instructionsOrOptions?: string | CompactOptions) => Promise<void>;
	getSystemPrompt: () => string[];
}

/** Actions for ExtensionCommandContext (ctx.* in command handlers). */
export interface ExtensionCommandContextActions {
	getContextUsage: () => ContextUsage | undefined;
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	branch: (entryId: string) => Promise<{ cancelled: boolean }>;
	navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
	compact: (instructionsOrOptions?: string | CompactOptions) => Promise<void>;
	switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/** Full runtime = state + actions, including host-compatible service-tier fallbacks. */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {
	getServiceTiers: GetServiceTiersHandler;
	setServiceTier: SetServiceTierHandler;
}

/** Loaded extension with all registered items. */
export interface Extension {
	path: string;
	resolvedPath: string;
	label?: string;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool<any, any>>;
	toolRegistrationListeners?: Set<ToolRegistrationListener>;
	assistantThinkingRenderers: AssistantThinkingRenderer[];
	fileWriteFallbackHandlers: FileWriteFallbackHandler[];
	fileDeleteFallbackHandlers: FileDeleteFallbackHandler[];
	messageRenderers: Map<string, MessageRenderer>;
	composerShapes: Map<string, ComposerShapeDefinition>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/**
 * Imported extension factory detached from any session runtime. The same
 * prepared module may be rebound to multiple session-scoped ExtensionAPI
 * instances without evaluating its module graph again.
 */
export interface PreparedExtension {
	path: string;
	resolvedPath: string;
	factory: ExtensionFactory | null;
	error: string | null;
}

/** Result of loading extensions. */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	runtime: ExtensionRuntime;
	/** Session-independent imported factories safe to rebind in child sessions. */
	preparedExtensions?: PreparedExtension[];
}

// ============================================================================
// Extension Error
// ============================================================================

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
