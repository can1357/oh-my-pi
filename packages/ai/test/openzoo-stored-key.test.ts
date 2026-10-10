import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";

const OPENZOO_LOCAL = "openzoo-local";

let storage: AuthStorage | undefined;

afterEach(() => {
	vi.restoreAllMocks();
	storage?.close();
	storage = undefined;
});

function openStorage(): AuthStorage {
	storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	return storage;
}

/**
 * Stand in for the openzoo env hook. `openzoo-local` is what that hook returns
 * when `OPENZOO_API_KEY` is unset; a different value is a real bearer. Other
 * providers keep the real resolver so this file does not touch `Bun.env`.
 */
function stubOpenzooEnvKey(key: string): void {
	const resolveEnvKey = envApiKey.getEnvApiKey;
	vi.spyOn(envApiKey, "getEnvApiKey").mockImplementation(provider =>
		provider === "openzoo" ? key : resolveEnvKey(provider),
	);
}

describe("openzoo stored credentials", () => {
	test("a source-less stored bearer wins over the keyless placeholder", async () => {
		stubOpenzooEnvKey(OPENZOO_LOCAL);
		const auth = openStorage();
		await auth.credentials.set("openzoo", { type: "api_key", key: "oz_broker-bearer" });

		expect(await auth.keys.get("openzoo")).toBe("oz_broker-bearer");
		expect(await auth.keys.peek("openzoo")).toBe("oz_broker-bearer");
		expect(auth.keys.source("openzoo")?.kind).toBe("api_key");
	});

	test("a login placeholder does not hide the source-less bearer", async () => {
		stubOpenzooEnvKey(OPENZOO_LOCAL);
		const auth = openStorage();
		await auth.credentials.set("openzoo", [
			{ type: "api_key", key: "openzoo-local", source: "login" },
			{ type: "api_key", key: "oz_broker-bearer" },
		]);

		expect(await auth.keys.get("openzoo")).toBe("oz_broker-bearer");
		expect(await auth.keys.peek("openzoo")).toBe("oz_broker-bearer");
	});

	test("nothing stored still resolves the keyless placeholder", async () => {
		stubOpenzooEnvKey(OPENZOO_LOCAL);
		const auth = openStorage();

		expect(await auth.keys.get("openzoo")).toBe("openzoo-local");
		expect(await auth.keys.peek("openzoo")).toBe("openzoo-local");
		expect(auth.keys.source("openzoo")?.kind).toBe("env");
	});

	test("OPENZOO_API_KEY still wins over a stored bearer", async () => {
		stubOpenzooEnvKey("oz_env-bearer");
		const auth = openStorage();
		await auth.credentials.set("openzoo", { type: "api_key", key: "oz_broker-bearer" });

		expect(await auth.keys.get("openzoo")).toBe("oz_env-bearer");
		expect(await auth.keys.peek("openzoo")).toBe("oz_env-bearer");
		expect(auth.keys.source("openzoo")?.kind).toBe("env");
	});
});
