import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
import { type RequestHolds, type RequestHoldView, runOutsideRequestHolds, runWithRequestHolds } from "@oh-my-pi/pi-ai";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { __providerInFlightForTesting, stream } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, Model, ProviderSessionState, StreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AgentServerMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	GetBlobArgsSchema,
	InteractionUpdateSchema,
	KvServerMessageSchema,
	McpArgsSchema,
	McpToolCallSchema,
	RequestContextArgsSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	ToolRequestsListedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, encodeJsonValue, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { bedrockHappyPathFrames, bedrockTestModel } from "./helpers/bedrock-stream";

class Hold implements RequestHolds {
	readonly checked = Promise.withResolvers<void>();
	readonly released = Promise.withResolvers<void>();
	#held: boolean;
	constructor(held = true) {
		this.#held = held;
	}
	arm(): void {
		this.#held = true;
	}
	open(): RequestHoldView {
		return {
			check: () => {
				if (this.#held) this.checked.resolve();
				return this.#held ? this.released.promise : undefined;
			},
			release() {},
		};
	}
	let(): void {
		this.#held = false;
		this.released.resolve();
	}
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
const watchdogMs = 100;

function ollamaModel(baseUrl: string): Model<"ollama-chat"> {
	return buildModel({
		id: "test-model",
		name: "Test model",
		api: "ollama-chat",
		provider: "held-capacity-test",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 512,
	});
}

function ollamaReply(): Response {
	return new Response(
		`${JSON.stringify({ model: "test-model", message: { role: "assistant", content: "hi" }, done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 })}\n`,
		{ headers: { "content-type": "application/x-ndjson" } },
	);
}

/** Uses the platform clock for Bun's real HTTP abort behavior; fake timers do not advance socket I/O. */
async function exceedWatchdog(): Promise<void> {
	const elapsed = Promise.withResolvers<void>();
	const timer = setTimeout(elapsed.resolve, watchdogMs * 2);
	try {
		await elapsed.promise;
	} finally {
		clearTimeout(timer);
	}
}

interface WatchdogProvider {
	name: string;
	start(baseUrl: string, options: StreamOptions): Promise<AssistantMessage>;
	reply(): Response;
}

const providers: WatchdogProvider[] = [
	{
		name: "Bedrock",
		start: (baseUrl, options) =>
			streamBedrock(bedrockTestModel({ baseUrl }), context, {
				...options,
				apiKey: "held-test-bearer",
				region: "us-east-1",
			}).result(),
		reply: () =>
			new Response(new Blob(bedrockHappyPathFrames()), {
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			}),
	},
	{
		name: "Ollama",
		start: (baseUrl, options) => streamOllama(ollamaModel(baseUrl), context, { ...options, apiKey: "test" }).result(),
		reply: ollamaReply,
	},
	{
		name: "Bedrock through shared stream wrapper",
		start: (baseUrl, options) =>
			stream(bedrockTestModel({ baseUrl }), context, {
				...options,
				apiKey: "held-test-bearer",
				region: "us-east-1",
			}).result(),
		reply: () =>
			new Response(new Blob(bedrockHappyPathFrames()), {
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			}),
	},
	{
		name: "Ollama through shared stream wrapper",
		start: (baseUrl, options) => stream(ollamaModel(baseUrl), context, { ...options, apiKey: "test" }).result(),
		reply: ollamaReply,
	},
];

function cursorFrame(message: AgentServerMessage["message"]): Buffer {
	const bytes = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
	const framed = Buffer.alloc(bytes.length + 5);
	framed.writeUInt32BE(bytes.length, 1);
	framed.set(bytes, 5);
	return framed;
}

afterEach(() => vi.restoreAllMocks());

describe("request holds do not spend network capacity or time", () => {
	for (const holdScope of [false, true]) {
		it(`does not reopen a completed Cursor request's permit for a parked blob reply (hold scope: ${holdScope})`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parked-capacity-"));
			__providerInFlightForTesting.setRoot(root);
			const states = new Map<string, ProviderSessionState>();
			const sessions = new Set<http2.ServerHttp2Session>();
			const closed = Promise.withResolvers<void>();
			const blobReply = Promise.withResolvers<void>();
			const controller = new AbortController();
			let wire: http2.ServerHttp2Stream | undefined;
			const server = http2.createServer();
			server.on("session", session => {
				sessions.add(session);
				session.on("close", () => {
					sessions.delete(session);
					closed.resolve();
				});
			});
			server.on("stream", (request: http2.ServerHttp2Stream) => {
				wire = request;
				request.on("error", () => {});
				request.respond({ ":status": 200, "content-type": "application/connect+proto" });
				let buffered = Buffer.alloc(0);
				request.on("data", (chunk: Buffer) => {
					buffered = Buffer.concat([buffered, chunk]);
					while (buffered.length >= 5) {
						const size = buffered.readUInt32BE(1);
						if (buffered.length < size + 5) return;
						const message = fromBinary(AgentClientMessageSchema, buffered.subarray(5, size + 5));
						buffered = buffered.subarray(size + 5);
						if (message.message.case === "kvClientMessage") blobReply.resolve();
						if (message.message.case === "runRequest") {
							request.write(
								cursorFrame({
									case: "execServerMessage",
									value: create(ExecServerMessageSchema, {
										id: 1,
										execId: "exec-1",
										message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
									}),
								}),
							);
						}
						if (
							message.message.case !== "execClientMessage" ||
							message.message.value.message.case !== "requestContextResult"
						)
							continue;
						const args = create(McpArgsSchema, {
							name: "read",
							toolName: "read",
							toolCallId: "call-read",
							providerIdentifier: "pi-agent",
							args: { path: encodeJsonValue("calc.py") },
						});
						request.write(
							Buffer.concat([
								cursorFrame({
									case: "interactionUpdate",
									value: create(InteractionUpdateSchema, {
										message: {
											case: "toolCallStarted",
											value: create(ToolCallStartedUpdateSchema, {
												callId: "call-read",
												toolCall: create(ToolCallSchema, {
													tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args }) },
												}),
											}),
										},
									}),
								}),
								cursorFrame({
									case: "execServerMessage",
									value: create(ExecServerMessageSchema, {
										id: 2,
										execId: "exec-2",
										message: { case: "mcpArgs", value: args },
									}),
								}),
								cursorFrame({
									case: "interactionUpdate",
									value: create(InteractionUpdateSchema, {
										message: {
											case: "toolRequestsListed",
											value: create(ToolRequestsListedUpdateSchema, { callCount: 1 }),
										},
									}),
								}),
							]),
						);
					}
				});
			});
			const listening = Promise.withResolvers<void>();
			server.listen(0, "127.0.0.1", listening.resolve);
			await listening.promise;
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing HTTP/2 port");
			const model = buildModel({
				id: "composer-2.5",
				name: "Local Cursor",
				api: "cursor-agent",
				provider: "cursor",
				baseUrl: `http://127.0.0.1:${address.port}`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			});
			const leases = async () =>
				(await fs.readdir(__providerInFlightForTesting.providerDir("cursor"))).filter(
					name => !name.startsWith("."),
				);
			try {
				const start = () =>
					stream(
						model,
						{
							...context,
							tools: [
								{
									name: "read",
									description: "Read",
									parameters: { type: "object", properties: { path: { type: "string" } } },
								},
							],
						},
						{
							apiKey: "test",
							transport: "http2",
							externalToolExecutor: true,
							sessionId: "parked",
							providerSessionState: states,
							signal: controller.signal,
							maxInFlightRequests: { cursor: 1 },
						},
					).result();
				const first = await (holdScope ? runWithRequestHolds(new Hold(false), start) : start());
				expect(first.stopReason).toBe("toolUse");
				const before = await leases();
				wire!.write(
					cursorFrame({
						case: "kvServerMessage",
						value: create(KvServerMessageSchema, {
							id: 51,
							message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: new Uint8Array(32) }) },
						}),
					}),
				);
				await blobReply.promise;
				const during = await leases();
				for (const state of states.values()) state.close();
				await closed.promise;
				const after = await leases();
				expect({ before, during, after }).toEqual({ before: [], during: [], after: [] });
			} finally {
				controller.abort();
				for (const state of states.values()) state.close();
				for (const session of sessions) session.destroy();
				server.close();
				__providerInFlightForTesting.setRoot(undefined);
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}

	for (const retry of [false, true]) {
		it(
			retry
				? "releases a retry's slot while its next attempt is held"
				: "lets an exempt same-provider request release a held request at capacity one",
			async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-held-capacity-"));
				__providerInFlightForTesting.setRoot(root);
				const hold = new Hold(!retry);
				const controller = new AbortController();
				const order: string[] = [];
				const server = Bun.serve({
					port: 0,
					hostname: "127.0.0.1",
					fetch(request) {
						if (retry && order.length === 0) {
							order.push("first");
							hold.arm();
							return Response.json({ error: "retry me" }, { status: 429, headers: { "retry-after": "0" } });
						}
						order.push(request.headers.get("x-request") ?? "missing");
						return ollamaReply();
					},
				});
				let deadlineHit = false;
				const deadline = setTimeout(() => {
					deadlineHit = true;
					controller.abort(new Error("held request deadlocked"));
				}, 2000);
				try {
					const model = ollamaModel(server.url.href);
					const options = {
						apiKey: "test",
						maxInFlightRequests: { [model.provider]: 1 },
						signal: controller.signal,
					};
					const held = runWithRequestHolds(hold, () =>
						stream(model, context, { ...options, headers: { "x-request": "held" } }).result(),
					);
					await hold.checked.promise;
					const exempt = await runWithRequestHolds(hold, () =>
						runOutsideRequestHolds(hold, () =>
							stream(model, context, { ...options, headers: { "x-request": "exempt" } }).result(),
						),
					);
					hold.let();
					const result = await held;
					expect(deadlineHit).toBe(false);
					expect(exempt.stopReason).toBe("stop");
					expect(result.stopReason).toBe("stop");
					expect(order).toEqual(retry ? ["first", "exempt", "held"] : ["exempt", "held"]);
				} finally {
					clearTimeout(deadline);
					controller.abort();
					hold.let();
					server.stop(true);
					__providerInFlightForTesting.setRoot(undefined);
					await fs.rm(root, { recursive: true, force: true });
				}
			},
		);
	}

	for (const provider of providers) {
		it(`${provider.name} sends once after a hold outlasts its first-event budget`, async () => {
			const hold = new Hold();
			let sends = 0;
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch() {
					sends++;
					return provider.reply();
				},
			});
			try {
				const result = runWithRequestHolds(hold, () =>
					provider.start(server.url.href, { streamFirstEventTimeoutMs: watchdogMs }),
				);
				await hold.checked.promise;
				await exceedWatchdog();
				expect(sends).toBe(0);
				hold.let();
				const message = await result;
				expect(message.errorMessage).toBeUndefined();
				expect(message.stopReason).toBe("stop");
				expect(sends).toBe(1);
			} finally {
				hold.let();
				server.stop(true);
			}
		});

		it(`${provider.name} still times out a real server after release without response headers`, async () => {
			const hold = new Hold();
			const received = Promise.withResolvers<void>();
			const reply = Promise.withResolvers<Response>();
			let sends = 0;
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch() {
					sends++;
					received.resolve();
					return reply.promise;
				},
			});
			try {
				const result = runWithRequestHolds(hold, () =>
					provider.start(server.url.href, { streamFirstEventTimeoutMs: watchdogMs }),
				);
				await hold.checked.promise;
				await exceedWatchdog();
				hold.let();
				const message = await result;
				expect(sends).toBe(1);
				await received.promise;
				expect(message.stopReason).toBe("error");
				expect(message.errorMessage).toMatch(/timed out|timeout/i);
			} finally {
				hold.let();
				reply.resolve(provider.reply());
				server.stop(true);
			}
		});

		it(`${provider.name} preserves caller cancellation during an over-budget hold without sending`, async () => {
			const hold = new Hold();
			const controller = new AbortController();
			let sends = 0;
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch() {
					sends++;
					return provider.reply();
				},
			});
			try {
				const result = runWithRequestHolds(hold, () =>
					provider.start(server.url.href, { signal: controller.signal, streamFirstEventTimeoutMs: watchdogMs }),
				);
				await hold.checked.promise;
				await exceedWatchdog();
				controller.abort(new Error("caller cancelled held request"));
				const message = await result;
				expect(message.stopReason).toBe("aborted");
				expect(message.errorMessage).not.toMatch(/timed out|timeout/i);
				expect(sends).toBe(0);
			} finally {
				controller.abort();
				hold.let();
				server.stop(true);
			}
		});
	}
});
