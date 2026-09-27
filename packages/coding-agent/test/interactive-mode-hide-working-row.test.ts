import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayHideWorkingRow } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode hide-working-row setting", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-hide-working-row-");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true, "statusLine.preset": "custom" },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function renderWorkingRow(): string {
		return stripVTControlCharacters(mode.statusContainer.render(120).join("\n")).trim();
	}

	it("mounts the working row with the interrupt keycap by default", () => {
		mode.ensureLoadingAnimation();
		expect(mode.loadingAnimation).toBeDefined();
		const rendered = renderWorkingRow();
		const keycap = appKey(mode.keybindings, "app.interrupt");
		expect(rendered).toContain(keycap);
		expect(rendered).toContain("Working");
		expect(mode.statusRowOccupied).toBe(true);
	});

	it("keeps the row unmounted when display.hideWorkingRow is on", () => {
		cfgDisplayHideWorkingRow.set(session.settings, true);
		mode.ensureLoadingAnimation();
		expect(mode.loadingAnimation).toBeUndefined();
		expect(renderWorkingRow()).toBe("");
		expect(mode.statusRowOccupied).toBe(false);
		// Working messages arriving mid-turn must not resurrect the row.
		mode.setWorkingMessage("Thinking harder");
		mode.ensureLoadingAnimation();
		expect(mode.loadingAnimation).toBeUndefined();
		expect(renderWorkingRow()).toBe("");
	});

	it("retires a live row when the setting is toggled on mid-turn", async () => {
		mode.ensureLoadingAnimation();
		expect(mode.loadingAnimation).toBeDefined();
		cfgDisplayHideWorkingRow.set(session.settings, true);
		// Live-settings listener is coalesced onto a microtask.
		await Promise.resolve();
		expect(mode.loadingAnimation).toBeUndefined();
		expect(renderWorkingRow()).toBe("");
		expect(mode.statusRowOccupied).toBe(false);
	});

	it("remounts the row on the next submission after the setting is turned off", async () => {
		cfgDisplayHideWorkingRow.set(session.settings, true);
		await Promise.resolve();
		mode.ensureLoadingAnimation();
		expect(mode.loadingAnimation).toBeUndefined();
		cfgDisplayHideWorkingRow.set(session.settings, false);
		await Promise.resolve();
		mode.ensureLoadingAnimation();
		expect(mode.loadingAnimation).toBeDefined();
		expect(renderWorkingRow()).toContain("Working");
		expect(mode.statusRowOccupied).toBe(true);
	});

	it("keeps the interrupt binding present while the row is hidden", () => {
		cfgDisplayHideWorkingRow.set(session.settings, true);
		mode.ensureLoadingAnimation();
		// The keycap row is display-only; the binding is captured on the editor
		// independent of the row, so interruption keeps working when hidden.
		expect(mode.keybindings.getKeys("app.interrupt").length).toBeGreaterThan(0);
	});
});
