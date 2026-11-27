import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgTuiResizeScrollback } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

describe("tui.resizeScrollback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-resize-scrollback-");
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
		term = createModeTerminal({ columns: 100, rows: 24, settings: session.settings });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, term.frame);
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Change the width; resolves once the settled resize rebuilt history at it (never under `preserve`). */
	async function rebuildAfterWidthChange(columns: number): Promise<void> {
		const rebuilt = Promise.withResolvers<void>();
		const off = mode.shell.host!.onFrame(frame => {
			if (frame.reset && !frame.alt && frame.columns === columns) rebuilt.resolve();
		});
		try {
			term.resize(columns, 24);
			await rebuilt.promise;
		} finally {
			off();
		}
	}

	it("applies a change made while the session runs to the next resize", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		const driver = mode.shell.host!.driver;
		expect(driver.replaysOnResize?.()).toBe(true);

		// Setting listeners are coalesced per microtask.
		cfgTuiResizeScrollback.set(mode.settings, "preserve");
		await Promise.resolve();
		expect(driver.replaysOnResize?.()).toBe(false);

		cfgTuiResizeScrollback.set(mode.settings, "rebuild");
		await Promise.resolve();
		expect(driver.replaysOnResize?.()).toBe(true);
		await rebuildAfterWidthChange(80);
	});
});
