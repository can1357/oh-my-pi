import type { Model } from "@oh-my-pi/pi-ai";
import {
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
	type ResolveCliModelResult,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import { getRetryFallbackChains } from "../../session/retry-fallback-chains";
import type { ConfiguredThinkingLevel } from "../../thinking";

export interface ResolvedSessionModelWithFallback {
	model?: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	role?: string;
	warning?: string;
	fallbackUsed?: boolean;
	fallbackFrom?: string;
	error?: string;
}

/**
 * Resolves a model selector for `/switch` using session scope or available models.
 */
export function resolveSessionModelSelector(
	selector: string,
	session: AgentSession,
	settings: Settings,
): ResolveCliModelResult {
	const scoped = session.scopedModels.map(entry => entry.model);
	return resolveCliModel({
		cliModel: selector,
		modelRegistry: session.modelRegistry,
		availableModels: scoped.length > 0 ? scoped : undefined,
		settings,
		preferences: getModelMatchPreferences(settings),
	});
}

/**
 * Resolve a model for `/switch` (or interactive switch) with fallback support:
 * 1. Supports comma- or space-separated fallback sequences: e.g. `/switch opus,sonnet`
 * 2. If the primary candidate is unauthenticated, checks explicit command fallbacks
 *    or configured retry fallback chains (role, model, provider wildcard, or default).
 */
export function resolveSwitchModelWithFallback(
	rawSelector: string,
	session: AgentSession,
	settings: Settings,
): ResolvedSessionModelWithFallback {
	const trimmed = rawSelector.trim();
	if (!trimmed) {
		return { error: "No model selector specified." };
	}

	// Split by comma first if present, otherwise split by whitespace (unless it has spaces in quotes)
	const tokens = trimmed.includes(",")
		? trimmed
				.split(",")
				.map(t => t.trim())
				.filter(Boolean)
		: trimmed.split(/\s+/).filter(Boolean);

	if (tokens.length === 0) {
		return { error: "No model selector specified." };
	}

	let firstResolved: ResolveCliModelResult | undefined;

	// 1. Try explicit tokens in order
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const resolved = resolveSessionModelSelector(token, session, settings);
		if (!firstResolved && resolved.model) {
			firstResolved = resolved;
		}
		if (
			resolved.model &&
			(session.modelRegistry.hasConfiguredAuth ? session.modelRegistry.hasConfiguredAuth(resolved.model) : true)
		) {
			return {
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				role: resolved.configuredRole,
				fallbackUsed: i > 0,
				fallbackFrom: i > 0 ? tokens[0] : undefined,
				warning: resolved.warning,
			};
		}
	}

	// 2. If single token was provided, but is unauthenticated, check configured fallback chains
	if (firstResolved?.model && tokens.length === 1) {
		const primaryModel = firstResolved.model;
		const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
		const chains = getRetryFallbackChains(settings);

		const candidateKeys: string[] = [];
		if (firstResolved.configuredRole && chains[firstResolved.configuredRole]) {
			candidateKeys.push(firstResolved.configuredRole);
		}
		if (chains[primarySelector]) {
			candidateKeys.push(primarySelector);
		}
		const wildcard = `${primaryModel.provider}/*`;
		if (chains[wildcard]) {
			candidateKeys.push(wildcard);
		}
		if (chains.default) {
			candidateKeys.push("default");
		}

		for (const key of candidateKeys) {
			const chain = chains[key];
			if (!Array.isArray(chain)) continue;
			for (const fallbackCandidate of chain) {
				const fallbackResolved = resolveSessionModelSelector(fallbackCandidate, session, settings);
				if (
					fallbackResolved.model &&
					(session.modelRegistry.hasConfiguredAuth
						? session.modelRegistry.hasConfiguredAuth(fallbackResolved.model)
						: true)
				) {
					return {
						model: fallbackResolved.model,
						thinkingLevel: fallbackResolved.thinkingLevel,
						role: firstResolved.configuredRole,
						fallbackUsed: true,
						fallbackFrom: formatModelString(primaryModel),
						warning: fallbackResolved.warning ?? firstResolved.warning,
					};
				}
			}
		}
	}

	// 3. If primary resolved to a model (even without auth), return it so auth errors surface properly
	if (firstResolved?.model) {
		return {
			model: firstResolved.model,
			thinkingLevel: firstResolved.thinkingLevel,
			role: firstResolved.configuredRole,
			warning: firstResolved.warning,
		};
	}

	return { error: `Unknown model: ${tokens[0]}` };
}
