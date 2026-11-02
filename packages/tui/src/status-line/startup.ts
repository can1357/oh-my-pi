/**
 * Status line for the speculative first frame, before any session exists.
 *
 * InteractiveMode persists {@link StatusLineStartupData} (settings plus the
 * resolved default role model and status inputs); the next launch renders it
 * through the real {@link StatusLineComponent} as a fresh, unnamed session at
 * the live terminal width. Path and git branch are read live; context usage is
 * reported unknown so the gauge shows the window without a percent.
 *
 * @example
 * ```ts ignore
 * const statusLine = createStartupStatusLine(cached.statusLine);
 * statusLine.attachToEditor(editor, getComposerStyle(shape));
 * ```
 */
import { type } from "@oh-my-pi/omptype";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { parseThinkingLevel } from "../thinking";
import { StatusLineComponent } from "./component";
import type { CompactionBoundaries } from "./context-usage";
import type { StatusLineHost, StatusLineSession } from "./host";
import {
	CONTEXT_LINE_MODE_VALUES,
	STATUS_LINE_PRESET_VALUES,
	STATUS_LINE_SEGMENT_IDS,
	STATUS_LINE_SEPARATOR_VALUES,
} from "./schema";
import type { StatusLineSettings } from "./types";

/** Session-independent inputs that reproduce a fresh session's status bar on the next launch. */
export interface StatusLineStartupData {
	readonly settings: StatusLineSettings;
	readonly gitEnabled: boolean;
	/** Model resolved for the next fresh session's default role. */
	readonly model?: Model;
	readonly thinkingLevel?: ThinkingLevel;
	readonly autoThinking: boolean;
	readonly fastMode: boolean;
	/** Whether `model` bills through a subscription (drives the cost segment's prefix). */
	readonly usingSubscription: boolean;
	readonly autoCompactEnabled: boolean;
	readonly compactionBoundaries: CompactionBoundaries | null;
}

const NO_MESSAGES: readonly never[] = [];
const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	orchestrationInput: 0,
	orchestrationOutput: 0,
	orchestrationCacheRead: 0,
	premiumRequests: 0,
	cost: 0,
};

/** Build the prepaint status line; the caller disposes it once the session-bound bar mounts. */
export function createStartupStatusLine(data: StatusLineStartupData): StatusLineComponent {
	const session: StatusLineSession = {
		state: { model: data.model, thinkingLevel: data.thinkingLevel, messages: NO_MESSAGES },
		model: data.model,
		messages: NO_MESSAGES,
		isStreaming: false,
		isAutoThinking: data.autoThinking,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "",
			getUsageStatistics: () => NO_USAGE,
		},
		modelRegistry: { isUsingOAuth: () => data.usingSubscription },
		getContextUsage: () =>
			data.model?.contextWindow ? { tokens: 0, contextWindow: data.model.contextWindow, percent: null } : undefined,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => data.fastMode,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => undefined,
	};
	const host: StatusLineHost = {
		getSettings: () => data.settings,
		gitEnabled: () => data.gitEnabled,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: async () => null,
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => data.compactionBoundaries,
	};
	const statusLine = new StatusLineComponent(session, host);
	statusLine.setAutoCompactEnabled(data.autoCompactEnabled);
	return statusLine;
}

const SegmentIds = type.enumerated(...STATUS_LINE_SEGMENT_IDS).array();

/** Shallow check of persisted settings; nested segment options are trusted as written by this version. */
const StatusLineSettingsShape = type({
	"preset?": type.enumerated(...STATUS_LINE_PRESET_VALUES),
	"leftSegments?": SegmentIds,
	"rightSegments?": SegmentIds,
	"separator?": type.enumerated(...STATUS_LINE_SEPARATOR_VALUES),
	"segmentOptions?": "Record<string, unknown>",
	"contextLine?": type.enumerated(...CONTEXT_LINE_MODE_VALUES),
	"showHookStatus?": "boolean",
	"sessionAccent?": "boolean",
	"transparent?": "boolean",
	"compactThinkingLevel?": "boolean",
});

const StartupDataShape = type({
	"+": "delete",
	settings: StatusLineSettingsShape,
	gitEnabled: "boolean",
	// Only the fields the status line reads; the rest is trusted as serialized by this version.
	"model?": { id: "string", name: "string", provider: "string", api: "string", contextWindow: "number" },
	"thinkingLevel?": "string",
	autoThinking: "boolean",
	fastMode: "boolean",
	usingSubscription: "boolean",
	autoCompactEnabled: "boolean",
	compactionBoundaries: type({ "+": "delete", thresholdPercent: "number", speculationPercent: "number | null" }).or(
		"null",
	),
});

/** Validate persisted {@link StatusLineStartupData}; `undefined` for anything malformed. */
export function readStatusLineStartupData(value: unknown): StatusLineStartupData | undefined {
	const data = StartupDataShape(value);
	if (data instanceof type.errors) return undefined;
	const thinkingLevel = data.thinkingLevel === undefined ? undefined : parseThinkingLevel(data.thinkingLevel);
	if (data.thinkingLevel !== undefined && thinkingLevel === undefined) return undefined;
	return {
		...data,
		settings: data.settings as StatusLineSettings,
		model: data.model as Model | undefined,
		thinkingLevel,
	};
}
