import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type WorkingSpec, workingMessage } from "../../../src/ui/dock/working";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

import { cfgTerminalShowProgress } from "@oh-my-pi/pi-coding-agent/modes/settings";

/**
 * The working-row invariant: `agent_start` shows the turn's row
 * (`ensureWorkingRow`); a transient row (auto-compaction, auto-retry) replaces
 * it; once the session streams again the turn's row comes back.
 *
 * The regression: the overlay handlers took the row down but the resumed turn
 * never put "Working…" back while the agent kept streaming.
 */
function createContext(options: { terminalProgress?: boolean } = {}) {
	const streamState = { isStreaming: false };
	if (options.terminalProgress) cfgTerminalShowProgress.set(settings, true);
	const setProgress = vi.fn((_active: boolean) => {});
	const ctx = createInteractiveModeContext({
		setTerminalProgress: setProgress,
		session: {
			get isStreaming() {
				return streamState.isStreaming;
			},
		},
	});
	return { ctx, streamState, setProgress };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;
const AGENT_END = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;
const AGENT_PAUSE = {
	type: "agent_pause",
	messages: [],
	yielded: false,
	awaiting: false,
} as unknown as AgentSessionEvent;
const COMPACTION_START = {
	type: "auto_compaction_start",
	reason: "overflow",
	action: "context-full",
} as unknown as AgentSessionEvent;
const COMPACTION_END = {
	type: "auto_compaction_end",
	action: "context-full",
	result: { summary: "s", shortSummary: "s", tokensBefore: 10, details: {}, firstKeptEntryId: undefined },
	willRetry: true,
} as unknown as AgentSessionEvent;

const RETRY_START = {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 1000,
	errorMessage: "overloaded",
} as unknown as AgentSessionEvent;
const TASK_TOOL_EXECUTION_END = {
	type: "tool_execution_end",
	toolCallId: "call-task-1",
	toolName: "task",
	args: {},
	result: { content: [], details: {} },
	isError: false,
} as unknown as AgentSessionEvent;

describe("EventController loader recovery after overflow maintenance", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.useFakeTimers();
	});

	afterEach(() => {
		setSystemTime();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("re-shows the Working… row after auto-compaction recovers and streams a new turn", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);

		// Turn 1 begins: the working row shows.
		await controller.handleEvent(AGENT_START);
		expect(ctx.working).toBe("turn");

		// Overflow recovery hands the status row to auto-compaction. The original
		// turn's agent_end is held while the prompt is in flight, so the session
		// keeps reporting streaming throughout.
		streamState.isStreaming = true;
		await controller.handleEvent(COMPACTION_START);
		expect(ctx.working).toBe("compaction");

		await controller.handleEvent(COMPACTION_END);
		// The session still streams: the turn's row comes back right away.
		expect(ctx.working).toBe("turn");

		// The retry continuation starts a fresh turn and keeps it.
		await controller.handleEvent(AGENT_START);
		expect(ctx.working).toBe("turn");
	});

	it("re-shows the Working… row after an auto-retry resumes the turn", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(ctx.working).toBe("turn");

		// A transient error: the retry countdown takes over the status row.
		streamState.isStreaming = true;
		await controller.handleEvent(RETRY_START);
		expect(ctx.working).toBe("retry");

		// The retry attempt re-enters the agent loop, emitting a fresh agent_start.
		await controller.handleEvent(AGENT_START);
		expect(ctx.working).toBe("turn");
	});

	it("counts the auto-retry wait down from the attempt's start", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);
		setSystemTime(1_000_000);

		streamState.isStreaming = true;
		await controller.handleEvent(RETRY_START);
		expect(ctx.working).toBe("retry");
		const showWorking = ctx.showWorking as unknown as { mock: { calls: [string, WorkingSpec][] } };
		const spec = showWorking.mock.calls.at(-1)![1];
		expect(spec.variant).toEqual({ kind: "retry", attempt: 1, max: 3, delayMs: 1000, reason: "overloaded" });
		expect(spec.interruptKey).toBe("escape");
		const line = (now: number) => workingMessage(spec, now, key => key);

		// The row shows the full delay at first, then what remains, clamped at zero.
		expect(line(spec.startedAt)).toContain("Retrying (1/3) in 1.0s");
		expect(line(spec.startedAt + 400)).toContain("in 600ms");
		expect(line(spec.startedAt + 2_400)).toContain("in 0ms");
	});

	it("re-shows the Working… row after a subagent task completes while the session keeps streaming", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(ctx.working).toBe("turn");

		// A transient row took the working row down mid-tool; the session is
		// still streaming when the subagent's task completes. `tool_execution_end`
		// (like `_update`) must put the row back, or the UI looks idle while the
		// agent keeps going.
		streamState.isStreaming = true;
		ctx.clearWorking();

		await controller.handleEvent(TASK_TOOL_EXECUTION_END);

		expect(ctx.working).toBe("turn");
	});

	it("does not re-arm the Working… row on tool_execution_end once the session has stopped streaming", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		ctx.clearWorking();
		streamState.isStreaming = false;

		await controller.handleEvent(TASK_TOOL_EXECUTION_END);

		// No streaming → the reconciler stays a no-op; a working row is not the
		// post-turn idle state.
		expect(ctx.working).toBeUndefined();
	});

	it("keeps OSC 9;4 progress on through auto-compaction inside a live turn", async () => {
		const { ctx, setProgress } = createContext({ terminalProgress: true });
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(COMPACTION_START);
		await controller.handleEvent(COMPACTION_END);
		// Clearing here would tell Tern the agent finished while it keeps working.
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true]);

		// The overflow retry's own agent_start/agent_end bracket ends the busy state once.
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(AGENT_END);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false]);
	});

	it("brackets OSC 9;4 progress around auto-compaction outside a turn", async () => {
		const { ctx, setProgress } = createContext({ terminalProgress: true });
		const controller = new EventController(ctx);

		await controller.handleEvent(COMPACTION_START);
		await controller.handleEvent(COMPACTION_END);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false]);
	});

	it("leaves OSC 9;4 progress to a turn that starts during auto-compaction", async () => {
		const { ctx, setProgress } = createContext({ terminalProgress: true });
		const controller = new EventController(ctx);

		await controller.handleEvent(COMPACTION_START);
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(COMPACTION_END);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true]);

		await controller.handleEvent(AGENT_END);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false]);
	});

	it("keeps OSC 9;4 progress through a pause and ends it when an abort ends the run before the retry starts", async () => {
		const { ctx, setProgress } = createContext({ terminalProgress: true });
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(COMPACTION_START);
		await controller.handleEvent(COMPACTION_END);
		// Recovery scheduled the retry, so the overflowed loop pauses.
		await controller.handleEvent(AGENT_PAUSE);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true]);

		// Esc cancels the scheduled retry: the session ends the run.
		await controller.handleEvent(AGENT_END);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false]);
	});

	it("leaves OSC 9;4 progress to a scheduled continuation that does start", async () => {
		const { ctx, setProgress } = createContext({ terminalProgress: true });
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(AGENT_PAUSE);
		await controller.handleEvent(AGENT_START);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true]);

		await controller.handleEvent(AGENT_END);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false]);
	});

	it("reports OSC 9;4 activity to Tern even when the setting is off", async () => {
		const program = Bun.env.TERM_PROGRAM;
		try {
			Bun.env.TERM_PROGRAM = "vscode";
			const outside = createContext();
			await new EventController(outside.ctx).handleEvent(AGENT_START);
			expect(outside.setProgress).not.toHaveBeenCalled();

			Bun.env.TERM_PROGRAM = "tern";
			const { ctx, setProgress } = createContext();
			const controller = new EventController(ctx);
			await controller.handleEvent(AGENT_START);
			await controller.handleEvent(AGENT_END);
			expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false]);
		} finally {
			if (program === undefined) delete Bun.env.TERM_PROGRAM;
			else Bun.env.TERM_PROGRAM = program;
		}
	});
});
