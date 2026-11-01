import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
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
		await store.saveOAuth("anthropic", mintOAuthCredential("a"));
		await store.saveOAuth("anthropic", mintOAuthCredential("b"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
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
		expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
	});
	test("restores a persisted strict account lock", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		manager.appendCredentialPin("anthropic", hash, "strict");

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.sessions.mode("anthropic", sessionId)).toBe("strict");
		expect(storage.oauth.accounts("anthropic", sessionId).find(account => account.active)?.accountId).toBe(
			"account-b",
		);
	});

	test("inherited strict mode survives a newer same-account affinity journal and is recorded", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const account = storage.oauth.accounts("anthropic", sessionId).find(item => item.accountId === "account-b")!;
		const hash = credentialPinHash("anthropic", account)!;
		manager.appendCredentialPin("anthropic", hash);
		const recordedAt = manager.getCredentialPins().get("anthropic")!.lastUsedAt;
		storage.sessions.pin("anthropic", sessionId, account.credentialId, {
			restoredAtMs: recordedAt - 60_000,
			strict: true,
		});

		seedCredentialPins(storage, manager, sessionId);
		expect(storage.sessions.mode("anthropic", sessionId)).toBe("strict");
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		expect(manager.getCredentialPins().get("anthropic")?.mode).toBe("strict");
		expect(manager.getBranch().filter(entry => entry.type === "credential_pin")).toHaveLength(2);
	});

	test("an inherited strict account overrides the revived child's automatic opt-out", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		manager.appendCredentialPin("anthropic", undefined, "automatic");
		const account = storage.oauth.accounts("anthropic", sessionId).find(item => item.accountId === "account-a")!;
		storage.sessions.pin("anthropic", "parent-strict", account.credentialId, { strict: true });
		const ownPins = manager.getCredentialPins();
		storage.sessions.inherit("parent-strict", sessionId, (provider, explicit) => explicit || !ownPins.has(provider));

		seedCredentialPins(storage, manager, sessionId);
		expect(storage.sessions.mode("anthropic", sessionId)).toBe("strict");
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		expect(manager.getCredentialPins().get("anthropic")?.mode).toBe("strict");
		expect(manager.getCredentialPins().get("anthropic")?.hash).toBe(credentialPinHash("anthropic", account));
	});

	test("a revived child's recorded account wins over the parent's automatic affinity", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.oauth.accounts("anthropic", sessionId);
		const parentAccount = accounts.find(item => item.accountId === "account-a")!;
		const childAccount = accounts.find(item => item.accountId === "account-b")!;
		manager.appendCredentialPin("anthropic", credentialPinHash("anthropic", childAccount)!);
		storage.sessions.pin("anthropic", "parent-affinity", parentAccount.credentialId, { restoredAtMs: Date.now() });
		const ownPins = manager.getCredentialPins();
		storage.sessions.inherit("parent-affinity", sessionId, (provider, explicit) => explicit || !ownPins.has(provider));

		seedCredentialPins(storage, manager, sessionId);
		expect(storage.sessions.mode("anthropic", sessionId)).toBe("affinity");
		expect(storage.oauth.accounts("anthropic", sessionId).find(item => item.active)?.accountId).toBe("account-b");
	});

	test("an automatic opt-out restores without being replaced by serving-account records", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		manager.appendCredentialPin("anthropic", undefined, "automatic");

		seedCredentialPins(storage, manager, sessionId);
		expect(storage.sessions.mode("anthropic", sessionId)).toBe("automatic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		expect(manager.getCredentialPins().get("anthropic")?.mode).toBe("automatic");
		expect(manager.getBranch().filter(entry => entry.type === "credential_pin")).toHaveLength(1);
	});

	test("pins are org-scoped: the same account in two orgs re-pins the matching org credential", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		await store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-1" }));
		await store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-2" }));
		const orgStorage = new AuthStorage(store);
		await orgStorage.credentials.reload();

		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const identity = { accountId: "account-x", email: "x@example.com" };
		const orgTwoHash = credentialPinHash("anthropic", { ...identity, orgId: "org-2" });
		if (!orgTwoHash) throw new Error("expected a pin hash");
		expect(orgTwoHash).not.toBe(credentialPinHash("anthropic", { ...identity, orgId: "org-1" }));
		manager.appendCredentialPin("anthropic", orgTwoHash);

		seedCredentialPins(orgStorage, manager, sessionId);

		const active = orgStorage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.orgId).toBe("org-2");
	});

	test("seeding never clobbers a live sticky from the same process", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.oauth.accounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		expect(storage.sessions.pin("anthropic", sessionId, accountA!.credentialId)).toBe(true);

		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-a");
	});

	test("seeding advances a same-account sticky that is older than the session-file pin", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		const pinLastUsedAt = manager.getCredentialPins().get("anthropic")!.lastUsedAt;
		const accountB = storage.oauth
			.accounts("anthropic", sessionId)
			.find(account => account.accountId === "account-b");
		// A lazily-persisted sticky for the same account, older than the session's last turn.
		storage.sessions.pin("anthropic", sessionId, accountB!.credentialId, { restoredAtMs: pinLastUsedAt - 600_000 });

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.oauth.accounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
		expect(active?.lastUsedAtMs).toBe(pinLastUsedAt);
	});

	test("seeding never rewinds a same-account sticky that is newer than the pin", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		const newerUse = manager.getCredentialPins().get("anthropic")!.lastUsedAt + 60_000;
		const accountB = storage.oauth
			.accounts("anthropic", sessionId)
			.find(account => account.accountId === "account-b");
		storage.sessions.pin("anthropic", sessionId, accountB!.credentialId, { restoredAtMs: newerUse });

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.oauth.accounts("anthropic", sessionId).find(account => account.active)?.lastUsedAtMs).toBe(
			newerUse,
		);
	});

	test("seeding is a no-op when the pinned account is no longer stored", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" });
		manager.appendCredentialPin("anthropic", hash!);

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});

	test.each([undefined, "strict"] as const)("unavailable strict pins fail restoration in mode %s", restoreMode => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" })!;
		manager.appendCredentialPin("anthropic", hash, "strict");

		expect(() => seedCredentialPins(storage, manager, sessionId, restoreMode)).toThrow(Error);
		expect(storage.sessions.mode("anthropic", sessionId)).toBe("affinity");
		expect(storage.oauth.accounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});

	test("strict adoption fails before configured defaults choose a sibling and reports no account identity", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" })!;
		manager.appendCredentialPin("anthropic", hash, "strict");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		let requests = 0;
		const agent = new Agent({
			getApiKey: () => {
				requests++;
				return "unused-key";
			},
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		let failure: unknown;
		expect(() => {
			try {
				new AgentSession({
					agent,
					sessionManager: manager,
					modelRegistry: new ModelRegistry(storage),
					settings: Settings.isolated({ "auth.defaultAccounts": { anthropic: "a" } }),
				});
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow(Error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("anthropic");
		expect((failure as Error).message).not.toContain(hash);
		expect((failure as Error).message).not.toContain("account-gone");
		expect(requests).toBe(0);
		expect(storage.oauth.accounts("anthropic", manager.getSessionId()).some(account => account.active)).toBe(false);
	});

	test("a strict journal overrides a live non-explicit sibling affinity", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.oauth.accounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a")!;
		const accountB = accounts.find(account => account.accountId === "account-b")!;
		manager.appendCredentialPin("anthropic", credentialPinHash("anthropic", accountB)!, "strict");
		storage.sessions.pin("anthropic", sessionId, accountA.credentialId, { restoredAtMs: Date.now() });

		seedCredentialPins(storage, manager, sessionId);
		expect(storage.sessions.mode("anthropic", sessionId)).toBe("strict");
		expect(storage.oauth.accounts("anthropic", sessionId).find(account => account.active)?.accountId).toBe("account-b");
	});

	test("configured sibling defaults never replace an unavailable live strict lock", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const account = storage.oauth.accounts("anthropic", sessionId).find(item => item.accountId === "account-b")!;
		expect(storage.sessions.pin("anthropic", sessionId, account.credentialId, { strict: true })).toBe(true);
		expect(await storage.credentials.removeById("anthropic", account.credentialId)).toBe(true);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const registry = new ModelRegistry(storage);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "unused-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: manager,
			modelRegistry: registry,
			settings: Settings.isolated({ "auth.defaultAccounts": { anthropic: "a" } }),
		});
		try {
			expect(storage.sessions.mode("anthropic", sessionId)).toBe("strict");
			expect(storage.oauth.accounts("anthropic", sessionId).some(item => item.active)).toBe(false);
			expect(await registry.getApiKey(model, sessionId)).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("recording appends the serving account's hash once and dedupes repeats", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.oauth.accounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		storage.sessions.pin("anthropic", sessionId, accountA!.credentialId);

		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");

		const entries = manager.getBranch().filter(entry => entry.type === "credential_pin");
		expect(entries).toHaveLength(1);
		const identity = storage.oauth.identity("anthropic", sessionId);
		expect(manager.getCredentialPins().get("anthropic")?.hash).toBe(credentialPinHash("anthropic", identity!));
	});

	test("auth.defaultAccounts seeds a strict pin on session adoption", () => {
		// Simulate what #seedDefaultCredentialPins does: find the account matching
		// the configured selector, pin it strictly, and journal the entry.
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const selector = "b";

		const accounts = storage.oauth.accounts("anthropic", sessionId);
		expect(accounts).toHaveLength(2);
		expect(accounts.some(a => a.active)).toBe(false);

		const matches = accounts.filter(account => {
			const email = account.email?.trim().toLowerCase();
			return (
				email === selector ||
				email?.split("@", 1)[0]?.startsWith(selector) === true ||
				account.accountId?.trim().toLowerCase() === selector
			);
		});
		expect(matches).toHaveLength(1);
		const account = matches[0]!;
		expect(storage.sessions.pin("anthropic", sessionId, account.credentialId, { strict: true })).toBe(true);
		const hash = credentialPinHash("anthropic", account);
		if (hash) manager.appendCredentialPin("anthropic", hash, "strict");

		// Verify: the session is strict-pinned to account-b, and a journal entry
		// with mode "strict" was written.
		expect(storage.sessions.mode("anthropic", sessionId)).toBe("strict");
		expect(storage.oauth.accounts("anthropic", sessionId).find(a => a.active)?.accountId).toBe("account-b");
		const pins = manager.getCredentialPins();
		expect(pins.get("anthropic")?.mode).toBe("strict");

		// Verify the pin survives a fresh-provider-ID restore (the /fresh path):
		// strict entries must be carried forward.
		const freshSid = `fresh-${sessionId}`;
		const strictPins = [...pins.entries()].filter(([, p]) => p.mode === "strict");
		expect(strictPins).toHaveLength(1);
		const freshMatch = storage.oauth
			.accounts("anthropic", freshSid)
			.find(a => credentialPinHash("anthropic", a) === strictPins[0]![1].hash);
		expect(freshMatch?.accountId).toBe("account-b");
	});
});
