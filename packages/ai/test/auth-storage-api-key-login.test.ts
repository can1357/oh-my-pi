import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import * as deepseekModule from "@pk-nerdsaver-ai/pi-ai/registry/deepseek";
import * as kagiModule from "@pk-nerdsaver-ai/pi-ai/registry/kagi";
import * as ollamaCloudModule from "@pk-nerdsaver-ai/pi-ai/registry/ollama-cloud";
import { removeWithRetries } from "../../utils/src/temp";

function countCredentialRows(dbPath: string, provider: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ?").get(provider) as
			| { count?: number }
			| undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

function countCredentialRowsByDisabledState(dbPath: string, provider: string, disabled: boolean): number {
	const disabledClause = disabled ? "IS NOT NULL" : "IS NULL";
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ? AND disabled_cause ${disabledClause}`,
			)
			.get(provider) as { count?: number } | undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

describe("AuthStorage api-key login upsert", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let loginDeepSeekSpy: Mock<typeof deepseekModule.loginDeepSeek>;
	let loginKagiSpy: Mock<typeof kagiModule.loginKagi>;
	let loginOllamaCloudSpy: Mock<typeof ollamaCloudModule.loginOllamaCloud>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-login-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		loginDeepSeekSpy = vi.spyOn(deepseekModule, "loginDeepSeek");
		loginKagiSpy = vi.spyOn(kagiModule, "loginKagi");
		loginOllamaCloudSpy = vi.spyOn(ollamaCloudModule, "loginOllamaCloud");
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

	it("reuses the stored api-key row when re-login returns the same key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginKagiSpy.mockResolvedValueOnce("same-kagi-key").mockResolvedValueOnce("same-kagi-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("kagi", controller);
		await authStorage.login("kagi", controller);

		expect(countCredentialRows(dbPath, "kagi")).toBe(1);
		const credentials = store.listAuthCredentials("kagi");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-kagi-key");
		expect(store.getApiKey("kagi")).toBe("same-kagi-key");
		expect(await authStorage.getApiKey("kagi", "session-kagi-relogin")).toBe("same-kagi-key");
	});

	it("appends a different api-key row when re-login returns a new key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginKagiSpy.mockResolvedValueOnce("first-kagi-key").mockResolvedValueOnce("second-kagi-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("kagi", controller);
		await authStorage.login("kagi", controller);

		expect(countCredentialRows(dbPath, "kagi")).toBe(2);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", false)).toBe(2);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", true)).toBe(0);

		const credentials = store.listAuthCredentials("kagi");
		expect(credentials.map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "first-kagi-key" },
			{ type: "api_key", key: "second-kagi-key" },
		]);
		const rotatedKeys = [await authStorage.getApiKey("kagi"), await authStorage.getApiKey("kagi")].sort();
		expect(rotatedKeys).toEqual(["first-kagi-key", "second-kagi-key"]);
	});

	it("hard-deletes superseded api-key rows when a different key replaces them", () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		store.saveApiKey("kagi", "old-key-123");
		store.saveApiKey("kagi", "new-key-456");

		expect(countCredentialRows(dbPath, "kagi")).toBe(1);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", false)).toBe(1);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", true)).toBe(0);
		expect(store.getApiKey("kagi")).toBe("new-key-456");
	});

	it("reuses the stored api-key row when ollama-cloud re-login returns the same key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginOllamaCloudSpy.mockResolvedValueOnce("same-ollama-cloud-key").mockResolvedValueOnce("same-ollama-cloud-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("ollama-cloud", controller);
		await authStorage.login("ollama-cloud", controller);

		expect(countCredentialRows(dbPath, "ollama-cloud")).toBe(1);
		const credentials = store.listAuthCredentials("ollama-cloud");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-ollama-cloud-key");
		expect(store.getApiKey("ollama-cloud")).toBe("same-ollama-cloud-key");
		expect(await authStorage.getApiKey("ollama-cloud", "session-ollama-cloud-relogin")).toBe("same-ollama-cloud-key");
	});

	it("stores DeepSeek login credentials as a reusable api-key credential", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginDeepSeekSpy.mockResolvedValueOnce("same-deepseek-key").mockResolvedValueOnce("same-deepseek-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("deepseek", controller);
		await authStorage.login("deepseek", controller);

		expect(countCredentialRows(dbPath, "deepseek")).toBe(1);
		const credentials = store.listAuthCredentials("deepseek");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-deepseek-key");
		expect(store.getApiKey("deepseek")).toBe("same-deepseek-key");
		expect(await authStorage.getApiKey("deepseek", "session-deepseek-relogin")).toBe("same-deepseek-key");
	});
});
