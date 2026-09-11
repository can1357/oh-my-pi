import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { serializeAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
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
	// Most tests neutralize the env leg so ambient shell / ~/.env keys cannot
	// hide the stored credential behavior under test. Login-persisted API keys
	// have their own precedence coverage below.
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let getEnvApiKeySpy: Mock<typeof aiStream.getEnvApiKey>;

	beforeEach(async () => {
		getEnvApiKeySpy = vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-login-"));
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

	it("reuses the stored api-key row when re-login returns the same key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "same-kagi-key",
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

		const keys = ["first-kagi-key", "second-kagi-key"];
		const controller = {
			onAuth: () => {},
			onPrompt: async () => keys.shift() ?? "",
		};

		await authStorage.login("kagi", controller);
		await authStorage.login("kagi", controller);

		expect(countCredentialRows(dbPath, "kagi")).toBe(2);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", false)).toBe(2);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", true)).toBe(0);

		const credentials = store.listAuthCredentials("kagi");
		expect(credentials.map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "first-kagi-key", source: "login" },
			{ type: "api_key", key: "second-kagi-key", source: "login" },
		]);
		const rotatedKeys = [await authStorage.getApiKey("kagi"), await authStorage.getApiKey("kagi")].sort();
		expect(rotatedKeys).toEqual(["first-kagi-key", "second-kagi-key"]);
	});

	it("replaces Token Plan Cookies by API-token identity without collapsing different tokens", () => {
		if (!store) throw new Error("test setup failed");
		const firstToken = "sk-sp-first";
		const secondToken = "sk-sp-second";

		store.upsertAuthCredentialForProvider("alibaba-token-plan", {
			type: "api_key",
			key: serializeAlibabaTokenPlanCredential(firstToken, "session=old"),
			source: "login",
		});
		store.upsertAuthCredentialForProvider("alibaba-token-plan", {
			type: "api_key",
			key: serializeAlibabaTokenPlanCredential(firstToken, "session=fresh"),
			source: "login",
		});
		store.upsertAuthCredentialForProvider("alibaba-token-plan", {
			type: "api_key",
			key: serializeAlibabaTokenPlanCredential(secondToken, "session=second"),
			source: "login",
		});

		expect(store.listAuthCredentials("alibaba-token-plan").map(entry => entry.credential)).toEqual([
			{
				type: "api_key",
				key: serializeAlibabaTokenPlanCredential(firstToken, "session=fresh"),
				source: "login",
			},
			{
				type: "api_key",
				key: serializeAlibabaTokenPlanCredential(secondToken, "session=second"),
				source: "login",
			},
		]);

		store.upsertAuthCredentialForProvider("alibaba-token-plan", {
			type: "api_key",
			key: firstToken,
			source: "login",
		});
		expect(store.listAuthCredentials("alibaba-token-plan").map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: firstToken, source: "login" },
			{
				type: "api_key",
				key: serializeAlibabaTokenPlanCredential(secondToken, "session=second"),
				source: "login",
			},
		]);
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

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "same-ollama-cloud-key",
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

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "same-deepseek-key",
			fetch: async () => Response.json({ object: "list", data: [] }),
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

	it("uses a fresh OpenCode Go login over an existing env fallback", async () => {
		if (!authStorage) throw new Error("test setup failed");

		getEnvApiKeySpy.mockImplementation(provider => (provider === "opencode-go" ? "old-opencode-key" : undefined));

		await authStorage.login("opencode-go", {
			onAuth: () => {},
			onPrompt: async () => "new-opencode-key",
		});

		expect(await authStorage.getApiKey("opencode-go", "session-opencode-go-login")).toBe("new-opencode-key");
		expect(await authStorage.peekApiKey("opencode-go")).toBe("new-opencode-key");
	});
});
