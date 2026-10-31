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
 * named list of members: each member calls the host's object, the arguments the extension passes
 * are copied in — inside its session's admission, since a getter on them is its code — and what
 * the host answers is copied out (`copyHostData`). Nothing the extension writes to what it was
 * handed reaches the host, because the host never reads it.
 *
 * Every member of a surface's type is listed (`Decided`), so a member added to the type does not
 * compile until someone says what an extension gets. `ctx.modelRegistry` and the session's
 * artifact manager hand only the members their records mark; the rest stay with the host.
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
import type { ApiKeyResolverModel, ApiKeyResolverOptions } from "../../config/api-key-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { MemoryRuntimeContext } from "../../memory-backend";
import type { ArtifactManager } from "../../session/artifacts";
import type { ReadonlySessionManager } from "../../session/session-manager";
import { type AuthorDataSite, CALLBACK, DATA, fieldsOf, snapshotAuthorData } from "./author-data";
import { copyHostData, fromHostCall, handHostModel, handSessionFacade, sessionHostCall } from "./boundary-data";
import { copyHandedModel } from "./compact-handler";
import type {
	ExtensionCallbackOwner,
	ExtensionContext,
	ExtensionCustomOptions,
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
 *  registry answers with is copied by what a model is ({@link handHostModel}), and every state and
 *  header set it answers with is a copy. */
export function handModelRegistry(registry: ModelRegistry, owner: ExtensionCallbackOwner): ExtensionModelRegistry {
	const subject = "ctx.modelRegistry";
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
		getError: () => copyHostData(registry.getError()),
		contextWindowTiers: target => copyHostData(registry.contextWindowTiers(data(owner, target, subject, "model"))),
		getAll: kind =>
			registry.getAll(kind === undefined ? undefined : data(owner, kind, subject, "kind")).map(handHostModel),
		getAvailableForProviders: (providers, kind) =>
			registry
				.getAvailableForProviders(
					copiedIn(owner, () => new Set(Array.from(providers, provider => String(provider)))),
					kind === undefined ? undefined : data(owner, kind, subject, "kind"),
				)
				.map(handHostModel),
		getAvailable: kind =>
			registry.getAvailable(kind === undefined ? undefined : data(owner, kind, subject, "kind")).map(handHostModel),
		hasConfiguredAuth: row => registry.hasConfiguredAuth(model(row)),
		hasConcreteAuth: provider => registry.hasConcreteAuth(text(owner, provider)),
		hasCommandBackedApiKey: provider => registry.hasCommandBackedApiKey(text(owner, provider)),
		credentialProvenance: provider => registry.credentialProvenance(text(owner, provider)),
		getDiscoverableProviders: () => copyHostData(registry.getDiscoverableProviders()),
		getDiscoveryProviderId: requested => registry.getDiscoveryProviderId(text(owner, requested)),
		hasProvider: provider => registry.hasProvider(text(owner, provider)),
		getProviderDiscoveryState: provider => copyHostData(registry.getProviderDiscoveryState(text(owner, provider))),
		isProviderDiscoveryPending: provider => registry.isProviderDiscoveryPending(text(owner, provider)),
		find: (provider, modelId) => {
			const row = registry.find(text(owner, provider), text(owner, modelId));
			return row && handHostModel(row);
		},
		getProviderModels: provider => registry.getProviderModels(text(owner, provider)).map(handHostModel),
		getProviderBaseUrl: provider => registry.getProviderBaseUrl(text(owner, provider)),
		getProviderHeaders: async provider => copyHostData(await registry.getProviderHeaders(text(owner, provider))),
		resolveModelHeaders: async (row, signal) =>
			copyHostData(await registry.resolveModelHeaders(model(row), followSignal(signal, subject, "signal"))),
		getApiKey: (row, sessionId, options) =>
			registry.getApiKey(model(row), optionalText(owner, sessionId), {
				signal: followSignal(
					options === undefined ? undefined : copiedIn(owner, () => Reflect.get(options, "signal")),
					subject,
					"options.signal",
				),
			}),
		getApiKeyAndHeaders: async row => copyHostData(await registry.getApiKeyAndHeaders(model(row))),
		getApiKeyForProvider: (provider, sessionId, options) =>
			registry.getApiKeyForProvider(text(owner, provider), optionalText(owner, sessionId), authOptions(options)),
		resolver,
		isUsingOAuth: row => registry.isUsingOAuth(model(row)),
		isSelectorSuppressed: selector => registry.isSelectorSuppressed(text(owner, selector)),
	};
	// Every member is the session's host call: refused once it has gone, its failure a copy.
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
		allocatePath: async toolType => copyHostData(await manager.allocatePath(text(owner, toolType))),
		save: (content, toolType) => manager.save(text(owner, content), text(owner, toolType)),
		exists: id => manager.exists(text(owner, id)),
		listFiles: async () => copyHostData(await manager.listFiles()),
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
		allocateArtifactPath: async toolType => copyHostData(await session.allocateArtifactPath(text(owner, toolType))),
		saveArtifact: (content, toolType) => session.saveArtifact(text(owner, content), text(owner, toolType)),
		getArtifactPath: id => session.getArtifactPath(text(owner, id)),
		getLeafId: () => session.getLeafId(),
		getLeafEntry: () => copyHostData(session.getLeafEntry()),
		getEntry: id => copyHostData(session.getEntry(text(owner, id))),
		getLabel: id => session.getLabel(text(owner, id)),
		getBranch: fromId => copyHostData(session.getBranch(optionalText(owner, fromId))),
		getHeader: () => copyHostData(session.getHeader()),
		getEntries: () => copyHostData(session.getEntries()),
		getTree: () => copyHostData(session.getTree()),
		getUsageStatistics: () => copyHostData(session.getUsageStatistics()),
		putBlob: async (blob, options) =>
			copyHostData(await session.putBlob(bytes(blob), data(owner, options, subject, "options"))),
		putBlobSync: (blob, options) =>
			copyHostData(session.putBlobSync(bytes(blob), data(owner, options, subject, "options"))),
	};
	// Every member is the session's host call: refused once it has gone, its failure a copy.
	return handSessionFacade(handed, owner);
}

// ---------------------------------------------------------------------------------------------
// ctx.localProtocolOptions, ctx.memory, ctx.sessionModes
// ---------------------------------------------------------------------------------------------

/** `local://` as the host resolves it for this session; the extension calls the host's own
 *  answers and cannot change them. Each member is read from the host's options when asked for,
 *  so a host that swaps one later is followed, and calling it is the session's host call, refused
 *  once the session has gone; a member the extension assigns replaces it on this object only. */
export function handLocalProtocolOptions(
	options: LocalProtocolOptions,
	owner: ExtensionCallbackOwner,
): LocalProtocolOptions {
	const assigned = new Map<keyof LocalProtocolOptions, unknown>();
	const member = <K extends keyof LocalProtocolOptions>(key: K): LocalProtocolOptions[K] => {
		if (assigned.has(key)) return assigned.get(key) as LocalProtocolOptions[K];
		const host = options[key];
		return (
			host && ((() => sessionHostCall(owner, () => Reflect.apply(host, options, []))) as LocalProtocolOptions[K])
		);
	};
	const handed: Decided<LocalProtocolOptions> = {
		get getArtifactsDir() {
			return member("getArtifactsDir");
		},
		set getArtifactsDir(value) {
			assigned.set("getArtifactsDir", value);
		},
		get getSessionId() {
			return member("getSessionId");
		},
		set getSessionId(value) {
			assigned.set("getSessionId", value);
		},
	};
	return handed;
}

/** The session's memory backend. */
export function handMemory(memory: MemoryRuntimeContext, owner: ExtensionCallbackOwner): MemoryRuntimeContext {
	const subject = "ctx.memory";
	const handed: Decided<MemoryRuntimeContext> = {
		status: async () => copyHostData(await memory.status()),
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
			return copyHostData(await memory.search(text(owner, query), copied));
		},
		save: async input =>
			copyHostData(await memory.save(typeof input === "string" ? input : data(owner, input, subject, "input"))),
	};
	return handSessionFacade(handed, owner);
}

/** The session's built-in mode controls. */
export function handSessionModes(modes: ExtensionSessionModes, owner: ExtensionCallbackOwner): ExtensionSessionModes {
	const handed: Decided<ExtensionSessionModes> = {
		getState: () => copyHostData(modes.getState()),
		set: async request => copyHostData(await modes.set(data(owner, request, "ctx.sessionModes", "request"))),
	};
	return handSessionFacade(handed, owner);
}

// ---------------------------------------------------------------------------------------------
// ctx itself
// ---------------------------------------------------------------------------------------------

/**
 * The members of a context that call no host: they answer from the context itself — what it was
 * made with, the runner's fixed facts — or are facades of their own that refuse member by member,
 * or clear what the extension itself scheduled (`clearTimer`). Every other member is the context's
 * session's host call ({@link handSessionFacade}), refused once that session has gone: `abort`,
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
 * `ctx.startLive` as a session hands it: the options cross as the strings they name and the
 * session's callbacks — inert once it has gone, each handed copies of what the host reports — and
 * the live session comes back as its strings and a `stop`. Ending the call it started stays the
 * extension's to do once its session has gone too: its own peer going away is the only signal the
 * host gets, and a call left open keeps the host's visualizer up for whoever comes next.
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
				const run = owner.ownCallback(value as (...args: unknown[]) => unknown);
				return ((...args: unknown[]) => run(...args.map(arg => copyHostData(arg)))) as unknown as F;
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
		return {
			sdpAnswer: String(live.sdpAnswer),
			voice: String(live.voice),
			stop: () => fromHostCall(() => live.stop()),
		};
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
 * the extension is handed an object of its own whose members call the host's theme. What a member
 * answers is a string, a fresh object or a copy (`spinnerFrames` is a shared array).
 */
export function handTheme(theme: Theme): Theme {
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
		getAllThemeColorHexes: () => copyHostData(theme.getAllThemeColorHexes()),
		getMajorThemeColorHexes: () => copyHostData(theme.getMajorThemeColorHexes()),
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
			return copyHostData(theme.spinnerFrames);
		},
		getSpinnerFrames: type => copyHostData(theme.getSpinnerFrames(type)),
		getLangIcon: lang => theme.getLangIcon(lang),
		getLangIconStyled: lang => theme.getLangIconStyled(lang),
	};
	// `Theme` is a class with private state, so no object the host builds can be one; this object
	// has every public member, and the host code an extension passes it to calls only those.
	const asTheme = handed as unknown as Theme;
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

const INERT_OVERLAY: OverlayHandle = { hide() {}, setHidden() {}, isHidden: () => true };

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
	return handed;
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
 *   the image budget an image draws through ({@link handImageBudget}) — calls the host's TUI;
 * - an input listener, a focus change and an overlay are the session's, made only while its scope
 *   is live and running in it: a listener is taken off the TUI at the first key after the scope
 *   has gone and is never called again; a component the session focuses or shows takes input in
 *   its scope (`bindInputScope`), and once the scope has gone an overlay is taken down and focus
 *   goes back to what the session took it from. A suspension (`stop`) is made only
 *   while the scope is live, and only the session's own suspension can be ended (`start`), at any
 *   time, so a session that went while suspended does not leave the host stopped;
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
			return handle;
		},
		stop: () => {
			if (!scope.live || suspended) return;
			suspended = true;
			tui.stop();
		},
		start: () => {
			if (!suspended) return;
			suspended = false;
			tui.start();
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
	const asTUI = handed as unknown as TUI;
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
	handedTerminals.set(terminal, handed);
	return handed;
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
		getPlacementGeometry: imageId => copyHostData(budget.getPlacementGeometry(Number(imageId))),
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
	const asBudget = handed as unknown as ImageBudget;
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
 * what the host's provider answers is copied out. The optional members are read when asked for.
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
			copyHostData(
				await provider.getSuggestions(
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
			),
		applyCompletion: (text, cursorLine, cursorCol, item, prefix) =>
			copyHostData(
				provider.applyCompletion(
					lines(text),
					number(cursorLine),
					number(cursorCol),
					data(owner, item, subject, "applyCompletion() item"),
					copiedIn(owner, () => String(prefix)),
				),
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
					copyHostData(
						Reflect.apply(trySyncSlashCompletion, provider, [copiedIn(owner, () => String(textBeforeCursor))]),
					))
			);
		},
		get trySyncInlineReplace(): AutocompleteProvider["trySyncInlineReplace"] {
			const trySyncInlineReplace = provider.trySyncInlineReplace;
			return (
				trySyncInlineReplace &&
				(textBeforeCursor =>
					copyHostData(
						Reflect.apply(trySyncInlineReplace, provider, [copiedIn(owner, () => String(textBeforeCursor))]),
					))
			);
		},
		get getForceFileSuggestions(): AutocompleteProvider["getForceFileSuggestions"] {
			const getForceFileSuggestions = provider.getForceFileSuggestions;
			return (
				getForceFileSuggestions &&
				(async (text, cursorLine, cursorCol, signal) =>
					copyHostData(
						await Reflect.apply(getForceFileSuggestions, provider, [
							lines(text),
							number(cursorLine),
							number(cursorCol),
							followSignal(signal, subject, "getForceFileSuggestions() signal"),
						]),
					))
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
	return handed;
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

/**
 * The UI as an extension's context hands it. The host's approval prompts go through its own UI
 * object, never this one, so nothing an extension does to what it was handed decides an approval.
 * `scope` is the session's renderer scope, which a factory or handler the extension passes runs in.
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
	const handed: Decided<ExtensionUIContext> = {
		get timeoutStartsOnPresentation() {
			return ui.timeoutStartsOnPresentation;
		},
		get supportsEditor() {
			return ui.supportsEditor;
		},
		select: async (title, options, dialogOptions) =>
			copyHostData(
				await ui.select(text(owner, title), data(owner, options, subject, "options"), dialog(dialogOptions)),
			),
		confirm: async (title, message, dialogOptions) =>
			(await ui.confirm(text(owner, title), text(owner, message), dialog(dialogOptions))) === true,
		// The optional members are read when asked for: a host can offer one later (RPC's
		// `set_ask_dialog`), and an absent one stays absent.
		get openTerminal(): ExtensionUIContext["openTerminal"] {
			const openTerminal = ui.openTerminal;
			return (
				openTerminal &&
				(async request =>
					copyHostData(await Reflect.apply(openTerminal, ui, [data(owner, request, subject, "request")])))
			);
		},
		input: async (title, placeholder, dialogOptions) =>
			copyHostData(await ui.input(text(owner, title), optionalText(owner, placeholder), dialog(dialogOptions))),
		get askDialog(): ExtensionUIContext["askDialog"] {
			const askDialog = ui.askDialog;
			return (
				askDialog &&
				(async (questions, dialogOptions) =>
					copyHostData(
						await Reflect.apply(askDialog, ui, [
							data(owner, questions, subject, "questions"),
							dialog(dialogOptions),
						]),
					))
			);
		},
		get approve(): ExtensionUIContext["approve"] {
			const approve = ui.approve;
			return (
				approve &&
				(async (prompt, dialogOptions) =>
					copyHostData(
						await Reflect.apply(approve, ui, [data(owner, prompt, subject, "prompt"), dialog(dialogOptions)]),
					))
			);
		},
		notify: (message, type) =>
			ui.notify(text(owner, message), type === undefined ? undefined : data(owner, type, subject, "type")),
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
		setStatus: (key, value) => ui.setStatus(text(owner, key), optionalText(owner, value)),
		setWorkingMessage: message => ui.setWorkingMessage(optionalText(owner, message)),
		setWidget: (key, content, options) =>
			ui.setWidget(
				text(owner, key),
				typeof content === "function" ? scoped(content, component) : data(owner, content, subject, "content"),
				data(owner, options, subject, "options"),
			),
		setFooter: factory => ui.setFooter(optionalScoped(factory, component)),
		setHeader: factory => ui.setHeader(optionalScoped(factory, component)),
		setTitle: title => ui.setTitle(text(owner, title)),
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
					done,
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
			copyHostData(
				await ui.editor(
					text(owner, title),
					optionalText(owner, prefill),
					dialog(dialogOptions),
					data(owner, editorOptions, subject, "editorOptions"),
				),
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
			if (installed && factory) editorFactories.set(installed, factory);
			ui.setEditorComponent(installed);
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
		getAllThemes: async () => copyHostData(await ui.getAllThemes()),
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
			return copyHostData(await ui.setTheme(host));
		},
		getToolsExpanded: () => ui.getToolsExpanded(),
		// Expanding redraws every tool block in the live transcript: a session that has gone does not.
		setToolsExpanded: expanded => ui.setToolsExpanded(copiedIn(owner, () => expanded === true)),
	};
	// Every member is the session's host call, refused once it has gone: the one clearing what it
	// installed (`setFooter(undefined)`) and the one reading what the user types now
	// (`getEditorText()`) as surely as the one writing a string.
	return handSessionFacade(handed, owner);
}
