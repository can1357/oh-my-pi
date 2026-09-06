/**
 * Resolve a `/subagent using <alias-or-model>` selector to a concrete catalog
 * model id (`<provider>/<model>`, optionally with `:thinkingLevel`).
 *
 * Lookup order:
 *   1. User-defined alias map (`subagent.modelAliases`) — exact key match.
 *   2. User-defined alias map — case-, space-, and hyphen-insensitive match.
 *   3. Model resolver fallback — `<provider>/<model>`, `<model>`, or a fuzzy
 *      match against the catalog via the shared `parseModelPattern` pipeline.
 *   4. Returns `null` when nothing matches; callers are expected to surface
 *      the unresolved alias to the user rather than silently defaulting.
 *
 * The resolver is intentionally a pure function: no settings reads, no
 * mutations, no logging. Wire callers feed it the alias map they already
 * fetched; tests can drive it with a bare `ModelRegistry` mock exposing
 * `getAvailable` plus the optional canonical helpers `parseModelPattern`
 * consults when matching bare ids.
 */

import type { ModelRegistry } from "../config/model-registry";
import { parseModelPattern, resolveModelFromString } from "../config/model-resolver";

/**
 * Minimum surface of {@link ModelRegistry} the resolver actually consumes.
 * Letting callers pass a partial keeps tests mock-cheap — `parseModelPattern`
 * only invokes `getAvailable`, and `resolveModelFromString` consults
 * `resolveCanonicalModel` / `getCanonicalId` opportunistically.
 */
export type SubagentAliasRegistry = Pick<ModelRegistry, "getAvailable"> &
	Partial<Pick<ModelRegistry, "resolveCanonicalModel" | "getCanonicalId">>;

export const BUILTIN_SUBAGENT_MODEL_ALIASES: Record<string, string> = {
	"minimax-code": "minimax-code/MiniMax-M3",
	"kimi-code": "kimi-code/kimi-for-coding",
	"minimax m3": "minimax/MiniMax-M3",
	// Concrete default for browser subagent spawns; role path is pi/browser-control (MiniMax-M3).
	"browser-fast": "9router/minimax/MiniMax-M3",
};

export function mergeSubagentModelAliases(userAliases: Record<string, string>): Record<string, string> {
	return { ...BUILTIN_SUBAGENT_MODEL_ALIASES, ...userAliases };
}

/** Normalize an alias key (or user input) for case-, space-, and hyphen-insensitive lookup. */
export function normalizeAliasKey(value: string): string {
	return value.toLowerCase().replace(/[\s\-_]+/g, "");
}

/**
 * Strip a trailing `:thinkingLevel` from a selector-style alias value so the
 * key match is purely structural. The thinking suffix lives on the resolved
 * selector and is carried through to the spawn unchanged.
 */
function splitThinkingSuffixFromAliasKey(value: string): string {
	const colonIdx = value.lastIndexOf(":");
	if (colonIdx <= 0) return value;
	const suffix = value.slice(colonIdx + 1);
	if (!suffix) return value;
	// Only strip when the suffix is a recognized thinking level; otherwise the
	// colon is part of a real model id (e.g. `openrouter/<id>:exacto`) and must
	// stay intact for the alias-map comparison.
	const knownLevels = new Set([
		"off",
		"min",
		"minimal",
		"low",
		"medium",
		"med",
		"high",
		"max",
		"xhigh",
		"ultra",
		"inherit",
		"auto",
	]);
	return knownLevels.has(suffix.toLowerCase()) ? value.slice(0, colonIdx) : value;
}

function resolveCatalogSelector(input: string, registry: SubagentAliasRegistry): string | null {
	const available = registry.getAvailable?.() ?? [];
	if (available.length === 0) return null;

	const viaFromString = resolveModelFromString(input, available, undefined, registry);
	if (viaFromString) {
		return `${viaFromString.provider}/${viaFromString.id}`;
	}

	const parsed = parseModelPattern(input, available, undefined, {
		allowInvalidThinkingSelectorFallback: false,
		modelRegistry: registry,
	});
	if (parsed.model) {
		const selector = `${parsed.model.provider}/${parsed.model.id}`;
		return parsed.thinkingLevel ? `${selector}:${parsed.thinkingLevel}` : selector;
	}

	return null;
}

/**
 * Resolve `input` to a concrete catalog model selector.
 *
 * Returns the selector as it should be passed to the model-resolver pipeline
 * (i.e. `provider/id` or `provider/id:thinking`). Returns `null` when no
 * alias matches and the model-resolver fallback also fails to bind a model —
 * callers MUST treat `null` as a hard "no usable model" signal rather than
 * silently falling back to the session default (the spawn path already
 * surfaces a clear error in that case).
 */
function appendThinkingSuffix(selector: string, thinkingSuffix: string | undefined): string {
	if (!thinkingSuffix) return selector;
	// Catalog resolution may already re-attach a thinking level; prefer the
	// caller-authored suffix from the alias input when present.
	const base = splitThinkingSuffixFromAliasKey(selector);
	return `${base}${thinkingSuffix}`;
}

export function resolveSubagentModelAlias(
	input: string,
	aliases: Record<string, string>,
	registry: SubagentAliasRegistry,
): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	// Preserve `:thinkingLevel` through alias lookup. Matching uses the base key;
	// the suffix is reattached to the resolved catalog selector.
	const aliasBase = splitThinkingSuffixFromAliasKey(trimmed);
	const thinkingSuffix = aliasBase === trimmed ? undefined : trimmed.slice(aliasBase.length);

	// 1. Exact alias match on the base key (case-sensitive — preserves the user-authored key).
	const exact = aliases[aliasBase] ?? (thinkingSuffix ? undefined : aliases[trimmed]);
	if (exact && exact.trim().length > 0) {
		const resolved = resolveCatalogSelector(exact.trim(), registry);
		return resolved ? appendThinkingSuffix(resolved, thinkingSuffix) : null;
	}

	// 2. Loose alias match: normalize keys and input to a single shape.
	const normalizedInput = normalizeAliasKey(aliasBase);
	if (normalizedInput.length > 0) {
		for (const [key, value] of Object.entries(aliases)) {
			if (normalizeAliasKey(splitThinkingSuffixFromAliasKey(key)) === normalizedInput) {
				const trimmedValue = value.trim();
				if (trimmedValue.length > 0) {
					const resolved = resolveCatalogSelector(trimmedValue, registry);
					return resolved ? appendThinkingSuffix(resolved, thinkingSuffix) : null;
				}
			}
		}
	}

	// 3. Model-resolver fallback. The alias key may itself be a real selector
	// (`provider/model`, canonical id, bare model id) that just isn't in the
	// map — try it through the shared pipeline before giving up.
	const available = registry.getAvailable?.() ?? [];
	if (available.length === 0) return null;

	const viaFromString = resolveModelFromString(trimmed, available, undefined, registry);
	if (viaFromString) {
		const selector = `${viaFromString.provider}/${viaFromString.id}`;
		return appendThinkingSuffix(selector, thinkingSuffix);
	}

	// `parseModelPattern` is the lenient matcher that also accepts bare ids and
	// fuzzy substring matches; pass `allowInvalidThinkingSelectorFallback: false`
	// so a typo'd `:thinking` doesn't silently swallow the failure.
	const parsed = parseModelPattern(trimmed, available, undefined, {
		allowInvalidThinkingSelectorFallback: false,
		modelRegistry: registry,
	});
	if (parsed.model) {
		const selector = `${parsed.model.provider}/${parsed.model.id}`;
		if (parsed.thinkingLevel) {
			return `${selector}:${parsed.thinkingLevel}`;
		}
		return appendThinkingSuffix(selector, thinkingSuffix);
	}

	// 4. Unresolved — let the caller surface the failure.
	return null;
}

// Internal export kept for tests; production callers should only need
// `resolveSubagentModelAlias`. Marked `__test` so accidental import outside
// the test build is loud at the call site.
export const __test = { splitThinkingSuffixFromAliasKey, normalizeAliasKey };
