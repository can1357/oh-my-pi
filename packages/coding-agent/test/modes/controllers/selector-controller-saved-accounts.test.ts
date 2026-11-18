import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as loginDialogModule from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

/** `/login` for a provider that keeps one registration per sign-in lists its saved accounts first. */
describe("SelectorController /login with saved ChatGPT accounts", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let state: SettingsTestState | undefined;
	let prompts: string[];

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-selector-saved-accounts-");
		const dbPath = path.join(tempDir.path(), "auth.db");
		const seed = await SqliteAuthCredentialStore.open(dbPath);
		for (const [client, accountId, email] of [
			["client_a", "acct_a", "first@example.com"],
			["client_b", "acct_b", "second@example.com"],
		] as const) {
			await seed.upsertAuthCredential("openai", {
				type: "oauth",
				access: `access-${client}`,
				refresh: `refresh-${client}`,
				expires: Date.now() + 3_600_000,
				oauthClientId: client,
				accountId,
				email,
			});
		}
		seed.close();
		authStorage = await AuthStorage.create(dbPath);
		prompts = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		await session?.dispose();
		session = undefined;
		authStorage.close();
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	/** Opens `/login openai` with the account prompt answered by `answer`; resolves once the login handler settles. */
	async function loginWithAnswer(answer: string): Promise<void> {
		vi.spyOn(loginDialogModule, "LoginDialogComponent").mockImplementation(function () {
			return {
				signal: new AbortController().signal,
				showPrompt: async (request: { message: string }) => {
					prompts.push(request.message);
					return answer;
				},
				showAuth: () => {},
				showProgress: () => {},
			};
		} as never);
		const settings = Settings.isolated();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5") as Model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator: new SecretObfuscator([]),
		});
		const controller = new SelectorController(
			createInteractiveModeContext({
				session,
				settings,
				ui: { showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }) },
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
			}),
		);
		await controller.showOAuthSelector("login", "openai");
	}

	it("switches the session to the chosen account by number without signing in", async () => {
		const login = vi.spyOn(authStorage.oauth, "login");

		await loginWithAnswer("2");

		expect(prompts[0]).toContain("1. first@example.com");
		expect(prompts[0]).toContain("2. second@example.com");
		expect(login).not.toHaveBeenCalled();
		const active = authStorage.oauth.accounts("openai", session!.sessionId).find(account => account.active);
		expect(active?.email).toBe("second@example.com");
	});

	it("goes on to a new sign-in when the answer is empty", async () => {
		const login = vi.spyOn(authStorage.oauth, "login").mockResolvedValue({ type: "oauth", email: "new@example.com" });

		await loginWithAnswer("");

		expect(login).toHaveBeenCalledTimes(1);
		expect(login.mock.calls[0]?.[0]).toBe("openai");
	});

	it("rejects a number that matches no saved account instead of signing in", async () => {
		const login = vi.spyOn(authStorage.oauth, "login");

		await loginWithAnswer("7");

		expect(login).not.toHaveBeenCalled();
		const active = authStorage.oauth.accounts("openai", session!.sessionId).find(account => account.active);
		expect(active).toBeUndefined();
	});
});
