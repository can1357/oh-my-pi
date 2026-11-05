import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const API_KEY = JSON.stringify({ token: "token", projectId: "proj-123" });
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-4-argon",
	name: "Gemini 4 Argon (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
});

// The manifest lookup would otherwise reach the injected fetch, which only
// models Cloud Code Assist endpoints.
const savedAntigravityVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
beforeEach(() => {
	process.env.PI_AI_ANTIGRAVITY_VERSION = "2.26.0";
});
afterEach(() => {
	if (savedAntigravityVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
	else process.env.PI_AI_ANTIGRAVITY_VERSION = savedAntigravityVersion;
});

function endpointFromInput(input: string | URL | Request): string {
	const url = input instanceof Request ? input.url : input.toString();
	return url.startsWith(ANTIGRAVITY_SANDBOX_ENDPOINT) ? ANTIGRAVITY_SANDBOX_ENDPOINT : ANTIGRAVITY_DAILY_ENDPOINT;
}

function responseWithUrl(response: Response, endpoint: string): Response {
	Object.defineProperty(response, "url", { value: `${endpoint}/v1internal:streamGenerateContent?alt=sse` });
	return response;
}

function thinkingChunk(text: string): string {
	return `data: ${JSON.stringify({
		response: { candidates: [{ content: { parts: [{ text, thought: true }] } }] },
	})}\n\n`;
}

/**
 * First pull delivers the thinking event; the next pull fails the body. The
 * default stream queue (one chunk) guarantees the reader consumes the thinking
 * event before the error surfaces — the mid-reply shape from the incident.
 */
function bodyThenError(firstEvent: string, error: unknown): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let pulls = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulls++ === 0) {
				controller.enqueue(encoder.encode(firstEvent));
				return;
			}
			controller.error(error);
		},
	});
}

function sse(response: Response, endpoint: string): Response {
	return responseWithUrl(response, endpoint);
}

function failingBodyFetch(error: unknown, requested: string[]): FetchImpl {
	return async input => {
		const endpoint = endpointFromInput(input);
		requested.push(endpoint);
		return sse(
			new Response(bodyThenError(thinkingChunk("reasoning before the drop"), error), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			endpoint,
		);
	};
}

describe("Antigravity mid-stream transport failures", () => {
	it("classifies a TLS handshake body failure with proxy guidance and no runtime wording", async () => {
		const requested: string[] = [];
		const handshake = Object.assign(
			new Error("EPROTO: The TLS handshake failed. Does the server speak TLS on this port?"),
			{ code: "EPROTO" },
		);

		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: API_KEY,
			antigravityEndpointMode: "auto",
			fetch: failingBodyFetch(handshake, requested),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(
			"TLS connection failed for daily-cloudcode-pa.googleapis.com during handshake",
		);
		expect(result.errorMessage).toContain("SOCKS");
		expect(result.errorMessage).not.toContain("certificate");
		expect(result.errorMessage).not.toContain("verbose");
		expect(AIError.is(result.errorId ?? 0, AIError.Flag.Transient)).toBe(true);
		// The reasoning that did arrive stays in the partial turn for recovery.
		expect(result.content.some(block => block.type === "thinking" && block.thinking.length > 0)).toBe(true);
		// `started` is set once an event streamed: no endpoint failover mid-reply.
		expect(requested).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
	});

	it("classifies a body ECONNRESET as a reset with the request host", async () => {
		const requested: string[] = [];
		const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: API_KEY,
			antigravityEndpointMode: "auto",
			fetch: failingBodyFetch(reset, requested),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			"Connection to daily-cloudcode-pa.googleapis.com was reset by the network or proxy. Check the proxy/VPN and retry.",
		);
		expect(AIError.is(result.errorId ?? 0, AIError.Flag.Transient)).toBe(true);
		expect(requested).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
	});

	it("bounds post-first-event silence with the idle watchdog and cancels the body", async () => {
		const encoder = new TextEncoder();
		let bodyCancelled = false;
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			return sse(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(thinkingChunk("reasoning then silence")));
						},
						pull() {
							// Never emit another event: the idle watchdog must end the turn.
							return new Promise<void>(() => {});
						},
						cancel() {
							bodyCancelled = true;
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
				endpoint,
			);
		};

		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: API_KEY,
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
			streamIdleTimeoutMs: 30,
			streamFirstEventTimeoutMs: 5_000,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stalled while waiting for the next event");
		expect(AIError.is(result.errorId ?? 0, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(result.errorId ?? 0, AIError.Flag.Transient)).toBe(true);
		// The watchdog must abort the response signal, not merely stop consuming:
		// a reader suspended in an in-flight read otherwise keeps the proxied
		// socket open.
		expect(bodyCancelled).toBe(true);
	});

	it("does not wrap a complete but malformed SSE frame as a transport drop", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async input => {
			calls += 1;
			const endpoint = endpointFromInput(input);
			return sse(
				new Response("data: definitely-not-json\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				endpoint,
			);
		};

		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: API_KEY,
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		}).result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		// The parser's SyntaxError keeps its own semantics instead of being
		// replayed as a transient incomplete stream.
		expect(result.errorMessage).not.toContain("closed before completion");
		expect(AIError.is(result.errorId ?? 0, AIError.Flag.Transient)).toBe(false);
	});

	it("does not diagnose a non-400 response as a region refusal", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response("User location is not supported for the API use.", {
				status: 403,
				headers: { "content-type": "text/plain" },
			});

		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: API_KEY,
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(403);
		expect(result.errorMessage).not.toContain("PI_PROXY_GOOGLE_ANTIGRAVITY");
		expect(result.errorMessage).not.toContain("egress region");
	});

	it("turns a region refusal into one actionable terminal error", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					error: {
						code: 400,
						message: "User location is not supported for the API use.",
						status: "FAILED_PRECONDITION",
					},
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		};

		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: API_KEY,
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		}).result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("User location is not supported for the API use");
		expect(result.errorMessage).toContain("PI_PROXY_GOOGLE_ANTIGRAVITY");
		expect(AIError.is(result.errorId ?? 0, AIError.Flag.Transient)).toBe(false);
	});

	it("accepts a plain-text region refusal through the phrase fallback", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response("400 FAILED_PRECONDITION: User location is not supported for the API use.", {
				status: 400,
				headers: { "content-type": "text/plain" },
			});
		};

		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: API_KEY,
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		}).result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("PI_PROXY_GOOGLE_ANTIGRAVITY");
		expect(AIError.is(result.errorId ?? 0, AIError.Flag.Transient)).toBe(false);
	});
});
