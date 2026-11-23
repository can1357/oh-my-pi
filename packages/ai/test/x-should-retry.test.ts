import { describe, expect, test } from "bun:test";
import * as AIError from "../src/error";
import { OpenAIHttpError, postOpenAIStream } from "../src/utils/openai-http";
import { mockFetch } from "./helpers/fetch-mock";

// A retrying gateway that already exhausted its own attempts answers with a
// terminal 5xx plus `x-should-retry: false`. The removed `openai` SDK obeyed
// that verdict; the wire transport and the provider retry loops must too, or
// every layer replays a request the gateway already gave up on (#17920).
function terminal503(): Response {
	return new Response(JSON.stringify({ error: { message: "upstream unavailable", type: "server_error" } }), {
		status: 503,
		headers: { "content-type": "application/json", "x-should-retry": "false", "retry-after-ms": "1" },
	});
}

async function captureStreamError(response: () => Response): Promise<{ attempts: number; error: unknown }> {
	let attempts = 0;
	const fetch = mockFetch(() => {
		attempts++;
		return response();
	});
	const error = await postOpenAIStream({
		url: "http://gateway.local/v1/chat/completions",
		headers: {},
		body: {},
		signal: new AbortController().signal,
		fetch,
	}).then(
		() => undefined,
		(err: unknown) => err,
	);
	return { attempts, error };
}

describe("x-should-retry on the OpenAI wire (#17920)", () => {
	test("transport surfaces a terminal 503 on the first attempt", async () => {
		const { attempts, error } = await captureStreamError(terminal503);

		expect(attempts).toBe(1);
		expect(error).toBeInstanceOf(OpenAIHttpError);
		expect((error as OpenAIHttpError).status).toBe(503);
	});

	test("provider retry classification obeys the captured verdict over status", async () => {
		const { error } = await captureStreamError(terminal503);
		expect(AIError.isProviderRetryableError(error)).toBe(false);

		const forcedRetry = new OpenAIHttpError("400 try again", {
			status: 400,
			headers: new Headers({ "x-should-retry": "true" }),
		});
		expect(AIError.isProviderRetryableError(forcedRetry)).toBe(true);
	});
});
