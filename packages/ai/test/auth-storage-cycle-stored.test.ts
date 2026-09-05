import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { removeWithRetries } from "../../utils/src/temp";

describe("AuthStorage manual stored api-key cycling", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	beforeEach(async () => {
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-cycle-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("manual cycle moves the same session to the other stored key and back", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const keys = ["first-kagi-key", "second-kagi-key"];
		const controller = {
			onAuth: () => {},
			onPrompt: async () => keys.shift() ?? "",
		};
		await authStorage.login("kagi", controller);
		await authStorage.login("kagi", controller);

		const before = await authStorage.getApiKey("kagi", "sess-cycle");
		expect(["first-kagi-key", "second-kagi-key"]).toContain(before);

		expect(authStorage.cycleStoredApiKey("kagi")).toEqual({ total: 2 });
		expect(await authStorage.getApiKey("kagi", "sess-cycle")).not.toBe(before);

		expect(authStorage.cycleStoredApiKey("kagi")).toEqual({ total: 2 });
		expect(await authStorage.getApiKey("kagi", "sess-cycle")).toBe(before);
	});

	it("returns undefined with fewer than two stored keys", async () => {
		if (!authStorage) throw new Error("test setup failed");

		expect(authStorage.cycleStoredApiKey("kagi")).toBeUndefined();

		await authStorage.login("kagi", {
			onAuth: () => {},
			onPrompt: async () => "only-key",
		});
		expect(authStorage.cycleStoredApiKey("kagi")).toBeUndefined();
		expect(await authStorage.getApiKey("kagi", "sess-cycle")).toBe("only-key");
	});
});
