import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { modelAccountPolicyBlockScope } from "@oh-my-pi/pi-ai/auth/blocks";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";
const PROVIDER_KEY = "anthropic:oauth";
const OTHER_PROVIDER = "openai-codex";
const MODEL_ID = "claude-sonnet-4-5";
const FUTURE_BLOCK_MS = 1_899_999_999_000;

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
	};
}

describe("AuthStorage limits.hasAvailableCredential", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let ids: number[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-available-credential-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		await store.saveOAuth(PROVIDER, oauthCredential("a"));
		await store.saveOAuth(PROVIDER, oauthCredential("b"));
		await store.saveOAuth(OTHER_PROVIDER, oauthCredential("c"));
		ids = store.listAuthCredentials(PROVIDER).map(row => row.id);
		storage = new AuthStorage(store);
		await storage.credentials.reload();
	});

	afterEach(async () => {
		storage?.close();
		storage = undefined;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	function block(credentialId: number, blockScope = ""): void {
		storage!.blocks.upsert({ credentialId, providerKey: PROVIDER_KEY, blockScope, blockedUntilMs: FUTURE_BLOCK_MS });
	}

	it("turns true once one account of the provider is unblocked again", async () => {
		block(ids[0]!);
		block(ids[1]!);
		// The other provider's healthy account does not make this one available.
		expect(await storage!.limits.hasAvailableCredential(PROVIDER, undefined, "oauth", MODEL_ID)).toBe(false);

		// A live report healed account B: its block is cleared.
		storage!.blocks.delete(ids[1]!, PROVIDER_KEY, "");
		expect(await storage!.limits.hasAvailableCredential(PROVIDER, undefined, "oauth", MODEL_ID)).toBe(true);
	});

	it("does not count an account the provider refuses this model", async () => {
		block(ids[0]!);
		block(ids[1]!, modelAccountPolicyBlockScope(MODEL_ID));
		expect(await storage!.limits.hasAvailableCredential(PROVIDER, undefined, "oauth", MODEL_ID)).toBe(false);
	});

	it("does not count a stored API key toward the limited OAuth accounts", async () => {
		// Kept beside the OAuth rows (saveApiKey would replace them).
		await store!.upsertAuthCredential(PROVIDER, { type: "api_key", key: "per-token-key" });
		await storage!.credentials.reload();
		expect(
			store!
				.listAuthCredentials(PROVIDER)
				.map(row => row.credential.type)
				.sort(),
		).toEqual(["api_key", "oauth", "oauth"]);
		block(ids[0]!);
		block(ids[1]!);
		expect(await storage!.limits.hasAvailableCredential(PROVIDER, undefined, "oauth", MODEL_ID)).toBe(false);
		expect(await storage!.limits.hasAvailableCredential(PROVIDER, undefined, "api_key", MODEL_ID)).toBe(true);
	});

	it("is false for a provider with no stored credential", async () => {
		expect(await storage!.limits.hasAvailableCredential("google", undefined, "oauth", "gemini-3.5-flash")).toBe(
			false,
		);
	});
});
