import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	type DisabledCredentialSummary,
	isActionableCredentialDisable,
	type OAuthCredential,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
	summarizeDisableCause,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { logger } from "@oh-my-pi/pi-utils";
import { withEnv } from "./helpers";

// Suppress ambient shortcuts only while exercising credential resolution.
const SUPPRESS_ANTHROPIC_ENV = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined };

const expiredOAuth = () =>
	({
		type: "oauth" as const,
		access: "expired-access",
		refresh: "stale-refresh",
		expires: Date.now() - 60_000,
		email: "signed-out@example.com",
		orgId: "org-1",
		orgName: "Example Org",
	}) as const;

const failOAuthRefresh = (message = 'HTTP 400 invalid_grant {"error":"invalid_grant"}'): void => {
	// AuthStorage now refreshes through `refreshOAuthToken` before formatting
	// the API key, so intercept the refresh call itself to simulate a failed
	// refresh attempt. Mocking `getOAuthApiKey` no longer fires because the
	// refresh short-circuits the path with a real provider call.
	vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
		throw new Error(message);
	});
};

class MemoryAuthCredentialStore implements AuthCredentialStore {
	#rows: StoredAuthCredential[] = [];
	#nextId = 1;
	listDisabledCredentials?: (provider?: string) => Promise<DisabledCredentialSummary[]>;
	refreshSnapshot?: (signal?: AbortSignal) => Promise<unknown>;

	close(): void {}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		return this.#rows.filter(row => row.disabledCause === null && (!provider || row.provider === provider));
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		const row = this.#rows.find(entry => entry.id === id);
		if (row) row.credential = credential;
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		const row = this.#rows.find(entry => entry.id === id);
		if (row) row.disabledCause = disabledCause;
	}

	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean {
		const row = this.#rows.find(entry => entry.id === id && entry.disabledCause === null);
		if (!row || serializeTestCredential(row.credential) !== expectedData) return false;
		row.disabledCause = disabledCause;
		return true;
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		for (const row of this.#rows) {
			if (row.provider === provider && row.disabledCause === null) {
				row.disabledCause = "replaced by newer credential";
			}
		}
		const rows = credentials.map((credential): StoredAuthCredential => ({
			id: this.#nextId++,
			provider,
			credential,
			disabledCause: null,
		}));
		this.#rows.push(...rows);
		return rows;
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		return this.replaceAuthCredentialsForProvider(provider, [credential]);
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		for (const row of this.#rows) {
			if (row.provider === provider && row.disabledCause === null) row.disabledCause = disabledCause;
		}
	}

	getCache(): string | null {
		return null;
	}

	setCache(): void {}

	cleanExpiredCache(): void {}
}

function serializeTestCredential(credential: AuthCredential): string {
	if (credential.type === "api_key") return JSON.stringify({ key: credential.key });
	if (credential.type === "oauth") {
		const { type: _type, ...rest } = credential;
		return JSON.stringify(rest);
	}
	return "";
}

function disableCredential(authStorage: AuthStorage, id: number, provider = "anthropic"): void {
	expect(authStorage.disableCredentialById(id, "oauth refresh failed: invalid_grant")).toBe(true);
	expect(authStorage.list()).not.toContain(provider);
}

describe("AuthStorage credential_disabled subscriptions", () => {
	const stores: AuthCredentialStore[] = [];

	const openStorage = (options?: ConstructorParameters<typeof AuthStorage>[1]): AuthStorage => {
		const store = new MemoryAuthCredentialStore();
		stores.push(store);
		return new AuthStorage(store, options);
	};

	afterEach(() => {
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) {
			store.close();
		}
	});

	describe("constructor `onCredentialDisabled` option", () => {
		test("fires when an OAuth credential is disabled by a definitive refresh failure", async () => {
			const events: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh();

			let apiKey: string | undefined;
			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				apiKey = await authStorage.getApiKey("anthropic", "session-disabled-event");
			});

			expect(apiKey).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]?.provider).toBe("anthropic");
			expect(events[0]?.disabledCause).toContain("invalid_grant");
		});

		test("does not fire for transient (non-definitive) refresh failures", async () => {
			const events: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("fetch failed: ECONNRESET");

			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				await authStorage.getApiKey("anthropic", "session-transient-failure");
			});
			expect(events).toHaveLength(0);
		});

		test("swallows synchronous handler exceptions so the disable still completes", async () => {
			const authStorage = openStorage({
				onCredentialDisabled: () => {
					throw new Error("subscriber exploded");
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			disableCredential(authStorage, 1);
		});

		test("swallows async handler rejections so the disable path still completes", async () => {
			const settled = Promise.withResolvers<void>();
			const authStorage = openStorage({
				onCredentialDisabled: async () => {
					// Yield so the rejection lands on the microtask queue, not synchronously.
					await Promise.resolve();
					settled.resolve();
					throw new Error("async subscriber exploded");
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);

			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				disableCredential(authStorage, 1);
				await settled.promise;
				await Bun.sleep(0);
				expect(unhandled).toHaveLength(0);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
	});

	describe("`onCredentialDisabled(listener)` runtime subscription", () => {
		test("registers an additional subscriber alongside the constructor handler — both fire", async () => {
			const constructorEvents: CredentialDisabledEvent[] = [];
			const runtimeEvents: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					constructorEvents.push(event);
				},
			});
			authStorage.onCredentialDisabled(event => {
				runtimeEvents.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);
			disableCredential(authStorage, 1);
			expect(constructorEvents).toHaveLength(1);
			expect(runtimeEvents).toHaveLength(1);
			expect(constructorEvents[0]?.provider).toBe("anthropic");
			expect(runtimeEvents[0]?.provider).toBe("anthropic");
		});

		test("fans out every event to every subscriber", async () => {
			const aEvents: CredentialDisabledEvent[] = [];
			const bEvents: CredentialDisabledEvent[] = [];
			const authStorage = openStorage();
			authStorage.onCredentialDisabled(event => {
				aEvents.push(event);
			});
			authStorage.onCredentialDisabled(event => {
				bEvents.push(event);
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			await authStorage.set("openai", [expiredOAuth()]);
			disableCredential(authStorage, 1);
			disableCredential(authStorage, 2, "openai");

			expect(aEvents.map(event => event.provider)).toEqual(["anthropic", "openai"]);
			expect(bEvents.map(event => event.provider)).toEqual(["anthropic", "openai"]);
		});

		test("unsubscribe removes only that listener; others continue to fire", async () => {
			const authStorage = openStorage();
			const aEvents: CredentialDisabledEvent[] = [];
			const bEvents: CredentialDisabledEvent[] = [];
			const unsubscribeA = authStorage.onCredentialDisabled(event => {
				aEvents.push(event);
			});
			authStorage.onCredentialDisabled(event => {
				bEvents.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);
			await authStorage.set("openai", [expiredOAuth()]);

			disableCredential(authStorage, 1);
			expect(aEvents).toHaveLength(1);
			expect(bEvents).toHaveLength(1);

			unsubscribeA();

			disableCredential(authStorage, 2, "openai");
			expect(aEvents).toHaveLength(1);
			expect(bEvents).toHaveLength(2);
		});

		test("unsubscribe is idempotent: a second call is a no-op and does not affect other listeners", async () => {
			const authStorage = openStorage();
			const aEvents: CredentialDisabledEvent[] = [];
			const bEvents: CredentialDisabledEvent[] = [];
			const unsubscribeA = authStorage.onCredentialDisabled(event => {
				aEvents.push(event);
			});
			authStorage.onCredentialDisabled(event => {
				bEvents.push(event);
			});

			unsubscribeA();
			unsubscribeA();

			await authStorage.set("anthropic", [expiredOAuth()]);
			disableCredential(authStorage, 1);

			expect(aEvents).toHaveLength(0);
			expect(bEvents).toHaveLength(1);
		});

		test("a throwing subscriber does not block other subscribers from receiving the event", async () => {
			const authStorage = openStorage();
			const tailEvents: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(() => {
				throw new Error("first subscriber exploded");
			});
			authStorage.onCredentialDisabled(event => {
				tailEvents.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);

			disableCredential(authStorage, 1);
			expect(tailEvents).toHaveLength(1);
		});

		test("an async-rejecting subscriber does not trip unhandledRejection and does not block others", async () => {
			const authStorage = openStorage();
			const tailEvents: CredentialDisabledEvent[] = [];
			const settled = Promise.withResolvers<void>();
			authStorage.onCredentialDisabled(async () => {
				await Promise.resolve();
				settled.resolve();
				throw new Error("async subscriber exploded");
			});
			authStorage.onCredentialDisabled(event => {
				tailEvents.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);

			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				disableCredential(authStorage, 1);
				await settled.promise;
				await Bun.sleep(0);
				expect(tailEvents).toHaveLength(1);
				expect(unhandled).toHaveLength(0);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
	});

	describe("buffer-and-replay for events fired with no subscribers", () => {
		test("replays buffered events to the first subscriber that triggers the empty→non-empty transition", async () => {
			const authStorage = openStorage();

			await authStorage.set("anthropic", [expiredOAuth()]);
			disableCredential(authStorage, 1);

			const replayed: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				replayed.push(event);
			});
			// Drain may schedule async invocations.
			await Promise.resolve();

			expect(replayed).toHaveLength(1);
			expect(replayed[0]?.provider).toBe("anthropic");
			expect(replayed[0]?.disabledCause).toContain("invalid_grant");
		});

		test("drains once: a later subscriber attached after the first does not re-receive past events", async () => {
			const authStorage = openStorage();

			await authStorage.set("anthropic", [expiredOAuth()]);
			disableCredential(authStorage, 1);

			const firstEvents: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				firstEvents.push(event);
			});
			await Promise.resolve();
			expect(firstEvents).toHaveLength(1);

			const secondEvents: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				secondEvents.push(event);
			});
			await Promise.resolve();

			expect(secondEvents).toHaveLength(0);
		});

		test("after every subscriber unsubscribes, subsequent events buffer until the next subscribe", async () => {
			const authStorage = openStorage();
			const events: CredentialDisabledEvent[] = [];
			const unsubscribe = authStorage.onCredentialDisabled(event => {
				events.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);
			disableCredential(authStorage, 1);
			expect(events).toHaveLength(1);

			unsubscribe();
			// No subscribers; the next disable goes to the buffer.
			await authStorage.set("openai", [expiredOAuth()]);
			disableCredential(authStorage, 2, "openai");
			expect(events).toHaveLength(1);

			const replayed: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				replayed.push(event);
			});
			await Promise.resolve();
			expect(replayed).toHaveLength(1);
			expect(replayed[0]?.provider).toBe("openai");
		});
	});

	describe("identity and log line", () => {
		test("provider text cannot disguise automatic invalidation as deliberate logout", async () => {
			const events: CredentialDisabledEvent[] = [];
			const storage = openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await storage.set("anthropic", [{ ...expiredOAuth(), expires: Date.now() + 3600000 }]);
			await storage.rotateSessionCredential("anthropic", "hostile-cause", {
				apiKey: "expired-access",
				error: new Error("deleted by user override: invalidated oauth token"),
			});
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("upstream reported invalidated OAuth token:");
		});

		test("a definitive refresh failure names the row and account it tore down, once in the log", async () => {
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const events: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh();

			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				await authStorage.getApiKey("anthropic", "session-identity");
			});

			const expected = expect.objectContaining({
				provider: "anthropic",
				credentialId: 1,
				credentialType: "oauth",
				email: "signed-out@example.com",
				orgId: "org-1",
				orgName: "Example Org",
				disabledCause: expect.stringContaining("invalid_grant"),
			});
			expect(events).toEqual([expected]);
			const disableLogs = warnSpy.mock.calls.filter(([message]) => message === "Auth credential disabled");
			expect(disableLogs).toEqual([["Auth credential disabled", expected]]);
		});

		test("listener throws and rejections redact provider and error without changing event evidence", async () => {
			const failures = Promise.withResolvers<void>();
			let failureCount = 0;
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(message => {
				if (message === "onCredentialDisabled listener threw" && ++failureCount === 2) failures.resolve();
			});
			const authStorage = openStorage();
			const provider = "mcp_oauth:profile:default:https://host.test/mcp?key=QUERYSECRET&region=west";
			const cause = "oauth refresh failed: HTTP 400 client_secret=BODYSECRET";
			const events: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				events.push(event);
				throw new Error(event.disabledCause);
			});
			authStorage.onCredentialDisabled(async event => {
				throw new Error(event.disabledCause);
			});
			await authStorage.set(provider, expiredOAuth());
			expect(authStorage.disableCredentialById(1, cause)).toBe(true);
			await failures.promise;
			expect(events).toEqual([expect.objectContaining({ provider, disabledCause: cause })]);
			const logs = warnSpy.mock.calls.filter(([message]) => message === "onCredentialDisabled listener threw");
			expect(logs).toHaveLength(2);
			for (const [, context] of logs) {
				expect(context).toMatchObject({
					provider: "mcp_oauth:profile:default:https://host.test/mcp?key=[redacted]&region=west",
					error: expect.stringContaining("HTTP 400"),
				});
				expect(JSON.stringify(context)).not.toContain("QUERYSECRET");
				expect(JSON.stringify(context)).not.toContain("BODYSECRET");
			}
		});

		test("a managed MCP credential id is redacted in the log line but not in the event", async () => {
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const events: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			// The id keeps the server URL's complete query string, secret included.
			const provider = "mcp_oauth:profile:default:https://mcp.example.com/mcp?ref=1&apiKey=sk-secret";
			await authStorage.set(provider, [
				{ ...expiredOAuth(), email: undefined, orgId: undefined, orgName: undefined },
			]);
			failOAuthRefresh();

			await authStorage.getApiKey(provider, "session-mcp");

			expect(events.map(event => event.provider)).toEqual([provider]);
			const disableLogs = warnSpy.mock.calls.filter(([message]) => message === "Auth credential disabled");
			expect(disableLogs).toEqual([
				[
					"Auth credential disabled",
					expect.objectContaining({
						provider: "mcp_oauth:profile:default:https://mcp.example.com/mcp?ref=1&apiKey=[redacted]",
					}),
				],
			]);
			expect(JSON.stringify(disableLogs)).not.toContain("sk-secret");
		});

		test("a failure body that echoes the refresh token is redacted in the log line and the summary", async () => {
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const events: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
				throw new Error(
					'HTTP 400 {"error":"invalid_grant","error_description":"grant revoked","refresh_token":"rt-echoed-1234"}',
				);
			});

			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				await authStorage.getApiKey("anthropic", "session-echo");
			});

			const [event] = events;
			if (!event) throw new Error("expected a disable event");
			expect(summarizeDisableCause(event.disabledCause)).toBe("grant revoked");
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("rt-echoed-1234");
			// The verbatim cause is what the store keeps for forensics; only log and display redact.
			expect(event.disabledCause).toContain("rt-echoed-1234");
		});

		test("a broker-issued disable by id carries the same identity", async () => {
			const events: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			expect(authStorage.disableCredentialById(1, "disabled via auth-broker")).toBe(true);

			expect(events).toEqual([
				expect.objectContaining({
					provider: "anthropic",
					credentialId: 1,
					credentialType: "oauth",
					email: "signed-out@example.com",
					disabledCause: "disabled via auth-broker",
				}),
			]);
		});

		test("a broker-issued disable with a deliberate cause deletes the row but fires no event", async () => {
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const events: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			// A remote client's own `remove()` reaches the broker host as `deleted by user`.
			expect(authStorage.disableCredentialById(1, "deleted by user")).toBe(true);

			expect(authStorage.exportSnapshot().credentials).toEqual([]);
			expect(events).toEqual([]);
			expect(warnSpy.mock.calls.filter(([message]) => message === "Auth credential disabled")).toEqual([]);
		});
	});

	describe("listActionableDisabledCredentials", () => {
		const oauthIdentity = (fields: Partial<OAuthCredential> = {}): OAuthCredential => ({
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: 4_000_000_000_000,
			...fields,
		});

		test.each<{
			name: string;
			provider: string;
			old: Partial<OAuthCredential>;
			fresh: Partial<OAuthCredential>;
			recovered: boolean;
		}>([
			{
				name: "account-priority provider does not recover a different account sharing the email",
				provider: "google-gemini-cli",
				old: { accountId: "account-a", email: "same@example.com" },
				fresh: { accountId: "account-b", email: "same@example.com" },
				recovered: false,
			},
			{
				name: "same-org alternate personal account recovers a changed email",
				provider: "anthropic",
				old: { email: "old@example.com", accountId: "person-1", orgId: "org-1" },
				fresh: { email: "new@example.com", accountId: "person-1", orgId: "org-1" },
				recovered: true,
			},
			{
				name: "shared workspace account cannot identify the returning member",
				provider: "openai-codex",
				old: { accountId: "org-1", orgId: "org-1" },
				fresh: { accountId: "org-1", orgId: "org-1", email: "member@example.com" },
				recovered: false,
			},
			{
				name: "project ids remain case sensitive",
				provider: "google-gemini-cli",
				old: { projectId: "Project-A" },
				fresh: { projectId: "project-a" },
				recovered: false,
			},
			{
				name: "email is trimmed and case insensitive within a trimmed organization",
				provider: "anthropic",
				old: { email: " PERSON@example.com ", orgId: " org-1 " },
				fresh: { email: "person@example.com", orgId: "org-1" },
				recovered: true,
			},
			{
				name: "project ids are trimmed",
				provider: "google-gemini-cli",
				old: { projectId: " project-a " },
				fresh: { projectId: "project-a" },
				recovered: true,
			},
			{
				name: "account ids remain case sensitive",
				provider: "google-gemini-cli",
				old: { accountId: "Account-A" },
				fresh: { accountId: "account-a" },
				recovered: false,
			},
			{
				name: "organization ids remain case sensitive and separate subscriptions",
				provider: "anthropic",
				old: { email: "same@example.com", orgId: "Org-A" },
				fresh: { email: "same@example.com", orgId: "org-a" },
				recovered: false,
			},
			{
				name: "org-scoped login recovers its legacy unscoped account",
				provider: "openai-codex",
				old: { accountId: " person-1 " },
				fresh: { accountId: "person-1", email: "person@example.com", orgId: "org-1" },
				recovered: true,
			},
			{
				name: "org-less login cannot recover an org-scoped subscription",
				provider: "openai-codex",
				old: { email: "person@example.com", orgId: "org-1" },
				fresh: { email: "person@example.com" },
				recovered: false,
			},
			{
				name: "an org-only tombstone is recovered by the same organization",
				provider: "anthropic",
				old: { orgId: "org-1" },
				fresh: { email: "person@example.com", orgId: "org-1" },
				recovered: true,
			},
			{
				name: "blank identities are recovered by a live OAuth credential",
				provider: "anthropic",
				old: { email: " ", accountId: " ", projectId: " ", orgId: " " },
				fresh: { email: "person@example.com" },
				recovered: true,
			},
		])("retention survives recovery while reminders follow identity: $name", async ({ provider, old, fresh, recovered }) => {
			const store = new SqliteAuthCredentialStore(new Database(":memory:"));
			try {
				const [row] = store.upsertAuthCredentialForProvider(provider, oauthIdentity(old));
				store.deleteAuthCredential(row!.id, "invalid_grant");
				const [summary] = await store.listDisabledCredentials(provider);
				expect(isActionableCredentialDisable(summary!, [{ provider, type: "oauth", ...fresh }])).toBe(!recovered);
				store.upsertAuthCredentialForProvider(provider, oauthIdentity(fresh));
				const retained = await store.listDisabledCredentials(provider);
				expect(retained).toEqual([summary!]);
				const active = store.listAuthCredentials(provider).map(entry => ({ provider, ...entry.credential }));
				expect(isActionableCredentialDisable(retained[0]!, active)).toBe(!recovered);
			} finally {
				store.close();
			}
		});

		test("an API key does not recover named or identity-less OAuth tombstones", async () => {
			const store = new SqliteAuthCredentialStore(new Database(":memory:"));
			try {
				const named = store.upsertAuthCredentialForProvider(
					"anthropic",
					oauthIdentity({ email: "person@example.com" }),
				)[0]!;
				store.deleteAuthCredential(named.id, "invalid_grant");
				const idless = store.upsertAuthCredentialForProvider("anthropic", oauthIdentity())[0]!;
				store.deleteAuthCredential(idless.id, "invalid_grant");
				const summaries = await store.listDisabledCredentials();
				for (const summary of summaries) {
					expect(
						isActionableCredentialDisable(summary, [
							{ provider: "anthropic", type: "api_key", email: "person@example.com" },
						]),
					).toBe(true);
				}
				store.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "key" });
				expect((await store.listDisabledCredentials()).map(row => row.id)).toEqual(summaries.map(row => row.id));
			} finally {
				store.close();
			}
		});

		test("retains project-only forensics but clears the reminder when the same project signs in", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-tombstone-"));
			const storage = await AuthStorage.create(path.join(dir, "agent.db"));
			try {
				const credential = {
					type: "oauth" as const,
					access: "a",
					refresh: "r",
					expires: Date.now() + 60000,
					projectId: "project-a",
				};
				await storage.set("google-gemini-cli", [credential]);
				const id = storage.exportSnapshot().credentials[0]!.id;
				storage.disableCredentialById(id, "invalid_grant");
				await storage.set("google-gemini-cli", [{ ...credential, access: "b", projectId: "project-b" }]);
				expect((await storage.listActionableDisabledCredentials()).map(row => row.projectId)).toEqual([
					"project-a",
				]);
				await storage.set("google-gemini-cli", [credential]);
				expect(await storage.listDisabledCredentials()).toContainEqual(
					expect.objectContaining({ id, projectId: "project-a", cause: "invalid_grant" }),
				);
				expect(await storage.listActionableDisabledCredentials()).toEqual([]);
			} finally {
				storage.close();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
		const tombstone = (overrides: Partial<DisabledCredentialSummary>): DisabledCredentialSummary => ({
			id: 7,
			provider: "anthropic",
			type: "oauth",
			email: "signed-out@example.com",
			cause: "oauth refresh failed: invalid_grant",
			...overrides,
		});

		const openStorageWithTombstones = (tombstones: DisabledCredentialSummary[]): AuthStorage => {
			const store = new MemoryAuthCredentialStore();
			store.listDisabledCredentials = async () => tombstones;
			stores.push(store);
			return new AuthStorage(store);
		};

		test("reports an automatic tombstone whose account has not signed in again", async () => {
			const authStorage = openStorageWithTombstones([tombstone({})]);
			await authStorage.set("anthropic", [{ ...expiredOAuth(), email: "someone-else@example.com", orgId: "org-2" }]);

			const actionable = await authStorage.listActionableDisabledCredentials();
			expect(actionable.map(summary => summary.id)).toEqual([7]);
		});

		test("hides tombstones recovered by a live credential with the same email, account, or organization", async () => {
			const authStorage = openStorageWithTombstones([
				tombstone({ id: 1, email: "Signed-Out@example.com" }),
				tombstone({ id: 2, email: undefined, accountId: "acct-1" }),
				tombstone({ id: 3, email: undefined, orgId: "org-1" }),
				tombstone({ id: 4, provider: "openai", email: "signed-out@example.com" }),
			]);
			await authStorage.set("anthropic", [{ ...expiredOAuth(), accountId: "acct-1" }]);

			const actionable = await authStorage.listActionableDisabledCredentials();
			expect(actionable.map(summary => summary.id)).toEqual([4]);
		});

		test("ignores API-key rows and every deliberate or lifecycle cause the store writes", async () => {
			const authStorage = openStorageWithTombstones([
				tombstone({ id: 1, type: "api_key", email: undefined }),
				tombstone({ id: 2, cause: "replaced by newer credential" }),
				tombstone({ id: 3, cause: "replaced by oauth login" }),
				tombstone({ id: 4, cause: "deleted by user" }),
				tombstone({ id: 5, cause: "logged out by user" }),
				tombstone({ id: 6, cause: "deduplicated duplicate credential" }),
			]);

			expect(await authStorage.listActionableDisabledCredentials()).toEqual([]);
		});

		test("keeps a tombstone whose organization disagrees with the live credential, and another member of the same workspace", async () => {
			const authStorage = openStorageWithTombstones([
				// Same person, different subscription: org A was lost, org B is live.
				tombstone({ id: 1, orgId: "org-a" }),
				// Same person, org-scoped subscription lost, only an org-less login is live.
				tombstone({ id: 4, email: "personal@example.com", orgId: "org-c" }),
				// The reverse upgrade still recovers: a pre-org tombstone claimed by an org-scoped login.
				tombstone({ id: 5, email: "upgraded@example.com", orgId: undefined }),
				// openai-codex stores the shared workspace id as accountId and orgId for every member.
				tombstone({ id: 2, email: "alice@example.com", accountId: "ws-team", orgId: "ws-team" }),
				// A member of another workspace whose email is unknown: the shared id proves nothing.
				tombstone({ id: 6, email: "carol@example.com", accountId: "ws-other", orgId: "ws-other" }),
				// A workspace id alone cannot prove which member signed in again.
				tombstone({ id: 3, email: undefined, accountId: "ws-team", orgId: "ws-team" }),
			]);
			await authStorage.set("anthropic", [
				{ ...expiredOAuth(), orgId: "org-b" },
				{ ...expiredOAuth(), email: "bob@example.com", accountId: "ws-team", orgId: "ws-team" },
				{ ...expiredOAuth(), email: undefined, accountId: "ws-other", orgId: "ws-other" },
				{ ...expiredOAuth(), email: "personal@example.com", orgId: undefined, orgName: undefined },
				{ ...expiredOAuth(), email: "upgraded@example.com", orgId: "org-d" },
			]);

			const actionable = await authStorage.listActionableDisabledCredentials();
			expect(actionable.map(summary => summary.id).toSorted()).toEqual([1, 2, 3, 4, 6]);
		});

		test("treats an identity-less tombstone as recovered by any live credential of its provider", async () => {
			const authStorage = openStorageWithTombstones([
				tombstone({ id: 1, email: undefined }),
				tombstone({ id: 2, provider: "openai", email: undefined }),
			]);
			await authStorage.set("anthropic", [expiredOAuth()]);

			const actionable = await authStorage.listActionableDisabledCredentials();
			expect(actionable.map(summary => summary.id)).toEqual([2]);
		});

		test("reports tombstones without recovery suppression when the snapshot cannot be revalidated", async () => {
			const store = new MemoryAuthCredentialStore();
			store.listDisabledCredentials = async () => [tombstone({})];
			store.refreshSnapshot = async () => {
				throw new Error("auth broker unreachable");
			};
			stores.push(store);
			const authStorage = new AuthStorage(store);
			// The loaded snapshot says the identity is live again, but that snapshot
			// may be the very cache the disable already outdated.
			await authStorage.set("anthropic", [expiredOAuth()]);

			expect((await authStorage.listActionableDisabledCredentials()).map(summary => summary.id)).toEqual([7]);
		});

		test("a token-identified tombstone waits for its own account rather than any OAuth login", async () => {
			const storage = await AuthStorage.create(":memory:");
			const jwt = (sub: string) =>
				`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`;
			try {
				const credential = oauthIdentity({ access: jwt("user-1") });
				await storage.set("unit-token-identity", [credential]);
				const id = storage.exportSnapshot().credentials[0]!.id;
				storage.disableCredentialById(id, "invalid_grant");
				await storage.set("unit-token-identity", [oauthIdentity({ access: jwt("user-2") })]);
				expect((await storage.listActionableDisabledCredentials()).map(row => row.id)).toEqual([id]);
				expect((await storage.listDisabledCredentials()).map(row => row.id)).toEqual([id]);
				await storage.set("unit-token-identity", [credential]);
				expect(await storage.listDisabledCredentials()).toContainEqual(
					expect.objectContaining({ id, accountId: "user-1", cause: "invalid_grant" }),
				);
				expect(await storage.listActionableDisabledCredentials()).toEqual([]);
			} finally {
				storage.close();
			}
		});

		test("retains identity-less forensics without a reminder after re-login until provider logout", async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-disabled-identityless-"));
			const authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
			try {
				// Opaque tokens carry no recoverable identity either.
				const bare = {
					type: "oauth" as const,
					access: "opaque-access-1",
					refresh: "r-1",
					expires: Date.now() + 60_000,
				};
				await authStorage.set("unit-idless", [bare]);
				const id = authStorage.exportSnapshot().credentials[0]!.id;
				expect(authStorage.disableCredentialById(id, "oauth refresh failed: invalid_grant")).toBe(true);
				expect((await authStorage.listActionableDisabledCredentials()).map(summary => summary.id)).toEqual([id]);

				await authStorage.set("unit-idless", [{ ...bare, access: "opaque-access-2", refresh: "r-2" }]);
				expect(await authStorage.listDisabledCredentials("unit-idless")).toContainEqual(
					expect.objectContaining({ id, cause: "oauth refresh failed: invalid_grant" }),
				);
				expect(await authStorage.listActionableDisabledCredentials()).toEqual([]);

				await authStorage.remove("unit-idless");
				expect((await authStorage.listDisabledCredentials("unit-idless")).map(row => row.id)).not.toContain(id);
				expect(await authStorage.listActionableDisabledCredentials()).toEqual([]);
			} finally {
				authStorage.close();
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		test("sees a disable performed by a sibling process instead of trusting its own loaded snapshot", async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-disabled-siblings-"));
			const dbPath = path.join(tempDir, "agent.db");
			const writer = await AuthStorage.create(dbPath);
			const reader = await AuthStorage.create(dbPath);
			try {
				await writer.set("anthropic", [expiredOAuth()]);
				await reader.reload();
				const id = reader.exportSnapshot().credentials[0]!.id;
				expect(writer.disableCredentialById(id, "oauth refresh failed: invalid_grant")).toBe(true);

				// The reader still holds the row as active in memory; the listing must not
				// let that stale copy pass for a re-login of the same identity.
				expect((await reader.listActionableDisabledCredentials()).map(summary => summary.id)).toEqual([id]);
			} finally {
				reader.close();
				writer.close();
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});
});
