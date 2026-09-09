/**
 * Shared plumbing for the benchmark-style CLI commands (`omp bench`, `omp if-bench`).
 *
 * Owns the three pieces every benchmark command needs before it can talk to a
 * provider: the auth/settings/model-registry runtime, selector → model
 * resolution (including the credential fallback that keeps a bare fuzzy id from
 * landing on an unauthenticated provider), and the injectable `streamSimple`
 * signature tests substitute for a synthetic stream.
 */
import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { buildModelProviderPriorityRank } from "@oh-my-pi/pi-catalog/identity";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, getModelMatchPreferences, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { concreteThinkingLevel, resolveThinkingLevelForModel } from "../thinking";

/** Injection point for the provider call; tests pass a synthetic event stream. */
export type StreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Model catalog + credential surface a benchmark command depends on. */
export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	hasConfiguredAuth?(model: Model<Api>): boolean;
}

/** Live registry plus the settings and teardown hook backing it. */
export interface BenchRuntime {
	modelRegistry: BenchModelRegistry;
	settings?: Settings;
	close?: () => void;
}

/** One resolved benchmark subject: the selector the user typed and what it became. */
export interface BenchTarget {
	selector: string;
	model: Model<Api>;
	thinking: ResolvedThinkingLevel | undefined;
}

/** Open the auth vault, settings, and model registry for a benchmark run. */
export async function createDefaultBenchRuntime(): Promise<BenchRuntime> {
	const authStorage = await discoverAuthStorage();
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(authStorage);
		await modelRegistry.hydrateCredentialScopedModelCaches();
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		return {
			modelRegistry,
			settings,
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

/** Highest-priority provider variant: native/OAuth transports outrank mirrors. */
function pickHighestPriorityProvider(models: Model<Api>[], providerOrder?: readonly string[]): Model<Api> | undefined {
	if (models.length <= 1) return models[0];
	const priority = buildModelProviderPriorityRank(providerOrder);
	return [...models].sort((a, b) => {
		const aRank = priority.get(a.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const bRank = priority.get(b.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		return aRank - bRank;
	})[0];
}

/**
 * Benchmarks resolve selectors against the entire catalog (credentials are
 * ignored), so an ambiguous id shared by several providers can land on one the
 * user never authenticated. For non-pinned selectors, redirect to an equivalent
 * model under a provider with configured auth. An explicit `provider/id`
 * selector is honored verbatim — even unauthenticated — so forced benchmarking
 * keeps working.
 */
function resolveAuthenticatedAlternative(
	selector: string,
	model: Model<Api>,
	modelRegistry: BenchModelRegistry,
	providerOrder?: readonly string[],
): Model<Api> | undefined {
	if (!modelRegistry.hasConfiguredAuth) return undefined;
	// A pinned `provider/...` selector is authoritative; never redirect off it.
	if (selector.trim().toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) return undefined;
	if (modelRegistry.hasConfiguredAuth(model)) return undefined;

	const seen = new Set<string>();
	const authenticated: Model<Api>[] = [];
	const consider = (candidate: Model<Api>): void => {
		const key = `${candidate.provider}/${candidate.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (modelRegistry.hasConfiguredAuth?.(candidate)) authenticated.push(candidate);
	};
	// Same-id fallback for equivalent entries under providers with configured auth.
	for (const candidate of modelRegistry.getAll()) {
		if (candidate.id === model.id) consider(candidate);
	}
	return pickHighestPriorityProvider(authenticated, providerOrder);
}

/**
 * Resolve every selector to a concrete model + thinking level, warning on
 * stderr when a selector was redirected to an authenticated provider.
 *
 * @throws when any selector cannot be resolved; the message lists all failures.
 */
export function resolveBenchTargets(
	selectors: string[],
	modelRegistry: BenchModelRegistry,
	settings: Settings | undefined,
	writeStderr: (text: string) => void,
): BenchTarget[] {
	const preferences = getModelMatchPreferences(settings);
	const resolved: BenchTarget[] = [];
	const errors: string[] = [];
	for (const selector of selectors) {
		// Benchmarks intentionally resolve against the full catalog first, then
		// apply the exact-id credential fallback below. Using the CLI resolver's
		// authenticated default here would silently redirect non-equivalent bare
		// ids and suppress the warning for equivalent cross-provider models.
		const result = resolveCliModel({
			cliModel: selector,
			modelRegistry,
			availableModels: modelRegistry.getAll(),
			settings,
			preferences,
		});
		if (result.error) {
			errors.push(`${selector}: ${result.error}`);
			continue;
		}
		if (!result.model) {
			errors.push(`${selector}: model not found`);
			continue;
		}
		if (result.warning) writeStderr(`${chalk.yellow(`Warning: ${result.warning}`)}\n`);
		let model = result.model;
		const authSelector = result.configuredPatterns?.[result.configuredPatternIndex ?? 0] ?? selector;
		const authenticated = resolveAuthenticatedAlternative(
			authSelector,
			model,
			modelRegistry,
			preferences.providerOrder,
		);
		if (authenticated) {
			writeStderr(
				`${chalk.yellow(
					`Warning: no credentials for "${model.provider}"; benchmarking ${formatModelString(authenticated)} instead. Pin "${formatModelString(model)}" to force it.`,
				)}\n`,
			);
			model = authenticated;
		}
		resolved.push({
			selector,
			model,
			thinking: resolveThinkingLevelForModel(model, concreteThinkingLevel(result.thinkingLevel)),
		});
	}
	if (errors.length > 0) {
		throw new Error(`Could not resolve ${errors.length === 1 ? "model" : "models"}:\n${errors.join("\n")}`);
	}
	return resolved;
}
