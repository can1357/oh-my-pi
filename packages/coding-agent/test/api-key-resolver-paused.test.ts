import { describe, expect, test } from "bun:test";
import { type AuthAccountPolicies, AuthStorage, DEFAULT_USAGE_RESERVE_PCT } from "@oh-my-pi/pi-ai/auth-storage";
import { resolvedApiKeyBearer } from "@oh-my-pi/pi-ai/auth-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createApiKeyResolver, describePausedAccounts } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";

const PAUSE_A = { provider: "anthropic", account: { email: "a@example.com" }, paused: true } as const;
const PAUSE_B = { provider: "anthropic", account: { email: "b@example.com" }, paused: true } as const;

/** Two stored Anthropic logins behind the given policies; no usage provider, so selection stays offline. */
async function createStorage(accountPolicies: AuthAccountPolicies): Promise<AuthStorage> {
	const authStorage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	await authStorage.credentials.set("anthropic", [
		{
			type: "oauth",
			access: "access-a",
			refresh: "refresh-a",
			expires: Date.now() + 3_600_000,
			email: "a@example.com",
			orgId: "org-a",
		},
		{
			type: "oauth",
			access: "access-b",
			refresh: "refresh-b",
			expires: Date.now() + 3_600_000,
			email: "b@example.com",
			orgId: "org-b",
		},
	]);
	authStorage.setAccountPolicies({ accountPolicies, defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
	return authStorage;
}

function resolverFor(authStorage: AuthStorage) {
	return createApiKeyResolver(
		{
			authStorage,
			getApiKeyWithCredentialForProvider: (provider, sessionId, options) =>
				authStorage.keys.getWithCredential(provider, sessionId, options),
		},
		"anthropic",
		{ sessionId: "paused-resolver" },
	);
}

describe("paused account API key resolver", () => {
	test("tells how to resume when every OAuth account is paused, instead of suggesting a missing login", async () => {
		const authStorage = await createStorage([PAUSE_A, PAUSE_B]);
		try {
			const hint = describePausedAccounts(authStorage, "anthropic");
			expect(hint).toContain("is paused in auth.accountPolicies");
			expect(hint).toContain("a@example.com");
			expect(hint).toContain("b@example.com");
			const initial = Promise.resolve(resolverFor(authStorage)({ lastChance: false, error: undefined }));
			await expect(initial).rejects.toBeInstanceOf(AIError.MissingApiKeyError);
			await expect(initial).rejects.toThrow(hint);
		} finally {
			authStorage.close();
		}
	});

	test("resolves the visible account without the hint when only some accounts are paused", async () => {
		const authStorage = await createStorage([PAUSE_B]);
		try {
			expect(describePausedAccounts(authStorage, "anthropic")).toBeUndefined();
			const resolved = await resolverFor(authStorage)({ lastChance: false, error: undefined });
			expect(resolvedApiKeyBearer(resolved)).toBe("access-a");
		} finally {
			authStorage.close();
		}
	});
});
