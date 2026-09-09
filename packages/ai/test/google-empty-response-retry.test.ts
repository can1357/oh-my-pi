import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// A Gemini turn that finishes with `finishReason: STOP` but carries only an empty text part —
// the well-known "empty response" failure. Delivered as-is, the agent receives a blank message
// and silently halts, so the provider must retry instead of surfacing it.

function sse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Top-level `candidates` shape (public Generative Language + Vertex). */
function genaiChunk(text: string): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: text ? 5 : 0, totalTokenCount: 15 },
	};
}

/** `{ response: { candidates } }` envelope (Cloud Code Assist: google-gemini-cli / antigravity). */
function ccaChunk(text: string): Record<string, unknown> {
	return { response: genaiChunk(text) };
}

/**
 * `{ response: { candidates } }` envelope carrying only a thinking part with `finishReason: STOP` —
 * the intentional-silence Advisor case (#8480): no visible text and no tool call.
 */
function ccaThinkingOnlyChunk(thinking: string): Record<string, unknown> {
	return {
		response: {
			candidates: [{ content: { parts: [{ text: thinking, thought: true }] }, finishReason: "STOP" }],
			usageMetadata: {
				promptTokenCount: 10,
				candidatesTokenCount: 0,
				thoughtsTokenCount: 5,
				totalTokenCount: 15,
			},
		},
	};
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, starts: events.filter(e => e.type === "start").length };
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter(b => b.type === "text")
		.map(b => b.text ?? "")
		.join("");
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const genaiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const vertexModel: Model<"google-vertex"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Vertex)",
	api: "google-vertex",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	...cliModel,
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
});

function withResponseUrl(response: Response, endpoint: string): Response {
	Object.defineProperty(response, "url", { value: `${endpoint}/v1internal:streamGenerateContent?alt=sse` });
	return response;
}

function endpointFromInput(input: Parameters<FetchImpl>[0]): string {
	const url = input instanceof Request ? input.url : input.toString();
	return url.startsWith(ANTIGRAVITY_SANDBOX_ENDPOINT) ? ANTIGRAVITY_SANDBOX_ENDPOINT : ANTIGRAVITY_DAILY_ENDPOINT;
}

describe("Google empty-response retry (public + Vertex path)", () => {
	it("retries a STOP-with-empty-text response and delivers the real follow-up content", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return calls === 1 ? sse(genaiChunk("")) : sse(genaiChunk("Hello!"));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2); // one empty attempt + one successful retry
		expect(starts).toBe(1); // exactly one start across the retry — no duplicate partials
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Hello!");
		void events;
	});

	it("surfaces an error after exhausting retries when every attempt is empty", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(genaiChunk(""));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const result = await stream.result();

		expect(calls).toBe(3); // MAX_EMPTY_STREAM_RETRIES (2) + 1 initial attempt
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("empty response");
	});

	it("accepts an empty STOP when silence is a valid caller result", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(genaiChunk(""));
		};

		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: fetchMock,
			acceptEmptyResponse: true,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("filters out empty text parts at stream end but preserves terminal thought signatures", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [
					{ content: { parts: [{ text: "", thoughtSignature: "terminal-sig" }] }, finishReason: "STOP" },
				],
			},
		];

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			return sse(...chunks);
		};

		const stream = streamGoogleVertex(vertexModel, context, {
			project: "project",
			location: "location",
			fetch: fetchMock,
		});
		const { events } = await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Hello",
			textSignature: "terminal-sig",
		});

		const textStartEvents = events.filter(e => e.type === "text_start");
		expect(textStartEvents).toHaveLength(1);
		expect(textStartEvents[0].contentIndex).toBe(0);

		const textDeltaEvents = events.filter(e => e.type === "text_delta");
		expect(textDeltaEvents).toHaveLength(1);
		expect(textDeltaEvents[0].delta).toBe("Hello");

		const textEndEvents = events.filter(e => e.type === "text_end");
		expect(textEndEvents).toHaveLength(1);
		expect(textEndEvents[0].content).toBe("Hello");
	});

	it("does not coalesce function-call thought signatures into the preceding Vertex text block", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" },
									thoughtSignature: "function-call-sig",
								},
							],
						},
						finishReason: "STOP",
					},
				],
			},
		];

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			return sse(...chunks);
		};

		const stream = streamGoogleVertex(vertexModel, context, {
			project: "project",
			location: "location",
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "Hello" });
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
			thoughtSignature: "function-call-sig",
		});
	});
});

describe("Google empty-response retry (Cloud Code Assist path)", () => {
	it("retries a STOP-with-empty-text response (the reported gemini-3-flash hang)", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			// Cloud Code Assist re-fetches `response.url` on retry; synthetic Responses default it to "".
			const response = calls === 1 ? sse(ccaChunk("")) : sse(ccaChunk("Done."));
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(starts).toBe(1); // the empty attempt must not leave a dangling duplicate start
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Done.");
		void events;
	});

	it("surfaces thought-only STOP immediately for session-level final-output recovery", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			const response = sse(ccaThinkingOnlyChunk("The task is complete, but I omitted the final answer."));
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("thought-only response without final output");
		expect(AIError.is(result.errorId, AIError.Flag.EmptyResponse)).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "thinking",
				thinking: "The task is complete, but I omitted the final answer.",
			}),
		]);
	});

	it("accepts an empty STOP when silence is a valid caller result", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(ccaChunk(""));
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
			acceptEmptyResponse: true,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("retries a stripped planning leak when empty STOPs are accepted", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			const response =
				calls === 1
					? sse(ccaChunk('{\n  "thought": "inspect the project",\n  "call": "lookup"\n}'))
					: sse({
							response: {
								candidates: [
									{
										content: {
											parts: [{ functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" } }],
										},
										finishReason: "STOP",
									},
								],
							},
						});
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
			acceptEmptyResponse: true,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(starts).toBe(1);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
		});
		expect(events.filter(e => e.type === "toolcall_start")).toHaveLength(1);
	});

	it("fails over to the sandbox endpoint after daily returns only empty successful streams", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			const response = endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT ? sse(ccaChunk("Recovered.")) : sse(ccaChunk(""));
			return withResponseUrl(response, endpoint);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		});
		const { starts } = await drain(stream);
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_SANDBOX_ENDPOINT,
		]);
		expect(starts).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Recovered.");
	});

	it("exhausts Antigravity auto failover before accepting silence", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			return withResponseUrl(sse(ccaChunk("")), endpoint);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			acceptEmptyResponse: true,
			fetch: fetchMock,
		});
		const result = await stream.result();

		// Daily still burns its empty-response budget and fails over; only the
		// last (sandbox) endpoint records the empty STOP as valid silence.
		expect(requestedEndpoints).toEqual([
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_SANDBOX_ENDPOINT,
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("accepts Advisor silence without failover after thought events start", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			const response =
				endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT
					? sse(ccaChunk("Recovered."))
					: sse(ccaThinkingOnlyChunk("No concrete risk. I will stay silent."));
			return withResponseUrl(response, endpoint);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			acceptEmptyResponse: true,
			fetch: fetchMock,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
		expect(starts).toBe(1);
		expect(events.filter(event => event.type === "thinking_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_end")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(textOf(result)).toBe("");
	});

	it("does not fail over a thought-only error after stream events start", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			const response =
				endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT
					? sse(ccaChunk("Recovered."))
					: sse(ccaThinkingOnlyChunk("I reasoned but omitted the final answer."));
			return withResponseUrl(response, endpoint);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
		expect(starts).toBe(1);
		expect(events.filter(event => event.type === "thinking_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_end")).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("thought-only response without final output");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "thinking",
				thinking: "I reasoned but omitted the final answer.",
			}),
		]);
	});

	for (const { mode, endpoint } of [
		{ mode: "production", endpoint: ANTIGRAVITY_DAILY_ENDPOINT },
		{ mode: "sandbox", endpoint: ANTIGRAVITY_SANDBOX_ENDPOINT },
	] as const) {
		it(`keeps empty-response retries on the selected ${mode} endpoint`, async () => {
			const requestedEndpoints: string[] = [];
			const fetchMock: FetchImpl = async input => {
				const requestedEndpoint = endpointFromInput(input);
				requestedEndpoints.push(requestedEndpoint);
				return withResponseUrl(sse(ccaChunk("")), requestedEndpoint);
			};

			const stream = streamGoogleGeminiCli(antigravityModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				antigravityEndpointMode: mode,
				fetch: fetchMock,
			});
			const result = await stream.result();

			expect(requestedEndpoints).toEqual([endpoint, endpoint, endpoint]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("empty response");
		});
	}

	for (const { name, chunk, errorText } of [
		{
			name: "SAFETY finish",
			chunk: { response: { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] } },
			errorText: "SAFETY",
		},
		{
			name: "MALFORMED_FUNCTION_CALL finish",
			chunk: {
				response: { candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] },
			},
			errorText: "MALFORMED_FUNCTION_CALL",
		},
		{
			name: "PROHIBITED_CONTENT block",
			chunk: {
				response: {
					candidates: [],
					promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "policy blocked" },
				},
			},
			errorText: "PROHIBITED_CONTENT",
		},
	] as const) {
		it(`does not fail over after a terminal ${name}`, async () => {
			const requestedEndpoints: string[] = [];
			const fetchMock: FetchImpl = async input => {
				const endpoint = endpointFromInput(input);
				requestedEndpoints.push(endpoint);
				return withResponseUrl(sse(chunk), endpoint);
			};

			const stream = streamGoogleGeminiCli(antigravityModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				antigravityEndpointMode: "auto",
				fetch: fetchMock,
			});
			const result = await stream.result();

			expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(errorText);
		});
	}

	it("does not fail over after an account-verification HTTP 403", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			return new Response(
				JSON.stringify({
					error: {
						code: 403,
						status: "PERMISSION_DENIED",
						details: [
							{
								"@type": "type.googleapis.com/google.rpc.ErrorInfo",
								reason: "VALIDATION_REQUIRED",
								metadata: { validation_url: "https://accounts.google.com/verify" },
							},
						],
					},
				}),
				{ status: 403 },
			);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Account verification required");
	});

	it("does not fail over after partial output has started", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			return withResponseUrl(
				sse({ response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] } }),
				endpoint,
			);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		});
		const { starts } = await drain(stream);
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
		expect(starts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(textOf(result)).toBe("partial");
	});

	it("does not coalesce function-call thought signatures into the preceding text block", async () => {
		const chunks = [
			{ response: { candidates: [{ content: { parts: [{ text: "Done" }] } }] } },
			{
				response: {
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" },
										thoughtSignature: "function-call-sig",
									},
								],
							},
							finishReason: "STOP",
						},
					],
				},
			},
		];

		const fetchMock: FetchImpl = async () => {
			const response = sse(...chunks);
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "Done" });
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
			thoughtSignature: "function-call-sig",
		});
	});

	it("does not retry if finishReason is SAFETY and bubbles up the error", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			const response = sse({
				response: {
					candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
				},
			});
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});

		await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Generation failed with finish reason: SAFETY");
		expect(calls).toBe(1);
	});
});
