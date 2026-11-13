import { expect, test } from "bun:test";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PRIMARY_SESSION = "primary-session";
const SECONDARY_SESSION = "secondary-session";

test("an exclusive session pool falls back only inside its allowlist and denies unlisted providers", async () => {
	const authStorage = createInMemoryAuthStorage();
	try {
		await authStorage.credentials.set(
			"anthropic",
			["a", "b", "c"].map(suffix => ({
				type: "oauth" as const,
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 60 * 60_000,
				accountId: `account-${suffix}`,
				email: `${suffix}@example.com`,
				orgId: `org-${suffix}`,
			})),
		);
		await authStorage.credentials.set("openrouter", { type: "api_key", key: "outside-api-key" });
		const accounts = authStorage.oauth.accounts("anthropic");
		const accountA = accounts.find(account => account.accountId === "account-a");
		const accountB = accounts.find(account => account.accountId === "account-b");
		const accountC = accounts.find(account => account.accountId === "account-c");
		if (!accountA || !accountB || !accountC) throw new Error("Expected all OAuth fixtures");

		const scope = new SessionAccountPoolScope(
			authStorage,
			{ anthropic: ["email:a@example.com|org:org-a", "email:b@example.com|org:org-b"] },
			PRIMARY_SESSION,
			{ denyUnlistedProviders: true },
		);
		const registry = scope.registry(new ModelRegistry(authStorage));
		scope.adopt(SECONDARY_SESSION);
		for (const sessionId of [PRIMARY_SESSION, SECONDARY_SESSION]) {
			expect(scope.permits("anthropic", sessionId, accountA.credentialId)).toBe(true);
			expect(scope.permits("anthropic", sessionId, accountB.credentialId)).toBe(true);
			expect(scope.permits("anthropic", sessionId, accountC.credentialId)).toBe(false);
		}

		expect(scope.allow("anthropic", "email:c@example.com|org:org-c")).toBe(true);
		for (const sessionId of [PRIMARY_SESSION, SECONDARY_SESSION]) {
			expect(scope.permits("anthropic", sessionId, accountC.credentialId)).toBe(true);
		}
		expect(scope.allow("anthropic", "email:c@example.com|org:org-c")).toBe(false);

		expect(authStorage.sessions.pin("anthropic", PRIMARY_SESSION, accountA.credentialId)).toBe(true);
		expect(await authStorage.keys.get("anthropic", PRIMARY_SESSION)).toBe("access-a");
		await authStorage.credentials.disable(accountA.credentialId, "test quota exhausted");
		expect(await authStorage.keys.get("anthropic", PRIMARY_SESSION)).toBe("access-b");

		expect(scope.pin("anthropic", "email:b@example.com|org:org-b")).toBe(true);
		for (const sessionId of [PRIMARY_SESSION, SECONDARY_SESSION]) {
			expect(scope.permits("anthropic", sessionId, accountA.credentialId)).toBe(false);
			expect(scope.permits("anthropic", sessionId, accountB.credentialId)).toBe(true);
			expect(scope.permits("anthropic", sessionId, accountC.credentialId)).toBe(false);
		}
		expect(scope.allows("anthropic", "email:c@example.com|org:org-c")).toBe(true);
		await authStorage.credentials.disable(accountB.credentialId, "test hard pin");
		await expect(authStorage.keys.get("anthropic", PRIMARY_SESSION)).rejects.toThrow(
			"restricted to its OAuth account pool",
		);
		expect(scope.pin("anthropic", "email:c@example.com|org:org-c")).toBe(true);
		expect(await authStorage.keys.get("anthropic", PRIMARY_SESSION)).toBe("access-c");
		await expect(registry.getApiKeyForProvider("openrouter", PRIMARY_SESSION)).rejects.toThrow(
			"restricted to its OAuth account pool",
		);

		scope.release();
		expect(authStorage.sessions.permits("anthropic", PRIMARY_SESSION, accountC.credentialId)).toBe(true);
		expect(await authStorage.keys.get("openrouter", PRIMARY_SESSION)).toBe("outside-api-key");
	} finally {
		authStorage.close();
	}
});
