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
function createContext() {
	const streamState = { mainRunActive: false, viewIsStreaming: false };
	const ctx = createInteractiveModeContext({
		session: {
			get isRunActive() {
				return streamState.mainRunActive;
			},
		},
		viewSession: {
			isCompacting: false,
			getLastAssistantMessage: () => undefined,
			get isStreaming() {
				return streamState.viewIsStreaming;
			},
		},
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
