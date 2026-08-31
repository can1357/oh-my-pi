import { describe, expect, it } from "bun:test";
import { classifyGatewayError, isRetryableGatewayDisposition } from "@oh-my-pi/pi-ai/error";

describe("auth-gateway classifyGatewayError", () => {
	it("honours an explicit numeric `status` property on the error", () => {
		const err = Object.assign(new Error("boom"), { status: 503 });
		const c = classifyGatewayError(err);
		expect(c.status).toBe(503);
		expect(c.type).toBe("upstream_error");
	});

	it("maps 401/403 to authentication_error via status property", () => {
		expect(classifyGatewayError(Object.assign(new Error(""), { status: 401 })).type).toBe("authentication_error");
		expect(classifyGatewayError(Object.assign(new Error(""), { status: 403 })).type).toBe("authentication_error");
	});

	it("maps 429 to rate_limit_error via status property", () => {
		expect(classifyGatewayError(Object.assign(new Error(""), { status: 429 })).type).toBe("rate_limit_error");
	});

	it("does NOT misclassify `GenerateContentRequest` 400 as rate-limited (the original bug)", () => {
		// Verbatim shape Google emits when functionResponse.name is missing.
		const msg =
			"Google API error (400): * GenerateContentRequest.contents[2].parts[0].function_response.name: Name cannot be empty.";
		const c = classifyGatewayError(new Error(msg));
		expect(c.status).toBe(400);
		expect(c.type).toBe("invalid_request_error");
	});

	it("extracts embedded status codes from common message shapes", () => {
		const cases: Array<[string, number, string]> = [
			["OpenAI API error (429): too many requests", 429, "rate_limit_error"],
			["HTTP 503: upstream gone away", 503, "upstream_error"],
			["status: 401 unauthorized", 401, "authentication_error"],
			["status_code=400 — bad json", 400, "invalid_request_error"],
			["Anthropic API error (529): overloaded", 529, "upstream_error"],
		];
		for (const [msg, status, type] of cases) {
			const c = classifyGatewayError(new Error(msg));
			expect({ msg, status: c.status, type: c.type }).toEqual({ msg, status, type });
		}
	});

	it("ignores incidental three-digit numbers without a status keyword", () => {
		// "took 200ms" should not get classified as 2xx and short-circuit.
		const c = classifyGatewayError(new Error("upstream took 200ms then timed out"));
		// Falls through all heuristics → default upstream_error/502.
		expect(c.status).toBe(502);
	});

	it("still recognizes rate-limit wording when no status is embedded", () => {
		const c = classifyGatewayError(new Error("too many requests — back off"));
		expect(c.status).toBe(429);
		expect(c.type).toBe("rate_limit_error");
	});

	it("prefers rate-limit wording over auth wording", () => {
		const c = classifyGatewayError(new Error("Rate limit exceeded - unauthorized due to throttling"));
		expect(c.status).toBe(429);
		expect(c.type).toBe("rate_limit_error");
	});

	it("classifies Codex 'You have hit your ChatGPT usage limit' as 429", () => {
		// Verbatim shape Codex returns from the `usage_limit_reached` branch
		// in `parseCodexError`. No embedded `HTTP NNN`/`(NNN)`/`status NNN`
		// token, no `rate limit`/`too many requests` wording — only the
		// gateway's `isUsageLimitError` branch catches this. Previously it
		// fell through to the default 502/upstream_error, which is why the
		// `lg` retry loop kept looping instead of switching to another
		// credential.
		const c = classifyGatewayError(
			new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."),
		);
		expect(c.status).toBe(429);
		expect(c.type).toBe("rate_limit_error");
	});

	it("classifies generic 'usage_limit_reached' code text as 429", () => {
		const c = classifyGatewayError(new Error('{"code":"usage_limit_reached","message":"…"}'));
		expect(c.status).toBe(429);
		expect(c.type).toBe("rate_limit_error");
	});

	it("does not match 'rate' inside camelCase or compound words", () => {
		// `Generate`, `iterate`, `deprecated`, `accelerate` all contain `rate` as
		// a substring and used to trip the classifier.
		for (const msg of [
			"GenerateContentRequest validation failed",
			"iterate over the candidate list",
			"deprecated field on response",
			"AccelerateProvider not registered",
		]) {
			const c = classifyGatewayError(new Error(msg));
			expect({ msg, status: c.status }).not.toEqual({ msg, status: 429 });
		}
	});

	it("classifies AbortError instances as 499 request_aborted", () => {
		const err = new Error("client gave up");
		err.name = "AbortError";
		const c = classifyGatewayError(err);
		expect(c.status).toBe(499);
		expect(c.type).toBe("request_aborted");
	});

	it("classifies AbortError as 499 even when a numeric status is attached (negative)", () => {
		const err = Object.assign(new Error("aborted"), { status: 503 });
		err.name = "AbortError";
		const c = classifyGatewayError(err);
		expect(c.status).toBe(499);
		expect(c.owner).toBe("cancelled");
		expect(c.disposition).toBe("cancelled");
	});

	it("classifies word-boundaried 'aborted' wording as 499", () => {
		const c = classifyGatewayError(new Error("request aborted by caller"));
		expect(c.status).toBe(499);
		expect(c.type).toBe("request_aborted");
	});

	it("falls through to 502 upstream_error when nothing matches", () => {
		const c = classifyGatewayError(new Error("something inscrutable happened"));
		expect(c.status).toBe(502);
		expect(c.type).toBe("upstream_error");
	});

	it("keeps GenerateContentRequest 400 as request_terminal, never credential_quota", () => {
		const msg =
			"Google API error (400): * GenerateContentRequest.contents[2].parts[0].function_response.name: Name cannot be empty.";
		const c = classifyGatewayError(new Error(msg));
		expect(c.status).toBe(400);
		expect(c.owner).toBe("request");
		expect(c.disposition).toBe("request_terminal");
		expect(c.disposition).not.toBe("credential_quota");
	});

	it("maps usage-limit wording to quota/credential_quota, not request_terminal", () => {
		const c = classifyGatewayError(
			new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."),
		);
		expect(c.status).toBe(429);
		expect(c.owner).toBe("quota");
		expect(c.disposition).toBe("credential_quota");
		expect(c.disposition).not.toBe("request_terminal");
	});

	it("never treats gateway_terminal as a retryable provider failure", () => {
		const err = Object.assign(new Error("internal invariant: stream already committed"), { owner: "gateway" });
		const c = classifyGatewayError(err);
		expect(c.owner).toBe("gateway");
		expect(c.disposition).toBe("gateway_terminal");
		expect(isRetryableGatewayDisposition(c.disposition)).toBe(false);
		expect(c.disposition).not.toBe("provider_unavailable");
		expect(c.disposition).not.toBe("provider_transient");
	});

	it("maps AbortError to cancelled rather than a retryable owner", () => {
		const err = new Error("client gave up");
		err.name = "AbortError";
		const c = classifyGatewayError(err);
		expect(c.status).toBe(499);
		expect(c.owner).toBe("cancelled");
		expect(c.disposition).toBe("cancelled");
		expect(isRetryableGatewayDisposition(c.disposition)).toBe(false);
	});

	it("maps 401 revoked wording to credential_permanent, not credential_transient", () => {
		const c = classifyGatewayError(Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }));
		expect(c.owner).toBe("credential");
		expect(c.disposition).toBe("credential_permanent");
		expect(c.disposition).not.toBe("credential_transient");
	});

	it("maps provider-wide 429 to provider_transient rather than credential_quota", () => {
		const c = classifyGatewayError(Object.assign(new Error("service overloaded"), { status: 429 }));
		expect(c.status).toBe(429);
		expect(c.owner).toBe("provider");
		expect(c.disposition).toBe("provider_transient");
		expect(c.disposition).not.toBe("credential_quota");
	});

	it("maps 5xx timeout wording to provider_transient", () => {
		const c = classifyGatewayError(Object.assign(new Error("upstream timed out"), { status: 503 }));
		expect(c.owner).toBe("provider");
		expect(c.disposition).toBe("provider_transient");
	});

	it("maps HTTP 408 to upstream_error / provider_transient (not request_terminal)", () => {
		const c = classifyGatewayError(Object.assign(new Error("request timed out"), { status: 408 }));
		expect(c.status).toBe(408);
		expect(c.type).toBe("upstream_error");
		expect(c.owner).toBe("provider");
		expect(c.disposition).toBe("provider_transient");
		expect(isRetryableGatewayDisposition(c.disposition)).toBe(true);
	});

	it("maps embedded HTTP 408 the same as an explicit status property", () => {
		const c = classifyGatewayError(new Error("HTTP 408: Request Timeout"));
		expect(c.status).toBe(408);
		expect(c.type).toBe("upstream_error");
		expect(c.disposition).toBe("provider_transient");
	});

	it("falls through inscrutable 502 to provider_unavailable", () => {
		const c = classifyGatewayError(new Error("something inscrutable happened"));
		expect(c.status).toBe(502);
		expect(c.owner).toBe("provider");
		expect(c.disposition).toBe("provider_unavailable");
	});
});

describe("classifyGatewayError authoritative-status precedence", () => {
	it("keeps an authoritative 5xx provider-owned even when echoed detail mentions context length", () => {
		const c = classifyGatewayError(new Error("HTTP 500: internal error while truncating context length check"));
		expect(c.status).toBe(500);
		expect(c.owner).toBe("provider");
		expect(c.disposition).not.toBe("context_overflow");
	});

	it("keeps a 5xx provider-owned when echoed detail mentions revoked", () => {
		const c = classifyGatewayError(new Error("HTTP 503: upstream cache row revoked unexpectedly"));
		expect(c.status).toBe(503);
		expect(c.owner).toBe("provider");
		expect(c.disposition).not.toBe("credential_permanent");
	});

	it("maps a 400 invalid_grant OAuth failure to credential_permanent", () => {
		const c = classifyGatewayError(new Error("API error (400): invalid_grant — token expired or revoked"));
		expect(c.owner).toBe("credential");
		expect(c.disposition).toBe("credential_permanent");
	});

	it("maps a 400 context-overflow rejection to context_overflow", () => {
		const c = classifyGatewayError(new Error("API error (400): prompt is too long: context length exceeded"));
		expect(c.owner).toBe("request");
		expect(c.disposition).toBe("context_overflow");
	});
});

describe("classifyGatewayError review follow-ups", () => {
	it("does not let abort wording override an authoritative provider status", () => {
		const c = classifyGatewayError(Object.assign(new Error("HTTP 503: upstream request aborted"), { status: 503 }));
		expect(c.status).toBe(503);
		expect(c.owner).toBe("provider");
		expect(c.disposition).not.toBe("cancelled");
	});

	it("keeps no-status overflow evidence terminal instead of provider_unavailable", () => {
		const c = classifyGatewayError(new Error("prompt is too long: context length exceeded"));
		expect(c.disposition).toBe("context_overflow");
		expect(c.disposition).not.toBe("provider_unavailable");
	});
});

describe("classifyGatewayError policy before auth", () => {
	it("maps 403 cyber_policy Trusted Access denials to policy_terminal", () => {
		const c = classifyGatewayError(
			Object.assign(
				new Error(
					"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
				),
				{ status: 403 },
			),
		);
		expect(c.owner).toBe("policy");
		expect(c.disposition).toBe("policy_terminal");
	});
});
