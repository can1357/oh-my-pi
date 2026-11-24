/**
 * The status bar a fresh session will most likely show, kept in the startup cache so
 * the next launch's first frame draws the real bar before any session exists.
 *
 * The live bar's session-independent facts (model, thinking level, fast mode, the
 * context a fresh session starts with, compaction thresholds, the bar's settings) are
 * predicted from the last session that ran here. Everything a session fills in later
 * (usage, git, quota, jobs) starts empty, as the live bar shows it before its first
 * fetch. The same status line draws both; the live one replaces the prediction once
 * the interactive mode attaches.
 */
import * as os from "node:os";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	CONTEXT_LINE_MODE_VALUES,
	STATUS_LINE_PRESET_VALUES,
	STATUS_LINE_SEGMENT_IDS,
	STATUS_LINE_SEPARATOR_VALUES,
} from "../../config/status-line-schema";
import type { StatusContext, StatusFacts, StatusLineSettings, StatusModel } from "../../ui/status/facts";
import type { StatusLineView } from "../types";

/** The facts a fresh session's bar shows before the session reports anything. */
export type PredictedStatusFacts = Pick<
	StatusFacts,
	| "model"
	| "thinkingLevel"
	| "autoThinking"
	| "fastMode"
	| "usingSubscription"
	| "autoCompact"
	| "compaction"
	| "profile"
	| "context"
>;

/** What the next launch's first frame draws in the status bar. */
export interface StatusPrediction {
	readonly settings: StatusLineSettings;
	readonly facts: PredictedStatusFacts;
}

/** What a fresh session differs in from the live bar's session. */
export interface FreshSession {
	/** The occupancy a fresh session starts with (system prompt and tools). */
	readonly context: StatusContext;
	/** Whether the configured service tier makes the model fast. */
	readonly fastMode: boolean;
}

/** The prediction a live bar makes for the next launch's fresh session. */
export function predictStatus(facts: StatusFacts, settings: StatusLineSettings, fresh: FreshSession): StatusPrediction {
	return {
		settings,
		facts: {
			...(facts.model ? { model: facts.model } : {}),
			...(facts.thinkingLevel !== undefined ? { thinkingLevel: facts.thinkingLevel } : {}),
			...(facts.autoThinking !== undefined ? { autoThinking: facts.autoThinking } : {}),
			...(facts.compaction ? { compaction: facts.compaction } : {}),
			...(facts.profile !== undefined ? { profile: facts.profile } : {}),
			usingSubscription: facts.usingSubscription,
			autoCompact: facts.autoCompact,
			fastMode: fresh.fastMode,
			context: fresh.context,
		},
	};
}

/** The predicted bar for `cwd`, as the composer chrome draws a status line. */
export function predictedStatusLine(prediction: StatusPrediction, cwd: string): StatusLineView {
	const facts: StatusFacts = {
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 },
		subagents: 0,
		jobs: 0,
		activeMs: 0,
		hooks: [],
		cwd,
		home: os.homedir(),
		now: Date.now(),
		...prediction.facts,
	};
	return { facts: () => facts, settings: () => prediction.settings };
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return values.some(entry => entry === value);
}

function isOptional<T>(value: unknown, check: (value: unknown) => value is T): value is T | undefined {
	return value === undefined || check(value);
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";

function isSegments(value: unknown): value is StatusLineSettings["leftSegments"] {
	return Array.isArray(value) && value.every(id => isOneOf(STATUS_LINE_SEGMENT_IDS, id));
}

function isSettings(value: unknown): value is StatusLineSettings {
	return (
		isRecord(value) &&
		isOptional(value.preset, (preset): preset is StatusLineSettings["preset"] =>
			isOneOf(STATUS_LINE_PRESET_VALUES, preset),
		) &&
		isOptional(value.leftSegments, isSegments) &&
		isOptional(value.rightSegments, isSegments) &&
		isOptional(value.separator, (separator): separator is StatusLineSettings["separator"] =>
			isOneOf(STATUS_LINE_SEPARATOR_VALUES, separator),
		) &&
		isOptional(value.segmentOptions, isRecord) &&
		isOptional(value.showHookStatus, isBoolean) &&
		isOptional(value.sessionAccent, isBoolean) &&
		isOptional(value.transparent, isBoolean) &&
		isOptional(value.compactThinkingLevel, isBoolean) &&
		isOptional(value.contextLine, (mode): mode is StatusLineSettings["contextLine"] =>
			isOneOf(CONTEXT_LINE_MODE_VALUES, mode),
		)
	);
}

function isModel(value: unknown): value is StatusModel {
	return (
		isRecord(value) &&
		isString(value.id) &&
		isBoolean(value.thinking) &&
		isOptional(value.name, isString) &&
		isOptional(value.contextWindow, isNumber)
	);
}

function isContext(value: unknown): value is StatusContext {
	return (
		isRecord(value) &&
		isNumber(value.tokens) &&
		isNumber(value.window) &&
		(value.percent === null || isNumber(value.percent))
	);
}

function isCompaction(value: unknown): value is StatusFacts["compaction"] {
	return (
		isRecord(value) &&
		isNumber(value.thresholdPercent) &&
		(value.speculationPercent === null || isNumber(value.speculationPercent))
	);
}

function isFacts(value: unknown): value is PredictedStatusFacts {
	return (
		isRecord(value) &&
		isOptional(value.model, isModel) &&
		isOptional(value.thinkingLevel, isString) &&
		isOptional(value.autoThinking, isBoolean) &&
		isOptional(value.fastMode, isBoolean) &&
		isOptional(value.compaction, isCompaction) &&
		isOptional(value.profile, isString) &&
		isBoolean(value.usingSubscription) &&
		isBoolean(value.autoCompact) &&
		isContext(value.context)
	);
}

/** A cached prediction, or undefined when `value` is not one (an older format, a damaged row). */
export function parseStatusPrediction(value: unknown): StatusPrediction | undefined {
	if (!isRecord(value) || !isSettings(value.settings) || !isFacts(value.facts)) return undefined;
	return { settings: value.settings, facts: value.facts };
}
