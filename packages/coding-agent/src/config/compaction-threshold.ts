import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { modelMatchesGlob } from "./model-resolver";

/**
 * One `task.agentCompactionThresholdOverrides` or `compaction.modelThresholds` entry: a positive
 * token count (`90000`) or a percentage string (`"80%"`). `null` clears an entry inherited from a
 * lower-priority settings layer.
 */
export type CompactionThresholdOverride = number | string | null;

/** Both compaction threshold fields, as consumed by `compaction.thresholdPercent`/`compaction.thresholdTokens`. */
export interface CompactionThresholdPair {
	thresholdPercent: number;
	thresholdTokens: number;
}

const PERCENT_PATTERN = /^(\d+(?:\.\d+)?)%$/;

function parseEntry(entryPath: string, entry: unknown): CompactionThresholdPair {
	if (typeof entry === "number") {
		if (Number.isSafeInteger(entry) && entry > 0) return { thresholdPercent: -1, thresholdTokens: entry };
	} else if (typeof entry === "string") {
		const match = PERCENT_PATTERN.exec(entry.trim());
		const percent = match ? Number(match[1]) : Number.NaN;
		if (percent > 0 && percent <= 100) return { thresholdPercent: percent, thresholdTokens: -1 };
	}
	const received = Array.isArray(entry) ? "an array" : typeof entry === "string" ? `"${entry}"` : String(entry);
	throw new Error(
		`Invalid ${entryPath}: expected a positive integer token count (e.g. 90000) or a percentage in (0, 100] (e.g. "80%"), got ${received}.`,
	);
}

/** Entries of a threshold map, with `null` (cleared) entries dropped; throws when `value` is not a map. */
function thresholdMapEntries(settingId: string, keyNoun: string, value: unknown): [string, unknown][] {
	if (value === undefined || value === null) return [];
	if (!isRecord(value)) {
		const received = Array.isArray(value) ? "an array" : `a ${typeof value}`;
		throw new Error(
			`Invalid ${settingId}: expected a map of ${keyNoun} to token count or percentage, got ${received}.`,
		);
	}
	return Object.entries(value).filter(([, entry]) => entry !== null);
}

/** Validate the exact-agent compaction threshold map and normalize each entry to both threshold fields. */
export function validateAgentCompactionThresholdOverrides(value: unknown): Record<string, CompactionThresholdPair> {
	const overrides: Record<string, CompactionThresholdPair> = {};
	for (const [agentName, entry] of thresholdMapEntries(
		"task.agentCompactionThresholdOverrides",
		"agent name",
		value,
	)) {
		overrides[agentName] = parseEntry(`task.agentCompactionThresholdOverrides.${agentName}`, entry);
	}
	return overrides;
}

/** One validated `compaction.modelThresholds` entry. */
export interface ModelCompactionThreshold {
	/** Lowercased selector. */
	selector: string;
	/** Selector has no glob metacharacters: it names one model by `provider/id` or bare id. */
	exact: boolean;
	glob: Bun.Glob;
	threshold: CompactionThresholdPair;
}

const GLOB_METACHARACTERS = /[*?[\]{}!]/;

/**
 * Validate `compaction.modelThresholds` (model selector → token count or percentage) in declaration
 * order. Selectors are syntax-checked only: one naming a model that is not currently available is
 * kept, since discovery and credentials change.
 */
export function validateModelCompactionThresholds(value: unknown): ModelCompactionThreshold[] {
	const thresholds: ModelCompactionThreshold[] = [];
	for (const [rawSelector, entry] of thresholdMapEntries("compaction.modelThresholds", "model selector", value)) {
		const selector = rawSelector.trim().toLowerCase();
		if (!selector) {
			throw new Error(
				`Invalid compaction.modelThresholds: model selectors must be non-empty (e.g. "anthropic/claude-opus-5" or "openai-codex/*"), got "${rawSelector}".`,
			);
		}
		thresholds.push({
			selector,
			exact: !GLOB_METACHARACTERS.test(selector),
			glob: new Bun.Glob(selector),
			threshold: parseEntry(`compaction.modelThresholds["${rawSelector}"]`, entry),
		});
	}
	return thresholds;
}

/**
 * The `compaction.modelThresholds` entry for `model`: an exact `provider/id` selector, else an exact
 * bare id, else the first declared matching glob. `undefined` when none matches.
 */
export function findModelCompactionThreshold(
	thresholds: readonly ModelCompactionThreshold[],
	model: Pick<Model, "provider" | "id">,
): CompactionThresholdPair | undefined {
	if (thresholds.length === 0) return undefined;
	const id = model.id.toLowerCase();
	const fullId = `${model.provider.toLowerCase()}/${id}`;
	let bareExact: ModelCompactionThreshold | undefined;
	let firstGlob: ModelCompactionThreshold | undefined;
	for (const entry of thresholds) {
		if (entry.exact) {
			if (entry.selector === fullId) return entry.threshold;
			if (entry.selector === id) bareExact ??= entry;
		} else if (firstGlob === undefined && modelMatchesGlob(entry.glob, model)) {
			firstGlob = entry;
		}
	}
	return (bareExact ?? firstGlob)?.threshold;
}

/**
 * Settings carrying a `task.agentCompactionThresholdOverrides` entry for the subagent they belong to.
 * That entry is the session's whole trigger, so `compaction.modelThresholds` does not apply to it.
 */
const agentPinnedThresholdSettings = new WeakSet<object>();

/** Mark `settings` as carrying a per-agent threshold that `compaction.modelThresholds` must not replace. */
export function pinAgentCompactionThreshold(settings: object): void {
	agentPinnedThresholdSettings.add(settings);
}

/** Whether `settings` carries a per-agent threshold (see {@link pinAgentCompactionThreshold}). */
export function hasAgentCompactionThreshold(settings: object): boolean {
	return agentPinnedThresholdSettings.has(settings);
}
