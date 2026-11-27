import { readlink, realpath } from "node:fs/promises";
import * as path from "node:path";
import {
	type OpenAuthCredentialStoreOptions,
	type OpenedAuthCredentialStore,
	openAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-broker/discover";
import { HybridAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-broker/hybrid-store";
import type { AuthBrokerProviderPool } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import { flushAuthBrokerSnapshotCacheWrites } from "@oh-my-pi/pi-ai/auth-broker/snapshot-cache";
import {
	type AuthAccountPolicies,
	type AuthCredentialStore,
	AuthStorage,
	type SessionRestrictionLease,
} from "@oh-my-pi/pi-ai/auth-storage";
import { type ProviderPauseScope, createProviderPauseScope } from "@oh-my-pi/pi-ai/registry/oauth";
import { isEnoent, isFsError, logger } from "@oh-my-pi/pi-utils";
import { type AuthDaemonBinding, MAX_AUTH_DAEMON_SESSION_ID_LENGTH } from "./auth-daemon-contract";

const CREDENTIAL_POLL_MS = 1000;
// The auth unit also stops after 30 seconds idle. Expire individual unused
// views even while another profile keeps the unit alive.
const AUTH_VIEW_IDLE_MS = 30_000;
const MAX_IDLE_AUTH_VIEWS = 8;
const MAX_LEASE_SESSION_SCOPES = 1024;

/** The file need not exist yet; resolve aliases of its existing ancestors too. */
async function canonicalDbPath(file: string): Promise<string> {
	try {
		return await realpath(file);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		const parent = path.dirname(file);
		if (parent === file) throw error;
		// realpath also fails for a dangling symlink. Use its eventual target as the key.
		let target: string | undefined;
		try {
			target = await readlink(file);
		} catch (linkError) {
			if (!isEnoent(linkError) && !(isFsError(linkError) && linkError.code === "EINVAL")) throw linkError;
		}
		return target === undefined
			? path.join(await canonicalDbPath(parent), path.basename(file))
			: canonicalDbPath(path.resolve(parent, target));
	}
}

/** Normalize map/set order, but keep unrestricted and explicitly empty allowlists distinct. */
function brokerAccountPool(entries: NonNullable<AuthDaemonBinding["broker"]>["accountPool"]) {
	const pool = new Map<string, AuthBrokerProviderPool>();
	for (const { provider, accounts, apiKeys } of entries) {
		pool.set(provider, { accounts: accounts === undefined ? undefined : new Set(accounts), apiKeys });
	}
	const key = Array.from(pool, ([provider, rule]): [string, string[] | null, boolean] => [
		provider,
		rule.accounts === undefined ? null : Array.from(rule.accounts).sort(),
		rule.apiKeys ?? true,
	]).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return { pool: pool.size === 0 ? null : pool, key };
}

/** Own the policy data and give it a field-order-independent cache key. */
function copyPolicies(policies: AuthAccountPolicies): AuthAccountPolicies {
	return policies.map(({ provider, account, priority, reservePct, reclaimAbovePct }) => ({
		provider,
		account: {
			email: account.email,
			accountId: account.accountId,
			projectId: account.projectId,
			orgId: account.orgId,
		},
		priority,
		reservePct,
		reclaimAbovePct,
	}));
}

/** SQLite's external probe ignores writes made on its own connection. Fan those out as well. */
const STORE_MUTATIONS: Partial<Record<keyof AuthCredentialStore, true>> = {
	updateAuthCredential: true,
	deleteAuthCredential: true,
	tryDisableAuthCredentialIfMatches: true,
	tryUpdateAuthCredentialIfMatches: true,
	replaceAuthCredentials: true,
	upsertAuthCredential: true,
	deleteAuthCredentials: true,
	upsertCredentialBlock: true,
	deleteCredentialBlock: true,
	deleteCredentialBlocks: true,
};

class BackingStore {
	readonly opened: Promise<OpenedAuthCredentialStore>;
	readonly views = new Map<string, PolicyView>();
	/** Includes retiring views until their last OAuth refresh has finished saving. */
	retainedViews = 0;
	#store?: AuthCredentialStore;
	#revision = 0;

	constructor(options: OpenAuthCredentialStoreOptions) {
		this.opened = openAuthCredentialStore(options).then(opened => {
			this.#store = opened.store;
			return opened;
		});
	}

	/** Local view only: each pool consumes its own revision, and cannot close the shared store. */
	forView(store: AuthCredentialStore): AuthCredentialStore {
		let seen = this.#revision;
		const pollExternalChanges = () => {
			if (store.pollExternalChanges?.()) this.#revision++;
			if (seen === this.#revision) return false;
			seen = this.#revision;
			return true;
		};
		const completeMutation = (value: unknown) => {
			if (value !== false) this.#revision++;
			return value;
		};
		const methods = new Map<PropertyKey, unknown>();
		let closed = false;
		const close = () => {
			closed = true;
			methods.clear();
		};
		return new Proxy(store, {
			get(target, property) {
				if (property === "close") return close;
				if (closed) throw new Error("Auth credential store view is closed");
				if (property === "pollExternalChanges") return pollExternalChanges;
				const cached = methods.get(property);
				if (cached !== undefined) return cached;
				const value: unknown = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				const method =
					STORE_MUTATIONS[property as keyof AuthCredentialStore] === true
						? (...args: unknown[]) => {
								const result: unknown = Reflect.apply(value, target, args);
								return result instanceof Promise ? result.then(completeMutation) : completeMutation(result);
							}
						: value.bind(target);
				methods.set(property, method);
				return method;
			},
		});
	}

	routesToBroker(provider: string): boolean {
		return this.#store instanceof HybridAuthCredentialStore && this.#store.routesToBroker(provider);
	}

	close(): void {
		this.#store?.close();
	}
}

/** AuthStorage modules are shared only by leases with identical routing policies. */
class PolicyView {
	readonly ready: Promise<AuthStorage>;
	readonly pauseScope: ProviderPauseScope;
	references = 0;
	#pollTimer?: NodeJS.Timeout;
	#poll?: Promise<void>;
	#activation?: Promise<void>;
	#pollFailed = false;
	#idle = false;
	#stopping = false;

	constructor(
		backing: BackingStore,
		accountPolicies: AuthAccountPolicies,
		defaultReservePct: number,
		unpausedProviders: readonly string[],
	) {
		this.pauseScope = createProviderPauseScope(unpausedProviders);
		this.ready = backing.opened.then(({ store, sourceLabel }) =>
			this.pauseScope.run(async () => {
				if (this.#stopping) throw new Error("Auth daemon owner is closed");
				const storage = AuthStorage.forStoredAuth(backing.forView(store), {
					accountPolicies,
					defaultReservePct,
					sourceLabel,
				});
				try {
					await storage.credentials.reload();
				} catch (error) {
					await storage.closeAndDrain();
					throw error;
				}
				return storage;
			}),
		);
	}

	/** Before returning a warm view to its caller, adopt external changes from its idle period. */
	activate(storage: AuthStorage): Promise<void> | undefined {
		if (this.#pollTimer !== undefined) return;
		return (this.#activation ??= this.#startPolling(storage).finally(() => {
			this.#activation = undefined;
		}));
	}

	async #startPolling(storage: AuthStorage): Promise<void> {
		if (this.#idle) {
			// A poll that started before idling can still be draining.
			await this.#poll;
			if (this.#stopping) return;
			await this.pauseScope.run(async () => {
				const changed = await storage.credentials.poll();
				// A failed reload may already have consumed the backing change revision.
				if (!changed && this.#pollFailed) await storage.credentials.reload();
			});
			this.#pollFailed = false;
			this.#idle = false;
		}
		if (this.#stopping) return;
		this.#pollTimer = setInterval(() => {
			this.#poll ??= this.pauseScope.run(() => this.#reconcile(storage));
		}, CREDENTIAL_POLL_MS).unref();
	}

	idle(): void {
		this.#idle = true;
		clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	async #reconcile(storage: AuthStorage): Promise<void> {
		try {
			if (await storage.credentials.poll()) this.#pollFailed = false;
		} catch {
			this.#pollFailed = true;
			logger.debug("Daemon auth credential reconciliation failed");
		} finally {
			this.#poll = undefined;
		}
	}

	async close(): Promise<void> {
		this.#stopping = true;
		this.idle();
		const storage = await this.ready.catch(() => undefined);
		if (storage === undefined) return;
		await this.#activation?.catch(() => undefined);
		await this.#poll;
		await this.pauseScope.run(() => storage.closeAndDrain());
	}
}

/** Server-only ownership of an immutable-policy auth view and its private session namespace. */
export interface AuthDaemonLease {
	readonly storage: AuthStorage;
	/** Whether this lease stores the provider's credentials with its broker. */
	routesToBroker(provider: string): boolean;
	/** Keep the caller's provider pause state for the entire handler, including awaited work. */
	run<T>(fn: () => T): T;
	sessionId(sessionId: string, provider?: string): string;
	sessionId(sessionId: string | undefined, provider?: string): string | undefined;
	restrict(provider: string, sessionId: string, identityKeys: readonly string[]): SessionRestrictionLease;
	unrestrict(provider: string, sessionId: string, restriction: SessionRestrictionLease): void;
	clearSession(provider: string, sessionId: string): void;
	close(): void;
}

class Lease implements AuthDaemonLease {
	readonly #prefix = `daemon:${crypto.randomUUID()}:`;
	readonly #sessions = new Map<string, Map<string, SessionRestrictionLease | undefined>>();
	#sessionScopes = 0;
	#closed = false;

	constructor(
		readonly storage: AuthStorage,
		readonly pauseScope: ProviderPauseScope,
		readonly routesToBroker: (provider: string) => boolean,
		readonly onClose: () => void,
	) {}

	run<T>(fn: () => T): T {
		if (this.#closed) throw new Error("Auth daemon lease is closed");
		return this.pauseScope.run(fn);
	}

	sessionId(sessionId: string, provider?: string): string;
	sessionId(sessionId: string | undefined, provider?: string): string | undefined;
	sessionId(sessionId: string | undefined, provider?: string): string | undefined {
		if (this.#closed) throw new Error("Auth daemon lease is closed");
		if (sessionId === undefined) return undefined;
		if (sessionId.length === 0 || sessionId.length > MAX_AUTH_DAEMON_SESSION_ID_LENGTH) {
			throw new Error("Invalid auth daemon session id length");
		}
		const scoped = this.#prefix + sessionId;
		if (provider !== undefined) this.#touch(provider, scoped);
		else for (const current of this.storage.storedAuthProviders()) this.#touch(current, scoped);
		return scoped;
	}

	#touch(provider: string, scoped: string): void {
		let sessions = this.#sessions.get(provider);
		if (sessions?.has(scoped)) return;
		// Reject new scopes rather than ever evicting a live deny/allowlist.
		if (this.#sessionScopes >= MAX_LEASE_SESSION_SCOPES) throw new Error("Too many auth daemon session scopes");
		if (sessions === undefined) this.#sessions.set(provider, (sessions = new Map()));
		sessions.set(scoped, undefined);
		this.#sessionScopes++;
	}

	restrict(provider: string, sessionId: string, identityKeys: readonly string[]): SessionRestrictionLease {
		const scoped = this.sessionId(sessionId, provider);
		const restriction = this.storage.sessions.restrict(provider, scoped, identityKeys);
		this.#sessions.get(provider)!.set(scoped, restriction);
		return restriction;
	}

	unrestrict(provider: string, sessionId: string, restriction: SessionRestrictionLease): void {
		const scoped = this.#prefix + sessionId;
		const sessions = this.#sessions.get(provider);
		if (sessions?.get(scoped) !== restriction) return;
		this.storage.sessions.unrestrict(provider, scoped, restriction);
		sessions.set(scoped, undefined);
	}

	clearSession(provider: string, sessionId: string): void {
		const scoped = this.#prefix + sessionId;
		const sessions = this.#sessions.get(provider);
		if (!sessions?.has(scoped)) return;
		this.#clear(provider, scoped, sessions.get(scoped));
		sessions.delete(scoped);
		this.#sessionScopes--;
		if (sessions.size === 0) this.#sessions.delete(provider);
	}

	#clear(provider: string, scoped: string, restriction: SessionRestrictionLease | undefined): void {
		const sessions = this.storage.sessions;
		if (restriction !== undefined) sessions.unrestrict(provider, scoped, restriction);
		sessions.clear(provider, scoped);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.pauseScope.run(() => {
				for (const [provider, sessions] of this.#sessions) {
					for (const [scoped, restriction] of sessions) this.#clear(provider, scoped, restriction);
				}
			});
		} finally {
			this.#sessions.clear();
			this.onClose();
		}
	}
}

/** Owns active daemon credential stores and a bounded cache of recently used views. */
export class AuthDaemonOwner {
	readonly #stores = new Map<string, BackingStore>();
	readonly #leases = new Set<AuthDaemonLease>();
	readonly #idleViews = new Map<PolicyView, { timer: NodeJS.Timeout; retire: () => void }>();
	readonly #retiring = new Set<Promise<void>>();
	#closing?: Promise<void>;

	async bind(binding: AuthDaemonBinding): Promise<AuthDaemonLease> {
		if (this.#closing !== undefined) throw new Error("Auth daemon owner is closed");
		const { broker, dbPath: requestedPath, encrypt, retryUnreachableBroker, defaultReservePct } = binding;
		if (
			!path.isAbsolute(requestedPath) ||
			(broker !== null && broker.ttlMs > 0 && !path.isAbsolute(broker.cachePath))
		) {
			throw new Error("Auth daemon requires absolute credential store paths");
		}
		const accountPolicies = copyPolicies(binding.accountPolicies);
		const unpausedProviders = Array.from(new Set(binding.unpausedProviders)).sort();
		const policyKey = JSON.stringify([defaultReservePct, accountPolicies, unpausedProviders], (_, value: unknown) =>
			typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
		);
		const brokerConfig = broker === null ? null : { url: broker.url, token: broker.token };
		const cachePath = broker?.cachePath;
		const snapshotTtlMs = broker?.ttlMs ?? 0;
		const accountPool = broker === null ? null : brokerAccountPool(broker.accountPool);
		const dbPath = await canonicalDbPath(path.resolve(requestedPath));
		if (this.#closing !== undefined) throw new Error("Auth daemon owner is closed");
		const storeKey = JSON.stringify([
			dbPath,
			encrypt,
			brokerConfig === null
				? null
				: [
						brokerConfig.url,
						Bun.SHA256.hash(brokerConfig.token, "hex"),
						cachePath,
						snapshotTtlMs,
						accountPool?.key,
						retryUnreachableBroker,
					],
		]);
		let backing = this.#stores.get(storeKey);
		if (backing === undefined) {
			backing = new BackingStore({
				agentDir: path.dirname(dbPath),
				accountPool: accountPool?.pool ?? null,
				brokerConfig,
				cachePath,
				dbPath,
				encrypt,
				requireUnlocked: true,
				retryUnreachableBroker,
				snapshotTtlMs,
			});
			this.#stores.set(storeKey, backing);
			const opening = backing;
			void opening.opened.catch(() => {
				if (this.#stores.get(storeKey) === opening) this.#stores.delete(storeKey);
			});
		}
		const entry = backing;
		let view = entry.views.get(policyKey);
		if (view === undefined) {
			view = new PolicyView(entry, accountPolicies, defaultReservePct, unpausedProviders);
			entry.views.set(policyKey, view);
			entry.retainedViews++;
		}
		const retained = view;
		this.#removeIdle(retained);
		retained.references++;
		const retire = () => this.#retireView(storeKey, entry, policyKey, retained);
		try {
			const storage = await retained.ready;
			if (this.#closing !== undefined) throw new Error("Auth daemon owner is closed");
			const activation = retained.activate(storage);
			if (activation !== undefined) await activation;
			if (this.#closing !== undefined) throw new Error("Auth daemon owner is closed");
			const lease = new Lease(
				storage,
				retained.pauseScope,
				provider => entry.routesToBroker(provider),
				() => {
					this.#leases.delete(lease);
					if (--retained.references === 0) this.#keepIdle(retained, retire);
				},
			);
			this.#leases.add(lease);
			return lease;
		} catch (error) {
			if (--retained.references === 0) retire();
			throw error;
		}
	}

	#keepIdle(view: PolicyView, retire: () => void): void {
		view.idle();
		const timer = setTimeout(retire, AUTH_VIEW_IDLE_MS).unref();
		this.#idleViews.set(view, { timer, retire });
		if (this.#idleViews.size > MAX_IDLE_AUTH_VIEWS) this.#idleViews.values().next().value?.retire();
	}

	#removeIdle(view: PolicyView): void {
		const idle = this.#idleViews.get(view);
		if (idle === undefined) return;
		clearTimeout(idle.timer);
		this.#idleViews.delete(view);
	}

	#retireView(storeKey: string, backing: BackingStore, policyKey: string, view: PolicyView): void {
		if (backing.views.get(policyKey) !== view) return;
		this.#removeIdle(view);
		backing.views.delete(policyKey);
		const retirement = view.close().finally(() => {
			if (--backing.retainedViews !== 0) return;
			try {
				backing.close();
			} finally {
				if (this.#stores.get(storeKey) === backing) this.#stores.delete(storeKey);
			}
		});
		this.#retiring.add(retirement);
		void retirement.then(
			() => this.#retiring.delete(retirement),
			() => {
				this.#retiring.delete(retirement);
				logger.warn("Daemon auth credential store close failed");
			},
		);
	}

	close(): Promise<void> {
		return (this.#closing ??= this.#close());
	}

	async #close(): Promise<void> {
		for (const lease of this.#leases) lease.close();
		for (const [storeKey, backing] of this.#stores) {
			for (const [policyKey, view] of backing.views) this.#retireView(storeKey, backing, policyKey, view);
		}
		const results = await Promise.allSettled(this.#retiring);
		await flushAuthBrokerSnapshotCacheWrites();
		const failed = results.find(result => result.status === "rejected");
		if (failed) throw failed.reason;
	}
}
