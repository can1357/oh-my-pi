import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	credentialAccountLabel,
	type CredentialDisabledEvent,
	type DisabledCredentialSummary,
	isActionableCredentialDisable,
	type OAuthCredential,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
	projectCredentialDisabledEvent,
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
	/** Keep inserted rows out of the id space a stubbed tombstone history already claims. */
	seedNextId(nextId: number): void {
		this.#nextId = Math.max(this.#nextId, nextId);
	}

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
	test("a padded deliberate cause is not announced as an automatic sign-out", async () => {
		const events: CredentialDisabledEvent[] = [];
		const authStorage = openStorage({
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
		await authStorage.set("anthropic", expiredOAuth());
		const id = authStorage.listStoredCredentials("anthropic")[0]!.id;

		// SQLite trims before classifying; the broker endpoint must agree with it.
		expect(authStorage.disableCredentialById(id, "  deleted by user  ")).toBe(true);
		expect(events).toEqual([]);
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

	describe("undelivered sign-out requeue", () => {
		test("a requeued sign-out reaches the next subscriber past a permanent one", async () => {
			// A constructor-level subscriber keeps the listener set non-empty for the
			// process's life, so the requeue cannot depend on an empty→non-empty
			// transition to be delivered.
			const permanent: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					permanent.push(event);
				},
			});
			try {
				await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
					failOAuthRefresh();
					await authStorage.set("anthropic", [expiredOAuth()]);
					await authStorage.getApiKey("anthropic", "startup");
				});
				expect(permanent).toHaveLength(1);

				// The session that was going to report this died before it could.
				authStorage.retainUndeliveredCredentialDisabled(permanent);

				const nextSession: CredentialDisabledEvent[] = [];
				authStorage.onCredentialDisabled(event => {
					nextSession.push(event);
				});
				await Promise.resolve();
				expect(nextSession.map(event => event.credentialId)).toEqual([permanent[0]!.credentialId]);
				// The subscriber that already saw it is not told twice.
				expect(permanent).toHaveLength(1);
			} finally {
				authStorage.close();
			}
		});
	});

	describe("requeue is idempotent", () => {
		test("a sign-out handed back by two teardown paths is reported once", async () => {
			const seen: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					seen.push(event);
				},
			});
			try {
				await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
					failOAuthRefresh();
					await authStorage.set("anthropic", [expiredOAuth()]);
					await authStorage.getApiKey("anthropic", "startup");
				});
				expect(seen).toHaveLength(1);

				// A failing startup reaches the store twice for the same sign-out:
				// once from the disposed session's unseen set, once from the startup
				// buffer. Both carry the object the store emitted.
				authStorage.retainUndeliveredCredentialDisabled(seen);
				authStorage.retainUndeliveredCredentialDisabled(seen);

				const replayed: CredentialDisabledEvent[] = [];
				authStorage.onCredentialDisabled(event => {
					replayed.push(event);
				});
				await Promise.resolve();
				expect(replayed).toHaveLength(1);
			} finally {
				authStorage.close();
			}
		});
	});

	describe("requeue and extension delivery", () => {
		test("a requeued sign-out the runner already saw is replayed for the operator only", async () => {
			const seen: CredentialDisabledEvent[] = [];
			const authStorage = openStorage({
				onCredentialDisabled: event => {
					seen.push(event);
				},
			});
			try {
				await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
					failOAuthRefresh();
					await authStorage.set("anthropic", [expiredOAuth()]);
					await authStorage.getApiKey("anthropic", "startup");
				});
				expect(seen).toHaveLength(1);
				const delivered = seen[0]!;
				expect(authStorage.credentialDisabledReachedExtensions(delivered)).toBe(false);

				// The failed session had already handed this to its extension runner.
				authStorage.retainUndeliveredCredentialDisabled([delivered], {
					extensionsAlreadyNotified: [delivered],
				});

				// Still replayed — the operator never saw it — but marked so the next
				// session does not report the same teardown to handlers twice.
				const replayed: CredentialDisabledEvent[] = [];
				authStorage.onCredentialDisabled(event => {
					replayed.push(event);
				});
				await Promise.resolve();
				expect(replayed).toEqual([delivered]);
				expect(authStorage.credentialDisabledReachedExtensions(delivered)).toBe(true);
			} finally {
				authStorage.close();
			}
		});
	});

	describe("post-disable pool verdict", () => {
		test("a pool whose only sibling is usage-blocked reports no usable sibling", async () => {
			// A persisting store is the point: `#resetProviderAssignments` clears the
			// in-memory backoff after a disable, so only a persisted usage block is
			// still in force when the pool verdict is computed.
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ai-post-disable-"));
			const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
			const authStorage = new AuthStorage(store);
			try {
				await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
					await authStorage.set("anthropic", [
						{
							...expiredOAuth(),
							access: "primary-access",
							email: "primary@example.com",
							expires: Date.now() + 3_600_000,
						},
						{
							...expiredOAuth(),
							access: "sibling-access",
							email: "sibling@example.com",
							expires: Date.now() + 3_600_000,
						},
					]);

					const sessionId = "post-disable-verdict";
					expect(await authStorage.getApiKey("anthropic", sessionId)).toBeTruthy();
					// Block the session's current account; the session switches to the
					// other one, so the rotation below retires the unblocked account and
					// leaves only the blocked sibling.
					const marked = await authStorage.markUsageLimitReached("anthropic", sessionId, {
						retryAfterMs: 6 * 24 * 60 * 60 * 1000,
					});
					expect(marked.switched).toBe(true);
					expect(marked.blockedUntilMs).toBeGreaterThan(Date.now());

					const active = store.listAuthCredentials("anthropic");
					const blockedRow = active.find(row => store.getCredentialBlock?.(row.id, "anthropic:oauth", ""));
					const unblockedRow = active.find(row => row.id !== blockedRow?.id);
					expect(blockedRow).toBeDefined();
					expect(unblockedRow).toBeDefined();

					// Retire the unblocked account. Row existence alone would answer
					// "sibling available" and send the caller straight back into the
					// account already known to be blocked.
					const failedBearer = (unblockedRow!.credential as { access: string }).access;
					const remaining = await authStorage.rotateSessionCredential("anthropic", sessionId, {
						credentialId: unblockedRow!.id,
						// Proof the failed request actually ran on this row; a rotation
						// that cannot prove it declines to retire anything.
						apiKey: failedBearer,
						// Classified as an invalidated bearer, so this rotation retires the
						// row rather than merely blocking it — the path whose verdict
						// comes from the post-disable pool.
						error: new Error("upstream reported invalidated oauth token"),
					});
					expect(store.listAuthCredentials("anthropic").map(row => row.id)).toEqual([blockedRow!.id]);
					expect(remaining).toBe(false);
				});
			} finally {
				authStorage.close();
				fs.rmSync(dir, { recursive: true, force: true });
			}
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
			expect(events[0]?.disabledCause).toContain("invalidated oauth token");
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
			// The event keeps the forensic cause; the log line carries the classified one.
			const disableLogs = warnSpy.mock.calls.filter(([message]) => message === "Auth credential disabled");
			expect(disableLogs).toEqual([
				["Auth credential disabled", expect.objectContaining({ disabledCause: "sign-in expired" })],
			]);
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
			expect(events).toEqual([
				expect.objectContaining({
					provider,
					disabledCause: cause,
				}),
			]);
			const logs = warnSpy.mock.calls.filter(([message]) => message === "onCredentialDisabled listener threw");
			expect(logs).toHaveLength(2);
			for (const [, context] of logs) {
				// The provider id loses its query structurally; a listener's own error is
				// logged verbatim, as every other caught error in this file is.
				expect(context).toMatchObject({
					provider: "mcp_oauth:profile:default:https://host.test",
					error: "onCredentialDisabled listener rejected",
				});
				expect(JSON.stringify(context)).not.toContain("QUERYSECRET");
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

			// The event is in-process and keeps the stored provider id: notice
			// reconciliation correlates on it. The projection happens at the
			// boundary out of the process — see the extension-handler canary in
			// `sdk-credential-disabled-bridge.test.ts`.
			expect(events.map(event => event.provider)).toEqual([provider]);
			const disableLogs = warnSpy.mock.calls.filter(([message]) => message === "Auth credential disabled");
			expect(disableLogs).toEqual([
				[
					"Auth credential disabled",
					expect.objectContaining({
						provider: "mcp_oauth:profile:default:https://mcp.example.com",
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
			expect(event.disabledCause).toContain("invalid_grant");
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("rt-echoed-1234");
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
			// A remote client's own `removeCredential()` reaches the broker host as `deleted by user`.
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
				name: "an unknown login cannot recover a known account",
				provider: "anthropic",
				old: { email: "person@example.com" },
				fresh: { email: " ", accountId: " ", projectId: " ", orgId: " " },
				recovered: false,
			},
			{
				name: "blank identities cannot prove recovery from a live OAuth credential",
				provider: "anthropic",
				old: { email: " ", accountId: " ", projectId: " ", orgId: " " },
				fresh: { email: "person@example.com" },
				recovered: false,
			},
		])(
			"retention survives recovery while reminders follow identity: $name",
			async ({ provider, old, fresh, recovered }) => {
				const store = new SqliteAuthCredentialStore(new Database(":memory:"));
				try {
					const [row] = store.upsertAuthCredentialForProvider(provider, oauthIdentity(old));
					store.deleteAuthCredential(row!.id, "invalid_grant");
					const [summary] = await store.listDisabledCredentials(provider);
					expect(isActionableCredentialDisable(summary!, [{ provider, type: "oauth", ...fresh }])).toBe(
						!recovered,
					);
					store.upsertAuthCredentialForProvider(provider, oauthIdentity(fresh));
					const retained = await store.listDisabledCredentials(provider);
					expect(retained).toEqual([summary!]);
					const active = store.listAuthCredentials(provider).map(entry => ({ provider, ...entry.credential }));
					expect(isActionableCredentialDisable(retained[0]!, active)).toBe(!recovered);
				} finally {
					store.close();
				}
			},
		);

		test("active identity projection preserves alternate refresh claims for organization upgrades", async () => {
			const authStorage = openStorage();
			const refresh = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: "legacy-person" })).toString("base64url")}.sig`;
			await authStorage.set(
				"anthropic",
				oauthIdentity({
					email: "new@example.com",
					accountId: "primary-person",
					orgId: "org-1",
					refresh,
				}),
			);
			const identities = authStorage.listCredentialAccountIdentities();
			const summary: DisabledCredentialSummary = {
				id: 10,
				provider: "anthropic",
				type: "oauth",
				cause: "invalid_grant",
				accountId: "legacy-person",
			};
			expect(isActionableCredentialDisable(summary, identities)).toBe(false);
			expect(isActionableCredentialDisable({ ...summary, orgId: "org-1" }, identities)).toBe(false);
			expect(isActionableCredentialDisable({ ...summary, orgId: "org-2" }, identities)).toBe(true);
			expect(JSON.stringify(identities)).not.toContain(refresh);
		});

		test("reload replaces authoritative identity metadata even when redacted credential bytes are unchanged", async () => {
			const store = new MemoryAuthCredentialStore();
			stores.push(store);
			const authStorage = new AuthStorage(store);
			const [row] = store.replaceAuthCredentialsForProvider("google-gemini-cli", [
				oauthIdentity({ email: "shared@example.com" }),
			]);
			row!.identityKey = "account:account-a";
			await authStorage.reload();
			const summary: DisabledCredentialSummary = {
				id: 10,
				provider: "google-gemini-cli",
				type: "oauth",
				cause: "invalid_grant",
				accountId: "account-a",
				email: "shared@example.com",
			};
			expect(isActionableCredentialDisable(summary, authStorage.listCredentialAccountIdentities())).toBe(false);
			row!.identityKey = "account:account-b";
			await authStorage.reload();
			expect(isActionableCredentialDisable(summary, authStorage.listCredentialAccountIdentities())).toBe(true);
			await authStorage.set("google-gemini-cli", oauthIdentity({ accountId: "account-a" }));
			expect(isActionableCredentialDisable(summary, authStorage.listCredentialAccountIdentities())).toBe(false);
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
			// A real store never hands a live row the id of one of its tombstones;
			// keep the stubbed history and the inserted rows in disjoint id space.
			store.seedNextId(Math.max(0, ...tombstones.map(summary => summary.id)) + 1);
			stores.push(store);
			return new AuthStorage(store);
		};

		test("reports an automatic tombstone whose account has not signed in again", async () => {
			const authStorage = openStorageWithTombstones([tombstone({})]);
			await authStorage.set("anthropic", [{ ...expiredOAuth(), email: "someone-else@example.com", orgId: "org-2" }]);

			const actionable = await authStorage.listActionableDisabledCredentials();
			expect(actionable.map(summary => summary.id)).toEqual([7]);
		});

		test("projects the latest canonical account disable without merging ambiguous or differently scoped identities", async () => {
			const history = [
				tombstone({ id: 1, email: " PERSON@example.com ", orgId: " org-a ", disabledAtMs: 300 }),
				tombstone({ id: 2, email: "person@example.com", orgId: "org-a", disabledAtMs: 100 }),
				tombstone({ id: 3, email: "person@example.com", orgId: "org-a", disabledAtMs: 300 }),
				tombstone({ id: 4, email: "person@example.com", orgId: "org-b" }),
				tombstone({ id: 5, email: "person@example.com", orgId: "org-a", provider: "openai-codex" }),
				tombstone({ id: 6, email: "person@example.com" }),
				tombstone({ id: 7, email: undefined }),
				tombstone({ id: 8, email: undefined }),
				tombstone({ id: 9, email: undefined, accountId: "workspace", orgId: "workspace" }),
				tombstone({ id: 10, email: undefined, accountId: "workspace", orgId: "workspace" }),
				tombstone({ id: 11, provider: "google-gemini-cli", accountId: "account", orgId: "org-a" }),
				tombstone({ id: 12, provider: "google-gemini-cli", accountId: "account", orgId: "org-b" }),
				// A newer row id is not evidence of a later actual disable.
				tombstone({ id: 13, email: "person@example.com", orgId: "org-a", disabledAtMs: 50 }),
			];
			const authStorage = openStorageWithTombstones(history);
			expect((await authStorage.listActionableDisabledCredentials()).map(summary => summary.id)).toEqual([
				3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
			]);
			expect(await authStorage.listDisabledCredentials()).toEqual(history);
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

		test("keeps identity-less tombstones when live identities cannot prove a later login", async () => {
			const authStorage = openStorageWithTombstones([
				tombstone({ id: 1, email: undefined }),
				tombstone({ id: 2, provider: "openai", email: undefined }),
			]);
			await authStorage.set("anthropic", [expiredOAuth()]);

			const actionable = await authStorage.listActionableDisabledCredentials();
			expect(actionable.map(summary => summary.id)).toEqual([1, 2]);
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

		test("retains identity-less forensics and its reminder until provider logout", async () => {
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
				expect((await authStorage.listActionableDisabledCredentials()).map(row => row.id)).toEqual([id]);

				await authStorage.remove("unit-idless");
				expect((await authStorage.listDisabledCredentials("unit-idless")).map(row => row.id)).not.toContain(id);
				expect(await authStorage.listActionableDisabledCredentials()).toEqual([]);
			} finally {
				authStorage.close();
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		test.each(["known", "unknown"])(
			"keeps distinct unknown tombstones beside a preexisting %s OAuth sibling",
			async identity => {
				const store = new SqliteAuthCredentialStore(new Database(":memory:"));
				const storage = new AuthStorage(store);
				try {
					const rows = store.replaceAuthCredentialsForProvider("anthropic", [
						oauthIdentity({ access: "old-a" }),
						oauthIdentity({ access: "old-b", email: " ", accountId: " " }),
						oauthIdentity({ access: "sibling", email: identity === "known" ? "sibling@example.com" : undefined }),
					]);
					const lost = rows.slice(0, 2);
					for (const row of lost) store.deleteAuthCredential(row.id, "invalid_grant");
					const actionable = await storage.listActionableDisabledCredentials("anthropic");
					expect(actionable.map(row => row.id)).toEqual(lost.map(row => row.id));
					expect(actionable.map(row => summarizeDisableCause(row.cause))).toEqual([
						"sign-in expired",
						"sign-in expired",
					]);
					expect((await store.listDisabledCredentials()).map(row => row.id)).toEqual(lost.map(row => row.id));
				} finally {
					storage.close();
				}
			},
		);

		test.each(["update", "compare-and-swap"])(
			"%s refresh preserves unknown tombstones and their raw forensic payloads",
			async method => {
				const db = new Database(":memory:");
				const store = new SqliteAuthCredentialStore(db);
				const storage = new AuthStorage(store);
				try {
					const sibling = oauthIdentity({ email: "sibling@example.com" });
					const [lost, live] = store.replaceAuthCredentialsForProvider("anthropic", [oauthIdentity(), sibling]);
					const cause = "invalid_grant; refresh_token=forensic-only-secret";
					store.deleteAuthCredential(lost!.id, cause);
					const raw = db.query("SELECT * FROM auth_credentials WHERE id = ?").get(lost!.id);
					const refreshed = { ...sibling, access: "rotated-access", refresh: "rotated-refresh" };
					if (method === "update") store.updateAuthCredential(live!.id, refreshed);
					else
						expect(
							store.tryUpdateAuthCredentialIfMatches(live!.id, serializeTestCredential(sibling), refreshed),
						).toBe(true);
					expect(db.query("SELECT * FROM auth_credentials WHERE id = ?").get(lost!.id)).toEqual(raw);
					expect((await store.listDisabledCredentials())[0]?.cause).toBe(cause);
					const actionable = await storage.listActionableDisabledCredentials();
					expect(actionable.map(row => row.id)).toEqual([lost!.id]);
					// The forensic cause reaches callers intact; no display surface prints it.
					expect(actionable[0]?.cause).toContain("forensic-only-secret");
					expect(summarizeDisableCause(actionable[0]!.cause)).not.toContain("forensic-only-secret");
					expect(summarizeDisableCause(actionable[0]!.cause)).toBe("sign-in expired");
				} finally {
					storage.close();
				}
			},
		);

		test.each(["upsert", "replace"])(
			"a later explicit %s login retains unknown automatic history when reusing a sibling row",
			async method => {
				const store = new SqliteAuthCredentialStore(new Database(":memory:"));
				try {
					const sibling = oauthIdentity({ email: "sibling@example.com" });
					const [lost, live] = store.replaceAuthCredentialsForProvider("anthropic", [oauthIdentity(), sibling]);
					store.deleteAuthCredential(lost!.id, "invalid_grant");
					const replacement = { ...sibling, access: "login-access", refresh: "login-refresh" };
					const rows =
						method === "upsert"
							? store.upsertAuthCredentialForProvider("anthropic", replacement)
							: store.replaceAuthCredentialsForProvider("anthropic", [replacement]);
					expect(rows.map(row => row.id)).toEqual([live!.id]);
					expect((await store.listDisabledCredentials()).map(row => row.id)).toEqual([lost!.id]);
					store.deleteAuthCredential(live!.id, "logged out by user");
					expect((await store.listDisabledCredentials()).map(row => row.id).toSorted()).toEqual(
						[lost!.id, live!.id].toSorted(),
					);
				} finally {
					store.close();
				}
			},
		);

		test.each([false, true])(
			"uses post-refresh history when a sibling disables another account (initial history: %s)",
			async initialHistory => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-history-race-"));
				const dbPath = path.join(dir, "agent.db");
				const writer = await AuthStorage.create(dbPath);
				const reader = await AuthStorage.create(dbPath);
				try {
					await writer.set("anthropic", [
						oauthIdentity({ email: "old@example.com" }),
						oauthIdentity({ email: "new@example.com" }),
					]);
					await reader.reload();
					const [old, fresh] = writer.listStoredCredentials("anthropic");
					if (initialHistory) writer.disableCredentialById(old!.id, "invalid_grant");
					const revalidate = reader.revalidateCredentials.bind(reader);
					vi.spyOn(reader, "revalidateCredentials").mockImplementationOnce(async signal => {
						expect(writer.disableCredentialById(fresh!.id, "invalid_grant")).toBe(true);
						await revalidate(signal);
					});
					const actionable = await reader.listActionableDisabledCredentials("anthropic");
					expect(actionable.map(row => row.id)).toEqual(initialHistory ? [old!.id, fresh!.id] : [fresh!.id]);
					expect(actionable.map(row => [credentialAccountLabel(row), summarizeDisableCause(row.cause)])).toEqual(
						initialHistory
							? [
									["old@example.com", "sign-in expired"],
									["new@example.com", "sign-in expired"],
								]
							: [["new@example.com", "sign-in expired"]],
					);
					expect((await writer.listDisabledCredentials()).map(row => row.id)).toEqual(
						actionable.map(row => row.id),
					);
				} finally {
					reader.close();
					writer.close();
					fs.rmSync(dir, { recursive: true, force: true });
				}
			},
		);

		test("does not resurrect a tombstone deliberately purged by a sibling during revalidation", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-history-purge-"));
			const dbPath = path.join(dir, "agent.db");
			const reader = await AuthStorage.create(dbPath);
			const siblingDb = new Database(dbPath);
			try {
				await reader.set("anthropic", oauthIdentity({ email: "purged@example.com" }));
				const id = reader.listStoredCredentials()[0]!.id;
				reader.disableCredentialById(id, "invalid_grant");
				const revalidate = reader.revalidateCredentials.bind(reader);
				vi.spyOn(reader, "revalidateCredentials").mockImplementationOnce(async signal => {
					siblingDb.run("DELETE FROM auth_credentials WHERE id = ?", [id]);
					await revalidate(signal);
				});
				expect(await reader.listActionableDisabledCredentials()).toEqual([]);
				expect(await reader.listDisabledCredentials()).toEqual([]);
			} finally {
				siblingDb.close();
				reader.close();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test("reports a sign-out a sibling performs between the refresh and the history recheck", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-history-generation-"));
			const dbPath = path.join(dir, "agent.db");
			const reader = await AuthStorage.create(dbPath);
			const writer = await AuthStorage.create(dbPath);
			try {
				await reader.set("anthropic", oauthIdentity({ email: "racer@example.com" }));
				await reader.reload();
				const id = reader.listStoredCredentials()[0]!.id;
				// The peer disables the row after this process refreshes its pool but
				// before the tombstone recheck, so the two reads straddle the change.
				const revalidate = reader.revalidateCredentials.bind(reader);
				vi.spyOn(reader, "revalidateCredentials").mockImplementationOnce(async signal => {
					await revalidate(signal);
					await writer.reload();
					writer.disableCredentialById(id, "invalid_grant");
				});
				// The identity is only "live" in the pre-disable pool; pairing it with the
				// fresh tombstone would silently classify the sign-out as recovered.
				expect((await reader.listActionableDisabledCredentials()).map(row => row.id)).toEqual([id]);
			} finally {
				writer.close();
				reader.close();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test("retains initial history without recovery when the caller aborts the post-refresh read", async () => {
			const store = new MemoryAuthCredentialStore();
			const controller = new AbortController();
			store.listDisabledCredentials = async (_provider?: string, signal?: AbortSignal) => {
				signal?.throwIfAborted();
				return [tombstone({})];
			};
			store.refreshSnapshot = async () => controller.abort();
			stores.push(store);
			const storage = new AuthStorage(store);
			await storage.set("anthropic", expiredOAuth());
			const actionable = await storage.listActionableDisabledCredentials("anthropic", controller.signal);
			// Even the freshly loaded matching row cannot hide history without a successful second read.
			expect(actionable.map(row => row.id)).toEqual([7]);
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

describe("credential disable cause projection", () => {
	/**
	 * `projectCredentialDisabledEvent` runs at every boundary out of the
	 * process's trust domain, and an event can cross more than one. Each label
	 * the classifier can emit must therefore be a fixed point of it: several are
	 * not matched by the arm that produced them, and `replaced by a newer
	 * sign-in` is matched by a *different* arm — it reads as a deliberate logout
	 * and degrades to `signed out`, reporting a routine rotation as a sign-out.
	 */
	test("every label the classifier emits is a fixed point of it", () => {
		const rawCauses = [
			"oauth refresh failed: invalid_grant",
			"oauth refresh failed: HTTP 400 expired token",
			"upstream reported invalidated OAuth token: HTTP 401",
			"oauth refresh failed: invalid_client",
			"oauth refresh failed: unauthorized_client",
			"token invalid_token",
			"credential revoked upstream",
			"replaced by newer credential",
			"logged out by user",
			"deleted by user",
			"deduplicated duplicate credential",
			"disabled",
			"something entirely unclassified",
		];
		const emitted = new Set(rawCauses.map(summarizeDisableCause));
		// Guards the vocabulary itself: a new arm must be added to the fixed-point
		// set, or this catches it on the next double projection.
		expect(emitted.size).toBeGreaterThan(1);
		for (const label of emitted) {
			expect(summarizeDisableCause(label)).toBe(label);
		}
	});

	test("a replacement is named as one, not as a sign-out", () => {
		// `replaced by …` is a non-automatic cause, so a classifier that checks the
		// deliberate branch first reports a routine re-login or key rotation as a
		// user sign-out. The replacement arm has to come first.
		expect(summarizeDisableCause("replaced by newer credential")).toBe("replaced by a newer sign-in");
		expect(summarizeDisableCause("logged out by user")).toBe("signed out");
	});

	test("projecting an event twice equals projecting it once", () => {
		const event = {
			provider: "mcp_oauth:profile:default:https://host.test/mcp/SECRET?k=SECRET",
			credentialId: 3,
			credentialType: "oauth" as const,
			disabledCause: "oauth refresh failed: invalid_grant refresh_token=SECRET",
			email: "user@example.test",
		};
		const once = projectCredentialDisabledEvent(event);
		expect(projectCredentialDisabledEvent(once)).toEqual(once);
		expect(JSON.stringify(once)).not.toContain("SECRET");
	});
});
