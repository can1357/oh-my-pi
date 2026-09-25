/**
 * Capability Registry
 *
 * Central registry for capabilities and providers. Provides the main API for:
 * - Defining capabilities (what we're looking for)
 * - Registering providers (where to find it)
 * - Loading items for a capability across all providers
 */
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";

import type { Settings } from "../config/settings";
import { clearCache as clearFsCache, findRepoRoot, cacheStats as fsCacheStats, invalidate as invalidateFs } from "./fs";
import type {
	Capability,
	CapabilityInfo,
	CapabilityResult,
	LoadContext,
	LoadOptions,
	Provider,
	ProviderInfo,
	SourceMeta,
} from "./types";

import { cfgDisabledExtensions } from "../extensibility/settings";
import { cfgDisabledProviders, cfgEnabledProviders } from "../config/model-settings";

// =============================================================================
// Registry State
// =============================================================================

/** Registry of all capabilities */
const capabilities = new Map<string, Capability<unknown>>();

/** Reverse index: provider ID -> capability IDs it's registered for */
const providerCapabilities = new Map<string, Set<string>>();

/** Provider display metadata (shared across capabilities) */
const providerMeta = new Map<string, { displayName: string; description: string }>();

/** Provider switches in effect while no settings instance is bound ({@link initializeWithSettings}). */
let unboundDisabledProviders = new Set<string>();
let unboundEnabledProviders = new Set<string>();

/** `disabledProviders` / `enabledProviders` as sets, memoized per settings instance. */
const cfgDisabledProviderSet = cfgDisabledProviders.map(ids => new Set(ids));
const cfgEnabledProviderSet = cfgEnabledProviders.map(ids => new Set(ids));

/** Foreign tools whose user-level (~/...) configs are opt-in */
const FOREIGN_USER_PROVIDERS: Record<string, true> = {
	cursor: true,
	codex: true,
	claude: true,
	"claude-plugins": true,
	gemini: true,
	opencode: true,
	windsurf: true,
	github: true,
};

/** Outstanding {@link initializeWithSettings} holds, oldest first; the newest one is bound. */
const settingsHolds: { settings: Settings }[] = [];

/** Settings instance provider switches are read from and persisted to (the newest hold), if any. */
function boundSettings(): Settings | undefined {
	return settingsHolds.at(-1)?.settings;
}

/** Disabled provider IDs in effect: the bound settings' live value, else the unbound set. */
function disabledProviders(): ReadonlySet<string> {
	const settings = boundSettings();
	return settings ? cfgDisabledProviderSet.get(settings) : unboundDisabledProviders;
}

/** Explicitly enabled provider IDs in effect: the bound settings' live value, else the unbound set. */
function enabledProviders(): ReadonlySet<string> {
	const settings = boundSettings();
	return settings ? cfgEnabledProviderSet.get(settings) : unboundEnabledProviders;
}

// =============================================================================
// Registration API
// =============================================================================

/**
 * Define a new capability.
 */
export function defineCapability<T>(def: Omit<Capability<T>, "providers">): Capability<T> {
	if (capabilities.has(def.id)) {
		throw new Error(`Capability "${def.id}" is already defined`);
	}
	const capability: Capability<T> = { ...def, providers: [] };
	capabilities.set(def.id, capability as Capability<unknown>);
	return capability;
}

/**
 * Register a provider for a capability.
 */
export function registerProvider<T>(capabilityId: string, provider: Provider<T>): void {
	const capability = capabilities.get(capabilityId);
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}". Define it first with defineCapability().`);
	}

	// Store provider metadata (for cross-capability display)
	if (!providerMeta.has(provider.id)) {
		providerMeta.set(provider.id, {
			displayName: provider.displayName,
			description: provider.description,
		});
	}

	// Track which capabilities this provider is registered for
	if (!providerCapabilities.has(provider.id)) {
		providerCapabilities.set(provider.id, new Set());
	}
	providerCapabilities.get(provider.id)!.add(capabilityId);

	// Insert in priority order (highest first)
	const providers = capability.providers as Provider<T>[];
	const idx = providers.findIndex(p => p.priority < provider.priority);
	if (idx === -1) {
		providers.push(provider);
	} else {
		providers.splice(idx, 0, provider);
	}
}

// =============================================================================
// Loading API
// =============================================================================

/**
 * Async loading logic shared by loadCapability().
 */
async function loadImpl<T>(
	capability: Capability<T>,
	providers: Provider<T>[],
	ctx: LoadContext,
	options: LoadOptions<T>,
): Promise<CapabilityResult<T>> {
	const allItems: Array<T & { _source: SourceMeta; _shadowed?: boolean }> = [];
	const suppressedItems = new Set<T & { _source: SourceMeta; _shadowed?: boolean }>();
	const disabledItems = new Set<T & { _source: SourceMeta; _shadowed?: boolean }>();
	const allWarnings: string[] = [];
	const contributingProviders: string[] = [];
	const settings = boundSettings();
	const disabledExtensionIds = new Set<string>(
		options.disabledExtensions ?? (settings ? cfgDisabledExtensions.get(settings) : undefined) ?? [],
	);

	const results = await Promise.all(
		providers.map(async provider => {
			try {
				const result = await logger.time(
					`capability:${capability.id}:${provider.id}`,
					provider.load.bind(provider),
					ctx,
				);
				return { provider, result };
			} catch (error) {
				logger.debug(`capability:${capability.id}:${provider.id}:error`);
				return { provider, error };
			}
		}),
	);

	for (const entry of results) {
		const { provider } = entry;
		if ("error" in entry) {
			allWarnings.push(`[${provider.displayName}] Failed to load: ${entry.error}`);
			continue;
		}

		const result = entry.result;
		if (!result) continue;

		if (result.warnings) {
			allWarnings.push(...result.warnings.map(w => `[${provider.displayName}] ${w}`));
		}

		let contributedItemCount = 0;
		for (const item of result.items) {
			const itemWithSource = item as T & { _source: SourceMeta };
			if (!itemWithSource._source) {
				allWarnings.push(`[${provider.displayName}] Item missing _source metadata, skipping`);
				continue;
			}

			const extensionId = capability.toExtensionId?.(itemWithSource);
			const isDisabled = extensionId !== undefined && disabledExtensionIds.has(extensionId);
			if (isDisabled && !options.includeDisabled) {
				continue;
			}

			if (options.filter && !options.filter(itemWithSource)) {
				continue;
			}

			if (isDisabled) {
				disabledItems.add(itemWithSource);
			}

			if (options.suppress?.(itemWithSource)) {
				// Suppressed items still claim their dedupe key below, so a
				// suppressed higher-priority item shadows same-key lower-priority
				// ones, but they never survive or equivalence-shadow survivors.
				itemWithSource._source.providerName = provider.displayName;
				const suppressed = itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean };
				suppressedItems.add(suppressed);
				allItems.push(suppressed);
				continue;
			}

			itemWithSource._source.providerName = provider.displayName;
			allItems.push(itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean });
			contributedItemCount += 1;
		}

		if (contributedItemCount > 0) {
			contributingProviders.push(provider.id);
		}
	}

	// Deduplicate by key or semantic equivalence (first wins = highest priority)
	const seen = new Set<string>();
	const deduped: Array<T & { _source: SourceMeta }> = [];
	const equivalent = capability.equivalent;

	for (const item of allItems) {
		const key = capability.key(item);

		if (disabledItems.has(item)) {
			// Disabled rows never claim their key or equivalence class, so they
			// can't shadow an enabled survivor (issue #11870). But when an
			// earlier enabled item already owns the key or an equivalent
			// identity, the disabled row is a lower-priority loser: mark it
			// shadowed so the dashboard treats it as a shadowed no-op instead of
			// an independently toggleable row.
			const keySeen = key !== undefined && seen.has(key);
			const aliasSeen =
				!keySeen &&
				equivalent !== undefined &&
				deduped.some(existing => !disabledItems.has(existing) && equivalent(existing, item));
			if (keySeen || aliasSeen) item._shadowed = true;
			if (!suppressedItems.has(item)) deduped.push(item);
			continue;
		}

		if (suppressedItems.has(item)) {
			// Claim key ownership (same-name precedence, including disabled
			// state) without surviving or equivalence-shadowing survivors.
			if (key !== undefined) seen.add(key);
			continue;
		}

		if (key === undefined) {
			deduped.push(item);
			continue;
		}

		const keySeen = seen.has(key);
		seen.add(key);
		const aliasSeen =
			!keySeen &&
			equivalent !== undefined &&
			deduped.some(existing => !disabledItems.has(existing) && equivalent(existing, item));
		if (keySeen || aliasSeen) {
			item._shadowed = true;
		} else {
			deduped.push(item);
		}
	}

	// Validate items (only non-shadowed items)
	if (capability.validate && !options.includeInvalid) {
		for (let i = deduped.length - 1; i >= 0; i--) {
			const error = capability.validate(deduped[i]);
			if (error) {
				const source = deduped[i]._source;
				allWarnings.push(
					`[${source?.providerName ?? "unknown"}] Invalid item at ${source?.path ?? "unknown"}: ${error}`,
				);
				deduped.splice(i, 1);
			}
		}
	}

	return {
		items: deduped,
		all: suppressedItems.size > 0 ? allItems.filter(item => !suppressedItems.has(item)) : allItems,
		warnings: allWarnings,
		providers: contributingProviders,
	};
}

/**
 * Filter providers based on options and disabled state.
 */
function filterProviders<T>(capability: Capability<T>, options: LoadOptions<T>): Provider<T>[] {
	const disabled = disabledProviders();
	let providers = (capability.providers as Provider<T>[]).filter(p => !disabled.has(p.id));

	if (options.providers) {
		const allowed = new Set(options.providers);
		providers = providers.filter(p => allowed.has(p.id));
	}
	if (options.excludeProviders) {
		const excluded = new Set(options.excludeProviders);
		providers = providers.filter(p => !excluded.has(p.id));
	}

	return providers;
}

/**
 * Load a capability by ID.
 */
export async function loadCapability<T>(
	capabilityId: string,
	options: LoadOptions<T> = {},
): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const cwd = options.cwd ?? getProjectDir();
	const home = os.homedir();
	const repoRoot = await findRepoRoot(cwd);
	const ctx: LoadContext = { cwd, home, repoRoot };
	if (options.providers) ctx.explicitProviders = new Set(options.providers);
	if (options.includeDisabled) ctx.includeOptOutUserSources = true;
	if (options.extensionRoots !== undefined) ctx.extensionRoots = options.extensionRoots;
	const providers = filterProviders(capability, options);

	return await loadImpl(capability, providers, ctx, options);
}

// =============================================================================
// Provider Enable/Disable API
// =============================================================================

/** Whether `providerId` is a foreign tool whose `~/` config is opt-in. */
export function isForeignUserProvider(providerId: string): boolean {
	return FOREIGN_USER_PROVIDERS[providerId] === true;
}

/**
 * Check whether a user-level (~/...) config source is enabled.
 * Native (.omp) and .agents directories are enabled by default.
 * Foreign tool directories (~/.cursor, ~/.codex, ~/.claude, etc.) are opt-in
 * via `enabledProviders`. Project-level (cwd) config is unaffected; see
 * {@link isProviderEnabled} for the whole-provider switch.
 */
export function isUserSourceEnabled(source: string, ctx?: LoadContext): boolean {
	const id = source.replace(/^\./, "");
	if (disabledProviders().has(id)) return false;
	if (FOREIGN_USER_PROVIDERS[id] !== true) return true;
	if (ctx?.explicitProviders?.has(id) || ctx?.includeOptOutUserSources) return true;
	const enabled = enabledProviders();
	if (enabled.has(id) || enabled.has("*") || enabled.has("all")) return true;
	if (id === "claude-plugins" && enabled.has("claude")) return true;
	if (id === "claude" && process.env.CLAUDE_CONFIG_DIR?.trim()) return true;
	return false;
}

/** Opt a foreign provider's `~/` config in. */
export function enableUserSource(providerId: string): void {
	setEnabledProviders([...enabledProviders(), providerId]);
}

/** Opt a foreign provider's `~/` config out (project config keeps loading). */
export function disableUserSource(providerId: string): void {
	setEnabledProviders([...enabledProviders()].filter(id => id !== providerId));
}

/**
 * Bind the capability system to `activeSettings`: provider switches are read live
 * from its `enabledProviders`/`disabledProviders` (settings UI, `set()` from any
 * caller, on-disk reloads — the next discovery pass sees them) and persisted to it.
 * Holds stack: the newest outstanding hold is bound, and releasing it (the returned
 * function) hands the binding back to the previous hold. The release is idempotent
 * and never ends another holder's hold.
 */
export function initializeWithSettings(activeSettings: Settings): () => void {
	const hold = { settings: activeSettings };
	settingsHolds.push(hold);
	return () => {
		const index = settingsHolds.indexOf(hold);
		if (index !== -1) settingsHolds.splice(index, 1);
	};
}

/**
 * Re-seed the provider switches from `activeSettings` after a settings reload.
 * A bound instance reads `enabledProviders`/`disabledProviders` live through
 * {@link disabledProviders}/{@link enabledProviders} (their derived values
 * recompute when the settings revision bumps), so only the unbound fallback
 * used before a hold is taken can still reflect the startup view.
 */
export function reconcileProviderSets(activeSettings: Settings): void {
	if (boundSettings()) return;
	unboundDisabledProviders = new Set(cfgDisabledProviders.get(activeSettings));
	unboundEnabledProviders = new Set(cfgEnabledProviders.get(activeSettings));
}

/**
 * Disable a provider globally (across all capabilities).
 */
export function disableProvider(providerId: string): void {
	setDisabledProviders([...disabledProviders(), providerId]);
}

/**
 * Enable a previously disabled provider.
 */
export function enableProvider(providerId: string): void {
	setDisabledProviders([...disabledProviders()].filter(id => id !== providerId));
}

/**
 * Check if a provider is enabled (the whole-provider switch backed by
 * `disabledProviders`). Foreign `~/` config additionally needs
 * {@link isUserSourceEnabled}.
 */
export function isProviderEnabled(providerId: string): boolean {
	return !disabledProviders().has(providerId);
}

/**
 * Get list of all disabled provider IDs.
 */
export function getDisabledProviders(): string[] {
	return Array.from(disabledProviders());
}

/**
 * Set disabled providers from a list (replaces current set), persisting to the bound settings.
 */
export function setDisabledProviders(providerIds: string[]): void {
	const settings = boundSettings();
	if (settings) cfgDisabledProviders.set(settings, [...new Set(providerIds)]);
	else unboundDisabledProviders = new Set(providerIds);
}

/**
 * Get list of all explicitly enabled provider IDs.
 */
export function getEnabledProviders(): string[] {
	return Array.from(enabledProviders());
}

/**
 * Set enabled providers from a list (replaces current set), persisting to the bound settings.
 */
export function setEnabledProviders(providerIds: string[]): void {
	const settings = boundSettings();
	if (settings) cfgEnabledProviders.set(settings, [...new Set(providerIds)]);
	else unboundEnabledProviders = new Set(providerIds);
}

// =============================================================================
// Introspection API
// =============================================================================

/**
 * Get a capability definition (for introspection).
 */
export function getCapability<T>(id: string): Capability<T> | undefined {
	return capabilities.get(id) as Capability<T> | undefined;
}

/**
 * List all registered capability IDs.
 */
export function listCapabilities(): string[] {
	return Array.from(capabilities.keys());
}

/**
 * Get capability info for UI display.
 */
export function getCapabilityInfo(capabilityId: string): CapabilityInfo | undefined {
	const capability = capabilities.get(capabilityId);
	if (!capability) return undefined;

	const disabled = disabledProviders();
	return {
		id: capability.id,
		displayName: capability.displayName,
		description: capability.description,
		providers: capability.providers.map(p => ({
			id: p.id,
			displayName: p.displayName,
			description: p.description,
			priority: p.priority,
			enabled: !disabled.has(p.id),
		})),
	};
}

/**
 * Get all capabilities info for UI display.
 */
export function getAllCapabilitiesInfo(): CapabilityInfo[] {
	return listCapabilities().map(id => getCapabilityInfo(id)!);
}

/**
 * Get provider info for UI display.
 */
export function getProviderInfo(providerId: string): ProviderInfo | undefined {
	const meta = providerMeta.get(providerId);
	const caps = providerCapabilities.get(providerId);
	if (!meta || !caps) return undefined;

	// Find priority from first capability's provider list
	let priority = 0;
	for (const capId of caps) {
		const cap = capabilities.get(capId);
		const provider = cap?.providers.find(p => p.id === providerId);
		if (provider) {
			priority = provider.priority;
			break;
		}
	}

	return {
		id: providerId,
		displayName: meta.displayName,
		description: meta.description,
		priority,
		capabilities: Array.from(caps),
		enabled: !disabledProviders().has(providerId),
	};
}

/**
 * Get all providers info for UI display (deduplicated across capabilities).
 */
export function getAllProvidersInfo(): ProviderInfo[] {
	const providers: ProviderInfo[] = [];

	for (const providerId of providerMeta.keys()) {
		const info = getProviderInfo(providerId);
		if (info) {
			providers.push(info);
		}
	}

	// Sort by priority (highest first)
	providers.sort((a, b) => b.priority - a.priority);

	return providers;
}

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Reset all caches. Call after chdir or filesystem changes.
 */
export function reset(): void {
	clearFsCache();
}

/**
 * Reset capability registry settings and provider state. Test-only.
 */
export function resetCapabilityForTests(): void {
	settingsHolds.length = 0;
	unboundDisabledProviders = new Set();
	unboundEnabledProviders = new Set();
	clearFsCache();
}

/**
 * Invalidate cache for a specific path.
 * @param filePath - Absolute or relative path to invalidate
 */
export function invalidate(filePath: string, cwd?: string): void {
	const resolved = cwd ? path.resolve(cwd, filePath) : filePath;
	invalidateFs(resolved);
}

/**
 * Get cache stats for diagnostics.
 */
export function cacheStats(): { content: number; dir: number } {
	return fsCacheStats();
}

// =============================================================================
// Re-exports
// =============================================================================

export type * from "./types";
