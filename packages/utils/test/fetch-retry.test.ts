import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	extractRetryHint,
	fetchWithRetry,
	findRetryRefusal,
	isUnexpectedSocketCloseMessage,
	longestRetryHint,
	parseRetryDateMs,
	RetryRefusedError,
} from "@oh-my-pi/pi-utils/fetch-retry";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Await a rejection and narrow it to `Error` without asserting a shape. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	const value = await promise.then(
		() => undefined,
		(err: unknown) => err,
	);
	if (!(value instanceof Error)) throw new Error(`Expected a rejected Error, got ${String(value)}`);
	return value;
}

describe("isUnexpectedSocketCloseMessage", () => {
	it.each(["Socket is closed", "Error: Socket is closed.", "The socket connection was closed unexpectedly"])(
		"recognizes %s",
		message => expect(isUnexpectedSocketCloseMessage(message)).toBe(true),
	);

	it("does not match socket wording embedded in an application error", () => {
		expect(isUnexpectedSocketCloseMessage("validation failed because socket is closed to remote control")).toBe(
			false,
		);
	});
});

describe("fetchWithRetry", () => {
	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});

	it("lets callers stop retries for deterministic response bodies", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("deterministic provider failure", { status: 500 });
		};

		const response = await fetchWithRetry("https://example.invalid/z", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: (_response, bodyText) => !bodyText.includes("deterministic"),
		});

		expect(response.status).toBe(500);
		expect(await response.text()).toBe("deterministic provider failure");
		expect(attempt).toBe(1);
	});

	it("returns retryable responses immediately when retry hints exceed the delay cap", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/rate-limit", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			maxDelayMs: 10,
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toBe("slow down");
		expect(attempt).toBe(1);
	});

	it("normalizes aborts during response backoff", async () => {
		const request = fetchWithRetry("https://example.invalid/response-backoff", {
			fetch: async () => new Response("retry", { status: 503 }),
			signal: AbortSignal.timeout(10),
			defaultDelayMs: 1_000,
			maxAttempts: 2,
		});

		await expect(request).rejects.toMatchObject({
			name: "Error",
			message: "Request was aborted",
		});
	});

	it("normalizes aborts during network-error backoff", async () => {
		const request = fetchWithRetry("https://example.invalid/network-backoff", {
			fetch: async () => {
				throw new TypeError("connection reset");
			},
			signal: AbortSignal.timeout(10),
			defaultDelayMs: 1_000,
			maxAttempts: 2,
		});

		await expect(request).rejects.toMatchObject({
			name: "Error",
			message: "Request was aborted",
		});
	});

	it("keeps the rejected fetch error reachable as the wrapped error's cause", async () => {
		const errno = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
		const fetchFailed = new TypeError("fetch failed", { cause: new AggregateError([errno]) });

		const error = await rejectionOf(
			fetchWithRetry("http://127.0.0.1:8080/v1/chat/completions", {
				fetch: async () => {
					throw fetchFailed;
				},
				maxAttempts: 1,
			}),
		);

		// The AggregateError carries no message, so the flattened text alone names
		// no failure; downstream classifiers reach ECONNREFUSED only through `cause`.
		expect(error.cause).toBe(fetchFailed);
	});

	it("keeps the flattened `Network error:` wording for a direct cause", async () => {
		const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" });
		const error = await rejectionOf(
			fetchWithRetry("https://api.openai.com/v1/chat/completions", {
				fetch: async () => {
					throw new TypeError("fetch failed", { cause: dns });
				},
				maxAttempts: 1,
			}),
		);

		expect(error.message).toBe("Network error: getaddrinfo ENOTFOUND api.openai.com");
	});

	it("returns a 429 at once when its duplicate Retry-After lines, arriving joined, name a wait past maxDelayMs", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.invalid/joined-retry-after", {
			fetch: async () => {
				calls++;
				return new Response("rate limited", { status: 429, headers: { "retry-after": "9, 120" } });
			},
			maxAttempts: 3,
		});

		// 120 s is past the default 60 s cap: the caller fails fast instead of
		// retrying on a 500 ms backoff the server's 120 s forbids.
		expect(calls).toBe(1);
		expect(response.status).toBe(429);
	});

	// A caller that bounds what one call may spend retrying passes a gate. A gate
	// that is ignored lets the retry loop run to its own ceiling while the caller
	// believes it is bounded, so both failure shapes must stop on a refusal.
	describe("retryGate", () => {
		it("rethrows a network failure instead of retrying when the gate refuses", async () => {
			let calls = 0;
			const asked: number[] = [];
			const error = await rejectionOf(
				fetchWithRetry("https://example.invalid/gate", {
					fetch: async () => {
						calls += 1;
						throw new Error("socket hang up");
					},
					maxAttempts: 5,
					defaultDelayMs: 1,
					retryGate: delayMs => {
						asked.push(delayMs);
						return false;
					},
				}),
			);

			expect(error.message).toBe("socket hang up");
			expect(calls).toBe(1);
			expect(asked).toEqual([1]);
		});

		it("returns the retryable response with its server wait offered to the gate", async () => {
			let calls = 0;
			const asked: number[] = [];
			const response = await fetchWithRetry("https://example.invalid/gate", {
				fetch: async () => {
					calls += 1;
					return new Response("overloaded", { status: 503, headers: { "retry-after": "2" } });
				},
				maxAttempts: 5,
				retryGate: delayMs => {
					asked.push(delayMs);
					return false;
				},
			});

			expect(response.status).toBe(503);
			expect(await response.text()).toBe("overloaded");
			expect(calls).toBe(1);
			expect(asked).toEqual([2_000]);
		});

		it("keeps retrying while the gate admits each wait", async () => {
			let calls = 0;
			const response = await fetchWithRetry("https://example.invalid/gate", {
				fetch: async () => {
					calls += 1;
					return calls < 3 ? new Response("", { status: 503 }) : new Response("done", { status: 200 });
				},
				maxAttempts: 5,
				defaultDelayMs: 1,
				retryGate: () => true,
			});

			expect(await response.text()).toBe("done");
			expect(calls).toBe(3);
		});

		// The wait and `prepareInit` take real time. A gate asked only before the
		// wait lets a retry go out after the caller's deadline has passed.
		it("asks the gate again after the wait and preparation, and returns the held response on a refusal", async () => {
			const events: string[] = [];
			let calls = 0;
			const response = await fetchWithRetry("https://example.invalid/gate", {
				fetch: async () => {
					calls += 1;
					events.push(`fetch ${calls}`);
					return new Response("overloaded", { status: 503 });
				},
				prepareInit: async attempt => {
					events.push(`prepare ${attempt}`);
					return {};
				},
				maxAttempts: 5,
				defaultDelayMs: 1,
				retryGate: delayMs => {
					events.push(`gate ${delayMs}`);
					return delayMs > 0;
				},
			});

			expect(calls).toBe(1);
			expect(events).toEqual(["prepare 0", "fetch 1", "gate 1", "prepare 1", "gate 0"]);
			expect(response.status).toBe(503);
			expect(await response.text()).toBe("overloaded");
		});

		it("rethrows the held network failure when the gate refuses right before the retry", async () => {
			let calls = 0;
			const error = await rejectionOf(
				fetchWithRetry("https://example.invalid/gate", {
					fetch: async () => {
						calls += 1;
						throw new Error(`socket hang up ${calls}`);
					},
					maxAttempts: 5,
					defaultDelayMs: 1,
					retryGate: delayMs => delayMs > 0,
				}),
			);

			expect(calls).toBe(1);
			expect(error.message).toBe("socket hang up 1");
		});

		it("offers the gate the body's wait when the header says zero", async () => {
			const asked: number[] = [];
			const response = await fetchWithRetry("https://example.invalid/gate", {
				fetch: async () =>
					new Response('{"error":{"message":"Please retry in 30s"}}', {
						status: 503,
						headers: { "retry-after": "0" },
					}),
				maxAttempts: 5,
				retryGate: delayMs => {
					asked.push(delayMs);
					return false;
				},
			});

			expect(response.status).toBe(503);
			expect(asked).toEqual([30_000]);
		});

		// The transport below the retry loop can refuse a retry at the moment it
		// would send it. The response that retry would have replaced is the result,
		// not the refusal and not a network error retried again.
		it("returns the held response when the transport refuses the retry at send time", async () => {
			let calls = 0;
			const response = await fetchWithRetry("https://example.invalid/gate", {
				fetch: async () => {
					calls += 1;
					if (calls === 2) throw new RetryRefusedError();
					return new Response("overloaded", { status: 503 });
				},
				maxAttempts: 5,
				defaultDelayMs: 1,
				retryGate: () => true,
			});

			expect(calls).toBe(2);
			expect(response.status).toBe(503);
			expect(await response.text()).toBe("overloaded");
		});

		it("rethrows the held network failure when the transport refuses the retry at send time", async () => {
			let calls = 0;
			const error = await rejectionOf(
				fetchWithRetry("https://example.invalid/gate", {
					fetch: async () => {
						calls += 1;
						if (calls === 2) throw new RetryRefusedError();
						throw new Error("socket hang up");
					},
					maxAttempts: 5,
					defaultDelayMs: 1,
					retryGate: () => true,
				}),
			);

			expect(calls).toBe(2);
			expect(error.message).toBe("socket hang up");
		});

		it("passes a refusal of its first request through unchanged", async () => {
			const refusal = new RetryRefusedError("the rejection being corrected");
			const error = await rejectionOf(
				fetchWithRetry("https://example.invalid/gate", {
					fetch: async () => {
						throw refusal;
					},
					maxAttempts: 5,
					retryGate: () => true,
				}),
			);

			expect(error).toBe(refusal);
		});

		it("offers the gate the longest of several retry headers", async () => {
			const asked: number[] = [];
			await fetchWithRetry("https://example.invalid/gate", {
				fetch: async () =>
					new Response("", {
						status: 503,
						headers: { "retry-after-ms": "1", "retry-after": "0.002", "x-ratelimit-reset-after": "30" },
					}),
				maxAttempts: 5,
				retryGate: delayMs => {
					asked.push(delayMs);
					return false;
				},
			});

			expect(asked).toEqual([30_000]);
		});
	});

	describe("findRetryRefusal", () => {
		it("finds a refusal through the cause chain a transport wrapper adds", () => {
			const refusal = new RetryRefusedError();
			const wrapped = new Error("Connection error.", { cause: new Error("fetch failed", { cause: refusal }) });

			expect(findRetryRefusal(wrapped)).toBe(refusal);
			expect(findRetryRefusal(new Error("socket hang up"))).toBeUndefined();
		});
	});
});

// The retry loop's own reader stops at the first header it recognizes and the
// first occurrence of each phrase. A caller bounding its retries by a budget
// must see the longest wait the server named, or it resends inside a window the
// server already said is closed.
describe("longestRetryHint", () => {
	it.each([
		["retry-after-ms beside retry-after", { "retry-after-ms": "1", "retry-after": "30" }, 30_000],
		[
			"x-ratelimit-reset-after beside shorter headers",
			{ "retry-after-ms": "1", "x-ratelimit-reset-after": "30" },
			30_000,
		],
		["a malformed header beside a valid one", { "retry-after-ms": "bad", "retry-after": "30" }, 30_000],
		["duplicate header lines joined by a comma", { "retry-after": "1, 30" }, 30_000],
		["an explicit zero alone", { "retry-after-ms": "0" }, 0],
	])("reads %s", (_name, headers, expected) => {
		expect(longestRetryHint(new Headers(headers))).toBe(expected);
	});

	it("reads an HTTP date", () => {
		const at = new Date(Date.now() + 60_000).toUTCString();
		const hint = longestRetryHint(new Headers({ "retry-after": at }));
		expect(hint).toBeGreaterThan(55_000);
		expect(hint).toBeLessThanOrEqual(60_000);
	});

	it.each([
		["every occurrence of one phrase", "Please retry in 1ms. Please retry in 30s."],
		["a valid occurrence after a malformed one", "Please retry in ...s. Please retry in 30s."],
		["different phrases", "Please retry in 1ms; try again in 30s"],
	])("reads %s in the body", (_name, body) => {
		expect(longestRetryHint(undefined, body)).toBe(30_000);
	});

	it("takes the longer of the headers and the body", () => {
		expect(longestRetryHint(new Headers({ "retry-after-ms": "30000" }), "Please retry in 1ms")).toBe(30_000);
		expect(longestRetryHint(new Headers({ "retry-after-ms": "0" }), "Please retry in 30s")).toBe(30_000);
	});

	// `retry-after: <date>` in text. A zoned date is read in its zone. A date with
	// no zone names no wait in a body, where nothing says which zone it is in;
	// the same date in a header is GMT, as every HTTP date is.
	describe("an HTTP date in the body", () => {
		const at = Date.UTC(2026, 9, 31, 12, 0, 0);
		const imf = (ms: number): string => new Date(ms).toUTCString();
		const rfc850 = (ms: number): string => {
			const date = new Date(ms);
			const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()];
			const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
				date.getUTCMonth()
			];
			const pad = (value: number): string => String(value).padStart(2, "0");
			return `${day}, ${pad(date.getUTCDate())}-${month}-${String(date.getUTCFullYear()).slice(2)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`;
		};
		const asctime = (ms: number): string =>
			imf(ms).replace(
				/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/,
				(_match, day, date, month, year, time) => `${day} ${month} ${Number(date)} ${time} ${year}`,
			);

		// A zone whose offset is not zero, so a zone-less date read as local time
		// names a different instant than the same text read as GMT.
		const savedZone = process.env.TZ;
		beforeEach(() => {
			process.env.TZ = "America/New_York";
		});
		afterEach(() => {
			if (savedZone === undefined) delete process.env.TZ;
			else process.env.TZ = savedZone;
		});

		it.each([
			["IMF-fixdate", imf],
			["RFC 850", rfc850],
		])("reads %s", (_name, format) => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(longestRetryHint(undefined, `retry-after: ${format(at + 30_000)}`)).toBe(30_000);
		});

		it.each([
			["asctime", asctime],
			["IMF-fixdate without GMT", (ms: number): string => imf(ms).replace(/ GMT$/, "")],
			["RFC 3339 without a zone", (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/, "")],
			[
				"RFC 3339 with a space and no zone",
				(ms: number): string =>
					new Date(ms)
						.toISOString()
						.replace("T", " ")
						.replace(/\.000Z$/, ""),
			],
		])("names no wait for %s in a body, and reads it as GMT in a header", (_name, format) => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(longestRetryHint(undefined, `retry-after: ${format(at + 30_000)}`)).toBeUndefined();
			expect(extractRetryHint(undefined, `retry-after: ${format(at + 30_000)}`)).toBeUndefined();
			expect(longestRetryHint(new Headers({ "retry-after": format(at + 30_000) }))).toBe(30_000);
			expect(extractRetryHint(new Headers({ "retry-after": format(at + 30_000) }))).toBe(30_000);
		});

		it("beats a short delta beside it, in either order", () => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(longestRetryHint(undefined, `retry-after: ${imf(at + 30_000)}; Please retry in 1ms`)).toBe(30_000);
			expect(longestRetryHint(undefined, `Please retry in 1ms; retry-after=${imf(at + 30_000)}`)).toBe(30_000);
		});

		it("reads a past date as an immediate retry", () => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(longestRetryHint(undefined, `retry-after: ${imf(at - 60_000)}`)).toBe(0);
		});

		it("is read in a header the same way as in text", () => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(longestRetryHint(new Headers({ "retry-after": asctime(at + 30_000) }))).toBe(30_000);
		});

		// One date reader: the retry loop without a gate reads a date in text too.
		it("is read without a gate too", () => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(extractRetryHint(undefined, `retry-after: ${imf(at + 30_000)}`)).toBe(30_000);
		});

		// RFC 9110 section 5.6.7, case by case: the rolling fifty-year reading of a
		// two-digit year, the leap second, and a malformed field never read as part
		// of a longer one.
		const header = (value: string): number | undefined => longestRetryHint(new Headers({ "retry-after": value }));
		const body = (value: string): number | undefined => longestRetryHint(undefined, `retry-after: ${value}`);

		it.each([
			["less than fifty years ahead", "Sunday, 31-Oct-60 12:00:30 GMT", Date.UTC(2060, 9, 31, 12, 0, 30) - at],
			["more than fifty years ahead, read as the past", "Sunday, 31-Oct-80 12:00:30 GMT", 0],
			["a four-digit year", "Sunday, 31-Oct-2060 12:00:30 GMT", Date.UTC(2060, 9, 31, 12, 0, 30) - at],
		])("reads an RFC 850 year %s, in a header and in text", (_name, value, expected) => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(header(value)).toBe(expected);
			expect(body(value)).toBe(expected);
		});

		it("reads a 29 February only in the century the fifty-year rule picks", () => {
			// From 2060 the window ends in 2110: "00" is 2100, which has no 29 February.
			vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2060, 0, 1));
			expect(header("Tuesday, 29-Feb-00 00:00:00 GMT")).toBeUndefined();
			// From 2026 it is 2000, which has one.
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(header("Tuesday, 29-Feb-00 00:00:00 GMT")).toBe(0);
		});

		it("reads the leap second 23:59:60 as the instant after 23:59:59", () => {
			vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2016, 11, 31, 23, 59, 30));
			expect(header("Sat, 31 Dec 2016 23:59:60 GMT")).toBe(30_000);
			expect(body("Sat, 31 Dec 2016 23:59:60 GMT")).toBe(30_000);
			expect(header("Sat, 31 Dec 2016 12:00:60 GMT")).toBeUndefined();
		});

		it("never reads a prefix of a malformed year beside a valid date", () => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			const valid = imf(at + 30_000);
			expect(longestRetryHint(undefined, `retry-after: Sat Oct 31 12:00:30 999999999; retry-after: ${valid}`)).toBe(
				30_000,
			);
			expect(
				longestRetryHint(undefined, `retry-after: Sat, 31 Oct 999999999 12:00:30 GMT; retry-after: ${valid}`),
			).toBe(30_000);
			expect(longestRetryHint(undefined, `retry-after: Sat, 31 Oct 2026 12:00:300 GMT; retry-after: ${valid}`)).toBe(
				30_000,
			);
		});

		it.each([
			["a day the month does not have", "Sat, 31 Nov 2026 12:00:30 GMT"],
			["an hour past 23", "Sat, 31 Oct 2026 24:00:30 GMT"],
			["an unknown month", "Sat, 31 Foo 2026 12:00:30 GMT"],
			["a five-digit year", "Sat, 31 Oct 20260 12:00:30 GMT"],
		])("names no wait for %s", (_name, value) => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(header(value)).toBeUndefined();
		});

		it("reads both dates of a duplicate header joined by a comma", () => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(header(`${imf(at + 1_000)}, ${imf(at + 30_000)}`)).toBe(30_000);
		});

		// Every reader of a Retry-After date, with or without a budget, reads it the
		// same way: the header reading without a gate agrees with the budget's.
		it.each([
			["an RFC 850 two-digit year decades ahead", "Sunday, 31-Oct-60 12:00:30 GMT"],
			["the zone-less asctime form, read as GMT", "Sat Oct 31 12:00:30 2026"],
			["31 November", "Sat, 31 Nov 2026 12:00:30 GMT"],
			["a five-digit year", "Sat, 31 Oct 20260 12:00:30 GMT"],
			["an RFC 5322 US zone", "Sat, 31 Oct 2026 05:00:30 PDT"],
			["a zoned RFC 3339 timestamp", "2026-10-31T12:00:30Z"],
			["a zone-less RFC 3339 timestamp", "2026-10-31T12:00:30"],
		])("reads %s the same in the header without a gate", (_name, value) => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(extractRetryHint(new Headers({ "retry-after": value }))).toBe(header(value));
		});

		it("reads a timestamp written as one token in text with the same reader", () => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			expect(extractRetryHint(undefined, "retry-after: 2026-10-31T12:00:30Z")).toBe(30_000);
			expect(extractRetryHint(undefined, "retry-after: 2026-10-31T12:00:30")).toBeUndefined();
			expect(extractRetryHint(new Headers({ "retry-after": "2026-10-31T12:00:30" }))).toBe(30_000);
		});
	});

	describe("parseRetryDateMs", () => {
		const at = Date.UTC(2026, 9, 31, 12, 0, 0);
		it.each([
			["IMF-fixdate", "Sat, 31 Oct 2026 12:00:30 GMT", at + 30_000],
			["an RFC 5322 numeric offset", "Sat, 31 Oct 2026 13:00:30 +0100", at + 30_000],
			["an RFC 5322 US zone", "Sat, 31 Oct 2026 05:00:30 PDT", at + 30_000],
			["an RFC 5322 date without its weekday", "31 Oct 2026 12:00:30 GMT", at + 30_000],
			["an RFC 3339 timestamp in UTC", "2026-10-31T12:00:30Z", at + 30_000],
			["an RFC 3339 timestamp with an offset and a fraction", "2026-10-31T14:00:30.250+02:00", at + 30_250],
			["an RFC 3339 one-digit fraction, as tenths", "2026-10-31T12:00:30.5Z", at + 30_500],
			["an RFC 3339 two-digit fraction, as hundredths", "2026-10-31T12:00:30.05Z", at + 30_050],
			["an RFC 3339 fraction finer than milliseconds", "2026-10-31T12:00:30.123456Z", at + 30_123],
			["the RFC 3339 leap second", "2016-12-31T23:59:60Z", Date.UTC(2017, 0, 1)],
			["a date with a trailing comment", "Sat, 31 Oct 2026 12:00:30 GMT (UTC)", at + 30_000],
			["long weekday and month names", "Saturday, 31 October 2026 12:00:30 GMT", at + 30_000],
			["a time without seconds", "Sat, 31 Oct 2026 12:01 GMT", at + 60_000],
			["a GMT offset", "Sat, 31 Oct 2026 13:00:30 GMT+0100", at + 30_000],
			[
				"JavaScript's Date#toString shape",
				"Sat Oct 31 2026 12:00:30 GMT+0000 (Coordinated Universal Time)",
				at + 30_000,
			],
			["an RFC 3339 timestamp with a space for the T", "2026-10-31 12:00:30Z", at + 30_000],
		])("reads %s", (_name, value, expected) => {
			expect(parseRetryDateMs(value, "gmt", at)).toBe(expected);
			expect(parseRetryDateMs(value, "reject", at)).toBe(expected);
		});

		// RFC 5322 section 4.3: every named zone, so no single offset can drift.
		it.each([
			["GMT", 0],
			["UT", 0],
			["UTC", 0],
			["Z", 0],
			["EST", -5 * 60],
			["EDT", -4 * 60],
			["CST", -6 * 60],
			["CDT", -5 * 60],
			["MST", -7 * 60],
			["MDT", -6 * 60],
			["PST", -8 * 60],
			["PDT", -7 * 60],
		])("reads the zone %s as %i minutes from UTC", (zone, offsetMinutes) => {
			// The wall clock in that zone at `at`.
			const wall = new Date(at + offsetMinutes * 60_000);
			const hh = String(wall.getUTCHours()).padStart(2, "0");
			const mm = String(wall.getUTCMinutes()).padStart(2, "0");
			expect(parseRetryDateMs(`${wall.getUTCDate()} Oct 2026 ${hh}:${mm}:00 ${zone}`, "reject", at)).toBe(at);
		});

		// `Date.UTC` reads years 0-99 as 1900-1999; a four-digit year below 100 is
		// that year, in every shape.
		it.each([
			["IMF", "Fri, 01 Jan 0050 00:00:00 GMT"],
			["RFC 3339", "0050-01-01T00:00:00Z"],
			["asctime", "Fri Jan  1 00:00:00 0050"],
		])("reads a four-digit year below 100 as itself in the %s shape", (_name, value) => {
			const year50 = new Date(0);
			year50.setUTCFullYear(50, 0, 1);
			expect(parseRetryDateMs(value, "gmt", at)).toBe(year50.getTime());
		});

		// A date with no zone: GMT from a header, no wait from a body.
		it.each([
			["an IMF date without its zone", "Sat, 31 Oct 2026 12:00:30"],
			["an RFC 850 date without its zone", "Saturday, 31-Oct-26 12:00:30"],
			["asctime", "Sat Oct 31 12:00:30 2026"],
			["an RFC 3339 timestamp without a zone", "2026-10-31T12:00:30"],
			["an RFC 3339 timestamp with a space and no zone", "2026-10-31 12:00:30"],
			["JavaScript's Date#toString shape without a zone", "Sat Oct 31 2026 12:00:30"],
		])("reads %s as GMT from a header and as nothing from a body", (_name, value) => {
			expect(parseRetryDateMs(value, "gmt", at)).toBe(at + 30_000);
			expect(parseRetryDateMs(value, "reject", at)).toBeUndefined();
		});

		it.each([
			["a word that is not a weekday", "Foo, 31 Oct 2026 12:00:30 GMT"],
			["an unknown zone", "Sat, 31 Oct 2026 12:00:30 CET"],
			["an offset past 23 hours", "2026-10-31T12:00:30+24:00"],
			["a seconds value", "30"],
			["a seconds value with trailing text", "30abc"],
		])("reads no date in %s", (_name, value) => {
			expect(parseRetryDateMs(value, "gmt", at)).toBeUndefined();
			expect(parseRetryDateMs(value, "reject", at)).toBeUndefined();
		});
	});

	it("names no wait when nothing names one", () => {
		expect(longestRetryHint(new Headers({ "content-type": "application/json" }), "overloaded")).toBeUndefined();
	});
});

describe("extractRetryHint, unchanged", () => {
	// The retry loop with no gate keeps its first-match reading: these pin it.
	it("still returns the first recognized header", () => {
		expect(extractRetryHint(new Headers({ "retry-after-ms": "1", "retry-after": "30" }))).toBe(1);
	});

	it("still reads only the first occurrence of a phrase", () => {
		expect(extractRetryHint(undefined, "Please retry in 1ms. Please retry in 30s.")).toBe(1);
	});
});

describe("extractRetryHint", () => {
	// Devin returns HTTP 403 with "Your limit will reset in 13 minutes" for an
	// account-scoped message rate cap. Without recognizing "will reset in", the
	// credential is blocked for the 1-minute default instead of 13 minutes and
	// can be reselected and hammered while the cap remains active.
	it("parses Devin 'Your limit will reset in 13 minutes' as 13 minutes", () => {
		expect(extractRetryHint(undefined, "Your limit will reset in 13 minutes")).toBe(13 * 60_000);
	});

	it("parses 'will reset in 2h' phrasing", () => {
		expect(extractRetryHint(undefined, "will reset in 2h")).toBe(2 * 60 * 60_000);
	});
	// OpenCode Go quota errors use "Resets in …" with day units and compound
	// remainders (upstream `formatRetryTime`: "2hr 15min", "3 days", "45min").
	// Without these the exhausted credential falls back to the 60s heuristic
	// and is reselected while the cap is still active.
	it("parses OpenCode Go 'Resets in 45min' as 45 minutes", () => {
		expect(
			extractRetryHint(
				undefined,
				"429 5-hour usage limit reached. Resets in 45min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_1/go",
			),
		).toBe(45 * 60_000);
	});

	it("parses OpenCode Go compound 'Resets in 2hr 15min' as 2h15m", () => {
		expect(
			extractRetryHint(
				undefined,
				"429 5-hour usage limit reached. Resets in 2hr 15min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_1/go",
			),
		).toBe((2 * 60 + 15) * 60_000);
	});

	it("parses OpenCode Go day-unit resets", () => {
		expect(extractRetryHint(undefined, "429 Weekly usage limit reached. Resets in 3 days.")).toBe(
			3 * 24 * 60 * 60_000,
		);
		expect(extractRetryHint(undefined, "429 Monthly usage limit reached. Resets in 1 day.")).toBe(24 * 60 * 60_000);
	});

	// A quota body can carry both a generic retry hint and the account reset
	// window ("Please retry in 5s. Your limit will reset in 13 minutes"). The
	// account-reset hint must take precedence so the exhausted credential stays
	// blocked for the full stated window instead of the short generic retry.
	it("prefers the account reset window over a shorter retry hint", () => {
		expect(extractRetryHint(undefined, "Please retry in 5s. Your limit will reset in 13 minutes")).toBe(13 * 60_000);
	});
	// The appended header hint is already the max across response headers
	// (getRetryAfterMsFromHeaders in pi-ai). When it outlasts the textual
	// account reset, it must win so the retry honors the provider's retry
	// window instead of re-hitting a blocked credential.
	it("prefers a longer appended retry hint over a shorter account reset", () => {
		expect(
			extractRetryHint(undefined, "429 quota exceeded. Your limit will reset in 5 minutes. retry-after-ms=3600000"),
		).toBe(3600000);
	});

	it("prefers a longer legacy retry-after over a shorter reset phrase", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. reset in 5 minutes; retry-after=3600")).toBe(3_600_000);
	});

	it("parses x-ratelimit-reset epoch seconds in the body", () => {
		const hint = extractRetryHint(undefined, "rate limited, x-ratelimit-reset=9999999999");
		expect(hint).toBeDefined();
		expect(hint!).toBeGreaterThan(8_000_000_000_000);
	});

	it("parses retry-after-ms in error body", () => {
		expect(
			extractRetryHint(
				undefined,
				'429 {"type":"error","error":{"type":"rate_limit_error","code":"1310"}} retry-after-ms=98497000',
			),
		).toBe(98_497_000);
	});

	it("parses colon-delimited and spaced retry-after-ms forms", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. retry-after-ms: 7200000")).toBe(7_200_000);
		expect(extractRetryHint(undefined, "429 quota exceeded. retry-after-ms = 7200000")).toBe(7_200_000);
	});

	it("keeps a longer colon-delimited retry-after-ms over a shorter reset phrase", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. reset in 5 minutes. retry-after-ms: 3600000")).toBe(
			3_600_000,
		);
	});

	it("parses an offset-bearing absolute reset timestamp", () => {
		const expected = Date.parse("2099-09-01T09:44:51+08:00") - Date.now();
		const hint = extractRetryHint(undefined, "Your limit will reset at 2099-09-01 09:44:51+08:00");
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	// A date with no zone in a body is the server's wall clock in a zone
	// nothing names; read as UTC it once gave eight hours where the server's
	// header said 750 ms. A wait that cannot be computed is no wait at all.
	it.each([
		["a space-separated reset stamp", "Your limit will reset at 2099-09-01 09:44:51"],
		["an ISO-separated reset stamp", "Your limit will reset at 2099-09-01T09:44:51"],
		["a Chinese reset stamp", "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。"],
		["a legacy retry-after ISO date", "rate limited; retry-after: 2099-09-01T09:44:51"],
	])("reads no wait from %s with no zone and no provider offset", (_label, body) => {
		expect(extractRetryHint(undefined, body)).toBeUndefined();
		expect(longestRetryHint(undefined, body)).toBeUndefined();
	});

	it("reads a legacy retry-after date in a body in its stated zone", () => {
		const expected = Date.parse("2099-09-01T09:44:51Z") - Date.now();
		const hint = extractRetryHint(undefined, "rate limited; retry-after: 2099-09-01T09:44:51Z");
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("prefers an absolute account reset over retry-after-ms", () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const hint = extractRetryHint(undefined, `Your limit will reset at ${future} retry-after-ms=5000`);
		expect(hint).toBeGreaterThan(3_500_000);
		expect(hint).toBeLessThanOrEqual(3_600_000);
	});

	it("yields to the relative retry hint over a longer naive reset-at stamp", () => {
		// A naive stamp is the provider's wall clock in an unknown zone: it
		// cannot disambiguate against a conflicting relative signal without
		// guessing the zone, so the unambiguous signal wins regardless of
		// which is longer.
		const naiveWall = new Date(Date.now() + 3_600_000).toISOString().slice(0, 19).replace("T", " ");
		expect(extractRetryHint(undefined, `Your limit will reset at ${naiveWall} retry-after-ms=5000`)).toBe(5000);
	});

	it("still reads the relative hint beside a zone-less stamp", () => {
		expect(
			extractRetryHint(undefined, "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。 retry-after-ms=5000"),
		).toBe(5000);
	});

	it("applies naiveResetTimezoneOffset to a naive Chinese reset stamp", () => {
		const targetMs = Date.parse("2099-09-01T09:44:51+08:00");
		const expected = targetMs - Date.now();
		const hint = extractRetryHint(undefined, "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。", {
			naiveResetTimezoneOffset: "+08:00",
		});
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("keeps a configured reset over a shorter retry-after-ms", () => {
		const future = new Date(Date.now() + 3_600_000 + 8 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ");
		const hint = extractRetryHint(undefined, `Your limit will reset at ${future} retry-after-ms=5000`, {
			naiveResetTimezoneOffset: "+08:00",
		});
		expect(hint).toBeGreaterThan(3_500_000);
		expect(hint).toBeLessThanOrEqual(3_600_000);
	});

	// Zero-valued and elapsed signals are authoritative "retry now" replies:
	// collapsing them into `undefined` lets callers substitute a heuristic
	// wait (30-minute quota guess) for a provider that said retry immediately.
	it("preserves an explicit zero retry-after-ms as retry-now", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. retry-after-ms=0")).toBe(0);
	});

	it("preserves an explicit zero legacy retry-after as retry-now", () => {
		expect(extractRetryHint(undefined, "rate limited; retry-after=0")).toBe(0);
	});

	it("treats elapsed x-ratelimit-reset epochs as retry-now", () => {
		expect(extractRetryHint(undefined, `rate limited, x-ratelimit-reset-ms=${Date.now() - 60_000}`)).toBe(0);
		expect(extractRetryHint(undefined, `rate limited, x-ratelimit-reset=${Math.floor(Date.now() / 1000) - 60}`)).toBe(
			0,
		);
	});

	it("lets a longer reset phrase win over a zero retry hint", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. reset in 5 minutes. retry-after-ms=0")).toBe(5 * 60_000);
	});

	it("still returns undefined when only elapsed account resets are present", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		expect(extractRetryHint(undefined, `Your limit will reset at ${past}`)).toBeUndefined();
	});

	describe("a zone-less date in a Retry-After header", () => {
		// An HTTP-date is GMT by definition (RFC 9110 §5.6.7), so a header date
		// without a zone is read as GMT, never in this machine's zone.
		const originalTz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = originalTz;
		});
		it.each([
			["an IMF-fixdate without GMT", "Tue, 01 Sep 2099 09:44:51"],
			["an asctime date", "Tue Sep  1 09:44:51 2099"],
			["an ISO date-time without a zone", "2099-09-01T09:44:51"],
		])("reads %s as GMT", (_label, value) => {
			process.env.TZ = "America/Los_Angeles";
			const expected = Date.UTC(2099, 8, 1, 9, 44, 51) - Date.now();
			for (const hint of [
				extractRetryHint(new Headers({ "retry-after": value })),
				longestRetryHint(new Headers({ "retry-after": value })),
			]) {
				expect(hint).toBeDefined();
				expect(Math.abs(hint! - expected)).toBeLessThan(1000);
			}
		});
		it("reads a zoned header date in its zone", () => {
			process.env.TZ = "America/Los_Angeles";
			const expected = Date.UTC(2099, 8, 1, 9, 44, 51) - Date.now();
			const hint = extractRetryHint(new Headers({ "retry-after": "Tue, 01 Sep 2099 09:44:51 GMT" }));
			expect(Math.abs(hint! - expected)).toBeLessThan(1000);
		});
	});

	it.each([
		["retry-after", "9, 120", 120_000],
		["retry-after-ms", "100, 9000", 9_000],
	] as [string, string, number][])(
		"reads the longest part of a joined %s header (%s), as longestRetryHint does",
		(name, value, expected) => {
			const headers = new Headers({ [name]: value });
			expect(extractRetryHint(headers)).toBe(expected);
			expect(longestRetryHint(headers)).toBe(expected);
		},
	);
});
