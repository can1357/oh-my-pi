import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import * as theme from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

import {
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
		expect(theme.theme.getSymbolPreset()).toBe("nerd");
	});

	it("routes /settings hide-thinking changes through the shared display resync", async () => {
		// R1 regression: the /settings branch used to flip the flag on children and
		// requestRender(true) only. The stable-row ledger still counted the rows the
		// append-only thinking heads had published to scrollback while streaming, so
		// the block's shorter render was sliced by that count — the live assistant
		// block rendered zero rows (the answer vanished) and retirement wrote nothing
		// to scrollback (permanent loss). It must run the exact same propagation as
		// the Ctrl+T keybinding (#10177).
		const applyThinkingBlockVisibility = vi.spyOn(InputController.prototype, "applyThinkingBlockVisibility");
		const resetStableEmission = vi.spyOn(mode.chatContainer, "resetStableEmission");
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay");

		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();

		expect(mode.hideThinkingBlock).toBe(true);
		// Same helper as Ctrl+T — one propagation, not a second copy that can drift.
		expect(applyThinkingBlockVisibility).toHaveBeenCalledWith(true);
		// The ledger+history rebuild the branch used to skip.
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("keeps the assistant answer in the transcript when /settings hides thinking mid-stream", async () => {
		// R1 end-to-end: hide thinking blocks through the settings path while a turn
		// is still streaming, then finish the turn. The finalized block must still
		// render the answer (the stale-ledger slice would drop it) and must keep the
		// hidden thinking hidden (the reveal resync must not resurrect reasoning).
		type SessionEvent = Parameters<typeof mode.eventController.handleEvent>[0];
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const thinking = {
			type: "thinking" as const,
			thinking: "Deliberating about the request in detail.",
			thinkingSignature: "sig",
		};

		await mode.eventController.handleEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [thinking],
				api: "anthropic-messages",
				provider: "anthropic",
				model: session.model!.id,
				usage,
				timestamp: Date.now(),
			},
		} as unknown as SessionEvent);
		const partial = {
			role: "assistant",
			content: [thinking, { type: "text" as const, text: "Streaming the ANSWER_TAIL_MARKER." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: session.model!.id,
			usage,
			timestamp: Date.now(),
		} as unknown as AssistantMessage;
		await mode.eventController.handleEvent({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "start", partial },
		} as unknown as SessionEvent);

		// Mid-stream hide via the settings path (the R1 trigger).
		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();
		expect(mode.hideThinkingBlock).toBe(true);

		await mode.eventController.handleEvent({
			type: "message_end",
			message: { ...partial, stopReason: "stop" },
		} as unknown as SessionEvent);

		const assistantBlocks = mode.chatContainer.children.filter(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(assistantBlocks.length).toBe(1);
		const rendered = Bun.stripANSI(assistantBlocks[0]!.render(100).join("\n"));
		expect(rendered).toContain("ANSWER_TAIL_MARKER");
		expect(rendered).not.toContain("Deliberating");
	});
});
