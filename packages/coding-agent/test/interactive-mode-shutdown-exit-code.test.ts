import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

// The SIGCONT recovery requests a failure exit code, but the process is
// terminated inside shutdown()'s host-owned quit. This pins that the requested
// code survives the graceful teardown instead of exiting 0.
describe("InteractiveMode shutdown exit code", () => {
	let authStorage: AuthStorage;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-shutdown-exit-code-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("exits with the code requested by the caller", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};
		const quitSpy: Mock<typeof postmortem.quit> = vi.spyOn(postmortem, "quit").mockImplementation(async () => {});

		await mode.shutdown(7);

		expect(quitSpy).toHaveBeenCalledWith(7);
	});

	it("escalates the exit code of a shutdown already in flight", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		// Park the close inside #teardown() so the second shutdown() below hits
		// the in-flight guard.
		const drainGate = Promise.withResolvers<void>();
		mode.ui.terminal.drainInput = () => drainGate.promise;
		const quitSpy: Mock<typeof postmortem.quit> = vi.spyOn(postmortem, "quit").mockImplementation(async () => {});

		const closing = mode.shutdown(0);
		// A failure code arriving mid-close must not be dropped by the guard, or
		// the in-flight clean close would exit 0 and mask it.
		await mode.shutdown(1);
		drainGate.resolve();
		await closing;

		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(quitSpy).toHaveBeenCalledWith(1);
	});
});
