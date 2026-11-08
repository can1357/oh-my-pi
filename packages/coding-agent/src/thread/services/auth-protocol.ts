/**
 * Wire protocols of the main-thread auth objects a subagent worker reaches by
 * reference: `AuthStorage` (every namespace method as `"<namespace>.<method>"`),
 * `ModelRegistry` (the worker mirror's subscription to main's runtime state,
 * plus the discovery and refresh calls it runs on main), and the Anthropic
 * slow-mode lane registry and lanes.
 *
 * Inputs the main thread would have to call back synchronously are carried as
 * data instead: a sync `baseUrlResolver` becomes a {@link BaseUrlTable}, the
 * `sessions.inherit` filter an {@link InheritTable}, a slow-mode `lowPriority()`
 * read its value at call time. Session-restriction leases (symbols) cross as
 * numeric ids held in a main-side table.
 */
import type {
	AnthropicSlowModeFailure,
	AnthropicSlowModeRetry,
	AnthropicSlowModeSignal,
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AuthAccountPolicy,
	AuthAccountPolicyConfig,
	AuthApiKeyOptions,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialSnapshot,
	AuthCredentialSnapshotEntry,
	AuthPeekOptions,
	AuthSource,
	AuthSourceOptions,
	AuthStorage,
	AuthStorageData,
	CheckCredentialsOptions,
	Context,
	ClientUsageReport,
	ClientUsageSummary,
	CredentialDisabledEvent,
	CredentialHealthResult,
	CredentialRotation,
	DisabledCredentialSummary,
	InvalidateCredentialMatchingOptions,
	ListResetCreditsOptions,
	MarkUsageLimitOptions,
	Model,
	ModelUsageHealth,
	ModelUsageHealthOptions,
	OAuthAccess,
	OAuthAccessResolution,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthCredential,
	OAuthLoginController,
	OAuthLoginIdentity,
	OAuthProviderId,
	OAuthRefreshByIdOptions,
	ObservedUsageInput,
	Provider,
	RedeemResetCreditOptions,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResolvedApiKey,
	RotateCredentialOptions,
	StoredAuthCredential,
	StoredCredentialBlock,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimitMarkResult,
	UsageProvider,
	UsageReport,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { ModelRefreshStrategy } from "@oh-my-pi/pi-catalog/model-manager";
import type {
	ModelRegistryMirrorBatch,
	ModelRegistryMirrorChange,
	ModelRegistryMirrorInputs,
	ModelRegistryRefreshOptions,
	ProviderConfigInput,
} from "../../config/model-registry";
import type {
	AnthropicSlowModeAvailability,
	AnthropicSlowModeEndReason,
	AnthropicSlowModeHookOptions,
	AnthropicSlowModeLane,
} from "../../session/anthropic-slow-mode";
import type { UsageLimitState } from "../../session/usage-limit";
import type { RpcMethod } from "../rpc";

/** Exported-class kind of `AuthStorage`. */
export const AUTH_STORAGE_KIND = "auth-storage";
/** Exported-class kind of `ModelRegistry`. */
export const MODEL_REGISTRY_KIND = "model-registry";
/** Exported-class kind of the slow-mode lane registry. */
export const SLOW_MODE_LANES_KIND = "anthropic-slow-mode-lanes";
/** Exported-class kind of one slow-mode lane controller. */
export const SLOW_MODE_LANE_KIND = "anthropic-slow-mode-lane";

/** Provider → base URL: a worker's sync `baseUrlResolver`, evaluated before the call. Absent = resolver returned undefined. */
export type BaseUrlTable = Record<string, string>;

/** Provider → `[include when not explicit, include when explicit]`: a worker's `sessions.inherit` filter, evaluated before the call. */
export type InheritTable = Record<string, readonly [boolean, boolean]>;

/**
 * One provider's answers to `keys.source` with the default `env` mode (absent = no auth),
 * `keys.keyless` and `credentials.hasOAuth`.
 */
export interface ProviderAuthAvailability {
	readonly source?: AuthSource;
	readonly keyless: boolean;
	/** Without a stored OAuth credential no session has an OAuth account (`oauth.identity`, `usage.ingestHeaders`). */
	readonly oauth: boolean;
}

/** Provider → {@link ProviderAuthAvailability}, for every provider main reports at once. */
export type AuthAvailabilityTable = Record<string, ProviderAuthAvailability>;

/** `usage.reports` options on the wire. */
export interface WireUsageReportsOptions {
	provider?: Provider;
	baseUrls?: BaseUrlTable;
	signal?: AbortSignal;
}

/** `health.check` options on the wire. */
export type WireCheckCredentialsOptions = Omit<CheckCredentialsOptions, "baseUrlResolver"> & {
	baseUrls?: BaseUrlTable;
};

/** `resets.list` options on the wire. */
export type WireListResetCreditsOptions = Omit<ListResetCreditsOptions, "baseUrlResolver"> & {
	baseUrls?: BaseUrlTable;
};

/** `resets.redeem` options on the wire. */
export type WireRedeemResetCreditOptions = Omit<RedeemResetCreditOptions, "baseUrlResolver"> & {
	baseUrls?: BaseUrlTable;
};

/** Every `AuthStorage` call a worker forwards to the main thread's instance. */
export type AuthStorageProtocol = {
	"credentials.generation": RpcMethod<[], number>;
	/** Returns a sync unsubscribe (`rpcSync`). */
	"credentials.onGeneration": RpcMethod<[listener: (generation: number) => void], () => void>;
	/** Returns a sync unsubscribe (`rpcSync`). */
	"credentials.onDisabled": RpcMethod<
		[listener: (event: CredentialDisabledEvent) => void | Promise<void>],
		() => void
	>;
	"credentials.reload": RpcMethod<[], void>;
	"credentials.poll": RpcMethod<[], boolean>;
	"credentials.revalidate": RpcMethod<[], void>;
	"credentials.get": RpcMethod<[provider: string], AuthCredential | undefined>;
	"credentials.all": RpcMethod<[], AuthStorageData>;
	"credentials.list": RpcMethod<[provider?: string], StoredAuthCredential[]>;
	"credentials.has": RpcMethod<[provider: string], boolean>;
	"credentials.hasOAuth": RpcMethod<[provider: string], boolean>;
	"credentials.hasSubscription": RpcMethod<[provider: string], boolean>;
	"credentials.getOAuth": RpcMethod<[provider: string], OAuthCredential | undefined>;
	"credentials.set": RpcMethod<[provider: string, credential: AuthCredentialEntry], void>;
	"credentials.upsert": RpcMethod<[provider: string, credential: AuthCredential], AuthCredentialSnapshotEntry[]>;
	"credentials.remove": RpcMethod<[provider: string], void>;
	"credentials.removeById": RpcMethod<[provider: string, credentialId: number], boolean>;
	"credentials.disable": RpcMethod<[id: number, disabledCause: string], boolean>;
	"credentials.listDisabled": RpcMethod<[provider?: string, signal?: AbortSignal], DisabledCredentialSummary[]>;
	"credentials.snapshot": RpcMethod<[], AuthCredentialSnapshot>;

	"keys.get": RpcMethod<[provider: string, sessionId?: string, options?: AuthApiKeyOptions], string | undefined>;
	"keys.prefetchUsage": RpcMethod<[provider: string, sessionId?: string, options?: AuthApiKeyOptions], void>;
	"keys.getWithCredential": RpcMethod<
		[provider: string, sessionId?: string, options?: AuthApiKeyOptions],
		ResolvedApiKey | undefined
	>;
	"keys.peek": RpcMethod<[provider: string, options?: AuthPeekOptions], string | undefined>;
	/** `keys.source` with another than the default `env` mode (the availability table holds the default). */
	"keys.source": RpcMethod<[provider: string, options?: AuthSourceOptions], AuthSource | undefined>;
	/**
	 * `keys.source` (default `env` mode) and `keys.keyless` of every bundled provider, every
	 * provider with stored credentials, and `providers`, in one call (a worker caches it).
	 */
	"keys.availability": RpcMethod<[providers: readonly string[]], AuthAvailabilityTable>;
	/** {@link ProviderAuthAvailability} of one provider the cached table lacks. */
	"keys.availabilityOf": RpcMethod<[provider: string], ProviderAuthAvailability>;
	"keys.describe": RpcMethod<[provider: string, sessionId?: string], string | undefined>;
	"keys.setRuntime": RpcMethod<[provider: string, apiKey: string], void>;
	"keys.removeRuntime": RpcMethod<[provider: string], void>;
	"keys.setConfig": RpcMethod<[provider: string, apiKeyConfig: string, options?: { fallback?: boolean }], void>;
	"keys.removeConfig": RpcMethod<[provider: string], void>;
	"keys.clearConfig": RpcMethod<[], void>;
	"keys.setResolver": RpcMethod<[resolver: (config: string) => Promise<string | undefined>], void>;
	"keys.resolver": RpcMethod<
		[provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }],
		ApiKeyResolver
	>;

	"oauth.login": RpcMethod<[provider: OAuthProviderId, ctrl: OAuthLoginController], OAuthLoginIdentity | undefined>;
	"oauth.access": RpcMethod<
		[provider: string, sessionId?: string, options?: AuthApiKeyOptions],
		OAuthAccess | undefined
	>;
	"oauth.accessAll": RpcMethod<[provider: string, options?: AuthApiKeyOptions], OAuthAccessResolution[]>;
	"oauth.accessById": RpcMethod<
		[provider: string, credentialId: number, options?: AuthApiKeyOptions],
		OAuthAccessResolution | undefined
	>;
	"oauth.accounts": RpcMethod<[provider: string, sessionId?: string], OAuthAccountSummary[]>;
	"oauth.identity": RpcMethod<[provider: string, sessionId?: string], OAuthAccountIdentity | undefined>;
	"oauth.policy": RpcMethod<[provider: string, identity: OAuthAccountIdentity], AuthAccountPolicy | undefined>;
	"oauth.refresh": RpcMethod<
		[id: number, signal?: AbortSignal, options?: OAuthRefreshByIdOptions],
		AuthCredentialSnapshotEntry
	>;

	"sessions.pin": RpcMethod<
		[provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }],
		boolean
	>;
	"sessions.inherit": RpcMethod<
		[sourceSessionId: string, targetSessionId: string, include: InheritTable | undefined],
		number
	>;
	/** Returns the lease id; the main thread holds the lease symbol. */
	"sessions.restrict": RpcMethod<[provider: string, sessionId: string, identityKeys: readonly string[]], number>;
	"sessions.unrestrict": RpcMethod<[provider: string, sessionId: string, lease: number], void>;
	"sessions.permits": RpcMethod<[provider: string, sessionId: string, credentialId: number], boolean>;
	"sessions.release": RpcMethod<[provider: string, sessionId: string], boolean>;

	"usage.reports": RpcMethod<[options?: WireUsageReportsOptions], UsageReport[] | null>;
	"usage.ingestHeaders": RpcMethod<
		[
			provider: Provider,
			headers: Record<string, string>,
			options?: { sessionId?: string; baseUrl?: string; responseStatus?: number },
		],
		boolean
	>;
	"usage.invalidate": RpcMethod<[provider?: string, signal?: AbortSignal], void>;
	"usage.history": RpcMethod<[query?: UsageHistoryQuery], UsageHistoryEntry[]>;
	"usage.observe": RpcMethod<[entry: ObservedUsageInput], void>;
	"usage.recordClient": RpcMethod<[report: ClientUsageReport], boolean>;
	"usage.clientSummary": RpcMethod<[sinceMs: number], ClientUsageSummary>;
	/** Sync hooks of the returned provider are `rpcSync` wrappers. */
	"usage.providerFor": RpcMethod<[provider: Provider], UsageProvider | undefined>;
	"usage.reportingModelIds": RpcMethod<
		[provider: Provider, modelIds: readonly string[], reports: readonly UsageReport[]],
		string[]
	>;
	"usage.setProvider": RpcMethod<[provider: Provider, usageProvider: UsageProvider, apiKey?: string], void>;
	"usage.removeProvider": RpcMethod<[provider: Provider], void>;

	"health.model": RpcMethod<[provider: Provider, options: ModelUsageHealthOptions], ModelUsageHealth>;
	"health.check": RpcMethod<[options?: WireCheckCredentialsOptions], CredentialHealthResult[]>;

	"limits.markReached": RpcMethod<
		[provider: string, sessionId: string | undefined, options?: MarkUsageLimitOptions],
		UsageLimitMarkResult
	>;
	"limits.rotate": RpcMethod<
		[provider: string, sessionId: string | undefined, options?: RotateCredentialOptions],
		CredentialRotation
	>;
	"limits.invalidateMatching": RpcMethod<
		[provider: string, apiKey: string, options?: InvalidateCredentialMatchingOptions],
		boolean
	>;

	"resets.list": RpcMethod<[options?: WireListResetCreditsOptions], ResetCreditAccountStatus[]>;
	"resets.redeem": RpcMethod<[options: WireRedeemResetCreditOptions], ResetCreditRedeemOutcome>;

	"blocks.list": RpcMethod<[credentialIds: readonly number[]], StoredCredentialBlock[]>;
	"blocks.upsert": RpcMethod<[block: StoredCredentialBlock], void>;
	"blocks.delete": RpcMethod<[credentialId: number, providerKey: string, blockScope: string], void>;
	"blocks.deleteAll": RpcMethod<[credentialId: number], void>;

	setAccountPolicies: RpcMethod<[config: AuthAccountPolicyConfig], void>;
};

/**
 * A provider's `streamSimple` run on the main thread: it iterates the real
 * stream, hands each event to the worker's `sink` in order, and resolves the
 * stream's final message (undefined when it ended without one). It rejects
 * with the error the stream threw.
 */
export type MainStreamSimple = (
	model: Model<Api>,
	context: Context,
	options: WireStreamOptions | undefined,
	sink: (event: AssistantMessageEvent) => void,
) => Promise<AssistantMessage | undefined>;

/**
 * `ProviderConfigInput` on the wire. `streamSimple` stays on main behind
 * {@link streamOnMain}; `usage` stays on main (main's `AuthStorage` already
 * serves it); OAuth `getApiKey`/`modifyModels` are `rpcSync`.
 */
export interface WireProviderConfig extends Omit<ProviderConfigInput, "streamSimple" | "usage"> {
	streamOnMain?: MainStreamSimple;
}

/**
 * A worker's stream options as a main-side `streamSimple` receives them.
 * `fetch` crosses as {@link WorkerFetch} (main rebuilds a `fetch` over it);
 * `anthropicSlowMode` stays behind, since its synchronous `isActive` cannot be
 * answered by a worker.
 */
export interface WireStreamOptions extends Omit<SimpleStreamOptions, "fetch" | "anthropicSlowMode"> {
	fetchOnWorker?: WorkerFetch;
}

/** A request a main-side provider sends through the worker's `fetch`. */
export interface WireFetchRequest {
	url: string;
	method: string;
	headers: [string, string][];
	body?: Uint8Array;
	redirect: Request["redirect"];
	signal?: AbortSignal;
}

/** The worker response body, one chunk per `read` (undefined once done). */
export interface WireFetchBody {
	read(): Promise<Uint8Array | undefined>;
	cancel(reason?: unknown): Promise<void>;
}

/** A worker `fetch` response as main rebuilds it. */
export interface WireFetchResponse {
	status: number;
	statusText: string;
	headers: [string, string][];
	url: string;
	redirected: boolean;
	body?: WireFetchBody;
}

/** The worker's `fetch`, run for main: resolves the response head; the body streams on demand. */
export type WorkerFetch = (request: WireFetchRequest) => Promise<WireFetchResponse>;

/** A `ModelRegistryMirrorChange` on the wire. */
export type WireMirrorChange =
	| Exclude<ModelRegistryMirrorChange, { kind: "register" }>
	| (Omit<Extract<ModelRegistryMirrorChange, { kind: "register" }>, "config"> & {
			readonly config: WireProviderConfig;
	  });

/** A `ModelRegistryMirrorBatch` on the wire. */
export interface WireMirrorBatch extends Omit<ModelRegistryMirrorBatch, "changes"> {
	readonly changes: readonly WireMirrorChange[];
}

/** What a worker needs to build its mirror of a main-thread `ModelRegistry`. */
export interface ModelRegistryMirrorWire extends ModelRegistryMirrorInputs {
	readonly authStorage: AuthStorage;
	/** Main's runtime state at subscription; later batches go to the subscribed listener. */
	readonly snapshot: WireMirrorBatch;
}

/** Calls a worker's mirror registry makes on the main thread's `ModelRegistry`. */
export type ModelRegistryProtocol = {
	/** Sync: subscribe `listener` to main's change batches (until the worker exits) and return the mirror's inputs. */
	mirror: RpcMethod<[listener: (batch: WireMirrorBatch) => void], ModelRegistryMirrorWire>;
	invalidateCommandConfigs: RpcMethod<[provider?: string], void>;
	refresh: RpcMethod<[strategy: ModelRefreshStrategy, options?: ModelRegistryRefreshOptions], void>;
	refreshProvider: RpcMethod<
		[providerId: string, strategy: ModelRefreshStrategy, options?: ModelRegistryRefreshOptions],
		void
	>;
	refreshDiscoverableProviders: RpcMethod<[providerIds: string[], strategy: ModelRefreshStrategy], void>;
	refreshRuntimeProviders: RpcMethod<[strategy: ModelRefreshStrategy], void>;
	hydrateCredentialScopedModelCaches: RpcMethod<[], void>;
	reapplyModelPolicies: RpcMethod<[], void>;
	refreshInBackground: RpcMethod<[strategy: ModelRefreshStrategy], void>;
	/** Sync. */
	isBackgroundRefreshPending: RpcMethod<[], boolean>;
	awaitBackgroundRefresh: RpcMethod<[], void>;
	refreshIfStale: RpcMethod<[], boolean>;
	awaitInitialBackgroundRefresh: RpcMethod<[signal?: AbortSignal], void>;
};

/** Slow-mode hook options on the wire: `lowPriority()` is read by the caller at call time. */
export interface WireSlowModeHookOptions {
	lowPriority: boolean;
	canAutoAccept?: AnthropicSlowModeHookOptions["canAutoAccept"];
	notify?: AnthropicSlowModeHookOptions["notify"];
}

/** Calls on the main thread's slow-mode lane registry. */
export type SlowModeLanesProtocol = {
	lane: RpcMethod<[key: string], AnthropicSlowModeLane>;
};

/** Calls on one main-thread slow-mode lane controller. */
export type SlowModeLaneProtocol = {
	isActive: RpcMethod<[now?: number], boolean>;
	activeResetsAtSec: RpcMethod<[now?: number], number | undefined>;
	allowanceLeftPercent: RpcMethod<[], number | undefined>;
	wrapUpHintKey: RpcMethod<[lowPriority: boolean, now?: number], number | undefined>;
	status: RpcMethod<[now?: number, lowPriority?: boolean], UsageLimitState | undefined>;
	availability: RpcMethod<[now?: number], AnthropicSlowModeAvailability>;
	accept: RpcMethod<[now?: number], AnthropicSlowModeAvailability>;
	stop: RpcMethod<[reason: AnthropicSlowModeEndReason, now?: number], boolean>;
	reset: RpcMethod<[], void>;
	observe: RpcMethod<[signal: AnthropicSlowModeSignal, options: WireSlowModeHookOptions], void>;
	onFailure: RpcMethod<
		[failure: AnthropicSlowModeFailure, options: WireSlowModeHookOptions],
		AnthropicSlowModeRetry | undefined
	>;
};
