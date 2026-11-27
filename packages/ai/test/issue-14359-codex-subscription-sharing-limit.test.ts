import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	CODEX_SUBSCRIPTION_SHARING_LIMIT_MESSAGE,
	CodexApiError,
} from "../src/providers/openai-codex/response-handler";
import { createCodexProviderStreamError } from "../src/providers/openai-codex-responses";

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const SHARING_SCOPE = "subscription-sharing";
const PROVIDER_ERROR = {
	message:
		"The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.",
	type: "invalid_request_error",
	param: null,
	code: "subscription_sharing_usage_limit_exceeded",
};

function planWindow(key: "primary" | "secondary", durationMs: number): UsageLimit {
	return {
		id: `openai-codex:${key}`,
		label: key,
		scope: { provider: "openai-codex", windowId: key === "primary" ? "5h" : "7d", shared: true },
		window: { id: key, label: key, durationMs, resetsAt: Date.now() + durationMs },
		amount: { unit: "percent", used: 5, limit: 100, remaining: 95, usedFraction: 0.05, remainingFraction: 0.95 },
		status: "ok",
	};
}

/** Plan windows with headroom: what ChatGPT reports while the sharing cap still refuses. */
function healthyPlanReport(accountId: string): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [planWindow("primary", 5 * HOUR_MS), planWindow("secondary", WEEK_MS)],
		metadata: { accountId, allowed: true, limitReached: false, planType: "plus" },
	};
}

function credential(accountId: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email: `${accountId}@example.com`,
	};
}

describe("issue #14359: Codex subscription-sharing limit", () => {
	test("an HTTP refusal names the app limit instead of OpenAI's bare text and stays a usage limit", async () => {
		const error = await CodexApiError.fromResponse(
			new Response(JSON.stringify({ error: PROVIDER_ERROR }), { status: 429 }),
		);
		expect(error.message).toBe(CODEX_SUBSCRIPTION_SHARING_LIMIT_MESSAGE);
		expect(error.message).toContain("Settings → Usage → App limits");
		expect(error.info.code).toBe("subscription_sharing_usage_limit_exceeded");
		expect(AIError.isUsageLimit(error)).toBe(true);
	});

	test("a streamed refusal reads the same and is not retried as a transient failure", () => {
		const error = createCodexProviderStreamError({ type: "error", error: PROVIDER_ERROR });
		expect(error.message).toBe(
			`${CODEX_SUBSCRIPTION_SHARING_LIMIT_MESSAGE} (code=subscription_sharing_usage_limit_exceeded)`,
		);
		expect(error.retryable).toBe(false);
		expect(AIError.isUsageLimit(new Error(error.message))).toBe(true);
	});

	describe("credential rotation", () => {
		let store: AuthCredentialStore;
		let authStorage: AuthStorage;
		const usageProvider: UsageProvider = {
			id: "openai-codex",
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				return accountId ? healthyPlanReport(accountId) : null;
			},
		};

		beforeEach(async () => {
			store = new SqliteAuthCredentialStore(new Database(":memory:"));
			authStorage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
			});
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
				const stored = credentials["openai-codex"] as OAuthCredentials | undefined;
				return stored?.accountId ? { apiKey: `api-${stored.accountId}`, newCredentials: stored } : null;
			});
			await authStorage.credentials.set("openai-codex", [
				{ type: "oauth", ...credential("acct-capped") },
				{ type: "oauth", ...credential("acct-sibling") },
			]);
		});

		afterEach(() => {
			setSystemTime();
			vi.restoreAllMocks();
			store.close();
		});

		test("parks the capped account for every model where healthy plan windows cannot lift it", async () => {
			const capped = store.listAuthCredentials("openai-codex").find(row => {
				return row.credential.type === "oauth" && row.credential.accountId === "acct-capped";
			});
			if (!capped) throw new Error("expected the capped credential row");
			const sessionId = "sharing-capped";
			expect(authStorage.sessions.pin("openai-codex", sessionId, capped.id)).toBe(true);
			expect(await authStorage.keys.get("openai-codex", sessionId)).toBe("api-acct-capped");

			const startedAt = Date.now();
			const rotation = await authStorage.limits.rotate("openai-codex", sessionId, {
				error: new Error(CODEX_SUBSCRIPTION_SHARING_LIMIT_MESSAGE),
				credentialId: capped.id,
			});
			expect(rotation.switched).toBe(true);

			// Blocked under the sharing scope for the quota heuristic, not the
			// 60s generic default or a plan-window reset.
			const blockedUntil = store.getCredentialBlock?.(capped.id, "openai-codex:oauth", SHARING_SCOPE);
			expect(blockedUntil).toBeGreaterThanOrEqual(startedAt + 30 * 60_000);
			expect(blockedUntil).toBeLessThan(startedAt + HOUR_MS);
			// The session's own bookkeeping also parks the plan ("chat") scope on its quota guess.
			await authStorage.limits.markReached("openai-codex", sessionId, {
				retryAfterMs: 30 * 60_000,
				credentialId: capped.id,
			});
			expect(store.getCredentialBlock?.(capped.id, "openai-codex:oauth", "chat")).toBeDefined();

			// Past the stale-block guard, a live report with plan headroom heals the
			// plan scope but must not lift the sharing cap it does not measure.
			setSystemTime(new Date(Date.now() + 10 * 60_000));
			await authStorage.usage.reports();
			expect(store.getCredentialBlock?.(capped.id, "openai-codex:oauth", "chat")).toBeUndefined();
			expect(store.getCredentialBlock?.(capped.id, "openai-codex:oauth", SHARING_SCOPE)).toBe(blockedUntil);

			for (const modelId of [undefined, "gpt-5.3-codex-spark"]) {
				for (let index = 0; index < 10; index++) {
					const key = await authStorage.keys.get(
						"openai-codex",
						`fresh-${modelId ?? "chat"}-${index}`,
						modelId === undefined ? undefined : { modelId },
					);
					expect(key).toBe("api-acct-sibling");
				}
			}
		});
	});
});
