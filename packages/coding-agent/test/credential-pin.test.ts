import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { credentialPinHash, recordCredentialPin, seedCredentialPins } from "../src/session/credential-pin";
import { SessionManager } from "../src/session/session-manager";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, extra?: { orgId?: string }) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		...extra,
	};
}

function assistantMessage(provider: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "hi" }],
		api: "anthropic-messages",
		provider,
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

describe("credential pins", () => {
	let tempDir: TempDir;
	let storage: AuthStorage;

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = TempDir.createSync("@pi-credential-pin-");
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		store.saveOAuth("anthropic", mintOAuthCredential("b"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(() => {
		for (const key of ANTHROPIC_ENV) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		tempDir[Symbol.dispose]();
	});

	test("pin entries survive a session reload and the latest pin per provider wins", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		manager.appendCredentialPin("anthropic", "hash-old");
		manager.appendCredentialPin("openai-codex", "hash-codex");
		manager.appendCredentialPin("anthropic", "hash-new");
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		const reopened = await SessionManager.open(file);
		const pins = reopened.getCredentialPins();
		expect(pins.get("anthropic")?.hash).toBe("hash-new");
		expect(pins.get("openai-codex")?.hash).toBe("hash-codex");
	});

	test("later assistant turns advance the pin's effective last-use; other providers and new pins do not", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const pinId = manager.appendCredentialPin("anthropic", "hash-a");
		const pinnedAt = new Date(manager.getEntry(pinId)!.timestamp).getTime();

		// Long session on one account: no new pin entries, only assistant turns.
		const lastTurnAt = pinnedAt + 3 * 60 * 60 * 1000;
		manager.appendMessage(assistantMessage("anthropic", pinnedAt + 60_000));
		manager.appendMessage(assistantMessage("anthropic", lastTurnAt));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// A different provider's turn never advances this provider's pin.
		manager.appendMessage(assistantMessage("openai-codex", lastTurnAt + 60_000));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// An account change re-bases last-use at the new pin.
		const newPinId = manager.appendCredentialPin("anthropic", "hash-b");
		const newPinnedAt = new Date(manager.getEntry(newPinId)!.timestamp).getTime();
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(newPinnedAt);
	});

	test("seeding re-pins the recorded account in a store with no session stickiness", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		manager.appendCredentialPin("anthropic", hash);

		// Fresh process: no sticky exists yet (the broker-mode resume scenario).
		expect(storage.listOAuthAccounts("anthropic", sessionId).some(account => account.active)).toBe(false);

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
	});

	test("pins are org-scoped: the same account in two orgs re-pins the matching org credential", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-1" }));
		store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-2" }));
		const orgStorage = new AuthStorage(store);
		await orgStorage.reload();

		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const identity = { accountId: "account-x", email: "x@example.com" };
		const orgTwoHash = credentialPinHash("anthropic", { ...identity, orgId: "org-2" });
		if (!orgTwoHash) throw new Error("expected a pin hash");
		expect(orgTwoHash).not.toBe(credentialPinHash("anthropic", { ...identity, orgId: "org-1" }));
		manager.appendCredentialPin("anthropic", orgTwoHash);

		seedCredentialPins(orgStorage, manager, sessionId);

		const active = orgStorage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.orgId).toBe("org-2");
	});

	test("an explicit pin is persisted as pinned and replayed as a user pin under fixed selection", async () => {
		// Regression: `/session pin` is recorded like automatic routing, so a broker
		// resume replays it as a restore and fixed selection snaps back to account a.
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		const accountB = storage
			.listOAuthAccounts("anthropic", sessionId)
			.find(account => account.accountId === "account-b");
		expect(storage.pinSessionOAuthAccount("anthropic", sessionId, accountB!.credentialId)).toBe(true);
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		expect(manager.getCredentialPins().get("anthropic")?.pinned).toBe(true);
		await manager.flush();

		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a session file");
		const reopened = await SessionManager.open(file);
		expect(reopened.getCredentialPins().get("anthropic")?.pinned).toBe(true);

		// Fresh process with fixed selection and no sticky (broker-mode resume).
		const freshStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		freshStore.saveOAuth("anthropic", mintOAuthCredential("a"));
		freshStore.saveOAuth("anthropic", mintOAuthCredential("b"));
		const fixedStorage = new AuthStorage(freshStore, { accountSelection: "fixed" });
		await fixedStorage.reload();
		seedCredentialPins(fixedStorage, reopened, sessionId);

		// Replayed as a user pin: fixed selection keeps honouring it (pi-ai's
		// account-selection tests cover the resolve semantics of a user pin).
		expect(fixedStorage.listOAuthAccounts("anthropic", sessionId).find(account => account.active)?.accountId).toBe(
			"account-b",
		);
		expect(fixedStorage.isSessionOAuthAccountPinned("anthropic", sessionId)).toBe(true);
	});

	test("an automatic pin is replayed as a restore and yields to fixed selection", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		expect(manager.getCredentialPins().get("anthropic")?.pinned).toBe(false);

		const freshStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		freshStore.saveOAuth("anthropic", mintOAuthCredential("a"));
		freshStore.saveOAuth("anthropic", mintOAuthCredential("b"));
		const fixedStorage = new AuthStorage(freshStore, { accountSelection: "fixed" });
		await fixedStorage.reload();
		seedCredentialPins(fixedStorage, manager, sessionId);

		// Replayed as a restore: the sticky exists for warm-cache reuse under
		// balanced, but fixed selection may route back to the first account.
		expect(fixedStorage.listOAuthAccounts("anthropic", sessionId).find(account => account.active)?.accountId).toBe(
			"account-b",
		);
		expect(fixedStorage.isSessionOAuthAccountPinned("anthropic", sessionId)).toBe(false);
	});

	test("seeding never clobbers a live sticky from the same process", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.listOAuthAccounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		expect(storage.pinSessionOAuthAccount("anthropic", sessionId, accountA!.credentialId)).toBe(true);

		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		seedCredentialPins(storage, manager, sessionId);

		const active = storage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-a");
	});

	test("seeding is a no-op when the pinned account is no longer stored", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" });
		manager.appendCredentialPin("anthropic", hash!);

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.listOAuthAccounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});

	test("recording appends the serving account's hash once and dedupes repeats", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.listOAuthAccounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		storage.pinSessionOAuthAccount("anthropic", sessionId, accountA!.credentialId);

		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");

		const entries = manager.getBranch().filter(entry => entry.type === "credential_pin");
		expect(entries).toHaveLength(1);
		const identity = storage.getOAuthAccountIdentity("anthropic", sessionId);
		expect(manager.getCredentialPins().get("anthropic")?.hash).toBe(credentialPinHash("anthropic", identity!));
	});
});
