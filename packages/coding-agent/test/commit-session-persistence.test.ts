import { afterEach, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { listSessionsReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

it("keeps a one-shot commit conversation out of the resumable session list", async () => {
	using tempDir = TempDir.createSync("@omp-commit-session-");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	try {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled commit model");
		const createSession = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const result = await createSession({ ...options, agentDir: tempDir.path(), skipPythonPreflight: true });
			result.session.agent.streamFn = createMockModel({ handler: { content: ["commit proposed"] } }).stream;
			return result;
		});

		await runCommitAgentSession({
			cwd: import.meta.dir,
			model,
			settings: Settings.isolated({ "async.enabled": false, "advisor.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			authStorage,
			changelogTargets: [],
			requireChangelog: false,
		});

		const sessionDir = SessionManager.getDefaultSessionDir(import.meta.dir, tempDir.path());
		expect(await listSessionsReadOnly(sessionDir, new FileSessionStorage())).toEqual([]);
	} finally {
		authStorage.close();
	}
});
