/**
 * Capability Registry
 *
 * Central registry for capabilities and providers. Provides the main API for:
 * - Defining capabilities (what we're looking for)
 * - Registering providers (where to find it)
 * - Loading items for a capability across all providers
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// =============================================================================
// Registry State
// =============================================================================

/** Registry of all capabilities */
const capabilities = new Map<string, Capability<unknown>>();

/** Reverse index: provider ID -> capability IDs it's registered for */
const providerCapabilities = new Map<string, Set<string>>();

/** Provider display metadata (shared across capabilities) */
const providerMeta = new Map<string, { displayName: string; description: string }>();

/** Disabled providers (by ID) */
const disabledProviders = new Set<string>();

/** Settings manager for persistence (if set) */
let settingsManager: { getDisabledProviders(): string[]; setDisabledProviders(ids: string[]): void } | null = null;

// =============================================================================
// Filesystem Cache
// =============================================================================

type StatResult = "file" | "dir" | null;

const statCache = new Map<string, StatResult>();
const contentCache = new Map<string, string | null>();
const dirCache = new Map<string, Dirent[]>();

function clearCache(): void {
	statCache.clear();
	contentCache.clear();
	dirCache.clear();
}

function createFsHelpers(cwd: string): LoadContext["fs"] {
	return {
		exists(path: string): boolean {
			const abs = resolve(cwd, path);
			if (!statCache.has(abs)) {
				try {
					const stat = statSync(abs);
					statCache.set(abs, stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null);
				} catch {
					statCache.set(abs, null);
				}
			}
			return statCache.get(abs) !== null;
		},

		isDir(path: string): boolean {
			this.exists(path);
			return statCache.get(resolve(cwd, path)) === "dir";
		},

		isFile(path: string): boolean {
			this.exists(path);
			return statCache.get(resolve(cwd, path)) === "file";
		},

		readFile(path: string): string | null {
			const abs = resolve(cwd, path);
			if (!contentCache.has(abs)) {
				try {
					contentCache.set(abs, readFileSync(abs, "utf-8"));
				} catch {
					contentCache.set(abs, null);
				}
			}
			return contentCache.get(abs) ?? null;
		},

		readDir(path: string): string[] {
			const abs = resolve(cwd, path);
			if (!this.isDir(path)) return [];
			if (!dirCache.has(abs)) {
				try {
					dirCache.set(abs, readdirSync(abs, { withFileTypes: true }));
				} catch {
					dirCache.set(abs, []);
				}
			}
			return (dirCache.get(abs) ?? []).map((e) => e.name);
		},

		walkUp(name: string, opts: { file?: boolean; dir?: boolean } = {}): string | null {
			const { file = true, dir = true } = opts;
			let current = cwd;
			while (true) {
				const candidate = join(current, name);
				if (file && this.isFile(candidate)) return candidate;
				if (dir && this.isDir(candidate)) return candidate;
				const parent = dirname(current);
				if (parent === current) return null;
				current = parent;
			}
		},
	};
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
	const idx = providers.findIndex((p) => p.priority < provider.priority);
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
 * Core loading logic shared by both load() and loadSync().
 */
function loadImpl<T>(
	capability: Capability<T>,
	providers: Provider<T>[],
	ctx: LoadContext,
	options: LoadOptions,
): CapabilityResult<T> {
	const allItems: Array<T & { _source: SourceMeta; _shadowed?: boolean }> = [];
	const allWarnings: string[] = [];
	const contributingProviders: string[] = [];

	for (const provider of providers) {
		try {
			const result = provider.load(ctx);

			if (result instanceof Promise) {
				throw new Error(
					`Provider "${provider.id}" returned a Promise. Use load() instead of loadSync() for async providers.`,
				);
			}

			if (result.warnings) {
				allWarnings.push(...result.warnings.map((w) => `[${provider.displayName}] ${w}`));
			}

			if (result.items.length > 0) {
				contributingProviders.push(provider.id);

				for (const item of result.items) {
					const itemWithSource = item as T & { _source: SourceMeta };
					if (itemWithSource._source) {
						itemWithSource._source.providerName = provider.displayName;
						allItems.push(itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean });
					} else {
						allWarnings.push(`[${provider.displayName}] Item missing _source metadata, skipping`);
					}
				}
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes("returned a Promise")) {
				throw err;
			}
			allWarnings.push(`[${provider.displayName}] Failed to load: ${err}`);
		}
	}

	// Deduplicate by key (first wins = highest priority)
	const seen = new Map<string, number>();
	const deduped: Array<T & { _source: SourceMeta }> = [];

	for (let i = 0; i < allItems.length; i++) {
		const item = allItems[i];
		const key = capability.key(item);

		if (key === undefined) {
			deduped.push(item);
		} else if (!seen.has(key)) {
			seen.set(key, i);
			deduped.push(item);
		} else {
			item._shadowed = true;
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
		all: allItems,
		warnings: allWarnings,
		providers: contributingProviders,
	};
}

/**
 * Async loading logic shared by load().
 */
async function loadImplAsync<T>(
	capability: Capability<T>,
	providers: Provider<T>[],
	ctx: LoadContext,
	options: LoadOptions,
): Promise<CapabilityResult<T>> {
	const allItems: Array<T & { _source: SourceMeta; _shadowed?: boolean }> = [];
	const allWarnings: string[] = [];
	const contributingProviders: string[] = [];

	for (const provider of providers) {
		try {
			const result = await provider.load(ctx);

			if (result.warnings) {
				allWarnings.push(...result.warnings.map((w) => `[${provider.displayName}] ${w}`));
			}

			if (result.items.length > 0) {
				contributingProviders.push(provider.id);

				for (const item of result.items) {
					const itemWithSource = item as T & { _source: SourceMeta };
					if (itemWithSource._source) {
						itemWithSource._source.providerName = provider.displayName;
						allItems.push(itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean });
					} else {
						allWarnings.push(`[${provider.displayName}] Item missing _source metadata, skipping`);
					}
				}
			}
		} catch (err) {
			allWarnings.push(`[${provider.displayName}] Failed to load: ${err}`);
		}
	}

	// Deduplicate by key (first wins = highest priority)
	const seen = new Map<string, number>();
	const deduped: Array<T & { _source: SourceMeta }> = [];

	for (let i = 0; i < allItems.length; i++) {
		const item = allItems[i];
		const key = capability.key(item);

		if (key === undefined) {
			deduped.push(item);
		} else if (!seen.has(key)) {
			seen.set(key, i);
			deduped.push(item);
		} else {
			item._shadowed = true;
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
		all: allItems,
		warnings: allWarnings,
		providers: contributingProviders,
	};
}

/**
 * Filter providers based on options and disabled state.
 */
function filterProviders<T>(capability: Capability<T>, options: LoadOptions): Provider<T>[] {
	let providers = (capability.providers as Provider<T>[]).filter((p) => !disabledProviders.has(p.id));

	if (options.providers) {
		const allowed = new Set(options.providers);
		providers = providers.filter((p) => allowed.has(p.id));
	}
	if (options.excludeProviders) {
		const excluded = new Set(options.excludeProviders);
		providers = providers.filter((p) => !excluded.has(p.id));
	}

	return providers;
}

/**
 * Load a capability by ID.
 */
export async function load<T>(capabilityId: string, options: LoadOptions = {}): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const cwd = options.cwd ?? process.cwd();
	const home = homedir();
	const ctx: LoadContext = { cwd, home, fs: createFsHelpers(cwd) };
	const providers = filterProviders(capability, options);

	return loadImplAsync(capability, providers, ctx, options);
}

/**
 * Synchronous load (for capabilities where all providers are sync).
 * Throws if any provider returns a Promise.
 */
export function loadSync<T>(capabilityId: string, options: LoadOptions = {}): CapabilityResult<T> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const cwd = options.cwd ?? process.cwd();
	const home = homedir();
	const ctx: LoadContext = { cwd, home, fs: createFsHelpers(cwd) };
	const providers = filterProviders(capability, options);

	return loadImpl(capability, providers, ctx, options);
}

// =============================================================================
// Provider Enable/Disable API
// =============================================================================

/**
 * Initialize capability system with settings manager for persistence.
 * Call this once on startup to enable persistent provider state.
 */
export function initializeWithSettings(manager: {
	getDisabledProviders(): string[];
	setDisabledProviders(ids: string[]): void;
}): void {
	settingsManager = manager;
	// Load disabled providers from settings
	const disabled = manager.getDisabledProviders();
	disabledProviders.clear();
	for (const id of disabled) {
		disabledProviders.add(id);
	}
}

/**
 * Persist current disabled providers to settings.
 */
function persistDisabledProviders(): void {
	if (settingsManager) {
		settingsManager.setDisabledProviders(Array.from(disabledProviders));
	}
}

/**
 * Disable a provider globally (across all capabilities).
 */
export function disableProvider(providerId: string): void {
	disabledProviders.add(providerId);
	persistDisabledProviders();
}

/**
 * Enable a previously disabled provider.
 */
export function enableProvider(providerId: string): void {
	disabledProviders.delete(providerId);
	persistDisabledProviders();
}

/**
 * Check if a provider is enabled.
 */
export function isProviderEnabled(providerId: string): boolean {
	return !disabledProviders.has(providerId);
}

/**
 * Get list of all disabled provider IDs.
 */
export function getDisabledProviders(): string[] {
	return Array.from(disabledProviders);
}

/**
 * Set disabled providers from a list (replaces current set).
 */
export function setDisabledProviders(providerIds: string[]): void {
	disabledProviders.clear();
	for (const id of providerIds) {
		disabledProviders.add(id);
	}
	persistDisabledProviders();
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

	return {
		id: capability.id,
		displayName: capability.displayName,
		description: capability.description,
		providers: capability.providers.map((p) => ({
			id: p.id,
			displayName: p.displayName,
			description: p.description,
			priority: p.priority,
			enabled: !disabledProviders.has(p.id),
		})),
	};
}

/**
 * Get all capabilities info for UI display.
 */
export function getAllCapabilitiesInfo(): CapabilityInfo[] {
	return listCapabilities().map((id) => getCapabilityInfo(id)!);
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
		const provider = cap?.providers.find((p) => p.id === providerId);
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
		enabled: !disabledProviders.has(providerId),
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
	clearCache();
}

/**
 * Invalidate cache for a specific path.
 * @param path - Absolute or relative path to invalidate
 * @param cwd - Working directory for resolving relative paths (defaults to process.cwd())
 */
export function invalidate(path: string, cwd?: string): void {
	const abs = resolve(cwd ?? process.cwd(), path);
	statCache.delete(abs);
	contentCache.delete(abs);
	dirCache.delete(abs);
	// Also invalidate parent for directory listings
	const parent = dirname(abs);
	if (parent !== abs) {
		statCache.delete(parent);
		dirCache.delete(parent);
	}
}

/**
 * Get cache stats for diagnostics.
 */
export function cacheStats(): { stat: number; content: number; dir: number } {
	return {
		stat: statCache.size,
		content: contentCache.size,
		dir: dirCache.size,
	};
}

// =============================================================================
// Re-exports
// =============================================================================

export type {
	Capability,
	CapabilityInfo,
	CapabilityResult,
	LoadContext,
	LoadOptions,
	LoadResult,
	Provider,
	ProviderInfo,
	SourceMeta,
} from "./types";
