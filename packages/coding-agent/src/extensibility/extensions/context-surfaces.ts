/**
 * The host services an extension's context hands over — `ctx.ui` (and its `theme`),
 * `ctx.sessionManager`, `ctx.modelRegistry`, `ctx.localProtocolOptions`, `ctx.memory` and
 * `ctx.sessionModes`.
 *
 * Each is the host's own object, and the host keeps acting on it after the extension is done with
 * it: it asks for a tool's approval through the UI, builds requests from the registry's rows and
 * credentials, resolves `local://` through the options, and sends the model the session's history.
 * Handing the object itself would let an extension change what the host does — replace
 * `ui.approve` or the registry's `getApiKey`, edit a row's `baseUrl`, rewrite an entry, call a
 * write method its type does not declare. So each surface is an object the host builds from a
 * named list of members: each member calls the host's object, and the arguments the extension
 * passes are copied in — inside its session's admission, since a getter on them is its code.
 * Nothing the extension writes to what it was handed reaches the host, because the host never
 * reads it.
 *
 * The boundary is put on each surface by one helper (`handSessionFacade`, `handHostFacade`), and it
 * is on the call and on everything the call answers: a member is the session's host call, refused
 * once the session has gone; what it answers crosses by one rule (`crossing`), so a function it
 * answers with — a credential resolver, a disposer — is the session's call too, and an object is a
 * copy unless the boundary built it to be handed (a facade, a model copy). An answer that arrives
 * later — a promise the runtime made — is gated again when it arrives: admitted while the session
 * was live, it is refused if the session has gone by then. A member here returns what the host
 * answered and leaves the copy to the helper; one that forgets hands a copy, never the host's
 * object. The helper refuses, by name, a member it cannot gate.
 *
 * Every member of a surface's type is listed (`Decided`), so a member added to the type does not
 * compile until someone says what an extension gets. `ctx.modelRegistry` and the session's
 * artifact manager hand only the members their records mark; the rest stay with the host.
 *
 * Drawing is the one thing a surface does for whoever holds it, whenever: the theme, and the TUI's
 * render requests, frame facts, terminal size and image budget a component draws through, answer
 * after the session has gone (`handHostFacade`), as the cleanup a session may still owe does (a
 * live call's `stop`, an overlay's `hide`). Their failures are copies and what they answer crosses
 * by the same rule; what they reach is the process-wide renderer, which nothing of them changes.
 * Each exception is as narrow as its reason. A value handed as it is (`handAsIs`) carries no right
 * to act: a dialog's `done` hands its value back as it is, and finishes the dialog only while the
 * session is live; starting the renderer (`start`) is an action, not drawing, and stops with the
 * session, which ends the session's own suspension itself.
 *
 * A callback the extension hands a UI member is its code, run by the host later: a dialog's
 * callbacks are owned (`ownCallback`); a component factory, an autocomplete factory and a
 * terminal-input handler run in the session's renderer scope (`ExtensionRunner.rendererScope`),
 * do nothing once it has gone, and carry that scope (`rendererScope`) for the host that mounts or
 * drives what they return.
 */
import type { ApiKeyResolver, Model } from "@oh-my-pi/pi-ai";
import type { AuthApiKeyOptions } from "@oh-my-pi/pi-ai/auth-storage";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	ImageBudget,
	InputListener,
	InputListenerResult,
	OverlayHandle,
	OverlayOptions,
	Terminal,
	TUI,
} from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import {
	bindInputScope,
	hasInputScope,
	pinInputScope,
	retireGoneInputScopes,
	type ToolRendererScope,
	toolRendererScope,
	whenInputScopeGone,
} from "@oh-my-pi/pi-tui/tools/renderer-scope";
import { logger } from "@oh-my-pi/pi-utils";
import type { ApiKeyResolverModel, ApiKeyResolverOptions } from "../../config/api-key-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { MemoryRuntimeContext } from "../../memory-backend";
import type { ArtifactManager } from "../../session/artifacts";
import type { ReadonlySessionManager } from "../../session/session-manager";
import { type AuthorDataSite, CALLBACK, DATA, fieldsOf, snapshotAuthorData } from "./author-data";
import {
	copyHostData,
	handAsIs,
	handHostFacade,
	handHostModel,
	handSessionFacade,
	isImmutableData,
	releaseHandle,
	releaseIfUndelivered,
	sessionCall,
	sessionHostCall,
} from "./boundary-data";
import { copyHandedModel } from "./compact-handler";
import { hostUIOf } from "./user-wait";
import type {
	ExtensionAgentIdentity,
	ExtensionAnnotationsAPI,
	ExtensionCallbackOwner,
	ExtensionContext,
	ExtensionCustomOptions,
	ExtensionLiveSession,
	ExtensionLiveStartOptions,
	ExtensionSessionModes,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "./types";

/** Every member of `T`, optional ones included (`undefined` where the host has none): an object
 *  built as `Decided<T>` says what it does with each, so a member added to `T` does not compile
 *  until someone decides. */
type Decided<T> = { [K in keyof Required<T>]: {} extends Pick<T, K> ? T[K] | undefined : T[K] };

/** The members a record marks `true`. */
type Handed<Record> = { [K in keyof Record]: Record[K] extends true ? K : never }[keyof Record];

const ADVICE = "Compute the value before handing it over.";

function site(subject: string, at: string): AuthorDataSite {
	return { subject, path: [at], advice: ADVICE };
}

/** `copy` as the session's work: inside its admission, refused once it has gone. */
function copiedIn<T>(owner: ExtensionCallbackOwner, copy: () => T): T {
	return owner.runOwned(copy);
}

/** A string argument, read inside the admission: refused once the session has gone, a string as
 *  it is and anything else converted. A string must not skip the gate — it is what a dead
 *  session's `notify`, `setStatus` or `setEditorText` would write into the live host. */
function text(owner: ExtensionCallbackOwner, value: unknown): string {
	return copiedIn(owner, () => (typeof value === "string" ? value : String(value)));
}

function optionalText(owner: ExtensionCallbackOwner, value: unknown): string | undefined {
	return value === undefined ? undefined : text(owner, value);
}

/** A data argument, copied by its schema inside the admission. */
function data<T>(owner: ExtensionCallbackOwner, value: T, subject: string, at: string): T {
	if (value === undefined || value === null || typeof value !== "object") return value;
	return copiedIn(owner, () => snapshotAuthorData(value, DATA, site(subject, at), new Map()) as T);
}

/** A host signal following the `AbortSignal` the extension passed: `AbortSignal.any` reads the
 *  signal's own state, never a property the author could have replaced, and refuses anything
 *  that is not a signal. */
function followSignal(value: unknown, subject: string, at: string): AbortSignal | undefined {
	if (value === undefined || value === null) return undefined;
	try {
		return AbortSignal.any([value as AbortSignal]);
	} catch {
		throw new Error(`${subject}: ${at} is not an AbortSignal.`);
	}
}

/** A callback the host calls later: the session's, inert once it has gone. Data stays data. */
function owned<T>(owner: ExtensionCallbackOwner, callback: T): T {
	return typeof callback === "function"
		? (owner.ownCallback(callback as (...args: unknown[]) => unknown) as T)
		: callback;
}

// ---------------------------------------------------------------------------------------------
// ctx.modelRegistry
// ---------------------------------------------------------------------------------------------

/**
 * Which members of the host's registry an extension's `ctx.modelRegistry` has: the catalog
 * queries, credential resolution (`getApiKey`, `resolver`, `resolveModelHeaders`), and the one
 * derived fact a provenance guard needs from the store `resolver` resolves through
 * (`credentialProvenance`, a string). Withheld: the credential store itself (`authStorage`) and
 * the stored credential (`getApiKeyWithCredentialForProvider`); registration, which
 * `pi.registerProvider` does as the session's own; and everything that refreshes, reconfigures or
 * drains the host's catalog.
 */
const MODEL_REGISTRY_MEMBERS = {
	authStorage: false,
	refresh: false,
	hydrateCredentialScopedModelCaches: false,
	reapplyModelPolicies: false,
	refreshInBackground: false,
	// The host's own background refresh, as `refreshInBackground` and `awaitBackgroundRefresh` beside
	// it: an extension asks per provider (`isProviderDiscoveryPending`).
	isBackgroundRefreshPending: false,
	awaitBackgroundRefresh: false,
	refreshIfStale: false,
	awaitInitialBackgroundRefresh: false,
	refreshProvider: false,
	refreshDiscoverableProviders: false,
	hasLazyRuntimeMetadata: true,
	refreshSelectedModelMetadata: false,
	refreshRuntimeProviders: false,
	getError: true,
	drainConfigWarnings: false,
	advertisedReasoningCacheSuffix: false,
	contextWindowTiers: true,
	fitContextWindow: false,
	getAll: true,
	getAvailableForProviders: true,
	getAvailable: true,
	hasConfiguredAuth: true,
	hasConcreteAuth: true,
	hasCommandBackedApiKey: true,
	credentialProvenance: true,
	getDiscoverableProviders: true,
	getDiscoveryProviderId: true,
	hasProvider: true,
	getProviderDiscoveryState: true,
	isProviderDiscoveryPending: true,
	find: true,
	getProviderModels: true,
	getProviderBaseUrl: true,
	getProviderHeaders: true,
	resolveModelHeaders: true,
	getApiKey: true,
	getApiKeyAndHeaders: true,
	getApiKeyForProvider: true,
	getApiKeyWithCredentialForProvider: false,
	resolver: true,
	isUsingOAuth: true,
	clearSourceRegistrations: false,
	unregisterProvider: false,
	syncExtensionSources: false,
	registerProvider: false,
	suppressSelector: false,
	isSelectorSuppressed: true,
	clearSuppressedSelector: false,
	clearSuppressedSelectors: false,
} as const satisfies Record<keyof ModelRegistry, boolean>;

/** `ctx.modelRegistry`: the members of the host's registry {@link MODEL_REGISTRY_MEMBERS} hands. */
export type ExtensionModelRegistry = Pick<ModelRegistry, Handed<typeof MODEL_REGISTRY_MEMBERS>>;

const AUTH_OPTIONS = fieldsOf<AuthApiKeyOptions>({
	baseUrl: DATA,
	modelId: DATA,
	accountIds: DATA,
	signal: CALLBACK,
	forceRefresh: DATA,
	refreshReason: DATA,
	rejectedAccessToken: DATA,
	recordAffinity: DATA,
});

const RESOLVER_OPTIONS = fieldsOf<ApiKeyResolverOptions>({ sessionId: DATA, baseUrl: DATA, modelId: DATA });

/** The registry as an extension's context hands it ({@link ExtensionModelRegistry}). A model the
 *  extension passes is copied as `pi.setModel` copies one ({@link copyHandedModel}); every row the
 *  registry answers with is copied by what a model is ({@link handHostModel}), its `resolveHeaders`
 *  the session's call; every state and header set it answers with is a copy, and a resolver
 *  (`resolver`) is the session's call, refused once it has gone ({@link handSessionFacade}). */
export function handModelRegistry(registry: ModelRegistry, owner: ExtensionCallbackOwner): ExtensionModelRegistry {
	const subject = "ctx.modelRegistry";
	const call = sessionCall(owner);
	const row = (value: Model): Model => handHostModel(value, call);
	const model = <M extends object>(value: M): M =>
		copyHandedModel(value as unknown as Model, owner, subject) as unknown as M;
	const authOptions = (value: AuthApiKeyOptions | undefined): AuthApiKeyOptions | undefined =>
		value === undefined
			? undefined
			: copiedIn(owner, () => {
					const copy = snapshotAuthorData(
						value,
						AUTH_OPTIONS,
						site(subject, "options"),
						new Map(),
					) as AuthApiKeyOptions;
					return { ...copy, signal: followSignal(copy.signal, subject, "options.signal") };
				});
	function resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	function resolver(target: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	function resolver(
		target: string | ApiKeyResolverModel,
		optionsOrSessionId?: ApiKeyResolverOptions | string,
	): ApiKeyResolver {
		if (typeof target !== "string" && (typeof target !== "object" || target === null)) {
			return registry.resolver(text(owner, target), resolverOptions(optionsOrSessionId));
		}
		if (typeof target === "string") return registry.resolver(target, resolverOptions(optionsOrSessionId));
		return registry.resolver(model(target), optionalText(owner, optionsOrSessionId));
	}
	const resolverOptions = (value: unknown): ApiKeyResolverOptions | undefined => {
		if (value === undefined) return undefined;
		if (typeof value !== "object" || value === null) return { sessionId: text(owner, value) };
		return copiedIn(
			owner,
			() =>
				snapshotAuthorData(value, RESOLVER_OPTIONS, site(subject, "options"), new Map()) as ApiKeyResolverOptions,
		);
	};
	const handed: Decided<ExtensionModelRegistry> = {
		hasLazyRuntimeMetadata: provider => registry.hasLazyRuntimeMetadata(text(owner, provider)),
		getError: () => registry.getError(),
		contextWindowTiers: target => registry.contextWindowTiers(data(owner, target, subject, "model")),
		getAll: kind => registry.getAll(kind === undefined ? undefined : data(owner, kind, subject, "kind")).map(row),
		getAvailableForProviders: (providers, kind) =>
			registry
				.getAvailableForProviders(
					copiedIn(owner, () => new Set(Array.from(providers, provider => String(provider)))),
					kind === undefined ? undefined : data(owner, kind, subject, "kind"),
				)
				.map(row),
		getAvailable: kind =>
			registry.getAvailable(kind === undefined ? undefined : data(owner, kind, subject, "kind")).map(row),
		hasConfiguredAuth: target => registry.hasConfiguredAuth(model(target)),
		hasConcreteAuth: provider => registry.hasConcreteAuth(text(owner, provider)),
		hasCommandBackedApiKey: provider => registry.hasCommandBackedApiKey(text(owner, provider)),
		credentialProvenance: provider => registry.credentialProvenance(text(owner, provider)),
		getDiscoverableProviders: () => registry.getDiscoverableProviders(),
		getDiscoveryProviderId: requested => registry.getDiscoveryProviderId(text(owner, requested)),
		hasProvider: provider => registry.hasProvider(text(owner, provider)),
		getProviderDiscoveryState: provider => registry.getProviderDiscoveryState(text(owner, provider)),
		isProviderDiscoveryPending: provider => registry.isProviderDiscoveryPending(text(owner, provider)),
		find: (provider, modelId) => {
			const found = registry.find(text(owner, provider), text(owner, modelId));
			return found && row(found);
		},
		getProviderModels: provider => registry.getProviderModels(text(owner, provider)).map(row),
		getProviderBaseUrl: provider => registry.getProviderBaseUrl(text(owner, provider)),
		getProviderHeaders: async provider => registry.getProviderHeaders(text(owner, provider)),
		resolveModelHeaders: async (target, signal) =>
			registry.resolveModelHeaders(model(target), followSignal(signal, subject, "signal")),
		getApiKey: (target, sessionId, options) =>
			registry.getApiKey(model(target), optionalText(owner, sessionId), {
				signal: followSignal(
					options === undefined ? undefined : copiedIn(owner, () => Reflect.get(options, "signal")),
					subject,
					"options.signal",
				),
			}),
		getApiKeyAndHeaders: async target => registry.getApiKeyAndHeaders(model(target)),
		getApiKeyForProvider: (provider, sessionId, options) =>
			registry.getApiKeyForProvider(text(owner, provider), optionalText(owner, sessionId), authOptions(options)),
		// The resolver the registry makes closes over its credential store: it crosses as the
		// session's call, refused once the session has gone ({@link handSessionFacade}).
		resolver,
		isUsingOAuth: target => registry.isUsingOAuth(model(target)),
		isSelectorSuppressed: selector => registry.isSelectorSuppressed(text(owner, selector)),
	};
	// Every member is the session's host call: refused once it has gone, its failure a copy, and
	// what it answers handed by the boundary's one rule.
	return handSessionFacade(handed, owner);
}

// ---------------------------------------------------------------------------------------------
// ctx.sessionManager
// ---------------------------------------------------------------------------------------------

/** Which members of the session's artifact manager an extension gets: reading and writing its
 *  own artifacts. Withheld: allocating a bare id, which the manager's paths are built on. */
const ARTIFACT_MANAGER_MEMBERS = {
	dir: true,
	allocateId: false,
	allocatePath: true,
	save: true,
	exists: true,
	listFiles: true,
	getPath: true,
} as const satisfies Record<keyof ArtifactManager, boolean>;

/** The session's artifact manager, as `ctx.sessionManager.getArtifactManager()` hands it. */
export type ExtensionArtifactManager = Pick<ArtifactManager, Handed<typeof ARTIFACT_MANAGER_MEMBERS>>;

/** `ctx.sessionManager`: exactly the read-only members `ReadonlySessionManager` declares, the
 *  artifact manager handed as {@link ExtensionArtifactManager}. */
export type ExtensionSessionManager = Omit<ReadonlySessionManager, "getArtifactManager"> & {
	getArtifactManager(): ExtensionArtifactManager | null;
};

function handArtifactManager(manager: ArtifactManager, owner: ExtensionCallbackOwner): ExtensionArtifactManager {
	const handed: Decided<ExtensionArtifactManager> = {
		get dir() {
			return manager.dir;
		},
		allocatePath: async toolType => manager.allocatePath(text(owner, toolType)),
		save: (content, toolType) => manager.save(text(owner, content), text(owner, toolType)),
		exists: id => manager.exists(text(owner, id)),
		listFiles: async () => manager.listFiles(),
		getPath: id => manager.getPath(text(owner, id)),
	};
	return handSessionFacade(handed, owner);
}

/** The session's history, as an extension's context hands it ({@link ExtensionSessionManager}):
 *  every entry, branch, tree and statistic it answers with is a copy, so an edit to one changes
 *  nothing of what the session persists or sends the model. */
export function handSessionManager(
	session: ReadonlySessionManager,
	owner: ExtensionCallbackOwner,
): ExtensionSessionManager {
	const subject = "ctx.sessionManager";
	const bytes = (value: unknown): Buffer => copiedIn(owner, () => Buffer.from(value as Uint8Array));
	const handed: Decided<ExtensionSessionManager> = {
		getCwd: () => session.getCwd(),
		getRecordedCwd: () => session.getRecordedCwd(),
		getSessionDir: () => session.getSessionDir(),
		getSessionId: () => session.getSessionId(),
		getSessionFile: () => session.getSessionFile(),
		getSessionName: () => session.getSessionName(),
		getArtifactsDir: () => session.getArtifactsDir(),
		ensureOnDisk: () => session.ensureOnDisk(),
		getArtifactManager: () => {
			const manager = session.getArtifactManager();
			return manager ? handArtifactManager(manager, owner) : null;
		},
		allocateArtifactPath: async toolType => session.allocateArtifactPath(text(owner, toolType)),
		saveArtifact: (content, toolType) => session.saveArtifact(text(owner, content), text(owner, toolType)),
		getArtifactPath: id => session.getArtifactPath(text(owner, id)),
		getLeafId: () => session.getLeafId(),
		getLeafEntry: () => session.getLeafEntry(),
		getEntry: id => session.getEntry(text(owner, id)),
		getLabel: id => session.getLabel(text(owner, id)),
		getBranch: fromId => session.getBranch(optionalText(owner, fromId)),
		getHeader: () => session.getHeader(),
		getEntries: () => session.getEntries(),
		getTree: () => session.getTree(),
		getUsageStatistics: () => session.getUsageStatistics(),
		putBlob: async (blob, options) => session.putBlob(bytes(blob), data(owner, options, subject, "options")),
		putBlobSync: (blob, options) => session.putBlobSync(bytes(blob), data(owner, options, subject, "options")),
	};
	// Every member is the session's host call: refused once it has gone, its failure a copy, and
	// every entry, tree and statistic it answers with a copy ({@link handSessionFacade}).
	return handSessionFacade(handed, owner);
}

// ---------------------------------------------------------------------------------------------
// ctx.localProtocolOptions, ctx.memory, ctx.sessionModes
// ---------------------------------------------------------------------------------------------

/** `local://` as the host resolves it for this session; the extension calls the host's own
 *  answers and cannot change them. Each member is read from the host's options when asked for,
 *  so a host that swaps one later is followed. Reading a member is the session's host call — the
 *  options' getter, a prototype's or a Proxy's trap is the host's code — and so is calling what it
 *  answers: both are refused once the session has gone, and a failure of either is a copy. A
 *  member the extension assigns replaces it on this object only, and is handed back as it is. */
export function handLocalProtocolOptions(
	options: LocalProtocolOptions,
	owner: ExtensionCallbackOwner,
): LocalProtocolOptions {
	const assigned = new Map<keyof LocalProtocolOptions, unknown>();
	const member = <K extends keyof LocalProtocolOptions>(key: K): LocalProtocolOptions[K] => {
		if (assigned.has(key)) return assigned.get(key) as LocalProtocolOptions[K];
		const host = options[key];
		// Called on the host's options, as the host calls it; the boundary makes it the session's call.
		return host && ((() => Reflect.apply(host, options, [])) as LocalProtocolOptions[K]);
	};
	const handed: Decided<LocalProtocolOptions> = {
		get getArtifactsDir() {
			return member("getArtifactsDir");
		},
		set getArtifactsDir(value) {
			assigned.set("getArtifactsDir", handAsIs(value));
		},
		get getSessionId() {
			return member("getSessionId");
		},
		set getSessionId(value) {
			assigned.set("getSessionId", handAsIs(value));
		},
	};
	return handSessionFacade(handed, owner);
}

/** The session's memory backend. */
export function handMemory(memory: MemoryRuntimeContext, owner: ExtensionCallbackOwner): MemoryRuntimeContext {
	const subject = "ctx.memory";
	const handed: Decided<MemoryRuntimeContext> = {
		status: async () => memory.status(),
		search: async (query, options) => {
			const copied =
				options === undefined
					? undefined
					: copiedIn(owner, () => ({
							limit: snapshotAuthorData(
								Reflect.get(options, "limit"),
								DATA,
								site(subject, "options.limit"),
								new Map(),
							) as number | undefined,
							signal: followSignal(Reflect.get(options, "signal"), subject, "options.signal"),
						}));
			return memory.search(text(owner, query), copied);
		},
		save: async input => memory.save(typeof input === "string" ? input : data(owner, input, subject, "input")),
	};
	return handSessionFacade(handed, owner);
}

/** The session's built-in mode controls. */
export function handSessionModes(modes: ExtensionSessionModes, owner: ExtensionCallbackOwner): ExtensionSessionModes {
	const handed: Decided<ExtensionSessionModes> = {
		getState: () => modes.getState(),
		set: async request => modes.set(data(owner, request, "ctx.sessionModes", "request")),
	};
	return handSessionFacade(handed, owner);
}

// ---------------------------------------------------------------------------------------------
// ctx itself
// ---------------------------------------------------------------------------------------------

/**
 * The members of a context that call no host: they answer from the context itself, or are facades
 * of their own that refuse member by member, or clear what the extension itself scheduled
 * (`clearTimer`). `agent` is what the context was made with ({@link handAgentIdentity}). `mode`
 * and `hasUI` are not fixed: while the context's session is live they read the runner now, so a
 * context kept across a rebind answers as the host does; once the session has gone they answer
 * what they did when the context was made, never the host the runner was rebound to since. What
 * each answers crosses by the boundary's one rule all the same ({@link handSessionFacade}). Every
 * other member is the context's session's host call, refused once that session has gone: `abort`,
 * `shutdown`, `compact`, every read of the live session's state (`cwd`, `model`, `isIdle`),
 * `setTimeout`. A member added to the context is a host call until it is listed here, so the
 * default is the one that refuses.
 */
export const CONTEXT_ANSWERS: ReadonlySet<PropertyKey> = new Set<keyof ExtensionContext>([
	"ui",
	"mode",
	"hasUI",
	"agent",
	"isProjectTrusted",
	"sessionManager",
	"modelRegistry",
	"models",
	"sessionModes",
	"localProtocolOptions",
	"clearTimer",
]);

/**
 * `ctx.agent`: the fields the host's identity declares, each read once, now, as the host reads it
 * (a class's getter included), onto a record of the context's own — a write to it stays there,
 * and nothing of the host's object is reached again. A record nothing can change (the default
 * identity, the SDK's frozen one) is handed as it is.
 */
export function handAgentIdentity(agent: ExtensionAgentIdentity): ExtensionAgentIdentity {
	if (isImmutableData(agent)) return agent;
	const declared: Decided<ExtensionAgentIdentity> = {
		kind: agent.kind,
		id: agent.id,
		name: agent.name,
		depth: agent.depth,
		parentId: agent.parentId,
	};
	if (declared.parentId === undefined) delete declared.parentId;
	return handAsIs(copyHostData(declared));
}

/**
 * `ctx.annotations` as a session hands it: an object of its own whose members call the host's, as
 * the session's host calls, what they answer a copy. The host's object is never handed: it is the
 * host's, which the host may keep and drive itself. The request is copied in, inside the
 * admission, as every other surface's argument is: the host reads its source, awaits, then reads
 * its notes, and must read what it checked — never the extension's object, after its session.
 */
export function handAnnotations(
	annotations: ExtensionAnnotationsAPI,
	owner: ExtensionCallbackOwner,
): ExtensionAnnotationsAPI {
	const subject = "ctx.annotations";
	const handed: Decided<ExtensionAnnotationsAPI> = {
		submit: async request => annotations.submit(data(owner, request, subject, "request")),
		open: async request => annotations.open(data(owner, request, subject, "request")),
	};
	return handSessionFacade(handed, owner);
}

/**
 * `ctx.startLive` as a session hands it: the options cross as the strings they name and the
 * session's callbacks — inert once it has gone, each handed copies of what the host reports, the
 * copy taken only once the callback is admitted — and the live session comes back as its strings
 * and a `stop`. Ending the call it started stays the extension's to do once its session has gone
 * too: its own peer going away is the only signal the host gets, and a call left open keeps the
 * host's visualizer up for whoever comes next. So the live session is a facade that answers
 * whenever it is called ({@link handHostFacade}), and a failure of `stop` crosses as a copy.
 *
 * A call the session cannot be handed is ended by the host, whenever the session goes: gone while
 * the call was starting, the host stops it and the session is refused before anything of the live
 * session is read; gone after the handle was built but before it is delivered (the answer is gated
 * again when it settles, `handSessionFacade`), the boundary refuses the handle and the host stops
 * the call ({@link releaseIfUndelivered}). A refused handle never leaves a running call behind.
 */
export function handLiveStart(
	startLive: NonNullable<ExtensionContext["startLive"]>,
	owner: ExtensionCallbackOwner,
): NonNullable<ExtensionContext["startLive"]> {
	const subject = "ctx.startLive";
	return async options => {
		const handed = copiedIn(owner, (): ExtensionLiveStartOptions => {
			const read = (key: keyof ExtensionLiveStartOptions): unknown => Reflect.get(options, key);
			const optional = (key: "voice" | "instructions"): string | undefined => {
				const value = read(key);
				return value === undefined ? undefined : String(value);
			};
			const callback = <F extends (...args: never[]) => void>(
				key: "onPhase" | "onTranscript" | "onEnd",
			): F | undefined => {
				const value = read(key);
				if (value === undefined) return undefined;
				if (typeof value !== "function") throw new Error(`${subject}: options.${key} is not a function.`);
				// Admitted first, copied second: once the session has gone, what the host reports is
				// not read at all.
				return owner.ownCallback((...args: unknown[]) =>
					Reflect.apply(
						value,
						undefined,
						args.map(arg => copyHostData(arg)),
					),
				) as unknown as F;
			};
			return {
				sdpOffer: String(read("sdpOffer")),
				voice: optional("voice"),
				instructions: optional("instructions"),
				onPhase: callback("onPhase"),
				onTranscript: callback("onTranscript"),
				onEnd: callback("onEnd"),
			};
		});
		const live = await startLive(handed);
		if (owner.isRetired) {
			releaseHandle(() => live.stop());
			// The session's refusal, before anything of the live session is read.
			return sessionHostCall(owner, () => {
				throw new Error(`${subject}: the session ended while its live call was starting.`);
			});
		}
		const session: Decided<ExtensionLiveSession> = {
			sdpAnswer: String(live.sdpAnswer),
			voice: String(live.voice),
			stop: () => live.stop(),
		};
		return releaseIfUndelivered(handHostFacade(session), () => live.stop());
	};
}

// ---------------------------------------------------------------------------------------------
// ctx.ui.theme
// ---------------------------------------------------------------------------------------------

/** Each theme handed out, by the host's theme it calls: one per theme, so it compares equal to
 *  itself across reads. */
const handedThemes = new WeakMap<Theme, Theme>();
/** The host's theme behind each handed one, for a handed theme passed back to `setTheme`. */
const themesHanded = new WeakMap<object, Theme>();

/**
 * The host's theme as an extension is handed it. The host's theme is one object shared by every
 * session and every renderer, so a method an extension replaced on it would draw for all of them;
 * the extension is handed an object of its own whose members call the host's theme. It is drawing,
 * and draws for whoever holds it ({@link handHostFacade}): a member's failure is a copy, and what it
 * answers is a string or a copy, `sessionAccentInputs` — frozen data — excepted.
 */
export function handTheme(theme: Theme): Theme {
	if (themesHanded.has(theme)) return theme;
	const known = handedThemes.get(theme);
	if (known) return known;
	const handed: Decided<Theme> = {
		get statusLineLuminance() {
			return theme.statusLineLuminance;
		},
		get isLight() {
			return theme.isLight;
		},
		get accentSurfaceLuminance() {
			return theme.accentSurfaceLuminance;
		},
		getColorHex: color => theme.getColorHex(color),
		getBgHex: color => theme.getBgHex(color),
		getAllThemeColorHexes: () => theme.getAllThemeColorHexes(),
		getMajorThemeColorHexes: () => theme.getMajorThemeColorHexes(),
		getAccentColorHex: () => theme.getAccentColorHex(),
		get sessionAccentInputs() {
			return theme.sessionAccentInputs;
		},
		hasColor: color => theme.hasColor(color),
		fg: (color, value) => theme.fg(color, value),
		fgResolved: (color, value) => theme.fgResolved(color, value),
		bg: (color, value) => theme.bg(color, value),
		bgFill: (color, value) => theme.bgFill(color, value),
		fgOnBg: (color, background, value) => theme.fgOnBg(color, background, value),
		bold: value => theme.bold(value),
		italic: value => theme.italic(value),
		underline: value => theme.underline(value),
		strikethrough: value => theme.strikethrough(value),
		inverse: value => theme.inverse(value),
		getFgAnsi: color => theme.getFgAnsi(color),
		getBgAnsi: color => theme.getBgAnsi(color),
		getFgOnBgAnsi: (color, background) => theme.getFgOnBgAnsi(color, background),
		getContrastFgAnsi: color => theme.getContrastFgAnsi(color),
		getColorMode: () => theme.getColorMode(),
		getThinkingBorderColor: level => theme.getThinkingBorderColor(level),
		getBashModeBorderColor: () => theme.getBashModeBorderColor(),
		getPythonModeBorderColor: () => theme.getPythonModeBorderColor(),
		symbol: key => theme.symbol(key),
		styledSymbol: (key, color) => theme.styledSymbol(key, color),
		getSymbolPreset: () => theme.getSymbolPreset(),
		get status() {
			return theme.status;
		},
		get nav() {
			return theme.nav;
		},
		get tree() {
			return theme.tree;
		},
		get progress() {
			return theme.progress;
		},
		get boxRound() {
			return theme.boxRound;
		},
		get boxDotted() {
			return theme.boxDotted;
		},
		get boxSharp() {
			return theme.boxSharp;
		},
		get sep() {
			return theme.sep;
		},
		get icon() {
			return theme.icon;
		},
		get cmd() {
			return theme.cmd;
		},
		get thinking() {
			return theme.thinking;
		},
		get checkbox() {
			return theme.checkbox;
		},
		get radio() {
			return theme.radio;
		},
		get format() {
			return theme.format;
		},
		get md() {
			return theme.md;
		},
		get spinnerFrames() {
			return theme.spinnerFrames;
		},
		getSpinnerFrames: type => theme.getSpinnerFrames(type),
		getLangIcon: lang => theme.getLangIcon(lang),
		getLangIconStyled: lang => theme.getLangIconStyled(lang),
	};
	// `Theme` is a class with private state, so no object the host builds can be one; this object
	// has every public member, and the host code an extension passes it to calls only those.
	const asTheme = handHostFacade(handed) as unknown as Theme;
	handedThemes.set(theme, asTheme);
	themesHanded.set(asTheme, theme);
	return asTheme;
}

// ---------------------------------------------------------------------------------------------
// ctx.ui
// ---------------------------------------------------------------------------------------------

const DIALOG_OPTIONS = fieldsOf<ExtensionUIDialogOptions>({
	signal: CALLBACK,
	timeout: DATA,
	onTimeout: CALLBACK,
	onTimeoutStart: CALLBACK,
	onTimeoutReset: CALLBACK,
	secret: DATA,
	initialIndex: DATA,
	outline: DATA,
	onLeft: CALLBACK,
	onRight: CALLBACK,
	onExternalEditor: CALLBACK,
	helpText: DATA,
	selectionMarker: DATA,
	checkedIndices: DATA,
	markableCount: DATA,
	acceptImages: DATA,
});

const CUSTOM_OPTIONS = fieldsOf<ExtensionCustomOptions>({
	overlay: DATA,
	overlayOptions: CALLBACK,
	onHandle: CALLBACK,
	signal: CALLBACK,
});

// ---------------------------------------------------------------------------------------------
// What a ctx.ui factory is handed: the TUI, the keybindings, the provider it wraps
// ---------------------------------------------------------------------------------------------

/** A member a surface lists but does not hand: there, so the surface has every member its type
 *  declares, and refusing with its name when used. */
function withheld(subject: string, member: string): never {
	throw new Error(`${subject}: ${member} is the host's own; an extension's component cannot use it.`);
}

const TUI_SUBJECT = "ctx.ui tui";

const OVERLAY_OPTIONS = fieldsOf<OverlayOptions>({
	width: DATA,
	minWidth: DATA,
	maxHeight: DATA,
	anchor: DATA,
	offsetX: DATA,
	offsetY: DATA,
	row: DATA,
	col: DATA,
	margin: DATA,
	visible: CALLBACK,
	fullscreen: DATA,
	mouseTracking: DATA,
});

const INERT_OVERLAY: OverlayHandle = handHostFacade({ hide() {}, setHidden() {}, isHidden: () => true });

/** The host's overlay handle as a session's dialog is handed it: hiding it is always allowed, and
 *  showing it again only while that session is live. The host's object is never handed. */
function handOverlayHandle(handle: OverlayHandle, session: ToolRendererScope): OverlayHandle {
	const handed: Decided<OverlayHandle> = {
		hide: () => handle.hide(),
		setHidden: hidden => {
			if (hidden === true) handle.setHidden(true);
			else if (session.live) handle.setHidden(false);
		},
		isHidden: () => handle.isHidden(),
	};
	return handHostFacade(handed);
}

/** A factory pinned to one session crossing another session's `ctx.ui`: live while both are, run
 *  in the scope of the session whose code it is. */
function bothScopes(outer: ToolRendererScope, inner: ToolRendererScope): ToolRendererScope {
	return {
		get live() {
			return outer.live && inner.live;
		},
		run<T>(call: () => T): T {
			if (!outer.live) throw new Error("Extension session retired; its renderers are no longer callable");
			return inner.run(call);
		},
	};
}

/** What a session's input listener answered, read inside its scope: whether it consumed the key,
 *  and the text it passes on in its place. */
function copyListenerResult(result: unknown): InputListenerResult {
	if (typeof result !== "object" || result === null) return undefined;
	const consume: unknown = Reflect.get(result, "consume");
	const data: unknown = Reflect.get(result, "data");
	return { consume: consume === true, ...(typeof data === "string" && { data }) };
}

/** Each TUI handed out, per session scope and host TUI: one per pair, so it compares equal to
 *  itself across factories. */
const handedTUIs = new WeakMap<ToolRendererScope, WeakMap<TUI, TUI>>();

/**
 * The host's TUI as a session's component factory is handed it. The TUI is one object for the
 * whole process: it takes every session's keystrokes, draws every frame, and runs the screen. So
 * the factory is handed an object of the session's own whose members are listed (`Decided`):
 *
 * - drawing — a render request, the frame's timing, the terminal's size ({@link handTerminal}) and
 *   the image budget an image draws through ({@link handImageBudget}) — calls the host's TUI,
 *   whoever calls it and whenever: it asks the process-wide renderer for a frame and reads what it
 *   reports, and changes nothing else ({@link handHostFacade}, a failure crossing as a copy);
 * - an input listener, a focus change and an overlay are the session's, made only while its scope
 *   is live and running in it: a listener is taken off the TUI at the first key after the scope
 *   has gone and is never called again; a component the session focuses or shows takes input in
 *   its scope (`bindInputScope`), and once the scope has gone an overlay is taken down and focus
 *   goes back to what the session took it from. A suspension (`stop`) is made, and ended (`start`),
 *   only while the scope is live, and only the session's own; it is the session's state on the
 *   host, as what it sets on the UI is, so the host ends it when the session ends (`whenSessionEnds`)
 *   and the renderer is not left stopped. Starting the renderer is an action, not drawing: once the
 *   session has gone, `start` does nothing;
 * - everything that steers the host's renderer, its input, its screen and its other components —
 *   its children, its listeners for paints and frames, its debug input — is withheld.
 */
export function handTUI(tui: TUI, owner: ExtensionCallbackOwner, scope: ToolRendererScope): TUI {
	// A host with no TUI to give (a test's bare controller) passes nothing, and nothing is handed.
	if (tui === undefined || tui === null) return tui;
	let byTUI = handedTUIs.get(scope);
	if (!byTUI) {
		byTUI = new WeakMap();
		handedTUIs.set(scope, byTUI);
	}
	const known = byTUI.get(tui);
	if (known) return known;
	const refuse = (member: string): never => withheld(TUI_SUBJECT, member);
	/** Each listener the session added, with what takes it off the host's TUI. */
	const listeners = new Map<InputListener, () => void>();
	/** Each component the session focused or showed, and what had focus outside the session when
	 *  it last took focus: where focus goes back to once the session gives it up or has gone. */
	const predecessors = new WeakMap<Component, Component | undefined>();
	/** The overlays each session showed and has not taken down, by the session they belong to
	 *  (`pinInputScope`): the host takes them down once that session has gone, whichever component
	 *  they hold and whoever bound it, even when the runtime already serves the next session. */
	const overlaysBySession = new Map<ToolRendererScope, Set<OverlayHandle>>();
	let suspended = false;
	/** Whether the session's end has been asked to end its suspension: asked once, whatever it does. */
	let resumesAtEnd = false;
	const resume = (): void => {
		if (!suspended) return;
		suspended = false;
		tui.start();
	};
	/** What had focus outside the session: a component the session took focus with stands for what
	 *  it took focus from. */
	const outsideSession = (component: Component | null): Component | undefined =>
		component === null ? undefined : predecessors.has(component) ? predecessors.get(component) : component;
	/**
	 * The session takes `component` into view or focus. Whatever a session that has gone left on it
	 * is settled first (`retireGoneInputScopes`): a component that session left focused hands focus
	 * back to what that session took it from, so this taking records where focus really was. It
	 * takes input in the session's scope from now on — bound before the TUI calls anything of it,
	 * unless it takes input in a live scope already (a dialog the host bound, a child an overlay
	 * owns) — and remembers what had focus outside the session at this taking, not an earlier one:
	 * a component given up and taken again goes back to what it was taken from the last time. Once
	 * the scope has gone, input addressed to it, and focus left on it, go there (`inputRecipient`,
	 * `TUI.setFocus`).
	 */
	const take = (component: Component): void => {
		retireGoneInputScopes();
		const focused = tui.getFocused();
		if (focused !== component) predecessors.set(component, outsideSession(focused));
		if (!hasInputScope(component)) {
			bindInputScope(component, scope, () => {
				const successor = predecessors.get(component);
				if (tui.getFocused() === component) tui.setFocus(successor ?? null);
				return successor;
			});
		}
	};
	const handed: Decided<TUI> = {
		requestRender: force => tui.requestRender(force === true),
		requestComponentRender: component => tui.requestComponentRender(component),
		renderNow: () => tui.renderNow(),
		invalidate: () => tui.invalidate(),
		get fullRedraws() {
			return tui.fullRedraws;
		},
		get synchronizedOutput() {
			return tui.synchronizedOutput;
		},
		get lastFrameCostMs() {
			return tui.lastFrameCostMs;
		},
		get nativeRendering() {
			return tui.nativeRendering;
		},
		get nativeFallbackCount() {
			return tui.nativeFallbackCount;
		},
		get terminal() {
			return handTerminal(tui.terminal);
		},
		get imageBudget() {
			return handImageBudget(tui.imageBudget);
		},
		getShowHardwareCursor: () => tui.getShowHardwareCursor(),
		getResizeScrollback: () => tui.getResizeScrollback(),
		hasOverlay: () => tui.hasOverlay(),
		addInputListener: (listener, options) => {
			// The session adding it, not the runtime's: a listener ends with that session.
			const session = pinInputScope(scope);
			if (!session.live) return () => {};
			const prepend = copiedIn(owner, () => options?.prepend === true);
			let remove = (): void => {};
			const unsubscribe = tui.addInputListener(
				data => {
					if (!session.live) {
						remove();
						return undefined;
					}
					return session.run(() => copyListenerResult(listener(data)));
				},
				{ prepend },
			);
			remove = () => {
				unsubscribe();
				listeners.delete(listener);
			};
			listeners.set(listener, remove);
			return remove;
		},
		removeInputListener: listener => listeners.get(listener)?.(),
		setFocus: component => {
			if (!scope.live) return;
			if (component === null) {
				// Giving focus up hands it back to what the session took it from — or to what took that
				// one's place, once it has gone (`TUI.setFocus`) — and only from what the session took.
				const focused = tui.getFocused();
				if (focused !== null && predecessors.has(focused)) tui.setFocus(predecessors.get(focused) ?? null);
				return;
			}
			take(component);
			tui.setFocus(component);
		},
		showOverlay: (component, options) => {
			const session = pinInputScope(scope);
			if (!session.live) return INERT_OVERLAY;
			const copied =
				options === undefined
					? undefined
					: copiedIn(
							owner,
							() =>
								snapshotAuthorData(
									options,
									OVERLAY_OPTIONS,
									site(TUI_SUBJECT, "showOverlay() options"),
									new Map(),
								) as OverlayOptions,
						);
			const visible = copied?.visible;
			// Taken before it is shown: showing it focuses it.
			take(component);
			const shown = tui.showOverlay(
				component,
				copied && {
					...copied,
					visible:
						typeof visible === "function"
							? (width, height) => session.live && session.run(() => visible(width, height) === true)
							: undefined,
				},
			);
			// Whatever else the session did with this component — focused it first, showed it twice —
			// the overlay comes down when the session goes, before anything of it is drawn again. The
			// TUI also takes it down if the session that owns the component goes first.
			let owed = overlaysBySession.get(session);
			if (!owed) {
				const settled = new Set<OverlayHandle>();
				overlaysBySession.set(session, settled);
				whenInputScopeGone(session, () => {
					overlaysBySession.delete(session);
					for (const overlay of settled) overlay.hide();
				});
				owed = settled;
			}
			const overlays = owed;
			overlays.add(shown);
			const handle: Decided<OverlayHandle> = {
				hide: () => {
					overlays.delete(shown);
					shown.hide();
				},
				// Hidden and shown again only while the session is live: once it has gone the overlay is
				// down for good.
				setHidden: hidden => {
					if (session.live) shown.setHidden(hidden === true);
				},
				isHidden: () => shown.isHidden(),
			};
			return handHostFacade(handle);
		},
		stop: () => {
			if (!scope.live || suspended) return;
			suspended = true;
			tui.stop();
			if (resumesAtEnd) return;
			resumesAtEnd = true;
			owner.whenSessionEnds?.(resume);
		},
		start: () => {
			if (scope.live) resume();
		},
		get children(): Component[] {
			return refuse("children");
		},
		get overlayStack(): TUI["overlayStack"] {
			return refuse("overlayStack");
		},
		get onDebug() {
			return undefined;
		},
		setIgnoreTight: () => refuse("setIgnoreTight()"),
		addChild: () => refuse("addChild()"),
		removeChild: () => refuse("removeChild()"),
		clear: () => refuse("clear()"),
		disposeChildren: () => refuse("disposeChildren()"),
		releaseRenderCaches: () => refuse("releaseRenderCaches()"),
		dispose: () => refuse("dispose()"),
		render: () => refuse("render()"),
		describe: () => refuse("describe()"),
		addPaintListener: () => refuse("addPaintListener()"),
		addFrameWriteListener: () => refuse("addFrameWriteListener()"),
		addStartListener: () => refuse("addStartListener()"),
		setFrameProvider: () => refuse("setFrameProvider()"),
		setMaxInlineImages: () => refuse("setMaxInlineImages()"),
		setResizeScrollback: () => refuse("setResizeScrollback()"),
		clearInlineImages: () => refuse("clearInlineImages()"),
		setShowHardwareCursor: () => refuse("setShowHardwareCursor()"),
		getFocused: () => refuse("getFocused()"),
		getDebugPaint: () => refuse("getDebugPaint()"),
		getDebugDocument: () => refuse("getDebugDocument()"),
		injectDebugInput: () => refuse("injectDebugInput()"),
		hideOverlay: () => refuse("hideOverlay()"),
		getMutableViewport: () => refuse("getMutableViewport()"),
		getFilledHistoryRows: () => refuse("getFilledHistoryRows()"),
		hasProviderHistory: () => refuse("hasProviderHistory()"),
		setInlineMouseTrackingProvider: () => refuse("setInlineMouseTrackingProvider()"),
		closeNative: () => refuse("closeNative()"),
		getNativeDocument: () => refuse("getNativeDocument()"),
		getNativeFrames: () => refuse("getNativeFrames()"),
		enableInput: () => refuse("enableInput()"),
		releaseHeldInput: () => refuse("releaseHeldInput()"),
		replaceHeldFocus: () => refuse("replaceHeldFocus()"),
		resetDisplay: () => refuse("resetDisplay()"),
		scheduleAfter: () => refuse("scheduleAfter()"),
	};
	// `TUI` is a class with private state, so no object the host builds can be one; this object
	// has every public member, each handed, scoped or refused as listed above.
	const asTUI = handHostFacade(handed) as unknown as TUI;
	byTUI.set(tui, asTUI);
	return asTUI;
}

const TERMINAL_SUBJECT = "ctx.ui tui.terminal";
const handedTerminals = new WeakMap<Terminal, Terminal>();

/** The host's terminal as a session's component reads it: its size and what it reported about
 *  itself. Everything that writes to it or subscribes to it is the host's renderer's. */
function handTerminal(terminal: Terminal): Terminal {
	const known = handedTerminals.get(terminal);
	if (known) return known;
	const refuse = (member: string): never => withheld(TERMINAL_SUBJECT, member);
	const handed: Decided<Terminal> = {
		get columns() {
			return terminal.columns;
		},
		get rows() {
			return terminal.rows;
		},
		get pendingOutputBytes() {
			return terminal.pendingOutputBytes;
		},
		get hostOwnsGridOnResize() {
			return terminal.hostOwnsGridOnResize;
		},
		get kittyProtocolActive() {
			return terminal.kittyProtocolActive;
		},
		get kittyEnableSequence() {
			return terminal.kittyEnableSequence;
		},
		get keyboardEnhancementEnterSequence() {
			return terminal.keyboardEnhancementEnterSequence;
		},
		get keyboardEnhancementExitSequence() {
			return terminal.keyboardEnhancementExitSequence;
		},
		get keyboardEnhancementRestoreSequence() {
			return terminal.keyboardEnhancementRestoreSequence;
		},
		get appearance() {
			return terminal.appearance;
		},
		get tspProbePending() {
			return terminal.tspProbePending;
		},
		get tspExpected() {
			return terminal.tspExpected;
		},
		start: () => refuse("start()"),
		enableInput: undefined,
		stop: () => refuse("stop()"),
		drainInput: () => refuse("drainInput()"),
		write: () => refuse("write()"),
		moveBy: () => refuse("moveBy()"),
		hideCursor: () => refuse("hideCursor()"),
		showCursor: () => refuse("showCursor()"),
		setCursorShape: undefined,
		clearLine: () => refuse("clearLine()"),
		clearFromCursor: () => refuse("clearFromCursor()"),
		clearScreen: () => refuse("clearScreen()"),
		setTitle: () => refuse("setTitle()"),
		setProgress: () => refuse("setProgress()"),
		onAppearanceChange: () => refuse("onAppearanceChange()"),
		onAppearanceReport: undefined,
		refreshAppearance: undefined,
		onPrivateModeReport: undefined,
		onSixelSupport: undefined,
		onGlyphProtocolReport: undefined,
		onTspHello: undefined,
	};
	const asTerminal = handHostFacade(handed);
	handedTerminals.set(terminal, asTerminal);
	return asTerminal;
}

const IMAGE_BUDGET_SUBJECT = "ctx.ui tui.imageBudget";
const handedImageBudgets = new WeakMap<ImageBudget, ImageBudget>();

/** The host's image budget as an image a session's component draws reaches it: the ids, the
 *  observations and the transmits one image makes while it draws. Running a pass, setting the cap
 *  and taking what a frame purges are the host's renderer's. */
function handImageBudget(budget: ImageBudget): ImageBudget {
	const known = handedImageBudgets.get(budget);
	if (known) return known;
	const refuse = (member: string): never => withheld(IMAGE_BUDGET_SUBJECT, member);
	const handed: Decided<ImageBudget> = {
		get cap() {
			return budget.cap;
		},
		get enabled() {
			return budget.enabled;
		},
		get quiescent() {
			return budget.quiescent;
		},
		requestRender: () => budget.requestRender(),
		acquireId: key => budget.acquireId(typeof key === "string" ? key : undefined),
		release: key => {
			if (typeof key === "string") budget.release(key);
		},
		observe: imageId => typeof imageId === "number" && budget.observe(imageId),
		shouldTransmit: imageId => typeof imageId === "number" && budget.shouldTransmit(imageId),
		registerPlacementGeometry: (imageId, widthPx, heightPx) =>
			budget.registerPlacementGeometry(Number(imageId), Number(widthPx), Number(heightPx)),
		getPlacementGeometry: imageId => budget.getPlacementGeometry(Number(imageId)),
		enqueueTransmit: (imageId, sequence) => {
			if (typeof imageId === "number" && typeof sequence === "string") budget.enqueueTransmit(imageId, sequence);
		},
		hasPendingTransmits: () => budget.hasPendingTransmits(),
		setRequestRender: () => refuse("setRequestRender()"),
		setCap: () => refuse("setCap()"),
		beginAltScreenLifecycle: () => refuse("beginAltScreenLifecycle()"),
		beginPass: () => refuse("beginPass()"),
		endPass: () => refuse("endPass()"),
		limitResidentImages: () => refuse("limitResidentImages()"),
		takeResetPurgeIds: () => refuse("takeResetPurgeIds()"),
		takePurgeIds: () => refuse("takePurgeIds()"),
		takeAllTransmittedIds: () => refuse("takeAllTransmittedIds()"),
		takeTransmits: () => refuse("takeTransmits()"),
		forgetTransmitted: () => refuse("forgetTransmitted()"),
	};
	// A class with private state, as `TUI` is: this object has every public member.
	const asBudget = handHostFacade(handed) as unknown as ImageBudget;
	handedImageBudgets.set(budget, asBudget);
	return asBudget;
}

/**
 * The keybindings a dialog or an editor factory is handed: a manager of its own, built from a copy
 * of the user's bindings. The bindings are data; the manager the host matches keys with — the
 * editor's submit, the next session's shortcuts — is the host's, and a binding the extension
 * changes changes only its copy.
 */
export function handKeybindings(keybindings: KeybindingsManager): KeybindingsManager {
	return keybindings === undefined || keybindings === null
		? keybindings
		: KeybindingsManager.inMemory(copyHostData(keybindings.getUserBindings()));
}

/**
 * The provider an autocomplete factory wraps, as the factory is handed it. The host keeps that
 * provider — the built-in one, or the provider the factory before this one made — and falls back
 * to it once the extension's own provider has retired, so the factory is handed an object of the
 * session's own whose members call the host's: a member the extension replaces is replaced there.
 * What the extension passes is copied in inside its admission, a callback it passes is owned, and
 * every member is the session's host call ({@link handSessionFacade}): what the host's provider
 * answers is copied out, and once the session has gone the provider refuses. The optional members
 * are read when asked for.
 */
export function handAutocompleteProvider(
	provider: AutocompleteProvider,
	owner: ExtensionCallbackOwner,
): AutocompleteProvider {
	const subject = "ctx.ui addAutocompleteProvider() provider";
	const lines = (value: string[]): string[] => copiedIn(owner, () => Array.from(value, line => String(line)));
	const number = (value: number): number => copiedIn(owner, () => Number(value));
	const handed: Decided<AutocompleteProvider> = {
		getSuggestions: async (text, cursorLine, cursorCol, signal, onPartial) =>
			provider.getSuggestions(
				lines(text),
				number(cursorLine),
				number(cursorCol),
				followSignal(signal, subject, "getSuggestions() signal"),
				typeof onPartial === "function"
					? owner.ownCallback((suggestions: { items: AutocompleteItem[]; prefix: string }) =>
							onPartial(copyHostData(suggestions)),
						)
					: undefined,
			),
		applyCompletion: (text, cursorLine, cursorCol, item, prefix) =>
			provider.applyCompletion(
				lines(text),
				number(cursorLine),
				number(cursorCol),
				data(owner, item, subject, "applyCompletion() item"),
				copiedIn(owner, () => String(prefix)),
			),
		get getInlineHint(): AutocompleteProvider["getInlineHint"] {
			const getInlineHint = provider.getInlineHint;
			return (
				getInlineHint &&
				((text, cursorLine, cursorCol) =>
					Reflect.apply(getInlineHint, provider, [lines(text), number(cursorLine), number(cursorCol)]))
			);
		},
		get trySyncSlashCompletion(): AutocompleteProvider["trySyncSlashCompletion"] {
			const trySyncSlashCompletion = provider.trySyncSlashCompletion;
			return (
				trySyncSlashCompletion &&
				(textBeforeCursor =>
					Reflect.apply(trySyncSlashCompletion, provider, [copiedIn(owner, () => String(textBeforeCursor))]))
			);
		},
		get trySyncInlineReplace(): AutocompleteProvider["trySyncInlineReplace"] {
			const trySyncInlineReplace = provider.trySyncInlineReplace;
			return (
				trySyncInlineReplace &&
				(textBeforeCursor =>
					Reflect.apply(trySyncInlineReplace, provider, [copiedIn(owner, () => String(textBeforeCursor))]))
			);
		},
		get getForceFileSuggestions(): AutocompleteProvider["getForceFileSuggestions"] {
			const getForceFileSuggestions = provider.getForceFileSuggestions;
			return (
				getForceFileSuggestions &&
				(async (text, cursorLine, cursorCol, signal) =>
					Reflect.apply(getForceFileSuggestions, provider, [
						lines(text),
						number(cursorLine),
						number(cursorCol),
						followSignal(signal, subject, "getForceFileSuggestions() signal"),
					]))
			);
		},
		get shouldTriggerFileCompletion(): AutocompleteProvider["shouldTriggerFileCompletion"] {
			const shouldTriggerFileCompletion = provider.shouldTriggerFileCompletion;
			return (
				shouldTriggerFileCompletion &&
				((text, cursorLine, cursorCol) =>
					Reflect.apply(shouldTriggerFileCompletion, provider, [
						lines(text),
						number(cursorLine),
						number(cursorCol),
					]) === true)
			);
		},
	};
	return handSessionFacade(handed, owner);
}

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

/** Each session's editor factories, by the wrapper the host holds. Keyed on the session, not on a
 *  facade: the host hands one session several `ui` objects (a dialog's, a link activation's), and a
 *  factory the session installed through one is its own read back through any of them. */
const editorFactoriesBySession = new WeakMap<ExtensionCallbackOwner, WeakMap<object, EditorFactory>>();

function editorFactoriesOf(owner: ExtensionCallbackOwner): WeakMap<object, EditorFactory> {
	let factories = editorFactoriesBySession.get(owner);
	if (!factories) {
		factories = new WeakMap();
		editorFactoriesBySession.set(owner, factories);
	}
	return factories;
}

/** What the sessions have done to the slots of one host UI ({@link hostUIKey}) — a footer, a status
 *  key, the title — whichever wrapper each runner holds that UI through. */
interface HostUISlots {
	/** Which session holds each slot it set: the last whose setting of it took. */
	readonly held: Map<string, ExtensionCallbackOwner>;
	/** Which session's setting of each slot the host is applying right now. */
	readonly setting: Map<string, ExtensionCallbackOwner>;
}

const uiSlots = new WeakMap<object, HostUISlots>();

/** The host UIs on which each slot is held, by slot ({@link warnIfHeldElsewhere}). An entry lives
 *  only while its slot is held there, so it keeps no gone UI alive. */
const slotHolders = new Map<string, Set<HostUISlots>>();

/** Slots {@link warnIfHeldElsewhere} has warned about: once names the cause. */
const warnedSlots = new Set<string>();

/**
 * Warns when the session `ending` takes `slot` back on one UI object while another live session
 * holds the same slot on another. Two UI objects are two UIs here ({@link hostUIKey}), but an
 * embedder that hands each agent its own copy of one UI fronts a single UI with two objects, and
 * then this withdrawal clears — and for a widget, disposes — what the other session shows, which
 * that session cannot read back or learn of. The two cases cannot be told apart, so this does not
 * change what is written; it says so, once per slot, where an embedder can find it.
 */
function warnIfHeldElsewhere(slot: string, here: HostUISlots, ending: ExtensionCallbackOwner): void {
	if (warnedSlots.has(slot)) return;
	for (const other of slotHolders.get(slot) ?? []) {
		const holder = other.held.get(slot);
		if (other === here || holder === undefined || holder === ending || holder.isRetired) continue;
		warnedSlots.add(slot);
		logger.warn(
			"An extension session's end cleared a UI slot that another live session holds through a different UI object. If both objects front one UI, the other session's value was cleared too: hand every agent sharing a UI the same object, or a transparent Proxy over one extensible object (docs/sdk.md).",
			{ slot },
		);
		return;
	}
}

/** Where a host UI carries the key its slots are held under ({@link hostUIKey}). */
const HOST_UI_KEY = Symbol("omp.extension.hostUIKey");

/**
 * The one key for the host's UI behind `ui`, whatever wraps it. Each runner holds the host's UI
 * through a wrapper of its own (`trackUserWaits`, one per runner and per tool context), and two
 * sessions on two runners write to the same host UI through two wrappers, so the wrapper's identity
 * cannot say which UI a slot is on. The key is defined on the UI through `ui`: a wrapper that
 * forwards to the host's object — `trackUserWaits`, a transparent Proxy an embedder makes — defines
 * it there, and every wrapper over that object reads the same key.
 *
 * The key is the object's own: read from its own property table, never through its prototype
 * chain, so two host UIs made from one prototype (`Object.create(parent)`) are two keys even once
 * the prototype has one. A host UI that cannot take a key — one made non-extensible, such as the
 * frozen no-UI object every runner without a UI shares — is keyed by its identity: through a
 * `trackUserWaits` wrapper, the identity of the UI it wraps ({@link hostUIOf}). A frozen UI takes
 * that path only untracked, handed to a runner with no user-wait tracker: the Proxy invariant
 * forbids `trackUserWaits` answering a frozen UI's members with wrappers, so one cannot be tracked.
 *
 * What no key can see through is a wrapper that leaves no trace on the host: an object that
 * forwards by copying its members — `{ ...hostUI, setStatus: hostUI.setStatus.bind(hostUI) }` —
 * or a Proxy over a host that cannot take a key (one that is not extensible: frozen, sealed, or
 * made so with `Object.preventExtensions`), one per runner. Nothing on such a
 * wrapper names the host behind it — a bound function's target and a Proxy's target are not
 * observable — and the members it shares with the host are shared just as much by unrelated UIs
 * made from the same base, which must stay apart (the `Object.create(parent)` case above). Such a
 * wrapper is a host UI of its own here, and a session's end clears what it set through it, logging
 * that it did when another live session holds the slot elsewhere ({@link warnIfHeldElsewhere}). That is
 * the embedder's contract (docs/sdk.md): two runners writing to one UI are handed the same object,
 * or a transparent Proxy over an object that can take a key — one that is extensible.
 *
 * Nothing else can be right for such a wrapper. Session A set a slot through one wrapper, session
 * B set it later through another, and A ends: over one host A must not clear, over two it must.
 * The only writes that satisfy both — clear through A's wrapper, then set B's again — make B's
 * host do B's setting twice, and a setter is not an assignment: the host's widget slot disposes
 * the component B's factory made and makes a new one, losing what it held. So a session's end
 * writes nothing but its own withdrawal, and only where it still holds the slot.
 */
function hostUIKey(ui: ExtensionUIContext): object {
	const own: unknown = Reflect.getOwnPropertyDescriptor(ui, HOST_UI_KEY)?.value;
	if (typeof own === "object" && own !== null) return own;
	const key = {};
	return Reflect.defineProperty(ui, HOST_UI_KEY, { value: key }) ? key : hostUIOf(ui);
}

/**
 * The UI as an extension's context hands it. The host's approval prompts go through its own UI
 * object, never this one, so nothing an extension does to what it was handed decides an approval.
 * `scope` is the session's renderer scope, which a factory or handler the extension passes runs in.
 *
 * What a session sets on the host's UI — a footer, a header, a working message, a status, the
 * title, a widget, an editor — is its own, as what it registers is: when the session ends it is
 * taken back, as a registration is withdrawn (`whenSessionEnds`), unless another session has set
 * that slot since. The next session does not inherit a gone session's strings, and a gone session
 * need not clear them: its own `setWorkingMessage(undefined)` refuses, as every member of it does.
 */
export function handUIContext(
	ui: ExtensionUIContext,
	owner: ExtensionCallbackOwner,
	scope: ToolRendererScope,
): ExtensionUIContext {
	const subject = "ctx.ui";
	const dialog = (value: ExtensionUIDialogOptions | undefined): ExtensionUIDialogOptions | undefined =>
		value === undefined
			? undefined
			: copiedIn(owner, () => {
					const copy = snapshotAuthorData(
						value,
						DIALOG_OPTIONS,
						site(subject, "dialogOptions"),
						new Map(),
					) as ExtensionUIDialogOptions;
					return {
						...copy,
						signal: followSignal(copy.signal, subject, "dialogOptions.signal"),
						onTimeout: owned(owner, copy.onTimeout),
						onTimeoutStart: owned(owner, copy.onTimeoutStart),
						onTimeoutReset: owned(owner, copy.onTimeoutReset),
						onLeft: owned(owner, copy.onLeft),
						onRight: owned(owner, copy.onRight),
						onExternalEditor: owned(owner, copy.onExternalEditor),
					};
				});
	/** The extension's `factory`, as the host calls it: in the renderer scope of the session that
	 *  handed it over (`pinInputScope`), nothing once that session has gone — even when the runtime
	 *  already serves the next one, since a factory one session registered is that session's — and
	 *  carrying that scope for the host that mounts or drives what it returns. `hand` turns what the
	 *  host passes into what the factory is handed — the TUI, the theme, the keybindings, the
	 *  provider it wraps, each as the session's own — before the factory runs.
	 *
	 *  A factory another session's `ctx.ui` already pinned keeps that lifetime as it crosses this
	 *  one: it runs, and what it returns takes input, only while both sessions are live, in the
	 *  scope of the session whose code it is. Rewrapping never transfers a component's ownership. */
	const scoped = <F extends (...args: never[]) => unknown>(
		factory: F,
		hand: (...args: Parameters<F>) => Parameters<F>,
	): F => {
		const own = pinInputScope(scope);
		const inner = toolRendererScope(factory);
		const session = inner === undefined || inner === own ? own : bothScopes(own, inner);
		const run = (...args: Parameters<F>): unknown => {
			if (!session.live) return undefined;
			const handed = hand(...args);
			return session.run(() => Reflect.apply(factory, undefined, handed));
		};
		return Object.assign(run, { rendererScope: session }) as unknown as F;
	};
	const optionalScoped = <F extends (...args: never[]) => unknown>(
		factory: F | undefined,
		hand: (...args: Parameters<F>) => Parameters<F>,
	) => (typeof factory === "function" ? scoped(factory, hand) : undefined);
	const handedTUI = (tui: TUI): TUI => handTUI(tui, owner, scope);
	const handedTheme = (theme: Theme): Theme => (theme === undefined ? theme : handTheme(theme));
	/** A widget's, a footer's and a header's factory: the TUI and the theme, each the session's. */
	const component = (tui: TUI, theme: Theme): [TUI, Theme] => [handedTUI(tui), handedTheme(theme)];
	/** What a member installing a callback is handed: a function, or the member refuses rather than
	 *  install something the host fails on when it calls it. */
	const callable = <F>(value: F, member: string): F => {
		if (typeof value !== "function") throw new Error(`${subject}: ${member} takes a function.`);
		return value;
	};
	/** Each editor factory this session installed, by the wrapper the host holds: what
	 *  `getEditorComponent` hands back, through whichever of the session's facades asks. */
	const editorFactories = editorFactoriesOf(owner);
	const hostUI = hostUIKey(ui);
	let slots = uiSlots.get(hostUI);
	if (!slots) {
		slots = { held: new Map(), setting: new Map() };
		uiSlots.set(hostUI, slots);
	}
	const { held, setting } = slots;
	const here = slots;
	/** `holder` holds `slot` on this host UI, as {@link slotHolders} indexes it. */
	const hold = (slot: string, holder: ExtensionCallbackOwner): void => {
		held.set(slot, holder);
		let uis = slotHolders.get(slot);
		if (!uis) {
			uis = new Set();
			slotHolders.set(slot, uis);
		}
		uis.add(here);
	};
	/** Nobody holds `slot` on this host UI any more. */
	const release = (slot: string): void => {
		held.delete(slot);
		const uis = slotHolders.get(slot);
		uis?.delete(here);
		if (uis?.size === 0) slotHolders.delete(slot);
	};
	/** This session's end takes `slot` back with `clear`. */
	const withdraw = (slot: string, clear: () => void): void => {
		release(slot);
		warnIfHeldElsewhere(slot, here, owner);
		clear();
	};
	/** The slots this facade takes back when its session ends: one withdrawal each. */
	const withdrawing = new Set<string>();
	/** The session sets `slot` on the host's UI with `set`, or clears it: a slot it set is taken
	 *  back with `clear` when it ends, unless a session's setting of the slot has taken since.
	 *
	 *  The host's setter is the host's code, and it can end a session, throw, or call another
	 *  session's setter before it returns, so who holds the slot follows what the setter did:
	 *
	 *  - The session holds the slot, and its withdrawal is registered, before the setter runs: a
	 *    setter that ends the previous holder finds the slot already this session's, and the end
	 *    leaves the value being set.
	 *  - A setter that throws has not said whether it wrote. The slot goes back to the live session
	 *    that held it, whose value the host may still show; with none, it stays with this session,
	 *    whose value the host may show, so this session's end takes it back.
	 *  - A session that ends inside its own setter has had its withdrawal run before the setter
	 *    wrote: the withdrawal is made again once the setter returns, so the value it wrote goes.
	 *  - Another session's setting of the same slot, made from inside this one's setter, is refused:
	 *    the host alone knows whether its own write lands before or after the nested one, and
	 *    guessing either way leaves a gone session's value showing or clears a live one's. */
	const holds = (slot: string, clearing: boolean, set: () => void, clear: () => void): void => {
		const applying = setting.get(slot);
		if (applying !== undefined && applying !== owner) {
			throw new Error(
				`${subject}: "${slot}" was set while the host was still applying another session's setting of it; set it once that setting has returned.`,
			);
		}
		if (clearing) {
			if (held.get(slot) === owner) release(slot);
			set();
			return;
		}
		const previous = held.get(slot);
		hold(slot, owner);
		if (!withdrawing.has(slot)) {
			withdrawing.add(slot);
			owner.whenSessionEnds?.(() => {
				withdrawing.delete(slot);
				if (held.get(slot) !== owner) return;
				withdraw(slot, clear);
			});
		}
		setting.set(slot, owner);
		let took = false;
		try {
			set();
			took = true;
		} finally {
			if (applying === undefined) setting.delete(slot);
			if (!took && held.get(slot) === owner && previous !== undefined && !previous.isRetired) {
				hold(slot, previous);
			}
			const holder = held.get(slot);
			if (owner.isRetired && (holder === undefined || holder === owner)) withdraw(slot, clear);
		}
	};
	const handed: Decided<ExtensionUIContext> = {
		get timeoutStartsOnPresentation() {
			return ui.timeoutStartsOnPresentation;
		},
		get supportsEditor() {
			return ui.supportsEditor;
		},
		select: async (title, options, dialogOptions) =>
			ui.select(text(owner, title), data(owner, options, subject, "options"), dialog(dialogOptions)),
		confirm: async (title, message, dialogOptions) =>
			(await ui.confirm(text(owner, title), text(owner, message), dialog(dialogOptions))) === true,
		// The optional members are read when asked for: a host can offer one later (RPC's
		// `set_ask_dialog`), and an absent one stays absent.
		get openTerminal(): ExtensionUIContext["openTerminal"] {
			const openTerminal = ui.openTerminal;
			return (
				openTerminal &&
				(async request => Reflect.apply(openTerminal, ui, [data(owner, request, subject, "request")]))
			);
		},
		input: async (title, placeholder, dialogOptions) =>
			ui.input(text(owner, title), optionalText(owner, placeholder), dialog(dialogOptions)),
		get askDialog(): ExtensionUIContext["askDialog"] {
			const askDialog = ui.askDialog;
			return (
				askDialog &&
				(async (questions, dialogOptions) =>
					Reflect.apply(askDialog, ui, [data(owner, questions, subject, "questions"), dialog(dialogOptions)]))
			);
		},
		get approve(): ExtensionUIContext["approve"] {
			const approve = ui.approve;
			return (
				approve &&
				(async (prompt, dialogOptions) =>
					Reflect.apply(approve, ui, [data(owner, prompt, subject, "prompt"), dialog(dialogOptions)]))
			);
		},
		notify: (message, type) =>
			ui.notify(text(owner, message), type === undefined ? undefined : data(owner, type, subject, "type")),
		// What the host answers — its way to take the handler off — is the session's call, as every
		// function a member answers with is (`handSessionFacade`).
		onTerminalInput: handler => {
			const listener = callable(handler, "onTerminalInput()");
			return ui.onTerminalInput(
				scoped(
					((input: string) =>
						snapshotAuthorData(
							listener(input),
							DATA,
							site(subject, "onTerminalInput() result"),
							new Map(),
						)) as typeof handler,
					input => [input],
				),
			);
		},
		rerenderMessage: timestamp => ui.rerenderMessage(copiedIn(owner, () => Number(timestamp))),
		getLinkClicksAvailable: () => ui.getLinkClicksAvailable(),
		setStatus: (key, value) => {
			const slot = text(owner, key);
			const shown = optionalText(owner, value);
			holds(
				`status:${slot}`,
				shown === undefined,
				() => ui.setStatus(slot, shown),
				() => ui.setStatus(slot, undefined),
			);
		},
		setWorkingMessage: message => {
			const shown = optionalText(owner, message);
			holds(
				"workingMessage",
				shown === undefined,
				() => ui.setWorkingMessage(shown),
				() => ui.setWorkingMessage(undefined),
			);
		},
		setWidget: (key, content, options) => {
			const slot = text(owner, key);
			const shown =
				typeof content === "function" ? scoped(content, component) : data(owner, content, subject, "content");
			const shownOptions = data(owner, options, subject, "options");
			holds(
				`widget:${slot}`,
				content === undefined,
				() => ui.setWidget(slot, shown, shownOptions),
				() => ui.setWidget(slot, undefined),
			);
		},
		setFooter: factory => {
			const installed = optionalScoped(factory, component);
			holds(
				"footer",
				installed === undefined,
				() => ui.setFooter(installed),
				() => ui.setFooter(undefined),
			);
		},
		setHeader: factory => {
			const installed = optionalScoped(factory, component);
			holds(
				"header",
				installed === undefined,
				() => ui.setHeader(installed),
				() => ui.setHeader(undefined),
			);
		},
		// A blank title releases the extension's claim on the terminal's title, as the host reads it.
		setTitle: title => {
			const shown = text(owner, title);
			holds(
				"title",
				shown.trim() === "",
				() => ui.setTitle(shown),
				() => ui.setTitle(""),
			);
		},
		custom: (factory, options) => {
			// The dialog belongs to the session that opens it: its option callbacks run as that
			// session's work and do nothing once it has gone, even while the runtime serves the next.
			const session = owner.forSession?.() ?? owner;
			const sessionScope = pinInputScope(scope);
			return ui.custom(
				scoped(callable(factory, "custom()"), (tui, theme, keybindings, done) => [
					handedTUI(tui),
					handedTheme(theme),
					handKeybindings(keybindings),
					// What the dialog is done with is the extension's own, and `custom()` hands it back
					// as it is rather than as a copy. That exception is for the value, not for the right
					// to act: finishing the dialog is the host resetting its editor, focus and frame, so it
					// happens only while the session that opened the dialog is live. Once it has gone the
					// host closes the dialog itself (`showHookCustom`), and `done` does nothing.
					result => {
						if (sessionScope.live) done(handAsIs(result));
					},
				]),
				options === undefined
					? undefined
					: copiedIn(session, () => {
							const copy = snapshotAuthorData(
								options,
								CUSTOM_OPTIONS,
								site(subject, "options"),
								new Map(),
							) as ExtensionCustomOptions;
							const overlayOptions = copy.overlayOptions;
							const onHandle = owned(session, copy.onHandle);
							return {
								...copy,
								overlayOptions:
									typeof overlayOptions === "function"
										? owned(session, () =>
												snapshotAuthorData(
													overlayOptions(),
													DATA,
													site(subject, "options.overlayOptions()"),
													new Map(),
												),
											)
										: snapshotAuthorData(
												overlayOptions,
												DATA,
												site(subject, "options.overlayOptions"),
												new Map(),
											),
								// The overlay's handle is the host's: the dialog is handed one of its own.
								onHandle:
									onHandle && ((handle: OverlayHandle) => onHandle(handOverlayHandle(handle, sessionScope))),
								signal: followSignal(copy.signal, subject, "options.signal"),
							} as ExtensionCustomOptions;
						}),
			);
		},
		setEditorText: value => ui.setEditorText(text(owner, value)),
		pasteToEditor: value => ui.pasteToEditor(text(owner, value)),
		getEditorText: () => ui.getEditorText(),
		editor: async (title, prefill, dialogOptions, editorOptions) =>
			ui.editor(
				text(owner, title),
				optionalText(owner, prefill),
				dialog(dialogOptions),
				data(owner, editorOptions, subject, "editorOptions"),
			),
		addAutocompleteProvider: factory =>
			ui.addAutocompleteProvider(
				scoped(callable(factory, "addAutocompleteProvider()"), provider => [
					handAutocompleteProvider(provider, owner),
				]),
			),
		setEditorComponent: factory => {
			// The editor theme is the host's — its symbols, spinner frames included, are module
			// state the next editor reads — so the factory is handed a copy, as `handTheme` copies.
			const installed = optionalScoped<NonNullable<typeof factory>>(factory, (tui, theme, keybindings) => [
				handedTUI(tui),
				copyHostData(theme),
				handKeybindings(keybindings),
			]);
			// The factory is the extension's own: `getEditorComponent` hands it back as it is.
			if (installed && factory) editorFactories.set(installed, handAsIs(factory));
			holds(
				"editor",
				installed === undefined,
				() => ui.setEditorComponent(installed),
				() => ui.setEditorComponent(undefined),
			);
		},
		// What the host installed is its own object — the wrapper this session made, or another
		// extension's, or the host's. An extension reads back only the factory it installed itself.
		getEditorComponent: () => {
			const current = ui.getEditorComponent();
			return current === undefined ? undefined : editorFactories.get(current);
		},
		get theme() {
			return handTheme(ui.theme);
		},
		getAllThemes: async () => ui.getAllThemes(),
		getTheme: async name => {
			const theme = await ui.getTheme(text(owner, name));
			return theme && handTheme(theme);
		},
		// The theme is the whole process's (every session draws in it, and setting one starts the
		// host's theme watcher): a session that has gone sets none.
		setTheme: async theme => {
			const host = copiedIn(owner, () => {
				if (typeof theme === "string") return theme;
				// A theme the host handed out is the host's; any other object would be the extension's
				// code drawing every session.
				const hosts = themesHanded.get(theme);
				if (!hosts) throw new Error(`${subject}: setTheme() takes a theme name, or a theme the host handed you.`);
				return hosts;
			});
			return ui.setTheme(host);
		},
		getToolsExpanded: () => ui.getToolsExpanded(),
		// Expanding redraws every tool block in the live transcript: a session that has gone does not.
		setToolsExpanded: expanded => ui.setToolsExpanded(copiedIn(owner, () => expanded === true)),
	};
	// Every member is the session's host call, refused once it has gone: the one clearing what it
	// installed (`setFooter(undefined)`) and the one reading what the user types now
	// (`getEditorText()`) as surely as the one writing a string. What a member answers is handed by
	// the boundary's one rule: a copy, a facade, or — a function — the session's call.
	return handSessionFacade(handed, owner);
}
