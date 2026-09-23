import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { ConfiguredThinkingLevel } from "./render/render-utils";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { Model, ThinkingMode } from "@oh-my-pi/pi-catalog/types";
/** Thinking selectors accepted by CLI inputs, in display order. */
export const CLI_THINKING_LEVELS: readonly string[] = ["off", ...THINKING_EFFORTS, "auto"];

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
		description: "Extended reasoning (~32k tokens)",
	},
	[ThinkingLevel.Max]: {
		value: ThinkingLevel.Max,
		label: "max",
		description: "Maximum reasoning the model supports",
	},
};

const EFFORT_BY_SELECTOR: Readonly<Record<string, Effort>> = {
	[Effort.Minimal]: Effort.Minimal,
	[Effort.Low]: Effort.Low,
	[Effort.Medium]: Effort.Medium,
	[Effort.High]: Effort.High,
	[Effort.XHigh]: Effort.XHigh,
	[Effort.Max]: Effort.Max,
};
export const DEFAULT_THINKING_MODE = "default" as const;

export type ConfiguredThinkingMode = ThinkingMode | typeof DEFAULT_THINKING_MODE;

const THINKING_MODE_BY_SELECTOR: Readonly<Record<string, ConfiguredThinkingMode>> = {
	adaptive: "adaptive",
	default: DEFAULT_THINKING_MODE,
};

const THINKING_LEVEL_BY_SELECTOR: Readonly<Record<string, ThinkingLevel>> = {
	[ThinkingLevel.Inherit]: ThinkingLevel.Inherit,
	[ThinkingLevel.Off]: ThinkingLevel.Off,
	[ThinkingLevel.Minimal]: ThinkingLevel.Minimal,
	[ThinkingLevel.Low]: ThinkingLevel.Low,
	[ThinkingLevel.Medium]: ThinkingLevel.Medium,
	[ThinkingLevel.High]: ThinkingLevel.High,
	[ThinkingLevel.XHigh]: ThinkingLevel.XHigh,
	[ThinkingLevel.Max]: ThinkingLevel.Max,
};

function getOwnSelector<T>(selectors: Readonly<Record<string, T>>, value: string | null | undefined): T | undefined {
	if (value === undefined || value === null) return undefined;
	if (Object.hasOwn(selectors, value)) return selectors[value];
	// Accept unambiguous abbreviations (`xhi` → xhigh, `med` → medium) so every
	// selector surface (`--thinking`, `:suffix`, role values) parses alike.
	// Two-character minimum keeps single letters (`m`) from guessing.
	if (value.length < 2) return undefined;
	const matches = Object.keys(selectors).filter(selector => selector.startsWith(value));
	return matches.length === 1 ? selectors[matches[0]] : undefined;
}

/**
 * Parses a provider-facing effort value. Accepts unambiguous abbreviations.
 */
export function parseEffort(value: string | null | undefined): Effort | undefined {
	return getOwnSelector(EFFORT_BY_SELECTOR, value);
}

/**
 * Parses an agent-local thinking selector. Accepts unambiguous abbreviations.
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
 * Resolves a provider-neutral thinking mode against the selected model.
 *
 * Modes are purely additive refinements: `adaptive` survives only on models
 * whose thinking transport is adaptive. Disabling thinking is intensity, not
 * mode, so it never reaches this axis — it travels as `ThinkingLevel.Off` plus
 * `disableReasoning`.
 */
export function resolveThinkingModeForModel(
	model: Model | undefined,
	mode: ThinkingMode | undefined,
): ThinkingMode | undefined {
	return mode === "adaptive" && model?.thinking?.mode === "anthropic-adaptive" ? "adaptive" : undefined;
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
export type { ConfiguredThinkingLevel } from "./render/render-utils";

/** Maps the session-level `auto` sentinel to `undefined`; concrete levels pass through. */
export function concreteThinkingLevel(level: ConfiguredThinkingLevel | undefined): ThinkingLevel | undefined {
	return level === AUTO_THINKING ? undefined : level;
}

/**
 * True when a prewalk hand-off from `current`/`currentLevel` to
 * `target`/`targetLevel` would change nothing observable: same model id, same
 * auto/fixed mode, and the same model-clamped effective effort. Prewalk arms and
 * switches only when this is false.
 *
 * An effort-only delta on the same model id is a legitimate cheapening hand-off
 * — on a reasoning model the effort is the bulk of the cost — so it is NOT a
 * no-op and must still switch. A `targetLevel` of `undefined` means the prewalk
 * pattern carried no explicit `:level` suffix (no effort change requested),
 * which on the same model is a no-op.
 *
 * `auto` mode is compared before efforts: `auto` and a fixed selector that both
 * resolve to `undefined` effort (e.g. `:inherit`) are NOT interchangeable —
 * applying the fixed selector clears per-turn classification, so switching
 * auto↔fixed is always a real change even when the clamped efforts match.
 *
 * Efforts are otherwise compared AFTER model clamping, so a target the model
 * cannot honor (e.g. `:xhigh` on a model capped at `high`) — which
 * `setThinkingLevel` would clamp straight back to the active effort — is
 * recognized as a no-op instead of triggering an ephemeral reset and the
 * plan/checklist nudges for nothing.
 */
export function prewalkWouldBeNoop(
	current: Model | undefined,
	currentLevel: ConfiguredThinkingLevel | undefined,
	target: Model,
	targetLevel: ConfiguredThinkingLevel | undefined,
): boolean {
	if (!modelsAreEqual(current, target)) return false;
	if (targetLevel === undefined) return true;
	if ((targetLevel === AUTO_THINKING) !== (currentLevel === AUTO_THINKING)) return false;
	return (
		resolveThinkingLevelForModel(target, concreteThinkingLevel(targetLevel)) ===
		resolveThinkingLevelForModel(target, concreteThinkingLevel(currentLevel))
	);
}

/** Metadata used to render the `auto` selector value alongside concrete levels. */
export interface ConfiguredThinkingLevelMetadata {
	value: ConfiguredThinkingLevel;
	label: string;
	description: string;
}

const AUTO_THINKING_METADATA: ConfiguredThinkingLevelMetadata = {
	value: AUTO_THINKING,
	label: "auto",
	description: "Auto-detect per prompt",
};

/**
 * Parses a configured thinking selector, accepting `auto` in addition to every
 * value {@link parseThinkingLevel} accepts. {@link parseThinkingLevel} itself
 * stays strict so model-suffix parsing (`model:high`) keeps rejecting `auto`.
 */
export function parseConfiguredThinkingLevel(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	if (value === AUTO_THINKING) return AUTO_THINKING;
	return parseThinkingLevel(value);
}

/** Returns display metadata for a configured selector, including `auto`. */
export function getConfiguredThinkingLevelMetadata(level: ConfiguredThinkingLevel): ConfiguredThinkingLevelMetadata {
	return level === AUTO_THINKING ? AUTO_THINKING_METADATA : getThinkingLevelMetadata(level);
}

/**
 * Thinking modes accepted by the `--thinking` CLI flag, in display order.
 *
 * This axis is purely additive: it selects a provider-side thinking *mode* that
 * only some models advertise (currently Claude 4.6+/5 `adaptive`). Disabling
 * thinking is intensity, not mode, so it lives on `--effort off` alongside the
 * rest of the ladder — a single universal axis every provider already honors.
 */
export const CLI_THINKING_MODES: readonly string[] = ["adaptive", DEFAULT_THINKING_MODE];

/**
 * Parses a `--thinking` CLI value as a mode selector. Effort values (including
 * `off`) return `undefined` here; {@link parseCliEffort} owns them, and the CLI
 * flag routes them to `--effort` with a deprecation warning.
 */
export function parseCliThinkingMode(value: string | null | undefined): ConfiguredThinkingMode | undefined {
	return getOwnSelector(THINKING_MODE_BY_SELECTOR, value);
}

/**
 * Effort selectors accepted by the `--effort` CLI flag, in display order:
 * `off`, every concrete effort (`minimal`..`max`), then `auto`.
 */
export const CLI_EFFORT_LEVELS: readonly string[] = [ThinkingLevel.Off, ...THINKING_EFFORTS, AUTO_THINKING];

const CLI_EFFORT_BY_SELECTOR: Readonly<Record<string, ConfiguredThinkingLevel>> = {
	...EFFORT_BY_SELECTOR,
	[ThinkingLevel.Off]: ThinkingLevel.Off,
	[AUTO_THINKING]: AUTO_THINKING,
};

/**
 * Parses a `--effort` CLI value. Accepts unambiguous abbreviations for every
 * selector, `off` and `auto` included, matching `--thinking`'s legacy domain.
 */
export function parseCliEffort(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	return getOwnSelector(CLI_EFFORT_BY_SELECTOR, value);
}

/** Maps a configured thinking mode to the provider-neutral request mode. */
export function toProviderThinkingMode(mode: ConfiguredThinkingMode | undefined): ThinkingMode | undefined {
	return mode === DEFAULT_THINKING_MODE ? undefined : mode;
}

/**
 * Resolves an auto-classified effort against the active model's supported
 * range. Unlike {@link clampThinkingLevelForModel}, `auto` never resolves below
 * {@link Effort.Low}: the eligible pool is the model's supported efforts at or
 * above Low (falling back to the full supported set only when the model maxes
 * out below Low). Within that pool the request snaps to the highest level not
 * exceeding it, or the pool minimum when the request is below the pool.
 * `ceiling` bounds the pool from above, so a policy ceiling survives the model
 * clamp: a sparse ladder such as `["max"]` must not snap an `xhigh` request up
 * to `max`. The Low floor is resolved against the model's own ladder *before*
 * the ceiling applies — a ceiling that hides every tier at or above Low means
 * there is nothing legal to pick (`undefined`), not a licence to fall through
 * to a sub-Low tier the model happens to expose.
 *
 * Returns `undefined` for reasoning-capable models without a controllable
 * effort surface (`thinking.efforts` empty — e.g. devin-agent models, where
 * Cascade selects effort by routing to sibling model ids). Matches
 * {@link clampThinkingLevelForModel}: with no effort to pick, `auto` must not
 * forward a concrete effort that would then trip {@link requireSupportedEffort}
 * downstream.
 */
export function clampAutoThinkingEffort(
	model: Model | undefined,
	effort: Effort,
	ceiling: Effort = Effort.Max,
): Effort | undefined {
	const supported = model ? getSupportedEfforts(model) : THINKING_EFFORTS;
	if (supported.length === 0) return undefined;
	const lowIndex = THINKING_EFFORTS.indexOf(Effort.Low);
	const ceilingIndex = THINKING_EFFORTS.indexOf(ceiling);
	const atOrAboveLow = supported.filter(level => THINKING_EFFORTS.indexOf(level) >= lowIndex);
	const floored = atOrAboveLow.length > 0 ? atOrAboveLow : supported;
	const pool = floored.filter(level => THINKING_EFFORTS.indexOf(level) <= ceilingIndex);
	if (pool.length === 0) return undefined;
	const requestedIndex = THINKING_EFFORTS.indexOf(effort);
	let chosen = pool[0];
	for (const candidate of pool) {
		if (THINKING_EFFORTS.indexOf(candidate) > requestedIndex) break;
		chosen = candidate;
	}
	return chosen;
}

/** Coarse per-spawn effort selectors accepted by the task tool. */
export const TASK_EFFORTS = ["lo", "med", "hi"] as const;

/** Coarse task-spawn effort: the lowest, middle, or highest thinking level the target model supports. */
export type TaskEffort = (typeof TASK_EFFORTS)[number];

/**
 * Maps a coarse task effort onto the model's supported thinking range:
 * `lo` = lowest supported level, `hi` = highest (whatever the model tops out
 * at — high, xhigh, or max), `med` = the middle (lower of the two middles for
 * an even-sized range). Without a model, maps over the full canonical range.
 * Returns `undefined` when the model has no controllable effort surface, so
 * callers fall back to their default selector (e.g. `auto`). Throws when the
 * configured ceiling is below the model's lowest supported effort.
 */
export function resolveTaskEffortLevel(
	model: Model | undefined,
	effort: TaskEffort,
	maxEffort?: Effort,
): Effort | undefined {
	const supported = model ? getSupportedEfforts(model) : THINKING_EFFORTS;
	if (supported.length === 0) return undefined;
	let resolved: Effort;
	switch (effort) {
		case "lo":
			resolved = supported[0];
			break;
		case "med":
			resolved = supported[(supported.length - 1) >> 1];
			break;
		case "hi":
			resolved = supported[supported.length - 1];
			break;
	}
	if (maxEffort === undefined) return resolved;
	const maxIndex = THINKING_EFFORTS.indexOf(maxEffort);
	const ceiling = supported.findLast(candidate => THINKING_EFFORTS.indexOf(candidate) <= maxIndex);
	if (ceiling === undefined) {
		const modelName = model ? `${model.provider}/${model.id}` : "Selected model";
		throw new RangeError(`${modelName} has no supported thinking effort at or below task.maxEffort=${maxEffort}`);
	}
	return THINKING_EFFORTS.indexOf(resolved) > THINKING_EFFORTS.indexOf(ceiling) ? ceiling : resolved;
}

/**
 * Clamps a concrete thinking selector to a per-session effort ceiling (e.g. a
 * task spawn's `task.maxEffort`-capped effort hint). `off`/`inherit`/
 * `undefined` pass through, as do levels already at or below the ceiling.
 * Levels above it snap to the highest model-supported effort at or below the
 * ceiling. A model whose floor exceeds the ceiling has nothing valid to snap
 * to; the requested level is returned unchanged and the caller is responsible
 * for rejecting or skipping such models (see {@link modelSupportsEffortCeiling}).
 */
export function clampThinkingLevelToCeiling(
	model: Model | undefined,
	level: Effort | undefined,
	ceiling: Effort | undefined,
): Effort | undefined;
export function clampThinkingLevelToCeiling(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
	ceiling: Effort | undefined,
): ThinkingLevel | undefined;
export function clampThinkingLevelToCeiling(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
	ceiling: Effort | undefined,
): ThinkingLevel | undefined {
	if (ceiling === undefined || level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return level;
	}
	const maxIndex = THINKING_EFFORTS.indexOf(ceiling);
	if (THINKING_EFFORTS.indexOf(level) <= maxIndex) return level;
	const supported = model ? getSupportedEfforts(model) : THINKING_EFFORTS;
	return supported.findLast(candidate => THINKING_EFFORTS.indexOf(candidate) <= maxIndex) ?? level;
}

/**
 * True when `model` can honor a thinking-effort ceiling: it either has no
 * controllable effort surface (nothing to cap) or supports at least one effort
 * at or below the ceiling. Retry-fallback candidate filtering uses this to
 * skip models whose floor would force the session above the ceiling.
 */
export function modelSupportsEffortCeiling(model: Model, ceiling: Effort): boolean {
	const supported = getSupportedEfforts(model);
	if (supported.length === 0) return true;
	const maxIndex = THINKING_EFFORTS.indexOf(ceiling);
	return supported.some(candidate => THINKING_EFFORTS.indexOf(candidate) <= maxIndex);
}

/**
 * The provisional concrete level shown while `auto` is configured but before a
 * turn has been classified, and the fallback when classification fails. Prefers
 * the model's `defaultLevel`, otherwise High, clamped into the auto range.
 *
 * Deliberately stays below {@link Effort.Max}: the placeholder must not bill the
 * top tier for a turn nobody classified, so XHigh is passed as a hard ceiling
 * rather than only capping the preferred level — otherwise a sparse `["max"]`
 * ladder would snap straight back up. A model whose ladder offers nothing at or
 * below XHigh therefore has no provisional level, and `auto` leaves the current
 * one in place. Classification itself may still resolve Max on models that
 * expose the tier when the user opts in. Returns `undefined` for non-reasoning
 * models.
 */
export function resolveProvisionalAutoLevel(model: Model | undefined): Effort | undefined {
	if (!model?.reasoning) return undefined;
	const preferred = model.thinking?.defaultLevel ?? Effort.High;
	return clampAutoThinkingEffort(model, preferred === Effort.Max ? Effort.XHigh : preferred, Effort.XHigh);
}
