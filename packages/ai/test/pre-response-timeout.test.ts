import { afterEach, describe, expect, it, vi } from "bun:test";
import { armPreResponseTimeout } from "@oh-my-pi/pi-ai/utils/idle-iterator";

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
