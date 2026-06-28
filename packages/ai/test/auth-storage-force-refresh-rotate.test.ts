import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@pk-nerdsaver-ai/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-rotate-oauth";
const SOURCE = "auth-storage-force-refresh-rotate-test";

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

function usageLimitError(): Error & { status: number } {
	return Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."), {
		status: 429,
	});
}

function quotaPayloadError(message: string, status?: number): Error & { status?: number } {
	return status === undefined ? new Error(message) : Object.assign(new Error(message), { status });
}

function invalidRequestError(): Error & { status: number } {
	return Object.assign(new Error("400 invalid_request_error: model unsupported"), { status: 400 });
}

describe("AuthStorage forceRefresh + rotateSessionCredential", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-rotate-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(SOURCE);
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	function registerProvider(onRefresh?: () => void): void {
		registerOAuthProvider({
			id: PROVIDER,
			name: "Rotate Unit",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: farExpiry() };
			},
			async refreshToken(credentials) {
				onRefresh?.();
				return {
					...credentials,
					access: "minted-access",
					refresh: "minted-refresh",
					expires: farExpiry(),
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
	}

	test("forceRefresh re-mints a not-yet-expired token; a normal resolve uses the cached token", async () => {
		if (!authStorage) throw new Error("test setup failed");
		let refreshCalls = 0;
		registerProvider(() => {
			refreshCalls += 1;
		});
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "cached-access", refresh: "cached-refresh", expires: farExpiry() },
		]);

		const cached = await authStorage.getApiKey(PROVIDER, "s-control");
		expect(cached).toBe("cached-access");
		expect(refreshCalls).toBe(0);

		const forced = await authStorage.getApiKey(PROVIDER, "s-force", { forceRefresh: true });
		expect(forced).toBe("minted-access");
		expect(refreshCalls).toBe(1);

		// The re-minted credential is persisted, so the next plain resolve sees it.
		const after = await authStorage.getApiKey(PROVIDER, "s-after");
		expect(after).toBe("minted-access");
	});

	test("rotateSessionCredential(401) blocks + clears the sticky and rotates to a sibling", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const first = await authStorage.getApiKey(PROVIDER, "sess");
		expect(["acc-A", "acc-B"]).toContain(first ?? "");

		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");
		const rotated = await authStorage.rotateSessionCredential(PROVIDER, "sess", { error: authError() });

		expect(rotated).toBe(true);
		// A hard 401 must NOT take the usage-limit code path.
		expect(usageLimitSpy).not.toHaveBeenCalled();

		const second = await authStorage.getApiKey(PROVIDER, "sess");
		expect(["acc-A", "acc-B"]).toContain(second ?? "");
		expect(second).not.toBe(first);
	});

	test("rotateSessionCredential(usage-limit) delegates to markUsageLimitReached", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const first = await authStorage.getApiKey(PROVIDER, "sess");
		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

		const rotated = await authStorage.rotateSessionCredential(PROVIDER, "sess", {
			error: usageLimitError(),
		});

		expect(rotated).toBe(true);
		// Usage / account-rate-limit errors route to markUsageLimitReached, which
		// owns the block duration (default + server usage-report reset) — the
		// resolver never parses retry-after itself.
		expect(usageLimitSpy).toHaveBeenCalledTimes(1);
		expect(usageLimitSpy.mock.calls[0]?.[0]).toBe(PROVIDER);
		expect(usageLimitSpy.mock.calls[0]?.[1]).toBe("sess");

		const second = await authStorage.getApiKey(PROVIDER, "sess");
		expect(second).not.toBe(first);
	});

	test("rotateSessionCredential treats quota payloads as temporary usage blocks", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
			{ type: "oauth", access: "acc-C", refresh: "ref-C", expires: farExpiry() },
			{ type: "oauth", access: "acc-D", refresh: "ref-D", expires: farExpiry() },
			{ type: "oauth", access: "acc-E", refresh: "ref-E", expires: farExpiry() },
		]);

		for (const [index, error] of [
			[0, quotaPayloadError("429", 429)],
			[1, quotaPayloadError("insufficient_quota")],
			[2, quotaPayloadError("usage_limit_exceeded")],
			[3, quotaPayloadError("usage_limit_reached")],
		] as const) {
			const sessionId = `quota-payload-${index}`;
			const first = await authStorage.getApiKey(PROVIDER, sessionId);
			const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

			const rotated = await authStorage.rotateSessionCredential(PROVIDER, sessionId, { error });

			expect(rotated).toBe(true);
			expect(usageLimitSpy).toHaveBeenCalledTimes(1);
			expect(await authStorage.getApiKey(PROVIDER, sessionId)).not.toBe(first);
			usageLimitSpy.mockRestore();
		}
	});

	test("rotateSessionCredential does not treat invalid requests as quota blocks", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		await authStorage.getApiKey(PROVIDER, "invalid-request");
		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

		await authStorage.rotateSessionCredential(PROVIDER, "invalid-request", { error: invalidRequestError() });

		expect(usageLimitSpy).not.toHaveBeenCalled();
	});

	test("rotateSessionCredential leaves informative transient 429s out of the quota block path", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const transient429Bodies = [
			"Cloud Code Assist API error (429): Too many requests",
			"Please retry in 5s",
			"Service overloaded 529",
		];

		for (const [index, body] of transient429Bodies.entries()) {
			const sessionId = `transient-429-${index}`;
			await authStorage.getApiKey(PROVIDER, sessionId);
			const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

			await authStorage.rotateSessionCredential(PROVIDER, sessionId, {
				error: Object.assign(new Error(body), { status: 429 }),
			});

			// `Too many requests`, server retry hints, and capacity overload are
			// owned by the provider's own retry layer — burning a sibling
			// credential here would orphan a healthy account for the default
			// backoff window.
			expect(usageLimitSpy).not.toHaveBeenCalled();
			usageLimitSpy.mockRestore();
		}
	});

	test("rotateSessionCredential reports no sibling for a single-credential setup", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "only-access", refresh: "only-refresh", expires: farExpiry() },
		]);

		await authStorage.getApiKey(PROVIDER, "sess");
		expect(await authStorage.rotateSessionCredential(PROVIDER, "sess", { error: authError() })).toBe(false);
	});

	test("rotateSessionCredential returns false when the session has no sticky credential", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() }]);

		// Never resolved a key for this session → nothing to rotate away from.
		expect(await authStorage.rotateSessionCredential(PROVIDER, "untouched", { error: authError() })).toBe(false);
	});

	test("markUsageLimitReached reports the earliest sibling unblock time when every sibling is blocked", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		// Session A takes one credential and parks it briefly (e.g. a transient
		// probe block) — a sibling is still free, so this reports switched.
		await authStorage.getApiKey(PROVIDER, "sess-a");
		const blockedBefore = Date.now();
		const first = await authStorage.markUsageLimitReached(PROVIDER, "sess-a", { retryAfterMs: 30_000 });
		const blockedAfter = Date.now();
		expect(first.switched).toBe(true);

		// Session B lands on the remaining credential and hits a multi-hour
		// usage limit. No sibling is free *right now*, but the result must
		// carry session A's short unblock time — not the 1h window — so the
		// retry layer can wait seconds instead of bailing on the long wait.
		await authStorage.getApiKey(PROVIDER, "sess-b");
		const second = await authStorage.markUsageLimitReached(PROVIDER, "sess-b", { retryAfterMs: 3_600_000 });
		expect(second.switched).toBe(false);
		expect(second.retryAtMs).toBeDefined();
		expect(second.retryAtMs!).toBeGreaterThanOrEqual(blockedBefore + 30_000);
		expect(second.retryAtMs!).toBeLessThanOrEqual(blockedAfter + 30_000);
	});

	test("markUsageLimitReached reports no retry time for a single-credential setup", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "only-access", refresh: "only-refresh", expires: farExpiry() },
		]);

		await authStorage.getApiKey(PROVIDER, "sess");
		const outcome = await authStorage.markUsageLimitReached(PROVIDER, "sess", { retryAfterMs: 3_600_000 });
		expect(outcome).toEqual({ switched: false, retryAtMs: undefined });
	});
});
