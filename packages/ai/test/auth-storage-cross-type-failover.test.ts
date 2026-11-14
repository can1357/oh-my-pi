import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { CredentialRankingStrategy } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-cross-type-failover";
const SOURCE = "auth-storage-cross-type-failover-test";

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

/** ZAI writes usage-limit blocks under `credits`, not an unscoped row. */
const creditsStrategy: CredentialRankingStrategy = {
	blockScope: () => "credits",
	findWindowLimits: () => ({}),
	windowDefaults: { primaryMs: 5 * 60 * 60_000, secondaryMs: 7 * 24 * 60 * 60_000 },
};

function usageLimitError(): Error & { status: number } {
	return Object.assign(
		new Error("429 Usage limit reached for 5 hour. Your limit will reset at 2026-11-14 06:25:37 (type=1308)"),
		{ status: 429 },
	);
}

describe("oauth usage-limit falls through to a login api_key", () => {
	let tempDir = "";
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE);
		authStorage?.close();
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function openStorage(): Promise<AuthStorage> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-cross-type-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		registerOAuthProvider({
			id: PROVIDER,
			name: "Cross Type",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: farExpiry() };
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		authStorage = new AuthStorage(store, {
			rankingStrategyResolver: provider => (provider === PROVIDER ? creditsStrategy : undefined),
		});
		return authStorage;
	}

	test("a credits-scoped oauth block yields to the login key and reports a sibling", async () => {
		const storage = await openStorage();
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "oauth-a", refresh: "ref-a", expires: farExpiry() },
			{ type: "api_key", key: "login-key", source: "login" },
		]);
		const sessionId = "cross-type";
		expect(await storage.keys.get(PROVIDER, sessionId)).toBe("oauth-a");

		const marked = await storage.limits.rotate(PROVIDER, sessionId, { error: usageLimitError() });
		expect(marked.switched).toBe(true);
		expect(await storage.keys.get(PROVIDER, sessionId)).toBe("login-key");
	});

	test("a healthy oauth sibling still wins over the login key", async () => {
		const storage = await openStorage();
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "oauth-a", refresh: "ref-a", expires: farExpiry() },
			{ type: "oauth", access: "oauth-b", refresh: "ref-b", expires: farExpiry() },
			{ type: "api_key", key: "login-key", source: "login" },
		]);
		const sessionId = "same-type-first";
		const first = await storage.keys.get(PROVIDER, sessionId);
		expect(first === "oauth-a" || first === "oauth-b").toBe(true);

		const marked = await storage.limits.rotate(PROVIDER, sessionId, { error: usageLimitError() });
		expect(marked.switched).toBe(true);
		const next = await storage.keys.get(PROVIDER, sessionId);
		expect(next).not.toBe(first);
		expect(next).not.toBe("login-key");
	});

	test("a stored api_key that was not signed in via login is not a sibling", async () => {
		const storage = await openStorage();
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "oauth-a", refresh: "ref-a", expires: farExpiry() },
			{ type: "api_key", key: "stale-broker-key" },
		]);
		const sessionId = "not-a-login-key";
		expect(await storage.keys.get(PROVIDER, sessionId)).toBe("oauth-a");

		const marked = await storage.limits.rotate(PROVIDER, sessionId, { error: usageLimitError() });
		expect(marked.switched).toBe(false);
		expect(await storage.keys.get(PROVIDER, sessionId)).toBe("oauth-a");
	});
});
