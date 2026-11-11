import * as path from "node:path";
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
	let store: SqliteAuthCredentialStore;

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = TempDir.createSync("@pi-credential-pin-");
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
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

	test.each([false, true])("unavailable strict pins fail restoration (explicit only: %s)", explicitOnly => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" })!;
		manager.appendCredentialPin("anthropic", hash, "strict");

		expect(() => seedCredentialPins(storage, manager, sessionId, explicitOnly)).toThrow(Error);
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

	function createAnthropicSession(
		manager: SessionManager,
		registry: ModelRegistry,
		settings: Settings = Settings.isolated({}),
	): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "unused-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: manager,
			modelRegistry: registry,
			settings,
		});
	}

	test("/fresh keeps a strict lock on a removed account instead of routing to a sibling", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const registry = new ModelRegistry(storage, path.join(tempDir.path(), "models.yml"));
		const session = createAnthropicSession(manager, registry);
		try {
			const accountB = storage.oauth
				.accounts("anthropic", session.sessionId)
				.find(account => account.accountId === "account-b");
			if (!accountB) throw new Error("expected account b");
			expect(session.pinCurrentProviderOAuthAccount(accountB.credentialId, { strict: true })).toEqual({
				persisted: true,
			});
			expect(await storage.credentials.removeById("anthropic", accountB.credentialId)).toBe(true);

			const fresh = session.freshSession();
			expect(fresh?.sessionId).not.toBe(fresh?.previousSessionId);
			expect(storage.sessions.mode("anthropic", session.sessionId)).toBe("strict");
			expect(await registry.getApiKey(session.model!, session.sessionId)).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("a non-strict pin replaces a saved strict lock before the next turn", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const session = createAnthropicSession(manager, new ModelRegistry(storage, path.join(tempDir.path(), "models.yml")));
		try {
			const accounts = storage.oauth.accounts("anthropic", session.sessionId);
			const accountA = accounts.find(account => account.accountId === "account-a")!;
			const accountB = accounts.find(account => account.accountId === "account-b")!;
			expect(session.pinCurrentProviderOAuthAccount(accountA.credentialId, { strict: true })).toBeTruthy();
			expect(session.pinCurrentProviderOAuthAccount(accountB.credentialId)).toBeTruthy();

			// A resume before any turn restores B without the replaced lock on A.
			const resumed = new AuthStorage(store);
			await resumed.credentials.reload();
			seedCredentialPins(resumed, manager, "resumed-provider-session");
			expect(resumed.sessions.mode("anthropic", "resumed-provider-session")).not.toBe("strict");
			expect(
				resumed.oauth.accounts("anthropic", "resumed-provider-session").find(account => account.active)?.accountId,
			).toBe("account-b");
		} finally {
			await session.dispose();
		}
	});

	test("a strict lock on an account without identity is session-only but survives /fresh", async () => {
		await store.saveOAuth("anthropic", {
			access: "access-anonymous",
			refresh: "refresh-anonymous",
			expires: Date.now() + 60_000,
		});
		await storage.credentials.reload();
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const registry = new ModelRegistry(storage, path.join(tempDir.path(), "models.yml"));
		const session = createAnthropicSession(manager, registry);
		try {
			const anonymous = storage.oauth
				.accounts("anthropic", session.sessionId)
				.find(account => !account.accountId && !account.email);
			if (!anonymous) throw new Error("expected an account without identity");
			expect(session.pinCurrentProviderOAuthAccount(anonymous.credentialId, { strict: true })).toEqual({
				persisted: false,
			});
			expect(manager.getCredentialPins().has("anthropic")).toBe(false);
			session.freshSession();
			expect(storage.sessions.mode("anthropic", session.sessionId)).toBe("strict");
		} finally {
			await session.dispose();
		}
	});

	test("automatic routing outlives /fresh and resume despite a configured default account", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const settings = Settings.isolated({ "auth.defaultAccounts": { anthropic: "b" } });
		const createSession = (authStorage: AuthStorage, sessionManager: SessionManager) =>
			new AgentSession({
				agent: new Agent({
					getApiKey: () => "unused-key",
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				}),
				sessionManager,
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				settings,
			});
		const session = createSession(storage, manager);
		try {
			expect(storage.sessions.mode("anthropic", session.sessionId)).toBe("strict");
			expect(session.useAutomaticProviderAccountRouting()).toBe(true);
			expect(storage.sessions.mode("anthropic", session.sessionId)).toBe("automatic");

			// `/fresh` mints a provider session id; the default must not re-lock it.
			const fresh = session.freshSession();
			expect(fresh).toBeDefined();
			expect(storage.sessions.mode("anthropic", session.sessionId)).toBe("automatic");
			await manager.flush();
		} finally {
			await session.dispose();
		}

		// A new process has no live routing state; only the reopened journal carries the opt-out.
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		const resumedStorage = new AuthStorage(store);
		await resumedStorage.credentials.reload();
		const resumed = createSession(resumedStorage, await SessionManager.open(file));
		try {
			expect(resumedStorage.sessions.mode("anthropic", resumed.sessionId)).toBe("automatic");
		} finally {
			await resumed.dispose();
		}
	});

	test.each([
		["a strict lock on another account", "strict"],
		["automatic routing", "automatic"],
	] as const)("%s chosen after /fresh survives resume despite a configured default account", async (_label, choice) => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		const settings = Settings.isolated({ "auth.defaultAccounts": { anthropic: "b" } });
		const modelsPath = path.join(tempDir.path(), "models.yml");
		const session = createAnthropicSession(manager, new ModelRegistry(storage, modelsPath), settings);
		try {
			expect(storage.sessions.mode("anthropic", session.sessionId)).toBe("strict");
			session.freshSession();
			if (choice === "strict") {
				const accountA = storage.oauth
					.accounts("anthropic", session.sessionId)
					.find(account => account.accountId === "account-a")!;
				expect(session.pinCurrentProviderOAuthAccount(accountA.credentialId, { strict: true })).toEqual({
					persisted: true,
				});
			} else {
				expect(session.useAutomaticProviderAccountRouting()).toBe(true);
			}
			await manager.flush();
		} finally {
			await session.dispose();
		}

		// A new process resumes on the transcript's own provider id, whose persisted
		// affinity row predates the choice made on the rotated `/fresh` id.
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		const resumedStorage = new AuthStorage(store);
		await resumedStorage.credentials.reload();
		const resumed = createAnthropicSession(
			await SessionManager.open(file),
			new ModelRegistry(resumedStorage, modelsPath),
			settings,
		);
		try {
			const sessionId = resumed.sessionId;
			expect(resumedStorage.sessions.mode("anthropic", sessionId)).toBe(choice);
			const active = resumedStorage.oauth.accounts("anthropic", sessionId).find(account => account.active);
			expect(active?.accountId).toBe(choice === "strict" ? "account-a" : undefined);
		} finally {
			await resumed.dispose();
		}
	});

	test("an unmatched configured default warns without the selector and leaves routing automatic", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const selector = "nobody@corp.example";
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "unused-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: manager,
			modelRegistry: new ModelRegistry(storage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated({ "auth.defaultAccounts": { anthropic: selector } }),
		});
		try {
			const warnings = session.configWarnings.filter(warning => warning.startsWith("auth.defaultAccounts.anthropic"));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("matches no stored anthropic OAuth account");
			expect(warnings[0]).not.toContain(selector);
			expect(storage.sessions.mode("anthropic", session.sessionId)).toBe("affinity");
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
