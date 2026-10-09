import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * One `task.agentCompactionThresholdOverrides` or `compaction.modelThresholds`
 * entry: a positive token count (`90000`) or a percentage string (`"80%"`).
 * `null` clears an entry inherited from a lower-priority settings layer.
 */
export type AgentCompactionThresholdOverride = number | string | null;

/** Both compaction threshold fields, as consumed by `compaction.thresholdPercent`/`compaction.thresholdTokens`. */
export interface CompactionThresholdPair {
	thresholdPercent: number;
	thresholdTokens: number;
}

const PERCENT_PATTERN = /^(\d+(?:\.\d+)?)%$/;
const TOKEN_INPUT_PATTERN = /^(\d+)([kmb])?$/i;
const TOKEN_SUFFIX_SCALE: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

function parseThresholdEntry(entry: unknown): CompactionThresholdPair | undefined {
	if (typeof entry === "number") {
		if (Number.isSafeInteger(entry) && entry > 0) return { thresholdPercent: -1, thresholdTokens: entry };
	} else if (typeof entry === "string") {
		const match = PERCENT_PATTERN.exec(entry.trim());
		const percent = match ? Number(match[1]) : Number.NaN;
		if (percent > 0 && percent <= 100) return { thresholdPercent: percent, thresholdTokens: -1 };
	}
	return undefined;
}

/** Validate a `key → entry` threshold map and normalize each entry to both threshold fields. */
function validateThresholdMap(
	settingId: string,
	keyNoun: string,
	value: unknown,
	checkKey?: (key: string) => string | undefined,
): Record<string, CompactionThresholdPair> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		const received = Array.isArray(value) ? "an array" : `a ${typeof value}`;
		throw new Error(
			`Invalid ${settingId}: expected a map of ${keyNoun} to token count or percentage, got ${received}.`,
		);
	}

	const thresholds: Record<string, CompactionThresholdPair> = {};
	for (const [key, entry] of Object.entries(value)) {
		const keyError = checkKey?.(key);
		if (keyError) throw new Error(`Invalid ${settingId} key "${key}": ${keyError}.`);
		if (entry === null) continue;
		const threshold = parseThresholdEntry(entry);
		if (!threshold) {
			const received = Array.isArray(entry) ? "an array" : typeof entry === "string" ? `"${entry}"` : String(entry);
			throw new Error(
				`Invalid ${settingId}.${key}: expected a positive integer token count (e.g. 90000) or a percentage in (0, 100] (e.g. "80%"), got ${received}.`,
			);
		}
		thresholds[key] = threshold;
	}
	return thresholds;
}

/** Validate the exact-agent compaction threshold map and normalize each entry to both threshold fields. */
export function validateAgentCompactionThresholdOverrides(value: unknown): Record<string, CompactionThresholdPair> {
	return validateThresholdMap("task.agentCompactionThresholdOverrides", "agent name", value);
}

function checkModelThresholdKey(key: string): string | undefined {
	const star = key.indexOf("*");
	if (star !== -1 && star !== key.length - 1) return "`*` is only allowed as the last character";
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return "expected `provider/model-id` or a `provider/…*` prefix";
	return undefined;
}

/**
 * Validate `compaction.modelThresholds`: keys are an exact `provider/model-id`
 * or a `*`-terminated prefix of one (`deepseek/*`, `openrouter/anthropic/*`).
 */
export function validateModelCompactionThresholds(value: unknown): Record<string, CompactionThresholdPair> {
	return validateThresholdMap("compaction.modelThresholds", "model selector", value, checkModelThresholdKey);
}

/** The `compaction.modelThresholds` entry governing one model. */
export interface ModelCompactionThresholdMatch {
	/** The entry's key: the exact `provider/model-id`, or the longest matching `…*` prefix. */
	key: string;
	threshold: CompactionThresholdPair;
}

const parsedModelThresholds = new WeakMap<object, Record<string, CompactionThresholdPair>>();

function modelThresholdsOf(raw: unknown): Record<string, CompactionThresholdPair> {
	if (!isRecord(raw)) return {};
	let parsed = parsedModelThresholds.get(raw);
	if (!parsed) {
		parsed = validateModelCompactionThresholds(raw);
		parsedModelThresholds.set(raw, parsed);
	}
	return parsed;
}

/**
 * The `compaction.modelThresholds` entry for `model`: an exact `provider/model-id`
 * key wins, else the longest `*`-terminated prefix matching it.
 */
export function matchModelCompactionThreshold(
	raw: unknown,
	model: { provider: string; id: string },
): ModelCompactionThresholdMatch | undefined {
	const thresholds = modelThresholdsOf(raw);
	const selector = `${model.provider}/${model.id}`;
	if (Object.hasOwn(thresholds, selector)) return { key: selector, threshold: thresholds[selector] };
	let best: ModelCompactionThresholdMatch | undefined;
	for (const key in thresholds) {
		if (!key.endsWith("*") || !selector.startsWith(key.slice(0, -1))) continue;
		if (!best || key.length > best.key.length) best = { key, threshold: thresholds[key] };
	}
	return best;
}

const appliedThresholds = new WeakMap<object, Map<string, CompactionThresholdPair>>();

/**
 * `settings` with the threshold fields of the `compaction.modelThresholds` entry
 * governing `model`; the same object when no entry applies. Results are cached
 * per settings snapshot so hot paths allocate once per entry.
 */
export function applyModelCompactionThreshold<T extends CompactionThresholdPair>(
	settings: T,
	raw: unknown,
	model: { provider: string; id: string } | null | undefined,
): T {
	if (!model) return settings;
	const match = matchModelCompactionThreshold(raw, model);
	if (!match) return settings;
	let byKey = appliedThresholds.get(settings);
	if (!byKey) {
		byKey = new Map();
		appliedThresholds.set(settings, byKey);
	}
	const cached = byKey.get(match.key);
	if (
		cached &&
		cached.thresholdPercent === match.threshold.thresholdPercent &&
		cached.thresholdTokens === match.threshold.thresholdTokens
	) {
		return cached as T;
	}
	const applied: T = { ...settings, ...match.threshold };
	byKey.set(match.key, applied);
	return applied;
}

/**
 * Parse a typed compaction point into its persisted entry: an integer token
 * count with an optional `k`/`m`/`b` suffix (any case) becomes a number, a
 * percentage stays `"N%"`, and empty input is `null` (reset). Throws on
 * anything else.
 */
export function parseCompactionPointInput(input: string): number | string | null {
	const text = input.trim();
	if (text.length === 0) return null;
	if (text.endsWith("%")) {
		if (parseThresholdEntry(text)) return text;
		throw new Error(`Invalid compaction point "${text}": percentage must be in (0, 100]`);
	}
	const match = TOKEN_INPUT_PATTERN.exec(text);
	if (match) {
		const scale = match[2] ? TOKEN_SUFFIX_SCALE[match[2].toLowerCase()] : 1;
		const tokens = Number(match[1]) * scale;
		if (parseThresholdEntry(tokens)) return tokens;
	}
	throw new Error(`Invalid compaction point "${text}": use a token count (90000, 90k, 1m) or a percentage (80%)`);
}

/** A threshold pair as text {@link parseCompactionPointInput} reads back: `90k`, `1500k`, `123456`, `80%`. */
export function formatCompactionPointInput(threshold: CompactionThresholdPair): string {
	if (threshold.thresholdTokens > 0) {
		const tokens = threshold.thresholdTokens;
		for (const suffix of ["b", "m", "k"] as const) {
			const scale = TOKEN_SUFFIX_SCALE[suffix];
			if (tokens % scale === 0) return `${tokens / scale}${suffix}`;
		}
		return String(tokens);
	}
	return `${threshold.thresholdPercent}%`;
}
