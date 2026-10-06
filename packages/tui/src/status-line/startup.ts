/**
 * Status line for the speculative first frame, before any session exists.
 *
 * InteractiveMode persists {@link StatusLineStartupData} (settings plus the last
 * session's model and thinking state); the next launch renders it through the
 * real {@link StatusLineComponent} as a fresh, unnamed session at the live
 * terminal width. Path and git branch are read live; context usage is reported
 * unknown so the gauge shows the window without a percent.
 *
 * @example
 * ```ts ignore
 * const statusLine = createStartupStatusLine(cached.statusLine);
 * statusLine.attachToEditor(editor, getComposerStyle(shape));
 * ```
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
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
	/** Model of the last session; the next fresh session usually starts on it too. */
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
		getAdvisorUsageAccounts: () => [],
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

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && values.some(candidate => candidate === value);
}

function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function isSegmentList(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every(id => isOneOf(STATUS_LINE_SEGMENT_IDS, id)));
}

/** Shallow check of persisted settings; nested segment options are trusted as written by this version. */
function isStatusLineSettings(value: unknown): value is StatusLineSettings {
	return (
		isRecord(value) &&
		(value.preset === undefined || isOneOf(STATUS_LINE_PRESET_VALUES, value.preset)) &&
		isSegmentList(value.leftSegments) &&
		isSegmentList(value.rightSegments) &&
		(value.separator === undefined || isOneOf(STATUS_LINE_SEPARATOR_VALUES, value.separator)) &&
		(value.segmentOptions === undefined || isRecord(value.segmentOptions)) &&
		(value.contextLine === undefined || isOneOf(CONTEXT_LINE_MODE_VALUES, value.contextLine)) &&
		isOptionalBoolean(value.showHookStatus) &&
		isOptionalBoolean(value.sessionAccent) &&
		isOptionalBoolean(value.transparent) &&
		isOptionalBoolean(value.compactThinkingLevel)
	);
}

/** Check the model fields the status line reads; the rest is trusted as serialized by this version. */
function isPersistedModel(value: unknown): value is Model {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.provider === "string" &&
		typeof value.api === "string" &&
		typeof value.contextWindow === "number"
	);
}

function readCompactionBoundaries(value: unknown): CompactionBoundaries | null | undefined {
	if (value === null) return null;
	if (!isRecord(value) || typeof value.thresholdPercent !== "number") return undefined;
	const speculationPercent = value.speculationPercent;
	if (speculationPercent !== null && typeof speculationPercent !== "number") return undefined;
	return { thresholdPercent: value.thresholdPercent, speculationPercent };
}

/** Validate persisted {@link StatusLineStartupData}; `undefined` for anything malformed. */
export function readStatusLineStartupData(value: unknown): StatusLineStartupData | undefined {
	if (!isRecord(value) || !isStatusLineSettings(value.settings)) return undefined;
	const model = value.model;
	if (model !== undefined && !isPersistedModel(model)) return undefined;
	const thinkingLevel = typeof value.thinkingLevel === "string" ? parseThinkingLevel(value.thinkingLevel) : undefined;
	if (value.thinkingLevel !== undefined && thinkingLevel === undefined) return undefined;
	const compactionBoundaries = readCompactionBoundaries(value.compactionBoundaries);
	if (
		typeof value.gitEnabled !== "boolean" ||
		typeof value.autoThinking !== "boolean" ||
		typeof value.fastMode !== "boolean" ||
		typeof value.usingSubscription !== "boolean" ||
		typeof value.autoCompactEnabled !== "boolean" ||
		compactionBoundaries === undefined
	) {
		return undefined;
	}
	return {
		settings: value.settings,
		gitEnabled: value.gitEnabled,
		model,
		thinkingLevel,
		autoThinking: value.autoThinking,
		fastMode: value.fastMode,
		usingSubscription: value.usingSubscription,
		autoCompactEnabled: value.autoCompactEnabled,
		compactionBoundaries,
	};
}
