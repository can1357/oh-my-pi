// Regression coverage for gateways (OpenRouter, Vercel AI Gateway, …) that
// report upstream model failures as a bare `finish_reason: "error"` — e.g.
// Gemini MALFORMED_FUNCTION_CALL behind an OpenAI-compat endpoint. The mapped
// error message must match the session retry classifier's transient-transport
// pattern (`provider.?returned.?error` in agent-session's
// #isTransientTransportErrorMessage) so the turn is auto-retried instead of
// stopping with a pinned error banner.
import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getNativeFinishReasonError } from "@oh-my-pi/pi-ai/providers/native-finish-reason";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Mirrors the transient-transport alternative the session retry gate matches on.
const RETRYABLE_PATTERN = /provider.?returned.?error/i;

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					const data = typeof event === "string" ? event : JSON.stringify(event);
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
				}
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

function completionChunk(extra: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-error-finish",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	};
}

describe("final tool-call arguments", () => {
	const tool = {
		name: "write",
		description: "Write a file",
		parameters: {
			type: "object",
			properties: { i: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
		},
	};
	const args = { i: "Writing file", path: "repaired.txt", content: "hello" };
	async function streamCall(raw: string | Record<string, unknown>, finishReason: string) {
		return streamOpenAICompletions(
			completionsModel,
			{ ...baseContext(), tools: [tool] },
			{
				apiKey: "test-key",
				fetch: createSseFetch([
					completionChunk({
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_write",
											type: "function",
											function: { name: "write", arguments: raw },
										},
									],
								},
							},
						],
					}),
					completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
					"[DONE]",
				]),
			},
		).result();
	}

	for (const finishReason of ["tool_calls", "stop"]) {
		it.each([
			JSON.stringify(args).slice(0, -2),
			JSON.stringify(args).slice(0, -1),
			JSON.stringify(args) + " garbage",
		])("refuses incomplete or trailing-garbage arguments under " + finishReason + ": %s", async raw => {
			const result = await streamCall(raw, finishReason);
			expect(result.stopReason).toBe("toolUse");
			const call = result.content.find(block => block.type === "toolCall");
			if (!call) throw new Error("Expected tool call");
			expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: raw });
			expect(() => validateToolArguments(tool, call)).toThrow("Tool call arguments are not valid JSON");
		});

		it.each([
			[JSON.stringify(args), args],
			["{i:'Writing file',path:'repaired.txt',content:'hello',}", args],
			["{i:'Writing file',path:'repaired.txt',content:hello,}", args],
			["", {}],
			[" \n\t", {}],
			[args, args],
		] as const)(
			"preserves complete, repairable and empty arguments under " + finishReason + ": %j",
			async (raw, expected) => {
				const result = await streamCall(raw, finishReason);
				expect(result.stopReason).toBe("toolUse");
				const call = result.content.find(block => block.type === "toolCall");
				if (!call) throw new Error("Expected tool call");
				expect(call.arguments).toEqual(expected);
				expect(validateToolArguments(tool, call)).toEqual(expected);
			},
		);
	}

	it("caps raw invalid argument diagnostics without retaining executable preview keys", async () => {
		const raw = JSON.stringify({ ...args, content: "x".repeat(600) }).slice(0, -2);
		const result = await streamCall(raw, "tool_calls");
		const call = result.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("Expected tool call");
		const bounded = raw.slice(0, 512) + "… [truncated " + (raw.length - 512) + " chars]";
		expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: bounded });
		// The validation error shows the same bound, not a second truncation of it.
		expect(() => validateToolArguments(tool, call)).toThrow(`Raw JSON:\n${bounded}`);
	});
});

describe("finish_reason: error", () => {
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);

	it("stays an error even when the stream carried tool calls", async () => {
		// The user-visible failure mode: the model garbles a tool call, the
		// gateway ends the stream with `finish_reason: "error"`. Tool-call
		// promotion (stop → toolUse) must not paper over the error finish.
		const fetchMock = createSseFetch([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"pattern":"x"}' },
								},
							],
						},
					},
				],
			}),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);
});

describe("native_finish_reason", () => {
	const toolDelta = {
		role: "assistant",
		tool_calls: [
			{
				index: 0,
				id: "call_read",
				type: "function",
				function: { name: "read", arguments: '{"path":"hello.txt"}' },
			},
		],
	};

	it("rejects a billed malformed response normalized to stop, retaining trailing usage and response ID", async () => {
		const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 };
		const stream = streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			maxHttpAttempts: 1,
			fetch: createSseFetch([
				completionChunk({
					choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "MALFORMED_RESPONSE" }],
					usage,
				}),
				// A later clean finish must not revive the failed generation.
				completionChunk({
					choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "STOP" }],
				}),
				completionChunk({
					choices: [],
					usage: { ...usage, prompt_tokens_details: { cached_tokens: 20 } },
				}),
				"[DONE]",
			]),
		});
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();

		expect(eventTypes).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider returned error (native_finish_reason: MALFORMED_RESPONSE)");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
		expect(AIError.retriable(AIError.classifyMessage(result))).toBe(true);
		expect(result.responseId).toBe("chatcmpl-error-finish");
		expect(result.usage).toMatchObject({ input: 80, output: 40, cacheRead: 20, totalTokens: 140 });
		expect(result.usage.cost.total).toBeGreaterThan(0);
	});

	it.each(["malformed_function_call", "Unexpected_Tool_Call", "NETWORK_ERROR"])(
		"rejects %s despite an earlier valid tool call and a normalized tool_calls finish",
		async nativeFinishReason => {
			const stream = streamOpenAICompletions(completionsModel, baseContext(), {
				apiKey: "test-key",
				fetch: createSseFetch([
					completionChunk({ choices: [{ index: 0, delta: toolDelta }] }),
					completionChunk({
						choices: [
							{
								index: 0,
								delta: {},
								finish_reason: "tool_calls",
								native_finish_reason: nativeFinishReason,
							},
						],
					}),
					completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
					completionChunk({
						choices: [],
						usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
					}),
					"[DONE]",
				]),
			});
			const eventTypes: string[] = [];
			for await (const event of stream) eventTypes.push(event.type);
			const result = await stream.result();

			expect(eventTypes.at(-1)).toBe("error");
			expect(eventTypes).not.toContain("done");
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe(`Provider returned error (native_finish_reason: ${nativeFinishReason})`);
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(true);
			expect(result.content.find(block => block.type === "toolCall")).toMatchObject({
				type: "toolCall",
				id: "call_read",
				name: "read",
				arguments: { path: "hello.txt" },
			});
			expect(result.responseId).toBe("chatcmpl-error-finish");
			expect(result.usage).toMatchObject({ input: 100, output: 40, totalTokens: 140 });
		},
	);

	it.each([
		{ branch: "success", native: "STOP", normalized: "stop", expected: "stop", tools: false },
		{ branch: "length", native: "MAX_TOKENS", normalized: "length", expected: "length", tools: false },
		{ branch: "continuation", native: "TOOL_CALLS", normalized: "tool_calls", expected: "toolUse", tools: true },
		{ branch: "unknown", native: "FUTURE_VENDOR_REASON", normalized: "stop", expected: "stop", tools: false },
	])("preserves normalized $branch behavior for native $native", async ({ native, normalized, expected, tools }) => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch([
				completionChunk({
					choices: [{ index: 0, delta: tools ? toolDelta : { role: "assistant", content: "Hello" } }],
				}),
				completionChunk({
					choices: [{ index: 0, delta: {}, finish_reason: normalized, native_finish_reason: native }],
				}),
				"[DONE]",
			]),
		}).result();

		expect(result.stopReason).toBe(expected);
		expect(result.errorMessage).toBeUndefined();
		if (tools) expect(result.content.some(block => block.type === "toolCall")).toBe(true);
		else expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("ignores absent and non-string native reasons without coercion", () => {
		for (const reason of [undefined, null, 42, {}, ["MALFORMED_RESPONSE"]]) {
			expect(getNativeFinishReasonError(reason)).toBeUndefined();
		}
	});
});

describe("in-band SSE error envelope", () => {
	it("surfaces a queue-full error carried inside a successful HTTP stream", async () => {
		const fetchMock = createSseFetch([
			{
				error: {
					object: "error",
					message: "The request queue is full.",
					type: "SERVICE_UNAVAILABLE",
					param: null,
					code: 503,
				},
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(503);
		expect(result.errorMessage).toContain("The request queue is full.");
	}, 10_000);

	it("surfaces a flat error string carried inside a successful HTTP stream", async () => {
		const fetchMock = createSseFetch([{ error: "rate limit exceeded" }, "[DONE]"]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("rate limit exceeded");
	}, 10_000);

	it("surfaces a flat message-only error carried inside a successful HTTP stream", async () => {
		const fetchMock = createSseFetch([{ message: "provider temporarily unavailable" }, "[DONE]"]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider temporarily unavailable");
	}, 10_000);

	it("does not replay after content precedes an in-band error", async () => {
		let attempts = 0;
		const baseFetch = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Partial" } }] }),
			{
				error: {
					message: "Request timed out in the queue.",
					type: "REQUEST_TIMEOUT",
				},
			},
			"[DONE]",
		]);
		const fetchMock: FetchImpl = async (input, init) => {
			attempts++;
			return baseFetch(input, init);
		};

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(408);
		expect(result.content).toEqual([{ type: "text", text: "Partial" }]);
	}, 10_000);
});

describe("finish_reason: insufficient_system_resource", () => {
	// DeepSeek interrupts the generation mid-stream when its inference system
	// runs out of resources; the terminal chunk carries
	// `finish_reason: "insufficient_system_resource"`. It must surface as a
	// retryable provider error — never as a clean `stop`.
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "insufficient_system_resource" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);
});

describe("finish_reason: network_error and unknown", () => {
	// OpenCode retries `network_error`/`network-error` finishes and continues past
	// an unknown finish reason. Both must surface as retryable errors, but a
	// recognised terminal reason with the same shape must not.
	async function finishWith(finishReason: string) {
		return streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch([
				completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
				"[DONE]",
			]),
		}).result();
	}

	it.each(["network_error", "network-error", "NETWORK_ERROR"])(
		"retries finish_reason %s",
		async reason => {
			const result = await finishWith(reason);
			expect(result.stopReason).toBe("error");
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(true);
		},
		10_000,
	);

	it.each(["unknown", "other", "unspecified", "FINISH_REASON_UNSPECIFIED"])(
		"retries unknown finish_reason %s instead of pinning it",
		async reason => {
			const result = await finishWith(reason);
			expect(result.stopReason).toBe("error");
			expect(AIError.retriable(AIError.classifyMessage(result))).toBe(true);
		},
		10_000,
	);

	it("keeps an unrecognised vendor finish_reason terminal", async () => {
		const result = await finishWith("recitation");
		expect(result.stopReason).toBe("error");
		expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
	}, 10_000);
});

describe("premature stream closure", () => {
	// The connection dies mid-generation without any `finish_reason` chunk
	// (DeepSeek insufficient-system-resource interruption, flaky gateway).
	// Before the guard, the partial message finalized as a clean `stop` and
	// the agent loop treated the truncated turn as complete — the silent
	// mid-sentence halt. Now it must surface as an error turn.
	it("fails the turn instead of silently stopping", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: { content: "lo" } }] }),
		]);

		const eventTypes: string[] = [];
		let errorMessage: string | undefined;
		for await (const event of streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		})) {
			eventTypes.push(event.type);
			if (event.type === "error") errorMessage = event.error.errorMessage;
		}

		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "error"]);
		expect(errorMessage).toContain("finish_reason");
	}, 10_000);

	it("still retries a genuinely empty close via the empty-completion path", async () => {
		// Zero content + no finish_reason is the flaky-gateway empty completion:
		// it stays a clean `stop` so withEmptyCompletionRetry can re-sample
		// instead of failing outright.
		let attempts = 0;
		async function fetchMock(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
			attempts++;
			const events =
				attempts === 1
					? []
					: [
							completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] }),
							completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
							"[DONE]",
						];
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const event of events) {
						const data = typeof event === "string" ? event : JSON.stringify(event);
						controller.enqueue(encoder.encode(`data: ${data}\n\n`));
					}
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock as typeof fetch,
		}).result();

		expect(attempts).toBeGreaterThan(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
	}, 10_000);
});

describe("[DONE]-terminated stream without finish_reason", () => {
	// Many OpenAI-compatible hosts stream content, then terminate with the `[DONE]`
	// sentinel while omitting (or `null`ing) `finish_reason`. `[DONE]` is the
	// streaming protocol's terminal signal, so those turns completed by server
	// agreement and must finalize cleanly; only a genuine transport EOF (no
	// `[DONE]`) is a truncated stream.
	const litellmModel = buildModel({
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "litellm",
		baseUrl: "http://127.0.0.1:4000/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
	});

	const doneTerminated: readonly (readonly [string, unknown[], string])[] = [
		[
			"no terminal finish chunk, just [DONE]",
			[{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] }, "[DONE]"],
			"Hello",
		],
		[
			"trailing finish_reason:null then [DONE]",
			[{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: {}, finish_reason: null }] }, "[DONE]"],
			"Hel",
		],
		[
			"trailing empty choices:[] then [DONE]",
			[{ choices: [{ delta: { content: "Hel" } }] }, { choices: [] }, "[DONE]"],
			"Hel",
		],
	];

	for (const [label, frames, expectedText] of doneTerminated) {
		it(`finalizes as a clean stop with content preserved (${label})`, async () => {
			const msg = await streamOpenAICompletions(litellmModel, baseContext(), {
				apiKey: "k",
				fetch: createSseFetch(frames),
			}).result();
			const text = msg.content.reduce((acc, block) => (block.type === "text" ? acc + block.text : acc), "");
			expect(msg.stopReason).toBe("stop");
			expect(msg.errorMessage).toBeUndefined();
			expect(text).toBe(expectedText);
		});
	}

	it("promotes a [DONE]-terminated tool-call turn without finish_reason to toolUse", async () => {
		const msg = await streamOpenAICompletions(litellmModel, baseContext(), {
			apiKey: "k",
			fetch: createSseFetch([
				{
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, id: "call_1", function: { name: "foo", arguments: '{"a":1}' } }],
							},
						},
					],
				},
				"[DONE]",
			]),
		}).result();
		expect(msg.stopReason).toBe("toolUse");
		expect(msg.errorMessage).toBeUndefined();
		expect(msg.content.some(block => block.type === "toolCall")).toBe(true);
	});
});

describe("finish_reason: repetition", () => {
	// OpenAI-compatible servers report a generation degenerating into repetition
	// as a terminal signal (`finish_reason: "repetition"` and/or
	// `stop_reason: "repetition_detected"`). It must classify as a thinking loop
	// and drop the degenerate partial reasoning instead of replaying it.
	const reasoningModel = buildModel({
		id: "repetition-model",
		name: "Repetition Model",
		api: "openai-completions",
		provider: "litellm",
		baseUrl: "http://127.0.0.1:4000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
	});

	/**
	 * Build a stream that thinks in `?!` and then reports a repetition stop.
	 *
	 * 64 characters of reasoning is below the detector's 180-character floor, so the
	 * server stop signal is the only thing that can classify this turn.
	 */
	function repetitionStream(choice: Record<string, unknown>): { fetchMock: FetchImpl; requests: () => number } {
		const chunk = (extra: Record<string, unknown>) => ({
			id: "chatcmpl-repetition",
			object: "chat.completion.chunk",
			created: 0,
			model: reasoningModel.id,
			choices: [{ index: 0, ...extra }],
		});
		const frames = [
			...Array.from({ length: 32 }, () => chunk({ delta: { reasoning_content: "?!" }, finish_reason: null })),
			chunk({ delta: {}, ...choice }),
		];
		const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
		let requests = 0;
		const fetchMock = Object.assign(
			async (): Promise<Response> => {
				requests += 1;
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			},
			{ preconnect: fetch.preconnect },
		);
		return { fetchMock, requests: () => requests };
	}

	// The `stop_reason` form is reported both alongside a clean `stop` and with no
	// `finish_reason` at all, so it cannot be read only from `finish_reason`.
	const REPETITION_CHOICES: ReadonlyArray<Record<string, unknown>> = [
		{ finish_reason: "repetition", stop_reason: "repetition_detected" },
		{ finish_reason: "repetition" },
		{ finish_reason: "stop", stop_reason: "repetition_detected" },
		{ stop_reason: "repetition_detected" },
	];

	for (const choice of REPETITION_CHOICES) {
		it(`classifies ${JSON.stringify(choice)} as a thinking loop and drops the partial`, async () => {
			const { fetchMock, requests } = repetitionStream(choice);
			const result = await streamOpenAICompletions(reasoningModel, baseContext(), {
				apiKey: "test-key",
				fetch: fetchMock,
			}).result();

			// One request: the provider stops at the terminal signal rather than
			// resampling on its own.
			expect(requests()).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
			// Degenerate reasoning is replay garbage; retaining it is what made the
			// loop survive across turns.
			expect(result.content).toEqual([]);
		}, 10_000);
	}

	it("keeps the raw stop reasons for diagnosis", async () => {
		const { fetchMock } = repetitionStream({ finish_reason: "repetition", stop_reason: "repetition_detected" });
		const result = await streamOpenAICompletions(reasoningModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.errorMessage).toContain("finish_reason=repetition");
		expect(result.errorMessage).toContain("stop_reason=repetition_detected");
	}, 10_000);

	it("leaves an ordinary stop finish untouched", async () => {
		const { fetchMock } = repetitionStream({ finish_reason: "stop" });
		const result = await streamOpenAICompletions(reasoningModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(false);
	}, 10_000);
});

describe("uppercase finish_reason", () => {
	// Some OpenAI-compatible gateways fronting Gemini backends emit the native
	// uppercase reasons (`STOP`, `MAX_TOKENS`) instead of the lowercase OpenAI
	// contract values. `mapStopReason` must fold case and map `MAX_TOKENS` to
	// `length`, not surface a clean completion as an error.
	it("maps STOP to a clean stop", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "STOP" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	}, 10_000);

	it("maps MAX_TOKENS to length", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "MAX_TOKENS" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBeUndefined();
	}, 10_000);
});

describe("non-string finish_reason", () => {
	// A malformed provider SSE can put a non-string `finish_reason` on the
	// chunk. Folding case must not throw on it — it falls through to the
	// unknown-reason error path with the original value surfaced.
	it("falls through to an error instead of throwing", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: 42 }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider finish_reason: 42");
	}, 10_000);
});
