import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseThinkingLevel } from "../thinking";

/** Opt-in selectors that can otherwise be literal model-id suffixes. */
export interface ThinkingSuffixOptions {
	allowMaxSuffix?: boolean;
	allowAutoAlias?: boolean;
}

/** Selector parsing options with authoritative literal-model lookup. */
export interface ModelStringParseOptions extends ThinkingSuffixOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}
// Suffix recognition for the model-pattern parser: `:max` is a real thinking
// level and `:auto` maps to the auto sentinel. Both are gated behind flags
// (and the literal-id / exact-match guards on the callers) because real model
// ids end in `:max` (e.g. `glm-4.7:max`) — an ungated split would silently
// reinterpret them as a thinking suffix.
/** Recognize all configured effort selectors after literal-id matching. */
export const MAX_THINKING_SUFFIX_OPTIONS: ThinkingSuffixOptions = { allowMaxSuffix: true, allowAutoAlias: true };

/** Parse a suffix while preserving selectors not explicitly enabled. */
export function parseThinkingSuffix(
	value: string,
	options?: ThinkingSuffixOptions,
): ConfiguredThinkingLevel | undefined {
	const level = parseThinkingLevel(value);
	if (level === ThinkingLevel.Max) return options?.allowMaxSuffix === true ? level : undefined;
	if (level !== undefined) return level;
	if (options?.allowAutoAlias === true && value === AUTO_THINKING) return AUTO_THINKING;
	return undefined;
}

/**
 * Split a trailing `:<level>` thinking selector off a model pattern.
 *
 * `level` is set when the suffix parses as a concrete thinking level (or, when
 * the caller opts in via `allowMaxSuffix`/`allowAutoAlias`, the guarded `:max`
 * level / `:auto` sentinel); `base` then has the suffix stripped. Otherwise
 * `base` is the input.
 * `minColonIndex` requires the colon to appear strictly after that index —
 * role-alias callers pass the matched alias prefix length.
 */
export function splitThinkingSuffix(
	pattern: string,
	minColonIndex = -1,
	options?: ThinkingSuffixOptions,
): { base: string; level?: ConfiguredThinkingLevel } {
	const colonIdx = pattern.lastIndexOf(":");
	if (colonIdx <= minColonIndex) return { base: pattern };
	const level = parseThinkingSuffix(pattern.slice(colonIdx + 1), options);
	return level ? { base: pattern.slice(0, colonIdx), level } : { base: pattern };
}

/**
 * Parse a model string in "provider/modelId" format.
 * Returns undefined if the format is invalid.
 */
export function parseModelString(
	modelStr: string,
	options?: ModelStringParseOptions,
): { provider: string; id: string; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const id = modelStr.slice(slashIdx + 1);
	const provider = modelStr.slice(0, slashIdx);
	// Strip strict thinking level suffixes first (e.g. "claude-sonnet-4-6:high" -> id "claude-sonnet-4-6", thinkingLevel "high").
	const strict = splitThinkingSuffix(id);
	if (strict.level) return { provider, id: strict.base, thinkingLevel: strict.level };
	// `max` is a real thinking level, but real model IDs can also end in
	// `:max`. Context-aware callers pass a literal lookup so those models win.
	const maxAlias = splitThinkingSuffix(id, -1, options);
	if (maxAlias.level) {
		return options?.isLiteralModelId?.(provider, id) === true
			? { provider, id }
			: { provider, id: maxAlias.base, thinkingLevel: maxAlias.level };
	}
	return { provider, id };
}

export function formatModelSelectorValue(selector: string, thinkingLevel: ConfiguredThinkingLevel | undefined): string {
	return thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit ? `${selector}:${thinkingLevel}` : selector;
}

/** Bare slug (`cerebras`) or tiered/regional slug (`google-ai-studio/priority`, `google-vertex/global/flex`). */
const UPSTREAM_ROUTING_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Split a trailing `@<upstream>` provider-routing selector off a model pattern.
 *
 * `openrouter/z-ai/glm-4.7@cerebras` -> base `openrouter/z-ai/glm-4.7`, upstream
 * `cerebras`. Tiered upstreams keep their path (`...@google-ai-studio/priority`).
 * A `:thinking` suffix after the slug is kept on the base
 * (`...@cerebras:high` -> base `...:high`). Returns undefined when there is no
 * `@` or the suffix is not a bare provider slug, so model ids that legitimately
 * contain `@` (`claude-opus-4-8@default`, `workers-ai/@cf/...`) are never split.
 */
export function splitUpstreamRouting(pattern: string): { base: string; upstream: string } | undefined {
	const at = pattern.lastIndexOf("@");
	if (at <= 0) return undefined;
	const rest = pattern.slice(at + 1);
	const colon = rest.indexOf(":");
	const upstream = colon === -1 ? rest : rest.slice(0, colon);
	if (!UPSTREAM_ROUTING_SLUG.test(upstream)) return undefined;
	const trailing = colon === -1 ? "" : rest.slice(colon);
	return { base: pattern.slice(0, at) + trailing, upstream };
}
