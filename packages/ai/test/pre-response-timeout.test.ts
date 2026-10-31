import { afterEach, describe, expect, it, vi } from "bun:test";
import { armPreResponseTimeout, preResponseGuard } from "@oh-my-pi/pi-ai/utils/idle-iterator";

/**
 * Regression for the issue #2422 follow-up: the streaming providers (Codex SSE,
 * Bedrock, Gemini CLI, Ollama) used to hand `AbortSignal.timeout(firstEventMs)`
 * to `fetch` as a "pre-response" guard. That signal is an *absolute* wall-clock
 * deadline and stays bound to the request after headers arrive, so it aborted an
 * actively-streaming body (e.g. a large `write` tool call) with
 * `TimeoutError: The operation timed out.` even while deltas were flowing — a
 * `fetch` signal governs the whole request lifecycle, including the body stream.
 *
 * `armPreResponseTimeout` arms a *clearable* timer that callers disarm the
 * instant `fetchWithRetry` resolves (headers in), leaving the body to the
 * iterator-level idle watchdog. The deadline is a plain `setTimeout`, so these
 * tests drive it with fake timers — the contract is "signal aborts at the
 * deadline unless cleared", which needs no real time or network.
 */
describe("armPreResponseTimeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("passes the caller signal through unchanged when no positive timeout is configured", () => {
		const caller = new AbortController().signal;
		expect(armPreResponseTimeout(caller, undefined).signal).toBe(caller);
		expect(armPreResponseTimeout(caller, 0).signal).toBe(caller);
		expect(armPreResponseTimeout(caller, -5).signal).toBe(caller);
		expect(armPreResponseTimeout(undefined, undefined).signal).toBeUndefined();
	});

	it("aborts at the deadline with a TimeoutError when never cleared", () => {
		vi.useFakeTimers();
		const { signal } = armPreResponseTimeout(undefined, 50);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(49);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal?.aborted).toBe(true);
		const reason = signal?.reason as DOMException;
		expect(reason.name).toBe("TimeoutError");
		expect(reason.message).toBe("The operation timed out.");
	});

	it("never aborts once cleared, even long past the deadline", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 50);
		clear(); // headers arrived — disarm before the body streams
		vi.advanceTimersByTime(10_000);
		expect(signal?.aborted).toBe(false);
	});

	it("combines the caller signal so a caller abort still cancels after clearing", () => {
		const caller = new AbortController();
		const { signal, clear } = armPreResponseTimeout(caller.signal, 60_000);
		clear();
		expect(signal).toBeDefined();
		expect(signal!.aborted).toBe(false);
		caller.abort(new Error("caller cancelled"));
		expect(signal!.aborted).toBe(true);
		expect((signal!.reason as Error).message).toBe("caller cancelled");
	});
});

/**
 * The budget is a stopwatch the transport stops while it prepares a request and
 * while it is parked on a caller's dispatch hold (`/pause`), and starts again at
 * the wire with what is left. Two properties follow, and both are load-bearing:
 * a hold a human releases must not consume the provider's first-byte budget,
 * and a caller that reuses one guard across its own retries (Gemini CLI hands
 * `watchdog.signal` to `fetchWithRetry`) must not get a fresh budget per
 * attempt — that is how a 90 ms first-event budget became 194 ms of waiting.
 */
describe("pre-response budget", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not spend the budget while the transport is suspended", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 60);
		const budget = preResponseGuard(signal);
		expect(budget).toBeDefined();
		budget?.suspend();
		vi.advanceTimersByTime(10_000);
		expect(signal?.aborted).toBe(false);
		budget?.resume();
		vi.advanceTimersByTime(59);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal?.aborted).toBe(true);
		clear();
	});

	it("spends one budget across every attempt the guard covers", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 120);
		const budget = preResponseGuard(signal);
		// Attempt one: 80 ms of wire time, then a retry backoff off the clock.
		budget?.suspend();
		budget?.resume();
		vi.advanceTimersByTime(80);
		budget?.suspend();
		vi.advanceTimersByTime(5_000);
		expect(signal?.aborted).toBe(false);
		// Attempt two gets the 40 ms that are left, not another 120 ms.
		budget?.resume();
		vi.advanceTimersByTime(39);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal?.aborted).toBe(true);
		clear();
	});

	it("expires at the wire when the budget is already spent", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 20);
		const budget = preResponseGuard(signal);
		// Wall time the armed timer did not get to observe (a blocked loop, a
		// suspended machine): the stopwatch still charges it to the budget.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 50);
		budget?.suspend();
		budget?.resume();
		expect(signal?.aborted).toBe(true);
		expect((signal?.reason as DOMException | undefined)?.name).toBe("TimeoutError");
		clear();
	});

	it("stays disarmed after clear, whatever the transport does next", () => {
		vi.useFakeTimers();
		const { signal, clear } = armPreResponseTimeout(undefined, 30);
		const budget = preResponseGuard(signal);
		clear();
		budget?.suspend();
		budget?.resume();
		vi.advanceTimersByTime(10_000);
		expect(signal?.aborted).toBe(false);
	});
});
