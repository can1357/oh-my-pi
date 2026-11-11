import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as registry from "@oh-my-pi/pi-ai/registry";
import type { OAuthCredentials, OAuthPrompt } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { removeWithRetries } from "../../utils/src/temp";

// The real auth rules give google-antigravity a `login-warning`.
const PROVIDER = "google-antigravity";

describe("a provider whose login carries an account risk", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let auth: AuthStorage;
	let providerLogin: Mock<() => Promise<OAuthCredentials>>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-login-warning-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
		providerLogin = vi.fn(async () => ({ access: "acc", refresh: "ref", expires: Date.now() + 3_600_000 }));
		const original = registry.getProviderDefinition;
		vi.spyOn(registry, "getProviderDefinition").mockImplementation(id => {
			const def = original(id);
			return id === PROVIDER && def ? { ...def, login: providerLogin } : def;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		await removeWithRetries(tempDir);
	});

	const login = (answer: string) => {
		const prompts: OAuthPrompt[] = [];
		const result = auth.oauth.login(PROVIDER, {
			onAuth: () => {},
			onPrompt: async prompt => {
				prompts.push(prompt);
				return answer;
			},
		});
		return { prompts, result };
	};

	test("any answer but yes cancels before the provider flow starts and stores nothing", async () => {
		const { prompts, result } = login("y");
		await expect(result).rejects.toBeInstanceOf(AIError.LoginCancelledError);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toContain("own risk");
		expect(providerLogin).not.toHaveBeenCalled();
		expect(auth.credentials.list(PROVIDER)).toEqual([]);
	});

	test("typing yes runs the provider flow and stores the login", async () => {
		const { result } = login(" YES ");
		await result;
		expect(providerLogin).toHaveBeenCalledTimes(1);
		expect(auth.credentials.list(PROVIDER)).toHaveLength(1);
	});
});
