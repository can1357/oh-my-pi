import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
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
import { cfgHideThinkingBlock, cfgProseOnlyThinking } from "@oh-my-pi/pi-coding-agent/session/settings";

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
		// Thinking on, so the raw preference flip below also flips the effective
		// visibility every component renders by — that is the #10177 path this
		// guards (a raw flip that leaves the effective value alone must skip the
		// replay; see the test below).
		session.setThinkingLevel(ThinkingLevel.High);
		await Promise.resolve();
		expect(mode.effectiveHideThinkingBlock).toBe(false);
		const resetStableEmission = vi.spyOn(mode.chatContainer, "resetStableEmission");
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay");

		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();

		expect(mode.hideThinkingBlock).toBe(true);
		// The ledger+history rebuild the branch used to skip.
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not replay the terminal when a hide-thinking preference flip leaves visibility hidden", async () => {
		// Regression: an on-disk reload or programmatic update flipped the raw
		// hideThinkingBlock preference while thinking was off and the session had
		// produced no displayable reasoning, so effectiveHideThinkingBlock stayed
		// hidden on both sides of the update. The batch compared the raw
		// preference and ran the full propagation anyway: resetStableEmission
		// forgot the stable rows every rendered block had published to scrollback
		// and ui.resetDisplay() cleared and replayed the whole terminal — an
		// avoidable stall/flicker on a long transcript for a change nothing
		// observes. The preference must still persist; only the destructive
		// replay must go away.
		session.setThinkingLevel(ThinkingLevel.Off);
		await Promise.resolve();
		expect(mode.effectiveHideThinkingBlock).toBe(true);
		const resetStableEmission = vi.spyOn(mode.chatContainer, "resetStableEmission");
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay");

		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();
		expect(mode.hideThinkingBlock).toBe(true);

		// Same no-op in the other direction: the persisted preference flips back
		// while thinking is still hidden.
		cfgHideThinkingBlock.set(session.settings, false);
		await Promise.resolve();

		expect(mode.hideThinkingBlock).toBe(false);
		expect(cfgHideThinkingBlock.get(session.settings)).toBe(false);
		expect(resetStableEmission).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
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
		const rendered = Bun.stripANSI(
			mode.chatContainer.renderViewport(80, 40, { tick: 1, now: Date.now() }).join("\n"),
		);
		expect(rendered).toContain("ANSWER_TAIL_MARKER");
		expect(rendered).not.toContain("Deliberating");
		// The propagation forgets the emission ledger, so the replay re-renders the
		// head under the new visibility instead of slicing it by the stale count.
		expect(mode.chatContainer.emittedStableRows()).toEqual([0]);
	});

	it("does not replay the terminal when a prose-only preference update carries no change", async () => {
		// The ledger reset for proseOnlyThinking is value-guarded against the mode's
		// cached field, but the display reset below it was gated only on the snapshot
		// diff. The two disagree whenever the mode's field already holds the value the
		// snapshot is landing on: the constructor resolves the setting when the mode is
		// built while the coalesced listener only subscribes later in init(), so a
		// settings layer resolving in between leaves the mode's field ahead of the
		// listener's snapshot. Such a batch then skipped the ledger reset and still ran
		// ui.resetDisplay(), clearing and replaying the whole terminal for a change
		// nothing observes — a stall/flicker on a long transcript at every settings
		// reload — and it did so without the stable-emission ledger the replay has to
		// be paired with.
		expect(mode.proseOnlyThinking).toBe(true);
		// Thinking must be visible for the flip to be observable at all: a hidden
		// thinking block renders no rows, so the prose mode changes nothing on
		// screen and owes no replay (see the test below).
		session.setThinkingLevel(ThinkingLevel.High);
		await Promise.resolve();
		expect(mode.effectiveHideThinkingBlock).toBe(false);
		const resetStableEmission = vi.spyOn(mode.chatContainer, "resetStableEmission");
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay");

		// A real flip establishes the one propagation the toggle owes.
		cfgProseOnlyThinking.set(session.settings, false);
		await Promise.resolve();
		expect(mode.proseOnlyThinking).toBe(false);
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);

		// The mode's field runs ahead of the listener's snapshot, so the batch below
		// diffs on the snapshot while the mode already renders the value it lands on.
		mode.proseOnlyThinking = true;
		cfgProseOnlyThinking.set(session.settings, true);
		await Promise.resolve();
		expect(mode.proseOnlyThinking).toBe(true);
		expect(cfgProseOnlyThinking.get(session.settings)).toBe(true);
		// Nothing observes a difference, so the batch owes nothing — in particular not
		// a replay the ledger reset cannot back up.
		expect(resetStableEmission).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not replay the terminal when a prose-only change lands while thinking is hidden", async () => {
		// A hidden thinking block renders no rows, so the prose mode changes
		// nothing on screen: it only decides how a block is formatted if it is
		// shown later. The branch used to reset the stable-emission ledger and
		// replay the terminal anyway, clearing and re-rendering an arbitrarily
		// long transcript for a change nothing observes — the same stall/flicker
		// the adjacent effective-visibility guard avoids. The component state must
		// still carry the new mode, but the destructive replay must wait until
		// thinking is visible.
		session.setThinkingLevel(ThinkingLevel.Off);
		await Promise.resolve();
		expect(mode.effectiveHideThinkingBlock).toBe(true);
		const resetStableEmission = vi.spyOn(mode.chatContainer, "resetStableEmission");
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay");

		cfgProseOnlyThinking.set(session.settings, false);
		await Promise.resolve();

		// The preference lands on the mode and its components...
		expect(mode.proseOnlyThinking).toBe(false);
		expect(cfgProseOnlyThinking.get(session.settings)).toBe(false);
		// ...but nothing is replayed for a change no row can show.
		expect(resetStableEmission).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("resets the stable ledger when prose-only thinking changes mid-stream", async () => {
		// When proseOnlyThinking changes while an assistant block has emitted stable
		// thinking rows but has not yet retired, the destructive replay must reset
		// the stable ledger and resync the live reveal BEFORE the paired display
		// reset. Without the ledger reset, the emitted snapshots describe the old
		// raw/prose layout while the display reset renders the new layout, so the
		// container slices the block by the old prefix height — a raw-to-prose
		// shrink can slice past the answer and retirement then permanently omits it.
		type SessionEvent = Parameters<typeof mode.eventController.handleEvent>[0];
		cfgDisplaySmoothStreaming.set(session.settings, false);
		// Stream in raw mode so the append-only head publishes the full fence;
		// the toggle below shrinks it back to prose.
		cfgProseOnlyThinking.set(session.settings, false);
		await Promise.resolve();
		expect(mode.proseOnlyThinking).toBe(false);
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
			// Raw mode renders this fence in full, so the append-only head publishes
			// many stable rows while it streams; prose mode collapses the fence to a
			// trailing ellipsis, which is the raw-to-prose shrink that makes the
			// stale emitted count slice past the answer.
			thinking: [
				"Deliberating about the request in detail.",
				"```python",
				"def solve(n):",
				"    if n <= 1:",
				"        return n",
				"    return solve(n - 1) + solve(n - 2)",
				"```",
				"Checking the result once more.",
			].join("\n\n"),
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

		// Retire the append-only thinking head into native history so the
		// container's ledger records the rows the head had already emitted.
		const published = mode.chatContainer.peekFinalizedBatch(80, 1);
		expect(published).toBeDefined();
		expect(published!.rows.length).toBeGreaterThan(0);
		mode.chatContainer.acknowledgeFinalizedBatch(published!.id);
		expect(mode.chatContainer.emittedStableRows()[0]!).toBeGreaterThan(0);

		// Mid-stream prose-only change via the settings path: raw back to prose is
		// the shrink direction.
		cfgProseOnlyThinking.set(session.settings, true);
		await Promise.resolve();
		expect(mode.proseOnlyThinking).toBe(true);

		await mode.eventController.handleEvent({
			type: "message_end",
			message: { ...partial, stopReason: "stop" },
		} as unknown as SessionEvent);

		// The answer must still be visible — the ledger reset prevents the stale
		// emitted-row count from slicing past it.
		const rendered = Bun.stripANSI(
			mode.chatContainer.renderViewport(80, 40, { tick: 1, now: Date.now() }).join("\n"),
		);
		expect(rendered).toContain("ANSWER_TAIL_MARKER");
		// The propagation forgets the emission ledger, so the replay re-renders
		// the head under the new prose mode instead of slicing by the stale count.
		expect(mode.chatContainer.emittedStableRows()).toEqual([0]);
	});

	it("resets the stable ledger when prose-only thinking changes after message_end", async () => {
		// Same regression as the mid-stream case, one boundary later: #handleMessageEnd
		// clears streamingComponent/streamingMessage the moment the turn ends, but the
		// finalized assistant entry stays in the transcript — with the stable rows
		// its append-only thinking head published — until it retires. A prose-only
		// toggle in that window must still reset the ledger: without it the paired
		// display reset replays the entry under the new prose mode while slicing it
		// by the old prefix height, so a raw-to-prose shrink cuts past the answer
		// and retirement omits it permanently.
		type SessionEvent = Parameters<typeof mode.eventController.handleEvent>[0];
		cfgDisplaySmoothStreaming.set(session.settings, false);
		// Start in raw mode so the append-only head publishes the full reasoning
		// while it streams; the toggle below shrinks it back to prose.
		cfgProseOnlyThinking.set(session.settings, false);
		await Promise.resolve();
		expect(mode.proseOnlyThinking).toBe(false);
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
			// Raw mode renders this fence in full, so the append-only head publishes
			// many stable rows while it streams; prose mode collapses the fence to a
			// trailing ellipsis, so the toggle below is the raw-to-prose shrink that
			// makes the stale emitted count slice past the answer.
			thinking: [
				"Deliberating about the request in detail.",
				"```python",
				"def solve(n):",
				"    if n <= 1:",
				"        return n",
				"    return solve(n - 1) + solve(n - 2)",
				"```",
				"Checking the result once more.",
			].join("\n\n"),
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

		// Retire the append-only thinking head into native history so the
		// container's ledger records the rows the head had already emitted.
		const published = mode.chatContainer.peekFinalizedBatch(80, 1);
		expect(published).toBeDefined();
		expect(published!.rows.length).toBeGreaterThan(0);
		mode.chatContainer.acknowledgeFinalizedBatch(published!.id);
		expect(mode.chatContainer.emittedStableRows()[0]!).toBeGreaterThan(0);

		// End the turn: the controller drops both streaming fields here, which is
		// exactly the window this regression lives in.
		await mode.eventController.handleEvent({
			type: "message_end",
			message: { ...partial, stopReason: "stop" },
		} as unknown as SessionEvent);
		expect(mode.streamingComponent).toBeUndefined();
		expect(mode.streamingMessage).toBeUndefined();

		// Prose-only on, after message_end but before the entry retires: the
		// raw-to-prose shrink is what makes the stale emitted count slice past
		// the answer.
		cfgProseOnlyThinking.set(session.settings, true);
		await Promise.resolve();
		expect(mode.proseOnlyThinking).toBe(true);

		const rendered = Bun.stripANSI(
			mode.chatContainer.renderViewport(80, 40, { tick: 1, now: Date.now() }).join("\n"),
		);
		expect(rendered).toContain("ANSWER_TAIL_MARKER");
		// The ledger was forgotten even with no live stream, so the replay
		// re-renders the head under prose mode instead of slicing it away.
		expect(mode.chatContainer.emittedStableRows()).toEqual([0]);
	});
});
