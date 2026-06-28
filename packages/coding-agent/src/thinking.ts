import { type ResolvedThinkingLevel, ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { Effort, type Model, THINKING_EFFORTS } from "@pk-nerdsaver-ai/pi-ai";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";

/**
 * Metadata used to render thinking selector values in the coding-agent UI.
 */
export interface ThinkingLevelMetadata {
	value: ThinkingLevel;
	label: string;
	description: string;
}

const THINKING_LEVEL_METADATA: Record<ThinkingLevel, ThinkingLevelMetadata> = {
	[ThinkingLevel.Inherit]: {
		value: ThinkingLevel.Inherit,
		label: "inherit",
		description: "Inherit session default",
	},
	[ThinkingLevel.Off]: { value: ThinkingLevel.Off, label: "off", description: "No reasoning" },
	[ThinkingLevel.Minimal]: {
		value: ThinkingLevel.Minimal,
		label: "min",
		description: "Very brief reasoning (~1k tokens)",
	},
	[ThinkingLevel.Low]: { value: ThinkingLevel.Low, label: "low", description: "Light reasoning (~2k tokens)" },
	[ThinkingLevel.Medium]: {
		value: ThinkingLevel.Medium,
		label: "medium",
		description: "Moderate reasoning (~8k tokens)",
	},
	[ThinkingLevel.High]: { value: ThinkingLevel.High, label: "high", description: "Deep reasoning (~16k tokens)" },
	[ThinkingLevel.XHigh]: {
		value: ThinkingLevel.XHigh,
		label: "xhigh",
		description: "Maximum reasoning (~32k tokens)",
	},
};

const EFFORT_BY_SELECTOR: Readonly<Record<string, Effort>> = {
	[Effort.Minimal]: Effort.Minimal,
	[Effort.Low]: Effort.Low,
	[Effort.Medium]: Effort.Medium,
	[Effort.High]: Effort.High,
	[Effort.XHigh]: Effort.XHigh,
	max: Effort.XHigh,
};
const THINKING_LEVEL_BY_SELECTOR: Readonly<Record<string, ThinkingLevel>> = {
	[ThinkingLevel.Inherit]: ThinkingLevel.Inherit,
	[ThinkingLevel.Off]: ThinkingLevel.Off,
	[ThinkingLevel.Minimal]: ThinkingLevel.Minimal,
	[ThinkingLevel.Low]: ThinkingLevel.Low,
	[ThinkingLevel.Medium]: ThinkingLevel.Medium,
	[ThinkingLevel.High]: ThinkingLevel.High,
	[ThinkingLevel.XHigh]: ThinkingLevel.XHigh,
};

function getOwnSelector<T>(selectors: Readonly<Record<string, T>>, value: string | null | undefined): T | undefined {
	return value === undefined || value === null || !Object.hasOwn(selectors, value) ? undefined : selectors[value];
}

/**
 * Parses a provider-facing effort value.
 */
export function parseEffort(value: string | null | undefined): Effort | undefined {
	return getOwnSelector(EFFORT_BY_SELECTOR, value);
}

/**
 * Parses an agent-local thinking selector.
 */
export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	return getOwnSelector(THINKING_LEVEL_BY_SELECTOR, value);
}

/**
 * Returns display metadata for a thinking selector.
 */
export function getThinkingLevelMetadata(level: ThinkingLevel): ThinkingLevelMetadata {
	return THINKING_LEVEL_METADATA[level];
}

/**
 * Converts an agent-local selector into the effort sent to providers.
 */
export function toReasoningEffort(level: ThinkingLevel | undefined): Effort | undefined {
	if (level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	return level;
}

/**
 * True when a selector explicitly requests provider-side reasoning disablement.
 */
export function shouldDisableReasoning(level: ThinkingLevel | undefined): boolean {
	return level === ThinkingLevel.Off;
}

/**
 * Resolves a selector against the current model while preserving explicit "off".
 */
export function resolveThinkingLevelForModel(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	if (level === undefined || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	if (level === ThinkingLevel.Off) {
		return ThinkingLevel.Off;
	}
	return clampThinkingLevelForModel(model, level);
}

/**
 * Sentinel selector for the coding-agent "auto" thinking mode. Kept entirely
 * inside the coding-agent layer: it is never an {@link Effort} or
 * {@link ThinkingLevel}, so provider mapping/clamping keeps seeing concrete
 * efforts. The session resolves `auto` to a concrete effort each turn.
 */
export const AUTO_THINKING = "auto" as const;

/** A thinking selector as configured by the user — a concrete level or `auto`. */
export type ConfiguredThinkingLevel = ThinkingLevel | typeof AUTO_THINKING;

/** Metadata used to render the `auto` selector value alongside concrete levels. */
export interface ConfiguredThinkingLevelMetadata {
	value: ConfiguredThinkingLevel;
	label: string;
	description: string;
}

const AUTO_THINKING_METADATA: ConfiguredThinkingLevelMetadata = {
	value: AUTO_THINKING,
	label: "auto",
	description: "Auto-detect per prompt (low–xhigh)",
};

/**
 * Parses a configured thinking selector, accepting `auto` in addition to every
 * value {@link parseThinkingLevel} accepts. {@link parseThinkingLevel} itself
 * stays strict so model-suffix parsing (`model:high`) keeps rejecting `auto`.
 */
export function parseConfiguredThinkingLevel(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	if (value === AUTO_THINKING) return AUTO_THINKING;
	if (value === "max") return ThinkingLevel.XHigh;
	return parseThinkingLevel(value);
}

/** Returns display metadata for a configured selector, including `auto`. */
export function getConfiguredThinkingLevelMetadata(level: ConfiguredThinkingLevel): ConfiguredThinkingLevelMetadata {
	return level === AUTO_THINKING ? AUTO_THINKING_METADATA : getThinkingLevelMetadata(level);
}

/**
 * Thinking selectors accepted by the `--thinking` CLI flag, in display order:
 * `off`, every concrete effort (`minimal`..`xhigh`), then `auto`. Single source
 * for the flag's `options` list, shell completions, and the "invalid level"
 * warning so all three stay in sync.
 */
export const CLI_THINKING_LEVELS: readonly string[] = [ThinkingLevel.Off, ...THINKING_EFFORTS, AUTO_THINKING];

/**
 * Parses a `--thinking` CLI value. Accepts every {@link parseConfiguredThinkingLevel}
 * selector (`off`, `auto`, `minimal`..`xhigh`, plus the `max` alias) but rejects
 * `inherit`: an explicit `inherit` on the command line would suppress the
 * settings/scoped-model fallback during startup resolution only to resolve back
 * to the provider default, which is never what the user means.
 */
export function parseCliThinkingLevel(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	const level = parseConfiguredThinkingLevel(value);
	return level === ThinkingLevel.Inherit ? undefined : level;
}

/**
 * Resolves an auto-classified effort against the active model's supported
 * range. Unlike {@link clampThinkingLevelForModel}, `auto` never resolves below
 * {@link Effort.Low}: the eligible pool is the model's supported efforts at or
 * above Low (falling back to the full supported set only when the model maxes
 * out below Low). Within that pool the request snaps to the highest level not
 * exceeding it, or the pool minimum when the request is below the pool.
 *
 * Returns `undefined` for reasoning-capable models without a controllable
 * effort surface (`thinking.efforts` empty — e.g. devin-agent models, where
 * Cascade selects effort by routing to sibling model ids). Matches
 * {@link clampThinkingLevelForModel}: with no effort to pick, `auto` must not
 * forward a concrete effort that would then trip {@link requireSupportedEffort}
 * downstream.
 */
export function clampAutoThinkingEffort(model: Model | undefined, effort: Effort): Effort | undefined {
	const supported = model ? getSupportedEfforts(model) : THINKING_EFFORTS;
	if (supported.length === 0) return undefined;
	const lowIndex = THINKING_EFFORTS.indexOf(Effort.Low);
	const eligible = supported.filter(level => THINKING_EFFORTS.indexOf(level) >= lowIndex);
	const pool = eligible.length > 0 ? eligible : supported;
	const requestedIndex = THINKING_EFFORTS.indexOf(effort);
	let chosen = pool[0];
	for (const candidate of pool) {
		if (THINKING_EFFORTS.indexOf(candidate) > requestedIndex) break;
		chosen = candidate;
	}
	return chosen;
}

/**
 * The provisional concrete level shown while `auto` is configured but before a
 * turn has been classified. Prefers the model's `defaultLevel`, otherwise High,
 * clamped into the auto range. Returns `undefined` for non-reasoning models.
 */
export function resolveProvisionalAutoLevel(model: Model | undefined): Effort | undefined {
	if (!model?.reasoning) return undefined;
	return clampAutoThinkingEffort(model, model.thinking?.defaultLevel ?? Effort.High);
}
