import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createRoot, effect } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, transcriptText } from "./helpers/mode-terminal";

/**
 * An in-place rebuild (compaction, `/shake`, a display setting change) replays the whole session
 * into the transcript. The drawn main region must update once for the replay, not once per
 * replayed block: in Tern every update walks the whole transcript, so a per-block update made a
 * rebuild quadratic in its length.
 */
describe("in-place transcript rebuild", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-rebuild-region-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.close();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("updates the main region once for the removal and the whole replay", () => {
		for (let i = 0; i < 20; i++) {
			session.sessionManager.appendMessage({ role: "user", content: `prompt ${i}`, timestamp: i + 1 });
		}
		// A drawn transcript to replace, as compaction or `/shake` finds it.
		mode.rebuildChatFromMessages();
		let updates = 0;
		createRoot(dispose => {
			effect(() => {
				mode.shell.surface.main();
				updates++;
			});
			updates = 0;
			mode.rebuildChatFromMessages();
			dispose();
		});
		expect(updates).toBe(1);
		const rendered = transcriptText(mode.shell);
		expect(rendered).toContain("prompt 0");
		expect(rendered).toContain("prompt 19");
	});
});
