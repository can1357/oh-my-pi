import { afterEach, expect, test, vi } from "bun:test";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const FLASH_FIRST_EVENT_TIMEOUT_MS = 60_000;
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

afterEach(() => {
	vi.useRealTimers();
});

function endpointFromInput(input: Parameters<FetchImpl>[0]): string {
	const url = input instanceof Request ? input.url : input.toString();
	return url.startsWith(ANTIGRAVITY_SANDBOX_ENDPOINT) ? ANTIGRAVITY_SANDBOX_ENDPOINT : ANTIGRAVITY_DAILY_ENDPOINT;
}

function responseWithUrl(response: Response, endpoint: string): Response {
	Object.defineProperty(response, "url", { value: `${endpoint}/v1internal:streamGenerateContent?alt=sse` });
	return response;
}

test("Antigravity Flash fails over when headers arrive without a first SSE event", async () => {
	const requestedEndpoints: string[] = [];
	let dailyBodyCancelled = false;
	const dailyBodyReadStarted = Promise.withResolvers<void>();
	const dailyBodyStall = Promise.withResolvers<void>();
	vi.useFakeTimers();

	const fetchMock: FetchImpl = async input => {
		const endpoint = endpointFromInput(input);
		requestedEndpoints.push(endpoint);
		if (endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT) {
			const body = `data: ${JSON.stringify({
				response: {
					candidates: [{ content: { parts: [{ text: "Recovered after stall." }] }, finishReason: "STOP" }],
				},
			})}\n\n`;
			return responseWithUrl(
				new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
				endpoint,
			);
		}

		return responseWithUrl(
			new Response(
				new ReadableStream({
					pull() {
						dailyBodyReadStarted.resolve();
						return dailyBodyStall.promise;
					},
					cancel() {
						dailyBodyStall.resolve();
						dailyBodyCancelled = true;
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
			endpoint,
		);
	};

	const stream = streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto",
		fetch: fetchMock,
	});
	const resultPromise = stream.result();
	await dailyBodyReadStarted.promise;
	expect(vi.getTimerCount()).toBeGreaterThan(0);
	vi.advanceTimersByTime(FLASH_FIRST_EVENT_TIMEOUT_MS * 2);
	const result = await resultPromise;

	expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT]);
	expect(dailyBodyCancelled).toBe(true);
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([{ type: "text", text: "Recovered after stall." }]);
});
