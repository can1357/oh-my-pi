/**
 * Server side of TypeSafe's System One wire format (`POST /v1/systemone`),
 * served by the auth-gateway so TypeSafe SDKs and omp's own `TypeSafeJudge`
 * can point `TYPESAFE_BASE_URL` at the gateway and never hold the real key.
 *
 * Requests are validated only as far as routing needs — the `model` id and
 * the shape of the `questions` map — and otherwise forwarded verbatim, so
 * structured `instructions`/`criteria` and forward-compatible fields reach
 * the upstream untouched. Validation failures answer `422` like TypeSafe.
 */
import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import type { JudgmentRequest, JudgmentResult } from "../judgment/types";

/**
 * TypeSafe accepts `instructions` and `criteria` as strings or structured
 * JSON (https://docs.typesafe.ai/api); only `type` decides how an answer is
 * read back, so that is all the gateway pins down.
 */
const systemOneRequestSchema = type({
	model: "string > 0",
	state: "string | object",
	questions: type({ "[string]": { type: "'noul' | 'choice' | 'score'", instructions: "string | object" } }),
});

export interface SystemOneParsedRequest {
	modelId: string;
	request: JudgmentRequest;
}

/** `POST /v1/systemone` response body; `cost` (USD) appears only when the route billed one. */
export interface SystemOneResponseBody {
	model: string;
	answers: JudgmentResult["answers"];
	usage: { input_tokens: number; output_tokens: number; cost?: number };
}

/**
 * Validate the routing-relevant parts of a System One request body.
 *
 * @throws {AIError.ValidationError} naming the offending field when `model`,
 * `state`, or `questions` is missing or malformed.
 */
export function parseRequest(body: unknown): SystemOneParsedRequest {
	const parsed = systemOneRequestSchema(body);
	if (parsed instanceof type.errors) throw new AIError.ValidationError(`systemone: ${parsed.summary}`);
	// `req.json()` output is JSON by construction, and the typed `Questions`
	// contract models string instructions only; the judge forwards the request
	// verbatim and reads back nothing but each question's `type`.
	const request = { state: parsed.state, questions: parsed.questions } as JudgmentRequest;
	return { modelId: parsed.model, request };
}

/** Re-encode a judgment result in TypeSafe's response shape. */
export function encodeResponse(result: JudgmentResult): SystemOneResponseBody {
	const usage: SystemOneResponseBody["usage"] = {
		input_tokens: result.usage.input,
		output_tokens: result.usage.output,
	};
	if (result.usage.cost.total > 0) usage.cost = result.usage.cost.total;
	return { model: result.model, answers: result.answers, usage };
}

/** TypeSafe answers errors with a status code and a JSON body; the envelope mirrors the other gateway routes. */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { type, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
