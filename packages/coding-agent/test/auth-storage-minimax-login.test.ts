import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

describe.each(["minimax-code", "minimax-code-cn"] as const)("AuthStorage %s login", provider => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let currentApiKey = "sk-old";

	const fetchMock: FetchImpl = async () =>
		new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
	const loginCallbacks = {
		onAuth: () => {},
		onPrompt: async () => currentApiKey,
		fetch: fetchMock,
	};

	const storedApiKeys = (): string[] =>
		authStorage
			.listStoredCredentials(provider)
			.map(row => (row.credential.type === "api_key" ? row.credential.key : null))
			.filter((key): key is string => key !== null)
			.sort();

	beforeEach(async () => {
		currentApiKey = "sk-old";
		tempDir = path.join(os.tmpdir(), `pi-test-auth-minimax-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("relogin with a different API key keeps both stored keys", async () => {
		await authStorage.login(provider, loginCallbacks);
		currentApiKey = "sk-new";
		await authStorage.login(provider, loginCallbacks);

		expect(storedApiKeys()).toEqual(["sk-new", "sk-old"]);
	});

	test("relogin with the same API key does not duplicate it", async () => {
		await authStorage.login(provider, loginCallbacks);
		await authStorage.login(provider, loginCallbacks);

		expect(storedApiKeys()).toEqual(["sk-old"]);
	});

	test("logout removes an individual stored API key, leaving the rest", async () => {
		await authStorage.login(provider, loginCallbacks);
		currentApiKey = "sk-new";
		await authStorage.login(provider, loginCallbacks);

		const oldRow = authStorage
			.listStoredCredentials(provider)
			.find(row => row.credential.type === "api_key" && row.credential.key === "sk-old");
		if (!oldRow) throw new Error("expected stored sk-old credential");

		const removed = await authStorage.removeCredential(provider, oldRow.id);
		expect(removed).toBe(true);
		expect(storedApiKeys()).toEqual(["sk-new"]);
	});
});
