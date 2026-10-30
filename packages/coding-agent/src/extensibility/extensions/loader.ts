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
import { getCodingAgentApi } from "../host-api";
import type { SendUserMessageOptions } from "../../session/agent-session";
import type { CustomMessagePayload } from "../../session/messages";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { isFilesystemSourcePath } from "../../tools/path-utils";
import { InternalUrlRouter } from "../../internal-urls/router";
import { EventBus, extensionCallbackScope, OwnedEventBus } from "../../utils/event-bus";
import * as TypeBox from "../legacy-typebox";
import { ownCallableSurface } from "./callback-ownership";
import { resolveExtensionDirectory } from "./directory-resolution";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";

import { resolvePath, withHostGuard } from "../utils";
import type { ComposerShapeDefinition } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import type {
	AssistantTextRenderer,
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionCallbackOwner,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
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

/** RFC 3986 scheme syntax, lowercased, two characters at least so `c` cannot capture `C:/` paths. */
const LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+$/;

/** Standard schemes an extension may not claim: web, file and mail links. omp's internal URLs are refused too. */
const STANDARD_LINK_SCHEMES: Readonly<Record<string, true>> = {
	about: true,
	blob: true,
	data: true,
	file: true,
	ftp: true,
	http: true,
	https: true,
	javascript: true,
	mailto: true,
	ssh: true,
	ws: true,
	wss: true,
};

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

/** Takes ownership of a callback a session accepts from an extension. Only a value that IS a
 *  function is taken.
 *
 *  Ownership CANNOT be complete by registration, and it does not need to be: a facility that
 *  invokes a callback can always own that invocation, and a facility that never invokes one has
 *  nothing to own. `ManagedTimers`, `EventBus`, the tool UI controller, `ExtensionRunner.runScoped`,
 *  `ModelRegistry` (`oauth.login`/`refreshToken`/`getApiKey`/`modifyModels`,
 *  `usage.fetchUsage`/`parseRateLimitHeaders`) and `session-maintenance` (`ctx.compact`'s
 *  `onError`/`onComplete`) each own their own calls, and the enumeration lives at those call sites.
 *
 *  Retirement therefore covers WRAPPED callbacks — the ones an owner was given a chance to wrap —
 *  not every callback an extension ever handed over. A callback reached only through an
 *  uninstrumented invoker is still live after disposal; that is a missing invoker, not a missing
 *  mechanism, and it is the thing to look for when a post-disposal call is observed.
 *
 *  Do not try to own every argument crossing the `pi` surface instead. It was built and reverted:
 *  it broke a re-registered built-in tool, an extension `web_search` and the TTSR `willContinue`
 *  gate, in every variant (copy, in-place, direct-functions-only). The cause was not isolated at
 *  the time; review later showed that wrapping a CALLABLE carrying properties — an ArkType schema
 *  with `toJsonSchema` — drops them, which fits. Either way the surface is the wrong place: it
 *  cannot see who will call. */
export function ownAcceptedCallbacks(value: unknown, owner: ExtensionCallbackOwner): unknown {
	if (typeof value === "function") return owner.ownCallback(value as (...args: unknown[]) => unknown);
	return value;
}

/** One session's hold on an extension surface, counted so that concurrent sessions sharing a
 *  runtime release it together. Retirement belongs here rather than on the runtime because a
 *  runtime outlives the session that used it: the next session gets a new lease, and the
 *  callbacks an extension registered once are live again for it. */
class ExtensionCallbackLease {
	#holders = 1;

	join(): void {
		this.#holders++;
	}

	release(): void {
		if (this.#holders > 0) this.#holders--;
	}

	get isRetired(): boolean {
		return this.#holders === 0;
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];

	/**
	 * Extension-authored callbacks, owned from the moment this session ACCEPTS them.
	 *
	 * Ownership keyed on the facility that invokes a callback cannot be completed by enumeration.
	 * Three rounds of review each closed the measured routes — the runner, timers, the event bus,
	 * a tool's `onSession` — and found more: a provider config's `login` and `fetchDynamicModels`
	 * reaching `ModelRegistry`, a `ctx.compact({ onError })` continuation, a deferred factory the
	 * host started. Any facility handed a callback through `pi` can invoke it, and reaching this
	 * object from the runner does not make the runner see what it never started.
	 *
	 * So ownership is taken where the set IS closed: every extension callback is a value the
	 * extension passes into `pi` or a `ctx` method, and {@link ownCallback} wraps it there. The
	 * wrapper owns its own execution, so no invoking facility has to opt in and a new one cannot
	 * reopen the hole — and it REFUSES to run once the last session hold has been released,
	 * because a callback that should not have been entered cannot be fixed by reporting that it
	 * was.
	 */
	readonly #pendingCallbacks = new Set<Promise<unknown>>();
	#callbacksChanged: PromiseWithResolvers<void> | undefined;
	/**
	 * The session that currently owns this runtime's callbacks, or `undefined` while no session
	 * has claimed them.
	 *
	 * Retirement is per SESSION, not per runtime: a host may build one runner and runtime and use
	 * it for several `AgentSession`s in turn — `agent-session-concurrent.test.ts` does — so
	 * retiring the runtime itself would leave the second session's handlers refused forever. The
	 * lease is the per-session object the wrapper consults, and {@link beginSession} installs a
	 * fresh one once the last holder has gone. Sessions sharing a runtime at the same time share
	 * one lease, so one sibling's disposal cannot retire callbacks another is still invoking.
	 */
	#lease: ExtensionCallbackLease | undefined;

	/** Claims this runtime's callbacks for a session that is starting, and returns the only way to
	 *  give that claim back. A lease retired by an earlier session is replaced; a live one gains a
	 *  holder.
	 *
	 *  The release is a handle rather than a second method for two reasons the review found by
	 *  building them: a handle cannot be called without a matching claim, so no caller can steal a
	 *  live sibling's hold, and it is idempotent, so a session disposed twice — or reentrantly —
	 *  releases once. It releases the lease it claimed, so a handle outliving its generation
	 *  cannot retire the session that came after.
	 *
	 *  Once the last holder releases, every callback accepted through `pi`/`ctx` becomes inert, so
	 *  a facility still holding one (a bus subscription, a provider config, a timer) can no longer
	 *  enter a session whose resources are being released. Work already running is unaffected and
	 *  still has to be waited for. */
	beginSession(): () => void {
		let lease = this.#lease;
		if (!lease || lease.isRetired) {
			lease = new ExtensionCallbackLease();
			this.#lease = lease;
		} else {
			lease.join();
		}
		const claimed = lease;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			claimed.release();
		};
	}

	get isRetired(): boolean {
		return this.#lease?.isRetired === true;
	}

	/** Wraps a callback this session accepts. The wrapper refuses once the last session hold has
	 *  been released, and owns the lifetime of what it returns. */
	ownCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
		const owner = this;
		// A regular function, not an arrow: a facility may invoke a callback with a receiver
		// (`definition.execute.call(tool, …)`), and dropping `this` silently breaks it.
		return function (this: unknown, ...args: A): R | undefined {
			if (owner.isRetired) return undefined;
			// Re-entered so a subscription this callback makes (`pi.events.on` from inside a
			// handler) is attributed to this session, not to whoever is on the stack.
			return extensionCallbackScope.run(owner, () => owner.trackCallback(fn.apply(this, args)));
		};
	}

	/** Counts `result` as a live extension callback when it is awaitable, and returns something
	 *  awaitable exactly once more. Thenable duck-typing, not `instanceof`: a callback compiled in
	 *  another realm (`node:vm`, an `--import` loader) returns a Promise that fails the brand check
	 *  while being every bit as live. A COLD thenable runs its body on each `then`, so observing
	 *  one by calling `then` and handing the original back would run it twice; the adopted promise
	 *  is returned in its place. */
	trackCallback<T>(result: T): T {
		if (result === null || (typeof result !== "object" && typeof result !== "function")) return result;
		if (!("then" in result) || typeof result.then !== "function") return result;
		// `then` is callable, so this is awaitable; the compiler cannot express that for `unknown`.
		const adopted = Promise.resolve(result as PromiseLike<unknown>);
		const settled = adopted.then(
			() => undefined,
			() => undefined,
		);
		this.#pendingCallbacks.add(settled);
		this.#notifyCallbacksChanged();
		void settled.finally(() => {
			this.#pendingCallbacks.delete(settled);
			this.#notifyCallbacksChanged();
		});
		return adopted as T;
	}

	ownInvocation<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
		const owner = this;
		return function (this: unknown, ...args: A): R {
			if (owner.isRetired) throw new Error("Extension session retired; its callbacks are no longer callable");
			return extensionCallbackScope.run(owner, () => owner.trackCallback(fn.apply(this, args)));
		};
	}

	/** Whether any extension callback is executing. */
	hasPendingCallbacks(): boolean {
		return this.#pendingCallbacks.size > 0;
	}

	/** Resolves once every extension callback executing now has returned. */
	async waitForPendingCallbacks(): Promise<void> {
		while (this.#pendingCallbacks.size > 0) {
			await Promise.all([...this.#pendingCallbacks]);
		}
	}

	/** Settles on the next add or remove, so a caller can wait for a change instead of sampling. */
	whenCallbacksChange(): Promise<void> {
		this.#callbacksChanged ??= Promise.withResolvers<void>();
		return this.#callbacksChanged.promise;
	}

	#notifyCallbacksChanged(): void {
		const changed = this.#callbacksChanged;
		this.#callbacksChanged = undefined;
		changed?.resolve();
	}

	registerProvider(name: string, config: ProviderConfig, sourceId: string): void {
		// Owned at the queue, not at each drain site: main.ts, sdk.ts and models-cli.ts all hand
		// this configuration to ModelRegistry, and a host that drains it itself must not be able
		// to lose the ownership by not knowing to pass an owner. A read-through view, so the
		// extension's own object is neither rewritten nor copied, and a callback it declared as a
		// class method, a getter or a non-enumerable property is owned like any other.
		this.pendingProviderRegistrations.push({ name, config: ownCallableSurface(config, this, true), sourceId });
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

	get pi() {
		return getCodingAgentApi();
	}

	readonly events: EventBus;

	constructor(
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		events: EventBus,
	) {
		// A view of the host's bus bound to THIS session's owner, not the bus itself. The scope
		// alone attributes a subscription to whoever is accepting on the stack, which is silent
		// for a `pi` reference captured and used later and wrong for one used while another
		// session is on the stack; the reference knows which session gave it out. The transport
		// is shared, so emits and handlers still cross sessions exactly as before — see
		// `OwnedEventBus`. Stable identity: one view per binding, so `pi.events === pi.events`,
		// and two bindings of one extension still see two different objects for two sessions.
		this.events = new OwnedEventBus(events, runtime);
		// Extensions destructure `pi.on` or forward API methods as callbacks, so every
		// prototype method must keep its receiver when detached. Walk the prototype
		// rather than listing methods: a new method is bound without touching this.
		//
		// Taking ownership of every ARGUMENT here was tried and reverted: a callback reached only
		// through a registration's configuration object cannot be owned without rewriting that
		// object, and consumers key on what they were handed. See `ownAcceptedCallbacks`.
		const prototype = ConcreteExtensionAPI.prototype;
		for (const name of Object.getOwnPropertyNames(prototype)) {
			if (name === "constructor") continue;
			const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
			if (typeof descriptor?.value !== "function") continue;
			Object.defineProperty(this, name, { value: descriptor.value.bind(this), writable: true, configurable: true });
		}
	}

	beginSession(): () => void {
		return this.runtime.beginSession();
	}

	get isRetired(): boolean {
		return this.runtime.isRetired;
	}

	ownCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
		return this.runtime.ownCallback(fn);
	}

	ownInvocation<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
		return this.runtime.ownInvocation(fn);
	}

	/** Callback ownership belongs to the one runtime behind every facade for this session; this
	 *  object is an API surface, not a second owner. */
	trackCallback<T>(result: T): T {
		return this.runtime.trackCallback(result);
	}

	hasPendingCallbacks(): boolean {
		return this.runtime.hasPendingCallbacks();
	}

	waitForPendingCallbacks(): Promise<void> {
		return this.runtime.waitForPendingCallbacks();
	}

	whenCallbacksChange(): Promise<void> {
		return this.runtime.whenCallbacksChange();
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

	registerAssistantTextRenderer(renderer: AssistantTextRenderer): void {
		if (typeof renderer !== "function") {
			throw new TypeError(
				`registerAssistantTextRenderer expects a function, got ${typeof renderer} (extension ${this.extension.path})`,
			);
		}
		this.extension.assistantTextRenderers.push(renderer);
	}

	registerLinkScheme(scheme: string): void {
		const normalized = scheme.toLowerCase();
		if (!LINK_SCHEME_PATTERN.test(normalized)) {
			throw new Error(
				`registerLinkScheme: "${scheme}" is not a URL scheme of two or more characters (letters, digits, "+", "-", ".")`,
			);
		}
		// `=== true`: inherited keys such as `constructor` are not reserved.
		if (STANDARD_LINK_SCHEMES[normalized] === true || InternalUrlRouter.instance().isBuiltin(normalized)) {
			throw new Error(`registerLinkScheme: "${scheme}" is reserved for standard or omp-internal links`);
		}
		if (!this.extension.linkSchemes.includes(normalized)) this.extension.linkSchemes.push(normalized);
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

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		this.extension.registersProviders = true;
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
		assistantTextRenderers: [],
		linkSchemes: [],
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
		// Scoped so a `pi.events.on` during registration is attributed to THIS session, which a
		// bus shared between sessions cannot work out for itself.
		await extensionCallbackScope.run(runtime, () => factory(api));
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
		const api = new ConcreteExtensionAPI(extension, runtime, cwd, eventBus);
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
	const api = new ConcreteExtensionAPI(extension, runtime, cwd, eventBus);
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
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: IExtensionRuntime,
): Promise<LoadExtensionsResult> {
	const preparedExtensions = await Promise.all(paths.map(extPath => importExtensionModule(extPath, cwd)));
	return bindPreparedExtensions(preparedExtensions, cwd, eventBus, runtime);
}

/**
 * Bind previously imported extension factories. A fresh session runtime is
 * created unless `runtime` is given: deferred startup extensions bind into the
 * live session's runtime so they share its flag values and wired actions.
 */
export async function bindPreparedExtensions(
	preparedExtensions: readonly PreparedExtension[],
	cwd: string,
	eventBus?: EventBus,
	runtime: IExtensionRuntime = new ExtensionRuntime(),
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();

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

	// Key on the real file so a symlink and its target load once, e.g. an
	// extensions/ symlink plus the same file passed with --extension. Missing
	// paths keep their lexical key so the loader still reports them.
	const addPath = async (extPath: string): Promise<void> => {
		const resolved = path.resolve(extPath);
		const key = await fs.realpath(resolved).catch(() => resolved);
		if (!seen.has(key)) {
			seen.add(key);
			allPaths.push(extPath);
		}
	};

	const addPaths = async (paths: string[]): Promise<void> => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			await addPath(extPath);
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
			await addPath(ext.path);
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
				await addPath(hookPath);
			}
		}
	} else {
		for (const configuredPath of configuredPaths) {
			await addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)));
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		await addPaths(await getAllPluginExtensionPaths(cwd));
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
			await addPaths(resolveExtensionDirectory(resolved, CONFIGURED_EXTENSION_DIRECTORY_OPTIONS).files);
			continue;
		}

		await addPath(resolved);
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
