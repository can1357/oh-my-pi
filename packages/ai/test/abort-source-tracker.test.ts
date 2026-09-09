import { describe, expect, it } from "bun:test";
import { createAbortSourceTracker } from "@oh-my-pi/pi-ai/utils/abort";

/**
 * Defends the contract `AssistantMessageEventStream` providers depend on: caller
 * aborts always win over local watchdog aborts, regardless of ordering. Without
 * this, a user ESC that lands microseconds after a local idle/first-event
 * watchdog gets mis-classified as a transient timeout, which `agent-session`
 * then routes through `#isRetryableError` and silently auto-retries — leaving
 * the spinner up after the user has already tried to cancel.
 */
describe("createAbortSourceTracker", () => {
	it("reports neither caller nor local abort when nothing fires", () => {
		const tracker = createAbortSourceTracker(new AbortController().signal);
		expect(tracker.wasCallerAbort()).toBe(false);
		expect(tracker.getLocalAbortReason()).toBeUndefined();
	});

	it("reports caller abort when only the caller signal aborts", () => {
		const caller = new AbortController();
		const tracker = createAbortSourceTracker(caller.signal);

		caller.abort();

		expect(tracker.wasCallerAbort()).toBe(true);
		expect(tracker.getLocalAbortReason()).toBeUndefined();
	});

	it("reports local abort when only a local watchdog fires (no caller signal)", () => {
		const tracker = createAbortSourceTracker(undefined);
		const reason = new Error("idle timeout");

		tracker.abortLocally(reason);

		expect(tracker.wasCallerAbort()).toBe(false);
		expect(tracker.getLocalAbortReason()).toBe(reason);
	});

	it("reports local abort when local fires first and caller never aborts", () => {
		const caller = new AbortController();
		const tracker = createAbortSourceTracker(caller.signal);
		const reason = new Error("idle timeout");

		tracker.abortLocally(reason);

		expect(tracker.wasCallerAbort()).toBe(false);
		expect(tracker.getLocalAbortReason()).toBe(reason);
	});

	it("treats local-then-caller as a caller abort and hides the local reason", () => {
		// Race A: watchdog fires, then user presses ESC. The previous heuristic
		// returned wasCallerAbort()=false here because requestSignal.reason was
		// already sealed to the local error — which routed user cancels through
		// the auto-retry transient path.
		const caller = new AbortController();
		const tracker = createAbortSourceTracker(caller.signal);
		const reason = new Error("OpenAI responses stream stalled while waiting for the next event");

		tracker.abortLocally(reason);
		caller.abort();

		expect(tracker.wasCallerAbort()).toBe(true);
		expect(tracker.getLocalAbortReason()).toBeUndefined();
	});

	it("treats caller-then-local as a caller abort and hides the local reason", () => {
		// Race B: user presses ESC, then watchdog fires before the provider's
		// catch block reads tracker state.
		const caller = new AbortController();
		const tracker = createAbortSourceTracker(caller.signal);
		const reason = new Error("OpenAI responses stream timed out while waiting for the first event");

		caller.abort();
		tracker.abortLocally(reason);

		expect(tracker.wasCallerAbort()).toBe(true);
		expect(tracker.getLocalAbortReason()).toBeUndefined();
	});

	it("propagates local aborts onto the merged request signal", () => {
		const caller = new AbortController();
		const tracker = createAbortSourceTracker(caller.signal);
		const reason = new Error("idle timeout");

		tracker.abortLocally(reason);

		expect(tracker.requestSignal.aborted).toBe(true);
	});
});
