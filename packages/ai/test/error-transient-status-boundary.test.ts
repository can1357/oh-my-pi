import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";

/**
 * The transient classifier matches bare HTTP status codes in error text. Those
 * digits must be a token of their own: omp appends its own
 * `raw-http-request=<...>/<random-id>.json` pointer to provider errors, and a
 * random id containing `503` used to make a hard 400 look retryable — which
 * turned a deterministic oversized-prompt rejection into ten identical retries.
 */
describe("transient status classification", () => {
	const overflowWithArtifactPointer =
		'Summarization failed: 400 {"type":"error","error":{"type":"invalid_request_error",' +
		'"message":"prompt is too long: 3030000 tokens > 1000000 maximum"}}\n' +
		"raw-http-request=/home/u/.omp/logs/http-400-requests/1787022540720-3o503gxo48bvb.json";

	it("does not call a 400 transient because an artifact id embeds a status code", () => {
		const id = AIError.classify(new Error(overflowWithArtifactPointer), "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.ContextOverflow)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
	});

	it("still classifies a real gateway status as transient", () => {
		for (const text of ["503 Service Unavailable", "upstream returned 502", "HTTP 429 from provider"]) {
			const id = AIError.classify(new Error(text), "anthropic-messages");
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		}
	});

	it("does not treat status digits inside an identifier as transient", () => {
		for (const text of ["model gpt-500x rejected the request", "request req500502 failed validation"]) {
			const id = AIError.classify(new Error(text), "anthropic-messages");
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		}
	});
});
