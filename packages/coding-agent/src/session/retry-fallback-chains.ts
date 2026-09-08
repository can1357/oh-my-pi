import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	parseModelString,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "../thinking";

/** Configured fallback chains keyed by role or model selector. */
export type RetryFallbackChains = Record<string, string[]>;

/** Policy controlling restoration of a fallback chain's primary model. */
export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

/** Parsed model selector used by retry fallback resolution. */
export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

/** Minimal model lookup needed by fallback-chain resolution. */
export interface RetryFallbackModelLookup {
	find(provider: string, id: string): Model | undefined;
	hasProvider(provider: string): boolean;
}

/**
 * Inputs shared by startup (sdk) and runtime (turn-recovery) fallback-chain
 * resolution. `chains` is pre-expanded so callers can apply the default chain
 * to roles beyond the configured model roles (e.g. a subagent fallback role).
 */
export interface RetryFallbackResolutionContext {
	chains: RetryFallbackChains;
	getModelRole(role: string): string | undefined;
	modelLookup: RetryFallbackModelLookup;
}

/** Active retry fallback state retained until the primary can be restored. */
export interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
	/**
	 * Set once a turn on the fallback target settles successfully. Until then the
	 * switch is only a routing decision — nothing has been produced by the new
	 * model, so no observer may report the run as having used it.
	 */
	served?: boolean;
}

/** Model a session's produced work is attributed to. */
export interface ServingModel {
	/** Full selector including routing and thinking level. */
	selector: string;
	/** Whether fallback routing, rather than the configured primary, owns it. */
	isFallback: boolean;
}

const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;
const RETRY_BACKOFF_JITTER_RATIO = 0.25;

/** Calculates capped exponential retry delay with downward jitter. */
export function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/** Parses a configured retry fallback selector. */
export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: Pick<RetryFallbackModelLookup, "find">,
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/** Whether a fallback-chain key is a model selector rather than a role. */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/** Whether a fallback-chain key or entry is a provider wildcard. */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

/** Splits a wildcard selector into provider and optional model-id prefix. */
export function parseRetryFallbackWildcard(
	key: string,
	isKnownProvider: (provider: string) => boolean,
): { provider: string; idPrefix: string | undefined } {
	const template = key.slice(0, -2);
	const slash = template.indexOf("/");
	if (slash < 0 || isKnownProvider(template)) return { provider: template, idPrefix: undefined };
	return { provider: template.slice(0, slash), idPrefix: template.slice(slash + 1) };
}

/** Formats a concrete model and thinking level as a fallback selector. */
export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

/** Formats the model-only portion of a parsed fallback selector. */
function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

/** Whether a provider is registered or configured for discovery. */
export function isKnownProvider(modelRegistry: ModelRegistry, provider: string): boolean {
	return modelRegistry.hasProvider(provider);
}

/** Apply the configured default chain to roles without their own chain. */
export function expandDefaultRetryFallbackChains(
	configuredChains: RetryFallbackChains,
	roleNames: readonly string[],
): RetryFallbackChains {
	const chains: RetryFallbackChains = { ...configuredChains };
	const defaultChain = chains.default;
	if (!Array.isArray(defaultChain)) return chains;
	for (const role of roleNames) {
		if (role !== "default" && chains[role] === undefined) chains[role] = defaultChain;
	}
	return chains;
}

/** Resolves configured fallback chains, applying the default chain to named roles. */
export function getRetryFallbackChains(settings: Settings): RetryFallbackChains {
	const configuredChains = settings.get("retry.fallbackChains");
	if (!configuredChains || typeof configuredChains !== "object") return {};
	return expandDefaultRetryFallbackChains(configuredChains, Object.keys(settings.getModelRoles()));
}

/**
 * Validates configured fallback chains and reports each warning via `warn`.
 *
 * `options.isDiscoveryPending` suppresses "unknown model" warnings for
 * selectors whose config-declared discovery provider has not yet populated the
 * registry (a cold discovery cache after `omp update` bumps the cache
 * namespace, #10048). Such selectors are re-checked once background discovery
 * settles. Logging is the caller's responsibility so a post-discovery re-run
 * does not double-log persistent warnings.
 */
export function validateRetryFallbackChains(
	settings: Settings,
	modelRegistry: ModelRegistry,
	warn: (message: string) => void,
	options: { isDiscoveryPending?: (provider: string) => boolean } = {},
): void {
	const configuredChains = settings.get("retry.fallbackChains");
	if (configuredChains === undefined) return;
	const report = warn;
	const isDiscoveryPending = options.isDiscoveryPending ?? (() => false);
	if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
		report("retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.");
		return;
	}

	for (const key in configuredChains) {
		const chain = configuredChains[key];
		const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
		if (keyKind === "model") {
			if (isRetryFallbackWildcardKey(key)) {
				const { provider } = parseRetryFallbackWildcard(key, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`retry.fallbackChains wildcard key references unknown provider: ${key}`);
				}
			} else {
				const parsedKey = parseRetryFallbackSelector(key, modelRegistry);
				if (!parsedKey) {
					report(`Invalid model selector key in retry.fallbackChains: ${key}`);
				} else if (
					!modelRegistry.find(parsedKey.provider, parsedKey.id) &&
					!isDiscoveryPending(parsedKey.provider)
				) {
					report(`retry.fallbackChains key references unknown model: ${key}`);
				}
			}
		}
		if (!Array.isArray(chain)) {
			report(`Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`);
			continue;
		}
		for (const selectorStr of chain) {
			if (typeof selectorStr !== "string") {
				report(`Fallback chain for ${keyKind} '${key}' contains a non-string selector.`);
				continue;
			}
			if (isRetryFallbackWildcardKey(selectorStr)) {
				const { provider } = parseRetryFallbackWildcard(selectorStr, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`Fallback chain for ${keyKind} '${key}' references unknown provider: ${selectorStr}`);
				}
				continue;
			}
			const parsed = parseRetryFallbackSelector(selectorStr, modelRegistry);
			if (!parsed) {
				report(`Invalid fallback selector format in ${keyKind} '${key}': ${selectorStr}`);
				continue;
			}
			if (!modelRegistry.find(parsed.provider, parsed.id) && !isDiscoveryPending(parsed.provider)) {
				report(`Fallback chain for ${keyKind} '${key}' references unknown model: ${selectorStr}`);
			}
		}
	}
}

/** Returns the configured fallback-primary restoration policy. */
export function getRetryFallbackRevertPolicy(settings: Settings): RetryFallbackRevertPolicy {
	return settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
}

/** Resolves the primary selector represented by a fallback-chain key. */
function getRetryFallbackPrimarySelector(
	context: RetryFallbackResolutionContext,
	chainKey: string,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(chainKey)) return undefined;
	if (isRetryFallbackModelKey(chainKey)) return parseRetryFallbackSelector(chainKey, context.modelLookup);
	const configuredSelector = context.getModelRole(chainKey);
	return configuredSelector ? parseRetryFallbackSelector(configuredSelector, context.modelLookup) : undefined;
}

function selectorMatchesCurrent(
	primary: RetryFallbackSelector | undefined,
	currentSelector: string,
	currentBaseSelector: string,
	currentPlainSelector: string | undefined,
	currentPlainBaseSelector: string | undefined,
): boolean {
	if (!primary) return false;
	if (primary.raw === currentSelector || (currentPlainSelector && primary.raw === currentPlainSelector)) return true;
	const base = formatRetryFallbackBaseSelector(primary);
	return base === currentBaseSelector || (!!currentPlainBaseSelector && base === currentPlainBaseSelector);
}

/**
 * Resolve the chain key for a concrete selector by specificity: exact model,
 * longest matching wildcard, hinted role, then matching role keys with
 * `default` preferred over other shared assignments, then default.
 */
export function resolveRetryFallbackChainKey(
	context: RetryFallbackResolutionContext,
	currentSelector: string,
	currentModel?: Model | null,
	roleHint?: string,
): string | undefined {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) {
		if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
		return undefined;
	}
	const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
	const currentPlainBaseSelector =
		currentPlainSelector && currentPlainSelector !== currentSelector
			? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
			: undefined;

	// 1. Exact model-selector keys — most specific.
	for (const key in context.chains) {
		if (isRetryFallbackModelKey(key) && !isRetryFallbackWildcardKey(key)) {
			if (
				selectorMatchesCurrent(
					getRetryFallbackPrimarySelector(context, key),
					currentSelector,
					currentBaseSelector,
					currentPlainSelector,
					currentPlainBaseSelector,
				)
			) {
				return key;
			}
		}
	}

	// 2. Provider wildcards — an id-prefixed key (`openrouter/google/*`)
	//    beats the plain `provider/*` key for ids under its prefix.
	let wildcardMatch: string | undefined;
	let wildcardPrefixLength = -1;
	for (const key in context.chains) {
		if (!isRetryFallbackWildcardKey(key) || !Array.isArray(context.chains[key])) continue;
		const { provider, idPrefix } = parseRetryFallbackWildcard(key, provider =>
			context.modelLookup.hasProvider(provider),
		);
		if (provider !== parsedCurrent.provider) continue;
		if (idPrefix !== undefined && !parsedCurrent.id.startsWith(`${idPrefix}/`)) continue;
		const prefixLength = idPrefix?.length ?? 0;
		if (prefixLength > wildcardPrefixLength) {
			wildcardMatch = key;
			wildcardPrefixLength = prefixLength;
		}
	}
	if (wildcardMatch) return wildcardMatch;

	// 3. The hinted role, then role keys matched by their assigned model.
	// A shared assignment (default and vision both the same model) must not
	// let yaml insertion order steal the live role's chain. Prefer the hint,
	// then `default` when it also matches.
	if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
	let matchedRole: string | undefined;
	for (const key in context.chains) {
		if (isRetryFallbackModelKey(key)) continue;
		if (
			selectorMatchesCurrent(
				getRetryFallbackPrimarySelector(context, key),
				currentSelector,
				currentBaseSelector,
				currentPlainSelector,
				currentPlainBaseSelector,
			)
		) {
			if (key === "default") return "default";
			matchedRole ??= key;
		}
	}
	if (matchedRole) return matchedRole;

	// 4. The default chain, when default has no explicit role primary.
	const defaultChain = context.chains.default;
	if (
		Array.isArray(defaultChain) &&
		defaultChain.length > 0 &&
		getRetryFallbackPrimarySelector(context, "default") === undefined
	) {
		return "default";
	}
	return undefined;
}

/**
 * Parse one configured chain entry. A `provider/*` entry keeps the failing
 * model's id and swaps the provider (google-antigravity/x → google/x); an
 * id-prefixed `provider/prefix/*` entry re-prefixes the failing model's
 * bare id instead (openrouter/google/* : google-antigravity/x →
 * openrouter/google/x). Ids the target provider lacks are skipped by the
 * candidate loop's registry lookup.
 */
function parseRetryFallbackChainEntry(
	context: RetryFallbackResolutionContext,
	entry: string,
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector | undefined {
	if (!isRetryFallbackWildcardKey(entry)) return parseRetryFallbackSelector(entry, context.modelLookup);
	if (!current) return undefined;
	const { provider, idPrefix } = parseRetryFallbackWildcard(entry, candidate =>
		context.modelLookup.hasProvider(candidate),
	);
	const bareId = current.id.slice(current.id.lastIndexOf("/") + 1);
	let id: string;
	if (idPrefix !== undefined) {
		id = `${idPrefix}/${bareId}`;
	} else if (
		bareId !== current.id &&
		!context.modelLookup.find(provider, current.id) &&
		context.modelLookup.find(provider, bareId)
	) {
		// Aggregator → direct: the failing id carries a vendor prefix the
		// target provider does not use (openrouter/google/x → google-vertex/x).
		id = bareId;
	} else {
		id = current.id;
	}
	return { raw: `${provider}/${id}`, provider, id, thinkingLevel: undefined };
}

/** Builds a fallback chain beginning with its effective primary selector. */
function getRetryFallbackEffectiveChain(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel: Model | null | undefined,
	allowMissingPrimary: boolean,
): RetryFallbackSelector[] {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const parsedCurrent =
		parsedConfigured ??
		(currentModel
			? parseRetryFallbackSelector(
					formatModelSelectorValue(formatModelString(currentModel), undefined),
					context.modelLookup,
				)
			: undefined);
	const seen = new Set<string>();
	const chain: RetryFallbackSelector[] = [];
	if (isRetryFallbackWildcardKey(chainKey)) {
		// A wildcard key has no fixed primary: the active model is the
		// primary, followed by the configured provider-level fallbacks.
		if (parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		}
	} else {
		const primarySelector = getRetryFallbackPrimarySelector(context, chainKey);
		if (primarySelector) {
			chain.push(primarySelector);
			seen.add(primarySelector.raw);
		} else if ((chainKey === "default" || allowMissingPrimary) && parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		} else if (!allowMissingPrimary) {
			return [];
		}
	}
	for (const selector of context.chains[chainKey] ?? []) {
		const parsed = parseRetryFallbackChainEntry(context, selector, parsedCurrent);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		chain.push(parsed);
	}
	return chain;
}

/**
 * Return candidates after the current selector in an effective chain.
 * `wrapAround` additionally appends entries before the current selector,
 * without returning the current selector itself.
 */
export function findRetryFallbackCandidates(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel?: Model | null,
	options?: { allowMissingPrimary?: boolean; wrapAround?: boolean },
): RetryFallbackSelector[] {
	const chain = getRetryFallbackEffectiveChain(
		context,
		chainKey,
		currentSelector,
		currentModel,
		options?.allowMissingPrimary === true,
	);
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) return chain;
	if (chain.length <= 1) return [];
	const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
	const currentPlainBaseSelector =
		parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
			? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
			: undefined;
	const exactIndex = chain.findIndex(
		selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
	);
	if (exactIndex >= 0) {
		const candidatesAfter = chain.slice(exactIndex + 1);
		return options?.wrapAround ? [...candidatesAfter, ...chain.slice(0, exactIndex)] : candidatesAfter;
	}
	const baseIndex = currentBaseSelector
		? chain.findIndex(selector => {
				const selectorBase = formatRetryFallbackBaseSelector(selector);
				return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
			})
		: -1;
	if (baseIndex >= 0) {
		const candidatesAfter = chain.slice(baseIndex + 1);
		return options?.wrapAround ? [...candidatesAfter, ...chain.slice(0, baseIndex)] : candidatesAfter;
	}
	return chain.slice(1);
}
