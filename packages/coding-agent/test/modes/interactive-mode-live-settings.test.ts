import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import * as themeService from "@oh-my-pi/pi-coding-agent/ui/theme/service";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createModeTerminal, type ModeTerminal } from "../helpers/mode-terminal";

import {
	cfgGitChildRepoDiscovery,
	cfgStatusLineContextLine,
	cfgStatusLineLeftSegments,
	cfgSymbolPreset,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("InteractiveMode live settings", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let reportGlyphProtocol: (supported: boolean) => void;
	let term: ModeTerminal;

	beforeAll(async () => {
		themeService.initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-live-ui-settings-");
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
		// The terminal's Glyph Protocol reply arrives as a driver capability change.
		term = createModeTerminal();
		await term.start();
		const driver = term.frame.shell.host!.driver;
		const identity = driver.identity;
		let glyphs = false;
		Object.defineProperty(driver, "identity", { configurable: true, get: () => ({ ...identity, glyphs }) });
		const listeners: (() => void)[] = [];
		vi.spyOn(driver, "onCapabilities").mockImplementation(listener => {
			const notify = () => listener(driver.capabilities);
			listeners.push(notify);
			return () => listeners.splice(listeners.indexOf(notify), 1);
		});
		reportGlyphProtocol = supported => {
			glyphs = supported;
			for (const notify of listeners) notify();
		};
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		await themeService.setSymbolPreset("unicode");
		vi.restoreAllMocks();
	});

	it("applies status-line and thinking-visibility changes made outside the settings panel", async () => {
		cfgStatusLineLeftSegments.set(session.settings, ["time", "model"]);
		cfgStatusLineContextLine.set(session.settings, "off");
		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();

		const effective = mode.statusLine.settings();
		expect(effective.leftSegments).toEqual(["time", "model"]);
		expect(effective.contextLine).toBe("off");
		expect(mode.hideThinkingBlock).toBe(true);
	});

	it("invalidates the idle checkout on both child discovery transitions", async () => {
		const invalidate = vi.spyOn(mode.statusLine, "invalidateVcs");
		cfgGitChildRepoDiscovery.set(session.settings, false);
		await Promise.resolve();
		expect(invalidate).toHaveBeenCalledTimes(1);
		cfgGitChildRepoDiscovery.set(session.settings, true);
		await Promise.resolve();
		expect(invalidate).toHaveBeenCalledTimes(2);
	});

	it("coalesces restored agent registrations and renders their final state", async () => {
		const sync = vi.spyOn(mode, "syncRunningSubagentBadge");
		const badge = vi.spyOn(mode.statusLine, "setRunningSubagents");
		const registry = AgentRegistry.global();
		const ids = Array.from({ length: 100 }, (_, index) => `restore-burst-${index}`);
		vi.useFakeTimers();
		try {
			for (const id of ids) {
				registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
			}
			expect(sync).not.toHaveBeenCalled();
			vi.advanceTimersByTime(100);
			expect(sync).toHaveBeenCalledTimes(1);
			expect(badge.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining(ids));
			for (const id of ids) registry.unregister(id);
			vi.advanceTimersByTime(100);
			expect(sync).toHaveBeenCalledTimes(2);
			expect(badge.mock.calls.at(-1)?.[0].some(id => ids.includes(id))).toBe(false);
		} finally {
			vi.useRealTimers();
			for (const id of ids) registry.unregister(id);
		}
	});

	it("keeps an explicitly configured unicode status bar after Glyph Protocol confirmation", async () => {
		cfgSymbolPreset.set(session.settings, "unicode");
		await themeService.setSymbolPreset("unicode");
		reportGlyphProtocol(true);
		expect(themeService.getThemePreferences().symbolPreset).toBe("unicode");
		expect(currentTheme().symbols.preset).toBe("unicode");
	});

	it("upgrades an unconfigured unicode status bar after Glyph Protocol confirmation", async () => {
		await themeService.setSymbolPreset("unicode");
		reportGlyphProtocol(true);
		expect(themeService.getThemePreferences().symbolPreset).toBe("nerd");
	});
});
