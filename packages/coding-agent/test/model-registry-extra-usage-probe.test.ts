import { afterEach, describe, expect, test, vi } from "bun:test";
import type { UsageProvider } from "@oh-my-pi/pi-ai/usage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-5";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function money(amount: number): { amount_minor: number; currency: "USD"; exponent: 2 } {
	return { amount_minor: Math.round(amount * 100), currency: "USD", exponent: 2 };
}

function credential(): OAuthCredentials {
	return {
		access: "access-only",
		refresh: "refresh-only",
		expires: Date.now() + WEEK_MS,
		accountId: "only",
		email: "only@example.test",
	};
}

function usageProvider(): UsageProvider {
	return {
		id: PROVIDER,
		async fetchUsage() {
			return parseClaudeUsagePayload(
				{
					five_hour: { utilization: 0, resets_at: new Date(Date.now() + WEEK_MS).toISOString() },
					seven_day: { utilization: 100, resets_at: new Date(Date.now() + WEEK_MS).toISOString() },
					spend: { enabled: true, used: money(98), limit: money(100) },
				},
				{ accountId: "only" },
			);
		},
	};
}

describe("ModelRegistry extra-usage availability probes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns no availability key when the only account is past its paid floor but preserves request failure", async () => {
		const authStorage = await AuthStorage.create(":memory:", {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider() : undefined),
			accountPolicies: [
				{
					provider: PROVIDER,
					account: { accountId: "only" },
					extraUsageFloor: 3,
				},
			],
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const stored = credentials[PROVIDER] as OAuthCredentials | undefined;
			return stored === undefined ? null : { apiKey: stored.access, newCredentials: stored };
		});
		await authStorage.credentials.set(PROVIDER, [{ type: "oauth", ...credential() }]);
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const model = getBundledModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error("Expected bundled probe model");

		try {
			await expect(registry.getApiKey(model, "probe")).resolves.toBeUndefined();
			await expect(registry.getApiKey(model, "probe", { rejectWithheld: true })).rejects.toBeInstanceOf(
				AIError.ExtraUsageWithheldError,
			);
			vi.spyOn(authStorage.keys, "getWithCredential").mockRejectedValueOnce(
				new AIError.OAuthRefreshUnavailableError(PROVIDER, new Error("ECONNRESET")),
			);
			await expect(registry.getApiKey(model, "probe", { rejectWithheld: true })).resolves.toBeUndefined();
			await expect(
				registry.getApiKeyForProvider(PROVIDER, "availability-probe", { modelId: MODEL_ID }),
			).resolves.toBeUndefined();
			await expect(
				registry.getApiKeyWithCredentialForProvider(PROVIDER, "request", { modelId: MODEL_ID }),
			).rejects.toBeInstanceOf(AIError.ExtraUsageWithheldError);
		} finally {
			authStorage.close();
		}
	});
});
