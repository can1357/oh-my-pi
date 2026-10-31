import { describe, expect, it } from "bun:test";
import { withErrorEventHeaders } from "@oh-my-pi/pi-ai/utils/error-event-headers";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "@oh-my-pi/pi-ai/utils/retry-after";

/** The wait a client reads from an error built for this in-band error object. */
function waitFrom(errorObject: unknown): number | undefined {
	return getRetryAfterMsFromHeaders(
		getHeadersFromError(withErrorEventHeaders(new Error("stream failed"), errorObject)),
	);
}

describe("withErrorEventHeaders", () => {
	it.each([
		["retry-after-ms as a string", { "retry-after-ms": "9000" }, 9000],
		["retry-after-ms as a number", { "retry-after-ms": 9000 }, 9000],
		["Retry-After in seconds, any case", { "Retry-After": "9" }, 9000],
	] as [string, Record<string, unknown>, number][])("reads %s", (_label, headers, expected) => {
		expect(waitFrom({ message: "rate limited", headers })).toBe(expected);
	});

	it.each([
		// A body's other "headers" are not a wait instruction, and reach no reader.
		["a window reset", { "x-ratelimit-reset": "3600" }],
		["a window reset in ms", { "x-ratelimit-reset-ms": "3600000" }],
		["a provider's own header", { "anthropic-ratelimit-requests-reset": "2099-01-01T00:00:00Z" }],
		["a value that is not a string or number", { "retry-after-ms": { value: 9000 } }],
		["a non-finite number", { "retry-after-ms": Number.POSITIVE_INFINITY }],
		["an invalid header value", { "retry-after-ms": "9000\r\nx-injected: 1" }],
	] as [string, Record<string, unknown>][])("ignores %s", (_label, headers) => {
		const error = withErrorEventHeaders(new Error("stream failed"), { message: "rate limited", headers });
		expect(getHeadersFromError(error)).toBeUndefined();
	});

	it("never reads the message text", () => {
		expect(waitFrom({ message: "retry-after-ms=9000" })).toBeUndefined();
	});

	it("keeps an error's own headers", () => {
		const error = Object.assign(new Error("429"), { headers: new Headers({ "retry-after-ms": "1000" }) });
		const result = withErrorEventHeaders(error, { headers: { "retry-after-ms": "9000" } });
		expect(getRetryAfterMsFromHeaders(getHeadersFromError(result))).toBe(1000);
	});
});
