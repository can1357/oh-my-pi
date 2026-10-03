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
	/** Compiled selector, or `undefined` when it has no glob metacharacters and can only match literally. */
	glob: Bun.Glob | undefined;
	threshold: CompactionThresholdPair;
}

const GLOB_METACHARACTERS = /[*?[\]{}!\\]/;

/**
 * Why `selector` is not a well-formed glob, or `undefined` when it is. `Bun.Glob` compiles any
 * string, so an unterminated `[` class or `{` group, a stray `}`, or a dangling `\` would otherwise
 * silently match nothing or match more than written.
 */
function globSyntaxError(selector: string): string | undefined {
	let braceDepth = 0;
	for (let i = 0; i < selector.length; i++) {
		const char = selector[i];
		if (char === "\\") {
			if (++i >= selector.length) return "it ends with an unescaped backslash";
		} else if (char === "[") {
			let end = i + 1;
			if (selector[end] === "!" || selector[end] === "^") end++;
			// The first member may itself be `]`; the class must hold at least one member.
			end++;
			while (end < selector.length && selector[end] !== "]") end += selector[end] === "\\" ? 2 : 1;
			if (end >= selector.length) return "it has an unterminated character class `[`";
			i = end;
		} else if (char === "{") {
			braceDepth++;
		} else if (char === "}") {
			if (braceDepth === 0) return "it has a `}` without a matching `{`";
			braceDepth--;
		}
	}
	return braceDepth > 0 ? "it has an unterminated brace group `{`" : undefined;
}

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
		const syntaxError = globSyntaxError(selector);
		if (syntaxError) {
			throw new Error(
				`Invalid compaction.modelThresholds: model selector "${rawSelector}" is malformed: ${syntaxError}.`,
			);
		}
		thresholds.push({
			selector,
			glob: GLOB_METACHARACTERS.test(selector) ? new Bun.Glob(selector) : undefined,
			threshold: parseEntry(`compaction.modelThresholds["${rawSelector}"]`, entry),
		});
	}
	return thresholds;
}

/**
 * The `compaction.modelThresholds` entry for `model`: a selector equal to its `provider/id`, else
 * one equal to its bare id, else the first declared matching glob. Literal equality is checked for
 * every selector, so an id containing glob characters (`glm-5.2-highspeed[1m]`) is still matched
 * exactly. `undefined` when none matches.
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
		if (entry.selector === fullId) return entry.threshold;
		if (entry.selector === id) bareExact ??= entry;
		else if (firstGlob === undefined && entry.glob && modelMatchesGlob(entry.glob, model)) firstGlob = entry;
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
