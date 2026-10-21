import { describe, expect, it, mock } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import { encodeFactoryDroidCompletionsToolName } from "../src/providers/factory-droid/tool-names";
import type { Message, Model } from "../src/types";
import {
	assistantTurn,
	type CapturedRequest,
	captureFetch,
	completionsChunks,
	factoryModel,
	kimiK3,
} from "./helpers/factory-droid";

const deepseekFlash = (): Model<"factory-droid-agent"> => factoryModel("deepseek-v4.1-flash", ["fireworks"]);
const glm53 = (upstream = "baseten"): Model<"factory-droid-agent"> => factoryModel("glm-5.3", [upstream]);
const mistralMedium35 = (): Model<"factory-droid-agent"> => factoryModel("mistral-medium-3.5");

/** Assistant tool-call turn plus its tool result, as stored by a prior turn. */
function toolTurn(key: string, model: string): Message[] {
	return [
		assistantTurn([{ type: "toolCall", id: `call_${key}`, name: "Read", arguments: { path: "/tmp/x" } }], model),
		{
			role: "toolResult",
			toolCallId: `call_${key}`,
			toolName: "Read",
			content: [{ type: "text", text: "body" }],
			isError: false,
			timestamp: 3,
		},
	];
}

describe("Factory Droid completions reasoning matrix", () => {
	it("lets a caller override the pinned completions temperature", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				temperature: 0.2,
			},
		).result();
		expect(captured[0].body.temperature).toBe(0.2);
	});

	it("forwards the first-event budget and aborts a stalled completions stream via the idle watchdog", async () => {
		// One valid chunk, then a stall: the first-event budget (huge here) must
		// be released once the first SSE event arrived, so the steady-state idle
		// watchdog governs the next wait and aborts fast. If the forwarded idle
		// budget leaked, the stream would hang until the 60s first-event deadline.
		const encoder = new TextEncoder();
		let releaseAfterFirst: ((reason: unknown) => void) | undefined;
		const partial = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							id: "chatcmpl-test",
							object: "chat.completion.chunk",
							created: 1,
							model: "kimi-k3",
							choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }],
						})}\n\n`,
					),
				);
				releaseAfterFirst = (reason: unknown) => controller.error(reason);
			},
			cancel() {
				releaseAfterFirst?.(new DOMException("Aborted", "AbortError"));
			},
		});
		const headers: Headers[] = [];
		const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			headers.push(new Headers(init?.headers));
			(init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
				releaseAfterFirst?.(new DOMException("Aborted", "AbortError")),
			);
			return new Response(partial, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		});
		const stream = streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				streamIdleTimeoutMs: 50,
				streamFirstEventTimeoutMs: 60_000,
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}
		// Only the first-event budget rides the wire as X-Stainless-Timeout.
		expect(headers[0].get("x-stainless-timeout")).toBe("60");
		// The watchdog fires and the client surfaces a provider error, not a hang.
		expect(events).toContain("text_delta");
		expect(events).toContain("error");
		expect(events).not.toContain("done");
	});

	it.each(["baseten", "mistral", "databricks"])(
		"emits GLM reasoning_effort verbatim without template or history fields via %s",
		async upstream => {
			const captured: CapturedRequest[] = [];
			await streamFactoryDroid(
				glm53(upstream),
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: "workos-token",
					fetch: captureFetch(captured, completionsChunks("OK", "glm-5.3")),
					reasoning: Effort.Max,
				},
			).result();

			expect(captured[0].headers["x-api-provider"]).toBe(upstream);
			// "max" passes verbatim on the completions route (no max -> xhigh mapping).
			expect(captured[0].body.reasoning_effort).toBe("max");
			expect(captured[0].body.chat_template_args).toBeUndefined();
			expect(captured[0].body.reasoning_history).toBeUndefined();
		},
	);

	it("decodes typed thinking for GLM routed through Mistral, not only Mistral model IDs", async () => {
		const captured: CapturedRequest[] = [];
		const routed = glm53("mistral");
		const chunks = [
			JSON.stringify({
				id: "glm-typed",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.3",
				choices: [
					{
						index: 0,
						delta: {
							content: [
								{ type: "thinking", thinking: [{ type: "text", text: "route-specific" }] },
								{ type: "text", text: "answer" },
							],
						},
					},
				],
			}),
			...completionsChunks("", "glm-5.3").slice(1),
		];
		const first = await streamFactoryDroid(
			routed,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "workos-token", fetch: captureFetch(captured, chunks), reasoning: Effort.High },
		).result();
		expect(first.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "route-specific" }));
		expect(first.content).toContainEqual(expect.objectContaining({ type: "text", text: "answer" }));
		await streamFactoryDroid(
			routed,
			{
				messages: [
					{ role: "user", content: "hello", timestamp: 1 },
					first,
					{ role: "user", content: "continue", timestamp: 2 },
				],
			},
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "glm-5.3")),
				reasoning: Effort.High,
			},
		).result();
		const messages = captured[1].body.messages as Array<Record<string, unknown>>;
		expect(messages.find(message => message.role === "assistant")?.content).toEqual([
			{ type: "thinking", thinking: [{ type: "text", text: "route-specific" }] },
			{ type: "text", text: "answer" },
		]);
	});

	it("heals text-only Mistral typed parts instead of dropping unstructured thinking", async () => {
		const captured: CapturedRequest[] = [];
		const chunks = [
			JSON.stringify({
				id: "mistral-think",
				object: "chat.completion.chunk",
				created: 1,
				model: "mistral-medium-3.5",
				choices: [{ index: 0, delta: { content: [{ type: "text", text: "<think>reason</think>answer" }] } }],
			}),
			...completionsChunks("", "mistral-medium-3.5").slice(1),
		];
		const result = await streamFactoryDroid(
			mistralMedium35(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "workos-token", fetch: captureFetch(captured, chunks), reasoning: Effort.High },
		).result();
		expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "reason" }));
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "answer" }));
	});

	it("retains scalar reasoning beside typed text-only content", async () => {
		const result = await streamFactoryDroid(
			mistralMedium35(),
			{
				messages: [{ role: "user", content: "answer", timestamp: 1 }],
			},
			{
				apiKey: "workos-token",
				fetch: captureFetch(
					[],
					[
						JSON.stringify({
							id: "mixed",
							object: "chat.completion.chunk",
							created: 1,
							model: "mistral-medium-3.5",
							choices: [
								{
									index: 0,
									delta: {
										reasoning_content: "scalar reason",
										content: [{ type: "text", text: "answer" }],
									},
									finish_reason: "stop",
								},
							],
						}),
					],
				),
			},
		).result();
		expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "scalar reason" }));
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "answer" }));
	});

	it.each(["minimax-m3", "mistral-medium-3.5", "mistral-large-4"])(
		"preserves %s reasoning over two tool turns with native implicit effort",
		async modelId => {
			const model = factoryModel(modelId);
			const captured: CapturedRequest[] = [];
			const messages: Message[] = [{ role: "user", content: "inspect twice", timestamp: 1 }];
			for (let turn = 0; turn < 3; turn++) {
				const reasoning = `reason-${turn}`;
				const delta = {
					...(modelId === "minimax-m3"
						? { reasoning_content: reasoning }
						: { content: [{ type: "thinking", thinking: [{ type: "text", text: reasoning }] }] }),
					tool_calls: [
						{ index: 0, id: `call${turn}`, type: "function", function: { name: "Read", arguments: "{}" } },
					],
				};
				const result = await streamFactoryDroid(
					model,
					{
						messages,
						tools: [{ name: "Read", description: "read", parameters: type({}) }],
					},
					{
						apiKey: "workos-token",
						fetch: captureFetch(captured, [
							JSON.stringify({
								id: `turn${turn}`,
								object: "chat.completion.chunk",
								created: 1,
								model: modelId,
								choices: [{ index: 0, delta, finish_reason: "tool_calls" }],
							}),
						]),
					},
				).result();
				expect(result.stopReason).toBe("toolUse");
				const call = result.content.find(block => block.type === "toolCall");
				if (!call || call.type !== "toolCall") throw new Error("Missing tool call");
				messages.push(result, {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: `result-${turn}` }],
					isError: false,
					timestamp: turn + 2,
				});
			}
			for (const request of captured) {
				expect(request.body.reasoning_effort).toBe("high");
				expect(request.body.reasoning_history).toBeUndefined();
			}
			const replay = (captured[2].body.messages as Array<Record<string, unknown>>).filter(
				message => message.role === "assistant",
			);
			expect(replay).toHaveLength(2);
			for (let turn = 0; turn < 2; turn++) {
				if (modelId === "minimax-m3") expect(replay[turn].reasoning_content).toBe(`reason-${turn}`);
				else {
					expect(replay[turn].reasoning_content).toBeUndefined();
					expect(replay[turn].content).toContainEqual({
						type: "thinking",
						thinking: [{ type: "text", text: `reason-${turn}` }],
					});
				}
			}
		},
	);

	it("decodes Mistral split thinking/text deltas and replays ordered typed reasoning with a tool call", async () => {
		const model = mistralMedium35();
		const captured: CapturedRequest[] = [];
		const modelId = "mistral-medium-3.5";
		const chunk = (delta: Record<string, unknown>, finish_reason?: string) =>
			JSON.stringify({
				id: "chatcmpl-mistral",
				object: "chat.completion.chunk",
				created: 1,
				model: modelId,
				choices: [{ index: 0, delta, finish_reason }],
			});
		const chunks = [
			chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: "first " }] }] }),
			chunk({
				reasoning_content: "step", // Alias on the same chunk must not duplicate the typed thinking part.
				content: [
					{ type: "thinking", thinking: [{ type: "text", text: "step" }] },
					{ type: "text", text: "Checking " },
				],
			}),
			chunk(
				{
					content: "file",
					tool_calls: [
						{
							index: 0,
							id: "abcdefghi",
							type: "function",
							function: { name: "Read", arguments: '{"path":"x"}' },
						},
					],
				},
				"tool_calls",
			),
		];
		const first = await streamFactoryDroid(
			model,
			{
				systemPrompt: ["Keep user policy"],
				messages: [{ role: "user", content: "inspect", timestamp: 1 }],
				tools: [{ name: "Read", description: "Read file", parameters: type({ path: "string" }) }],
			},
			{ apiKey: "workos-token", fetch: captureFetch(captured, chunks), reasoning: Effort.High },
		).result();
		expect(first.content.map(block => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(first.content[0]).toMatchObject({
			type: "thinking",
			thinking: "first step",
			thinkingSignature: "mistral-content-parts",
		});
		expect(first.content[1]).toMatchObject({ type: "text", text: "Checking file" });

		await streamFactoryDroid(
			model,
			{
				systemPrompt: ["Keep user policy"],
				tools: [{ name: "Read", description: "Read file", parameters: type({ path: "string" }) }],
				messages: [
					{ role: "user", content: "inspect", timestamp: 1 },
					first,
					{
						role: "toolResult",
						toolCallId: "abcdefghi",
						toolName: "Read",
						content: [{ type: "text", text: "body" }],
						isError: false,
						timestamp: 3,
					},
					{ role: "user", content: "summarize", timestamp: 4 },
				],
			},
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", modelId)),
				reasoning: Effort.High,
			},
		).result();
		const messages = captured[1].body.messages as Array<Record<string, unknown>>;
		expect(captured[1].body.tools).toBeDefined();
		expect(JSON.stringify(captured[1].body.messages)).toContain("Keep user policy");
		const replayed = messages.find(message => message.role === "assistant" && message.tool_calls);
		expect(replayed?.content).toEqual([
			{ type: "thinking", thinking: [{ type: "text", text: "first step" }] },
			{ type: "text", text: "Checking file" },
		]);
		expect(replayed?.reasoning_content).toBeUndefined();
		expect(messages.find(message => message.role === "tool")?.tool_call_id).toBe("abcdefghi");
	});

	it("does not suppress reasoning when a named tool is forced (kimi)", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{
				messages: [{ role: "user", content: "read the file", timestamp: 1 }],
				tools: [
					{
						name: "Read",
						description: "read a file",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			},
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				reasoning: Effort.High,
				toolChoice: { type: "tool", name: "Read" },
			},
		).result();

		expect(captured[0].body.tool_choice).toEqual({ type: "function", function: { name: "Read" } });
		expect(captured[0].body.reasoning_effort).toBe("high");
		expect(captured[0].body.reasoning_history).toBe("preserved");
	});

	describe("long tool names", () => {
		const LONG = `mcp__${"long_server__".repeat(4)}${"t".repeat(16)}`;
		const LONG_WIRE = "mcp__long_server__long_server__long_server__long_server_7c6fd6f9";
		const tool = (name: string) => ({ name, description: "d", parameters: type({ path: "string" }) });
		/** Chat-completions chunks returning one tool call per name, then `tool_calls`. */
		const callChunks = (...names: string[]) => [
			JSON.stringify({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 1,
				model: "kimi-k3",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: names.map((name, index) => ({
								index,
								id: `call_${index}`,
								type: "function",
								function: { name, arguments: '{"path":"b"}' },
							})),
						},
					},
				],
			}),
			JSON.stringify({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 1,
				model: "kimi-k3",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
		];
		type Body = {
			tools: Array<{ function: { name: string } }>;
			tool_choice?: unknown;
			messages: Array<{ role: string; tool_calls?: Array<{ function: { name: string } }>; content?: unknown }>;
		};

		it("sends a 73-character name capped to 64 and keeps its call and result in replayed history", async () => {
			expect(LONG).toHaveLength(73);
			const captured: CapturedRequest[] = [];
			const result = await streamFactoryDroid(
				kimiK3(),
				{
					messages: [
						{ role: "user", content: "go", timestamp: 1 },
						assistantTurn(
							[{ type: "toolCall", id: "call_long", name: LONG, arguments: { path: "a" } }],
							"kimi-k3",
						),
						{
							role: "toolResult",
							toolCallId: "call_long",
							toolName: LONG,
							content: [{ type: "text", text: "long result" }],
							isError: false,
							timestamp: 3,
						},
					],
					tools: [tool(LONG)],
				},
				{ apiKey: "workos-token", fetch: captureFetch(captured, callChunks(LONG_WIRE)) },
			).result();
			const body = captured[0].body as Body;
			expect(body.tools[0].function.name).toBe(LONG_WIRE);
			expect(body.messages.find(message => message.role === "assistant")?.tool_calls?.[0].function.name).toBe(
				LONG_WIRE,
			);
			expect(body.messages.find(message => message.role === "tool")?.content).toContain("long result");
			expect(result.content.find(block => block.type === "toolCall")).toMatchObject({ name: LONG });
		});

		it("declares names of 64 characters or fewer verbatim, dots included", async () => {
			const captured: CapturedRequest[] = [];
			await streamFactoryDroid(
				kimiK3(),
				{
					messages: [{ role: "user", content: "go", timestamp: 1 }],
					tools: [tool("mcp.server.tool"), tool("mcp_server_tool")],
				},
				{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")) },
			).result();
			expect((captured[0].body as Body).tools.map(t => t.function.name)).toEqual([
				"mcp.server.tool",
				"mcp_server_tool",
			]);
		});

		it.each([
			["tool", { type: "tool" as const, name: LONG }],
			["function", { type: "function" as const, function: { name: LONG } }],
		])("forces a long-named tool by its wire name (%s shape) and maps the call back", async (_shape, toolChoice) => {
			const captured: CapturedRequest[] = [];
			const result = await streamFactoryDroid(
				kimiK3(),
				{ messages: [{ role: "user", content: "go", timestamp: 1 }], tools: [tool(LONG)] },
				{ apiKey: "workos-token", fetch: captureFetch(captured, callChunks(LONG_WIRE)), toolChoice },
			).result();
			expect((captured[0].body as Body).tool_choice).toEqual({ type: "function", function: { name: LONG_WIRE } });
			expect(result.content.find(block => block.type === "toolCall")).toMatchObject({ name: LONG });
		});

		it("maps parallel long and short calls back and names the caller's tool on every tool-call event", async () => {
			const captured: CapturedRequest[] = [];
			const stream = streamFactoryDroid(
				kimiK3(),
				{ messages: [{ role: "user", content: "go", timestamp: 1 }], tools: [tool(LONG), tool("Read")] },
				{ apiKey: "workos-token", fetch: captureFetch(captured, callChunks(LONG_WIRE, "Read")) },
			);
			const eventNames: string[] = [];
			for await (const event of stream) {
				if (event.type === "toolcall_start") {
					const block = event.partial.content[event.contentIndex];
					if (block.type === "toolCall") eventNames.push(`start:${block.name}`);
				}
				if (event.type === "toolcall_end") eventNames.push(`end:${event.toolCall.name}`);
			}
			const result = await stream.result();
			expect(result.content.flatMap(block => (block.type === "toolCall" ? [block.name] : []))).toEqual([
				LONG,
				"Read",
			]);
			expect(eventNames).toEqual(expect.arrayContaining([`start:${LONG}`, `end:${LONG}`, "start:Read", "end:Read"]));
			expect(eventNames.some(name => name.includes(LONG_WIRE))).toBe(false);
		});

		it("refuses two long names that encode to the same wire name before sending", async () => {
			const captured: CapturedRequest[] = [];
			const dotted = `mcp.${"long_server.".repeat(4)}${"t".repeat(17)}`;
			const result = await streamFactoryDroid(
				kimiK3(),
				{
					messages: [{ role: "user", content: "go", timestamp: 1 }],
					tools: [tool(dotted), tool(dotted.replaceAll(".", "_"))],
				},
				{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")) },
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("both encode as");
			expect(captured).toHaveLength(0);
		});

		it("caps at the limit it is given, so a catalog bound other than 64 moves the cap with it", () => {
			const wire = encodeFactoryDroidCompletionsToolName(LONG, 40);
			expect(wire).toHaveLength(40);
			expect(wire.slice(0, 31)).toBe(LONG.slice(0, 31));
			expect(encodeFactoryDroidCompletionsToolName(LONG, 73)).toBe(LONG);
		});
	});

	it("ends with an error result when a provider retry wait rejects", async () => {
		// An empty completion triggers the shared empty-response retry; its wait
		// rejecting fails the retry stream, which the completions transport turns
		// into an `error` event, so the tool-name wrapper ends instead of hanging.
		const empty = [
			JSON.stringify({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 1,
				model: "kimi-k3",
				choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 11, completion_tokens: 0, total_tokens: 11 },
			}),
		];
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, empty),
				providerRetryWait: async () => {
					throw new Error("retry wait rejected");
				},
			},
		).result();
		expect(captured).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("retry wait rejected");
	});

	it("does not invent synthetic reasoning_content or content for kimi tool-call history", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{
				messages: [
					{ role: "user", content: "read the file", timestamp: 1 },
					...toolTurn("k", "kimi-k3"),
					{ role: "user", content: "now summarize", timestamp: 4 },
				],
			},
			{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")) },
		).result();

		const messages = captured[0].body.messages as Array<{
			role: string;
			content?: unknown;
			tool_calls?: unknown;
			reasoning_content?: unknown;
		}>;
		const toolCallTurn = messages.find(message => message.role === "assistant" && message.tool_calls);
		expect(toolCallTurn).toBeDefined();
		expect(toolCallTurn?.reasoning_content).toBeUndefined();
		// Empty assistant content is normalized to "" for the wire, never ".".
		expect(toolCallTurn?.content).not.toBe(".");
	});

	it("replays stored reasoning_content on assistant turns for glm-5.3", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			glm53(),
			{
				messages: [
					{ role: "user", content: "think hard", timestamp: 1 },
					assistantTurn(
						[
							{ type: "thinking", thinking: "stored reasoning", thinkingSignature: "reasoning_content" },
							{ type: "text", text: "the answer" },
						],
						"glm-5.3",
					),
					{ role: "user", content: "continue", timestamp: 3 },
				],
			},
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "glm-5.3")),
				reasoning: Effort.High,
			},
		).result();

		const messages = captured[0].body.messages as Array<{ role: string; reasoning_content?: unknown }>;
		expect(messages.find(message => message.role === "assistant")?.reasoning_content).toBe("stored reasoning");
	});

	it("forces a single-space reasoning_content only on deepseek tool-call turns", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			deepseekFlash(),
			{
				messages: [
					{ role: "user", content: "read the file", timestamp: 1 },
					assistantTurn([{ type: "text", text: "answer with no reasoning" }], "deepseek-v4.1-flash"),
					{ role: "user", content: "now call the tool", timestamp: 3 },
					...toolTurn("d", "deepseek-v4.1-flash"),
					{ role: "user", content: "summarize", timestamp: 6 },
				],
			},
			{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "deepseek-v4.1-flash")) },
		).result();

		const messages = captured[0].body.messages as Array<{
			role: string;
			content?: unknown;
			tool_calls?: unknown;
			reasoning_content?: unknown;
		}>;
		const plainAssistants = messages.filter(
			message => message.role === "assistant" && typeof message.content === "string" && !message.tool_calls,
		);
		// Plain assistant turns (no tool calls, no stored reasoning) carry no forced field.
		for (const turn of plainAssistants) {
			expect(turn.reasoning_content).toBeUndefined();
		}
		const toolCallTurn = messages.find(message => message.role === "assistant" && message.tool_calls);
		expect(toolCallTurn).toBeDefined();
		// Tool-call turns force the native single-space placeholder, not "".
		expect(toolCallTurn?.reasoning_content).toBe(" ");
	});
});
