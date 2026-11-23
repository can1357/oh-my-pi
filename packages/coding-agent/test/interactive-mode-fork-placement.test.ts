import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { CleanseCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/cleanse-command-controller";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { OmfgController } from "@oh-my-pi/pi-coding-agent/modes/controllers/omfg-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode fork placement bridge", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-fork-placement-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
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

	it.each([
		["an in-place fork tears down", undefined, 1],
		["a pane fork keeps", "pane", 0],
	] as const)("%s the current session's side controllers", async (_label, placement, disposals) => {
		const btwDispose = vi.spyOn(BtwController.prototype, "dispose");
		const omfgDispose = vi.spyOn(OmfgController.prototype, "dispose");
		const cleanseDispose = vi.spyOn(CleanseCommandController.prototype, "dispose");
		vi.spyOn(CommandController.prototype, "handleForkCommand").mockResolvedValue();

		await mode.handleForkCommand(placement);

		expect(btwDispose).toHaveBeenCalledTimes(disposals);
		expect(omfgDispose).toHaveBeenCalledTimes(disposals);
		expect(cleanseDispose).toHaveBeenCalledTimes(disposals);
	});
});
