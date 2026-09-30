import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { StartupChangelogSelection } from "@oh-my-pi/pi-coding-agent/utils/changelog";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The startup header is built once, while the auto theme may still be on its
 * dark default guess. When the terminal's OSC 11 reply later reports a light
 * background, the header must repaint in the light palette: a dark-palette
 * accent is near-white and disappears on a light background.
 */

const startupChangelog: StartupChangelogSelection = {
	markdown: "## [9.9.9]\n\n### Fixed\n\n- Something",
	persistCurrentVersion: true,
	truncated: false,
	selectedEntries: 1,
	totalUnseenEntries: 1,
	latestVersion: "9.9.9",
	changeCount: 1,
	categoryCounts: { Fixed: 1 },
};

/** Opening SGR sequence `theme.fg(color, ...)` emits under the active theme. */
function fgPrefix(color: "accent" | "warning"): string {
	const styled = themeModule.theme.fg(color, "\u0001");
	return styled.slice(0, styled.indexOf("\u0001"));
}

describe("InteractiveMode startup header after the terminal reports a light background", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		// Auto theme resolves dark before the terminal's appearance reply arrives.
		themeModule.stopThemeWatcher();
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-startup-header-theme-");
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
		mode = new InteractiveMode(session, "test", startupChangelog);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		themeModule.stopThemeWatcher();
		themeModule.onTerminalAppearanceChange("dark");
		const dark = await themeModule.getThemeByName("dark");
		if (dark) themeModule.setThemeInstance(dark);
	});

	/** Report a light background and resolve once the mode has handled the theme swap. */
	async function switchTerminalToLight(): Promise<void> {
		const epochBefore = themeModule.getThemeEpoch();
		const handled = Promise.withResolvers<void>();
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {
			if (themeModule.getThemeEpoch() !== epochBefore) handled.resolve();
		});
		themeModule.onTerminalAppearanceChange("light", {});
		await handled.promise;
		expect(themeModule.getCurrentThemeName()).toBe("light");
	}

	function renderedLine(text: string): string {
		const line = mode.ui.render(120).find(row => Bun.stripANSI(row).includes(text));
		if (line === undefined) throw new Error(`Expected a rendered row containing ${JSON.stringify(text)}`);
		return line;
	}

	it("recolors the What's New heading", async () => {
		await mode.init();
		const darkAccent = fgPrefix("accent");
		expect(renderedLine("What's New")).toContain(darkAccent);

		await switchTerminalToLight();
		const lightAccent = fgPrefix("accent");
		expect(lightAccent).not.toBe(darkAccent);

		const heading = renderedLine("What's New");
		expect(heading).toContain(lightAccent);
		expect(heading).not.toContain(darkAccent);
	});

	it("recolors a config warning", async () => {
		session.configWarnings.push("theme.dark names a missing theme");
		await mode.init();
		const darkWarning = fgPrefix("warning");
		expect(renderedLine("Warning: theme.dark names a missing theme")).toContain(darkWarning);

		await switchTerminalToLight();
		const lightWarning = fgPrefix("warning");
		expect(lightWarning).not.toBe(darkWarning);

		const warning = renderedLine("Warning: theme.dark names a missing theme");
		expect(warning).toContain(lightWarning);
		expect(warning).not.toContain(darkWarning);
	});
});
