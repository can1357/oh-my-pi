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
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { ToolRendererScope } from "@oh-my-pi/pi-tui/tools/renderer-scope";
import type { ApiKeyResolverModel, ApiKeyResolverOptions } from "../../config/api-key-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { MemoryRuntimeContext } from "../../memory-backend";
import type { ArtifactManager } from "../../session/artifacts";
import type { ReadonlySessionManager } from "../../session/session-manager";
import { type AuthorDataSite, CALLBACK, DATA, fieldsOf, snapshotAuthorData } from "./author-data";
import { copyHostData } from "./boundary-data";
import { copyHandedModel } from "./compact-handler";
import type {
	ExtensionCallbackOwner,
	ExtensionCustomOptions,
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

/** A string argument: as it is when it is one, else converted inside the admission. */
function text(owner: ExtensionCallbackOwner, value: unknown): string {
	return typeof value === "string" ? value : copiedIn(owner, () => String(value));
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
 *  extension passes is copied as `pi.setModel` copies one ({@link copyHandedModel}); every row,
 *  state and header set the registry answers with is a copy. */
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
			copyHostData(registry.getAll(kind === undefined ? undefined : data(owner, kind, subject, "kind"))),
		getAvailableForProviders: (providers, kind) =>
			copyHostData(
				registry.getAvailableForProviders(
					copiedIn(owner, () => new Set(Array.from(providers, provider => String(provider)))),
					kind === undefined ? undefined : data(owner, kind, subject, "kind"),
				),
			),
		getAvailable: kind =>
			copyHostData(registry.getAvailable(kind === undefined ? undefined : data(owner, kind, subject, "kind"))),
		hasConfiguredAuth: row => registry.hasConfiguredAuth(model(row)),
		hasConcreteAuth: provider => registry.hasConcreteAuth(text(owner, provider)),
		hasCommandBackedApiKey: provider => registry.hasCommandBackedApiKey(text(owner, provider)),
		credentialProvenance: provider => registry.credentialProvenance(text(owner, provider)),
		getDiscoverableProviders: () => copyHostData(registry.getDiscoverableProviders()),
		getDiscoveryProviderId: requested => registry.getDiscoveryProviderId(text(owner, requested)),
		hasProvider: provider => registry.hasProvider(text(owner, provider)),
		getProviderDiscoveryState: provider => copyHostData(registry.getProviderDiscoveryState(text(owner, provider))),
		isProviderDiscoveryPending: provider => registry.isProviderDiscoveryPending(text(owner, provider)),
		find: (provider, modelId) => copyHostData(registry.find(text(owner, provider), text(owner, modelId))),
		getProviderModels: provider => copyHostData(registry.getProviderModels(text(owner, provider))),
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
	return handed;
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
	return handed;
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
	return handed;
}

// ---------------------------------------------------------------------------------------------
// ctx.localProtocolOptions, ctx.memory, ctx.sessionModes
// ---------------------------------------------------------------------------------------------

/** `local://` as the host resolves it for this session; the extension calls the host's own
 *  answers and cannot change them. */
export function handLocalProtocolOptions(options: LocalProtocolOptions): LocalProtocolOptions {
	const { getArtifactsDir, getSessionId } = options;
	const handed: Decided<LocalProtocolOptions> = {
		getArtifactsDir: getArtifactsDir && (() => Reflect.apply(getArtifactsDir, options, [])),
		getSessionId: getSessionId && (() => Reflect.apply(getSessionId, options, [])),
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
	return handed;
}

/** The session's built-in mode controls. */
export function handSessionModes(modes: ExtensionSessionModes, owner: ExtensionCallbackOwner): ExtensionSessionModes {
	const handed: Decided<ExtensionSessionModes> = {
		getState: () => copyHostData(modes.getState()),
		set: async request => copyHostData(await modes.set(data(owner, request, "ctx.sessionModes", "request"))),
	};
	return handed;
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
	/** The extension's `factory`, as the host calls it: in the session's renderer scope, with the
	 *  host's theme handed as {@link handTheme} hands it, nothing once the scope has gone, and
	 *  carrying the scope for the host that mounts or drives what it returns. */
	const scoped = <F extends (...args: never[]) => unknown>(factory: F, themeAt?: number): F => {
		const run = (...args: unknown[]): unknown => {
			if (!scope.live) return undefined;
			const handed =
				themeAt === undefined
					? args
					: args.map((arg, index) => (index === themeAt && arg !== undefined ? handTheme(arg as Theme) : arg));
			return scope.run(() => Reflect.apply(factory, undefined, handed));
		};
		return Object.assign(run, { rendererScope: scope }) as unknown as F;
	};
	const optionalScoped = <F extends (...args: never[]) => unknown>(factory: F | undefined, themeAt?: number) =>
		typeof factory === "function" ? scoped(factory, themeAt) : undefined;
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
		onTerminalInput: handler =>
			ui.onTerminalInput(
				scoped(((input: string) =>
					snapshotAuthorData(
						handler(input),
						DATA,
						site(subject, "onTerminalInput() result"),
						new Map(),
					)) as typeof handler),
			),
		rerenderMessage: timestamp => ui.rerenderMessage(copiedIn(owner, () => Number(timestamp))),
		getLinkClicksAvailable: () => ui.getLinkClicksAvailable(),
		setStatus: (key, value) => ui.setStatus(text(owner, key), optionalText(owner, value)),
		setWorkingMessage: message => ui.setWorkingMessage(optionalText(owner, message)),
		setWidget: (key, content, options) =>
			ui.setWidget(
				text(owner, key),
				typeof content === "function" ? scoped(content, 1) : data(owner, content, subject, "content"),
				data(owner, options, subject, "options"),
			),
		setFooter: factory => ui.setFooter(optionalScoped(factory, 1)),
		setHeader: factory => ui.setHeader(optionalScoped(factory, 1)),
		setTitle: title => ui.setTitle(text(owner, title)),
		custom: (factory, options) =>
			ui.custom(
				scoped(factory, 1),
				options === undefined
					? undefined
					: copiedIn(owner, () => {
							const copy = snapshotAuthorData(
								options,
								CUSTOM_OPTIONS,
								site(subject, "options"),
								new Map(),
							) as ExtensionCustomOptions;
							const overlayOptions = copy.overlayOptions;
							return {
								...copy,
								overlayOptions:
									typeof overlayOptions === "function"
										? owned(owner, () =>
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
								onHandle: owned(owner, copy.onHandle),
								signal: followSignal(copy.signal, subject, "options.signal"),
							} as ExtensionCustomOptions;
						}),
			),
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
		addAutocompleteProvider: factory => ui.addAutocompleteProvider(scoped(factory)),
		setEditorComponent: factory => ui.setEditorComponent(optionalScoped(factory)),
		getEditorComponent: () => ui.getEditorComponent(),
		get theme() {
			return handTheme(ui.theme);
		},
		getAllThemes: async () => copyHostData(await ui.getAllThemes()),
		getTheme: async name => {
			const theme = await ui.getTheme(text(owner, name));
			return theme && handTheme(theme);
		},
		setTheme: async theme => {
			if (typeof theme === "string") return copyHostData(await ui.setTheme(theme));
			// A theme the host handed out is the host's; any other object would be the extension's
			// code drawing every session.
			const hosts = themesHanded.get(theme);
			if (!hosts) throw new Error(`${subject}: setTheme() takes a theme name, or a theme the host handed you.`);
			return copyHostData(await ui.setTheme(hosts));
		},
		getToolsExpanded: () => ui.getToolsExpanded(),
		setToolsExpanded: expanded => ui.setToolsExpanded(expanded === true),
	};
	return handed;
}
