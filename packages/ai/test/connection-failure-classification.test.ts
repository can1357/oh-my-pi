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
});
