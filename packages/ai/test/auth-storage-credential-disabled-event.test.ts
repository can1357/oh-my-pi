import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

// Env vars short-circuit AuthStorage.getApiKey before the OAuth refresh path runs; suppress
// them for every test in this file so the credential-disable code path can be exercised.
const SUPPRESS_ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof SUPPRESS_ANTHROPIC_ENV)[number], string | undefined>> = {};

const expiredOAuth = () =>
	({
		type: "oauth" as const,
		access: "expired-access",
		refresh: "stale-refresh",
		expires: Date.now() - 60_000,
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

	beforeEach(() => {
		for (const key of SUPPRESS_ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) {
			store.close();
		}
		for (const key of SUPPRESS_ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
			delete savedEnv[key];
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

			const apiKey = await authStorage.getApiKey("anthropic", "session-disabled-event");

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

			await authStorage.getApiKey("anthropic", "session-transient-failure");
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
});
