/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Agent, AgentBusyError, type AgentMessage, agentPauseGate, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Model, Usage, UsageReport } from "@oh-my-pi/pi-ai";
import { routedModelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { execReplace } from "@oh-my-pi/pi-natives";
import type { AutocompleteProvider, SlashCommand } from "../autocomplete/autocomplete";
import type { KeyId } from "../config/keybindings/key-id";

import type { AsyncJobManagerApi } from "../async/job-manager";
import { stopAgentRun } from "../async/job-control";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { collectTrayInput, runsInlineAgent, TrayFeed, TrayMainActivity } from "./tray";
import type { JobWidgetRegistry } from "../job-widgets/types";
import { type TrackSegment } from "./view-model/chrome/segment-track";
import { actionKey } from "../ui/keys/hints";

import { type TspText } from "@oh-my-pi/pi-wire";
import {
	$env,
	formatDuration,
	formatNumber,
	getActiveProfile,
	getProjectDir,
	isEnoent,
	logger,
	postmortem,
	prompt,
	sanitizeText,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";

import { restartArgv } from "../cli/flag-tables";
import type { CollabGuestLink } from "../collab/guest";
import { CollabController } from "../collab/controller";
import type { CollabHost } from "../collab/host";
import {
	formatModelStringWithRouting,
	type ResolvedModelRoleValue,
	resolveExactModelIdentity,
} from "../config/model-resolver";
import { isSettingsInitialized, Settings, settings } from "../config/settings";
import type {
	AutocompleteProviderFactory,
	ContextUsage,
	ExtensionCustomOptions,
	ExtensionRunner,
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
	PlanReviewOption,
	PlanReviewRequestedEvent,
	SessionModeRequest,
	SessionModeResult,
	SessionModeState,
	ExtensionCustomFactory,
} from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import { loadSlashCommands } from "../extensibility/slash-commands";
import type { GoalModeState } from "../goals/state";
import { rescopeSessionToCwd } from "../session/cwd-rescope";
import { copyLocalArtifacts, resolveLocalRoot } from "../internal-urls";

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
import {
	isJudgmentBatchProgress,
	JUDGMENT_BATCH_PROGRESS_EVENT_CHANNEL,
	type JudgmentBatchProgress,
} from "../eval/judgment-batch-events";
import { onDownloadActivity } from "../downloads/activity";
import { autosaveApprovedPlan, planSaveFileName } from "../plan-mode/plan-autosave";
import { resolvePlanModelTransition } from "../plan-mode/model-transition";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import planFilenamePrompt from "../prompts/system/plan-filename.md" with { type: "text" };
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with { type: "text" };
import type { AgentHubRegistry } from "../registry/agent-hub-types";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { isSessionTreeRef, registerPersistedSubagents } from "../registry/persisted-agents";
import type { AgentCostSnapshot } from "./view-model/overlays/agent-hub-projection";
import { sumSubagentTreeCost } from "./agent-hub-runtime";
import {
	type AgentSession,
	type AgentSessionEvent,
	type DroppedPrompt,
	type ResolvedRoleModel,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "../session/agent-session";
import type { AgentSessionHandle, AgentViewSession } from "../session/agent-session-handle";
import type { TranscriptEntryLike } from "../session/transcript/transcript-entry";
import type { BashExecutionMessage, PythonExecutionMessage } from "../session/transcript/messages";
import type { CompactMode } from "../session/compact-modes";
import type { ForeignSessionSource } from "../session/foreign-session-store";
import { HistoryStorage } from "../session/history-storage";
import { syncTextPrediction, textPredictionBackend } from "../predict/client";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { resolveMarkdownLinkHrefs } from "../internal-urls/hyperlink-targets";
import type { ResolveContext } from "../internal-urls/index";
import { shiftImageMarkers } from "./view-model/prompt/composer-attachments";
import { formatQueueShorthand } from "./view-model/prompt/queue-input";
import { type SessionContext } from "../session/session-context";
import type { SessionManager } from "../session/session-manager";
import { loadPinnedSessionIds } from "../session/session-pins";
import {
	canAutoCreateWorktree,
	planWorktreeExit,
	removeExitWorktrees,
	type WorktreeExitPlan,
} from "../session/session-worktree";
import type { SessionWorktree } from "../worktree/backend";
import type { ShakeMode } from "../session/shake-types";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, buildTuiBuiltinSlashCommands } from "../slash-commands/builtin-registry";
import { buildStaticInlineHint } from "../slash-commands/builtin-completions";
import { formatCoarseDuration } from "./view-model/chrome/format";
import { type DictationTarget, MicCursor, type SttCallbacks, STTController, type SttState } from "../stt";
import type { SpaceHoldHandler } from "../config/keybindings/space-hold";
import { resolveRestartCmd } from "../subprocess/worker-client";

import { parseConfiguredThinkingLevel } from "../thinking/levels";
import { type ConfiguredThinkingLevel } from "../utils/render-utils";

import { isMCPToolName } from "../tools/builtin-names";
import type { LspStartupServerInfo } from "../tools";
import { resolvePlanFilePath } from "../plan-mode/plan-files";
import { resolveToCwd } from "../tools/path-utils";
import type { StreamFrameSource } from "../stream/paint-encoder";
import { StreamPublisher } from "../stream/publisher";
import { newRecordingPath, SessionRecorder } from "../stream/recording";
import { StreamRedactor } from "../stream/redactor";
import { shortenEmbeddedPaths, shortenPath, TRUNCATE_LENGTHS } from "../utils/render-utils";
import { replaceTabs, truncateToWidth } from "../utils/text-width";
import { setAutoQaConsentHandler } from "../tools/report-tool-issue";
import { type CfgApproval, type CfgChangeRequest, setCfgApprovalHost } from "../internal-urls/cfg-protocol";
import {
	createTodoHudStateData,
	getTodoHudVisibility,
	TODO_HUD_STATE_CUSTOM_TYPE,
	type TodoHudStateEntryData,
} from "../tools/todo";
import { isClosedTodo } from "../tools/details/todo";
import type { SpotlightDetails } from "../tools/details/spotlight";
import { readArtifactText } from "../spotlight/sink";
import { hasSpotlightOriginal } from "./view-model/overlays/spotlight-sheet";
import { vocalizer } from "../tts/vocalizer";

import { formatStartupChangelogSummary, type StartupChangelogSelection } from "../utils/changelog";
import { copyToClipboard, readTextFromClipboard } from "../utils/clipboard";
import type { EventBus } from "../utils/event-bus";
import { getEditorCommand, openInEditor } from "../utils/external-editor";

import { resumeCommand } from "../utils/resume-command";
import { messageHasDisplayableThinking } from "../session/transcript/thinking-display";
import type { TokenRateMeter } from "../utils/token-rate";
import {
	type BlockedKind,
	disposeProgramStatus,
	holdBlockedStatus,
	initProgramStatus,
	promptZonesEnabled,
	setProgramStatusEnabled,
	setProgramStatusSupported,
	settleStartupRun,
} from "../utils/run-status";
import {
	disposeTerminalTitleState,
	initTerminalTitleState,
	popTerminalTitle,
	pushTerminalTitle,
	reportTernSession,
	setSessionTerminalTitle,
	setTerminalSessionSource,
	setTerminalTitlePullRequest,
	setTerminalTitleSpinnerInterval,
	setTerminalTitleHandoff,
	setTerminalTitleSpinnerStyle,
	setTerminalTitleStateEnabled,
} from "../utils/title-generator";
import {
	aggregateVibeWorkerTokensPerSecond,
	type VibeOwnerScope,
	type VibeParentSession,
	VibeSessionRegistry,
} from "../vibe/runtime";

import type { VersionUpdate } from "./view-model/prompt/welcome";
import type { HookSelectorSlider } from "./view-model/overlays/hook-selector";
import {
	type PlanReviewAnnotationState,
	type PlanReviewOverlayChoice,
} from "./view-model/overlays/plan-review-overlay";
import { type PlanSaveOverlayResult } from "./view-model/overlays/plan-save-overlay";
import { ServedModelTracker } from "../session/transcript/served-model-marker";

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
import { describeLoopCondition, evaluateLoopCondition, type LoopConditionVerdict } from "./loop-condition";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	isLoopLimitExhausted,
	parseLoopArgs,
	type LoopLimitConfig,
} from "./loop-limit";
import type { LoopConditionConfig, LoopLimitRuntime } from "./view-model/status-line/loop";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { formatPersistenceNotice } from "./persistence-failure";
import { hintUsage } from "../utils/usage-counter";
import {
	getInspectableSubagentCount,
	getRunningSubagentBadgeAgentIds,
	getRunningSubagentBadgeRegistry,
} from "./view-model/overlays/running-subagent-badge";
import { SessionObserverRegistry } from "../task/session-observer-registry";
import { createSessionTeardown, type SessionTeardown } from "./session-teardown";
import { sanitizeStatusText } from "./view-model/chrome/shared";
import { invokeSkillCommandFromText, isKnownSkillCommand } from "./skill-command";
import type {
	AgentHubOpenOptions,
	AssistantView,
	DockModels,
	ExecRunPresentation,
	PendingTool,
	PresentAssistantOptions,
	PresentOptions,
	ToolCallSpec,
	TranscriptEntry,
	WorkingKind,
	CompactionQueuedMessage,
	ComposerOwner,
	InteractiveModeContext,
	InteractiveModeInitOptions,
	InteractiveSelectorDialogOptions,
	RenderInitialMessagesOptions,
	RenderSessionContextOptions,
	ResumeSessionOptions,
	ShowStatusOptions,
	SubmittedUserInput,
	YieldCompaction,
} from "./types";
import type { TodoItem, TodoPhase } from "../tools/details/todo";
import type { ConversationPosition } from "./utils/conversation-position";
import { DEFAULT_FIGURE_CELL, type FigureCell, figureMaxRows } from "../ui/transcript/figures/svg";
import { setImageBlobWriter } from "../ui/transcript/image-links";
import { followInlineImageLimits } from "../ui/transcript/messages/image";
import { imageLinksForMessage, UiHelpers } from "./utils/ui-helpers";

import {
	askTimeoutMs,
	cfgAutocompleteMaxVisible,
	cfgComposerPredictionAlternatives,
	cfgComposerPredictions,
	cfgComposerShape,
	cfgComposerTokenRate,
	cfgDisplayAdvisorCollapsedLines,
	cfgDisplayCacheMissMarker,
	cfgDisplayCollapseCompacted,
	cfgDisplayHideToolActivity,
	cfgDisplayPinnedAgents,
	cfgDisplayShellVisualization,
	cfgDisplayShowTokenUsage,
	cfgDisplayShowTurnTime,
	cfgDisplaySubagentLivePreview,
	cfgGitEnabled,
	cfgLoopConditionTimeoutMs,
	cfgLoopMode,
	cfgRecapEnabled,
	cfgRecapIdleSeconds,
	cfgShowHardwareCursor,
	cfgSpellingAutocomplete,
	cfgSpellingAutocorrect,
	cfgSpellingTypoDetection,
	cfgStartupChangelogMode,
	cfgStartupQuiet,
	cfgStatusLineCompactThinkingLevel,
	cfgStatusLineContextLine,
	cfgStatusLineLeftSegments,
	cfgStatusLinePreset,
	cfgStatusLineRightSegments,
	cfgStatusLineSegmentOptions,
	cfgStatusLineSeparator,
	cfgStatusLineSessionAccent,
	cfgStatusLineShowHookStatus,
	cfgStatusLineTransparent,
	cfgSymbolPreset,
	cfgTerminalProgramStatus,
	cfgTerminalShowImages,
	cfgTuiHyperlinks,
	cfgTuiMaxFps,
	cfgTuiImeSafeCursor,
	cfgTuiMaxInlineImages,
	cfgTuiAutoGraph,
	cfgTuiMouse,
	cfgTuiColorfulMarkdown,
	cfgTuiRenderMermaid,
	cfgTuiRenderEmbeds,
	cfgTuiRenderSvg,
	cfgTuiResizeScrollback,
	cfgTuiTextSizing,
	cfgTuiTight,
	cfgTuiTitleSpinner,
	cfgMotionResolved,
	cfgTuiTitleState,
	cfgTuiVimMode,
	cfgTuiVimModeDisplay,
	cfgTuiVimShowCommand,
	cfgTuiVimStartMode,
	cfgTuiVimYankToClipboard,
} from "./settings";
import { pickTableChart } from "../auto-graph/planner";
import { hasNativeJudge } from "../judgment";
import { setTableCharts } from "../session/transcript/table-chart";
import {
	cfgArchiveEnabled,
	cfgCommitEnabled,
	cfgComputerEnabled,
	cfgRatchetEnabled,
	cfgReadToolResultPreview,
	cfgTasksTodoClearDelay,
} from "../tools/settings";
import { cfgTaskShowResolvedModelBadge, cfgWorktreeOnExit, cfgWorktreeOnStart } from "../task/settings";
import { cfgMcpRenderMarkdownResults } from "../mcp/settings";
import { cfgExpandThinkingBlocks, cfgProseOnlyThinking } from "../session/settings";
import { cfgHideThinkingBlock } from "../session/settings";
import { cfgCycleOrder, cfgModelRoles } from "../config/model-settings";
import { cfgExtensionHandlersModeControl } from "../extensibility/settings";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "../goals/settings";
import { goalContinuationActivity, goalFromModeData } from "../goals/state";
import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "../plan-mode/settings";
import { cfgStreamRedactPatterns } from "../stream/settings";
import { cfgSttEnabled } from "../stt/settings";
import { combine, type SettingValueOf } from "../config/registry";
import { cfgAdvisorEnabled, cfgAdvisorMaxNotesPerUpdate } from "../advisor/settings";
import { cfgExtensionAssistantTextRenderers, cfgExtensionTranscriptPresenters } from "../extensibility/settings";
import { cfgTierAdvisor } from "../session/settings";
import {
	cfgCompactionEnabled,
	cfgCompactionIdleEnabled,
	cfgCompactionIdleThresholdTokens,
	cfgCompactionIdleTimeoutSeconds,
	cfgCompactionMethodOrder,
} from "../session/context-settings";
import { followTerminal, onThemeChange, setSymbolPreset } from "../ui/theme/service";
import {
	batch,
	createRoot,
	effect,
	type JSXNode,
	jsx,
	type KeyEvent,
	nativeRendering,
	type PresentedFrame,
	type Signal,
	signal,
	untrack,
} from "@oh-my-pi/pi-tui";

import { insideMultiplexer } from "@oh-my-pi/pi-tui/driver/mux/detect";
import { setLinkSchemes } from "@oh-my-pi/pi-tui/term/painters/md";
import { setMarkdownLook } from "@oh-my-pi/pi-tui/text/markdown/look";
import { KeybindingsManager } from "../config/keybindings/keybindings";
import { appInterruptKeys } from "../config/keybindings/matchers";
import { setExtensionLinkClicksProvider } from "../extensibility/extensions/link-clicks";
import { getAssistantMessageLinkTargets } from "../session/transcript/link-targets";
import { onTranscriptPresentersChanged } from "../session/transcript/transcript-presentation";
import type { TurnAct } from "../session/transcript/transcript-actions";
import type { Composer } from "../ui/composer";
import type { DialogVim } from "../ui/composer/vim-editor";
import { enabledMagicKeywords } from "../ui/composer/magic-keywords";
import { deferredMaxRows, subagentEntries, TODO_COMPACT_ROWS, type WorkingSpec } from "../ui/dock";
import { CodexResetFireworks, FIREWORKS_SHEET } from "../ui/overlays/panels/codex-reset-fireworks";
import { ErrorBanner } from "../ui/overlays/panels/error-banner";
import { PlanReview, planReviewSheet } from "../ui/overlays/panels/plan-review";
import { SpotlightSheet, spotlightOverlay } from "../ui/overlays/panels/spotlight-sheet";
import { renderAssistantText } from "../ui/transcript/messages/assistant-message";
import { setActiveTodoDescriptions } from "../ui/tools/todo";
import { PlanReviewModel } from "../ui/overlays/panels/plan-review-model";
import { PLAN_SAVE_SHEET, PlanSave } from "../ui/overlays/panels/plan-save";
import { SESSION_INFO_SHEET, SessionInfo } from "../ui/overlays/panels/session-info";
import { JOBS_SHEET, JobsPanel } from "../ui/overlays/pickers/jobs-panel";
import { hasExtensionLinks, LinkBrowser, type LinkReply } from "../ui/overlays/pickers/link-browser";
import { showSheet } from "../ui/overlays/sheet";
import {
	type BlockOptions,
	type InputInterceptor,
	mountNode,
	type OverlayHandle,
	type OverlayOptions,
	type Shell,
	type TranscriptBlock,
	within,
} from "../ui/shell";
import { AnsiText } from "../ui/transcript/ansi-text";
import type { ExecRun } from "../ui/transcript/exec-run";
import { applyFileLinkSetting } from "../utils/file-links";
import { openPath } from "../utils/open";
import { AppFrame } from "./interactive/frame";
import { SessionStatusLine } from "./interactive/status-line";
import type { MessageFaceEnv } from "./interactive/messages";
import { type DisplayFlags, TranscriptPresenter } from "./interactive/transcript";
import { TranscriptReplica } from "./interactive/transcript-replica";
import { WorkingRows } from "./interactive/working";
import { resolveComposerHint } from "./view-model/prompt/composer-hints";
import { WordCompletionProvider } from "./view-model/prompt/word-completion";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

import { composerBorderColor } from "./interactive/border-color";
import { sharedStartupCache } from "./interactive/startup-cache";
import { predictStatus } from "./interactive/status-prediction";
import { bold } from "@oh-my-pi/pi-tui/theme/theme";

/**
 * Settings with live interactive-UI side effects, keyed by id. One coalesced listener applies
 * them (`InteractiveMode.#applyUiSettingChanges`) so a bulk reload rebuilds the transcript once.
 */
const cfgLiveUiSettings = combine({
	showHardwareCursor: cfgShowHardwareCursor,
	"tui.maxInlineImages": cfgTuiMaxInlineImages,
	"tui.resizeScrollback": cfgTuiResizeScrollback,
	"tui.imeSafeCursor": cfgTuiImeSafeCursor,
	autocompleteMaxVisible: cfgAutocompleteMaxVisible,
	"spelling.typoDetection": cfgSpellingTypoDetection,
	"spelling.autocomplete": cfgSpellingAutocomplete,
	"spelling.autocorrect": cfgSpellingAutocorrect,
	"composer.shape": cfgComposerShape,
	"tui.vimMode": cfgTuiVimMode,
	"tui.vimModeDisplay": cfgTuiVimModeDisplay,
	"tui.vimShowCommand": cfgTuiVimShowCommand,
	"tui.vimStartMode": cfgTuiVimStartMode,
	"display.pinnedAgents": cfgDisplayPinnedAgents,
	"display.subagentLivePreview": cfgDisplaySubagentLivePreview,
	"compaction.idleEnabled": cfgCompactionIdleEnabled,
	"compaction.idleThresholdTokens": cfgCompactionIdleThresholdTokens,
	"compaction.idleTimeoutSeconds": cfgCompactionIdleTimeoutSeconds,
	"recap.enabled": cfgRecapEnabled,
	"recap.idleSeconds": cfgRecapIdleSeconds,
	"composer.predictions": cfgComposerPredictions,
	"composer.predictionAlternatives": cfgComposerPredictionAlternatives,
	"compaction.enabled": cfgCompactionEnabled,
	"compaction.methodOrder": cfgCompactionMethodOrder,
	"display.hideToolActivity": cfgDisplayHideToolActivity,
	"display.shellVisualization": cfgDisplayShellVisualization,
	"terminal.showImages": cfgTerminalShowImages,
	"terminal.programStatus": cfgTerminalProgramStatus,
	hideThinkingBlock: cfgHideThinkingBlock,
	proseOnlyThinking: cfgProseOnlyThinking,
	expandThinkingBlocks: cfgExpandThinkingBlocks,
	"display.advisorCollapsedLines": cfgDisplayAdvisorCollapsedLines,
	"display.cacheMissMarker": cfgDisplayCacheMissMarker,
	"display.collapseCompacted": cfgDisplayCollapseCompacted,
	"display.showTokenUsage": cfgDisplayShowTokenUsage,
	"display.showTurnTime": cfgDisplayShowTurnTime,
	"tui.colorfulMarkdown": cfgTuiColorfulMarkdown,
	"tui.renderMermaid": cfgTuiRenderMermaid,
	"tui.renderSvg": cfgTuiRenderSvg,
	"tui.renderEmbeds": cfgTuiRenderEmbeds,
	"extensionRenderers.assistantText": cfgExtensionAssistantTextRenderers,
	"extensionRenderers.transcriptPresenters": cfgExtensionTranscriptPresenters,
	"tui.autoGraph": cfgTuiAutoGraph,
	"tui.textSizing": cfgTuiTextSizing,
	"tui.tight": cfgTuiTight,
	"tui.hyperlinks": cfgTuiHyperlinks,
	"tui.titleState": cfgTuiTitleState,
	"tui.titleSpinner": cfgTuiTitleSpinner,
	motion: cfgMotionResolved,
	"statusLine.preset": cfgStatusLinePreset,
	"statusLine.leftSegments": cfgStatusLineLeftSegments,
	"statusLine.rightSegments": cfgStatusLineRightSegments,
	"statusLine.separator": cfgStatusLineSeparator,
	"statusLine.showHookStatus": cfgStatusLineShowHookStatus,
	"statusLine.sessionAccent": cfgStatusLineSessionAccent,
	"statusLine.transparent": cfgStatusLineTransparent,
	"statusLine.segmentOptions": cfgStatusLineSegmentOptions,
	"statusLine.compactThinkingLevel": cfgStatusLineCompactThinkingLevel,
	"statusLine.contextLine": cfgStatusLineContextLine,
	"git.enabled": cfgGitEnabled,
	"advisor.enabled": cfgAdvisorEnabled,
	"advisor.maxNotesPerUpdate": cfgAdvisorMaxNotesPerUpdate,
	"tier.advisor": cfgTierAdvisor,
});
type LiveUiSettings = SettingValueOf<typeof cfgLiveUiSettings>;

const STILL_CLOSING_DELAY_MS = 3_000;
const JUDGMENT_BATCH_PROGRESS_RETAIN_MS = 1_000;
/** A transcript action naming an agent to view (a live task card's agent row). */
const SUBAGENT_FOCUS_ACT = "subagents.focus=";
/** The composer's hint while an ask waits above it. */
const ASK_COMPOSER_HINT = "↑ answer the questions above, or type here to skip them";
/** Tern's placeholder while an ask waits above the composer. */
const NATIVE_ASK_PLACEHOLDER = "Answer above, or type here to skip the questions";
/** Slash-command type glyph for the autocomplete icon column; none under ASCII symbols. */
function slashCommandIcon(name: string): string | undefined {
	const symbols = currentTheme().symbols;
	if (symbols.preset === "ascii") return undefined;
	return symbols.icon(name) || undefined;
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

type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);
const PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;
const PLAN_SAVE_TITLE_LINE_LIMIT = 6;

const CFG_APPROVE_SESSION = "Always for this session";
const CFG_APPROVE_ONCE = "Allow once";
const CFG_DENY = "Deny";

const PLAN_FILENAME_SYSTEM_PROMPT = prompt.render(planFilenamePrompt);

function planSaveTitleExcerpt(planContent: string): string {
	return planContent
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.slice(0, PLAN_SAVE_TITLE_LINE_LIMIT)
		.join("\n");
}

function parseGoalSubcommand(args: string): {
	sub: GoalSubcommand | undefined;
	rest: string;
} {
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

function hasAssistantToolCall(message: AgentMessage): boolean {
	return message.role === "assistant" && message.content.some(block => block.type === "toolCall");
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
	sessionSettings: Settings,
): boolean {
	const hasConversationContext = sessionManager.buildSessionContext().messages.length > 0;
	const hasExplicitMode = sessionManager.getEntries().some(entry => entry.type === "mode_change");
	return (
		!hasConversationContext &&
		!hasExplicitMode &&
		cfgPlanDefaultOnStartup.get(sessionSettings) &&
		cfgPlanEnabled.get(sessionSettings)
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

const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

const CTRL_L_APPEARANCE_RESPONSE_DEADLINE_MS = 2000;

/** Repaint cadence of the open jobs sheet: output tails, pids and list ages are polled, not pushed. */
const JOBS_SHEET_REFRESH_MS = 250;
type PlanPreModelState = {
	model?: Model;
	identity?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
};

export class InteractiveMode implements InteractiveModeContext {
	#ownsStartedUi: boolean;
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;

	/** The screen: shell, composer, welcome card and dock models (adopted from the CLI's prepaint when it built one). */
	readonly #frame: AppFrame;
	get shell(): Shell {
		return this.#frame.shell;
	}
	get composer(): Composer {
		return this.#frame.composer;
	}
	get hud(): DockModels {
		return this.#frame.hud;
	}
	statusLinePreviewRow(columns: number): string | undefined {
		return this.#frame.statusPreviewRow(columns);
	}
	readonly statusLine: SessionStatusLine;
	/** Live transcript blocks: assistant replies, tool calls, `!`/`$` runs. */
	readonly #presenter: TranscriptPresenter;
	/** What the transcript's message faces read (the live ones, and a replica's). */
	readonly #messageEnv: MessageFaceEnv;
	/** The status row's working row. */
	readonly #working: WorkingRows;
	/** The view's display flags as signals the blocks read (the fields below write them). */
	readonly #display: DisplayFlags = {
		toolOutputExpanded: signal(false),
		hideToolActivity: signal(false),
		hideThinking: signal(false),
		proseOnlyThinking: signal(true),
		expandThinkingBlocks: signal(false),
		showImages: signal(true),
		renderSvg: signal(true),
		renderEmbeds: signal(true),
		figureCell: signal<FigureCell | undefined>(undefined),
		// Set with the terminal's rows (see `init`): a signal, so a resize that keeps the share redraws nothing.
		figureRows: signal<number | undefined>(undefined),
		tableCharts: () => this.tableChartsVisible,
		shellVisualization: signal(true),
		mcpMarkdown: signal(false),
		readPreview: signal(true),
	};

	isInitialized = false;
	initialChatRendered = false;
	isBashMode = false;
	get toolOutputExpanded(): boolean {
		return this.#display.toolOutputExpanded();
	}
	set toolOutputExpanded(expanded: boolean) {
		this.#display.toolOutputExpanded.set(expanded);
	}
	get hideToolActivity(): boolean {
		return this.#display.hideToolActivity();
	}
	set hideToolActivity(hidden: boolean) {
		this.#display.hideToolActivity.set(hidden);
	}
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
	loopCondition: LoopConditionConfig | undefined = undefined;
	/** Last state reported through `mode_changed`; starts inactive so a restored session's modes are reported too. */
	#reportedModeState: SessionModeState = {
		plan: { status: "inactive" },
		vibe: { status: "inactive" },
		goal: { status: "inactive" },
		loop: { status: "inactive" },
	};
	#reportedModeKey = JSON.stringify(this.#reportedModeState);
	/** A `ctx.sessionModes.set()` transition is running: concurrent calls are refused. */
	#modeSetInFlight = false;
	/** Open mode transitions; `mode_changed` waits until the outermost one settles. */
	#modeChangeHolds = 0;
	/** A `mode_changed` report is waiting for the running session switch to settle. */
	#modeChangeAwaitsSessionTransition = false;
	/** False until init() has restored the journaled modes; before that the state is not yet the session's. */
	#modesRestored = false;
	readonly sessionModes: ExtensionSessionModes = {
		getState: () => this.#getSessionModeState(),
		set: request => this.#setSessionMode(request),
	};
	/**
	 * Aborts the in-flight `--while` / `--until` evaluation. Esc between
	 * iterations lands while the condition command is still running, and
	 * `#cancelLoopAutoSubmit` only clears the pending timer — without this the
	 * child process would outlive the loop it was gating.
	 */
	#loopConditionAbort: AbortController | undefined;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	#pendingLoopIterations = 0;
	#todoAutoClearTimer: NodeJS.Timeout | undefined;
	#todoAutoClearGeneration = 0;
	readonly #judgmentBatchProgressClearTimers = new Map<string, NodeJS.Timeout>();
	todoPhases: TodoPhase[] = [];
	/**
	 * Session that owns the plan currently in {@link todoPhases}. HUD
	 * visibility (dismissal and reveal entries) persists to this session, not
	 * blindly to `viewSession`, which flips to the destination before
	 * `reloadTodos` refreshes during focus attach.
	 */
	#todoPhasesOwner?: AgentViewSession;
	#todoHudHidden = false;
	#hideThinkingBlock = false;
	/** Ctrl+T: thinking hidden (the blocks read the effective state, see {@link effectiveHideThinkingBlock}). */
	get hideThinkingBlock(): boolean {
		return this.#hideThinkingBlock;
	}
	set hideThinkingBlock(hidden: boolean) {
		this.#hideThinkingBlock = hidden;
		this.#syncHideThinking();
	}
	/** Push the effective thinking visibility to the blocks. */
	#syncHideThinking(): void {
		this.#display.hideThinking.set(this.effectiveHideThinkingBlock);
	}
	#sessionsWithDisplayableThinkingContent = new WeakSet<AgentViewSession>();
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
		this.#syncHideThinking();
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
	get proseOnlyThinking(): boolean {
		return this.#display.proseOnlyThinking();
	}
	set proseOnlyThinking(on: boolean) {
		this.#display.proseOnlyThinking.set(on);
	}
	get expandThinkingBlocks(): boolean {
		return this.#display.expandThinkingBlocks();
	}
	set expandThinkingBlocks(on: boolean) {
		this.#display.expandThinkingBlocks.set(on);
	}
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	yieldCompaction: YieldCompaction | undefined = undefined;
	compactionQueueOrigin: ConversationPosition | undefined = undefined;
	pendingTools = new Map<string, PendingTool>();
	transcriptBlocks = new WeakMap<AgentMessage, TranscriptBlock>();
	bashRun: ExecRun | undefined = undefined;
	pythonRun: ExecRun | undefined = undefined;
	isPythonMode = false;
	isBtwMode = false;
	streaming: AssistantView | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	lastAssistantUsage: Usage | undefined = undefined;
	servedModelTracker = new ServedModelTracker();
	/** What holds the status row's working row. */
	get working(): WorkingKind | undefined {
		return this.#working.kind;
	}
	/**
	 * Band composer: the status band hides `session_name`, so the title docks onto the working row
	 * instead: faint and italic, behind an accent pin.
	 */
	#workingTitleTrailer(): string | undefined {
		if (cfgComposerShape.get(settings) !== "band") return undefined;
		const name = this.sessionManager.getSessionName();
		if (!name) return undefined;
		const theme = currentTheme();
		const pin = this.#sessionPinned ? theme.symbols.symbol("icon.pin") : undefined;
		const title = `\x1b[2;3m${sanitizeStatusText(name)}\x1b[23;22m`;
		return pin ? `${theme.fg("accent", pin)} ${title}` : title;
	}
	/** Live gen tok/s for the working row: the viewed session's own meter, so a
	 * focused subagent shows its own reading and the main session's survives
	 * focus round-trips. */
	get tokenRate(): TokenRateMeter {
		return this.viewSession.tokenRate;
	}
	/** Generation tok/s: live while streaming, the last reading between
	 * turns, blank until a run has produced enough tokens to measure. */
	#tokenRateLabel(): string | undefined {
		if (!cfgComposerTokenRate.get(settings)) return undefined;
		const rate = this.tokenRate.rate();
		if (rate === null) return undefined;
		const theme = currentTheme();
		return theme.fg("dim", `${theme.symbols.symbol("icon.throughput")} ${rate.toFixed(1)} tok/s`);
	}
	/** Right-docked suffix of the working row, styled: the tok/s readout, then the band-mode title. */
	#workingRowTrailer(): string | undefined {
		const rate = this.#tokenRateLabel();
		const title = this.#workingTitleTrailer();
		if (rate && title) return `${rate}  ${title}`;
		return rate ?? title;
	}
	/** The interrupt key id, or undefined while Esc would not cancel a maintenance run (a focused subagent). */
	maintenanceInterruptKey(): KeyId | undefined {
		if (this.focusedAgentId) return undefined;
		return appInterruptKeys(this.keybindings)[0] ?? "escape";
	}
	/** The stop control's click: the same handler as the interrupt key. */
	interruptFromPointer(): void {
		this.#inputController.handleInterrupt();
	}
	/** Feed the native HUD pills: running agents and background jobs (the jobs a running agent owns count as its). */
	#syncHudPills(): void {
		const pills = this.hud.pills;
		const showAgents = cfgDisplayPinnedAgents.get(settings) !== "off";
		pills.showAgents.set(showAgents);
		pills.agentsRunning.set(showAgents ? this.#runningSubagentCount : 0);
		pills.agentsInSession.set(showAgents ? this.#inspectableSubagentCount : 0);
		this.#syncJobWidgetsListener();
		const background = new Set<string>();
		for (const job of this.session.getAsyncJobSnapshot()?.running ?? []) {
			if (job.agentId === undefined) background.add(job.id);
		}
		pills.jobsRunning.set(background.size);
		pills.jobWidgets.set(this.session.getRunningJobWidgets().filter(entry => background.has(entry.id)));
		this.statusLine.refreshJobs();
	}
	/** The job widget registry this mode follows, and how to stop listening to it. */
	#jobWidgetsListener: { registry: JobWidgetRegistry; unsubscribe: () => void } | undefined;
	/** The job manager whose settled jobs update the running counts, and how to stop listening to it. */
	#jobSettleListener: { manager: AsyncJobManagerApi; unsubscribe: () => void } | undefined;
	/** Follow the root job manager's widget registry and settled jobs (the pills, the status line's job count). */
	#syncJobWidgetsListener(): void {
		const manager = this.session.asyncJobManager;
		const registry = manager?.widgets;
		if (this.#jobWidgetsListener?.registry !== registry) {
			this.#jobWidgetsListener?.unsubscribe();
			this.#jobWidgetsListener = registry
				? { registry, unsubscribe: registry.subscribe(() => this.#queueHudPillsSync()) }
				: undefined;
		}
		if (this.#jobSettleListener?.manager !== manager) {
			this.#jobSettleListener?.unsubscribe();
			this.#jobSettleListener = manager
				? { manager, unsubscribe: manager.onJobSettled(() => this.#queueHudPillsSync()) }
				: undefined;
		}
	}
	#hudPillsSyncQueued = false;
	#queueHudPillsSync(): void {
		if (this.#hudPillsSyncQueued) return;
		this.#hudPillsSyncQueued = true;
		queueMicrotask(() => {
			this.#hudPillsSyncQueued = false;
			this.#syncHudPills();
			if (this.#trayShown()) this.#scheduleTraySync();
		});
	}
	/** Whether a native host advertising `tray` draws this session. */
	#trayShown(): boolean {
		return this.shell.native() && this.shell.host?.feature("tray") === true;
	}
	/**
	 * Follow the tray host: the pills hand running work to it, the status row seats it, and the
	 * root job manager's changes rebuild its cards. Runs when the host or its features change.
	 */
	#syncTrayHost(): void {
		const onHost = this.#trayShown();
		this.hud.pills.trayHost.set(onHost);
		if (!onHost) {
			this.#releaseTray();
			return;
		}
		this.#syncJobWidgetsListener();
		const manager = this.session.asyncJobManager;
		if (this.#trayJobsListener?.manager !== manager) {
			this.#trayJobsListener?.unsubscribe();
			this.#trayJobsListener = manager
				? { manager, unsubscribe: manager.onJobsChanged(() => this.#scheduleTraySync()) }
				: undefined;
		}
		this.#scheduleTraySync();
	}
	/** Coalesce tray rebuilds (as the observer's). */
	#scheduleTraySync(): void {
		if (this.#traySyncTimer) return;
		this.#traySyncTimer = setTimeout(() => {
			this.#traySyncTimer = undefined;
			if (this.#trayShown()) this.#syncTray();
		}, SUBAGENT_OBSERVER_UI_COALESCE_MS);
		this.#traySyncTimer.unref?.();
	}
	/** Rebuild the tray's cards and the status row's caption and seat. */
	#syncTray(): void {
		this.#tray.refresh();
		this.#watchTraySessions();
		const status = this.hud.status;
		status.traySeat.set(this.#tray.items.length > 0);
		status.trayCaption.set(this.#working.kind === undefined ? this.#tray.caption() : undefined);
	}
	/** Off a tray host: no job listener, no pending tray rebuild. */
	#releaseTray(): void {
		this.#trayJobsListener?.unsubscribe();
		this.#trayJobsListener = undefined;
		for (const unsubscribe of this.#traySessionWatches.values()) unsubscribe();
		this.#traySessionWatches.clear();
		if (this.#traySyncTimer) {
			clearTimeout(this.#traySyncTimer);
			this.#traySyncTimer = undefined;
		}
		this.hud.status.traySeat.set(false);
		this.hud.status.trayCaption.set(undefined);
	}
	/** Follow the registered live agents' sessions: a model or thinking switch rebuilds their cards. */
	#watchTraySessions(): void {
		const live = new Set<AgentSessionHandle>();
		for (const ref of AgentRegistry.global().list()) if (ref.session) live.add(ref.session);
		for (const [session, unsubscribe] of this.#traySessionWatches) {
			if (live.has(session)) continue;
			unsubscribe();
			this.#traySessionWatches.delete(session);
		}
		for (const session of live) {
			if (this.#traySessionWatches.has(session)) continue;
			this.#traySessionWatches.set(
				session,
				session.subscribe(event => {
					if (event.type === "model_changed" || event.type === "thinking_level_changed") this.#scheduleTraySync();
				}),
			);
		}
	}
	/**
	 * Follow the main session's turn and calls for the tray's `main` prop, updating a tray host the
	 * moment it flips (a `wait` starting or ending, the turn yielding).
	 */
	#followTrayMain(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
			case "agent_pause":
			case "agent_end":
			case "tool_execution_start":
			case "tool_execution_end":
				if (
					this.#trayMain.handle(event, this.session.isRunActive, id =>
						runsInlineAgent(this.#observerRegistry.getSessions(), id),
					) &&
					this.#trayShown()
				)
					this.#tray.syncMain();
		}
	}
	/** Stop agent `id` for good from the tray, as cancelling its task job from the jobs sheet does. */
	#stopTrayAgent(id: string): void {
		const remote = this.collabGuest?.hubRemote;
		if (remote) {
			remote.kill(id);
			return;
		}
		const scope = { agentRegistry: AgentRegistry.global(), agentLifecycle: () => AgentLifecycleManager.global() };
		stopAgentRun(scope, this.session.asyncJobManager, id, USER_INTERRUPT_LABEL).then(
			outcome => {
				if (outcome.status !== "cancelled") this.showWarning(outcome.message);
			},
			(error: unknown) => this.showError(error instanceof Error ? error.message : String(error)),
		);
	}
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined = undefined;
	locallySubmittedUserSignatures: Set<string> = new Set();
	#pendingSubmittedInput: (SubmittedUserInput & { submittedAt: number }) | undefined;
	#pendingSubmissionDispose: (() => void) | undefined;
	#pendingSubmissionPreservesDraft = false;
	/** Unregisters this mode's transcript-image blob writer (a later mode's registration survives). */
	#disposeImageBlobWriter: (() => void) | undefined;
	#disposeInlineImageLimits: (() => void) | undefined;
	#optimisticUserMessageBlocks: TranscriptBlock[] = [];
	#optimisticSkillMessageBlocks: TranscriptBlock[] = [];
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
	/**
	 * Cancellation scope of the current `shutdown()`/`restart()` close attempt.
	 * Every prompt the close shows before teardown (the extension
	 * `session_before_shutdown` gate, `worktree.onExit` confirmations) runs
	 * under it; another close request, a signal teardown, or `stop()` aborts it.
	 */
	#closeAttempt: AbortController | undefined;
	/**
	 * Set once a graceful {@link shutdown} teardown threw. The teardown is
	 * promise-memoized (and the session manager latches its disk error), so
	 * re-running it repeats the identical failure — without this flag the user is
	 * trapped in a process that can never close (#12238: a corrupted session file
	 * makes the close-time rewrite refuse to clobber it). The next shutdown is the
	 * escape hatch: exit without writing the session log.
	 */
	#teardownFailed = false;
	/** True once a graceful `shutdown()` teardown failed at the memoized
	 *  dispose stage. Surfaced to the input controller so the next single
	 *  Ctrl+C skips the double-tap gate and runs `shutdown()` — which
	 *  force-quits — instead of merely clearing the editor (#12238). */
	get teardownFailed(): boolean {
		return this.#teardownFailed;
	}
	/** Worktrees this launch created (auto-start or `/wt`), considered on exit per `worktree.onExit`. */
	#ownedWorktrees: SessionWorktree[] = [];
	/** Owned worktrees whose `post-checkout` hook is still running: an exit keeps them rather than remove them under the hook. */
	#worktreesInHook = new Set<SessionWorktree>();
	/** True once `shutdown()` has begun teardown. Surfaced to the input
	 *  controller so a Ctrl+C arriving while teardown is in flight can hard-
	 *  abort the remaining work instead of stacking another no-op call. */
	get isShuttingDown(): boolean {
		return this.#isShuttingDown;
	}
	hookSelector: OverlayHandle | undefined = undefined;
	hookInput: OverlayHandle | undefined = undefined;
	hookEditor: OverlayHandle | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();
	/** Owns hosting: manual `/collab`, `collab.autoStart`, and room rotation on session switch. */
	readonly collabController: CollabController;
	/** Owned room; use {@link collabController}.host for current-session reuse and links. */
	collabHost?: CollabHost;
	#collabGuest: CollabGuestLink | undefined;
	/** Set with {@link setCollabGuest}. */
	get collabGuest(): CollabGuestLink | undefined {
		return this.#collabGuest;
	}
	/**
	 * A guest's transcript is the host's and draws stock cards. Joining replays the host's next
	 * ({@link renderInitialMessages} drops the local presenters then), so the local blocks keep their
	 * drawing meanwhile; leaving restored the local transcript while the guest still held it, so its
	 * blocks are asked again.
	 */
	setCollabGuest(guest: CollabGuestLink | undefined): void {
		this.#collabGuest = guest;
		if (!guest) this.#syncTranscriptPresenters();
	}
	#streamPublisher: StreamPublisher | undefined;
	#recorder: SessionRecorder | undefined;
	#recorderStarting = false;

	/** Command output held while a turn streams (also previewed in the `deferredCommand` slot). */
	#pendingCommandOutput: { factory: () => JSXNode; options?: BlockOptions & { readonly live?: boolean } }[] = [];
	#pendingCommandOutputSessionId: string | undefined;
	/** Commands (not components) queued while streaming, for the deferral hint. */
	#pendingCommandOutputCommands = 0;
	#pendingSlashCommands: SlashCommand[] = [];
	/** Symbol preset the slash-command picker icons were resolved under. */
	#slashIconPreset: string | undefined;
	/** Built-in editor autocomplete provider, before extension wrapping. */
	#baseAutocompleteProvider: AutocompleteProvider | undefined;
	/** Extension-registered provider factories, applied in registration order (#4919). */
	#autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	#cleanupUnsubscribe?: () => void;
	#signalTeardown?: SessionTeardown;
	readonly #version: string;
	/** The startup changelog under the welcome card, kept so a live config-warning change can rebuild the header (#10048). */
	#headerAfter: (() => JSXNode) | undefined;
	/** The header's blocks under the welcome card: config warnings, then the startup changelog. */
	#headerBlocks: TranscriptBlock[] = [];
	#planModePreviousToolPresentation: { enabled: string[]; mounted: string[]; registered: string[] } | undefined;
	/** True while goal mode owns the `goal` tool in the live roster; exit strips only that tool. */
	#goalToolAddedByMode = false;
	// True from `/guided-goal` kickoff until the interview ends: a goal record
	// appears, a turn makes tool calls (the interview itself is tool-free, so
	// tool use means it was abandoned for real work), the kickoff fails, or the
	// session switches. While set, short replies like "c" are answers, not
	// continue shortcuts.
	#guidedGoalInterviewActive = false;
	#vibeModePreviousTools: string[] | undefined;
	#vibeModeOwnerScope: VibeOwnerScope | undefined;
	// In-flight #enterVibeMode promise: set before the activateVibeTools await
	// (while vibeModeEnabled is still false) and cleared when entry settles.
	// Loop reset guards treat a pending entry as active, and a concurrent /vibe
	// command awaits it instead of dispatching its prompt on the stale toolset.
	#vibeModeEntry: Promise<void> | undefined;
	// FIFO tail + live count for concurrent /vibe skill dispatches. A skill
	// prompt yields on its file read before the turn reserves, so each skill
	// links behind its predecessor (arrival order) while the count — visible
	// synchronously, unlike a single shared slot — stops later prompts from
	// overtaking any of them. Both settle when the dispatch settles, so a
	// failure unblocks every waiter instead of hanging it.
	#vibeSkillTail: Promise<void> = Promise.resolve();
	#vibeSkillInFlight = 0;
	#vibeScopeSuspendedForSwitch = false;
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	/** Submitted continuation turns awaiting their asynchronously delivered `agent_end`. */
	#pendingGoalContinuationTurns = 0;
	#previousGoalContinuationActivity: string | undefined;
	#goalSuppressNextContinuation = false;
	#planModePreviousModelState: PlanPreModelState | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** Whether #pendingModelSwitch was queued by the live plan-role reconciler. */
	#pendingPlanModelSwitch = false;
	#planModeHasEntered = false;
	#planReview: PlanReviewModel | undefined;
	#planReviewOverlayHandle: OverlayHandle | undefined;
	#sessionInfoOverlayHandle: OverlayHandle | undefined;
	#spotlightSheetHandle: OverlayHandle | undefined;
	#jobsSheetHandle: OverlayHandle | undefined;
	/** Re-renders the open jobs sheet so output tails and pids stay live. */
	#jobsSheetTimer: NodeJS.Timeout | undefined;
	/** The last frame the terminal renderer presented (seeds a new recorder or stream viewer). */
	#lastFrame: PresentedFrame | undefined;
	#editorAreaDialog: OverlayHandle | undefined;
	/** Until when a theme change replays history again (Ctrl+L's appearance query); 0 when none waits. */
	#appearanceRefreshDeadline = 0;
	#planReviewOwner: object | undefined;
	#planReviewCancel: (() => void) | undefined;
	#planReviewPick: ((choice: string) => boolean) | undefined;
	/** Runs once when the open review's overlay is hidden; set by `showPlanReview`'s `onClose`. */
	#planReviewOnHide: (() => void) | undefined;
	/** The open review awaiting an answer; cleared as soon as a local or remote pick settles it. */
	#pendingPlanReview:
		| {
				request: PlanReviewRequestedEvent;
				remote?: { choice: PlanReviewChoice; feedback?: string };
				/**
				 * Applies a remote tier pick to the review's slider selection; false when `role` names no tier
				 * or `choice` is disabled on it. Undefined when the slider is hidden.
				 */
				selectTier?: (role: string, choice: PlanReviewChoice) => boolean;
				/** A remote Save: writes the plan to its default file name; the review stays open. */
				save: () => void;
		  }
		| undefined;
	/** Serializable review annotations keyed by the resolved plan file path. */
	#planReviewAnnotationState = new Map<string, PlanReviewAnnotationState>();
	/** Annotation state held until the associated queued refinement actually starts. */
	#planReviewAnnotationStateBySubmission = new WeakMap<SubmittedUserInput, string>();
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: MCPManager;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	/** The open Codex reset celebration; one at a time. */
	#fireworks: OverlayHandle | undefined;
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
	/**
	 * Settles pending `cfg://` approval prompts when the mode stops, so a
	 * prompt armed without a deadline cannot outlive the UI waiting on it.
	 * Stays aborted after a stop: queued approvals behind the approval mutex
	 * then deny instead of prompting onto a torn-down UI. Refreshed by `init`.
	 */
	#dialogLifetime = new AbortController();
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #focusController: SessionFocusController;
	/** Sessions retain this small activity record, not the terminal and its transcript, after the view leaves. */
	readonly #idleMaintenanceActivity: {
		target: AgentViewSession | undefined;
		ready: boolean;
		isComposing: boolean;
		scheduledTurn: ((target: AgentViewSession) => boolean) | undefined;
		presentRecap: ((recap: string) => void) | undefined;
	} = { target: undefined, ready: false, isComposing: false, scheduledTurn: undefined, presentRecap: undefined };

	syncIdleMaintenanceView(target: AgentViewSession | null = this.viewSession): void {
		const activity = this.#idleMaintenanceActivity;
		const previous = activity.target;
		if (target === null) {
			activity.target = undefined;
			activity.ready = false;
			activity.isComposing = false;
			activity.scheduledTurn = undefined;
			activity.presentRecap = undefined;
			previous?.refreshIdleMaintenance();
			return;
		}
		if (!activity.scheduledTurn) return;
		activity.target = target;
		activity.isComposing = untrack(this.composer.text).trim() !== "";
		target.enableIdleMaintenance({
			isBlocked: () => !activity.ready || activity.target !== target || activity.isComposing,
			scheduledTurn: () => activity.scheduledTurn?.(target) === true,
			// Delivered only while unblocked, so `target` is the session on screen.
			onRecap: recap => activity.presentRecap?.(recap),
		});
		if (previous !== target) previous?.refreshIdleMaintenance();
		target.refreshIdleMaintenance();
	}
	get viewSession(): AgentViewSession {
		return this.#focusController.target ?? this.session;
	}
	get assistantImagesVisible(): boolean {
		return cfgTerminalShowImages.get(this.settings);
	}
	get tableChartsVisible(): boolean {
		return this.#focusController.target === undefined;
	}
	resolveAssistantMessageLinkHrefs(hrefs: readonly string[]): Promise<ReadonlyMap<string, string>> {
		return resolveMarkdownLinkHrefs(hrefs, this.#linkResolveContext());
	}
	#linkResolveContext(): ResolveContext {
		const session = this.viewSession;
		return {
			cwd: session.sessionManager.getCwd(),
			sessionFile: session.sessionFile,
			settings: session.settings,
			localProtocolOptions: {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			},
			skills: session.skills,
			rules: session.ttsrManager?.getRules(),
		};
	}
	approvalOwnsComposer = false;
	composerOwner?: ComposerOwner;
	get focusedAgentId(): string | undefined {
		return this.#focusController.focusedAgentId;
	}
	get sessionName(): string | undefined {
		return this.session.sessionName;
	}
	focusAgentSession(id: string): Promise<void> {
		// Viewing an agent may revive it, passing its registry status through `running`: the
		// tray must not read that as work (cards would regroup, a quiet tray would wake).
		// Off a tray host, or for an agent already at work, it is simply viewed.
		if (!this.#trayShown() || AgentRegistry.global().get(id)?.status === "running") {
			return this.#focusController.focusAgent(id);
		}
		this.#trayReviving.add(id);
		return this.#focusController.focusAgent(id).finally(() => {
			this.#trayReviving.delete(id);
			if (this.#trayShown()) this.#scheduleTraySync();
		});
	}
	focusParentSession(): Promise<void> {
		return this.#focusController.focusParent();
	}
	unfocusSession(): Promise<void> {
		return this.#focusController.unfocus();
	}
	invalidatePendingFocus(): void {
		this.#focusController.invalidatePendingFocus();
	}

	/** Rebuild the pinned jump list for a `display.pinnedAgents` change. */
	applyPinnedAgentsSetting(): void {
		// An explicit settings change wins over click state: without the reset,
		// reselecting the current value would keep showing the old override.
		this.#pinnedHudOverride = undefined;
		this.#renderSubagentList();
		this.#syncHudPills();
	}

	clearTransientSessionUi(options?: { viewOnly?: boolean }): void {
		this.#hideSessionInfo();
		this.#working.clear();
		this.#presenter.clearPendingExecRuns();
		this.hud.queue.groups.set([]);
		this.#clearJudgmentBatchProgress();
		this.hud.modelCycle.clear();
		this.#pendingCommandOutput = [];
		this.#pendingCommandOutputSessionId = undefined;
		this.#pendingCommandOutputCommands = 0;
		this.#syncDeferredCommandPreview();
		// A view switch leaves the main session, and the input queued for it, in place. A session reset
		// hands a queued `/compact` and the input in the compaction queue back to the editor.
		if (!options?.viewOnly) this.#inputController.restoreCompactionQueueToEditor();
		this.streaming = undefined;
		this.streamingMessage = undefined;
		this.lastAssistantUsage = undefined;
		this.servedModelTracker = new ServedModelTracker();
		this.pendingTools.clear();
	}
	readonly #uiHelpers: UiHelpers;
	#sttController: STTController | undefined;
	#dictationStarting = false;
	#micCursor: MicCursor | undefined;
	#observerRegistry: SessionObserverRegistry;
	/** Click override for the pinned jump-list density; undefined follows `display.pinnedAgents`. */
	#pinnedHudOverride: boolean | undefined;
	#eventBus?: EventBus;
	#subagentEventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	/** Mirror of `tui.mouse`: the terminal reports clicks (node hits, extension links). */
	#mouseCapture = false;
	/** The fullscreen extension link browser while it is shown. */
	#linkBrowser: { replies: Signal<readonly LinkReply[]>; handle: OverlayHandle } | undefined;
	#observerUiSyncTimer?: NodeJS.Timeout;
	/** Feeds the dock tray; idle unless a native host advertises `tray`. */
	readonly #tray: TrayFeed;
	/** Agents being opened for viewing; see `TrayInput.reviving`. */
	readonly #trayReviving = new Set<string>();
	/** What the main agent is doing, as the tray's `main` prop says; follows the main session's events. */
	readonly #trayMain = new TrayMainActivity(false);
	/** The root job manager the tray repaints on, and how to stop listening to it. */
	#trayJobsListener: { manager: AsyncJobManagerApi; unsubscribe: () => void } | undefined;
	/** Live agents' sessions the tray follows for model and thinking switches, by session. */
	readonly #traySessionWatches = new Map<AgentSessionHandle, () => void>();
	#traySyncTimer?: NodeJS.Timeout;
	/** Active subagent descriptions the todo HUD last rendered with (joined); see #flushObserverUiSync. */
	#todoHudSubagentKey: string | undefined;
	#runningSubagentCount = 0;
	/** Prose word completion for the composer's ghost text (`spelling.autocomplete`). */
	readonly #wordCompletion = new WordCompletionProvider(textPredictionBackend);
	/** Bumped when state the composer hint reads (running agents, the conversation) may have changed. */
	readonly #composerHintRevision = signal(0);
	/** Agents the hub can show, running or not: keeps the HUD agents segment up after the last one finishes. */
	#inspectableSubagentCount = 0;
	#agentRegistryUnsubscribe?: () => void;
	#agentRegistrySubscriptionTarget?: AgentHubRegistry;
	#subagentSessionCosts = new WeakMap<object, AgentCostSnapshot>();
	#subagentCostHydratedRoot?: string;
	#mcpStatusOrder: string[] = [];
	#mcpPendingServers = new Set<string>();
	#mcpConnectedServers = new Set<string>();
	#mcpFailedServers = new Map<string, { error: string; sourcePath?: string }>();

	/** Root-scoped bus carrying this session tree's `task:subagent:*` frames. */
	get subagentEventBus(): EventBus | undefined {
		return this.#subagentEventBus;
	}

	constructor(
		session: AgentSession,
		version: string,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: MCPManager,
		eventBus?: EventBus,
		frame?: AppFrame,
		subagentEventBus?: EventBus,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.#ownsStartedUi = frame?.shell.host !== undefined;
		this.#frame =
			frame ??
			new AppFrame({
				version,
				shape: cfgComposerShape.get(settings),
				quiet: cfgStartupQuiet.get(settings),
				intro: true,
				vim: cfgTuiVimMode.get(settings),
				autocompleteMaxVisible: cfgAutocompleteMaxVisible.get(settings),
				hardwareCursor: cfgShowHardwareCursor.get(settings),
				imeSafeCursor: cfgTuiImeSafeCursor.get(settings),
			});
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		// An MCP sign-in can wait for the user mid-turn; like the auto-QA and cfg:// prompts below, it runs as a wait for
		// the user (AgentSession.waitForUser).
		this.mcpManager?.setAuthHandler((serverName, challenge) =>
			this.session.waitForUser(() => new MCPCommandController(this).handleMCPAuthChallenge(serverName, challenge)),
		);
		this.#eventBus = eventBus;
		this.#subagentEventBus = subagentEventBus;
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					if (cfgStartupQuiet.get(this.settings)) return;
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
				eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
					if (!isMcpConnectionStatusEvent(data)) {
						logger.warn("Ignoring malformed mcp:connection-status event", { data });
						return;
					}
					this.#handleMcpConnectionStatusEvent(data);
				}),
				eventBus.on(JUDGMENT_BATCH_PROGRESS_EVENT_CHANNEL, data => {
					if (!isJudgmentBatchProgress(data)) {
						logger.warn("Ignoring malformed eval:judgment-batch-progress event", { data });
						return;
					}
					this.#handleJudgmentBatchProgress(data);
				}),
			);
		}
		this.#eventBusUnsubscribers.push(onDownloadActivity(activity => this.hud.progress.downloads.update(activity)));
		applyFileLinkSetting();
		this.#mouseCapture = cfgTuiMouse.get(this.settings);
		this.#eventBusUnsubscribers.push(
			cfgTuiMouse.listen(this.settings, on => {
				this.#mouseCapture = on;
				// Any-motion tracking, as the old UI's: hovered rows band under the pointer.
				this.shell.setInlineMouse(on ? "any" : "off");
				this.#syncExtensionLinkClicks();
			}),
		);
		setExtensionLinkClicksProvider(() => this.#extensionLinkClicksAvailable());

		this.statusLine = new SessionStatusLine(session);
		this.statusLine.onPullRequest = pr => setTerminalTitlePullRequest(pr?.number);
		this.statusLine.onResetExpiryNotice = notice => this.showWarning(notice);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.statusLine.setModes({
			vibeWorkerTokenRate: () => aggregateVibeWorkerTokensPerSecond(this.session.getAgentId() ?? MAIN_AGENT_ID),
		});
		this.statusLine.onCodexResetFireworks = event => {
			if (this.#fireworks) return;
			const startedAt = Date.now();
			this.#fireworks = showSheet(
				this.shell,
				FIREWORKS_SHEET,
				() => jsx(CodexResetFireworks, { event, startedAt, onClose: () => this.#fireworks?.close() }),
				{ onClose: () => (this.#fireworks = undefined) },
			);
		};

		this.#working = new WorkingRows({
			status: this.hud.status,
			interruptKey: () => appInterruptKeys(this.keybindings)[0] ?? "escape",
			// Read through the status facts, which a rename or an accent toggle refreshes: a running
			// row recolors with them.
			accentTitle: () => {
				this.statusLine.facts();
				return !isSettingsInitialized() || cfgStatusLineSessionAccent.get(settings) !== false
					? this.sessionManager.getSessionName()
					: undefined;
			},
			shimmer: () => cfgMotionResolved.get(this.settings).shimmer,
			trailer: () => this.#workingRowTrailer(),
			runStartedAt: () => this.viewSession.runStartedAt,
			retryHintWanted: () =>
				!this.collabGuest && !this.viewSession.isStreaming && this.viewSession.hasAbortedToolCallTail,
			retryKey: () => this.keybindings.keysFor("app.retry")[0] ?? "f5",
		});
		this.hud.status.onInterrupt = () => this.interruptFromPointer();
		this.#messageEnv = {
			expanded: () => this.#display.toolOutputExpanded(),
			activityVisible: () => !this.#display.hideToolActivity(),
			advisorCollapsedLines: () => cfgDisplayAdvisorCollapsedLines.get(this.settings),
			renderer: customType => this.viewSession.extensionRunner?.getMessageRenderer(customType),
			onRenderError: (customType, error) =>
				logger.warn("Extension message renderer failed", { customType, error: String(error) }),
			imageLinks: (_message, images) => imageLinksForMessage(images, this.viewSession.sessionManager),
			showImages: this.#display.showImages,
			skillPath: name => this.skillCommands.get(`skill:${name}`)?.filePath,
			actions: () => true,
			hour12: this.shell.hour12,
			promptZones: promptZonesEnabled,
			magicKeywords: () => enabledMagicKeywords(this.settings),
			onUserAction: (act, text, timestamp) => this.#onPromptAction(act, text, timestamp),
		};
		const host = this;
		this.#presenter = new TranscriptPresenter({
			shell: this.shell,
			get viewSession() {
				return host.viewSession;
			},
			display: this.#display,
			pendingShellRuns: this.#frame.pendingShellRuns,
			linkTargets: () => getAssistantMessageLinkTargets(this),
			openSpotlight: (spotlight, reduced) => void this.#showSpotlightSheet(spotlight, reduced),
			onAssistantAction: (act, message, copyText) => this.#onTranscriptAction(act, message, copyText),
			messages: this.#messageEnv,
		});
		// Transcript images without a file of their own (pasted, tool-produced) link to a
		// blob copy of their bytes, the store that backs composer chips.
		this.#disposeImageBlobWriter = setImageBlobWriter((data, options) =>
			this.viewSession.sessionManager.putBlobSync(data, options),
		);
		this.#disposeInlineImageLimits = followInlineImageLimits(() => this.shell.size().rows);
		this.#tray = new TrayFeed(
			{
				input: () => {
					// A collab guest's registry mirrors the host's session: every agent in it is the session's.
					const root = this.collabGuest ? undefined : this.sessionManager.getSessionFile();
					return collectTrayInput({
						observers: this.#observerRegistry,
						refs: getRunningSubagentBadgeRegistry(this.collabGuest, AgentRegistry.global())
							.list()
							.filter(ref => isSessionTreeRef(ref, root)),
						manager: this.session.asyncJobManager,
						snapshot: () => this.session.getAsyncJobSnapshot({ recentLimit: Number.POSITIVE_INFINITY }),
						irc: IrcBus.existing(),
						showAgents: cfgDisplayPinnedAgents.get(settings) !== "off",
						canFocus: this.collabGuest === undefined,
						reviving: this.#trayReviving,
					});
				},
				main: () => this.#trayMain.state(id => runsInlineAgent(this.#observerRegistry.getSessions(), id)),
				focusAgent: id => {
					this.focusAgentSession(id).catch((error: unknown) =>
						this.showError(error instanceof Error ? error.message : String(error)),
					);
				},
				showJobsSheet: selected => this.showJobsSheet(selected),
				stopAgent: id => this.#stopTrayAgent(id),
				cancelJob: id => {
					this.session.cancelAsyncJob(id);
				},
			},
			this.hud.tray,
		);
		this.#eventBusUnsubscribers.push(() => {
			this.#releaseTray();
			this.#tray.dispose();
		});
		this.hud.pills.onOpenAgents = () => this.showAgentHub();
		this.hud.pills.onOpenJobs = () => this.showJobsSheet();
		this.hud.subagents.onFocus = id => this.#focusSubagentFromHud(id);
		this.hud.subagents.onToggle = () => this.#togglePinnedHudExpanded();
		this.hud.queue.onEdit = () => this.handleDequeue();

		this.#display.hideToolActivity.set(cfgDisplayHideToolActivity.get(settings));
		this.#hideThinkingBlock = cfgHideThinkingBlock.get(settings);
		this.#display.proseOnlyThinking.set(cfgProseOnlyThinking.get(settings));
		this.#display.expandThinkingBlocks.set(cfgExpandThinkingBlocks.get(settings));
		this.#syncTranscriptDisplaySettings();
		this.#applyAutoGraphSetting();

		const composer = this.composer;
		// Enter waits for init: a submission before the pipeline exists would clear the draft into nowhere.
		if (!this.isInitialized) composer.setDisableSubmit(true);
		this.#wordCompletion.setMethod(cfgSpellingAutocomplete.get(this.settings));
		composer.setWordCompletion(this.#wordCompletion);
		this.#syncEditorMaxHeight();
		// The composer caps its height to the terminal's rows.
		this.#effect(() => {
			const { rows } = this.shell.size();
			this.shell.native();
			// Tern lays figures out itself: its rasters keep their full size.
			const figureRows = nativeRendering() ? undefined : figureMaxRows(rows);
			untrack(() => {
				this.#display.figureRows.set(figureRows);
				this.#syncEditorMaxHeight();
				// A short terminal folds the plan into the status row.
				this.hud.todo.compact.set(rows < TODO_COMPACT_ROWS);
				this.hud.deferred.maxRows.set(deferredMaxRows(rows));
			});
		});
		try {
			this.historyStorage = HistoryStorage.open();
			const storage = this.historyStorage;
			composer.setHistory(
				storage.getRecent(100).map(entry => entry.prompt),
				text => {
					storage.add(text, getProjectDir()).catch(error => {
						logger.error("HistoryStorage add failed", { error: String(error) });
					});
				},
			);
			storage.setSessionResolver(() => this.sessionManager.getSessionId());
			// The prediction daemon learns from history.db; nudge it once each prompt is durable.
			storage.setAddListener(syncTextPrediction);
			storage.setErrorListener(() => {
				this.showWarning("Prompt history could not be saved; this prompt may be unavailable after restart.");
			});
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}

		// Store pending commands for init() where file commands are loaded async
		this.#pendingSlashCommands = this.#buildPendingSlashCommands();

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
		this.collabController = new CollabController(this);
		this.session.setPromptDropped?.(prompt => this.restoreDroppedPrompt(prompt));
		this.#observerRegistry = new SessionObserverRegistry();
		// The composer hint follows the ask above, running agents and the conversation's start.
		this.#effect(() => this.composer.setPlaceholder(this.#composerHint()));
		this.#effect(() => this.composer.setNativePlaceholder(this.#nativeComposerPlaceholder()));
		// A `/btw` note taking or giving back the composer changes its role and chip; so does a draft
		// that starts or stops skipping the ask waiting above (read only while one waits).
		this.#effect(() => {
			this.#btwController.isFocused();
			this.#extensionUiController.composerAsk();
			untrack(() => this.#syncComposerState());
		});
		// Idle, the terminal's status row keeps the working row's trailer (band title with its pin,
		// tok/s): the status facts follow renames, pins and session events.
		this.#effect(() => {
			this.statusLine.facts();
			const working = this.hud.status.row()?.kind === "working";
			const trailer = working ? undefined : untrack(() => this.#workingRowTrailer());
			untrack(() => this.hud.status.idleTrailer.set(trailer));
		});
		this.composer.setPredictions({
			choices: () => this.#eventController.composerPrediction.choices,
			shown: () => this.#eventController.composerPrediction.shown(),
			accepted: rank => this.#eventController.composerPrediction.accepted(rank),
		});
		// Both read the viewed session through the focus controller: after every controller exists.
		// A started frame (the startup frame's predicted bar) redraws the bar's slots at once.
		this.#attachStatusLine();
		this.#predictStatusForNextLaunch();
		// The composer's dictation control shows while speech-to-text is on.
		const syncDictation = (enabled: boolean): void =>
			this.#frame.dictation.set(enabled ? (this.#sttController?.state ?? "idle") : undefined);
		syncDictation(cfgSttEnabled.get(settings));
		this.#eventBusUnsubscribers.push(cfgSttEnabled.listen(settings, syncDictation));
	}

	/** Show the session's status line in the composer chrome, with the generation-rate readout. */
	#attachStatusLine(): void {
		const showRate = signal(cfgComposerTokenRate.get(settings));
		this.#eventBusUnsubscribers.push(cfgComposerTokenRate.listen(settings, on => showRate.set(on)));
		const showUsage = () => void this.handleUsageCommand();
		this.#frame.setStatusLine(this.statusLine, {
			actions: {
				"status.model": () => this.showModelSelector({ temporaryOnly: true }),
				"status.context": () => this.handleContextCommand(),
				"status.git": () => this.showGitUi(),
				"status.cost": showUsage,
				"status.usage": showUsage,
				"status.cache": () => void this.handleSessionCommand(),
				"status.path": () => openPath(this.sessionManager.getCwd()),
				"status.tree": () => this.showTreeSelector(),
				"thinking.cycle": () => this.#inputController.cycleThinkingFromComposer(),
				"thinking.set": value => this.#inputController.setThinkingFromComposer(value),
				"dictation.toggle": () => void this.#toggleComposerDictation(),
			},
			rate: () => (showRate() ? this.statusLine.composerRate() : undefined),
		});
	}

	/** Run `fn` as an effect owned by this mode (disposed at stop). */
	/**
	 * Keep the startup cache's status prediction current: the next launch's first frame draws it
	 * before its session exists. The context is the one a fresh session here starts with.
	 */
	#predictStatusForNextLaunch(): void {
		const cache = sharedStartupCache();
		if (!cache) return;
		const project = getProjectDir();
		let freshContext = cache.read(project).status?.facts.context;
		this.#effect(() => {
			const facts = this.statusLine.facts();
			const settings = this.statusLine.settings();
			if (this.focusedAgentId !== undefined) return;
			if (untrack(() => this.viewSession.messages.length) === 0) freshContext = facts.context;
			if (!freshContext) return;
			// A fresh session runs at the configured tier, not this one's `/fast` toggle.
			const model = untrack(() => this.session.model);
			const fastMode = model !== undefined && this.session.isFastModeConfiguredFor(model);
			cache.writeStatus(project, predictStatus(facts, settings, { context: freshContext, fastMode }));
		});
	}

	#effect(fn: () => void): void {
		createRoot(dispose => {
			effect(fn);
			this.#eventBusUnsubscribers.push(dispose);
		});
	}

	/** Start the shell (unless a prepaint already did) on the process terminal. */
	async #startShell(clearHistory: boolean): Promise<void> {
		this.#syncFrameSettings();
		await this.#frame.start({
			clearHistory,
			resizeScrollback: cfgTuiResizeScrollback.get(this.settings),
		});
	}

	/** The terminal renderer's presented frames, for `/record` and the live stream (none natively). */
	#frameSource(): StreamFrameSource {
		return {
			size: () => untrack(this.shell.size),
			onFrame: listener => this.shell.host?.onFrame(listener) ?? (() => {}),
			current: () => this.#lastFrame,
		};
	}

	/** `tui.maxFps`, `tui.hyperlinks` and `tui.textSizing` into the running renderer. */
	#syncFrameSettings(): void {
		this.#frame.frameInterval.set(1000 / cfgTuiMaxFps.get(this.settings));
		const hyperlinks = cfgTuiHyperlinks.get(this.settings);
		this.#frame.hyperlinks.set(hyperlinks === "off" ? false : hyperlinks === "always" ? true : undefined);
		this.#frame.textSizing.set(cfgTuiTextSizing.get(this.settings));
	}

	/** Follow the started host: terminal appearance, mouse, link routing, the tray, frame settings. */
	#bindShellHost(): void {
		this.#eventBusUnsubscribers.push(cfgTuiMaxFps.listen(this.settings, () => this.#syncFrameSettings()));
		this.shell.transcript.onSelect = href => this.#onTranscriptSelect(href);
		// A live task card's agent row (terminal): view that agent.
		this.shell.transcript.onAction = act => {
			if (act.startsWith(SUBAGENT_FOCUS_ACT)) void this.focusAgentSession(act.slice(SUBAGENT_FOCUS_ACT.length));
		};
		const host = this.shell.host;
		if (!host) return;
		const updateFigureCell = (): void => {
			const caps = host.driver.capabilities;
			const next = caps.images ? (caps.cell ?? DEFAULT_FIGURE_CELL) : undefined;
			const current = this.#display.figureCell.peek();
			if (current?.w !== next?.w || current?.h !== next?.h) this.#display.figureCell.set(next);
		};
		updateFigureCell();
		// A confirmed Glyph Protocol handshake means omp's own icons render without a Nerd Font, so
		// the unconfigured `unicode` preset is upgraded to `nerd` for this session. The setting is
		// left alone (it travels to terminals where the upgrade would show tofu); an explicit
		// preset is never touched.
		const upgradeGlyphs = (): void => {
			if (
				!host.driver.identity.glyphs ||
				cfgSymbolPreset.provenance(settings) !== "default" ||
				currentTheme().symbols.preset !== "unicode"
			)
				return;
			void setSymbolPreset("nerd");
		};
		upgradeGlyphs();
		this.#eventBusUnsubscribers.push(
			host.driver.onCapabilities(upgradeGlyphs),
			host.driver.onCapabilities(updateFigureCell),
			followTerminal(host.driver),
			host.onFrame(frame => (this.#lastFrame = frame)),
		);
		// A palette change Ctrl+L's appearance query reveals recolors the history it replayed too.
		this.#effect(() => {
			currentTheme();
			if (Date.now() > this.#appearanceRefreshDeadline) return;
			this.#appearanceRefreshDeadline = 0;
			untrack(() => this.shell.host?.replayHistory());
		});
		this.shell.setInlineMouse(this.#mouseCapture ? "any" : "off");
		// Tern routes link clicks and draws the tray itself: follow it as it comes and goes.
		this.#effect(() => {
			this.shell.native();
			untrack(() => {
				this.#syncExtensionLinkClicks();
				this.#syncTrayHost();
			});
		});
		// Tern reads and shows this session's checkout itself: nothing to read here while it does.
		this.#effect(() => {
			const homed = this.shell.native() && this.shell.host?.checkoutShown() === true;
			untrack(() => this.statusLine.setCheckoutHomed(homed));
		});
		this.#probeProgramStatus();
	}

	/**
	 * Ask whether the terminal keeps OSC 7501 program-status records (working/blocked); only a
	 * confirmed receiver gets them. Multiplexers can consume the query or leak the reply into the
	 * pane, so their panes are not asked.
	 */
	#probeProgramStatus(): void {
		const driver = this.shell.host?.driver;
		if (!driver || insideMultiplexer(Bun.env)) return;
		const stop = this.interceptInput(event => {
			if (event.type !== "osc" || !event.raw.startsWith("\x1b]7501;")) return false;
			stop();
			const fields = /^\x1b\]7501;\?((?::[^\x07\x1b]*)?)(?:\x07|\x1b\\)$/u.exec(event.raw)?.[1];
			if (fields === undefined) return true;
			let states: string[] | undefined;
			for (const pair of fields.split(":")) {
				const eq = pair.indexOf("=");
				if (eq !== -1 && pair.slice(0, eq).trim() === "states")
					states = pair
						.slice(eq + 1)
						.split(",")
						.map(state => state.trim());
			}
			setProgramStatusSupported(states === undefined || (states.includes("working") && states.includes("blocked")));
			return true;
		});
		this.#eventBusUnsubscribers.push(stop);
		driver.writeRaw("\x1b]7501;?\x1b\\");
	}

	/** A reply's transcript control (retry, copy, switch model, a turn's hold-menu action). */
	#onTranscriptAction(act: string, message: AssistantMessage | undefined, copyText?: string): void {
		switch (act) {
			case "retry":
				void this.#inputController.handleRetry();
				return;
			case "switch-model":
				this.showModelSelector({ temporaryOnly: true });
				return;
			case "copy-answer":
			case "copy-error":
				if (copyText) void this.#copyToClipboardWithStatus(copyText);
				return;
			case "edit-turn":
			case "retry-turn":
			case "rewind-turn":
			case "fork-turn":
				if (!message) return;
				void this.#selectorController.runTurnAction(act.slice(0, -"-turn".length) as TurnAct, {
					role: "assistant",
					at: message.timestamp,
				});
				return;
		}
	}

	/** A prompt bubble's control or hold-menu entry. */
	#onPromptAction(act: string, text: string, timestamp: number): void {
		switch (act) {
			case "copy-message":
				copyToClipboard(text).then(
					() => this.showStatus("Copied to clipboard"),
					(error: unknown) =>
						this.showWarning(`Copy failed: ${error instanceof Error ? error.message : String(error)}`),
				);
				return;
			case "edit-turn":
			case "retry-turn":
			case "rewind-turn":
			case "fork-turn":
				void this.#selectorController.runTurnAction(
					act.slice(0, -"-turn".length) as TurnAct,
					{ role: "user", at: timestamp },
					this.#pendingSubmittedInput,
				);
		}
	}

	/** A click on a subagent's rows in the HUD: view its transcript. */
	#focusSubagentFromHud(id: string): void {
		if (id === this.focusedAgentId) {
			// Reaffirming the current view is still the user's latest click.
			this.invalidatePendingFocus();
			return;
		}
		this.focusAgentSession(id).catch((error: unknown) =>
			this.showStatus(error instanceof Error ? error.message : String(error)),
		);
	}

	/** Flip the pinned jump list between its collapsed few and the full list, overriding the setting. */
	#togglePinnedHudExpanded(): void {
		const expanded = this.#pinnedHudOverride ?? cfgDisplayPinnedAgents.get(settings) === "full";
		this.#pinnedHudOverride = !expanded;
		this.#renderSubagentList();
	}

	#handleJudgmentBatchProgress(progress: JudgmentBatchProgress): void {
		const judgments = this.hud.progress.judgments;
		const pendingClear = this.#judgmentBatchProgressClearTimers.get(progress.id);
		if (pendingClear) {
			clearTimeout(pendingClear);
			this.#judgmentBatchProgressClearTimers.delete(progress.id);
		}
		judgments.update(progress);
		if (!progress.running) {
			const timer = setTimeout(() => {
				this.#judgmentBatchProgressClearTimers.delete(progress.id);
				judgments.delete(progress.id);
			}, JUDGMENT_BATCH_PROGRESS_RETAIN_MS);
			timer.unref?.();
			this.#judgmentBatchProgressClearTimers.set(progress.id, timer);
		}
	}

	#clearJudgmentBatchProgress(): void {
		for (const timer of this.#judgmentBatchProgressClearTimers.values()) clearTimeout(timer);
		this.#judgmentBatchProgressClearTimers.clear();
		this.hud.progress.judgments.clear();
	}

	#handleMcpConnectionStatusEvent(event: McpConnectionStatusEvent): void {
		if (cfgStartupQuiet.get(this.settings)) return;
		if (event.type === "connecting") {
			this.#mcpStatusOrder = [];
			this.#mcpPendingServers.clear();
			this.#mcpConnectedServers.clear();
			this.#mcpFailedServers.clear();
			for (const serverName of event.serverNames) {
				this.#trackMcpStatusServer(serverName);
				this.#mcpPendingServers.add(serverName);
			}
		} else if (event.type === "reconnecting") {
			this.#trackMcpStatusServer(event.serverName);
			this.#mcpConnectedServers.delete(event.serverName);
			this.#mcpFailedServers.delete(event.serverName);
			this.#mcpPendingServers.add(event.serverName);
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
		// Progress of every server connecting or failing: a toast per change
		// is noise on a native terminal (Tern), so it stays in the ANSI transcript.
		// Keyed so the line updates in place across notices shown meanwhile.
		if (message) this.showStatus(message, { toast: false, key: "mcp-status" });
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
		this.#frame.playWelcomeIntro();
	}

	async init(options: InteractiveModeInitOptions = {}): Promise<void> {
		if (this.isInitialized) return;
		// The card waits for its intro; without one it is final now (a resumed transcript retires under it).
		if (options.suppressWelcomeIntro) this.#frame.welcome.skipIntro();
		this.#idleMaintenanceActivity.scheduledTurn = target =>
			target === this.session &&
			(this.#goalContinuationTimer !== undefined ||
				this.#pendingGoalContinuationTurns > 0 ||
				this.#loopAutoSubmitTimer !== undefined ||
				this.#pendingLoopIterations > 0);
		this.#idleMaintenanceActivity.presentRecap = recap => this.#eventController.presentIdleRecap(recap);
		this.syncIdleMaintenanceView();

		// Fresh dialog lifetime: a previous stop (if this mode is ever
		// re-initialized) left the old controller aborted, and approvals queued
		// behind the approval mutex must prompt on a live signal, not a dead one.
		this.#dialogLifetime.abort();
		this.#dialogLifetime = new AbortController();

		this.keybindings = logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());
		// Before first paint, so hints the user already learned never flash on.
		await logger.time("InteractiveMode.init:hintUsage", () => hintUsage.load());

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
			beginDispose: () => {
				this.#closeAttempt?.abort();
				this.session.beginDispose();
				this.statusLine.dispose();
			},
			saveDraft: text => this.sessionManager.saveDraft(text),
			disposeSession: async reason => {
				await this.#btwController.dispose();
				await this.session.dispose({
					mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS,
					reason,
				});
			},
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
		setAutoQaConsentHandler(() => this.session.waitForUser(() => this.#promptAutoQaConsent()), Settings.instance);
		// Same wiring for cfg:// writes: every settings change the agent makes is
		// confirmed here, and `/save` persists to disk. Subagents and headless
		// sessions are refused by the handler before reaching this host. Changes
		// to this session's settings get the settings panel's in-process side
		// effects (a `defaultThinkingLevel` change also switches the live session).
		setCfgApprovalHost({
			// With `ask.timeout` set the prompt settles on its own and the turn goes on, so it stays agent time,
			// like a timed `ask`.
			approve: (request, options) =>
				askTimeoutMs(this.session.settings) === undefined
					? this.session.waitForUser(() => this.#promptCfgChange(request, options?.signal))
					: this.#promptCfgChange(request, options?.signal),
			applied: change => {
				if (change.settings !== this.session.settings) return;
				this.#selectorController.handleSettingChange(change.path, change.value);
			},
			persistentSettings: Settings.instance,
		});

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
			this.session.slashCommands,
		);

		if (cfgStartupQuiet.get(settings)) this.#frame.hideWelcome();
		else this.#frame.showWelcome();
		this.#frame.welcome.version.set(this.#version);
		this.#syncHeaderExtras();
		this.syncComposerShape();
		// An ask waiting above the composer holds the keys: the composer dims.
		this.#effect(() => this.composer.setFaint(this.#extensionUiController.askHoldsKeys()));

		this.#inputController.setupKeyHandlers();
		this.#frame.releaseStartupKeys();
		this.#inputController.setupEditorSubmitHandler();
		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus, this.#subagentEventBus ?? this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningSubagentBadge();
		this.#observerRegistry.onChange(() => {
			this.#scheduleObserverUiSync();
		});
		// `/pause` stops the live-preview tick (the fullscreen pause screen covers
		// the HUD); resuming repaints so elapsed markers catch up immediately.
		this.#eventBusUnsubscribers.push(
			agentPauseGate.onChange(() => {
				if (!cfgDisplaySubagentLivePreview.get(settings)) return;
				this.#renderSubagentList();
			}),
		);

		// Load initial todos
		await logger.time("InteractiveMode.init:todos", () => this.#loadTodoList());

		// A prepaint frame may already own the terminal.
		if (!this.#ownsStartedUi) {
			await this.#startShell(options.clearInitialTerminalHistory === true);
			this.#ownsStartedUi = true;
			// The keys were wired before the terminal started: it takes enhanced paste now.
			this.#inputController.enableEnhancedPaste();
		}
		this.#bindShellHost();
		pushTerminalTitle();
		// Claim the terminal title before any session update: this is the one path
		// that releases the teardown latch, so a late async `setSessionTerminalTitle`
		// after shutdown can never write into the parent shell's tab.
		initTerminalTitleState();
		setTerminalTitleStateEnabled(cfgTuiTitleState.get(this.settings));
		setTerminalTitleSpinnerStyle(cfgTuiTitleSpinner.get(this.settings));
		setTerminalTitleSpinnerInterval(cfgMotionResolved.get(this.settings).titleSpinnerInterval);
		initProgramStatus({ startupRun: options.startupRun });
		setProgramStatusEnabled(cfgTerminalProgramStatus.get(this.settings));
		this.#probeProgramStatus();
		setTerminalSessionSource({
			file: () => this.sessionManager.getSessionFile(),
			cwd: () => this.sessionManager.getCwd(),
		});
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		// Seeds the border and the status-line `vim` segment.
		this.#applyVimModeSetting();
		this.#syncVimStatus();
		void this.#syncSessionPinned();
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
			this.sessionManager.onPersistenceNotice(notice => this.showWarning(formatPersistenceNotice(notice))),
			this.sessionManager.onSessionNameChanged(() => {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
				this.#handleSessionAccentInputsChanged();
			}),
			// Fork and branch adopt a new session file without retitling.
			this.session.registerSessionChangeCallback(() => {
				reportTernSession();
				void this.#syncSessionPinned();
			}),
		);
		this.#syncEditorMaxHeight();
		this.isInitialized = true;

		const streamCwd = this.sessionManager.getCwd();
		this.#streamPublisher =
			(await StreamPublisher.connectLazy({
				cwd: streamCwd,
				sessionId: this.sessionManager.getSessionId(),
				title: path.basename(streamCwd),
				frames: this.#frameSource(),
				loadRedactor: () => StreamRedactor.load(streamCwd, cfgStreamRedactPatterns.get(this.settings)),
				onStatus: status => this.statusLine.setModes({ stream: status ?? undefined }),
				onChat: message => {
					const chat = truncateToWidth(
						replaceTabs(sanitizeText(`${message.name}: ${message.text}`)).replace(/[\r\n]+/g, " "),
						TRUNCATE_LENGTHS.LINE,
					);
					this.showStatus(chat);
				},
			})) ?? undefined;
		if (this.#streamPublisher) {
			// Live stream redaction follows `stream.redactPatterns` edits; only the
			// newest edit's load applies, however the async loads interleave.
			let redactorLoads = 0;
			this.#eventBusUnsubscribers.push(
				cfgStreamRedactPatterns.listen(this.settings, async patterns => {
					const load = ++redactorLoads;
					const redactor = await StreamRedactor.load(streamCwd, patterns);
					if (load === redactorLoads) this.#streamPublisher?.setRedactor(redactor);
				}),
			);
		}

		// Prewarm the local tiny-title worker off the submit hot path: spawn it
		// now, idle and unref'd, so the first submit reuses a live subprocess
		// instead of paying spawn latency ahead of the first frame (issue #6462).
		// No-ops for the online default and for already-named sessions that will
		// not be titled. Deferred via setImmediate so it runs AFTER the render
		// callback requestRender(true) queued above (immediates are FIFO) — the
		// spawn syscall never lands in the same loop turn ahead of the first paint.
		setImmediate(() => {
			// Resumed sessions paint their restored transcript (code blocks, diffs)
			// right after init; warm the native syntax set (~60ms, ~24 MiB) off-thread
			// so that paint does not build it on the JS thread. Fresh sessions skip it
			// and pay the cost lazily on the first highlight, if any.
			// Open the model API connection while the user reads the first frame.
			this.session.prewarmModelConnection();
			if (!$env.PI_NO_TITLE && !this.sessionManager.getSessionName()) {
				this.#inputController.prewarmTinyTitleModel();
			}
		});

		// Host the session before extension hooks run: a dialog raised from a
		// `session_start` hook is then retained for the first writer that joins.
		// The relay connection proceeds in the background and never blocks init.
		// The owning caller keeps guest mutations gated through its full outer
		// startup; early dialog answers do not require that readiness signal.
		if (options.autoStartCollab === true) this.collabController.autoStart();

		// Initialize hooks with TUI-based UI context
		await logger.time("InteractiveMode.init:hooks", () => this.initHooksAndCustomTools());
		// A live `disabledExtensions` edit suspends or resumes extensions: drop (or restore) their link
		// schemes and renderers from the transcript.
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner) {
			this.#eventBusUnsubscribers.push(
				extensionRunner.onSuspensionChange(() => {
					this.#applyExtensionLinks();
					this.#redrawExtensionLinks();
					this.#syncTranscriptPresenters();
				}),
			);
		}
		this.#eventBusUnsubscribers.push(
			// Process-wide: another session's runner (a subagent's) registering a presenter leaves the
			// main set unchanged, and the transcript is not asked again.
			onTranscriptPresentersChanged(() => this.#syncTranscriptPresenters()),
		);
		this.#applyTranscriptPresenters();

		// Restore mode from session (e.g. plan mode on resume)
		this.session.setSessionBeforeSwitchReconciler?.(async () => {
			await this.#liveCommandController.stop();
			await this.#quiesceVibeForSessionSwitch();
		});
		this.session.setSessionSwitchReconciler?.(() => this.#reconcileModeFromSession({ preserveActiveGoal: true }));
		await logger.time("InteractiveMode.init:reconcileMode", () => this.#reconcileModeFromSession());
		this.#modesRestored = true;

		// Brand-new sessions optionally start in plan mode when the user has made it
		// the startup default. "Brand-new" means the resolved branch carries no
		// conversation context (buildSessionContext().messages — covers messages,
		// custom messages, branch summaries, and compaction summaries) and the user
		// set no explicit `mode_change` (which #reconcileModeFromSession just
		// restored). SDK startup metadata and extension `custom` state entries are
		// ignored. This way `omp --continue` (or auto-resume) that finds no recent
		// session and creates a fresh one still honors the default, while a session
		// with restored context or an explicit mode keeps its reconciled mode. Not
		// part of the switch reconciler above: the plan-approval → execution handoff
		// and loop resets also start sessions through handleClearCommand and must
		// never be dragged back into plan mode; user-initiated /new re-applies the
		// default through handleNewCommand instead.
		await this.#applyPlanModeDefault();

		// Restore unsent editor draft from previous session shutdown (Ctrl+D).
		// One-shot: consumeDraft removes the sidecar after read so the next
		// resume does not re-restore the same text. Text typed while startup
		// ran stays after it, where the caret lands.
		try {
			const draft = await logger.time("InteractiveMode.init:draft", () => this.sessionManager.consumeDraft());
			if (draft) {
				this.composer.setText(draft + this.composer.text());
				this.updateEditorBorderColor();
			}
		} catch (err) {
			logger.warn("Failed to restore session draft", { error: String(err) });
		}

		// Subscribe to agent events
		this.#subscribeToAgent();

		// Job widgets refresh in the background; repaint the HUD and status line glance when one changes.
		this.#syncJobWidgetsListener();
		this.#eventBusUnsubscribers.push(() => {
			this.#jobWidgetsListener?.unsubscribe();
			this.#jobWidgetsListener = undefined;
			this.#jobSettleListener?.unsubscribe();
			this.#jobSettleListener = undefined;
		});

		this.#eventBusUnsubscribers.push(
			this.session.subscribe(event => {
				this.#followTrayMain(event);
				if (event.type === "model_changed") {
					this.session.prewarmModelConnection();
				}
				if (event.type === "config_warnings_changed") {
					this.#syncHeaderExtras();
				}
				// A terminal provider failure is not a loop yield: resubmitting the
				// captured prompt would append another user turn (and every @file
				// attachment) without making progress. Pauses still belong to the
				// run and must not park the loop.
				if (event.type === "agent_end") {
					const last = event.messages.findLast(message => message.role === "assistant");
					if (last?.stopReason === "error" && this.loopModeEnabled && this.loopPrompt) {
						this.pauseLoop();
					} else if (this.onInputCallback) {
						this.#scheduleLoopAutoSubmit();
					}
				}
				void this.#handleGoalSessionEvent(event);
			}),
			cfgLiveUiSettings.listen(this.settings, (next, previous) => this.#applyUiSettingChanges(next, previous)),
		);
		// Config warnings can change before this point and the event is not replayed:
		// rebuild the header from the live array once here.
		this.#syncHeaderExtras();
		this.#eventBusUnsubscribers.push(
			cfgModelRoles.listen(this.settings, () => this.#reapplyPlanModeModelOnRoleChange()),
		);
		// An eval-prelude toggle rebuilds the base system prompt in the session's own listener, with no
		// event when it lands: repaint the context figure behind that rebuild.
		const repaintAfterPromptRebuild = (): void =>
			queueMicrotask(() => {
				void this.session.runToolRegistryMutation(async () => {}).then(() => this.statusLine.refresh());
			});
		this.#eventBusUnsubscribers.push(
			cfgComputerEnabled.listen(this.settings, repaintAfterPromptRebuild),
			cfgRatchetEnabled.listen(this.settings, repaintAfterPromptRebuild),
			cfgArchiveEnabled.listen(this.settings, repaintAfterPromptRebuild),
			cfgCommitEnabled.listen(this.settings, repaintAfterPromptRebuild),
		);
		this.#eventBusUnsubscribers.push(
			this.session.subscribeCommandMetadataChanged(() => {
				// Skills/commands rediscovery (live `skills.*`/`commands.*`/extension edits,
				// `/move`, manage_skill, MCP prompts) lands here; rebuild the picker from session state.
				this.#pendingSlashCommands = this.#buildPendingSlashCommands();
				this.#rebuildSlashCommandAutocomplete(this.sessionManager.getCwd());
			}),
		);
		// Set up theme file watcher
		this.#eventBusUnsubscribers.push(
			onThemeChange(change => {
				this.#refreshSlashCommandIcons();
				this.statusLine.refresh();
				this.updateEditorBorderColor();
				// Previews and multiplexer panes keep the emitted history; a committed
				// theme swap rebuilds it so a reader scrolled up sees the same palette.
				const replay = !change.ephemeral && !insideMultiplexer(Bun.env);
				// The header's warnings and changelog carry the theme's colors as text: rebuild them
				// (in history only with the replay: removing a retired block replays it).
				if (replay || !this.#headerBlocks.some(block => this.shell.transcript.retired(block)))
					this.#syncHeaderExtras();
				if (!replay) return;
				this.shell.host?.replayHistory();
			}),
		);
		// The preset may have switched before this listener existed.
		this.#refreshSlashCommandIcons();

		// Everything is wired: subscriptions observe agent events, the session
		// mode is reconciled, and the submit handler is installed. Lift the
		// composer's bootstrap submit gate (`disableSubmit = true` since
		// construction, so an Enter typed before the pipeline existed could not
		// clear the draft into nowhere, and a turn started mid-init could not run
		// unobserved). From here Enter dispatches safely in every state — the
		// initial CLI prompt and a user submission both flow with
		// `streamingBehavior: "steer"`, so whichever lands second queues into the
		// other's turn instead of dying.
		this.composer.setDisableSubmit(false);
		this.#idleMaintenanceActivity.ready = true;
		if (!options.suppressWelcomeIntro) this.playWelcomeIntro();
		this.syncIdleMaintenanceView();
		// The first alt+p then opens as fast as a reopen.
		this.#selectorController
			.warmModelPicker(this.#dialogLifetime.signal)
			.catch(error => logger.warn("Model picker prewarm failed", { error: String(error) }));
	}

	/**
	 * Slash-command icons are resolved from the symbol preset when the picker is
	 * built. A preset switch (settings, Glyph Protocol upgrade, native rendering,
	 * which can land before the theme listener exists) rebuilds the picker.
	 */
	#refreshSlashCommandIcons(): void {
		if (currentTheme().symbols.preset === this.#slashIconPreset) return;
		this.#rebuildSlashCommandAutocomplete(this.sessionManager.getCwd());
	}

	/** Builtin, extension, custom, and `/skill:<name>` commands derived from live session state. */
	#buildPendingSlashCommands(): SlashCommand[] {
		this.#slashIconPreset = currentTheme().symbols.preset;
		const builtinCommands: SlashCommand[] = buildTuiBuiltinSlashCommands({
			ctx: this,
		}).map(cmd => ({
			...cmd,
			icon: slashCommandIcon(cmd.icon ?? "action"),
			iconName: cmd.icon ?? "action",
		}));

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			icon: slashCommandIcon("extension"),
			iconName: "extension",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => {
			const complete = loaded.command.getArgumentCompletions?.bind(loaded.command);
			return {
				name: loaded.command.name,
				description: `${loaded.command.description} (${loaded.source})`,
				icon: slashCommandIcon(loaded.path.startsWith("mcp:") ? "mcp" : "prompt"),
				iconName: loaded.path.startsWith("mcp:") ? "mcp" : "prompt",
				getArgumentCompletions: complete && (prefix => complete(prefix, this.sessionManager.getCwd())),
			};
		});

		const skillCommandList: SlashCommand[] = [];
		this.skillCommands.clear();
		if (this.session.skillsSettings?.enableSkillCommands !== false) {
			const icon = slashCommandIcon("skill");
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill);
				skillCommandList.push({
					name: commandName,
					description: skill.description,
					icon,
					iconName: "skill",
				});
			}
		}

		return [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommandList];
	}

	/** Reload session skills and the `/skill:<name>` command list. */
	async refreshSkillState(): Promise<void> {
		// The session's command-metadata notification rebuilds the picker.
		await this.session.refreshSkills();
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
		this.session.setSlashCommands(fileCommands);
		this.#rebuildSlashCommandAutocomplete(basePath);
	}

	/**
	 * Rebuild the editor's slash-command autocomplete from the pending command list and
	 * the session's current file-based slash commands and prompt templates.
	 */
	#rebuildSlashCommandAutocomplete(basePath: string): void {
		if (currentTheme().symbols.preset !== this.#slashIconPreset)
			this.#pendingSlashCommands = this.#buildPendingSlashCommands();
		const fileCommands = this.session.slashCommands;
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const promptIcon = slashCommandIcon("prompt");
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => {
			const argumentHint = cmd.argumentHint ? replaceTabs(cmd.argumentHint).replace(/[\r\n]+/g, " ") : undefined;
			return {
				name: cmd.name,
				description: cmd.description,
				icon: promptIcon,
				iconName: "prompt",
				argumentHint,
				getInlineHint: argumentHint ? buildStaticInlineHint(argumentHint) : undefined,
			};
		});
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
				iconName: "prompt",
			}));
		this.#baseAutocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...promptTemplateCommands],
			basePath,
		);
		this.#applyAutocompleteProvider();
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
		this.composer.setAutocomplete(provider);
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
		const scopedSettings = isSettingsInitialized() ? settings : undefined;
		try {
			await rescopeSessionToCwd(this.session, scopedSettings, newCwd);
		} catch (error) {
			// Undo the whole transition: the process cwd, Settings scope, and
			// cwd-derived state (memory, plugin roots, agents, extensions, custom
			// tools, MCP servers, skills, slash commands) must all return to the
			// source project so a `false` result reliably means nothing was committed.
			this.sessionManager.setCwdWithoutRelocation(previousCwd);
			try {
				setProjectDir(previousCwd);
				await rescopeSessionToCwd(this.session, scopedSettings, previousCwd);
			} catch (restoreError) {
				const actual = this.sessionManager.getCwd();
				try {
					setProjectDir(actual);
					await rescopeSessionToCwd(this.session, scopedSettings, actual);
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
		this.#scheduleLoopAutoSubmit();
		this.#scheduleGoalContinuation();

		return await promise;
	}

	#scheduleLoopAutoSubmit(): void {
		this.#cancelLoopAutoSubmit();
		if (!this.loopModeEnabled || !this.loopPrompt || this.#isShuttingDown) return;
		const prompt = this.loopPrompt;
		const loopAction = cfgLoopMode.get(settings);
		this.#deferLoopAutoSubmit(() => {
			void this.#runLoopIteration(loopAction, prompt);
		});
	}

	#deferLoopAutoSubmit(callback: () => void): void {
		// Brief delay so the user has a chance to press Esc between iterations.
		this.#loopAutoSubmitTimer = setTimeout(() => {
			this.#loopAutoSubmitTimer = undefined;
			try {
				if (!this.loopModeEnabled || !this.onInputCallback) return;
				callback();
			} finally {
				this.syncIdleMaintenanceView();
			}
		}, 800);
	}

	#cancelLoopAutoSubmit(): void {
		if (this.#loopAutoSubmitTimer) {
			clearTimeout(this.#loopAutoSubmitTimer);
			this.#loopAutoSubmitTimer = undefined;
			this.syncIdleMaintenanceView();
		}
	}

	#scheduleGoalContinuation(): void {
		this.#cancelGoalContinuation();
		if (this.loopModeEnabled) return;
		if (!this.onInputCallback) return;
		if (!cfgGoalContinuationModes.get(this.session.settings).includes("interactive")) return;
		if (this.planModeEnabled || this.planModePaused) return;
		if (!this.goalModeEnabled || this.goalModePaused) return;
		if (this.#goalSuppressNextContinuation) return;
		if (this.#pendingSubmittedInput) return;
		if (this.composer.text().trim().length > 0) return;
		if (this.composer.pendingImages.length > 0) return;
		const state = this.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			try {
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
				if (this.composer.text().trim().length > 0) return;
				if (this.composer.pendingImages.length > 0) return;
				const latestState = this.session.getGoalModeState();
				if (!latestState?.enabled || latestState.goal.status !== "active") return;
				this.#pendingGoalContinuationTurns++;
				this.onInputCallback(
					this.startPendingSubmission({
						text: prompt,
						customType: "goal-continuation",
						display: false,
					}),
				);
			} finally {
				this.syncIdleMaintenanceView();
			}
		}, 800);
	}

	#cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
			this.syncIdleMaintenanceView();
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

	/**
	 * Whether loop iterations and goal continuations must hold off. An open run
	 * counts even while paused on background subagents/jobs: its terminal
	 * `agent_end` re-arms both.
	 */
	#isAutoSubmitBlocked(): boolean {
		return (
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.session.hasPostPromptWork ||
			this.session.isRunActive
		);
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

	/** One loop iteration; while it runs, idle maintenance treats the loop's next turn as scheduled. */
	async #runLoopIteration(action: "prompt" | "compact" | "reset", prompt: string): Promise<void> {
		this.#pendingLoopIterations++;
		try {
			await this.#loopIteration(action, prompt);
		} finally {
			this.#pendingLoopIterations--;
			this.syncIdleMaintenanceView();
		}
	}

	async #loopIteration(action: "prompt" | "compact" | "reset", prompt: string): Promise<void> {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		if (action === "reset" && (this.vibeModeEnabled || this.#vibeModeEntry !== undefined)) {
			this.disableLoopMode("Exit vibe mode before using reset loops. Loop mode disabled.");
			return;
		}

		// An exhausted budget ends the loop regardless of the condition, so check
		// it first: the user's command must not run one last time for nothing.
		if (isLoopLimitExhausted(this.loopLimit)) {
			this.disableLoopMode("Loop limit reached. Loop mode disabled.");
			return;
		}

		// The gate sits before the budget consume so a halt never burns an
		// iteration that did not run, and after the blocked-check/defer above so
		// a streaming turn cannot re-run the command on every retry tick.
		if (this.loopCondition && !(await this.#passesLoopCondition(prompt))) return;

		// The gate awaited a child process: a turn may have started meanwhile
		// (async job, idle flush), so re-check before spending budget or
		// compacting/resetting into the now-busy session.
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		// /vibe can be enabled while the gate was awaiting: the pre-gate guard
		// above is stale, and handleClearCommand would only warn and then let
		// the iteration submit without resetting. Check the entering transition
		// too: vibeModeEnabled is still false while activateVibeTools is in
		// flight, but the reset must not run concurrently with the toolset switch.
		if (action === "reset" && (this.vibeModeEnabled || this.#vibeModeEntry !== undefined)) {
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

	/**
	 * Evaluate the `--while` / `--until` condition for one iteration.
	 *
	 * Returns false when the loop must not continue: either the condition said
	 * to stop (already reported through {@link disableLoopMode}) or the loop was
	 * paused/disabled while the command was still running.
	 */
	async #passesLoopCondition(prompt: string): Promise<boolean> {
		const condition = this.loopCondition;
		if (!condition) return true;

		const controller = new AbortController();
		// A prior evaluation can still be in flight when the next iteration
		// starts (the user submitted mid-command); drop it instead of leaking a
		// child process that Esc can no longer reach.
		this.#abortLoopCondition();
		this.#loopConditionAbort = controller;
		const sessionId = this.sessionManager.getSessionId();
		let verdict: LoopConditionVerdict;
		try {
			verdict = await evaluateLoopCondition(condition, {
				cwd: this.sessionManager.getCwd(),
				timeoutMs: cfgLoopConditionTimeoutMs.get(settings),
				signal: controller.signal,
				sessionId,
				sessionFile: this.sessionManager.getSessionFile(),
				isSessionCurrent: () => this.sessionManager.getSessionId() === sessionId,
			});
		} finally {
			if (this.#loopConditionAbort === controller) this.#loopConditionAbort = undefined;
		}

		// Running the condition is an await point: Esc (pauseLoop) or a second
		// /loop (disableLoopMode) can land mid-command, so re-check the same
		// guards the method entry used before acting on a now-stale verdict.
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return false;
		if (verdict.kind === "continue") return true;
		if (verdict.kind === "aborted") return false;
		this.disableLoopMode(verdict.message);
		return false;
	}

	#abortLoopCondition(): void {
		this.#loopConditionAbort?.abort();
		this.#loopConditionAbort = undefined;
	}

	#syncLoopModeStatus(): void {
		const state: "waiting" | "running" | "paused" = this.loopModePaused
			? "paused"
			: this.loopPrompt
				? "running"
				: "waiting";
		this.statusLine.setModes({
			loop: this.loopModeEnabled
				? {
						state,
						...(this.loopLimit ? { limit: this.loopLimit } : {}),
						...(this.loopCondition ? { condition: this.loopCondition } : {}),
					}
				: undefined,
		});
		this.#notifyModeChanged();
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.loopModeEnabled;
		this.loopModeEnabled = false;
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = undefined;
		this.loopCondition = undefined;
		this.#cancelLoopAutoSubmit();
		this.#abortLoopCondition();
		this.#syncLoopModeStatus();
		if (wasEnabled) {
			this.showStatus(message);
		}
	}

	setLoopPrompt(prompt: string): void {
		if (!this.loopModeEnabled) return;
		// Any manual submit supersedes whatever gate is currently pending, even
		// one resubmitting identical text: the gate was checking the *previous*
		// iteration, and that iteration's turn is about to be superseded either
		// way. Abort immediately instead of letting it run for up to the
		// configured timeout in parallel with the turn it can no longer gate.
		this.#abortLoopCondition();
		this.loopPrompt = prompt;
		this.loopModePaused = false;
		this.#syncLoopModeStatus();
	}

	/**
	 * Schedule the next auto-resubmit for a submission that never reached
	 * {@link getUserInput}. A `/skill:` command dispatches inline from the
	 * submit handler, leaving `onInputCallback` unresolved, so the run loop
	 * never re-enters `getUserInput` to arm the following iteration.
	 */
	armLoopAutoSubmit(): void {
		this.#scheduleLoopAutoSubmit();
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
		this.#abortLoopCondition();
		this.#syncLoopModeStatus();
	}

	async handleLoopCommand(args = ""): Promise<string | undefined> {
		if (this.loopModeEnabled) {
			this.disableLoopMode();
			return undefined;
		}
		const parsed = parseLoopArgs(args);
		if (typeof parsed === "string") {
			this.showError(parsed);
			return undefined;
		}
		this.#enableLoopMode(parsed.limit, parsed.condition, Boolean(parsed.prompt));
		// Hand any inline prompt back to the dispatcher so the normal submit flow
		// runs the first iteration — it records the text as the loop prompt and
		// auto-resubmits it after each yield, identical to typing the prompt right
		// after enabling loop mode.
		return parsed.prompt;
	}

	#enableLoopMode(
		limit: LoopLimitConfig | undefined,
		condition: LoopConditionConfig | undefined,
		hasPrompt: boolean,
	): void {
		this.loopModeEnabled = true;
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = createLoopLimitRuntime(limit);
		this.loopCondition = condition;
		this.#syncLoopModeStatus();
		const limitSuffix = limit ? ` Limited to ${describeLoopLimit(limit)}.` : "";
		const remainingSuffix = this.loopLimit ? ` ${describeLoopLimitRuntime(this.loopLimit)}.` : "";
		// The condition is a *continuation* signal: the first iteration always
		// runs, and it is re-evaluated before each subsequent one.
		const conditionSuffix = condition ? ` Continuing ${describeLoopCondition(condition)}.` : "";
		const tail = hasPrompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		this.showStatus(
			`Loop mode enabled.${limitSuffix}${remainingSuffix}${conditionSuffix} ${tail} ${actionKey("app.interrupt", this.keybindings)} suspends the ongoing loop; /loop again to disable.`,
		);
	}

	#getSessionModeState(): SessionModeState {
		const goalState = this.session.getGoalModeState();
		// A completed goal keeps its tool until the turn ends; it stays active until #exitGoalMode tears it down.
		const goalActive = this.goalModeEnabled || goalState?.mode === "exiting";
		return {
			plan: this.planModeEnabled
				? { status: "active", planFilePath: this.session.getPlanModeState()?.planFilePath }
				: { status: this.planModePaused ? "paused" : "inactive" },
			vibe: { status: this.vibeModeEnabled ? "active" : "inactive" },
			goal:
				goalActive || this.goalModePaused
					? {
							status: goalActive ? "active" : "paused",
							objective: goalState?.goal.objective,
							tokenBudget: goalState?.goal.tokenBudget,
						}
					: { status: "inactive" },
			loop: { status: !this.loopModeEnabled ? "inactive" : this.loopModePaused ? "paused" : "active" },
		};
	}

	/**
	 * Report a committed mode change. Every mode status refresh calls this, so slash commands, the
	 * goal tool, and session restore report alongside `ctx.sessionModes.set()`. Goal accounting is
	 * not part of the state, so usage ticks never fire it. During a session switch the report waits
	 * until the switch settles, so handlers see the destination's restored modes, never the cleared
	 * intermediate state, and may call `set()` from the handler.
	 */
	#notifyModeChanged(): void {
		if (this.#modeChangeHolds > 0) return;
		if (this.session.isSessionTransitioning) {
			if (this.#modeChangeAwaitsSessionTransition) return;
			this.#modeChangeAwaitsSessionTransition = true;
			void this.session.waitForSessionTransition().then(() => {
				this.#modeChangeAwaitsSessionTransition = false;
				this.#notifyModeChanged();
			});
			return;
		}
		const state = this.#getSessionModeState();
		const key = JSON.stringify(state);
		if (key === this.#reportedModeKey) return;
		const previous = this.#reportedModeState;
		this.#reportedModeState = state;
		this.#reportedModeKey = key;
		void this.session.extensionRunner?.emit({ type: "mode_changed", previous, state: structuredClone(state) });
	}

	/**
	 * Defer `mode_changed` until a multi-step transition settles: goal entry/exit flips mode flags
	 * from `goal_updated` before the goal tool is activated or the prior tools are restored, and
	 * session restore clears every mode before re-entering the saved one.
	 */
	#holdModeChanges(): Disposable {
		this.#modeChangeHolds++;
		return {
			[Symbol.dispose]: () => {
				this.#modeChangeHolds--;
				this.#notifyModeChanged();
			},
		};
	}

	async #setSessionMode(request: SessionModeRequest): Promise<SessionModeResult> {
		const refuse = (code: Extract<SessionModeResult, { ok: false }>["code"], message: string): SessionModeResult => ({
			ok: false,
			code,
			message,
			state: this.#getSessionModeState(),
		});
		if (!cfgExtensionHandlersModeControl.get(this.session.settings)) {
			return refuse("disabled", "Extension mode control is disabled in settings (extensionHandlers.modeControl).");
		}
		// Refuse rather than queue: a call from a handler of this transition's own events would deadlock.
		if (this.#modeSetInFlight || this.#modeChangeHolds > 0) {
			return refuse("busy", "Another mode transition is running; retry after it settles.");
		}
		if (!this.#modesRestored || this.session.isSessionTransitioning) {
			return refuse("busy", "The session's saved modes are still being restored; retry after the switch settles.");
		}
		if (this.session.getGoalModeState()?.mode === "exiting") {
			return refuse("busy", "The completed goal is still being torn down; retry after its `mode_changed`.");
		}
		const transition = this.#planSessionModeTransition(request);
		if (transition === undefined) return { ok: true, changed: false, state: this.#getSessionModeState() };
		if (typeof transition !== "function") return refuse(transition.code, transition.message);
		if (this.session.isBusyForSnapshot) {
			return refuse("busy", "The session is busy with a turn or compaction; retry once it is idle.");
		}
		const before = JSON.stringify(this.#getSessionModeState());
		this.#modeSetInFlight = true;
		const hold = this.#holdModeChanges();
		try {
			await transition();
		} finally {
			this.#modeSetInFlight = false;
			hold[Symbol.dispose]();
		}
		const state = this.#getSessionModeState();
		return { ok: true, changed: JSON.stringify(state) !== before, state };
	}

	/**
	 * Resolve a request against the slash commands' gates: `undefined` when the requested state
	 * already holds, a refusal, or the transition to run. Runs the same enter/exit helpers as the
	 * slash commands, minus their confirmations and prompt submission.
	 */
	#planSessionModeTransition(
		request: SessionModeRequest,
	): { code: "conflict" | "disabled" | "invalid_request"; message: string } | (() => Promise<void>) | undefined {
		const invalid = (message: string) => ({ code: "invalid_request" as const, message });
		const conflict = (mode: string) => ({ code: "conflict" as const, message: `Exit ${mode} mode first.` });
		const planBlocks = this.planModeEnabled || this.planModePaused;
		const goalBlocks = this.goalModeEnabled || this.goalModePaused;
		switch (request?.mode) {
			case "plan":
				if (request.action === "exit") {
					if (this.planModeEnabled) {
						return async () => {
							this.#hidePlanReview();
							await this.#exitPlanMode();
							this.#planModeHasEntered = false;
						};
					}
					return this.planModePaused ? async () => this.#disablePausedPlanMode() : undefined;
				}
				if (request.action !== "enter") break;
				if (this.planModeEnabled) return undefined;
				if (!cfgPlanEnabled.get(this.session.settings)) {
					return { code: "disabled", message: "Plan mode is disabled in settings (plan.enabled)." };
				}
				if (goalBlocks) return conflict("goal");
				if (this.vibeModeEnabled) return conflict("vibe");
				return () => this.#enterPlanMode();
			case "vibe":
				if (request.action === "exit") return this.vibeModeEnabled ? () => this.#exitVibeMode() : undefined;
				if (request.action !== "enter") break;
				if (this.vibeModeEnabled) return undefined;
				if (planBlocks) return conflict("plan");
				if (goalBlocks) return conflict("goal");
				return () => this.#enterVibeMode();
			case "goal":
				switch (request.action) {
					case "enter": {
						const objective = typeof request.objective === "string" ? request.objective.trim() : "";
						if (!objective) return invalid("Goal objective must be a non-empty string.");
						const budget = request.tokenBudget;
						if (budget !== undefined && !(Number.isInteger(budget) && budget > 0)) {
							return invalid("Goal tokenBudget must be a positive integer.");
						}
						if (this.goalModeEnabled) {
							const current = this.session.getGoalModeState()?.goal;
							if (current?.objective === objective && current.tokenBudget === budget) return undefined;
							return invalid("A goal is already active; drop it before setting a new objective.");
						}
						if (this.goalModePaused) return invalid("Resume or drop the paused goal first.");
						if (!cfgGoalEnabled.get(this.session.settings)) {
							return { code: "disabled", message: "Goal mode is disabled in settings (goal.enabled)." };
						}
						if (planBlocks) return conflict("plan");
						if (this.vibeModeEnabled) return conflict("vibe");
						return () => this.#enterGoalMode({ objective, tokenBudget: budget });
					}
					case "pause":
						if (this.goalModeEnabled) return () => this.#pauseGoalAction();
						return this.goalModePaused ? undefined : invalid("There is no active goal to pause.");
					case "resume":
						if (this.goalModeEnabled) return undefined;
						if (!this.#getPausedGoalState()) return invalid("There is no paused goal to resume.");
						if (!cfgGoalEnabled.get(this.session.settings)) {
							return { code: "disabled", message: "Goal mode is disabled in settings (goal.enabled)." };
						}
						return () => this.#enterGoalMode({ resume: true });
					case "drop":
						if (!goalBlocks) return undefined;
						return async () => {
							await this.session.goalRuntime.dropGoal();
							await this.#exitGoalMode({ reason: "dropped" });
						};
				}
				break;
			case "loop": {
				if (request.action === "exit") return this.loopModeEnabled ? async () => this.disableLoopMode() : undefined;
				if (request.action !== "enter") break;
				const { limit, condition } = request;
				const prompt = typeof request.prompt === "string" ? request.prompt.trim() : request.prompt;
				if (prompt !== undefined && (typeof prompt !== "string" || !prompt)) {
					return invalid("Loop prompt must be a non-empty string.");
				}
				const validLimit =
					limit === undefined ||
					(limit?.kind === "iterations" && Number.isSafeInteger(limit.iterations) && limit.iterations > 0) ||
					(limit?.kind === "duration" && Number.isFinite(limit.durationMs) && limit.durationMs > 0);
				if (!validLimit)
					return invalid("Loop limit needs a positive integer `iterations` or positive `durationMs`.");
				if (
					condition !== undefined &&
					(typeof condition?.command !== "string" ||
						!condition.command.trim() ||
						typeof condition.until !== "boolean")
				) {
					return invalid("Loop condition needs a non-empty `command` and a boolean `until`.");
				}
				if (this.loopModeEnabled) {
					if (limit !== undefined || condition !== undefined) {
						return invalid("Loop mode is already active; exit it before changing its bounds.");
					}
					if (prompt !== undefined && (prompt !== this.loopPrompt || this.loopModePaused)) {
						return async () => this.setLoopPrompt(prompt);
					}
					if (!this.loopModePaused) return undefined;
					// A paused loop resumes waiting: the next prompt becomes its body again.
					return async () => {
						this.loopModePaused = false;
						this.#syncLoopModeStatus();
					};
				}
				return async () => {
					this.#enableLoopMode(limit, condition, prompt !== undefined);
					if (prompt !== undefined) this.setLoopPrompt(prompt);
				};
			}
		}
		return invalid("Unknown mode or action.");
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
	clearOptimisticUserMessage(): void {
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		this.#optimisticUserMessageBlocks = [];
	}

	replaceOptimisticUserMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void {
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		for (const block of this.#optimisticUserMessageBlocks) this.shell.transcript.remove(block);
		this.#optimisticUserMessageBlocks = [];
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
		// Held live (unsettled) so it stays removable until reconcile, instead of
		// retiring into immutable scrollback mid-preflight (issue #11217).
		this.#optimisticSkillMessageBlocks = this.#uiHelpers.addMessageToChat(message, { ...options, live: true });
		this.ensureWorkingRow();
	}

	/**
	 * Reconcile the optimistic `/skill:` row against the canonical message emitted
	 * by the session (mirrors {@link replaceOptimisticUserMessage} for skills).
	 *
	 * The row is adopted in place — finalized, with the append skipped — only when
	 * it is still on screen but no longer removable: it retired into native
	 * scrollback before the canonical `message_start` arrived, so appending would
	 * trail it with a second identical card (issue #11217). Otherwise the canonical
	 * message is appended after clearing the tracked row, covering both a still-live
	 * row (clean replace) and a row a transcript rebuild already detached from the
	 * container (e.g. a display-setting toggle calling {@link rebuildChatFromMessages}),
	 * whose card would otherwise vanish.
	 */
	reconcileOptimisticSkillMessage(message: AgentMessage): void {
		this.optimisticSkillMessagePending = false;
		const blocks = this.#optimisticSkillMessageBlocks;
		this.#optimisticSkillMessageBlocks = [];
		const transcript = this.shell.transcript;
		const present = blocks.filter(block => transcript.blocks().includes(block));
		if (present.length > 0 && present.every(block => transcript.retired(block))) {
			for (const block of present) transcript.settle(block);
			// The adopted card now stands for the canonical message (rewind, presenters, link lookups).
			const card = present.at(-1)!;
			this.transcriptBlocks.set(message, card);
			this.#presenter.register(card, { kind: "message", message });
			return;
		}
		for (const block of blocks) transcript.remove(block);
		this.addMessageToChat(message);
	}

	/** Drop the optimistic `/skill:` row when dispatch fails or bails before the
	 *  message reaches the agent (aborted preflight, streaming-race requeue). */
	clearOptimisticSkillMessage(): void {
		this.optimisticSkillMessagePending = false;
		if (this.#optimisticSkillMessageBlocks.length === 0) return;
		for (const block of this.#optimisticSkillMessageBlocks) this.shell.transcript.remove(block);
		this.#optimisticSkillMessageBlocks = [];
	}

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
	): SubmittedUserInput {
		const submission = {
			submittedAt: Date.now(),
			text: input.text,
			images: input.images,
			imageLinks: input.imageLinks,
			customType: input.customType,
			display: input.display,
			streamingBehavior: input.streamingBehavior,
			followUps: input.followUps,
			cancelled: false,
			started: false,
		};
		if (submission.customType !== "goal-continuation") {
			this.#pendingGoalContinuationTurns = 0;
			this.syncIdleMaintenanceView();
		}
		this.#pendingSubmittedInput = submission;
		this.#pendingSubmissionPreservesDraft = options?.preserveDraft === true;
		// `submitInteractiveInput` dispatches known `/skill:` text as a custom
		// message, and EventController appends that canonical row on its own. An
		// ordinary optimistic user row would survive as a duplicate, so mirror the
		// dispatch condition here.
		if (!submission.customType && !isKnownSkillCommand(this, submission.text)) {
			this.#resetGoalContinuationSuppression();
			const imageCount = submission.images?.length ?? 0;
			this.optimisticUserMessageSignature = `${submission.text}\u0000${imageCount}`;
			this.#pendingSubmissionDispose = this.recordLocalSubmission(submission.text, imageCount);
			this.#replayOptimisticUserMessage();
		} else {
			this.clearOptimisticUserMessage();
		}
		if (!options?.preserveDraft && options?.clearEditor !== false) this.composer.setDraft("");
		this.ensureWorkingRow();
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
		this.#working.setMessage(undefined);
		if (submission.customType === "goal-continuation") this.#releaseGoalContinuationTurn();
		this.clearWorking("turn");
		if (!submission.customType && !preserveDraft) {
			// Enter clears the submitted draft before this cancellation can run.
			// Keep anything typed or attached since then, after the recovered input.
			const composer = this.composer;
			const laterText = composer.expandedText();
			const submittedImages = submission.images ?? [];
			const laterImages = [...composer.pendingImages];
			const laterLinks = [...composer.pendingImageLinks];
			const submittedText = submission.followUps
				? formatQueueShorthand([submission.text, ...submission.followUps])
				: submission.text;
			const recoveredText = laterText
				? `${submittedText}\n${shiftImageMarkers(laterText, submittedImages.length)}`
				: submittedText;
			this.rebuildChatFromMessages();
			composer.setDraft("", [...submittedImages, ...laterImages]);
			composer.pendingImageLinks.splice(
				0,
				composer.pendingImageLinks.length,
				...(submission.imageLinks ?? submittedImages.map(() => undefined)),
				...laterLinks,
			);
			composer.setCollapsedText(recoveredText);
		}
		this.updateEditorBorderColor();
		return true;
	}

	/**
	 * Hands back a prompt the session dropped before dispatch (an Esc abort,
	 * usage preflight denial or the cost cap raced turn setup). The message was
	 * never persisted, so the tree/branch selectors cannot offer it — remove the
	 * optimistic transcript row and put the typed text back in the editor for editing.
	 * A prompt with unsent follow-ups comes back as one `=>` list.
	 */
	restoreDroppedPrompt(prompt: DroppedPrompt): void {
		this.clearOptimisticUserMessage();
		this.#working.setMessage(undefined);
		this.clearWorking("turn");
		this.rebuildChatFromMessages();
		// A /btw inject keeps its own retry (its key re-arms and it reports the reason); handing it
		// to the editor as well would offer a second way to send it.
		if (this.#btwController.reclaimDroppedPrompt(prompt)) return;
		// The rebuild drops transient notices, including the one that refused this prompt.
		if (prompt.reason) this.showError(prompt.reason);
		// The drop arrives asynchronously (after the abort settles); never clobber
		// a draft the user has already started typing in the meantime.
		if (!this.composer.text().trim()) {
			this.composer.setDraft(
				prompt.followUps ? formatQueueShorthand([prompt.text, ...prompt.followUps]) : prompt.text,
				prompt.images ?? [],
			);
		}
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
		// A started continuation the session refused or dropped gets no `agent_end` to release its reservation.
		if (input.customType === "goal-continuation" && input.started && !input.dispatched) {
			this.#releaseGoalContinuationTurn();
		}
		const wasPendingSubmission = this.#pendingSubmittedInput === input;
		const pendingSubmissionDispose = this.#pendingSubmissionDispose;
		if (wasPendingSubmission) {
			this.#pendingSubmittedInput = undefined;
			this.#pendingSubmissionDispose = undefined;
			this.#pendingSubmissionPreservesDraft = false;
		}

		if (wasPendingSubmission && !this.session.isStreaming && !this.streaming) {
			this.optimisticUserMessageSignature = undefined;
			pendingSubmissionDispose?.();
			this.#optimisticUserMessageBlocks = [];
			this.#working.setMessage(undefined);
			this.clearWorking("turn");
		}
	}

	/** Drop one pending goal-continuation reservation, so idle maintenance stops waiting for its turn. */
	#releaseGoalContinuationTurn(): void {
		this.#pendingGoalContinuationTurns = Math.max(0, this.#pendingGoalContinuationTurns - 1);
		this.syncIdleMaintenanceView();
	}

	/** Cap the composer's field to the terminal's rows (its chrome takes two). */
	#syncEditorMaxHeight(): void {
		const lines = computeEditorMaxHeight(this.shell.size().rows);
		// The terminal composer's two border rows come out of the budget; Tern's editor has none.
		this.composer.setMaxLines(this.shell.native() ? lines : Math.max(1, lines - 2));
	}

	/**
	 * Charts under assistant tables per `tui.autoGraph`: `smart` picks charts through the session's judge,
	 * `auto` only while the judge role resolves to a native backend (checked per table, so a login or
	 * role change mid-session applies), else the local guess.
	 */
	#applyAutoGraphSetting(): void {
		const mode = cfgTuiAutoGraph.get(this.settings);
		if (mode === "off" || mode === "always") {
			setTableCharts(mode);
			return;
		}
		setTableCharts("smart", request =>
			mode === "auto" && !hasNativeJudge(this.settings, this.session.modelRegistry, this.session.model)
				? undefined
				: pickTableChart(request, this.session.tableChartJudge()),
		);
	}

	/** Transcript display settings the blocks read (`cfgTranscriptDisplay` and the Markdown look). */
	#syncTranscriptDisplaySettings(): void {
		const display = this.#display;
		display.showImages.set(cfgTerminalShowImages.get(this.settings));
		display.renderSvg.set(cfgTuiRenderSvg.get(this.settings));
		display.renderEmbeds.set(cfgTuiRenderEmbeds.get(this.settings));
		display.shellVisualization.set(cfgDisplayShellVisualization.get(this.settings));
		display.mcpMarkdown.set(cfgMcpRenderMarkdownResults.get(this.settings));
		display.readPreview.set(cfgReadToolResultPreview.get(this.settings));
		setMarkdownLook({
			colorful: cfgTuiColorfulMarkdown.get(this.settings),
			mermaid: cfgTuiRenderMermaid.get(this.settings),
		});
	}

	/**
	 * Apply live UI side effects for settings changed through any path (`/settings`,
	 * `cfg://`, `settings.set()`, on-disk reload). One coalesced {@link cfgLiveUiSettings}
	 * listener, so a bulk reload rebuilds the transcript at most once.
	 */
	#applyUiSettingChanges(next: LiveUiSettings, previous: LiveUiSettings): void {
		const any = (...ids: (keyof LiveUiSettings)[]) => ids.some(id => !Bun.deepEquals(next[id], previous[id]));
		let rebuildChat = false;
		let resetDisplay = false;

		if (any("showHardwareCursor"))
			this.composer.setCaret(cfgShowHardwareCursor.get(this.settings) ? "terminal" : "drawn");
		if (any("tui.imeSafeCursor")) this.#frame.setImeSafeCursor(cfgTuiImeSafeCursor.get(this.settings));
		if (any("autocompleteMaxVisible"))
			this.composer.setAutocompleteMaxVisible(cfgAutocompleteMaxVisible.get(this.settings));
		if (any("composer.shape")) this.syncComposerShape();
		if (any("spelling.autocomplete")) this.#wordCompletion.setMethod(cfgSpellingAutocomplete.get(this.settings));
		if (any("tui.vimMode", "tui.vimModeDisplay", "tui.vimShowCommand", "tui.vimStartMode")) {
			this.#applyVimModeSetting();
		}
		if (any("display.pinnedAgents")) this.applyPinnedAgentsSetting();
		if (any("display.subagentLivePreview")) this.#renderSubagentList();
		const composerPrediction = this.#eventController.composerPrediction;
		if (
			(any("composer.predictions") && !next["composer.predictions"]) ||
			// Alternatives already offered would keep their list until the next turn.
			(any("composer.predictionAlternatives") &&
				!next["composer.predictionAlternatives"] &&
				(composerPrediction.choices?.length ?? 0) > 1)
		) {
			composerPrediction.cancel();
		}
		if (any("compaction.enabled", "compaction.methodOrder")) {
			this.statusLine.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		}

		// Field comparisons skip effects the keybinding toggles already applied. The blocks read
		// these flags reactively; rows already in scrollback change only with a replay.
		const hideToolActivity = cfgDisplayHideToolActivity.get(this.settings);
		if (any("display.hideToolActivity") && hideToolActivity !== this.hideToolActivity) {
			this.hideToolActivity = hideToolActivity;
			if (!hideToolActivity) this.toolOutputExpanded = false;
			resetDisplay = true;
		}
		if (any("terminal.showImages", "display.shellVisualization")) this.#syncTranscriptDisplaySettings();
		if (any("tui.autoGraph")) {
			this.#applyAutoGraphSetting();
			rebuildChat = true;
		}
		if (any("terminal.showImages")) resetDisplay = true;
		const hideThinkingBlock = cfgHideThinkingBlock.get(this.settings);
		if (any("hideThinkingBlock") && hideThinkingBlock !== this.hideThinkingBlock) {
			this.hideThinkingBlock = hideThinkingBlock;
			resetDisplay = true;
		}
		const proseOnlyThinking = cfgProseOnlyThinking.get(this.settings);
		if (any("proseOnlyThinking") && proseOnlyThinking !== this.proseOnlyThinking) {
			this.proseOnlyThinking = proseOnlyThinking;
			rebuildChat = true;
		}
		const expandThinkingBlocks = cfgExpandThinkingBlocks.get(this.settings);
		if (any("expandThinkingBlocks") && expandThinkingBlocks !== this.expandThinkingBlocks) {
			this.expandThinkingBlocks = expandThinkingBlocks;
			resetDisplay = true;
		}

		// Usage-row detection, compacted-history collapse, and markdown render
		// options are baked in at build time: rebuild, then retire rows already
		// committed to native scrollback.
		if (
			any(
				"display.advisorCollapsedLines",
				"display.shellVisualization",
				"display.cacheMissMarker",
				"display.collapseCompacted",
				"display.showTokenUsage",
				"display.showTurnTime",
			)
		) {
			rebuildChat = true;
		}
		if (any("tui.colorfulMarkdown", "tui.renderMermaid", "tui.renderSvg", "tui.renderEmbeds")) {
			this.#syncTranscriptDisplaySettings();
			resetDisplay = true;
		}
		// Components take the extension text renderers when built; the rebuild keeps the streaming
		// reply's components, so hand them the new set directly.
		if (any("extensionRenderers.assistantText")) {
			// The browser replays with the renderers it opened with: close it rather than show them stale.
			this.closeLinkBrowser();
			this.#applyExtensionLinks();
			this.#presenter.refreshRenderers();
			this.#eventController.applyAssistantTextRenderers();
			rebuildChat = true;
		}
		if (any("extensionRenderers.transcriptPresenters")) this.#syncTranscriptPresenters();
		// Rows in scrollback were written with the old link and heading forms.
		if (any("tui.hyperlinks", "tui.textSizing")) {
			this.#syncFrameSettings();
			resetDisplay = true;
		}
		if (any("tui.titleState")) setTerminalTitleStateEnabled(cfgTuiTitleState.get(this.settings));
		if (any("tui.titleSpinner")) setTerminalTitleSpinnerStyle(cfgTuiTitleSpinner.get(this.settings));
		if (any("terminal.programStatus")) setProgramStatusEnabled(cfgTerminalProgramStatus.get(this.settings));
		if (any("motion")) setTerminalTitleSpinnerInterval(next.motion.titleSpinnerInterval);

		if (
			any(
				"statusLine.preset",
				"statusLine.leftSegments",
				"statusLine.rightSegments",
				"statusLine.separator",
				"statusLine.showHookStatus",
				"statusLine.sessionAccent",
				"statusLine.transparent",
				"statusLine.segmentOptions",
				"statusLine.compactThinkingLevel",
				"statusLine.contextLine",
				"git.enabled",
			)
		) {
			this.statusLine.reloadSettings();
		}
		if (any("statusLine.sessionAccent")) this.#handleSessionAccentInputsChanged();
		// Advisor runtime start/stop has no session event; repaint its status segment.
		if (any("advisor.enabled", "advisor.maxNotesPerUpdate", "tier.advisor")) this.statusLine.refresh();

		if (rebuildChat) this.rebuildChatFromMessages();
		else if (resetDisplay) this.shell.host?.replayHistory();
	}

	syncComposerShape(): void {
		this.#frame.setShape(cfgComposerShape.get(settings));
		this.updateEditorBorderColor();
	}

	/** The viewed session's extension link schemes, as last pushed to the Markdown painter. */
	#linkSchemes: readonly string[] = [];

	/**
	 * Push the viewed session's extension link schemes to the Markdown painter (only while links
	 * are routed here: a plain terminal with a way to pick them); returns whether that changed. A
	 * focused subagent's runner draws with what the main runner leaves active.
	 */
	#applyExtensionLinks(): boolean {
		const viewed = this.viewSession.extensionRunner;
		viewed?.followSuspension(this.session.extensionRunner);
		const schemes = this.#extensionLinkClicksAvailable() ? [...(viewed?.getLinkSchemes() ?? [])].sort() : [];
		const changed =
			schemes.length !== this.#linkSchemes.length || schemes.some((scheme, i) => scheme !== this.#linkSchemes[i]);
		this.#linkSchemes = schemes;
		setLinkSchemes(schemes);
		return changed;
	}

	/**
	 * Whether a claimed link can be picked here: schemes are registered, Tern does not route clicks
	 * itself, and the link-hint key is bound or `tui.mouse` delivers clicks.
	 */
	#extensionLinkClicksAvailable(): boolean {
		const schemes = this.viewSession.extensionRunner?.getLinkSchemes() ?? [];
		if (schemes.length === 0 || this.shell.native()) return false;
		return this.#mouseCapture || this.keybindings.keysFor("app.links.hint").length > 0;
	}

	/** Re-evaluate link routing (mouse capture, native rendering, bindings changed). */
	#syncExtensionLinkClicks(): void {
		if (this.#applyExtensionLinks()) this.#redrawExtensionLinks();
	}

	syncExtensionLinks(): void {
		if (!this.#applyExtensionLinks()) return;
		this.#redrawExtensionLinks();
	}

	/**
	 * Close the link browser, whose copy was drawn with the links of before, and replay scrollback
	 * so retired rows draw the new links (live blocks repaint by themselves).
	 */
	#redrawExtensionLinks(): void {
		this.closeLinkBrowser();
		this.#presenter.refreshRenderers();
		this.#eventController.applyAssistantTextRenderers();
		this.shell.host?.replayHistory();
	}

	/** Raise `link_activate` for `url` on `runner`, the extension runner of the transcript it was drawn in. */
	#activateLink(url: string, runner: ExtensionRunner | undefined): boolean {
		if (!runner) return false;
		// A focused subagent's runner is headless: hand its handler the UI drawing that transcript.
		runner.emitLinkActivate(url, this.session.extensionRunner?.getUIContext()).catch((error: unknown) => {
			logger.warn("link_activate dispatch failed", { url, error: String(error) });
		});
		return true;
	}

	/** A link label clicked in the transcript (a Markdown `select` with its href). */
	#onTranscriptSelect(href: string): void {
		const colon = href.indexOf(":");
		if (colon <= 0 || !this.#linkSchemes.includes(href.slice(0, colon).toLowerCase())) return;
		this.#activateLink(href, this.viewSession.extensionRunner);
	}

	/**
	 * Link-hint mode: the link browser tags every extension link of the viewed transcript (the rows
	 * on screen and those in scrollback alike); typing a tag picks its link.
	 */
	startLinkHints(): boolean {
		if (this.#linkSchemes.length === 0) return false;
		if (!this.openLinkBrowser() && !this.#linkBrowser) this.showStatus("No extension links in the transcript");
		return true;
	}

	/** Tags are typed into the link browser, which holds the keys while open. */
	get linkHintsActive(): boolean {
		return false;
	}

	typeLinkHint(_letter: string): void {
		this.closeLinkBrowser();
	}

	cancelLinkHints(): void {
		this.closeLinkBrowser();
	}

	/** The viewed branch's replies as the link browser reads them (a streaming reply as far as it came). */
	#linkReplies(): LinkReply[] {
		const view = this.viewSession;
		const replies: LinkReply[] = [];
		const renderers = view.extensionRunner?.getAssistantTextRenderers() ?? [];
		// A reply as the transcript draws it: the extensions' text renderers may add links.
		const drawn = (message: AssistantMessage, streaming: boolean): string => {
			if (renderers.length === 0) return this.extractAssistantText(message);
			const copy = structuredClone(message);
			let text = "";
			message.content.forEach((content, index) => {
				if (content.type === "text") text += renderAssistantText(renderers, copy, index, content.text, streaming);
			});
			return text.trim();
		};
		for (const entry of view.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const text = drawn(entry.message, false);
			if (text) replies.push({ id: entry.id, text });
		}
		const streaming = view.isStreaming ? this.streamingMessage : undefined;
		if (streaming) replies.push({ id: "omp:link-browser-streaming-reply", text: drawn(streaming, true) });
		return replies;
	}

	openLinkBrowser(): boolean {
		if (this.#linkBrowser || this.#linkSchemes.length === 0) return false;
		const runner = this.viewSession.extensionRunner;
		const replies = signal<readonly LinkReply[]>(this.#linkReplies());
		if (!hasExtensionLinks(replies.peek(), this.#linkSchemes)) return false;
		const schemes = this.#linkSchemes;
		const handle = this.shell.overlays.show(
			() =>
				jsx(LinkBrowser, {
					replies,
					schemes,
					rows: () => this.shell.size().rows,
					onActivate: (url: string) => {
						this.closeLinkBrowser();
						this.#activateLink(url, runner);
					},
					onClose: () => this.closeLinkBrowser(),
				}),
			{ onClose: () => (this.#linkBrowser = undefined) },
		);
		this.#linkBrowser = { replies, handle };
		return true;
	}

	closeLinkBrowser(): void {
		const open = this.#linkBrowser;
		if (!open) return;
		this.#linkBrowser = undefined;
		open.handle.close();
	}

	rerenderInLinkBrowser(_timestamp: number): void {
		this.#linkBrowser?.replies.set(this.#linkReplies());
	}

	/**
	 * Install the main session's transcript presenters (what its runner leaves active); true when
	 * they changed. A focused subagent's transcript and a collab guest's draw stock cards instead.
	 */
	#applyTranscriptPresenters(): boolean {
		const runner = this.viewSession === this.session && !this.collabGuest ? this.session.extensionRunner : undefined;
		return this.#presenter.setPresenters(runner?.getTranscriptPresenters() ?? []);
	}

	#syncTranscriptPresenters(): void {
		if (this.#applyTranscriptPresenters()) this.refreshTranscriptPresentation();
	}

	refreshTranscriptPresentation(ids?: ReadonlySet<string>): void {
		// A changed block on screen repaints; one with rows in scrollback replays history once.
		this.#presenter.refreshPresentation(ids);
	}

	redrawTranscriptBlocks(
		blocks: Iterable<TranscriptBlock>,
		redraw: (block: TranscriptBlock, entry: TranscriptEntry | undefined) => boolean,
	): void {
		this.shell.transcript.redraw(blocks, block => redraw(block, this.#presenter.transcriptEntry(block)));
	}

	#handleSessionAccentInputsChanged(): void {
		this.statusLine.refresh();
		this.updateEditorBorderColor();
	}

	updateEditorBorderColor(): void {
		const accentEnabled = !isSettingsInitialized() || cfgStatusLineSessionAccent.get(settings) !== false;
		const sessionName = accentEnabled ? this.sessionManager.getSessionName() : undefined;
		const inputMode = this.isBashMode ? "bash" : this.isPythonMode ? "python" : this.isBtwMode ? "btw" : undefined;
		const color = composerBorderColor({
			inputMode,
			vimMode: this.composer.vimMode(),
			sessionName,
			thinkingLevel: this.viewSession.thinkingLevel ?? ThinkingLevel.Off,
		});
		// A focused subagent's view fades the outline so the borrowed session reads as such.
		this.composer.setBorderColor(color, this.focusedAgentId !== undefined);
		this.#syncComposerState();
	}

	/**
	 * The composer's mode: a turn runs (Stop for Send), the draft is a shell command or a `/btw`
	 * question, the view is a subagent's (its viewing header), sending the draft skips the ask above.
	 */
	#syncComposerState(): void {
		this.#composerHintRevision.set(this.#composerHintRevision.peek() + 1);
		const draft = untrack(this.composer.text).trimStart();
		const viewing = this.#viewingLineage();
		this.composer.setState({
			running: this.#working.kind !== undefined || this.session.isStreaming,
			...(this.isBashMode
				? { shell: { kind: "bash", excluded: draft.startsWith("!!") } }
				: this.isPythonMode
					? { shell: { kind: "python", excluded: draft.startsWith("$$") } }
					: this.isBtwMode
						? { shell: { kind: "btw", excluded: false } }
						: {}),
			...(untrack(() => this.isBtwFocused) ? { btw: true } : {}),
			...(viewing ? { viewing } : {}),
			...(untrack(() => this.#extensionUiController.composerAsk()) === "skip" ? { skipsAsk: true } : {}),
		});
	}

	/** The focused subagent and its live ancestors below main, outermost first; undefined on the main session. */
	#viewingLineage(): string[] | undefined {
		const id = this.focusedAgentId;
		if (!id) return undefined;
		const registry = AgentRegistry.global();
		const lineage = [id];
		for (
			let parent = registry.get(id)?.parentId;
			parent && parent !== MAIN_AGENT_ID && !lineage.includes(parent) && registry.get(parent);
			parent = registry.get(parent)?.parentId
		) {
			lineage.unshift(parent);
		}
		return lineage;
	}

	/**
	 * Refresh the running-subagents status badge from the active local or collab
	 * registry, and the cost segment's subagent-tree spend (local sessions only:
	 * a collab guest's registry mirrors host transcripts outside this root).
	 */
	#subagentTreeCost = 0;

	syncRunningSubagentBadge(): boolean {
		const registry = getRunningSubagentBadgeRegistry(this.collabGuest, AgentRegistry.global());
		if (this.#agentRegistrySubscriptionTarget !== registry) {
			this.#agentRegistryUnsubscribe?.();
			this.#agentRegistrySubscriptionTarget = registry;
			this.#agentRegistryUnsubscribe = registry.onChange(() => {
				// Restoring a roster emits one event per agent. Rebuild the badge and
				// lists once per burst through the observer scheduler.
				this.#scheduleObserverUiSync();
			});
		}
		const agentIds = getRunningSubagentBadgeAgentIds(registry);
		if (this.#runningSubagentCount !== agentIds.length) {
			this.#runningSubagentCount = agentIds.length;
			this.#composerHintRevision.set(this.#composerHintRevision.peek() + 1);
		}
		const inspectable = getInspectableSubagentCount(registry);
		const inspectableChanged = inspectable !== this.#inspectableSubagentCount;
		this.#inspectableSubagentCount = inspectable;
		const agentsChanged = this.statusLine.setRunningSubagents(agentIds);
		let treeCost = 0;
		if (!this.collabGuest) {
			const rootSessionFile = this.sessionManager.getSessionFile() ?? undefined;
			this.#hydratePersistedSubagentCosts(rootSessionFile);
			treeCost = sumSubagentTreeCost({
				refs: AgentRegistry.global().list(),
				observers: this.#observerRegistry,
				rootSessionFile,
				sessionCosts: this.#subagentSessionCosts,
			});
		}
		const costChanged = this.#subagentTreeCost !== treeCost;
		this.#subagentTreeCost = treeCost;
		if (costChanged) this.statusLine.setModes({ subagentTreeCost: treeCost });
		const changed = agentsChanged || costChanged || inspectableChanged;
		if (changed) this.#syncHudPills();
		return changed;
	}

	/**
	 * Register a resumed session's persisted subagent transcripts (with usage
	 * history) so the status line's tree cost matches the Agent Hub without it
	 * being opened first. Once per on-disk root; registry changes re-sync the cost.
	 */
	#hydratePersistedSubagentCosts(rootSessionFile: string | undefined): void {
		if (!rootSessionFile || this.#subagentCostHydratedRoot === rootSessionFile) return;
		if (!this.sessionManager.isSessionOnDisk()) return;
		this.#subagentCostHydratedRoot = rootSessionFile;
		registerPersistedSubagents(AgentRegistry.global(), rootSessionFile, {
			shouldContinue: () => this.sessionManager.getSessionFile() === rootSessionFile,
		}).catch(error => {
			logger.warn("Persisted subagent cost hydration failed", { rootSessionFile, error: String(error) });
		});
	}

	/** Placeholder for the empty composer; see `COMPOSER_HINTS` for the registered hints. */
	#composerHint(): TspText | undefined {
		this.#composerHintRevision();
		// An ask above holding the keys: its key hints; the keys here: what typing does.
		if (this.#extensionUiController.composerAsk()) {
			const keys = this.#extensionUiController.askKeyHints();
			return keys === undefined ? ASK_COMPOSER_HINT : [{ t: keys, s: "dim" }];
		}
		return resolveComposerHint({
			runningAgents: this.#runningSubagentCount,
			focusedOnAgent: this.focusedAgentId !== undefined,
			conversationStarted: this.viewSession.messages.length > 0,
			keybindings: this.keybindings,
			uses: id => hintUsage.get(id),
		});
	}

	/**
	 * What Tern shows in the empty composer: a `/btw` note it talks to, the ask above, the subagent
	 * the draft goes to, else the session's title quoted in italics (undefined: the default question).
	 */
	#nativeComposerPlaceholder(): TspText | undefined {
		this.#composerHintRevision();
		if (this.isBtwFocused) return "Ask about this…";
		if (this.#extensionUiController.composerAsk()) return NATIVE_ASK_PLACEHOLDER;
		const agent = this.focusedAgentId;
		if (agent !== undefined) return `Message ${agent}`;
		const title = this.sessionManager.getSessionName();
		return title ? [{ t: `“${title}”`, s: "em" }] : undefined;
	}

	rebuildChatFromMessages(): void {
		// Mid-stream rebuilds (`/shake`, setting changes that touch the transcript) replay only
		// committed `state.messages`. The in-flight reply and its pending tool calls live outside
		// them until `message_end`, so their blocks stay live in place (#3656): every other block
		// goes, the replay lands above them, and `pendingTools` keeps routing into them.
		const transcript = this.shell.transcript;
		const live = new Set<TranscriptBlock>();
		const livePendingTools = new Map<string, PendingTool>();
		if (this.viewSession?.isStreaming) {
			if (this.streaming) live.add(this.streaming.block);
			// Text after a tool call in the streaming reply is drawn by its own blocks.
			for (const segment of this.#eventController.liveAssistantSegments()) live.add(segment.block);
			// So are replies a still-executing call's commands wrote to `out://`.
			for (const reply of this.#eventController.liveToolReplies()) live.add(reply.block);
			for (const [id, tool] of this.pendingTools) {
				livePendingTools.set(id, tool);
				live.add(tool.block);
			}
		}
		// Live display collapses to the compacted transcript tail unless the
		// user opted into the full inline history; export/resume callers choose
		// their own mode.
		const context = this.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: cfgDisplayCollapseCompacted.get(settings),
		});
		const preservedLiveToolCallIds = new Set<string>();
		// A preserved call whose result already landed in the replayed transcript is drawn by the
		// replay itself (#6516); keeping its live block too would draw the call twice. A background
		// job's `running` result keeps its live block (later frames still fill it), and a read group
		// another pending read still shares stays as one block.
		for (const message of context.messages) {
			if (message.role !== "toolResult") continue;
			const resolved = livePendingTools.get(message.toolCallId);
			if (!resolved) continue;
			const details = message.details as { async?: { state?: string } } | undefined;
			if (details?.async?.state === "running") {
				preservedLiveToolCallIds.add(message.toolCallId);
				continue;
			}
			livePendingTools.delete(message.toolCallId);
			if ([...livePendingTools.values()].includes(resolved)) {
				preservedLiveToolCallIds.add(message.toolCallId);
				continue;
			}
			live.delete(resolved.block);
		}
		this.transcriptBlocks = new WeakMap();
		this.#frame.welcomeBlock = undefined;
		transcript.retain(live);
		this.#headerBlocks = [];
		const anchor = transcript.blocks()[0];
		transcript.setInsertionPoint(anchor);
		try {
			if (!cfgStartupQuiet.get(settings)) this.#frame.showWelcome();
			this.#syncHeaderExtras();
			this.renderSessionContext(context, { preservedLiveToolCallIds });
		} finally {
			transcript.setInsertionPoint(undefined);
		}
		// `renderSessionContext` clears `pendingTools` at start and end so historical tool blocks
		// don't leak into live tracking: restore the in-flight entries so the next streamed delta
		// routes into the preserved block instead of stacking a duplicate below it.
		for (const [id, tool] of livePendingTools) this.pendingTools.set(id, tool);
		this.#eventController.reconcileReadGroupAfterRebuild();
		void this.#btwController.placeNotes();
		// During the pre-streaming window (the optimistic user row is up, its `message_start` not yet
		// in the session) a rebuild would erase the just-submitted message until the first assistant
		// token (#2372); once `message_start` fires the signature is cleared, so this is a no-op.
		this.#replayOptimisticUserMessage();
	}

	#replayOptimisticUserMessage(): void {
		if (!this.optimisticUserMessageSignature) return;
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.cancelled || submission.customType) return;
		this.#optimisticUserMessageBlocks = this.addMessageToChat(
			{
				role: "user",
				content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
				attribution: "user",
				timestamp: submission.submittedAt,
			},
			submission.imageLinks ? { imageLinks: submission.imageLinks } : {},
		);
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

	#cancelTodoAutoClearTimer(): void {
		this.#todoAutoClearGeneration++;
		if (this.#todoAutoClearTimer) {
			clearTimeout(this.#todoAutoClearTimer);
			this.#todoAutoClearTimer = undefined;
		}
	}

	#syncTodoHudState(owner: AgentViewSession): void {
		this.#cancelTodoAutoClearTimer();
		const phases = this.todoPhases;
		const persisted = getTodoHudVisibility(owner.sessionManager.getBranch(), phases);
		this.#todoHudHidden = persisted === "dismissed";
		if (persisted || phases.length === 0) return;
		const tasks = phases.flatMap(phase => phase.tasks);
		if (tasks.length === 0 || tasks.some(task => !isClosedTodo(task))) return;
		const delaySeconds = cfgTasksTodoClearDelay.get(owner.settings);
		if (!Number.isFinite(delaySeconds) || delaySeconds < 0) return;
		const generation = this.#todoAutoClearGeneration;
		const snapshotKey = JSON.stringify(phases);
		const sessionId = owner.sessionManager.getSessionId();
		const sessionFile = owner.sessionManager.getSessionFile();
		const isCurrent = (): boolean =>
			generation === this.#todoAutoClearGeneration &&
			this.#todoPhasesOwner === owner &&
			owner.sessionManager.getSessionId() === sessionId &&
			owner.sessionManager.getSessionFile() === sessionFile &&
			JSON.stringify(this.todoPhases) === snapshotKey;
		const persistAndHide = async (): Promise<void> => {
			this.#todoAutoClearTimer = undefined;
			await owner.settleInFlightMessagePersistence();
			if (!isCurrent()) return;
			const data = createTodoHudStateData(owner.sessionManager.getBranch(), this.todoPhases, "dismissed");
			if (!data) return;
			owner.sessionManager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, data);
			await owner.sessionManager.flush();
			if (!isCurrent()) return;
			this.#todoHudHidden = true;
			this.#renderTodoList();
		};
		this.#todoAutoClearTimer = setTimeout(() => {
			void persistAndHide().catch(error => {
				logger.warn("Failed to persist TODO HUD dismissal", { error });
			});
		}, delaySeconds * 1000);
		this.#todoAutoClearTimer.unref?.();
	}

	/** The ctrl+p model-role chip track above the composer; it clears itself after a few seconds. */
	showModelCycleTrack(segments: readonly TrackSegment[], activeIndex: number): void {
		this.hud.modelCycle.show(
			segments.map(segment => segment.label),
			activeIndex,
		);
	}

	#scheduleObserverUiSync(): void {
		if (this.#observerUiSyncTimer) return;
		this.#observerUiSyncTimer = setTimeout(() => {
			this.#observerUiSyncTimer = undefined;
			this.#flushObserverUiSync();
		}, SUBAGENT_OBSERVER_UI_COALESCE_MS);
		this.#observerUiSyncTimer.unref?.();
	}

	#flushObserverUiSync(): void {
		this.syncRunningSubagentBadge();
		// Observer changes never touch the todo phases or their persisted
		// visibility: a finished subagent's description is not a `todo done`, so
		// only the pending-todo highlight reads them. Repaint the HUD and
		// transcript todo cards when the active descriptions change, even if the
		// HUD is hidden; re-syncing HUD state here would re-arm the auto-clear timer.
		const descriptionsChanged = this.#getActiveSubagentDescriptions().join("\n") !== this.#todoHudSubagentKey;
		if (descriptionsChanged) this.#renderTodoList();
		this.#renderSubagentList();
		if (this.#trayShown()) this.#syncTray();
	}

	#cancelObserverUiSyncTimer(): void {
		if (this.#observerUiSyncTimer) {
			clearTimeout(this.#observerUiSyncTimer);
			this.#observerUiSyncTimer = undefined;
		}
	}

	/** Feed the todo HUD: the plan, its expansion, dismissal, the short-terminal fold and the subagents at work. */
	#renderTodoList(): void {
		const descriptions = this.#getActiveSubagentDescriptions();
		this.#todoHudSubagentKey = descriptions.join("\n");
		const todo = this.hud.todo;
		batch(() => {
			todo.phases.set(this.todoPhases);
			todo.expanded.set(this.todoExpanded);
			todo.hidden.set(this.#todoHudHidden);
			todo.descriptions.set(descriptions);
		});
		// Collapsed transcript todo cards light the pending tasks the running subagents work on.
		setActiveTodoDescriptions(descriptions);
	}

	async #loadTodoList(source: AgentViewSession = this.session): Promise<void> {
		this.todoPhases = source.getTodoPhases();
		this.#todoPhasesOwner = source;
		this.#syncTodoHudState(source);
		this.#renderTodoList();
	}

	async #getPlanFilePath(): Promise<string> {
		return this.session.getPlanReferencePath() || "local://PLAN.md";
	}

	#resolvePlanFilePath(planFilePath: string): string {
		return resolvePlanFilePath(planFilePath, {
			localProtocolOptions: {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			},
			cwd: this.sessionManager.getCwd(),
		});
	}

	#updatePlanModeStatus(): void {
		const status =
			this.planModeEnabled || this.planModePaused
				? {
						enabled: this.planModeEnabled,
						paused: this.planModePaused,
					}
				: undefined;
		this.statusLine.setModes({ plan: status });
		this.#notifyModeChanged();
	}

	#updateVibeModeStatus(): void {
		this.statusLine.setModes({ vibe: this.vibeModeEnabled });
		this.#notifyModeChanged();
	}

	/**
	 * Anchored HUD of in-flight subagents, mirroring the Todos block above the
	 * editor. Driven entirely by observer-registry change events, so rows appear
	 * on spawn and the whole block clears itself once the last subagent leaves
	 * the "active" state. With the live preview on, a tool call running without
	 * progress events (a long quiet bash) still needs its elapsed marker to
	 * appear and advance, so a repaint is armed for when the marker first shows
	 * and then once a second while a listed agent stays mid-call.
	 */
	#renderSubagentList(): void {
		const hud = this.hud.subagents;
		const mode = cfgDisplayPinnedAgents.get(settings);
		const entries =
			mode === "off"
				? []
				: subagentEntries(this.#observerRegistry.getSessions(), cfgTaskShowResolvedModelBadge.get(settings));
		batch(() => {
			hud.entries.set(entries);
			hud.expanded.set(this.#pinnedHudOverride ?? mode === "full");
			hud.livePreview.set(cfgDisplaySubagentLivePreview.get(settings) && !agentPauseGate.paused);
			hud.hubKey.set(actionKey("app.agents.hub", this.keybindings) || undefined);
		});
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
			getActiveModelString: () =>
				this.session.model ? formatModelStringWithRouting(this.session.model) : undefined,
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
		this.statusLine.setModes({ goal: status });
		this.#notifyModeChanged();
	}

	#resetGoalContinuationSuppression(): void {
		this.#goalSuppressNextContinuation = false;
		this.#previousGoalContinuationActivity = undefined;
	}

	#getPausedGoalState(): GoalModeState | undefined {
		const state = this.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	async #handleGoalSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.#cancelGoalContinuation();
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.#resetGoalContinuationSuppression();
			return;
		}
		if (event.type === "goal_updated") {
			if (event.state) this.#guidedGoalInterviewActive = false;
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
		if (this.#guidedGoalInterviewActive && event.messages.some(hasAssistantToolCall)) {
			this.#guidedGoalInterviewActive = false;
		}
		if (this.#pendingGoalContinuationTurns > 0) {
			this.#pendingGoalContinuationTurns--;
			const activity = goalContinuationActivity(event.messages);
			this.#goalSuppressNextContinuation =
				activity.length === 0 || activity === this.#previousGoalContinuationActivity;
			this.#previousGoalContinuationActivity = activity;
		} else {
			this.#resetGoalContinuationSuppression();
		}
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
			return;
		}
		this.#scheduleGoalContinuation();
		this.syncIdleMaintenanceView();
	}

	async #applyPlanModeModel(): Promise<void> {
		const currentModel = this.session.model;
		const resolved = this.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;
		// Only an entry captures this; role changes while planning must not overwrite it.
		this.#planModePreviousModelState = {
			...(currentModel ? { model: currentModel, identity: formatModelStringWithRouting(currentModel) } : {}),
			thinkingLevel: this.session.configuredThinkingLevel(),
		};

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
					this.#pendingModelSwitch = {
						model: transition.model,
						thinkingLevel: transition.thinkingLevel,
					};
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
		restorePlanModel?: boolean;
	}): Promise<void> {
		if (this.planModeEnabled || this.planModePaused) {
			const previousModel = this.#planModePreviousModelState;
			this.session.setPlanModeState(undefined);
			try {
				const previousPresentation = this.#planModePreviousToolPresentation;
				if (previousPresentation) {
					await this.session.restoreNonMCPToolPresentation(
						previousPresentation.enabled,
						previousPresentation.mounted,
						previousPresentation.registered,
					);
				}
			} finally {
				this.session.setPlanProposalHandler?.(null);
				this.planModeEnabled = false;
				this.planModePaused = false;
				this.planModePlanFilePath = undefined;
				this.#planModePreviousToolPresentation = undefined;
				this.#planModePreviousModelState = undefined;
				this.#pendingModelSwitch = undefined;
				this.#pendingPlanModelSwitch = false;
				this.#planModeHasEntered = false;
				this.#updatePlanModeStatus();
			}
			if (options?.restorePlanModel) {
				await this.#restorePlanPreviousModel(previousModel ?? {});
			}
		}

		if (this.goalModeEnabled || this.goalModePaused) {
			await this.#removeGoalToolPreservingRoster();
			this.session.setGoalModeState(undefined);
			this.goalModeEnabled = false;
			this.goalModePaused = false;
			this.#goalToolAddedByMode = false;
			this.#pendingGoalContinuationTurns = 0;
			this.#previousGoalContinuationActivity = undefined;
			this.#goalSuppressNextContinuation = false;
			this.#cancelGoalContinuation();
			this.syncIdleMaintenanceView();
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
		// Report only the restored result, not the cleared state in between.
		using _hold = this.#holdModeChanges();
		const vibeScopeAlreadySuspended = this.#vibeScopeSuspendedForSwitch;
		this.#vibeScopeSuspendedForSwitch = false;
		this.#guidedGoalInterviewActive = false;
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
		// A session that records no model (a `/new` boundary) keeps the live model,
		// which during plan mode is the transient plan-role model; hand it the
		// pre-plan model instead. A recorded model was already restored by switchSession.
		await this.#clearTransientModeState({
			preserveVibe,
			vibeScopeAlreadySuspended,
			restorePlanModel: Object.keys(sessionContext.models).length === 0,
		});
		await VibeSessionRegistry.global().rehydrate(vibeSession);
		const goalEnabled = cfgGoalEnabled.get(this.session.settings);
		if (!goalEnabled && (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused")) {
			this.session.goalRuntime.clearAccounting();
			this.sessionManager.appendModeChange("none");
			return;
		}
		if (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused") {
			const goal = goalFromModeData(sessionContext.modeData);
			if (!goal) {
				this.sessionManager.appendModeChange("none");
				return;
			}
			// A --no-tools session cannot run the goal; leave it journaled for a session that can.
			if (this.session.restrictToolNames) {
				this.session.goalRuntime.clearAccounting();
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
				const enabledTools = this.session.getEnabledToolNames();
				if (!enabledTools.includes("goal")) this.#goalToolAddedByMode = true;
				await this.session.setActiveToolsByName([...new Set([...enabledTools, "goal"])]);
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
		if (!cfgPlanEnabled.get(this.session.settings)) {
			// Clear stale plan/plan_paused mode so re-enabling the setting
			// later doesn't unexpectedly restore an old plan session.
			if (sessionContext.mode === "plan" || sessionContext.mode === "plan_paused") {
				this.sessionManager.appendModeChange("none");
			}
			return;
		}
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			const prePlanModelIdentity = sessionContext.modeData?.prePlanModelIdentity;
			const previousModel =
				typeof prePlanModelIdentity === "string"
					? resolveExactModelIdentity(prePlanModelIdentity, this.session.modelRegistry)
					: undefined;
			const prePlanThinkingLevel = parseConfiguredThinkingLevel(
				typeof sessionContext.modeData?.prePlanThinkingLevel === "string"
					? sessionContext.modeData.prePlanThinkingLevel
					: undefined,
			);
			await this.#enterPlanMode({
				planFilePath,
				preserveRestoredModel: true,
				previousModelState:
					typeof prePlanModelIdentity === "string"
						? {
								...(previousModel ? { model: previousModel } : {}),
								identity: prePlanModelIdentity,
								thinkingLevel: prePlanThinkingLevel,
							}
						: undefined,
			});
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.#planModeHasEntered = true;
			this.#updatePlanModeStatus();
		}
	}

	/**
	 * Enters plan mode when `plan.defaultOnStartup` applies to the current session
	 * (see {@link shouldEnterPlanModeOnStartup}). Called at launch and after `/new`.
	 * #enterPlanMode is idempotent and self-guards against an active plan/goal/vibe
	 * mode; plan.enabled is checked by shouldEnterPlanModeOnStartup.
	 */
	async #applyPlanModeDefault(): Promise<void> {
		if (shouldEnterPlanModeOnStartup(this.sessionManager, this.session.settings)) {
			await this.#enterPlanMode();
		}
	}

	async #enterPlanMode(options?: {
		planFilePath?: string;
		workflow?: "parallel" | "iterative";
		preserveRestoredModel?: boolean;
		previousModelState?: PlanPreModelState;
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
		// Plan mode ends by `propose`, which a --no-tools session does not register.
		if (this.session.restrictToolNames) {
			this.showWarning("Plan mode is unavailable in a --no-tools session.");
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? (await this.#getPlanFilePath());
		const previousTools = this.session.getEnabledToolNames();
		const previousMountedTools = this.session.getMountedToolCommandNames();
		// `plan-mode-active.md` instructs the agent to draft the plan file with
		// `write` and refine it with `edit`. Both must be in the active set or the
		// agent falls back to `edit` on a non-existent file and stalls.
		// `edit` is an essential built-in and always ships top-level; re-activate
		// `write` here only when the current registry entry is the built-in write
		// tool (issue #3165). A shadowing extension tool named `write` is dropped
		// from the active set rather than carried over (issue #14030): plan mode's
		// read-only guarantee relies on the built-in write/edit guard. `propose`
		// needs no selection: it is a `bash` command while tool commands are
		// mounted, otherwise a top-level tool the session presents while plan mode
		// is on. The standing handler below consumes plan submissions.
		const planAugmentations: string[] = [];
		if (this.session.hasBuiltInTool("write")) {
			planAugmentations.push("write");
		} else if (previousTools.includes("write")) {
			this.showWarning("Plan mode: the `write` tool is provided by an extension and stays disabled while planning.");
		}
		const uniquePlanTools = [...new Set([...previousTools.filter(name => name !== "write"), ...planAugmentations])];

		this.#planModePreviousToolPresentation = {
			enabled: previousTools.filter(name => !isMCPToolName(name)),
			mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
			registered: this.session.getAllToolNames(),
		};
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;
		// Suppress cache-miss marker on the next turn: plan mode changes the system
		// prompt, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;

		// Plan mode state must land before the tool partition: the session
		// presents `propose` as a top-level tool while plan mode is on and `bash`
		// does not carry it as a command.
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
		if (options?.previousModelState) {
			this.#planModePreviousModelState = options.previousModelState;
		}
		// Resume already restored the active plan model; applying the role again
		// would overwrite any execution target restored from the journal.
		if (!options?.preserveRestoredModel) {
			await this.#applyPlanModeModel();
		}
		this.#updatePlanModeStatus();
		this.sessionManager.appendModeChange("plan", this.#planModeJournalData(planFilePath));
		this.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	#planModeJournalData(planFilePath: string): Record<string, unknown> {
		const previous = this.#planModePreviousModelState;
		const identity =
			previous?.identity ?? (previous?.model ? formatModelStringWithRouting(previous.model) : undefined);
		return {
			planFilePath,
			...(identity
				? {
						prePlanModelIdentity: identity,
						...(previous?.thinkingLevel !== undefined ? { prePlanThinkingLevel: previous.thinkingLevel } : {}),
					}
				: {}),
		};
	}

	async #restorePlanPreviousModel(prev: PlanPreModelState): Promise<void> {
		if (!prev.model) return;
		if (
			this.session.model &&
			formatModelStringWithRouting(this.session.model) === formatModelStringWithRouting(prev.model)
		) {
			// Same model — only thinking level may differ. Avoid setModelTemporary()
			// which would reset provider-side sessions and break continuity.
			this.session.setThinkingLevel(prev.thinkingLevel);
		} else if (this.session.isStreaming) {
			this.#pendingModelSwitch = {
				model: prev.model,
				thinkingLevel: prev.thinkingLevel,
			};
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
		// submits the plan with `propose`, so the live turn must be aborted inside
		// `withQueueDrainPaused` to avoid restarting on the stale toolset.
		if (options?.interruptActiveTurn && this.session.isStreaming) {
			await this.session.withQueueDrainPaused(async () => {
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
		const planModeMountedTools = this.session.getMountedToolCommandNames();
		const planModeModelState = this.session.model
			? {
					model: this.session.model,
					thinkingLevel: this.session.configuredThinkingLevel(),
				}
			: undefined;
		this.session.setPlanModeState(undefined);
		try {
			const previousPresentation = this.#planModePreviousToolPresentation;
			if (previousPresentation) {
				await this.session.restoreNonMCPToolPresentation(
					previousPresentation.enabled,
					previousPresentation.mounted,
					previousPresentation.registered,
				);
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
				(!routedModelsAreEqual(this.session.model, planModeModelState.model) ||
					this.session.configuredThinkingLevel() !== planModeModelState.thinkingLevel)
			) {
				try {
					await this.#restorePlanPreviousModel(planModeModelState);
				} catch (rollbackError) {
					logger.warn("Failed to restore plan model after plan exit failure", {
						error: String(rollbackError),
					});
				}
			}
			const enabledTools = this.session.getEnabledToolNames();
			const mountedTools = this.session.getMountedToolCommandNames();
			if (
				enabledTools.length !== planModeTools.length ||
				enabledTools.some((name, index) => name !== planModeTools[index]) ||
				mountedTools.length !== planModeMountedTools.length ||
				mountedTools.some((name, index) => name !== planModeMountedTools[index])
			) {
				try {
					await this.session.setActiveToolPresentation(planModeTools, planModeMountedTools);
				} catch (rollbackError) {
					logger.warn("Failed to restore plan tools after plan exit failure", {
						error: String(rollbackError),
					});
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
		this.#planModePreviousToolPresentation = undefined;
		if (!options?.deferModelRestore || !this.#planModePreviousModelState?.model) {
			this.#planModePreviousModelState = undefined;
		}
		this.#updatePlanModeStatus();
		const paused = options?.paused ?? false;
		this.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		if (!options?.silent) {
			this.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	/**
	 * Warn that a plan session blocks entering goal/vibe mode, distinguishing an
	 * active session from a paused one. A paused session already restored the
	 * tools/model and cleared the `propose` handler, so "Exit plan mode
	 * first." reads as stale right after the user toggled plan mode off (#11692);
	 * point them at the second `/plan` toggle that fully exits instead.
	 */
	#warnPlanModeBlocks(): void {
		this.showWarning(
			this.planModePaused ? "Plan mode is paused — run /plan again to fully exit." : "Exit plan mode first.",
		);
	}

	async #enterGoalMode(options: {
		objective?: string;
		tokenBudget?: number;
		resume?: boolean;
		silent?: boolean;
	}): Promise<void> {
		using _hold = this.#holdModeChanges();
		if (this.goalModeEnabled) {
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.#warnPlanModeBlocks();
			return;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return;
		}
		// Goal mode runs through the `goal` tool, which a --no-tools session does not register.
		if (this.session.restrictToolNames) {
			this.showWarning("Goal mode is unavailable in a --no-tools session.");
			return;
		}
		const enabledTools = this.session.getEnabledToolNames();
		const goalTools = [...new Set([...enabledTools, "goal"])];
		const ownedGoalTool = this.#goalToolAddedByMode;
		if (!enabledTools.includes("goal")) this.#goalToolAddedByMode = true;
		let state: GoalModeState | undefined;
		try {
			state = options.resume
				? await this.session.goalRuntime.resumeGoal()
				: await this.session.goalRuntime.createGoal({
						objective: options.objective ?? "",
						tokenBudget: options.tokenBudget,
					});
			await this.session.setActiveToolsByName(goalTools);
		} catch (error) {
			this.#goalToolAddedByMode = ownedGoalTool;
			// The runtime already journaled the goal; without its tool it must not
			// stay active, or every later entry is refused against a stuck goal.
			if (state) {
				const runtime = this.session.goalRuntime;
				await (options.resume ? runtime.pauseGoal() : runtime.dropGoal()).catch((rollbackError: unknown) =>
					logger.warn("Failed to roll back goal after tool activation failed", { error: String(rollbackError) }),
				);
			}
			throw error;
		}
		this.goalModePaused = false;
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

	/** Undo only goal mode's own tool change; tools registered or enabled after entry stay live. */
	async #removeGoalToolPreservingRoster(): Promise<void> {
		if (!this.#goalToolAddedByMode) return;
		const liveTools = this.session.getEnabledToolNames();
		if (liveTools.includes("goal")) {
			await this.session.setActiveToolsByName(liveTools.filter(name => name !== "goal"));
		}
	}

	async #exitGoalMode(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<void> {
		using _hold = this.#holdModeChanges();
		// Not gated on goalModeEnabled: a pause's goal_updated clears that flag
		// before this runs, which used to leave the goal tool active.
		await this.#removeGoalToolPreservingRoster();
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
		this.#goalToolAddedByMode = false;
		this.#pendingGoalContinuationTurns = 0;
		this.#previousGoalContinuationActivity = undefined;
		this.#goalSuppressNextContinuation = false;
		this.#cancelGoalContinuation();
		this.syncIdleMaintenanceView();
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

	/**
	 * Show the plan review; resolves with the picked choice id (an approval choice's,
	 * or `dialogOptions.refine.id`), or undefined when cancelled. Save runs
	 * `dialogOptions.onSave` and leaves the review open.
	 */
	showPlanReview(
		planContent: string,
		title: string,
		options: readonly PlanReviewOverlayChoice[],
		dialogOptions?: {
			helpText?: string;
			/** Refine, offered while the plan has feedback. */
			refine?: { id: string; label: string };
			/** Save with the overlay's current plan text; the review stays open. */
			onSave?: (content: string) => void;
			onExternalEditor?: () => void;
			onPlanEdited?: (content: string) => void;
			onFeedbackChange?: (feedback: string) => void;
			annotationState?: PlanReviewAnnotationState;
			onAnnotationStateChange?: (state: PlanReviewAnnotationState) => void;
			initialIndex?: number;
			/** Called once, with the settled choice, when the review overlay is hidden. */
			onClose?: (choice: string | undefined) => void;
		},
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		this.#hidePlanReview();
		const pending = this.#pendingPlanReview;
		const owner = pending ?? {};
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		let picked: string | undefined;
		const finish = (choice: string | undefined): void => {
			if (settled) return;
			settled = true;
			picked = choice;
			if (this.#planReviewOwner === owner) {
				this.#planReviewCancel = undefined;
				this.#planReviewPick = undefined;
			}
			if (pending && this.#pendingPlanReview === pending) this.#pendingPlanReview = undefined;
			resolve(choice);
		};
		this.#planReviewOwner = owner;
		this.#planReviewCancel = () => finish(undefined);
		this.#planReviewPick = choice => model.selectOption(choice);
		const onClose = dialogOptions?.onClose;
		this.#planReviewOnHide = onClose ? () => onClose(picked) : undefined;
		const externalEditorKey = this.keybindings.keysFor("app.editor.external")[0];
		const model = new PlanReviewModel(
			planContent,
			{
				promptTitle: title,
				options,
				...(dialogOptions?.refine ? { refine: dialogOptions.refine } : {}),
				...(dialogOptions?.helpText ? { helpText: dialogOptions.helpText } : {}),
				...(dialogOptions?.initialIndex !== undefined ? { initialIndex: dialogOptions.initialIndex } : {}),
				...(extra?.slider ? { slider: extra.slider } : {}),
				...(externalEditorKey
					? { externalEditorLabel: actionKey("app.editor.external", this.keybindings), externalEditorKey }
					: {}),
				...(dialogOptions?.annotationState ? { annotationState: dialogOptions.annotationState } : {}),
				cancelKey: appInterruptKeys(this.keybindings)[0] ?? "escape",
			},
			{
				onPick: choice => finish(choice),
				onCancel: () => finish(undefined),
				onSave: dialogOptions?.onSave,
				onCopyPlan: content => void this.#copyPlanToClipboard(content),
				onExternalEditor: dialogOptions?.onExternalEditor,
				onAnnotationExternalEditor: (draft, commit) => void this.#openPlanAnnotationInExternalEditor(draft, commit),
				onPlanEdited: dialogOptions?.onPlanEdited,
				onFeedbackChange: dialogOptions?.onFeedbackChange,
				onAnnotationStateChange: dialogOptions?.onAnnotationStateChange,
			},
			{ theme: currentTheme, size: () => this.shell.size() },
		);
		this.#planReview = model;
		this.#planReviewOverlayHandle = showSheet(this.shell, planReviewSheet(model), () => jsx(PlanReview, { model }), {
			mouse: "any",
		});
		return promise;
	}

	#hidePlanReview(owner?: object): void {
		if (owner !== undefined && this.#planReviewOwner !== owner) return;
		this.#planReviewCancel?.();
		const onHide = this.#planReviewOnHide;
		this.#planReviewCancel = undefined;
		this.#planReviewPick = undefined;
		this.#planReviewOnHide = undefined;
		this.#planReviewOverlayHandle?.close();
		this.#planReviewOverlayHandle = undefined;
		this.#planReview = undefined;
		this.#planReviewOwner = undefined;
		onHide?.();
	}

	/** The open plan review awaiting an answer, as `plan_review_requested` reported it: backs `ctx.getPendingPlanReview`. */
	getPendingPlanReview(): PlanReviewRequestedEvent | undefined {
		const request = this.#pendingPlanReview?.request;
		return request ? structuredClone(request) : undefined;
	}

	/**
	 * Answers the open plan review as if the operator picked `choice`: backs `ctx.resolvePlanReview`.
	 * Refine feedback is sent verbatim; it only has to be non-blank. `input.role` moves an
	 * approval's execution-tier selection before the pick; it is refused when it names no tier
	 * or accompanies a non-approval choice. `save` writes the plan to its default file name and
	 * leaves the review open, still answerable.
	 */
	resolvePlanReview(
		reviewId: string,
		choice: PlanReviewChoice,
		input?: { feedback?: string; role?: string },
	): boolean {
		const pending = this.#pendingPlanReview;
		const pick = this.#planReviewPick;
		if (!pending || pending.request.reviewId !== reviewId || !pick) return false;
		const option = pending.request.options.find(item => item.id === choice);
		if (!option) return false;
		const feedback = input?.feedback;
		if (choice === "refine" && !feedback?.trim()) return false;
		if (input?.role !== undefined) {
			// The tier decides availability (keep-context is measured against its window).
			const approves = choice === "execute" || choice === "compact" || choice === "keep";
			if (!approves || !pending.selectTier?.(input.role, choice)) return false;
		} else if (option.disabled) {
			return false;
		}
		if (choice === "save") {
			pending.save();
			return true;
		}
		pending.remote = { choice, feedback };
		if (pick(choice)) return true;
		pending.remote = undefined;
		return false;
	}

	/**
	 * The keep-context approval as the review reports it and the overlay shows it, measured against
	 * `executionModel`'s context window (the session's when it has none): disabled past
	 * {@link PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT}.
	 */
	#planKeepContextChoice(executionModel: Model | undefined): {
		option: PlanReviewOption;
		choice: PlanReviewOverlayChoice;
	} {
		const contextWindow = executionModel?.contextWindow;
		const usage =
			typeof contextWindow === "number"
				? this.session.getContextUsage({ contextWindow })
				: this.session.getContextUsage();
		// The context carried over (`~378k / 1m`), when known.
		const meta = usage
			? `~${formatContextTokenCount(usage.tokens)} / ${formatContextTokenCount(usage.contextWindow)}`
			: undefined;
		const disabled = usage !== undefined && usage.percent > PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT;
		return {
			option: {
				id: "keep",
				label: meta ? `Approve and keep context (${meta})` : "Approve and keep context",
				disabled,
			},
			choice: {
				id: "keep",
				label: "Approve and keep context",
				meta,
				disabled: disabled ? `Context is over ${PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT}% full` : undefined,
			},
		};
	}

	/**
	 * Apply the `tui.vimMode` settings to the composer (turning Vim on lands in the start mode) and
	 * route its clipboard registers; `/` and `?` open the same prompt-history search as Ctrl+R.
	 */
	#applyVimModeSetting(): void {
		const composer = this.composer;
		const vim = this.dialogVim();
		composer.onYank = vim?.onYank;
		composer.readClipboard = vim?.readClipboard;
		composer.onHistorySearch = () => this.showHistorySearch();
		composer.onUpFromTop = () => this.focusAsk();
		composer.setVimStartMode(cfgTuiVimStartMode.get(settings));
		composer.setVim(cfgTuiVimMode.get(settings));
		this.#vimSettings.set(this.#vimSettings.peek() + 1);
	}

	/** Bumped when a Vim setting changes, so the status line re-reads them. */
	readonly #vimSettings = signal(0);

	/**
	 * Vim for a dialog's text box while `tui.vimMode` is on: the start mode, and the clipboard
	 * registers (a yank reaches the system clipboard when it names `"+`/`"*`, or always under
	 * `tui.vimYankToClipboard`; `"+p`/`"*p` read it back).
	 */
	dialogVim(): DialogVim | undefined {
		if (!cfgTuiVimMode.get(settings)) return undefined;
		return {
			startMode: () => cfgTuiVimStartMode.get(settings),
			onYank: (text, register) => {
				if (register === "+" || register === "*" || cfgTuiVimYankToClipboard.get(settings))
					void this.#copyYankToClipboard(text);
			},
			readClipboard: readTextFromClipboard,
		};
	}

	/**
	 * Follow the composer's Vim mode into the status line's `vim` segment, the prompt border and the
	 * hardware cursor's shape: the command being typed (with Vim Show Command) and the Visual
	 * selection's height too.
	 */
	#syncVimStatus(): void {
		this.#effect(() => {
			this.#vimSettings();
			const mode = this.composer.vimMode();
			const pending = this.composer.vimPendingText();
			const selectedLines = this.composer.vimSelectedLines();
			const display = cfgTuiVimModeDisplay.get(settings);
			const showCommand = cfgTuiVimShowCommand.get(settings);
			untrack(() => {
				this.statusLine.setModes({
					vim: mode === null ? undefined : { mode, pending: showCommand ? pending : "", selectedLines, display },
				});
				// The hardware cursor shows the mode too: a bar where typing inserts, a block resting on a
				// character in Normal and Visual, the user's own shape without Vim.
				this.shell.host?.driver.setCursorShape(mode === null ? "default" : mode === "insert" ? "bar" : "block");
				this.updateEditorBorderColor();
			});
		});
	}

	/** Bumped by every pin-state write so a slower pins-file read can't overwrite a newer update. */
	#pinStateGeneration = 0;

	/** Reload the pinned set from disk: at startup and on session switch, picking up other instances' pins. */
	async #syncSessionPinned(): Promise<void> {
		const generation = ++this.#pinStateGeneration;
		const pinnedIds = await loadPinnedSessionIds();
		if (generation !== this.#pinStateGeneration) return;
		this.#pinnedSessionIds = new Set(pinnedIds);
		this.#syncPinned();
	}

	applySessionPin(sessionId: string, pinned: boolean): void {
		this.#pinStateGeneration++;
		const next = new Set(this.#pinnedSessionIds);
		if (pinned) next.add(sessionId);
		else next.delete(sessionId);
		this.#pinnedSessionIds = next;
		this.#syncPinned();
	}

	#pinnedSessionIds: ReadonlySet<string> = new Set();

	/** Whether the viewed session is pinned (the status line's pin, the band title's). */
	get #sessionPinned(): boolean {
		return this.#pinnedSessionIds.has(this.sessionManager.getSessionId());
	}

	#syncPinned(): void {
		this.statusLine.setModes({ pinned: this.#sessionPinned });
	}

	async #copyYankToClipboard(content: string): Promise<void> {
		try {
			await copyToClipboard(content);
		} catch (error) {
			// Best-effort: the yank already landed in the internal register, so `p` still puts it
			// back. A per-yank warning would spam headless/SSH sessions on every `yy`.
			logger.debug("Vim yank clipboard copy failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
		const suggested = signal(suggestedPath);
		const excerpt = planSaveTitleExcerpt(planContent);
		if (excerpt) {
			void this.session
				.generateTitle(excerpt, PLAN_FILENAME_SYSTEM_PROMPT)
				.then(generatedTitle => {
					if (!generatedTitle) return;
					suggestedPath = planSaveFileName(generatedTitle);
					suggested.set(suggestedPath);
				})
				.catch(error => {
					logger.debug("plan-save: filename generation failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
		}
		const { promise, resolve } = Promise.withResolvers<PlanSaveOverlayResult | undefined>();
		let result: PlanSaveOverlayResult | undefined;
		const handle = showSheet(
			this.shell,
			PLAN_SAVE_SHEET,
			() =>
				jsx(PlanSave, {
					suggestedPath: suggested,
					onDone: (value: PlanSaveOverlayResult | undefined) => {
						result = value;
						handle.close();
					},
				}),
			{
				focus: root => root.children().find(node => node.kind === "input") ?? root,
				onClose: () => resolve(result),
			},
		);
		return (await promise)?.path;
	}

	/**
	 * Export the plan to a chosen or preset path without resolving the review.
	 * The review owns focus again when the path sheet closes.
	 */
	async #savePlan(planContent: string, title: string, presetPath?: string): Promise<void> {
		const review = presetPath === undefined ? this.#planReview : undefined;
		const selectedPath = presetPath ?? (await this.#promptPlanSavePath(planContent, title));
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
		const message = `Saved plan to ${shortenPath(destination)}`;
		if (review && this.#planReview === review && !this.shell.native()) review.setSaveNotice(message);
		this.showStatus(message);
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
			const result = await this.suspend(() =>
				openInEditor(editorCmd, currentText, {
					extension: path.extname(resolvedPath) || ".md",
					trimTrailingNewline: false,
				}),
			);
			if (result !== null) {
				await Bun.write(resolvedPath, result);
				this.#planReview?.setPlanContent(result);
				this.showStatus("Plan updated in external editor.");
			}
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #openPlanAnnotationInExternalEditor(draft: string, commit: (text: string | null) => void): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		try {
			const result = await this.suspend(() => openInEditor(editorCmd, draft, { extension: ".md" }));
			if (result !== null) commit(result);
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #applyPlanExecutionModel(entry: ResolvedRoleModel | undefined): Promise<void> {
		if (!entry) return;
		try {
			await this.session.applyRoleModel(entry);
			this.statusLine.refresh();
			this.updateEditorBorderColor();
			this.showStatus(`Continuing with ${entry.role}: ${entry.model.name || entry.model.id}`);
		} catch (error) {
			this.showWarning(
				`Could not switch to the ${entry.role} model: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	#resolveLocalRoot(): string {
		return path.resolve(
			resolveLocalRoot({
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			}),
		);
	}

	async #approvePlan(
		planContent: string,
		options: {
			planFilePath: string;
			title: string;
			preserveContext?: boolean;
			compactBeforeExecute?: boolean;
			executionModel?: ResolvedRoleModel;
			reviewOwner: object;
		},
	): Promise<boolean> {
		const previousPresentation = this.#planModePreviousToolPresentation ?? {
			enabled: this.session.getEnabledToolNames().filter(name => !isMCPToolName(name)),
			mounted: this.session.getMountedToolCommandNames().filter(name => !isMCPToolName(name)),
			registered: this.session.getAllToolNames(),
		};

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
				const newLocalPath = this.#resolvePlanFilePath(options.planFilePath);
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
				// summary toward the plan boilerplate (issue #4359). The model the
				// transition below restores reads the summary.
				const readerModel =
					options.executionModel?.model ?? this.#planModePreviousModelState?.model ?? this.session.model;
				compactOutcome = await this.handleCompactCommand(
					undefined,
					undefined,
					outcome => this.#applyDeferredPlanModelTransition(outcome, options.executionModel),
					{ internalGuidance: compactionPrompt, readerModel },
				);
			}
		} finally {
			// Unconditional clear. Idempotent: a no-op when the flag was never set
			// (i.e., the !compactBeforeExecute branch), and a no-op when the flag
			// was already consumed by AgentSession.#handleAgentEvent's aborted
			// message_end stamping. Guarantees the flag is dead at every exit.
			this.session.clearPlanInternalAbortPending();
		}

		// Restore the execution tool set, but force-enable `read` so the durable
		// local:// plan remains available if the inline copy becomes unrecoverable.
		const executionTools = previousPresentation.enabled.includes("read")
			? previousPresentation.enabled
			: [...previousPresentation.enabled, "read"];
		await this.session.restoreNonMCPToolPresentation(
			executionTools,
			previousPresentation.mounted,
			previousPresentation.registered,
		);
		this.session.setPlanReferencePath(options.planFilePath);
		this.sessionManager.appendModeChange("none", { approvedPlanFilePath: options.planFilePath });
		try {
			const autosaved = await autosaveApprovedPlan({
				settings: this.session.settings,
				cwd: this.sessionManager.getCwd(),
				title: options.title,
				planContent,
			});
			if (autosaved) {
				const displayPath = truncateToWidth(replaceTabs(shortenPath(autosaved)), TRUNCATE_LENGTHS.CONTENT);
				this.showStatus(`Saved plan to ${displayPath}.`);
			}
		} catch (error) {
			const detail = truncateToWidth(
				shortenEmbeddedPaths(
					replaceTabs(error instanceof Error ? error.message : String(error))
						.replace(/[\r\n]+/g, " ")
						.trim(),
				),
				TRUNCATE_LENGTHS.CONTENT,
			);
			this.showWarning(`Failed to autosave plan: ${detail}`);
		}

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
		// so the session is not left unnamed, unless automatic titling is disabled
		// (`--no-title` / PI_NO_TITLE). `setSessionName("auto")` is a no-op when the
		// user has already chosen a name (preserveContext paths).
		const seededName = humanizePlanTitle(options.title);
		if (!$env.PI_NO_TITLE && seededName && !this.sessionManager.getSessionName()) {
			await this.sessionManager.setSessionName(seededName, "auto");
		}

		// markPlanReferenceSent fires only on the dispatch path so the synthetic
		// plan-approved prompt is the source of the reference injection.
		this.session.markPlanReferenceSent();
		const planModePrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath: options.planFilePath,
			planContent,
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
		// The ownership-bound hide is idempotent, so the caller's trailing
		// `closePlanReview()` — and a stale continuation after a replacement review
		// opened — stay safe no-ops.
		this.#hidePlanReview(options.reviewOwner);
		// A user turn queued during compaction was already fired by
		// `flushCompactionQueue` before we returned from `handleCompactCommand`; the
		// old abort-then-prompt path would have discarded that operator turn AND
		// still surfaced `AgentBusyError` when the queued turn kicked off in the
		// synchronous gap. Preserve the in-flight work and queue the hidden
		// execution directive behind it as a synthetic follow-up. If `isStreaming`
		// flips true between the check and dispatch (the same fire-and-forget race
		// noted below), catch `AgentBusyError` and fall back to the same queue.
		if (this.session.isStreaming) {
			await this.session.followUp(planModePrompt, undefined, {
				synthetic: true,
			});
		} else {
			try {
				await this.session.prompt(planModePrompt, { synthetic: true });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await this.session.followUp(planModePrompt, undefined, {
					synthetic: true,
				});
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

	/**
	 * Paused plan → off. Tools, model, and plan state were already restored by the
	 * prior #exitPlanMode({ paused: true }); only the paused flag, the reentry
	 * marker, and the session mode entry remain. The draft file is kept.
	 */
	#disablePausedPlanMode(): void {
		this.planModePaused = false;
		this.#planModeHasEntered = false;
		this.#updatePlanModeStatus();
		this.sessionManager.appendModeChange("none");
		this.showStatus("Plan mode disabled.");
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
			// An open review must not outlive the plan mode it approves: a later pick
			// would autosave and dispatch the plan while plan mode is paused.
			this.#hidePlanReview();
			await this.#exitPlanMode({ paused: true, interruptActiveTurn: true });
			return false;
		}
		if (this.planModePaused && !initialPrompt) {
			// No-arg third toggle. Prompted /plan invocations fall through to
			// #enterPlanMode below so the supplied prompt is still submitted as the
			// first plan-mode turn.
			this.#disablePausedPlanMode();
			return false;
		}
		if (!cfgPlanEnabled.get(this.session.settings)) {
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
				() =>
					this.session.prompt(initialPrompt, {
						streamingBehavior: "steer",
						images,
					}),
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
			this.#warnPlanModeBlocks();
			return false;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return false;
		}
		await this.#enterVibeMode();
		if (!initialPrompt) return false;
		if (isKnownSkillCommand(this, initialPrompt)) {
			// Append synchronously: the skill file read below yields before the
			// turn reserves, so a concurrent plain prompt must see this claim
			// before it can take the idle waiter — and a later skill must queue
			// behind this one rather than overwrite a shared slot.
			const prev = this.#vibeSkillTail;
			this.#vibeSkillInFlight++;
			const mine = (async () => {
				try {
					await prev;
					await this.#waitForInFlightSubmission(true);
					await invokeSkillCommandFromText(this, initialPrompt, "steer", {
						images: input?.images,
						propagateErrors: true,
					});
				} finally {
					this.#vibeSkillInFlight--;
				}
			})();
			// Never reject: a failed skill must not break the chain for later ones.
			this.#vibeSkillTail = mine.catch(() => {});
			await mine;
			return true;
		}
		if (this.session.isStreaming) {
			// Same ordering covenant as below: a skill prompt may be reserving
			// ahead of us even though the session looks continuously busy.
			await this.#waitForInFlightSubmission();
			const images = input?.images?.length ? input.images : undefined;
			await this.withLocalSubmission(
				initialPrompt,
				() =>
					this.session.prompt(initialPrompt, {
						streamingBehavior: "steer",
						images,
					}),
				{ imageCount: images?.length ?? 0 },
			);
			return true;
		}
		const dispatchViaWaiter = (): boolean => {
			// A skill prompt reserving ahead of us owns the next turn: leave the
			// waiter armed until it reserves, so the main loop submits in order.
			if (this.#vibeSkillInFlight > 0) return false;
			const onInput = this.onInputCallback;
			if (!onInput) return false;
			onInput(this.startPendingSubmission({ text: initialPrompt, ...input }, { preserveDraft: true }));
			return true;
		};
		if (dispatchViaWaiter()) return true;
		// No input waiter: a concurrent dispatch may have just taken the one-shot
		// waiter — its submission exists but the main loop hasn't handed it to the
		// session yet. Steering now would overtake it and reverse prompt order, so
		// yield until it reserves its turn, then re-check for a fresh waiter.
		await this.#waitForInFlightSubmission();
		if (dispatchViaWaiter()) return true;
		// Still no waiter (the main loop is between turns): steer directly instead
		// of silently swallowing the prompt — the same fallback the normal submit
		// path uses when its waiter is gone.
		const images = input?.images?.length ? input.images : undefined;
		await this.withLocalSubmission(
			initialPrompt,
			() =>
				this.session.prompt(initialPrompt, {
					streamingBehavior: "steer",
					images,
				}),
			{ imageCount: images?.length ?? 0 },
		);
		return true;
	}

	/**
	 * Yield until prior dispatches reserve their turn (streaming, queued, or
	 * dropped) or a fresh waiter arms. Without this, a prompt dispatched right
	 * after a concurrent submit resolved the one-shot input waiter — or while a
	 * skill prompt is still reading its file — would reach
	 * {@link session.prompt} before the main loop submits the earlier input,
	 * reversing their order. No-op when nothing is in flight; bounded so a
	 * stalled loop degrades to immediate dispatch. `ignoreSkills` lets a skill
	 * dispatch wait for earlier plain submissions only: concurrent skills order
	 * themselves through the tail chain, and counting the live total here would
	 * stall an earlier skill behind a later one it must precede.
	 */
	async #waitForInFlightSubmission(ignoreSkills = false): Promise<void> {
		for (let index = 0; index < 200; index++) {
			const skillBlocked = !ignoreSkills && this.#vibeSkillInFlight > 0;
			const awaited = this.#pendingSubmittedInput;
			const pendingBlocked =
				awaited !== undefined &&
				!awaited.cancelled &&
				!this.session.isStreaming &&
				this.session.queuedMessageCount === 0 &&
				!this.onInputCallback;
			if (!skillBlocked && !pendingBlocked) return;
			await Bun.sleep(10);
		}
	}

	async #enterVibeMode(options?: { persistModeChange?: boolean; previousTools?: string[] }): Promise<void> {
		if (this.vibeModeEnabled) {
			return;
		}
		const inFlight = this.#vibeModeEntry;
		if (inFlight) {
			// A second /vibe (possibly with a prompt) submitted while activation
			// is still in flight must not dispatch on the stale toolset: wait for
			// the first entry, then return with vibe active. A failed entry
			// rejects here too, so the prompt is dropped instead of running
			// outside vibe mode.
			await inFlight;
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.#warnPlanModeBlocks();
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
		// The entry runs as a stored promise so a concurrent /vibe joins it
		// above instead of dispatching on the stale toolset. The first caller
		// awaits it below, so a failure is always observed (no unhandled
		// rejection) and propagates to every joiner, dropping their prompts.
		const entry = (async () => {
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
		})();
		this.#vibeModeEntry = entry;
		try {
			await entry;
		} finally {
			if (this.#vibeModeEntry === entry) this.#vibeModeEntry = undefined;
		}
	}

	async #exitVibeMode(): Promise<void> {
		if (!this.vibeModeEnabled) {
			return;
		}
		// Tear down with the queued-message drain suppressed: aborting the active
		// turn would otherwise let a queued user steer/follow-up restart on the
		// still-live Vibe tools before this teardown removes them (issue #8326).
		let killed = 0;
		await this.session.withQueueDrainPaused(async () => {
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
			this.#warnPlanModeBlocks();
			return false;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return false;
		}
		if (!cfgGoalEnabled.get(this.session.settings)) {
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
			await this.showHookEditor("Goal objective", undefined, undefined, {
				promptStyle: true,
			})
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
				this.#warnPlanModeBlocks();
				return false;
			}
			if (this.vibeModeEnabled) {
				this.showWarning("Exit vibe mode first.");
				return false;
			}
			if (!cfgGoalEnabled.get(this.session.settings)) {
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
			// calling `goal create`. Remember that this mode added the tool: the
			// tool-driven create flips goalModeEnabled via `goal_updated`, and the
			// eventual goal exit drops only that tool from the live roster.
			const enabledTools = this.session.getEnabledToolNames();
			if (!enabledTools.includes("goal")) {
				this.#goalToolAddedByMode = true;
				await this.session.setActiveToolsByName([...enabledTools, "goal"]);
			}
			this.#guidedGoalInterviewActive = true;

			// The interview is a normal conversation: the kickoff rides in as a
			// hidden developer message, the agent asks its questions as regular
			// assistant turns, and the user answers in the ordinary editor. Queue
			// behind an in-flight run instead of aborting it.
			const kickoff = prompt.render(guidedGoalInterviewPrompt, {
				initial: rest?.trim() || undefined,
			});
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
			this.#guidedGoalInterviewActive = false;
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
			`Time spent: ${formatCoarseDuration(goal.timeUsedSeconds * 1000)}`,
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
		using _hold = this.#holdModeChanges();
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

	/** Enter through the same goal activation path as `/goal set`, then start its first turn. */
	async startGoalAtStartup(objective: string): Promise<void> {
		await this.#enterGoalMode({ objective, silent: true });
		if (!this.goalModeEnabled) return;
		this.#resetGoalContinuationSuppression();
		await this.session.prompt(objective, { streamingBehavior: "steer" });
	}

	/** End the `working` hold of `init({ startupRun })` once the command-line prompts are dispatched. */
	settleStartupRun(): void {
		settleStartupRun();
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
				() =>
					this.session.prompt(objective, {
						streamingBehavior: "steer",
						images,
					}),
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
				() =>
					this.session.prompt(objective, {
						streamingBehavior: "steer",
						images,
					}),
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
			: (
					await this.showHookEditor("Goal objective", undefined, undefined, {
						promptStyle: true,
					})
				)?.trim();
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
	 *  works before any review and across restarts.
	 *
	 *  `fromExtension` backs `ctx.openPlanReview`: an extension never interrupts work
	 *  it did not start, so a busy session refuses instead of aborting the turn (an
	 *  extension tool awaiting this would otherwise wait on its own abort), an open
	 *  review is kept rather than replaced, and refusals are silent. Resolves once a
	 *  review is awaiting an answer, not when it is answered. */
	async openPlanReview(options?: { fromExtension?: boolean }): Promise<boolean> {
		const fromExtension = options?.fromExtension === true;
		const warn = (message: string): void => {
			if (!fromExtension) this.showWarning(message);
		};
		if (!this.planModeEnabled) {
			warn("Plan mode is not active.");
			return false;
		}
		if (fromExtension) {
			if (this.#hasAnswerablePlanReview()) return true;
			if (this.session.isStreaming || this.session.isCompacting) return false;
		}
		const noPlan = "No plan to review yet — write one to a local://<slug>-plan.md file first.";
		const [planFilePath] = await this.#listLocalPlanFiles();
		if (!planFilePath) {
			warn(noPlan);
			return false;
		}
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent?.trim()) {
			warn(noPlan);
			return false;
		}
		const { title } = resolvePlanTitle({ planContent, planFilePath });
		const opened = Promise.withResolvers<boolean>();
		let isOpen = false;
		void this.handlePlanApproval(
			{ planFilePath, title, planExists: true },
			{
				abortTurn: !fromExtension,
				onOpened: () => {
					isOpen = true;
					opened.resolve(true);
				},
			},
		).then(
			// Returned without opening: still true when a concurrent open won the race.
			() => opened.resolve(fromExtension && this.#hasAnswerablePlanReview()),
			error => {
				opened.resolve(false);
				const message = error instanceof Error ? error.message : String(error);
				this.showError(isOpen ? `Plan review failed: ${message}` : `Failed to open plan review: ${message}`);
			},
		);
		return opened.promise;
	}

	/** A plan review is open and can still take a remote answer. */
	#hasAnswerablePlanReview(): boolean {
		return this.#pendingPlanReview !== undefined && this.#planReviewPick !== undefined;
	}

	/**
	 * `abortTurn: false` skips the turn abort for callers that checked the session is
	 * idle; the review is then refused if a turn started while the plan was read.
	 * `onOpened` runs once the overlay and pending request exist.
	 */
	async handlePlanApproval(
		details: PlanApprovalDetails,
		options?: { abortTurn?: boolean; onOpened?: () => void },
	): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}
		const abortTurn = options?.abortTurn !== false;
		const originSessionId = this.sessionManager.getSessionId();

		// Abort the agent to prevent it from continuing (e.g., re-submitting the
		// plan) while the popup is showing. The event listener fires asynchronously
		// (agent's #emit is fire-and-forget), so without this the model sees
		// "Plan ready for approval." and immediately re-dispatches approval in a loop.
		// This abort is an internal UI transition, not operator cancellation.
		if (abortTurn) await this.#abortPlanApprovalTurnSilently();

		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.#getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.showError(`Plan file not found at ${planFilePath}`);
			return;
		}
		// The operator may have left plan mode or switched sessions while the turn was
		// aborted or the plan was read; a stale review must not mount over that.
		if (!this.planModeEnabled || this.sessionManager.getSessionId() !== originSessionId) return;
		// Without the abort barrier, a turn or another review may have started while the
		// plan was read; everything from here to the overlay is synchronous.
		if (!abortTurn && (this.session.isStreaming || this.session.isCompacting || this.#hasAnswerablePlanReview())) {
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
			this.sessionManager.appendModeChange("plan", this.#planModeJournalData(planFilePath));
			// Reported only once committed: the next planning turn reads this state.
			this.#notifyModeChanged();
		}

		// Model-tier slider: let the operator pick which configured role model
		// (smol/default/slow/…) executes the approved plan. The slider always starts
		// on the `default` tier so execution defaults to the default model no matter
		// which model drove the planning conversation. Left/right move it from there;
		// hidden when fewer than two role models resolve — a lone tier is no choice.
		// `selectedTierIndex` tracks the live slider position.
		const cycle = this.session.getRoleModelCycle(cfgCycleOrder.get(this.session.settings));
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
							const next = choicesAt(index);
							request.options = next.options;
							this.#planReview?.setChoices(next.choices);
						},
					}
				: undefined;
		// Keep-context availability follows the model that executes: the selected tier while the
		// slider shows, else the pre-plan model #exitPlanMode restores. The overlay offers Refine
		// only while the plan has feedback; an extension may always refine with its own feedback,
		// so the reported options keep it.
		const restoredModel = this.#planModePreviousModelState?.model ?? this.session.model;
		const choicesAt = (tierIndex: number): { options: PlanReviewOption[]; choices: PlanReviewOverlayChoice[] } => {
			const keep = this.#planKeepContextChoice(slider ? cycle!.models[tierIndex]?.model : restoredModel);
			return {
				options: [
					{ id: "execute", label: "Approve and execute", disabled: false },
					{ id: "compact", label: "Approve and compact context", disabled: false },
					keep.option,
					{ id: "refine", label: "Refine plan", disabled: false },
					{ id: "save", label: "Save", disabled: false },
				],
				choices: [
					{ id: "execute", label: "Approve and execute", detail: "Start fresh with just the plan" },
					{
						id: "compact",
						label: "Approve and compact context",
						detail: "Summarize this conversation, then execute",
					},
					keep.choice,
				],
			};
		};
		const initialChoices = choicesAt(startTierIndex);
		// The overlay now owns the dynamic, focus-aware help line; the caller only
		// supplies the trailing cancel hint.
		const helpText = `${actionKey("tui.select.cancel", this.keybindings)} cancel`;
		// In-overlay edits (section deletes/undo) and section annotations. Deletes
		// update `editedContent` (and mirror to disk); annotations build `feedback`
		// that the Refine branch re-prompts the model with.
		let editedContent: string | undefined;
		let feedback = "";
		const annotationStateKey = this.#resolvePlanFilePath(planFilePath);

		const reviewSessionId = this.sessionManager.getSessionId();
		const request: PlanReviewRequestedEvent = {
			type: "plan_review_requested",
			reviewId: crypto.randomUUID(),
			sessionId: reviewSessionId,
			title: details.title,
			planFilePath,
			planContent,
			options: initialChoices.options,
			tiers: slider
				? cycle!.models.map(entry => ({
						role: entry.role,
						provider: entry.model.provider,
						model: entry.model.id,
						...(entry.explicitThinkingLevel && entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
					}))
				: undefined,
		};
		const reviewId = request.reviewId;
		// Save writes the plan as it stands (in-overlay edits, else the file) and leaves the review open.
		const savePlan = async (content: string | undefined, presetPath?: string): Promise<void> => {
			try {
				const latestPlanContent = content ?? editedContent ?? (await this.#readPlanFile(planFilePath));
				if (latestPlanContent === null) {
					this.showError(`Plan file not found at ${planFilePath}`);
					return;
				}
				await this.#savePlan(latestPlanContent, details.title, presetPath);
			} catch (error) {
				this.showError(`Failed to save plan: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		this.#pendingPlanReview = {
			request,
			save: () => void savePlan(undefined, planSaveFileName(details.title)),
			// Mirrors the slider's onChange for remote answers: a pick in `resolvePlanReview`
			// moves the same `selectedTierIndex` the approval branch reads after the choice.
			// Undefined when the slider is hidden — a lone tier is no selection, and pinning
			// it would switch the session back to the plan model.
			selectTier: slider
				? (role, choice) => {
						const index = cycle!.models.findIndex(entry => entry.role === role);
						if (index < 0 || choicesAt(index).options.find(option => option.id === choice)?.disabled)
							return false;
						this.#planReview?.setSliderIndex(index);
						return true;
					}
				: undefined,
		};
		const pending = this.#pendingPlanReview;
		const extensionRunner = this.session.extensionRunner;
		// `plan_review_resolved` reports the overlay closing, not the pick: a pick can
		// leave it up (compaction runs behind it), and it only fires once every
		// extension has been handed `plan_review_requested`.
		const requestDelivered = Promise.withResolvers<void>();
		const choicePromise = this.showPlanReview(
			planContent,
			"Plan mode - next step",
			initialChoices.choices,
			{
				helpText,
				refine: { id: "refine", label: "Refine plan" },
				onSave: content => void savePlan(content),
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
				onClose: closedWith => {
					if (!extensionRunner) return;
					const resolved = {
						type: "plan_review_resolved",
						reviewId,
						sessionId: reviewSessionId,
						choice: request.options.find(option => option.id === closedWith)?.id,
						by: pending.remote ? "extension" : "local",
					} as const;
					void requestDelivered.promise.then(() => extensionRunner.emit(resolved));
				},
			},
			{ slider },
		);
		options?.onOpened?.();
		// Handlers get their own copy so mutating the event cannot re-enable a refused choice.
		const requestedDelivery = extensionRunner?.emit(structuredClone(request));
		void requestedDelivery?.then(
			() => requestDelivered.resolve(),
			() => requestDelivered.resolve(),
		);
		// The plan waits on the user's approval, after the turn that proposed it has ended.
		const release = holdBlockedStatus({ state: "blocked", kind: "permission", msg: `Review plan: ${details.title}` });
		const choice = await choicePromise.finally(release);
		if (this.#pendingPlanReview === pending) this.#pendingPlanReview = undefined;
		const remote = pending.remote;
		const closePlanReview = (): void => {
			this.#hidePlanReview(pending);
		};

		if (choice === "execute" || choice === "compact" || choice === "keep") {
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
					cycle && restoredState?.model
						? cycle.models.findIndex(entry => {
								if (!routedModelsAreEqual(entry.model, restoredState.model)) return false;
								if (!entry.explicitThinkingLevel) return true;
								return entry.thinkingLevel === restoredState.thinkingLevel;
							})
						: -1;
				const executionModel =
					slider && cycle && selectedTierIndex !== restoredIndex ? cycle.models[selectedTierIndex] : undefined;
				const executionDispatched = await this.#approvePlan(latestPlanContent, {
					planFilePath,
					title: details.title,
					preserveContext: choice !== "execute",
					compactBeforeExecute: choice === "compact",
					executionModel,
					reviewOwner: pending,
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

		if (choice === "refine") {
			// Offered locally only with feedback; a remote refine brings its own (non-blank).
			const refinement = remote?.choice === "refine" ? (remote.feedback ?? "") : feedback;
			try {
				if (this.onInputCallback) {
					const input = this.startPendingSubmission({ text: refinement });
					this.#planReviewAnnotationStateBySubmission.set(input, annotationStateKey);
					this.onInputCallback(input);
				} else {
					await this.session.prompt(refinement);
					this.#planReviewAnnotationState.delete(annotationStateKey);
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
			"🧾 Your agent drafted a strongly worded letter to one of its tools.",
			"Mail it to the devs? Just the tool name + the grievance, nothing personal.",
		],
		[
			"🕵️ Your agent caught a tool acting suspicious.",
			"Tip off the devs? Tool name + the evidence, no personal info.",
		],
		[
			"👻 Your agent swears one of its tools is haunted.",
			"Call in the devs for an exorcism? Tool name + the spooky bit, nothing personal.",
		],
		["🫖 Your agent has tea about a tool.", "Spill it to the devs? Tool name + the tea, never anything personal."],
		[
			"🦆 Your agent explained a tool to its rubber duck. The duck is also confused.",
			"Escalate past the duck to the devs? Tool name + the confusion, no personal info.",
		],
		[
			"📟 Your agent is asking to speak to a tool's manager.",
			"Put the call through to the devs? Tool name + the complaint, nothing personal.",
		],
		[
			"🧂 Your agent is extremely salty about a tool.",
			"Let it salt the devs' inbox? Tool name + what soured it, no personal info.",
		],
		[
			"🐛 Your agent found a bug. A real one. In a tool.",
			"Hand the specimen to the devs? Tool name + where it crawled out, nothing personal.",
		],
		[
			"🍿 Your agent just watched a tool pull a plot twist nobody asked for.",
			"Send the devs a spoiler? Tool name + what happened, never anything personal.",
		],
		[
			"📉 Your agent's opinion of a tool just crashed.",
			"Send the post-mortem to the devs? Tool name + what tanked it, no personal info.",
		],
	];

	/**
	 * Show the report_tool_issue consent popup (mirrored to writable `/collab` guests)
	 * and return the user's decision.
	 * Invoked by the process-global consent handler the tool dispatches to;
	 * subagent invocations bubble up here through the shared module state.
	 */
	async #promptAutoQaConsent(): Promise<boolean | null> {
		const pool = InteractiveMode.#AUTOQA_CONSENT_PROMPTS;
		const [headline, body] = pool[Math.floor(Math.random() * pool.length)];
		const choice = await this.#extensionUiController.showCollabAwareSelector(
			`${headline}\n${body}`,
			["Yes", "No"],
			undefined,
			{ kind: "permission" },
		);
		return choice === "Yes";
	}

	/**
	 * Ask the user to approve one `cfg://` settings change; writable `/collab` guests get the
	 * same prompt and the first answer wins. Dismissing the dialog denies it, as does
	 * aborting the calling turn or stopping the mode. The wait honors `ask.timeout`
	 * (seconds, 0 waits indefinitely); while a deadline is armed, any host
	 * keypress restarts the countdown, and an unanswered prompt drops the write as `timeout`.
	 */
	async #promptCfgChange(request: CfgChangeRequest, callerSignal?: AbortSignal): Promise<CfgApproval> {
		const headline = request.save
			? `💾 Your agent wants to save \`${request.path}\` to your config.`
			: `⚙️ Your agent wants to change \`${request.path}\` for this session.`;
		const warning = request.shadowedBy
			? `\n⚠️ Overridden by your ${request.shadowedBy}: the saved value won't take effect here.`
			: "";
		let timedOut = false;
		const timeout = askTimeoutMs(this.session.settings);
		// Settle dismissed when the caller's turn aborts (a collab guest
		// interrupting the agent) or when the mode stops, whichever first.
		const signal =
			callerSignal === undefined
				? this.#dialogLifetime.signal
				: AbortSignal.any([callerSignal, this.#dialogLifetime.signal]);
		const choice = await this.#extensionUiController.showCollabAwareSelector(
			`${headline}\n${request.previous} → ${request.value}${warning}`,
			[CFG_APPROVE_SESSION, CFG_APPROVE_ONCE, CFG_DENY],
			{
				// A reflexive Enter approves this change only, never the whole session.
				initialIndex: 1,
				timeout,
				signal,
				// With a deadline armed the selector auto-picks the highlighted option on
				// expiry; an unanswered prompt approves nothing.
				onTimeout: () => {
					timedOut = true;
				},
			},
			{ kind: "permission" },
		);
		if (timedOut) return "timeout";
		if (choice === CFG_APPROVE_SESSION) return "session";
		if (choice === CFG_APPROVE_ONCE) return "once";
		return "deny";
	}

	stop(): void {
		this.#frame.releaseStartupKeys();
		this.#closeAttempt?.abort();
		this.syncIdleMaintenanceView(null);
		this.#hidePlanReview();
		// Settle any pending approval prompt as dismissed (deny). The
		// controller stays aborted: approvals still queued behind the approval
		// mutex deny on arrival instead of prompting a torn-down UI. `init`
		// installs a fresh one.
		this.#dialogLifetime.abort();
		this.#streamPublisher?.dispose();
		this.#streamPublisher = undefined;
		void this.#recorder?.stop();
		this.#recorder = undefined;
		this.#working.clear();
		this.setTerminalProgress(false);
		this.#editorAreaDialog?.close();
		this.#micCursor?.dispose();
		this.#micCursor = undefined;
		this.#liveCommandController.dispose();
		this.#clearJudgmentBatchProgress();
		this.hud.progress.downloads.dispose();
		this.hud.modelCycle.clear();
		this.#cancelTodoAutoClearTimer();
		this.#cancelObserverUiSyncTimer();
		this.#cancelGoalContinuation();
		clearInterval(this.#jobsSheetTimer);
		this.#jobsSheetTimer = undefined;
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
		this.#fireworks?.close();
		this.statusLine.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}
		// Clear the process-global consent handler so it doesn't outlive this
		// InteractiveMode instance (e.g. test harnesses, headless re-init).
		setAutoQaConsentHandler(null, null);
		setCfgApprovalHost(null);
		this.#disposeImageBlobWriter?.();
		this.#disposeImageBlobWriter = undefined;
		this.#disposeInlineImageLimits?.();
		this.#disposeInlineImageLimits = undefined;
		this.#hideSessionInfo();
		if (this.#ownsStartedUi) {
			void this.shell.stop();
			this.#ownsStartedUi = false;
		}
		// The Markdown painter's link schemes and the link-click provider are process-wide.
		setLinkSchemes([]);
		setExtensionLinkClicksProvider(undefined);
		this.#presenter.setPresenters([]);
		this.isInitialized = false;
	}

	async #quitHostOwned(code: number): Promise<void> {
		try {
			await postmortem.quit(code);
		} catch {
			// Extension loading guards process.exit; cleanup already ran before
			// the guarded exit throws, so host shutdown can use the native exit.
			postmortem.exitProcess(code);
		}
	}

	/**
	 * Close the session and quit. `cancellable: false` is for closes nobody may
	 * refuse (fatal workspace states, `ctx.shutdown()`); operator quits are
	 * cancellable and first ask extensions through `session_before_shutdown`.
	 */
	async shutdown(options?: { cancellable?: boolean }): Promise<void> {
		if (this.#isShuttingDown) {
			// Another close request ends the pending attempt's prompts; that
			// attempt keeps ownership of teardown and can no longer be cancelled.
			this.#closeAttempt?.abort();
			return;
		}
		// The previous graceful teardown failed AT the memoized session.dispose()
		// (the session is already disposing), so it re-rejects identically forever
		// and the process can never close (#12238: a corrupted session file makes
		// the close-time rewrite refuse to clobber it). This second attempt is the
		// escape hatch: quit without writing the session log. 130 = 128 + SIGINT,
		// matching the Ctrl+C hard-abort exit code in input-controller.
		if (this.#teardownFailed) {
			await this.#quitHostOwned(130);
			return;
		}
		const signal = this.#beginClose();
		// Reversible decisions first: nothing has been stopped yet, so a refusal
		// leaves the session exactly as it was.
		if (options?.cancellable !== false && !(await this.session.confirmClose(signal))) {
			this.#abandonClose();
			this.showStatus("Session close cancelled");
			// The refusal covers only this quit, not a pending `ctx.shutdown()`.
			if (this.shutdownRequested) void this.checkShutdownRequested();
			return;
		}
		// A signal teardown or stop() took over while extensions were asked.
		if (this.session.isDisposed || this.#dialogLifetime.signal.aborted) return;
		const worktreePlan = await this.#planOwnedWorktreeExit(signal);
		try {
			await this.#teardown();
		} catch (error) {
			this.#handleTeardownError("close", error);
			return;
		}
		for (const message of await removeExitWorktrees(worktreePlan)) {
			process.stderr.write(`${chalk.yellow(message)}\n`);
		}

		// Print resumption hint only if the session was actually materialized to
		// durable storage — `--resume <id>` fails on a never-written file (see
		// #resumableSessionId).
		const sessionId = this.#resumableSessionId();
		if (sessionId) {
			// Command on its own line so triple-click selects just the command (#11001).
			process.stderr.write(`\n${chalk.dim("Resume this session with")}\n${chalk.dim(resumeCommand(sessionId))}\n`);
		}

		await this.#quitHostOwned(0);
	}

	#handleTeardownError(action: "close" | "restart", error: unknown): void {
		this.#abandonClose();
		const detail = error instanceof Error ? error.message : String(error);
		// Arm the escape hatch only once dispose() has begun: its promise is
		// memoized, so a retry can only re-fail. A failure BEFORE dispose (a
		// transient BTW/live-command flush) leaves the session undisposed and
		// the teardown genuinely retryable, so it must not force-quit.
		this.#teardownFailed = this.session.isDisposed;
		this.showError(
			this.#teardownFailed
				? `Could not ${action} session: ${detail}\nPress ${actionKey("app.clear", this.keybindings)} again to exit without saving the session log.`
				: `Could not ${action} session: ${detail}`,
		);
	}

	/**
	 * Apply `worktree.onExit` to worktrees this launch created and return the ones
	 * to remove after teardown. Stops the agent turn and live commands first so the
	 * prompts describe a worktree nothing is still writing to. Never throws.
	 */
	async #planOwnedWorktreeExit(signal: AbortSignal): Promise<WorktreeExitPlan[]> {
		const policy = cfgWorktreeOnExit.get(this.settings);
		if (policy === "keep") return [];
		const owned: SessionWorktree[] = [];
		for (const worktree of this.#ownedWorktrees) {
			if (this.#worktreesInHook.has(worktree)) {
				this.showWarning(`Kept worktree ${shortenPath(worktree.path)}: its post-checkout hook is still running.`);
			} else {
				owned.push(worktree);
			}
		}
		if (owned.length === 0) return [];
		this.#abortLoopCondition();
		this.#cancelLoopAutoSubmit();
		try {
			await this.session.abort();
			await this.#liveCommandController.stop();
		} catch (err) {
			this.showWarning(err instanceof Error ? err.message : String(err));
		}
		return planWorktreeExit(
			owned,
			policy,
			(title, message) => this.showHookConfirm(title, message, { signal }),
			message => this.showWarning(message),
		);
	}

	/**
	 * Tear down like {@link shutdown}, then relaunch the CLI with the original
	 * launch argv (session-source flags and positional prompts stripped, see
	 * {@link restartArgv}), restoring this session (`--restore`) when it exists on
	 * disk: subagents the teardown cut off mid-turn go on in the new process.
	 *
	 * Refuses to close the session if its working directory has been removed.
	 *
	 * On POSIX the relaunch is a true `execvp(3)` image replacement: same PID,
	 * same terminal, no lingering parent. Postmortem cleanups and stdout are
	 * flushed first because nothing in this process runs after a successful
	 * exec. On Windows (no exec semantics) or on exec failure, falls back to
	 * spawning the replacement and lingering only to forward its exit code.
	 */
	async restart(): Promise<void> {
		if (this.#isShuttingDown) return;
		try {
			// Bun can return a cached process.cwd() after the directory is unlinked.
			await fs.realpath(".");
		} catch (error) {
			if (!isEnoent(error)) throw error;
			if (!this.#isShuttingDown) {
				this.showError("Could not restart: the working directory no longer exists. Run /move <dir> first.");
			}
			return;
		}
		if (this.#isShuttingDown) return;
		this.#beginClose();
		try {
			await this.#teardown();
		} catch (error) {
			this.#handleTeardownError("restart", error);
			return;
		}

		const sessionFile = this.sessionManager.isSessionOnDisk() ? this.sessionManager.getSessionFile() : undefined;
		// Pass the profile explicitly: native exec does not inherit Bun's process.env updates.
		const activeProfile = getActiveProfile();
		const cmd = [
			...resolveRestartCmd(),
			...restartArgv(
				process.argv.slice(2),
				sessionFile ? path.resolve(sessionFile) : undefined,
				activeProfile ? { "--profile": true } : undefined,
			),
		];
		if (activeProfile) cmd.push("--profile", activeProfile);
		await postmortem.cleanup();
		await postmortem.drainStdout();
		if (process.platform !== "win32") {
			try {
				const env: Record<string, string> = {};
				for (const key in process.env) {
					const value = process.env[key];
					if (value !== undefined) env[key] = value;
				}
				execReplace(cmd[0], cmd, env, []); // never returns on success
			} catch (err) {
				process.stderr.write(`${chalk.red(`Restart exec failed: ${err instanceof Error ? err.message : err}`)}\n`);
			}
		}
		try {
			const child = Bun.spawn(cmd, {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			await postmortem.quit(await child.exited);
		} catch (err) {
			process.stderr.write(`${chalk.red(`Restart spawn failed: ${err instanceof Error ? err.message : err}`)}\n`);
			await postmortem.quit(1);
		}
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

	/**
	 * Claim the one-shot `shutdown()`/`restart()` close and acknowledge it before
	 * any await: worktree exit planning, live commands, and BTW history writes can
	 * all stall, and the user must see a reason for the pause.
	 */
	#beginClose(): AbortSignal {
		this.#isShuttingDown = true;
		this.#closeAttempt = new AbortController();
		this.showStatus("Closing session…");
		return this.#closeAttempt.signal;
	}

	/** Return to a usable session after a close attempt was refused or failed. */
	#abandonClose(): void {
		this.#isShuttingDown = false;
		this.#closeAttempt = undefined;
	}

	/** Shared `shutdown()`/`restart()` teardown: dispose the session and hand the terminal back. */
	async #teardown(): Promise<void> {
		// An in-flight loop condition (or a deferred auto-submit timer) must not
		// outlive session disposal: an unaborted `sleep 30`-style condition can
		// resolve mid-teardown and drive `#passesLoopCondition` into invoking the
		// pending input callback against a session that is already disposing.
		this.#abortLoopCondition();
		this.#cancelLoopAutoSubmit();

		// `#beginClose()` already acknowledged the close; escalate only once the
		// teardown itself lingers, so time spent in exit prompts never counts.
		const stillClosingTimer = setTimeout(() => {
			this.showStatus("Still closing… (flushing memory backend / network)");
		}, STILL_CLOSING_DELAY_MS);
		try {
			this.#streamPublisher?.dispose();
			this.#streamPublisher = undefined;
			await this.#recorder?.stop();
			this.#recorder = undefined;
			// Guests get goodbye and the registry entry disappears before the
			// session is disposed, under the same still-closing progress notice.
			await this.collabController.shutdown("host exited");
			await this.#liveCommandController.stop();
			await this.#btwController.dispose();
			this.#omfgController.dispose();
			this.#cleanseController.dispose();
			this.#focusController.dispose();

			// Persist the draft and dispose the session through the shared teardown
			// so a signal that arrives mid-shutdown cannot fire a second dispose.
			// The teardown is a promise-memoized singleton; whichever path calls it
			// first runs the work, the other awaits the same settled promise.
			// The teardown is registered lazily in `init()` — a `/exit` reached
			// before `init()` completed falls back to a direct dispose.
			if (this.#signalTeardown) {
				await this.#signalTeardown();
			} else {
				await this.session.dispose({
					mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS,
				});
			}
		} finally {
			clearTimeout(stillClosingTimer);
		}

		// Do not force a final render during teardown: disposed session/UI state can
		// collapse to an empty frame, clearing the viewport and leaving the parent
		// shell prompt at row 0. Stop from the last committed frame so the terminal
		// hands Bash the cursor immediately after visible OMP content.
		// Stop the run-state spinner interval BEFORE restoring the shell title, so a
		// pending tick cannot re-emit an OSC title after `popTerminalTitle` hands the
		// terminal back (which would leave the parent shell with a `π ⠋ …` tab).
		disposeTerminalTitleState();
		disposeProgramStatus();
		popTerminalTitle();
		this.stop();
		// The driver drains in-flight key releases and restores the terminal before the shell gets it.
		await this.shell.stop();
	}

	requestShutdown(): void {
		this.shutdownRequested = true;
		// Background extensions do not submit terminal input. Start the same
		// settled-boundary check without waiting for another user keystroke.
		void this.checkShutdownRequested().catch(error => {
			this.showError(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	/** True while a foreground submission is accepted but not yet handed to the session. */
	hasPendingSubmission(): boolean {
		return this.#pendingSubmittedInput !== undefined;
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested || this.isShuttingDown) return;
		// Quiesce in a loop: an admitted submission that settles may have started a turn
		// whose recovery work waitForIdle() must observe again before the final decision.
		for (;;) {
			await this.session.waitForIdle();
			if (!this.session.hasAdmittedSubmission) break;
			await this.session.waitForAdmittedSubmissions();
		}
		// No await between this check and shutdown(): the decision and the start of
		// teardown share one microtask, so nothing can be admitted in between.
		if (
			this.isShuttingDown ||
			this.hasPendingSubmission() ||
			this.session.hasAdmittedSubmission ||
			this.session.isStreaming ||
			this.session.queuedMessageCount > 0 ||
			this.session.isRunActive
		) {
			return;
		}
		await this.shutdown({ cancellable: false });
	}

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#toolUiContextSetter(uiContext, hasUI);
	}

	// UI helpers
	present(factory: () => JSXNode, options?: PresentOptions): TranscriptBlock {
		const transcript = this.shell.transcript;
		const block = options?.before
			? transcript.insertBefore(options.before, factory, options)
			: transcript.append(factory, options);
		if (!options?.live) transcript.settle(block);
		return block;
	}

	presentAssistant(message?: AssistantMessage, options?: PresentAssistantOptions): AssistantView {
		return this.#presenter.presentAssistant(message, options);
	}

	createTranscriptReplica(entries: readonly TranscriptEntryLike[]): TranscriptReplica {
		return new TranscriptReplica(
			{
				mode: this,
				shell: this.shell,
				display: this.#display,
				messages: this.#messageEnv,
				replaySteps: (target, context) => this.#uiHelpers.replaySteps(target, context),
			},
			entries,
		);
	}

	presentMessage(
		message: AgentMessage,
		options?: {
			readonly imageLinks?: readonly (string | undefined)[];
			readonly live?: boolean;
			readonly before?: TranscriptBlock;
		},
	): TranscriptBlock | undefined {
		return this.#presenter.presentMessage(message, options);
	}

	presentToolCall(spec: ToolCallSpec, options?: { readonly before?: TranscriptBlock }): PendingTool {
		return this.#presenter.presentToolCall(spec, options);
	}

	presentReadGroup(options?: { readonly before?: TranscriptBlock }): PendingTool {
		return this.#presenter.presentReadGroup(options);
	}

	presentExecRun(
		run: ExecRun,
		options?: { readonly deferred?: boolean; readonly recorded?: BashExecutionMessage | PythonExecutionMessage },
	): ExecRunPresentation {
		return this.#presenter.presentExecRun(run, options);
	}

	transcriptEntry(block: TranscriptBlock): TranscriptEntry | undefined {
		return this.#presenter.transcriptEntry(block);
	}

	showWorking(kind: WorkingKind, spec: WorkingSpec): void {
		this.#working.show(kind, spec);
		this.#syncComposerState();
	}

	clearWorking(kind?: WorkingKind): boolean {
		const cleared = this.#working.clear(kind);
		// Whatever took the row down (the turn's own submission, an error, a maintenance step), a run
		// that yielded and still waits on outside work gets its row back naming the wait.
		if (cleared) this.#eventController.restoreAsyncWait();
		// Synced even when another path took the row down first: the composer's Stop also follows
		// `session.isStreaming`, which a stopped turn clears only after its submission returned.
		this.#syncComposerState();
		return cleared;
	}

	ensureWorkingRow(): void {
		this.#working.ensureTurn();
		this.#syncComposerState();
	}

	interceptInput(handler: InputInterceptor): () => void {
		return this.shell.interceptInput(handler);
	}

	addGlobalKeyHandler(handler: (key: KeyEvent) => boolean): () => void {
		return this.shell.addGlobalKeyHandler(handler);
	}

	async suspend<R>(run: () => Promise<R>): Promise<R> {
		const host = this.shell.host;
		if (!host) return await run();
		try {
			return await host.suspend(async () => {
				// The terminal is the other program's now: a Tern tab without a surface gets the rows title.
				setTerminalTitleHandoff(true);
				return await run();
			});
		} finally {
			// Back on our surface (the title follows its reopening); the handoff left enhanced paste off
			// with the other input modes.
			setTerminalTitleHandoff(false);
			this.#inputController.enableEnhancedPaste();
		}
	}

	/** The terminal's busy indicator (OSC 9;4; the driver keeps it alive where terminals drop it). */
	setTerminalProgress(busy: boolean): void {
		this.shell.host?.driver.setProgress(busy);
	}

	/**
	 * Show `factory` in the composer's place: it becomes the shell's home focus while open, so a
	 * closing overlay or `shell.focus(null)` lands on the visible prompt (#3349). A newer dialog
	 * replaces it; closing puts the composer back.
	 */
	showEditorAreaDialog(factory: () => JSXNode, options?: OverlayOptions): OverlayHandle {
		this.#editorAreaDialog?.close();
		const view = mountNode(factory, "An editor-area dialog");
		const frame = this.#frame;
		let closed = false;
		const handle: OverlayHandle = {
			node: view.node,
			get closed() {
				return closed;
			},
			close: () => {
				if (closed) return;
				closed = true;
				if (this.#editorAreaDialog === handle) this.#editorAreaDialog = undefined;
				const focused = this.shell.focused();
				const held = focused !== null && (focused === view.node || within(focused, view.node));
				if (frame.editorArea.peek() === view.node) {
					frame.editorArea.set(undefined);
					this.shell.setHome(this.composer.field);
				}
				view.dispose();
				if (held) this.shell.focus(null);
				options?.onClose?.();
			},
		};
		this.#editorAreaDialog = handle;
		frame.editorArea.set(view.node);
		this.shell.setHome(view.node);
		const focus = options?.focus ?? true;
		if (focus) this.shell.focus(focus === true ? view.node : focus(view.node));
		return handle;
	}

	/**
	 * Defer transcript command panels while the agent is streaming, then mount them at the next
	 * settle, terminal or not. A non-terminal settle is only a scheduling pause, so resumed
	 * streaming can still land below a panel flushed there; that beats leaving it queued behind a
	 * command the user runs during the pause, which mounts at once and would put the older panel
	 * out of order.
	 *
	 * The deferral shows in the `deferredCommand` slot above the editor, not in the transcript: a
	 * mid-turn mount changes the live frame while streaming. A Tern surface has no append-only
	 * scrollback to duplicate into, so there the panel mounts in the transcript at once.
	 */
	presentCommandOutput(factory: () => JSXNode, options?: BlockOptions & { readonly live?: boolean }): void {
		if (!this.session.isStreaming || this.shell.native()) {
			this.present(factory, options);
			return;
		}
		const sessionId = this.sessionManager.getSessionId();
		if (this.#pendingCommandOutput.length > 0 && this.#pendingCommandOutputSessionId !== sessionId) {
			this.#pendingCommandOutput = [];
			this.#pendingCommandOutputCommands = 0;
		}
		this.#pendingCommandOutputSessionId = sessionId;
		this.#pendingCommandOutput.push(options ? { factory, options } : { factory });
		this.#pendingCommandOutputCommands += 1;
		this.#syncDeferredCommandPreview();
	}

	/** Preview the queued panels above the editor so a command answers at once; cleared when they enter the transcript. */
	#syncDeferredCommandPreview(): void {
		const deferred = this.hud.deferred;
		batch(() => {
			deferred.panels.set(this.#pendingCommandOutput.map(item => item.factory));
			deferred.commands.set(this.#pendingCommandOutputCommands);
		});
	}

	/** Mount every command panel queued for the current session while the agent was streaming. */
	flushPendingCommandOutput(): void {
		if (this.#pendingCommandOutput.length === 0) return;
		const pending = this.#pendingCommandOutput;
		const pendingSessionId = this.#pendingCommandOutputSessionId;
		this.#pendingCommandOutput = [];
		this.#pendingCommandOutputSessionId = undefined;
		this.#pendingCommandOutputCommands = 0;
		this.#syncDeferredCommandPreview();
		if (pendingSessionId !== this.sessionManager.getSessionId()) return;
		for (const item of pending) this.present(item.factory, item.options);
	}

	/**
	 * The Spotlight sheet of a shaped tool result (its notice's action): the original, loaded from the
	 * session artifact its trace names, beside the text the model saw; for a held-out or gated result,
	 * beside the would-be text its `shapedUrl` names. One at a time; Esc closes it.
	 */
	async #showSpotlightSheet(spotlight: SpotlightDetails, reduced: string): Promise<void> {
		if (this.#spotlightSheetHandle || !hasSpotlightOriginal(spotlight)) return;
		const sessionManager = this.viewSession.sessionManager;
		const original = await readArtifactText(sessionManager, spotlight.original.url);
		if (original === null) {
			this.showWarning(`The original of this result is gone (${spotlight.original.url}).`);
			return;
		}
		if (spotlight.holdout || spotlight.gated) {
			const shapedUrl = spotlight.original.shapedUrl;
			const shaped = shapedUrl ? await readArtifactText(sessionManager, shapedUrl) : null;
			if (shaped === null) {
				this.showWarning(`The would-be text of this held-out result is gone (${shapedUrl ?? "never saved"}).`);
				return;
			}
			reduced = shaped;
		}
		if (this.#spotlightSheetHandle) return;
		this.#spotlightSheetHandle = showSheet(
			this.shell,
			spotlightOverlay(spotlight),
			() =>
				jsx(SpotlightSheet, { spotlight, original, reduced, onClose: () => this.#spotlightSheetHandle?.close() }),
			{ onClose: () => this.#onSheetClosed("spotlight") },
		);
	}

	showSessionInfo(info: string, context?: ContextUsage): void {
		this.#hideSessionInfo();
		this.#sessionInfoOverlayHandle = showSheet(
			this.shell,
			SESSION_INFO_SHEET,
			() =>
				jsx(SessionInfo, {
					report: info,
					theme: currentTheme(),
					...(context ? { context } : {}),
					rows: () => this.shell.size().rows,
					onClose: () => this.#hideSessionInfo(),
					onCopy: (text: string) => void this.#copyToClipboardWithStatus(text),
				}),
			{ onClose: () => this.#onSheetClosed("info") },
		);
	}

	async #copyToClipboardWithStatus(text: string): Promise<void> {
		try {
			await copyToClipboard(text);
			this.showStatus("Copied to clipboard");
		} catch (error) {
			this.showWarning(`Failed to copy: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * The jobs pill's sheet: live background jobs in a dismissable overlay.
	 * Unlike `/jobs` it adds nothing to the transcript, so a click mid-turn
	 * leaves no deferred command preview above the editor.
	 *
	 * It lists the viewed session's jobs and its subagents' as a tree. A focused
	 * subagent view opens it without the Cancel action: the view only watches
	 * that agent, as `/jobs kill` stays main-session only. `selected` opens it
	 * on that job (a tray card's), when the sheet lists it.
	 */
	showJobsSheet(selected?: string): void {
		if (this.#jobsSheetHandle) return;
		const session = this.viewSession;
		if (!session.getAsyncJobTree()) {
			this.showWarning("Async background jobs are unavailable in this session.");
			return;
		}
		// Output tails and pids change without events: the sheet reads the session again on this tick.
		const tick = signal(0);
		this.#jobsSheetTimer = setInterval(() => tick.set(tick.peek() + 1), JOBS_SHEET_REFRESH_MS);
		this.#jobsSheetHandle = showSheet(
			this.shell,
			JOBS_SHEET,
			() =>
				jsx(JobsPanel, {
					source: {
						load: () => session.getAsyncJobTree() ?? { running: [], recent: [] },
						inspect: (id: string) => session.inspectAsyncJob(id),
						...(this.focusedAgentId
							? {}
							: {
									cancel: (id: string) => {
										session.cancelAsyncJob(id);
										tick.set(tick.peek() + 1);
									},
								}),
						close: () => this.#jobsSheetHandle?.close(),
					},
					...(selected ? { selected } : {}),
					refresh: tick,
				}),
			{ onClose: () => this.#onSheetClosed("jobs") },
		);
	}

	/**
	 * A sheet closed (its own close, Esc, or a replacement): forget its handle and hand keys back to
	 * the visible editor-area owner, not the composer: an extension ask or hook may have taken the
	 * editor area while the sheet was open (same stale-focus class as #3349).
	 */
	#onSheetClosed(sheet: "info" | "jobs" | "spotlight"): void {
		if (sheet === "info") this.#sessionInfoOverlayHandle = undefined;
		else if (sheet === "spotlight") this.#spotlightSheetHandle = undefined;
		else {
			this.#jobsSheetHandle = undefined;
			clearInterval(this.#jobsSheetTimer);
			this.#jobsSheetTimer = undefined;
		}
		this.#selectorController.focusActiveEditorArea();
	}

	#hideSessionInfo(): void {
		this.#sessionInfoOverlayHandle?.close();
	}

	resetTranscript(): void {
		this.transcriptBlocks = new WeakMap();
		this.#frame.welcomeBlock = undefined;
		this.#headerBlocks = [];
		this.shell.transcript.clear();
		// The header stands over every session: the welcome card and what follows it come back.
		this.#frame.showWelcome();
		this.#syncHeaderExtras();
		this.#commandController.clearCommandReport();
	}

	showStatus(message: string, options?: ShowStatusOptions): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.#pendingSubmissionPreservesDraft = false;
		this.clearOptimisticUserMessage();
		this.#working.setMessage();
		this.clearWorking("turn");
		this.#uiHelpers.showError(message);
	}

	showPinnedError(message: string): void {
		this.#hidePlanReview();
		this.shell.dock
			.slot("errorBanner")
			.set(() => jsx(ErrorBanner, { message, onDismiss: () => this.clearPinnedError() }));
	}

	clearPinnedError(): void {
		this.shell.dock.slot("errorBanner").set(undefined);
	}

	showWarning(message: string, options?: { hideWithToolActivity?: boolean }): void {
		this.#uiHelpers.showWarning(message, options);
	}

	#handleLspStartupEvent(event: LspStartupEvent): void {
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

	/**
	 * Redraw the header under the welcome card: the current config warnings (rebuilt when they
	 * change, #10048), then the startup changelog. Settled at once, like the card.
	 */
	#syncHeaderExtras(): void {
		const transcript = this.shell.transcript;
		for (const block of this.#headerBlocks) transcript.remove(block);
		this.#headerBlocks = [];
		const factories: (() => JSXNode)[] = this.session.configWarnings.map(
			warning => () => jsx(AnsiText, { text: `${currentTheme().fg("warning", `Warning: ${warning}`)}\n`, padX: 1 }),
		);
		if (this.#headerAfter) factories.push(this.#headerAfter);
		if (factories.length === 0) return;
		// Right under the welcome card (or at the top without one), above everything since.
		const blocks = transcript.blocks();
		const welcome = this.#frame.welcomeBlock;
		const anchor = welcome ? blocks[blocks.indexOf(welcome) + 1] : blocks[0];
		for (const factory of factories) {
			const block = anchor
				? transcript.insertBefore(anchor, factory, { head: true })
				: transcript.append(factory, { head: true });
			transcript.settle(block);
			this.#headerBlocks.push(block);
		}
	}

	/**
	 * Set the working row's label; no argument restores the default. A function
	 * label is live — re-read on every frame — and kept to one row.
	 */
	setWorkingMessage(message?: string | (() => string)): void {
		this.#working.setMessage(message);
	}

	applyPendingWorkingMessage(): void {
		this.#working.applyPending();
	}

	showNewVersionNotification(newVersion: string): void {
		this.#uiHelpers.showNewVersionNotification(newVersion);
	}

	/** Show (or with `null`, clear) background auto-update progress after the welcome banner's version. */
	showVersionUpdate(update: VersionUpdate | null): void {
		this.#frame.welcome.update.set(update);
	}

	/**
	 * Add this launch's release notes below the welcome header. Startup calls it
	 * after the first session-bound frame; quiet startup and hidden mode show nothing.
	 */
	showStartupChangelog(selection: StartupChangelogSelection): void {
		const mode = cfgStartupChangelogMode.get(settings);
		if (cfgStartupQuiet.get(settings) || mode === "hidden") return;
		const notes =
			mode === "summary"
				? (): JSXNode =>
						jsx(AnsiText, {
							text: formatStartupChangelogSummary(selection).replace(/\/changelog(?: full)?/g, command =>
								bold(command),
							),
							padX: 1,
						})
				: (): JSXNode => jsx("md", { text: selection.markdown?.trim() ?? "" });
		this.#headerAfter = () =>
			jsx("col", {
				role: "omp.changelog",
				children: [
					jsx("rule", {}),
					jsx(AnsiText, { text: `${bold(currentTheme().fg("accent", "What's New"))}\n`, padX: 1 }),
					notes(),
					jsx(AnsiText, { text: " " }),
					jsx("rule", {}),
				],
			});
		this.#syncHeaderExtras();
	}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	queueCompactionMessage(
		text: string,
		mode: "steer" | "followUp",
		images?: ImageContent[],
		options?: { preserveDraft?: boolean },
	): void {
		this.#uiHelpers.queueCompactionMessage(text, mode, images, options);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
	}

	runYieldCompaction(): void {
		if (!this.yieldCompaction) return;
		// Not awaited by callers: the compaction outlives the event dispatch or submission that starts it.
		void this.#commandController.runYieldCompaction().catch(error => {
			logger.warn("Queued compaction failed", { error: String(error) });
		});
	}

	flushPendingExecRuns(): void {
		this.#presenter.flushPendingExecRuns();
	}

	clearPendingExecRuns(): void {
		this.#presenter.clearPendingExecRuns();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(
		message: AgentMessage,
		options?: {
			imageLinks?: readonly (string | undefined)[];
			live?: boolean;
		},
	): TranscriptBlock[] {
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

	async renderInitialMessages(options?: RenderInitialMessagesOptions): Promise<void> {
		// A focus switch replays another session's transcript: claim that session's link schemes first.
		this.#applyExtensionLinks();
		this.#applyTranscriptPresenters();
		await this.#uiHelpers.renderInitialMessages(options);
		void this.#btwController.placeNotes();
		this.syncRetryHintRow();
		// A switch or tree move that replays the transcript strands a `/compact` queued for the old position.
		this.#inputController.releaseStaleYieldCompaction();
	}
	/**
	 * Reconcile the idle "F5 to Retry" status row with the transcript tail: shown when the last
	 * turn died on a tool call (Esc mid-execution, stream failure) and no working row holds the
	 * status row, gone when stale. Runs at turn end and after every transcript replay (startup
	 * resume, `/tree`, session switch).
	 */
	syncRetryHintRow(): void {
		this.#working.syncRetryHint();
	}

	truncateTranscriptFromMessage(message: AgentMessage): boolean {
		return this.#uiHelpers.truncateTranscriptFromMessage(message);
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
	handleTraceCommand(): Promise<void> {
		return this.#commandController.handleTraceCommand();
	}

	async handleDumpCommand(): Promise<void> {
		return this.#commandController.handleDumpCommand();
	}

	async handleDumpAllCommand(): Promise<void> {
		return this.#commandController.handleDumpAllCommand();
	}

	async handleDumpAnonCommand(): Promise<void> {
		return this.#commandController.handleDumpAnonCommand();
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

	handleJobsCommand(options?: { full?: boolean }): Promise<void> {
		return this.#commandController.handleJobsCommand(options);
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	async handleChangelogCommand(args = ""): Promise<void> {
		await this.#commandController.handleChangelogCommand(args);
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

	async prepareSessionSwitch(): Promise<void> {
		this.#clearJudgmentBatchProgress();
		await this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#cleanseController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.clearPinnedError();
		this.#hidePlanReview();
	}

	async handleClearCommand(): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		await this.prepareSessionSwitch();
		await this.#commandController.handleClearCommand();
	}

	/**
	 * User-initiated `/new` (slash command and `app.session.new`): starts a new
	 * session like {@link handleClearCommand}, then honors `plan.defaultOnStartup`
	 * as launch does. Internal resets keep calling handleClearCommand directly.
	 */
	async handleNewCommand(): Promise<void> {
		const previousSessionId = this.sessionManager.getSessionId();
		await this.handleClearCommand();
		if (this.sessionManager.getSessionId() === previousSessionId) return;
		await this.#applyPlanModeDefault();
	}

	handleFreshCommand(): Promise<void> {
		return this.#commandController.handleFreshCommand();
	}

	handleResetContextCommand(): Promise<void> {
		return this.#commandController.handleResetContextCommand();
	}

	async handleDeleteCommand(): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		await this.prepareSessionSwitch();
		await this.#commandController.handleDeleteCommand();
	}

	async handleForkCommand(placement?: "pane" | "window"): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		if (!placement) {
			await this.#btwController.dispose();
			this.#omfgController.dispose();
			this.#cleanseController.dispose();
		}
		await this.#commandController.handleForkCommand(placement);
	}

	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		await this.#commandController.handleMoveCommand(targetPath);
	}

	async handleWorktreeCommand(branch?: string, options?: { keepChanges?: boolean }): Promise<void> {
		if (this.#vibeSessionTransitionBlocked()) return;
		const worktree = await this.#commandController.handleWorktreeCommand(branch, options);
		if (!worktree) return;
		this.#ownedWorktrees.push(worktree);
		this.#worktreesInHook.add(worktree);
		try {
			await this.#commandController.runWorktreeHook(worktree);
		} finally {
			this.#worktreesInHook.delete(worktree);
		}
	}

	/**
	 * Whether {@link maybeAutoCreateWorktree} may stop to ask the user (`worktree.onStart: ask`).
	 * It answers before the async git check, so it also says yes in a folder where the question
	 * never shows.
	 */
	mayAskForStartupWorktree(): boolean {
		return cfgWorktreeOnStart.get(this.settings) === "ask";
	}

	/**
	 * Apply `worktree.onStart` to a fresh launch: optionally move the session into
	 * a new worktree forked from clean `HEAD`. Silent no-op outside git checkouts;
	 * failures become a warning so startup continues.
	 */
	async maybeAutoCreateWorktree(): Promise<void> {
		try {
			if (
				cfgWorktreeOnStart.get(this.settings) === "off" ||
				!(await canAutoCreateWorktree(this.sessionManager.getCwd(), this.settings))
			)
				return;
			if (
				this.mayAskForStartupWorktree() &&
				!(await this.showHookConfirm(
					"Create a worktree for this session?",
					"Work happens on a new wt/* branch; this checkout stays untouched.",
				))
			) {
				return;
			}
			await this.handleWorktreeCommand(undefined, { keepChanges: false });
		} catch (err) {
			this.showWarning(`Worktree not created: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	withBtwSessionMove(operation: () => Promise<boolean>): Promise<boolean> {
		return this.#btwController.withSessionMove(operation);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	async handleSTTToggle(): Promise<void> {
		await this.#readySTTController()?.toggle(this.composer, this.#dictationCallbacks(this.composer));
	}

	/** The composer microphone: start a draft-only capture, or stop (or cancel the start of) the running one. */
	async #toggleComposerDictation(): Promise<void> {
		if (this.#dictationStarting || this.#sttController?.state === "recording") {
			await this.#sttController?.stop();
			return;
		}
		if (this.#sttController?.state === "transcribing") return;
		const controller = this.#readySTTController();
		if (!controller) return;
		this.#dictationStarting = true;
		if (this.#frame.dictation.peek() !== undefined) this.#frame.dictation.set("starting");
		try {
			await controller.start(this.composer, { ...this.#dictationCallbacks(this.composer), manualSubmit: true });
		} finally {
			this.#dictationStarting = false;
			// A start that failed or was cancelled reports no state of its own.
			if (this.#frame.dictation.peek() === "starting") this.#frame.dictation.set(controller.state);
		}
	}

	dictationSpaceHold(target: DictationTarget): SpaceHoldHandler {
		return {
			enabled: () => cfgSttEnabled.get(settings),
			onStart: () => void this.#readySTTController()?.start(target, this.#dictationCallbacks(target)),
			onEnd: () => void this.#sttController?.stop(),
		};
	}

	/** The speech-to-text controller, created on first use; undefined (after a warning) while live mode
	 *  or a disabled STT rules dictation out. */
	#readySTTController(): STTController | undefined {
		if (this.#liveCommandController.active) {
			this.showWarning("End live mode before using push-to-talk speech input.");
			return undefined;
		}
		if (!cfgSttEnabled.get(settings)) {
			this.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return undefined;
		}
		this.#sttController ??= new STTController({
			settings: this.settings,
			registry: this.session.modelRegistry,
			getSessionId: () => this.session.sessionId,
			getSessionProvider: () => this.session.model?.provider,
		});
		return this.#sttController;
	}

	/** Callbacks for a capture dictating into `target`: the mic glyph replaces its cursor while the
	 *  capture runs. */
	#dictationCallbacks(target: DictationTarget): SttCallbacks {
		return {
			showWarning: (msg: string) => this.showWarning(msg),
			showStatus: (msg: string) => this.showStatus(msg),
			onStateChange: (state: SttState) => {
				// Duck assistant speech while the user is talking (push-to-talk); restore after.
				if (state === "recording") vocalizer.duck();
				else vocalizer.unduck();
				if (this.#frame.dictation.peek() !== undefined) this.#frame.dictation.set(state);
				if (state === "recording") {
					this.#micCursor?.dispose();
					this.#micCursor = new MicCursor(target);
				} else if (state === "transcribing") {
					this.#micCursor?.showTranscribing();
				} else {
					this.#micCursor?.dispose();
					this.#micCursor = undefined;
				}
			},
		};
	}

	/** Start a `/record` screen capture, or stop the running one and report where it was saved. */
	async toggleRecording(): Promise<void> {
		const active = this.#recorder;
		if (active) {
			this.#recorder = undefined;
			const elapsed = active.elapsedMs;
			await active.stop();
			this.statusLine.setModes({ recording: false });
			this.showStatus(
				`Saved ${formatDuration(elapsed)} recording to ${active.path} · replay: omp play · share: omp clip`,
			);
			return;
		}
		if (this.#recorderStarting) return;
		this.#recorderStarting = true;
		const cwd = this.sessionManager.getCwd();
		try {
			this.#recorder = await SessionRecorder.start({
				frames: this.#frameSource(),
				redactor: await StreamRedactor.load(cwd, cfgStreamRedactPatterns.get(this.settings)),
				title: this.sessionManager.getSessionName() || path.basename(cwd),
				path: newRecordingPath(this.sessionManager.getSessionId()),
			});
		} catch (error) {
			this.showError(`Could not start recording: ${error instanceof Error ? error.message : String(error)}`);
			return;
		} finally {
			this.#recorderStarting = false;
		}
		this.statusLine.setModes({ recording: true });
		this.showStatus(`Recording to ${this.#recorder.path} · /record again to stop`);
	}

	/** Why live mode cannot start right now, or `undefined` when it can. */
	#liveStartBlocker(): string | undefined {
		if (this.#dictationStarting || (this.#sttController && this.#sttController.state !== "idle")) {
			return "Finish the current speech-to-text capture before starting live mode.";
		}
		return undefined;
	}

	/** Start or stop the Codex-backed realtime voice surface. */
	async handleLiveCommand(): Promise<void> {
		const blocker = this.#liveStartBlocker();
		if (blocker) {
			this.showWarning(blocker);
			return;
		}
		await this.#liveCommandController.handleCommand();
	}

	/** Start a live session whose audio runs on an extension's own WebRTC peer. */
	async startRemoteLive(options: ExtensionLiveStartOptions): Promise<ExtensionLiveSession> {
		const blocker = this.#liveStartBlocker();
		if (blocker) throw new Error(blocker);
		return await this.#liveCommandController.startRemote(options);
	}

	async showDebugSelector(): Promise<void> {
		await this.#selectorController.showDebugSelector();
	}

	showAgentHub(options?: AgentHubOpenOptions): void {
		// The agents-hub key on a tray host: into the tray while it shows cards, else nothing, as
		// the tray has no hub to fall back to. With its agents turned off, the key opens the hub.
		if (options?.trayFirst && this.#trayShown()) {
			if (this.hud.tray.focusTray() || cfgDisplayPinnedAgents.get(settings) !== "off") return;
		}
		this.#selectorController.showAgentHub(this.#observerRegistry, options, {
			prompt: (act, text, timestamp) => this.#onPromptAction(act, text, timestamp),
			reply: (act, message, copyText) => this.#onTranscriptAction(act, message, copyText),
		});
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
		options?: Pick<CompactOptions, "internalGuidance" | "readerModel">,
	): Promise<CompactionOutcome> {
		return this.#commandController.handleCompactCommand(customInstructions, mode, beforeFlush, options);
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

	showUsageDashboard(reports: UsageReport[]): void {
		this.#selectorController.showUsageDashboard(reports);
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

	switchSessionModel(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void> {
		return this.#selectorController.switchSessionModel(model, thinkingLevel);
	}

	showPluginSelector(mode?: "install" | "uninstall"): Promise<void> {
		return this.#selectorController.showPluginSelector(mode);
	}

	showUserMessageSelector(startAt?: string): void {
		this.#selectorController.showUserMessageSelector(startAt);
	}

	showCopySelector(): void {
		this.#selectorController.showCopySelector();
	}

	showTreeSelector(): void {
		this.#selectorController.showTreeSelector();
	}

	showThinkingSelector(): void {
		this.#selectorController.showThinkingSelector();
	}

	showSessionSelector(source?: ForeignSessionSource): void {
		void this.#selectorController.showSessionSelector(source);
	}

	async handleResumeSession(sessionPath: string, options?: ResumeSessionOptions): Promise<void> {
		await this.#selectorController.handleResumeSession(sessionPath, options);
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

	async showProviderSetup(): Promise<void> {
		const { runProviderSetupWizard } = await import("./setup");
		await runProviderSetupWizard(this);
	}

	showHookConfirm(title: string, message: string, dialogOptions?: InteractiveSelectorDialogOptions): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message, dialogOptions);
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

	/**
	 * Ctrl+L: replay the whole display now, and ask the terminal for its appearance again; a theme
	 * change its answer brings within {@link CTRL_L_APPEARANCE_RESPONSE_DEADLINE_MS} replays once more.
	 */
	resetDisplayAfterAppearanceRefresh(): void {
		const host = this.shell.host;
		if (!host) return;
		this.#appearanceRefreshDeadline = Date.now() + CTRL_L_APPEARANCE_RESPONSE_DEADLINE_MS;
		host.driver.refreshAppearance();
		host.replayHistory();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	restoreCompactionQueueToEditor(status?: string): void {
		this.#inputController.restoreCompactionQueueToEditor(status);
	}

	waitForSubmissionDispatches(): Promise<void> {
		return this.#inputController.waitForSubmissionDispatches();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	handleImagePathPaste(path: string): Promise<void> {
		return this.#inputController.handleImagePathPaste(path);
	}

	/** Queue slash-command input behind the active turn. */
	handleQueueCommand(
		message: string,
		detached?: Pick<SubmittedUserInput, "text" | "images" | "imageLinks">,
	): Promise<void> {
		return this.#inputController.handleQueueCommand(message, detached);
	}

	handleBtwCommand(question: string, images?: ImageContent[], title?: string): Promise<boolean> {
		return this.#btwController.start(question, images, title);
	}

	handleTanCommand(work: string, images?: ImageContent[]): Promise<boolean> {
		return this.#tanCommandController.start(work, images);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	focusAsk(): boolean {
		return this.#extensionUiController.focusAsk();
	}

	get isBtwFocused(): boolean {
		return this.#btwController.isFocused();
	}

	submitBtwFollowUp(question: string, images?: ImageContent[]): Promise<boolean> {
		return this.#btwController.submitFollowUp(question, images);
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

	isGuidedGoalInterviewActive(): boolean {
		return this.#guidedGoalInterviewActive && !this.goalModeEnabled && !this.goalModePaused;
	}

	handleBtwCopyKey(): Promise<boolean> {
		return this.#btwController.handleCopy();
	}

	canFollowUpBtw(): boolean {
		return this.#btwController.canFollowUp();
	}

	handleBtwFollowUpKey(): boolean {
		return this.#btwController.handleFollowUp();
	}

	handleBtwInjectKey(): boolean {
		return this.#btwController.handleInject();
	}

	async handleBtwBranch(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
		images?: ImageContent[],
	): Promise<void> {
		try {
			const result = await this.session.branchFromBtw(question, assistantMessage, leafId, sessionId, images);
			if (result.cancelled) {
				this.showStatus("/btw branch cancelled", { dim: true });
				return;
			}
			await this.#btwController.dispose();
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

	showCommandReport(options: { title: string; head?: TspText; body: () => JSXNode }): void {
		this.#commandController.showCommandReport(options);
	}

	dismissCommandReport(): boolean {
		return this.#commandController.dismissCommandReport();
	}

	commandReportRows(): number | undefined {
		const below = this.shell.rowsBelow("report");
		return below === undefined ? undefined : this.shell.size().rows - below;
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
		this.setTodoExpanded(!this.todoExpanded);
	}

	setTodoExpanded(expanded: boolean): void {
		this.todoExpanded = expanded;
		if (expanded) {
			const owner = this.#todoPhasesOwner ?? this.viewSession;
			this.#cancelTodoAutoClearTimer();
			this.#todoHudHidden = false;
			const appendReveal = (data: TodoHudStateEntryData): void => {
				owner.sessionManager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, data);
			};
			const data = createTodoHudStateData(owner.sessionManager.getBranch(), this.todoPhases, "revealed");
			if (data) {
				try {
					appendReveal(data);
				} catch (error) {
					logger.warn("Failed to persist TODO HUD reveal", { error });
				}
			} else {
				const generation = this.#todoAutoClearGeneration;
				const snapshotKey = JSON.stringify(this.todoPhases);
				const sessionId = owner.sessionManager.getSessionId();
				const sessionFile = owner.sessionManager.getSessionFile();
				void owner
					.settleInFlightMessagePersistence()
					.then(() => {
						if (
							generation !== this.#todoAutoClearGeneration ||
							this.#todoPhasesOwner !== owner ||
							owner.sessionManager.getSessionId() !== sessionId ||
							owner.sessionManager.getSessionFile() !== sessionFile ||
							JSON.stringify(this.todoPhases) !== snapshotKey
						)
							return;
						const settledData = createTodoHudStateData(
							owner.sessionManager.getBranch(),
							this.todoPhases,
							"revealed",
						);
						if (settledData) appendReveal(settledData);
					})
					.catch(error => logger.warn("Failed to persist TODO HUD reveal", { error }));
			}
		}
		this.#renderTodoList();
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
		this.#syncTodoHudState(this.viewSession);
		this.#renderTodoList();
	}

	async reloadTodos(source: AgentViewSession = this.session): Promise<void> {
		await this.#loadTodoList(source);
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
		extra?: { slider?: HookSelectorSlider; kind?: BlockedKind },
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

	showHookCustom<T>(factory: ExtensionCustomFactory<T>, options?: ExtensionCustomOptions): Promise<T> {
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
