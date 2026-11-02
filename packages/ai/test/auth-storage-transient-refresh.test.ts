/**
 * A transient OAuth refresh failure (network blip, timeout) must not read as
 * "no credential configured" on the request path: `MissingApiKeyError` is
 * non-retryable, so a single blip used to end an unattended session with
 * "No API key for provider" while the stored credential was still valid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;

const expiredOAuth = () => ({
	type: "oauth" as const,
	access: "expired-access",
	refresh: "refresh-1",
	expires: Date.now() - 60_000,
});

describe("AuthStorage transient OAuth refresh failure", () => {
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	let storage: AuthStorage | undefined;

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		storage?.close();
		storage = undefined;
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	const open = async (): Promise<AuthStorage> => {
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"));
		return storage;
	};

	it("rejects request resolution with a retryable error and keeps the credential", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [expiredOAuth()]);
		const refresh = vi
			.spyOn(oauthUtils, "refreshOAuthToken")
			.mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
			.mockResolvedValue({ access: "fresh-access", refresh: "refresh-2", expires: Date.now() + 3_600_000 });

		const error = await auth.keys.getWithCredential("anthropic", "session").catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AIError.OAuthRefreshUnavailableError);
		expect(AIError.retriable(AIError.classify(error))).toBe(true);
		expect(auth.credentials.has("anthropic")).toBe(true);

		expect((await auth.keys.getWithCredential("anthropic", "session"))?.apiKey).toBe("fresh-access");
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("lets availability probes treat a transient refresh failure as unavailable", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [expiredOAuth()]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("fetch failed: ECONNRESET"));

		expect(await auth.keys.get("anthropic", "session")).toBeUndefined();
		expect(auth.credentials.has("anthropic")).toBe(true);
	});

	it("surfaces the refresh failure for a session restricted to its account pool", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [{ ...expiredOAuth(), accountId: "acc-a" }]);
		auth.sessions.restrict("anthropic", "child", ["account:acc-a"]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("fetch failed: ECONNRESET"));

		const error = await auth.keys.getWithCredential("anthropic", "child").catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AIError.OAuthRefreshUnavailableError);
	});

	it("still falls back to a stored API key when OAuth refresh fails transiently", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [expiredOAuth(), { type: "api_key", key: "sk-fallback" }]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("fetch failed: ECONNRESET"));

		expect((await auth.keys.getWithCredential("anthropic", "session"))?.apiKey).toBe("sk-fallback");
	});

	it("reports no key after a definitive refresh failure disables the only credential", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [expiredOAuth()]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(
			new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}'),
		);

		expect(await auth.keys.getWithCredential("anthropic", "session")).toBeUndefined();
		expect(auth.credentials.has("anthropic")).toBe(false);
	});
});
