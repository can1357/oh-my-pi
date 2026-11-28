import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Model, Usage, UsageReport } from "@oh-my-pi/pi-ai";
import type { Accessor, JSXNode, KeyEvent, Signal, UiNode } from "@oh-my-pi/pi-tui";

import type { TspText, TspTone } from "@oh-my-pi/pi-wire";
import type { CollabController } from "../collab/controller";
import type { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import type { CollabSessionState } from "../collab/protocol";
import type { KeyId } from "../config/keybindings/key-id";
import type { KeybindingsManager } from "../config/keybindings/keybindings";
import type { SpaceHoldHandler } from "../config/keybindings/space-hold";
import type { Settings } from "../config/settings";
import type { AiuTotals } from "../session/aiu-billing";
import type {
	AutocompleteProviderFactory,
	ExtensionCustomFactory,
	ExtensionCustomOptions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type {
	CompactOptions,
	ExtensionLiveSession,
	ExtensionLiveStartOptions,
	ExtensionSessionModes,
	PlanReviewChoice,
	PlanReviewRequestedEvent,
} from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { DialogVim } from "../ui/composer/vim-editor";
import type { MCPManager } from "../mcp";
import type { PlanApprovalDetails } from "../plan-mode/approved-plan";
import type { AgentSession } from "../session/agent-session";
import type { AgentViewSession } from "../session/agent-session-handle";
import type { DroppedPrompt } from "../session/agent-session-types";
import type { CompactMode } from "../session/compact-modes";
import type { ToolActivityMode } from "./settings";
import type { ForeignSessionSource } from "../session/foreign-session-store";
import type { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import type { SessionContinuation } from "../session/session-listing";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import type { CacheInvalidation } from "../session/transcript/cache-invalidation-marker";
import type { BashExecutionMessage, PythonExecutionMessage } from "../session/transcript/messages";
import type { ServedModelMismatch, ServedModelTracker } from "../session/transcript/served-model-marker";
import type { TranscriptEntryLike } from "../session/transcript/transcript-entry";
import type { DictationTarget } from "../stt";
import type { LspStartupServerInfo } from "../tools";
import type { TodoItem, TodoPhase } from "../tools/details/todo";
import type { Composer } from "../ui/composer";
import type {
	DeferredCommandModel,
	HookWidgetsModel,
	HudPillsModel,
	ModelCycleModel,
	ProgressHudModel,
	QueueModel,
	StatusHudModel,
	SubagentHudModel,
	TodoHudModel,
	TrayModel,
	WorkingSpec,
} from "../ui/dock";
import type { HookSelectorProps } from "../ui/overlays/pickers/hook-selector";
import type {
	BlockOptions,
	InputInterceptor,
	OverlayHandle,
	OverlayOptions,
	Shell,
	TranscriptBlock,
} from "../ui/shell";
import type { StatusFacts, StatusLineSettings } from "../ui/status/facts";
import type { ExecRun } from "../ui/transcript/exec-run";
import type { AssistantMessageModel, ToolResultMedia } from "../ui/transcript/messages/assistant-message";
import type { ReadGroup } from "../ui/transcript/read-group";
import type { ToolCall, ToolCallResult } from "../ui/transcript/tool-block";
import type { EventBus } from "../utils/event-bus";
import type { ConfiguredThinkingLevel } from "../utils/render-utils";
import type { BlockedKind } from "../utils/run-status";
import type { TokenRateMeter } from "../utils/token-rate";
import type { TranscriptReplica } from "./interactive/transcript-replica";
import type { EventController } from "./controllers/event-controller";
import type { OAuthManualInputManager } from "./oauth-manual-input";
import type { ConversationPosition } from "./utils/conversation-position";
import type { StatusNoticeAction } from "./view-model/chrome/status-notice";
import type { TrackSegment } from "./view-model/chrome/segment-track";
import type { TurnUsageSummary } from "./view-model/overlays/usage-row";
import type { LoopConditionConfig, LoopLimitRuntime } from "./view-model/status-line/loop";
import type { ContextUsage } from "./view-model/status-line/types";

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
};

/**
 * `/compact` sent with the follow-up key during a run: it runs once the run settles, while the
 * session's branch still continues from the position it was queued at. A switch or tree
 * navigation hands it back to the editor instead.
 */
export type YieldCompaction = ConversationPosition & {
	/** The submitted command, restored to the editor when the request is dequeued. */
	text: string;
	instructions?: string;
	mode?: CompactMode;
};

export type SubmittedUserInput = {
	text: string;
	/** Submission time shared by the optimistic prompt bubble and its persisted turn. */
	submittedAt?: number;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
	customType?: string;
	/** The `.`/`c` continue shortcut: dispatch through `session.resume()` instead of
	 *  prompting with `text`, so no visible user turn is added. */
	resume?: boolean;
	display?: boolean;
	/** Queue intent if the session is (or becomes) busy when this submission is
	 *  dispatched: "steer" (interrupt the active turn) or "followUp" (process after
	 *  it). Normal user Enter carries "steer" to match the streaming-branch Enter;
	 *  background/continuation submits omit it and default to "followUp". */
	streamingBehavior?: "steer" | "followUp";
	/** Prompts sent after this one, in order, as the session prompt's `followUps`. */
	followUps?: string[];
	/** Set by `submitInteractiveInput` for a custom-message submission: the session took it (started a turn or queued it into one). */
	dispatched?: boolean;
	cancelled: boolean;
	started: boolean;
};

/** A dialog that hands typing to the composer: registered by the ExtensionUiController approval, form and ask presenters, read by InputController's image and HTML paste routing. */
export interface ComposerOwner {
	/** The dialog's root node. */
	readonly node: UiNode;
	owns(): boolean;
}

/**
 * The dock's live models, one per HUD. The interactive mode mounts each model's view in its
 * dock slot once at startup; controllers only set the models' signals and callbacks (no slot
 * or render calls). See `src/ui/dock/*` for the fields.
 */
export interface DockModels {
	/** `status` slot: the working row (turn, compaction, retry countdown), the idle retry hint, a
	 *  background compaction (`status.background.run`), the idle tok/s trailer. Prefer the
	 *  context's working-row methods ({@link InteractiveModeContext.showWorking}) over `status.row`. */
	readonly status: StatusHudModel;
	/** `todo` slot (and natively the activity line): the plan. Fed through {@link InteractiveModeContext.setTodos}. */
	readonly todo: TodoHudModel;
	/** `subagents` slot: running agents. `onFocus`/`onToggle` are wired by the interactive mode. */
	readonly subagents: SubagentHudModel;
	/** `pendingMessages` slot: steering / follow-up queue. Fed through {@link InteractiveModeContext.updatePendingMessagesDisplay}. */
	readonly queue: QueueModel;
	/** `modelCycle` slot: the ctrl+p role track. Fed through {@link InteractiveModeContext.showModelCycleTrack}. */
	readonly modelCycle: ModelCycleModel;
	/** `widgetsAbove`/`widgetsBelow` slots: extension widgets. Fed through {@link InteractiveModeContext.setHookWidget}. */
	readonly widgets: HookWidgetsModel;
	/** `progress` slot: judge batches (`progress.judgments`) and downloads (`progress.downloads`). */
	readonly progress: ProgressHudModel;
	/** `deferredCommand` slot: command output waiting for the turn to end ({@link InteractiveModeContext.presentCommandOutput}). */
	readonly deferred: DeferredCommandModel;
	/** Native only, `pills` slot: agents/jobs pills and job widgets. */
	readonly pills: HudPillsModel;
	/** Native only, `tray` slot: background agent and job cards. */
	readonly tray: TrayModel;
}

/** What the composer chrome draws a status bar from. */
export interface StatusLineView {
	/** The current facts (reactive). */
	readonly facts: Accessor<StatusFacts>;
	/** The effective `statusLine.*` settings, a settings-screen preview merged in (reactive). */
	readonly settings: Accessor<StatusLineSettings>;
}

/**
 * The status line's data: one {@link StatusFacts} snapshot the composer chrome and the footer
 * draw, recomputed from the viewed session, settings, git and quota reads.
 */
export interface StatusLineModel extends StatusLineView {
	/** Re-read session-derived facts now (usage, model, context, modes). Replaces `statusLine.invalidate()`. */
	refresh(): void;
	/** Re-read the git/jj facts too: a user `!`/`$` command may have moved HEAD or edited the tree. */
	refreshVcs(): void;
	/** Restart the active-processing clock (new session, `/new`). */
	resetActiveTime(): void;
	/** A turn started (the active clock runs). */
	markActivityStart(): void;
	/** The turn ended (the active clock stops). */
	markActivityEnd(): void;
	/** An extension status by key (`undefined` removes it). */
	setHookStatus(key: string, text: string | undefined): void;
	/** An ask is waiting for the user's answer. */
	setAwaitingAnswer(awaiting: boolean): void;
	/** The collab segment (hosting or joined, participant count); `null` hides it. */
	setCollabStatus(status: CollabStatus | null): void;
	/** The running-subagents badge; returns whether the count changed. */
	setRunningSubagents(agentIds: readonly string[]): boolean;
	/** Read facts from another session (focus switch); `focusedAgentId` names a focused subagent. */
	setSession(session: AgentViewSession, focusedAgentId?: string): void;
	/**
	 * Draw with `settings` merged over the saved `statusLine.*` settings (the settings screen's
	 * live preview); `undefined` drops the preview and re-reads the saved settings.
	 */
	previewSettings(settings: Partial<StatusLineSettings> | undefined): void;
}

/** The collab segment of the status line. */
export interface CollabStatus extends NonNullable<StatusFacts["collab"]> {
	/** Guest only: the host's footer snapshot, overriding locally computed facts (context usage). */
	readonly stateOverride?: CollabSessionState | null;
}

/** What holds the status row's working row. */
export type WorkingKind =
	/** An agent turn (the `Working…` row). */
	| "turn"
	/** Automatic compaction. */
	| "compaction"
	/** A retry countdown after a failed request. */
	| "retry"
	/** A user-started maintenance run (`/compact`, branch summary, handoff). */
	| "maintenance";

/** Options of {@link InteractiveModeContext.present}. */
export interface PresentOptions extends BlockOptions {
	/**
	 * Keep the block live (default: settled at once, so a plain terminal may move it into
	 * scrollback). Settle a live block with `ctx.shell.transcript.settle(block)` once it is final.
	 */
	readonly live?: boolean;
	/** Mount before this block instead of at the transcript's end. */
	readonly before?: TranscriptBlock;
}

/**
 * An assistant reply in the transcript: its block and the signals its {@link AssistantMessageModel}
 * reads. The display settings (thinking visibility, images, expansion) are wired to the
 * context's reactive flags; set these signals for everything per-reply.
 */
export interface AssistantView {
	readonly block: TranscriptBlock;
	readonly model: AssistantMessageModel;
	/** The reply as last updated (streaming deltas included). */
	readonly message: Signal<AssistantMessage | undefined>;
	/** The last update was a streaming delta. */
	readonly transient: Signal<boolean>;
	/** Nothing streams any more (`message_end`); also settles the block. */
	readonly finalized: Signal<boolean>;
	/** Session-resolved destinations of the reply's relative prose links. */
	readonly linkTargets: Signal<ReadonlyMap<string, string>>;
	/** Media grouped reads produced, by tool call id. */
	readonly toolResultMedia: Signal<ReadonlyMap<string, ToolResultMedia>>;
	/** Record the latest media produced by a grouped read. */
	setToolResultMedia(toolCallId: string, media: ToolResultMedia): void;
	readonly cacheInvalidation: Signal<CacheInvalidation | undefined>;
	readonly servedModelMismatch: Signal<ServedModelMismatch | undefined>;
	readonly turnUsage: Signal<TurnUsageSummary | undefined>;
	/** A TTSR rule rewound this partial answer. */
	readonly rewound: Signal<boolean>;
	/** The turn-ending error is pinned above the composer (the inline copy is suppressed while it shows). */
	readonly errorPinned: Signal<boolean>;
	/** Show the whole turn-ending error. */
	readonly errorExpanded: Signal<boolean>;
}

/** A shown `!`/`$` run's presentation. */
export interface ExecRunPresentation {
	/** The run's transcript block; undefined while it waits in the `pendingShell` slot. */
	readonly block: TranscriptBlock | undefined;
	/**
	 * The session recorded the run as `message`: extension transcript presenters see that message
	 * from now on (before, a provisional one built from the run).
	 */
	record(message: BashExecutionMessage | PythonExecutionMessage): void;
}

/** Options of {@link InteractiveModeContext.presentAssistant}. */
export interface PresentAssistantOptions {
	/** Destinations of relative links (default: the viewed session's resolved targets). */
	readonly linkTargets?: ReadonlyMap<string, string>;
	/** Index in the full reply of the segment's first block (a segment drawn after a tool call). */
	readonly contentOffset?: number;
	/** Mount before this block instead of at the transcript's end. */
	readonly before?: TranscriptBlock;
	/** Tone of the reply's prose (`/live`'s spoken reply: accent). */
	readonly tone?: TspTone;
}

/** A tool call about to get its transcript block. */
export interface ToolCallSpec {
	/** Renderer name (`toolRenderName`). */
	readonly name: string;
	readonly args: unknown;
	readonly tool: AgentTool | undefined;
	readonly id: string;
	/** Directory the call's relative paths resolve against. */
	readonly cwd: string;
	/** Wall-clock ms the model made the call (a replayed call's message time); defaults to now. */
	readonly timestamp?: number;
}

/**
 * A tool call's live transcript entry, the value of {@link InteractiveModeContext.pendingTools}.
 * One handle routes events to whichever view draws the call: a tool card ({@link call}), a read
 * group shared by consecutive reads ({@link group}; several ids map to one handle), or a built-in
 * `write` to a reply URL drawn as assistant prose ({@link reply}). Methods taking `toolCallId`
 * address one read of a group; cards and replies ignore it.
 */
export interface PendingTool {
	readonly block: TranscriptBlock;
	readonly call?: ToolCall;
	readonly group?: ReadGroup;
	readonly reply?: AssistantView;
	/** Streamed (or final) args; `timestamp` dates a read joining a group (wall-clock ms, default now). */
	updateArgs(args: unknown, toolCallId: string, timestamp?: number): void;
	/** The edit preview a streaming edit-like call pushes. */
	updateStreamPreview(preview: unknown): void;
	/** A progress frame (`partial`) or the final result. */
	updateResult(result: ToolCallResult, partial: boolean, toolCallId: string): void;
	/** The args are final (message end). */
	setArgsComplete(toolCallId: string): void;
	/** The call began executing. */
	setExecutionStarted(toolCallId: string): void;
	/** The call returned but its background job keeps sending frames into the card. */
	parkAsBackground(): void;
	/** No more events arrive: stop animations and settle the block. */
	seal(): void;
	/**
	 * The streamed call's id changed (minted at stream end): presenters and presentation refreshes
	 * see `newId` from now on. Cards only; a group renames its read with `group.renameEntry`.
	 */
	rename?(newId: string): void;
}

/**
 * What a transcript block shows, for controllers that walk `ctx.shell.transcript.blocks()`
 * (see {@link InteractiveModeContext.transcriptEntry}). Static blocks (notices, markers) have none.
 */
export type TranscriptEntry =
	| { readonly kind: "assistant"; readonly view: AssistantView }
	| { readonly kind: "tool"; readonly tool: PendingTool }
	| { readonly kind: "exec"; readonly run: ExecRun }
	| { readonly kind: "message"; readonly message: AgentMessage };

export interface InteractiveModeInitOptions {
	suppressWelcomeIntro?: boolean;
	clearInitialTerminalHistory?: boolean;
	/** Opt into hosting when the caller owns outer startup readiness and shutdown. */
	autoStartCollab?: boolean;
	/** A command-line prompt runs once startup ends: report `working` from the first frame. */
	startupRun?: boolean;
	/** Host-owned work that can wait until the live composer has had time to handle input. */
	startupBackgroundWork?: () => void;
}

export type InteractiveSelectorDialogOptions = ExtensionUIDialogOptions &
	Pick<HookSelectorProps, "disabledIndices" | "inline">;

/** How {@link InteractiveModeContext.handleResumeSession} picks the file it opens. */
export interface ResumeSessionOptions {
	/**
	 * The user chose this session to resume (picker, `/resume <id>`, welcome
	 * card): when its conversation went on in another file, resume that copy.
	 * Restoring a session the process itself left (collab) opens the path as given.
	 */
	followContinuation?: boolean;
	/**
	 * The copy to resume, already found by the caller (`resolveResumeTarget`):
	 * `sessionPath` is that copy, and the notice names the file it came from.
	 */
	continuation?: SessionContinuation;
}

/** How {@link InteractiveModeContext.applyCwdChange} re-scopes the session and reports memory. */
export interface CwdChangeOptions {
	/** The session returns to a directory after a failed move; see `CwdRescopeOptions.restore`. */
	restore?: boolean;
	/**
	 * Receives the memory warning for the directory the call leaves the session in, at most once per call.
	 * A caller that applies a cwd again during a rollback shows only the last call's warning.
	 */
	onWarning: (warning: string) => void;
}

export interface RenderSessionContextOptions {
	updateFooter?: boolean;
	/** Tool calls whose existing live block remains the sole render owner across a rebuild. */
	preservedLiveToolCallIds?: ReadonlySet<string>;
}

export interface RenderInitialMessagesOptions {
	preserveExistingChat?: boolean;
	clearTerminalHistory?: boolean;
	/**
	 * Called synchronously, once, with the session context the committed transcript was built from.
	 * Not called when a newer replay supersedes this one.
	 */
	onCommit?: (context: SessionContext) => void;
}

/** How {@link InteractiveModeContext.showStatus} shows a notice. */
export interface ShowStatusOptions {
	/** Dims the ANSI line (default true). */
	dim?: boolean;
	/** Toasts it on a native terminal (default true); false keeps it to the ANSI transcript. */
	toast?: boolean;
	/** A button on the native toast (Undo); the ANSI line has none. */
	action?: StatusNoticeAction;
	/**
	 * Names a status that updates in place (the MCP startup line): a later status with the same key rewrites
	 * that line while it is still mutable and only notices sit below it. Otherwise it appends a fresh line,
	 * preserving both unrelated notices and status updates after the original line enters scrollback.
	 * Keyed statuses never collapse with unkeyed ones.
	 */
	key?: string;
	/**
	 * Whether the status collapses into the status line directly above it and lets the next one collapse into it
	 * (default true). False gives it a line of its own: an extension's notice, which must not overwrite or be
	 * overwritten by another source's status.
	 */
	collapse?: boolean;
}

export interface AgentHubOpenOptions {
	requireContent?: boolean;
	armCloseTap?: boolean;
	initialSection?: "agents" | "activity";
	/** The agents-hub key: on a native host showing tray cards, focus moves into the tray instead. */
	trayFirst?: boolean;
}

export interface InteractiveModeContext {
	// UI access
	/**
	 * The UI shell (`src/ui/shell`): `shell.transcript` (blocks: append/insertBefore/settle/
	 * remove/truncate/redraw/blocks()), `shell.dock.slot(name)` (live chrome; `set(factory)` /
	 * `clear()`), `shell.overlays.show(factory, { focus, onClose })` (pickers, sheets, toasts),
	 * `shell.focus(node)` / `shell.focused()`, `shell.native()` (Tern renders natively),
	 * `shell.size()` (terminal cells, reactive) and `shell.host` (driver: capabilities, images,
	 * title, notifications; `host.replayHistory()` rebuilds terminal scrollback).
	 * Rendering is reactive: there is no render request; changing a signal repaints.
	 *
	 * Slots the interactive mode owns (do not `set` them): `composer`, `status`, `todo`,
	 * `subagents`, `pendingMessages`, `pendingShell`, `modelCycle`, `deferredCommand`, `progress`,
	 * `attachments`, `editorGap`, `widgetsAbove`, `widgetsBelow`, `pills`, `tray` (feed {@link hud}
	 * instead). Slots controllers fill: `ask`, `btw`, `omfg`, `cleanse`, `errorBanner` (via
	 * {@link showPinnedError}), `report` (via {@link showCommandReport}).
	 */
	readonly shell: Shell;
	/**
	 * The prompt composer (`src/ui/composer`): draft (`text()`, `setText`, `clearDraft`,
	 * `insertTextAttachment`, `insertAtom`, `pendingImages`, `chips()`), history (`addToHistory`),
	 * `submit()`, state (`setState`, `setFaint`, `setBorderColor`, `setDisableSubmit`, `setSlots`)
	 * and extension hooks (`addKeyHandler` — runs before the composer's own bindings while it has
	 * focus, the home of app editor actions —, `addPasteHandler` — runs before the composer types
	 * or collapses a paste —, `addDecorator`, `setSubmitTransform`, `setShape`).
	 * `composer.field` is the node to focus for typing. Replaces `editor` / `editorContainer`.
	 */
	readonly composer: Composer;
	/** The dock's HUD models (see {@link DockModels}). */
	readonly hud: DockModels;
	/** The status line's facts (see {@link StatusLineModel}); replaces `StatusLineComponent`. */
	readonly statusLine: StatusLineModel;
	/**
	 * The status line row as the composer's shape draws it on a `columns`-wide terminal (its top
	 * chrome's status, or the standalone bar); the settings screen's preview. Undefined before the
	 * status line exists.
	 */
	statusLinePreviewRow(columns: number): string | undefined;
	/**
	 * See every input event (key, paste, mouse) before the focused node: true consumes it, an array
	 * replaces it (the replacements go on through the older interceptors, then the focus path).
	 * Newest interceptor first. Returns its removal. Replaces `ui.addInputListener` (link hints,
	 * double-tap detection, enhanced paste). `shell.input(event)` routes an event the same way.
	 */
	interceptInput(handler: InputInterceptor): () => void;
	/**
	 * Handle keys nothing on the focus path consumed (app-wide shortcuts such as the debug key);
	 * newest handler first until one returns true. Returns its removal.
	 */
	addGlobalKeyHandler(handler: (key: KeyEvent) => boolean): () => void;
	/**
	 * Hand the terminal to `run` (an external editor, Ctrl+Z suspend) and take it back once it
	 * settles; the display is redrawn after. Replaces `ui.stop()` / `ui.start()` pairs.
	 */
	suspend<R>(run: () => Promise<R>): Promise<R>;
	/** The terminal's busy indicator (OSC 9;4 progress) on or off. */
	setTerminalProgress(busy: boolean): void;
	/**
	 * Mount `factory` in the composer's place (an extension select/input/editor/custom view, an
	 * approval or login prompt); focus moves into it unless `options.focus` is false. Closing the
	 * handle puts the composer back and returns focus to it. A newer call closes the older one.
	 * Replaces `editorContainer.clear(); editorContainer.addChild(dialog); ui.setFocus(dialog)`.
	 */
	showEditorAreaDialog(factory: () => JSXNode, options?: OverlayOptions): OverlayHandle;
	/** Show a pin change already written to the pins file; supersedes any in-flight pins-file reload. */
	applySessionPin(sessionId: string, pinned: boolean): void;
	syncComposerShape(): void;
	/**
	 * Push the extension link schemes to the markdown renderer; redraws the transcript when that
	 * changes how links are drawn.
	 */
	syncExtensionLinks(): void;

	// Session access
	session: AgentSession;
	sessionManager: SessionManager;
	/** The current session display name / title. */
	readonly sessionName: string | undefined;
	/** Session the transcript/editor/status are attached to: the focused agent's, else `session`. */
	readonly viewSession: AgentViewSession;
	/** Bind idle maintenance to the given view (default: the current one), or release the UI activity binding on null. */
	syncIdleMaintenanceView(target?: AgentViewSession | null): void;
	/** Id of the focused agent, undefined when the main session is attached. */
	readonly focusedAgentId: string | undefined;
	/** Set while a tool-approval dialog owns the composer: its drafts steer the main session awaiting that approval, even from a focused agent's view. */
	approvalOwnsComposer?: boolean;
	/** The mounted dialog that currently hands typing to the composer, if any. */
	composerOwner?: ComposerOwner;
	/**
	 * An image-accepting prompt in the composer's place (an extension editor that takes images):
	 * image pastes attach there instead of being refused. Set by whoever mounts it.
	 */
	promptPasteTarget?: {
		readonly node: UiNode;
		/** `dims`: the pasted image's size, for its `[Image #N, WxH]` marker. */
		attachImage(image: ImageContent, dims?: { readonly width: number; readonly height: number }): void;
		setText(text: string): void;
	};
	/** Focus the main view on an agent's live session (delegates to SessionFocusController.focusAgent). */
	focusAgentSession(id: string): Promise<void>;
	/** Focus the focused agent's parent session, falling back to main (delegates to focusParent). */
	focusParentSession(): Promise<void>;
	/** Return the view to the main session (delegates to SessionFocusController.unfocus). */
	unfocusSession(): Promise<void>;
	/** Drop pending focus requests without changing the view (delegates to SessionFocusController.invalidatePendingFocus). */
	invalidatePendingFocus(): void;
	/**
	 * Enter keyboard link-hint mode: tag each extension link label on screen; with none on screen,
	 * open the link browser, or show a status when the transcript draws none either. Returns false,
	 * doing nothing, unless extension links are routed (a scheme claimed, plain terminal).
	 */
	startLinkHints(): boolean;
	/** Whether link-hint mode is on; it ends by itself once the tagged labels move or vanish. */
	readonly linkHintsActive: boolean;
	/** Narrow link-hint mode by one typed letter; a whole tag raises `link_activate` for its link. */
	typeLinkHint(letter: string): void;
	/** Leave link-hint mode without activating a link. */
	cancelLinkHints(): void;
	/**
	 * Leave link-hint mode and open the fullscreen link browser over the viewed transcript, where
	 * links already in terminal scrollback can be picked too. Returns false, opening nothing, when
	 * links are not routed, it is already open, or the transcript draws no extension link.
	 */
	openLinkBrowser(): boolean;
	/**
	 * Close the link browser if it is open. An editor-area dialog (an extension's confirm, select,
	 * input, editor or custom UI, or an ask) calls this before mounting, so it is not hidden behind it.
	 */
	closeLinkBrowser(): void;
	/** Redraw the link browser's copy of the reply sent at `timestamp`, if the browser is open. */
	rerenderInLinkBrowser(timestamp: number): void;
	/**
	 * Run `redraw` over `blocks`; it returns whether the block's display changed. Live blocks (and
	 * every block in Tern's native view) just repaint; a changed block with rows already in terminal
	 * scrollback rebuilds the scrollback once for the batch, since a plain terminal cannot repaint
	 * them (deferred while the link browser covers the screen).
	 */
	redrawTranscriptBlocks(
		blocks: Iterable<TranscriptBlock>,
		redraw: (block: TranscriptBlock, entry: TranscriptEntry | undefined) => boolean,
	): void;
	/**
	 * Ask the extension transcript presenters again for every block (only the parts `ids` selects,
	 * when given) and redraw those whose display changed.
	 */
	refreshTranscriptPresentation(ids?: ReadonlySet<string>): void;
	/** Clear working rows, transient HUD/pending slots, streaming state, and pending tools. `viewOnly`
	 *  (focus switch, main session unchanged) keeps the main session's compaction queues. */
	clearTransientSessionUi(options?: { viewOnly?: boolean }): void;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: AgentSession["agent"];
	historyStorage?: HistoryStorage;
	mcpManager?: MCPManager;
	lspServers?: LspStartupServerInfo[];
	/** Owns hosting: manual `/collab`, `collab.autoStart`, and room rotation on session switch. */
	collabController: CollabController;
	/** Owned room; use {@link collabController}.host for current-session reuse and links. */
	collabHost?: CollabHost;
	/** The collab session this process joined as a guest; set with {@link setCollabGuest}. */
	readonly collabGuest?: CollabGuestLink;
	/** Join (`guest`) or leave (`undefined`) a collab session as a guest. */
	setCollabGuest(guest: CollabGuestLink | undefined): void;
	eventController: EventController;
	eventBus?: EventBus;
	/** Root-scoped bus carrying this session tree's `task:subagent:*` frames. */
	subagentEventBus?: EventBus;

	// State
	isInitialized: boolean;
	/**
	 * `true` once `renderInitialMessages` has rendered the session transcript
	 * into `shell.transcript` at least once.
	 *
	 * Extension chat-rebuilds (`ExtensionUiController.#applyCustomMessageDisplay`)
	 * are gated on this: rebuilding before the initial render would plant a
	 * session-derived component into the chat that `renderInitialMessages` then
	 * both re-renders from session entries AND re-appends via
	 * `preserveExistingChat`, duplicating the message (issue #1955).
	 */
	initialChatRendered: boolean;
	isBashMode: boolean;
	/**
	 * Ctrl+O: tool output, read groups, `!`/`$` runs and expandable messages show in full.
	 * Reactive like every display flag below ({@link toolActivity}, {@link hideThinkingBlock},
	 * {@link proseOnlyThinking}, {@link expandThinkingBlocks}): assigning it repaints every live
	 * block that reads it; blocks already in terminal scrollback keep their rows until the
	 * scrollback is rebuilt (`shell.host?.replayHistory()`). No walking blocks to push it.
	 */
	toolOutputExpanded: boolean;
	/** How tool activity shows: `display.toolActivity` (reactive, see {@link toolOutputExpanded}). */
	toolActivity: ToolActivityMode;
	todoExpanded: boolean;
	planModeEnabled: boolean;
	vibeModeEnabled: boolean;
	goalModeEnabled: boolean;
	goalModePaused: boolean;
	loopModeEnabled: boolean;
	loopModePaused: boolean;
	loopPrompt?: string;
	loopLimit?: LoopLimitRuntime;
	loopCondition?: LoopConditionConfig;
	planModePlanFilePath?: string;
	/** Ctrl+T: thinking hidden (reactive, see {@link toolOutputExpanded}). */
	hideThinkingBlock: boolean;
	/**
	 * Effective thinking-block visibility: true when hidden by user setting OR
	 * thinking level is "off" before the session has produced displayable
	 * thinking content.
	 */
	readonly effectiveHideThinkingBlock: boolean;
	readonly assistantImagesVisible: boolean;
	/** Whether the viewed session's tables get charts: the main session's do, a focused subagent's do not. */
	readonly tableChartsVisible: boolean;
	resolveAssistantMessageLinkHrefs(hrefs: readonly string[]): Promise<ReadonlyMap<string, string>>;
	/** Whether this visible session has produced thinking content the user can reveal. */
	readonly hasDisplayableThinkingContent: boolean;
	/** Record a message whose thinking content makes Ctrl+T meaningful even at thinking level "off"; returns true on first observation. */
	noteDisplayableThinkingContent(message: AgentMessage): boolean;
	/** Elide fenced code in thinking (reactive). */
	proseOnlyThinking: boolean;
	/** Keep finished thinking expanded (reactive). */
	expandThinkingBlocks: boolean;
	compactionQueuedMessages: CompactionQueuedMessage[];
	/** Compaction queued for the next yield; follow-ups sent after it wait in `compactionQueuedMessages`. */
	yieldCompaction: YieldCompaction | undefined;
	/** While a queued compaction runs, the conversation the input it held in `compactionQueuedMessages`
	 *  belongs to; checked when that input is flushed. */
	compactionQueueOrigin: ConversationPosition | undefined;
	/** The block showing each rendered message (user, assistant, custom, summaries). Replaces `transcriptMessageComponents`. */
	transcriptBlocks: WeakMap<AgentMessage, TranscriptBlock>;
	/** Live tool calls by tool call id (several read ids share one group handle). */
	pendingTools: Map<string, PendingTool>;
	/** The user `!` run in progress, if any (its block draws it). */
	bashRun: ExecRun | undefined;
	/** The user `$` run in progress, if any. */
	pythonRun: ExecRun | undefined;
	isPythonMode: boolean;
	/** The draft starts with `?`, the `/btw` shortcut. */
	isBtwMode: boolean;
	/** The assistant reply streaming now (its block, model and signals); replaces `streamingComponent`. */
	streaming: AssistantView | undefined;
	streamingMessage: AssistantMessage | undefined;
	/**
	 * Usage of the most recently rendered assistant turn, used to detect a
	 * prompt-cache invalidation on the next turn (cache footprint collapse).
	 * Reseeded by `renderSessionContext` on every rebuild/session switch.
	 */
	lastAssistantUsage: Usage | undefined;
	/**
	 * Remembers which (requested → served) model substitutions this transcript
	 * has already flagged, so the served-model divider appears once per pair.
	 * Replaced by `renderSessionContext` on every rebuild/session switch.
	 */
	servedModelTracker: ServedModelTracker;
	/** Live gen tok/s for the working row; fed by streamed deltas, reset per run. */
	tokenRate: TokenRateMeter;
	/**
	 * What holds the status row's working row, undefined while none does (the idle retry hint and
	 * a background compaction, `hud.status.background.run`, are not working rows). Replaces the
	 * `loadingAnimation` / `autoCompactionLoader` / `retryLoader` checks.
	 */
	readonly working: WorkingKind | undefined;
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
	/** True once a graceful `shutdown()` teardown failed at the dispose stage,
	 *  so the next single Ctrl+C must escape (force-quit) rather than re-run the
	 *  doomed teardown or merely clear the editor (#12238). */
	readonly teardownFailed: boolean;
	/** The extension select dialog in the composer's place ({@link showEditorAreaDialog}), if open. */
	hookSelector: OverlayHandle | undefined;
	/** The extension input dialog in the composer's place, if open. */
	hookInput: OverlayHandle | undefined;
	/** The extension editor dialog in the composer's place, if open. */
	hookEditor: OverlayHandle | undefined;
	fileSlashCommands: Set<string>;
	skillCommands: Map<string, Skill>;
	oauthManualInput: OAuthManualInputManager;
	todoPhases: TodoPhase[];

	// Lifecycle
	init(options?: InteractiveModeInitOptions): Promise<void>;
	playWelcomeIntro(): void;
	/** Close and quit. Operator quits are cancellable by extensions; pass `cancellable: false` for forced closes. */
	shutdown(options?: { cancellable?: boolean }): Promise<void>;
	/** Restart with the original launch flags, resuming this session. Refuse if the working directory was removed. */
	restart(): Promise<void>;
	/** Request graceful shutdown at the next fully settled boundary, including background turns. */
	requestShutdown(): void;
	checkShutdownRequested(): Promise<void>;

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
	/** Stack extension autocomplete behavior on top of the built-in editor provider. */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	// Transcript
	/**
	 * Mount a transcript block: the single sink for "show this in chat". `factory` runs once in
	 * the block's own reactive root (its effects and timers live until the block is removed) and
	 * must build exactly one node. Settled at once unless `options.live`.
	 */
	present(factory: () => JSXNode, options?: PresentOptions): TranscriptBlock;
	/**
	 * Mount command output now while idle or on a Tern surface, or defer it (shown in the
	 * `deferredCommand` slot) until the active agent turn ends so a growing live block cannot
	 * push duplicate rows into terminal scrollback. The block is settled when mounted unless `live`
	 * (output that still changes: settle it with `shell.transcript.settle` once final).
	 */
	presentCommandOutput(factory: () => JSXNode, options?: BlockOptions & { readonly live?: boolean }): void;
	/**
	 * Mount an assistant reply wired to the view's display flags (thinking visibility, images,
	 * charts, expansion, extension text/thinking renderers). `message` is omitted for the streaming
	 * placeholder. The block stays live until `view.finalized.set(true)`.
	 */
	presentAssistant(message?: AssistantMessage, options?: PresentAssistantOptions): AssistantView;
	/**
	 * Replay `entries` into a transcript of their own, drawn by the session's block presenters (the
	 * rewind page's turns). `clipped`: the entries are a later part of the session, so the run they
	 * open in may have started above them. Dispose it when the page closes.
	 */
	createTranscriptReplica(entries: readonly TranscriptEntryLike[], clipped: boolean): TranscriptReplica;
	/**
	 * Mount a tool call's block: a tool card, or a reply block for a built-in `write` to a reply
	 * URL (`out://`). Wired to the display flags; registers nothing in {@link pendingTools}.
	 */
	presentToolCall(spec: ToolCallSpec, options?: { readonly before?: TranscriptBlock }): PendingTool;
	/** Mount an empty read group (`read.toolResultPreview`, expansion and presenters wired); reads join via `updateArgs`. */
	presentReadGroup(options?: { readonly before?: TranscriptBlock }): PendingTool;
	/**
	 * Show a user `!`/`$` run, drawn as the extension transcript presenters ask: in the transcript,
	 * or with `deferred` (a run started while the agent streams) in the `pendingShell` slot until
	 * {@link flushPendingExecRuns} moves it into the transcript. A replayed run passes its
	 * `recorded` message (otherwise {@link ExecRunPresentation.record} sets it once recorded).
	 */
	presentExecRun(
		run: ExecRun,
		options?: { readonly deferred?: boolean; readonly recorded?: BashExecutionMessage | PythonExecutionMessage },
	): ExecRunPresentation;
	/** What `block` shows (assistant reply, tool call, exec run, message), undefined for static blocks. */
	transcriptEntry(block: TranscriptBlock): TranscriptEntry | undefined;
	/** Show session information in a focused transient overlay; `context` adds a context-window meter natively. */
	showSessionInfo(info: string, context?: ContextUsage): void;
	/** Mount command output deferred by {@link presentCommandOutput}. */
	flushPendingCommandOutput(): void;
	/** Hide the deferred command output preview; the output still mounts at the settle. False when none is shown (Esc falls through). */
	dismissDeferredCommandOutput(): boolean;
	/**
	 * Remove every transcript block (disposing their roots, so timers and subscriptions stop) and
	 * forget the block maps. Used before a full rebuild.
	 */
	resetTranscript(): void;
	showStatus(message: string, options?: ShowStatusOptions): void;
	/** Show the ctrl+p role chip track above the editor, `activeIndex` filled. */
	showModelCycleTrack(segments: readonly TrackSegment[], activeIndex: number): void;
	showError(message: string): void;
	showPinnedError(message: string): void;
	clearPinnedError(): void;
	showWarning(message: string, options?: { hideWithToolActivity?: boolean }): void;
	/** The provider's `active-notice` line when the viewed session moves onto a new model of that provider. */
	showActiveModelNotice(): void;
	showNewVersionNotification(newVersion: string): void;
	clearEditor(): void;
	updatePendingMessagesDisplay(): void;
	queueCompactionMessage(
		text: string,
		mode: "steer" | "followUp",
		images?: ImageContent[],
		options?: { preserveDraft?: boolean },
	): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	/** Start the compaction queued for the next yield, if any; it runs once the session is idle. */
	runYieldCompaction(): void;
	/** Hand a queued `/compact` and the input in the compaction queue back to the editor, saying why. */
	restoreCompactionQueueToEditor(status?: string): void;
	/** Resolves once submissions reached the session (admission or pending-submission hand-off) or finished locally. */
	waitForSubmissionDispatches(): Promise<void>;
	/** True while a foreground submission is accepted but not yet handed to the session. */
	hasPendingSubmission(): boolean;
	/** Move the `!`/`$` runs deferred by {@link presentExecRun} from the `pendingShell` slot into the transcript. */
	flushPendingExecRuns(): void;
	/** Drop the `!`/`$` runs deferred by {@link presentExecRun} (a transcript replay or session switch drops them with the transcript). */
	clearPendingExecRuns(): void;
	flushPendingModelSwitch(): Promise<void>;
	/** No argument restores the default; a function label is re-read on every frame. */
	setWorkingMessage(message?: string | (() => string)): void;
	applyPendingWorkingMessage(): void;
	/** Show the turn's working row (default label, interrupt key, accent, tok/s trailer) unless one holds the row. */
	ensureWorkingRow(): void;
	/**
	 * Put a working row in the status slot, replacing whatever holds it. Fields `spec` leaves unset
	 * take the app's defaults: `accent` (session accent), `shimmer` (`display.shimmer`) and, for
	 * `turn`, the tok/s `trailer`.
	 */
	showWorking(kind: WorkingKind, spec: WorkingSpec): void;
	/** Take the working row down; with `kind`, only when that kind holds it. Returns whether one was removed. */
	clearWorking(kind?: WorkingKind): boolean;
	/** Interrupt key id for a maintenance working row's stop control; undefined while Esc would not cancel it. */
	maintenanceInterruptKey(): KeyId | undefined;
	/** A click on a working row's stop control: the interrupt key's handler. */
	interruptFromPointer(): void;
	/** Reconcile the idle "F5 to Retry" status row with the transcript tail. */
	syncRetryHintRow(): void;
	startPendingSubmission(
		input: {
			text: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
			customType?: string;
			display?: boolean;
			streamingBehavior?: "steer" | "followUp";
			followUps?: string[];
		},
		options?: { preserveDraft?: boolean; clearEditor?: boolean },
	): SubmittedUserInput;
	cancelPendingSubmission(): boolean;
	/** Put a prompt that never reached the agent (and its unsent follow-ups, as one `=>` list) back in an empty editor. */
	restoreDroppedPrompt(prompt: DroppedPrompt): void;
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
	/**
	 * Mount the blocks drawing `message` at the transcript's end and record them in
	 * {@link transcriptBlocks}. `live` keeps them unsettled (an optimistic prompt that may still be
	 * withdrawn): settle them with `shell.transcript.settle` or remove them.
	 */
	addMessageToChat(
		message: AgentMessage,
		options?: {
			imageLinks?: readonly (string | undefined)[];
			live?: boolean;
		},
	): TranscriptBlock[];
	/**
	 * Mount the face of a prompt, summary, file mention or custom message (not replies or runs:
	 * {@link presentAssistant}, {@link presentExecRun}); undefined when it draws nothing. Settled at
	 * once unless `live`. {@link addMessageToChat} routes every role and records the block.
	 */
	presentMessage(
		message: AgentMessage,
		options?: {
			readonly imageLinks?: readonly (string | undefined)[];
			readonly live?: boolean;
			readonly before?: TranscriptBlock;
		},
	): TranscriptBlock | undefined;
	renderSessionContext(sessionContext: SessionContext, options?: RenderSessionContextOptions): void;
	/** Render a session context in bounded chunks so terminal input runs between transcript paints. */
	renderSessionContextIncrementally(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		renderChunk?: () => void,
	): Promise<void>;
	renderInitialMessages(options?: RenderInitialMessagesOptions): Promise<void>;
	/**
	 * In-place transcript rewind: drop the blocks at/after `message` when
	 * none of their rows reached terminal scrollback. Returns
	 * false when the caller must fall back to a destructive
	 * `renderInitialMessages({ clearTerminalHistory: true })` replay.
	 */
	truncateTranscriptFromMessage(message: AgentMessage): boolean;
	findLastAssistantMessage(): AssistantMessage | undefined;
	extractAssistantText(message: AssistantMessage): string;
	/** Refresh the running-subagents status badge from the active local or collab registry. */
	syncRunningSubagentBadge(): void;
	updateEditorBorderColor(): void;
	/** Redraw the transcript from the viewed session (the in-flight reply and its pending calls stay live in place). */
	rebuildChatFromMessages(): void;
	setTodos(todos: TodoItem[] | TodoPhase[]): void;
	reloadTodos(source?: AgentViewSession): Promise<void>;
	toggleTodoExpansion(): void;
	setTodoExpanded(expanded: boolean): void;
	// Command handling
	handleExportCommand(text: string): Promise<void>;
	handleTraceCommand(): Promise<void>;
	handleShareCommand(): Promise<void>;
	handleTodoCommand(args: string): Promise<void>;
	handleSessionCommand(): Promise<void>;
	handleAdvisorStatusCommand(): Promise<void>;
	handleJobsCommand(options?: { full?: boolean }): Promise<void>;
	handleUsageCommand(reports?: UsageReport[] | null): Promise<void>;
	handleChangelogCommand(args?: string): Promise<void>;
	handleHotkeysCommand(): void;
	handleToolsCommand(): void;
	handleContextCommand(): void;
	handleDumpCommand(): Promise<void>;
	handleDumpAllCommand(): Promise<void>;
	handleDumpAnonCommand(): Promise<void>;
	handleAdvisorDumpCommand(isRaw?: boolean): void;
	handleDebugTranscriptCommand(): Promise<void>;
	handleClearCommand(): Promise<void>;
	/** User-initiated `/new`: {@link handleClearCommand} plus the `plan.defaultOnStartup` default. */
	handleNewCommand(): Promise<void>;
	handleFreshCommand(): Promise<void>;
	handleResetContextCommand(): Promise<void>;
	handleDeleteCommand(): Promise<void>;
	handleForkCommand(placement?: "pane" | "window"): Promise<void>;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void>;
	handleMCPCommand(text: string): Promise<void>;
	handleSSHCommand(text: string): Promise<void>;
	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		options?: Pick<CompactOptions, "internalGuidance" | "readerModel">,
	): Promise<CompactionOutcome>;
	handleShakeCommand(mode: ShakeMode): Promise<void>;
	handleMoveCommand(targetPath?: string): Promise<void>;
	/** `/wt`: fork the checkout into a new worktree (keeping changes unless `keepChanges` is false) and move there. */
	handleWorktreeCommand(branch?: string, options?: { keepChanges?: boolean }): Promise<void>;
	withBtwSessionMove(operation: () => Promise<boolean>): Promise<boolean>;
	handleRenameCommand(title: string): Promise<void>;
	handleMemoryCommand(text: string): Promise<void>;
	handleSTTToggle(): Promise<void>;
	/** Space-bar push-to-talk into `target`: a recognized hold starts dictation and its release stops
	 *  it. Gated on `stt.enabled`, so a disabled STT leaves the space bar typing normally. */
	dictationSpaceHold(target: DictationTarget): SpaceHoldHandler;
	/** Start or stop the Codex-backed realtime voice session. */
	handleLiveCommand(): Promise<void>;
	/** Start a live session whose audio runs on an extension's own WebRTC peer (`ctx.startLive`). */
	startRemoteLive(options: ExtensionLiveStartOptions): Promise<ExtensionLiveSession>;
	/** Start a `/record` screen capture, or stop the running one. */
	toggleRecording(): Promise<void>;
	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome>;
	openInBrowser(urlOrPath: string): void;
	refreshSlashCommandState(cwd?: string): Promise<void>;
	/** Reload session skills and derived `/skill:<name>` commands. */
	refreshSkillState(): Promise<void>;
	applyCwdChange(newCwd: string, options: CwdChangeOptions): Promise<boolean>;

	// Selector handling
	showSettingsSelector(): void;
	/** Open the fullscreen `/usage` dashboard overlay for the given reports. */
	showUsageDashboard(reports: UsageReport[], sessionAiu?: AiuTotals): void;
	showAdvisorConfigure(): void;
	showHistorySearch(): void;
	showExtensionsDashboard(): void;
	showAgentsDashboard(): void;
	/** Open the fullscreen git UI, optionally pinned to a revision (`/git <rev>`). */
	showGitUi(revision?: string): void;
	showModelSelector(options?: { temporaryOnly?: boolean }): void;
	/** Session-only switch to an already-resolved model (`/switch <selector>`); compacts first when over context. */
	switchSessionModel(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void>;
	showPluginSelector(mode?: "install" | "uninstall"): Promise<void>;
	showUserMessageSelector(startAt?: string): Promise<void>;
	showCopySelector(): Promise<void>;
	showTreeSelector(): Promise<void>;
	/** Open the `/effort` picker over the levels the current model accepts. */
	showThinkingSelector(): void;
	showSessionSelector(source?: ForeignSessionSource): void;
	/** Settle side requests before replacing the session or deleting its artifacts. */
	prepareSessionSwitch(): Promise<void>;
	handleResumeSession(sessionPath: string, options?: ResumeSessionOptions): Promise<void>;
	handleSessionDeleteCommand(): Promise<void>;
	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void>;
	showSessionPinSelector(): Promise<void>;
	showResetUsageSelector(): Promise<void>;
	showProviderSetup(): Promise<void>;
	showHookConfirm(title: string, message: string, dialogOptions?: InteractiveSelectorDialogOptions): Promise<boolean>;
	showDebugSelector(): Promise<void>;
	showAgentHub(options?: AgentHubOpenOptions): void;
	resetObserverRegistry(): void;

	// Input handling
	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;
	/** Re-query terminal appearance for an explicit display reset, then immediately replay the display. */
	resetDisplayAfterAppearanceRefresh(): void;
	handleDequeue(): void;
	handleImagePaste(): Promise<boolean>;
	/** Attach a pasted image path to the main editor or an image-accepting prompt; other prompts refuse. */
	handleImagePathPaste(path: string): Promise<void>;
	/**
	 * Queue a message for delivery only after the active agent turn would stop.
	 * `detached` is a submission whose draft already left the editor: its attachments
	 * are queued and its text is restored if queueing fails.
	 */
	handleQueueCommand(
		message: string,
		detached?: Pick<SubmittedUserInput, "text" | "images" | "imageLinks">,
	): Promise<void>;
	/** `title` heads the side question instead of its text, e.g. a side file command's `/sitrep the migration`. */
	handleBtwCommand(question: string, images?: ImageContent[], title?: string): Promise<boolean>;
	handleTanCommand(work: string, images?: ImageContent[]): Promise<boolean>;
	hasActiveBtw(): boolean;
	handleBtwEscape(): boolean;
	/** Gives the keys to the ask waiting above the composer; false when none waits. */
	focusAsk(): boolean;
	/** Vim for a dialog's text box (start mode, clipboard registers) while `tui.vimMode` is on. */
	dialogVim(): DialogVim | undefined;
	/** The composer talks to a `/btw` note (Tern): plain drafts go to its topic as follow-ups. */
	readonly isBtwFocused: boolean;
	/** Sends a draft to the focused `/btw` note's topic; false when no follow-up started. */
	submitBtwFollowUp(question: string, images?: ImageContent[]): Promise<boolean>;
	handleBtwBranchKey(): Promise<boolean>;
	canBranchBtw(): boolean;
	handlesBtwBranchKey(): boolean;
	canCopyBtw(): boolean;
	handleBtwCopyKey(): Promise<boolean>;
	canFollowUpBtw(): boolean;
	handleBtwFollowUpKey(): boolean;
	/** The inject key (`app.btw.inject`, Alt+I): steer the main session with the completed /btw answer's `<inject>` block (`btw.inject`). */
	handleBtwInjectKey(): boolean;
	handleBtwBranch(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
		images?: ImageContent[],
	): Promise<void>;
	handleOmfgCommand(complaint: string): Promise<void>;
	hasActiveOmfg(): boolean;
	handleOmfgEscape(): boolean;
	handleCleanseCommand(args: string): Promise<void>;
	hasActiveCleanse(): boolean;
	handleCleanseEscape(): boolean;
	/**
	 * Show a read-only command report outside the transcript: in the `report` slot above the
	 * composer like `/btw` (a full-screen page when taller, and always in fullscreen mode) in text
	 * mode, a `/usage`-style sheet natively. `body` builds the report's content (runs once, in the
	 * report's root). Replaces the report already shown.
	 */
	showCommandReport(options: { title: string; head?: TspText; body: () => JSXNode }): void;
	/** The jobs sheet (the jobs pill's), on job `selected` when it lists it. */
	showJobsSheet(selected?: string): void;
	/** Clear the docked command report; false when none was shown (Esc falls through). */
	dismissCommandReport(): boolean;
	/**
	 * Screen rows a report above the editor may take: all of them but the editor and the chrome
	 * under it, none in fullscreen mode; undefined natively.
	 */
	commandReportRows(): number | undefined;
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
	/** True while `/guided-goal` is interviewing the user and no goal record exists yet. */
	isGuidedGoalInterviewActive(): boolean;
	handleLoopCommand(args?: string): Promise<string | undefined>;
	setLoopPrompt(prompt: string): void;
	armLoopAutoSubmit(): void;
	disableLoopMode(message?: string): void;
	cancelGoalContinuation(): void;
	disableGoalMode(message?: string): void;
	pauseLoop(): void;
	handlePlanApproval(details: PlanApprovalDetails): Promise<void>;
	resolvePlanReview(reviewId: string, choice: PlanReviewChoice, input?: { feedback?: string; role?: string }): boolean;
	getPendingPlanReview(): PlanReviewRequestedEvent | undefined;
	openPlanReview(options?: { fromExtension?: boolean }): Promise<boolean>;
	readonly sessionModes: ExtensionSessionModes;

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
		extra?: { kind?: BlockedKind },
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
	/**
	 * `ctx.ui.custom`: the factory's output (pi-tui nodes, or a rows object drawn as a canvas that
	 * receives input) shows in the composer's place, or as an overlay with `options.overlay`;
	 * resolves with the value passed to `done`.
	 */
	showHookCustom<T>(factory: ExtensionCustomFactory<T>, options?: ExtensionCustomOptions): Promise<T>;
	showExtensionError(extensionPath: string, error: string): void;
	showToolError(toolName: string, error: string): void;
}
