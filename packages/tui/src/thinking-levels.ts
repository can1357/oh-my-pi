import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

/**
 * Sentinel selector for the coding-agent "auto" thinking mode. Kept entirely
 * inside the coding-agent layer: it is never an {@link Effort} or
 * {@link ThinkingLevel}, so provider mapping/clamping keeps seeing concrete
 * efforts. The session resolves `auto` to a concrete effort each turn.
 */
export const AUTO_THINKING = "auto" as const;

/** Effort levels that may serve as a minimum floor for auto thinking. Excludes max. */
export const AUTO_THINKING_FLOORS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] as const;
export type AutoThinkingFloor = (typeof AUTO_THINKING_FLOORS)[number];

/** Effort levels that may serve as the maximum of an `auto:[<floor>]-<ceiling>` selector. Excludes minimal. */
export const AUTO_THINKING_CEILINGS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;
export type AutoThinkingCeiling = (typeof AUTO_THINKING_CEILINGS)[number];

/** Every valid `auto:<floor>-<ceiling>` selector: floor strictly below ceiling, in ladder order. */
export const AUTO_THINKING_RANGES = [
	"auto:minimal-low",
	"auto:minimal-medium",
	"auto:minimal-high",
	"auto:minimal-xhigh",
	"auto:minimal-max",
	"auto:low-medium",
	"auto:low-high",
	"auto:low-xhigh",
	"auto:low-max",
	"auto:medium-high",
	"auto:medium-xhigh",
	"auto:medium-max",
	"auto:high-xhigh",
	"auto:high-max",
	"auto:xhigh-max",
] as const;
export type AutoThinkingRange = (typeof AUTO_THINKING_RANGES)[number];

/**
 * Every valid ceiling-only `auto:-<ceiling>` selector: the ceiling replaces
 * `providers.autoThinkingMaxEffort`, the floor stays `providers.autoThinkingMinEffort`.
 */
export const AUTO_THINKING_CEILING_SELECTORS = [
	"auto:-low",
	"auto:-medium",
	"auto:-high",
	"auto:-xhigh",
	"auto:-max",
] as const;
export type AutoThinkingCeilingSelector = (typeof AUTO_THINKING_CEILING_SELECTORS)[number];

/**
 * A thinking selector configured as automatic selection: `auto`, `auto:<floor>`,
 * `auto:-<ceiling>`, or `auto:<floor>-<ceiling>`.
 */
export type AutoThinkingLevel = "auto" | `auto:${AutoThinkingFloor}` | AutoThinkingCeilingSelector | AutoThinkingRange;
export type ConfiguredThinkingLevel = ThinkingLevel | AutoThinkingLevel;

/**
 * Every canonical auto selector, in display order. The settings enum and the RPC
 * wire enum are built from this list, so it is the one source of legal values.
 */
export const AUTO_THINKING_LEVELS = [
	AUTO_THINKING,
	...AUTO_THINKING_FLOORS.map(effort => `auto:${effort}` as const),
	...AUTO_THINKING_CEILING_SELECTORS,
	...AUTO_THINKING_RANGES,
] as const;

/**
 * True when `level` is a canonical auto selector. Abbreviated input (`auto:med`)
 * is not canonical; parse it with `parseAutoThinkingLevel` first.
 */
export function isAutoThinking(level: unknown): level is AutoThinkingLevel {
	return AUTO_THINKING_LEVELS.some(selector => selector === level);
}

/**
 * Picker levels with a stored `auto:<floor>[-<ceiling>]` selector kept as its own
 * entry (after plain `auto`, else after `off`), so confirming the preselected entry
 * writes the bounds back instead of plain `auto`, `off` or `inherit`.
 */
export function withStoredAutoSelector(
	options: readonly ConfiguredThinkingLevel[],
	current: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel[] {
	if (!isAutoThinking(current) || options.includes(current)) return [...options];
	const anchor = options.includes(AUTO_THINKING) ? AUTO_THINKING : ThinkingLevel.Off;
	const at = options.indexOf(anchor) + 1;
	return [...options.slice(0, at), current, ...options.slice(at)];
}
