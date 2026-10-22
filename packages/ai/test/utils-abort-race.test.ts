/**
 * Contract tests for `raceWithSignal` (published as `raceSignal` from
 * `@oh-my-pi/pi-ai/auth/abort`).
 *
 * A caller-supplied `message` — including `""` — becomes the text of a fresh
 * `AbortError`; only an omitted message surfaces the signal's own reason. Reading
 * the message with a truthiness check instead of `!== undefined` leaks the
 * signal's reason whenever the caller passes `""`, which loses the caller's abort
 * text and, because `AbortController.abort()` with no argument sets a
 * `DOMException` reason carrying no `Flag.Abort`, silently downgrades the
 * classification that retry routing (`classify` + `Flag.Abort`) depends on — a
 * cancelled stream then looks transient and gets retried.
 *
 * `raceWithSignal` builds its rejection at two independent sites (the
 * `signal.aborted` early reject and the `onAbort` listener), so each message case
 * runs through both.
 */
import { describe, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { raceSignal } from "@oh-my-pi/pi-ai/auth/abort";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";

/** Each row races a promise that never settles, aborted through one rejection site. */
const sites: Array<[string, (message?: string, reason?: unknown) => Promise<unknown>]> = [
	[
		"signal already aborted",
		(message, reason) => {
			const controller = new AbortController();
			controller.abort(reason);
			return raceWithSignal(Promise.withResolvers<never>().promise, controller.signal, message).catch(
				(err: unknown) => err,
			);
		},
	],
	[
		"signal aborts mid-race",
		(message, reason) => {
			const controller = new AbortController();
			const raced = raceWithSignal(Promise.withResolvers<never>().promise, controller.signal, message);
			controller.abort(reason);
			return raced.catch((err: unknown) => err);
		},
	],
];

describe.each(sites)("raceWithSignal abort classification (%s)", (_site, rejectFrom) => {
	test("carries a non-empty caller message on a fresh AbortError", async () => {
		const error = await rejectFrom("usage fetch aborted");
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect((error as Error).message).toBe("usage fetch aborted");
		expect(AIError.is(AIError.classify(error), AIError.Flag.Abort)).toBe(true);
	});

	test("treats an empty-string message as a caller-supplied message, not an absent one", async () => {
		// `""` means "cancelled, no text". Falling through to the signal's reason
		// returns a `DOMException`, which carries no `Flag.Abort`, so retry routing
		// re-submits a request the caller already cancelled.
		const error = await rejectFrom("");
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect((error as Error).message).toBe("");
		expect(AIError.is(AIError.classify(error), AIError.Flag.Abort)).toBe(true);
	});

	test("surfaces the signal's own reason when no message is supplied", async () => {
		// A watchdog that aborts with its own error must keep that identity: callers
		// distinguish a timeout from a user cancel by the surfaced reason.
		const reason = new AIError.AbortError("provider watchdog fired");
		expect(await rejectFrom(undefined, reason)).toBe(reason);
	});

	test("falls back to a default AbortError when no message and no reason exist", async () => {
		// `abort(null)` leaves `signal.reason` null; without the fallback the caller is
		// handed `null` and crashes dereferencing the error instead of seeing a cancel.
		// The default text is the migration-stable `"Request was aborted"` string that
		// remaining text-based matchers still read.
		const error = await rejectFrom(undefined, null);
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect((error as Error).message).toBe("Request was aborted");
		expect(AIError.is(AIError.classify(error), AIError.Flag.Abort)).toBe(true);
	});
});

describe("raceWithSignal shared promise", () => {
	test("keeps the racing promise running for other awaiters after one caller aborts", async () => {
		const { promise: shared, resolve: settle } = Promise.withResolvers<string>();
		const controller = new AbortController();
		const raced = raceWithSignal(shared, controller.signal, "caller bailed");
		controller.abort();
		await raced.catch(() => {});

		settle("still running");
		expect(await shared).toBe("still running");
	});
});

describe("raceSignal published alias", () => {
	test("carries the caller's message through the published import path", async () => {
		// `@oh-my-pi/pi-ai/auth/abort` is a published import path. A second copy here
		// would drift from the fix in `utils/abort.ts` and reintroduce the regression
		// for external consumers without any internal caller noticing, so the alias is
		// exercised through its own behavior rather than function identity.
		const controller = new AbortController();
		controller.abort();
		const error = await raceSignal(Promise.withResolvers<never>().promise, controller.signal, "").catch(
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect((error as Error).message).toBe("");
		expect(AIError.is(AIError.classify(error), AIError.Flag.Abort)).toBe(true);
	});
});
