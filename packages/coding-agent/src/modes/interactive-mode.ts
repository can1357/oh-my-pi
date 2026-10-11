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
	agentPauseGate,
	EventLoopKeepalive,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Model, Usage, UsageReport } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { execReplace } from "@oh-my-pi/pi-natives";
import type {
	AutocompleteProvider,
	Component,
	EditorTheme,
	KeyId,
	LoaderMessageColorFn,
	OverlayHandle,
	SlashCommand,
} from "@oh-my-pi/pi-tui";
import {
	Container,
	clearRenderCache,
	getComposerStyle,
	getPaddingX,
	getWidthConfigEpoch,
	Loader,
	Markdown,
	Spacer,
	setTerminalTextSizing,
	setTuiTight,
	TERMINAL,
	Text,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type { TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { col, kbd, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { sameItems } from "@oh-my-pi/pi-tui/native/memo";
import { describeSegmentTrack, renderSegmentTrack, type TrackSegment } from "@oh-my-pi/pi-tui/chrome/segment-track";
import type { WorkingRowSpec } from "@oh-my-pi/pi-tui/components/loader";
import { formatDoubleTap } from "@oh-my-pi/pi-tui/key-hint-format";
import { thinkingLevelWord } from "@oh-my-pi/pi-tui/status-line/segments";
import type { TspChecklistItem, TspChecklistPhase, TspSpan, TspText, TspTreeNode } from "@oh-my-pi/pi-wire";
import { isInsideTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-capabilities";
import {
	$env,
	adjustHsv,
	formatDuration,
	formatNumber,
	getProjectDir,
	isEnoent,
	logger,
	postmortem,
	prompt,
	sanitizeText,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { pickTableChart } from "../auto-graph/planner";
import { restartArgv } from "../cli/flag-tables";
import type { CollabGuestLink } from "../collab/guest";
import { CollabController } from "../collab/controller";
import type { CollabHost } from "../collab/host";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { appKey, editorKey, rawKeyHint } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { formatModelString, type ResolvedModelRoleValue } from "../config/model-resolver";
import { isSettingsInitialized, Settings, settings } from "../config/settings";
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
import type { GoalModeState } from "../goals/state";
import { rebindMemoryBackendForCwd } from "../hindsight/backend";
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
import { DownloadActivityHud, JudgmentBatchProgressHud } from "./progress-hud";
import { autosaveApprovedPlan, planSaveFileName } from "../plan-mode/plan-autosave";
import { resolvePlanModelTransition } from "../plan-mode/model-transition";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import planFilenamePrompt from "../prompts/system/plan-filename.md" with { type: "text" };
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with { type: "text" };
import type { AgentHubRegistry } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import type { AgentMetrics } from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import { sumSubagentTreeCost } from "./agent-hub-runtime";
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
import { syncTextPrediction, textPredictionBackend } from "../predict/client";
import { setWordPredictionHost } from "@oh-my-pi/pi-tui/prompt/word-completion";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { resolveMarkdownLinkHrefs } from "../internal-urls/hyperlink-targets";
import type { ResolveContext } from "../internal-urls/index";
import { modelMentionDisplayName } from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import { modelMentionChipLabel, shiftImageMarkers } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import type { SessionContext } from "../session/session-context";
import type { SessionManager } from "../session/session-manager";
import {
	canAutoCreateWorktree,
	planWorktreeExit,
	removeExitWorktrees,
	type SessionWorktree,
	type WorktreeExitPlan,
} from "../session/session-worktree";
import type { ShakeMode } from "../session/shake-types";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, buildTuiBuiltinSlashCommands } from "../slash-commands/builtin-registry";
import { buildStaticInlineHint } from "../slash-commands/builtin-completions";
import { formatCoarseDuration } from "@oh-my-pi/pi-tui/chrome/format";
import { type DictationTarget, MicCursor, type SttCallbacks, STTController, type SttState } from "../stt";
import type { SpaceHoldHandler } from "@oh-my-pi/pi-tui/space-hold";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { labelEchoesHandle } from "../task/label";
import { agentTypeBadge, formatTaskId } from "@oh-my-pi/pi-tui/tools/task";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isMCPToolName } from "../tools/builtin-names";
import type { LspStartupServerInfo } from "../tools";
import { resolvePlanFilePath } from "../plan-mode/plan-files";
import { resolveToCwd } from "../tools/path-utils";
import { StreamPublisher } from "../stream/publisher";
import { newRecordingPath, SessionRecorder } from "../stream/recording";
import { StreamRedactor } from "../stream/redactor";
import {
	FEED_MODEL_BADGE_WIDTH,
	formatFeedModelBadge,
	formatMoreItems,
	isFeedModelBadgeEnabled,
	previewLine,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenToolArgumentPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { setAutoQaConsentHandler } from "../tools/report-tool-issue";
import { type CfgApproval, type CfgChangeRequest, setCfgApprovalHost } from "../internal-urls/cfg-protocol";
import {
	createTodoHudStateData,
	getTodoHudVisibility,
	nextActionableTask,
	TODO_HUD_STATE_CUSTOM_TYPE,
	USER_TODO_EDIT_CUSTOM_TYPE,
	type TodoHudStateEntryData,
} from "../tools/todo";
import {
	formatPhaseDisplayName,
	isClosedTodo,
	selectCollapsedTodos,
	setActiveTodoDescriptionsProvider,
	todoMatchesAnyDescription,
} from "@oh-my-pi/pi-tui/tools/todo";
import { vocalizer } from "../tts/vocalizer";
import { applyHyperlinkSetting, fileHyperlink } from "@oh-my-pi/pi-tui/render/hyperlink";
import { renderTreeList } from "@oh-my-pi/pi-tui/render/tree-list";
import { formatStartupChangelogSummary, type StartupChangelogSelection } from "../utils/changelog";
import { copyToClipboard } from "../utils/clipboard";
import type { EventBus } from "../utils/event-bus";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import { openPath } from "../utils/open";
import { resumeCommand } from "../utils/resume-command";
import { getSessionAccentAnsi, getSessionAccentHex } from "@oh-my-pi/pi-tui/theme/session-color";
import { messageHasDisplayableThinking } from "@oh-my-pi/pi-tui/chat/thinking-display";
import type { TokenRateMeter } from "../utils/token-rate";
import { disposeProgramStatus, initProgramStatus, setProgramStatusEnabled } from "../utils/run-status";
import {
	disposeTerminalTitleState,
	initTerminalTitleState,
	popTerminalTitle,
	pushTerminalTitle,
	reportTernSession,
	setSessionTerminalTitle,
	setTerminalSessionSource,
	setTerminalTitlePullRequest,
	setTerminalTitleSpinnerStyle,
	setTerminalTitleStateEnabled,
} from "../utils/title-generator";
import {
	aggregateVibeWorkerTokensPerSecond,
	type VibeOwnerScope,
	type VibeParentSession,
	VibeSessionRegistry,
} from "../vibe/runtime";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setSvgFigureRendering } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { setTableCharts } from "@oh-my-pi/pi-tui/chat/table-chart";
import { setTranscriptActionHandler } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { AttachmentChipsBand } from "@oh-my-pi/pi-tui/prompt/attachment-chips";
import type { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { ChatBlock, type ChatBlockHost } from "@oh-my-pi/pi-tui/chrome/chat-block";
import { CodexResetFireworksController } from "@oh-my-pi/pi-tui/overlays/codex-reset-fireworks";
import { type ComposerNativeState, CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { DynamicBorder } from "@oh-my-pi/pi-tui/chrome/dynamic-border";
import { EditorTopGap } from "@oh-my-pi/pi-tui/prompt/editor-top-gap";
import { ErrorBannerComponent } from "@oh-my-pi/pi-tui/overlays/error-banner";
import type { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import type { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import type { HookInputComponent } from "@oh-my-pi/pi-tui/overlays/hook-input";
import type { HookSelectorComponent, HookSelectorSlider } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { type PlanReviewAnnotationState, PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { PlanSaveOverlay, type PlanSaveOverlayResult } from "@oh-my-pi/pi-tui/overlays/plan-save-overlay";
import { ServedModelTracker } from "@oh-my-pi/pi-tui/chat/served-model-marker";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { JobsSheet } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { SkillMessageComponent } from "@oh-my-pi/pi-tui/chat/skill-message";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "./status-line-host";
import { stopSharedSpinnerTicker, type ToolExecutionHandle } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import {
	Composer,
	type ComposerPreferences,
	type ComposerStatusCache,
	PINNED_HUD_TOGGLE_ID,
} from "@oh-my-pi/pi-tui/prompt/composer";
import { setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { MAGIC_KEYWORDS } from "./magic-keywords";
import { sharedComposerCache } from "@oh-my-pi/pi-tui/prompt/composer-cache";
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
import { imageReferenceHyperlink } from "@oh-my-pi/pi-tui/prompt/image-references";
import { describeLoopCondition, evaluateLoopCondition, type LoopConditionVerdict } from "./loop-condition";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	isLoopLimitExhausted,
	parseLoopArgs,
} from "./loop-limit";
import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { formatPersistenceNotice } from "./persistence-failure";
import { resolveComposerHint } from "@oh-my-pi/pi-tui/prompt/composer-hints";
import { hintUsage } from "../utils/usage-counter";
import {
	getRunningSubagentBadgeAgentIds,
	getRunningSubagentBadgeRegistry,
} from "@oh-my-pi/pi-tui/overlays/running-subagent-badge";
import {
	type ObservableSession,
	type SessionObserverChangeKind,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { createSessionTeardown, type SessionTeardown } from "./session-teardown";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { invokeSkillCommandFromText, isKnownSkillCommand } from "./skill-command";
import { clearMermaidCache } from "@oh-my-pi/pi-tui/theme/mermaid-cache";
import { type ShimmerPalette, shimmerEnabled, shimmerText } from "@oh-my-pi/pi-tui/theme/shimmer";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import {
	getEditorTheme,
	getMarkdownTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	setMarkdownMermaidRendering,
	setSymbolPreset,
	startMacOSAppearanceReprobeFallback,
	theme,
	warmHighlighter,
} from "@oh-my-pi/pi-tui/theme";
import { getSlashCommandTypeIcon } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type {
	AgentHubOpenOptions,
	CompactionQueuedMessage,
	InteractiveModeContext,
	InteractiveModeInitOptions,
	InteractiveSelectorDialogOptions,
	RenderSessionContextOptions,
	ShowStatusOptions,
	SubmittedUserInput,
} from "./types";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { materializeImageChipLinks, UiHelpers } from "./utils/ui-helpers";

import {
	cfgAutocompleteMaxVisible,
	cfgComposerPredictions,
	cfgComposerShape,
	cfgComposerTokenRate,
	cfgDisplayCacheMissMarker,
	cfgDisplayCollapseCompacted,
	cfgDisplayHideToolActivity,
	cfgDisplayPinnedAgents,
	cfgDisplayShowTokenUsage,
	cfgDisplayShowTurnTime,
	cfgDisplaySubagentLivePreview,
	cfgGitEnabled,
	cfgLoopConditionTimeoutMs,
	cfgLoopMode,
	cfgMagicKeywordsEnabled,
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
	cfgTuiImeSafeCursor,
	cfgTuiMaxInlineImages,
	cfgTuiAutoGraph,
	cfgTuiMouse,
	cfgTuiRenderMermaid,
	cfgTuiRenderSvg,
	cfgTuiResizeScrollback,
	cfgTuiTextSizing,
	cfgTuiTight,
	cfgTuiTitleSpinner,
	cfgTuiTitleState,
	cfgTuiVimMode,
	cfgTuiVimModeDisplay,
} from "./settings";
import { cfgTasksTodoClearDelay } from "../tools/settings";
import { cfgWorktreeOnExit, cfgWorktreeOnStart } from "../task/settings";
import { cfgExpandThinkingBlocks, cfgProseOnlyThinking } from "../session/settings";
import { cfgHideThinkingBlock } from "../session/settings";
import { cfgCycleOrder, cfgModelRoles } from "../config/model-settings";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "../goals/settings";
import { goalContinuationActivity, goalFromModeData } from "../goals/state";
import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "../plan-mode/settings";
import { cfgStreamRedactPatterns } from "../stream/settings";
import { cfgSttEnabled } from "../stt/settings";
import { combine, type SettingValueOf } from "../config/registry";
import { cfgAdvisorEnabled, cfgAdvisorMaxNotesPerUpdate } from "../advisor/settings";
import { cfgTierAdvisor } from "../session/settings";
import {
	cfgCompactionEnabled,
	cfgCompactionIdleEnabled,
	cfgCompactionIdleThresholdTokens,
	cfgCompactionIdleTimeoutSeconds,
	cfgCompactionMethodOrder,
} from "../session/context-settings";

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
	"display.pinnedAgents": cfgDisplayPinnedAgents,
	"display.subagentLivePreview": cfgDisplaySubagentLivePreview,
	"compaction.idleEnabled": cfgCompactionIdleEnabled,
	"compaction.idleThresholdTokens": cfgCompactionIdleThresholdTokens,
	"compaction.idleTimeoutSeconds": cfgCompactionIdleTimeoutSeconds,
	"recap.enabled": cfgRecapEnabled,
	"recap.idleSeconds": cfgRecapIdleSeconds,
	"composer.predictions": cfgComposerPredictions,
	"compaction.enabled": cfgCompactionEnabled,
	"compaction.methodOrder": cfgCompactionMethodOrder,
	"display.hideToolActivity": cfgDisplayHideToolActivity,
	"terminal.showImages": cfgTerminalShowImages,
	"terminal.programStatus": cfgTerminalProgramStatus,
	hideThinkingBlock: cfgHideThinkingBlock,
	proseOnlyThinking: cfgProseOnlyThinking,
	expandThinkingBlocks: cfgExpandThinkingBlocks,
	"display.cacheMissMarker": cfgDisplayCacheMissMarker,
	"display.collapseCompacted": cfgDisplayCollapseCompacted,
	"display.showTokenUsage": cfgDisplayShowTokenUsage,
	"display.showTurnTime": cfgDisplayShowTurnTime,
	"tui.renderMermaid": cfgTuiRenderMermaid,
	"tui.renderSvg": cfgTuiRenderSvg,
	"tui.autoGraph": cfgTuiAutoGraph,
	"tui.textSizing": cfgTuiTextSizing,
	"tui.tight": cfgTuiTight,
	"tui.hyperlinks": cfgTuiHyperlinks,
	"tui.titleState": cfgTuiTitleState,
	"tui.titleSpinner": cfgTuiTitleSpinner,
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
/** Startup emits several status-bar changes within a second; persist only the settled one. */
const COMPOSER_STATUS_PERSIST_DELAY_MS = 1_000;
const DEFAULT_WORKING_MESSAGE = "Working…";
/** Native working-message shimmer under a session accent: the hue itself is the terminal's `accent`. */
const NATIVE_ACCENT_SHIMMER: ShimmerPalette = { low: "dim", mid: "accent", high: "accent", bold: true };

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
	accent.palette ??= {
		low: "dim",
		mid: { ansi: accent.main },
		high: { ansi: accent.main },
		bold: true,
	};
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

/** How long a `cfg://` approval prompt waits for an answer before the write fails as unanswered. */
const CFG_APPROVAL_TIMEOUT_MS = 10_000;
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

export const TODO_COMPACT_TERMINAL_ROWS_THRESHOLD = 18;

/** Holds mutable HUD and editor-adjacent chrome outside transcript history. */
class AnchoredLiveContainer extends Container {}

/** An empty HUD slot: the terminal owns spacing, so nothing is described. */
const EMPTY_HUD: NativeNode = col([]);

/** Renders through an ANSI component and describes as a node built alongside it. */
class DescribedComponent implements Component {
	constructor(
		readonly inner: Component,
		readonly native: NativeNode,
	) {}

	render(width: number): readonly string[] {
		return this.inner.render(width);
	}

	describe(): NativeNode {
		return this.native;
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}
}

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

/**
 * Native-only dock row of HUD pills (§8.1), right-aligned above the activity
 * line: the agents pill and the background-jobs pill. ANSI renders the pinned
 * agent list in its own container and the agent and job counts in the status
 * line, so this row renders nothing.
 */
class HudPillsRow implements Component {
	constructor(private readonly mode: InteractiveMode) {}

	render(): readonly string[] {
		return [];
	}

	describe(): NativeNode {
		return this.mode.describeHudPills();
	}

	/** A click on the agents pill opens the agent hub; one on the jobs pill, the jobs sheet. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "agents.open") this.mode.showAgentHub();
		else if (event.act === "jobs.open") this.mode.showJobsSheet();
	}
}

/** A described running-work pill with the count it shows, so an unchanged count reuses the node. */
interface RunningPill {
	readonly running: number;
	readonly node: NativeNode;
}

/** `prev` while it still shows `running`, else a fresh pill from `describe`; undefined when nothing runs. */
function runningPill(
	prev: RunningPill | undefined,
	running: number,
	describe: (running: number) => NativeNode,
): RunningPill | undefined {
	if (running === 0) return undefined;
	return prev?.running === running ? prev : { running, node: describe(running) };
}

/** What a running-work pill shows and the action a click on it sends to {@link HudPillsRow}. */
interface RunningPillSpec {
	/** Sibling key in the HUD row: the pill keeps its id, and skips its entrance, as the count changes. */
	readonly key: string;
	readonly icon: string;
	/** Singular noun the count reads with (`1 job running`, `2 jobs running`). */
	readonly noun: string;
	readonly title: string;
	readonly act: string;
}

/** Native dock pill (§8.1) counting running work, with a spinner. */
function describeRunningPill(spec: RunningPillSpec, running: number): NativeNode {
	return node(
		"row",
		{ role: "omp.hud.pill", gap: "xs", align: "center", title: spec.title, actions: { click: spec.act } },
		[
			node("icon", { name: spec.icon }, undefined, "icon"),
			node("spinner", { style: "dots", tone: "accent" }, undefined, "spinner"),
			node(
				"text",
				{ text: `${running} ${spec.noun}${running === 1 ? "" : "s"} running`, wrap: "none" },
				undefined,
				"label",
			),
		],
		spec.key,
	);
}

class StatusHudContainer extends AnchoredLiveContainer {
	constructor(private readonly mode: InteractiveMode) {
		super();
	}

	override describe(cx: DescribeContext): NativeNode {
		return this.mode.describeStatusHud(this.children, cx);
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
	#native: NativeNode | undefined;

	constructor(
		private readonly items: readonly Component[],
		private readonly maxRows: number,
		private readonly commandCount: number,
	) {}

	/** The real panels, clamped to the preview height, then the queued-output note. */
	describe(): NativeNode {
		const queued = this.commandCount === 1 ? "1 command output" : `${this.commandCount} command outputs`;
		this.#native ??= col(
			[
				col(this.items, { max: { h: `${this.maxRows}lines` } }),
				text([span(`${queued} — shown in full in the transcript when the agent pauses`, "dim")]),
			],
			{ role: "omp.hud.deferred" },
		);
		return this.#native;
	}

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

/** Active subagent sessions the anchored HUD jump-lists, sync or detached. Slots follow registry order. */
function isHudSubagent(session: ObservableSession): boolean {
	return session.kind === "subagent" && session.status === "active";
}

/**
 * Anchored subagent HUD block with its visible session order, so click-to-focus
 * can map a rendered row back to its agent. Row 0 is the leading blank, row 1
 * the title; item rows follow in `order`; the overflow summary maps nowhere.
 * The expander row (when `layoutPinnedHud` shows one) resolves to the toggle
 * sentinel, which the click router handles before any registry lookup.
 * Rendering delegates to the same `Text` mount as before, so output bytes are
 * unchanged — only the row map is new. Long rows wrap inside `Text` (content
 * is two cells narrower than the terminal), so the map is built on the first
 * click after rendering at a new width or width configuration: continuation
 * rows belong to the agent (or toggle) whose logical row started them.
 */
export class SubagentHudComponent implements Component {
	readonly #text: Text;
	#lines: readonly string[];
	#order: readonly string[];
	#toggleLine: number | undefined;
	#physicalOwner?: (string | undefined)[];
	#renderedWidth?: number;
	#renderedRows = 0;
	#renderedWidthConfigEpoch?: number;
	constructor(lines: readonly string[], order: readonly string[], toggleRow?: number) {
		this.#text = new Text(lines.join("\n"), 1, 0);
		this.#lines = lines;
		this.#order = order;
		this.#toggleLine = toggleRow;
	}

	/** Repaint in place with a new view; the click map rebuilds lazily. */
	update(lines: readonly string[], order: readonly string[], toggleRow: number | undefined): void {
		this.#order = order;
		this.#toggleLine = toggleRow;
		this.#text.setText(lines.join("\n"));
		this.#lines = lines;
		this.#physicalOwner = undefined;
	}
	render(width: number): readonly string[] {
		const rows = this.#text.render(width);
		const widthConfigEpoch = getWidthConfigEpoch();
		if (
			this.#renderedWidth !== width ||
			this.#renderedRows !== rows.length ||
			this.#renderedWidthConfigEpoch !== widthConfigEpoch
		) {
			this.#physicalOwner = undefined;
		}
		this.#renderedWidth = width;
		this.#renderedRows = rows.length;
		this.#renderedWidthConfigEpoch = widthConfigEpoch;
		return rows;
	}
	getClickAgentAtRow(row: number): string | undefined {
		if (row < 0 || row >= this.#renderedRows || this.#renderedWidth === undefined) return undefined;
		if (!this.#physicalOwner) {
			if (this.#renderedWidthConfigEpoch !== getWidthConfigEpoch()) return undefined;
			this.#rebuildHitMap(this.#renderedWidth, this.#renderedRows);
		}
		return this.#physicalOwner?.[row];
	}
	// Native wrap splits paragraphs independently, so per-line wrapped
	// heights compose exactly to the rendered row count. A length mismatch
	// means the wrap contract drifted: fall back to one row per line (the
	// old mapping) rather than misrouting clicks.
	#rebuildHitMap(width: number, renderedRows: number): void {
		const contentWidth = Math.max(1, width - getPaddingX(1) * 2);
		const owner: (string | undefined)[] = [];
		for (let index = 0; index < this.#lines.length; index++) {
			const height = wrapTextWithAnsi(replaceTabs(this.#lines[index]!), contentWidth).length;
			let id: string | undefined;
			if (this.#toggleLine !== undefined && index === this.#toggleLine) id = PINNED_HUD_TOGGLE_ID;
			else {
				const orderIndex = index - 2;
				id = orderIndex >= 0 && orderIndex < this.#order.length ? this.#order[orderIndex] : undefined;
			}
			for (let row = 0; row < height; row++) owner.push(id);
		}
		if (owner.length !== renderedRows) {
			this.#physicalOwner = this.#lines.map((_line, index) => {
				if (this.#toggleLine !== undefined && index === this.#toggleLine) return PINNED_HUD_TOGGLE_ID;
				const orderIndex = index - 2;
				return orderIndex >= 0 && orderIndex < this.#order.length ? this.#order[orderIndex] : undefined;
			});
			return;
		}
		this.#physicalOwner = owner;
	}
}

const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

/** Repaint cadence for live-preview elapsed markers while a subagent tool call runs. */
const SUBAGENT_PREVIEW_TICK_MS = 1000;

/** Item rows a collapsed jump list shows before the expander. */
const SUBAGENT_HUD_COLLAPSED_LIMIT = 3;

/** Pinned jump-list layout: painted item rows plus the expander row. */
export interface PinnedHudLayout {
	/** Item rows painted, in registry order. */
	itemRows: number;
	/** Expander direction, or undefined when the list fits without one. */
	toggle: "expand" | "collapse" | undefined;
	/** Viewport row of the expander within HUD lines (2 header rows + items). */
	toggleRow: number | undefined;
}

/**
 * Pinned jump-list layout for `runningTotal` live agents. Collapsed shows a
 * few rows plus an expander; expanded shows every row plus a collapse row.
 * Single source of truth for the renderer and the click row map, so painted
 * rows and hit-testing can never disagree.
 */
export function layoutPinnedHud(runningTotal: number, expanded: boolean): PinnedHudLayout {
	if (runningTotal <= SUBAGENT_HUD_COLLAPSED_LIMIT) {
		return { itemRows: runningTotal, toggle: undefined, toggleRow: undefined };
	}
	if (!expanded) {
		return {
			itemRows: SUBAGENT_HUD_COLLAPSED_LIMIT,
			toggle: "expand",
			toggleRow: 2 + SUBAGENT_HUD_COLLAPSED_LIMIT,
		};
	}
	return {
		itemRows: runningTotal,
		toggle: "collapse",
		toggleRow: 2 + runningTotal,
	};
}

/** A running tool call earns an elapsed marker in the live preview once it outlasts this. */
const SUBAGENT_PREVIEW_ELAPSED_MIN_MS = 5000;

/** Narrowest detail worth showing after the tool name in the live preview. */
const SUBAGENT_PREVIEW_MIN_DETAIL_WIDTH = 8;

/**
 * Delay until the live preview next needs a repaint with no progress event to
 * trigger it: when the first listed in-flight call crosses the elapsed-marker
 * threshold, then once a second while any marker is showing. Undefined when no
 * listed agent is mid-call, so an idle or thinking agent never arms a timer.
 */
export function nextSubagentPreviewTickMs(sessions: readonly ObservableSession[], now: number): number | undefined {
	let delay: number | undefined;
	for (const session of sessions) {
		const progress = session.progress;
		if (progress?.status !== "running" || !progress.currentTool || progress.currentToolStartMs === undefined)
			continue;
		const untilMarker = progress.currentToolStartMs + SUBAGENT_PREVIEW_ELAPSED_MIN_MS + 1 - now;
		const next = untilMarker > 0 ? untilMarker : SUBAGENT_PREVIEW_TICK_MS;
		delay = delay === undefined ? next : Math.min(delay, next);
	}
	return delay;
}

/**
 * Live-preview row for a running subagent: its current (or, between calls,
 * most recent) tool call with a one-line detail and, once the call has run a
 * while, an elapsed marker. The detail is that call's own intent, else its
 * args — never an earlier call's intent. Undefined when the agent has not
 * called a tool yet. The row never overflows `width`.
 */
function renderSubagentToolPreview(session: ObservableSession, width: number): string | undefined {
	const progress = session.progress;
	if (progress?.status !== "running") return undefined;
	const currentTool = progress.currentTool;
	const recent = progress.recentTools[0];
	const tool = currentTool ?? recent?.tool;
	if (!tool) return undefined;
	const intent = currentTool ? progress.currentToolIntent : recent?.intent;
	const args = currentTool ? progress.currentToolArgs : recent?.args;
	const argsKey = currentTool ? progress.currentToolArgsKey : recent?.argsKey;
	// A model-written intent is prose, so home paths inside it are shortened as they stand. An argument is
	// shortened by its key, so a literal search pattern that names a home path still shows what was searched.
	const detail = intent
		? shortenEmbeddedPaths(replaceTabs(intent))
		: args
			? shortenToolArgumentPaths(replaceTabs(args), argsKey)
			: undefined;
	const elapsed = currentTool && progress.currentToolStartMs ? Date.now() - progress.currentToolStartMs : 0;
	const elapsedLabel =
		elapsed > SUBAGENT_PREVIEW_ELAPSED_MIN_MS
			? `${theme.sep.dot}${theme.fg("warning", formatDuration(elapsed))}`
			: "";
	const elapsedWidth = visibleWidth(elapsedLabel);
	const hook = `${theme.fg("dim", theme.tree.hook)} `;
	// Between calls the row keeps the last call, marked with how it ended.
	const status =
		!currentTool && recent
			? `${theme.styledSymbol(recent.isError ? "status.error" : "status.success", recent.isError ? "error" : "success")} `
			: "";
	const prefixWidth = visibleWidth(hook) + visibleWidth(status);
	// Reserve the elapsed marker first, then cap the tool name; the detail gets whatever is left.
	const shortTool = truncateToWidth(replaceTabs(tool), Math.max(0, width - prefixWidth - elapsedWidth), "");
	let line = `${hook}${status}${theme.fg(currentTool ? "muted" : "dim", shortTool)}`;
	const detailBudget = width - prefixWidth - visibleWidth(shortTool) - elapsedWidth - visibleWidth(": ");
	if (detail && detailBudget >= SUBAGENT_PREVIEW_MIN_DETAIL_WIDTH) {
		line += `: ${theme.fg("dim", previewLine(detail, Math.min(TRUNCATE_LENGTHS.SHORT, detailBudget)))}`;
	}
	return truncateToWidth(`${line}${elapsedLabel}`, width, "");
}

/**
 * Build the anchored subagent HUD block: a bold accent "Subagents" header plus
 * a bounded set of running-agent rows in the same `Id ⟨role⟩: description` shape
 * the inline task rows use (muted task preview when no description was given).
 * Layout mirrors the Todos HUD exactly: unindented header, then
 * `renderTreeList` rows (dim connectors) shifted right by one space.
 * Every active subagent is listed — detached background spawns and sync task
 * calls alike — so the pinned block doubles as a click jump list.
 * With `livePreview` (`display.subagentLivePreview`), a row that has called a
 * tool carries a second physical row showing that call; both rows share one
 * returned line (joined by a newline) so line N still maps to agent N - 2.
 * Returns an empty array when nothing is running so the container can clear.
 */
export function renderSubagentHudLines(
	sessions: ObservableSession[],
	columns: number,
	expanded = false,
	livePreview = false,
): string[] {
	const running = sessions.filter(isHudSubagent);
	if (running.length === 0) return [];
	// `SubagentHudComponent` paints through `Text` with horizontal padding, so
	// rows budgeted to the full terminal width would wrap.
	const contentColumns = Math.max(0, columns - getPaddingX(1) * 2);
	const layout = layoutPinnedHud(running.length, expanded);
	const dot = theme.styledSymbol("status.done", "accent");
	const items = running.slice(0, layout.itemRows);
	const showModelBadge = isFeedModelBadgeEnabled();
	const outerIndent = " ";
	const itemLineCounts = new Map<ObservableSession, number>();
	const rows = renderTreeList(
		{
			items,
			expanded: true,
			renderItem: (session, context) => {
				const rowWidth = Math.max(0, contentColumns - visibleWidth(outerIndent) - (context.prefixWidth ?? 0));
				const role = session.agent ?? session.progress?.agent;
				const displayId = truncateToWidth(
					formatTaskId(session.id),
					Math.max(0, rowWidth - visibleWidth(`${dot} `)),
				);
				const badge = truncateToWidth(
					agentTypeBadge(role, theme),
					Math.max(0, rowWidth - visibleWidth(`${dot} ${displayId}`)),
				);
				const titleBudget = Math.max(0, rowWidth - visibleWidth(`${dot} ${displayId}${badge}`));
				const modelBadge = showModelBadge
					? formatFeedModelBadge(
							session.progress?.resolvedModelIdentity ?? session.progress?.resolvedModel,
							session.progress?.resolvedThinkingLevel,
							session.progress?.advisor,
							theme,
							Math.min(FEED_MODEL_BADGE_WIDTH, Math.max(0, titleBudget - 1)),
						)
					: "";
				const modelLead = modelBadge ? `${modelBadge} ` : "";
				let line = `${dot} ${modelLead}${theme.fg("accent", theme.bold(displayId))}${badge}`;
				const description = session.description?.trim() || session.progress?.description?.trim();
				const distinctDescription =
					description && !labelEchoesHandle(session.id, description) ? description : undefined;
				if (distinctDescription) {
					const budget = Math.max(0, rowWidth - visibleWidth(line) - visibleWidth(": "));
					const formatted = replaceTabs(distinctDescription).replace(/\s*[\r\n]+\s*/g, " ↵ ");
					if (budget > 0) {
						line += `${theme.fg("accent", ":")} ${theme.fg("accent", truncateToWidth(formatted, budget))}`;
					}
				} else {
					// No spawn description: fall back to a muted task preview, same as
					// the inline task rows when a row has no label.
					const taskPreview = session.progress?.task?.trim();
					if (taskPreview && !labelEchoesHandle(session.id, taskPreview)) {
						const formatted = replaceTabs(taskPreview).replace(/\s*[\r\n]+\s*/g, " ↵ ");
						const budget = Math.min(TRUNCATE_LENGTHS.SHORT, Math.max(0, rowWidth - visibleWidth(line) - 1));
						if (budget > 0) line += ` ${theme.fg("muted", truncateToWidth(formatted, budget))}`;
					}
				}
				const head = truncateToWidth(line, rowWidth, "");
				const preview = livePreview ? renderSubagentToolPreview(session, rowWidth) : undefined;
				itemLineCounts.set(session, preview ? 2 : 1);
				return preview ? [head, preview] : head;
			},
		},
		theme,
	);
	const toggleRow =
		layout.toggle === undefined
			? []
			: [
					truncateToWidth(
						`${outerIndent}${theme.fg(
							"dim",
							layout.toggle === "expand" ? `… ${running.length - layout.itemRows} more — expand` : "… show less",
						)}`,
						contentColumns,
						"",
					),
				];
	const itemLines: string[] = [];
	let cursor = 0;
	for (const session of items) {
		const count = itemLineCounts.get(session) ?? 1;
		itemLines.push(
			rows
				.slice(cursor, cursor + count)
				.map(row => truncateToWidth(`${outerIndent}${row}`, contentColumns, ""))
				.join("\n"),
		);
		cursor += count;
	}
	return [
		"",
		truncateToWidth(theme.bold(theme.fg("accent", "Subagents")), contentColumns),
		...itemLines,
		...toggleRow,
	];
}

const CTRL_L_APPEARANCE_RESPONSE_DEADLINE_MS = 2000;

/** Repaint cadence of the open jobs sheet: output tails, pids and list ages are polled, not pushed. */
const JOBS_SHEET_REFRESH_MS = 250;

export class InteractiveMode implements InteractiveModeContext {
	#ownsStartedUi: boolean;
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
	/** Judge-batch and automatic-download progress rows above the working line. */
	progressHudContainer: Container;
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
	/** The docked `/changelog`-style command report, just above the editor; Esc clears it. */
	reportContainer: Container;
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
	loopCondition: LoopConditionConfig | undefined = undefined;
	/**
	 * Aborts the in-flight `--while` / `--until` evaluation. Esc between
	 * iterations lands while the condition command is still running, and
	 * `#cancelLoopAutoSubmit` only clears the pending timer — without this the
	 * child process would outlive the loop it was gating.
	 */
	#loopConditionAbort: AbortController | undefined;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	#todoAutoClearTimer: NodeJS.Timeout | undefined;
	#todoAutoClearGeneration = 0;
	#modelCycleClearTimer: NodeJS.Timeout | undefined;
	#composerStatusPersistTimer: NodeJS.Timeout | undefined;
	readonly #judgmentBatchProgressHud = new JudgmentBatchProgressHud();
	readonly #downloadActivityHud = new DownloadActivityHud(() => this.ui.requestRender());
	readonly #judgmentBatchProgressClearTimers = new Map<string, NodeJS.Timeout>();
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
	#todoHudHidden = false;
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
	expandThinkingBlocks = false;
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
	servedModelTracker = new ServedModelTracker();
	loadingAnimation: Loader | undefined = undefined;
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;
	#pendingWorkingMessage: string | undefined;
	#retryHintRow: DescribedComponent | undefined;
	#workingMessageAccentCacheKey?: WorkingMessageAccentCacheKey;
	#workingMessageAccentCacheValue?: WorkingMessageAccent;
	#workingMessageAccentCacheHasValue = false;
	/** Band composer: the status band hides `session_name`, so the title docks
	 * onto the working row instead — right-aligned, dim, italic. */
	#workingTitleTrailer(): string | undefined {
		if (cfgComposerShape.get(settings) !== "band") return undefined;
		const name = this.sessionManager.getSessionName();
		if (!name) return undefined;
		return `\x1b[2;3m${sanitizeStatusText(name)}\x1b[23;22m`;
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
		return theme.fg("dim", `${theme.icon.throughput} ${rate.toFixed(1)} tok/s`);
	}
	/** Right-docked suffix of the working row: the tok/s readout, then the band-mode title. */
	#workingRowTrailer(): string | undefined {
		const rate = this.#tokenRateLabel();
		const title = this.#workingTitleTrailer();
		if (rate && title) return `${rate}  ${title}`;
		return rate ?? title;
	}
	/** Idle stand-in for the working row: the last tok/s reading and the
	 * band-mode title stay readable between turns, docked where the loader's
	 * trailer was. */
	renderIdleStatusHud(width: number): readonly string[] | undefined {
		const trailer = this.#workingRowTrailer();
		if (!trailer) return undefined;
		return ["", " ".repeat(Math.max(0, width - visibleWidth(trailer))) + trailer];
	}
	/** Message the working row shows; mirrors what the loader was last given. */
	#workingMessage = DEFAULT_WORKING_MESSAGE;
	/**
	 * The native row's `elapsed` origin: the viewed session's run start, so a
	 * loader recreated by a focus switch keeps the real elapsed time.
	 */
	#workingStartedAt = 0;
	#statusHudNative: { children: readonly Component[]; todo: NativeNode | undefined; node: NativeNode } | undefined;
	/**
	 * The todo HUD, rebuilt with its ANSI rows; undefined while hidden. A
	 * terminal with `checklist` gets the whole plan as a HUD checklist, others
	 * the same stage window as a tree; both keyed `todo` in the activity line.
	 */
	#todoHudNative: { checklist: NativeNode; fallback: NativeNode } | undefined;
	#hudPillsNative: { children: readonly NativeChild[]; node: NativeNode } | undefined;
	#agentsPill: RunningPill | undefined;
	#jobsPill: RunningPill | undefined;
	/** Gen tok/s for the native composer bar, one decimal (a steadier `rate` target): live while running, else the last reading. */
	#nativeTokenRate(): number | undefined {
		if (!cfgComposerTokenRate.get(settings)) return undefined;
		const rate = this.tokenRate.rate();
		return rate === null ? undefined : Math.round(rate * 10) / 10;
	}
	/** The key that interrupts (the working row's stop control), or undefined when Esc would not cancel. */
	maintenanceInterruptKey(): KeyId | undefined {
		if (this.focusedAgentId) return undefined;
		return this.keybindings.getKeys("app.interrupt")[0] ?? "escape";
	}
	/** The running turn's working row (§8.1): its elapsed time, the intent and the stop control. */
	#workingRowSpec(): WorkingRowSpec {
		const accent = this.#getWorkingMessageAccent() !== undefined;
		return {
			label: this.#workingMessage,
			startedAt: this.#workingStartedAt,
			palette: accent ? NATIVE_ACCENT_SHIMMER : undefined,
			interruptKey: this.keybindings.getKeys("app.interrupt")[0] ?? "escape",
		};
	}
	/** The stop control's click: the same handler as the interrupt key. */
	interruptFromPointer(): void {
		this.editor.onEscape?.();
	}
	/** The native HUD pills row: the agents pill, then the jobs pill; hidden while both are absent. */
	describeHudPills(): NativeNode {
		// Agents count as the status-line badge counts them, from the agent
		// registry: the observer registry only hears task-executor lifecycles,
		// so an agent a peer message woke or revived would run without a pill.
		const agents = cfgDisplayPinnedAgents.get(settings) === "off" ? 0 : this.#runningSubagentCount;
		this.#agentsPill = runningPill(this.#agentsPill, agents, count =>
			describeRunningPill(
				{
					key: "agents",
					icon: "users",
					noun: "agent",
					title: `Agents  ${formatDoubleTap("left")}`,
					act: "agents.open",
				},
				count,
			),
		);
		this.#jobsPill = runningPill(this.#jobsPill, this.statusLine.runningBackgroundJobCount(), count =>
			describeRunningPill(
				{ key: "jobs", icon: "job", noun: "job", title: "Background jobs  /jobs", act: "jobs.open" },
				count,
			),
		);
		const children: NativeChild[] = [];
		if (this.#agentsPill) children.push(this.#agentsPill.node);
		if (this.#jobsPill) children.push(this.#jobsPill.node);
		const memo = this.#hudPillsNative;
		if (memo && sameItems(memo.children, children)) return memo.node;
		const described = row(children, {
			role: "omp.hud",
			justify: "end",
			gap: "sm",
			hidden: children.length === 0 || undefined,
		});
		this.#hudPillsNative = { children, node: described };
		return described;
	}
	/**
	 * Native activity line (`omp.hud.activity`): the status rows (the working,
	 * retry and compaction loaders describe themselves as the working row;
	 * other rows describe themselves) in an `omp.hud.status` column, then the
	 * todo HUD, so the todo holds its place as the turn starts and ends.
	 * Nothing to show describes the empty HUD.
	 */
	describeStatusHud(children: readonly Component[], cx: DescribeContext): NativeNode {
		const hud = this.#todoHudNative;
		const todo = hud && (cx.supports("checklist") ? hud.checklist : hud.fallback);
		const memo = this.#statusHudNative;
		if (memo && memo.todo === todo && sameItems(memo.children, children)) return memo.node;
		const parts: NativeChild[] = [];
		if (children.length > 0) parts.push(node("col", { role: "omp.hud.status" }, children.slice(), "status"));
		if (todo) parts.push(todo);
		const described =
			parts.length === 0 ? EMPTY_HUD : row(parts, { role: "omp.hud.activity", align: "center", gap: "sm" });
		this.#statusHudNative = { children: children.slice(), todo, node: described };
		return described;
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
	/** True once `shutdown()` has begun teardown. Surfaced to the input
	 *  controller so a Ctrl+C arriving while teardown is in flight can hard-
	 *  abort the remaining work instead of stacking another no-op call. */
	get isShuttingDown(): boolean {
		return this.#isShuttingDown;
	}
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatus: StatusNotice | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();
	/** Owns hosting: manual `/collab`, `collab.autoStart`, and room rotation on session switch. */
	readonly collabController: CollabController;
	/** Owned room; use {@link collabController}.host for current-session reuse and links. */
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;
	#streamPublisher: StreamPublisher | undefined;
	#recorder: SessionRecorder | undefined;
	#recorderStarting = false;

	#pendingCommandOutput: Component[] = [];
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
	readonly #startupChangelog: StartupChangelogSelection | undefined;
	/** Header components below the config warnings + welcome, retained so a live config-warning change can rebuild the header (#10048). */
	#headerAfter: readonly Component[] = [];
	#planModePreviousToolPresentation: { enabled: string[]; mounted: string[] } | undefined;
	#goalModePreviousTools: string[] | undefined;
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
	#planModePreviousModelState: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** Whether #pendingModelSwitch was queued by the live plan-role reconciler. */
	#pendingPlanModelSwitch = false;
	#planModeHasEntered = false;
	#planReviewOverlay: PlanReviewOverlay | undefined;
	#planReviewOverlayHandle: OverlayHandle | undefined;
	#sessionInfoOverlayHandle: OverlayHandle | undefined;
	#jobsSheetHandle: OverlayHandle | undefined;
	/** Re-renders the open jobs sheet so output tails and pids stay live. */
	#jobsSheetTimer: NodeJS.Timeout | undefined;
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
	invalidatePendingFocus(): void {
		this.#focusController.invalidatePendingFocus();
	}

	resolveViewportClickCandidates(index: number): string[] {
		return this.composer.viewportClickCandidates(index);
	}

	/** Flip the pinned jump list between its collapsed few and the full list, overriding the setting. */
	togglePinnedHudExpanded(): void {
		const mode = cfgDisplayPinnedAgents.get(settings);
		const expanded = this.#pinnedHudOverride ?? mode === "full";
		this.#pinnedHudOverride = !expanded;
		this.#renderSubagentList();
		this.ui.requestRender();
	}

	/** Rebuild the pinned jump list for a `display.pinnedAgents` change. */
	applyPinnedAgentsSetting(): void {
		// An explicit settings change wins over click state: without the reset,
		// reselecting the current value would keep showing the old override.
		this.#pinnedHudOverride = undefined;
		this.#renderSubagentList();
		this.ui.requestRender();
	}

	setClickHoverId(id: string | undefined): void {
		this.composer.setHoveredClickId(id);
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
		this.#clearJudgmentBatchProgress();
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
		this.servedModelTracker = new ServedModelTracker();
		this.pendingTools.clear();
	}
	readonly #uiHelpers: UiHelpers;
	#sttController: STTController | undefined;
	#micCursor: MicCursor | undefined;
	#resizeHandler?: () => void;
	#observerRegistry: SessionObserverRegistry;
	/** Click override for the pinned jump-list density; undefined follows `display.pinnedAgents`. */
	#pinnedHudOverride: boolean | undefined;
	#eventBus?: EventBus;
	#subagentEventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	/** Mirror of `tui.mouse`, read by the TUI's per-frame inline mouse tracking probe. */
	#mouseCapture = false;
	#observerUiSyncTimer?: NodeJS.Timeout;
	/** Repaints the subagent HUD so live-preview elapsed markers advance between progress events. */
	#subagentPreviewTickTimer?: NodeJS.Timeout;
	#observerUiSyncNeedsTodoReconcile = false;
	/** Active subagent descriptions the todo HUD last rendered with (joined); see #flushObserverUiSync. */
	#todoHudSubagentKey: string | undefined;
	#runningSubagentCount = 0;
	#agentRegistryUnsubscribe?: () => void;
	#agentRegistrySubscriptionTarget?: AgentHubRegistry;
	#subagentSessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
	#subagentCostHydratedRoot?: string;
	#mcpStatusOrder: string[] = [];
	#mcpPendingServers = new Set<string>();
	#mcpConnectedServers = new Set<string>();
	#mcpFailedServers = new Map<string, { error: string; sourcePath?: string }>();
	readonly #chatHost: ChatBlockHost = {
		requestRender: () => this.ui.requestRender(),
	};

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
			quiet: cfgStartupQuiet.get(settings),
			composerShape: cfgComposerShape.get(settings),
			...this.#liveComposerPreferences(),
		};
		const wasStarted = composer?.started ?? false;
		setMagicKeywords(MAGIC_KEYWORDS);
		this.composer =
			composer ??
			new Composer({
				preferences,
				welcome: { version },
			});
		this.composer.setPreferences(preferences);
		this.ui = this.composer.ui;
		this.editor = this.composer.editor;
		this.editor.magicKeywordsEnabled = () => cfgMagicKeywordsEnabled.get(this.settings);
		this.editor.placeholder = () => this.#composerHint();
		this.editor.prediction = () => this.#eventController.composerPrediction.text;
		this.editor.composerState = () => this.#composerNativeState();
		this.editor.imageReferenceHyperlink = imageReferenceHyperlink;
		this.editor.skillFilePath = name => this.skillCommands.get(`skill:${name}`)?.filePath;
		this.editor.modelMentionLabel = selector => {
			const model = this.session.findMentionableModel(selector);
			return model ? modelMentionChipLabel(modelMentionDisplayName(model)) : undefined;
		};
		this.editor.modelMentionSelector = agent => this.session.modelMentions.find(m => m.agent === agent)?.selector;
		this.editor.fileHyperlink = (filePath, text) => fileHyperlink(filePath, text, { line: 1 });
		this.#ownsStartedUi = wasStarted;
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
					if (cfgStartupQuiet.get(this.settings)) return;
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
			this.#eventBusUnsubscribers.push(
				eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
					if (!isMcpConnectionStatusEvent(data)) {
						logger.warn("Ignoring malformed mcp:connection-status event", {
							data,
						});
						return;
					}
					this.#handleMcpConnectionStatusEvent(data);
				}),
			);
		}

		setTuiTight(cfgTuiTight.get(settings));
		setMarkdownMermaidRendering(cfgTuiRenderMermaid.get(settings));
		setSvgFigureRendering(cfgTuiRenderSvg.get(settings));
		this.#applyAutoGraphSetting();
		this.#applyTextSizingSetting();
		// Keep generic pi-tui renderers aligned with the coding-agent setting.
		applyHyperlinkSetting();
		// The TUI polls the provider every frame, so it reads a field kept in sync by
		// subscription rather than resolving the setting per render.
		// Session settings overlay the global layer and forward its changes.
		this.#mouseCapture = cfgTuiMouse.get(this.settings);
		this.#eventBusUnsubscribers.push(
			cfgTuiMouse.listen(this.settings, on => {
				this.#mouseCapture = on;
				// Dropping capture must also drop the band: with reporting off no
				// motion event will ever arrive to clear a mid-hover highlight.
				// The controller cache goes too, or a re-enable plus motion over
				// the same card would look unchanged and skip restoring the band.
				if (!on) {
					this.composer.setHoveredClickId(undefined);
					this.#inputController?.clearHoverHighlight();
				}
				this.ui.requestRender();
			}),
		);
		this.ui.setInlineMouseTrackingProvider(() => this.#mouseCapture);
		this.chatContainer = new TranscriptContainer();
		this.pendingMessagesContainer = new AnchoredLiveContainer();
		this.progressHudContainer = new AnchoredLiveContainer();
		this.progressHudContainer.addChild(this.#judgmentBatchProgressHud);
		this.progressHudContainer.addChild(this.#downloadActivityHud);
		this.#eventBusUnsubscribers.push(onDownloadActivity(activity => this.#downloadActivityHud.update(activity)));
		this.statusContainer = new StatusHudContainer(this);
		this.todoContainer = new TodoHudContainer(this);
		this.subagentContainer = new AnchoredLiveContainer();
		this.btwContainer = new AnchoredLiveContainer();
		this.omfgContainer = new AnchoredLiveContainer();
		this.cleanseContainer = new AnchoredLiveContainer();
		this.errorBannerContainer = new AnchoredLiveContainer();
		this.modelCycleContainer = new AnchoredLiveContainer();
		this.deferredCommandContainer = new AnchoredLiveContainer();
		this.reportContainer = new AnchoredLiveContainer();
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(JUDGMENT_BATCH_PROGRESS_EVENT_CHANNEL, data => {
					if (!isJudgmentBatchProgress(data)) {
						logger.warn("Ignoring malformed eval:judgment-batch-progress event", { data });
						return;
					}
					this.#handleJudgmentBatchProgress(data);
				}),
			);
		}
		this.#applyVimMode(this.editor);
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
		setWordPredictionHost(textPredictionBackend);
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
			this.historyStorage.setSessionResolver(() => this.sessionManager.getSessionId());
			// The prediction daemon learns from history.db; nudge it once each prompt is durable.
			this.historyStorage.setAddListener(syncTextPrediction);
			this.historyStorage.setErrorListener(() => {
				this.showWarning("Prompt history could not be saved; this prompt may be unavailable after restart.");
			});
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.hookWidgetContainerAbove = new Container();
		this.hookWidgetContainerAbove.addChild(new EditorTopGap(() => this.statusRowOccupied));
		this.hookWidgetContainerBelow = new Container();
		this.attachmentChipsContainer = new Container();
		const attachmentChips = new AttachmentChipsBand(this.editor, this.ui.imageBudget, () => this.ui.requestRender());
		this.attachmentChipsContainer.addChild(attachmentChips);
		this.editor.attachmentChips = attachmentChips;
		// Restored drafts (esc-esc, /tree, branch) re-materialize chip links off the render
		// path so their chip tokens become clickable again instead of degrading to dead text.
		this.editor.draftImageLinkMaterializer = images => materializeImageChipLinks(images, this.sessionManager);
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.statusLine = new StatusLineComponent(session, statusLineHost);
		// Native segment clicks open what their slash commands and keys open.
		this.statusLine.onNativeAction = action => {
			switch (action) {
				case "status.model":
					this.showModelSelector({ temporaryOnly: true });
					return;
				case "status.context":
					this.handleContextCommand();
					return;
				case "status.git":
					this.showGitUi();
					return;
				case "status.cost":
					void this.handleUsageCommand();
					return;
				case "status.path":
					openPath(this.sessionManager.getCwd());
					return;
			}
		};
		// A TSP terminal has no status strip: the tab title carries the PR.
		this.statusLine.onNativePullRequest = pr => setTerminalTitlePullRequest(pr?.number);
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

		this.hideToolActivity = cfgDisplayHideToolActivity.get(settings);
		this.chatContainer.setToolActivityVisible(!this.hideToolActivity);
		this.hideThinkingBlock = cfgHideThinkingBlock.get(settings);
		this.proseOnlyThinking = cfgProseOnlyThinking.get(settings);
		this.expandThinkingBlocks = cfgExpandThinkingBlocks.get(settings);

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
		this.session.setPromptDropped?.(prompt => this.#restoreDroppedPrompt(prompt));
		this.#observerRegistry = new SessionObserverRegistry();
	}

	#handleJudgmentBatchProgress(progress: JudgmentBatchProgress): void {
		const pendingClear = this.#judgmentBatchProgressClearTimers.get(progress.id);
		if (pendingClear) {
			clearTimeout(pendingClear);
			this.#judgmentBatchProgressClearTimers.delete(progress.id);
		}

		this.#judgmentBatchProgressHud.update(progress);
		if (!progress.running) {
			const timer = setTimeout(() => {
				this.#judgmentBatchProgressClearTimers.delete(progress.id);
				this.#judgmentBatchProgressHud.delete(progress.id);
				this.ui.requestRender();
			}, JUDGMENT_BATCH_PROGRESS_RETAIN_MS);
			timer.unref?.();
			this.#judgmentBatchProgressClearTimers.set(progress.id, timer);
		}
		this.ui.requestRender();
	}

	#clearJudgmentBatchProgress(requestRender = false): void {
		for (const timer of this.#judgmentBatchProgressClearTimers.values()) clearTimeout(timer);
		this.#judgmentBatchProgressClearTimers.clear();
		this.#judgmentBatchProgressHud.clear();
		if (requestRender) this.ui.requestRender();
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
		if (message) this.showStatus(message, { toast: false });
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
			beginDispose: () => this.session.beginDispose(),
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
		setAutoQaConsentHandler(() => this.#promptAutoQaConsent(), Settings.instance);
		// Same wiring for cfg:// writes: every settings change the agent makes is
		// confirmed here, and `/save` persists to disk. Subagents and headless
		// sessions are refused by the handler before reaching this host. Changes
		// to this session's settings get the settings panel's in-process side
		// effects (a `defaultThinkingLevel` change also switches the live session).
		setCfgApprovalHost({
			approve: request => this.#promptCfgChange(request),
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

		const startupQuiet = cfgStartupQuiet.get(settings);
		this.composer.setPreferences({ quiet: startupQuiet });
		this.composer.updateWelcome({ version: this.#version });
		const headerBefore = this.#buildConfigWarningComponents();
		const headerAfter: Component[] = [];
		if (!startupQuiet && this.#startupChangelog && cfgStartupChangelogMode.get(settings) !== "hidden") {
			headerAfter.push(
				new DynamicBorder(),
				new Text("What's New", 1, 0).setStyleFn(t => theme.bold(theme.fg("accent", t))),
				new Spacer(1),
			);
			if (cfgStartupChangelogMode.get(settings) === "summary") {
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
		this.statusLine.watchBranch(() => this.ui.requestRender());
		this.composer.setStatusComponent(this.statusLine);

		this.composer.setRuntimeChildren(
			[
				this.chatContainer,
				this.pendingMessagesContainer,
				this.todoContainer,
				this.subagentContainer,
				this.btwContainer,
				this.reportContainer,
				this.omfgContainer,
				this.cleanseContainer,
				this.errorBannerContainer,
				this.modelCycleContainer,
				this.deferredCommandContainer,
				// Judge batches and automatic downloads stay editor-anchored and update
				// independently of transcript output, directly above the working/throughput/title row.
				this.progressHudContainer,
				// Working loader / transient status sits below the sticky todo + subagent
				// HUDs, just above the editor's hook-widget top margin — so it reads next to
				// the prompt while keeping the one-line gap above the editor (the band
				// composer collapses that gap so its status band sits flush).
				this.statusContainer,
				this.attachmentChipsContainer,
				this.hookWidgetContainerAbove,
				this.editorContainer,
				this.hookWidgetContainerBelow,
			],
			{
				// Inline dialogs and a tall multi-line draft swap into the editor
				// container and collapse again, as a command report above it closes
				// on Esc: they clip the transcript instead of retiring it to
				// scrollback, so the editor returns to the bottom when they go.
				// Everything else is turn-scoped.
				transient: [this.editorContainer, this.reportContainer],
				// Natively the HUD pills lead the dock, queued messages sit between
				// the working row and the composer, and the attachment chips live
				// inside the composer.
				nativeDock: [
					new HudPillsRow(this),
					this.btwContainer,
					this.omfgContainer,
					this.cleanseContainer,
					this.errorBannerContainer,
					this.modelCycleContainer,
					this.deferredCommandContainer,
					this.progressHudContainer,
					this.statusContainer,
					this.pendingMessagesContainer,
					this.hookWidgetContainerAbove,
					this.editorContainer,
					this.hookWidgetContainerBelow,
				],
			},
		);
		this.ui.setFocus(this.editor);
		this.syncComposerShape();

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();
		// Native transcript controls (user-message toolbar, error-frame actions)
		// run the same commands as their key bindings.
		setTranscriptActionHandler(action => {
			switch (action.act) {
				case "retry":
					void this.#inputController.handleRetry();
					return;
				case "switch-model":
					this.showModelSelector({ temporaryOnly: true });
					return;
				case "rewind":
					this.showUserMessageSelector();
					return;
				case "resume":
					this.handleResumeSession(action.path).catch((error: unknown) =>
						this.showError(error instanceof Error ? error.message : String(error)),
					);
					return;
				case "copy":
					copyToClipboard(action.text).then(
						() => this.showStatus("Copied to clipboard"),
						(error: unknown) =>
							this.showWarning(`Copy failed: ${error instanceof Error ? error.message : String(error)}`),
					);
			}
		});

		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus, this.#subagentEventBus ?? this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningSubagentBadge();
		this.#observerRegistry.onChange(kind => {
			this.#scheduleObserverUiSync(kind);
		});
		// `/pause` stops the live-preview tick (the fullscreen pause screen covers
		// the HUD); resuming repaints so elapsed markers catch up immediately.
		this.#eventBusUnsubscribers.push(
			agentPauseGate.onChange(paused => {
				if (!cfgDisplaySubagentLivePreview.get(settings)) return;
				this.#renderSubagentList();
				if (!paused) this.ui.requestRender();
			}),
		);
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
		// Claim the terminal title before any session update: this is the one path
		// that releases the teardown latch, so a late async `setSessionTerminalTitle`
		// after shutdown can never write into the parent shell's tab.
		initTerminalTitleState();
		setTerminalTitleStateEnabled(cfgTuiTitleState.get(this.settings));
		setTerminalTitleSpinnerStyle(cfgTuiTitleSpinner.get(this.settings));
		initProgramStatus();
		setProgramStatusEnabled(cfgTerminalProgramStatus.get(this.settings));
		setTerminalSessionSource({
			file: () => this.sessionManager.getSessionFile(),
			cwd: () => this.sessionManager.getCwd(),
		});
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		// Seeds the border, the status-line `vim` segment, and the cursor shape in one call.
		// Deliberately here rather than beside #applyVimMode in the constructor: that runs before
		// #focusController exists, which updateEditorBorderColor dereferences.
		this.#syncVimStatus(this.editor);
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
			this.session.registerSessionChangeCallback(reportTernSession),
		);
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		// The startup composer is already visible. Commit the complete runtime
		// tree before session_start hooks/reconciliation continue; renderNow keeps
		// TUI's multiplexer, output-backlog, and image safety gates.
		this.ui.renderNow();

		const streamCwd = this.sessionManager.getCwd();
		this.#streamPublisher =
			(await StreamPublisher.connectLazy({
				cwd: streamCwd,
				sessionId: this.sessionManager.getSessionId(),
				title: path.basename(streamCwd),
				tui: this.ui,
				loadRedactor: () => StreamRedactor.load(streamCwd, cfgStreamRedactPatterns.get(this.settings)),
				onStatus: status => {
					this.statusLine.setStreamStatus(status);
					this.ui.requestRender();
				},
				onChat: message => {
					const chat = truncateToWidth(
						replaceTabs(sanitizeText(`${message.name}: ${message.text}`)).replace(/[\r\n]+/g, " "),
						TRUNCATE_LENGTHS.LINE,
					);
					this.showStatus(chat);
				},
			})) ?? undefined;
		if (this.#streamPublisher) {
			this.ui.renderNow();
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
		// The native syntax set (syntect defaults plus the vendored TypeScript/TSX/
		// Julia grammars, parsed from YAML) costs ~1s to build on first use, and each
		// language's regexes compile on its first highlight (~250ms for TS/TSX).
		// Warm both on the native worker pool now so the first highlighted code
		// block, bash command preview, or file diff does not stall the render thread.
		setImmediate(() => {
			void warmHighlighter();
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
					this.#scheduleComposerStatusPersist();
				}
				if (event.type === "config_warnings_changed") {
					this.#syncConfigWarningHeader();
				}
				void this.#handleGoalSessionEvent(event);
			}),
			cfgLiveUiSettings.listen(this.settings, (next, previous) => this.#applyUiSettingChanges(next, previous)),
		);
		// Cache the live model for the next status-bar prepaint: init-time
		// reconciliations (#reconcileModeFromSession, #enterPlanMode for
		// plan.defaultOnStartup) can change the model before this subscription
		// exists, so the model_changed events they emit are never observed above.
		this.#scheduleComposerStatusPersist();
		// Config warnings can change during the same pre-subscription window; the
		// event is not replayed, so rebuild from the live array once here too.
		this.#syncConfigWarningHeader();
		this.#eventBusUnsubscribers.push(
			cfgModelRoles.listen(this.settings, () => this.#reapplyPlanModeModelOnRoleChange()),
		);
		this.#eventBusUnsubscribers.push(
			this.session.subscribeCommandMetadataChanged(() => {
				// Skills/commands rediscovery (live `skills.*`/`commands.*`/extension edits,
				// `/move`, manage_skill, MCP prompts) lands here; rebuild the picker from session state.
				this.#pendingSlashCommands = this.#buildPendingSlashCommands();
				this.#rebuildSlashCommandAutocomplete(this.sessionManager.getCwd());
				this.ui.requestRender();
			}),
		);
		// Set up theme file watcher
		this.#eventBusUnsubscribers.push(
			onThemeChange(event => {
				this.#refreshSlashCommandIcons();
				this.#clearWorkingMessageAccentCache();
				clearRenderCache();
				clearMermaidCache();
				this.statusLine.invalidate();
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
		// The preset may have switched before this listener existed.
		this.#refreshSlashCommandIcons();
		// A confirmed Glyph Protocol handshake means omp's own icons render in
		// this terminal without a Nerd Font, so the unconfigured `unicode` preset
		// is upgraded to `nerd` for this session. The persisted setting is left
		// alone: it travels to terminals (ssh, tmux) where the upgrade would
		// show tofu. Explicit preset choices are never touched.
		this.ui.terminal.onGlyphProtocolReport?.(supported => {
			if (!supported || cfgSymbolPreset.provenance(settings) !== "default" || theme.getSymbolPreset() !== "unicode")
				return;
			void setSymbolPreset("nerd").then(() => {
				this.statusLine.invalidate();
				this.ui.invalidate();
				this.ui.requestRender();
			});
		});

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

		// Keys pressed while a Tern startup loaded were held until hooks ran, the
		// session mode settled, the draft was restored and every subscription
		// above was installed. They replay into the restored draft, never over
		// it, a startup shortcut (Alt+P, Ctrl+G, extension shortcuts) acts on the
		// final mode, editor contents and observed session, and a held Enter
		// still meets the bootstrap submit gate lifted just below.
		this.ui.releaseHeldInput();

		// Everything is wired: subscriptions observe agent events, the session
		// mode is reconciled, and the submit handler is installed. Lift the
		// composer's bootstrap submit gate (`disableSubmit = true` since
		// construction, so an Enter typed before the pipeline existed could not
		// clear the draft into nowhere, and a turn started mid-init could not run
		// unobserved). From here Enter dispatches safely in every state — the
		// initial CLI prompt and a user submission both flow with
		// `streamingBehavior: "steer"`, so whichever lands second queues into the
		// other's turn instead of dying.
		this.editor.disableSubmit = false;
		// Publish native send readiness even when no user input triggers another frame.
		this.ui.requestRender();
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

	/**
	 * Slash-command icons are resolved from the symbol preset when the picker is
	 * built. A preset switch (settings, Glyph Protocol upgrade, native rendering,
	 * which can land before the theme listener exists) rebuilds the picker.
	 */
	#refreshSlashCommandIcons(): void {
		if (theme.getSymbolPreset() === this.#slashIconPreset) return;
		this.#rebuildSlashCommandAutocomplete(this.sessionManager.getCwd());
	}

	/** Builtin, extension, custom, and `/skill:<name>` commands derived from live session state. */
	#buildPendingSlashCommands(): SlashCommand[] {
		this.#slashIconPreset = theme.getSymbolPreset();
		const builtinCommands: SlashCommand[] = buildTuiBuiltinSlashCommands({
			ctx: this,
		}).map(cmd => ({
			...cmd,
			icon: getSlashCommandTypeIcon(cmd.icon ?? "action"),
			iconName: cmd.icon ?? "action",
		}));

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			icon: getSlashCommandTypeIcon("extension"),
			iconName: "extension",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => {
			const complete = loaded.command.getArgumentCompletions?.bind(loaded.command);
			return {
				name: loaded.command.name,
				description: `${loaded.command.description} (${loaded.source})`,
				icon: getSlashCommandTypeIcon(loaded.path.startsWith("mcp:") ? "mcp" : "prompt"),
				iconName: loaded.path.startsWith("mcp:") ? "mcp" : "prompt",
				getArgumentCompletions: complete && (prefix => complete(prefix, this.sessionManager.getCwd())),
			};
		});

		const skillCommandList: SlashCommand[] = [];
		this.skillCommands.clear();
		if (this.session.skillsSettings?.enableSkillCommands !== false) {
			const icon = getSlashCommandTypeIcon("skill");
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
		if (theme.getSymbolPreset() !== this.#slashIconPreset)
			this.#pendingSlashCommands = this.#buildPendingSlashCommands();
		const fileCommands = this.session.slashCommands;
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const promptIcon = getSlashCommandTypeIcon("prompt");
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
				// The reload fired the memory scope hooks; complete the rebind
				// before the move commits so the next prompt cannot recall or
				// retain against the source project's memory.
				await rebindMemoryBackendForCwd(this.session);
			}
			// Re-warm plugin roots, capabilities, slash commands, and the ssh tool so
			// the next prompt sees everything scoped to the new project directory.
			clearClaudePluginRootsCache();
			await this.refreshTitleSystemPrompt(newCwd);
			await this.session.refreshSkillsAndCommands();
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
					await rebindMemoryBackendForCwd(this.session);
				}
				clearClaudePluginRootsCache();
				await this.refreshTitleSystemPrompt(previousCwd);
				await this.session.refreshSkillsAndCommands();
			} catch (restoreError) {
				const actual = this.sessionManager.getCwd();
				try {
					setProjectDir(actual);
					if (isSettingsInitialized()) {
						await settings.reloadForCwd(actual);
						await rebindMemoryBackendForCwd(this.session);
					}
					clearClaudePluginRootsCache();
					await this.refreshTitleSystemPrompt(actual);
					await this.session.refreshSkillsAndCommands();
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

		using _ = new EventLoopKeepalive();
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
		if (!cfgGoalContinuationModes.get(this.session.settings).includes("interactive")) return;
		if (this.planModeEnabled || this.planModePaused) return;
		if (!this.goalModeEnabled || this.goalModePaused) return;
		if (this.#goalSuppressNextContinuation) return;
		if (this.#goalOpenWorkAllBlocked()) return;
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
			if (this.#goalOpenWorkAllBlocked()) return;
			this.#pendingGoalContinuationTurns++;
			this.onInputCallback(
				this.startPendingSubmission({
					text: prompt,
					customType: "goal-continuation",
					display: false,
				}),
			);
		}, 800);
	}

	/** A blocked-only todo list has no work the agent can advance without another turn. */
	#goalOpenWorkAllBlocked(): boolean {
		const phases = this.session.getTodoPhases();
		if (nextActionableTask(phases)) return false;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.status === "blocked") return true;
			}
		}
		return false;
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
		let verdict: LoopConditionVerdict;
		try {
			verdict = await evaluateLoopCondition(condition, {
				cwd: this.sessionManager.getCwd(),
				timeoutMs: cfgLoopConditionTimeoutMs.get(settings),
				signal: controller.signal,
				sessionId: this.sessionManager.getSessionId(),
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
		this.statusLine.setLoopModeStatus(
			this.loopModeEnabled ? { state, limit: this.loopLimit, condition: this.loopCondition } : undefined,
		);
		this.ui.requestRender();
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
		this.loopModeEnabled = true;
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = createLoopLimitRuntime(parsed.limit);
		this.loopCondition = parsed.condition;
		this.#syncLoopModeStatus();
		const limitSuffix = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const remainingSuffix = this.loopLimit ? ` ${describeLoopLimitRuntime(this.loopLimit)}.` : "";
		// The condition is a *continuation* signal: the first iteration always
		// runs, and it is re-evaluated before each subsequent one.
		const conditionSuffix = parsed.condition ? ` Continuing ${describeLoopCondition(parsed.condition)}.` : "";
		const tail = parsed.prompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		this.showStatus(
			`Loop mode enabled.${limitSuffix}${remainingSuffix}${conditionSuffix} ${tail} ${appKey(this.keybindings, "app.interrupt")} suspends the ongoing loop; /loop again to disable.`,
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
		// Hold the row live (unfinalized) so it stays removable until reconcile,
		// instead of settling and retiring into immutable scrollback mid-preflight
		// where reconcile could no longer swap it out (issue #11217).
		for (const component of this.#optimisticSkillMessageComponents) {
			if (component instanceof SkillMessageComponent) component.markTranscriptBlockPending();
		}
		this.ensureLoadingAnimation();
		this.ui.requestRender();
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
		const components = this.#optimisticSkillMessageComponents;
		this.#optimisticSkillMessageComponents = [];
		const present = components.filter(component => this.chatContainer.children.includes(component));
		if (present.length > 0 && present.every(component => !this.chatContainer.canRemoveBlock(component))) {
			for (const component of present) {
				if (component instanceof SkillMessageComponent) component.markTranscriptBlockFinalized();
			}
			return;
		}
		for (const component of components) this.chatContainer.removeChild(component);
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
		options?: { preserveDraft?: boolean; clearEditor?: boolean },
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
		if (submission.customType !== "goal-continuation") {
			this.#pendingGoalContinuationTurns = 0;
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
		if (!options?.preserveDraft && options?.clearEditor !== false) {
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
			this.#pendingGoalContinuationTurns = Math.max(0, this.#pendingGoalContinuationTurns - 1);
		}
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		if (!submission.customType && !preserveDraft) {
			// Enter clears the submitted draft before this cancellation can run.
			// Keep anything typed or attached since then, after the recovered input.
			const laterText = this.editor.getExpandedText();
			const submittedImages = submission.images ?? [];
			const laterImages = this.editor.pendingImages;
			const recoveredText = laterText
				? `${submission.text}\n${shiftImageMarkers(laterText, submittedImages.length)}`
				: submission.text;
			this.editor.pendingImages = [...submittedImages, ...laterImages];
			this.editor.pendingImageLinks = [
				...(submission.imageLinks ?? submittedImages.map(() => undefined)),
				...this.editor.pendingImageLinks,
			];
			this.editor.imageLinks = this.editor.pendingImageLinks;
			this.rebuildChatFromMessages();
			this.editor.setCollapsedText(recoveredText);
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

	/** Live-setting composer preferences; `quiet` is startup-only and `composerShape` flows through {@link syncComposerShape}. */
	#liveComposerPreferences(): Omit<ComposerPreferences, "quiet" | "composerShape"> {
		return {
			showHardwareCursor: cfgShowHardwareCursor.get(this.settings),
			maxInlineImages: cfgTuiMaxInlineImages.get(this.settings),
			resizeScrollback: cfgTuiResizeScrollback.get(this.settings),
			imeSafeCursor: cfgTuiImeSafeCursor.get(this.settings),
			autocompleteMaxVisible: cfgAutocompleteMaxVisible.get(this.settings),
			spellingTypoDetection: cfgSpellingTypoDetection.get(this.settings),
			spellingAutocomplete: cfgSpellingAutocomplete.get(this.settings),
			spellingAutocorrect: cfgSpellingAutocorrect.get(this.settings),
		};
	}

	/**
	 * OSC 66 text-sizing is Kitty-only; resolve the setting against the terminal's
	 * capability (`TERMINAL.supportsTextSizing` defaults on for Kitty) so it stays off
	 * unless the user opts in, and never emits raw escapes on other terminals.
	 */
	#applyTextSizingSetting(): void {
		setTerminalTextSizing(cfgTuiTextSizing.get(this.settings) && TERMINAL.supportsTextSizing);
	}

	/** Charts under assistant tables per `tui.autoGraph`; `smart` picks multi-series charts through the session's judge. */
	#applyAutoGraphSetting(): void {
		const mode = cfgTuiAutoGraph.get(this.settings);
		setTableCharts(
			mode,
			mode === "smart" ? request => pickTableChart(request, this.session.tableChartJudge()) : undefined,
		);
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

		if (
			any(
				"showHardwareCursor",
				"tui.maxInlineImages",
				"tui.resizeScrollback",
				"tui.imeSafeCursor",
				"autocompleteMaxVisible",
				"spelling.typoDetection",
				"spelling.autocomplete",
				"spelling.autocorrect",
			)
		) {
			this.composer.setPreferences(this.#liveComposerPreferences());
			// setPreferences re-themes the editor, which resets its mode-tinted border.
			this.updateEditorBorderColor();
		}
		if (any("composer.shape")) this.syncComposerShape();
		if (any("tui.vimMode", "tui.vimModeDisplay")) this.#applyVimModeSetting();
		if (any("display.pinnedAgents")) this.applyPinnedAgentsSetting();
		if (any("display.subagentLivePreview")) {
			this.#renderSubagentList();
			this.ui.requestRender();
		}
		if (any("compaction.idleEnabled", "compaction.idleThresholdTokens", "compaction.idleTimeoutSeconds")) {
			this.#eventController.refreshIdleCompactionTimer();
		}
		if (any("recap.enabled", "recap.idleSeconds")) this.#eventController.refreshIdleRecapTimer();
		if (any("composer.predictions") && !next["composer.predictions"]) {
			this.#eventController.composerPrediction.cancel();
		}
		if (any("compaction.enabled", "compaction.methodOrder")) {
			this.statusLine.setAutoCompactEnabled(this.session.autoCompactionEnabled);
			this.ui.requestRender();
		}

		// Field comparisons skip effects the keybinding toggles already applied.
		const hideToolActivity = cfgDisplayHideToolActivity.get(this.settings);
		if (any("display.hideToolActivity") && hideToolActivity !== this.hideToolActivity) {
			this.hideToolActivity = hideToolActivity;
			if (!hideToolActivity) this.toolOutputExpanded = false;
			for (const child of this.chatContainer.children) {
				if (
					!hideToolActivity &&
					(child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent)
				) {
					child.setExpanded(false);
				} else if (child instanceof AssistantMessageComponent) {
					child.setToolResultImagesVisible(!hideToolActivity);
				}
			}
			this.chatContainer.setToolActivityVisible(!hideToolActivity);
			if (hideToolActivity) this.ui.clearInlineImages();
			// Visibility changes must rebuild retired terminal history.
			resetDisplay = true;
		}
		if (any("terminal.showImages")) {
			const visible = cfgTerminalShowImages.get(this.settings);
			for (const child of this.chatContainer.children) {
				if (child instanceof ToolExecutionComponent) {
					child.setShowImages(visible);
				} else if (child instanceof AssistantMessageComponent) {
					child.setImagesVisible(visible);
				}
			}
			if (!visible) this.ui.clearInlineImages();
			this.ui.requestRender(true);
		}
		const hideThinkingBlock = cfgHideThinkingBlock.get(this.settings);
		if (any("hideThinkingBlock") && hideThinkingBlock !== this.hideThinkingBlock) {
			this.hideThinkingBlock = hideThinkingBlock;
			for (const child of this.chatContainer.children) {
				if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(this.effectiveHideThinkingBlock);
			}
			this.ui.requestRender(true);
		}
		const proseOnlyThinking = cfgProseOnlyThinking.get(this.settings);
		if (any("proseOnlyThinking") && proseOnlyThinking !== this.proseOnlyThinking) {
			this.proseOnlyThinking = proseOnlyThinking;
			for (const child of this.chatContainer.children) {
				if (child instanceof AssistantMessageComponent) child.setProseOnlyThinking(proseOnlyThinking);
			}
			this.ui.requestRender(true);
		}
		const expandThinkingBlocks = cfgExpandThinkingBlocks.get(this.settings);
		if (any("expandThinkingBlocks") && expandThinkingBlocks !== this.expandThinkingBlocks) {
			this.expandThinkingBlocks = expandThinkingBlocks;
			for (const child of this.chatContainer.children) {
				if (child instanceof AssistantMessageComponent) child.setExpandThinkingBlocks(expandThinkingBlocks);
			}
			this.ui.requestRender(true);
		}

		// Usage-row detection, compacted-history collapse, and markdown render
		// options are baked in at build time: rebuild, then retire rows already
		// committed to native scrollback.
		if (
			any("display.cacheMissMarker", "display.collapseCompacted", "display.showTokenUsage", "display.showTurnTime")
		) {
			rebuildChat = true;
		}
		if (any("tui.renderMermaid")) {
			setMarkdownMermaidRendering(cfgTuiRenderMermaid.get(this.settings));
			rebuildChat = true;
		}
		if (any("tui.renderSvg")) {
			setSvgFigureRendering(cfgTuiRenderSvg.get(this.settings));
			rebuildChat = true;
		}
		if (any("tui.autoGraph")) {
			this.#applyAutoGraphSetting();
			rebuildChat = true;
		}
		if (any("tui.textSizing")) {
			this.#applyTextSizingSetting();
			this.ui.invalidate();
			resetDisplay = true;
		}
		if (any("tui.tight")) {
			setTuiTight(cfgTuiTight.get(this.settings));
			this.ui.invalidate();
			this.ui.requestRender();
		}
		if (any("tui.hyperlinks")) {
			// The tui.hyperlinks effect already re-applied the flag; repaint cached rows.
			this.statusLine.invalidate();
			this.ui.invalidate();
			this.ui.requestRender();
		}
		if (any("tui.titleState")) setTerminalTitleStateEnabled(cfgTuiTitleState.get(this.settings));
		if (any("tui.titleSpinner")) setTerminalTitleSpinnerStyle(cfgTuiTitleSpinner.get(this.settings));
		if (any("terminal.programStatus")) setProgramStatusEnabled(cfgTerminalProgramStatus.get(this.settings));

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
			this.#syncStatusLineSettings();
			this.ui.requestRender();
		}
		if (any("statusLine.sessionAccent")) this.#handleSessionAccentInputsChanged();
		// Advisor runtime start/stop has no session event; repaint its status segment.
		if (any("advisor.enabled", "advisor.maxNotesPerUpdate", "tier.advisor")) {
			this.statusLine.invalidate();
			this.ui.requestRender();
		}

		if (rebuildChat) this.rebuildChatFromMessages();
		if (rebuildChat || resetDisplay) this.ui.resetDisplay();
	}

	#syncStatusLineSettings(): void {
		this.statusLine.updateSettings({
			preset: cfgStatusLinePreset.get(settings),
			leftSegments: cfgStatusLineLeftSegments.get(settings),
			rightSegments: cfgStatusLineRightSegments.get(settings),
			separator: cfgStatusLineSeparator.get(settings),
			showHookStatus: cfgStatusLineShowHookStatus.get(settings),
			sessionAccent: cfgStatusLineSessionAccent.get(settings),
			transparent: cfgStatusLineTransparent.get(settings),
			segmentOptions: cfgStatusLineSegmentOptions.get(settings),
			compactThinkingLevel: cfgStatusLineCompactThinkingLevel.get(settings),
			contextLine: cfgStatusLineContextLine.get(settings),
		});
	}
	syncComposerShape(): void {
		const shape = cfgComposerShape.get(settings);
		const style = getComposerStyle(shape);
		this.composer.setPreferences({ composerShape: shape });
		this.statusLine.attachToEditor(this.editor, style);
		this.updateEditorBorderColor();
		this.#scheduleComposerStatusPersist();
		this.ui.requestRender();
	}

	/** Coalesce status-cache writes; `stop()` flushes a pending one synchronously. */
	#scheduleComposerStatusPersist(): void {
		if (this.#composerStatusPersistTimer) return;
		this.#composerStatusPersistTimer = setTimeout(() => {
			this.#composerStatusPersistTimer = undefined;
			this.#persistComposerStatus();
		}, COMPOSER_STATUS_PERSIST_DELAY_MS);
		this.#composerStatusPersistTimer.unref();
	}

	/**
	 * Cache the inputs of a fresh session's status bar (settings, model, thinking
	 * state) so the next launch renders it at first paint; see `createStartupStatusLine`.
	 */
	#persistComposerStatus(): void {
		if (!this.sessionManager.getSessionFile()) return;
		const model = this.session.model;
		// Recover the border's ANSI wrapper by coloring a sentinel and splitting around it.
		const marker = "\0";
		const colored = this.editor.borderColor(marker);
		const markerIndex = colored.indexOf(marker);
		const status: ComposerStatusCache = {
			borderColor:
				markerIndex < 0
					? undefined
					: {
							prefix: colored.slice(0, markerIndex),
							suffix: colored.slice(markerIndex + marker.length),
						},
			statusLine: {
				settings: statusLineHost.getSettings(),
				gitEnabled: statusLineHost.gitEnabled(),
				model,
				thinkingLevel: this.session.thinkingLevel,
				autoThinking: this.session.isAutoThinking,
				fastMode: this.session.isFastModeActive(),
				usingSubscription: model ? this.session.modelRegistry.isUsingOAuth(model) : false,
				autoCompactEnabled: this.session.autoCompactionEnabled,
				compactionBoundaries: model?.contextWindow
					? statusLineHost.computeCompactionBoundaries(this.session, model.contextWindow, model)
					: null,
			},
		};
		sharedComposerCache()?.writeStatus(this.sessionManager.getCwd(), status);
	}

	#handleSessionAccentInputsChanged(): void {
		this.#clearWorkingMessageAccentCache();
		this.statusLine.invalidate();
		this.updateEditorBorderColor();
	}

	updateEditorBorderColor(): void {
		// `vimMode` reads "insert" when modal editing is off, so every Vim branch below must gate on
		// `vimEnabled` — otherwise non-Vim users would lose the session-accent/thinking border.
		const vimMode = this.editor.vimEnabled ? this.editor.vimMode : undefined;
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else if (this.isPythonMode) {
			this.editor.borderColor = theme.getPythonModeBorderColor();
		} else if (vimMode === "visual" || vimMode === "visual-line") {
			this.editor.borderColor = (str: string) => theme.fg("warning", str);
		} else if (vimMode === "normal" || vimMode === "replace") {
			this.editor.borderColor = (str: string) => theme.fg("accent", str);
		} else if (vimMode === "insert") {
			// Insert gets its own colour rather than falling through to the session accent: with Normal
			// and Visual both coloured, an uncoloured Insert made the border unreadable as a mode.
			// Matches the `vim` status-line segment, which uses the same three colours.
			this.editor.borderColor = (str: string) => theme.fg("success", str);
		} else {
			const accentEnabled = !isSettingsInitialized() || cfgStatusLineSessionAccent.get(settings) !== false;
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

	/**
	 * Refresh the running-subagents status badge from the active local or collab
	 * registry, and the cost segment's subagent-tree spend (local sessions only:
	 * a collab guest's registry mirrors host transcripts outside this root).
	 */
	syncRunningSubagentBadge(options: { requestRender?: boolean } = {}): void {
		const registry = getRunningSubagentBadgeRegistry(this.collabGuest, AgentRegistry.global());
		if (this.#agentRegistrySubscriptionTarget !== registry) {
			this.#agentRegistryUnsubscribe?.();
			this.#agentRegistrySubscriptionTarget = registry;
			this.#agentRegistryUnsubscribe = registry.onChange(() => {
				this.syncRunningSubagentBadge();
			});
		}
		const agentIds = getRunningSubagentBadgeAgentIds(registry);
		this.#runningSubagentCount = agentIds.length;
		this.statusLine.setRunningSubagents(agentIds);
		if (this.collabGuest) {
			this.statusLine.setSubagentTreeCost(0);
		} else {
			const rootSessionFile = this.sessionManager.getSessionFile() ?? undefined;
			this.#hydratePersistedSubagentCosts(rootSessionFile);
			this.statusLine.setSubagentTreeCost(
				sumSubagentTreeCost({
					refs: AgentRegistry.global().list(),
					observers: this.#observerRegistry,
					rootSessionFile,
					sessionMetrics: this.#subagentSessionMetrics,
				}),
			);
		}
		if (options.requestRender !== false) this.ui.requestRender();
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

	/**
	 * What the TSP composer shows: the draft's shell mode, the effort chip
	 * (the viewed agent's, like the model chip beside it) or the model chip's
	 * effort icon, the tok/s readout after it, send vs Stop, and the session
	 * title the empty composer's placeholder quotes.
	 */
	#composerNativeState(): ComposerNativeState {
		const draft = this.editor.getText().trimStart();
		return {
			shell: this.isBashMode
				? { kind: "bash", excluded: draft.startsWith("!!") }
				: this.isPythonMode
					? { kind: "python", excluded: draft.startsWith("$$") }
					: undefined,
			thinking: thinkingLevelWord(this.viewSession),
			thinkingInModel: cfgStatusLineCompactThinkingLevel.get(settings),
			rate: this.#nativeTokenRate(),
			running: this.loadingAnimation !== undefined || this.session.isStreaming,
			viewing: this.#viewingLineage(),
			title: this.sessionManager.getSessionName(),
		};
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

	/** Placeholder for the empty composer; see `COMPOSER_HINTS` for the registered hints. */
	#composerHint(): string | undefined {
		return resolveComposerHint({
			runningAgents: this.#runningSubagentCount,
			focusedOnAgent: this.focusedAgentId !== undefined,
			conversationStarted: this.viewSession.messages.length > 0,
			keybindings: this.keybindings,
			uses: id => hintUsage.get(id),
		});
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
			collapseCompactedHistory: cfgDisplayCollapseCompacted.get(settings),
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
		owner.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: next,
		});
		owner.setTodoPhases(next);
		this.todoPhases = next;
		this.#syncTodoHudState(owner);
		this.#renderTodoList();
		this.ui.requestRender();
	}

	#cancelTodoAutoClearTimer(): void {
		this.#todoAutoClearGeneration++;
		if (this.#todoAutoClearTimer) {
			clearTimeout(this.#todoAutoClearTimer);
			this.#todoAutoClearTimer = undefined;
		}
	}

	#syncTodoHudState(owner: AgentSession): void {
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
			this.ui.requestRender();
		};
		this.#todoAutoClearTimer = setTimeout(() => {
			void persistAndHide().catch(error => {
				logger.warn("Failed to persist TODO HUD dismissal", { error });
			});
		}, delaySeconds * 1000);
		this.#todoAutoClearTimer.unref?.();
	}

	/**
	 * Render the ctrl+p model-role cycle chip track into its own anchored
	 * container (just above the editor), mirroring the todo HUD: the container is
	 * cleared and rebuilt in place on every cycle, so rapid presses or concurrent
	 * chat activity can never stack duplicate tracks into the scrollback.
	 */
	showModelCycleTrack(segments: readonly TrackSegment[], activeIndex: number): void {
		this.#renderModelCycleTrack({ segments, activeIndex });
		this.#syncModelCycleClearTimer();
		this.ui.requestRender();
	}

	#renderModelCycleTrack(track: { segments: readonly TrackSegment[]; activeIndex: number } | null): void {
		this.modelCycleContainer.clear();
		if (!track) return;
		this.modelCycleContainer.addChild(new Spacer(1));
		this.modelCycleContainer.addChild(
			new DescribedComponent(
				new Text(renderSegmentTrack([...track.segments], track.activeIndex), 1, 0),
				describeSegmentTrack(track.segments, track.activeIndex),
			),
		);
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
			this.#syncTodoHudState(this.#todoPhasesOwner ?? this.session);
			this.#renderTodoList();
		} else if (this.#getActiveSubagentDescriptions().join("\n") !== this.#todoHudSubagentKey) {
			// Progress-only ticks (10 Hz while subagents run) cannot change the
			// todo phases or their persisted visibility — re-syncing would also
			// re-arm the auto-clear timer so it could never fire. Only the HUD's
			// subagent highlight depends on them, so repaint just when the active
			// descriptions change.
			this.#renderTodoList();
		}
		this.#renderSubagentList();
		this.ui.requestRender();
	}

	#cancelObserverUiSyncTimer(): void {
		if (this.#observerUiSyncTimer) {
			clearTimeout(this.#observerUiSyncTimer);
			this.#observerUiSyncTimer = undefined;
		}
		this.#observerUiSyncNeedsTodoReconcile = false;
		this.#cancelSubagentPreviewTick();
	}

	#renderTodoList(): void {
		this.todoContainer.clear();
		this.#todoHudNative = undefined;
		const activeDescs = this.#getActiveSubagentDescriptions();
		this.#todoHudSubagentKey = activeDescs.join("\n");
		if (this.#todoHudHidden) return;
		const phases = this.todoPhases.filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return;
		const expanded = this.todoExpanded;
		const multiPhase = phases.length > 1;
		const activeIdx = phases.indexOf(this.#getActivePhase(phases) ?? phases[0]);
		// Fixed budgets keep the HUD bounded regardless of plan size / progress.
		const subsequentStageCap = 4; // stages shown after the active one (a trailing summary row covers the rest)
		const activeTaskCap = 5; // open tasks previewed for the active stage

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

		// Native: the same stage window as a tree, overall progress as a bar.
		const describeTask = (todo: TodoItem, id: string): TspTreeNode => {
			const done = todo.status === "completed";
			const token =
				todo.status === "completed"
					? "success del"
					: todo.status === "abandoned"
						? "error del"
						: todo.status === "blocked"
							? "warning"
							: todo.status === "in_progress" || isMatched(todo)
								? "accent"
								: "dim";
			const label: TspSpan[] = [span(todo.status === "blocked" ? `${todo.content} (blocked)` : todo.content, token)];
			const notes = todo.notes?.length ?? 0;
			if (notes > 0) label.push(span(` +${notes}`, "dim em"));
			return { id, label, icon: done ? "check" : "circle" };
		};
		const describeTasks = (phase: TodoPhase, phaseIndex: number): TspTreeNode[] => {
			const index = (todo: TodoItem): string => `${phaseIndex}.${phase.tasks.indexOf(todo)}`;
			if (expanded) return phase.tasks.map(todo => describeTask(todo, index(todo)));
			const selection = selectCollapsedTodos(phase.tasks, isMatched, activeTaskCap);
			const nodes = selection.items.map(todo => describeTask(todo, index(todo)));
			if (selection.summary) nodes.push({ id: `${phaseIndex}.more`, label: [span(selection.summary, "muted")] });
			return nodes;
		};
		const phaseNodes: TspTreeNode[] = phaseSlice.map((phase, offset) => {
			const phaseIndex = baseIdx + offset;
			const isActive = phaseIndex === activeIdx;
			const name = multiPhase ? formatPhaseDisplayName(phase.name, phaseIndex + 1) : phase.name;
			const done = phase.tasks.filter(isClosedTodo).length;
			const open = isActive || expanded;
			return {
				id: `${phaseIndex}`,
				label: [span(name, isActive ? "accent strong" : "muted"), span(` · ${done}/${phase.tasks.length}`, "dim")],
				open,
				children: open ? describeTasks(phase, phaseIndex) : undefined,
			};
		});
		if (hiddenStages > 0) {
			phaseNodes.push({ id: "more", label: [span(formatMoreItems(hiddenStages, "stage"), "muted")] });
		}
		const fallback = node(
			"col",
			{ role: "omp.hud.todo" },
			[
				row(
					[
						text([span("TODO", "accent strong")]),
						node("progress", { value: closedTasks / totalTasks, label: `${closedTasks}/${totalTasks}` }),
					],
					{ gap: "sm", align: "center" },
				),
				node("tree", { nodes: phaseNodes }),
			],
			"todo",
		);
		// A `checklist` HUD is a pill with the whole plan as its popover.
		const checklistPhases: TspChecklistPhase[] = phases.map((phase, phaseIndex) => ({
			id: `${phaseIndex}`,
			title: multiPhase ? formatPhaseDisplayName(phase.name, phaseIndex + 1) : phase.name,
			collapsed: phase.tasks.every(isClosedTodo) || undefined,
			items: phase.tasks.map((todo, taskIndex): TspChecklistItem => {
				const note = todo.blocker ?? todo.notes?.at(-1);
				return {
					id: `${phaseIndex}.${taskIndex}`,
					text: todo.content,
					status:
						todo.status === "completed"
							? "done"
							: todo.status === "abandoned"
								? "dropped"
								: todo.status === "blocked"
									? "blocked"
									: todo.status === "in_progress" || isMatched(todo)
										? "active"
										: "pending",
					note,
				};
			}),
		}));
		this.#todoHudNative = {
			checklist: node(
				"checklist",
				{ phases: checklistPhases, mode: "hud", role: "omp.hud.todo" },
				undefined,
				"todo",
			),
			fallback,
		};
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

	async #loadTodoList(source: AgentSession = this.session): Promise<void> {
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
		this.statusLine.setPlanModeStatus(status);
		this.ui.requestRender();
	}

	#updateVibeModeStatus(): void {
		this.statusLine.setVibeModeStatus(this.vibeModeEnabled ? { enabled: true } : undefined);
		this.ui.requestRender();
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
		this.#cancelSubagentPreviewTick();
		const view = this.#buildSubagentHudView();
		if (!view) {
			this.subagentContainer.clear();
			return;
		}
		const hud = this.subagentContainer.children[0];
		if (hud instanceof SubagentHudComponent) hud.update(view.lines, view.order, view.toggleRow);
		else this.subagentContainer.addChild(new SubagentHudComponent(view.lines, view.order, view.toggleRow));
		this.#armSubagentPreviewTick(view.tickMs);
	}

	/** Inputs for one HUD paint; undefined when the HUD is off or nothing is running. */
	#buildSubagentHudView():
		| {
				lines: string[];
				order: string[];
				toggleRow: number | undefined;
				tickMs: number | undefined;
		  }
		| undefined {
		const mode = cfgDisplayPinnedAgents.get(settings);
		if (mode === "off") return undefined;
		const sessions = this.#observerRegistry.getSessions();
		const running = sessions.filter(isHudSubagent);
		const expanded = this.#pinnedHudOverride ?? mode === "full";
		const livePreview = cfgDisplaySubagentLivePreview.get(settings);
		const lines = renderSubagentHudLines(sessions, this.ui.terminal.columns, expanded, livePreview);
		if (lines.length === 0) return undefined;
		const layout = layoutPinnedHud(running.length, expanded);
		const tickMs =
			livePreview && !agentPauseGate.paused
				? nextSubagentPreviewTickMs(running.slice(0, layout.itemRows), Date.now())
				: undefined;
		return { lines, order: running.map(session => session.id), toggleRow: layout.toggleRow, tickMs };
	}

	#armSubagentPreviewTick(tickMs: number | undefined): void {
		if (tickMs === undefined) return;
		this.#subagentPreviewTickTimer = setTimeout(() => {
			this.#subagentPreviewTickTimer = undefined;
			this.#renderSubagentList();
			this.ui.requestRender();
		}, tickMs);
		this.#subagentPreviewTickTimer.unref?.();
	}

	#cancelSubagentPreviewTick(): void {
		if (this.#subagentPreviewTickTimer) {
			clearTimeout(this.#subagentPreviewTickTimer);
			this.#subagentPreviewTickTimer = undefined;
		}
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
			? {
					model: currentModel,
					thinkingLevel: this.session.configuredThinkingLevel(),
				}
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
			if (options?.restorePlanModel && previousModel) {
				await this.#restorePlanPreviousModel(previousModel);
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
			this.#pendingGoalContinuationTurns = 0;
			this.#previousGoalContinuationActivity = undefined;
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
		const previousMountedTools = this.session.getMountedXdevToolNames();
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

		this.#planModePreviousToolPresentation = {
			enabled: previousTools.filter(name => !isMCPToolName(name)),
			mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
		};
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
				(!modelsAreEqual(this.session.model, planModeModelState.model) ||
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
		if (!options?.deferModelRestore) this.#planModePreviousModelState = undefined;
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
	 * tools/model and cleared the `xd://propose` handler, so "Exit plan mode
	 * first." reads as stale right after the user toggled plan mode off (#11692);
	 * point them at the second `/plan` toggle that fully exits instead.
	 */
	#warnPlanModeBlocks(): void {
		this.showWarning(
			this.planModePaused ? "Plan mode is paused — run /plan again to fully exit." : "Exit plan mode first.",
		);
	}

	async #enterGoalMode(options: { objective?: string; resume?: boolean; silent?: boolean }): Promise<void> {
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
		const previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#goalModePreviousTools = previousTools;
		this.goalModePaused = false;
		const state = options.resume
			? await this.session.goalRuntime.resumeGoal()
			: await this.session.goalRuntime.createGoal({
					objective: options.objective ?? "",
				});
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
		this.#pendingGoalContinuationTurns = 0;
		this.#previousGoalContinuationActivity = undefined;
		this.#goalSuppressNextContinuation = false;
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
				externalEditorLabel: appKey(this.keybindings, "app.editor.external") || undefined,
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

	/** Apply the `tui.vimMode` setting to an editor and route Visual-mode yanks to the clipboard. */
	#applyVimMode(editor: CustomEditor): void {
		editor.setVimMode(cfgTuiVimMode.get(settings));
		editor.onYank = text => {
			void this.#copyYankToClipboard(text);
		};
		// Recolor the prompt border on every mode switch: in a modal editor the mode has to be
		// visible at a glance, and the border is where bash/python mode already signal themselves.
		editor.onVimModeChange = () => this.#syncVimStatus(editor);
	}

	/**
	 * Re-apply `tui.vimMode` to the live editor. `setVimMode` is idempotent and always lands in
	 * Insert, so toggling the setting mid-session can never strand the editor in a mode where
	 * ordinary typing does nothing.
	 */
	#applyVimModeSetting(): void {
		this.#applyVimMode(this.editor);
		this.#syncVimStatus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Push an editor's modal state into the three places that surface it: the prompt border, the
	 * status-line `vim` segment, and the hardware cursor shape. Called on every mode/pending change,
	 * so it stays cheap — the terminal dedupes an unchanged DECSCUSR shape. Takes the editor rather
	 * than reading `this.editor`: `setEditorComponent` configures its replacement before swapping it in.
	 */
	#syncVimStatus(editor: CustomEditor): void {
		this.statusLine.setVimStatus(
			editor.vimEnabled
				? {
						mode: editor.vimMode,
						pending: editor.vimPending,
						selectedLines: editor.vimSelectedLines,
						display: cfgTuiVimModeDisplay.get(settings),
					}
				: undefined,
		);
		// Insert gets the bar every non-modal editor uses; Normal/Visual rest *on* a grapheme, which
		// is a block. Sent unconditionally: the software cursor carries the same distinction itself
		// (Editor#cursorCell), and when the hardware cursor is hidden this only reshapes something
		// invisible. ProcessTerminal dedupes, so an unchanged shape costs nothing per frame.
		this.ui.terminal.setCursorShape?.(
			editor.vimEnabled && editor.vimMode !== "insert" ? "block" : editor.vimEnabled ? "bar" : "default",
		);
		this.updateEditorBorderColor();
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
		},
	): Promise<boolean> {
		const previousPresentation = this.#planModePreviousToolPresentation ?? {
			enabled: this.session.getEnabledToolNames().filter(name => !isMCPToolName(name)),
			mounted: this.session.getMountedXdevToolNames().filter(name => !isMCPToolName(name)),
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

		// Restore the execution tool set, but force-enable `read` so the durable
		// local:// plan remains available if the inline copy becomes unrecoverable.
		const executionTools = previousPresentation.enabled.includes("read")
			? previousPresentation.enabled
			: [...previousPresentation.enabled, "read"];
		await this.session.restoreNonMCPToolPresentation(executionTools, previousPresentation.mounted);
		this.session.setPlanReferencePath(options.planFilePath);
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
			// calling `goal create`. Record the pre-interview toolset first: the
			// tool-driven create flips goalModeEnabled via `goal_updated`, and the
			// eventual goal exit restores this set (dropping the goal tool again).
			const enabledTools = this.session.getEnabledToolNames();
			this.#goalModePreviousTools = enabledTools.filter(name => name !== "goal");
			if (!enabledTools.includes("goal")) {
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
		using _keepalive = new EventLoopKeepalive();
		await this.session.prompt(objective, { streamingBehavior: "steer" });
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
						},
					}
				: undefined;
		// The overlay now owns the dynamic, focus-aware help line; the caller only
		// supplies the trailing cancel hint.
		const helpText = `${editorKey("tui.select.cancel")} cancel`;
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
		const choice = await this.#extensionUiController.showCollabAwareSelector(`${headline}\n${body}`, ["Yes", "No"]);
		return choice === "Yes";
	}

	/**
	 * Ask the user to approve one `cfg://` settings change; writable `/collab` guests get the
	 * same prompt and the first answer wins. Dismissing the dialog denies it; leaving it
	 * unanswered for {@link CFG_APPROVAL_TIMEOUT_MS} (any host keypress restarts the
	 * countdown) drops it as `timeout`.
	 */
	async #promptCfgChange(request: CfgChangeRequest): Promise<CfgApproval> {
		const headline = request.save
			? `💾 Your agent wants to save \`${request.path}\` to your config.`
			: `⚙️ Your agent wants to change \`${request.path}\` for this session.`;
		const warning = request.shadowedBy
			? `\n⚠️ Overridden by your ${request.shadowedBy}: the saved value won't take effect here.`
			: "";
		let timedOut = false;
		const choice = await this.#extensionUiController.showCollabAwareSelector(
			`${headline}\n${request.previous} → ${request.value}${warning}`,
			[CFG_APPROVE_SESSION, CFG_APPROVE_ONCE, CFG_DENY],
			{
				// A reflexive Enter approves this change only, never the whole session.
				initialIndex: 1,
				timeout: CFG_APPROVAL_TIMEOUT_MS,
				// The selector auto-picks the highlighted option on expiry; an unanswered prompt approves nothing.
				onTimeout: () => {
					timedOut = true;
				},
			},
		);
		if (timedOut) return "timeout";
		if (choice === CFG_APPROVE_SESSION) return "session";
		if (choice === CFG_APPROVE_ONCE) return "once";
		return "deny";
	}

	stop(): void {
		this.#appearanceRefreshRequest = undefined;
		this.#streamPublisher?.dispose();
		this.#streamPublisher = undefined;
		void this.#recorder?.stop();
		this.#recorder = undefined;
		// Last chance to refresh the startup status placeholder for the next launch.
		clearTimeout(this.#composerStatusPersistTimer);
		this.#composerStatusPersistTimer = undefined;
		this.#persistComposerStatus();
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(false);
		}
		this.#micCursor?.dispose();
		this.#micCursor = undefined;
		// Stop the shared tool-spinner ticker: a live block missed by per-component
		// stopAnimation would otherwise keep an 80ms interval pinning the process.
		stopSharedSpinnerTicker();
		this.#liveCommandController.dispose();
		this.#clearJudgmentBatchProgress();
		this.#downloadActivityHud.dispose();
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
		setCfgApprovalHost(null);
		this.#hideSessionInfo();
		if (this.#ownsStartedUi) {
			this.ui.stop();
			this.#ownsStartedUi = false;
		}
		this.isInitialized = false;
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		// The previous graceful teardown failed AT the memoized session.dispose()
		// (the session is already disposing), so it re-rejects identically forever
		// and the process can never close (#12238: a corrupted session file makes
		// the close-time rewrite refuse to clobber it). This second attempt is the
		// escape hatch: quit without writing the session log. 130 = 128 + SIGINT,
		// matching the Ctrl+C hard-abort exit code in input-controller.
		if (this.#teardownFailed) {
			try {
				await postmortem.quit(130);
			} catch {
				// Extension/hook loading temporarily guards process.exit. Cleanup
				// has already run; bypass that guard for this host-owned escape.
				postmortem.exitProcess(130);
			}
			return;
		}
		this.#beginClose();
		const worktreePlan = await this.#planOwnedWorktreeExit();
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

		await postmortem.quit(0);
	}

	#handleTeardownError(action: "close" | "restart", error: unknown): void {
		this.#isShuttingDown = false;
		const detail = error instanceof Error ? error.message : String(error);
		// Arm the escape hatch only once dispose() has begun: its promise is
		// memoized, so a retry can only re-fail. A failure BEFORE dispose (a
		// transient BTW/live-command flush) leaves the session undisposed and
		// the teardown genuinely retryable, so it must not force-quit.
		this.#teardownFailed = this.session.isDisposed;
		this.showError(
			this.#teardownFailed
				? `Could not ${action} session: ${detail}\nPress ${appKey(this.keybindings, "app.clear")} again to exit without saving the session log.`
				: `Could not ${action} session: ${detail}`,
		);
	}

	/**
	 * Apply `worktree.onExit` to worktrees this launch created and return the ones
	 * to remove after teardown. Stops the agent turn and live commands first so the
	 * prompts describe a worktree nothing is still writing to. Never throws.
	 */
	async #planOwnedWorktreeExit(): Promise<WorktreeExitPlan[]> {
		const policy = cfgWorktreeOnExit.get(this.settings);
		if (policy === "keep" || this.#ownedWorktrees.length === 0) return [];
		this.#abortLoopCondition();
		this.#cancelLoopAutoSubmit();
		try {
			await this.session.abort();
			await this.#liveCommandController.stop();
		} catch (err) {
			this.showWarning(err instanceof Error ? err.message : String(err));
		}
		return planWorktreeExit(
			this.#ownedWorktrees,
			policy,
			(title, message) => this.showHookConfirm(title, message),
			message => this.showWarning(message),
		);
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
		this.#beginClose();
		try {
			await this.#teardown();
		} catch (error) {
			this.#handleTeardownError("restart", error);
			return;
		}

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
	#beginClose(): void {
		this.#isShuttingDown = true;
		this.showStatus("Closing session…");
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
		// Close the TSP surfaces first so the drain below also swallows what the
		// terminal still sends them (acks, events) instead of the shell.
		this.ui.closeNative();
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		// Stop the run-state spinner interval BEFORE restoring the shell title, so a
		// pending tick cannot re-emit an OSC title after `popTerminalTitle` hands the
		// terminal back (which would leave the parent shell with a `π ⠋ …` tab).
		disposeTerminalTitleState();
		disposeProgramStatus();
		popTerminalTitle();
		this.stop();
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
			this.session.hasPendingAsyncWork()
		) {
			return;
		}
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
		nextEditor.setImeSafeCursorLayout(cfgTuiImeSafeCursor.get(this.settings));
		this.#applyVimMode(nextEditor);
		nextEditor.setAutocompleteMaxVisible(cfgAutocompleteMaxVisible.get(this.settings));
		nextEditor.setSpellingFeatures({
			typoDetection: cfgSpellingTypoDetection.get(this.settings),
			autocomplete: cfgSpellingAutocomplete.get(this.settings),
			autocorrect: cfgSpellingAutocorrect.get(this.settings),
		});
		nextEditor.viewportRowsProvider = () => this.ui.terminal.rows;
		nextEditor.magicKeywordsEnabled = () => cfgMagicKeywordsEnabled.get(this.settings);
		nextEditor.placeholder = () => this.#composerHint();
		nextEditor.prediction = () => this.#eventController.composerPrediction.text;
		nextEditor.composerState = () => this.#composerNativeState();
		nextEditor.attachmentChips = previousEditor.attachmentChips;
		nextEditor.imageReferenceHyperlink = imageReferenceHyperlink;
		nextEditor.skillFilePath = name => this.skillCommands.get(`skill:${name}`)?.filePath;
		nextEditor.modelMentionLabel = selector => {
			const model = this.session.findMentionableModel(selector);
			return model ? modelMentionChipLabel(modelMentionDisplayName(model)) : undefined;
		};
		nextEditor.modelMentionSelector = agent => this.session.modelMentions.find(m => m.agent === agent)?.selector;
		nextEditor.fileHyperlink = (filePath, text) => fileHyperlink(filePath, text, { line: 1 });
		nextEditor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		nextEditor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		// A swap during startup keeps the bootstrap submit gate until init lifts it.
		nextEditor.disableSubmit = previousEditor.disableSubmit;
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
			logger.warn("Failed to refresh slash command state for custom editor", {
				error: String(error),
			});
		});

		this.#syncVimStatus(nextEditor);
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
	 *
	 * A Tern Surface Protocol surface has no append-only scrollback to
	 * duplicate into, so there the panel mounts in the transcript at once.
	 */
	presentCommandOutput(content: Component | readonly Component[]): void {
		if (!this.session.isStreaming || this.ui.nativeRendering) {
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
	showSessionInfo(info: string, context?: ContextUsage): void {
		this.#hideSessionInfo();
		const overlay = new SessionInfoOverlay(this.ui, info, () => this.#hideSessionInfo(), context);
		this.#sessionInfoOverlayHandle = this.ui.showOverlay(overlay, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ui.setFocus(overlay);
		this.ui.requestRender();
	}

	/**
	 * The jobs pill's sheet: live background jobs in a dismissable overlay.
	 * Unlike `/jobs` it adds nothing to the transcript, so a click mid-turn
	 * leaves no deferred command preview above the editor.
	 */
	showJobsSheet(): void {
		if (this.#jobsSheetHandle) return;
		if (!this.session.getAsyncJobSnapshot()) {
			this.showWarning("Async background jobs are unavailable in this session.");
			return;
		}
		const sheet = new JobsSheet({
			load: () => this.session.getAsyncJobSnapshot({ recentLimit: 5 }) ?? { running: [], recent: [] },
			inspect: id => this.session.inspectAsyncJob(id),
			cancel: id => {
				this.session.cancelAsyncJob(id);
				this.ui.requestRender();
			},
			close: () => this.#hideJobsSheet(),
		});
		this.#jobsSheetHandle = this.ui.showOverlay(sheet, { anchor: "center", width: "90%", maxHeight: "90%" });
		this.#jobsSheetTimer = setInterval(() => this.ui.requestRender(), JOBS_SHEET_REFRESH_MS);
		this.ui.setFocus(sheet);
		this.ui.requestRender();
	}

	#hideJobsSheet(): void {
		const handle = this.#jobsSheetHandle;
		this.#jobsSheetHandle = undefined;
		clearInterval(this.#jobsSheetTimer);
		this.#jobsSheetTimer = undefined;
		if (!handle) return;
		handle.hide();
		this.#selectorController.focusActiveEditorArea();
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
		this.#commandController.clearCommandReport();
	}

	showStatus(message: string, options?: ShowStatusOptions): void {
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
		this.errorBannerContainer.addChild(new ErrorBannerComponent(message, () => this.clearPinnedError()));
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

	#syncConfigWarningHeader(): void {
		this.composer.setHeaderExtras(this.#buildConfigWarningComponents(), this.#headerAfter);
	}

	/** Header rows for the current config warnings, rebuilt when they change (#10048). */
	#buildConfigWarningComponents(): Component[] {
		const components: Component[] = [];
		for (const warning of this.session.configWarnings) {
			components.push(
				new Text(`Warning: ${warning}`, 1, 0).setStyleFn(t => theme.fg("warning", t)),
				new Spacer(1),
			);
		}
		return components;
	}

	#clearWorkingMessageAccentCache(): void {
		this.#workingMessageAccentCacheKey = undefined;
		this.#workingMessageAccentCacheValue = undefined;
		this.#workingMessageAccentCacheHasValue = false;
	}

	#buildWorkingMessageAccentCacheKey(): WorkingMessageAccentCacheKey {
		const sessionAccentEnabled = !isSettingsInitialized() || cfgStatusLineSessionAccent.get(settings) !== false;
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
		if (this.autoCompactionLoader || this.retryLoader) return;
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
				[` ${appKey(this.keybindings, "app.interrupt")}`],
			);
			this.loadingAnimation.setTrailer(() => this.#workingRowTrailer());
			this.loadingAnimation.setWorkingRow(
				() => this.#workingRowSpec(),
				() => this.interruptFromPointer(),
			);
			this.#workingMessage = DEFAULT_WORKING_MESSAGE;
			this.#workingStartedAt = this.viewSession.runStartedAt ?? Date.now();
			this.statusContainer.addChild(this.loadingAnimation);
		} else if (!this.statusContainer.children.includes(this.loadingAnimation)) {
			this.statusContainer.disposeChildren();
			this.loadingAnimation.start();
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
				this.#workingMessage = DEFAULT_WORKING_MESSAGE;
			}
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message);
			this.#workingMessage = message;
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
		// Laid out as the working row it replaces: a blank row above, then the
		// key in the column where the working row's interrupt key stood.
		const hint = new Container();
		hint.addChild(new Spacer(1));
		hint.addChild(new Text(` ${rawKeyHint(retryKey, "to retry")}`, 1, 0));
		this.#retryHintRow = new DescribedComponent(
			hint,
			row([node("icon", { name: "loop", tone: "muted" }), kbd(retryKey, "key"), text([span("to retry", "muted")])], {
				gap: "sm",
				align: "center",
				role: "omp.hint.retry",
			}),
		);
		this.statusContainer.addChild(this.#retryHintRow);
		this.ui.requestRender();
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
		this.#clearJudgmentBatchProgress(true);
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
		if (worktree) this.#ownedWorktrees.push(worktree);
	}

	/**
	 * Apply `worktree.onStart` to a fresh launch: optionally move the session into
	 * a new worktree forked from clean `HEAD`. Silent no-op outside git checkouts;
	 * failures become a warning so startup continues.
	 */
	async maybeAutoCreateWorktree(): Promise<void> {
		try {
			const policy = cfgWorktreeOnStart.get(this.settings);
			if (policy === "off" || !(await canAutoCreateWorktree(this.sessionManager.getCwd()))) return;
			if (
				policy === "ask" &&
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
		await this.#readySTTController()?.toggle(this.editor, this.#dictationCallbacks(this.editor));
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
				if (state === "recording") {
					this.#micCursor?.dispose();
					this.#micCursor = new MicCursor(this.ui, target);
				} else if (state === "transcribing") {
					this.#micCursor?.showTranscribing();
				} else {
					this.#micCursor?.dispose();
					this.#micCursor = undefined;
				}
				this.ui.requestRender();
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
			this.statusLine.setRecording(false);
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
				tui: this.ui,
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
		this.statusLine.setRecording(true);
		this.showStatus(`Recording to ${this.#recorder.path} · /record again to stop`);
	}

	/** Start or stop the Codex-backed realtime voice surface. */
	async handleLiveCommand(): Promise<void> {
		if (this.#sttController && this.#sttController.state !== "idle") {
			this.showWarning("Finish the current speech-to-text capture before starting live mode.");
			return;
		}
		await this.#liveCommandController.handleCommand();
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

	showThinkingSelector(): void {
		this.#selectorController.showThinkingSelector();
	}

	showSessionSelector(source?: ForeignSessionSource): void {
		void this.#selectorController.showSessionSelector(source);
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		await this.#selectorController.handleResumeSession(sessionPath);
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

	showCommandReport(options: { title: string; head?: TspText; body: Component }): void {
		this.#commandController.showCommandReport(options);
	}

	dismissCommandReport(): boolean {
		return this.#commandController.dismissCommandReport();
	}

	commandReportRows(): number | undefined {
		const below = this.composer.rowsBelow(this.reportContainer);
		return below === undefined ? undefined : this.ui.terminal.rows - below;
	}

	composerInputAtBottom(): boolean {
		const viewport = this.ui.getMutableViewport();
		return viewport.length > 0 && viewport.top + viewport.length >= this.ui.terminal.rows;
	}

	pinComposerToBottom(): void {
		this.composer.pinInputToBottom();
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
		this.#syncTodoHudState(this.viewSession);
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
