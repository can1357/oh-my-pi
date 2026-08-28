import type { type as ArkType } from "@oh-my-pi/omptype";
import type * as TypeBox from "@oh-my-pi/omptype/typebox";
import type * as zod from "@oh-my-pi/omptype/zod";
import type { ImageContent, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { logger as PiLogger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { EditToolDetails } from "../../edit";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type * as PiCodingAgent from "../../index";
import type { Theme } from "../../modes/theme/theme";
import type { CustomMessagePayload, HookMessage } from "../../session/messages";
import type { ReadonlySessionManager, SessionManager } from "../../session/session-manager";
import type { BashToolDetails, GlobToolDetails, GrepToolDetails, ReadToolDetails } from "../../tools";
import type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	ContextEvent,
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
	SessionSwitchEvent,
	SessionTreeEvent,
	TodoReminderEvent,
	ToolCallEventResult,
	ToolResultEventResult,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";

// Re-export for backward compatibility
export type { ExecOptions, ExecResult } from "../../exec/exec";

/**
 * UI context for hooks to request interactive UI from the harness.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
// fallow-ignore-next-line code-duplication
// Parallel to ExtensionUIContext: hooks expose a deliberately narrower UI
// surface — no terminal-input listener, no editor component override, no
// theme management — because hooks are invoked from inside the agent loop
// and must not be able to seize ownership of the editor.
export interface HookUIContext {
	/**
	 * Show a selector and return the user's choice.
	 * @param title - Title to display
	 * @param options - Array of string options
	 * @returns Selected option string, or null if cancelled
	 */
	select(title: string, options: string[]): Promise<string | undefined>;

	/**
	 * Show a confirmation dialog.
	 * @returns true if confirmed, false if cancelled
	 */
	confirm(title: string, message: string): Promise<boolean>;

	/**
	 * Show a text input dialog.
	 * @returns User input, or undefined if cancelled
	 */
	input(title: string, placeholder?: string): Promise<string | undefined>;

	/**
	 * Show a notification to the user.
	 */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/**
	 * Set status text in the footer/status bar.
	 * Pass undefined as text to clear the status for this key.
	 * ANSI/VT escape sequences and most control characters are stripped; tabs and newlines become spaces.
	 * Repeated spaces are collapsed and surrounding whitespace is trimmed.
	 * The combined status line is truncated to terminal width.
	 * @param key - Unique key to identify this status (e.g., hook name)
	 * @param text - Status text to display, or undefined to clear
	 */
	setStatus(key: string, text: string | undefined): void;

	/**
	 * Show a custom component with keyboard focus.
	 * The factory receives TUI, theme, and a done() callback to close the component.
	 * Can be async for fire-and-forget work (don't await the work, just start it).
	 *
	 * @param factory - Function that creates the component. Call done() when finished.
	 * @returns Promise that resolves with the value passed to done()
	 *
	 * @example
	 * // Sync factory
	 * const result = await ctx.ui.custom((tui, theme, done) => {
	 *   const component = new MyComponent(tui, theme);
	 *   component.onFinish = (value) => done(value);
	 *   return component;
	 * });
	 *
	 * // Async factory with fire-and-forget work
	 * const result = await ctx.ui.custom(async (tui, theme, done) => {
	 *   const loader = new CancellableLoader(tui, theme.fg("accent"), theme.fg("muted"), "Working...");
	 *   loader.onAbort = () => done(null);
	 *   doWork(loader.signal).then(done);  // Don't await - fire and forget
	 *   return loader;
	 * });
	 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	): Promise<T>;

	/**
	 * Set the text in the core input editor.
	 * Use this to pre-fill the input box with generated content (e.g., prompt templates, extracted questions).
	 * @param text - Text to set in the editor
	 */
	setEditorText(text: string): void;

	/**
	 * Get the current text from the core input editor.
	 * @returns Current editor text
	 */
	getEditorText(): string;

	/**
	 * Show a multi-line editor for text editing.
	 * Supports Ctrl+G to open external editor ($VISUAL or $EDITOR).
	 * @param title - Title describing what is being edited
	 * @param prefill - Optional initial text
	 * @param options - Optional dialog controls such as an abort signal
	 * @param editorOptions - Optional editor behavior; `promptStyle` makes Enter submit and Shift+Enter insert a newline
	 * @returns Edited text, or undefined if cancelled (Escape)
	 */
	editor(
		title: string,
		prefill?: string,
		options?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;

	/**
	 * Get the current theme for styling custom components.
	 */
	readonly theme: Theme;
}

/**
 * Context passed to hook event handlers.
 * For command handlers, see HookCommandContext which extends this with session control methods.
 */
// fallow-ignore-next-line code-duplication
// Parallel to ExtensionContext: hooks see a narrower runtime context (no
// model registry mutation, no system prompt access, no shutdown). The
// overlap in field names is intentional API symmetry; widening hooks to
// match extensions would let hooks call methods that deadlock the agent.
export interface HookContext {
	/** UI methods for user interaction */
	ui: HookUIContext;
	/** Whether UI is available (false in print mode) */
	hasUI: boolean;
	/** Current working directory */
	cwd: string;
	/** Session manager (read-only) - use pi.sendMessage()/pi.appendEntry() for writes */
	sessionManager: ReadonlySessionManager;
	/** Model registry - use for API key resolution and model retrieval */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined if no model is selected yet) */
	model: Model | undefined;
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Abort the current agent operation (fire-and-forget, does not wait) */
	abort(): void;
	/** Whether there are queued messages waiting to be processed */
	hasQueuedMessages(): boolean;
}

/**
 * Extended context for slash command handlers.
 * Includes session control methods that are only safe in user-initiated commands.
 *
 * These methods are not available in event handlers because they can cause
 * deadlocks when called from within the agent loop (e.g., tool_call, context events).
 */
// fallow-ignore-next-line code-duplication
// Parallel to ExtensionCommandContext: hooks intentionally omit
// `switchSession`, `reload`, `compact`, and `getContextUsage` — those are
// safe only from extension command handlers, not from the hook execution
// context.
export interface HookCommandContext extends HookContext {
	/** Wait for the agent to finish streaming */
	waitForIdle(): Promise<void>;

	/**
	 * Start a new session, optionally with a setup callback to initialize it.
	 * The setup callback receives a writable SessionManager for the new session.
	 *
	 * @param options.parentSession - Path to parent session for lineage tracking
	 * @param options.setup - Async callback to initialize the new session (e.g., append messages)
	 * @returns Object with `cancelled: true` if a hook cancelled the new session
	 *
	 * @example
	 * // Handoff: summarize current session and start fresh with context
	 * await ctx.newSession({
	 *   parentSession: ctx.sessionManager.getSessionFile(),
	 *   setup: async (sm) => {
	 *     sm.appendMessage({ role: "user", content: [{ type: "text", text: summary }] });
	 *   }
	 * });
	 */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/**
	 * Branch from a specific entry, creating a new session file.
	 *
	 * @param entryId - ID of the entry to branch from
	 * @returns Object with `cancelled: true` if a hook cancelled the branch
	 */
	branch(entryId: string): Promise<{ cancelled: boolean }>;

	/**
	 * Navigate to a different point in the session tree (in-place).
	 *
	 * @param targetId - ID of the entry to navigate to
	 * @param options.summarize - Whether to summarize the abandoned branch
	 * @returns Object with `cancelled: true` if a hook cancelled the navigation
	 */
	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
}

// ============================================================================
// Session Events (shared with extensions subsystem)
// ============================================================================

export type {
	ContextEvent,
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

/**
 * Event data for before_agent_start event.
 * Fired after user submits a prompt but before the agent loop starts.
 * Allows hooks to inject context that will be persisted and visible in TUI.
 */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** The user's prompt text */
	prompt: string;
	/** Any images attached to the prompt */
	images?: ImageContent[];
}

export type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	TodoReminderEvent,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";

/**
 * Event data for tool_call event.
 * Fired before a tool is executed. Hooks can block execution.
 */
export interface ToolCallEvent {
	type: "tool_call";
	/** Tool name (e.g., "bash", "edit", "write") */
	toolName: string;
	/** Tool call ID */
	toolCallId: string;
	/** Tool input parameters */
	input: Record<string, unknown>;
}

/**
 * Base interface for tool_result events.
 */
interface ToolResultEventBase {
	type: "tool_result";
	/** Tool call ID */
	toolCallId: string;
	/** Tool input parameters */
	input: Record<string, unknown>;
	/** Full content array (text and images) */
	content: (TextContent | ImageContent)[];
	/** Whether the tool execution was an error */
	isError?: boolean;
}

/** Tool result event for bash tool */
export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

/** Tool result event for read tool */
export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

/** Tool result event for edit tool */
export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

/** Tool result event for write tool */
export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

/** Tool result event for grep tool */
export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

/** Tool result event for glob tool */
export interface GlobToolResultEvent extends ToolResultEventBase {
	toolName: "glob";
	details: GlobToolDetails | undefined;
}

/** Tool result event for custom/unknown tools */
export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/**
 * Event data for tool_result event.
 * Fired after a tool is executed. Hooks can modify the result.
 * Use toolName to discriminate and get typed details.
 */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| GlobToolResultEvent
	| CustomToolResultEvent;

/**
 * Union of all hook event types.
 */
export type HookEvent =
	| SessionEvent
	| ContextEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// Event Results
// ============================================================================

/**
 * Return type for context event handlers.
 * Allows hooks to modify messages before they're sent to the LLM.
 */
export interface ContextEventResult {
	/** Modified messages to send instead of the original */
	messages?: Message[];
}

export type { ToolCallEventResult, ToolResultEventResult } from "../shared-events";

/**
 * Return type for before_agent_start event handlers.
 * Allows hooks to inject context before the agent runs.
 */
export interface BeforeAgentStartEventResult {
	/** Message to inject into context (persisted to session, visible in TUI) */
	message?: CustomMessagePayload;
}

export type {
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
} from "../shared-events";

// ============================================================================
// Hook API
// ============================================================================

/**
 * Handler function type for each event.
 * Handlers can return R, undefined, or void (bare return statements).
 */
export type HookHandler<E, R = undefined> = (event: E, ctx: HookContext) => Promise<R | void> | R | void;

export interface HookMessageRenderOptions {
	/** Whether the view is expanded */
	expanded: boolean;
}

/**
 * Renderer for hook messages.
 * Hooks register these to provide custom TUI rendering for their message types.
 */
export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
	theme: Theme,
) => Component | undefined;

/**
 * Command registration options.
 */
// fallow-ignore-next-line code-duplication
// Parallel to extensions' RegisteredCommand: hooks bind to
// HookCommandContext and have no argument-completion hook.
export interface RegisteredCommand {
	name: string;
	description?: string;

	handler: (args: string, ctx: HookCommandContext) => Promise<void>;
}

/**
 * HookAPI passed to hook factory functions.
 * Hooks use pi.on() to subscribe to events and pi.sendMessage() to inject messages.
 */
export interface HookAPI {
	// Session events
	on(event: "session_start", handler: HookHandler<SessionStartEvent>): void;
	on(event: "session_before_switch", handler: HookHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): void;
	on(event: "session_switch", handler: HookHandler<SessionSwitchEvent>): void;
	on(event: "session_before_branch", handler: HookHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>): void;
	on(event: "session_branch", handler: HookHandler<SessionBranchEvent>): void;
	on(
		event: "session_before_compact",
		handler: HookHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session.compacting", handler: HookHandler<SessionCompactingEvent, SessionCompactingResult>): void;
	on(event: "session_compact", handler: HookHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: HookHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: HookHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: HookHandler<SessionTreeEvent>): void;

	// Context and agent events
	on(event: "context", handler: HookHandler<ContextEvent, ContextEventResult>): void;
	on(event: "before_agent_start", handler: HookHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: HookHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: HookHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: HookHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: HookHandler<TurnEndEvent>): void;
	on(event: "auto_compaction_start", handler: HookHandler<AutoCompactionStartEvent>): void;
	on(event: "auto_compaction_end", handler: HookHandler<AutoCompactionEndEvent>): void;
	on(event: "auto_retry_start", handler: HookHandler<AutoRetryStartEvent>): void;
	on(event: "auto_retry_end", handler: HookHandler<AutoRetryEndEvent>): void;
	on(event: "ttsr_triggered", handler: HookHandler<TtsrTriggeredEvent>): void;
	on(event: "todo_reminder", handler: HookHandler<TodoReminderEvent>): void;
	on(event: "tool_call", handler: HookHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: HookHandler<ToolResultEvent, ToolResultEventResult>): void;

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry that
	 * participates in LLM context and can be displayed in the TUI.
	 *
	 * Use this when you want the LLM to see the message content.
	 * For hook state that should NOT be sent to the LLM, use appendEntry() instead.
	 *
	 * @param message - The message object to send, or a string shorthand for visible message content
	 * @param message.customType - Identifier for your hook (used for filtering on reload)
	 * @param message.content - Message content (string or TextContent/ImageContent array)
	 * @param message.display - Whether to show in TUI (true = styled display, false = hidden)
	 * @param message.details - Optional hook-specific metadata (not sent to LLM)
	 * @param message.attribution - Who initiated the message for billing/attribution semantics ("user" | "agent")
	 * @param options.triggerTurn - If true and agent is idle, triggers a new LLM turn. Default: false.
	 *                              If agent is streaming, message is queued and triggerTurn is ignored.
	 * @param options.deliverAs - How to deliver the message: "steer" or "followUp".
	 */
	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
	): void;

	/**
	 * Append a custom entry to the session for hook state persistence.
	 * Creates a CustomEntry that does NOT participate in LLM context.
	 *
	 * Use this to store hook-specific data that should persist across session reloads
	 * but should NOT be sent to the LLM. On reload, scan session entries for your
	 * customType to reconstruct hook state.
	 *
	 * For messages that SHOULD be sent to the LLM, use sendMessage() instead.
	 *
	 * @param customType - Identifier for your hook (used for filtering on reload)
	 * @param data - Hook-specific data to persist (must be JSON-serializable)
	 *
	 * @example
	 * // Store permission state
	 * pi.appendEntry("permissions", { level: "full", grantedAt: Date.now() });
	 *
	 * // On reload, reconstruct state from entries
	 * pi.on("session", async (event, ctx) => {
	 *   if (event.reason === "start") {
	 *     const entries = event.sessionManager.getEntries();
	 *     const myEntries = entries.filter(e => e.type === "custom" && e.customType === "permissions");
	 *     // Reconstruct state from myEntries...
	 *   }
	 * });
	 */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	/**
	 * Register a custom renderer for CustomMessageEntry with a specific customType.
	 * The renderer is called when rendering the entry in the TUI.
	 * Return nothing to use the default renderer.
	 */
	registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void;

	/**
	 * Register a custom slash command.
	 * Handler receives HookCommandContext with session control methods.
	 */
	registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void;

	/**
	 * Execute a shell command and return stdout/stderr/code.
	 * Supports timeout and abort signal.
	 */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** File logger for error/warning/debug messages */
	logger: typeof PiLogger;
	/** Injected TypeBox shim (legacy/compat — prefer `arktype`). */
	typebox: typeof TypeBox;
	/** Injected omptype schema builder for hooks. */
	arktype: typeof ArkType;
	/** Injected Zod-compatible omptype builder for hooks. */
	zod: typeof zod;
	/** Injected pi-coding-agent exports */
	pi: typeof PiCodingAgent;
}

/**
 * Hook factory function type.
 * Hooks export a default function that receives the HookAPI.
 */
export type HookFactory = (pi: HookAPI) => void;

// ============================================================================
// Errors
// ============================================================================

/**
 * Error emitted when a hook fails.
 */
export interface HookError {
	hookPath: string;
	event: string;
	error: string;
}
