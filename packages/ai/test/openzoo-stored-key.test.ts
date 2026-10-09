import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";

const ORIGINAL_OPENZOO_API_KEY = Bun.env.OPENZOO_API_KEY;

let storage: AuthStorage | undefined;

afterEach(() => {
	storage?.close();
	storage = undefined;
	if (ORIGINAL_OPENZOO_API_KEY === undefined) {
		delete Bun.env.OPENZOO_API_KEY;
	} else {
		Bun.env.OPENZOO_API_KEY = ORIGINAL_OPENZOO_API_KEY;
	}
});

function openStorage(): AuthStorage {
	storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	return storage;
}

describe("openzoo stored credentials", () => {
	test("a source-less stored bearer wins over the keyless placeholder", async () => {
		delete Bun.env.OPENZOO_API_KEY;
		const auth = openStorage();
		await auth.credentials.set("openzoo", { type: "api_key", key: "oz_broker-bearer" });

		expect(await auth.keys.get("openzoo")).toBe("oz_broker-bearer");
		expect(await auth.keys.peek("openzoo")).toBe("oz_broker-bearer");
		expect(auth.keys.source("openzoo")?.kind).toBe("api_key");
	});

	test("a login placeholder does not hide the source-less bearer", async () => {
		delete Bun.env.OPENZOO_API_KEY;
		const auth = openStorage();
		await auth.credentials.set("openzoo", [
			{ type: "api_key", key: "openzoo-local", source: "login" },
			{ type: "api_key", key: "oz_broker-bearer" },
		]);

		expect(await auth.keys.get("openzoo")).toBe("oz_broker-bearer");
		expect(await auth.keys.peek("openzoo")).toBe("oz_broker-bearer");
	});

	test("nothing stored still resolves the keyless placeholder", async () => {
		delete Bun.env.OPENZOO_API_KEY;
		const auth = openStorage();

		expect(await auth.keys.get("openzoo")).toBe("openzoo-local");
		expect(await auth.keys.peek("openzoo")).toBe("openzoo-local");
		expect(auth.keys.source("openzoo")?.kind).toBe("env");
	});

	test("OPENZOO_API_KEY still wins over a stored bearer", async () => {
		const auth = openStorage();
		await auth.credentials.set("openzoo", { type: "api_key", key: "oz_broker-bearer" });
		Bun.env.OPENZOO_API_KEY = "oz_env-bearer";

		expect(await auth.keys.get("openzoo")).toBe("oz_env-bearer");
		expect(await auth.keys.peek("openzoo")).toBe("oz_env-bearer");
		expect(auth.keys.source("openzoo")?.kind).toBe("env");
	});
});
