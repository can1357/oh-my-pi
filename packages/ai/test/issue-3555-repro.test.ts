import { describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

describe("issue 3555 Ollama usage registration", () => {
	it("registers Ollama and Ollama Cloud in the default usage resolver", async () => {
		const store: AuthCredentialStore = {
			close() {},
			listAuthCredentials() {
				return [];
			},
			updateAuthCredential() {},
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				return false;
			},
			replaceAuthCredentialsForProvider() {
				return [];
			},
			upsertAuthCredentialForProvider() {
				return [];
			},
			deleteAuthCredentialsForProvider() {},
			getCache() {
				return null;
			},
			setCache() {},
			cleanExpiredCache() {},
		};
		const storage = new AuthStorage(store);
		await storage.reload();

		try {
			expect(storage.usageProviderFor("ollama")).toBeDefined();
			const cloudProvider = storage.usageProviderFor("ollama-cloud");
			expect(cloudProvider).toBeDefined();
			if (!cloudProvider) throw new Error("expected Ollama Cloud usage provider");

			const report = await cloudProvider.fetchUsage(
				{
					provider: "ollama-cloud",
					credential: { type: "oauth", email: "cloud@example.test" },
				},
				{ fetch: globalThis.fetch },
			);
			expect(report).toMatchObject({
				provider: "ollama-cloud",
				limits: [],
				metadata: { email: "cloud@example.test" },
			});
			expect(report?.notes?.[0]).toContain("does not expose a standalone quota usage API");
		} finally {
			storage.close();
		}
	});
});
