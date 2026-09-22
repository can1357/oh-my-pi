import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function mintOAuthCredential(suffix: string, extra?: { orgId?: string; orgName?: string }) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		...extra,
	};
}

const model = getBundledModel("anthropic", "claude-opus-4-5") ?? getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("expected a bundled anthropic model for this test file");
const openaiModel = getBundledModel("openai", "gpt-5");
if (!openaiModel) throw new Error("expected a bundled openai model for this test file");

const cleanup: Array<() => Promise<void> | void> = [];

/** Two Anthropic OAuth accounts under one settings-configured `startupOAuthAccount` default (account "a"). */
async function createHarness(): Promise<{
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	dbPath: string;
}> {
	const tempDir = TempDir.createSync("@pi-startup-oauth-pin-");
	const cwd = tempDir.path();
	const dbPath = path.join(cwd, "auth.db");
	const store = new SqliteAuthCredentialStore(new Database(dbPath));
	store.saveOAuth("anthropic", mintOAuthCredential("a"));
	store.saveOAuth("anthropic", mintOAuthCredential("b"));
	const authStorage = new AuthStorage(store);
	await authStorage.reload();

	const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
	const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

	cleanup.push(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	return { session, sessionManager, authStorage, dbPath };
}

describe("AgentSession startup OAuth account pin", () => {
	afterEach(async () => {
		while (cleanup.length > 0) {
			const run = cleanup.pop();
			if (run) await run();
		}
	});

	it("pins the configured account on construction", async () => {
		const { session } = await createHarness();
		const accounts = await session.listCurrentProviderOAuthAccounts();
		const active = accounts?.accounts.find(a => a.active);
		expect(active?.accountId).toBe("account-a");
	});

	it("pins every configured provider and reapplies non-current pins after auth mutations", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-all-providers-");
		const cwd = tempDir.path();
		const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
		store.saveOAuth("anthropic", mintOAuthCredential("anthropic-a"));
		store.saveOAuth("openai", mintOAuthCredential("openai-a"));
		store.saveOAuth("openai", mintOAuthCredential("openai-b"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const settings = Settings.isolated({
			"auth.startupOAuthAccount": {
				anthropic: "anthropic-a@example.com",
				openai: "openai-b@example.com",
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		expect(
			authStorage.listOAuthAccounts("openai", session.sessionId).find(account => account.active)?.accountId,
		).toBe("account-openai-b");

		// `/login` and `/logout` reset every assignment for the mutated provider.
		// OpenAI is not the foreground provider, but its configured startup pin
		// must still be restored before a primary-session helper can probe it.
		authStorage.upsertCredential("openai", mintOAuthCredential("openai-c"));
		expect(
			authStorage.listOAuthAccounts("openai", session.sessionId).find(account => account.active)?.accountId,
		).toBe("account-openai-b");
	});

	it("reapplies the pin after /new mints a fresh session id", async () => {
		const { session } = await createHarness();
		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active)?.accountId).toBe(
			"account-a",
		);

		expect(await session.newSession()).toBe(true);

		// This is the exact regression: before the fix, /new minted a session id
		// with no restored pin and #applyStartupOAuthAccountPin ran only once,
		// at the original construction — so the fresh session fell back to
		// automatic ranking instead of the configured default.
		const afterNew = await session.listCurrentProviderOAuthAccounts();
		expect(afterNew?.accounts.find(a => a.active)?.accountId).toBe("account-a");
	});

	it("never overrides a resumed manual pin recorded in the session file", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-resume-");
		const cwd = tempDir.path();
		const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		store.saveOAuth("anthropic", mintOAuthCredential("b"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		// Simulate a resumed session file whose last turn was served by account
		// "b" — recorded the same way `recordCredentialPin` does after a real turn.
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		sessionManager.appendCredentialPin("anthropic", hash);

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		// The resumed pin (account "b") must win over the configured startup
		// default (account "a") — resuming a real conversation must not silently
		// reroute it to a different account's (cold) prompt cache.
		const accounts = await session.listCurrentProviderOAuthAccounts();
		expect(accounts?.accounts.find(a => a.active)?.accountId).toBe("account-b");
	});

	it("falls back to the configured default once a resumed session-file pin's account is confirmably gone", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-resume-gone-");
		const cwd = tempDir.path();
		const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		store.saveOAuth("anthropic", mintOAuthCredential("b"));
		store.saveOAuth("anthropic", mintOAuthCredential("c"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		// Simulate a resumed session file recorded while account "b" served it,
		// then "b" was removed via `/logout` in a different process/session
		// before this one resumes -- `seedCredentialPins` can never match it
		// again (see its own "gone (logged out)" no-op).
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		sessionManager.appendCredentialPin("anthropic", hash);
		const toRemove = authStorage.listOAuthAccounts("anthropic").find(a => a.accountId === "account-b");
		if (!toRemove) throw new Error("expected account b to exist before removal");
		expect(await authStorage.removeCredential("anthropic", toRemove.credentialId)).toBe(true);

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		// The first check after construction only gets one "not yet visible"
		// grace round (indistinguishable from a stale broker snapshot), so
		// nothing is active yet.
		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.some(a => a.active)).toBe(false);

		// An unrelated credential change bumps AuthStorage's generation and
		// retries the pin. On this SECOND consecutive miss for account "b"'s
		// hash, the recorded pin is confirmably gone -- unlike the
		// unconditional guard this replaces, that must now let the configured
		// default (account "a") claim the session instead of deferring
		// forever.
		store.saveOAuth("anthropic", mintOAuthCredential("d"));
		await authStorage.reload();
		const accounts = await session.listCurrentProviderOAuthAccounts();
		expect(accounts?.accounts.find(a => a.active)?.accountId).toBe("account-a");
	});

	it("a synchronous second preflight call does not consume resume grace before a genuine credential refresh", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-resume-sync-preflight-");
		const cwd = tempDir.path();
		const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
		// Only account "a" is visible at construction; the resumed session's
		// recorded account "b" is not (stale broker snapshot).
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		sessionManager.appendCredentialPin("anthropic", hash);

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		// Construction's own check is the first miss: nothing active yet. Peek
		// via `authStorage.listOAuthAccounts()` directly rather than
		// `session.listCurrentProviderOAuthAccounts()`, which itself calls
		// `authStorage.reload()` as a side effect and would confound this
		// test's "no refresh happened in between" setup.
		expect(authStorage.listOAuthAccounts("anthropic", session.sessionId).some(a => a.active)).toBe(false);

		// A different preflight call site probes the SAME (provider, sessionId)
		// synchronously, exactly like `memories/index.ts` calling the public
		// `applyStartupOAuthAccountPin()` entry point right after construction --
		// with no credential-store mutation or reload in between. This must NOT
		// be treated as the confirmable second miss and must not let the
		// configured default ("a") claim the session yet: account "b"'s real
		// broker snapshot has not had a chance to arrive.
		session.applyStartupOAuthAccountPin("anthropic", session.sessionId);
		expect(authStorage.listOAuthAccounts("anthropic", session.sessionId).some(a => a.active)).toBe(false);

		// A genuine credential-store refresh now occurs (still without "b"
		// appearing). This is the real second miss, so the configured default
		// may finally claim the session.
		store.saveOAuth("anthropic", mintOAuthCredential("c"));
		await authStorage.reload();
		const accounts = authStorage.listOAuthAccounts("anthropic", session.sessionId);
		expect(accounts.find(a => a.active)?.accountId).toBe("account-a");
	});

	it("a confirmed-unchanged external refresh still advances resume grace toward the configured default", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-resume-unchanged-reload-");
		const cwd = tempDir.path();
		const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
		// Only account "a" is visible at construction; the resumed session's
		// recorded account "b" is not (stale broker snapshot) and never
		// reappears -- "b" was deleted for good.
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		sessionManager.appendCredentialPin("anthropic", hash);

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		// Construction's own check is the first miss: nothing active yet. Peek
		// via `authStorage.listOAuthAccounts()` directly, which does not itself
		// reload, to isolate the explicit reload below as the sole refresh.
		expect(authStorage.listOAuthAccounts("anthropic", session.sessionId).some(a => a.active)).toBe(false);

		// A background auth-broker snapshot delivery (`discover.ts`'s
		// `onSnapshot` -> `reload()` -> `notifyExternalRefresh()`) confirms the
		// authoritative view again -- content is byte-identical to what was
		// already cached, so this does NOT bump `getGeneration()`.
		// `AgentSession` subscribes to `AuthStorage.onRefreshAttempted`, not
		// `onGenerationChanged`, specifically so this confirmed-unchanged
		// external refresh retries the pin on its own -- without needing any
		// OTHER call site (a helper's own preflight, `/session pin`, etc.) to
		// invoke the hook again before the default is ever applied. A bare
		// `reload()` alone (with no `notifyExternalRefresh()`) must NOT have
		// this effect -- see the "does not consume resume grace" test above,
		// which exercises exactly that boundary.
		await authStorage.reload();
		authStorage.notifyExternalRefresh();
		const accounts = authStorage.listOAuthAccounts("anthropic", session.sessionId);
		expect(accounts.find(a => a.active)?.accountId).toBe("account-a");
	});

	it("overrides a sibling account activated during the resume-grace window once grace expires", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-resume-grace-sticky-override-");
		const cwd = tempDir.path();
		const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
		// "a" (the configured default) and "c" (an unrelated sibling) are both
		// visible at construction; the resumed session's recorded account "b"
		// never reappears -- "b" was deleted for good.
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		store.saveOAuth("anthropic", mintOAuthCredential("c"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		sessionManager.appendCredentialPin("anthropic", hash);

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		// Construction's own check is the first miss: nothing active yet.
		expect(authStorage.listOAuthAccounts("anthropic", session.sessionId).some(a => a.active)).toBe(false);

		// A real request during the deferral window resolves credentials through
		// ordinary ranking (nothing is pinned yet) and lands on sibling "c" --
		// exactly what `getOAuthAccess`/`getApiKey` do internally, independent of
		// `#applyStartupOAuthAccountPin`.
		const cCredentialId = authStorage
			.listOAuthAccounts("anthropic", session.sessionId)
			.find(a => a.accountId === "account-c")?.credentialId;
		if (cCredentialId === undefined) throw new Error("expected account c to exist");
		authStorage.pinSessionOAuthAccount("anthropic", session.sessionId, cCredentialId);
		expect(authStorage.listOAuthAccounts("anthropic", session.sessionId).find(a => a.active)?.accountId).toBe(
			"account-c",
		);

		// A confirmed-unchanged external refresh (`discover.ts`'s
		// `onSnapshot` -> `reload()` -> `notifyExternalRefresh()`) confirms "b"
		// is still gone, expiring the grace. The configured default ("a") must
		// override "c"'s incidental sticky here -- not be permanently blocked
		// by it just because the deferral window's own miss-tracking branches
		// never marked this key `#pendingStartupOAuthPins`, which is what
		// `hasActive`'s override check requires.
		await authStorage.reload();
		authStorage.notifyExternalRefresh();
		const accounts = authStorage.listOAuthAccounts("anthropic", session.sessionId);
		expect(accounts.find(a => a.active)?.accountId).toBe("account-a");
	});

	it("still fails over to the sibling account when the pinned one is rate-limited", async () => {
		const { session } = await createHarness();
		const authStorage = session.modelRegistry.authStorage;
		const pinned = (await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active);
		expect(pinned?.accountId).toBe("account-a");

		authStorage.upsertCredentialBlock({
			credentialId: pinned!.credentialId,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 60 * 60_000,
		});

		const resolution = await authStorage.getOAuthAccess("anthropic", session.sessionId);
		expect(resolution?.accountId).toBe("account-b");
	});

	it("does not crash session construction when the configured value is not a string", async () => {
		// A hand-edited YAML `anthropic: 1` (unquoted) or the generic /settings
		// record editor can save a number instead of a string selector.
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-nonstring-");
		const cwd = tempDir.path();
		const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const settings = Settings.isolated({
			"auth.startupOAuthAccount": { anthropic: 1 } as unknown as Record<string, string>,
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });

		let session: AgentSession | undefined;
		cleanup.push(async () => {
			await session?.dispose();
			authStorage.close();
			tempDir.removeSync();
		});
		expect(() => {
			session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		}).not.toThrow();

		const accounts = await session?.listCurrentProviderOAuthAccounts();
		expect(accounts?.accounts.some(a => a.active)).toBe(false);
	});

	it("reapplies the startup default when /model switches provider", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-provider-switch-");
		const cwd = tempDir.path();
		const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		store.saveOAuth("openai", mintOAuthCredential("o"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const settings = Settings.isolated({
			"auth.startupOAuthAccount": { anthropic: "a@example.com", openai: "o@example.com" },
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active)?.accountId).toBe(
			"account-a",
		);

		// `/model` to a different provider funnels through
		// `#setModelWithProviderSessionReset`, a different code path from the
		// session-identity transitions `#syncAgentSessionId` covers.
		await session.setModel(openaiModel);

		const openaiAccounts = authStorage.listOAuthAccounts("openai", session.sessionId);
		expect(openaiAccounts.find(a => a.active)?.accountId).toBe("account-o");
	});

	it("propagates the startup pin to an enabled advisor's own provider-session id", async () => {
		const { session, authStorage } = await createHarness();
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		session.toggleAdvisorEnabled();
		const advisorAgent = session.getAdvisorAgent();
		if (!advisorAgent) throw new Error("expected advisor agent to exist");

		// Advisor provider-session ids are separate random UUIDs credential
		// stickiness is keyed on (see `getOrCreateAdvisorProviderSessionId`) --
		// without propagation the advisor would start on automatic ranking
		// instead of the configured account, potentially consuming the sibling
		// account the setting reserved for failover.
		const advisorSessionId = advisorAgent.sessionId;
		expect(advisorSessionId).toBeDefined();
		expect(advisorSessionId).not.toBe(session.sessionId);
		const advisorAccounts = authStorage.listOAuthAccounts("anthropic", advisorSessionId as string);
		expect(advisorAccounts.find(a => a.active)?.accountId).toBe("account-a");
	});

	it("retries the startup pin — for the primary session and an enabled advisor — once a matching account appears after construction", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-retry-");
		const cwd = tempDir.path();
		const dbPath = path.join(cwd, "auth.db");
		const store = new SqliteAuthCredentialStore(new Database(dbPath));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		// Selector for account "c", which does not exist yet: nothing to match
		// at construction time, the exact shape of a stale auth-broker snapshot
		// cache or a sibling process's `/login` not yet visible.
		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "c@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		session.toggleAdvisorEnabled();
		const advisorAgent = session.getAdvisorAgent();
		if (!advisorAgent) throw new Error("expected advisor agent to exist");
		const advisorSessionId = advisorAgent.sessionId as string;

		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.some(a => a.active)).toBe(false);
		expect(authStorage.listOAuthAccounts("anthropic", advisorSessionId).some(a => a.active)).toBe(false);

		// The account becomes visible later — through a second store handle on
		// the same db, mirroring how a sibling process's write or a broker
		// snapshot delivery makes new rows visible to `AuthStorage.reload()`
		// without this process having restarted.
		const secondStore = new SqliteAuthCredentialStore(new Database(dbPath));
		secondStore.saveOAuth("anthropic", mintOAuthCredential("c"));
		secondStore.close();
		await authStorage.reload();

		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active)?.accountId).toBe(
			"account-c",
		);
		expect(authStorage.listOAuthAccounts("anthropic", advisorSessionId).find(a => a.active)?.accountId).toBe(
			"account-c",
		);
	});

	it("retry overrides an automatically-selected sticky once the configured account becomes resolvable", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-auto-override-");
		const cwd = tempDir.path();
		const dbPath = path.join(cwd, "auth.db");
		const store = new SqliteAuthCredentialStore(new Database(dbPath));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		// Selector for account "c", which does not exist yet.
		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "c@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});
		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.some(a => a.active)).toBe(false);

		// A real request routes to "a" (the only stored account) through
		// ordinary automatic ranking before the configured account is visible
		// -- same storage effect as ranking's own sticky recording, since
		// `pinSessionOAuthAccount` and automatic ranking share the same
		// underlying `#recordSessionCredential`.
		const accountA = authStorage.listOAuthAccounts("anthropic", session.sessionId)[0];
		if (!accountA) throw new Error("expected account a");
		expect(authStorage.pinSessionOAuthAccount("anthropic", session.sessionId, accountA.credentialId)).toBe(true);

		// "c" becomes visible later (broker snapshot catching up / sibling
		// process `/login`); the generation-changed retry must override the
		// incidental "a" sticky now that the configured selector resolves --
		// the old blanket "something is active, never touch it" guard would
		// leave this permanently stuck on "a".
		const secondStore = new SqliteAuthCredentialStore(new Database(dbPath));
		secondStore.saveOAuth("anthropic", mintOAuthCredential("c"));
		secondStore.close();
		await authStorage.reload();

		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active)?.accountId).toBe(
			"account-c",
		);
	});

	it("retry never overrides a deliberate manual /session pin issued during the same unresolved window", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-manual-protect-");
		const cwd = tempDir.path();
		const dbPath = path.join(cwd, "auth.db");
		const store = new SqliteAuthCredentialStore(new Database(dbPath));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "c@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});
		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.some(a => a.active)).toBe(false);

		// The user deliberately pins "a" through the real public API
		// (`/session pin`'s own call target) during the same window the
		// startup selector is still unresolved.
		const accountA = authStorage.listOAuthAccounts("anthropic", session.sessionId)[0];
		if (!accountA) throw new Error("expected account a");
		expect(session.pinCurrentProviderOAuthAccount(accountA.credentialId)).toBe(true);

		// "c" (the configured default) becomes visible later. The retry must
		// NOT override the user's deliberate choice just because it happened
		// to run during the same unresolved window an automatic pick would
		// have used.
		const secondStore = new SqliteAuthCredentialStore(new Database(dbPath));
		secondStore.saveOAuth("anthropic", mintOAuthCredential("c"));
		secondStore.close();
		await authStorage.reload();

		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active)?.accountId).toBe(
			"account-a",
		);
	});

	it("preserves a manual pin when a credential mutation resets live assignments before a turn", async () => {
		const { session, authStorage } = await createHarness();
		const accountB = authStorage
			.listOAuthAccounts("anthropic", session.sessionId)
			.find(account => account.accountId === "account-b");
		if (!accountB) throw new Error("expected account b");
		expect(session.pinCurrentProviderOAuthAccount(accountB.credentialId)).toBe(true);

		// `/login`/`/logout` clear per-provider assignments. Its generation
		// listener immediately restores a recorded pin before considering the
		// configured default, so the user-selected B must survive even though
		// it has not served an assistant turn yet.
		authStorage.upsertCredential("anthropic", mintOAuthCredential("c"));

		expect(
			(await session.listCurrentProviderOAuthAccounts())?.accounts.find(account => account.active)?.accountId,
		).toBe("account-b");
	});

	it("a resumed session-file pin still wins when its account only becomes visible after the startup default's", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-resume-race-");
		const cwd = tempDir.path();
		const dbPath = path.join(cwd, "auth.db");
		const store = new SqliteAuthCredentialStore(new Database(dbPath));
		// Only the startup default's account "a" is visible at construction; the
		// resumed session's recorded account "b" is not (stale broker snapshot).
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		sessionManager.appendCredentialPin("anthropic", hash);

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		// The default must NOT claim the session just because it resolved first:
		// a recorded pin outranks it whether or not it is seedable yet. Otherwise
		// the later `seedCredentialPins` retry sees an active account and skips,
		// permanently inverting the documented precedence.
		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.some(a => a.active)).toBe(false);

		const secondStore = new SqliteAuthCredentialStore(new Database(dbPath));
		secondStore.saveOAuth("anthropic", mintOAuthCredential("b"));
		secondStore.close();
		await authStorage.reload();

		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active)?.accountId).toBe(
			"account-b",
		);
	});

	it("restores a resumed session-file pin over an incidental automatic sticky once its account reappears", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-resume-restore-");
		const cwd = tempDir.path();
		const dbPath = path.join(cwd, "auth.db");
		const store = new SqliteAuthCredentialStore(new Database(dbPath));
		// Only account "a" is visible at construction; the resumed session's
		// recorded account "b" is not yet (stale broker snapshot).
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		sessionManager.appendCredentialPin("anthropic", hash);

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});
		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.some(a => a.active)).toBe(false);

		// A real request routes to "a" through ordinary automatic ranking before
		// the resumed account "b" is visible -- same storage effect as ranking's
		// own sticky recording (see the sibling "retry overrides an
		// automatically-selected sticky" test above).
		const accountA = authStorage.listOAuthAccounts("anthropic", session.sessionId)[0];
		if (!accountA) throw new Error("expected account a");
		expect(authStorage.pinSessionOAuthAccount("anthropic", session.sessionId, accountA.credentialId)).toBe(true);

		// "b" becomes visible later. `seedCredentialPins` only restores onto a
		// session with nothing active yet, so it no-ops now that "a" is sticky --
		// the resumed pin must still win by being restored explicitly here,
		// rather than leaving the incidental "a" sticky in place.
		const secondStore = new SqliteAuthCredentialStore(new Database(dbPath));
		secondStore.saveOAuth("anthropic", mintOAuthCredential("b"));
		secondStore.close();
		await authStorage.reload();

		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active)?.accountId).toBe(
			"account-b",
		);
	});

	it("stops retrying the startup pin once the session is disposed", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-dispose-");
		const cwd = tempDir.path();
		const dbPath = path.join(cwd, "auth.db");
		const store = new SqliteAuthCredentialStore(new Database(dbPath));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "c@example.com" } });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(() => {
			authStorage.close();
			tempDir.removeSync();
		});
		const sessionId = session.sessionId;
		expect(authStorage.listOAuthAccounts("anthropic", sessionId).some(a => a.active)).toBe(false);

		await session.dispose();

		// The configured account appears only after disposal. A disposed session
		// must not keep writing credential pins for an id nothing will use again.
		const secondStore = new SqliteAuthCredentialStore(new Database(dbPath));
		secondStore.saveOAuth("anthropic", mintOAuthCredential("c"));
		secondStore.close();
		await authStorage.reload();

		expect(authStorage.listOAuthAccounts("anthropic", sessionId).some(a => a.active)).toBe(false);
	});

	it("retries a title session's pending startup pin once its configured account becomes visible", async () => {
		const tempDir = TempDir.createSync("@pi-startup-oauth-pin-title-retry-");
		const cwd = tempDir.path();
		const dbPath = path.join(cwd, "auth.db");
		const store = new SqliteAuthCredentialStore(new Database(dbPath));
		store.saveOAuth("anthropic", mintOAuthCredential("b"));
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const settings = Settings.isolated({ "auth.startupOAuthAccount": { anthropic: "a@example.com" } });
		settings.overrideModelRoles({ smol: `${model.provider}/${model.id}` });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [], model } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Investigate shutdown</title>" }],
		} as never);

		await session.generateTitle("Investigate the crash on shutdown");

		const titleSessionId = getApiKeySpy.mock.calls.find(call => call[0] === model)?.[1];
		if (!titleSessionId) throw new Error("expected a captured title session id");
		expect(titleSessionId).not.toBe(session.sessionId);
		// The configured "a@example.com" default was not yet visible, so
		// automatic ranking claimed the only available account ("b") for the
		// isolated title session.
		expect(authStorage.listOAuthAccounts("anthropic", titleSessionId).find(a => a.active)?.accountId).toBe(
			"account-b",
		);

		// The configured account becomes visible later (e.g. a sibling
		// process's `/login`). This is the exact regression: the
		// generation-changed retry only covered the primary session and live
		// advisors, so a title (or classifier) session's pending pin was never
		// retried and stayed on the automatically-ranked account forever.
		authStorage.upsertCredential("anthropic", mintOAuthCredential("a"));

		expect(authStorage.listOAuthAccounts("anthropic", titleSessionId).find(a => a.active)?.accountId).toBe(
			"account-a",
		);
	});
});
