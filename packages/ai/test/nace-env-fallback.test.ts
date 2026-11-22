import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";

const ORIGINAL_ENV = {
	NACE_API_KEY: Bun.env.NACE_API_KEY,
	DREX_API_KEY: Bun.env.DREX_API_KEY,
} as const;

afterEach(() => {
	for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
});

describe("Nace env fallback", () => {
	test("falls back to DREX_API_KEY when NACE_API_KEY is unset and prefers NACE_API_KEY", async () => {
		delete Bun.env.NACE_API_KEY;
		Bun.env.DREX_API_KEY = "drex-alias-key";
		expect(getEnvApiKey("nace")).toBe("drex-alias-key");

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			expect(await storage.getApiKey("nace")).toBe("drex-alias-key");
		} finally {
			store.close();
		}

		Bun.env.NACE_API_KEY = "nace-primary-key";
		expect(getEnvApiKey("nace")).toBe("nace-primary-key");
	});
});
