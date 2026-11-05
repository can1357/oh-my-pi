import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";

describe("AIError.classify — structural provider errors", () => {
	it("classifies an Anthropic connection timeout as timeout + transient (no regex)", () => {
		const id = AIError.classify(new AIError.AnthropicConnectionTimeoutError());
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("classifies an Anthropic connection error as transient", () => {
		const id = AIError.classify(new AIError.AnthropicConnectionError(new Error("ECONNRESET")));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("maps a 5xx ProviderHttpError to transient via status", () => {
		const id = AIError.classify(new AIError.ProviderHttpError("Service Unavailable", 503));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("maps the overloaded_error code to transient regardless of status", () => {
		const id = AIError.classify(new AIError.ProviderHttpError("Overloaded", 529, { code: "overloaded_error" }));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("classifies statusless provider capacity errors as transient and retryable", () => {
		const messages = [
			"Error Code no_capacity: The system is currently experiencing high demand",
			"Provider is at capacity",
			"Insufficient capacity during peak load",
			"Capacity exhausted",
		];
		for (const message of messages) {
			const id = AIError.classify(new Error(message));
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		}
	});

	it("does not treat benign capacity descriptions as transient", () => {
		const id = AIError.classify(new Error("This model has a 128k token capacity"));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
	});

	it("maps 401/403 to authFailed via status", () => {
		expect(
			AIError.is(AIError.classify(new AIError.ProviderHttpError("Unauthorized", 401)), AIError.Flag.AuthFailed),
		).toBe(true);
		expect(
			AIError.is(AIError.classify(new AIError.ProviderHttpError("Forbidden", 403)), AIError.Flag.AuthFailed),
		).toBe(true);
	});

	it("classifies a typed AWS credential-resolution failure as authFailed", () => {
		const id = AIError.classify(new AIError.AwsCredentialsError("opaque provider setup failure", "resolution"));
		expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(true);
	});

	it("maps the usage_limit_reached code to usageLimit on a 429", () => {
		const id = AIError.classify(
			new AIError.ProviderHttpError("Payment Required", 429, { code: "usage_limit_reached" }),
		);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
	});

	it("recognizes Codex transport errors by name without importing the provider", () => {
		const transport = Object.assign(new Error("websocket closed"), { name: "CodexWebSocketTransportError" });
		expect(AIError.is(AIError.classify(transport), AIError.Flag.Transient)).toBe(true);
		const retryableStream = Object.assign(new Error("server error"), {
			name: "CodexProviderStreamError",
			retryable: true,
		});
		expect(AIError.is(AIError.classify(retryableStream), AIError.Flag.Transient)).toBe(true);
		const fatalStream = Object.assign(new Error("bad request"), {
			name: "CodexProviderStreamError",
			retryable: false,
		});
		expect(AIError.is(AIError.classify(fatalStream), AIError.Flag.Transient)).toBe(false);
	});

	it("classifies an incomplete provider stream as transient + retryable", () => {
		const err = new AIError.ProviderResponseError(
			"Google API stream ended without a finish reason (connection dropped or response truncated)",
			{ provider: "google", kind: "incomplete-stream" },
		);
		const id = AIError.classify(err);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("keeps a terminal 4xx that wraps a stream-truncation cause terminal", () => {
		const err = new AIError.ProviderHttpError("Bad Request", 400, { cause: new Error("unexpected EOF") });
		const id = AIError.classify(err);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("keeps a retryable-status wrapper over a stream-truncation cause transient", () => {
		for (const wrapped of [
			new AIError.ProviderHttpError("Service Unavailable", 503, { cause: new Error("unexpected EOF") }),
			new AIError.ProviderHttpError("Too Many Requests", 429, { cause: new Error("eof while parsing") }),
		]) {
			const id = AIError.classify(wrapped);
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		}
	});

	it("keeps empty response bodies on the generic transient fallback path", () => {
		const err = new AIError.ProviderResponseError("Google API returned an empty response body", {
			provider: "google",
			kind: "empty-body",
		});
		const id = AIError.classify(err);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.EmptyResponse)).toBe(false);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("classifies thought-only output as transient + empty-response + retryable", () => {
		const err = new AIError.ProviderResponseError(
			"Cloud Code Assist API returned a thought-only response without final output",
			{
				provider: "google-antigravity",
				kind: "empty-output",
			},
		);
		const id = AIError.classify(err);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.EmptyResponse)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("does not mark a terminal output provider error as transient", () => {
		const err = new AIError.ProviderResponseError("upstream error", { provider: "google", kind: "output" });
		expect(AIError.retriable(AIError.classify(err))).toBe(false);
	});
});

describe("AIError.finalize", () => {
	it("bundles id, status, error stopReason, and message for a connection timeout", async () => {
		const result = await AIError.finalize(new AIError.AnthropicConnectionTimeoutError(), {});
		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(result.id, AIError.Flag.Transient)).toBe(true);
		expect(result.message.length).toBeGreaterThan(0);
	});

	it("reports aborted when the caller signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await AIError.finalize(new Error("cancelled"), { signal: controller.signal });
		expect(result.stopReason).toBe("aborted");
	});

	it("surfaces the HTTP status from a ProviderHttpError", async () => {
		const result = await AIError.finalize(new AIError.ProviderHttpError("Bad Gateway", 502), {});
		expect(result.status).toBe(502);
		expect(AIError.is(result.id, AIError.Flag.Transient)).toBe(true);
	});

	it("applies a captured terminal 4xx before classifying a truncation error", async () => {
		const result = await AIError.finalize(new Error("unexpected EOF"), {
			capturedErrorResponse: { status: 400 },
		});

		expect(result.status).toBe(400);
		expect(AIError.is(result.id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(result.id)).toBe(false);
	});

	it("preserves nested token-overflow evidence through finalization", async () => {
		const inner = Object.assign(new Error("Error: maximum context length is 128000 tokens"), { status: 413 });
		const result = await AIError.finalize(new Error("Provider returned error", { cause: inner }));

		expect(AIError.is(result.id, AIError.Flag.ContextOverflow)).toBe(true);
		expect(AIError.is(result.id, AIError.Flag.PayloadRejected)).toBe(false);
	});

	it("keeps an incomplete-stream provider error retryable through finalize + classifyMessage", async () => {
		const result = await AIError.finalize(
			new AIError.ProviderResponseError("stream ended without a finish reason", { kind: "incomplete-stream" }),
			{},
		);
		expect(result.stopReason).toBe("error");
		expect(AIError.retriable(result.id)).toBe(true);
		// The transient flag survives a re-classify from the persisted message fields.
		const reId = AIError.classifyMessage({ errorId: result.id, errorMessage: result.message });
		expect(AIError.retriable(reId)).toBe(true);
	});

	it("treats Aliyun multimodal-gateway 400s as transient (flaky, replay succeeds)", () => {
		const phrasings = [
			"400 <400> InternalError.Algo.InvalidParameter: The provided URL does not appear to be valid. Ensure it is correctly formatted.\n<400> InternalError.Algo.InvalidParameter: The provided URL does not appear to be valid. Ensure it is correctly formatted. (type=invalid_request_error param=invalid_parameter_error)",
			"400 <400> InternalError.Algo.InvalidParameter: Download multimodal file timed out\n<400> InternalError.Algo.InvalidParameter: Download multimodal file timed out (type=invalid_request_error param=invalid_parameter_error)",
		];
		for (const errorMessage of phrasings) {
			const id = AIError.classifyMessage({ errorStatus: 400, errorMessage });
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		}
	});

	it("keeps genuine 400 validation errors terminal", () => {
		const id = AIError.classifyMessage({
			errorStatus: 400,
			errorMessage: "400 invalid_request_error: unknown field 'temperaturee' in request body",
		});
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
	});
});

describe("aierr flag helpers", () => {
	it("compose then has round-trips multiple flags", () => {
		const id = AIError.create(AIError.Flag.ThinkingLoop, AIError.Flag.Transient);
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(false);
	});

	it("treats transient and usageLimit ids as retryable", () => {
		expect(AIError.retriable(AIError.create(AIError.Flag.Transient))).toBe(true);
		expect(AIError.retriable(AIError.create(AIError.Flag.UsageLimit))).toBe(true);
	});

	it("recognizes explicit transient stream parse diagnostics without broad text false positives", () => {
		const message = "JSON Parse error: Unterminated string";
		expect(AIError.isTransientStreamParseError(new Error(message))).toBe(true);
		expect(AIError.isTransientStreamParseError(new Error("response truncated"))).toBe(true);
		expect(AIError.isTransientStreamParseError(message)).toBe(true);
		expect(AIError.isTransientStreamParseError("Unexpected end of JSON input")).toBe(true);
		expect(AIError.isTransientStreamParseError("JSON.parse: unexpected end of data at line 1 column 8")).toBe(true);
		expect(AIError.isTransientStreamParseError("Unexpected EOF")).toBe(true);
		expect(AIError.isTransientStreamParseError("EOF while parsing")).toBe(true);
		expect(AIError.isTransientStreamParseError("truncated")).toBe(false);
		expect(AIError.isTransientStreamParseError("end of file")).toBe(false);
		expect(AIError.isTransientStreamParseError("Unexpected token in JSON")).toBe(false);
	});
});

describe("OpenAIHttpError.parseEnvelope — where the error actually is", () => {
	// What a user reads when a provider declines or fails is whatever this returns. The positions
	// below are the ones real hosts use; each was found by driving the product after an earlier
	// enumeration had been called complete.
	const body = (value: unknown) => AIError.OpenAIHttpError.parseEnvelope(value, JSON.stringify(value));

	it("reads the message out of a wrapper whose inner object carries only a message", () => {
		// No code anywhere, so the only thing worth surfacing is the sentence. Reporting the raw
		// JSON body instead shows the user a blob and hides the provider's own explanation.
		expect(body({ error: { error: { message: "the real explanation" } } })).toEqual({
			detail: "the real explanation",
			code: undefined,
		});
	});

	it("prefers the root's own code to a diagnostic object beside it", () => {
		expect(body({ code: "cyber_policy", message: "declined", error: { code: "invalid_api_key" } })).toEqual({
			detail: "declined",
			code: "cyber_policy",
		});
	});

	it("finds a Responses-shaped failure delivered as a non-2xx body", () => {
		const envelope = { code: "cyber_policy", message: "declined" };
		expect(body({ response: { status: "failed", error: envelope } })).toEqual({
			detail: "declined",
			code: "cyber_policy",
		});
		expect(body({ response: { status: "failed", status_details: { error: envelope } } })).toEqual({
			detail: "declined",
			code: "cyber_policy",
		});
	});

	it("invents no code for a response-shaped body that carries no error", () => {
		// The `response` branch above must not turn a completed response into a failure with a
		// borrowed code; only an `error` object inside it counts.
		expect(body({ response: { status: "completed", output: [] } }).code).toBeUndefined();
		expect(body({ id: "resp_1", output: [] }).code).toBeUndefined();
	});
});

describe("which refusals never rotate credentials", () => {
	// "May a sibling credential see something different": for an organization's own classifier the
	// answer is no, for every code in the table, so rotating spends siblings on a decided verdict.
	// Whether a resend is worth trying is the other question, and the session tests answer it.
	it("covers the organization-classifier codes and nothing else", () => {
		expect(AIError.isContentPolicyRefusal("cyber_policy", "declined")).toBe(true);
		expect(AIError.isContentPolicyRefusal("reasoning_extraction", "declined")).toBe(true);
		expect(AIError.isContentPolicyRefusal("sensitive", "declined")).toBe(false);
		expect(AIError.isContentPolicyRefusal("refusal", "declined")).toBe(false);
	});

	it("lets an account-eligibility denial keep rotating", () => {
		// Trusted Access names an account that can be enrolled, so a sibling really can serve it.
		expect(AIError.isContentPolicyRefusal("cyber_policy", "Your account needs Trusted Access for Cyber")).toBe(false);
	});
});

describe("a refusal code in free text, and only where a code can appear", () => {
	// The last-resort path for a provider that surfaces nothing structured. Matching the bare
	// token anywhere makes any text that merely MENTIONS the code a refusal — a log line about
	// this classifier, a user message quoting one, a report discussing one — so the token must sit
	// where a code sits: at the start, after `code=`/`type=`, or inside brackets or quotes.
	const blocked = (message: string) =>
		AIError.is(
			AIError.classify(new AIError.ProviderResponseError(message, { provider: "p", kind: "runtime" })),
			AIError.Flag.ContentBlocked,
		);

	it.each([
		"cyber_policy: This content was flagged for possible cybersecurity risk",
		"reasoning_extraction: the request replays prior reasoning",
		'{"code":"cyber_policy","message":"declined"}',
		"400 request id 42 (type=cyber_policy param=detail)",
	])("classifies a code in a code position: %s", message => {
		expect(blocked(message)).toBe(true);
	});

	it.each([
		"the reasoning_extraction classifier refused an unrelated request earlier",
		"see the findings file for notes on cyber_policy handling",
		"upstream timed out while we were discussing reasoning_extraction with support",
	])("does not classify prose that merely mentions the code: %s", message => {
		expect(blocked(message)).toBe(false);
	});
});
