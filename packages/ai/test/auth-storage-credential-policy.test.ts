import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

describe("AuthStorage remote snapshots", () => {
	it("redacts refresh secrets while keeping the Kiro client binding", async () => {
		const auth = await AuthStorage.create(":memory:");
		try {
			await auth.credentials.set("kiro", {
				type: "oauth",
				access: "access-token",
				refresh: "real-refresh-token",
				expires: Date.now() + 60_000,
				kiroClientId: "client-id",
				kiroClientSecret: "real-client-secret",
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			});
			const credential = auth.credentials.snapshot().credentials.find(e => e.provider === "kiro")?.credential;
			expect(credential).toMatchObject({
				refresh: "__remote__",
				kiroClientId: "client-id",
				kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
			});
			expect(credential).not.toHaveProperty("kiroClientSecret");
		} finally {
			auth.close();
		}
	});
});
