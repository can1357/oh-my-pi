import { describe, expect, it } from "bun:test";
import {
	credentialRejectionVerdict,
	isCredentialRejection,
	ProviderHttpError,
	statesCredentialRejection,
} from "@oh-my-pi/pi-ai/error";
import { finalizeErrorMessage } from "@oh-my-pi/pi-ai/utils/http-inspector";

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

	it("reads an OpenAI rejected key through the real response formatter", async () => {
		// The path that produces the message, not a hand-written copy of it:
		// `finalizeErrorMessage` renders the captured body, and its output is
		// what the retry driver classifies. The renderer used to label fields by
		// position after dropping the absent ones, so this body — type present,
		// `param` null, code present — arrived as `param=invalid_api_key` and
		// the reader called it "not a credential failure".
		const payload = {
			error: {
				message: "Incorrect API key provided: sk-***.",
				type: "invalid_request_error",
				param: null,
				code: "invalid_api_key",
			},
		};
		const message = await finalizeErrorMessage(new Error("401 Incorrect API key provided: sk-***."), undefined, {
			status: 401,
			bodyText: JSON.stringify(payload),
			bodyJson: payload,
		});
		expect(message).toContain("code=invalid_api_key");
		expect(credentialRejectionVerdict(new ProviderHttpError(message, 401))).toBe("structured");
	});

	it("still reads a rejected key a build before the renderer fix mislabelled", () => {
		const message = "401 Incorrect API key provided: sk-***. (type=invalid_request_error param=invalid_api_key)";
		expect(credentialRejectionVerdict(new ProviderHttpError(message, 401))).toBe("structured");
	});

	it("prefers the transport's error class over JSON inside the provider's prose", () => {
		const message =
			'401 Credential validation failed for claims {"type":"id_token"} (type=auth_error param=Authorization code=401)';
		expect(credentialRejectionVerdict(new ProviderHttpError(message, 401))).toBe("structured");
	});

	it("finds the envelope behind prose that is not JSON", () => {
		const refusal = GATEWAY_REFUSALS["an identity token past its exp"]!;
		const message = `401 upstream {request} rejected: ${JSON.stringify({ error: refusal })}`;
		expect(credentialRejectionVerdict(new ProviderHttpError(message, 401))).toBe("structured");
	});

	it("reads a machine code the decoder kept on the error object", () => {
		// Codex reduces the message to prose but keeps the code on the error.
		const error = new ProviderHttpError("401 Unauthorized", 401, { code: "invalid_api_key" });
		expect(credentialRejectionVerdict(error)).toBe("structured");
	});

	it("survives a body with text appended after it", () => {
		const refusal = GATEWAY_REFUSALS["an identity token past its exp"]!;
		const error = new ProviderHttpError(`${rawBodyMessage(refusal)}\nrequest-id: abc123`, 401);
		expect(credentialRejectionVerdict(error)).toBe("structured");
	});

	it("does not let a code that restates the status override a differing type", () => {
		// Measured 2026-11-08 against Theorem's model gateway: an unknown
		// virtual key. LiteLLM restates the status as the code, so reading the
		// code as a class made the body's own `type` irrelevant and every 401
		// the gateway renders qualified.
		const body = JSON.stringify({
			error: {
				message: "Authentication Error, Invalid proxy server token passed.",
				type: "token_not_found_in_db",
				code: "401",
			},
		});
		const error = new ProviderHttpError(`401 ${body}`, 401);
		expect(credentialRejectionVerdict(error)).toBe("not-credential");
		expect(isCredentialRejection(error)).toBe(false);
	});

	it("does not read a request-shape 401 as a credential refusal on its status code", () => {
		const body = JSON.stringify({
			error: { message: "request blocked", type: "invalid_request_error", code: "401" },
		});
		expect(credentialRejectionVerdict(new ProviderHttpError(`401 ${body}`, 401))).toBe("not-credential");
	});

	it("still reads the status restated as a code when the body names no type", () => {
		const body = JSON.stringify({ error: { message: "Authentication Error.", code: "401" } });
		expect(credentialRejectionVerdict(new ProviderHttpError(`401 ${body}`, 401))).toBe("structured");
	});

	it("qualifies a signature failure whose token is nowhere near its exp", () => {
		// A locally signed junk JWT with `exp` an hour out, replayed from the
		// gateway's own answer to it. The signal is that a refreshable
		// credential was refused, not that one expired — nothing here reads a
		// token's `exp`, and nothing withholds a request on one.
		const body = JSON.stringify({
			error: {
				message: "This identity token is signed by no key Google publishes.",
				type: "auth_error",
				param: "Authorization",
				code: "401",
			},
		});
		expect(credentialRejectionVerdict(new ProviderHttpError(`401 ${body}`, 401))).toBe("structured");
	});

	it("prefers the transport's class over an error envelope inside the prose", () => {
		// The prose object carries an `error` member, so it reads as an
		// envelope. The transport's suffix is still the body's real class.
		const message =
			'401 Credential validation failed for claims {"error":{"type":"id_token"}} (type=auth_error param=Authorization code=401)';
		expect(credentialRejectionVerdict(new ProviderHttpError(message, 401))).toBe("structured");
	});

	it("does not let an auth envelope in the prose qualify a refusal that is not one", () => {
		const message =
			'401 Request denied; prior check {"error":{"type":"auth_error"}} (type=invalid_request_error param=Authorization code=policy_blocked)';
		expect(credentialRejectionVerdict(new ProviderHttpError(message, 401))).toBe("not-credential");
	});

	it("does not mistake prose that merely contains type= for the transport's class", () => {
		const refusal = GATEWAY_REFUSALS["an identity token past its exp"]!;
		const message = `401 upstream said type=id_token for ${JSON.stringify({ error: refusal })}`;
		expect(credentialRejectionVerdict(new ProviderHttpError(message, 401))).toBe("structured");
	});
});
