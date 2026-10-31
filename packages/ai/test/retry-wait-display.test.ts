import { describe, expect, it } from "bun:test";
import {
	assistantErrorText,
	assistantTurnError,
	errorText,
	formatRetryWait,
	retryAfterMsOf,
	withRetryWait,
} from "@oh-my-pi/pi-ai/utils/retry-wait-display";

describe("the server's retry wait at display", () => {
	it("renders a wait after the text with the shared duration format, and nothing when there is none", () => {
		expect(formatRetryWait(30_000)).toBe("retry after 30.0s");
		expect(withRetryWait("429 Too many requests", 30_000)).toBe(`429 Too many requests (${formatRetryWait(30_000)})`);
		for (const none of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(withRetryWait("503 overloaded", none)).toBe("503 overloaded");
		}
	});

	it("renders a failed turn from its fields, with a fallback for an empty message", () => {
		expect(assistantErrorText({ errorMessage: "503 overloaded", errorRetryAfterMs: 2_000 })).toBe(
			`503 overloaded (${formatRetryWait(2_000)})`,
		);
		expect(assistantErrorText({ errorMessage: "" })).toBe("Error");
		expect(assistantErrorText({}, "Request failed")).toBe("Request failed");
	});

	// Absence renders no wait: never one scanned from the text, never a default,
	// never the last one rendered.
	it("renders no wait when the field is absent, even when the text names one", () => {
		expect(assistantErrorText({ errorMessage: "503 overloaded", errorRetryAfterMs: 9_000 })).toContain("retry after");
		expect(assistantErrorText({ errorMessage: "503 overloaded retry-after-ms=9000" })).toBe(
			"503 overloaded retry-after-ms=9000",
		);
		expect(assistantErrorText({ errorMessage: "503 overloaded. Please retry in 30s" })).toBe(
			"503 overloaded. Please retry in 30s",
		);
		expect(errorText(new Error("429 retry-after: 30"))).toBe("429 retry-after: 30");
	});

	it("carries the wait on an error as a number, never in its message", () => {
		const error = assistantTurnError({ errorMessage: "503 overloaded", errorRetryAfterMs: 9_000 });
		expect(error.message).toBe("503 overloaded");
		expect(retryAfterMsOf(error)).toBe(9_000);
		expect(errorText(error)).toBe(`503 overloaded (${formatRetryWait(9_000)})`);
		expect(retryAfterMsOf(assistantTurnError({ errorMessage: "400 bad request" }))).toBeUndefined();
		expect(assistantTurnError({ errorMessage: "x" }, "Commit failed: x").message).toBe("Commit failed: x");
	});

	it("reads a wait only from a numeric own property", () => {
		expect(retryAfterMsOf(Object.assign(new Error("e"), { retryAfterMs: "9000" }))).toBeUndefined();
		expect(retryAfterMsOf({ retryAfterMs: 9_000 })).toBeUndefined();
		expect(retryAfterMsOf(Object.create(Object.assign(new Error("e"), { retryAfterMs: 9_000 })))).toBeUndefined();
		expect(errorText("plain")).toBe("plain");
	});
});
