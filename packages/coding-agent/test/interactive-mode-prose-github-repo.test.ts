import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as ghCommon from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode prose GitHub repo", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-prose-github-repo-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	/** Stubs gh's repo lookup and the session's cwd; returns the pending lookups and a cwd setter. */
	function stubSession(initialCwd: string): { lookups: Promise<string | undefined>[]; moveTo: (cwd: string) => void } {
		const repos: Record<string, string> = { "/work/alpha": "owner/alpha", "/work/beta": "owner/beta" };
		const lookups: Promise<string | undefined>[] = [];
		vi.spyOn(ghCommon, "tryResolveCurrentRepo").mockImplementation(cwd => {
			const lookup = Promise.resolve(repos[cwd]);
			lookups.push(lookup);
			return lookup;
		});
		let cwd = initialCwd;
		vi.spyOn(session.sessionManager, "getCwd").mockImplementation(() => cwd);
		return { lookups, moveTo: next => (cwd = next) };
	}

	it("binds a reply rebuilt after a cwd change to the repo it was written in", async () => {
		const { lookups, moveTo } = stubSession("/work/alpha");
		mode.proseGithubRepo();
		const writtenInAlpha = Date.now() - 1_000;
		moveTo("/work/beta");
		mode.proseGithubRepo();
		const writtenInBeta = Date.now() + 1_000;
		await Promise.all(lookups);

		expect(mode.proseGithubRepo(writtenInAlpha)()).toBe("owner/alpha");
		expect(mode.proseGithubRepo(writtenInBeta)()).toBe("owner/beta");
		// The live (streaming) component has no message yet and follows the current cwd.
		expect(mode.proseGithubRepo()()).toBe("owner/beta");
	});

	it("binds a resumed session's older replies to that session's repo", async () => {
		const { lookups, moveTo } = stubSession("/work/alpha");
		mode.proseGithubRepo();
		// `/resume` loads another session, from another repo, into the same AgentSession.
		const writtenBeforeResume = Date.now() - 1_000;
		vi.spyOn(session.sessionManager, "getSessionId").mockReturnValue("resumed-session");
		moveTo("/work/beta");
		mode.proseGithubRepo();
		await Promise.all(lookups);

		expect(mode.proseGithubRepo(writtenBeforeResume)()).toBe("owner/beta");
	});

	it("binds replies from earlier cwds to their repos after a restart and resume", async () => {
		const { lookups } = stubSession("/work/alpha");
		const manager = session.sessionManager;
		manager.setCwdWithoutRelocation("/work/alpha");
		const inAlpha = { ...createAssistantMessage("see #1"), timestamp: 1_000 };
		manager.appendMessage(inAlpha);
		manager.setCwdWithoutRelocation("/work/beta");
		const inBeta = { ...createAssistantMessage("see #2"), timestamp: 2_000 };
		manager.appendMessage(inBeta);
		await manager.flush();

		// A new process: fresh InteractiveMode and AgentSession over the reopened file.
		const reopened = await SessionManager.open(manager.getSessionFile()!, tempDir.path());
		const resumed = new AgentSession({
			agent: new Agent({
				initialState: { model: session.model!, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: reopened,
			settings: Settings.isolated({}),
			modelRegistry,
		});
		const resumedMode = new InteractiveMode(resumed, "test");
		try {
			resumedMode.proseGithubRepo();
			await Promise.all(lookups);

			expect(resumedMode.proseGithubRepo(inAlpha.timestamp)()).toBe("owner/alpha");
			expect(resumedMode.proseGithubRepo(inBeta.timestamp)()).toBe("owner/beta");
		} finally {
			resumedMode.stop();
			await resumed.dispose();
		}
	});
});
