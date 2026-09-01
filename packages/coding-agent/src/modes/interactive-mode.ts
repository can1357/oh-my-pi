/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Agent,
	AgentBusyError,
	type AgentMessage,
	EventLoopKeepalive,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Model, Usage, UsageReport } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { execReplace } from "@oh-my-pi/pi-natives";
import type {
	AutocompleteProvider,
	Component,
	EditorTheme,
	LoaderMessageColorFn,
	OverlayHandle,
	SlashCommand,
} from "@oh-my-pi/pi-tui";
import {
	Container,
	clearRenderCache,
	getComposerStyle,
	Loader,
	Markdown,
	Spacer,
	setTerminalTextSizing,
	setTuiTight,
	TERMINAL,
	Text,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import { isInsideTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-capabilities";
import {
	$env,
	adjustHsv,
	formatNumber,
	getProjectDir,
	hsvToRgb,
	isEnoent,
	logger,
	postmortem,
	prompt,
	sanitizeText,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { reset as resetCapabilities } from "../capability";
import { restartArgv } from "../cli/flag-tables";
import type { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import { formatKeyHint, KeybindingsManager } from "../config/keybindings";
import { formatModelString, type ResolvedModelRoleValue } from "../config/model-resolver";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import {
	isSettingsInitialized,
	onModelRolesChanged,
	onStatusLineSessionAccentChanged,
	Settings,
	settings,
} from "../config/settings";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import type {
	AutocompleteProviderFactory,
	ContextUsage,
	ExtensionCustomOptions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import { loadSlashCommands } from "../extensibility/slash-commands";
import type { Goal, GoalModeState } from "../goals/state";
import { copyLocalArtifacts, resolveLocalUrlToPath } from "../internal-urls";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import type { MCPManager } from "../mcp";
import {
	formatMCPConnectionStatusMessage,
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionFailure,
	type McpConnectionStatusEvent,
} from "../mcp/startup-events";
import { humanizePlanTitle, type PlanApprovalDetails, resolvePlanTitle } from "../plan-mode/approved-plan";
import { resolvePlanModelTransition } from "../plan-mode/model-transition";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import planFilenamePrompt from "../prompts/system/plan-filename.md" with { type: "text" };
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import {
	type AgentSession,
	type AgentSessionEvent,
	type DroppedPrompt,
	type ResolvedRoleModel,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "../session/agent-session";
import type { CompactMode } from "../session/compact-modes";
import type { ForeignSessionSource } from "../session/foreign-session-store";
import { HistoryStorage } from "../session/history-storage";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionContext } from "../session/session-context";
import { getRecentSessions } from "../session/session-listing";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, buildTuiBuiltinSlashCommands } from "../slash-commands/builtin-registry";
import { formatDuration } from "../slash-commands/helpers/format";
import { STTController, type SttState } from "../stt";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { labelEchoesHandle } from "../task/label";
import { agentTypeBadge, formatTaskId } from "../task/render";
import type { ConfiguredThinkingLevel } from "../thinking";
import { tinyTitleClient } from "../tiny/title-client";
import type { LspStartupServerInfo } from "../tools";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import { formatMoreItems, replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { setAutoQaConsentHandler } from "../tools/report-tool-issue";
import {
	formatPhaseDisplayName,
	isClosedTodo,
	nextActionableTask,
	selectCollapsedTodos,
	setActiveTodoDescriptionsProvider,
	todoMatchesAnyDescription,
} from "../tools/todo";
import { vocalizer } from "../tts/vocalizer";
import { applyHyperlinkSetting } from "../tui/hyperlink";
import { renderTreeList } from "../tui/tree-list";
import { formatStartupChangelogSummary, type StartupChangelogSelection } from "../utils/changelog";
import { copyToClipboard } from "../utils/clipboard";
import type { EventBus } from "../utils/event-bus";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import { resumeCommand } from "../utils/resume-command";
import { getSessionAccentAnsi, getSessionAccentHex } from "../utils/session-color";
import { messageHasDisplayableThinking } from "../utils/thinking-display";
import {
	disposeTerminalTitleState,
	popTerminalTitle,
	pushTerminalTitle,
	setSessionTerminalTitle,
	setTerminalTitleStateEnabled,
} from "../utils/title-generator";
import {
	aggregateVibeWorkerTokensPerSecond,
	type VibeOwnerScope,
	type VibeParentSession,
	VibeSessionRegistry,
} from "../vibe/runtime";
import type { AssistantMessageComponent } from "./components/assistant-message";
import { AttachmentChipsBand } from "./components/attachment-chips";
import type { BashExecutionComponent } from "./components/bash-execution";
import { ChatBlock, type ChatBlockHost } from "./components/chat-block";
import { CodexResetFireworksController } from "./components/codex-reset-fireworks";
import { CustomEditor } from "./components/custom-editor";
import { DynamicBorder } from "./components/dynamic-border";
import { EditorTopGap } from "./components/editor-top-gap";
import { ErrorBannerComponent } from "./components/error-banner";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent, HookSelectorSlider } from "./components/hook-selector";
import { type PlanReviewAnnotationState, PlanReviewOverlay } from "./components/plan-review-overlay";
import { PlanSaveOverlay, type PlanSaveOverlayResult } from "./components/plan-save-overlay";
import { SessionInfoOverlay } from "./components/session-info-overlay";
import { StatusLineComponent } from "./components/status-line";
import { stopSharedSpinnerTicker, type ToolExecutionHandle } from "./components/tool-execution";
import { TranscriptContainer } from "./components/transcript-container";
import type { LspServerInfo as WelcomeLspServerInfo } from "./components/welcome";
import { Composer } from "./composer";
import { writeComposerWelcomeCache } from "./composer-cache";
import { BtwController } from "./controllers/btw-controller";
import { CleanseCommandController } from "./controllers/cleanse-command-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { LiveCommandController } from "./controllers/live-command-controller";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import { OmfgController } from "./controllers/omfg-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SessionFocusController } from "./controllers/session-focus-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { TanCommandController } from "./controllers/tan-command-controller";
import { TodoCommandController } from "./controllers/todo-command-controller";
import { imageReferenceHyperlink, materializeImageReferenceLinks } from "./image-references";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitRuntime,
	parseLoopLimitArgs,
} from "./loop-limit";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { getRunningSubagentBadgeAgentIds, getRunningSubagentBadgeRegistry } from "./running-subagent-badge";
import {
	type ObservableSession,
	type SessionObserverChangeKind,
	SessionObserverRegistry,
} from "./session-observer-registry";
import { createSessionTeardown, type SessionTeardown } from "./session-teardown";
import { runProviderSetupWizard } from "./setup-wizard/lazy";
import { sanitizeStatusText } from "./shared";
import { invokeSkillCommandFromText, isKnownSkillCommand } from "./skill-command";
import { clearMermaidCache } from "./theme/mermaid-cache";
import { type ShimmerPalette, shimmerEnabled, shimmerText } from "./theme/shimmer";
import type { Theme } from "./theme/theme";
import {
	getEditorTheme,
	getMarkdownTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	setMarkdownMermaidRendering,
	startMacOSAppearanceReprobeFallback,
	theme,
} from "./theme/theme";
import { getSlashCommandTypeIcon } from "./theme/tui-adapters";
import type {
	AgentHubOpenOptions,
	CompactionQueuedMessage,
	InteractiveModeContext,
	InteractiveModeInitOptions,
	InteractiveSelectorDialogOptions,
	RenderSessionContextOptions,
	SubmittedUserInput,
	TodoItem,
	TodoPhase,
} from "./types";
import { UiHelpers } from "./utils/ui-helpers";

const STILL_CLOSING_DELAY_MS = 3_000;
const DEFAULT_WORKING_MESSAGE = "Working…";

interface WorkingMessageAccent {
	main: string;
	dim: string;
	/**
	 * Interned shimmer palette for this accent so `compile()` inside
	 * `shimmerText` sees a stable palette object between animation ticks.
	 * A fresh palette literal every frame guaranteed a cache miss on the
	 * Symbol-keyed compiled-ANSI slot and forced `resolveTierAnsi` to walk
	 * every tier open/close for the ~30fps loader redraw (issue #4377).
	 */
	palette?: ShimmerPalette;
}

interface WorkingMessageAccentCacheKey {
	sessionName: string | undefined;
	accentSurfaceLuminance: number | undefined;
	sessionAccentEnabled: boolean;
}

function renderWorkingMessage(message: string, accent?: WorkingMessageAccent): string {
	if (!accent) return shimmerText(message, theme);
	accent.palette ??= { low: "dim", mid: { ansi: accent.main }, high: { ansi: accent.main }, bold: true };
	return shimmerText(message, theme, accent.palette);
}

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;
const EDITOR_MIN_CHROME_ROWS = 4; // rows reserved for transcript + status on small terms
const EDITOR_MIN_RENDERED_ROWS = 3; // bordered editor floor: top+bottom border + 1 content row

/**
 * Editor max-height cap for a terminal of `terminalRows` rows.
 *
 * Roomy terminals get the comfortable [6, 18] band. Small terminals shrink the
 * cap so the editor leaves at least EDITOR_MIN_CHROME_ROWS rows for the
 * transcript + status line. The editor is bordered, so it never renders fewer
 * than EDITOR_MIN_RENDERED_ROWS rows; once the terminal is too small for both
 * (terminalRows < EDITOR_MIN_RENDERED_ROWS + EDITOR_MIN_CHROME_ROWS) the cap is
 * pinned to that floor — returning a smaller number would not shrink the editor
 * any further, it would only misreport the rows it actually occupies.
 */
export function computeEditorMaxHeight(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : EDITOR_FALLBACK_ROWS;
	const comfortable = Math.max(EDITOR_MAX_HEIGHT_MIN, Math.min(EDITOR_MAX_HEIGHT_MAX, rows - EDITOR_RESERVED_ROWS));
	return Math.max(EDITOR_MIN_RENDERED_ROWS, Math.min(comfortable, rows - EDITOR_MIN_CHROME_ROWS));
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
const PLAN_SAVE_AND_QUIT_OPTION = "Save and quit";
const PLAN_SAVE_TITLE_LINE_LIMIT = 6;

const PLAN_SAVE_STEM_MAX_LENGTH = 32;
const PLAN_FILENAME_SYSTEM_PROMPT = prompt.render(planFilenamePrompt);
/** Suggested save filename for an approved plan: `<TOPIC>_PLAN.md` from the
 *  tiny-model topic (e.g. `PYO3_METHODS_PLAN.md`), trimmed to a word boundary
 *  when a verbose fallback title sneaks through. */
export function planSaveFileName(title: string): string {
	let stem = title
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}]+/gu, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	if (stem.length > PLAN_SAVE_STEM_MAX_LENGTH) {
		const cut = stem.lastIndexOf("_", PLAN_SAVE_STEM_MAX_LENGTH);
		stem = cut > 0 ? stem.slice(0, cut) : stem.slice(0, PLAN_SAVE_STEM_MAX_LENGTH);
	}
	if (!stem || stem === "PLAN") return "PLAN.md";
	return `${stem.endsWith("_PLAN") ? stem : `${stem}_PLAN`}.md`;
}

function planSaveTitleExcerpt(planContent: string): string {
	return planContent
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.slice(0, PLAN_SAVE_TITLE_LINE_LIMIT)
		.join("\n");
}

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

function formatContextTokenCount(value: number): string {
	return formatNumber(Math.max(0, Math.round(value))).toLowerCase();
}

/**
 * Reads a tool-name snapshot out of a persisted `mode_change` payload. Session
 * files are user-editable and survive across versions, so anything that is not
 * a plain array of strings is treated as absent rather than trusted.
 */
function readPersistedToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (!value.every(name => typeof name === "string")) return undefined;
	return value as string[];
}

export function shouldEnterPlanModeOnStartup(
	sessionManager: Pick<SessionManager, "buildSessionContext" | "getEntries">,
	sessionSettings: Pick<Settings, "get">,
): boolean {
	const hasConversationContext = sessionManager.buildSessionContext().messages.length > 0;
	const hasExplicitMode = sessionManager.getEntries().some(entry => entry.type === "mode_change");
	return (
		!hasConversationContext &&
		!hasExplicitMode &&
		sessionSettings.get("plan.defaultOnStartup") &&
		sessionSettings.get("plan.enabled")
	);
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

export const TODO_COMPACT_TERMINAL_ROWS_THRESHOLD = 18;

/** Holds mutable HUD and editor-adjacent chrome outside transcript history. */
class AnchoredLiveContainer extends Container {}

class TodoHudContainer extends AnchoredLiveContainer {
	constructor(private readonly mode: InteractiveMode) {
		super();
	}

	override render(width: number): readonly string[] {
		if (this.mode.isCompactTodoMode()) {
			return [];
		}
		return super.render(width);
	}
}

class StatusHudContainer extends AnchoredLiveContainer {
	constructor(private readonly mode: InteractiveMode) {
		super();
	}

	override render(width: number): readonly string[] {
		const lines = this.#renderLines(width);
		this.mode.statusRowOccupied = lines.length > 0;
		return lines;
	}

	#renderLines(width: number): readonly string[] {
		const childLines = super.render(width);
		if (!this.mode.isCompactTodoMode()) {
			if (childLines.length === 0) {
				const idle = this.mode.renderIdleStatusHud(width);
				if (idle) return idle;
			}
			return childLines;
		}
		return this.mode.renderCompactStatusLine(width, childLines);
	}
}

/**
 * Preview of the command panels queued while the agent streams, rendered above
 * the editor so `/usage` and friends answer immediately mid-turn.
 *
 * Capped in height: the panels are shown in full in the transcript at the next
 * settle, so the preview only has to answer the question, not reproduce the
 * whole report. Rendering is delegated to the real panels at the real width, so
 * the preview cannot drift from what eventually lands in the transcript.
 */
class DeferredCommandPreview implements Component {
	constructor(
		private readonly items: readonly Component[],
		private readonly maxRows: number,
		private readonly commandCount: number,
	) {}

	render(width: number): readonly string[] {
		const rows: string[] = [];
		for (const item of this.items) rows.push(...item.render(width));
		const queued = this.commandCount === 1 ? "1 command output" : `${this.commandCount} command outputs`;
		if (rows.length <= this.maxRows) {
			rows.push(theme.fg("dim", `${queued} — repeated in the transcript when the agent pauses`));
			return rows;
		}
		const shown = rows.slice(0, Math.max(1, this.maxRows - 1));
		const hidden = rows.length - shown.length;
		shown.push(theme.fg("dim", `… ${hidden} more rows — ${queued} shown in full when the agent pauses`));
		return shown;
	}
}

/** Never shrink the queued-output preview below this, even on a short terminal. */
const DEFERRED_PREVIEW_MIN_ROWS = 6;
/** Ceiling for the preview as a share of the viewport, so the prompt stays visible. */
const DEFERRED_PREVIEW_VIEWPORT_FRACTION = 0.4;

/** How long the ctrl+p model-role cycle chip track lingers above the editor
 *  before it auto-clears, mirroring the todo HUD's auto-clear timer. */
const MODEL_CYCLE_TRACK_CLEAR_MS = 4000;

const SUBAGENT_HUD_VISIBLE_LIMIT = 8;
const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

/**
 * Build the anchored subagent HUD block: a bold accent "Subagents" header plus
 * a bounded set of running-agent rows in the same `Id ⟨role⟩: description` shape
 * the inline task rows use (muted task preview when no description was given).
 * Layout mirrors the Todos HUD exactly: unindented header, then
 * `renderTreeList` rows (dim connectors) shifted right by one space.
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

	const dot = theme.styledSymbol("status.done", "accent");
	const visible = running.slice(0, SUBAGENT_HUD_VISIBLE_LIMIT);
	const hiddenCount = running.length - visible.length;
	const rows = renderTreeList(
		{
			items: visible,
			expanded: true,
			renderItem: session => {
				const displayId = formatTaskId(session.id);
				const role = session.agent ?? session.progress?.agent;
				const badge = agentTypeBadge(role, theme);
				let line = `${dot} ${theme.fg("accent", theme.bold(displayId))}${badge}`;
				const description = session.description?.trim() || session.progress?.description?.trim();
				const distinctDescription =
					description && !labelEchoesHandle(session.id, description) ? description : undefined;
				if (distinctDescription) {
					const budget = Math.max(
						TRUNCATE_LENGTHS.SHORT,
						columns - visibleWidth(displayId) - visibleWidth(Bun.stripANSI(badge)) - 10,
					);
					const formatted = replaceTabs(distinctDescription).replace(/\s*[\r\n]+\s*/g, " ↵ ");
					line += `${theme.fg("accent", ":")} ${theme.fg("accent", truncateToWidth(formatted, budget))}`;
				} else {
					// No spawn description: fall back to a muted task preview, same as
					// the inline task rows when a row has no label.
					const taskPreview = session.progress?.task?.trim();
					if (taskPreview && !labelEchoesHandle(session.id, taskPreview)) {
						const formatted = replaceTabs(taskPreview).replace(/\s*[\r\n]+\s*/g, " ↵ ");
						line += ` ${theme.fg("muted", truncateToWidth(formatted, TRUNCATE_LENGTHS.SHORT))}`;
					}
				}
				return line;
			},
		},
		theme,
	);
	if (hiddenCount > 0) {
		rows.push(theme.fg("dim", `… ${hiddenCount} more running — open Agent Hub for full list`));
	}
	return ["", theme.bold(theme.fg("accent", "Subagents")), ...rows.map(line => ` ${line}`)];
}

const CTRL_L_APPEARANCE_RESPONSE_DEADLINE_MS = 2000;

export class InteractiveMode implements InteractiveModeContext {
	#ownsStartedUi: boolean;
	#startupSubmitGated: boolean;
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;

	/** Canonical composer shared by cold prepaint and the session-aware runtime. */
	readonly composer: Composer;
	ui: TUI;
	chatContainer: TranscriptContainer;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	/** Whether {@link statusContainer} rendered lines in the latest frame; the band composer's editor top gap collapses only then. */
	statusRowOccupied = false;
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
	/** Composer attachment band (chip cards) rendered directly above the prompt box. */
	attachmentChipsContainer: Container;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;

	isInitialized = false;
	initialChatRendered = false;
	isBashMode = false;
	toolOutputExpanded = false;
	hideToolActivity = false;
	todoExpanded = false;
	planModeEnabled = false;
	planModePaused = false;
	goalModeEnabled = false;
	goalModePaused = false;
	vibeModeEnabled = false;
	planModePlanFilePath: string | undefined = undefined;
	loopModeEnabled = false;
	loopModePaused = false;
	loopPrompt: string | undefined = undefined;
	loopLimit: LoopLimitRuntime | undefined = undefined;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	#todoAutoClearTimer: NodeJS.Timeout | undefined;
	#modelCycleClearTimer: NodeJS.Timeout | undefined;
	#nextAppearanceRequestToken = 1;
	#appearanceRefreshRequest: { token: TerminalAppearanceRequestToken; deadline: number } | undefined;
	todoPhases: TodoPhase[] = [];
	/**
	 * Session that owns the plan currently in {@link todoPhases}. Subagent
	 * reconciliation persists to this session, not blindly to `viewSession`,
	 * which flips to the destination before `reloadTodos` refreshes during
	 * focus attach.
	 */
	#todoPhasesOwner?: AgentSession;
	hideThinkingBlock = false;
	#sessionsWithDisplayableThinkingContent = new WeakSet<AgentSession>();
	/** Whether the visible session has produced thinking content the user can reveal. */
	get hasDisplayableThinkingContent(): boolean {
		return this.#sessionsWithDisplayableThinkingContent.has(this.viewSession);
	}
	/** Record received reasoning content so Ctrl+T can reveal it even when model metadata says thinking is off. */
	noteDisplayableThinkingContent(message: AgentMessage): boolean {
		if (this.hasDisplayableThinkingContent || !messageHasDisplayableThinking(message, this.proseOnlyThinking)) {
			return false;
		}
		this.#sessionsWithDisplayableThinkingContent.add(this.viewSession);
		return true;
	}
	/**
	 * Effective thinking-block visibility: hidden when the user's setting is on,
	 * or while thinking is "off" before the session has actually produced
	 * displayable thinking content. Some providers return thinking blocks without
	 * advertising reasoning support, so observed content unlocks the visibility
	 * toggle.
	 */
	get effectiveHideThinkingBlock(): boolean {
		const thinkingOff = (this.viewSession?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		return this.hideThinkingBlock || (thinkingOff && !this.hasDisplayableThinkingContent);
	}
	proseOnlyThinking = true;
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
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
	#retryHintRow: Text | undefined;
	#workingMessageAccentCacheKey?: WorkingMessageAccentCacheKey;
	#workingMessageAccentCacheValue?: WorkingMessageAccent;
	#workingMessageAccentCacheHasValue = false;
	/** Band composer: the status band hides `session_name`, so the title docks
	 * onto the working row instead — right-aligned, dim, italic. */
	#workingTitleTrailer(): string | undefined {
		if (settings.get("composer.shape") !== "band") return undefined;
		const name = this.sessionManager.getSessionName();
		if (!name) return undefined;
		return `\x1b[2;3m${sanitizeStatusText(name)}\x1b[23;22m`;
	}
	/** Idle stand-in for the working row in band mode: the docked title stays
	 * readable between turns, in the same spot the loader's trailer uses. */
	renderIdleStatusHud(width: number): readonly string[] | undefined {
		const trailer = this.#workingTitleTrailer();
		if (!trailer) return undefined;
		return ["", " ".repeat(Math.max(0, width - visibleWidth(trailer))) + trailer];
	}
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined = undefined;
	locallySubmittedUserSignatures: Set<string> = new Set();
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	#pendingSubmissionDispose: (() => void) | undefined;
	#pendingSubmissionPreservesDraft = false;
	#optimisticUserMessageComponents: Component[] = [];
	#optimisticSkillMessageComponents: Component[] = [];
	/** True while an optimistically-rendered `/skill:` row awaits its canonical
	 *  `message_start`. Read by the event controller to reconcile the row. */
	optimisticSkillMessagePending = false;
	lastSigintTime = 0;
	lastEscapeTime = 0;
	/** Owns Esc for every `/mcp test` that is active or whose cancellation hint may still be visible. */
	mcpTestEscapeHandlers = new Set<() => void>();
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
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;

	#pendingCommandOutput: Component[] = [];
	#pendingCommandOutputSessionId: string | undefined;
	/** Commands (not components) queued while streaming, for the deferral hint. */
	#pendingCommandOutputCommands = 0;
	#pendingSlashCommands: SlashCommand[] = [];
	/** Built-in editor autocomplete provider, before extension wrapping. */
	#baseAutocompleteProvider: AutocompleteProvider | undefined;
	/** Extension-registered provider factories, applied in registration order (#4919). */
	#autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	#cleanupUnsubscribe?: () => void;
	#signalTeardown?: SessionTeardown;
	readonly #version: string;
	readonly #startupChangelog: StartupChangelogSelection | undefined;
	/** Header components below the config warnings + welcome, retained so a live config-warning change can rebuild the header (#10048). */
	#headerAfter: readonly Component[] = [];
	#planModePreviousTools: string[] | undefined;
	#goalModePreviousTools: string[] | undefined;
	#vibeModePreviousTools: string[] | undefined;
	#vibeModeOwnerScope: VibeOwnerScope | undefined;
	#vibeScopeSuspendedForSwitch = false;
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	#goalTurnHadToolCalls = false;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;
	#planModePreviousModelState: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** Whether #pendingModelSwitch was queued by the live plan-role reconciler. */
	#pendingPlanModelSwitch = false;
	#planModeHasEntered = false;
	#planReviewOverlay: PlanReviewOverlay | undefined;
	#planReviewOverlayHandle: OverlayHandle | undefined;
	#sessionInfoOverlayHandle: OverlayHandle | undefined;
	#planReviewCancel: (() => void) | undefined;
	/** Serializable review annotations keyed by the resolved plan file path. */
	#planReviewAnnotationState = new Map<string, PlanReviewAnnotationState>();
	/** Annotation state held until the associated queued refinement actually starts. */
	#planReviewAnnotationStateBySubmission = new WeakMap<SubmittedUserInput, string>();
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: MCPManager;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	readonly #codexResetFireworksController: CodexResetFireworksController;
	readonly #btwController: BtwController;
	readonly #tanCommandController: TanCommandController;
	readonly #omfgController: OmfgController;
	readonly #cleanseController: CleanseCommandController;
	readonly #commandController: CommandController;
	readonly #todoCommandController: TodoCommandController;
	readonly #liveCommandController: LiveCommandController;
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
	get sessionName(): string | undefined {
		return this.session.sessionName;
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
		this.#hideSessionInfo();
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		if (this.autoCompactionLoader) {
			this.autoCompactionLoader.stop();
			this.autoCompactionLoader = undefined;
		}
		if (this.retryLoader) {
			this.retryLoader.stop();
			this.retryLoader = undefined;
		}
		this.statusContainer.disposeChildren();
		this.pendingMessagesContainer.disposeChildren();
		this.#cancelModelCycleClearTimer();
		this.modelCycleContainer.disposeChildren();
		this.deferredCommandContainer.disposeChildren();
		this.#pendingCommandOutput = [];
		this.#pendingCommandOutputSessionId = undefined;
		this.#pendingCommandOutputCommands = 0;
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
	#subagentEventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	#observerUiSyncTimer?: NodeJS.Timeout;
	#observerUiSyncNeedsTodoReconcile = false;
	#agentRegistryUnsubscribe?: () => void;
	#agentRegistrySubscriptionTarget?: AgentRegistry;
	#mcpStatusOrder: string[] = [];
	#mcpPendingServers = new Set<string>();
	#mcpConnectedServers = new Set<string>();
	#mcpFailedServers = new Map<string, { error: string; sourcePath?: string }>();
	readonly #chatHost: ChatBlockHost = { requestRender: () => this.ui.requestRender() };

	/** Root-scoped bus carrying this session tree's `task:subagent:*` frames. */
	get subagentEventBus(): EventBus | undefined {
		return this.#subagentEventBus;
	}

	constructor(
		session: AgentSession,
		version: string,
		startupChangelog: StartupChangelogSelection | undefined = undefined,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: MCPManager,
		eventBus?: EventBus,
		composer?: Composer,
		subagentEventBus?: EventBus,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		const preferences = {
			quiet: settings.get("startup.quiet"),
			composerShape: settings.get("composer.shape") ?? "band",
			showHardwareCursor: settings.get("showHardwareCursor"),
			maxInlineImages: settings.get("tui.maxInlineImages"),
			resizeScrollback: settings.get("tui.resizeScrollback"),
			imeSafeCursor: settings.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
		};
		const wasStarted = composer?.started ?? false;
		this.composer =
			composer ??
			new Composer({
				preferences,
				welcome: {
					version,
					modelName: session.model?.name ?? "Unknown",
					providerName: session.model?.provider ?? "Unknown",
					lspServers: lspServers?.map(server => ({
						name: server.name,
						status: server.status,
						fileTypes: server.fileTypes,
					})),
				},
			});
		this.composer.setPreferences(preferences);
		this.ui = this.composer.ui;
		this.editor = this.composer.editor;
		this.editor.magicKeywordsEnabled = () => this.settings.get("magicKeywords.enabled");
		this.editor.imageReferenceHyperlink = imageReferenceHyperlink;
		this.#ownsStartedUi = wasStarted;
		this.#startupSubmitGated = true;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#startupChangelog = startupChangelog;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.mcpManager?.setAuthHandler((serverName, challenge) =>
			new MCPCommandController(this).handleMCPAuthChallenge(serverName, challenge),
		);
		this.#eventBus = eventBus;
		this.#subagentEventBus = subagentEventBus;
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
						logger.warn("Ignoring malformed mcp:connection-status event", { data });
						return;
					}
					this.#handleMcpConnectionStatusEvent(data);
				}),
			);
		}

		setTuiTight(settings.get("tui.tight"));
		setMarkdownMermaidRendering(settings.get("tui.renderMermaid"));
		// A cold-start composer already owns the terminal. Reuse it so input
		// buffered during startup remains in the same editor instance.
		this.ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
		this.ui.setShowHardwareCursor(settings.get("showHardwareCursor"));
		// OSC 66 text-sizing is Kitty-only; resolve the setting against the terminal's
		// capability (`TERMINAL.supportsTextSizing` defaults on for Kitty) so it stays off
		// unless the user opts in, and never emits raw escapes on other terminals.
		setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.supportsTextSizing);
		// Keep generic pi-tui renderers aligned with the coding-agent setting.
		applyHyperlinkSetting();
		this.chatContainer = new TranscriptContainer();
		this.pendingMessagesContainer = new AnchoredLiveContainer();
		this.statusContainer = new StatusHudContainer(this);
		this.todoContainer = new TodoHudContainer(this);
		this.subagentContainer = new AnchoredLiveContainer();
		this.btwContainer = new AnchoredLiveContainer();
		this.omfgContainer = new AnchoredLiveContainer();
		this.cleanseContainer = new AnchoredLiveContainer();
		this.errorBannerContainer = new AnchoredLiveContainer();
		this.modelCycleContainer = new AnchoredLiveContainer();
		this.deferredCommandContainer = new AnchoredLiveContainer();
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(settings.get("tui.imeSafeCursor"));
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.syncEditorSpelling();
		this.editor.viewportRowsProvider = () => this.ui.terminal.rows;
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		this.#syncEditorMaxHeight();
		// Sync editor geometry only. TUI owns the alternate-buffer drag paint and
		// settled normal-buffer repaint for each SIGWINCH.
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
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
		this.hookWidgetContainerAbove.addChild(new EditorTopGap(() => this.statusRowOccupied));
		this.hookWidgetContainerBelow = new Container();
		this.attachmentChipsContainer = new Container();
		this.attachmentChipsContainer.addChild(
			new AttachmentChipsBand(this.editor, this.ui.imageBudget, () => this.ui.requestRender()),
		);
		// Restored drafts (esc-esc, /tree, branch) re-materialize blob-store links off the render
		// path so their chip tokens become clickable again instead of degrading to dead text.
		this.editor.draftImageLinkMaterializer = images =>
			materializeImageReferenceLinks(images, this.sessionManager.putBlob.bind(this.sessionManager));
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.#codexResetFireworksController = new CodexResetFireworksController(this);
		this.statusLine.setCodexResetFireworksHandler(event => {
			this.#codexResetFireworksController.show(event);
		});
		// Vibe worker tok/s aggregator — keeps the status-line render layer off
		// the heavy vibe/task dependency graph. The director is often idle while
		// workers stream, so without this the tok/s badge would show a stale
		// value while parallel work is actively generating tokens.
		this.statusLine.setVibeWorkerTokenRateProvider(() =>
			aggregateVibeWorkerTokensPerSecond(this.session.getAgentId() ?? MAIN_AGENT_ID),
		);

		this.hideToolActivity = settings.get("display.hideToolActivity");
		this.chatContainer.setToolActivityVisible(!this.hideToolActivity);
		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.proseOnlyThinking = settings.get("proseOnlyThinking");

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			icon: getSlashCommandTypeIcon("extension"),
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
			icon: getSlashCommandTypeIcon(loaded.path.startsWith("mcp:") ? "mcp" : "prompt"),
		}));

		const skillCommandList = this.#rebuildSkillCommandsFromSession();

		const builtinCommands: SlashCommand[] = buildTuiBuiltinSlashCommands({ ctx: this }).map(cmd => ({
			...cmd,
			icon: getSlashCommandTypeIcon(cmd.icon ?? "action"),
		}));
		// Store pending commands for init() where file commands are loaded async
		this.#pendingSlashCommands = [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#tanCommandController = new TanCommandController(this);
		this.#omfgController = new OmfgController(this);
		this.#cleanseController = new CleanseCommandController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#todoCommandController = new TodoCommandController(this);
		this.#liveCommandController = new LiveCommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#focusController = new SessionFocusController(this);
		this.#inputController = new InputController(this);
		this.session.setTitleGenerationStart?.(() => {
			this.#inputController.notifyTitleGenerationStart();
		});
		this.session.setPromptDropped?.(prompt => this.#restoreDroppedPrompt(prompt));
		this.#observerRegistry = new SessionObserverRegistry();
	}

	#handleMcpConnectionStatusEvent(event: McpConnectionStatusEvent): void {
		if (this.settings.get("startup.quiet")) return;
		if (event.type === "connecting") {
			this.#mcpStatusOrder = [];
			this.#mcpPendingServers.clear();
			this.#mcpConnectedServers.clear();
			this.#mcpFailedServers.clear();
			for (const serverName of event.serverNames) {
				this.#trackMcpStatusServer(serverName);
				this.#mcpPendingServers.add(serverName);
			}
		} else if (event.type === "connected") {
			this.#trackMcpStatusServer(event.serverName);
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpFailedServers.delete(event.serverName);
			this.#mcpConnectedServers.add(event.serverName);
		} else {
			this.#trackMcpStatusServer(event.serverName);
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpConnectedServers.delete(event.serverName);
			this.#mcpFailedServers.set(event.serverName, {
				error: event.error,
				sourcePath: event.sourcePath,
			});
		}

		const message = formatMCPConnectionStatusMessage({
			pendingServers: this.#orderedMcpStatusServers(this.#mcpPendingServers),
			connectedServers: this.#orderedMcpStatusServers(this.#mcpConnectedServers),
			failedServers: this.#orderedMcpStatusFailures(),
		});
		if (message) this.showStatus(message);
	}

	#trackMcpStatusServer(serverName: string): void {
		if (!this.#mcpStatusOrder.includes(serverName)) {
			this.#mcpStatusOrder.push(serverName);
		}
	}

	#orderedMcpStatusServers(servers: ReadonlySet<string>): string[] {
		return this.#mcpStatusOrder.filter(serverName => servers.has(serverName));
	}

	#orderedMcpStatusFailures(): McpConnectionFailure[] {
		return this.#mcpStatusOrder.flatMap(serverName => {
			const failure = this.#mcpFailedServers.get(serverName);
			return failure === undefined ? [] : [{ serverName, ...failure }];
		});
	}

	playWelcomeIntro(): void {
		this.composer.playWelcomeIntro();
	}

	async init(options: InteractiveModeInitOptions = {}): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings = logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());

		// Route SIGINT/SIGTERM/SIGHUP/uncaughtException through the same teardown
		// the TUI Ctrl+C keypress path performs: persist the in-progress editor
		// draft for `--resume`, then dispose the session (which emits the extension
		// `session_shutdown` event, cancels the owned async job manager, disposes
		// eval kernels, releases owned browser tabs, and closes the session
		// manager). Without this callback a real kernel signal would drop the
		// draft, skip the `session_shutdown` contract from `shared-events.ts`,
		// and orphan background bash/task processes (issue #4080). The registered
		// callback and `shutdown()` share one promise-memoized teardown, so a
		// signal arriving mid-Ctrl+C no-ops instead of racing a second dispose.
		this.#signalTeardown = createSessionTeardown({
			getDraftText: () => this.#inputController.getDraftText(),
			beginDispose: () => this.session.beginDispose(),
			saveDraft: text => this.sessionManager.saveDraft(text),
			disposeSession: reason =>
				this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS, reason }),
		});
		// Forward the postmortem reason (SIGTERM/SIGHUP/uncaughtException/…) so the
		// persisted `session_exit` diagnostic carries the real trigger. Postmortem
		// runs callbacks in REVERSE registration order — this callback (registered
		// after the AgentSession constructor's `agent-session:<id>` recorder) runs
		// FIRST and its dispose() would otherwise persist the generic "dispose".
		this.#cleanupUnsubscribe = postmortem.register("session-teardown", reason => this.#signalTeardown!(reason));

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
			this.session.slashCommands,
		);

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Prepaint started this scan before the runtime module graph loaded. Only
		// scan here when no startup composer exists (non-TTY/embedded hosts) or
		// its best-effort load failed.
		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", async () => {
			const preloaded = await options.recentSessions;
			if (preloaded) return preloaded;
			const sessions = await getRecentSessions(this.sessionManager.getSessionDir());
			return sessions.map(s => ({ name: s.name, timeAgo: s.timeAgo }));
		});
		const startupQuiet = settings.get("startup.quiet");
		this.composer.setPreferences({ quiet: startupQuiet });
		this.composer.updateWelcome({
			version: this.#version,
			modelName,
			providerName,
			recentSessions,
			lspServers: this.#getWelcomeLspServers(),
		});
		this.#persistComposerWelcome(modelName, providerName);
		const headerBefore = this.#buildConfigWarningComponents();
		const headerAfter: Component[] = [];
		if (!startupQuiet && this.#startupChangelog && settings.get("startup.changelogMode") !== "hidden") {
			headerAfter.push(
				new DynamicBorder(),
				new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0),
				new Spacer(1),
			);
			if (settings.get("startup.changelogMode") === "summary") {
				const summary = formatStartupChangelogSummary(this.#startupChangelog).replace(
					/\/changelog(?: full)?/g,
					command => theme.bold(command),
				);
				headerAfter.push(new Text(summary, 1, 0));
			} else {
				headerAfter.push(new Markdown(this.#startupChangelog.markdown?.trim() ?? "", 1, 0, getMarkdownTheme()));
			}
			headerAfter.push(new Spacer(1), new DynamicBorder());
		}
		this.#headerAfter = headerAfter;
		this.composer.setHeaderExtras(headerBefore, headerAfter);
		this.statusLine.watchBranch(() => {
			this.ui.requestRender();
		});
		this.composer.setStatusComponent(this.statusLine);

		this.composer.setRuntimeChildren([
			this.chatContainer,
			this.pendingMessagesContainer,
			this.todoContainer,
			this.subagentContainer,
			this.btwContainer,
			this.omfgContainer,
			this.cleanseContainer,
			this.errorBannerContainer,
			this.modelCycleContainer,
			this.deferredCommandContainer,
			// Working loader / transient status sits below the sticky todo + subagent
			// HUDs, just above the editor's hook-widget top margin — so it reads next to
			// the prompt while keeping the one-line gap above the editor (the band
			// composer collapses that gap so its status band sits flush).
			this.statusContainer,
			this.attachmentChipsContainer,
			this.hookWidgetContainerAbove,
			this.editorContainer,
			this.hookWidgetContainerBelow,
		]);
		this.ui.setFocus(this.editor);
		this.syncComposerShape();

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus, this.#subagentEventBus ?? this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningSubagentBadge();
		this.#observerRegistry.onChange(kind => {
			this.#scheduleObserverUiSync(kind);
		});
		// Let the transient todo tool result light up pending todos executed by a
		// live subagent, matching the sticky HUD's active set (#5873).
		setActiveTodoDescriptionsProvider(() => this.#getActiveSubagentDescriptions());

		// Load initial todos
		await logger.time("InteractiveMode.init:todos", () => this.#loadTodoList());

		if (process.platform === "darwin" && TERMINAL.id === "wezterm" && !isInsideTerminalMultiplexer()) {
			this.#eventBusUnsubscribers.push(startMacOSAppearanceReprobeFallback(this.ui.terminal));
		}

		// A prepaint Composer may already own raw mode and the render loop.
		if (!this.#ownsStartedUi) {
			this.composer.start({
				clearScrollback: options.clearInitialTerminalHistory === true,
				playWelcomeIntro: !options.suppressWelcomeIntro,
			});
			this.#ownsStartedUi = true;
		}
		pushTerminalTitle();
		setTerminalTitleStateEnabled(this.settings.get("tui.titleState"));
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.updateEditorBorderColor();
		// Single side-effect point for title changes: every setSessionName caller
		// (first-input titling, /rename, extension renames, plan seeding, replan
		// refresh) gets the terminal title + accent updates from here. Registered
		// before initHooksAndCustomTools/#reconcileModeFromSession/#enterPlanMode —
		// all of which can reach setSessionName during init.
		this.#eventBusUnsubscribers.push(
			this.sessionManager.onPersistenceError(error => {
				const detail = truncateToWidth(
					replaceTabs(sanitizeText(error.message)).replace(/[\r\n]+/g, " "),
					TRUNCATE_LENGTHS.LINE,
				);
				this.showWarning(
					`Session persistence failed: ${detail}. Unsaved entries remain in memory; persistence will retry on the next entry.`,
				);
			}),
			this.sessionManager.onSessionNameChanged(() => {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
				this.#handleSessionAccentInputsChanged();
			}),
		);
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		// The startup composer is already visible. Commit the complete runtime
		// tree before session_start hooks/reconciliation continue; renderNow keeps
		// TUI's multiplexer, output-backlog, and image safety gates.
		this.ui.renderNow();

		// Prewarm the local tiny-title worker off the submit hot path: spawn it
		// now, idle and unref'd, so the first submit reuses a live subprocess
		// instead of paying spawn latency ahead of the first frame (issue #6462).
		// No-ops for the online default and for already-named sessions that will
		// not be titled. Deferred via setImmediate so it runs AFTER the render
		// callback requestRender(true) queued above (immediates are FIFO) — the
		// spawn syscall never lands in the same loop turn ahead of the first paint.
		setImmediate(() => {
			if (!$env.PI_NO_TITLE && !this.sessionManager.getSessionName()) {
				tinyTitleClient.prewarm(this.settings.get("providers.tinyModel"));
			}
		});

		// Initialize hooks with TUI-based UI context
		await logger.time("InteractiveMode.init:hooks", () => this.initHooksAndCustomTools());

		// Restore mode from session (e.g. plan mode on resume)
		this.session.setSessionBeforeSwitchReconciler?.(async () => {
			await this.#liveCommandController.stop();
			await this.#quiesceVibeForSessionSwitch();
		});
		this.session.setSessionSwitchReconciler?.(() => this.#reconcileModeFromSession({ preserveActiveGoal: true }));
		await logger.time("InteractiveMode.init:reconcileMode", () => this.#reconcileModeFromSession());

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
		if (shouldEnterPlanModeOnStartup(this.sessionManager, this.session.settings)) {
			await this.#enterPlanMode();
		}

		// Restore unsent editor draft from previous session shutdown (Ctrl+D).
		// One-shot: consumeDraft removes the sidecar after read so the next
		// resume does not re-restore the same text.
		try {
			const draft = await logger.time("InteractiveMode.init:draft", () => this.sessionManager.consumeDraft());
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
				if (event.type === "model_changed") {
					this.#updateWelcomeModel();
				}
				if (event.type === "config_warnings_changed") {
					this.#syncConfigWarningHeader();
				}
				void this.#handleGoalSessionEvent(event);
			}),
			onStatusLineSessionAccentChanged(() => {
				this.#syncStatusLineSettings();
				this.#handleSessionAccentInputsChanged();
			}),
		);
		// Resync the welcome banner to the live model: init-time reconciliations
		// (#reconcileModeFromSession, #enterPlanMode for plan.defaultOnStartup)
		// can change the model before this subscription exists, so the
		// model_changed events they emit are never observed by the handler above.
		this.#updateWelcomeModel();
		// Config warnings can change during the same pre-subscription window; the
		// event is not replayed, so rebuild from the live array once here too.
		this.#syncConfigWarningHeader();
		this.#eventBusUnsubscribers.push(
			onModelRolesChanged(() => {
				void this.#reapplyPlanModeModelOnRoleChange();
			}),
		);
		this.#eventBusUnsubscribers.push(
			this.session.subscribeCommandMetadataChanged(() => {
				const retainedCommands = this.#pendingSlashCommands.filter(command => !command.name.startsWith("skill:"));
				const skillCommands = this.#rebuildSkillCommandsFromSession();
				this.#pendingSlashCommands = [...retainedCommands, ...skillCommands];
			}),
		);
		// Set up theme file watcher
		this.#eventBusUnsubscribers.push(
			onThemeChange(event => {
				this.#clearWorkingMessageAccentCache();
				clearRenderCache();
				clearMermaidCache();
				this.ui.invalidate();
				this.updateEditorBorderColor();
				if (event.ephemeral || isInsideTerminalMultiplexer()) {
					// Theme previews and multiplexer panes use a non-destructive viewport
					// repaint rather than replacing already emitted history.
					this.ui.requestRender();
					return;
				}
				// Rebuild history after a theme swap so a reader scrolled up sees the
				// same palette.
				this.ui.requestRender(true, { clearScrollback: true });
			}),
		);

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		const unsubscribeAppearanceReport = this.ui.terminal.onAppearanceReport?.((_mode, requestToken) => {
			const request = this.#appearanceRefreshRequest;
			if (request === undefined || requestToken !== request.token) return;
			// ProcessTerminal dispatches report callbacks first, then synchronously
			// dispatches onAppearanceChange when the reported appearance changed.
			// That change callback consumes the request below before this microtask
			// runs; an unchanged matching report has no change callback, so it
			// consumes the one-shot here. Comparing the captured request prevents a
			// newer Ctrl+L request from being cleared by this report's microtask.
			queueMicrotask(() => {
				if (this.#appearanceRefreshRequest === request) {
					this.#appearanceRefreshRequest = undefined;
				}
			});
		});
		if (unsubscribeAppearanceReport) {
			this.#eventBusUnsubscribers.push(unsubscribeAppearanceReport);
		}
		this.ui.terminal.onAppearanceChange((mode, requestToken) => {
			const request = this.#appearanceRefreshRequest;
			const appearanceRefreshWasRequested =
				request !== undefined &&
				Date.now() <= request.deadline &&
				(requestToken === request.token || requestToken === undefined);
			if (request !== undefined && requestToken === request.token) {
				this.#appearanceRefreshRequest = undefined;
			}
			// Ctrl+L already replays immediately below. If either its asynchronous
			// OSC 11 response or an automatic query ahead of it reveals a theme
			// change, commit that change so theme loading performs a second full
			// replay with the newly detected palette.
			onTerminalAppearanceChange(mode, appearanceRefreshWasRequested ? {} : undefined);
		});
	}

	/** Reload the title-generation system prompt override for the provided working
	 *  directory and stash it on the session so first-input titling
	 *  ({@link input-controller}) and replan-driven refresh
	 *  ({@link AgentSession.#refreshTitleAfterReplan}) share one source
	 *  ({@link discoverTitleSystemPromptFile}; issue #3734). */
	async refreshTitleSystemPrompt(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const titleSystemPromptSource = discoverTitleSystemPromptFile(basePath);
		const resolved = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		this.session.setTitleSystemPrompt(resolved);
	}

	#rebuildSkillCommandsFromSession(): SlashCommand[] {
		const commands: SlashCommand[] = [];
		this.skillCommands.clear();
		if (this.session.skillsSettings?.enableSkillCommands !== false) {
			const icon = getSlashCommandTypeIcon("skill");
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill);
				commands.push({ name: commandName, description: skill.description, icon });
			}
		}
		return commands;
	}

	/** Reload session skills and the `/skill:<name>` command list. */
	async refreshSkillState(): Promise<void> {
		await this.session.refreshSkills();
		const retainedCommands = this.#pendingSlashCommands.filter(command => !command.name.startsWith("skill:"));
		const skillCommands = this.#rebuildSkillCommandsFromSession();
		this.#pendingSlashCommands = [...retainedCommands, ...skillCommands];
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string, preloaded?: ReadonlyArray<FileSlashCommand>): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		// Session construction already ran slash-command discovery for this cwd;
		// init passes that result through instead of re-walking the providers.
		const fileCommands = preloaded
			? [...preloaded]
			: await loadSlashCommands({
					cwd: basePath,
					extensionRoots: this.session.effectiveExtensionRoots,
				});
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const promptIcon = getSlashCommandTypeIcon("prompt");
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
			icon: promptIcon,
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
				icon: promptIcon,
			}));
		this.#baseAutocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...promptTemplateCommands],
			basePath,
		);
		this.#applyAutocompleteProvider();
		this.session.setSlashCommands(fileCommands);
	}

	/**
	 * Rebuild the editor's autocomplete provider: the built-in provider wrapped
	 * by every extension-registered factory, in registration order. A factory
	 * that throws or returns a malformed provider is skipped so one broken
	 * extension cannot take down core autocomplete.
	 */
	#applyAutocompleteProvider(): void {
		const base = this.#baseAutocompleteProvider;
		if (!base) return;
		let provider = base;
		for (const factory of this.#autocompleteProviderFactories) {
			try {
				const wrapped = factory(provider);
				if (
					wrapped &&
					typeof wrapped.getSuggestions === "function" &&
					typeof wrapped.applyCompletion === "function"
				) {
					provider = wrapped;
				} else {
					logger.warn("Extension autocomplete provider factory returned an invalid provider; skipping it");
				}
			} catch (error) {
				logger.warn("Extension autocomplete provider factory threw; skipping it", { error: String(error) });
			}
		}
		this.editor.setAutocompleteProvider(provider);
	}

	/** Stack extension autocomplete behavior on top of the built-in editor provider (#4919). */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#autocompleteProviderFactories.push(factory);
		this.#applyAutocompleteProvider();
	}

	/**
	 * Re-point the process and every cwd-derived cache at `newCwd` after the
	 * active session's working directory changed (`/move` relocation or resuming
	 * a session from another project). The SessionManager's cwd MUST already
	 * reflect `newCwd` before this is called.
	 */
	async applyCwdChange(newCwd: string): Promise<boolean> {
		const previousCwd = getProjectDir();
		try {
			setProjectDir(newCwd);
		} catch (error) {
			this.showError(
				`Cannot change working directory to ${newCwd}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
		// Everything after chdir is a rescope of cwd-derived state. If any of it
		// fails, undo the chdir so `false` reliably means "nothing committed";
		// callers roll back their own session/manager state on false.
		try {
			// Re-scope project settings (`.claude/settings.yml` etc.) to the new
			// directory in place so the active session and every settings reader pick
			// up the destination project's configuration.
			if (isSettingsInitialized()) {
				await settings.reloadForCwd(newCwd);
				// Reapply provider preferences from the newly-loaded settings so the
				// module-level search/image provider state reflects the destination
				// project's configuration. Without this, the previous project's
				// exclusions leak and newly-excluded providers are still used.
				applyProviderGlobalsFromSettings(settings);
			}
			// Re-warm plugin roots, capabilities, slash commands, and the ssh tool so
			// the next prompt sees everything scoped to the new project directory.
			clearClaudePluginRootsCache();
			await this.refreshTitleSystemPrompt(newCwd);
			resetCapabilities();
			await this.refreshSkillState();
			await this.refreshSlashCommandState(newCwd);
		} catch (error) {
			// Undo the whole transition: the process cwd, Settings scope, and
			// cwd-derived caches (provider globals, plugin roots, capabilities,
			// skills, slash commands) must all return to the source project so a
			// `false` result reliably means nothing was committed.
			this.sessionManager.setCwdWithoutRelocation(previousCwd);
			try {
				setProjectDir(previousCwd);
				if (isSettingsInitialized()) {
					await settings.reloadForCwd(previousCwd);
					applyProviderGlobalsFromSettings(settings);
				}
				clearClaudePluginRootsCache();
				await this.refreshTitleSystemPrompt(previousCwd);
				resetCapabilities();
				await this.refreshSkillState();
				await this.refreshSlashCommandState(previousCwd);
			} catch (restoreError) {
				const actual = this.sessionManager.getCwd();
				try {
					setProjectDir(actual);
					if (isSettingsInitialized()) {
						await settings.reloadForCwd(actual);
						applyProviderGlobalsFromSettings(settings);
					}
					clearClaudePluginRootsCache();
					await this.refreshTitleSystemPrompt(actual);
					resetCapabilities();
					await this.refreshSkillState();
					await this.refreshSlashCommandState(actual);
				} catch {}
				this.showError(
					`Failed to switch to ${newCwd} (${error instanceof Error ? error.message : String(error)}), and restoring the previous workspace failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
				);
				throw new Error(
					`Failed to restore workspace after failed switch to ${newCwd}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)} (workspace may be inconsistent at ${actual})`,
				);
			}
			this.showError(
				`Cannot change working directory to ${newCwd}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.statusLine.applyCwdChange();
		return true;
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
		if (this.#startupSubmitGated) {
			this.#startupSubmitGated = false;
			this.editor.disableSubmit = false;
			this.ui.requestRender();
		}
		this.#scheduleLoopAutoSubmit();
		this.#scheduleGoalContinuation();

		using _ = new EventLoopKeepalive();
		return await promise;
	}

	#scheduleLoopAutoSubmit(): void {
		this.#cancelLoopAutoSubmit();
		if (!this.loopModeEnabled || !this.loopPrompt) return;
		const prompt = this.loopPrompt;
		const loopAction = settings.get("loop.mode");
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

	cancelGoalContinuation(): void {
		this.#cancelGoalContinuation();
	}

	disableGoalMode(message = "Goal mode disabled."): void {
		const was = this.goalModeEnabled;
		this.goalModeEnabled = false;
		this.goalModePaused = false;
		this.#cancelGoalContinuation();
		this.#updateGoalModeStatus();
		if (was) this.showStatus(message);
	}

	#isAutoSubmitBlocked(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork;
	}

	#submitLoopPromptWhenReady(prompt: string): void {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (isLoopDurationExpired(this.loopLimit)) {
			this.disableLoopMode("Loop time limit reached. Loop mode disabled.");
			return;
		}
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => this.#submitLoopPromptWhenReady(prompt));
			return;
		}
		this.onInputCallback(this.startPendingSubmission({ text: prompt }));
	}

	async #runLoopIteration(action: "prompt" | "compact" | "reset", prompt: string): Promise<void> {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		if (action === "reset" && this.vibeModeEnabled) {
			this.disableLoopMode("Exit vibe mode before using reset loops. Loop mode disabled.");
			return;
		}

		if (!consumeLoopLimitIteration(this.loopLimit)) {
			this.disableLoopMode("Loop limit reached. Loop mode disabled.");
			return;
		}
		this.#syncLoopModeStatus();

		if (action === "compact") {
			await this.handleCompactCommand();
		} else if (action === "reset") {
			await this.handleClearCommand();
		}
		this.#submitLoopPromptWhenReady(prompt);
	}

	#syncLoopModeStatus(): void {
		const state: "waiting" | "running" | "paused" = this.loopModePaused
			? "paused"
			: this.loopPrompt
				? "running"
				: "waiting";
		this.statusLine.setLoopModeStatus(this.loopModeEnabled ? { state, limit: this.loopLimit } : undefined);
		this.ui.requestRender();
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.loopModeEnabled;
		this.loopModeEnabled = false;
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = undefined;
		this.#cancelLoopAutoSubmit();
		this.#syncLoopModeStatus();
		if (wasEnabled) {
			this.showStatus(message);
		}
	}

	setLoopPrompt(prompt: string): void {
		if (!this.loopModeEnabled) return;
		this.loopPrompt = prompt;
		this.loopModePaused = false;
		this.#syncLoopModeStatus();
	}

	/**
	 * Pause the loop without exiting it: drops the captured prompt and any
	 * pending auto-resubmit. Loop mode stays enabled — the next prompt the
	 * user submits becomes the new loop prompt and resumes iteration.
	 */
	pauseLoop(): void {
		this.loopPrompt = undefined;
		this.loopModePaused = true;
		this.#cancelLoopAutoSubmit();
		this.#syncLoopModeStatus();
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
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = createLoopLimitRuntime(parsed.limit);
		this.#syncLoopModeStatus();
		const limitSuffix = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const remainingSuffix = this.loopLimit ? ` ${describeLoopLimitRuntime(this.loopLimit)}.` : "";
		const tail = parsed.prompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		this.showStatus(
			`Loop mode enabled.${limitSuffix}${remainingSuffix} ${tail} Esc cancels the current iteration; /loop again to disable.`,
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
	#captureAddedChatComponents(render: () => void): Component[] {
		const start = this.chatContainer.children.length;
		render();
		return this.chatContainer.children.slice(start);
	}

	clearOptimisticUserMessage(): void {
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		this.#optimisticUserMessageComponents = [];
	}

	replaceOptimisticUserMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void {
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		for (const component of this.#optimisticUserMessageComponents) {
			this.chatContainer.removeChild(component);
		}
		this.#optimisticUserMessageComponents = [];
		this.addMessageToChat(message, options);
	}

	/**
	 * Optimistically render a user-invoked `/skill:` row before its awaited
	 * dispatch so a slow preflight (memory recall, `before_agent_start` hooks,
	 * auto-thinking classification, pre-prompt compaction) does not leave the
	 * submission invisible — normal prompts paint their row via
	 * {@link startPendingSubmission} the same way (issue #8895). The canonical
	 * skill `message_start` swaps this row in place via
	 * {@link reconcileOptimisticSkillMessage}; a failed or bailed dispatch drops
	 * it via {@link clearOptimisticSkillMessage}.
	 */
	renderOptimisticSkillMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void {
		this.clearOptimisticSkillMessage();
		this.optimisticSkillMessagePending = true;
		this.#optimisticSkillMessageComponents = this.#captureAddedChatComponents(() => {
			this.addMessageToChat(message, options);
		});
		this.ensureLoadingAnimation();
		this.ui.requestRender();
	}

	/** Replace the optimistic `/skill:` row with the canonical message emitted by
	 *  the session, mirroring {@link replaceOptimisticUserMessage} for skills. */
	reconcileOptimisticSkillMessage(message: AgentMessage): void {
		this.optimisticSkillMessagePending = false;
		for (const component of this.#optimisticSkillMessageComponents) {
			this.chatContainer.removeChild(component);
		}
		this.#optimisticSkillMessageComponents = [];
		this.addMessageToChat(message);
	}

	/** Drop the optimistic `/skill:` row when dispatch fails or bails before the
	 *  message reaches the agent (aborted preflight, streaming-race requeue). */
	clearOptimisticSkillMessage(): void {
		this.optimisticSkillMessagePending = false;
		if (this.#optimisticSkillMessageComponents.length === 0) return;
		for (const component of this.#optimisticSkillMessageComponents) {
			this.chatContainer.removeChild(component);
		}
		this.#optimisticSkillMessageComponents = [];
	}

	startPendingSubmission(
		input: {
			text: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
			customType?: string;
			display?: boolean;
			streamingBehavior?: "steer" | "followUp";
		},
		options?: { preserveDraft?: boolean },
	): SubmittedUserInput {
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
		this.#pendingSubmissionPreservesDraft = options?.preserveDraft === true;
		if (!submission.customType) {
			this.#resetGoalContinuationSuppression();
			const imageCount = submission.images?.length ?? 0;
			this.optimisticUserMessageSignature = `${submission.text}\u0000${imageCount}`;
			this.#pendingSubmissionDispose = this.recordLocalSubmission(submission.text, imageCount);
			this.#optimisticUserMessageComponents = this.#captureAddedChatComponents(() => {
				this.addMessageToChat(
					{
						role: "user",
						content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
						attribution: "user",
						timestamp: Date.now(),
					},
					{ imageLinks: input.imageLinks },
				);
			});
		} else {
			this.clearOptimisticUserMessage();
		}
		if (!options?.preserveDraft) {
			this.editor.setText("");
			this.editor.imageLinks = undefined;
		}
		this.ensureLoadingAnimation();
		if (this.composer.started) this.ui.renderNow();
		else this.ui.requestRender(true);
		return submission;
	}

	cancelPendingSubmission(): boolean {
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.started) {
			return false;
		}
		const preserveDraft = this.#pendingSubmissionPreservesDraft;

		submission.cancelled = true;
		this.#pendingSubmittedInput = undefined;
		this.#pendingSubmissionPreservesDraft = false;
		this.clearOptimisticUserMessage();
		this.#pendingWorkingMessage = undefined;
		if (submission.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		if (!submission.customType && !preserveDraft) {
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

	/**
	 * Hands back a prompt the session dropped before dispatch (an Esc abort or
	 * usage preflight denial raced turn setup). The message was never persisted,
	 * so the tree/branch selectors cannot offer it — remove the optimistic
	 * transcript row and put the typed text back in the editor for editing.
	 */
	#restoreDroppedPrompt(prompt: DroppedPrompt): void {
		this.clearOptimisticUserMessage();
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		this.rebuildChatFromMessages();
		// The drop arrives asynchronously (after the abort settles); never clobber
		// a draft the user has already started typing in the meantime.
		if (!this.editor.getText().trim()) {
			this.editor.pendingImages = prompt.images ? [...prompt.images] : [];
			this.editor.pendingImageLinks = prompt.images ? prompt.images.map(() => undefined) : [];
			this.editor.imageLinks = this.editor.pendingImageLinks;
			this.editor.setText(prompt.text);
		}
		this.ui.requestRender();
	}

	markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
		if (this.#pendingSubmittedInput !== input || input.cancelled) {
			return false;
		}
		input.started = true;
		this.#pendingSubmissionPreservesDraft = false;
		const annotationStateKey = this.#planReviewAnnotationStateBySubmission.get(input);
		if (annotationStateKey) {
			this.#planReviewAnnotationStateBySubmission.delete(input);
			this.#planReviewAnnotationState.delete(annotationStateKey);
		}
		return true;
	}

	finishPendingSubmission(input: SubmittedUserInput): void {
		const wasPendingSubmission = this.#pendingSubmittedInput === input;
		const pendingSubmissionDispose = this.#pendingSubmissionDispose;
		if (wasPendingSubmission) {
			this.#pendingSubmittedInput = undefined;
			this.#pendingSubmissionDispose = undefined;
			this.#pendingSubmissionPreservesDraft = false;
		}
		if (input.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}

		if (wasPendingSubmission && !this.session.isStreaming && !this.streamingComponent) {
			this.optimisticUserMessageSignature = undefined;
			pendingSubmissionDispose?.();
			this.#optimisticUserMessageComponents = [];
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.#stopLoadingAnimation(true);
			}
		}
	}

	#computeEditorMaxHeight(): number {
		return computeEditorMaxHeight(this.ui.terminal.rows);
	}

	#syncEditorMaxHeight(): void {
		this.editor.setMaxHeight(this.#computeEditorMaxHeight());
	}

	syncEditorSpelling(): void {
		this.editor.setSpellingFeatures({
			typoDetection: this.settings.get("spelling.typoDetection"),
			autocomplete: this.settings.get("spelling.autocomplete"),
			autocorrect: this.settings.get("spelling.autocorrect"),
		});
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
			compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
			contextLine: settings.get("statusLine.contextLine"),
		});
	}
	syncComposerShape(): void {
		const shape = settings.get("composer.shape") ?? "band";
		const style = getComposerStyle(shape);
		this.composer.setPreferences({ composerShape: shape });
		this.statusLine.setAutocompleteActiveProbe(() => this.editor.isAutocompleteActive());
		switch (style.statusAttachment) {
			case "top-border":
				this.editor.setTopBorderProvider(availableWidth => this.statusLine.getTopBorder(availableWidth));
				break;
			case "top-band":
				this.editor.setTopBorderProvider(availableWidth => this.statusLine.getBandTopBorder(availableWidth));
				break;
			case "top-rule-chip":
				this.editor.setTopBorderProvider(availableWidth => this.statusLine.getStandaloneTopBorder(availableWidth));
				break;
			case "none":
				this.editor.setTopBorderProvider(undefined);
				this.editor.setTopBorder(undefined);
				break;
		}
		this.statusLine.setComposerStyle(style);
		this.updateEditorBorderColor();
		this.ui.requestRender();
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
			const hex = sessionName ? getSessionAccentHex(sessionName, theme.sessionAccentInputs) : undefined;
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
		this.ui.requestRender();
	}

	/** Refresh the running-subagents status badge from the active local or collab registry. */
	syncRunningSubagentBadge(options: { requestRender?: boolean } = {}): void {
		const registry = getRunningSubagentBadgeRegistry(this.collabGuest);
		if (this.#agentRegistrySubscriptionTarget !== registry) {
			this.#agentRegistryUnsubscribe?.();
			this.#agentRegistrySubscriptionTarget = registry;
			this.#agentRegistryUnsubscribe = registry.onChange(() => {
				this.syncRunningSubagentBadge();
			});
		}
		const agentIds = getRunningSubagentBadgeAgentIds(registry);
		this.statusLine.setRunningSubagents(agentIds);
		if (options.requestRender !== false) this.ui.requestRender();
	}

	rebuildChatFromMessages(options: { reuseSettledComponents?: boolean } = {}): void {
		// Mid-stream rebuilds (e.g. `/shake`, theme/setting changes that touch the
		// transcript) replay only committed `state.messages`. The agent's in-flight
		// `streamMessage` and its still-pending tool calls live OUTSIDE
		// `state.messages` until `message_end`, so a plain clear+replay detaches
		// their UI components while keeping the `streamingComponent` / `pendingTools`
		// references — subsequent `message_update`/`message_end` events would then
		// update orphaned components that never re-render and the live LLM output
		// vanishes from the chat (#3656). Snapshot the in-flight components,
		// clear+replay, then re-append them in their original chat-container order
		// and restore the `pendingTools` map so streaming routes back into them.
		const liveComponents: Component[] = [];
		const livePendingTools = new Map<string, ToolExecutionHandle>();
		if (this.viewSession?.isStreaming) {
			const liveSet = new Set<Component>();
			if (this.streamingComponent) liveSet.add(this.streamingComponent);
			for (const [id, component] of this.pendingTools) {
				livePendingTools.set(id, component);
				liveSet.add(component as unknown as Component);
			}
			if (liveSet.size > 0) {
				for (const child of this.chatContainer.children) {
					if (liveSet.has(child)) liveComponents.push(child);
				}
			}
		}
		this.chatContainer.clear();
		// Live display collapses to the compacted transcript tail unless the
		// user opted into the full inline history; export/resume callers choose
		// their own mode.
		const context = this.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
		});
		const preservedLiveToolCallIds = new Set<string>();
		// A preserved pending-tool component whose result has already landed in
		// the replayed transcript is re-rendered by `renderSessionContext` itself
		// (the toolResult message reconstructs the block with its output). Keeping
		// it in the live set too re-appends a second identical block below the
		// replayed one — the tool call renders twice (#6516). The preservation
		// above assumes every pending-tool component is still dangling (its result
		// lives outside `state.messages`), which stops holding the instant the
		// result is persisted while the component lingers in `pendingTools` (a
		// rebuild racing tool-completion, a background/displaceable snapshot).
		// Drop the already-resolved ones and let the replay own them; only
		// genuinely in-flight (dangling, replay-stripped) calls still need
		// preserving.
		for (const message of context.messages) {
			if (message.role !== "toolResult") continue;
			const resolved = livePendingTools.get(message.toolCallId);
			if (!resolved) continue;
			// A background task's initial `async.state === "running"` result is
			// persisted while `EventController#handleToolExecutionEnd` deliberately
			// keeps its component in `pendingTools` so a later
			// `tool_execution_update`/`_end` settles it. Such a handle is still
			// live — dropping it would strand those updates on the running snapshot
			// — so keep it and let the live component retain ownership; only
			// terminal results are owned by the replay. (Cast mirrors the async
			// detail reads in tool-execution.ts / event-controller.ts.)
			const details = message.details as { async?: { state?: string } } | undefined;
			if (details?.async?.state === "running") {
				preservedLiveToolCallIds.add(message.toolCallId);
				continue;
			}
			livePendingTools.delete(message.toolCallId);
			// A `ReadToolGroupComponent` is shared by every read id it renders
			// (ui-helpers sets the same group for each collapsed read call). While a
			// sibling read id still points at it the component must stay on screen
			// and preserved — splicing it here would detach the pending read's
			// display and strand its future result on an off-screen component.
			// Splice only once no remaining pending id shares it.
			let stillShared = false;
			for (const other of livePendingTools.values()) {
				if (other === resolved) {
					stillShared = true;
					break;
				}
			}
			if (stillShared) {
				// The shared component still owns this completed member as well as
				// its pending sibling. Suppress the replay copy so the group remains
				// a single on-screen block while future results keep routing to it.
				preservedLiveToolCallIds.add(message.toolCallId);
				continue;
			}
			const index = liveComponents.indexOf(resolved as unknown as Component);
			if (index >= 0) liveComponents.splice(index, 1);
		}
		// Prune the settled-component cache to the messages this rebuild will
		// actually render. Message objects stay strongly reachable through
		// session entries for the whole session, so entries for compacted-away
		// history would otherwise pin their components' rendered layout caches
		// forever — exactly the memory a collapsed compaction used to release.
		const retained = new WeakMap<AgentMessage, Component>();
		for (const message of context.messages) {
			const component = this.transcriptMessageComponents.get(message);
			if (component) retained.set(message, component);
		}
		this.transcriptMessageComponents = retained;
		this.renderSessionContext(context, {
			reuseSettledComponents: options.reuseSettledComponents,
			preservedLiveToolCallIds,
		});
		for (const child of liveComponents) {
			this.chatContainer.addChild(child);
		}
		// `renderSessionContext` clears `pendingTools` at start AND end so the
		// reconstructed historical tool components don't leak into live tracking.
		// Restore the in-flight entries afterwards so the next streamed tool-call
		// delta is routed into the preserved component instead of stacking a
		// duplicate ToolExecutionComponent below it.
		for (const [id, component] of livePendingTools) {
			this.pendingTools.set(id, component);
		}
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
		this.#optimisticUserMessageComponents = this.#captureAddedChatComponents(() => {
			this.addMessageToChat(
				{
					role: "user",
					content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
					attribution: "user",
					timestamp: Date.now(),
				},
				{ imageLinks: submission.imageLinks },
			);
		});
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
			case "blocked":
				return theme.fg("warning", `${prefix}${checkbox.unchecked} ${todo.content} (blocked)`) + marker;
			default:
				if (matched) return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
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
	 * Auto-complete any open todo (pending/in_progress/blocked) whose content
	 * matches a subagent that has finished successfully. Fires on every observer
	 * `onChange` so the visual state stays in sync with subagent lifecycle
	 * without requiring the agent to issue a follow-up `todo`. A todo `block`ed
	 * while waiting on a detached subagent is included: that subagent completing
	 * is exactly the unblock signal, and blocked todos are excluded from the stop
	 * reminder, so leaving it blocked would strand it silently. Failed and aborted
	 * subagents are intentionally NOT auto-completed — those stay open so the user
	 * (or the next agent turn) can decide what to do.
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
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") {
					return task;
				}
				if (!todoMatchesAnyDescription(task.content, completedDescs)) return task;
				mutated = true;
				// Drop any blocker note along with the blocked status — the wait the
				// note described is over.
				return { content: task.content, status: "completed" as const };
			}),
		}));
		if (!mutated) return;
		// Persist into the session that owns the snapshot we derived `next` from,
		// not `viewSession`: the two diverge mid focus-attach, and writing to the
		// destination there would clobber its canonical plan. Leaving the owner
		// bound (rather than routing through `setTodos`, which rebinds it to
		// `viewSession`) keeps a follow-up reconcile in the same window correct.
		const owner = this.#todoPhasesOwner ?? this.session;
		owner.setTodoPhases(next);
		this.todoPhases = next;
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.ui.requestRender();
	}

	#cancelTodoAutoClearTimer(): void {
		if (!this.#todoAutoClearTimer) return;
		clearTimeout(this.#todoAutoClearTimer);
		this.#todoAutoClearTimer = undefined;
	}

	/**
	 * Whether every todo is closed, so the HUD has nothing left to track.
	 *
	 * The auto-clear only fires on a settled list. Scrubbing closed tasks while
	 * open work remains is destructive: the walking viewport already hides all but
	 * the newest closed row, and those tasks are what the phase progress counters
	 * and the stage roman numerals are computed from — dropping them mid-run reset
	 * an in-flight phase to `0/n` and renumbered the stages, so a plan the agent
	 * was four tasks into rendered as untouched until the next `todo` call
	 * restored the real snapshot.
	 */
	#isTodoListSettled(phases: TodoPhase[]): boolean {
		let seenTask = false;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (!isClosedTodo(task)) return false;
				seenTask = true;
			}
		}
		return seenTask;
	}

	#syncTodoAutoClearTimer(): void {
		this.#cancelTodoAutoClearTimer();
		const delaySeconds = this.settings.get("tasks.todoClearDelay");
		if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || !this.#isTodoListSettled(this.todoPhases)) return;
		if (delaySeconds === 0) {
			this.todoPhases = [];
			return;
		}

		this.#todoAutoClearTimer = setTimeout(() => {
			this.#todoAutoClearTimer = undefined;
			this.todoPhases = [];
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

	#scheduleObserverUiSync(kind: SessionObserverChangeKind): void {
		if (kind !== "progress") {
			this.#observerUiSyncNeedsTodoReconcile = true;
		}
		if (this.#observerUiSyncTimer) return;
		this.#observerUiSyncTimer = setTimeout(() => {
			this.#observerUiSyncTimer = undefined;
			this.#flushObserverUiSync();
		}, SUBAGENT_OBSERVER_UI_COALESCE_MS);
		this.#observerUiSyncTimer.unref?.();
	}

	#flushObserverUiSync(): void {
		this.syncRunningSubagentBadge({ requestRender: false });
		if (this.#observerUiSyncNeedsTodoReconcile) {
			this.#observerUiSyncNeedsTodoReconcile = false;
			this.#reconcileTodosWithSubagents();
		}
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.#renderSubagentList();
		this.ui.requestRender();
	}

	#cancelObserverUiSyncTimer(): void {
		if (this.#observerUiSyncTimer) {
			clearTimeout(this.#observerUiSyncTimer);
			this.#observerUiSyncTimer = undefined;
		}
		this.#observerUiSyncNeedsTodoReconcile = false;
	}

	#renderTodoList(): void {
		this.todoContainer.clear();
		const phases = this.todoPhases.filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return;
		const expanded = this.todoExpanded;
		const multiPhase = phases.length > 1;
		const activeIdx = phases.indexOf(this.#getActivePhase(phases) ?? phases[0]);
		// Fixed budgets keep the HUD bounded regardless of plan size / progress.
		const subsequentStageCap = 4; // stages shown after the active one (a trailing summary row covers the rest)
		const activeTaskCap = 5; // open tasks previewed for the active stage

		const activeDescs = this.#getActiveSubagentDescriptions();
		// A pending todo "lights up" (accent) when an in-flight subagent is doing
		// its work, matched by normalized content overlap.
		const isMatched = (todo: TodoItem): boolean =>
			activeDescs.length > 0 && todoMatchesAnyDescription(todo.content, activeDescs);

		// Task subtree for a phase. Collapsed runs the shared walking-viewport
		// policy (completed/abandoned omitted, active work pulled to the head,
		// then following pending tasks) so the HUD and the transient tool result
		// can never disagree about the current work (#5873). Expanded lists all.
		const renderTasks = (phase: TodoPhase): string[] => {
			if (expanded) {
				return renderTreeList(
					{
						items: phase.tasks,
						expanded: true,
						renderItem: todo => this.#formatTodoLine(todo, "", isMatched(todo)),
					},
					theme,
				);
			}
			const selection = selectCollapsedTodos(phase.tasks, isMatched, activeTaskCap);
			return renderTreeList(
				{
					items: selection.items,
					itemType: "task",
					trailingSummary: selection.summary,
					renderItem: todo => this.#formatTodoLine(todo, "", isMatched(todo)),
				},
				theme,
			);
		};

		// One phase node. The active stage is highlighted with normal-brightness task
		// progress; other stages render their whole row (name + progress) in the
		// brighter muted gray. Overall progress lives in the tree spine (below).
		const renderPhase = (phase: TodoPhase, oneBased: number, isActive: boolean): string | string[] => {
			const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name;
			// Closed, not just completed: the collapsed task window hides abandoned
			// tasks too, so counting only completions leaves the phase reading stuck.
			const done = phase.tasks.filter(isClosedTodo).length;
			const progress = ` · ${done}/${phase.tasks.length}`;
			if (!isActive) {
				const header = theme.fg("muted", label) + theme.fg("dim", progress);
				return expanded ? [header, ...renderTasks(phase)] : header;
			}
			const header = theme.bold(theme.fg("accent", label)) + theme.fg("dim", progress);
			return [header, ...renderTasks(phase)];
		};

		// Collapsed: active stage + a bounded number of following stages, with a
		// "… n more stages" row for anything past the cap. Expanded: every stage
		// from the top. Roman numerals stay tied to the real phase index.
		const baseIdx = expanded ? 0 : activeIdx;
		const phaseSlice = expanded ? phases.slice(baseIdx) : phases.slice(baseIdx, baseIdx + 1 + subsequentStageCap);
		const hiddenStages = phases.length - baseIdx - phaseSlice.length;

		// Flatten the stage tree into content rows plus a per-row top-level spine
		// glyph (`├─` for stage rows, `│` for continuations). The spine never
		// closes downward — a short elbow tail (`└────`) ends the block instead,
		// so spine + bend + tail form one continuous progress path.
		const spineGlyphs: string[] = [];
		const contentLines: string[] = [];
		const pushBlock = (block: string | string[]): void => {
			const rows = Array.isArray(block) ? block : [block];
			if (rows.length === 0) return;
			spineGlyphs.push(`${theme.tree.branch} `);
			contentLines.push(replaceTabs(rows[0]!));
			for (let i = 1; i < rows.length; i++) {
				spineGlyphs.push(`${theme.tree.vertical}  `);
				contentLines.push(replaceTabs(rows[i]!));
			}
		};
		for (let i = 0; i < phaseSlice.length; i++) {
			pushBlock(renderPhase(phaseSlice[i], baseIdx + i + 1, baseIdx + i === activeIdx));
		}
		if (hiddenStages > 0) {
			pushBlock(theme.fg("muted", formatMoreItems(hiddenStages, "stage")));
		}

		// Closing tail: hook + a few horizontals. Every tail cell is 1 column in
		// both glyph sets, so string slicing below splits it by visible cells.
		const tailLen = 6;
		const tail = theme.tree.hook + theme.tree.horizontal.repeat(Math.max(0, tailLen - visibleWidth(theme.tree.hook)));

		// Overall progress (summed across every stage) fills the path in reading
		// order: down the spine, around the bend, out along the tail.
		// Clamp so partial progress lights at least one cell; a closed plan fills
		// the entire path until the configured auto-clear removes the HUD.
		const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		const closedTasks = phases.reduce((sum, phase) => sum + phase.tasks.filter(isClosedTodo).length, 0);
		const pathLen = contentLines.length + tailLen;
		let filled = Math.round((closedTasks / totalTasks) * pathLen);
		if (closedTasks > 0) filled = Math.max(filled, 1);
		if (closedTasks < totalTasks) filled = Math.min(filled, pathLen - 1);

		const lines = ["", theme.bold(theme.fg("accent", "TODO"))];
		for (let i = 0; i < contentLines.length; i++) {
			lines.push(` ${theme.fg(i < filled ? "accent" : "dim", spineGlyphs[i]!)}${contentLines[i]}`);
		}
		const tailFilled = Math.max(0, Math.min(filled - contentLines.length, tail.length));
		lines.push(` ${theme.fg("accent", tail.slice(0, tailFilled))}${theme.fg("dim", tail.slice(tailFilled))}`);
		this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	isCompactTodoMode(): boolean {
		const rows = this.ui?.terminal?.rows ?? process.stdout.rows ?? 24;
		return rows < TODO_COMPACT_TERMINAL_ROWS_THRESHOLD;
	}

	renderCompactStatusLine(width: number, childLines: readonly string[]): readonly string[] {
		const phases = this.todoPhases.filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return childLines;

		const activeDescs = this.#getActiveSubagentDescriptions();
		const isMatched = (todo: TodoItem): boolean =>
			activeDescs.length > 0 && todoMatchesAnyDescription(todo.content, activeDescs);

		const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		const closedTasks = phases.reduce((sum, phase) => sum + phase.tasks.filter(isClosedTodo).length, 0);
		const activeTask = nextActionableTask(phases);

		const header = `${theme.bold(theme.fg("accent", "TODO"))} ${theme.fg("dim", `${closedTasks}/${totalTasks}`)}`;
		const taskStr = activeTask
			? this.#formatTodoLine(activeTask, "", isMatched(activeTask))
			: theme.fg("success", `${theme.checkbox.checked} done`);
		const rightLine = `${header} ${theme.fg("dim", "·")} ${taskStr}`;

		const rightPad = " ";
		const rightWidth = visibleWidth(rightLine) + 1;

		let leftLine = "";
		if (childLines.length > 0) {
			leftLine = childLines[childLines.length - 1] ?? "";
		}

		const leftWidth = visibleWidth(leftLine);
		const minGap = 2;

		let combinedLine: string;
		if (leftWidth === 0) {
			if (rightWidth <= width) {
				const gap = Math.max(0, width - rightWidth);
				combinedLine = " ".repeat(gap) + rightLine + rightPad;
			} else {
				const maxRight = Math.max(4, width - 1);
				const truncatedRight = truncateToWidth(rightLine, maxRight);
				const gap = Math.max(0, width - visibleWidth(truncatedRight) - 1);
				combinedLine = " ".repeat(gap) + truncatedRight + rightPad;
			}
		} else {
			if (leftWidth + minGap + rightWidth <= width) {
				const gap = width - leftWidth - rightWidth;
				combinedLine = leftLine + " ".repeat(gap) + rightLine + rightPad;
			} else {
				const maxRight = Math.min(rightWidth, Math.max(10, Math.floor(width * 0.45)));
				const truncatedRight = truncateToWidth(rightLine, maxRight);
				const truncatedRightWidth = visibleWidth(truncatedRight) + 1;
				const availableLeft = Math.max(4, width - truncatedRightWidth - minGap);
				const truncatedLeft = truncateToWidth(leftLine, availableLeft);
				const gap = Math.max(minGap, width - visibleWidth(truncatedLeft) - truncatedRightWidth);
				combinedLine = truncatedLeft + " ".repeat(gap) + truncatedRight + rightPad;
			}
		}

		const leadingLines = childLines.length > 1 ? childLines.slice(0, -1) : [""];
		return [...leadingLines, combinedLine];
	}

	/**
	 * Anchored HUD of in-flight subagents, mirroring the Todos block above the

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

	async #loadTodoList(source: AgentSession = this.session): Promise<void> {
		this.todoPhases = source.getTodoPhases();
		this.#todoPhasesOwner = source;
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
		this.ui.requestRender();
	}

	#updateVibeModeStatus(): void {
		this.statusLine.setVibeModeStatus(this.vibeModeEnabled ? { enabled: true } : undefined);
		this.ui.requestRender();
	}

	#vibeParentSession(): VibeParentSession {
		return {
			getAgentId: () => this.session.getAgentId() ?? null,
			getSessionId: () => this.sessionManager.getSessionId(),
			getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
			sessionManager: this.sessionManager,
			asyncJobManager: this.session.asyncJobManager,
			settings: this.session.settings,
			// Resolve restored/switched-to workers against this session's active model
			// (same as the spawn-path ToolSession), not the settings default. This is
			// the primary fallback in resolveAgentModelPatterns, so the `good` worker's
			// pi/task inheritance tracks the reopened session's model.
			getActiveModelString: () => (this.session.model ? formatModelString(this.session.model) : undefined),
		};
	}

	async #quiesceVibeForSessionSwitch(): Promise<void> {
		const ownerScope = this.#vibeModeOwnerScope;
		if (!this.vibeModeEnabled || !ownerScope) return;
		await VibeSessionRegistry.global().suspendScope(ownerScope, this.session.asyncJobManager);
		this.#vibeScopeSuspendedForSwitch = true;
	}

	#updateGoalModeStatus(): void {
		const status =
			this.goalModeEnabled || this.goalModePaused
				? { enabled: this.goalModeEnabled, paused: this.goalModePaused }
				: undefined;
		this.statusLine.setGoalModeStatus(status);
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
		// Capture the pre-plan model so #exitPlanMode can restore it. Only the
		// entry path records this — a mid-planning role change (below) leaves the
		// active model on the plan role, so overwriting here would restore the old
		// plan model instead of the user's real pre-plan model.
		this.#planModePreviousModelState = currentModel
			? { model: currentModel, thinkingLevel: this.session.configuredThinkingLevel() }
			: undefined;

		await this.#applyPlanModelTransition(currentModel, resolved);
	}

	/**
	 * Re-resolve the `plan` role and move the active model onto it. Fires when
	 * the plan role is reassigned while plan mode is active: the active model IS
	 * the plan model there, so a settings-only change would otherwise leave the
	 * current turn on the model plan mode was entered with (issue #5657). No-op
	 * outside plan mode — role reassignment for an inactive role only touches
	 * settings.
	 */
	async #reapplyPlanModeModelOnRoleChange(): Promise<void> {
		if (!this.planModeEnabled) return;
		const resolved = this.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) {
			this.#clearPendingPlanModelSwitch();
			return;
		}
		await this.#applyPlanModelTransition(this.session.model, resolved);
	}

	/**
	 * Drop a stale deferred switch that was queued for a previous plan-role
	 * assignment. Other deferred switches (such as restoring the pre-plan
	 * model) remain intact.
	 */
	#clearPendingPlanModelSwitch(): void {
		if (!this.#pendingPlanModelSwitch) return;
		this.#pendingModelSwitch = undefined;
		this.#pendingPlanModelSwitch = false;
	}

	/** Apply (or defer) the model/thinking change implied by the resolved plan role. */
	async #applyPlanModelTransition(currentModel: Model | undefined, resolved: ResolvedModelRoleValue): Promise<void> {
		const transition = resolvePlanModelTransition(currentModel, resolved, this.session.isStreaming);
		if (transition.kind !== "apply" || !transition.deferred) {
			this.#clearPendingPlanModelSwitch();
		}
		switch (transition.kind) {
			case "none":
				return;
			case "thinking":
				this.session.setThinkingLevel(transition.thinkingLevel);
				return;
			case "apply":
				if (transition.deferred) {
					this.#pendingModelSwitch = { model: transition.model, thinkingLevel: transition.thinkingLevel };
					this.#pendingPlanModelSwitch = true;
					return;
				}
				try {
					await this.session.setModelTemporary(transition.model, transition.thinkingLevel);
				} catch (error) {
					this.showWarning(
						`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
		}
	}

	/** Apply any deferred model switch after the current stream ends. */
	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		this.#pendingModelSwitch = undefined;
		this.#pendingPlanModelSwitch = false;
		if (!pending) return;
		try {
			await this.session.setModelTemporary(pending.model, pending.thinkingLevel);
		} catch (error) {
			this.showWarning(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #clearTransientModeState(options?: {
		preserveVibe?: boolean;
		vibeScopeAlreadySuspended?: boolean;
	}): Promise<void> {
		if (this.planModeEnabled || this.planModePaused) {
			this.session.setPlanModeState(undefined);
			try {
				if (this.#planModePreviousTools !== undefined) {
					await this.session.setActiveToolsByName(this.#planModePreviousTools);
				}
			} finally {
				this.session.setPlanProposalHandler?.(null);
				this.planModeEnabled = false;
				this.planModePaused = false;
				this.planModePlanFilePath = undefined;
				this.#planModePreviousTools = undefined;
				this.#planModePreviousModelState = undefined;
				this.#pendingModelSwitch = undefined;
				this.#pendingPlanModelSwitch = false;
				this.#planModeHasEntered = false;
				this.#updatePlanModeStatus();
			}
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

		if (this.vibeModeEnabled && !options?.preserveVibe) {
			const ownerScope = this.#vibeModeOwnerScope;
			// This runs only from #reconcileModeFromSession, i.e. after switchSession
			// already loaded and restored the target session's active tools. The
			// #vibeModePreviousTools snapshot belongs to the SOURCE session, so
			// applying it here would clobber the target's tools — strip only the
			// transient vibe tools and keep the target's active set intact.
			await this.session.removeVibeToolsPreservingActive();
			this.session.setVibeModeState(undefined);
			this.vibeModeEnabled = false;
			this.#vibeModePreviousTools = undefined;
			this.#vibeModeOwnerScope = undefined;
			if (ownerScope && !options?.vibeScopeAlreadySuspended) {
				await VibeSessionRegistry.global().suspendScope(ownerScope, this.session.asyncJobManager);
			}
			this.#updateVibeModeStatus();
		}
	}

	/** Reconcile mode state from session entries on resume/switch. */
	async #reconcileModeFromSession(options?: { preserveActiveGoal?: boolean }): Promise<void> {
		const vibeScopeAlreadySuspended = this.#vibeScopeSuspendedForSwitch;
		this.#vibeScopeSuspendedForSwitch = false;
		const sessionContext = this.sessionManager.buildSessionContext();
		const vibeSession = this.#vibeParentSession();
		const targetVibeScope = VibeSessionRegistry.global().ownerScope(vibeSession);
		const preserveVibe =
			this.vibeModeEnabled &&
			sessionContext.mode === "vibe" &&
			this.#vibeModeOwnerScope?.ownerId === targetVibeScope.ownerId &&
			this.#vibeModeOwnerScope.parentSessionId === targetVibeScope.parentSessionId &&
			this.#vibeModeOwnerScope.parentSessionFile === targetVibeScope.parentSessionFile;
		// #clearTransientModeState below keeps the live active set instead of
		// applying a snapshot, so for a vibe -> vibe switch the live toolset is
		// already the reduced vibe set and cannot serve as the pre-vibe snapshot.
		// That is the only case the persisted snapshot is for: a cold resume or a
		// switch in from a non-vibe session built its toolset from the current CLI
		// flags and settings, and that set — not a historical one — is what exiting
		// vibe must restore.
		const vibeToolsetLostToTeardown = this.vibeModeEnabled && !preserveVibe;
		await this.#clearTransientModeState({ preserveVibe, vibeScopeAlreadySuspended });
		await VibeSessionRegistry.global().rehydrate(vibeSession);
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
				const previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
				this.#goalModePreviousTools = previousTools;
				await this.session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
			}
			this.#updateGoalModeStatus();
			return;
		}
		this.session.goalRuntime.clearAccounting();
		if (sessionContext.mode === "vibe") {
			if (!preserveVibe) {
				await this.#enterVibeMode({
					persistModeChange: false,
					previousTools: vibeToolsetLostToTeardown
						? readPersistedToolNames(sessionContext.modeData?.previousTools)
						: undefined,
				});
			}
			return;
		}
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
			await this.#enterPlanMode({ planFilePath, preserveRestoredModel: true });
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.#planModeHasEntered = true;
			this.#updatePlanModeStatus();
		}
	}

	async #enterPlanMode(options?: {
		planFilePath?: string;
		workflow?: "parallel" | "iterative";
		preserveRestoredModel?: boolean;
	}): Promise<void> {
		if (this.planModeEnabled) {
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? (await this.#getPlanFilePath());
		const previousTools = this.session.getEnabledToolNames();
		// `plan-mode-active.md` instructs the agent to draft the plan file with
		// `write` and refine it with `edit`, and plan approval itself is a `write`
		// to `xd://propose`. Both must be in the active set or the agent falls
		// back to `edit` on a non-existent file and stalls — and cannot submit the plan.
		// `edit` is an essential built-in and always ships top-level; re-activate
		// `write` here only when the current registry entry is the built-in write
		// tool (issue #3165). A shadowing extension tool named `write` must stay
		// inactive because plan mode's read-only guarantee relies on the built-in
		// write/edit guard. The standing handler below consumes plan-approval
		// dispatches.
		const planAugmentations: string[] = [];
		if (this.session.hasBuiltInTool("write")) {
			planAugmentations.push("write");
		}
		const uniquePlanTools = [...new Set([...previousTools, ...planAugmentations])];

		this.#planModePreviousTools = previousTools;
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;
		// Suppress cache-miss marker on the next turn: plan mode changes the system
		// prompt, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;

		// Plan mode state must land before the tool partition: under Code Mode the
		// direct surface keeps `write` only while a transport needs it, and plan
		// approval is a top-level `write` to `xd://propose`.
		const previousPlanModeState = this.session.getPlanModeState();
		this.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#planModeHasEntered,
		});
		try {
			await this.session.setActiveToolsByName(uniquePlanTools);
		} catch (error) {
			this.session.setPlanModeState(previousPlanModeState);
			this.planModeEnabled = false;
			throw error;
		}
		this.session.setPlanProposalHandler?.(title => this.session.preparePlanForReview(title));
		if (this.session.isStreaming) {
			await this.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#planModeHasEntered = true;
		// Session loading already restored the model recorded in the journal.
		// Reapplying today's plan role here would replace a CLI/session-specific
		// selection with current config during --resume or an in-process switch.
		if (!options?.preserveRestoredModel) {
			await this.#applyPlanModeModel();
		}
		this.#updatePlanModeStatus();
		this.sessionManager.appendModeChange("plan", { planFilePath });
		this.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	async #restorePlanPreviousModel(prev: { model: Model; thinkingLevel?: ConfiguredThinkingLevel }): Promise<void> {
		if (modelsAreEqual(this.session.model, prev.model)) {
			// Same model — only thinking level may differ. Avoid setModelTemporary()
			// which would reset provider-side sessions and break continuity.
			this.session.setThinkingLevel(prev.thinkingLevel);
		} else if (this.session.isStreaming) {
			this.#pendingModelSwitch = { model: prev.model, thinkingLevel: prev.thinkingLevel };
			this.#pendingPlanModelSwitch = false;
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

	async #exitPlanMode(options?: {
		silent?: boolean;
		paused?: boolean;
		deferModelRestore?: boolean;
		interruptActiveTurn?: boolean;
	}): Promise<void> {
		if (!this.planModeEnabled) {
			return;
		}
		// A mid-turn exit must interrupt the currently streaming turn.
		// The plan-mode prompt instructs the model to keep planning until it
		// writes to `xd://propose`, so the live turn must be aborted inside
		// `runModeExitTeardown` to avoid restarting on the stale toolset.
		if (options?.interruptActiveTurn && this.session.isStreaming) {
			await this.session.runModeExitTeardown(async () => {
				await this.session.abort({ reason: USER_INTERRUPT_LABEL });
				await this.#tearDownPlanMode(options);
			});
			return;
		}
		await this.#tearDownPlanMode(options);
	}

	async #tearDownPlanMode(options?: {
		silent?: boolean;
		paused?: boolean;
		deferModelRestore?: boolean;
	}): Promise<void> {
		const planModeState = this.session.getPlanModeState();
		const planModeTools = this.session.getEnabledToolNames();
		const planModeMountedTools = this.session.getMountedXdevToolNames();
		const planModeModelState = this.session.model
			? { model: this.session.model, thinkingLevel: this.session.configuredThinkingLevel() }
			: undefined;
		this.session.setPlanModeState(undefined);
		try {
			if (this.#planModePreviousTools !== undefined) {
				await this.session.setActiveToolsByName(this.#planModePreviousTools);
			}
			if (this.#planModePreviousModelState && !options?.deferModelRestore) {
				await this.#restorePlanPreviousModel(this.#planModePreviousModelState);
			}
			// If #applyPlanModeModel queued a deferred switch to the plan-role model
			// (because the session was streaming on entry), drop it now: we are
			// leaving plan mode, so flushing it on the next agent_end would land the
			// session on the plan-role model after the user has exited plan mode
			// (issue #816). This runs even when deferModelRestore is set
			// (compact-approval path): otherwise the stale plan switch survives and
			// flushPendingModelSwitch() later clobbers the restored/execution model.
			if (this.#planModePreviousModelState) this.#clearPendingPlanModelSwitch();
		} catch (error) {
			this.session.setPlanModeState(planModeState);
			if (
				planModeModelState &&
				(!modelsAreEqual(this.session.model, planModeModelState.model) ||
					this.session.configuredThinkingLevel() !== planModeModelState.thinkingLevel)
			) {
				try {
					await this.#restorePlanPreviousModel(planModeModelState);
				} catch (rollbackError) {
					logger.warn("Failed to restore plan model after plan exit failure", { error: String(rollbackError) });
				}
			}
			const enabledTools = this.session.getEnabledToolNames();
			const mountedTools = this.session.getMountedXdevToolNames();
			if (
				enabledTools.length !== planModeTools.length ||
				enabledTools.some((name, index) => name !== planModeTools[index]) ||
				mountedTools.length !== planModeMountedTools.length ||
				mountedTools.some((name, index) => name !== planModeMountedTools[index])
			) {
				try {
					await this.session.setActiveToolPresentation(planModeTools, planModeMountedTools);
				} catch (rollbackError) {
					logger.warn("Failed to restore plan tools after plan exit failure", { error: String(rollbackError) });
				}
			}
			throw error;
		}
		this.session.setPlanProposalHandler?.(null);
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
		if (this.goalModeEnabled) {
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return;
		}
		const previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
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
			annotationState?: PlanReviewAnnotationState;
			onAnnotationStateChange?: (state: PlanReviewAnnotationState) => void;
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
			resolve(choice);
		};
		this.#planReviewCancel = () => finish(undefined);
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
				annotationState: dialogOptions?.annotationState,
			},
			{
				onPick: choice => finish(choice),
				onCancel: () => finish(undefined),
				onCopyPlan: content => void this.#copyPlanToClipboard(content),
				onExternalEditor: dialogOptions?.onExternalEditor,
				onAnnotationExternalEditor: (draft, commit) => void this.#openPlanAnnotationInExternalEditor(draft, commit),
				onPlanEdited: dialogOptions?.onPlanEdited,
				onFeedbackChange: dialogOptions?.onFeedbackChange,
				onAnnotationStateChange: dialogOptions?.onAnnotationStateChange,
			},
		);
		this.#planReviewOverlay = overlay;
		this.#planReviewOverlayHandle = this.ui.showOverlay(overlay, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
			mouseTracking: false,
		});
		this.ui.setFocus(overlay);
		this.ui.requestRender();
		return promise;
	}

	#hidePlanReview(): void {
		this.#planReviewCancel = undefined;
		this.#planReviewOverlayHandle?.hide();
		this.#planReviewOverlayHandle = undefined;
		this.#planReviewOverlay = undefined;
	}

	#dismissPlanReview(): void {
		const cancel = this.#planReviewCancel;
		this.#planReviewCancel = undefined;
		cancel?.();
		this.#hidePlanReview();
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

	async #copyPlanToClipboard(content: string): Promise<void> {
		try {
			await copyToClipboard(content);
			this.showStatus("Copied plan to clipboard");
		} catch (error) {
			this.showWarning(
				`Failed to copy plan to clipboard: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #promptPlanSavePath(planContent: string, title: string): Promise<string | undefined> {
		let suggestedPath = planSaveFileName(title);
		let overlay: PlanSaveOverlay | undefined;
		const excerpt = planSaveTitleExcerpt(planContent);
		if (excerpt) {
			void this.session
				.generateTitle(excerpt, PLAN_FILENAME_SYSTEM_PROMPT)
				.then(generatedTitle => {
					if (!generatedTitle) return;
					suggestedPath = planSaveFileName(generatedTitle);
					overlay?.setSuggestedPath(suggestedPath);
					this.ui.requestRender();
				})
				.catch(error => {
					logger.debug("plan-save: filename generation failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
		}
		try {
			const result = await this.showHookCustom<PlanSaveOverlayResult | undefined>(
				(_tui, _theme, _keybindings, done) => {
					overlay = new PlanSaveOverlay(suggestedPath, done);
					return overlay;
				},
				{ overlay: true },
			);
			return result?.path;
		} finally {
			overlay = undefined;
		}
	}

	async #savePlanAndQuit(planContent: string, title: string, annotationStateKey: string): Promise<void> {
		const selectedPath = await this.#promptPlanSavePath(planContent, title);
		if (!selectedPath) return;

		let destination: string;
		try {
			destination = resolveToCwd(selectedPath, this.sessionManager.getCwd());
		} catch (error) {
			this.showError(`Invalid plan save path: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		try {
			await Bun.write(destination, planContent);
		} catch (error) {
			this.showError(
				`Failed to save plan to ${shortenPath(destination)}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		try {
			await this.#exitPlanMode({ silent: true });
		} catch (error) {
			this.showError(
				`Saved plan to ${shortenPath(destination)}, but could not exit plan mode: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return;
		}

		this.#planReviewAnnotationState.delete(annotationStateKey);
		try {
			await this.handleClearCommand();
			this.showStatus(`Saved plan to ${shortenPath(destination)}.`);
		} catch (error) {
			this.showError(
				`Saved plan to ${shortenPath(destination)}, but could not start a new session: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
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

		try {
			this.ui.stop();
			const result = await openInEditor(editorCmd, currentText, {
				extension: path.extname(resolvedPath) || ".md",
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

		try {
			this.ui.stop();
			const result = await openInEditor(editorCmd, draft, { extension: ".md" });
			if (result !== null) {
				commit(result);
			}
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
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

	#resolveLocalRoot(): string {
		return resolveLocalUrlToPath("local://", {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		});
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
	): Promise<boolean> {
		const previousTools = this.#planModePreviousTools ?? this.session.getEnabledToolNames();

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
				const oldLocalRoot = this.#resolveLocalRoot();
				await this.handleClearCommand();
				const newLocalRoot = this.#resolveLocalRoot();
				await copyLocalArtifacts(oldLocalRoot, newLocalRoot);
				const newLocalPath = resolveLocalUrlToPath(options.planFilePath, {
					getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
					getSessionId: () => this.sessionManager.getSessionId(),
				});
				await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
				await fs.writeFile(newLocalPath, planContent);
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
				// Ride the plan-mode distillation prompt through as `internalGuidance`
				// so it reaches native summarization without leaking into the public
				// `customInstructions` channel on `session_before_compact` — extensions
				// there treat that field as user focus and would query-bias the
				// summary toward the plan boilerplate (issue #4359).
				compactOutcome = await this.handleCompactCommand(
					undefined,
					undefined,
					outcome => this.#applyDeferredPlanModelTransition(outcome, options.executionModel),
					compactionPrompt,
				);
			}
		} finally {
			// Unconditional clear. Idempotent: a no-op when the flag was never set
			// (i.e., the !compactBeforeExecute branch), and a no-op when the flag
			// was already consumed by AgentSession.#handleAgentEvent's aborted
			// message_end stamping. Guarantees the flag is dead at every exit.
			this.session.clearPlanInternalAbortPending();
		}

		// Restore the execution tool set, but force-enable `read`: approved-plan
		// prompts now require loading the durable local:// plan file before work.
		const executionTools = previousTools.includes("read") ? previousTools : [...previousTools, "read"];
		await this.session.setActiveToolsByName(executionTools);
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
			return false;
		}

		// Approved plans land in a fresh (or compacted) session whose first user-visible
		// turn is the synthetic plan-approved prompt — that path bypasses the
		// input-controller's title generation. Seed an auto-name from the plan title
		// so the session is not left unnamed. `setSessionName("auto")` is a no-op
		// when the user has already chosen a name (preserveContext paths).
		const seededName = humanizePlanTitle(options.title);
		if (seededName && !this.sessionManager.getSessionName()) {
			await this.sessionManager.setSessionName(seededName, "auto");
		}

		// markPlanReferenceSent fires only on the dispatch path so the synthetic
		// plan-approved prompt is the source of the reference injection.
		this.session.markPlanReferenceSent();
		const planModePrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath: options.planFilePath,
			contextPreserved: options.preserveContext === true,
		});
		// Close the review overlay only now — after the async title write and plan
		// prompt are prepared, immediately before the execution turn is queued. The
		// synthetic prompt below blocks in `session.prompt` for the whole run, so
		// hiding here (rather than after #approvePlan returns) keeps the operator off
		// the stale plan-review screen (issue #5688) while #5319's stale-buffer guard
		// stays intact. Deferring the hide past the awaited `setSessionName` also
		// prevents restored editor focus from letting operator keystrokes submit a
		// normal turn ahead of the approved execution turn (PR #5689 review).
		// `#hidePlanReview` is idempotent, so the caller's trailing `closePlanReview()`
		// — and the cancelled/error early returns above — stay safe no-ops.
		this.#hidePlanReview();
		this.ui.requestRender();
		// A user turn queued during compaction was already fired by
		// `flushCompactionQueue` before we returned from `handleCompactCommand`; the
		// old abort-then-prompt path would have discarded that operator turn AND
		// still surfaced `AgentBusyError` when the queued turn kicked off in the
		// synchronous gap. Preserve the in-flight work and queue the hidden
		// execution directive behind it as a synthetic follow-up. If `isStreaming`
		// flips true between the check and dispatch (the same fire-and-forget race
		// noted below), catch `AgentBusyError` and fall back to the same queue.
		if (this.session.isStreaming) {
			await this.session.followUp(planModePrompt, undefined, { synthetic: true });
		} else {
			try {
				await this.session.prompt(planModePrompt, { synthetic: true });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await this.session.followUp(planModePrompt, undefined, { synthetic: true });
			}
		}
		return true;
	}
	async #abortPlanApprovalTurnSilently(): Promise<void> {
		this.session.markPlanInternalAbortPending();
		try {
			await this.session.abort();
		} finally {
			this.session.clearPlanInternalAbortPending();
		}
	}

	async handlePlanModeCommand(
		initialPrompt?: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return false;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return false;
		}
		if (this.planModeEnabled) {
			const planFilePath = this.planModePlanFilePath ?? (await this.#getPlanFilePath());
			if (await this.#hasPlanModeDraftContent(planFilePath)) {
				const confirmed = await this.showHookConfirm(
					"Exit plan mode?",
					"This exits plan mode without approving a plan.",
				);
				if (!confirmed) return false;
			}
			await this.#exitPlanMode({ paused: true, interruptActiveTurn: true });
			return false;
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
			return false;
		}
		if (!this.session.settings.get("plan.enabled")) {
			this.showWarning("Plan mode is disabled. Enable it in settings (plan.enabled).");
			return false;
		}
		await this.#enterPlanMode();
		if (!initialPrompt) return false;
		if (isKnownSkillCommand(this, initialPrompt)) {
			await invokeSkillCommandFromText(this, initialPrompt, "steer", {
				images: input?.images,
				propagateErrors: true,
			});
			return true;
		}
		if (this.session.isStreaming) {
			const images = input?.images?.length ? input.images : undefined;
			await this.withLocalSubmission(
				initialPrompt,
				() => this.session.prompt(initialPrompt, { streamingBehavior: "steer", images }),
				{ imageCount: images?.length ?? 0 },
			);
			return true;
		}
		if (this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt, ...input }, { preserveDraft: true }));
			return true;
		}
		return false;
	}

	/**
	 * `/vibe` toggle. Entering installs the ephemeral vibe tools, strips the
	 * active toolset down to `read`, optional parent-owned `todo`, plus those
	 * tools, and injects the director context. Exiting unregisters them, restores
	 * the previous toolset, and kills every worker session so workers cannot
	 * outlive the mode that directs them.
	 */
	async handleVibeModeCommand(
		initialPrompt?: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		if (this.vibeModeEnabled) {
			await this.#exitVibeMode();
			return false;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return false;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return false;
		}
		await this.#enterVibeMode();
		if (!initialPrompt) return false;
		if (isKnownSkillCommand(this, initialPrompt)) {
			await invokeSkillCommandFromText(this, initialPrompt, "steer", {
				images: input?.images,
				propagateErrors: true,
			});
			return true;
		}
		if (this.session.isStreaming) {
			const images = input?.images?.length ? input.images : undefined;
			await this.withLocalSubmission(
				initialPrompt,
				() => this.session.prompt(initialPrompt, { streamingBehavior: "steer", images }),
				{ imageCount: images?.length ?? 0 },
			);
			return true;
		}
		if (this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt, ...input }, { preserveDraft: true }));
			return true;
		}
		return false;
	}

	async #enterVibeMode(options?: { persistModeChange?: boolean; previousTools?: string[] }): Promise<void> {
		if (this.vibeModeEnabled) {
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}

		const vibeRegistry = VibeSessionRegistry.global();
		const ownerScope = vibeRegistry.ownerScope(this.#vibeParentSession());
		vibeRegistry.activateScope(ownerScope);
		// When a vibe session switches into another session that is also in vibe
		// mode, the teardown keeps the live active set, which is by then the reduced
		// vibe set, so re-snapshotting it here would make the snapshot useless. That
		// path passes the pre-vibe toolset recorded on the target's own mode_change
		// entry instead.
		const previousTools = options?.previousTools ?? this.session.getEnabledToolNames();
		const vibeBaseTools = ["read"];
		if (this.session.hasBuiltInTool("todo")) vibeBaseTools.push("todo");
		await this.session.activateVibeTools(vibeBaseTools);
		this.#vibeModePreviousTools = previousTools;
		this.#vibeModeOwnerScope = ownerScope;
		this.vibeModeEnabled = true;
		// Suppress cache-miss marker on the next turn: vibe mode changes the
		// injected context, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;
		this.session.setVibeModeState({ enabled: true });
		if (this.session.isStreaming) {
			await this.session.sendVibeModeContext({ deliverAs: "steer" });
		}
		this.#updateVibeModeStatus();
		if (options?.persistModeChange !== false) this.sessionManager.appendModeChange("vibe", { previousTools });
		this.showStatus(
			"Vibe mode enabled. You direct fast/good worker sessions; toolset is read + optional parent Todo + vibe tools.",
		);
	}

	async #exitVibeMode(): Promise<void> {
		if (!this.vibeModeEnabled) {
			return;
		}
		// Tear down with the queued-message drain suppressed: aborting the active
		// turn would otherwise let a queued user steer/follow-up restart on the
		// still-live Vibe tools before this teardown removes them (issue #8326).
		let killed = 0;
		await this.session.runModeExitTeardown(async () => {
			if (this.session.isStreaming) {
				await this.session.abort();
			}
			killed = await VibeSessionRegistry.global().killAll(this.#vibeParentSession(), this.#vibeModeOwnerScope);
			await this.session.deactivateVibeTools(this.#vibeModePreviousTools ?? []);
			this.session.setVibeModeState(undefined);
		});
		this.vibeModeEnabled = false;
		this.#vibeModePreviousTools = undefined;
		this.#vibeModeOwnerScope = undefined;
		this.lastAssistantUsage = undefined;
		this.#updateVibeModeStatus();
		this.showStatus(
			killed > 0
				? `Vibe mode disabled. Killed ${killed} worker session${killed === 1 ? "" : "s"}.`
				: "Vibe mode disabled.",
		);
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

	async handleGoalModeCommand(
		rest?: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return false;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return false;
		}
		if (!this.session.settings.get("goal.enabled")) {
			this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
			return false;
		}
		const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
		if (sub) return await this.#dispatchGoalSubcommand(sub, subRest, input);
		if (this.goalModeEnabled) {
			if (subRest) {
				this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
				return false;
			}
			await this.#openGoalMenu("active");
			return false;
		}
		const pausedState = this.#getPausedGoalState();
		if (pausedState) {
			if (subRest) {
				this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return false;
			}
			await this.#openGoalMenu("paused");
			return false;
		}
		if (subRest) return await this.#startGoalFromObjective(subRest, input);
		const objective = (
			await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true })
		)?.trim();
		if (!objective) return false;
		return await this.#startGoalFromObjective(objective, input);
	}
	async handleGuidedGoalCommand(
		rest?: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		try {
			if (this.planModeEnabled || this.planModePaused) {
				this.showWarning("Exit plan mode first.");
				return false;
			}
			if (this.vibeModeEnabled) {
				this.showWarning("Exit vibe mode first.");
				return false;
			}
			if (!this.session.settings.get("goal.enabled")) {
				this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return false;
			}
			if (this.goalModeEnabled) {
				this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
				return false;
			}
			if (this.#getPausedGoalState()) {
				this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return false;
			}

			// Expose the goal tool for the interview so the agent can finish by
			// calling `goal create`. Record the pre-interview toolset first: the
			// tool-driven create flips goalModeEnabled via `goal_updated`, and the
			// eventual goal exit restores this set (dropping the goal tool again).
			const enabledTools = this.session.getEnabledToolNames();
			this.#goalModePreviousTools = enabledTools.filter(name => name !== "goal");
			if (!enabledTools.includes("goal")) {
				await this.session.setActiveToolsByName([...enabledTools, "goal"]);
			}

			// The interview is a normal conversation: the kickoff rides in as a
			// hidden developer message, the agent asks its questions as regular
			// assistant turns, and the user answers in the ordinary editor. Queue
			// behind an in-flight run instead of aborting it.
			const kickoff = prompt.render(guidedGoalInterviewPrompt, { initial: rest?.trim() || undefined });
			const images = input?.images?.length ? input.images : undefined;
			if (this.session.isStreaming) {
				await this.session.followUp(kickoff, images, { synthetic: true });
			} else {
				try {
					await this.session.prompt(kickoff, images ? { synthetic: true, images } : { synthetic: true });
				} catch (error) {
					if (!(error instanceof AgentBusyError)) throw error;
					await this.session.followUp(kickoff, images, { synthetic: true });
				}
			}
			return true;
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	async #dispatchGoalSubcommand(
		sub: GoalSubcommand,
		rest: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		switch (sub) {
			case "set":
				return await this.#handleGoalSetSubcommand(rest, input);
			case "show":
				this.#showGoalDetails();
				return false;
			case "pause":
				await this.#pauseGoalAction();
				return false;
			case "resume":
				await this.#resumeGoalAction();
				return false;
			case "drop":
				await this.#confirmAndDropGoal();
				return false;
			case "budget":
				if (!this.goalModeEnabled) {
					this.showWarning(
						this.#getPausedGoalState() ? "Resume the goal before adjusting the budget." : "No active goal.",
					);
					return false;
				}
				if (!rest) {
					await this.#promptGoalBudgetEdit();
					return false;
				}
				await this.#handleGoalBudgetCommand(rest);
				return false;
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

	async #startGoalFromObjective(
		objective: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		await this.#enterGoalMode({ objective, silent: true });
		this.#resetGoalContinuationSuppression();
		if (this.session.isStreaming) {
			const images = input?.images?.length ? input.images : undefined;
			await this.withLocalSubmission(
				objective,
				() => this.session.prompt(objective, { streamingBehavior: "steer", images }),
				{ imageCount: images?.length ?? 0 },
			);
			return true;
		}
		if (this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective, ...input }, { preserveDraft: true }));
			return true;
		}
		return false;
	}

	async #replaceGoalFromObjective(
		objective: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		const state = await this.session.goalRuntime.replaceGoal({ objective });
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.goalModePaused = false;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
			const images = input?.images?.length ? input.images : undefined;
			await this.withLocalSubmission(
				objective,
				() => this.session.prompt(objective, { streamingBehavior: "steer", images }),
				{ imageCount: images?.length ?? 0 },
			);
			return true;
		}
		if (this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective, ...input }, { preserveDraft: true }));
			return true;
		}
		return false;
	}

	async #handleGoalSetSubcommand(
		rest: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		if (!this.goalModeEnabled && this.#getPausedGoalState()) {
			this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return false;
		}
		const objective = rest.trim()
			? rest.trim()
			: (await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true }))?.trim();
		if (!objective) return false;
		if (this.goalModeEnabled) return await this.#replaceGoalFromObjective(objective, input);
		return await this.#startGoalFromObjective(objective, input);
	}

	/** Manually (re-)open the plan-review overlay — bound to `/plan-review`. Lets
	 *  the operator pull the review back up after dismissing it, or review a plan
	 *  the agent wrote without dispatching approval. There is no fixed plan filename:
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
		// "Plan ready for approval." and immediately re-dispatches approval in a loop.
		// This abort is an internal UI transition, not operator cancellation.
		await this.#abortPlanApprovalTurnSilently();

		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.#getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		// resolveApprovedPlan may return a newer draft than the path recorded in
		// plan-mode state. `AgentSession.#buildPlanModeMessage()` reads that state,
		// so if the operator refines (or dismisses and keeps planning) the next
		// planning turn must target the plan just reviewed — promote the reviewed
		// path into plan-mode state now, mirroring the print-mode approval handler.
		const planState = this.session.getPlanModeState();
		if (planState?.enabled && planState.planFilePath !== planFilePath) {
			this.session.setPlanModeState({ ...planState, planFilePath });
			this.sessionManager.appendModeChange("plan", { planFilePath });
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
		const annotationStateKey = this.#resolvePlanFilePath(planFilePath);

		const choice = await this.showPlanReview(
			planContent,
			"Plan mode - next step",
			[
				"Approve and execute",
				"Approve and compact context",
				keepContextLabel,
				"Refine plan",
				PLAN_SAVE_AND_QUIT_OPTION,
			],
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
				annotationState: this.#planReviewAnnotationState.get(annotationStateKey),
				onAnnotationStateChange: state => {
					if (state.annotations.length > 0) this.#planReviewAnnotationState.set(annotationStateKey, state);
					else this.#planReviewAnnotationState.delete(annotationStateKey);
				},
				disabledIndices: keepContextDisabled ? [PLAN_KEEP_CONTEXT_OPTION_INDEX] : undefined,
			},
			{ slider },
		);
		const closePlanReview = (): void => {
			this.#hidePlanReview();
			this.ui.requestRender();
		};

		if (choice === PLAN_SAVE_AND_QUIT_OPTION) {
			closePlanReview();
			try {
				const latestPlanContent = editedContent ?? (await this.#readPlanFile(planFilePath));
				if (latestPlanContent === null) {
					this.showError(`Plan file not found at ${planFilePath}`);
					return;
				}
				await this.#savePlanAndQuit(latestPlanContent, details.title, annotationStateKey);
			} catch (error) {
				this.showError(`Failed to save plan: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (choice === "Approve and execute" || choice === "Approve and compact context" || choice === keepContextLabel) {
			try {
				// Prefer in-overlay edits (already in memory) over a disk re-read. The
				// overlay mirrors edits as they happen, and approval awaits one final
				// write so the durable plan file and synthetic prompt carry the same text.
				const latestPlanContent = editedContent ?? (await this.#readPlanFile(planFilePath));
				if (editedContent !== undefined) {
					await Bun.write(this.#resolvePlanFilePath(planFilePath), editedContent);
				}
				if (!latestPlanContent) {
					this.showError(`Plan file not found at ${planFilePath}`);
					closePlanReview();
					return;
				}
				// Capture the operator's tier choice and hand it to #approvePlan, which
				// applies it AFTER #exitPlanMode. #exitPlanMode normally restores
				// #planModePreviousModelState (the model from before plan mode), so
				// applying the slider choice any earlier would be silently reverted.
				// Pass executionModel only when the slider was actually shown — a
				// singleton cycle (e.g. only modelRoles.plan is configured, so
				// getRoleModelCycle synthesizes a lone `default` entry from the
				// currently active plan model) hides the slider, the operator made
				// no selection, and the pre-plan model is not in the cycle. Pinning
				// that singleton would silently switch the session back to the plan
				// model after #exitPlanMode restored the pre-plan model.
				// Treat the choice as implicit only when applying the selected role
				// would land on the same end state as the restore — same model AND
				// the same effective thinking level. A role with an explicit thinking
				// suffix that differs from the restored thinking level must still go
				// through applyRoleModel, otherwise approving on the same model with a
				// different configured thinking level silently keeps the pre-plan level.
				const restoredState = this.#planModePreviousModelState;
				const restoredIndex =
					cycle && restoredState
						? cycle.models.findIndex(entry => {
								if (!modelsAreEqual(entry.model, restoredState.model)) return false;
								if (!entry.explicitThinkingLevel) return true;
								return entry.thinkingLevel === restoredState.thinkingLevel;
							})
						: -1;
				const executionModel =
					slider && cycle && selectedTierIndex !== restoredIndex ? cycle.models[selectedTierIndex] : undefined;
				const executionDispatched = await this.#approvePlan(latestPlanContent, {
					planFilePath,
					title: details.title,
					preserveContext: choice !== "Approve and execute",
					compactBeforeExecute: choice === "Approve and compact context",
					executionModel,
				});
				if (executionDispatched) this.#planReviewAnnotationState.delete(annotationStateKey);
			} catch (error) {
				this.showError(
					`Failed to finalize approved plan: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			closePlanReview();
			return;
		}

		if (choice === "Refine plan") {
			const refinement = feedback.trim();
			try {
				if (refinement) {
					if (this.onInputCallback) {
						const input = this.startPendingSubmission({ text: feedback });
						this.#planReviewAnnotationStateBySubmission.set(input, annotationStateKey);
						this.onInputCallback(input);
					} else {
						await this.session.prompt(feedback);
						this.#planReviewAnnotationState.delete(annotationStateKey);
					}
				} else {
					this.showStatus("Refine plan: enter a follow-up prompt.");
				}
			} catch (error) {
				this.showError(`Failed to refine plan: ${error instanceof Error ? error.message : String(error)}`);
			}
			closePlanReview();
			return;
		}
		closePlanReview();
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
		this.#appearanceRefreshRequest = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(false);
		}
		this.#cleanupMicAnimation();
		// Stop the shared tool-spinner ticker: a live block missed by per-component
		// stopAnimation would otherwise keep an 80ms interval pinning the process.
		stopSharedSpinnerTicker();
		this.#liveCommandController.dispose();
		this.#cancelTodoAutoClearTimer();
		this.#cancelObserverUiSyncTimer();
		this.#cancelGoalContinuation();
		if (this.#sttController) {
			this.#sttController.dispose();
			this.#sttController = undefined;
		}
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		this.#extensionUiController.disposeComposerShapes();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#observerRegistry.dispose();
		this.#agentRegistryUnsubscribe?.();
		this.#agentRegistryUnsubscribe = undefined;
		this.#agentRegistrySubscriptionTarget = undefined;
		this.#eventController.dispose();
		this.#codexResetFireworksController.dispose();
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
		this.#hideSessionInfo();
		if (this.#ownsStartedUi) {
			this.ui.stop();
			this.#ownsStartedUi = false;
		}
		this.isInitialized = false;
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;
		await this.#teardown();

		// Print resumption hint only if the session was actually materialized to
		// durable storage — `--resume <id>` fails on a never-written file (see
		// #resumableSessionId).
		const sessionId = this.#resumableSessionId();
		if (sessionId) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${resumeCommand(sessionId)}`)}\n`);
		}

		await postmortem.quit(0);
	}

	/**
	 * Tear down like {@link shutdown}, then relaunch the CLI with the original
	 * launch argv (session-source flags and positional prompts stripped, see
	 * {@link restartArgv}), resuming this session when it exists on disk.
	 *
	 * On POSIX the relaunch is a true `execvp(3)` image replacement: same PID,
	 * same terminal, no lingering parent. Postmortem cleanups and stdout are
	 * flushed first because nothing in this process runs after a successful
	 * exec. On Windows (no exec semantics) or on exec failure, falls back to
	 * spawning the replacement and lingering only to forward its exit code.
	 */
	async restart(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;
		await this.#teardown();

		const cmd = [...resolveCliEntryCmd(), ...restartArgv(process.argv.slice(2), this.#resumableSessionId())];
		await postmortem.cleanup();
		await postmortem.drainStdout();
		if (process.platform !== "win32") {
			try {
				execReplace(cmd); // never returns on success
			} catch (err) {
				process.stderr.write(`${chalk.red(`Restart exec failed: ${err instanceof Error ? err.message : err}`)}\n`);
			}
		}
		const child = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		await postmortem.quit(await child.exited);
	}

	/**
	 * Session id when the session was actually materialized to durable storage —
	 * the only case `--resume <id>` can load. Persistence is lazy: a session that
	 * exits before its first assistant message (or dies early to an auth error, a
	 * mid-flight Ctrl+C, or a launch-then-quit) never wrote its JSONL, so the path
	 * is allocated but the file does not exist (issue #8860).
	 */
	#resumableSessionId(): string | undefined {
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		return sessionId && sessionFile && this.sessionManager.isSessionOnDisk() ? sessionId : undefined;
	}

	/** Shared `shutdown()`/`restart()` teardown: dispose the session and hand the terminal back. */
	async #teardown(): Promise<void> {
		await this.#liveCommandController.stop();

		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#cleanseController.dispose();
		this.#focusController.dispose();

		// Surface an explicit "Closing session…" line so the user sees a reason
		// for the pause while `session.dispose()` flushes memory consolidate and
		// other cleanups (issue #3641). The await on the next line yields the
		// event loop, giving requestRender() a tick to paint the status before
		// dispose blocks.
		this.showStatus("Closing session…");

		// Persist the draft and dispose the session through the shared teardown
		// so a signal that arrives mid-shutdown cannot fire a second dispose.
		// The teardown is a promise-memoized singleton; whichever path calls it
		// first runs the work, the other awaits the same settled promise.
		// The teardown is registered lazily in `init()` — a `/exit` reached
		// before `init()` completed falls back to a direct dispose.
		const stillClosingTimer = setTimeout(() => {
			this.showStatus("Still closing… (flushing memory backend / network)");
		}, STILL_CLOSING_DELAY_MS);
		try {
			if (this.#signalTeardown) {
				await this.#signalTeardown();
			} else {
				await this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
			}
		} finally {
			clearTimeout(stillClosingTimer);
		}

		// Do not force a final render during teardown: disposed session/UI state can
		// collapse to an empty frame, clearing the viewport and leaving the parent
		// shell prompt at row 0. Stop from the last committed frame so the terminal
		// hands Bash the cursor immediately after visible OMP content.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		// Stop the run-state spinner interval BEFORE restoring the shell title, so a
		// pending tick cannot re-emit an OSC title after `popTerminalTitle` hands the
		// terminal back (which would leave the parent shell with a `π ⠋ …` tab).
		disposeTerminalTitleState();
		popTerminalTitle();
		this.stop();
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
		nextEditor.setImeSafeCursorLayout(this.settings.get("tui.imeSafeCursor"));
		nextEditor.setAutocompleteMaxVisible(this.settings.get("autocompleteMaxVisible"));
		nextEditor.setSpellingFeatures({
			typoDetection: this.settings.get("spelling.typoDetection"),
			autocomplete: this.settings.get("spelling.autocomplete"),
			autocorrect: this.settings.get("spelling.autocorrect"),
		});
		nextEditor.viewportRowsProvider = () => this.ui.terminal.rows;
		nextEditor.magicKeywordsEnabled = () => this.settings.get("magicKeywords.enabled");
		nextEditor.imageReferenceHyperlink = imageReferenceHyperlink;
		nextEditor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		nextEditor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		nextEditor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(nextEditor));
		this.editor = nextEditor;
		this.composer.setEditor(nextEditor);
		this.syncComposerShape();
		nextEditor.setMaxHeight(this.#computeEditorMaxHeight());
		if (this.historyStorage) {
			nextEditor.setHistoryStorage(this.historyStorage);
		}
		nextEditor.setText(previousText);

		this.editorContainer.clear();
		this.editorContainer.addChild(nextEditor);
		this.ui.setFocus(nextEditor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		void this.refreshSlashCommandState().catch(error => {
			logger.warn("Failed to refresh slash command state for custom editor", { error: String(error) });
		});

		this.updateEditorBorderColor();
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

	/**
	 * Defer transcript command panels while the agent is streaming, then mount
	 * them at the next settle, terminal or not. A non-terminal settle is only a
	 * scheduling pause, so resumed streaming can still land below a panel
	 * flushed there. That is preferred over leaving it queued behind a command
	 * the user runs during the pause, which mounts immediately and would put the
	 * older panel out of order.
	 *
	 * The deferral is acknowledged in {@link deferredCommandContainer}, an
	 * anchored container above the editor. Nothing is mounted into the
	 * transcript: a mid-turn mount changes the active frame while streaming,
	 * which is why the earlier `showStatus` acknowledgment was reverted. An
	 * anchored container is cleared and rebuilt in place without adding history
	 * rows — the same reason the ctrl+p role-cycle track lives there.
	 */
	presentCommandOutput(content: Component | readonly Component[]): void {
		if (!this.session.isStreaming) {
			this.present(content);
			return;
		}
		const sessionId = this.sessionManager.getSessionId();
		if (this.#pendingCommandOutput.length > 0 && this.#pendingCommandOutputSessionId !== sessionId) {
			this.#pendingCommandOutput = [];
			this.#pendingCommandOutputCommands = 0;
		}
		this.#pendingCommandOutputSessionId = sessionId;
		const items = Array.isArray(content) ? content : [content as Component];
		this.#pendingCommandOutput.push(...items);
		this.#pendingCommandOutputCommands += 1;
		this.#renderDeferredCommandNotice();
		this.ui.requestRender();
	}
	showSessionInfo(info: string): void {
		this.#hideSessionInfo();
		const overlay = new SessionInfoOverlay(this.ui, info, () => this.#hideSessionInfo());
		this.#sessionInfoOverlayHandle = this.ui.showOverlay(overlay, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ui.setFocus(overlay);
		this.ui.requestRender();
	}

	#hideSessionInfo(): void {
		const handle = this.#sessionInfoOverlayHandle;
		this.#sessionInfoOverlayHandle = undefined;
		if (!handle) return;
		handle.hide();
		// Focus the visible editor-slot owner, not this.editor: an extension ask
		// or hook may have swapped into editorContainer while the panel was open,
		// and keys must reach the visible prompt (same stale-focus class as #3349).
		this.#selectorController.focusActiveEditorArea();
		this.ui.requestRender();
	}

	/**
	 * Preview the queued panels above the editor so a command answers straight
	 * away, then clear at settle when the real panels enter the transcript.
	 *
	 * Height is capped against the viewport: a `/usage` report with several
	 * providers is tall enough to push the prompt off screen, and the full text
	 * is a moment away in the transcript either way.
	 */
	#renderDeferredCommandNotice(): void {
		this.deferredCommandContainer.clear();
		if (this.#pendingCommandOutput.length === 0) return;
		const maxRows = Math.max(
			DEFERRED_PREVIEW_MIN_ROWS,
			Math.floor(this.ui.terminal.rows * DEFERRED_PREVIEW_VIEWPORT_FRACTION),
		);
		this.deferredCommandContainer.addChild(new Spacer(1));
		this.deferredCommandContainer.addChild(
			new DeferredCommandPreview([...this.#pendingCommandOutput], maxRows, this.#pendingCommandOutputCommands),
		);
	}

	/** Mount every command panel queued for the current session while the agent was streaming. */
	flushPendingCommandOutput(): void {
		if (this.#pendingCommandOutput.length === 0) return;
		const pending = this.#pendingCommandOutput;
		const pendingSessionId = this.#pendingCommandOutputSessionId;
		this.#pendingCommandOutput = [];
		this.#pendingCommandOutputSessionId = undefined;
		this.#pendingCommandOutputCommands = 0;
		this.#renderDeferredCommandNotice();
		if (pendingSessionId !== this.sessionManager.getSessionId()) return;
		this.present(pending);
	}

	#mountChatChild(item: Component): void {
		this.chatContainer.addChild(item);
		if (item instanceof ChatBlock) item.mount(this.#chatHost);
	}

	resetTranscript(): void {
		this.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
		this.chatContainer.dispose();
		this.chatContainer.clear();
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.#pendingSubmissionPreservesDraft = false;
		this.clearOptimisticUserMessage();
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		this.#uiHelpers.showError(message);
	}

	showPinnedError(message: string): void {
		this.#dismissPlanReview();
		this.errorBannerContainer.clear();
		this.errorBannerContainer.addChild(new ErrorBannerComponent(message));
		this.ui.requestRender();
	}

	clearPinnedError(): void {
		if (this.errorBannerContainer.children.length === 0) return;
		this.errorBannerContainer.clear();
		this.ui.requestRender();
	}

	showWarning(message: string, options?: { hideWithToolActivity?: boolean }): void {
		this.#uiHelpers.showWarning(message, options);
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

	#updateWelcomeModel(): void {
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";
		this.composer.updateWelcome({ modelName, providerName });
		this.#persistComposerWelcome(modelName, providerName);
	}

	#syncConfigWarningHeader(): void {
		this.composer.setHeaderExtras(this.#buildConfigWarningComponents(), this.#headerAfter);
	}

	/** Header rows for the current config warnings, rebuilt when they change (#10048). */
	#buildConfigWarningComponents(): Component[] {
		const components: Component[] = [];
		for (const warning of this.session.configWarnings) {
			components.push(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0), new Spacer(1));
		}
		return components;
	}

	#persistComposerWelcome(modelName: string, providerName: string): void {
		if (!this.sessionManager.getSessionFile()) return;
		void writeComposerWelcomeCache(this.sessionManager.getCwd(), { modelName, providerName }).catch(error => {
			logger.debug("composer welcome cache write failed", { error });
		});
	}

	#updateWelcomeLspServers(): void {
		this.composer.updateWelcome({ lspServers: this.#getWelcomeLspServers() });
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
		const hex = getSessionAccentHex(key.sessionName, theme.sessionAccentInputs);
		const main = getSessionAccentAnsi(hex);
		const dim = getSessionAccentAnsi(adjustHsv(hex, { s: 0.55, v: 0.65 }));
		return this.#cacheWorkingMessageAccent(key, main && dim ? { main, dim } : undefined);
	}

	ensureLoadingAnimation(): void {
		if (!this.loadingAnimation) {
			this.#clearWorkingMessageAccentCache();
			this.statusContainer.disposeChildren();
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
					return accent ? `${accent.dim}${spinner}\x1b[39m` : theme.fg("muted", spinner);
				},
				messageColorFn,
				DEFAULT_WORKING_MESSAGE,
				// The brand spinner lives in the status line while working; this row
				// leads with the interrupt affordance instead of a second spinner.
				// The leading space nudges the row one column right of the flush-left
				// status rows so the interrupt glyph reads as indented.
				[` ${theme.icon.esc}`],
			);
			this.loadingAnimation.setTrailer(() => this.#workingTitleTrailer());
			this.statusContainer.addChild(this.loadingAnimation);
		} else if (!this.statusContainer.children.includes(this.loadingAnimation)) {
			this.statusContainer.disposeChildren();
			this.statusContainer.addChild(this.loadingAnimation);
			this.ui.requestRender();
		}
		this.applyPendingWorkingMessage();
	}

	#stopLoadingAnimation(clearStatusContainer: boolean): void {
		if (!this.loadingAnimation) return;
		this.loadingAnimation.stop();
		this.loadingAnimation = undefined;
		this.#clearWorkingMessageAccentCache();
		if (clearStatusContainer) {
			this.statusContainer.disposeChildren();
		}
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(DEFAULT_WORKING_MESSAGE);
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
		options?: {
			imageLinks?: readonly (string | undefined)[];
			reuseSettledComponent?: boolean;
		},
	): Component[] {
		return this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(sessionContext: SessionContext, options?: RenderSessionContextOptions): void {
		for (const message of sessionContext.messages) {
			this.noteDisplayableThinkingContent(message);
		}
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	/** Build a session context in bounded chunks so terminal input runs between event-loop turns. */
	async renderSessionContextIncrementally(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		renderChunk?: () => void,
	): Promise<void> {
		for (const message of sessionContext.messages) {
			this.noteDisplayableThinkingContent(message);
		}
		await this.#uiHelpers.renderSessionContextIncrementally(sessionContext, options, renderChunk);
	}

	async renderInitialMessages(options?: {
		preserveExistingChat?: boolean;
		clearTerminalHistory?: boolean;
	}): Promise<void> {
		await this.#uiHelpers.renderInitialMessages(options);
		this.syncRetryHintRow();
	}
	/**
	 * Reconcile the idle "F5 to Retry" status row with the transcript tail:
	 * mount it when the last turn died on a tool call (Esc mid-execution,
	 * stream failure) and the status row is free, remove it when stale. Runs at
	 * turn end and after every transcript replay (startup resume, `/tree`,
	 * session switch). The advertised key is the live `app.retry` binding,
	 * dispatched by the editor to `InputController.handleRetry`.
	 */
	syncRetryHintRow(): void {
		const show = !this.collabGuest && !this.viewSession.isStreaming && this.viewSession.hasAbortedToolCallTail;
		if (this.#retryHintRow) {
			const mounted = this.statusContainer.children.includes(this.#retryHintRow);
			if (mounted && show) return;
			if (mounted) this.statusContainer.removeChild(this.#retryHintRow);
			this.#retryHintRow = undefined;
		}
		// Never contend with a live loader (working/auto-retry/compaction).
		if (!show || this.statusContainer.children.length > 0) return;
		const retryKey = this.keybindings.getKeys("app.retry")[0] ?? "f5";
		this.#retryHintRow = new Text(
			`${theme.fg("muted", theme.icon.loop)} ${theme.fg("dim", `${formatKeyHint(retryKey)} to Retry`)}`,
			1,
			0,
		);
		this.statusContainer.addChild(this.#retryHintRow);
		this.ui.requestRender();
	}

	truncateTranscriptFromMessage(message: AgentMessage): boolean {
		return this.#uiHelpers.truncateTranscriptFromMessage(message);
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

	async handleDumpCommand(): Promise<void> {
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

	#vibeSessionTransitionBlocked(): boolean {
		if (!this.vibeModeEnabled) return false;
		this.showWarning("Exit vibe mode first.");
		return true;
	}

	#prepareSessionSwitch(): void {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#cleanseController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.clearPinnedError();
		this.#hidePlanReview();
	}

	async handleClearCommand(): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		this.#prepareSessionSwitch();
		await this.#commandController.handleClearCommand();
	}

	handleFreshCommand(): Promise<void> {
		return this.#commandController.handleFreshCommand();
	}

	handleResetContextCommand(): Promise<void> {
		return this.#commandController.handleResetContextCommand();
	}

	async handleDropCommand(): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		this.#prepareSessionSwitch();
		await this.#commandController.handleDropCommand();
	}

	async handleForkCommand(): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#cleanseController.dispose();
		await this.#commandController.handleForkCommand();
	}

	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		await this.#commandController.handleMoveCommand(targetPath);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	async handleSTTToggle(): Promise<void> {
		if (this.#liveCommandController.active) {
			this.showWarning("End live mode before using push-to-talk speech input.");
			return;
		}
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
				this.ui.requestRender();
			},
		});
	}

	/** Start or stop the Codex-backed realtime voice surface. */
	async handleLiveCommand(): Promise<void> {
		if (this.#sttController && this.#sttController.state !== "idle") {
			this.showWarning("Finish the current speech-to-text capture before starting live mode.");
			return;
		}
		await this.#liveCommandController.handleCommand();
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

	showAgentHub(options?: AgentHubOpenOptions): void {
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
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		return this.#commandController.handleCompactCommand(customInstructions, mode, beforeFlush, internalGuidance);
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

	showAdvisorConfigure(): void {
		this.#selectorController.showAdvisorConfigure();
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
	showGitUi(revision?: string): void {
		void this.#selectorController.showGitTui(revision);
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

	showSessionSelector(source?: ForeignSessionSource): void {
		void this.#selectorController.showSessionSelector(source);
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		// Flush pending settings writes *before* disposing controllers or resetting
		// observers: a save failure must leave the session, process project dir,
		// and Settings in the source scope with all UI intact.
		try {
			await this.settings.flush();
		} catch (err) {
			this.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#cleanseController.dispose();
		this.resetObserverRegistry();
		await this.#selectorController.handleResumeSession(sessionPath, { settingsFlushed: true });
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#selectorController.handleSessionDeleteCommand();
	}

	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		return this.#selectorController.showOAuthSelector(mode, providerId);
	}

	showSessionPinSelector(): Promise<void> {
		return this.#selectorController.showSessionPinSelector();
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

	resetDisplayAfterAppearanceRefresh(): void {
		const refreshAppearance = this.ui.terminal.refreshAppearance;
		if (refreshAppearance) {
			const token = this.#nextAppearanceRequestToken++;
			const request = {
				token,
				deadline: Date.now() + CTRL_L_APPEARANCE_RESPONSE_DEADLINE_MS,
			};
			this.#appearanceRefreshRequest = request;
			const acceptedToken = refreshAppearance.call(this.ui.terminal, token);
			if (acceptedToken !== token && this.#appearanceRefreshRequest === request) {
				this.#appearanceRefreshRequest = undefined;
			}
		} else {
			this.#appearanceRefreshRequest = undefined;
		}
		// Preserve Ctrl+L's immediate full replay when the probe is unsupported,
		// receives no response, or reports an unchanged appearance.
		this.ui.resetDisplay();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	/** Queue slash-command input behind the active turn. */
	handleQueueCommand(message: string): Promise<void> {
		return this.#inputController.handleQueueCommand(message);
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	handleTanCommand(work: string): Promise<void> {
		return this.#tanCommandController.start(work);
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

	/** Reserves plain `b` only after /btw has a completed branch action to handle. */
	handlesBtwBranchKey(): boolean {
		return this.#btwController.handlesBranchKey();
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

	async handleBtwBranch(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<void> {
		try {
			const result = await this.session.branchFromBtw(question, assistantMessage, leafId, sessionId);
			if (result.cancelled) {
				this.showStatus("/btw branch cancelled", { dim: true });
				return;
			}
			this.#btwController.dispose();
			this.#omfgController.dispose();
			this.#cleanseController.dispose();
			await this.renderInitialMessages({ clearTerminalHistory: true });
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

	handleCleanseCommand(args: string): Promise<void> {
		return this.#cleanseController.start(args);
	}

	hasActiveCleanse(): boolean {
		return this.#cleanseController.hasActiveRun();
	}

	handleCleanseEscape(): boolean {
		return this.#cleanseController.handleEscape();
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
		this.#todoPhasesOwner = this.viewSession;
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(source: AgentSession = this.session): Promise<void> {
		await this.#loadTodoList(source);
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

	getToolUIContext(): ExtensionUIContext | undefined {
		return this.#extensionUiController.getToolUIContext();
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
		options?: ExtensionCustomOptions,
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
