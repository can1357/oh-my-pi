import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
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
async function createHarness(): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
	const tempDir = TempDir.createSync("@pi-startup-oauth-pin-");
	const cwd = tempDir.path();
	const store = new SqliteAuthCredentialStore(new Database(path.join(cwd, "auth.db")));
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
	return { session, sessionManager };
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
		expect(() => {
			session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		}).not.toThrow();

		const accounts = await session?.listCurrentProviderOAuthAccounts();
		expect(accounts?.accounts.some(a => a.active)).toBe(false);

		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
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

		expect((await session.listCurrentProviderOAuthAccounts())?.accounts.find(a => a.active)?.accountId).toBe(
			"account-a",
		);

		// `/model` to a different provider funnels through
		// `#setModelWithProviderSessionReset`, a different code path from the
		// session-identity transitions `#syncAgentSessionId` covers.
		await session.setModel(openaiModel);

		const openaiAccounts = authStorage.listOAuthAccounts("openai", session.sessionId);
		expect(openaiAccounts.find(a => a.active)?.accountId).toBe("account-o");

		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
});
