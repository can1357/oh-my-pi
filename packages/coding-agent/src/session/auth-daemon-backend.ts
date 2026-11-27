/**
 * Session auth served by the daemon-owned credential store.
 *
 * {@link ManagedAuth} is the {@link AuthStorageBackend} behind the `AuthStorage` of a stock
 * session whose auth tunnel is bound. Stored credentials, refresh grants, pins, blocks and
 * usage caches stay in the daemon; this process holds credential metadata only.
 *
 * Stays in the caller:
 * - Runtime, config and environment keys, the config-value resolver, and usage providers
 *   registered at runtime. The daemon learns that a local source exists, never its value.
 * - OAuth login (its callbacks run here) and every operation on providers the daemon does
 *   not serve. Those use the local owner: a real `AuthStorage` on the same store, opened on
 *   first use (see {@link localAuthOwner}, {@link prepareLocalAuthForProviders}).
 * - Usage, health and saved-reset probes against an endpoint the bundled catalog does not list.
 *
 * Never happens:
 * - No local store is opened because binding was refused or the tunnel was lost.
 * - No credential row, snapshot or account pool crosses the tunnel; raw-row getters throw
 *   {@link ManagedAuthUnsupportedError} for daemon-served providers.
 * - No request is sent before the session restrictions it depends on are acknowledged, and a
 *   restricted session never uses a caller-local key.
 * - No session mutation resolves before the daemon acknowledged it, and no request is resent
 *   after a lost tunnel. A new lease serves only after held restrictions and pins are replayed.
 */
import { AccountPolicies } from "@oh-my-pi/pi-ai/auth/policy";
import { usageReportingModelIds } from "@oh-my-pi/pi-ai/auth/usage-report";
import type { AuthAccountPolicyConfig } from "@oh-my-pi/pi-ai/auth-broker/discover";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import {
	type AuthApiKeyOptions,
	type AuthCredentialStore,
	AuthStorage,
	type AuthStorageBackend,
	type BlocksApi,
	type CredentialDisabledEvent,
	type CredentialsApi,
	type DisabledCredentialSummary,
	type HealthApi,
	type KeysApi,
	type LimitsApi,
	type ModelUsageHealth,
	type OAuthAccess,
	type OAuthAccessResolution,
	type OAuthAccountIdentity,
	type OAuthApi,
	type OAuthSignOutResult,
	type ResetCreditAccountStatus,
	type ResetCreditRedeemOutcome,
	type ResetsApi,
	type SessionRestrictionLease,
	type SessionsApi,
	type StoredCredentialSummary,
	summarizeStoredCredential,
	type UsageApi,
} from "@oh-my-pi/pi-ai/auth-storage";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { OAuthRefreshUnavailableError } from "@oh-my-pi/pi-ai/error";
import { providerPauseReason } from "@oh-my-pi/pi-ai/registry";
import type { Provider } from "@oh-my-pi/pi-ai/types";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { DEFAULT_USAGE_PROVIDERS, defaultRankingStrategy, defaultUsageProvider } from "@oh-my-pi/pi-ai/usage/registry";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import {
	AUTH_DAEMON_PROVIDERS,
	type AuthDaemonBinding,
	isAuthDaemonCredentialId,
	isAuthDaemonHttpStatus,
} from "./auth-daemon-contract";
import { type AuthDaemonKeyAvailability, DaemonKeys } from "./auth-daemon-keys";
import { AuthDaemonLimits } from "./auth-daemon-limits";
import { type AuthDaemonLink, openAuthDaemonLink } from "./auth-daemon-link";
import { pickAuthDaemonUsageHeaders } from "./auth-daemon-management";
import type { AuthDaemonMcpAccessResult, AuthDaemonMcpFindResult } from "./auth-daemon-mcp";
import { AuthDaemonMetadata, type AuthDaemonProviderAvailability } from "./auth-daemon-metadata";
import { AuthDaemonSessions } from "./auth-daemon-session-client";

/** The operation needs something a daemon-managed storage does not hold or does not own. */
export class ManagedAuthUnsupportedError extends Error {
	constructor(
		readonly operation: string,
		hint: string,
	) {
		super(`${operation} is not available on daemon-managed auth storage: ${hint}`);
		this.name = "ManagedAuthUnsupportedError";
	}
}

/** A row id was obtained from a credential store this storage is no longer bound to. */
export class ManagedAuthStoreChangedError extends Error {
	constructor() {
		super("The bound credential store changed; look the credential up again");
		this.name = "ManagedAuthStoreChangedError";
	}
}

/** The daemon cannot be reached again after binding. Local credentials are not a fallback. */
export class ManagedAuthUnavailableError extends Error {
	constructor() {
		super("Daemon auth is unavailable; local credentials are not used as a fallback");
		this.name = "ManagedAuthUnavailableError";
	}
}

const RAW_ROWS = "stored rows never leave the daemon; use localAuthOwner() or prepareLocalAuthForProviders()";
const OWNER_SEAM = "this is a store-owner operation; open a locally owned auth storage for it";

function refuse(operation: string, hint: string): never {
	throw new ManagedAuthUnsupportedError(operation, hint);
}

function invalidReply(method: string): never {
	throw new Error(`Invalid daemon auth reply for ${method}`);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rowId(value: unknown, method: string): number {
	return isAuthDaemonCredentialId(value) ? value : invalidReply(method);
}

/** Identifies the credential store of a binding, apart from its routing policy. */
export function authDaemonStoreKey(binding: AuthDaemonBinding): string {
	const { broker } = binding;
	return JSON.stringify([
		binding.dbPath,
		binding.encrypt,
		broker && [broker.url, broker.token, broker.cachePath, broker.ttlMs, broker.accountPool],
	]);
}

function canonicalBaseUrl(value: string): string | undefined {
	const url = URL.parse(value);
	return url ? `${url.origin}${url.pathname.replace(/\/+$/, "")}` : undefined;
}

const catalogBaseUrls = new Map<string, ReadonlySet<string>>();

/** Whether `baseUrl` is one the bundled catalog lists for `provider`; anything else is the caller's endpoint. */
function isCatalogBaseUrl(provider: string, baseUrl: string): boolean {
	let known = catalogBaseUrls.get(provider);
	if (!known) {
		const urls = new Set<string>();
		for (const model of getBundledModels(provider)) {
			const canonical = model.baseUrl ? canonicalBaseUrl(model.baseUrl) : undefined;
			if (canonical) urls.add(canonical);
		}
		catalogBaseUrls.set(provider, (known = urls));
	}
	const canonical = canonicalBaseUrl(baseUrl);
	return canonical !== undefined && known.has(canonical);
}

const READ_ERROR_CATEGORIES = [
	"refresh-unavailable",
	"missing-api-key",
	"selection-failed",
	"unsupported-provider",
	"invalid-recovery",
];

function readErrorCategory(reply: unknown): string | undefined {
	if (!isRecord(reply) || reply.kind !== "error") return undefined;
	return typeof reply.category === "string" && READ_ERROR_CATEGORIES.includes(reply.category)
		? reply.category
		: invalidReply("oauth-access");
}

function parseOAuthAccess(reply: Record<string, unknown>): OAuthAccess & { credentialId: number } {
	const { accessToken, inferenceRegion } = reply;
	if (typeof accessToken !== "string" || !accessToken) invalidReply("oauth-access");
	if (
		inferenceRegion !== undefined &&
		inferenceRegion !== "global" &&
		inferenceRegion !== "eu" &&
		inferenceRegion !== "us"
	) {
		invalidReply("oauth-access");
	}
	return {
		accessToken,
		credentialId: rowId(reply.credentialId, "oauth-access"),
		accountId: text(reply.accountId),
		email: text(reply.email),
		projectId: text(reply.projectId),
		enterpriseUrl: text(reply.enterpriseUrl),
		apiEndpoint: text(reply.apiEndpoint),
		orgId: text(reply.orgId),
		orgName: text(reply.orgName),
		region: text(reply.region),
		inferenceRegion,
	};
}

function parseDisabled(reply: unknown): DisabledCredentialSummary[] {
	if (!Array.isArray(reply)) invalidReply("credentials-list-disabled");
	const rows: DisabledCredentialSummary[] = [];
	for (const row of reply) {
		if (!isRecord(row) || typeof row.provider !== "string" || typeof row.cause !== "string") {
			invalidReply("credentials-list-disabled");
		}
		const { type, disabledAtMs } = row;
		if (type !== "oauth" && type !== "api_key") invalidReply("credentials-list-disabled");
		rows.push({
			id: rowId(row.id, "credentials-list-disabled"),
			provider: row.provider,
			type,
			email: text(row.email),
			accountId: text(row.accountId),
			orgId: text(row.orgId),
			orgName: text(row.orgName),
			cause: row.cause,
			disabledAtMs: typeof disabledAtMs === "number" && Number.isFinite(disabledAtMs) ? disabledAtMs : undefined,
		});
	}
	return rows;
}

const HEALTH_STATES = ["healthy", "reserve", "depleted", "unknown"];
const UNKNOWN_HEALTH: ModelUsageHealth = { state: "unknown", accounts: [] };

function selection(options: AuthApiKeyOptions | undefined, forceRefresh: boolean | undefined) {
	if (!options) return undefined;
	const { modelId, accountIds, serviceTier, serviceTierAccounts, recordAffinity } = options;
	return { modelId, accountIds, serviceTier, serviceTierAccounts, forceRefresh, recordAffinity };
}

/** What is known about any provider while no lease is bound: nothing. */
const NO_CREDENTIALS: AuthDaemonProviderAvailability = Object.freeze({
	has: false,
	hasOAuth: false,
	hasSubscription: false,
	keyless: false,
	keylessCredentialIds: Object.freeze([]),
	credentials: Object.freeze([]),
});

/**
 * The one link the key and limit clients hold. Rebinding swaps the tunnel underneath them, so
 * the caller's key overrides survive a new lease.
 */
class SwitchableLink implements Pick<AuthDaemonLink, "request"> {
	readonly #onLost: () => void;
	#current: AuthDaemonLink;
	#detach: () => void;
	/** The bound tunnel closed. Nothing is sent until a new lease holds the replayed ledger. */
	lost = false;

	constructor(link: AuthDaemonLink, onLost: () => void) {
		this.#onLost = onLost;
		this.#current = link;
		this.#detach = this.#attach(link);
	}

	request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.#current.request(method, params, signal);
	}

	/** Returns the replaced tunnel; the caller closes it. */
	replace(link: AuthDaemonLink): AuthDaemonLink {
		const previous = this.#current;
		this.#detach();
		this.#current = link;
		this.lost = false;
		this.#detach = this.#attach(link);
		return previous;
	}

	close(): void {
		this.#detach();
		this.#current.close();
	}

	/** Discard a lease whose policy acknowledgments can no longer be trusted. */
	disconnect(): void {
		this.#current.close();
	}

	#attach(link: AuthDaemonLink): () => void {
		return link.onClose(() => {
			if (this.#current !== link || this.lost) return;
			this.lost = true;
			queueMicrotask(() => {
				if (this.#current === link && this.lost) this.#onLost();
			});
		});
	}
}

/** One `sessions.restrict` call. The caller's lease stays valid across rebinds and owner reopens. */
interface HeldRestriction {
	readonly provider: string;
	readonly sessionId: string;
	readonly identityKeys: readonly string[];
	readonly lease: SessionRestrictionLease;
	/** Installed on the local owner rather than the daemon lease. */
	local: boolean;
	/** Lease of the current installation; absent while a local owner is not open. */
	inner?: SessionRestrictionLease;
}

/** What this process knows of a session's affinity: enough to show it and to replay it. */
interface HeldAffinity {
	/** Row that last served the session, or the pinned row before any request. */
	credentialId: number;
	/** Row of an explicit user pin. */
	pinned?: number;
	lastUsedAtMs: number;
}

/** Opens and moves the local owner; supplied by the caller, which knows the settings scope. */
export interface ManagedLocalOwnerHooks {
	/** Open a real `AuthStorage` on the store and policies `binding` names. */
	open(binding: AuthDaemonBinding): Promise<AuthStorage>;
	/** Move an open owner from `previous` onto the store and policies of `binding`. */
	retarget(owner: AuthStorage, binding: AuthDaemonBinding, previous: AuthDaemonBinding): Promise<void>;
}

export interface ManagedAuthOptions {
	binding: AuthDaemonBinding;
	/** Bound with `binding`; owned by the storage from here on. */
	link: AuthDaemonLink;
	/** Binds a replacement tunnel on rebind or after a lost one. Default: {@link openAuthDaemonLink}. */
	connect?: (binding: AuthDaemonBinding) => Promise<AuthDaemonLink | undefined>;
	/** Resolves config key references (`!command`, env names) in this process. */
	configValueResolver?: (config: string) => Promise<string | undefined>;
	localOwner: ManagedLocalOwnerHooks;
}

/** A managed MCP grant located in the bound store; `storeEpoch` ties the row id to that store. */
export interface ManagedMcpOAuthMatch extends AuthDaemonMcpFindResult {
	storeEpoch: number;
}

const kManaged = Symbol("auth.managed");
type TaggedAuthStorage = AuthStorage & { [kManaged]?: ManagedAuth };

/** Daemon-backed implementation of every `AuthStorage` namespace; see the module doc. */
export class ManagedAuth implements AuthStorageBackend {
	readonly credentials: CredentialsApi;
	readonly keys: KeysApi;
	readonly oauth: OAuthApi;
	readonly sessions: SessionsApi;
	readonly usage: UsageApi;
	readonly health: HealthApi;
	readonly limits: LimitsApi;
	readonly resets: ResetsApi;
	readonly blocks: BlocksApi;

	readonly #hooks: ManagedLocalOwnerHooks;
	readonly #connect: (binding: AuthDaemonBinding) => Promise<AuthDaemonLink | undefined>;
	readonly #link: SwitchableLink;
	/** Availability read from the bound lease; absent while that lease is lost. */
	#metadata?: AuthDaemonMetadata;
	readonly #keys: DaemonKeys;
	readonly #limits: AuthDaemonLimits;
	#offMetadata: () => void;
	#binding: AuthDaemonBinding;
	#policies: AccountPolicies;
	#sessions: AuthDaemonSessions;
	#storeKey: string;
	#storeEpoch = 0;
	#closed = false;

	// Request barrier: a rebind waits for requests in flight and holds new ones.
	#gate?: Promise<void>;
	#idle?: PromiseWithResolvers<void>;
	#inflight = 0;
	#switching: Promise<void> = Promise.resolve();
	#reconnecting?: Promise<void>;

	// Policy ledger: the only state replayed onto a new lease or a reopened local owner.
	readonly #restrictions = new Map<string, Map<string, HeldRestriction>>();
	#restrictionRevision = 0;
	readonly #affinity = new Map<string, Map<string, HeldAffinity>>();
	/** OAuth access tokens the daemon served, mapped to their row. */
	readonly #bearers = new LRUCache<string, { provider: string; credentialId: number }>({ max: 256 });

	// Credential events.
	#generation = 0;
	readonly #generationListeners = new Set<(generation: number) => void>();
	readonly #disabledListeners = new Set<(event: CredentialDisabledEvent) => void | Promise<void>>();
	#pendingDisabled: CredentialDisabledEvent[] = [];
	#seenDisabled?: Set<number>;
	#disabledScan?: Promise<void>;
	#disabledRescan = false;

	// Caller-owned state, mirrored onto the local owner when it opens.
	#resolver?: (config: string) => Promise<string | undefined>;
	readonly #runtimeKeys = new Map<string, string>();
	readonly #configKeys = new Map<string, { config: string; fallback: boolean }[]>();
	readonly #runtimeUsage = new Map<Provider, { usageProvider: UsageProvider; apiKey?: string }>();
	#configuredUsage: ReadonlyMap<Provider, UsageProvider> = new Map();
	readonly #authRejections = new Map<string, number>();

	// Local owner: opened on first local-only use, never at startup.
	readonly #localProviders = new Set<string>();
	#local?: Promise<AuthStorage>;
	#openedLocal?: AuthStorage;
	#localBinding: AuthDaemonBinding;

	static async open(options: ManagedAuthOptions): Promise<ManagedAuth> {
		let metadata: AuthDaemonMetadata;
		try {
			metadata = await AuthDaemonMetadata.open(options.link);
		} catch (error) {
			options.link.close();
			throw error;
		}
		return new ManagedAuth(options, metadata);
	}

	private constructor(options: ManagedAuthOptions, metadata: AuthDaemonMetadata) {
		const { binding } = options;
		this.#hooks = options.localOwner;
		this.#connect = options.connect ?? openAuthDaemonLink;
		this.#metadata = metadata;
		this.#offMetadata = metadata.onGeneration(() => this.#bump());
		const link = new SwitchableLink(options.link, () => this.#onLost());
		this.#link = link;
		this.#binding = this.#localBinding = binding;
		this.#policies = new AccountPolicies(binding.accountPolicies, binding.defaultReservePct);
		this.#sessions = new AuthDaemonSessions(options.link);
		this.#storeKey = authDaemonStoreKey(binding);
		this.#limits = new AuthDaemonLimits({
			link,
			beforeRequest: run => this.#dispatch(run),
			resolutionHandle: (provider, sessionId, apiKey) => this.#keys.resolutionHandle(provider, sessionId, apiKey),
		});
		this.#keys = new DaemonKeys({
			link,
			availabilityLookup: (provider, sessionId) => this.#availability(provider, sessionId),
			isRestricted: (provider, sessionId) => this.#isRestricted(provider, sessionId),
			beforeRequest: run => this.#dispatch(run),
			isServiceTierRefused: (provider, serviceTier, modelId) =>
				this.#limits.localServiceTierRefused(provider, serviceTier, modelId),
			onServed: (provider, sessionId, resolved, recordAffinity) =>
				this.#noteServed(provider, sessionId, resolved.credentialId, resolved.oauthAccess, recordAffinity),
			rotate: (provider, sessionId, rotateOptions) => this.#limits.rotate(provider, sessionId, rotateOptions),
			sourceLabel: () =>
				this.#binding.broker ? `broker ${this.#binding.broker.url}` : `local ${this.#binding.dbPath}`,
		});
		if (options.configValueResolver) {
			this.#resolver = options.configValueResolver;
			this.#keys.setResolver(options.configValueResolver);
		}
		this.credentials = this.#credentialsApi();
		this.keys = this.#keysApi();
		this.oauth = this.#oauthApi();
		this.sessions = this.#sessionsApi();
		this.usage = this.#usageApi();
		this.health = this.#healthApi();
		this.limits = this.#limitsApi();
		this.resets = this.#resetsApi();
		this.blocks = {
			list: () => refuse("blocks.list", OWNER_SEAM),
			upsert: () => refuse("blocks.upsert", OWNER_SEAM),
			delete: () => refuse("blocks.delete", OWNER_SEAM),
			deleteAll: () => refuse("blocks.deleteAll", OWNER_SEAM),
		};
	}

	/** Changes when the bound credential store does; row ids are only meaningful within one epoch. */
	get storeEpoch(): number {
		return this.#storeEpoch;
	}

	/** Describe the provider's durable destination without opening its credential store here. */
	async credentialDestination(provider: string): Promise<string> {
		return this.#dispatch(async () => {
			const { broker, dbPath } = this.#binding;
			if (!broker) return dbPath;
			const remote = await this.#link.request("credential-destination", { provider });
			if (typeof remote !== "boolean") invalidReply("credential-destination");
			return remote ? `auth broker ${broker.url}` : dbPath;
		});
	}

	/** The local owner, once something has opened it. */
	get openedLocalOwner(): AuthStorage | undefined {
		return this.#openedLocal;
	}

	// ───────────────────────── lifecycle ─────────────────────────

	/**
	 * The daemon lease has a fixed policy view. A settings change goes through {@link rebind},
	 * which the caller awaits; a synchronous setter could not report a refused binding.
	 */
	setAccountPolicies(_config: AuthAccountPolicyConfig): void {
		refuse("setAccountPolicies", "rebind the storage with the new account policies");
	}

	/** The daemon owns the store; a store opened in this process cannot replace it. */
	async replaceStore(store: AuthCredentialStore): Promise<void> {
		store.close();
		refuse("replaceStore", "rebind the storage with the new broker settings");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#offMetadata();
		this.#metadata?.close();
		this.#link.close();
		this.#generationListeners.clear();
		this.#disabledListeners.clear();
		const local = this.#local;
		this.#local = this.#openedLocal = undefined;
		void local?.then(
			owner => owner.close(),
			() => {},
		);
	}

	/**
	 * Move this storage to `binding` (live broker or account-policy change). The new lease is
	 * bound and receives every held restriction and pin before it serves a request; if any step
	 * fails the current lease stays in place and the error is thrown. Pins do not carry over to
	 * a different credential store, whose row ids mean something else.
	 */
	rebind(binding: AuthDaemonBinding): Promise<void> {
		return this.#queueSwitch(() =>
			JSON.stringify(binding) === JSON.stringify(this.#binding) && !this.#link.lost
				? undefined
				: this.#switch(binding),
		);
	}

	#requireOpen(): void {
		if (this.#closed) throw new Error("Daemon-managed auth storage is closed");
	}

	#queueSwitch(run: () => Promise<void> | undefined): Promise<void> {
		const next = this.#switching.then(run);
		this.#switching = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	#reconnect(): Promise<void> {
		this.#reconnecting ??= this.#queueSwitch(() =>
			this.#link.lost ? this.#switch(this.#binding) : undefined,
		).finally(() => {
			this.#reconnecting = undefined;
		});
		return this.#reconnecting;
	}

	async #switch(binding: AuthDaemonBinding): Promise<void> {
		this.#requireOpen();
		// Validate first, so a bad policy set never reaches the tunnel.
		const policies = new AccountPolicies(binding.accountPolicies, binding.defaultReservePct);
		const raw = await this.#connect(binding);
		if (!raw) throw new ManagedAuthUnavailableError();
		const storeKey = authDaemonStoreKey(binding);
		const sameStore = storeKey === this.#storeKey;
		const gate = Promise.withResolvers<void>();
		this.#gate = gate.promise;
		let previous: AuthDaemonLink;
		let candidate: AuthDaemonMetadata | undefined;
		try {
			while (this.#inflight > 0) {
				const idle = Promise.withResolvers<void>();
				this.#idle = idle;
				await idle.promise;
			}
			this.#idle = undefined;
			this.#requireOpen();
			// Read the new lease's availability before it serves: row ids of the previous store
			// are never visible next to the new one.
			const metadata = await AuthDaemonMetadata.open(raw);
			candidate = metadata;
			const sessions = new AuthDaemonSessions(raw);
			const replayed = new Map<HeldRestriction, SessionRestrictionLease>();
			await this.#replayRestrictions(sessions, replayed);
			if (sameStore) {
				for (const [provider, bySession] of this.#affinity) {
					for (const [sessionId, held] of bySession) {
						const restored =
							held.pinned === undefined
								? await sessions.pin(provider, sessionId, held.credentialId, {
										restoredAtMs: held.lastUsedAtMs,
									})
								: await sessions.pin(provider, sessionId, held.pinned);
						if (restored) continue;
						bySession.delete(sessionId);
						logger.warn("Session account affinity could not be restored on the new daemon auth lease", {
							provider,
							pinned: held.pinned !== undefined,
						});
					}
				}
				// A restriction installed while pins were replayed must be on the lease before it serves.
				await this.#replayRestrictions(sessions, replayed);
			}
			this.#requireOpen();
			// No await from here to the end of the block: the switch is atomic.
			for (const [held, lease] of replayed) held.inner = lease;
			previous = this.#link.replace(raw);
			this.#keys.clearResolutionHandles();
			this.#offMetadata();
			this.#metadata?.close();
			this.#metadata = metadata;
			this.#offMetadata = metadata.onGeneration(() => this.#bump());
			this.#sessions = sessions;
			this.#binding = binding;
			this.#policies = policies;
			if (!sameStore) {
				this.#storeKey = storeKey;
				this.#storeEpoch++;
				this.#affinity.clear();
				this.#bearers.clear();
				this.#authRejections.clear();
				this.#seenDisabled = undefined;
			}
			this.#retargetLocal(binding);
		} catch (error) {
			candidate?.close();
			raw.close();
			throw error;
		} finally {
			this.#gate = undefined;
			gate.resolve();
		}
		previous.close();
		this.#bump();
	}

	/**
	 * Keep the last availability snapshot for display while the link is down. It cannot authorize
	 * requests. The replacement lease gets a fresh snapshot and the held session policies.
	 */
	#onLost(): void {
		if (this.#closed) return;
		this.#offMetadata();
		this.#metadata?.close();
		this.#keys.clearResolutionHandles();
		this.#bearers.clear();
		this.#authRejections.clear();
		void this.#reconnect().catch(error => {
			logger.debug("Daemon auth lease was lost and is not replaced yet", { error: String(error) });
		});
	}

	/** Bring `sessions` to the held restrictions, repeating until none changed while waiting for acknowledgment. */
	async #replayRestrictions(
		sessions: AuthDaemonSessions,
		replayed: Map<HeldRestriction, SessionRestrictionLease>,
	): Promise<void> {
		let revision: number;
		do {
			revision = this.#restrictionRevision;
			for (const bySession of this.#restrictions.values()) {
				for (const held of bySession.values()) {
					if (held.local || replayed.has(held)) continue;
					replayed.set(held, sessions.restrict(held.provider, held.sessionId, held.identityKeys));
				}
			}
			for (const [held, lease] of replayed) {
				if (!held.local && this.#restrictions.get(held.provider)?.get(held.sessionId) === held) continue;
				sessions.unrestrict(held.provider, held.sessionId, lease);
				replayed.delete(held);
			}
			await sessions.settled();
		} while (revision !== this.#restrictionRevision);
	}

	/**
	 * Run one daemon request once it is safe to send: no rebind under way, a live lease, and
	 * every earlier restriction acknowledged. A lost lease is replaced first; `run` itself is
	 * never repeated.
	 */
	async #dispatch<T>(run: () => T | Promise<T>): Promise<T> {
		for (;;) {
			this.#requireOpen();
			if (this.#gate) {
				await this.#gate;
				continue;
			}
			if (this.#link.lost) {
				await this.#reconnect();
				continue;
			}
			const sessions = this.#sessions;
			try {
				await sessions.settled();
			} catch (error) {
				if (this.#link.lost || sessions !== this.#sessions) continue;
				this.#link.disconnect();
				throw error;
			}
			if (!this.#gate && !this.#link.lost && sessions === this.#sessions) break;
		}
		this.#inflight++;
		try {
			return await run();
		} finally {
			if (--this.#inflight === 0) this.#idle?.resolve();
		}
	}

	#request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		return raceWithSignal(
			this.#dispatch(() => {
				signal?.throwIfAborted();
				return this.#link.request(method, params, signal);
			}),
			signal,
		);
	}

	async #refreshMetadata(): Promise<boolean> {
		return this.#dispatch(() => this.#metadata?.refresh() ?? false);
	}

	// ───────────────────────── local owner ─────────────────────────

	/**
	 * A real `AuthStorage` on the bound store, for work that needs stored rows in this process.
	 * Opened once, moved in place when the storage is rebound, closed with it. `storeEpoch`
	 * rejects a row id that came from a store this storage has since left.
	 */
	localOwner(storeEpoch?: number): Promise<AuthStorage> {
		if (this.#closed) return Promise.reject(new Error("Daemon-managed auth storage is closed"));
		if (storeEpoch !== undefined && storeEpoch !== this.#storeEpoch) {
			return Promise.reject(new ManagedAuthStoreChangedError());
		}
		return this.#local ?? this.#chainLocal(this.#openLocal());
	}

	/** Whether `provider` is served by the local owner (see {@link prepareLocal}). */
	isLocal(provider: string): boolean {
		return this.#localProviders.has(provider);
	}

	/**
	 * Hand `providers` to the local owner for the life of this storage. Held restrictions and
	 * affinity move with them, restrictions first. Returns nothing when there is no work to wait for.
	 */
	prepareLocal(providers: Iterable<string>): Promise<void> | undefined {
		const pending: string[] = [];
		for (const provider of providers) if (!this.#localProviders.has(provider)) pending.push(provider);
		if (pending.length === 0 && this.#openedLocal) return;
		return this.#adopt(pending).then(() => {});
	}

	async #adopt(providers: readonly string[]): Promise<AuthStorage> {
		const owner = await this.localOwner();
		// No await below: a provider is local only once its restrictions are on the owner.
		let changed = false;
		for (const provider of providers) {
			if (this.#localProviders.has(provider)) continue;
			for (const held of this.#restrictions.get(provider)?.values() ?? []) {
				if (held.local) continue;
				const daemonLease = held.inner;
				held.inner = owner.sessions.restrict(provider, held.sessionId, held.identityKeys);
				held.local = true;
				this.#restrictionRevision++;
				if (daemonLease !== undefined) this.#sessions.unrestrict(provider, held.sessionId, daemonLease);
			}
			for (const [sessionId, held] of this.#affinity.get(provider) ?? []) {
				const pinned =
					held.pinned === undefined
						? owner.sessions.pin(provider, sessionId, held.credentialId, { restoredAtMs: held.lastUsedAtMs })
						: owner.sessions.pin(provider, sessionId, held.pinned);
				if (pinned instanceof Promise) pinned.catch(() => {});
			}
			this.#affinity.delete(provider);
			this.#localProviders.add(provider);
			changed = true;
		}
		if (changed) this.#bump();
		return owner;
	}

	async #openLocal(): Promise<AuthStorage> {
		const binding = this.#binding;
		this.#localBinding = binding;
		const owner = await this.#hooks.open(binding);
		if (this.#closed) {
			owner.close();
			throw new Error("Daemon-managed auth storage is closed");
		}
		if (this.#resolver) owner.keys.setResolver(this.#resolver);
		for (const [provider, key] of this.#runtimeKeys) owner.keys.setRuntime(provider, key);
		for (const [provider, calls] of this.#configKeys) {
			for (const { config, fallback } of calls) owner.keys.setConfig(provider, config, { fallback });
		}
		owner.usage.replaceConfiguredProviders(this.#configuredUsage);
		for (const [provider, { usageProvider, apiKey }] of this.#runtimeUsage) {
			owner.usage.setProvider(provider, usageProvider, apiKey);
		}
		for (const bySession of this.#restrictions.values()) {
			for (const held of bySession.values()) {
				if (held.local) held.inner = owner.sessions.restrict(held.provider, held.sessionId, held.identityKeys);
			}
		}
		owner.credentials.onGeneration(() => {
			if (this.#openedLocal === owner) this.#bump();
		});
		owner.credentials.onDisabled(event => {
			if (this.#openedLocal !== owner) return;
			if (event.credentialId !== undefined) this.#seenDisabled?.add(event.credentialId);
			this.#emitDisabled(event);
		});
		// Visible in the same turn as its restrictions, so no restrict call can fall between the two.
		this.#openedLocal = owner;
		return owner;
	}

	/** Make `step` the owner's next state; a failed step leaves no owner, and the next use reopens it. */
	#chainLocal(step: Promise<AuthStorage>): Promise<AuthStorage> {
		const tail: Promise<AuthStorage> = step.then(
			owner => {
				if (this.#local === tail) this.#openedLocal = owner;
				return owner;
			},
			error => {
				if (this.#local === tail) this.#local = this.#openedLocal = undefined;
				throw error;
			},
		);
		this.#local = tail;
		return tail;
	}

	#retargetLocal(binding: AuthDaemonBinding): void {
		const opened = this.#local;
		if (!opened) return;
		const previous = this.#localBinding;
		this.#localBinding = binding;
		this.#chainLocal(
			opened.then(async owner => {
				try {
					await this.#hooks.retarget(owner, binding, previous);
				} catch (error) {
					owner.close();
					throw error;
				}
				return owner;
			}),
		).catch(error => {
			logger.warn("Local auth owner could not follow the daemon auth rebind; it reopens on next use", {
				error: String(error),
			});
		});
	}

	/** The warm owner of a local provider; `undefined` when the daemon (or nothing yet) serves it. */
	#ownerOf(provider: string): AuthStorage | undefined {
		if (!this.#localProviders.has(provider)) return undefined;
		if (this.#openedLocal) return this.#openedLocal;
		void this.localOwner().catch(() => {});
		return refuse(`auth for ${provider}`, "its local owner is reopening; retry");
	}

	/** Owner for an awaited call: adopts a provider the daemon cannot serve on its first use. */
	#route(provider: string): AuthStorage | undefined | Promise<AuthStorage> {
		if (this.#localProviders.has(provider)) return this.#openedLocal ?? this.localOwner();
		return AUTH_DAEMON_PROVIDERS.has(provider) ? undefined : this.#adopt([provider]);
	}

	/**
	 * A runtime or `models.yml` key outranks every stored row. A provider the daemon does not
	 * serve that has one is answered here, without opening the store.
	 */
	#callerOverride(provider: string, sessionId: string | undefined): Promise<string | undefined> | undefined {
		if (AUTH_DAEMON_PROVIDERS.has(provider) || this.#localProviders.has(provider)) return undefined;
		if (this.#isRestricted(provider, sessionId)) return undefined;
		const runtime = this.#runtimeKeys.get(provider);
		if (runtime) return Promise.resolve(runtime);
		const config = this.#configKeys.get(provider)?.find(call => !call.fallback)?.config;
		return config === undefined || !this.#resolver ? undefined : this.#resolver(config);
	}

	async #afterLocalWrite(): Promise<void> {
		try {
			await this.#request("credentials-reload", { revalidate: true });
			await this.#refreshMetadata();
		} catch (error) {
			// The daemon also polls the store; the write itself has succeeded.
			logger.warn("Daemon auth did not confirm a local credential change", { error: String(error) });
		}
	}

	// ───────────────────────── ledger and events ─────────────────────────

	#isRestricted(provider: string, sessionId: string | undefined): boolean {
		if (sessionId === undefined) return false;
		return (
			this.#restrictions.get(provider)?.has(sessionId) === true || this.#sessions.isRestricted(provider, sessionId)
		);
	}

	#availability(provider: string, sessionId: string | undefined): AuthDaemonKeyAvailability {
		const entry = this.#metadata?.lookup(provider) ?? NO_CREDENTIALS;
		const active = sessionId === undefined ? undefined : this.#affinity.get(provider)?.get(sessionId);
		return active
			? {
					keyless: entry.keyless,
					credentials: entry.credentials,
					keylessCredentialIds: entry.keylessCredentialIds,
					activeCredentialId: active.credentialId,
				}
			: entry;
	}

	#oauthRows(provider: string): Extract<StoredCredentialSummary, { type: "oauth" }>[] {
		const rows: Extract<StoredCredentialSummary, { type: "oauth" }>[] = [];
		for (const row of this.#metadata?.lookup(provider).credentials ?? []) {
			if (row.type === "oauth" && !row.disabled) rows.push(row);
		}
		return rows;
	}

	#noteServed(
		provider: string,
		sessionId: string | undefined,
		credentialId: number | undefined,
		oauthAccess: string | undefined,
		recordAffinity: boolean,
	): void {
		if (credentialId !== undefined && oauthAccess !== undefined) {
			this.#bearers.set(oauthAccess, { provider, credentialId });
		}
		if (sessionId === undefined || !recordAffinity) return;
		let bySession = this.#affinity.get(provider);
		const held = bySession?.get(sessionId);
		if (credentialId === undefined) {
			// The pool fell through to a caller-local key; the owner dropped the automatic affinity.
			if (held && held.pinned === undefined) bySession?.delete(sessionId);
			return;
		}
		if (held) {
			held.credentialId = credentialId;
			held.lastUsedAtMs = Date.now();
			return;
		}
		if (!bySession) this.#affinity.set(provider, (bySession = new Map()));
		bySession.set(sessionId, { credentialId, lastUsedAtMs: Date.now() });
	}

	#forgetRow(provider: string, credentialId: number): void {
		const bySession = this.#affinity.get(provider);
		if (!bySession) return;
		for (const [sessionId, held] of bySession) {
			if (held.credentialId === credentialId || held.pinned === credentialId) bySession.delete(sessionId);
		}
	}

	/** The served OAuth row whose access token is exactly `bearer`. */
	servedOAuthRow(provider: string, bearer: string): StoredCredentialSummary | undefined {
		const owner = this.#ownerOf(provider);
		if (owner) {
			for (const row of owner.credentials.list(provider)) {
				if (row.credential.type === "oauth" && row.credential.access === bearer)
					return summarizeStoredCredential(row);
			}
			return undefined;
		}
		const served = this.#bearers.get(bearer);
		if (served?.provider !== provider) return undefined;
		return this.#oauthRows(provider).find(row => row.id === served.credentialId);
	}

	#bump(): void {
		if (this.#closed) return;
		const generation = ++this.#generation;
		for (const listener of Array.from(this.#generationListeners)) {
			try {
				listener(generation);
			} catch {
				logger.debug("Auth credential generation listener failed");
			}
		}
		if (this.#disabledListeners.size > 0) this.#scanDisabled();
	}

	#emitDisabled(event: CredentialDisabledEvent): void {
		if (this.#disabledListeners.size === 0) {
			this.#pendingDisabled.push(event);
			return;
		}
		for (const listener of Array.from(this.#disabledListeners)) this.#notifyDisabled(listener, event);
	}

	#notifyDisabled(
		listener: (event: CredentialDisabledEvent) => void | Promise<void>,
		event: CredentialDisabledEvent,
	): void {
		try {
			void Promise.resolve(listener(event)).catch(() => {
				logger.debug("Auth credential disable listener failed");
			});
		} catch {
			logger.debug("Auth credential disable listener failed");
		}
	}

	/**
	 * Disable events are derived from the daemon's tombstones: the first scan records what is
	 * already disabled, later ones report rows that were disabled since and not by the user.
	 */
	#scanDisabled(): void {
		if (this.#disabledScan) {
			this.#disabledRescan = true;
			return;
		}
		this.#disabledScan = (async () => {
			do {
				this.#disabledRescan = false;
				const rows = parseDisabled(await this.#request("credentials-list-disabled", {}));
				const seen = this.#seenDisabled;
				const next = new Set<number>();
				for (const row of rows) {
					next.add(row.id);
					// The daemon's fixed labels for tombstones the user caused; those are not disable events.
					const userRemoved = row.cause === "Replaced by another credential" || row.cause === "Deleted by user";
					if (!seen || seen.has(row.id) || userRemoved || this.#localProviders.has(row.provider)) continue;
					this.#emitDisabled({
						provider: row.provider,
						disabledCause: row.cause,
						credentialId: row.id,
						email: row.email,
						accountId: row.accountId,
						orgId: row.orgId,
						orgName: row.orgName,
					});
				}
				this.#seenDisabled = next;
			} while (this.#disabledRescan && !this.#closed);
		})()
			.catch(error => {
				if (!this.#closed) logger.debug("Daemon auth disabled-credential scan failed", { error: String(error) });
			})
			.finally(() => {
				this.#disabledScan = undefined;
			});
	}

	// ───────────────────────── credentials ─────────────────────────

	#credentialsApi(): CredentialsApi {
		const backend = this;
		return {
			get generation() {
				return backend.#generation;
			},
			onGeneration: listener => {
				this.#generationListeners.add(listener);
				return () => {
					this.#generationListeners.delete(listener);
				};
			},
			onDisabled: listener => {
				const first = this.#disabledListeners.size === 0;
				this.#disabledListeners.add(listener);
				if (first && this.#pendingDisabled.length > 0) {
					const pending = this.#pendingDisabled;
					this.#pendingDisabled = [];
					for (const event of pending) this.#notifyDisabled(listener, event);
				}
				if (!this.#seenDisabled) this.#scanDisabled();
				return () => {
					this.#disabledListeners.delete(listener);
				};
			},
			reload: async () => {
				await this.#request("credentials-reload", {});
				await this.#refreshMetadata();
				await this.#openedLocal?.credentials.reload();
			},
			poll: async () => {
				const changed = await this.#refreshMetadata();
				return ((await this.#openedLocal?.credentials.poll()) ?? false) || changed;
			},
			revalidate: async () => {
				await this.#request("credentials-reload", { revalidate: true });
				await this.#refreshMetadata();
				await this.#openedLocal?.credentials.revalidate();
			},
			get: provider => (this.#ownerOf(provider) ?? refuse("credentials.get", RAW_ROWS)).credentials.get(provider),
			all: () => refuse("credentials.all", RAW_ROWS),
			list: provider => {
				const owner = provider === undefined ? undefined : this.#ownerOf(provider);
				return (owner ?? refuse("credentials.list", RAW_ROWS)).credentials.list(provider);
			},
			summaries: provider => {
				if (provider !== undefined) {
					const owner = this.#ownerOf(provider);
					return owner ? owner.credentials.summaries(provider) : [...(this.#metadata?.summaries(provider) ?? [])];
				}
				const rows = [...(this.#metadata?.summaries() ?? [])];
				const owner = this.#openedLocal;
				if (owner) for (const local of this.#localProviders) rows.push(...owner.credentials.summaries(local));
				return rows;
			},
			has: provider => {
				const owner = this.#ownerOf(provider);
				return owner ? owner.credentials.has(provider) : this.#metadata?.lookup(provider).has === true;
			},
			hasOAuth: provider => {
				const owner = this.#ownerOf(provider);
				return owner ? owner.credentials.hasOAuth(provider) : this.#metadata?.lookup(provider).hasOAuth === true;
			},
			hasSubscription: provider => {
				const owner = this.#ownerOf(provider);
				return owner
					? owner.credentials.hasSubscription(provider)
					: this.#metadata?.lookup(provider).hasSubscription === true;
			},
			getOAuth: provider =>
				(this.#ownerOf(provider) ?? refuse("credentials.getOAuth", RAW_ROWS)).credentials.getOAuth(provider),
			set: async (provider, credential) => {
				const owner = (await this.#route(provider)) ?? refuse("credentials.set", RAW_ROWS);
				await owner.credentials.set(provider, credential);
			},
			upsert: async (provider, credential) => {
				const owner = (await this.#route(provider)) ?? refuse("credentials.upsert", OWNER_SEAM);
				return owner.credentials.upsert(provider, credential);
			},
			remove: async provider => {
				const owner = await this.#route(provider);
				if (owner) return owner.credentials.remove(provider);
				await this.#request("credentials-remove", { provider });
				this.#affinity.delete(provider);
				await this.#refreshMetadata();
			},
			removeById: async (provider, credentialId) => {
				const owner = await this.#route(provider);
				if (owner) return owner.credentials.removeById(provider, credentialId);
				const removed = await this.#request("credentials-remove", { provider, id: credentialId });
				if (typeof removed !== "boolean") invalidReply("credentials-remove");
				if (removed) this.#forgetRow(provider, credentialId);
				await this.#refreshMetadata();
				return removed;
			},
			disable: () => refuse("credentials.disable", OWNER_SEAM),
			listDisabled: async (provider, signal) => {
				if (provider !== undefined) {
					const owner = await this.#route(provider);
					if (owner) return owner.credentials.listDisabled(provider, signal);
				}
				const rows = parseDisabled(await this.#request("credentials-list-disabled", { provider }, signal));
				const owner = provider === undefined ? this.#openedLocal : undefined;
				if (!owner || this.#localProviders.size === 0) return rows;
				// Both read the same store; each side reports only the providers it serves.
				const served = rows.filter(row => !this.#localProviders.has(row.provider));
				for (const row of await owner.credentials.listDisabled(undefined, signal)) {
					if (this.#localProviders.has(row.provider)) served.push(row);
				}
				return served;
			},
			snapshot: () => refuse("credentials.snapshot", OWNER_SEAM),
		};
	}

	// ───────────────────────── keys ─────────────────────────

	#keysApi(): KeysApi {
		const keys = this.#keys;
		return {
			get: async (provider, sessionId, options) => {
				const override = this.#callerOverride(provider, sessionId);
				if (override) return override;
				const owner = await this.#route(provider);
				return owner ? owner.keys.get(provider, sessionId, options) : keys.get(provider, sessionId, options);
			},
			getWithCredential: async (provider, sessionId, options) => {
				const override = this.#callerOverride(provider, sessionId);
				if (override) {
					const apiKey = await override;
					return apiKey === undefined ? undefined : { apiKey };
				}
				const owner = await this.#route(provider);
				return owner
					? owner.keys.getWithCredential(provider, sessionId, options)
					: keys.getWithCredential(provider, sessionId, options);
			},
			peek: async (provider, options) => {
				const override = this.#callerOverride(provider, undefined);
				if (override) return override;
				const owner = await this.#route(provider);
				return owner ? owner.keys.peek(provider, options) : keys.peek(provider, options);
			},
			prefetchUsage: async (provider, sessionId, options) => {
				if (this.#callerOverride(provider, sessionId)) return;
				const owner = await this.#route(provider);
				return owner
					? owner.keys.prefetchUsage(provider, sessionId, options)
					: keys.prefetchUsage(provider, sessionId, options);
			},
			source: (provider, options) => {
				const owner = this.#ownerOf(provider);
				return owner ? owner.keys.source(provider, options) : keys.source(provider, options);
			},
			keyless: provider => {
				const owner = this.#ownerOf(provider);
				return owner ? owner.keys.keyless(provider) : keys.keyless(provider);
			},
			describe: (provider, sessionId) => {
				const owner = this.#ownerOf(provider);
				return owner ? owner.keys.describe(provider, sessionId) : keys.describe(provider, sessionId);
			},
			setRuntime: (provider, apiKey) => {
				keys.setRuntime(provider, apiKey);
				this.#runtimeKeys.set(provider, apiKey);
				this.#openedLocal?.keys.setRuntime(provider, apiKey);
			},
			removeRuntime: provider => {
				keys.removeRuntime(provider);
				this.#runtimeKeys.delete(provider);
				this.#openedLocal?.keys.removeRuntime(provider);
			},
			setConfig: (provider, config, options) => {
				keys.setConfig(provider, config, options);
				const fallback = options?.fallback === true;
				const calls = this.#configKeys.get(provider)?.filter(call => call.fallback !== fallback) ?? [];
				calls.push({ config, fallback });
				this.#configKeys.set(provider, calls);
				this.#openedLocal?.keys.setConfig(provider, config, options);
			},
			removeConfig: provider => {
				keys.removeConfig(provider);
				this.#configKeys.delete(provider);
				this.#openedLocal?.keys.removeConfig(provider);
			},
			clearConfig: () => {
				keys.clearConfig();
				this.#configKeys.clear();
				this.#openedLocal?.keys.clearConfig();
			},
			setResolver: resolver => {
				keys.setResolver(resolver);
				this.#resolver = resolver;
				this.#openedLocal?.keys.setResolver(resolver);
			},
			resolver: (provider, options) => {
				const owner = this.#ownerOf(provider);
				if (owner) return owner.keys.resolver(provider, options);
				if (AUTH_DAEMON_PROVIDERS.has(provider)) return keys.resolver(provider, options);
				// Not served by the daemon and not adopted yet: decide per request, as the caller's keys may change.
				let adopted: ApiKeyResolver | undefined;
				return async request => {
					if (!adopted && request.error === undefined) {
						const override = this.#callerOverride(provider, options?.sessionId);
						if (override) {
							const apiKey = await override;
							return apiKey === undefined ? undefined : { apiKey };
						}
					}
					adopted ??= (await this.#adopt([provider])).keys.resolver(provider, options);
					return adopted(request);
				};
			},
		};
	}

	// ───────────────────────── oauth ─────────────────────────

	/** One `oauth-access` round trip; `undefined` when the daemon has no usable OAuth row. */
	async #oauthAccess(
		provider: string,
		sessionId: string | undefined,
		credentialId: number | undefined,
		options: AuthApiKeyOptions | undefined,
		forceRefresh: boolean | undefined,
		recoveryHandle?: string,
	): Promise<Record<string, unknown> | undefined> {
		const reply = await this.#request(
			"oauth-access",
			{
				provider,
				sessionId,
				credentialId,
				options: options && {
					...selection(options, forceRefresh),
					refreshReason: recoveryHandle && "auth-recovery",
				},
				recoveryHandle,
			},
			options?.signal,
		);
		if (reply === null) return undefined;
		return isRecord(reply) ? reply : invalidReply("oauth-access");
	}

	/**
	 * A forced refresh that names the rejected token first asks for the current one: when the
	 * owner already holds a different token, that one has not been rejected and no grant is spent.
	 */
	async #oauthAccessRecovering(
		provider: string,
		sessionId: string | undefined,
		credentialId: number | undefined,
		options: AuthApiKeyOptions | undefined,
	): Promise<Record<string, unknown> | undefined> {
		const force = options?.forceRefresh === true ? true : undefined;
		const rejected = force ? options?.rejectedAccessToken : undefined;
		if (rejected !== undefined) {
			const current = await this.#oauthAccess(provider, sessionId, credentialId, options, undefined);
			if (!current || current.kind === "error" || current.accessToken !== rejected) return current;
			const handle = text(current.recoveryHandle);
			if (!handle) invalidReply("oauth-access");
			const refreshed = await this.#oauthAccess(provider, sessionId, credentialId, options, true, handle);
			// A lease change invalidates its handle. A read can recover, but do not spend another mint.
			return refreshed?.category === "invalid-recovery"
				? this.#oauthAccess(provider, sessionId, credentialId, options, undefined)
				: refreshed;
		}
		return this.#oauthAccess(provider, sessionId, credentialId, options, force);
	}

	#oauthApi(): OAuthApi {
		const exact = async (
			provider: string,
			row: Extract<StoredCredentialSummary, { type: "oauth" }>,
			options: AuthApiKeyOptions | undefined,
		): Promise<OAuthAccessResolution | undefined> => {
			const reply = await this.#oauthAccessRecovering(provider, undefined, row.id, options);
			if (!reply) return undefined;
			const category = readErrorCategory(reply);
			if (category !== undefined) {
				return {
					ok: false,
					credentialId: row.id,
					accountId: row.accountId,
					email: row.email,
					projectId: row.projectId,
					enterpriseUrl: row.enterpriseUrl,
					orgId: row.orgId,
					orgName: row.orgName,
					error: `OAuth access unavailable (${category})`,
				};
			}
			if (reply.ok !== true || typeof reply.apiKey !== "string" || !reply.apiKey) invalidReply("oauth-access");
			const access = parseOAuthAccess(reply);
			if (access.credentialId !== row.id) invalidReply("oauth-access");
			this.#bearers.set(access.accessToken, { provider, credentialId: row.id });
			return { ...access, ok: true, apiKey: reply.apiKey };
		};
		return {
			login: async (provider, ctrl) => {
				// The flow and its callbacks run here; the grant goes straight into the bound store.
				const owner = await this.localOwner();
				const identity = await owner.oauth.login(provider, ctrl);
				if (identity) await this.#afterLocalWrite();
				return identity;
			},
			signOut: async (provider, credentialId, options) => {
				const owner = await this.#route(provider);
				if (owner) return owner.oauth.signOut(provider, credentialId, options);
				const reply = await this.#request("oauth-sign-out", { provider, credentialId }, options?.signal);
				if (!isRecord(reply) || typeof reply.removed !== "boolean") invalidReply("oauth-sign-out");
				const result: OAuthSignOutResult = { removed: reply.removed };
				const signOutError = text(reply.signOutError);
				if (signOutError !== undefined) result.signOutError = signOutError;
				if (result.removed) this.#forgetRow(provider, credentialId);
				await this.#refreshMetadata();
				return result;
			},
			access: async (provider, sessionId, options) => {
				const owner = await this.#route(provider);
				if (owner) return owner.oauth.access(provider, sessionId, options);
				if (providerPauseReason(provider) !== undefined) return undefined;
				if (this.#keys.suppressesOAuth(provider, sessionId)) return undefined;
				const reply = await this.#oauthAccessRecovering(provider, sessionId, undefined, options);
				if (!reply) return undefined;
				const category = readErrorCategory(reply);
				if (category === "refresh-unavailable") {
					throw new OAuthRefreshUnavailableError(provider, "Daemon refresh temporarily unavailable");
				}
				if (category !== undefined) {
					throw new Error(`Daemon could not resolve OAuth access for provider: ${provider} (${category})`);
				}
				const access = parseOAuthAccess(reply);
				this.#noteServed(
					provider,
					sessionId,
					access.credentialId,
					access.accessToken,
					options?.recordAffinity !== false,
				);
				return access;
			},
			accessAll: async (provider, options) => {
				const owner = await this.#route(provider);
				if (owner) return owner.oauth.accessAll(provider, options);
				if (this.#keys.hasOverride(provider)) return [];
				const resolutions: OAuthAccessResolution[] = [];
				// One row at a time: each is an exact-account request the daemon checks on its own.
				for (const row of this.#oauthRows(provider)) {
					const resolution = await exact(provider, row, options);
					if (resolution) resolutions.push(resolution);
				}
				return resolutions;
			},
			accessById: async (provider, credentialId, options) => {
				const owner = await this.#route(provider);
				if (owner) return owner.oauth.accessById(provider, credentialId, options);
				if (this.#keys.hasOverride(provider)) return undefined;
				const row = this.#oauthRows(provider).find(candidate => candidate.id === credentialId);
				return row && exact(provider, row, options);
			},
			accounts: (provider, sessionId) => {
				const owner = this.#ownerOf(provider);
				if (owner) return owner.oauth.accounts(provider, sessionId);
				if (this.#keys.suppressesOAuth(provider, sessionId)) return [];
				const active = sessionId === undefined ? undefined : this.#affinity.get(provider)?.get(sessionId);
				return this.#oauthRows(provider).map((row, position) => {
					const isActive = row.id === active?.credentialId;
					return {
						position,
						credentialId: row.id,
						accountId: row.accountId,
						email: row.email,
						projectId: row.projectId,
						enterpriseUrl: row.enterpriseUrl,
						orgId: row.orgId,
						orgName: row.orgName,
						active: isActive,
						...(isActive && active ? { lastUsedAtMs: active.lastUsedAtMs } : {}),
					};
				});
			},
			identity: (provider, sessionId) => {
				const owner = this.#ownerOf(provider);
				if (owner) return owner.oauth.identity(provider, sessionId);
				const rows = this.#oauthRows(provider);
				if (rows.length === 0 || this.#keys.suppressesOAuth(provider, sessionId)) return undefined;
				const restricted = this.#isRestricted(provider, sessionId);
				const active = sessionId === undefined ? undefined : this.#affinity.get(provider)?.get(sessionId);
				let row: (typeof rows)[number] | undefined;
				if (active) {
					row = rows.find(candidate => candidate.id === active.credentialId);
					// The session is routed to a stored API key: no OAuth account speaks for it.
					if (!row) return undefined;
				} else if (restricted) {
					// Which accounts the restriction allows is the daemon's to say; nothing has been served yet.
					return undefined;
				} else {
					// As on the store owner: with an environment key and nothing served yet, no account is attributed.
					if (getEnvApiKey(provider)) return undefined;
					row = rows[0];
				}
				if (!row) return undefined;
				const identity: OAuthAccountIdentity = {};
				if (row.accountId) identity.accountId = row.accountId;
				if (row.email) identity.email = row.email;
				if (row.projectId) identity.projectId = row.projectId;
				if (row.orgId) identity.orgId = row.orgId;
				if (row.orgName) identity.orgName = row.orgName;
				return identity.accountId || identity.email || identity.projectId || identity.orgId ? identity : undefined;
			},
			policy: (provider, identity) => this.#policies.find(provider, identity),
			refresh: () => refuse("oauth.refresh", OWNER_SEAM),
			refreshStored: (provider, options) =>
				(this.#ownerOf(provider) ?? refuse("oauth.refreshStored", RAW_ROWS)).oauth.refreshStored(provider, options),
		};
	}

	// ───────────────────────── sessions ─────────────────────────

	#hold(provider: string, sessionId: string, held: HeldAffinity): void {
		let bySession = this.#affinity.get(provider);
		if (!bySession) this.#affinity.set(provider, (bySession = new Map()));
		bySession.set(sessionId, held);
	}

	#sessionsApi(): SessionsApi {
		return {
			pin: async (provider, sessionId, credentialId, options) => {
				const owner = await this.#route(provider);
				if (owner) return owner.sessions.pin(provider, sessionId, credentialId, options);
				return this.#dispatch(async () => {
					const pinned = await this.#sessions.pin(provider, sessionId, credentialId, options);
					if (pinned) {
						const restoredAtMs = options?.restoredAtMs;
						this.#hold(
							provider,
							sessionId,
							restoredAtMs === undefined
								? { credentialId, pinned: credentialId, lastUsedAtMs: Date.now() }
								: { credentialId, lastUsedAtMs: restoredAtMs },
						);
					}
					return pinned;
				});
			},
			inherit: async (sourceSessionId, targetSessionId, include) => {
				if (sourceSessionId === targetSessionId) return 0;
				let copied = 0;
				const owner = this.#localProviders.size > 0 ? await this.localOwner() : undefined;
				if (owner) {
					copied += await owner.sessions.inherit(
						sourceSessionId,
						targetSessionId,
						(provider, explicit) => this.#localProviders.has(provider) && (include?.(provider, explicit) ?? true),
					);
				}
				return this.#dispatch(async () => {
					// The wire takes exact (provider, explicit) pairs, so the predicate is evaluated here
					// for every provider that has stored credentials.
					let allow: { provider: string; explicit: boolean }[] | undefined;
					if (include) {
						allow = [];
						const metadata = this.#metadata;
						for (const provider of metadata?.providers() ?? []) {
							if (!metadata?.lookup(provider).has) continue;
							if (include(provider, false)) allow.push({ provider, explicit: false });
							if (include(provider, true)) allow.push({ provider, explicit: true });
						}
						if (allow.length === 0) return copied;
					}
					copied += await this.#sessions.inherit(sourceSessionId, targetSessionId, allow);
					for (const [provider, bySession] of this.#affinity) {
						const held = bySession.get(sourceSessionId);
						if (held && (include?.(provider, held.pinned !== undefined) ?? true)) {
							bySession.set(targetSessionId, { ...held });
						}
					}
					return copied;
				});
			},
			restrict: (provider, sessionId, identityKeys) => {
				this.#requireOpen();
				if (!provider || !sessionId) throw new Error("sessions.restrict requires a provider and a session id");
				const held: HeldRestriction = {
					provider,
					sessionId,
					identityKeys: [...identityKeys],
					lease: Symbol("sessions.restrict"),
					local: this.#localProviders.has(provider) || !AUTH_DAEMON_PROVIDERS.has(provider),
				};
				// A provider the daemon cannot serve is restricted on the owner as soon as one is open.
				if (!held.local) held.inner = this.#sessions.restrict(provider, sessionId, held.identityKeys);
				else if (this.#openedLocal) {
					held.inner = this.#openedLocal.sessions.restrict(provider, sessionId, held.identityKeys);
				}
				let bySession = this.#restrictions.get(provider);
				if (!bySession) this.#restrictions.set(provider, (bySession = new Map()));
				bySession.set(sessionId, held);
				this.#restrictionRevision++;
				return held.lease;
			},
			unrestrict: (provider, sessionId, lease) => {
				const bySession = this.#restrictions.get(provider);
				const held = bySession?.get(sessionId);
				if (!bySession || held?.lease !== lease) return;
				bySession.delete(sessionId);
				if (bySession.size === 0) this.#restrictions.delete(provider);
				this.#restrictionRevision++;
				if (held.inner === undefined) return;
				if (held.local) this.#openedLocal?.sessions.unrestrict(provider, sessionId, held.inner);
				else this.#sessions.unrestrict(provider, sessionId, held.inner);
			},
			permits: (provider, sessionId, credentialId) => {
				const owner = this.#ownerOf(provider);
				if (owner) return owner.sessions.permits(provider, sessionId, credentialId);
				if (!this.#isRestricted(provider, sessionId)) return true;
				if (!AUTH_DAEMON_PROVIDERS.has(provider)) {
					return this.#adopt([provider]).then(adopted =>
						adopted.sessions.permits(provider, sessionId, credentialId),
					);
				}
				// Only the daemon knows which rows a restriction admits; ask for the session's own view.
				return this.#dispatch(async () => {
					const scoped = await this.#metadata?.scopedSnapshot({ sessionId, providers: [provider] });
					return scoped?.[provider]?.credentials.some(row => row.id === credentialId) === true;
				});
			},
			release: async (provider, sessionId) => {
				const owner = await this.#route(provider);
				if (owner) return owner.sessions.release(provider, sessionId);
				return this.#dispatch(async () => {
					const released = await this.#sessions.release(provider, sessionId);
					this.#affinity.get(provider)?.delete(sessionId);
					return released;
				});
			},
			clear: async (provider, sessionId) => {
				const owner = await this.#route(provider);
				if (owner) return owner.sessions.clear(provider, sessionId);
				return this.#dispatch(async () => {
					await this.#sessions.clear(provider, sessionId);
					this.#affinity.get(provider)?.delete(sessionId);
				});
			},
		};
	}

	// ───────────────────────── usage ─────────────────────────

	#usageProvider(provider: Provider): UsageProvider | undefined {
		if (providerPauseReason(provider) !== undefined) return undefined;
		return (
			this.#runtimeUsage.get(provider)?.usageProvider ??
			this.#configuredUsage.get(provider) ??
			defaultUsageProvider(provider)
		);
	}

	/** The probe would go to an endpoint the daemon does not know: the caller's own, or a local provider's. */
	#callerEndpoint(provider: string, baseUrl: string | undefined): boolean {
		return (
			this.#localProviders.has(provider) ||
			!AUTH_DAEMON_PROVIDERS.has(provider) ||
			(baseUrl !== undefined && !isCatalogBaseUrl(provider, baseUrl))
		);
	}

	/** Usage for `provider` depends on something only this process holds: an adapter, an endpoint or a key. */
	#callerUsage(provider: Provider, baseUrl: string | undefined): boolean {
		if (this.#runtimeUsage.has(provider) || this.#configuredUsage.has(provider)) return true;
		if (this.#usageProvider(provider) === undefined) return false;
		if (this.#callerEndpoint(provider, baseUrl)) return true;
		const kind = this.#keys.source(provider)?.kind;
		return kind === "runtime" || kind === "config" || kind === "env";
	}

	async #daemonUsageReports(provider: Provider | undefined, signal?: AbortSignal): Promise<UsageReport[] | null> {
		const reply = await this.#request("usage-reports", { provider }, signal);
		if (reply !== null && !Array.isArray(reply)) invalidReply("usage-reports");
		try {
			const rejections = await this.#request("usage-auth-rejections", { provider }, signal);
			if (!Array.isArray(rejections)) invalidReply("usage-auth-rejections");
			if (provider === undefined) this.#authRejections.clear();
			else {
				for (const key of this.#authRejections.keys()) {
					if (key.startsWith(`${provider}:`)) this.#authRejections.delete(key);
				}
			}
			for (const row of rejections) {
				if (isRecord(row) && typeof row.provider === "string" && (row.status === 401 || row.status === 403)) {
					this.#authRejections.set(
						`${row.provider}:${rowId(row.credentialId, "usage-auth-rejections")}`,
						row.status,
					);
				}
			}
		} catch (error) {
			signal?.throwIfAborted();
			logger.debug("Daemon auth usage rejections were not refreshed", { error: String(error) });
		}
		return reply as UsageReport[] | null;
	}

	#usageApi(): UsageApi {
		return {
			reports: async options => {
				const { provider, baseUrlResolver, signal } = options ?? {};
				if (provider !== undefined) {
					if (!this.#callerUsage(provider, baseUrlResolver?.(provider))) {
						return this.#daemonUsageReports(provider, signal);
					}
					return (await this.localOwner()).usage.reports(options);
				}
				const candidates = new Set<Provider>([
					...this.#localProviders,
					...this.#runtimeUsage.keys(),
					...this.#configuredUsage.keys(),
				]);
				for (const usageProvider of DEFAULT_USAGE_PROVIDERS) candidates.add(usageProvider.id);
				const metadata = this.#metadata;
				for (const served of metadata?.providers() ?? []) {
					if (metadata?.lookup(served).has) candidates.add(served);
				}
				const local: Provider[] = [];
				for (const candidate of candidates) {
					if (this.#callerUsage(candidate, baseUrlResolver?.(candidate))) local.push(candidate);
				}
				const daemon = await this.#daemonUsageReports(undefined, signal);
				if (local.length === 0) return daemon;
				const owner = await this.localOwner();
				const perProvider = await Promise.all(
					local.map(candidate => owner.usage.reports({ provider: candidate, baseUrlResolver, signal })),
				);
				// The owner reads the same store, so its report replaces the daemon's for these providers.
				const reports = daemon?.filter(report => !local.includes(report.provider)) ?? [];
				let any = daemon !== null;
				for (const found of perProvider) {
					if (!found) continue;
					any = true;
					reports.push(...found);
				}
				return any ? reports : null;
			},
			ingestHeaders: (provider, headers, options) => {
				const owner = this.#ownerOf(provider);
				if (owner) return owner.usage.ingestHeaders(provider, headers, options);
				const sessionId = options?.sessionId;
				if (sessionId === undefined || this.#callerEndpoint(provider, options?.baseUrl)) return false;
				if (this.#usageProvider(provider)?.parseRateLimitHeaders === undefined) return false;
				// Only the provider's numeric quota headers are sent; the daemon accepts nothing else.
				const picked = pickAuthDaemonUsageHeaders(provider, headers);
				if (Object.keys(picked).length === 0) return false;
				const status = options?.responseStatus;
				return this.#request("usage-ingest-headers", {
					provider,
					sessionId,
					headers: picked,
					responseStatus: isAuthDaemonHttpStatus(status) ? status : undefined,
				}).then(
					ingested => ingested === true,
					error => {
						logger.debug("Daemon auth did not ingest usage headers", { provider, error: String(error) });
						return false;
					},
				);
			},
			invalidate: async (provider, signal) => {
				if (provider === undefined || !this.#callerEndpoint(provider, undefined)) {
					await this.#request("usage-invalidate", { provider }, signal);
				}
				// The owner is told only when it probes: for everything once open, else for a caller-owned provider.
				const local =
					provider === undefined ? this.#openedLocal !== undefined : this.#callerUsage(provider, undefined);
				if (local) await (await this.localOwner()).usage.invalidate(provider, signal);
			},
			history: () => refuse("usage.history", OWNER_SEAM),
			observe: entry => {
				const { provider, model, usage, costUsd, at, client } = entry;
				if (!AUTH_DAEMON_PROVIDERS.has(provider) || this.#localProviders.has(provider)) {
					this.#openedLocal?.usage.observe(entry);
					return;
				}
				// Reporting only: a lost observation is not an auth failure.
				this.#request("usage-observe", {
					provider,
					model,
					usage: {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
					},
					costUsd,
					at,
					client: client && { installId: client.installId, hostname: client.hostname, app: client.app },
				}).catch(error => {
					logger.debug("Daemon auth did not record observed usage", { provider, error: String(error) });
				});
			},
			recordClient: () => refuse("usage.recordClient", OWNER_SEAM),
			clientSummary: () => refuse("usage.clientSummary", OWNER_SEAM),
			providerFor: provider => this.#usageProvider(provider),
			authRejection: (provider, credentialId) => {
				const owner = this.#ownerOf(provider);
				return owner
					? owner.usage.authRejection(provider, credentialId)
					: this.#authRejections.get(`${provider}:${credentialId}`);
			},
			reportingModelIds: (provider, modelIds, reports) =>
				usageReportingModelIds(provider, modelIds, reports, defaultRankingStrategy(provider)),
			setProvider: (provider, usageProvider, apiKey) => {
				this.#runtimeUsage.set(provider, { usageProvider, apiKey });
				this.#openedLocal?.usage.setProvider(provider, usageProvider, apiKey);
			},
			removeProvider: provider => {
				this.#runtimeUsage.delete(provider);
				this.#openedLocal?.usage.removeProvider(provider);
			},
			replaceConfiguredProviders: providers => {
				this.#configuredUsage = new Map(providers);
				this.#openedLocal?.usage.replaceConfiguredProviders(providers);
			},
		};
	}

	// ───────────────────────── health, limits, resets ─────────────────────────

	#healthApi(): HealthApi {
		return {
			model: async (provider, options) => {
				options.signal?.throwIfAborted();
				if (providerPauseReason(provider) !== undefined) return UNKNOWN_HEALTH;
				const { sessionId, modelId, baseUrl, reserveFraction, signal } = options;
				const owner = this.#ownerOf(provider);
				if (owner) return owner.health.model(provider, options);
				// Same gate as the store owner: a caller-local key is outside the managed account pool.
				const restricted = this.#isRestricted(provider, sessionId);
				const origin = restricted ? "oauth" : this.#keys.source(provider)?.kind;
				if (origin !== "oauth" && origin !== "api_key") return UNKNOWN_HEALTH;
				if (this.#callerEndpoint(provider, baseUrl)) {
					// The local owner does not hold the session's restriction; it must not widen the pool it reports.
					if (restricted) return UNKNOWN_HEALTH;
					return (await this.localOwner()).health.model(provider, options);
				}
				const reply = await this.#request(
					"health-model",
					{ provider, modelId, sessionId, reserveFraction },
					signal,
				);
				if (
					!isRecord(reply) ||
					typeof reply.state !== "string" ||
					!HEALTH_STATES.includes(reply.state) ||
					!Array.isArray(reply.accounts)
				) {
					invalidReply("health-model");
				}
				return reply as unknown as ModelUsageHealth;
			},
			check: () => refuse("health.check", OWNER_SEAM),
		};
	}

	#limitsApi(): LimitsApi {
		const limits = this.#limits;
		return {
			markReached: async (provider, sessionId, options) => {
				const owner = await this.#route(provider);
				return owner
					? owner.limits.markReached(provider, sessionId, options)
					: limits.markReached(provider, sessionId, options);
			},
			rotate: async (provider, sessionId, options) => {
				const owner = await this.#route(provider);
				return owner
					? owner.limits.rotate(provider, sessionId, options)
					: limits.rotate(provider, sessionId, options);
			},
			markServiceTierUnavailable: async (provider, options) => {
				const owner = await this.#route(provider);
				return owner
					? owner.limits.markServiceTierUnavailable(provider, options)
					: limits.markServiceTierUnavailable(provider, options);
			},
			rearmServiceTier: async (provider, serviceTier, modelId, sessionId) => {
				const owner = await this.#route(provider);
				return owner
					? owner.limits.rearmServiceTier(provider, serviceTier, modelId, sessionId)
					: limits.rearmServiceTier(provider, serviceTier, modelId, sessionId);
			},
			invalidateMatching: async (provider, apiKey, options) => {
				const owner = await this.#route(provider);
				return owner
					? owner.limits.invalidateMatching(provider, apiKey, options)
					: limits.invalidateMatching(provider, apiKey, options);
			},
		};
	}

	#resetsApi(): ResetsApi {
		return {
			list: async options => {
				// An omitted provider is the saved-reset default, as on the store owner.
				const provider = options?.provider ?? "openai-codex";
				const { sessionId, signal } = options ?? {};
				if (this.#callerEndpoint(provider, options?.baseUrlResolver?.(provider))) {
					const owner = await this.#route(provider);
					if (!owner && this.#isRestricted(provider, sessionId)) {
						refuse("resets.list", "a restricted session cannot list saved resets on a custom endpoint");
					}
					return (owner ?? (await this.localOwner())).resets.list(options);
				}
				const reply = await this.#request("resets-list", { provider: options?.provider, sessionId }, signal);
				if (!Array.isArray(reply)) invalidReply("resets-list");
				return reply as ResetCreditAccountStatus[];
			},
			redeem: async options => {
				const { target, signal } = options;
				const { provider } = target;
				if (this.#callerEndpoint(provider, options.baseUrlResolver?.(provider))) {
					const owner = (await this.#route(provider)) ?? (await this.localOwner());
					return owner.resets.redeem(options);
				}
				const reply = await this.#request(
					"resets-redeem",
					{
						target: {
							provider,
							credentialId: target.credentialId,
							creditId: target.creditId || undefined,
							accountId: target.accountId || undefined,
							email: target.email || undefined,
							orgId: target.orgId || undefined,
						},
					},
					signal,
				);
				if (
					!isRecord(reply) ||
					typeof reply.ok !== "boolean" ||
					typeof reply.code !== "string" ||
					typeof reply.provider !== "string"
				) {
					invalidReply("resets-redeem");
				}
				return reply as unknown as ResetCreditRedeemOutcome;
			},
		};
	}

	// ───────────────────────── managed MCP grants ─────────────────────────

	/** Locate the stored MCP grant among `providerDigests` (ordered SHA-256 hex of candidate provider ids). */
	async mcpOAuthFind(providerDigests: readonly string[]): Promise<ManagedMcpOAuthMatch | null> {
		return this.#dispatch(async () => {
			// The epoch is read with the reply, inside the barrier a rebind has to pass.
			const reply = await this.#link.request("mcp-oauth-find", { providerDigests: [...providerDigests] });
			if (reply === null) return null;
			if (
				!isRecord(reply) ||
				typeof reply.candidateIndex !== "number" ||
				!Number.isSafeInteger(reply.candidateIndex) ||
				reply.candidateIndex < 0 ||
				typeof reply.requiresLocal !== "boolean"
			) {
				invalidReply("mcp-oauth-find");
			}
			return {
				credentialId: rowId(reply.credentialId, "mcp-oauth-find"),
				candidateIndex: reply.candidateIndex,
				requiresLocal: reply.requiresLocal,
				storeEpoch: this.#storeEpoch,
			};
		});
	}

	/** Access token of a grant found by {@link mcpOAuthFind}; rejects when the bound store changed since. */
	async mcpOAuthAccess(request: {
		credentialId: number;
		storeEpoch: number;
		forceRefresh?: boolean;
		resourceMode: "from-row-id" | "none";
	}): Promise<AuthDaemonMcpAccessResult> {
		const { credentialId, storeEpoch, forceRefresh, resourceMode } = request;
		return this.#dispatch(async () => {
			if (storeEpoch !== this.#storeEpoch) throw new ManagedAuthStoreChangedError();
			const reply = await this.#link.request("mcp-oauth-access", { credentialId, forceRefresh, resourceMode });
			if (!isRecord(reply)) invalidReply("mcp-oauth-access");
			switch (reply.kind) {
				case "requires-local":
					return { kind: "requires-local" };
				case "missing":
					if (typeof reply.removed !== "boolean") invalidReply("mcp-oauth-access");
					return { kind: "missing", removed: reply.removed };
				case "access": {
					const { accessToken, expires, refreshed, refreshFailed } = reply;
					if (
						typeof accessToken !== "string" ||
						!accessToken ||
						typeof expires !== "number" ||
						!Number.isFinite(expires) ||
						typeof refreshed !== "boolean"
					) {
						invalidReply("mcp-oauth-access");
					}
					return refreshFailed === true
						? { kind: "access", accessToken, expires, refreshed, refreshFailed }
						: { kind: "access", accessToken, expires, refreshed };
				}
				default:
					return invalidReply("mcp-oauth-access");
			}
		});
	}
}

/** Open the `AuthStorage` of a session whose daemon auth tunnel `options.link` is bound. */
export async function openManagedAuthStorage(options: ManagedAuthOptions): Promise<AuthStorage> {
	const backend = await ManagedAuth.open(options);
	const storage: TaggedAuthStorage = new AuthStorage(backend);
	storage[kManaged] = backend;
	return storage;
}

/** The managed view of `authStorage`; `undefined` when this process owns its credential store. */
export function managedAuth(authStorage: AuthStorage): ManagedAuth | undefined {
	return (authStorage as TaggedAuthStorage)[kManaged];
}

/**
 * A storage that owns its rows in this process: `authStorage` itself when it is local, else
 * the managed storage's local owner on the same store. Never close the result, and ask again
 * for each operation. After writing through it, `await authStorage.credentials.reload()`.
 */
export function localAuthOwner(authStorage: AuthStorage, storeEpoch?: number): Promise<AuthStorage> {
	const managed = managedAuth(authStorage);
	return managed ? managed.localOwner(storeEpoch) : Promise.resolve(authStorage);
}

/**
 * Make `providers` locally owned before code that reads their stored rows synchronously
 * (extension OAuth providers, `modifyModels`). Nothing to wait for on a local storage or
 * when every provider is already local.
 */
export function prepareLocalAuthForProviders(
	authStorage: AuthStorage,
	providers: Iterable<string>,
): Promise<void> | undefined {
	return managedAuth(authStorage)?.prepareLocal(providers);
}

/** Whether `provider`'s stored rows can be read synchronously from `authStorage`. */
export function isLocalAuthProvider(authStorage: AuthStorage, provider: string): boolean {
	const managed = managedAuth(authStorage);
	return managed === undefined || managed.isLocal(provider);
}

/** Identity of the stored OAuth account behind a bearer; `fileUploadAllowed` is `false` only when its grant lacks the scope. */
export interface StoredOAuthBearerIdentity {
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
	region?: string;
	inferenceRegion?: "global" | "eu" | "us";
	fileUploadAllowed?: boolean;
}

/**
 * The stored OAuth account whose access token is exactly `selectedBearer`, a bearer obtained
 * from this storage. A structured request key, or a key from the caller's runtime, config or
 * environment, matches nothing.
 */
export async function findStoredOAuthIdentity(
	authStorage: AuthStorage,
	provider: string,
	selectedBearer: string,
): Promise<StoredOAuthBearerIdentity | undefined> {
	const managed = managedAuth(authStorage);
	let row: StoredCredentialSummary | undefined;
	if (managed) {
		row = managed.servedOAuthRow(provider, selectedBearer);
	} else {
		for (const stored of authStorage.credentials.list(provider)) {
			if (stored.credential.type !== "oauth" || stored.credential.access !== selectedBearer) continue;
			row = summarizeStoredCredential(stored);
			break;
		}
	}
	if (row?.type !== "oauth") return undefined;
	return {
		credentialId: row.id,
		accountId: row.accountId,
		email: row.email,
		projectId: row.projectId,
		orgId: row.orgId,
		region: row.region,
		inferenceRegion: row.inferenceRegion,
		fileUploadAllowed: row.fileUploadAllowed,
	};
}
