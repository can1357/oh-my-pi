import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { complete } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	getOAuthProviders,
	refreshOAuthToken,
	registerOAuthProvider,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";
const REASON = "paused for now";

describe("a provider disabled in its auth rules", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let auth: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-provider-disabled-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
		await auth.credentials.set(PROVIDER, [{ type: "api_key", key: "sk-stored" }]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		await removeWithRetries(tempDir);
	});

	const disable = () =>
		vi
			.spyOn(compatAuth, "providerDisabledReason")
			.mockImplementation(provider => (provider === PROVIDER ? REASON : undefined));

	test("resolves no key from stored, runtime or config sources, and comes back untouched when re-enabled", async () => {
		const spy = disable();
		auth.keys.setRuntime(PROVIDER, "sk-runtime");
		await auth.credentials.reload();
		expect(auth.keys.source(PROVIDER)).toBeUndefined();
		expect(await auth.keys.get(PROVIDER)).toBeUndefined();
		expect(await auth.keys.peek(PROVIDER)).toBeUndefined();
		expect(auth.credentials.list(PROVIDER)).toEqual([]);
		await expect(auth.keys.getWithCredential(PROVIDER)).rejects.toBeInstanceOf(AIError.ProviderDisabledError);

		spy.mockRestore();
		auth.keys.removeRuntime(PROVIDER);
		await auth.credentials.reload();
		expect(await auth.keys.get(PROVIDER)).toBe("sk-stored");
	});

	test("refuses a request even when the caller passes a key, naming the reason", async () => {
		disable();
		const model = getBundledModel(PROVIDER, "claude-haiku-4-5");
		const outcome = await complete(model, { messages: [] }, { apiKey: "sk-direct" }).then(
			message => message.errorMessage,
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		expect(outcome).toContain(REASON);
	});

	test("refuses to start a login", async () => {
		disable();
		await expect(
			auth.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "", onProgress: () => {} }),
		).rejects.toBeInstanceOf(AIError.ProviderDisabledError);
	});

	test("never probes usage, even through a runtime usage provider with its own key", async () => {
		disable();
		const fetchUsage = vi.fn(async () => null);
		auth.usage.setProvider(PROVIDER, { id: PROVIDER, fetchUsage }, "sk-ext");
		await auth.usage.reports({ provider: PROVIDER });
		expect(fetchUsage).not.toHaveBeenCalled();
	});

	test("never starts a token exchange for an old credential", async () => {
		disable();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(
			refreshOAuthToken(PROVIDER, { access: "old", refresh: "old-refresh", expires: 0 }),
		).rejects.toBeInstanceOf(AIError.ProviderDisabledError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("an extension that registers its own login under the paused id takes it back", async () => {
		disable();
		registerOAuthProvider({
			id: PROVIDER,
			name: "Extension login",
			sourceId: "provider-disabled-test",
			login: async () => "",
		});
		try {
			await auth.credentials.reload();
			expect(getOAuthProviders().some(provider => provider.name === "Extension login")).toBe(true);
			expect(await auth.keys.get(PROVIDER)).toBe("sk-stored");
		} finally {
			unregisterOAuthProviders("provider-disabled-test");
		}
	});
});
