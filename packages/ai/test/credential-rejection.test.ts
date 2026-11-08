import { describe, expect, it } from "bun:test";
import {
	credentialRejectionVerdict,
	isCredentialRejection,
	ProviderHttpError,
	statesCredentialRejection,
} from "@oh-my-pi/pi-ai/error";

/**
 * Refusals measured 2026-11-08 against Theorem's model gateway (a LiteLLM
 * proxy) at `https://model-gateway.tail12ec1c.ts.net`, with a junk identity
 * token minted locally — never a live credential. Captured on `/v1/models`,
 * `/v1/messages`, `/v1/chat/completions` and `/v1/responses`; every route
 * answered with the same body shape.
 *
 * These are the fixtures the retry path's match is for. If the gateway changes
 * BOTH its structured error class and its wording, the "a real refusal still
 * matches" test below reds rather than the retry silently ceasing to fire.
 */
const GATEWAY_REFUSALS: Record<string, { message: string; type: string; param?: string; code: string }> = {
	"no Authorization header": {
		message: "Authentication Error, No api key passed in.",
		type: "auth_error",
		code: "401",
	},
	"a bearer that is not a JWT": {
		message: "LiteLLM Virtual Key expected. Received=not-****-all, expected to start with 'sk-'.",
		type: "auth_error",
		code: "401",
	},
	"an identity token Google did not sign": {
		message: "This identity token is signed by no key Google publishes.",
		type: "auth_error",
		param: "Authorization",
		code: "401",
	},
	// The gateway owner's wording for a token past its `exp`: the condition
	// this whole path exists for.
	"an identity token past its exp": {
		message: "This identity token is not one this gateway accepts.",
		type: "auth_error",
		param: "Authorization",
		code: "401",
	},
};

/** The raw body, as the Anthropic wire keeps it in the error message. */
function rawBodyMessage(refusal: { message: string; type: string; param?: string; code: string }): string {
	return `401 ${JSON.stringify({ error: refusal })}`;
}

/** The re-rendered `(type=… param=… code=…)` form the OpenAI wires produce. */
function renderedMessage(refusal: { message: string; type: string; param?: string; code: string }): string {
	const fields = [`type=${refusal.type}`, refusal.param && `param=${refusal.param}`, `code=${refusal.code}`]
		.filter(Boolean)
		.join(" ");
	return `401 ${refusal.message} (${fields})`;
}

describe("credentialRejectionVerdict", () => {
	it.each(Object.keys(GATEWAY_REFUSALS))("reads the structured class out of the raw body: %s", name => {
		const refusal = GATEWAY_REFUSALS[name]!;
		const error = new ProviderHttpError(rawBodyMessage(refusal), 401);
		expect(credentialRejectionVerdict(error)).toBe("structured");
		expect(statesCredentialRejection(error)).toBe(true);
	});

	it.each(Object.keys(GATEWAY_REFUSALS))("reads the structured class out of the rendering: %s", name => {
		const refusal = GATEWAY_REFUSALS[name]!;
		const error = new ProviderHttpError(renderedMessage(refusal), 401);
		expect(credentialRejectionVerdict(error)).toBe("structured");
	});

	/**
	 * The requirement the gateway owner set: the match must not depend on
	 * wording alone, and it must not depend on the structured class alone
	 * either. This test reds if a real refusal matches through neither.
	 */
	it.each(Object.keys(GATEWAY_REFUSALS))("still matches with the structured class stripped: %s", name => {
		const refusal = GATEWAY_REFUSALS[name]!;
		const textOnly = new ProviderHttpError(`401 ${refusal.message}`, 401);
		const verdict = credentialRejectionVerdict(textOnly);
		expect(verdict).toBe("text");
		expect(statesCredentialRejection(textOnly)).toBe(true);
	});

	it("reads the assistant-message shape the stream driver carries", () => {
		const refusal = GATEWAY_REFUSALS["an identity token past its exp"]!;
		expect(credentialRejectionVerdict({ errorStatus: 401, errorMessage: rawBodyMessage(refusal) })).toBe(
			"structured",
		);
	});

	it("takes OpenAI's rejected key from the code when its type is not an auth class", () => {
		// OpenAI reports a bad key as type=invalid_request_error code=invalid_api_key.
		const body = JSON.stringify({
			error: {
				message: "Incorrect API key provided: sk-***. You can find your API key at https://platform.openai.com.",
				type: "invalid_request_error",
				param: null,
				code: "invalid_api_key",
			},
		});
		expect(credentialRejectionVerdict(new ProviderHttpError(`401 ${body}`, 401))).toBe("structured");
	});

	it("calls a 401 with an unreadable body a refusal on the status alone", () => {
		const error = new ProviderHttpError("401 Unauthorized", 401);
		expect(credentialRejectionVerdict(error)).toBe("status");
		// Re-minting is still worth trying — HTTP's own meaning, and what omp
		// did before the structured signal existed …
		expect(isCredentialRejection(error)).toBe(true);
		// … but the provider did not say so, so no credential is resent.
		expect(statesCredentialRejection(error)).toBe(false);
	});

	it("does not call a 401 a credential refusal when its own class says otherwise", () => {
		const body = JSON.stringify({
			error: { message: "request blocked by policy", type: "invalid_request_error", code: "policy_blocked" },
		});
		const error = new ProviderHttpError(`401 ${body}`, 401);
		expect(credentialRejectionVerdict(error)).toBe("not-credential");
		expect(isCredentialRejection(error)).toBe(false);
	});

	it("says nothing about failures that are not 401s", () => {
		expect(credentialRejectionVerdict(new ProviderHttpError("403 forbidden", 403))).toBe("unclassified");
		expect(credentialRejectionVerdict(new ProviderHttpError("429 slow down", 429))).toBe("unclassified");
		expect(credentialRejectionVerdict(new ProviderHttpError("500 server error", 500))).toBe("unclassified");
		expect(credentialRejectionVerdict(new ProviderHttpError('404 {"detail":"Not Found"}', 404))).toBe("unclassified");
		expect(credentialRejectionVerdict(undefined)).toBe("unclassified");
		expect(isCredentialRejection(new ProviderHttpError("500 server error", 500))).toBe(false);
	});

	it("survives a body with text appended after it", () => {
		const refusal = GATEWAY_REFUSALS["an identity token past its exp"]!;
		const error = new ProviderHttpError(`${rawBodyMessage(refusal)}\nrequest-id: abc123`, 401);
		expect(credentialRejectionVerdict(error)).toBe("structured");
	});
});
