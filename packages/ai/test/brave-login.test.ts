import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import * as logger from "../../utils/src/logger";
import { removeWithRetries } from "../../utils/src/temp";

const loginBrave = getProviderDefinition("brave")?.login;
if (!loginBrave) throw new Error("Brave login is not registered");

describe("brave login", () => {
	it("opens Brave API-key settings and returns a trimmed key without validation requests", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const apiKey = await loginBrave({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  BSA-test-key  ";
			},
			fetch: () => {
				throw new Error("Brave login must not make a network request");
			},
		});

		expect(authUrl).toBe("https://api-dashboard.search.brave.com/app/keys");
		expect(authInstructions).toBe("Create or copy your API key from the Brave Search API dashboard.");
		expect(promptMessage).toBe("Paste your Brave API key");
		expect(promptPlaceholder).toBe("API key");
		expect(apiKey).toBe("BSA-test-key");
	});

	it("rejects empty keys", async () => {
		await expect(
			loginBrave({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginBrave({})).rejects.toThrow("Brave login requires onPrompt callback");
	});
});

describe("brave AuthStorage credential source", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let getEnvApiKeySpy: Mock<typeof aiStream.getEnvApiKey>;
	const logCalls: string[] = [];

	function captureLog(level: string) {
		return (message: unknown, extra?: unknown) => {
			logCalls.push(`${level}:${typeof message === "string" ? message : JSON.stringify(message)}`);
			if (extra !== undefined) logCalls.push(`${level}-extra:${JSON.stringify(extra)}`);
		};
	}

	beforeEach(async () => {
		logCalls.length = 0;
		vi.spyOn(logger, "debug").mockImplementation(captureLog("debug") as typeof logger.debug);
		vi.spyOn(logger, "info").mockImplementation(captureLog("info") as typeof logger.info);
		vi.spyOn(logger, "warn").mockImplementation(captureLog("warn") as typeof logger.warn);
		vi.spyOn(logger, "error").mockImplementation(captureLog("error") as typeof logger.error);
		getEnvApiKeySpy = vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-brave-auth-"));
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

	it("prefers a login-stored brave key over BRAVE_API_KEY env fallback", async () => {
		if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

		getEnvApiKeySpy.mockImplementation(provider => (provider === "brave" ? "env-brave-key" : undefined));

		await authStorage.login("brave", {
			onAuth: () => {},
			onPrompt: async () => "stored-brave-key",
		});

		expect(await authStorage.getApiKey("brave", "session-brave-db-first")).toBe("stored-brave-key");
		expect(authStorage.describeCredentialSource("brave", "session-brave-db-first")).toContain("api_key");
		expect(authStorage.describeCredentialSource("brave", "session-brave-db-first")).not.toContain("env");

		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db
				.prepare("SELECT provider, credential_type FROM auth_credentials WHERE provider = ?")
				.get("brave") as { provider?: string; credential_type?: string } | undefined;
			expect(row).toEqual({ provider: "brave", credential_type: "api_key" });
		} finally {
			db.close();
		}
	});

	it("falls back to BRAVE_API_KEY when no stored brave credential exists", async () => {
		if (!authStorage) throw new Error("test setup failed");

		getEnvApiKeySpy.mockImplementation(provider => (provider === "brave" ? "env-brave-only" : undefined));

		expect(await authStorage.getApiKey("brave", "session-brave-env")).toBe("env-brave-only");
		expect(authStorage.describeCredentialSource("brave")).toContain("env");
	});

	it("fails closed when brave has neither stored credential nor env key", async () => {
		if (!authStorage) throw new Error("test setup failed");

		expect(await authStorage.getApiKey("brave", "session-brave-missing")).toBeUndefined();
		expect(authStorage.hasAuth("brave")).toBe(false);
		expect(authStorage.describeCredentialSource("brave")).toBeUndefined();
	});

	it("does not leak the stored brave key through logs or credential-source text", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const secret = "BSA-secret-do-not-leak-xyz";
		await authStorage.login("brave", {
			onAuth: () => {},
			onPrompt: async () => secret,
		});

		const source = authStorage.describeCredentialSource("brave", "session-brave-noleak");
		expect(source).toBeDefined();
		expect(source).not.toContain(secret);
		expect(logCalls.join("\n")).not.toContain(secret);
	});
});
