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
