/**
 * A transient OAuth refresh failure (network blip, timeout) must not read as
 * "no credential configured" on the request path: `MissingApiKeyError` is
 * non-retryable, so a single blip used to end an unattended session with
 * "No API key for provider" while the stored credential was still valid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialRankingStrategy, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

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

	it.each(["preflight", "request", "signal"] as const)(
		"does not strand a peer's healthy account when a %s refresh is abandoned",
		async stage => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-aborted-refresh-"));
			const dbPath = path.join(dir, "agent.db");
			let peer: AuthStorage | undefined;
			try {
				const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(dbPath);
				storage = new AuthStorage(store, {
					usageProviderResolver: () => undefined,
					rankingStrategyResolver: () => undefined,
				});
				const credential = { ...expiredOAuth(), accountId: "account-1" };
				await storage.credentials.set("anthropic", [
					stage === "request" ? { ...credential, expires: Date.now() + 3_600_000 } : credential,
				]);
				const [row] = storage.credentials.list("anthropic");
				if (!row) throw new Error("missing OAuth credential");
				if (stage === "request") {
					store.prepareForRequest = async id => {
						store.updateAuthCredential(id, credential);
						return true;
					};
				}
				const report: UsageReport = {
					provider: "anthropic",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "five-hour",
							label: "five-hour",
							scope: { provider: "anthropic" },
							window: { id: "five-hour", label: "five-hour", resetsAt: Date.now() + 60_000 },
							amount: { usedFraction: 0.2, unit: "percent" },
							status: "ok",
						},
					],
				};
				const strategy: CredentialRankingStrategy = {
					findWindowLimits: usage => ({ primary: usage.limits[0] }),
					scopeLimits: usage => usage.limits,
					windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
				};
				peer = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath), {
					usageProviderResolver: () => ({ id: "anthropic", fetchUsage: async () => report }),
					rankingStrategyResolver: () => strategy,
				});
				await peer.credentials.reload();
				const healthOptions = { modelId: "claude-opus-5-5", reserveFraction: 0.01 };
				expect((await peer.health.model("anthropic", healthOptions)).state).toBe("healthy");

				const controller = new AbortController();
				const refresh = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(() => {
					if (stage === "signal") controller.abort();
					return Promise.reject(
						stage === "request"
							? new DOMException("credential refresh aborted", "AbortError")
							: stage === "signal"
								? new Error("refresh stopped by caller")
								: new AIError.AbortError("OAuth refresh stopped during shutdown"),
					);
				});
				const resolved = await storage.keys.getWithCredential("anthropic", "shutdown-session", {
					signal: controller.signal,
				});
				if (stage !== "signal") expect(resolved).toBeUndefined();
				expect(refresh).toHaveBeenCalled();

				expect(peer.blocks.list([row.id])).toEqual([]);
				expect((await peer.health.model("anthropic", healthOptions)).state).toBe("healthy");
			} finally {
				peer?.close();
				storage?.close();
				storage = undefined;
				await removeWithRetries(dir);
			}
		},
	);

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
