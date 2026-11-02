import { afterEach, describe, expect, it, vi } from "bun:test";
import { getRetryAfterMsFromHeaders } from "@oh-my-pi/pi-ai/utils/retry-after";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getRetryAfterMsFromHeaders", () => {
	it("reads x-ratelimit-reset-ms as a millisecond delta, not epoch seconds", () => {
		// 2147483648 ms (about 24.9 days) is a delta the header's own unit names; read as epoch
		// seconds it became a reset in 2038, 447483648000 ms away.
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		expect(getRetryAfterMsFromHeaders(new Headers({ "x-ratelimit-reset-ms": "2147483648" }))).toBe(2_147_483_648);
	});

	it("ignores a retry hint too large to be a finite number of milliseconds", () => {
		// `Retry-After: 1e308` seconds overflows to an infinite delay; a shorter valid header still counts.
		expect(getRetryAfterMsFromHeaders(new Headers({ "retry-after": "1e308", "retry-after-ms": "250" }))).toBe(250);
	});
});
