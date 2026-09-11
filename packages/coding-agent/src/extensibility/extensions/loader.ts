/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	ImageContent,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	TextContent,
	TSchema,
} from "@oh-my-pi/pi-ai";
import { isBuiltinComposerStyle, type KeyId } from "@oh-my-pi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import * as PiCodingAgent from "../../index";
import type { CustomMessagePayload } from "../../session/messages";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { EventBus } from "../../utils/event-bus";
import * as TypeBox from "../legacy-typebox";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";

import { resolvePath, withHostGuard } from "../utils";
import type {
	AssistantThinkingRenderer,
	ComposerShapeDefinition,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	PreparedExtension,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
	ToolInfo,
} from "./types";

installLegacyPiSpecifierShim();

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];

	registerProvider(name: string, config: ProviderConfig, sourceId: string): void {
		this.pendingProviderRegistrations.push({ name, config, sourceId });
	}

	unregisterProvider(name: string): void {
		const remaining = this.pendingProviderRegistrations.filter(registration => registration.name !== name);
		this.pendingProviderRegistrations.splice(0, this.pendingProviderRegistrations.length, ...remaining);
	}

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): ToolInfo[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getServiceTiers(): ServiceTierByFamily {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setServiceTier(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
class ConcreteExtensionAPI implements ExtensionAPI, IExtensionRuntime {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly arktype = type;
	readonly zod = zod;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: Array<{
		name: string;
		config: ProviderConfig;
		sourceId: string;
	}> = [];

	constructor(
		public readonly pi: typeof PiCodingAgent,
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		public readonly events: EventBus,
	) {}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		const registered = {
			definition: tool,
			extensionPath: this.extension.path,
		};
		this.extension.tools.set(tool.name, registered);
		for (const listener of this.extension.toolRegistrationListeners ?? []) listener(tool.name);
	}

	registerFileWriteFallback(handler: FileWriteFallbackHandler): void {
		this.extension.fileWriteFallbackHandlers.push(handler);
	}

	registerFileDeleteFallback(handler: FileDeleteFallbackHandler): void {
		this.extension.fileDeleteFallbackHandlers.push(handler);
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.extension.commands.set(name, { name, ...options });
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.runtime.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		this.extension.assistantThinkingRenderers.push(renderer);
	}

	registerComposerShape(definition: ComposerShapeDefinition): void {
		const id = definition.style.id;
		if (id.length === 0 || id !== id.trim()) {
			throw new TypeError("Composer shape id must be a non-empty trimmed string");
		}
		if (definition.label.trim().length === 0) {
			throw new TypeError(`Composer shape "${id}" must have a label`);
		}
		if (isBuiltinComposerStyle(id)) {
			throw new Error(`Cannot replace built-in composer shape "${id}"`);
		}
		this.extension.composerShapes.set(id, definition);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" | "aside" },
	): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): ToolInfo[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getServiceTiers(): Readonly<ServiceTierByFamily> {
		return { ...this.runtime.getServiceTiers() };
	}

	setServiceTier(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (!isServiceTierFamily(family) || (tier !== undefined && !isServiceTierForFamily(family, tier))) {
			throw new TypeError(`Invalid service tier "${String(tier)}" for family "${String(family)}"`);
		}
		this.runtime.setServiceTier(family, tier);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		this.runtime.registerProvider(name, config, this.extension.path);
	}

	unregisterProvider(name: string): void {
		this.runtime.unregisterProvider(name, this.extension.path);
	}
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		toolRegistrationListeners: new Set(),
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * Runs an extension factory with provider registration rollback on failure.
 * Restores the complete registration queue when the factory throws because an
 * extension may unregister entries queued by an earlier extension.
 */
async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	runtime: IExtensionRuntime,
): Promise<void> {
	const providerRegistrationCheckpoint = [...runtime.pendingProviderRegistrations];

	try {
		await factory(api);
	} catch (error) {
		runtime.pendingProviderRegistrations.splice(
			0,
			runtime.pendingProviderRegistrations.length,
			...providerRegistrationCheckpoint,
		);
		throw error;
	}
}

async function importExtensionModule(extensionPath: string, cwd: string): Promise<PreparedExtension> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		const module = (await withHostGuard(() => loadLegacyPiModule(resolvedPath))) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				path: extensionPath,
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		return { path: extensionPath, factory, resolvedPath, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { path: extensionPath, factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

async function bindExtension(
	extensionPath: string,
	imported: PreparedExtension,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	try {
		const extension = createExtension(extensionPath, imported.resolvedPath);
		const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus);
		await withHostGuard(() => runExtensionFactory(factory, api, runtime));

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
): Promise<Extension> {
	const extension = createExtension(name, name);
	const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus);
	await runExtensionFactory(factory, api, runtime);
	return extension;
}

/**
 * Load extensions from paths.
 *
 * Module import (the dominant cold-start cost — file I/O plus module
 * evaluation) runs concurrently across extensions; factory binding then runs
 * sequentially in the original path order, so registration semantics
 * (last-wins collisions, shared runtime flag defaults) stay deterministic.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const preparedExtensions = await Promise.all(paths.map(extPath => importExtensionModule(extPath, cwd)));
	return bindPreparedExtensions(preparedExtensions, cwd, eventBus);
}

/** Bind previously imported extension factories to a fresh session runtime. */
export async function bindPreparedExtensions(
	preparedExtensions: readonly PreparedExtension[],
	cwd: string,
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = new ExtensionRuntime();

	for (const prepared of preparedExtensions) {
		const { extension, error } = await bindExtension(prepared.path, prepared, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: prepared.path, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
		preparedExtensions: [...preparedExtensions],
	};
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
}

async function readExtensionManifest(packageJsonPath: string): Promise<ExtensionManifest | null> {
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as { omp?: ExtensionManifest; pi?: ExtensionManifest };
		const manifest = pkg.omp ?? pkg.pi;
		if (manifest && typeof manifest === "object") {
			return manifest;
		}
		return null;
	} catch (error) {
		if (isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM")) {
			return null;
		}
		logger.warn("Failed to read extension manifest", { path: packageJsonPath, error: String(error) });
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 */
async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = path.join(dir, "package.json");
	const manifest = await readExtensionManifest(packageJsonPath);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = path.resolve(dir, extPath);
			try {
				await fs.stat(resolvedExtPath);
				entries.push(resolvedExtPath);
			} catch (err) {
				if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) continue;
				throw err;
			}
		}
		if (entries.length > 0) {
			return entries;
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	try {
		await fs.stat(indexTs);
		return [indexTs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
async function discoverExtensionsInDir(dir: string): Promise<string[]> {
	const discovered: string[] = [];

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = await resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	let entries: fs1.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to discover extensions in directory", { path: dir, error: String(err) });
		return [];
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);

		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}

		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const resolved = await resolveExtensionEntries(entryPath);
			if (resolved) {
				discovered.push(...resolved);
			}
		}
	}

	return discovered;
}
async function discoverHooksInPackageRoot(root: string): Promise<string[]> {
	const hooks: string[] = [];
	for (const hookType of ["pre", "post"]) {
		const hookDir = path.join(root, "hooks", hookType);
		let entries: fs1.Dirent[];
		try {
			entries = await fs.readdir(hookDir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || isEacces(err) || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EPERM")) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				hooks.push(path.join(hookDir, entry.name));
			}
		}
	}
	return hooks;
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.omp`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * The root session imports these paths once and forwards prepared factories to
 * subagents. Each child rebinds fresh Extension instances to its OWN
 * ExtensionAPI (cwd, eventBus, runtime) without re-evaluating the module graph.
 */
export interface DiscoverExtensionPathOptions {
	/** Include ambient native extensions, hooks, and installed plugins. */
	ambient?: boolean;
	/** Include ambient hook factories. Disable for read-only catalog commands. */
	includeAmbientHooks?: boolean;
}

export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<string[]> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds ? { cwd, disabledExtensions: disabledExtensionIds } : { cwd };

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	const addPath = (extPath: string): void => {
		const resolved = path.resolve(extPath);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPaths.push(extPath);
		}
	};

	const addPaths = (paths: string[]) => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			addPath(extPath);
		}
	};

	const ambient = options.ambient !== false;
	if (ambient) {
		// 1. Discover extension modules via capability API (native .omp/.pi only).
		// Scope the load to the native provider — the extension-module capability
		// also has claude/codex/gemini/opencode providers, and their items were
		// discarded here anyway (see #4198). The provider filter skips the walk
		// entirely instead of running four foreign directory scans and dropping
		// the results.
		const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
			...loadOptions,
			providers: ["native"],
		});
		for (const ext of discovered.items) {
			addPath(ext.path);
		}
	}

	// 2. Discover JS/TS hook factories and bind them through the extension
	// runner, which owns the current runtime event bus. Non-ambient discovery
	// scans only this invocation's configured package roots; it must not consult
	// settings, installed packages, or process-global CLI injection state.
	if (ambient) {
		if (options.includeAmbientHooks !== false) {
			const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
			for (const hookPath of hooks.items
				.map(hook => hook.path)
				.filter(hookPath => isExtensionFile(path.basename(hookPath)))) {
				addPath(hookPath);
			}
		}
	} else {
		for (const configuredPath of configuredPaths) {
			addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)));
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		addPaths(await getAllPluginExtensionPaths(cwd));
	}

	// 4. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			const entries = await resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}

			const discovered = await discoverExtensionsInDir(resolved);
			if (discovered.length > 0) {
				addPaths(discovered);
			}
			continue;
		}

		addPath(resolved);
	}

	return allPaths;
}

/**
 * Discover and load extensions from standard locations. Composed of
 * {@link discoverExtensionPaths} (FS scan) + {@link loadExtensions}
 * (per-session binding).
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(paths, cwd, eventBus);
}
