import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import {
	abandonToolExecution,
	createToolExecution,
	currentToolExecution,
	isExecutingToolCall,
	onToolExecutionEnd,
	runToolExecution,
} from "../src/tool-context";

describe("tool execution scope", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retires a run whose preparation was abandoned", async () => {
		// The executor prepares the run before it builds the call's context, so a
		// context that throws — or a call cancelled before `execute` — leaves a
		// run nobody will ever enter. Left live, a context that captured it would
		// keep answering for a later run of the same call.
		const owner = {};
		const execution = createToolExecution(owner, "call-1");
		const ends: string[] = [];
		onToolExecutionEnd(execution, () => ends.push("told"));

		abandonToolExecution(execution);

		expect(execution.finished).toBe(true);
		expect(ends).toEqual(["told"]);
		expect(isExecutingToolCall(owner, "call-1")).toBe(false);
		// A second run of the same call is unaffected by the abandoned one.
		await runToolExecution(createToolExecution(owner, "call-1"), async () => {
			expect(currentToolExecution(owner)?.finished).toBe(false);
			expect(isExecutingToolCall(owner, "call-1")).toBe(true);
		});
	});

	it("tells every holder the run ended, and counts it over, when one of them throws", async () => {
		// A holder that fails is its own problem. If its throw stopped the rest,
		// a run would stay counted as live and a stale claim would stay
		// answerable — the run's own bookkeeping cannot depend on its audience.
		// The failure goes to the log, never to stderr, which a TUI or an RPC
		// host owns.
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
		const owner = {};
		const execution = createToolExecution(owner, "call-1");
		const told: string[] = [];
		const failure = new Error("holder failed");
		onToolExecutionEnd(execution, () => {
			told.push("first");
			throw failure;
		});
		onToolExecutionEnd(execution, () => told.push("second"));

		await runToolExecution(execution, async () => {});

		expect(told).toEqual(["first", "second"]);
		expect(execution.finished).toBe(true);
		expect(isExecutingToolCall(owner, "call-1")).toBe(false);
		expect(stderr).not.toHaveBeenCalled();
		expect(logged).toHaveBeenCalledWith(expect.any(String), { error: failure });
	});

	it("refuses a second entry of a run that is still going, and keeps the first one live", async () => {
		// Two entries of one handle would share its end: whichever returned first
		// would mark the run over while the other still runs, and the dialogs it
		// raised would stop naming their call.
		const owner = {};
		const execution = createToolExecution(owner, "call-1");
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let liveAfterRefusal: boolean | undefined;
		const first = runToolExecution(execution, async () => {
			entered.resolve();
			await release.promise;
			liveAfterRefusal = currentToolExecution(owner) === execution;
		});
		await entered.promise;

		await expect(runToolExecution(execution, async () => {})).rejects.toThrow("cannot be entered again");
		expect(execution.finished).toBe(false);
		expect(isExecutingToolCall(owner, "call-1")).toBe(true);

		release.resolve();
		await first;
		expect(liveAfterRefusal).toBe(true);
		expect(execution.finished).toBe(true);
		expect(isExecutingToolCall(owner, "call-1")).toBe(false);
	});

	it("tells a holder at once when the run is already over, and drops it on request", async () => {
		const owner = {};
		const execution = createToolExecution(owner, "call-1");
		const live: string[] = [];
		const drop = onToolExecutionEnd(execution, () => live.push("dropped"));
		drop();
		await runToolExecution(execution, async () => {});
		expect(live).toEqual([]);

		const late: string[] = [];
		onToolExecutionEnd(execution, () => late.push("at once"));
		expect(late).toEqual(["at once"]);
	});
});
