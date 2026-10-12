import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as theme from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

import {
	cfgDisplaySmoothStreaming,
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
		expect(theme.getSymbolPresetOverride()).toBe("nerd");
	});

	it("routes /settings hide-thinking changes through the shared display resync", async () => {
		// /settings regression: the branch used to flip the flag on children and
		// requestRender(true) only. The stable-row ledger still counted the rows the
		// append-only thinking heads had published to scrollback while streaming, so
		// the block's shorter render was sliced by that count — the live assistant
		// block rendered zero rows (the answer vanished) and retirement wrote nothing
		// to scrollback (permanent loss). It must run the exact same propagation as
		// the Ctrl+T keybinding (#10177).
		const resetStableEmission = vi.spyOn(mode.chatContainer, "resetStableEmission");
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay");

		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();

		expect(mode.hideThinkingBlock).toBe(true);
		// The ledger+history rebuild the branch used to skip.
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("keeps the assistant answer in the transcript when /settings hides thinking mid-stream", async () => {
		// /settings regression (#10177), end to end: hide thinking blocks through the
		// settings path while a turn is still streaming, then finish the turn. The
		// finalized block must still render the answer (the stale-ledger slice would
		// drop it) and must keep the hidden thinking hidden (the reveal resync must
		// not resurrect reasoning).
		type SessionEvent = Parameters<typeof mode.eventController.handleEvent>[0];
		// The smooth reveal paces the streamed text on an interval, so the live head
		// would still be revealing when this test drives the ledger; turning the
		// pacing off renders the same content immediately and keeps the assertions
		// free of wall-clock waits.
		cfgDisplaySmoothStreaming.set(session.settings, false);
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
			// Long enough that the append-only head publishes many stable rows while
			// thinking is still visible; that emitted count is what a path skipping
			// the ledger reset would slice the shorter render by.
			thinking: Array.from(
				{ length: 10 },
				(_, index) => `Deliberating about the request in detail, step ${index + 1} of a long reasoning chain.`,
			).join("\n\n"),
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

		// Retire the append-only thinking head into native history exactly as a
		// pressured frame does, so the container's ledger records the rows the
		// head had already emitted while thinking was still visible.
		const published = mode.chatContainer.peekFinalizedBatch(80, 1);
		expect(published).toBeDefined();
		expect(published!.rows.length).toBeGreaterThan(0);
		mode.chatContainer.acknowledgeFinalizedBatch(published!.id);
		expect(mode.chatContainer.emittedStableRows()[0]!).toBeGreaterThan(0);

		// Mid-stream hide via the settings path (the /settings trigger).
		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();
		expect(mode.hideThinkingBlock).toBe(true);

		await mode.eventController.handleEvent({
			type: "message_end",
			message: { ...partial, stopReason: "stop" },
		} as unknown as SessionEvent);

		// Container-level viewport rows: only the container applies the emitted-row
		// count to a block's render, so this is where a skipped ledger reset drops
		// the answer.
		const rendered = Bun.stripANSI(mode.chatContainer.renderViewport(80, 40, { tick: 1, now: Date.now() }).join("\n"));
		expect(rendered).toContain("ANSWER_TAIL_MARKER");
		expect(rendered).not.toContain("Deliberating");
		// The propagation forgets the emission ledger, so the replay re-renders the
		// head under the new visibility instead of slicing it by the stale count.
		expect(mode.chatContainer.emittedStableRows()).toEqual([0]);
	});
});
