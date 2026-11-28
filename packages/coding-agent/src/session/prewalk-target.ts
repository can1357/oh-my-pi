import type { ModelRegistry } from "../config/model-registry";
import { type ModelMatchPreferences, type ResolveCliModelResult, resolveCliModel } from "../config/model-resolver";
import { parseModelString } from "../config/model-selector";
import type { Prewalk } from "./agent-session";

/** Resolve prewalk with the same ordering before and after extension registration. */
export async function resolvePrewalkTarget(
	patterns: readonly string[],
	target: string,
	modelRegistry: ModelRegistry,
	preferences: ModelMatchPreferences,
	disabledProviders: ReadonlySet<string>,
	{
		deferUnregistered = false,
		beforeRefresh,
	}: { deferUnregistered?: boolean; beforeRefresh?: () => Promise<void> } = {},
): Promise<{ prewalk?: Prewalk; warnings: string[]; deferred: boolean }> {
	let refreshedProviders: Set<string> | undefined;
	const resolveCandidate = (pattern: string) => resolveCliModel({ cliModel: pattern, modelRegistry, preferences });
	let authenticated: ResolveCliModelResult | undefined;
	let firstUnauthenticated: ResolveCliModelResult | undefined;
	let lastResolution: ResolveCliModelResult | undefined;
	let deferred = false;
	let disabledProvider: string | undefined;

	// Each provider-qualified candidate gets its scoped discovery opportunity
	// before advancing to the next candidate in the configured role chain.
	for (const pattern of patterns) {
		disabledProvider = undefined;
		let candidate = resolveCandidate(pattern);
		lastResolution = candidate;
		if (candidate.model && disabledProviders.has(candidate.model.provider)) {
			disabledProvider = candidate.model.provider;
			continue;
		}
		if (candidate.model && modelRegistry.hasConfiguredAuth(candidate.model)) {
			authenticated = candidate;
			break;
		}
		if (candidate.model) {
			firstUnauthenticated ??= candidate;
			continue;
		}

		const requestedProvider = parseModelString(pattern)?.provider.toLowerCase();
		if (requestedProvider && disabledProviders.has(requestedProvider)) {
			disabledProvider = requestedProvider;
			continue;
		}
		if (!requestedProvider) {
			if (deferUnregistered) deferred = true;
			continue;
		}
		if (refreshedProviders?.has(requestedProvider)) continue;
		const provider = modelRegistry.getDiscoveryProviderId(requestedProvider);
		if (!provider) {
			if (deferUnregistered) deferred = true;
			continue;
		}

		(refreshedProviders ??= new Set()).add(requestedProvider);
		await beforeRefresh?.();
		await modelRegistry.refreshDiscoverableProviders([provider], "online-if-uncached");
		candidate = resolveCandidate(pattern);
		lastResolution = candidate;
		if (candidate.model && disabledProviders.has(candidate.model.provider)) {
			disabledProvider = candidate.model.provider;
			continue;
		}
		if (candidate.model && modelRegistry.hasConfiguredAuth(candidate.model)) {
			authenticated = candidate;
			break;
		}
		if (candidate.model) firstUnauthenticated ??= candidate;
	}

	if (deferred) return { warnings: [], deferred: true };
	const resolved = authenticated ?? firstUnauthenticated ?? lastResolution ?? resolveCandidate(patterns[0] ?? target);
	const warnings = resolved.warning ? [resolved.warning] : [];
	if (resolved.error || !resolved.model) {
		warnings.push(
			disabledProvider
				? `prewalk disabled — provider "${disabledProvider}" is disabled`
				: `prewalk disabled — ${resolved.error ?? `model "${target}" not found`}`,
		);
	} else if (disabledProviders.has(resolved.model.provider)) {
		warnings.push(`prewalk disabled — provider "${resolved.model.provider}" is disabled`);
	} else if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
		warnings.push(`prewalk disabled — no API key for ${resolved.model.provider}/${resolved.model.id}`);
	} else {
		return { prewalk: { target: resolved.model, thinkingLevel: resolved.thinkingLevel }, warnings, deferred: false };
	}
	return { warnings, deferred: false };
}
