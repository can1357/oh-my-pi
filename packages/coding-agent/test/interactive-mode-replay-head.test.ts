import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

/**
 * A rewind (or `/tree` jump) replays the transcript and clears terminal history. The welcome card
 * and the header lines under it are not session messages, so the replay must keep them on top
 * instead of dropping them with the old transcript.
 */
describe("InteractiveMode transcript replay", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let term: ModeTerminal;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-replay-head-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		session.configWarnings.push("theme.dark names a missing theme");
		term = createModeTerminal({
			rows: 60,
			version: "9.9.9",
			settings: Settings.isolated({ "startup.quiet": false }),
		});
		mode = new InteractiveMode(session, "9.9.9", undefined, undefined, undefined, undefined, term.frame);
		vi.spyOn(vcs, "watch").mockImplementation(() => () => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps the welcome card and config warnings above a history-clearing replay", async () => {
		await mode.init();
		session.sessionManager.appendMessage({ role: "user", content: "kept prompt", timestamp: Date.now() });
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		await term.settle();

		const shown = term.text();
		const welcome = shown.indexOf("v9.9.9");
		const warning = shown.indexOf("Warning: theme.dark names a missing theme");
		const prompt = shown.indexOf("kept prompt");
		expect(welcome).toBeGreaterThanOrEqual(0);
		expect(warning).toBeGreaterThan(welcome);
		expect(prompt).toBeGreaterThan(warning);
	});
});
