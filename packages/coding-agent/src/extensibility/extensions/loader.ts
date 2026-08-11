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
import { hasFsCode, isEacces, isEnoent, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import * as PiCodingAgent from "../../index";
import { composeRemoteId, IrcBus, isValidRemoteName, isValidRemoteNamespace, remoteNamespaceOf } from "../../irc/bus";
import { AgentRegistry } from "../../registry/agent-registry";
import type { SendUserMessageOptions } from "../../session/agent-session";
import type { CustomMessagePayload } from "../../session/messages";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { isFilesystemSourcePath } from "../../tools/path-utils";
import { EventBus } from "../../utils/event-bus";
import * as TypeBox from "../legacy-typebox";
import { resolveExtensionDirectory } from "./directory-resolution";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";

import { resolvePath, withHostGuard } from "../utils";
import type { ComposerShapeDefinition } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import type {
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
	IrcApi,
	LoadExtensionsResult,
	MessageRenderer,
	PreparedExtension,
	ProviderConfig,
	RegisteredCommand,
	SourceInfo,
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

/**
 * Upstream-shaped provenance for an extension-registered tool. Consumers that
 * read `sourceInfo` off `getAllRegisteredTools()` (e.g. pi-fabric) receive an
 * absolute on-disk path: the tool's own `sourcePath` when it is filesystem-
 * absolute, otherwise the extension's resolved entry (`fallbackPath`). A tool
 * with no absolute origin at all falls back to the synthetic `<extension:name>`.
 */
export function extensionToolSourceInfo(
	definition: Pick<ToolDefinition, "name" | "sourcePath">,
	fallbackPath: string,
): SourceInfo {
	const sourcePath = definition.sourcePath;
	const path =
		sourcePath && isFilesystemSourcePath(sourcePath)
			? sourcePath
			: isFilesystemSourcePath(fallbackPath)
				? fallbackPath
				: `<extension:${definition.name}>`;
	return { path, source: "extension", scope: "temporary", origin: "top-level" };
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

	getAgentId(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * Sanitize a bridge-provided remote peer display name before it is stored on an AgentRef and later
 * interpolated into subagent system prompts (renderIrcPeerRoster). The value arrives over the
 * transport from another process, so an unsanitized name with newlines/control chars could inject
 * lines into every spawned subagent's prompt. Collapse to a bounded single line; fall back to the
 * (already isValidRemoteName-validated) bare name when nothing usable remains.
 */
const REMOTE_DISPLAY_NAME_MAX = 64;
function sanitizeRemoteDisplayName(raw: string | undefined, fallback: string): string {
	if (typeof raw !== "string") return fallback;
	let out = "";
	for (const ch of raw) {
		const code = ch.codePointAt(0) ?? 0;
		// Drop C0/C1 control chars (incl. newlines, tabs, ESC) so a hostile name can't break out of
		// its roster line; printable chars pass through and whitespace runs are collapsed below.
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
	}
	const single = out.replace(/\s+/g, " ").trim();
	if (single.length === 0) return fallback;
	return single.length > REMOTE_DISPLAY_NAME_MAX ? `${single.slice(0, REMOTE_DISPLAY_NAME_MAX - 1)}…` : single;
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
	/** The single namespace this extension load claimed via `irc.setRemoteTransport` (one per load). */
	#claimedNamespace: string | undefined;
	#ircTeardownArmed = false;
	readonly irc: IrcApi = {
		deliverInbound: (msg, opts) => {
			// A load may only inject inbound from the namespace it claimed via setRemoteTransport, so a
			// bridge for namespace A cannot forge `@B/x` and have B's wait/auto-reply route a reply back
			// out through B's transport (#7401 review). Enforced per-load, above the shared-registry bus.
			if (this.#claimedNamespace === undefined || remoteNamespaceOf(msg.from) !== this.#claimedNamespace) {
				return Promise.resolve({
					receipt: {
						to: msg.to,
						outcome: "failed" as const,
						error: `Inbound sender "${msg.from}" is not in this load's claimed IRC namespace "@${this.#claimedNamespace ?? "(none)"}/".`,
					},
					id: Snowflake.next(),
				});
			}
			return IrcBus.forRegistry(this.registry).deliverInbound(msg, opts);
		},
		setRemoteTransport: (namespace, transport) => {
			if (!isValidRemoteNamespace(namespace)) {
				throw new Error(
					`Invalid IRC namespace ${JSON.stringify(namespace)} (allowed: letters, digits, ".", "_", "-").`,
				);
			}
			if (this.#claimedNamespace !== undefined && this.#claimedNamespace !== namespace) {
				throw new Error(
					`This extension already claimed IRC namespace "${this.#claimedNamespace}"; an extension load owns a single namespace.`,
				);
			}
			const bus = IrcBus.forRegistry(this.registry);
			if (transport === undefined) {
				// Clearing this load's transport (reconnect / teardown). A clear of a namespace this load
				// never claimed stays a hard error, but a clear when the claim is already gone — the
				// session_shutdown safety net released it first, and those handlers run concurrently
				// (ExtensionRunner awaits them via Promise.all) — is a no-op, so a bridge's own teardown
				// clear never races the net (#7401 review).
				if (this.#claimedNamespace !== namespace) {
					throw new Error(
						`IRC namespace ${JSON.stringify(namespace)} is not claimed; install a transport before clearing.`,
					);
				}
				if (bus.namespaceOwner(namespace) === this.ownerToken) {
					bus.setRemoteTransport(namespace, undefined, this.ownerToken);
				}
				return;
			}
			bus.setRemoteTransport(namespace, transport, this.ownerToken);
			this.#claimedNamespace = namespace;
			this.#armIrcTeardown();
		},
		registerRemotePeer: peer => {
			// A remote peer lives at `@<claimedNamespace>/<name>`; a namespace must be claimed first (via
			// setRemoteTransport). The composed id is disjoint from local ids (`@` reserved) and from other
			// extensions' peers (namespaces are globally unique), so registration is collision-free — no
			// reserved-id or clobber guards — and is attributed to this load's ownerToken for rollback.
			const namespace = this.#claimedNamespace;
			if (namespace === undefined || !isValidRemoteName(peer.name)) return undefined;
			const id = composeRemoteId(namespace, peer.name);
			this.registry.register({
				id,
				displayName: sanitizeRemoteDisplayName(peer.displayName, peer.name),
				kind: "remote",
				session: null,
				status: peer.status,
				ownerToken: this.ownerToken,
			});
			return id;
		},
		unregisterRemotePeer: idOrName => {
			// Accept the composed `@ns/name` id or a bare name (composed against the claimed namespace).
			let id = idOrName;
			const namespace = this.#claimedNamespace;
			if (remoteNamespaceOf(idOrName) === undefined && namespace !== undefined && isValidRemoteName(idOrName)) {
				id = composeRemoteId(namespace, idOrName);
			}
			const registry = this.registry;
			const ref = registry.get(id);
			// Ownership-checked: a load may retract only the remote proxies it registered.
			if (ref?.kind !== "remote" || ref.ownerToken !== this.ownerToken) return false;
			return registry.unregister(id);
		},
	};
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
		/** Per-load owner token stamped on refs this load registers (see {@link AgentRef.ownerToken}). */
		private readonly ownerToken: string,
		/**
		 * The session's agent registry (default AgentRegistry.global()). Remote-peer proxies this load
		 * registers - and their teardown - target THIS registry, so an SDK embedder with a custom
		 * per-session registry lists/receives its own peers instead of leaking into the global one.
		 */
		private readonly registry: AgentRegistry,
	) {}

	/**
	 * Arm the one-shot IRC safety-net teardown on the FIRST namespace claim: release this load's
	 * process-global namespace claims, transports, and `remote` refs on `session_shutdown`, so a claim
	 * never outlives its load in a long-lived (SDK/ACP) host. Registered at claim time (not deferred to
	 * after the factory) so a delayed claim from a runtime handler — e.g. a bridge calling
	 * setRemoteTransport from `session_start` once it has `pi.getAgentId()` — is covered too (#7401
	 * review). Ordering among shutdown handlers is irrelevant: the release and the extension's own
	 * transport clear are each idempotent, and session_shutdown handlers run concurrently anyway.
	 */
	#armIrcTeardown(): void {
		if (this.#ircTeardownArmed) return;
		this.#ircTeardownArmed = true;
		this.on("session_shutdown", async () => releaseExtensionIrc(this.ownerToken, this.registry));
	}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		const registered = {
			definition: tool,
			extensionPath: this.extension.path,
			sourceInfo: extensionToolSourceInfo(tool, this.extension.resolvedPath),
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

	sendUserMessage(content: string | (TextContent | ImageContent)[], options?: SendUserMessageOptions): void {
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

	getAgentId(): string | undefined {
		return this.runtime.getAgentId();
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
 * Release the IRC resources a single extension load owns, keyed by its `ownerToken`: drop its
 * namespace claims + transports on the process-global bus (freeing the namespaces for re-claim) and
 * unregister from `registry` (the load's session registry) every `remote` proxy ref it registered.
 * Owner-scoped + idempotent, so sibling loads are untouched. Runs on BOTH factory-failure rollback and
 * clean session_shutdown teardown, so a claim never outlives its load.
 */
function releaseExtensionIrc(ownerToken: string, registry: AgentRegistry): void {
	IrcBus.forRegistry(registry).releaseTransportsForOwner(ownerToken);
	for (const ref of registry.list()) {
		if (ref.ownerToken === ownerToken) registry.unregister(ref.id);
	}
}

/**
 * Runs an extension factory with rollback of process-global state the factory may have mutated
 * before throwing. Restores the complete provider-registration queue (an extension may unregister
 * entries queued by an earlier extension), this load's {@link IrcBus} remote transport, and any `remote`
 * proxy refs the factory registered via `pi.irc.registerRemotePeer` (attributed by the per-load
 * `ownerToken`). So a factory that installs a transport / seeds remote peers and then throws leaves
 * no stale transport and no orphaned proxies — and, because the token is per LOAD not per source
 * path, a failed load never retracts a sibling load's peers (can1357/oh-my-pi#7401 review).
 */
async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	runtime: IExtensionRuntime,
	ownerToken: string,
	registry: AgentRegistry,
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
		// Release this load's IRC state (namespace claims + transports + `remote` refs), owner-scoped so
		// sibling loads are untouched. Identical to the clean session_shutdown teardown (#armIrcTeardown).
		releaseExtensionIrc(ownerToken, registry);
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
	registry: AgentRegistry,
): Promise<{ extension: Extension | null; error: string | null }> {
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	try {
		const extension = createExtension(extensionPath, imported.resolvedPath);
		const ownerToken = `${extension.path}:${crypto.randomUUID()}`;
		const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus, ownerToken, registry);
		await withHostGuard(() => runExtensionFactory(factory, api, runtime, ownerToken, registry));

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
	registry: AgentRegistry = AgentRegistry.global(),
): Promise<Extension> {
	const extension = createExtension(name, name);
	const ownerToken = `${extension.path}:${crypto.randomUUID()}`;
	const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus, ownerToken, registry);
	await runExtensionFactory(factory, api, runtime, ownerToken, registry);
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
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	registry: AgentRegistry = AgentRegistry.global(),
): Promise<LoadExtensionsResult> {
	const preparedExtensions = await Promise.all(paths.map(extPath => importExtensionModule(extPath, cwd)));
	return bindPreparedExtensions(preparedExtensions, cwd, eventBus, registry);
}

/** Bind previously imported extension factories to a fresh session runtime. */
export async function bindPreparedExtensions(
	preparedExtensions: readonly PreparedExtension[],
	cwd: string,
	eventBus?: EventBus,
	registry: AgentRegistry = AgentRegistry.global(),
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = new ExtensionRuntime();

	for (const prepared of preparedExtensions) {
		const { extension, error } = await bindExtension(prepared.path, prepared, cwd, resolvedEventBus, runtime, registry);

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

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

const CONFIGURED_EXTENSION_DIRECTORY_OPTIONS = {
	indexNames: ["index.ts", "index.js"],
	isScanFile: isExtensionFile,
	throwUnexpectedStatErrors: true,
	onReadError: (filePath: string, error: unknown) => {
		logger.warn("Failed to resolve extension directory", { path: filePath, error: String(error) });
	},
};

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
			addPaths(resolveExtensionDirectory(resolved, CONFIGURED_EXTENSION_DIRECTORY_OPTIONS).files);
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
	registry: AgentRegistry = AgentRegistry.global(),
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(paths, cwd, eventBus, registry);
}
