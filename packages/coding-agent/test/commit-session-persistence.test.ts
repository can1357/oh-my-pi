import { afterEach, beforeEach, expect, it } from "bun:test";
import { $ } from "bun";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { listSessionsReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const MOCK_SOURCE_ID = "test/commit-session-persistence";

let settingsState: SettingsTestState | undefined;

beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(() => {
	unregisterCustomApis(MOCK_SOURCE_ID);
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

it("keeps a one-shot commit conversation out of the resumable session list", async () => {
	using tempDir = TempDir.createSync("@omp-commit-session-");
	await $`git init -q`.cwd(tempDir.path()).quiet();
	const agentDir = tempDir.join("agent");
	setAgentDir(agentDir);
	registerMockApi(MOCK_SOURCE_ID);
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	try {
		await runCommitAgentSession({
			cwd: tempDir.path(),
			model: createMockModel({ provider: "anthropic", handler: { content: ["commit proposed"] } }),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			authStorage,
			changelogTargets: [],
			requireChangelog: false,
		});

		const sessionDir = SessionManager.getDefaultSessionDir(tempDir.path(), agentDir);
		expect(await listSessionsReadOnly(sessionDir, new FileSessionStorage())).toEqual([]);
	} finally {
		authStorage.close();
	}
});
