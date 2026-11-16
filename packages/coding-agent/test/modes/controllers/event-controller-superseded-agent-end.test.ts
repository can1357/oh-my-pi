import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Loader, TERMINAL } from "@oh-my-pi/pi-tui";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

/**
 * Models the loader lifecycle InteractiveMode owns: `agent_start` creates the
 * loader via `ensureLoadingAnimation`; `agent_end` stops and drops it. The
 * main session's run state and the viewed session's streaming state are
 * mutable flags the tests drive directly.
 */
function createContext(options: { viewSessionIsMain?: boolean } = {}) {
	const streamState = { mainRunActive: false, viewIsStreaming: false };
	const viewed = {
		isCompacting: false,
		getLastAssistantMessage: () => undefined,
		get isStreaming() {
			return streamState.viewIsStreaming;
		},
	};
	const ctx = createInteractiveModeContext({
		session: {
			get isRunActive() {
				return streamState.mainRunActive;
			},
			get isStreaming() {
				return streamState.viewIsStreaming;
			},
		},
		// No override: the helper's `viewSession` getter returns `this.session`,
		// the normal case where the main session is the one on screen.
		viewSession: options.viewSessionIsMain ? undefined : viewed,
	});
	const loader = new Loader(
		ctx.ui,
		text => text,
		text => text,
	);
	vi.spyOn(loader, "stop");
	ctx.ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation ??= loader;
	});
	return { ctx, streamState, loader };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;
const AGENT_END = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;
const DONE_END = {
	type: "agent_end",
	messages: [
		{
			role: "assistant",
			content: [{ type: "text", text: "result" }],
			stopReason: "stop",
			usage: { inputTokens: 0, outputTokens: 0 },
			timestamp: Date.now(),
		},
	],
} as unknown as AgentSessionEvent;

describe("EventController agent_end teardown", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("tears the loader down on the live turn's own final agent_end", async () => {
		const { ctx, loader } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();

		await controller.handleEvent(AGENT_END);

		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
	});

	it("releases the worker's run flag and loader when a focused worker ends while the main session's run goes on", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);

		streamState.viewIsStreaming = true;
		await controller.handleEvent(AGENT_START);
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);

		// The viewed worker finishes; the main session's run keeps going underneath
		// (streaming, or paused awaiting its own jobs).
		streamState.mainRunActive = true;
		streamState.viewIsStreaming = false;
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		await controller.handleEvent(AGENT_END);

		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(false);
		// A stale "Working…" row would otherwise stay under the finished worker.
		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
		// Main's run is not over: program status stays `working`.
		expect(report).not.toHaveBeenCalled();
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();
	});

	it("does not report done when a superseded agent_end lands after the next run opened on the viewed main session", async () => {
		const { ctx, streamState, loader } = createContext({ viewSessionIsMain: true });
		// The main session is on screen here, so the focused-worker teardown
		// branch cannot be what protects the status: the helper's getter makes
		// `viewSession === session` when no viewSession override is supplied.
		const controller = new EventController(ctx);

		streamState.mainRunActive = true;
		streamState.viewIsStreaming = true;
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();

		// This end belongs to the run that just ended, but the serialized
		// dispatch chain delivers it only after another run opened. Rex would
		// play a success sound on the resulting `state=done` mid-run (#17307).
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		await controller.handleEvent(DONE_END);

		expect(report).not.toHaveBeenCalled();
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);
		expect(ctx.loadingAnimation).toBeDefined();
		expect(loader.stop).not.toHaveBeenCalled();
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();

		// The live run's own terminal end still reports done normally.
		streamState.mainRunActive = false;
		streamState.viewIsStreaming = false;
		report.mockClear();
		await controller.handleEvent(DONE_END);
		expect(report).toHaveBeenCalledWith({ state: "done" });
	});

	it("keeps the composer busy for idle auto-compaction and releases it at the end", async () => {
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "idle",
			action: "context-full",
		} as unknown as AgentSessionEvent);
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);

		// An aborted compaction leaves no rebuilt transcript to refill the loader's row.
		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: true,
		} as unknown as AgentSessionEvent);
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(false);
	});

	it("flushes queued command panels at a pause", async () => {
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		// An async fan-out stops the loop without ending the run. Nothing streams
		// now, so any command issued mounts immediately — panels queued during the
		// loop have to mount too, or they render out of order at the run's end.
		await controller.handleEvent({
			type: "agent_pause",
			messages: [],
			yielded: true,
			awaiting: true,
		} as AgentSessionEvent);

		expect(ctx.flushPendingModelSwitch).toHaveBeenCalled();
		expect(ctx.flushPendingCommandOutput).toHaveBeenCalled();
	});
});
