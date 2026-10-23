import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ServerWebSocket } from "bun";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { type as schemaType } from "@oh-my-pi/omptype";
import {
	clearCopilotIntegrationCache,
	getCachedCopilotIntegrationId,
	getCopilotIntegrationCacheKey,
	rememberCopilotWorkingIntegrationId,
} from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import { COPILOT_CAPI_IDENTITY_HEADERS, COPILOT_CHAT_INTEGRATION_ID } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import {
	streamOpenAIResponses,
	openAIResponsesReplaysNativeHistory,
	type OpenAIResponsesOptions,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of resources.splice(0)) await dispose();
});

function textEvents(text: string, id: string): Record<string, unknown>[] {
	const item = {
		type: "message",
		id: `msg_${id}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text }],
	};
	return [
		{ type: "response.created", response: { id } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: { id, status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
		},
	];
}

function send(socket: ServerWebSocket<{ id: number }>, events: Record<string, unknown>[]): void {
	for (const event of events) socket.send(JSON.stringify(event));
}

function endpoint(
	behavior?: (socket: ServerWebSocket<{ id: number }>, body: Record<string, unknown>, index: number) => void,
	setup?: {
		provider?: "github-copilot";
		rejectUpgrade?: (request: Request) => Response | undefined;
		httpResponse?: (body: Record<string, unknown>) => Response | undefined;
	},
) {
	if (setup?.provider === "github-copilot") {
		const previous = Bun.env.COPILOT_INTEGRATION_ID;
		delete Bun.env.COPILOT_INTEGRATION_ID;
		resources.push(async () => {
			if (previous === undefined) delete Bun.env.COPILOT_INTEGRATION_ID;
			else Bun.env.COPILOT_INTEGRATION_ID = previous;
		});
	}
	const requests: Array<{ connection: number; body: Record<string, unknown> }> = [];
	const upgrades: Array<{ path: string; headers: Headers }> = [];
	const httpRequests: Array<Record<string, unknown>> = [];
	const sockets = new Map<number, ServerWebSocket<{ id: number }>>();
	const providerSessionState = new Map<string, ProviderSessionState>();
	const closeWaiters: Array<{ count: number; resolve: () => void }> = [];
	let opened = 0;
	let closed = 0;
	const server = Bun.serve<{ id: number }>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, server) {
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				upgrades.push({ path: new URL(request.url).pathname, headers: request.headers });
				const rejection = setup?.rejectUpgrade?.(request);
				if (rejection) return rejection;
				if (server.upgrade(request, { data: { id: ++opened } })) return undefined;
				return new Response("Upgrade failed", { status: 400 });
			}
			const body = (await request.json()) as Record<string, unknown>;
			httpRequests.push(body);
			const rejection = setup?.httpResponse?.(body);
			if (rejection) return rejection;
			return new Response(
				`${textEvents("HTTP", "resp_http")
					.map(event => `data: ${JSON.stringify(event)}\n\n`)
					.join("")}`,
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
		websocket: {
			open(socket) {
				sockets.set(socket.data.id, socket);
			},
			message(socket, message) {
				const body = JSON.parse(String(message)) as Record<string, unknown>;
				requests.push({ connection: socket.data.id, body });
				if (behavior) behavior(socket, body, requests.length);
				else send(socket, textEvents("WS", `resp_${requests.length}`));
			},
			close(socket) {
				sockets.delete(socket.data.id);
				closed++;
				for (const waiter of closeWaiters) if (closed >= waiter.count) waiter.resolve();
			},
		},
	});
	const model: Model<"openai-responses"> = {
		...((setup?.provider === "github-copilot"
			? getBundledModel("github-copilot", "gpt-5.4")
			: getBundledModel("openai", "gpt-5-mini")) as Model<"openai-responses">),
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
	};
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
	const options: OpenAIResponsesOptions = {
		apiKey: "test-key",
		sessionId: "main",
		providerSessionState,
		streamFirstEventTimeoutMs: 1000,
		streamIdleTimeoutMs: 1000,
	};
	resources.push(async () => {
		for (const state of providerSessionState.values()) state.close();
		await server.stop(true);
		if (setup?.provider === "github-copilot") {
			const cacheKey = getCopilotIntegrationCacheKey("test-key", model.baseUrl);
			if (cacheKey) clearCopilotIntegrationCache(cacheKey);
		}
	});
	return {
		model,
		context,
		options,
		requests,
		upgrades,
		httpRequests,
		sockets,
		providerSessionState,
		waitForClosed(count: number): Promise<void> {
			if (closed >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			closeWaiters.push({ count, resolve });
			return promise;
		},
	};
}

// These tests exercise the public provider stream against real Bun HTTP/WS endpoints.
describe("standard OpenAI Responses WebSocket opt-in", () => {
	for (const status of [400, 403]) {
		it(`negotiates a Copilot ${status} identity denial before generation and reuses the learned connection`, async () => {
			const cliId = COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"];
			let allowed: string = cliId;
			const fixture = endpoint(undefined, {
				provider: "github-copilot",
				rejectUpgrade: request =>
					request.headers.get("Copilot-Integration-Id") === allowed
						? undefined
						: Response.json({ error: { code: "model_not_supported" } }, { status }),
			});
			const options = { ...fixture.options, preferWebsockets: true };
			const key = getCopilotIntegrationCacheKey("test-key", fixture.model.baseUrl);
			for (const turn of [1, 2]) {
				const result = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toMatchObject([{ type: "text", text: "WS" }]);
				expect(fixture.requests).toHaveLength(turn);
				expect(fixture.upgrades).toHaveLength(2);
			}
			expect(getCachedCopilotIntegrationId(key)).toBe(cliId);
			expect(fixture.upgrades.map(upgrade => upgrade.headers.get("Copilot-Integration-Id"))).toEqual([
				COPILOT_CHAT_INTEGRATION_ID,
				cliId,
			]);
			for (const state of fixture.providerSessionState.values()) state.releaseSession?.("main");
			allowed = COPILOT_CHAT_INTEGRATION_ID;
			const afterPolicyChange = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
			expect(afterPolicyChange.stopReason).toBe("stop");
			expect(fixture.requests).toHaveLength(3);
			expect(fixture.upgrades.map(upgrade => upgrade.headers.get("Copilot-Integration-Id"))).toEqual([
				COPILOT_CHAT_INTEGRATION_ID,
				cliId,
				cliId,
				COPILOT_CHAT_INTEGRATION_ID,
			]);
			expect(getCachedCopilotIntegrationId(key)).toBe(COPILOT_CHAT_INTEGRATION_ID);
			expect(fixture.httpRequests).toHaveLength(0);
		});
	}

	for (const scenario of [
		{ name: "pinned identity", status: 403, code: "model_not_supported", pinned: true },
		{ name: "unrelated 400", status: 400, code: "invalid_parameter", pinned: false },
		{ name: "authentication failure", status: 401, code: "unauthorized", pinned: false },
		{ name: "server failure", status: 503, code: "unavailable", pinned: false },
	]) {
		it(`does not retry a Copilot upgrade on ${scenario.name}`, async () => {
			const fixture = endpoint(undefined, {
				provider: "github-copilot",
				rejectUpgrade: () => Response.json({ error: { code: scenario.code } }, { status: scenario.status }),
			});
			const result = await streamOpenAIResponses(fixture.model, fixture.context, {
				...fixture.options,
				preferWebsockets: true,
				headers: scenario.pinned ? { "Copilot-Integration-Id": COPILOT_CHAT_INTEGRATION_ID } : undefined,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(fixture.upgrades).toHaveLength(1);
			expect(fixture.requests).toHaveLength(0);
			expect(fixture.httpRequests).toHaveLength(0);
			expect(
				getCachedCopilotIntegrationId(getCopilotIntegrationCacheKey("test-key", fixture.model.baseUrl)),
			).toBeUndefined();
		});
	}

	it("stops after one rejected alternate Copilot upgrade and clears its stale cached identity", async () => {
		const fixture = endpoint(undefined, {
			provider: "github-copilot",
			rejectUpgrade: () => new Response("Denied", { status: 403 }),
		});
		const key = getCopilotIntegrationCacheKey("test-key", fixture.model.baseUrl);
		const cliId = COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"];
		rememberCopilotWorkingIntegrationId(key, cliId);
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fixture.upgrades.map(upgrade => upgrade.headers.get("Copilot-Integration-Id"))).toEqual([
			cliId,
			COPILOT_CHAT_INTEGRATION_ID,
		]);
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
		expect(getCachedCopilotIntegrationId(key)).toBeUndefined();
	});

	it("cancels an incomplete Copilot upgrade body without trying another identity", async () => {
		const received = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const fixture = endpoint(undefined, {
			provider: "github-copilot",
			rejectUpgrade: () => {
				received.resolve();
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"error":'));
						},
						cancel() {
							cancelled.resolve();
						},
					}),
					{ status: 400 },
				);
			},
		});
		const controller = new AbortController();
		const result = streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			signal: controller.signal,
		}).result();
		await received.promise;
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
		await cancelled.promise;
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("uses HTTP/SSE when unconfigured", async () => {
		const fixture = endpoint();
		const result = await streamOpenAIResponses(fixture.model, fixture.context, fixture.options).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "HTTP" }]);
		expect(fixture.httpRequests).toHaveLength(1);
		expect(fixture.upgrades).toHaveLength(0);
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

	it("honors model opt-in and lets explicit false force HTTP", async () => {
		const fixture = endpoint();
		const model = { ...fixture.model, preferWebsockets: true };
		expect((await streamOpenAIResponses(model, fixture.context, fixture.options).result()).stopReason).toBe("stop");
		expect(
			(await streamOpenAIResponses(model, fixture.context, { ...fixture.options, preferWebsockets: false }).result())
				.stopReason,
		).toBe("stop");
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.httpRequests).toHaveLength(1);
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

	it("reuses an idle session socket but replays full history even when statefulResponses is true", async () => {
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true, statefulResponses: true };
		const first = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		const second = await streamOpenAIResponses(
			fixture.model,
			{
				messages: [...fixture.context.messages, first, { role: "user", content: "Next", timestamp: 2 }],
			},
			options,
		).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.requests[1]?.connection).toBe(fixture.requests[0]?.connection);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toHaveLength(3);
	});

	it("continues a streamed tool call with its full call and result on the same socket", async () => {
		const fixture = endpoint((socket, _body, index) => {
			if (index !== 1) {
				send(socket, textEvents("Found", "resp_tool_result"));
				return;
			}
			const item = {
				type: "function_call",
				id: "fc_lookup",
				call_id: "call_lookup",
				name: "lookup",
				arguments: '{"query":"hello"}',
			};
			send(socket, [
				{ type: "response.created", response: { id: "resp_tool" } },
				{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: item.id,
					delta: item.arguments,
				},
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: { id: "resp_tool", status: "completed" } },
			]);
		});
		const options = { ...fixture.options, preferWebsockets: true, statefulResponses: true };
		const first = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(first.stopReason).toBe("toolUse");
		const toolCall = first.content.find(block => block.type === "toolCall");
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected streamed tool call");
		expect(toolCall.arguments).toEqual({ query: "hello" });
		const second = await streamOpenAIResponses(
			fixture.model,
			{
				messages: [
					...fixture.context.messages,
					first,
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: "lookup",
						content: [{ type: "text", text: "found" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			options,
		).result();
		expect(second.stopReason).toBe("stop");
		expect(fixture.upgrades).toHaveLength(1);
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(fixture.requests[1]?.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "function_call", call_id: "call_lookup" }),
				expect.objectContaining({ type: "function_call_output", call_id: "call_lookup", output: "found" }),
			]),
		);
	});

	it("reconnects a silent OPEN socket before submitting another generation", async () => {
		const actualNow = Date.now.bind(Date);
		let clockOffset = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => actualNow() + clockOffset);
		const OriginalWebSocket = globalThis.WebSocket;
		resources.push(async () => {
			clock.mockRestore();
			globalThis.WebSocket = OriginalWebSocket;
		});
		let silent = false;
		let connections = 0;
		let firstSocket: WebSocket | undefined;
		globalThis.WebSocket = new Proxy(OriginalWebSocket, {
			construct(target, args) {
				const socket: WebSocket = Reflect.construct(target, args);
				const first = ++connections === 1;
				if (first) firstSocket = socket;
				socket.send = new Proxy(socket.send, {
					apply(target, receiver, args) {
						// Model Bun's half-open state: writes succeed without a close event
						// but never reach the peer after idle eviction.
						if (first && silent) return;
						return Reflect.apply(target, receiver, args);
					},
				});
				return socket;
			},
		});
		const fixture = endpoint();
		const options = { ...fixture.options, preferWebsockets: true };
		expect((await streamOpenAIResponses(fixture.model, fixture.context, options).result()).stopReason).toBe("stop");
		clockOffset += 30_001;
		silent = true;
		expect(firstSocket?.readyState).toBe(OriginalWebSocket.OPEN);
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...options,
			streamFirstEventTimeoutMs: 250,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "WS" }));
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
	});

	it("reconnects after server close without sending a cross-connection response anchor", async () => {
		const fixture = endpoint((socket, _body, index) => {
			send(socket, textEvents("WS", `resp_${index}`));
			if (index === 1) socket.close(1000, "retire");
		});
		const clientClosed = Promise.withResolvers<void>();
		const OriginalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = new Proxy(OriginalWebSocket, {
			construct(target, args) {
				const socket: WebSocket = Reflect.construct(target, args);
				socket.addEventListener("close", () => clientClosed.resolve(), { once: true });
				return socket;
			},
		});
		resources.push(async () => {
			globalThis.WebSocket = OriginalWebSocket;
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

	it("rebuilds socket-owned computer history while preserving execution metadata and HTTP-native replay", async () => {
		const safetyChecks = [{ id: "must-ack", code: "confirm", message: "Confirm screenshot" }];
		const computerEvents = (id: string, callId: string) => {
			const item = {
				type: "computer_call",
				id,
				call_id: callId,
				status: "completed",
				actions: [{ type: "screenshot" }],
				pending_safety_checks: safetyChecks,
			};
			return [
				{ type: "response.created", response: { id: `resp_${id}` } },
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						id: `resp_${id}`,
						status: "completed",
						usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
					},
				},
			];
		};
		let httpTurns = 0;
		const foreignId = "cu_ws_owned";
		const denied = () =>
			Response.json({ error: { message: "input item does not belong to this connection" } }, { status: 401 });
		const fixture = endpoint(
			(socket, body, index) => {
				if (index > 1 && JSON.stringify(body.input).includes(foreignId)) {
					socket.send(
						JSON.stringify({
							type: "error",
							error: { code: "unauthorized", message: "input item does not belong to this connection" },
						}),
					);
				} else {
					send(
						socket,
						index === 1 ? computerEvents(foreignId, "call_ws") : textEvents("Continue", "resp_continue"),
					);
				}
			},
			{
				provider: "github-copilot",
				httpResponse: body => {
					if (JSON.stringify(body.input).includes(foreignId)) return denied();
					if (++httpTurns !== 1) return undefined;
					return new Response(
						computerEvents("cu_http_owned", "call_http")
							.map(event => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
						{
							headers: { "content-type": "text/event-stream" },
						},
					);
				},
			},
		);
		const model = { ...fixture.model, supportsComputerUse: true };
		let context: Context = {
			...fixture.context,
			tools: [
				{
					name: "computer",
					description: "Inspect the desktop",
					parameters: schemaType({}),
					native: { type: "computer" },
				},
			],
		};
		const options = {
			apiKey: fixture.options.apiKey,
			sessionId: fixture.options.sessionId,
			providerSessionState: fixture.providerSessionState,
			preferWebsockets: true,
		};
		const screenshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ncVkAAAAASUVORK5CYII=";
		const appendComputerResult = (turn: AssistantMessage) => {
			expect(turn.stopReason).toBe("toolUse");
			const call = turn.content.find(block => block.type === "toolCall");
			if (call?.type !== "toolCall" || call.providerMetadata?.type !== "computer")
				throw new Error("Missing native computer call");
			// Keep actions and safety checks for executing the current call, not just its history.
			expect(call.providerMetadata.actions).toEqual([{ type: "screenshot" }]);
			expect(call.providerMetadata.pendingSafetyChecks).toEqual(safetyChecks);
			context = {
				...context,
				messages: JSON.parse(
					JSON.stringify([
						...context.messages,
						turn,
						{
							role: "toolResult",
							toolName: "computer",
							toolCallId: call.id,
							timestamp: 2,
							providerMetadata: {
								type: "computer",
								screenshot: { type: "computer_screenshot", image_url: `data:image/png;base64,${screenshot}` },
								acknowledgedSafetyChecks: safetyChecks,
							},
							content: [{ type: "image", mimeType: "image/png", data: screenshot }],
						},
					]),
				) as Context["messages"],
			};
		};
		appendComputerResult(await streamSimple(model, context, options).result());
		const reconnected = await streamSimple(model, context, { ...options, apiKey: "replacement-key" }).result();
		expect(reconnected.stopReason).toBe("stop");
		const rebuilt = JSON.stringify(fixture.requests[1]?.body.input);
		expect(rebuilt).not.toContain(foreignId);
		expect(rebuilt).toContain("screenshot");
		expect(rebuilt).toContain("data:image/png;base64,");
		context = { ...context, messages: [...context.messages, reconnected] };
		appendComputerResult(await streamSimple(model, context, { ...options, preferWebsockets: false }).result());
		const http = await streamSimple(model, context, { ...options, preferWebsockets: false }).result();
		expect(http.stopReason).toBe("stop");
		expect(JSON.stringify(fixture.httpRequests[1]?.input)).not.toContain(foreignId);
		expect(JSON.stringify(fixture.httpRequests[1]?.input)).toContain("cu_http_owned");
	});

	it("rebuilds connection-bound history across reconnects and repeated HTTP turns", async () => {
		const fixture = endpoint(
			(socket, body, index) => {
				if (index > 1 && JSON.stringify(body.input).includes("rs_resp_1")) {
					socket.send(
						JSON.stringify({
							type: "error",
							error: { code: "unauthorized", message: "401 input item does not belong to this connection" },
						}),
					);
					return;
				}
				const events = textEvents(`TURN ${index}`, `resp_${index}`);
				const reasoning = {
					type: "reasoning",
					id: `rs_resp_${index}`,
					summary: [],
					encrypted_content: `ws-owned-${index}`,
				};
				events.splice(
					events.length - 1,
					0,
					{ type: "response.output_item.added", output_index: 1, item: reasoning },
					{ type: "response.output_item.done", output_index: 1, item: reasoning },
				);
				send(socket, events);
			},
			{
				provider: "github-copilot",
				httpResponse: body => {
					if (/rs_resp_|ws-owned-/.test(JSON.stringify(body.input))) {
						return Response.json(
							{ error: { message: "401 input item does not belong to this connection" } },
							{ status: 401 },
						);
					}
					const events = textEvents("HTTP", "resp_http");
					const reasoning = { type: "reasoning", id: "rs_http", summary: [], encrypted_content: "http-owned" };
					events.splice(
						events.length - 1,
						0,
						{ type: "response.output_item.added", output_index: 1, item: reasoning },
						{ type: "response.output_item.done", output_index: 1, item: reasoning },
					);
					return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
		);
		const model = fixture.model;
		const options = {
			apiKey: fixture.options.apiKey,
			sessionId: fixture.options.sessionId,
			providerSessionState: fixture.providerSessionState,
			preferWebsockets: true,
		};
		const first = await streamSimple(model, fixture.context, options).result();
		expect(first.stopReason).toBe("stop");
		const context: Context = {
			messages: [...fixture.context.messages, first, { role: "user", content: "Continue", timestamp: 2 }],
		};
		const second = await streamSimple(model, context, { ...options, apiKey: "replacement-key" }).result();
		expect(second.stopReason).toBe("stop");
		expect(second.content).toContainEqual(expect.objectContaining({ type: "text", text: "TURN 2" }));
		expect(JSON.stringify(fixture.requests[1]?.body.input)).not.toContain("rs_resp_1");
		expect(JSON.stringify(fixture.requests[1]?.body.input)).toContain("TURN 1");
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.httpRequests).toHaveLength(0);
		expect(openAIResponsesReplaysNativeHistory(model, fixture.providerSessionState, true)).toBe(false);
		expect(openAIResponsesReplaysNativeHistory(model, fixture.providerSessionState, false)).toBe(false);
		const httpContext: Context = {
			messages: [...context.messages, second, { role: "user", content: "Use HTTP", timestamp: 3 }],
		};
		const http = await streamSimple(model, httpContext, { ...options, preferWebsockets: false }).result();
		expect(http.stopReason).toBe("stop");
		expect(http.content).toContainEqual(expect.objectContaining({ type: "text", text: "HTTP" }));
		expect(JSON.stringify(fixture.httpRequests[0]?.input)).not.toContain("rs_resp_");
		expect(openAIResponsesReplaysNativeHistory(model, fixture.providerSessionState, false)).toBe(true);
		// Resume persisted history too: safety cannot depend on in-memory provenance.
		const resumed = JSON.parse(
			JSON.stringify({
				messages: [...httpContext.messages, http, { role: "user", content: "Continue HTTP", timestamp: 4 }],
			}),
		) as Context;
		const again = await streamSimple(model, resumed, { ...options, preferWebsockets: false }).result();
		expect(again.stopReason).toBe("stop");
		const replay = JSON.stringify(fixture.httpRequests[1]?.input);
		expect(replay).not.toContain("rs_resp_");
		expect(replay).not.toContain("ws-owned-");
		expect(replay).toContain("TURN 1");
		expect(replay).toContain("TURN 2");
		expect(replay).toContain("http-owned");
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
		expect(result.errorMessage).toContain("previous_response_id is not supported");
		expect(fixture.upgrades).toHaveLength(0);
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
		expect(fixture.upgrades).toHaveLength(0);
	});

	it("isolates concurrent same-session calls and does not close an in-flight socket", async () => {
		const firstSeen = Promise.withResolvers<void>();
		let firstSocket: ServerWebSocket<{ id: number }> | undefined;
		const fixture = endpoint((socket, _body, index) => {
			if (index === 1) {
				firstSocket = socket;
				firstSeen.resolve();
			} else send(socket, textEvents("SECOND", "resp_second"));
		});
		const options = { ...fixture.options, preferWebsockets: true };
		const first = streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await firstSeen.promise;
		const second = await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		expect(second.content).toMatchObject([{ type: "text", text: "SECOND" }]);
		if (!firstSocket) throw new Error("Expected first socket");
		send(firstSocket, textEvents("FIRST", "resp_first"));
		expect((await first).content).toMatchObject([{ type: "text", text: "FIRST" }]);
		expect(fixture.requests[0]?.connection).not.toBe(fixture.requests[1]?.connection);
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
		await streamOpenAIResponses(fixture.model, fixture.context, options).result();
		await streamOpenAIResponses(fixture.model, fixture.context, { ...options, apiKey: "replacement-key" }).result();
		expect(fixture.upgrades).toHaveLength(2);
		expect(fixture.upgrades[1]?.headers.get("authorization")).toBe("Bearer replacement-key");
		expect(fixture.requests[1]?.body.previous_response_id).toBeUndefined();
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
		const result = await streamOpenAIResponses(fixture.model, fixture.context, {
			...fixture.options,
			preferWebsockets: true,
			streamFirstEventTimeoutMs: 30,
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
});
