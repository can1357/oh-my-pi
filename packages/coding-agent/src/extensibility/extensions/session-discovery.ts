import * as fs from "node:fs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { EffectiveExtensionRoots } from "../../capability/types";
import type { Settings } from "../../config/settings";
import { cfgTodoBackend } from "../../tools/settings";
import type { EventBus } from "../../utils/event-bus";
import { cfgDisabledExtensions, cfgExtensions } from "../settings";
import { discoverExtensionPaths, loadExtensions } from "./loader";
import { partitionStartupExtensions, recordStartupVerdicts } from "./startup-deferral";
import type { LoadExtensionsResult } from "./types";

/** Session extension sources, independent of the session runtime. */
export interface ExtensionDiscoveryOptions {
	/** Skip ambient and configured discovery, retaining explicit paths. */
	disableExtensionDiscovery?: boolean;
	/** Explicit extension and package paths supplied by the caller. */
	additionalExtensionPaths?: string[];
	/** Effective sources for this invocation, if already resolved. */
	extensionRoots?: () => EffectiveExtensionRoots;
	/** Include ambient hooks (default true). */
	includeAmbientHooks?: boolean;
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}. Subagents reuse the
 * parent's scan but bind their own ExtensionAPI (cwd, event bus, runtime).
 */
export async function discoverSessionExtensionPaths(
	options: ExtensionDiscoveryOptions,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	const roots = options.extensionRoots?.();
	const explicit = roots?.explicit ?? options.additionalExtensionPaths ?? [];
	const explicitOnly = roots ? roots.mode === "explicit-only" : options.disableExtensionDiscovery;
	const configuredPaths = explicitOnly
		? [...explicit]
		: [...explicit, ...(roots?.configured ?? cfgExtensions.get(settings))];
	const disabledExtensionIds = explicitOnly ? undefined : cfgDisabledExtensions.get(settings);
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, {
		ambient: !explicitOnly,
		includeAmbientHooks: options.includeAmbientHooks,
	});
}

/**
 * Load the discovered/configured extensions for a session, except the inline
 * factories appended by `createAgentSession`. The CLI resolves flags and
 * classifies `@file` arguments before creating a session, then reuses these
 * instances via the SDK's `preloadedExtensions` option. With `deferStartupSafe`,
 * sources with a current startup-safe verdict are returned as `deferredPaths`
 * instead, for the SDK's `deferredExtensionPaths` option.
 */
export async function loadSessionExtensions(
	options: ExtensionDiscoveryOptions,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
	loadOptions: { deferStartupSafe?: boolean } = {},
): Promise<LoadExtensionsResult & { deferredPaths: string[] }> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings);
	const storage = settings.getStorage();
	const { eager, deferred } =
		loadOptions.deferStartupSafe && storage
			? await partitionStartupExtensions(storage, paths, cwd, cfgTodoBackend.get(settings))
			: { eager: paths, deferred: [] };
	const result = await logger.time("loadExtensions", loadExtensions, eager, cwd, eventBus);
	if (storage) await recordStartupVerdicts(storage, result.extensions);
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
	}
	return { ...result, deferredPaths: deferred };
}

function requireTrustedModulePath(filePath: string, canonicalize: boolean): string {
	let resolvedPath = filePath;
	let stat: fs.Stats;
	try {
		if (canonicalize) resolvedPath = fs.realpathSync.native(filePath);
		stat = fs.statSync(resolvedPath);
	} catch {
		throw new Error(`Trusted extension must be an existing module file: ${filePath}`);
	}
	if (!stat.isFile()) throw new Error(`Trusted extension must be a module file, not a directory: ${filePath}`);
	return resolvedPath;
}

/** Canonicalize the CLI's exact trusted-module allowlist. */
export function resolveTrustedExtensionPaths(paths: readonly string[]): string[] {
	return paths.map(filePath => requireTrustedModulePath(filePath, true));
}

/** Bind only the trusted files, never scanning sibling packages or hooks. */
export async function loadTrustedSessionExtensions(
	options: Pick<ExtensionDiscoveryOptions, "additionalExtensionPaths">,
	cwd: string,
	eventBus: EventBus,
): Promise<LoadExtensionsResult> {
	const paths = options.additionalExtensionPaths ?? [];
	// Recheck at use: a canonical file path becoming a directory must not
	// cause Bun to import that directory's index implicitly.
	for (const filePath of paths) requireTrustedModulePath(filePath, false);
	return loadExtensions(paths, cwd, eventBus);
}
