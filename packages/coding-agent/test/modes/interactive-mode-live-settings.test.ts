import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as theme from "@oh-my-pi/pi-tui/theme";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { TempDir } from "@oh-my-pi/pi-utils";

import {
	cfgDisplayReduceMotion,
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

	beforeAll(async () => {
		await theme.initTheme();
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
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.ui.terminal, "onGlyphProtocolReport").mockImplementation(callback => {
			reportGlyphProtocol = callback;
		});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		await theme.setSymbolPreset("unicode");
		vi.restoreAllMocks();
	});

	it("applies status-line and thinking-visibility changes made outside the settings panel", async () => {
		cfgStatusLineLeftSegments.set(session.settings, ["time", "model"]);
		cfgStatusLineContextLine.set(session.settings, "off");
		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();

		const effective = mode.statusLine.getEffectiveSettingsForTest();
		expect(effective.leftSegments).toEqual(["time", "model"]);
		expect(effective.contextLine).toBe("off");
		expect(mode.hideThinkingBlock).toBe(true);
	});

	it("stops and resumes an active thinking pulse through the live settings subscription", async () => {
		// Stop terminal I/O while retaining the settings subscription and component tree.
		mode.ui.stop();
		vi.useFakeTimers();
		const repaint = vi.fn();
		const thinking = new AssistantMessageComponent(undefined, true, repaint);
		const message = createAssistantMessage("");
		message.content = [{ type: "thinking", thinking: "hidden reasoning" }];
		mode.chatContainer.addChild(thinking);
		try {
			thinking.updateContent(message);
			vi.advanceTimersByTime(100);
			expect(repaint).toHaveBeenCalled();
			cfgDisplayReduceMotion.set(session.settings, "strict");
			await Promise.resolve();
			repaint.mockClear();
			vi.advanceTimersByTime(1000);
			expect(repaint).not.toHaveBeenCalled();
			expect(thinking.render(80).join("\n")).toContain("Thinking");
			cfgDisplayReduceMotion.set(session.settings, "off");
			await Promise.resolve();
			vi.advanceTimersByTime(100);
			expect(repaint).toHaveBeenCalled();
		} finally {
			thinking.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps an explicitly configured unicode status bar after Glyph Protocol confirmation", async () => {
		cfgSymbolPreset.set(session.settings, "unicode");
		await theme.setSymbolPreset("unicode");
		reportGlyphProtocol(true);
		expect(theme.getSymbolPresetOverride()).toBe("unicode");
		expect(theme.theme.getSymbolPreset()).toBe("unicode");
	});

	it("upgrades an unconfigured unicode status bar after Glyph Protocol confirmation", async () => {
		await theme.setSymbolPreset("unicode");
		reportGlyphProtocol(true);
		expect(theme.getSymbolPresetOverride()).toBe("nerd");
	});
});
