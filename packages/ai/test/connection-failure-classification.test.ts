/**
 * `AIError.Flag.Connection` marks a failure that died on the wire with no HTTP
 * status and no capacity signal. Turn recovery reads exactly this bit to decide
 * whether to keep a session on its model for a couple of retries before
 * `retry.fallbackChains` advances, so a wrong answer either strands a session on
 * a dead route or sends a throttled one back at the same cap.
 *
 * The session-level consequences live in
 * `packages/coding-agent/test/agent-session-retry-recovery.test.ts`; this file
 * pins the classifier boundary itself, including the shapes that reach it as a
 * wrapped `Error` rather than as a persisted message.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";

function flagsOfMessage(errorMessage: string, errorStatus?: number): { connection: boolean; retriable: boolean } {
	const id = AIError.classifyMessage({ errorMessage, errorStatus });
	return { connection: AIError.is(id, AIError.Flag.Connection), retriable: AIError.retriable(id) };
}

describe("connection-failure classification", () => {
	it.each([
		[
			"a runtime socket close mid-body",
			"ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
		],
		[
			"a gateway's own chunked-transfer diagnostic",
			"TransferEncodingError: the chunked response body ended before its terminating chunk",
		],
		["an SSE stream that ended before its terminal event", "stream disconnected before completion"],
		["an upstream that closed the connection", "upstream closed the connection"],
	])("flags %s as connection-level and retriable", (_label, errorMessage) => {
		expect(flagsOfMessage(errorMessage)).toEqual({ connection: true, retriable: true });
	});

	it.each([
		["a gateway 5xx before any model answered", "500 Internal Server Error: key lookup did not answer within 10s"],
		["a rate limit", "429 Too Many Requests: rate limit exceeded"],
		["an overload", "529 Overloaded"],
		["a service-unavailable overload", "503 service unavailable: overloaded_error"],
	])("keeps %s off the connection lane while staying retriable", (_label, errorMessage) => {
		expect(flagsOfMessage(errorMessage)).toEqual({ connection: false, retriable: true });
	});

	it.each([
		["a throttle named beside a wire death", "TooManyRequests: upstream closed the connection"],
		["an exhausted resource named beside a wire death", "RESOURCE_EXHAUSTED: connection reset by peer"],
		["a provider asking the client to back off", "Provider returned error: slow down, connection reset"],
		["a host reporting itself busy as the wire died", "model is busy, connection reset"],
		[
			"a usage limit reported as the stream died",
			'{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}} socket is closed',
		],
	])("keeps %s off the connection lane, because the replay re-hits the cap", (_label, errorMessage) => {
		expect(flagsOfMessage(errorMessage).connection).toBe(false);
	});

	it.each([
		["a killed process", "Process terminated by signal SIGKILL"],
		["a policy stop", "terminated: content policy"],
	])("does not read %s as a cut body", (_label, errorMessage) => {
		// undici's whole diagnostic for a body that ended early is the bare word
		// `terminated`; the word inside a sentence means something a replay does
		// not recover.
		expect(flagsOfMessage(errorMessage).connection).toBe(false);
	});

	it.each([["terminated"], ["TypeError: terminated"]])("reads undici's %p as a cut body", errorMessage => {
		expect(flagsOfMessage(errorMessage)).toEqual({ connection: true, retriable: true });
	});

	it("reads a wire errno carried only on the error code", () => {
		// A runtime that reports the failure as an errno leaves the message
		// generic, so the text predicates never see it.
		const error = Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });

		expect(AIError.is(AIError.classify(error), AIError.Flag.Connection)).toBe(true);
	});

	it("does not fabricate the connection lane from a status carried on the message", () => {
		// `errorStatus` is authoritative even when the text names only the wire:
		// a status means a status line arrived, which the transport retry covers.
		expect(flagsOfMessage("The socket connection was closed unexpectedly", 502).connection).toBe(false);
	});

	it("drops the connection lane when a throttled wrapper carries a wire-worded cause", () => {
		// `classify` ORs the kinds of every link in the cause chain, so a 429
		// whose cause is a bare socket death would otherwise hold the fallback
		// chain against a model that is genuinely capped.
		const cause = new Error("The socket connection was closed unexpectedly");
		const wrapper = Object.assign(new Error("429 Too Many Requests"), { status: 429, cause });
		const id = AIError.classify(wrapper);

		expect(AIError.is(id, AIError.Flag.Connection)).toBe(false);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("keeps the connection lane for a statusless wrapper over a wire-worded cause", () => {
		// The same shape without a status is the ordinary mid-stream cut: the
		// bit must survive the cause walk, or nothing holds the chain.
		const cause = new Error("socket hang up");
		const wrapper = Object.assign(new Error("stream failed"), { cause });

		expect(AIError.is(AIError.classify(wrapper), AIError.Flag.Connection)).toBe(true);
	});

	it("keeps a terminal 4xx out of the retry lane when a socket errno rides along", () => {
		// The errno arm reads `code` without looking at the message, so a request
		// the provider rejected as malformed must not become retriable because the
		// socket that carried the rejection was reset afterwards. Stripping only
		// `Connection` would leave `Transient` behind and auto-retry a 400.
		const sameLink = Object.assign(new Error("invalid request"), { status: 400, code: "ECONNRESET" });
		const wrapper = Object.assign(new Error("400 Bad Request"), {
			status: 400,
			cause: Object.assign(new Error("request failed"), { code: "ECONNRESET" }),
		});

		for (const error of [sameLink, wrapper]) {
			const id = AIError.classify(error);
			expect(AIError.is(id, AIError.Flag.Connection)).toBe(false);
			expect(AIError.retriable(id)).toBe(false);
		}
	});

	const WIRE_ERRNOS = ["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"] as const;
	const TERMINAL_STATUSES = [400, 401] as const;

	/** `{ status, message }` behind `depth` plain `Error` wrappers. */
	function behindWrappers(status: number, depth: number): unknown {
		let cause: unknown = { status, message: "request failed" };
		for (let i = 0; i < depth; i++) cause = new Error(`wrapper ${i}`, { cause });
		return cause;
	}

	it.each(
		WIRE_ERRNOS.flatMap(code => TERMINAL_STATUSES.flatMap(status => [0, 1, 3].map(depth => [code, status, depth]))),
	)("keeps the errno %s off the retry lane over a terminal %d %d wrappers deep", (code, status, depth) => {
		// The errno arm reads `code` on the outer error before the walk has
		// reached the status, and `status()` stops at the third link. Gating that
		// arm on the shallow reading made the wrapping depth decide whether a 400
		// or a 401 auto-retries: the finalizer later found the status and dropped
		// `Connection`, but the `Transient` the arm added with it stayed.
		const error = Object.assign(new Error("generic failure", { cause: behindWrappers(status, depth) }), { code });

		const id = AIError.classify(error);
		expect(AIError.is(id, AIError.Flag.Connection)).toBe(false);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
	});

	/** Every way a cause can state a terminal 400 or 401 that the classifier reads. */
	const STATUS_CAUSES: [string, (status: number) => unknown][] = [
		["a plain object's status", status => ({ status, message: "request failed" })],
		["a plain object's statusCode", status => ({ statusCode: status, message: "request failed" })],
		["a plain object's response.status", status => ({ response: { status }, message: "request failed" })],
		["an Error's message", status => new Error(`HTTP ${status} Bad Request`)],
		["a string cause", status => `HTTP ${status} Bad Request`],
		["a plain object's errorMessage", status => ({ errorMessage: `HTTP ${status} Bad Request` })],
	];

	/** `cause` behind `depth` plain `Error` wrappers. */
	function wrapped(cause: unknown, depth: number): unknown {
		let link = cause;
		for (let i = 0; i < depth; i++) link = new Error(`wrapper ${i}`, { cause: link });
		return link;
	}

	it.each(
		STATUS_CAUSES.flatMap(([label, make]) =>
			TERMINAL_STATUSES.flatMap(status =>
				[0, 3, 8, 30].flatMap(depth =>
					[
						["a generic errno", () => Object.assign(new Error("generic failure"), { code: "ECONNRESET" })],
						[
							"wire wording and its errno",
							() => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
						],
						["wire wording alone", () => new Error("socket hang up")],
					].map(([outerLabel, makeOuter]) => [
						outerLabel as string,
						label,
						status,
						depth,
						() => {
							const outer = (makeOuter as () => Error)();
							outer.cause = wrapped(make(status), depth);
							return outer;
						},
					]),
				),
			),
		) as [string, string, number, number, () => Error][],
	)("keeps %s off the retry lane over %s %d, %d wrappers deep", (_outer, _cause, _status, _depth, build) => {
		// A terminal 4xx anywhere in the chain governs the whole chain, whatever
		// carries it and however deep: the text arm and the errno arm both used
		// to set `Transient` from the outer link before the walk reached a status
		// past `status()`'s third link, or one stated only in a cause's text.
		const id = AIError.classify(build());
		expect(AIError.is(id, AIError.Flag.Connection)).toBe(false);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("still lets a deliberate 400 transient through when the status sits deep in the chain", () => {
		// Fireworks' mid-generation NaN 400 replays successfully; the chain-wide
		// status must keep feeding that special case, not only veto.
		const error = new Error("Floating point NaN detected in generation", {
			cause: wrapped({ status: 400, message: "request failed" }, 5),
		});
		expect(AIError.retriable(AIError.classify(error))).toBe(true);
	});

	it("drops a persisted connection classification for a terminal status read from the message", () => {
		// The status is in the text, not on `errorStatus`. The text classifier
		// parses it; the finalizer was handed only the structured status and so
		// kept a `Connection` the message itself contradicts.
		const id = AIError.classifyMessage({
			errorId: AIError.create(AIError.Flag.Connection | AIError.Flag.Transient),
			errorMessage: "HTTP 400 Bad Request",
		});

		expect(AIError.is(id, AIError.Flag.Connection)).toBe(false);
	});

	it.each([
		[
			"a capacity wrapper over a wire-worded cause",
			new Error("model is busy", { cause: new Error("socket hang up") }),
		],
		[
			"a wire-worded wrapper over a capacity cause",
			new Error("socket hang up", { cause: new Error("model is busy") }),
		],
		[
			"a capacity wrapper over a cause carrying only the errno",
			new Error("model is busy", { cause: Object.assign(new Error("request failed"), { code: "ECONNRESET" }) }),
		],
	])("drops the connection lane for %s", (_label, error) => {
		// Capacity is read per link, so a refusal and the wire wording that sits
		// on a different link used to assemble into a held chain against a model
		// that answered and declined for load.
		expect(AIError.is(AIError.classify(error), AIError.Flag.Connection)).toBe(false);
	});

	it("drops the connection lane for a status deeper than the status reader reaches", () => {
		// `status()` stops at the third link, so a wire-worded outer error over
		// three wrappers kept the lane even though the request reached a status
		// line — the case the transport and pre-output retries already replayed.
		const served = new AIError.ProviderHttpError("upstream failed while generating", 500);
		const error = new Error("premature close", {
			cause: new Error("stream failed", { cause: new Error("relay failed", { cause: served }) }),
		});

		expect(AIError.status(error)).toBeUndefined();
		const id = AIError.classify(error);
		expect(AIError.is(id, AIError.Flag.Connection)).toBe(false);
		expect(AIError.retriable(id)).toBe(true);
	});

	it.each([
		[
			"a stream id that reads like a status code",
			"<StreamReset stream_id:503, error_code:2, remote_reset:True>",
			true,
		],
		["a genuine 503 beside a stream reset", "503 Service Unavailable <StreamReset stream_id:1, error_code:2>", false],
		...[7, 429, 503, 529].map(id => [
			`a Go h2 stream error on stream ${id}`,
			`stream error: stream ID ${id}; INTERNAL_ERROR; received from peer`,
			true,
		]),
		...[1, 429, 503, 529].map(id => [
			`a Go h2 GOAWAY naming last stream ${id}`,
			`http2: server sent GOAWAY and closed the connection; LastStreamID=${id}, ErrCode=NO_ERROR, debug=""`,
			true,
		]),
		[
			"a genuine 503 beside a Go h2 stream error",
			"stream error: stream ID 503; INTERNAL_ERROR; received from peer: 503 Service Unavailable",
			false,
		],
	] as [string, string, boolean][])("reads %s correctly", (_label, errorMessage, connection) => {
		// The capacity readers search for bare `429`/`503`/`529` tokens, which an
		// h2 stream number satisfies by accident: Python's `stream_id:503` and
		// Go's `stream ID 503` / `LastStreamID=503` name a stream, not a refusal,
		// and the reset they report never reached a status line. A status token
		// elsewhere in the same diagnostic still counts.
		expect(flagsOfMessage(errorMessage).connection).toBe(connection);
	});

	const WIRE = "upstream closed the connection";

	it.each(
		["400", "401", "403", "429", "503", "529"].flatMap(code => [
			[`a URL path segment ${code}`, `${WIRE}: https://gateway.invalid/jobs/${code}/result`],
			[`a URL query status=${code}`, `${WIRE}: https://gateway.invalid/poll?status=${code}`],
			[`a URL port ${code}`, `${WIRE}: http://127.0.0.1:${code}/v1/messages`],
			[`a bare path segment ${code}`, `${WIRE} while reading /v1/jobs/${code}/result`],
			[`a header name segment ${code}`, `${WIRE}: x-request-${code}-trace=abc`],
			[`an id field ${code}`, `${WIRE} (request_id=${code})`],
			[`a model id with ${code}`, `${WIRE} for model gpt-${code}-preview`],
		]),
	)("keeps the connection lane and retry for %s", (_label, errorMessage) => {
		// A number inside a URL, glued into an identifier or naming an id is
		// metadata. Read as a bare status it made a wire cut a capacity refusal,
		// an auth rejection or a terminal 400, and the session walked the chain
		// (or stopped) after one request.
		expect(flagsOfMessage(errorMessage)).toEqual({ connection: true, retriable: true });
	});

	it.each([
		["a status line", `${WIRE}: HTTP 503`, false],
		["a status field", `${WIRE} (status=529)`, false],
		["a leading status", `503 Service Unavailable: ${WIRE}`, false],
		["a parenthesised status", `${WIRE} (429)`, false],
		["a status next to a URL", `${WIRE}: HTTP 503 from https://gateway.invalid/v1`, false],
		["a status field next to an id", `${WIRE} status=503 request_id=7`, false],
	] as [string, string, boolean][])("still reads explicit capacity in %s", (_label, errorMessage, connection) => {
		expect(flagsOfMessage(errorMessage).connection).toBe(connection);
	});

	it("does not read a status from a URL query", () => {
		expect(AIError.status(new Error(`${WIRE}: https://gateway.invalid/poll?status=400`))).toBeUndefined();
		expect(AIError.status(new Error(`${WIRE}: status=400 at https://gateway.invalid/poll`))).toBe(400);
	});

	const DURATION_VALUES = [399, 400, 401, 403, 429, 500, 503, 529, 8000];
	it.each(
		DURATION_VALUES.flatMap(n => [
			`retry-after-ms=${n}`,
			`elapsed_ms=${n}`,
			`retry-after: ${n}`,
			`latencyMs=${n}`,
			`{"elapsed":${n}}`,
			`after ${n} ms`,
			`after ${n}ms`,
			`timed ${n} seconds`,
		]),
	)("keeps the connection lane and the retry for a wire cut carrying %s", suffix => {
		// A duration, a delay hint or a size is metadata, whatever number it
		// holds. Read as a bare status, `retry-after-ms=401` made a socket reset
		// an auth rejection that never retries, and `=529` made it a capacity
		// refusal that walks the chain after one request.
		const id = AIError.classify(new Error(`read ECONNRESET ${suffix}`));
		expect(AIError.is(id, AIError.Flag.Connection)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
		expect(AIError.status(new Error(`read ECONNRESET ${suffix}`))).toBeUndefined();
	});

	it.each([
		["a status field", "read ECONNRESET status=529", 529],
		["a quoted status key", 'read ECONNRESET {"status":503}', undefined],
		["a camel-case status key", "read ECONNRESET statusCode: 503", undefined],
		["an upstream status key", "read ECONNRESET upstream_status=429", undefined],
		["an error field", "read ECONNRESET error=503", 503],
		["a status line beside a duration", "read ECONNRESET HTTP 503 elapsed_ms=12", 503],
	] as [string, string, number | undefined][])("still reads capacity in %s", (_label, errorMessage, expected) => {
		// A status-named field keeps its number, so the capacity it names still
		// takes the cut off the connection lane. `status()` reads only the
		// spellings it read before; the field keys it never parsed stay capacity
		// evidence without becoming a parsed status.
		expect(AIError.status(new Error(errorMessage))).toBe(expected);
		expect(AIError.is(AIError.classify(new Error(errorMessage)), AIError.Flag.Connection)).toBe(false);
	});

	/** Every time unit spelling the classifier must read as a unit, glued and spaced. */
	const TIME_UNITS = [
		"ns",
		"nanoseconds",
		"us",
		"µs",
		"μs",
		"microseconds",
		"ms",
		"milliseconds",
		"s",
		"sec",
		"seconds",
		"m",
		"min",
		"minutes",
		"h",
		"hours",
		"d",
		"days",
	];
	const ROLE_STATUSES = [400, 401, 403, 429, 500, 503, 529];

	it.each(
		ROLE_STATUSES.flatMap(n =>
			TIME_UNITS.flatMap(unit => [`after ${n} ${unit}`, `after ${n}${unit}`, `after ${n}.5 ${unit}`]),
		),
	)("reads a number with a time unit as a duration: %s", suffix => {
		// The unit decides the number's role, whatever surrounds it: a duration is
		// never a status, so it neither takes the cut off the connection lane nor
		// stops the retry.
		const error = new Error(`read ECONNRESET ${suffix}`);
		const id = AIError.classify(error);
		expect(AIError.is(id, AIError.Flag.Connection)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
		expect(AIError.status(error)).toBeUndefined();
	});

	it.each(
		ROLE_STATUSES.flatMap(n => [
			`elapsed: ${n}`,
			`duration: ${n}`,
			`latency: ${n}`,
			`timeout = ${n}`,
			`elapsed_ms="${n}"`,
			`elapsed_ms='${n}'`,
			`latency_ns=${n}`,
			`waitSeconds: ${n}`,
			`"retry_after": "${n}"`,
			`https://gateway.invalid/poll?elapsed=${n}us`,
			`https://gateway.invalid/poll?delay=${n}%20ns`,
		]),
	)("reads a time-named field as a duration, quoted or not: %s", suffix => {
		const error = new Error(`read ECONNRESET ${suffix}`);
		const id = AIError.classify(error);
		expect(AIError.is(id, AIError.Flag.Connection)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
		expect(AIError.status(error)).toBeUndefined();
	});

	it.each(
		ROLE_STATUSES.flatMap(status =>
			[`after 401 ns; HTTP ${status}`, `elapsed_ms="503"; HTTP ${status}`, `HTTP ${status} after 2.5 s`].map(
				text => [status, text],
			),
		) as [number, string][],
	)("classifies a status beside a duration as the status alone: HTTP %d in %s", (status, text) => {
		// The duration is removed, never the status: the message classifies the
		// way `read ECONNRESET HTTP <status>` does.
		const withDuration = new Error(`read ECONNRESET ${text}`);
		const alone = new Error(`read ECONNRESET HTTP ${status}`);
		expect(AIError.classify(withDuration)).toBe(AIError.classify(alone));
		expect(AIError.status(withDuration)).toBe(status);
	});

	it.each([
		["a status line", "503 Service Unavailable", 503],
		["a status after a prose colon", "upstream closed the connection: 503 Service Unavailable", 503],
		["a status glued into CJK prose", "服务器返回503错误", undefined],
	] as [string, string, number | undefined][])(
		"keeps a status that is not a duration: %s",
		(_label, text, expected) => {
			// `503 Service` is not `503 s`, a plain word before a colon is prose, and
			// CJK glues the status to its words without making it an identifier.
			expect(AIError.status(new Error(text))).toBe(expected);
			expect(AIError.is(AIError.classify(new Error(`read ECONNRESET ${text}`)), AIError.Flag.Connection)).toBe(
				false,
			);
		},
	);

	it("keeps a rejected credential off the connection lane", () => {
		// The far side answered and refused the credential; replaying it holds the
		// session on a route that refuses it again, and the hold reads only the
		// connection bit.
		expect(flagsOfMessage("authentication failed: socket is closed")).toEqual({
			connection: false,
			retriable: false,
		});
		const assembled = AIError.classify(new Error("authentication failed", { cause: new Error("socket hang up") }));
		expect(AIError.is(assembled, AIError.Flag.AuthFailed)).toBe(true);
		expect(AIError.is(assembled, AIError.Flag.Connection)).toBe(false);
	});

	it.each([
		["a forwarded nghttp2 internal error", "Stream closed with error code NGHTTP2_INTERNAL_ERROR", true],
		[
			"a forwarded nghttp2 refused stream",
			"Connect error failed_precondition: Error: Stream closed with error code NGHTTP2_REFUSED_STREAM",
			true,
		],
		["a Go h2 stream error frame", "stream error: stream ID 7; INTERNAL_ERROR; received from peer", true],
		["a model reporting an internal error", "500 Internal Server Error: internal error while generating", false],
	])("reads %s correctly", (_label, errorMessage, connection) => {
		// An HTTP/2 peer reset is a cut stream with no status line of its own,
		// and these are the spellings turn recovery already treats as transport
		// resets; a model's own "internal error" prose is not one.
		expect(flagsOfMessage(errorMessage).connection).toBe(connection);
	});
});
