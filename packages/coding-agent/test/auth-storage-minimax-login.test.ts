import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

describe("AuthStorage MiniMax login", () => {
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
		authStorage.credentials
			.list("minimax-code")
			.map(row => (row.credential.type === "api_key" ? row.credential.key : null))
			.filter((key): key is string => key !== null)
			.sort();

	beforeEach(async () => {
		currentApiKey = "sk-old";
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
	});

	test("relogin with a different API key keeps both stored keys", async () => {
		await authStorage.oauth.login("minimax-code", loginCallbacks);
		currentApiKey = "sk-new";
		await authStorage.oauth.login("minimax-code", loginCallbacks);

		expect(storedApiKeys()).toEqual(["sk-new", "sk-old"]);
	});

	test("relogin with the same API key does not duplicate it", async () => {
		await authStorage.oauth.login("minimax-code", loginCallbacks);
		await authStorage.oauth.login("minimax-code", loginCallbacks);

		expect(storedApiKeys()).toEqual(["sk-old"]);
	});

	test("logout removes an individual stored API key, leaving the rest", async () => {
		await authStorage.oauth.login("minimax-code", loginCallbacks);
		currentApiKey = "sk-new";
		await authStorage.oauth.login("minimax-code", loginCallbacks);

		const oldRow = authStorage.credentials
			.list("minimax-code")
			.find(row => row.credential.type === "api_key" && row.credential.key === "sk-old");
		if (!oldRow) throw new Error("expected stored sk-old credential");

		const removed = await authStorage.credentials.removeById("minimax-code", oldRow.id);
		expect(removed).toBe(true);
		expect(storedApiKeys()).toEqual(["sk-new"]);
	});
});
