/**
 * Contract tests for `raceWithSignal` (published as `raceSignal` from
 * `@oh-my-pi/pi-ai/auth/abort`).
 *
 * Callers pass an abort `message` to get a fresh `AbortError`; the empty string
 * is a legitimate value. A truthiness check reads `""` as "no message" and leaks
 * the signal's own reason instead — losing the caller's abort text and, since
 * `AbortController.abort()` installs a `DOMException` reason carrying no
 * `Flag.Abort`, silently downgrading the abort classification that
 * `oneshot-retry.ts` and the judgment retry paths route on.
 *
 * The regression hid from name-based checks: a `DOMException` from
 * `AbortController.abort()` is also named `AbortError`, so only the class and the
 * `Flag.Abort` classification catch it.
 */
import { describe, expect, test } from "bun:test";
import { raceSignal } from "@oh-my-pi/pi-ai/auth/abort";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";

const never = () => new Promise<never>(() => {});

/** Whether an error carries the `Flag.Abort` classification. */
const isAbortClassified = (error: unknown) => AIError.is(AIError.classify(error), AIError.Flag.Abort);

describe("raceWithSignal caller abort message", () => {
	test("carries a non-empty message on a fresh AbortError", async () => {
		const controller = new AbortController();
		const raced = raceWithSignal(never(), controller.signal, "usage fetch aborted");
		controller.abort();

		const error = await raced.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect((error as Error).message).toBe("usage fetch aborted");
		expect(isAbortClassified(error)).toBe(true);
	});

	test("an empty string is a message, not an absent one, when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const raced = raceWithSignal(never(), controller.signal, "");

		const error = await raced.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect((error as Error).message).toBe("");
		expect(isAbortClassified(error)).toBe(true);
	});

	test("an empty string is a message, not an absent one, when the signal aborts later", async () => {
		const controller = new AbortController();
		const raced = raceWithSignal(never(), controller.signal, "");
		controller.abort();

		const error = await raced.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect((error as Error).message).toBe("");
		expect(isAbortClassified(error)).toBe(true);
	});
});

describe("raceWithSignal without a caller message", () => {
	test("surfaces the signal's own reason verbatim when one is supplied", async () => {
		const controller = new AbortController();
		const reason = new AIError.AbortError("provider watchdog fired");
		const raced = raceWithSignal(never(), controller.signal);
		controller.abort(reason);

		expect(await raced.catch((err: unknown) => err)).toBe(reason);
	});

	test("passes a bare abort()'s DOMException reason through unchanged", async () => {
		const controller = new AbortController();
		controller.abort();
		const raced = raceWithSignal(never(), controller.signal);

		// A message-less race has always surfaced the signal's reason verbatim; the
		// empty-string fix must not disturb that precedence.
		expect(await raced.catch((err: unknown) => err)).toBe(controller.signal.reason);
	});
});

describe("raceWithSignal without a signal", () => {
	test("returns the underlying promise untouched", async () => {
		expect(await raceWithSignal(Promise.resolve("done"), undefined, "ignored")).toBe("done");
		expect(await raceWithSignal(Promise.resolve("done"), undefined)).toBe("done");
	});

	test("keeps the shared promise running for other awaiters after one caller aborts", async () => {
		let settle: (value: string) => void = () => {};
		const shared = new Promise<string>(resolve => {
			settle = resolve;
		});
		const controller = new AbortController();
		const raced = raceWithSignal(shared, controller.signal, "caller bailed");
		controller.abort();
		await raced.catch(() => {});

		settle("still running");
		expect(await shared).toBe("still running");
	});
});

describe("raceSignal published alias", () => {
	test("is the same implementation as raceWithSignal", () => {
		expect(raceSignal).toBe(raceWithSignal);
	});

	test("classifies an empty-string message as an abort", async () => {
		const controller = new AbortController();
		const raced = raceSignal(never(), controller.signal, "");
		controller.abort();

		const error = await raced.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AIError.AbortError);
		expect(isAbortClassified(error)).toBe(true);
	});
});
