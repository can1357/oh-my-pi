import { afterEach, beforeEach, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "status-line-account";
const SESSION_ID = "selected-account-session";
let auth: AuthStorage;
let temp: TempDir;
const components: StatusLineComponent[] = [];

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	temp = TempDir.createSync("status-line-account-");
	auth = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	await auth.credentials.set(PROVIDER, [
		{
			type: "oauth",
			access: "first-access",
			refresh: "first-refresh",
			expires: Date.now() + 3_600_000,
			email: "first@example.com",
			orgId: "org-personal",
		},
		{
			type: "oauth",
			access: "second-access",
			refresh: "second-refresh",
			expires: Date.now() + 3_600_000,
			email: "second@example.com",
			orgId: "org-work",
		},
	]);
});

afterEach(() => {
	for (const line of components.splice(0)) line.dispose();
	auth.close();
	temp.removeSync();
	resetSettingsForTest();
});

it("shows only the session-selected account, never the first stored credential or an overridden OAuth pin", () => {
	const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), provider: PROVIDER };
	const line = new StatusLineComponent(
		{
			state: { model, messages: [] },
			isStreaming: false,
			isAutoThinking: false,
			sessionManager: {
				getSessionName: () => undefined,
				getSessionId: () => SESSION_ID,
				getUsageStatistics: () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					orchestrationInput: 0,
					orchestrationOutput: 0,
					orchestrationCacheRead: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
			getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
			autoResolvedThinkingLevel: () => undefined,
			isFastModeActive: () => false,
			getAsyncJobSnapshot: () => null,
			getGoalModeState: () => undefined,
			sessionId: SESSION_ID,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		},
		statusLineHost,
	);
	components.push(line);
	line.updateSettings({ preset: "custom", leftSegments: ["model", "account"], rightSegments: [] });
	const text = () => Bun.stripANSI(line.getTopBorder(160).content);
	const nativeText = () => JSON.stringify(line.describeComposerFacts());

	expect(text()).not.toContain("first@example.com");
	expect(nativeText()).not.toContain("first@example.com");
	const [first, second] = auth.oauth.accounts(PROVIDER, SESSION_ID);
	if (!first || !second) throw new Error("Expected two stored accounts");
	auth.sessions.pin(PROVIDER, SESSION_ID, first.credentialId);
	expect(text()).toContain("first@example.com (org-personal)");
	expect(nativeText()).toContain("first@example.com (org-personal)");

	auth.sessions.pin(PROVIDER, SESSION_ID, second.credentialId);
	expect(text()).toContain("second@example.com (org-work)");
	expect(nativeText()).toContain("second@example.com (org-work)");
	expect(text()).not.toContain("first@example.com");

	auth.keys.setRuntime(PROVIDER, "explicit-api-key");
	expect(text()).not.toContain("second@example.com");
	expect(nativeText()).not.toContain("second@example.com");
});
