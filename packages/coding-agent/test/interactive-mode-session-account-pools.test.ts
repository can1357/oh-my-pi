import { afterAll, beforeAll, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, settings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

beforeAll(() => initTheme());

afterAll(() => resetSettingsForTest());

test("cwd changes keep the session's explicitly selected account pool through moves and rollback", async () => {
	const settingsState = beginSettingsTest();
	const tempDir = TempDir.createSync("@interactive-session-account-pools-");
	const source = tempDir.join("source");
	const target = tempDir.join("target");
	const unrestricted = tempDir.join("unrestricted");
	await Promise.all([source, target, unrestricted].map(directory => fs.mkdir(directory, { recursive: true })));
	setProjectDir(source);
	await Settings.init({
		inMemory: true,
		cwd: source,
		overrides: {
			"auth.sessionAccountPools": {
				company: { anthropic: ["email:a@example.com|org:org-a"] },
			},
		},
	});

	const authStorage = createInMemoryAuthStorage();
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	try {
		await authStorage.credentials.set(
			"anthropic",
			["a", "b"].map(suffix => ({
				type: "oauth" as const,
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 60 * 60_000,
				accountId: `account-${suffix}`,
				email: `${suffix}@example.com`,
				orgId: `org-${suffix}`,
			})),
		);
		const accountA = authStorage.oauth.accounts("anthropic").find(account => account.accountId === "account-a");
		const accountB = authStorage.oauth.accounts("anthropic").find(account => account.accountId === "account-b");
		if (!accountA || !accountB) throw new Error("Expected both OAuth fixtures");

		const sessionManager = SessionManager.inMemory(source);
		const baseRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = baseRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const scope = new SessionAccountPoolScope(
			authStorage,
			{ anthropic: ["email:a@example.com|org:org-a"] },
			sessionManager.getSessionId(),
			{ denyUnlistedProviders: true },
		);
		const modelRegistry = scope.registry(baseRegistry);
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings,
			modelRegistry,
			accountPoolScope: scope,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "refreshTitleSystemPrompt").mockResolvedValue();
		vi.spyOn(mode.statusLine, "applyCwdChange").mockImplementation(() => {});
		const refreshSkills = vi.spyOn(session, "refreshSkillsAndCommands").mockResolvedValue();
		const permits = (account: { credentialId: number }) =>
			authStorage.sessions.permits("anthropic", sessionManager.getSessionId(), account.credentialId);

		sessionManager.setCwdWithoutRelocation(target);
		expect(await mode.applyCwdChange(target)).toBe(true);
		expect(permits(accountA)).toBe(true);
		expect(permits(accountB)).toBe(false);

		sessionManager.setCwdWithoutRelocation(unrestricted);
		expect(await mode.applyCwdChange(unrestricted)).toBe(true);
		expect(permits(accountA)).toBe(true);
		expect(permits(accountB)).toBe(false);

		sessionManager.setCwdWithoutRelocation(source);
		expect(await mode.applyCwdChange(source)).toBe(true);
		expect(permits(accountA)).toBe(true);
		expect(permits(accountB)).toBe(false);

		refreshSkills.mockRejectedValueOnce(new Error("destination refresh failed")).mockResolvedValue();
		sessionManager.setCwdWithoutRelocation(target);
		expect(await mode.applyCwdChange(target)).toBe(false);
		expect(sessionManager.getCwd()).toBe(source);
		expect(permits(accountA)).toBe(true);
		expect(permits(accountB)).toBe(false);
	} finally {
		mode?.stop();
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		restoreSettingsTestState(settingsState);
	}
});
