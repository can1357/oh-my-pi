/**
 * Worker-thread halves of the auth bridge: an {@link AuthStorageBackend} whose
 * every namespace call runs on the main thread's `AuthStorage`, and proxies of
 * the main thread's Anthropic slow-mode lanes.
 *
 * Synchronous API methods block on the main thread (`callSync`), async ones
 * `call`, and fire-and-forget mutators `notify` (ordered before any later call
 * on the link). Sync callbacks the main thread would have to invoke are
 * evaluated here first and sent as data (see `./auth-protocol`).
 */
import type {
	AnthropicSlowModeFailure,
	AnthropicSlowModeRetry,
	AnthropicSlowModeSignal,
	ApiKeyResolver,
	AuthAccountPolicy,
	AuthAccountPolicyConfig,
	AuthApiKeyOptions,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialSnapshot,
	AuthCredentialSnapshotEntry,
	AuthCredentialStore,
	AuthPeekOptions,
	AuthSource,
	AuthSourceOptions,
	AuthStorage,
	AuthStorageBackend,
	AuthStorageData,
	BlocksApi,
	CheckCredentialsOptions,
	ClientUsageReport,
	ClientUsageSummary,
	CredentialDisabledEvent,
	CredentialHealthResult,
	CredentialRotation,
	CredentialsApi,
	DisabledCredentialSummary,
	HealthApi,
	InvalidateCredentialMatchingOptions,
	KeysApi,
	LimitsApi,
	ListResetCreditsOptions,
	MarkUsageLimitOptions,
	ModelUsageHealth,
	ModelUsageHealthOptions,
	OAuthAccess,
	OAuthAccessResolution,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthApi,
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
	ResetsApi,
	ResolvedApiKey,
	RotateCredentialOptions,
	SessionRestrictionLease,
	SessionsApi,
	StoredAuthCredential,
	StoredCredentialBlock,
	StoredOAuthRefreshOptions,
	StoredOAuthRefreshResult,
	UsageApi,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimitMarkResult,
	UsageProvider,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { DEFAULT_USAGE_PROVIDERS } from "@oh-my-pi/pi-ai/usage/registry";
import type {
	AnthropicSlowModeAvailability,
	AnthropicSlowModeEndReason,
	AnthropicSlowModeHookOptions,
	AnthropicSlowModeLane,
} from "../../session/anthropic-slow-mode";
import type { UsageLimitState } from "../../session/usage-limit";
import { type RemoteObject, RpcClosedError } from "../rpc";
import type {
	AuthStorageProtocol,
	BaseUrlTable,
	InheritTable,
	ProviderAuthAvailability,
	SlowModeLaneProtocol,
	SlowModeLanesProtocol,
	WireSlowModeHookOptions,
} from "./auth-protocol";

type AuthRemote = RemoteObject<AuthStorageProtocol>;

/**
 * Wrap a main-thread unsubscribe (sync via `rpcSync`): idempotent, and a no-op
 * once the link is closed, because closing dropped the subscription with it.
 */
function remoteUnsubscribe(unsubscribe: () => void): () => void {
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		try {
			unsubscribe();
		} catch (error) {
			if (!(error instanceof RpcClosedError)) throw error;
		}
	};
}

/**
 * Main's auth state of every provider it reports (bundled ones, stored ones, and those asked
 * about here), fetched in one blocking call on first use and kept until it may have changed:
 * a credential generation bump on main, an override set through this worker, a model
 * registry mirror batch, or a new run here ({@link invalidateRemoteAuthAvailability}).
 * Catalog availability asks `keys.source`/`keys.keyless` for every provider of the catalog,
 * and sync callbacks need a provider domain, so one call each would cost a round trip apiece.
 * A provider the table lacks costs one small call for its own entry, kept with the table.
 */
class RemoteAuthAvailability {
	readonly #remote: AuthRemote;
	#table: Map<string, ProviderAuthAvailability> | undefined;
	/** `keys.source` answers for the non-default `env` modes, by `${env}:${provider}`, dropped with the table. */
	readonly #otherSources = new Map<string, AuthSource | undefined>();
	/** Providers that missed the table here; every fetch includes them. */
	readonly #askedProviders = new Set<string>();
	#watchingGenerations = false;

	constructor(remote: AuthRemote) {
		this.#remote = remote;
	}

	/** Drop the table; the next read refetches it. */
	invalidate(): void {
		this.#table = undefined;
		this.#otherSources.clear();
	}

	/** `keys.source(provider, { env })`: the table answers the default mode, other modes cost one call each. */
	source(provider: string, env: NonNullable<AuthSourceOptions["env"]>): AuthSource | undefined {
		if (env === "dedicated") return this.of(provider).source;
		const key = `${env}:${provider}`;
		if (this.#otherSources.has(key)) return this.#otherSources.get(key);
		this.#watchGenerations();
		const source = this.#remote.callSync("keys.source", provider, { env });
		this.#otherSources.set(key, source);
		return source;
	}

	/** `provider`'s entry, asking main about it when the table lacks it. */
	of(provider: string): ProviderAuthAvailability {
		const table = this.#table;
		const cached = table?.get(provider);
		if (cached) return cached;
		this.#askedProviders.add(provider);
		if (table) {
			// A catalog pass meets the providers missing from the table one by one; rebuilding the
			// whole table for each cost main a pass over every provider apiece.
			const entry = this.#remote.callSync("keys.availabilityOf", provider);
			table.set(provider, entry);
			return entry;
		}
		const entry = this.#fetch().get(provider);
		if (!entry) throw new Error(`keys.availability omitted the requested provider ${provider}`);
		return entry;
	}

	/** Every provider in the table: a superset of those with stored credentials. */
	providers(): Iterable<string> {
		return (this.#table ?? this.#fetch()).keys();
	}

	#watchGenerations(): void {
		if (this.#watchingGenerations) return;
		this.#watchingGenerations = true;
		// Lives as long as the worker's view of this storage; the link closing drops it.
		this.#remote.callSync("credentials.onGeneration", () => this.invalidate());
	}

	#fetch(): Map<string, ProviderAuthAvailability> {
		this.#watchGenerations();
		const wire = this.#remote.callSync("keys.availability", [...this.#askedProviders]);
		const table = new Map<string, ProviderAuthAvailability>();
		for (const name in wire) table.set(name, wire[name]);
		this.#table = table;
		return table;
	}
}

/** Providers a main-thread pass may ask a `baseUrlResolver` about: stored ones, built-in usage endpoints, `extra`. */
function resolverDomain(availability: RemoteAuthAvailability, extra?: string): Set<string> {
	const providers = new Set(availability.providers());
	for (const usageProvider of DEFAULT_USAGE_PROVIDERS) providers.add(usageProvider.id);
	if (extra !== undefined) providers.add(extra);
	return providers;
}

/** Evaluate a sync `baseUrlResolver` here so the main thread reads data instead of calling back. */
function baseUrlTable(
	availability: RemoteAuthAvailability,
	resolver: ((provider: Provider) => string | undefined) | undefined,
	extra?: string,
): BaseUrlTable | undefined {
	if (!resolver) return undefined;
	const table: BaseUrlTable = {};
	for (const provider of resolverDomain(availability, extra)) {
		const baseUrl = resolver(provider);
		if (baseUrl !== undefined) table[provider] = baseUrl;
	}
	return table;
}

class RemoteCredentials implements CredentialsApi {
	readonly #remote: AuthRemote;

	constructor(remote: AuthRemote) {
		this.#remote = remote;
	}

	get generation(): number {
		return this.#remote.callSync("credentials.generation");
	}
	onGeneration(listener: (generation: number) => void): () => void {
		return remoteUnsubscribe(this.#remote.callSync("credentials.onGeneration", listener));
	}
	onDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		return remoteUnsubscribe(this.#remote.callSync("credentials.onDisabled", listener));
	}
	reload(): Promise<void> {
		return this.#remote.call("credentials.reload");
	}
	poll(): Promise<boolean> {
		return this.#remote.call("credentials.poll");
	}
	revalidate(): Promise<void> {
		return this.#remote.call("credentials.revalidate");
	}
	get(provider: string): AuthCredential | undefined {
		return this.#remote.callSync("credentials.get", provider);
	}
	all(): AuthStorageData {
		return this.#remote.callSync("credentials.all");
	}
	list(provider?: string): StoredAuthCredential[] {
		return this.#remote.callSync("credentials.list", provider);
	}
	has(provider: string): boolean {
		return this.#remote.callSync("credentials.has", provider);
	}
	hasOAuth(provider: string): boolean {
		return this.#remote.callSync("credentials.hasOAuth", provider);
	}
	getOAuth(provider: string): OAuthCredential | undefined {
		return this.#remote.callSync("credentials.getOAuth", provider);
	}
	set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		return this.#remote.call("credentials.set", provider, credential);
	}
	upsert(provider: string, credential: AuthCredential): Promise<AuthCredentialSnapshotEntry[]> {
		return this.#remote.call("credentials.upsert", provider, credential);
	}
	remove(provider: string): Promise<void> {
		return this.#remote.call("credentials.remove", provider);
	}
	removeById(provider: string, credentialId: number): Promise<boolean> {
		return this.#remote.call("credentials.removeById", provider, credentialId);
	}
	disable(id: number, disabledCause: string): Promise<boolean> {
		return this.#remote.call("credentials.disable", id, disabledCause);
	}
	listDisabled(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]> {
		return this.#remote.call("credentials.listDisabled", provider, signal);
	}
	snapshot(): AuthCredentialSnapshot {
		return this.#remote.callSync("credentials.snapshot");
	}
}

/** Keys namespace of a worker `AuthStorage`; `source` and `keyless` read {@link RemoteAuthAvailability}. */
class RemoteKeys implements KeysApi {
	readonly #remote: AuthRemote;
	readonly #availability: RemoteAuthAvailability;

	constructor(remote: AuthRemote, availability: RemoteAuthAvailability) {
		this.#remote = remote;
		this.#availability = availability;
	}

	/** Drop the cached auth availability; the next read refetches it from main. */
	invalidate(): void {
		this.#availability.invalidate();
	}

	get(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		return this.#remote.call("keys.get", provider, sessionId, options);
	}
	prefetchUsage(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<void> {
		return this.#remote.call("keys.prefetchUsage", provider, sessionId, options);
	}
	getWithCredential(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined> {
		return this.#remote.call("keys.getWithCredential", provider, sessionId, options);
	}
	peek(provider: string, options?: AuthPeekOptions): Promise<string | undefined> {
		return this.#remote.call("keys.peek", provider, options);
	}
	source(provider: string, options?: AuthSourceOptions): AuthSource | undefined {
		return this.#availability.source(provider, options?.env ?? "dedicated");
	}
	keyless(provider: string): boolean {
		return this.#availability.of(provider).keyless;
	}
	describe(provider: string, sessionId?: string): string | undefined {
		return this.#remote.callSync("keys.describe", provider, sessionId);
	}
	setRuntime(provider: string, apiKey: string): void {
		this.invalidate();
		this.#remote.notify("keys.setRuntime", provider, apiKey);
	}
	removeRuntime(provider: string): void {
		this.invalidate();
		this.#remote.notify("keys.removeRuntime", provider);
	}
	setConfig(provider: string, apiKeyConfig: string, options?: { fallback?: boolean }): void {
		this.invalidate();
		this.#remote.notify("keys.setConfig", provider, apiKeyConfig, options);
	}
	removeConfig(provider: string): void {
		this.invalidate();
		this.#remote.notify("keys.removeConfig", provider);
	}
	clearConfig(): void {
		this.invalidate();
		this.#remote.notify("keys.clearConfig");
	}
	setResolver(resolver: (config: string) => Promise<string | undefined>): void {
		this.#remote.notify("keys.setResolver", resolver);
	}
	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver {
		return this.#remote.callSync("keys.resolver", provider, options);
	}
}

class RemoteOAuth implements OAuthApi {
	readonly #remote: AuthRemote;
	readonly #availability: RemoteAuthAvailability;

	constructor(remote: AuthRemote, availability: RemoteAuthAvailability) {
		this.#remote = remote;
		this.#availability = availability;
	}

	async login(provider: OAuthProviderId, ctrl: OAuthLoginController): Promise<OAuthLoginIdentity | undefined> {
		// A fetch override answers with `Response` objects, which cannot cross threads.
		if (ctrl.fetch) throw new Error("OAuth login with a custom fetch must run on the main thread");
		return this.#remote.call("oauth.login", provider, ctrl);
	}
	access(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<OAuthAccess | undefined> {
		return this.#remote.call("oauth.access", provider, sessionId, options);
	}
	accessAll(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]> {
		return this.#remote.call("oauth.accessAll", provider, options);
	}
	accessById(
		provider: string,
		credentialId: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		return this.#remote.call("oauth.accessById", provider, credentialId, options);
	}
	accounts(provider: string, sessionId?: string): OAuthAccountSummary[] {
		return this.#remote.callSync("oauth.accounts", provider, sessionId);
	}
	identity(provider: string, sessionId?: string): OAuthAccountIdentity | undefined {
		// Read once per assistant turn; without a stored OAuth credential main answers `undefined`.
		if (!this.#availability.of(provider).oauth) return undefined;
		return this.#remote.callSync("oauth.identity", provider, sessionId);
	}
	policy(provider: string, identity: OAuthAccountIdentity): AuthAccountPolicy | undefined {
		return this.#remote.callSync("oauth.policy", provider, identity);
	}
	refresh(id: number, signal?: AbortSignal, options?: OAuthRefreshByIdOptions): Promise<AuthCredentialSnapshotEntry> {
		return this.#remote.call("oauth.refresh", id, signal, options);
	}
	/**
	 * Refused: the refresher calls `credentialFromRow`, `canRefresh`, and the other
	 * hooks synchronously on the thread that owns the store, and a worker's
	 * functions answer the main thread only asynchronously.
	 */
	async refreshStored<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		_options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		throw new Error(
			`oauth.refreshStored(${provider}) takes synchronous hooks and must run on the main thread, not a subagent worker`,
		);
	}
}

/** Worker-side record of one `sessions.restrict` lease; the main thread holds the real lease. */
interface RemoteLease {
	readonly id: number;
	readonly provider: string;
	readonly sessionId: string;
}

class RemoteSessions implements SessionsApi {
	readonly #remote: AuthRemote;
	readonly #availability: RemoteAuthAvailability;
	readonly #leases = new Map<SessionRestrictionLease, RemoteLease>();

	constructor(remote: AuthRemote, availability: RemoteAuthAvailability) {
		this.#remote = remote;
		this.#availability = availability;
	}

	pin(provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }): boolean {
		return this.#remote.callSync("sessions.pin", provider, sessionId, credentialId, options);
	}
	inherit(
		sourceSessionId: string,
		targetSessionId: string,
		include?: (provider: string, explicit: boolean) => boolean,
	): number {
		let table: InheritTable | undefined;
		if (include) {
			table = {};
			// Main consults the table for stored providers only; the availability domain covers them.
			for (const provider of this.#availability.providers()) {
				table[provider] = [include(provider, false), include(provider, true)];
			}
		}
		return this.#remote.callSync("sessions.inherit", sourceSessionId, targetSessionId, table);
	}
	restrict(provider: string, sessionId: string, identityKeys: readonly string[]): SessionRestrictionLease {
		const id = this.#remote.callSync("sessions.restrict", provider, sessionId, identityKeys);
		const lease: SessionRestrictionLease = Symbol(`restrict:${provider}:${sessionId}`);
		this.#leases.set(lease, { id, provider, sessionId });
		return lease;
	}
	unrestrict(provider: string, sessionId: string, lease: SessionRestrictionLease): void {
		const entry = this.#leases.get(lease);
		if (!entry) return;
		// Mirrors the main side: a call naming another session leaves the lease usable.
		if (entry.provider === provider && entry.sessionId === sessionId) this.#leases.delete(lease);
		this.#remote.notify("sessions.unrestrict", provider, sessionId, entry.id);
	}
	permits(provider: string, sessionId: string, credentialId: number): boolean {
		return this.#remote.callSync("sessions.permits", provider, sessionId, credentialId);
	}
	release(provider: string, sessionId: string): boolean {
		return this.#remote.callSync("sessions.release", provider, sessionId);
	}
}

class RemoteUsage implements UsageApi {
	readonly #remote: AuthRemote;
	readonly #availability: RemoteAuthAvailability;

	constructor(remote: AuthRemote, availability: RemoteAuthAvailability) {
		this.#remote = remote;
		this.#availability = availability;
	}

	reports(options?: {
		provider?: Provider;
		baseUrlResolver?: (provider: Provider) => string | undefined;
		signal?: AbortSignal;
	}): Promise<UsageReport[] | null> {
		return this.#remote.call("usage.reports", {
			provider: options?.provider,
			signal: options?.signal,
			baseUrls: baseUrlTable(this.#availability, options?.baseUrlResolver, options?.provider),
		});
	}
	ingestHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string; responseStatus?: number },
	): boolean {
		// Once per response; without a stored OAuth credential main ingests nothing.
		if (!this.#availability.of(provider).oauth) return false;
		return this.#remote.callSync("usage.ingestHeaders", provider, headers, options);
	}
	invalidate(provider?: string, signal?: AbortSignal): Promise<void> {
		return this.#remote.call("usage.invalidate", provider, signal);
	}
	history(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#remote.callSync("usage.history", query);
	}
	observe(entry: ObservedUsageInput): void {
		this.#remote.notify("usage.observe", entry);
	}
	recordClient(report: ClientUsageReport): boolean {
		return this.#remote.callSync("usage.recordClient", report);
	}
	clientSummary(sinceMs: number): ClientUsageSummary {
		return this.#remote.callSync("usage.clientSummary", sinceMs);
	}
	providerFor(provider: Provider): UsageProvider | undefined {
		return this.#remote.callSync("usage.providerFor", provider);
	}
	reportingModelIds(provider: Provider, modelIds: readonly string[], reports: readonly UsageReport[]): string[] {
		return this.#remote.callSync("usage.reportingModelIds", provider, modelIds, reports);
	}
	setProvider(provider: Provider, usageProvider: UsageProvider, apiKey?: string): void {
		// The main thread calls these hooks synchronously while ranking and ingesting headers.
		if (usageProvider.parseRateLimitHeaders || usageProvider.supports) {
			throw new Error(
				`Usage provider ${provider} has synchronous hooks and must be registered on the main thread, not a subagent worker`,
			);
		}
		this.#remote.notify("usage.setProvider", provider, usageProvider, apiKey);
	}
	removeProvider(provider: Provider): void {
		this.#remote.notify("usage.removeProvider", provider);
	}
}

class RemoteHealth implements HealthApi {
	readonly #remote: AuthRemote;
	readonly #availability: RemoteAuthAvailability;

	constructor(remote: AuthRemote, availability: RemoteAuthAvailability) {
		this.#remote = remote;
		this.#availability = availability;
	}

	model(provider: Provider, options: ModelUsageHealthOptions): Promise<ModelUsageHealth> {
		return this.#remote.call("health.model", provider, options);
	}
	check(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		if (!options) return this.#remote.call("health.check", undefined);
		const { baseUrlResolver, ...rest } = options;
		return this.#remote.call("health.check", {
			...rest,
			baseUrls: baseUrlTable(this.#availability, baseUrlResolver),
		});
	}
}

class RemoteLimits implements LimitsApi {
	readonly #remote: AuthRemote;

	constructor(remote: AuthRemote) {
		this.#remote = remote;
	}

	markReached(
		provider: string,
		sessionId: string | undefined,
		options?: MarkUsageLimitOptions,
	): Promise<UsageLimitMarkResult> {
		return this.#remote.call("limits.markReached", provider, sessionId, options);
	}
	rotate(
		provider: string,
		sessionId: string | undefined,
		options?: RotateCredentialOptions,
	): Promise<CredentialRotation> {
		return this.#remote.call("limits.rotate", provider, sessionId, options);
	}
	invalidateMatching(
		provider: string,
		apiKey: string,
		options?: InvalidateCredentialMatchingOptions,
	): Promise<boolean> {
		return this.#remote.call("limits.invalidateMatching", provider, apiKey, options);
	}
}

class RemoteResets implements ResetsApi {
	readonly #remote: AuthRemote;
	readonly #availability: RemoteAuthAvailability;

	constructor(remote: AuthRemote, availability: RemoteAuthAvailability) {
		this.#remote = remote;
		this.#availability = availability;
	}

	list(options?: ListResetCreditsOptions): Promise<ResetCreditAccountStatus[]> {
		if (!options) return this.#remote.call("resets.list", undefined);
		const { baseUrlResolver, ...rest } = options;
		return this.#remote.call("resets.list", {
			...rest,
			baseUrls: baseUrlTable(this.#availability, baseUrlResolver, options.provider),
		});
	}
	redeem(options: RedeemResetCreditOptions): Promise<ResetCreditRedeemOutcome> {
		const { baseUrlResolver, ...rest } = options;
		return this.#remote.call("resets.redeem", {
			...rest,
			baseUrls: baseUrlTable(this.#availability, baseUrlResolver, options.target.provider),
		});
	}
}

class RemoteBlocks implements BlocksApi {
	readonly #remote: AuthRemote;

	constructor(remote: AuthRemote) {
		this.#remote = remote;
	}

	list(credentialIds: readonly number[]): StoredCredentialBlock[] {
		return this.#remote.callSync("blocks.list", credentialIds);
	}
	upsert(block: StoredCredentialBlock): void {
		this.#remote.notify("blocks.upsert", block);
	}
	delete(credentialId: number, providerKey: string, blockScope: string): void {
		this.#remote.notify("blocks.delete", credentialId, providerKey, blockScope);
	}
	deleteAll(credentialId: number): void {
		this.#remote.notify("blocks.deleteAll", credentialId);
	}
}

/**
 * Backend of a worker thread's `AuthStorage`: every namespace runs on the main
 * thread's instance, so pins, restrictions, refresh single-flight, round-robin,
 * and block/usage caches have one owner. The store's lifetime belongs to the
 * main thread: {@link replaceStore} is refused and {@link close} is a no-op.
 */
export class RemoteAuthStorageBackend implements AuthStorageBackend {
	readonly credentials: CredentialsApi;
	readonly keys: KeysApi;
	readonly oauth: OAuthApi;
	readonly sessions: SessionsApi;
	readonly usage: UsageApi;
	readonly health: HealthApi;
	readonly limits: LimitsApi;
	readonly resets: ResetsApi;
	readonly blocks: BlocksApi;
	readonly #remote: AuthRemote;

	constructor(remote: AuthRemote) {
		this.#remote = remote;
		const availability = new RemoteAuthAvailability(remote);
		this.credentials = new RemoteCredentials(remote);
		this.keys = new RemoteKeys(remote, availability);
		this.oauth = new RemoteOAuth(remote, availability);
		this.sessions = new RemoteSessions(remote, availability);
		this.usage = new RemoteUsage(remote, availability);
		this.health = new RemoteHealth(remote, availability);
		this.limits = new RemoteLimits(remote);
		this.resets = new RemoteResets(remote, availability);
		this.blocks = new RemoteBlocks(remote);
	}

	setAccountPolicies(config: AuthAccountPolicyConfig): void {
		this.#remote.callSync("setAccountPolicies", config);
	}

	async replaceStore(store: AuthCredentialStore): Promise<void> {
		// Contract on failure: the offered store is closed, the current one stays active.
		store.close();
		throw new Error("AuthStorage.replaceStore must run on the main thread, which owns the credential store");
	}

	close(): void {
		// The main thread owns the store; a worker dropping its view must not close it.
	}
}

/**
 * Drop the worker-side auth availability table of `storage` (a worker `AuthStorage`; any other
 * is left alone), so its next `keys.source`/`keys.keyless` reads main's current state.
 */
export function invalidateRemoteAuthAvailability(storage: AuthStorage): void {
	const keys = storage.keys;
	if (keys instanceof RemoteKeys) keys.invalidate();
}

/** Worker proxy of the main thread's lane registry. */
export class RemoteSlowModeLanes {
	readonly #remote: RemoteObject<SlowModeLanesProtocol>;

	constructor(remote: RemoteObject<SlowModeLanesProtocol>) {
		this.#remote = remote;
	}

	/** The main thread's lane for `key` (a {@link RemoteSlowModeLane}). */
	lane(key: string): AnthropicSlowModeLane {
		return this.#remote.callSync("lane", key);
	}
}

/** Read the per-call `lowPriority()` here: the main thread cannot call back synchronously. */
function wireHookOptions(options: AnthropicSlowModeHookOptions): WireSlowModeHookOptions {
	return {
		lowPriority: options.lowPriority?.() ?? true,
		canAutoAccept: options.canAutoAccept,
		notify: options.notify,
	};
}

/** Worker proxy of one main-thread slow-mode lane controller. */
export class RemoteSlowModeLane implements AnthropicSlowModeLane {
	readonly #remote: RemoteObject<SlowModeLaneProtocol>;

	constructor(remote: RemoteObject<SlowModeLaneProtocol>) {
		this.#remote = remote;
	}

	isActive(now?: number): boolean {
		return this.#remote.callSync("isActive", now);
	}
	activeResetsAtSec(now?: number): number | undefined {
		return this.#remote.callSync("activeResetsAtSec", now);
	}
	allowanceLeftPercent(): number | undefined {
		return this.#remote.callSync("allowanceLeftPercent");
	}
	wrapUpHintKey(lowPriority: boolean, now?: number): number | undefined {
		return this.#remote.callSync("wrapUpHintKey", lowPriority, now);
	}
	status(now?: number, lowPriority?: boolean): UsageLimitState | undefined {
		return this.#remote.callSync("status", now, lowPriority);
	}
	availability(now?: number): AnthropicSlowModeAvailability {
		return this.#remote.callSync("availability", now);
	}
	accept(now?: number): AnthropicSlowModeAvailability {
		return this.#remote.callSync("accept", now);
	}
	stop(reason: AnthropicSlowModeEndReason, now?: number): boolean {
		return this.#remote.callSync("stop", reason, now);
	}
	reset(): void {
		this.#remote.callSync("reset");
	}
	observe(signal: AnthropicSlowModeSignal, options: AnthropicSlowModeHookOptions): void {
		this.#remote.notify("observe", signal, wireHookOptions(options));
	}
	onFailure(
		failure: AnthropicSlowModeFailure,
		options: AnthropicSlowModeHookOptions,
	): Promise<AnthropicSlowModeRetry | undefined> {
		return this.#remote.call("onFailure", failure, wireHookOptions(options));
	}
}
