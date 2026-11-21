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

	it("releases the worker's loader when a focused worker ends while the main session's run goes on", async () => {
		const { ctx, streamState, loader } = createContext();
		const controller = new EventController(ctx);

		streamState.viewIsStreaming = true;
		await controller.handleEvent(AGENT_START);

		// The viewed worker finishes; the main session's run keeps going underneath
		// (streaming, or paused awaiting its own jobs).
		streamState.mainRunActive = true;
		streamState.viewIsStreaming = false;
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		await controller.handleEvent(AGENT_END);

		// A stale "Working…" row would otherwise stay under the finished worker.
		expect(loader.stop).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
		// Main's run is not over: program status stays `working`.
		expect(report).not.toHaveBeenCalled();
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();
	});

	it("does not report done for a stale agent_end but still tears the ended run down when the next run opened on the viewed main session", async () => {
		const { ctx, streamState, loader } = createContext({ viewSessionIsMain: true });
		// The main session is on screen here, so the focused-worker teardown
		// branch cannot be what protects the status: the helper's getter makes
		// `viewSession === session` when no viewSession override is supplied.
		const controller = new EventController(ctx);

		// Run 1 starts and owns the loader / composer activity.
		streamState.mainRunActive = true;
		streamState.viewIsStreaming = true;
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();

		// Real chain order: #checkRun closes run 1 and emits its (stale)
		// agent_end, then #drainStrandedQueuedMessages opens run 2 before the
		// serialized dispatch chain delivers that end. So `isRunActive` is true
		// again when the controller handles the stale end. Run 2's own
		// agent_start follows in the chain — it is NOT dispatched before it.
		streamState.mainRunActive = false; // #checkRun closes run 1
		streamState.mainRunActive = true; // #drainStrandedQueuedMessages opens run 2
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		await controller.handleEvent(DONE_END);

		// No mid-run `done` for Rex / OSC 7501 ...
		expect(report).not.toHaveBeenCalled();
		// ... but the ended run still got its full teardown, not a blanket skip.
		expect(ctx.flushPendingModelSwitch).toHaveBeenCalled();
		expect(loader.stop).toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(TERMINAL.sendNotification).toHaveBeenCalled();

		// Run 2's agent_start follows the stale end and re-arms the live run.
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();

		// The live run's own terminal end still reports done normally.
		streamState.mainRunActive = false;
		streamState.viewIsStreaming = false;
		report.mockClear();
		await controller.handleEvent(DONE_END);
		expect(report).toHaveBeenCalledWith({ state: "done" });
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
