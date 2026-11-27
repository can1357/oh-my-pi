import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AuthCredential, AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { isRecord } from "@oh-my-pi/pi-utils";
import { daemonClient } from "../../src/daemon/client";
import { openManagedAuthStorage } from "../../src/session/auth-daemon-backend";
import { AUTH_DAEMON_KIND, type AuthDaemonBinding } from "../../src/session/auth-daemon-contract";
import { AuthDaemonBindingError, type AuthDaemonLink, openAuthDaemonLink } from "../../src/session/auth-daemon-link";
import { IsolatedDaemon, waitFor } from "../fixtures/daemon-harness";

const TEST_TIMEOUT_MS = 15_000;

function apiKey(key: string): AuthCredential {
	return { type: "api_key", key };
}

function oauth(name: string, fields?: Partial<OAuthCredential>): OAuthCredential {
	return {
		type: "oauth",
		access: `fixture-access-${name}`,
		refresh: `fixture-refresh-${name}`,
		expires: Date.now() + 24 * 60 * 60_000,
		accountId: name,
		...fields,
	};
}

function stored(result: unknown): { apiKey: string; credentialId: number } {
	if (!isRecord(result) || result.kind !== "stored" || !isRecord(result.resolved)) {
		throw new Error(`Expected a stored auth selection, received ${isRecord(result) ? result.kind : "no result"}`);
	}
	const { apiKey, credentialId } = result.resolved;
	if (typeof apiKey !== "string" || typeof credentialId !== "number") {
		throw new Error("Stored auth selection was missing its key or credential id");
	}
	return { apiKey, credentialId };
}

function resolve(link: AuthDaemonLink, provider: string, sessionId?: string): Promise<unknown> {
	return link.request("resolve", { provider, sessionId });
}

describe("daemon auth module", () => {
	let daemon: IsolatedDaemon | undefined;
	let root: string;
	const links: AuthDaemonLink[] = [];

	beforeAll(async () => {
		daemon = await IsolatedDaemon.create();
		root = await fs.realpath(daemon.dir);
	});

	afterEach(() => {
		for (const link of links.splice(0)) link.close();
	});

	afterAll(async () => {
		await daemon?.dispose();
	});

	async function profile(...rows: [provider: string, credential: AuthCredential][]): Promise<AuthDaemonBinding> {
		const dir = await fs.mkdtemp(path.join(root, "profile-"));
		const dbPath = path.join(dir, "agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath, { encrypt: false });
		try {
			for (const [provider, credential] of rows) await store.upsertAuthCredential(provider, credential);
		} finally {
			store.close();
		}
		return {
			dbPath,
			encrypt: false,
			broker: null,
			retryUnreachableBroker: false,
			accountPolicies: [],
			defaultReservePct: 0,
			unpausedProviders: [],
		};
	}

	async function bind(binding: AuthDaemonBinding): Promise<AuthDaemonLink> {
		const link = await openAuthDaemonLink(binding);
		if (!link) throw new Error("Expected native daemon auth support");
		links.push(link);
		return link;
	}

	async function waitForLeases(count: number): Promise<void> {
		const client = await daemonClient();
		await waitFor(
			async () => {
				const { units } = await client.request({ op: "list", kind: AUTH_DAEMON_KIND });
				return units[0]?.leases === count;
			},
			`${count} auth daemon leases`,
			3_000,
		);
	}

	it(
		"returns only selected request access and keeps credential material out of availability",
		async () => {
			const key = "fixture-static-key";
			const copilot = oauth("copilot", {
				enterpriseUrl: "copilot.example.test",
				apiEndpoint: "https://api.copilot.example.test",
			});
			const snowflake = oauth("snowflake", { enterpriseUrl: "https://fixture.snowflakecomputing.com" });
			const expired = oauth("expired", { expires: 1, refresh: "" });
			const link = await bind(
				await profile(
					["openai", apiKey(key)],
					["github-copilot", copilot],
					["snowflake", snowflake],
					["anthropic", expired],
				),
			);

			expect(stored(await resolve(link, "openai")).apiKey).toBe(key);
			for (const [provider, credential, expected] of [
				[
					"github-copilot",
					copilot,
					{ token: copilot.access, enterpriseUrl: copilot.enterpriseUrl, apiEndpoint: copilot.apiEndpoint },
				],
				["snowflake", snowflake, { token: snowflake.access, enterpriseUrl: snowflake.enterpriseUrl }],
			] as const) {
				const result = await resolve(link, provider);
				const selection = stored(result);
				expect(JSON.parse(selection.apiKey)).toEqual(expected);
				expect(JSON.stringify(result)).not.toContain(credential.refresh);
				expect(JSON.parse(stored(await link.request("peek", { provider })).apiKey)).toEqual(expected);

				const access = await link.request("oauth-access", { provider });
				expect(access).toMatchObject({ accessToken: credential.access, credentialId: selection.credentialId });
				expect(JSON.stringify(access)).not.toContain(credential.refresh);
			}

			// An expired, nonrenewable grant remains visible as metadata, never refreshed by peek.
			expect(await link.request("peek", { provider: "anthropic" })).toEqual({ kind: "missing" });
			expect(
				stored(await link.request("peek", { provider: "anthropic", options: { includeExpired: true } })).apiKey,
			).toBe(expired.access);
			const state = await link.request("availability", {
				providers: ["openai", "github-copilot", "snowflake", "anthropic"],
			});
			expect(state).toMatchObject({
				providers: {
					openai: { has: true, hasOAuth: false, credentials: [{ type: "api_key" }] },
					"github-copilot": { has: true, hasOAuth: true, credentials: [{ type: "oauth", accountId: "copilot" }] },
					snowflake: { has: true, hasOAuth: true, credentials: [{ type: "oauth", accountId: "snowflake" }] },
					anthropic: { has: true, hasOAuth: true, credentials: [{ type: "oauth", expires: expired.expires }] },
				},
			});
			const emitted = JSON.stringify(state);
			for (const secret of [
				key,
				copilot.access,
				copilot.refresh,
				snowflake.access,
				snowflake.refresh,
				expired.access,
			]) {
				expect(emitted).not.toContain(secret);
			}
			for (const rawField of ['"key":', '"access":', '"refresh":']) expect(emitted).not.toContain(rawField);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"isolates profile databases and leaves a peer tunnel usable after close",
		async () => {
			const firstKey = "fixture-profile-first";
			const secondKey = "fixture-profile-second";
			const first = await bind(await profile(["openai", apiKey(firstKey)]));
			const second = await bind(await profile(["openai", apiKey(secondKey)]));

			expect(stored(await resolve(first, "openai", "shared-session")).apiKey).toBe(firstKey);
			expect(stored(await resolve(second, "openai", "shared-session")).apiKey).toBe(secondKey);
			first.close();
			await waitForLeases(1);
			expect(stored(await resolve(second, "openai", "shared-session")).apiKey).toBe(secondKey);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"rejects a configured broker binding instead of using the available local credential",
		async () => {
			const key = "fixture-local-fallback-key";
			const binding = await profile(["openai", apiKey(key)]);
			const local = await bind(binding);
			expect(stored(await resolve(local, "openai")).apiKey).toBe(key);

			let requests = 0;
			const broker = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					requests++;
					return new Response(null, { status: 401 });
				},
			});
			try {
				const rejected = openAuthDaemonLink({
					...binding,
					broker: {
						url: broker.url.href,
						token: "fixture-rejected-broker-token",
						cachePath: path.join(path.dirname(binding.dbPath), "broker-cache.json"),
						ttlMs: 0,
						accountPool: [],
					},
				}).then(link => link?.close());
				await expect(rejected).rejects.toBeInstanceOf(AuthDaemonBindingError);
				await expect(rejected).rejects.toMatchObject({ kind: "broker", status: 401 });
				expect(requests).toBe(1);
			} finally {
				await broker.stop(true);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"routes a hybrid store's local OAuth row through a negative credential id",
		async () => {
			const provider = "anthropic";
			const credential = oauth("hybrid");
			const binding = await profile([provider, credential]);
			const local = await SqliteAuthCredentialStore.open(binding.dbPath);
			local.markBrokerLocalProvider(provider);
			local.close();
			const brokerStorage = await AuthStorage.create(path.join(path.dirname(binding.dbPath), "broker.db"));
			const token = "fixture-broker-token";
			const broker = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [token],
				disableRefresher: true,
			});
			try {
				const link = await bind({
					...binding,
					broker: {
						url: broker.url,
						token,
						cachePath: path.join(path.dirname(binding.dbPath), "broker-cache.json"),
						ttlMs: 0,
						accountPool: [],
					},
				});
				const sessionId = "hybrid-session";
				const { credentialId } = stored(await resolve(link, provider, sessionId));
				expect(credentialId).toBeLessThan(0);
				expect(await link.request("session-pin", { provider, sessionId, credentialId })).toBe(true);
				expect(await link.request("oauth-access", { provider, sessionId, credentialId })).toMatchObject({
					credentialId,
					accessToken: credential.access,
				});
				expect(await link.request("credential-destination", { provider })).toBe(false);
				link.close();
			} finally {
				await broker.close();
				brokerStorage.close();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps queued reads alive when one saturated caller is cancelled",
		async () => {
			const key = "fixture-queued-key";
			const link = await bind(await profile(["openai", apiKey(key)]));
			const reads = Array.from({ length: 40 }, (_, index) => resolve(link, "openai", `parallel-${index}`));
			const abort = new AbortController();
			const cancelled = link.request("resolve", { provider: "openai" }, abort.signal);
			abort.abort();
			await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
			expect((await Promise.all(reads)).map(reply => stored(reply).apiKey)).toEqual(Array(40).fill(key));
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"rebinds a live session without exposing local keys or expanding its restricted account pool",
		async () => {
			const provider = "anthropic";
			const sessionId = "restricted-chat";
			const a = oauth("a");
			const b = oauth("b");
			const binding = await profile([provider, a], [provider, b]);
			const link = await bind(binding);
			const storage = await openManagedAuthStorage({
				binding,
				link,
				localOwner: {
					async open() {
						throw new Error("This session does not own any local OAuth callbacks");
					},
					async retarget() {
						throw new Error("This session has no local credential owner to retarget");
					},
				},
			});
			try {
				storage.keys.setRuntime(provider, "caller-only-key");
				storage.sessions.restrict(provider, sessionId, ["account:b"]);
				expect(await storage.keys.get(provider)).toBe("caller-only-key");
				expect(await storage.keys.get(provider, sessionId)).toBe(b.access);

				const lost = Promise.withResolvers<void>();
				link.onClose(lost.resolve);
				const client = await daemonClient();
				const {
					units: [unit],
				} = await client.request({ op: "list", kind: AUTH_DAEMON_KIND });
				if (!unit) throw new Error("Expected a running auth unit");
				await client.request({ op: "stop", unit: unit.id, timeoutMs: 3_000 });
				await lost.promise;
				expect(await storage.keys.get(provider, "unrestricted-chat")).toBe("caller-only-key");
				const selected = await storage.keys.getWithCredential(provider, sessionId);
				expect(selected?.apiKey).toBe(b.access);
				if (selected?.credentialId === undefined) throw new Error("Expected a stored OAuth account");

				const peer = await bind(binding);
				expect(await peer.request("credentials-remove", { provider, id: selected.credentialId })).toBe(true);
				await waitFor(
					() => storage.credentials.summaries(provider).some(row => row.id === selected.credentialId) === false,
					"the peer's credential removal to reach the active session",
					3_000,
				);
				await expect(storage.keys.getWithCredential(provider, sessionId)).rejects.toThrow("restricted to");
			} finally {
				storage.close();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps A, B and empty OAuth restrictions private to each tunnel even on the same profile",
		async () => {
			const provider = "anthropic";
			const sessionId = "shared-session";
			const a = oauth("a");
			const b = oauth("b");
			const binding = await profile([provider, a], [provider, b], [provider, apiKey("fixture-unrestricted-key")]);
			const first = await bind(binding);
			const second = await bind(binding);
			const empty = await bind(binding);
			await first.request("session-restrict", { provider, sessionId, identityKeys: ["account:a"] });
			await second.request("session-restrict", { provider, sessionId, identityKeys: ["account:b"] });
			await empty.request("session-restrict", { provider, sessionId, identityKeys: [] });

			const firstSelection = stored(await resolve(first, provider, sessionId));
			expect(firstSelection.apiKey).toBe(a.access);
			expect(stored(await resolve(second, provider, sessionId)).apiKey).toBe(b.access);
			expect(await empty.request("session-clear", { provider, sessionId })).toBe(true);
			expect(
				await empty.request("resolve", { provider, sessionId, local: { runtime: true, env: "bearer" } }),
			).toEqual({
				kind: "error",
				category: "missing-api-key",
			});
			await expect(
				second.request("oauth-access", { provider, sessionId, credentialId: firstSelection.credentialId }),
			).rejects.toThrow();
			expect(await empty.request("availability", { providers: [provider], sessionId })).toMatchObject({
				providers: { [provider]: { has: false, credentials: [] } },
			});

			first.close();
			await waitForLeases(2);
			expect(stored(await resolve(second, provider, sessionId)).apiKey).toBe(b.access);
			expect(await empty.request("oauth-access", { provider, sessionId })).toBeNull();
		},
		TEST_TIMEOUT_MS,
	);
});
