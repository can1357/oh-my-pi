import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ServerWebSocket } from "bun";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { type as schemaType } from "@oh-my-pi/omptype";
import { streamOpenAIResponses, type OpenAIResponsesOptions } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	Context,
	Model,
	ProviderResponseMetadata,
	ProviderSessionState,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { endpoint as createEndpoint, send, sse, textEvents } from "./fixtures/openai-responses-server";

const EventedWebSocket = require("ws") as { prototype: WebSocket };

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of resources.splice(0)) await dispose();
});

function endpoint(
	behavior?: (socket: ServerWebSocket<{ id: number }>, body: Record<string, unknown>, index: number) => void,
	setup?: {
		rejectUpgrade?: (request: Request) => Response | undefined | Promise<Response | undefined>;
		httpResponse?: (body: Record<string, unknown>) => Response | undefined;
	},
) {
	const wire = createEndpoint(behavior, setup);
	const providerSessionState = new Map<string, ProviderSessionState>();
	const model: Model<"openai-responses"> = {
		...getBundledModel("openai", "gpt-5-mini"),
		baseUrl: `http://127.0.0.1:${wire.server.port}/v1`,
	};
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
	const options = {
		apiKey: "test-key",
		sessionId: "main",
		providerSessionState,
		streamFirstEventTimeoutMs: 1000,
		streamIdleTimeoutMs: 1000,
	};
	resources.push(async () => {
		for (const state of providerSessionState.values()) state.close();
		await wire.server.stop(true);
	});
	return { ...wire, model, context, options, providerSessionState };
}

// These tests exercise the public provider stream against real Bun HTTP/WS endpoints.
describe("standard OpenAI Responses WebSocket opt-in", () => {
	it("keeps a gateway on HTTP/SSE without explicit opt-in", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, fixture.options).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "HTTP" }]);
		expect(fixture.httpRequests).toHaveLength(1);
		expect(fixture.upgrades).toHaveLength(0);
	});

	it("runs an explicit WS payload hook for an already-aborted request without connecting", async () => {
		const fixture = endpoint();
		let payloadCalls = 0;
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			signal: AbortSignal.abort(),
			onPayload: () => {
				payloadCalls++;
			},
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(payloadCalls).toBe(1);
		expect(fixture.upgrades).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("does not connect when a payload hook rejects the candidate", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			onPayload: () => {
				throw new Error("payload denied by caller");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("payload denied by caller");
		expect(fixture.upgrades).toHaveLength(0);
		expect(fixture.requests).toHaveLength(0);
	});

	it("rebuilds HTTP storage controls and reapplies payload replacement after a rejected upgrade", async () => {
		const fixture = endpoint(undefined, { rejectUpgrade: () => new Response("SSE only", { status: 404 }) });
		const stores: unknown[] = [];
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			statefulResponses: true,
			onPayload: payload => {
				const body = payload as Record<string, unknown>;
				stores.push(body.store);
				return { ...body, metadata: { candidate: body.store ? "http" : "ws" } };
			},
		}).result();
		expect(result.content).toMatchObject([{ type: "text", text: "HTTP" }]);
		expect(stores).toEqual([false, true]);
		expect(fixture.httpRequests[0]).toMatchObject({ store: true, metadata: { candidate: "http" } });
		expect(fixture.httpRequests[0]?.previous_response_id).toBeUndefined();
		expect(fixture.requests).toHaveLength(0);
	});

	it("reports the physical handshake once instead of stale headers for each reused-socket generation", async () => {
		const fixture = endpoint();
		const responses: ProviderResponseMetadata[] = [];
		const options = {
			...fixture.options,
			preferWebsockets: true,
			onResponse: (response: ProviderResponseMetadata) => {
				responses.push(response);
			},
		};
		for (let turn = 0; turn < 2; turn++) {
			expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).stopReason).toBe(
				"stop",
			);
		}
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.upgrades).toHaveLength(1);
		expect(responses).toHaveLength(1);
		expect(responses[0]?.metadata).toEqual({ transport: "websocket", phase: "handshake" });
		expect(responses[0]?.requestId).toBeUndefined();
	});

	it("finishes response.done even when local handling crosses the first-event deadline", async () => {
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const fixture = endpoint(socket => {
				send(socket, [{ ...textEvents("WS", "resp_done").at(-1)!, type: "response.done" }]);
			});
			const result = await streamOpenAIResponses(fixture.model, fixture.context, {
				...fixture.options,
				preferWebsockets: true,
				streamIdleTimeoutMs: 5000,
				onSseEvent: event => {
					if (event.event === "response.done") now += 2000;
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.responseId).toBe("resp_done");
			expect(result.usage.input).toBe(5);
			expect(fixture.requests).toHaveLength(1);
		} finally {
			clock.mockRestore();
		}
	});

	it("uses response.create on the standard path with unchanged auth and custom headers", async () => {
		const fixture = endpoint();
		const observed: string[] = [];
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			headers: { "X-Test-Header": "preserved", "OpenAI-Organization": "test-org" },
			onSseEvent: event => {
				if (event.event) observed.push(event.event);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "WS" }]);
		expect(result.usage.input).toBe(5);
		expect(result.usage.output).toBe(3);
		expect(fixture.upgrades[0]?.path).toBe("/v1/responses");
		expect(fixture.upgrades[0]?.headers.get("authorization")).toBe("Bearer test-key");
		expect(fixture.upgrades[0]?.headers.get("x-test-header")).toBe("preserved");
		expect(fixture.upgrades[0]?.headers.get("openai-organization")).toBe("test-org");
		expect(fixture.upgrades[0]?.headers.get("openai-beta")).toBeNull();
		expect(fixture.requests[0]?.body).toMatchObject({ type: "response.create", model: fixture.model.id });
		expect(fixture.requests[0]?.body.stream).toBeUndefined();
		expect(fixture.requests[0]?.body.background).toBeUndefined();
		expect(fixture.httpRequests).toHaveLength(0);
		expect(observed).toContain("response.output_text.delta");
	});

	it("honors explicit transport preferences over an injected fetch", async () => {
		const fixture = endpoint();
		let fetchCalls = 0;
		const customFetch = Object.assign(
			(...args: Parameters<typeof fetch>) => {
				fetchCalls++;
				return fetch(...args);
			},
			{ preconnect: fetch.preconnect },
		);
		const model = { ...fixture.model, preferWebsockets: true };
		const options = { ...fixture.options, fetch: customFetch };
		const modelOptIn = await streamOpenAIResponses(model, fixture.context, options).result();
		expect(modelOptIn.content).toMatchObject([{ type: "text", text: "WS" }]);
		expect(fetchCalls).toBe(0);

		const requestOptOut = await streamOpenAIResponses(model, fixture.context, {
			...options,
			preferWebsockets: false,
		}).result();
		expect(requestOptOut.content).toMatchObject([{ type: "text", text: "HTTP" }]);
		expect(fetchCalls).toBe(1);

		const modelOptOut = await streamOpenAIResponses({ ...model, preferWebsockets: false }, fixture.context, {
			...options,
			preferWebsockets: true,
		}).result();
		expect(modelOptOut.content).toMatchObject([{ type: "text", text: "HTTP" }]);
		expect(fetchCalls).toBe(2);
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(2);
	});

	it("omits SSE-only WS options while preserving HTTP and payload hooks", async () => {
		const fixture = endpoint(
			(socket, body) => {
				const metadata = body.metadata as { source?: string } | undefined;
				if (
					"stream" in body ||
					"stream_options" in body ||
					body.custom_gateway_field !== "same" ||
					metadata?.source !== "hook"
				) {
					socket.send(
						JSON.stringify({
							type: "error",
							error: { code: "invalid_parameter", message: "Invalid response.create fields" },
						}),
					);
					return;
				}
				send(socket, textEvents("WS accepted", "resp_valid_ws"));
			},
			{
				httpResponse: body => {
					const streamOptions = body.stream_options as { include_obfuscation?: boolean } | undefined;
					return body.stream === true && streamOptions?.include_obfuscation === false
						? undefined
						: Response.json({ error: { message: "Missing SSE obfuscation options" } }, { status: 400 });
				},
			},
		);
		const model: Model<"openai-responses"> = {
			...fixture.model,
			compat: { ...fixture.model.compat, supportsObfuscationOptOut: true },
		};
		const options: OpenAIResponsesOptions = {
			...fixture.options,
			extraBody: { custom_gateway_field: "same" },
			onPayload: payload => ({ ...(payload as object), metadata: { source: "hook" } }),
		};
		const http = await streamOpenAIResponses(model, fixture.context, options).result();
		expect(http.stopReason).toBe("stop");
		expect(http.content).toContainEqual(expect.objectContaining({ type: "text", text: "HTTP" }));
		const ws = await streamOpenAIResponses(model, fixture.context, { ...options, preferWebsockets: true }).result();
		expect(ws.stopReason).toBe("stop");
		expect(ws.content).toContainEqual(expect.objectContaining({ type: "text", text: "WS accepted" }));
		expect(fixture.httpRequests).toHaveLength(1);
		expect(fixture.requests).toHaveLength(1);
	});

	it("continues three SDK turns from the complete local transcript with store:false on one socket", async () => {
		const fixture = endpoint((socket, body, index) => {
			const input = body.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
			const expectedText = index === 1 ? "Hello" : `Turn ${index}`;
			if (
				body.store !== false ||
				body.previous_response_id !== (index === 1 ? undefined : `resp_${index - 1}`) ||
				input.length !== 1 ||
				input[0]?.role !== "user" ||
				input[0]?.content?.[0]?.text !== expectedText
			) {
				send(socket, [
					{ type: "error", error: { code: "invalid_request", message: "Invalid conversation continuation" } },
				]);
				return;
			}
			send(socket, textEvents(`Accepted ${expectedText}`, `resp_${index}`));
		});
		const options = { ...fixture.options, preferWebsockets: true, storeResponses: false };
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Turn ${turn}`, timestamp: turn });
			const result = await streamSimple(fixture.model, context, options).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toMatchObject([
				{ type: "text", text: `Accepted ${turn === 1 ? "Hello" : `Turn ${turn}`}` },
			]);
			context.messages.push(result);
		}
		expect(fixture.requests).toHaveLength(3);
		expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 1]);
		expect(fixture.requests.map(request => request.body.previous_response_id)).toEqual([
			undefined,
			"resp_1",
			"resp_2",
		]);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("continues streamed function and custom tools using only each new result across three SDK turns", async () => {
		for (const kind of ["function", "custom"] as const) {
			const name = kind === "function" ? "lookup" : "apply_patch";
			const callType = kind === "function" ? "function_call" : "custom_tool_call";
			const fixture = endpoint((socket, body, index) => {
				const input = body.input as Array<{ type?: string; call_id?: string; output?: string; role?: string }>;
				const valid =
					index === 1
						? body.previous_response_id === undefined && input.length === 1 && input[0]?.role === "user"
						: body.previous_response_id === `resp_tool_${index - 1}` &&
							input.length === 1 &&
							input[0]?.type === `${callType}_output` &&
							input[0]?.call_id === `call_${index - 1}` &&
							input[0]?.output === `result ${index - 1}`;
				if (!valid) {
					send(socket, [
						{ type: "error", error: { code: "invalid_request", message: "Missing anchored tool result" } },
					]);
					return;
				}
				if (index === 3) {
					send(socket, textEvents("Both results accepted", "resp_done"));
					return;
				}
				const value = kind === "function" ? '{"query":"hello"}' : "*** Begin Patch\n*** End Patch\n";
				const field = kind === "function" ? "arguments" : "input";
				const item = {
					type: callType,
					id: `${kind === "function" ? "fc" : "ctc"}_${index}`,
					call_id: `call_${index}`,
					name,
					[field]: value,
					status: "completed",
				};
				send(socket, [
					{ type: "response.created", response: { id: `resp_tool_${index}` } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...item, [field]: "", status: "in_progress" },
					},
					{
						type:
							kind === "function"
								? "response.function_call_arguments.delta"
								: "response.custom_tool_call_input.delta",
						output_index: 0,
						item_id: item.id,
						delta: value,
					},
					{ type: "response.output_item.done", output_index: 0, item },
					{
						type: "response.completed",
						response: { id: `resp_tool_${index}`, status: "completed", output: [item] },
					},
				]);
			});
			const model = { ...fixture.model, ...(kind === "custom" ? { applyPatchToolType: "freeform" as const } : {}) };
			const context: Context = {
				...fixture.context,
				messages: [...fixture.context.messages],
				tools: [{ name, description: "Use the tool", parameters: schemaType({ query: "string" }) }],
			};
			const options = { ...fixture.options, preferWebsockets: true };
			for (const turn of [1, 2, 3]) {
				const result = await streamSimple(model, context, options).result();
				expect(result.stopReason).toBe(turn === 3 ? "stop" : "toolUse");
				context.messages.push(result);
				if (turn === 3) {
					expect(result.content).toMatchObject([{ type: "text", text: "Both results accepted" }]);
					continue;
				}
				const toolCall = result.content.find(block => block.type === "toolCall");
				if (toolCall?.type !== "toolCall") throw new Error("Expected streamed tool call");
				expect(toolCall.arguments).toEqual(
					kind === "function" ? { query: "hello" } : { input: "*** Begin Patch\n*** End Patch\n" },
				);
				context.messages.push({
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: `result ${turn}` }],
					isError: false,
					timestamp: turn + 1,
				});
			}
			expect(fixture.requests).toHaveLength(3);
			expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 1]);
			expect(fixture.upgrades).toHaveLength(1);
			expect(fixture.httpRequests).toHaveLength(0);
		}
	});

	it("replays complete history after history, tool, option, or post-hook payload changes", async () => {
		const fixture = endpoint((socket, body, index) => {
			if (
				body.previous_response_id !== undefined ||
				!Array.isArray(body.input) ||
				body.input.length !== index * 2 - 1
			) {
				send(socket, [
					{ type: "error", error: { code: "invalid_request", message: "Expected complete changed transcript" } },
				]);
				return;
			}
			send(socket, textEvents(`TURN ${index}`, `resp_${index}`));
		});
		let hookRevision = 0;
		const options: SimpleStreamOptions = {
			...fixture.options,
			preferWebsockets: true,
			onPayload: payload => ({ ...(payload as object), metadata: { revision: String(hookRevision) } }),
		};
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3, 4, 5]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Next ${turn}`, timestamp: turn });
			if (turn === 2) context.messages[0] = { role: "user", content: "Edited Hello", timestamp: 1 };
			if (turn === 3) context.tools = [{ name: "lookup", description: "Search", parameters: schemaType({}) }];
			// GPT-5 Mini drops sampling options in streamSimple; change an option
			// that actually survives SDK policy and reaches response.create.
			if (turn === 4) options.maxTokens = 1024;
			if (turn === 5) hookRevision++;
			const result = await streamSimple(fixture.model, context, options).result();
			expect(result.stopReason).toBe("stop");
			context.messages.push(result);
		}
		expect(fixture.requests[4]?.body.metadata).toEqual({ revision: "1" });
		expect(fixture.requests[3]?.body.max_output_tokens).toBe(1024);
		expect(fixture.requests[2]?.body.tools).toHaveLength(1);
		expect(JSON.stringify(fixture.requests[1]?.body.input)).toContain("Edited Hello");
		expect(fixture.requests).toHaveLength(5);
		expect(fixture.upgrades).toHaveLength(1);
	});

	it("lets statefulResponses:false opt out per request without forcing response storage", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true, storeResponses: false };
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Next ${turn}`, timestamp: turn });
			const result = await streamSimple(fixture.model, context, {
				...options,
				...(turn === 2 ? { statefulResponses: false } : {}),
			}).result();
			expect(result.stopReason).toBe("stop");
			context.messages.push(result);
		}
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
		expect(fixture.requests[2]?.body.previous_response_id).toBe("resp_2");
		expect(fixture.requests[2]?.body.input).toHaveLength(1);
		expect(fixture.requests.map(request => request.body.store)).toEqual([false, false, false]);
		expect(fixture.upgrades).toHaveLength(1);
	});

	it("clears the old anchor when a successful terminal response has no id", async () => {
		const fixture = endpoint((socket, body, index) => {
			const expectedAnchor = index === 2 ? "resp_1" : index === 4 ? "resp_3" : undefined;
			const expectedLength = index === 3 ? 5 : 1;
			if (
				body.previous_response_id !== expectedAnchor ||
				!Array.isArray(body.input) ||
				body.input.length !== expectedLength
			) {
				send(socket, [
					{
						type: "error",
						error: { code: "invalid_request", message: "Missing response id must break the anchor chain" },
					},
				]);
				return;
			}
			const events = textEvents(`TURN ${index}`, `resp_${index}`);
			if (index === 2) {
				// The locally constructed response keeps its created id, but not its terminal id.
				const completed = events[events.length - 1]?.response as Record<string, unknown>;
				delete completed.id;
			}
			send(socket, events);
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3, 4]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Next ${turn}`, timestamp: turn });
			const result = await streamSimple(fixture.model, context, options).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toMatchObject([{ type: "text", text: `TURN ${turn}` }]);
			context.messages.push(result);
		}
		expect(fixture.requests).toHaveLength(4);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("retries explicit first-frame stale anchors once on the same socket with complete history", async () => {
		for (const rejection of [
			{ code: "previous_response_not_found", message: "Response expired", recover: true },
			{ code: "invalid_request_error", message: "Invalid previous_response_id", recover: true },
			{ code: "invalid_request_error", message: "previous_response_id unsupported", recover: false },
		]) {
			const fixture = endpoint((socket, body, index) => {
				const input = body.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
				if (index === 1) {
					send(socket, textEvents("FIRST", "resp_first"));
					return;
				}
				if (index === 2) {
					if (
						body.previous_response_id !== "resp_first" ||
						input.length !== 1 ||
						input[0]?.content?.[0]?.text !== "Next"
					) {
						send(socket, [
							{ type: "error", error: { code: "invalid_request", message: "Expected anchored new user" } },
						]);
						return;
					}
					send(socket, [{ type: "error", error: { code: rejection.code, message: rejection.message } }]);
					return;
				}
				if (index === 3) {
					if (
						body.previous_response_id !== undefined ||
						input.length !== 3 ||
						input[0]?.content?.[0]?.text !== "Hello" ||
						input[1]?.role !== "assistant" ||
						input[1]?.content?.[0]?.text !== "FIRST" ||
						input[2]?.content?.[0]?.text !== "Next"
					) {
						send(socket, [
							{ type: "error", error: { code: "invalid_request", message: "Expected complete stale recovery" } },
						]);
						return;
					}
					if (rejection.recover) send(socket, textEvents("RECOVERED", "resp_recovered"));
					else send(socket, [{ type: "error", error: { code: rejection.code, message: rejection.message } }]);
					return;
				}
				if (
					body.previous_response_id === "resp_recovered" &&
					input.length === 1 &&
					input[0]?.content?.[0]?.text === "Again"
				) {
					send(socket, textEvents("CONTINUED", "resp_continued"));
				} else {
					send(socket, [
						{ type: "error", error: { code: "invalid_request", message: "Invalid recovered baseline" } },
					]);
				}
			});
			const options = { ...fixture.options, preferWebsockets: true };
			const first = await streamSimple(fixture.model, fixture.context, options).result();
			expect(first.stopReason).toBe("stop");
			const context: Context = {
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			};
			const second = await streamSimple(fixture.model, context, options).result();
			expect(second.stopReason).toBe(rejection.recover ? "stop" : "error");
			expect(fixture.requests).toHaveLength(3);
			expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 1]);
			if (rejection.recover) {
				expect(second.content).toMatchObject([{ type: "text", text: "RECOVERED" }]);
				context.messages.push(second, { role: "user", content: "Again", timestamp: 3 });
				const third = await streamSimple(fixture.model, context, options).result();
				expect(third.stopReason).toBe("stop");
				expect(third.content).toMatchObject([{ type: "text", text: "CONTINUED" }]);
				expect(fixture.requests).toHaveLength(4);
			} else {
				await fixture.waitForClosed(1);
			}
			expect(fixture.upgrades).toHaveLength(1);
			expect(fixture.httpRequests).toHaveLength(0);
		}
	});

	it("never replays unknown, generation, or post-progress anchor failures and retires their connection", async () => {
		for (const failure of ["unknown", "generation", "created", "output"] as const) {
			const fixture = endpoint((socket, body, index) => {
				if (index === 1) {
					send(socket, textEvents("FIRST", "resp_first"));
					return;
				}
				if (index > 2) {
					if (body.previous_response_id !== undefined || !Array.isArray(body.input) || body.input.length !== 3) {
						send(socket, [
							{
								type: "error",
								error: { code: "invalid_request", message: "Expected full history on replacement socket" },
							},
						]);
						return;
					}
					send(socket, textEvents("NEW CONNECTION", "resp_new"));
					return;
				}
				if (failure === "generation") {
					send(socket, [
						{
							type: "response.failed",
							response: {
								id: "resp_failed",
								status: "failed",
								error: { code: "server_error", message: "Generation failed" },
							},
						},
					]);
					return;
				}
				if (failure === "created") send(socket, [{ type: "response.created", response: { id: "resp_started" } }]);
				if (failure === "output") send(socket, textEvents("PARTIAL", "resp_partial").slice(0, 4));
				send(socket, [
					{
						type: "error",
						error:
							failure === "unknown"
								? { code: "invalid_request_error", message: "Unknown request failure" }
								: { code: "previous_response_not_found", message: "previous_response_id not found" },
					},
				]);
			});
			const options = { ...fixture.options, preferWebsockets: true };
			const first = await streamSimple(fixture.model, fixture.context, options).result();
			const context: Context = {
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			};
			const stream = streamSimple(fixture.model, context, options);
			const deltas: string[] = [];
			for await (const event of stream) if (event.type === "text_delta") deltas.push(event.delta);
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(deltas.join("")).toBe(failure === "output" ? "PARTIAL" : "");
			expect(fixture.requests).toHaveLength(2);
			expect(fixture.requests[1]?.body.previous_response_id).toBe("resp_first");
			await fixture.waitForClosed(1);
			expect((await streamSimple(fixture.model, context, options).result()).stopReason).toBe("stop");
			expect(fixture.requests).toHaveLength(3);
			expect(fixture.requests[2]?.connection).not.toBe(fixture.requests[0]?.connection);
			expect(fixture.upgrades).toHaveLength(2);
			expect(fixture.httpRequests).toHaveLength(0);
		}
	});

	it("replaces an OPEN socket whose inbound reuse window expired before sending", async () => {
		const actualNow = Date.now.bind(Date);
		let clockOffset = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => actualNow() + clockOffset);
		resources.push(async () => {
			clock.mockRestore();
		});
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true };
		const first = await streamSimple(fixture.model, fixture.context, options).result();
		expect(first.stopReason).toBe("stop");
		clockOffset += 30_001;
		expect(fixture.sockets.size).toBe(1);
		const result = await streamSimple(
			fixture.model,
			{
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			},
			{
				...options,
				streamFirstEventTimeoutMs: 250,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "WS" }));
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("reconnects after server close without sending a cross-connection response anchor", async () => {
		const fixture = endpoint((socket, _body, index) => {
			send(socket, textEvents("WS", `resp_${index}`));
			if (index === 1) socket.close(1000, "retire");
		});
		const clientClosed = Promise.withResolvers<void>();
		const descriptor = Object.getOwnPropertyDescriptor(EventedWebSocket.prototype, "onclose")!;
		resources.push(async () => {
			Object.defineProperty(EventedWebSocket.prototype, "onclose", descriptor);
		});
		Object.defineProperty(EventedWebSocket.prototype, "onclose", {
			...descriptor,
			set(this: WebSocket, handler: WebSocket["onclose"]) {
				descriptor.set?.call(
					this,
					handler
						? (event: CloseEvent) => {
								handler.call(this, event);
								clientClosed.resolve();
							}
						: handler,
				);
			},
		});
		const options = { ...fixture.options, preferWebsockets: true, statefulResponses: true };
		const first = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(first.stopReason).toBe("stop");
		await fixture.waitForClosed(1);
		// Bun's server close callback can run before the client even receives completed.
		// Wait for the peer close to be observable rather than racing a still-OPEN client.
		await clientClosed.promise;
		const second = await streamOpenAIResponses(
			fixture.model,
			{
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			},
			options,
		).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
	});

	it("keeps generation and socket reuse intact when the diagnostic observer throws", async () => {
		const fixture = endpoint((socket, _body, index) => {
			send(socket, textEvents(`TURN ${index}`, `resp_${index}`));
		});
		let observedDeltas = 0;
		const options: OpenAIResponsesOptions = {
			...fixture.options,
			preferWebsockets: true,
			onSseEvent: event => {
				if (event.event !== "response.output_text.delta") return;
				observedDeltas++;
				throw new Error("Diagnostic observer failed");
			},
		};
		for (const turn of [1, 2]) {
			const result = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toMatchObject([{ type: "text", text: `TURN ${turn}` }]);
		}
		expect(observedDeltas).toBe(2);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("rejects previous_response_id injected by onPayload rather than silently changing it", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			onPayload: payload => ({ ...(payload as object), previous_response_id: "resp_foreign" }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("previous_response_id");
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("rejects background requests locally", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			extraBody: { background: true },
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("background: true");
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("isolates a concurrent temporary socket from the busy session's continuation anchor", async () => {
		const firstSeen = Promise.withResolvers<void>();
		let firstSocket: ServerWebSocket<{ id: number }> | undefined;
		const fixture = endpoint((socket, body, index) => {
			if (index === 1) {
				send(socket, textEvents("SEED", "resp_seed"));
				return;
			}
			if (index === 2) {
				firstSocket = socket;
				firstSeen.resolve();
			}
			const expectedAnchor = index === 2 ? "resp_seed" : index === 3 ? undefined : "resp_first";
			if (
				body.previous_response_id !== expectedAnchor ||
				!Array.isArray(body.input) ||
				body.input.length !== (index === 3 ? 3 : 1)
			) {
				send(socket, [
					{ type: "error", error: { code: "invalid_request", message: "Cross-connection continuation" } },
				]);
				return;
			}
			if (index !== 2) send(socket, textEvents(index === 3 ? "SECOND" : "AFTER", `resp_${index}`));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const seed = await streamSimple(fixture.model, fixture.context, options).result();
		expect(seed.stopReason).toBe("stop");
		const context: Context = {
			messages: [...fixture.context.messages, seed, { role: "user", content: "Primary", timestamp: 2 }],
		};
		const first = streamSimple(fixture.model, context, options).result();
		await firstSeen.promise;
		const second = await streamSimple(fixture.model, context, options).result();
		expect(second.content).toMatchObject([{ type: "text", text: "SECOND" }]);
		if (!firstSocket) throw new Error("Expected first socket");
		send(firstSocket, textEvents("FIRST", "resp_first"));
		const primary = await first;
		expect(primary.content).toMatchObject([{ type: "text", text: "FIRST" }]);
		const after = await streamSimple(
			fixture.model,
			{
				messages: [...context.messages, primary, { role: "user", content: "After", timestamp: 3 }],
			},
			options,
		).result();
		expect(after.content).toMatchObject([{ type: "text", text: "AFTER" }]);
		expect(fixture.requests.map(request => request.connection)).toEqual([1, 1, 2, 1]);
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("cancels only its own concurrent request and retires the cancelled socket", async () => {
		const firstSeen = Promise.withResolvers<void>();
		const secondSeen = Promise.withResolvers<void>();
		let secondSocket: ServerWebSocket<{ id: number }> | undefined;
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) firstSeen.resolve();
			else {
				secondSocket = socket;
				secondSeen.resolve();
			}
		});
		const controller = new AbortController();
		const options = { ...fixture.options, preferWebsockets: true };
		const first = streamOpenAIResponses(fixture.model, fixture.context, {
			...options,
			signal: controller.signal,
		}).result();
		await firstSeen.promise;
		const second = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await secondSeen.promise;
		controller.abort();
		expect((await first).stopReason).toBe("aborted");
		await fixture.waitForClosed(1);
		if (!secondSocket) throw new Error("Expected concurrent socket");
		send(secondSocket, textEvents("SURVIVED", "resp_survived"));
		expect((await second).content).toMatchObject([{ type: "text", text: "SURVIVED" }]);
		expect(fixture.requests).toHaveLength(2);
	});

	for (const failure of ["error", "close", "malformed"] as const) {
		it(`surfaces ${failure} before output without replay or HTTP fallback`, async () => {
			const fixture = endpoint(socket => {
				if (failure === "error")
					socket.send(
						JSON.stringify({
							type: "error",
							error: { code: "rate_limit_exceeded", message: "Deliberate rejection" },
						}),
					);
				else if (failure === "malformed") socket.send("not JSON");
				else socket.close(1011, "dropped");
			});
			const result = await streamOpenAIResponses(fixture.model, fixture.context, {
				...fixture.options,
				preferWebsockets: true,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(fixture.requests).toHaveLength(1);
			expect(fixture.upgrades).toHaveLength(1);
			expect(fixture.httpRequests).toHaveLength(0);
			await fixture.waitForClosed(1);
		});
	}

	it("preserves already-visible deltas on interruption without resubmitting", async () => {
		const fixture = endpoint(socket => {
			send(socket, textEvents("PARTIAL", "resp_partial").slice(0, 4));
			socket.close(1011, "dropped after output");
		});
		const stream = streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
		});
		const deltas: string[] = [];
		for await (const event of stream) if (event.type === "text_delta") deltas.push(event.delta);
		const result = await stream.result();
		expect(deltas.join("")).toBe("PARTIAL");
		expect(result.stopReason).toBe("error");
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("closes sockets without provider session state instead of retaining an unreachable pool", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			providerSessionState: undefined,
		}).result();
		expect(result.stopReason).toBe("stop");
		await fixture.waitForClosed(1);
		expect(fixture.sockets.size).toBe(0);
	});

	it("releaseSession closes only that conversation and close cleans the remainder", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true };
		await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await streamOpenAIResponses(fixture.model, fixture.context, { ...options, sessionId: "other" }).result();
		for (const state of fixture.providerSessionState.values()) state.releaseSession?.("main");
		await fixture.waitForClosed(1);
		expect(fixture.sockets.size).toBe(1);
		await streamOpenAIResponses(fixture.model, fixture.context, { ...options, sessionId: "other" }).result();
		expect(fixture.upgrades).toHaveLength(2);
		for (const state of fixture.providerSessionState.values()) state.close();
		await fixture.waitForClosed(2);
		expect(fixture.sockets.size).toBe(0);
	});

	it("replaces an idle socket on credential change without reusing its authentication", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true };
		const first = await streamSimple(fixture.model, fixture.context, options).result();
		const context: Context = {
			messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
		};
		const second = await streamSimple(fixture.model, context, { ...options, apiKey: "replacement-key" }).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.upgrades[1]?.headers.get("authorization")).toBe("Bearer replacement-key");
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
	});
	it("does not retry a rejected upgrade or fall back to HTTP", async () => {
		let upgradeAttempts = 0;
		let postAttempts = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.headers.has("upgrade")) upgradeAttempts++;
				if (request.method === "POST") postAttempts++;
				return new Response("WebSocket unavailable", { status: 403 });
			},
		});
		resources.push(async () => {
			await server.stop(true);
		});
		const fixture = endpoint();
		const result = await streamOpenAIResponses(
			{
				...fixture.model,
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
			},
			fixture.context,
			{ ...fixture.options, preferWebsockets: true },
		).result();
		expect(result.stopReason).toBe("error");
		expect(upgradeAttempts).toBe(1);
		expect(postAttempts).toBe(0);
	});

	it("handles a signal aborted before the handshake without opening a socket", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			signal: AbortSignal.abort(),
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(fixture.upgrades).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("times out a stalled response without replay and closes its socket", async () => {
		const fixture = endpoint(() => {});
		// The fixture's 1 s first-event deadline: a shorter one can expire during the
		// WebSocket handshake on a loaded machine, which falls back to HTTP instead.
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
		await fixture.waitForClosed(1);
	});

	it("can close an active provider session and reconnect on its next request", async () => {
		const firstSeen = Promise.withResolvers<void>();
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) firstSeen.resolve();
			else send(socket, textEvents("AFTER CLOSE", "resp_after_close"));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const first = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await firstSeen.promise;
		for (const state of fixture.providerSessionState.values()) state.close();
		expect((await first).stopReason).toBe("error");
		await fixture.waitForClosed(1);
		const second = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
	});

	it("does not create a second WS generation for a successful empty completion", async () => {
		const fixture = endpoint(socket =>
			send(socket, [
				{
					type: "response.completed",
					response: { id: "empty", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } },
				},
			]),
		);
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([]);
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("keeps a no-state handshake fallback on SSE across the original empty-completion retry", async () => {
		let http = 0;
		const fixture = endpoint(undefined, {
			rejectUpgrade: () => new Response(null, { status: 426 }),
			httpResponse: () =>
				++http === 1
					? sse([
							{
								type: "response.completed",
								response: {
									id: "empty_http",
									status: "completed",
									output: [],
									usage: { input_tokens: 0, output_tokens: 0 },
								},
							},
						])
					: sse(textEvents("HTTP RETRIED", "retried")),
		});
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			providerSessionState: undefined,
			preferWebsockets: true,
			providerRetryWait: async () => {},
		}).result();
		expect(result.content).toMatchObject([{ type: "text", text: "HTTP RETRIED" }]);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(2);
	});

	it("does not share sticky SSE between independent calls without a logical sessionId", async () => {
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) socket.close(1011, "drop");
			else send(socket, textEvents("INDEPENDENT", "independent"));
		});
		const options = { ...fixture.options, sessionId: undefined, preferWebsockets: true };
		expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).stopReason).toBe("error");
		expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).content).toMatchObject([
			{ type: "text", text: "INDEPENDENT" },
		]);
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("keeps logical-session SSE fallback when cache retention is off and auth changes", async () => {
		const fixture = endpoint(socket => socket.close(1011, "drop"));
		const options: OpenAIResponsesOptions = {
			...fixture.options,
			cacheRetention: "none",
			preferWebsockets: true,
		};
		expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).stopReason).toBe("error");
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...options,
			apiKey: "new-test-key",
		}).result();
		expect(result.content).toMatchObject([{ type: "text", text: "HTTP" }]);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(1);
	});

	it("does not let a released lease mark a replacement session SSE-only", async () => {
		const arrived = Promise.withResolvers<void>();
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) arrived.resolve();
			else send(socket, textEvents("REPLACEMENT", `replacement_${index}`));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const old = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await arrived.promise;
		for (const state of fixture.providerSessionState.values()) state.releaseSession?.("main");
		const replacement = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect((await old).stopReason).toBe("error");
		expect((await replacement).stopReason).toBe("stop");
		expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests[2]?.connection).toBe(fixture.requests[1]?.connection);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("retries a strict-tools validation rejection on the same healthy leased connection", async () => {
		const fixture = endpoint((socket, body) => {
			const strict = (body.tools as Array<{ strict?: boolean }>)[0]?.strict;
			if (strict === true)
				send(socket, [
					{
						type: "error",
						status: 400,
						error: {
							type: "invalid_request_error",
							code: "invalid_function_parameters",
							param: "tools",
							message: "Invalid schema for function: strict tool parameters schema",
						},
					},
				]);
			else send(socket, textEvents("STRICT RECOVERED", "strict_recovered"));
		});
		const result = await streamOpenAIResponses(
			fixture.model,
			{
				...fixture.context,
				tools: [
					{
						name: "lookup",
						description: "Look up a value",
						strict: true,
						parameters: schemaType({ query: "string" }),
					},
				],
			},
			{ ...fixture.options, preferWebsockets: true },
		).result();
		expect(result.content).toMatchObject([{ type: "text", text: "STRICT RECOVERED" }]);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("negotiates a statusless explicit effort rejection before publishing the stream", async () => {
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1)
				send(socket, [
					{
						type: "error",
						error: {
							type: "invalid_request_error",
							code: "unsupported_value",
							param: "reasoning.effort",
							message: "reasoning.effort high is not supported. Supported values are: low, medium",
						},
					},
				]);
			else send(socket, textEvents("EFFORT RECOVERED", `effort_${index}`));
		});
		const options: OpenAIResponsesOptions = { ...fixture.options, preferWebsockets: true, reasoning: "high" };
		expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).content).toMatchObject([
			{ type: "text", text: "EFFORT RECOVERED" },
		]);
		expect(fixture.requests[0]?.body.reasoning).toMatchObject({ effort: "high" });
		expect(fixture.requests[1]?.body.reasoning).toMatchObject({ effort: "medium" });
		expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).stopReason).toBe("stop");
		expect(fixture.requests[2]?.body.reasoning).toMatchObject({ effort: "medium" });
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("does not re-handshake after parameter rejection loses its connection; the next call uses SSE", async () => {
		const fixture = endpoint(socket => {
			send(socket, [
				{
					type: "error",
					status: 400,
					error: {
						type: "invalid_request_error",
						message: "Invalid schema for function: strict tool parameters schema",
					},
				},
			]);
			socket.close(1011, "cannot retry this connection");
		});
		const context: Context = {
			...fixture.context,
			tools: [{ name: "lookup", description: "Look up", parameters: schemaType({ query: "string" }) }],
		};
		const options = { ...fixture.options, preferWebsockets: true };
		expect((await streamOpenAIResponses(fixture.model, context, options).result()).stopReason).toBe("error");
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
		expect((await streamOpenAIResponses(fixture.model, context, options).result()).content).toMatchObject([
			{ type: "text", text: "HTTP" },
		]);
		expect(fixture.httpRequests).toHaveLength(1);
	});

	it("does not mistake an in-band rate limit for strict validation or WS incompatibility", async () => {
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1)
				send(socket, [
					{
						type: "error",
						status: 429,
						error: {
							type: "invalid_request_error",
							code: "rate_limit_exceeded",
							message: "strict tools temporarily unavailable: rate limit",
						},
					},
				]);
			else send(socket, textEvents("RATE RECOVERED", "rate_recovered"));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const context: Context = {
			...fixture.context,
			tools: [{ name: "lookup", description: "Look up", parameters: schemaType({ query: "string" }) }],
		};
		const failure = await streamOpenAIResponses(fixture.model, context, options).result();
		expect(failure.stopReason).toBe("error");
		expect(failure.errorStatus).toBe(429);
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
		expect((await streamOpenAIResponses(fixture.model, context, options).result()).stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	for (const evidence of ["usage", "output"] as const) {
		it(`does not replay a first-frame stale rejection carrying generated ${evidence}`, async () => {
			const fixture = endpoint((socket, _body, index) => {
				if (index === 1) send(socket, textEvents("FIRST", "first_evidence"));
				else
					send(socket, [
						{
							type: "response.failed",
							response: {
								id: "generated_failure",
								status: "failed",
								error: {
									code: "previous_response_not_found",
									type: "invalid_request_error",
									message: "previous_response_id not found",
								},
								usage: { input_tokens: 0, output_tokens: evidence === "usage" ? 3 : 0 },
								output: evidence === "output" ? [{ type: "reasoning", id: "generated_item", summary: [] }] : [],
							},
						},
					]);
			});
			const options = { ...fixture.options, preferWebsockets: true };
			const first = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
			const failed = await streamOpenAIResponses(
				fixture.model,
				{
					messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
				},
				options,
			).result();
			expect(failed.stopReason).toBe("error");
			expect(fixture.requests).toHaveLength(2);
			expect(fixture.httpRequests).toHaveLength(0);
			if (evidence === "usage") expect(failed.usage.output).toBe(3);
		});
	}

	it("bounds a pending handshake by the shorter first-event timeout and sticks to SSE after a repeat", async () => {
		// Real Bun socket setup exercises the platform deadline; fake timers cannot drive the handshake.
		const pendingUpgrade = Promise.withResolvers<Response>();
		resources.push(async () => {
			pendingUpgrade.resolve(new Response("Late upgrade rejection", { status: 426 }));
		});
		const fixture = endpoint(undefined, { rejectUpgrade: () => pendingUpgrade.promise });
		const options = { ...fixture.options, preferWebsockets: true, streamFirstEventTimeoutMs: 100 };
		for (let call = 0; call < 3; call++) {
			expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).stopReason).toBe(
				"stop",
			);
		}
		// One timeout falls back for its own request only; the second consecutive one sticks.
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(3);
	}, 2_000);

	it("keeps WS after a single handshake timeout once a later exchange completes", async () => {
		const pending: Array<PromiseWithResolvers<Response>> = [];
		resources.push(async () => {
			for (const upgrade of pending) upgrade.resolve(new Response("Late upgrade rejection", { status: 426 }));
		});
		let upgradeIndex = 0;
		const fixture = endpoint((socket, _body, index) => send(socket, textEvents("WS", `resp_${index}`)), {
			rejectUpgrade: () => {
				upgradeIndex++;
				if (upgradeIndex !== 1 && upgradeIndex !== 3) return undefined;
				const upgrade = Promise.withResolvers<Response>();
				pending.push(upgrade);
				return upgrade.promise;
			},
		});
		const options = {
			...fixture.options,
			preferWebsockets: true,
			streamFirstEventTimeoutMs: 100,
			cacheRetention: "none" as const,
		};
		const texts: string[] = [];
		for (let call = 0; call < 4; call++) {
			const result = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
			expect(result.stopReason).toBe("stop");
			texts.push(result.content.map(block => (block.type === "text" ? block.text : "")).join(""));
		}
		// Timeout, WS success (resets the count), timeout, WS again: no sticky downgrade.
		expect(texts).toEqual(["HTTP", "WS", "HTTP", "WS"]);
		expect(fixture.upgrades).toHaveLength(4);
		expect(fixture.httpRequests).toHaveLength(2);
	}, 3_000);

	it("does not turn a malformed WS frame into an HTTP replay or sticky downgrade", async () => {
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) socket.send("{");
			else send(socket, textEvents("AFTER_PROTOCOL_ERROR", "after_protocol_error"));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const failed = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		const next = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(failed.stopReason).toBe("error");
		expect(next.content).toMatchObject([{ type: "text", text: "AFTER_PROTOCOL_ERROR" }]);
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("does not turn pre-exchange queue overflow into session-wide SSE downgrade", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true };
		const failed = await streamOpenAIResponses(fixture.model, fixture.context, {
			...options,
			onResponse: async () => {
				const socket = fixture.sockets.get(1)!;
				const frame = JSON.stringify({ type: "response.created", response: { id: "overflow" } });
				// Fill the actual 4096-frame channel before a reader owns the exchange.
				for (let index = 0; index <= 4096; index++) socket.send(frame);
				await fixture.waitForClosed(1);
			},
		}).result();
		const next = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(failed.stopReason).toBe("error");
		expect(next.content).toMatchObject([{ type: "text", text: "WS" }]);
		expect(failed.errorMessage).toContain("queue");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("keeps a concurrent lease's network downgrade after its temporary sibling completes", async () => {
		const firstSocket = Promise.withResolvers<ServerWebSocket<{ id: number }>>();
		const secondSocket = Promise.withResolvers<ServerWebSocket<{ id: number }>>();
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) firstSocket.resolve(socket);
			else if (index === 2) secondSocket.resolve(socket);
			else send(socket, textEvents("UNEXPECTED_WS", "unexpected_ws"));
		});
		const options: OpenAIResponsesOptions = {
			...fixture.options,
			preferWebsockets: true,
			cacheRetention: "none",
		};
		const first = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		const firstPeer = await firstSocket.promise;
		const second = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		const secondPeer = await secondSocket.promise;
		send(firstPeer, textEvents("COMPLETED_SIBLING", "completed_sibling"));
		expect((await first).stopReason).toBe("stop");
		await fixture.waitForClosed(1);
		secondPeer.terminate();
		expect((await second).stopReason).toBe("error");
		const next = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(next.content).toMatchObject([{ type: "text", text: "HTTP" }]);
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(1);
	});

	it("honors a compat statefulResponses:false opt-out for socket-local continuation", async () => {
		const fixture = endpoint();
		const model: Model<"openai-responses"> = {
			...fixture.model,
			compat: { ...fixture.model.compat, statefulResponses: false },
		};
		const options = { ...fixture.options, preferWebsockets: true };
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Next ${turn}`, timestamp: turn });
			const result = await streamSimple(model, context, options).result();
			expect(result.stopReason).toBe("stop");
			context.messages.push(result);
		}
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
		expect(fixture.upgrades).toHaveLength(1);
	});

	it("stops sending continuation anchors after three consecutive stale rejections", async () => {
		const fixture = endpoint((socket, body, index) => {
			if (body.previous_response_id !== undefined) {
				send(socket, [
					{ type: "error", error: { code: "previous_response_not_found", message: "Response expired" } },
				]);
				return;
			}
			send(socket, textEvents(`FULL ${index}`, `resp_${index}`));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const context: Context = { messages: [...fixture.context.messages] };
		for (const turn of [1, 2, 3, 4, 5]) {
			if (turn > 1) context.messages.push({ role: "user", content: `Next ${turn}`, timestamp: turn });
			const result = await streamSimple(fixture.model, context, options).result();
			expect(result.stopReason).toBe("stop");
			context.messages.push(result);
		}
		const anchored = fixture.requests.filter(request => request.body.previous_response_id !== undefined);
		expect(anchored).toHaveLength(3);
		// Turn 5 goes straight to full history; every anchored turn cost exactly one rejected frame.
		expect(fixture.requests).toHaveLength(8);
		expect(fixture.requests.at(-1)?.body.previous_response_id).toBeUndefined();
		expect(fixture.upgrades).toHaveLength(1);
	});
});
