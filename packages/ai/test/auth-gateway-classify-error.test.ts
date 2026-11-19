import { describe, expect, it } from "bun:test";
import { classifyGatewayError } from "@oh-my-pi/pi-ai/error";

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
});
