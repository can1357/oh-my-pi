/**
 * What the host hands a session's callback is a copy, and the host never reads that copy again.
 *
 * Everything that crosses the callback boundary is live until the host has copied it, in either
 * direction. An author can install a getter on, or assign into, any object it is handed. When
 * that object is one the host keeps — a stored credential, the storage's logger, a response's
 * headers, the context the next provider is handed — the host's next read of it runs author code
 * outside the session's admission, after its retirement, or inside another session's call. So a
 * gated callback is handed a copy: changing it changes nothing the host keeps, and what the author
 * RETURNS is what the host keeps. A host registration is the host's own code and still receives
 * the host's objects; the controls at the end pin that.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type AuthStorageOptions,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { mergeRefreshedCredential } from "@oh-my-pi/pi-ai/auth/refresh";
// `report` serves credential selection and the usage cache, not the public `UsageApi`.
import type { UsageService } from "@oh-my-pi/pi-ai/auth/usage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageFetchContext, UsageLogger, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

const PROVIDER = "callback-argument-copy";
const OTHER = "callback-argument-copy-other";
const SOURCE = "callback-argument-copy-source";
const HOUR = 3_600_000;

const sessionScope = new AsyncLocalStorage<object>();
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface SessionGate extends ProviderCallGate {
	retired: boolean;
	readonly inside: boolean;
}

/** A session's gate as the host builds one: its admission is an async context. */
function sessionGate(): SessionGate {
	const session = {};
	const gate: SessionGate = {
		retired: false,
		get inside() {
			return sessionScope.getStore() === session;
		},
		run(call) {
			if (gate.retired) throw new Error("Extension session retired");
			return sessionScope.run(session, call);
		},
	};
	return gate;
}

/** Each read of an installed getter, and whether it ran as the session's work. */
type Reads = Array<{ field: string; inside: boolean }>;

/**
 * Installs on `target` the getter an author can install on anything it is handed: it answers
 * `authored` inside the session's admission and `substitute` anywhere else, recording each read.
 */
function rewire(target: object, field: string, gate: SessionGate, reads: Reads, authored: string, substitute: string) {
	Object.defineProperty(target, field, {
		configurable: true,
		enumerable: true,
		get() {
			const inside = gate.inside;
			reads.push({ field, inside });
			return inside ? authored : substitute;
		},
	});
}

function outside(reads: Reads): Reads {
	return reads.filter(read => !read.inside);
}

async function sqliteStorage(leases: boolean): Promise<AuthStorage> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	if (!leases) Object.assign(store, { tryAcquireCredentialRefreshLease: undefined });
	const auth = new AuthStorage(store);
	cleanups.push(() => {
		unregisterOAuthProviders(SOURCE);
		store.close();
	});
	await auth.credentials.reload();
	return auth;
}

function storedCredential(expires: number): AuthCredential {
	return {
		type: "oauth",
		access: "stored-access",
		refresh: "stored-refresh",
		expires,
		orgId: "org-a",
		region: "eu-old",
	};
}

function memoryStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	return {
		close() {},
		listAuthCredentials(provider?: string) {
			return provider === undefined ? rows : rows.filter(row => row.provider === provider);
		},
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		async replaceAuthCredentials() {
			return rows;
		},
		async upsertAuthCredential() {
			return rows;
		},
		async deleteAuthCredentials() {},
		getCache() {
			return null;
		},
		setCache() {},
		cleanExpiredCache() {},
	};
}

function usageRow(id: number, provider: string, accountId: string, expires = Date.now() + HOUR): StoredAuthCredential {
	return {
		id,
		provider,
		credential: { type: "oauth", access: "oat", refresh: "refresh", expires, accountId, orgId: "org-a" },
		disabledCause: null,
	};
}

async function usageStorage(rows: StoredAuthCredential[], options?: AuthStorageOptions): Promise<AuthStorage> {
	const storage = new AuthStorage(memoryStore(rows), { usageProviderResolver: () => undefined, ...options });
	cleanups.push(() => storage.close());
	await storage.credentials.reload();
	return storage;
}

/** The storage's usage service, whose per-credential `report` the public `UsageApi` omits. */
function usageService(storage: AuthStorage): UsageService {
	return storage.usage as UsageService;
}

function emptyReport(provider: string): UsageReport {
	return { provider, fetchedAt: 1, limits: [] };
}

function recordingLogger(): UsageLogger & { messages: string[] } {
	const messages: string[] = [];
	return {
		messages,
		debug(message) {
			messages.push(message);
		},
		warn(message) {
			messages.push(message);
		},
	};
}

describe("the credential refreshToken is handed", () => {
	test.each([
		{ leases: true, returned: "none", stored: { orgId: "org-a", region: "eu-old" } },
		{ leases: false, returned: "none", stored: { orgId: "org-a", region: "eu-old" } },
		{ leases: true, returned: "org-b", stored: { orgId: "org-b", region: undefined } },
		{ leases: false, returned: "org-b", stored: { orgId: "org-b", region: undefined } },
	])(
		"changing it changes nothing stored, and what it returns is kept (leases=$leases, returned org=$returned)",
		async ({ leases, returned, stored }) => {
			const gate = sessionGate();
			const auth = await sqliteStorage(leases);
			const reads: Reads = [];
			registerOAuthProvider(
				{
					name: "Argument copy",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + HOUR }),
					refreshToken: async (credentials: OAuthCredentials) => {
						rewire(credentials, "orgId", gate, reads, "authored-org", "substitute-org");
						credentials.region = "us-swapped";
						return {
							access: "refreshed-access",
							refresh: "refreshed-refresh",
							expires: Date.now() + HOUR,
							...(returned === "none" ? {} : { orgId: returned }),
						};
					},
				} as never,
				{ id: PROVIDER, sourceId: SOURCE, gate },
			);
			await auth.credentials.set(PROVIDER, [storedCredential(Date.now() - 1_000)]);

			const key = await auth.keys.get(PROVIDER, "argument-copy-session");
			const memory = auth.credentials.getOAuth(PROVIDER);
			await auth.credentials.reload();
			const persisted = auth.credentials.getOAuth(PROVIDER);

			expect(key).toBe("refreshed-access");
			expect(outside(reads)).toEqual([]);
			// The region stays paired with the organization the author returned, or with the stored one
			// when it returned none: never the stored region beside an id read from its argument.
			expect({ orgId: memory?.orgId, region: memory?.region }).toEqual(stored);
			expect({ access: persisted?.access, orgId: persisted?.orgId, region: persisted?.region }).toEqual({
				access: "refreshed-access",
				...stored,
			});
		},
	);
});

describe("the credential getApiKey is handed", () => {
	test.each([
		{ stale: false, retire: false },
		{ stale: false, retire: true },
		{ stale: true, retire: false },
		{ stale: true, retire: true },
	])(
		"changing it changes nothing stored; the key it returns is used (stale=$stale, retired during the call=$retire)",
		async ({ stale, retire }) => {
			const gate = sessionGate();
			const auth = await sqliteStorage(true);
			const reads: Reads = [];
			registerOAuthProvider(
				{
					name: "Argument copy",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + HOUR }),
					refreshToken: async () => ({
						access: "refreshed-access",
						refresh: "refreshed-refresh",
						expires: Date.now() + HOUR,
					}),
					getApiKey: (credentials: OAuthCredentials) => {
						rewire(credentials, "access", gate, reads, "authored-access", "substitute-access");
						rewire(credentials, "orgId", gate, reads, "authored-org", "substitute-org");
						credentials.region = "us-swapped";
						const key = credentials.access;
						if (retire) gate.retired = true;
						return key;
					},
				} as never,
				{ id: PROVIDER, sourceId: SOURCE, gate },
			);
			await auth.credentials.set(PROVIDER, [storedCredential(stale ? Date.now() - 1_000 : Date.now() + HOUR)]);
			const expectedAccess = stale ? "refreshed-access" : "stored-access";

			const key = await auth.keys.get(PROVIDER, "argument-copy-session");
			const memory = auth.credentials.getOAuth(PROVIDER);
			const memoryAccess = memory && Object.getOwnPropertyDescriptor(memory, "access");
			await auth.credentials.reload();
			const persisted = auth.credentials.getOAuth(PROVIDER);

			expect(key).toBe("authored-access");
			// The author read its own copy, inside; the host read nothing it had handed over.
			expect(reads).toEqual([{ field: "access", inside: true }]);
			expect(memoryAccess).toMatchObject({ value: expectedAccess });
			expect({ access: memory?.access, orgId: memory?.orgId, region: memory?.region }).toEqual({
				access: expectedAccess,
				orgId: "org-a",
				region: "eu-old",
			});
			expect({ access: persisted?.access, orgId: persisted?.orgId, region: persisted?.region }).toEqual({
				access: expectedAccess,
				orgId: "org-a",
				region: "eu-old",
			});
		},
	);
});

describe("the usage credential a session's provider is handed", () => {
	test.each(["supports", "fetchUsage"] as const)(
		"%s: changing it changes nothing the host reads afterwards",
		async route => {
			const gate = sessionGate();
			const storage = await usageStorage([usageRow(1, PROVIDER, "account")]);
			const reads: Reads = [];
			storage.usage.setProvider(
				PROVIDER,
				{
					id: PROVIDER,
					supports(params) {
						if (route === "supports")
							rewire(params.credential, "orgId", gate, reads, "authored-org", "substitute-org");
						return true;
					},
					async fetchUsage(params) {
						if (route === "fetchUsage")
							rewire(params.credential, "orgId", gate, reads, "authored-org", "substitute-org");
						return emptyReport(PROVIDER);
					},
				},
				undefined,
				gate,
			);

			const report = await usageService(storage).report(PROVIDER, storage.credentials.getOAuth(PROVIDER)!);

			expect(outside(reads)).toEqual([]);
			// The host attributes the report from its own credential, not from what the author left.
			expect(report?.metadata?.orgId).toBe("org-a");
		},
	);

	test.each(["supports", "fetchUsage"] as const)(
		"health %s: the completion probe uses the host's bearer, not what the author left",
		async route => {
			const gate = sessionGate();
			const storage = await usageStorage([usageRow(1, PROVIDER, "account")]);
			const reads: Reads = [];
			storage.usage.setProvider(
				PROVIDER,
				{
					id: PROVIDER,
					validatesCredentials: true,
					supports(params) {
						if (route === "supports") {
							rewire(params.credential, "accessToken", gate, reads, "authored-token", "substitute-token");
						}
						return true;
					},
					async fetchUsage(params) {
						if (route === "fetchUsage") {
							rewire(params.credential, "accessToken", gate, reads, "authored-token", "substitute-token");
						}
						return emptyReport(PROVIDER);
					},
				},
				undefined,
				gate,
			);
			const bearers: Array<string | undefined> = [];

			const [result] = await storage.health.check({
				completionProbe: async ({ credential }) => {
					bearers.push(credential.type === "oauth" ? credential.accessToken : credential.apiKey);
					return { ok: true };
				},
			});

			expect(result).toMatchObject({ provider: PROVIDER, ok: true });
			expect(outside(reads)).toEqual([]);
			expect(bearers).toEqual(["oat"]);
		},
	);
});

describe("the context a session's usage provider is handed", () => {
	test("reassigning its logger leaves the storage's logger as it was, and the host's later logging calls the host's", async () => {
		const gate = sessionGate();
		const hostLogger = recordingLogger();
		const hostDebug = hostLogger.debug;
		const hostWarn = hostLogger.warn;
		const fresh = usageRow(1, PROVIDER, "fresh-account");
		const expiring = usageRow(2, PROVIDER, "expiring-account", Date.now() + 1_000);
		const storage = await usageStorage([fresh, expiring], { usageLogger: hostLogger });
		const authorCalls: Array<{ message: string; inside: boolean }> = [];
		storage.usage.setProvider(
			PROVIDER,
			{
				id: PROVIDER,
				async fetchUsage(_params, ctx) {
					ctx.logger!.debug = message => authorCalls.push({ message, inside: gate.inside });
					ctx.logger!.warn = message => authorCalls.push({ message, inside: gate.inside });
					return emptyReport(PROVIDER);
				},
			},
			undefined,
			gate,
		);

		await usageService(storage).report(PROVIDER, fresh.credential);
		// Its refresh fails (no OAuth provider answers for it), and the host logs that before probing.
		await usageService(storage).report(PROVIDER, expiring.credential);

		expect(hostLogger.debug).toBe(hostDebug);
		expect(hostLogger.warn).toBe(hostWarn);
		expect(hostLogger.messages).toContain("Usage credential refresh failed, using original credential");
		expect(authorCalls.filter(call => !call.inside)).toEqual([]);
	});

	test("health: an assignment to the context one session's provider is handed reaches no other provider", async () => {
		const gate = sessionGate();
		const hostFetch = (async () => new Response("{}")) as unknown as typeof fetch;
		const authorFetch: UsageFetchContext["fetch"] = async () => new Response("{}");
		const storage = await usageStorage(
			[usageRow(1, PROVIDER, "session-account"), usageRow(2, OTHER, "host-account")],
			{
				usageFetch: hostFetch,
			},
		);
		storage.usage.setProvider(
			PROVIDER,
			{
				id: PROVIDER,
				validatesCredentials: true,
				async fetchUsage(_params, ctx) {
					ctx.fetch = authorFetch;
					return emptyReport(PROVIDER);
				},
			},
			undefined,
			gate,
		);
		const seen: Array<UsageFetchContext["fetch"]> = [];
		storage.usage.setProvider(OTHER, {
			id: OTHER,
			validatesCredentials: true,
			async fetchUsage(_params, ctx) {
				seen.push(ctx.fetch);
				return emptyReport(OTHER);
			},
		});

		const results = await storage.health.check();

		expect(results.map(result => [result.provider, result.ok])).toEqual([
			[PROVIDER, true],
			[OTHER, true],
		]);
		expect(seen.map(fetch => (fetch === hostFetch ? "host" : fetch === authorFetch ? "author" : "other"))).toEqual([
			"host",
		]);
	});
});

describe("the headers a session's rate-limit parser is handed", () => {
	test("changing them changes nothing in the caller's response headers", async () => {
		const gate = sessionGate();
		const storage = await usageStorage([usageRow(1, PROVIDER, "account")]);
		const reads: Reads = [];
		storage.usage.setProvider(
			PROVIDER,
			{
				id: PROVIDER,
				async fetchUsage() {
					return null;
				},
				parseRateLimitHeaders(headers) {
					rewire(headers, "x-limit", gate, reads, "1", "999");
					return emptyReport(PROVIDER);
				},
			},
			undefined,
			gate,
		);
		// The record `normalizeProviderResponse` builds, which agent-session hands on after ingest.
		const headers: Record<string, string> = { "x-limit": "1" };

		expect(storage.usage.ingestHeaders(PROVIDER, headers)).toBe(true);
		const nextReader = headers["x-limit"];

		expect(outside(reads)).toEqual([]);
		expect(nextReader).toBe("1");
		expect(Object.getOwnPropertyDescriptor(headers, "x-limit")).toMatchObject({ value: "1" });
	});
});

describe("mergeRefreshedCredential", () => {
	test("reads each field of the refreshed record once, and keeps no other organization's region", () => {
		let orgReads = 0;
		const refreshed = {
			access: "new",
			refresh: "new-refresh",
			expires: Date.now() + HOUR,
			get orgId(): string {
				orgReads++;
				return orgReads === 2 ? "org-a" : "org-b";
			},
		} as OAuthCredentials;

		const merged = mergeRefreshedCredential(
			{ type: "oauth", access: "old", refresh: "old-refresh", expires: 1, orgId: "org-a", region: "eu-old" },
			refreshed,
		);

		expect(orgReads).toBe(1);
		expect(merged.orgId).toBe("org-b");
		expect(merged.region).toBeUndefined();
	});
});

describe("a host registration still receives the host's own objects", () => {
	test("refreshToken and getApiKey are handed the stored record, and getApiKey's change to it is kept", async () => {
		const auth = await sqliteStorage(false);
		const handed: Record<string, unknown>[] = [];
		registerOAuthProvider(
			{
				name: "Host provider",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + HOUR }),
				refreshToken: async (credentials: OAuthCredentials) => {
					handed.push(credentials as unknown as Record<string, unknown>);
					return { access: "refreshed-access", refresh: "refreshed-refresh", expires: Date.now() + HOUR };
				},
				getApiKey: (credentials: OAuthCredentials) => {
					handed.push(credentials as unknown as Record<string, unknown>);
					credentials.email = "host-set@example.com";
					return credentials.access;
				},
			} as never,
			{ id: PROVIDER, sourceId: SOURCE },
		);
		await auth.credentials.set(PROVIDER, [storedCredential(Date.now() - 1_000)]);

		const key = await auth.keys.get(PROVIDER, "argument-copy-session");
		await auth.credentials.reload();

		expect(key).toBe("refreshed-access");
		// The stored record itself, `type` and all, not a copy by the credential schema. By the time
		// `getApiKey` runs, the preflight refresh has already stored the refreshed record.
		expect(handed.map(credentials => credentials.type)).toEqual(["oauth", "oauth"]);
		expect(auth.credentials.getOAuth(PROVIDER)?.email).toBe("host-set@example.com");
	});

	test("usage callbacks are handed the request's credential, the storage's logger and the caller's headers", async () => {
		const hostLogger = recordingLogger();
		const storage = await usageStorage([usageRow(1, PROVIDER, "account")], { usageLogger: hostLogger });
		const credentials: object[] = [];
		const loggers: unknown[] = [];
		const handedHeaders: object[] = [];
		const provider: UsageProvider = {
			id: PROVIDER,
			supports(params) {
				credentials.push(params.credential);
				return true;
			},
			async fetchUsage(params, ctx) {
				credentials.push(params.credential);
				loggers.push(ctx.logger);
				return emptyReport(PROVIDER);
			},
			parseRateLimitHeaders(headers) {
				handedHeaders.push(headers);
				return emptyReport(PROVIDER);
			},
		};
		storage.usage.setProvider(PROVIDER, provider);
		const headers = { "x-limit": "1" };

		await usageService(storage).report(PROVIDER, storage.credentials.getOAuth(PROVIDER)!);
		storage.usage.ingestHeaders(PROVIDER, headers);

		expect(credentials).toHaveLength(2);
		expect(credentials[0]).toBe(credentials[1]!);
		expect(loggers).toEqual([hostLogger]);
		expect(loggers[0]).toBe(hostLogger);
		expect(handedHeaders).toHaveLength(1);
		expect(handedHeaders[0]).toBe(headers);
	});

	test("health hands every host provider the one shared context", async () => {
		const hostLogger = recordingLogger();
		const storage = await usageStorage([usageRow(1, PROVIDER, "first"), usageRow(2, OTHER, "second")], {
			usageLogger: hostLogger,
		});
		const contexts: UsageFetchContext[] = [];
		for (const name of [PROVIDER, OTHER]) {
			storage.usage.setProvider(name, {
				id: name,
				validatesCredentials: true,
				async fetchUsage(_params, ctx) {
					contexts.push(ctx);
					return emptyReport(name);
				},
			});
		}

		await storage.health.check();

		expect(contexts).toHaveLength(2);
		expect(contexts[0]).toBe(contexts[1]!);
		expect(contexts[0]!.logger).toBe(hostLogger);
	});
});
