/**
 * Core types for the capability-based config discovery system.
 *
 * This architecture inverts control: instead of callers knowing about paths like
 * `.claude`, `.codex`, `.gemini`, they simply ask for `load("mcps")` and get back
 * a unified array of MCP servers.
 */

/**
 * Context passed to every provider loader.
 */
export interface LoadContext {
	/** Current working directory (project root) */
	cwd: string;
	/** User home directory */
	home: string;
	/** Filesystem helpers (cached) */
	fs: {
		exists(path: string): boolean;
		isDir(path: string): boolean;
		isFile(path: string): boolean;
		readFile(path: string): string | null;
		readDir(path: string): string[];
		/** Walk up from cwd looking for a file/dir, returns first match */
		walkUp(name: string, opts?: { file?: boolean; dir?: boolean }): string | null;
	};
}

/**
 * Result from a provider's load function.
 */
export interface LoadResult<T> {
	items: T[];
	/** Warnings encountered during loading (parse errors, etc.) */
	warnings?: string[];
}

/**
 * A provider that can load items for a capability.
 */
export interface Provider<T> {
	/** Unique provider ID (e.g., "claude", "omp", "mcp-json", "agents-md") */
	id: string;

	/** Human-readable name for UI display (e.g., "Claude Code", "OpenAI Codex") */
	displayName: string;

	/** Short description for settings UI (e.g., "Load config from ~/.claude and .claude/") */
	description: string;

	/**
	 * Priority (higher = checked first, wins on conflicts).
	 * Suggested ranges:
	 *   100+ : Primary providers (omp, pi)
	 *   50-99: Tool-specific providers (claude, codex, gemini)
	 *   1-49 : Shared standards (mcp-json, agents-md)
	 */
	priority: number;

	/**
	 * Load items for this capability.
	 * Returns items in provider's preferred order (usually project before user).
	 */
	load(ctx: LoadContext): LoadResult<T> | Promise<LoadResult<T>>;
}

/**
 * Options for loading a capability.
 */
export interface LoadOptions {
	/** Only use these providers (by ID). Default: all registered */
	providers?: string[];
	/** Exclude these providers (by ID). Default: none */
	excludeProviders?: string[];
	/** Custom cwd. Default: process.cwd() */
	cwd?: string;
	/** Include items even if they fail validation. Default: false */
	includeInvalid?: boolean;
}

/**
 * Source metadata attached to every loaded item.
 */
export interface SourceMeta {
	/** Provider ID that loaded this item */
	provider: string;
	/** Provider display name (for UI) */
	providerName: string;
	/** Absolute path to the source file */
	path: string;
	/** Whether this came from user-level, project-level, or native config */
	level: "user" | "project" | "native";
}

/**
 * Merged result from loading a capability across all providers.
 */
export interface CapabilityResult<T> {
	/** Deduplicated items in priority order */
	items: Array<T & { _source: SourceMeta }>;
	/** All items including shadowed duplicates (for diagnostics) */
	all: Array<T & { _source: SourceMeta; _shadowed?: boolean }>;
	/** Warnings from all providers */
	warnings: string[];
	/** Which providers contributed items (IDs) */
	providers: string[];
}

/**
 * Definition of a capability.
 */
export interface Capability<T> {
	/** Capability ID (e.g., "mcps", "skills", "context-files") */
	id: string;

	/** Human-readable name for UI display (e.g., "MCP Servers", "Skills") */
	displayName: string;

	/** Short description for settings/status UI */
	description: string;

	/**
	 * Extract a unique key from an item for deduplication.
	 * Items with the same key: first one wins (highest priority provider).
	 * Return undefined to never deduplicate (all items kept).
	 */
	key(item: T): string | undefined;

	/**
	 * Optional validation. Return error message if invalid, undefined if valid.
	 */
	validate?(item: T): string | undefined;

	/** Registered providers, sorted by priority (highest first) */
	providers: Provider<T>[];
}

/**
 * Metadata about a capability (for introspection/UI).
 */
export interface CapabilityInfo {
	id: string;
	displayName: string;
	description: string;
	providers: Array<{
		id: string;
		displayName: string;
		description: string;
		priority: number;
		enabled: boolean;
	}>;
}

/**
 * Metadata about a provider (for introspection/UI).
 */
export interface ProviderInfo {
	id: string;
	displayName: string;
	description: string;
	priority: number;
	/** Which capabilities this provider is registered for */
	capabilities: string[];
	/** Whether this provider is currently enabled */
	enabled: boolean;
}
