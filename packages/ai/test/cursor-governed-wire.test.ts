import { describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	CONNECT_END_STREAM_FLAG,
	ConnectFrameDecoder,
	frameConnectMessage,
} from "@oh-my-pi/pi-ai/providers/connect-frame";
import { type CursorOptions, streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentServerMessageSchema,
	AzureCredentialsSchema,
	BidiAppendRequestSchema,
	BidiRequestIdSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	InteractionUpdateSchema,
	RequestedModel_ModelParameterbytesSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

type Transport = "http2" | "http1";
type Reply = "success" | "unavailable" | "checkpoint" | "not_found";
interface CapturedRequest {
	request: AgentRunRequest;
	bytes: Uint8Array;
}
interface Fixture {
	baseUrl: string;
	requests: CapturedRequest[];
	close(): Promise<void>;
}
interface StreamChannel {
	promise: Promise<ReadableStreamDefaultController<Uint8Array>>;
	resolve(controller: ReadableStreamDefaultController<Uint8Array>): void;
}
const context: Context = { messages: [{ role: "user", content: "emit an answer", timestamp: 1 }] };

function modelFor(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		requestModelId: "gpt-5.6-sol-none",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Medium, Effort.High],
			effortRouting: { off: "gpt-5.6-sol-none", medium: "gpt-5.6-sol-medium", high: "gpt-5.6-sol-high" },
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

function interactionFrames(text: string, terminal: boolean): Uint8Array[] {
	const frames = [
		frameConnectMessage(
			toBinary(
				AgentServerMessageSchema,
				create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
						}),
					},
				}),
			),
		),
	];
	if (terminal)
		frames.push(
			frameConnectMessage(
				toBinary(
					AgentServerMessageSchema,
					create(AgentServerMessageSchema, {
						message: {
							case: "interactionUpdate",
							value: create(InteractionUpdateSchema, {
								message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
							}),
						},
					}),
				),
			),
		);
	return frames;
}

function replyFrames(reply: Reply): Uint8Array[] {
	if (reply === "success") return interactionFrames("wire admitted", true);
	if (reply === "checkpoint") {
		return [
			...interactionFrames("before", false),
			frameConnectMessage(
				toBinary(
					AgentServerMessageSchema,
					create(AgentServerMessageSchema, {
						message: {
							case: "conversationCheckpointUpdate",
							value: create(ConversationStateStructureSchema, {
								rootPromptMessagesJson: [Uint8Array.of(0xc0, 0xff, 1)],
								turns: [Uint8Array.of(0xc0, 0xff, 2)],
								tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 42 }),
							}),
						},
					}),
				),
			),
		];
	}
	return [
		frameConnectMessage(
			new TextEncoder().encode(JSON.stringify({ error: { code: reply, message: "route unavailable" } })),
			CONNECT_END_STREAM_FLAG,
		),
	];
}

function capture(bytes: Uint8Array, requests: CapturedRequest[]): boolean {
	const message = fromBinary(AgentClientMessageSchema, bytes);
	if (message.message.case !== "runRequest") return false;
	requests.push({ request: message.message.value, bytes: bytes.slice() });
	return true;
}

async function startFixture(transport: Transport, replies: Reply[] = ["success"]): Promise<Fixture> {
	const requests: CapturedRequest[] = [];
	if (transport === "http1") {
		const channels = new Map<string, StreamChannel>();
		const channelFor = (id: string): StreamChannel => {
			const existing = channels.get(id);
			if (existing) return existing;
			const channel = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
			channels.set(id, channel);
			return channel;
		};
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const bytes = new Uint8Array(await request.arrayBuffer());
				const path = new URL(request.url).pathname;
				if (path === "/agent.v1.AgentService/RunSSE") {
					const frame = [...new ConnectFrameDecoder().decode(bytes)][0];
					if (!frame) throw new Error("expected RunSSE channel frame");
					const id = fromBinary(BidiRequestIdSchema, frame.payload).requestId;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								channelFor(id).resolve(controller);
							},
							cancel() {
								channels.delete(id);
							},
						}),
						{ headers: { "content-type": "application/connect+proto" } },
					);
				}
				if (path === "/aiserver.v1.BidiService/BidiAppend") {
					const append = fromBinary(BidiAppendRequestSchema, bytes);
					if (capture(append.dataBinary, requests)) {
						const controller = await channelFor(append.requestId?.requestId ?? "").promise;
						for (const frame of replyFrames(replies[requests.length - 1] ?? "success")) controller.enqueue(frame);
						controller.close();
					}
					return new Response(null, { headers: { "content-type": "application/proto" } });
				}
				return new Response(null, { status: 404 });
			},
		});
		return {
			baseUrl: server.url.toString(),
			requests,
			async close() {
				server.stop(true);
			},
		};
	}
	const sessions = new Set<http2.Http2Session>();
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		const decoder = new ConnectFrameDecoder();
		let handled = false;
		stream.on("data", (chunk: Buffer) => {
			if (handled) return;
			for (const frame of decoder.decode(chunk)) {
				if (!capture(frame.payload, requests)) continue;
				handled = true;
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				for (const response of replyFrames(replies[requests.length - 1] ?? "success")) stream.write(response);
				stream.end();
				break;
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		async close() {
			for (const session of sessions) session.destroy();
			const closing = Promise.withResolvers<void>();
			server.close(error => (error ? closing.reject(error) : closing.resolve()));
			await closing.promise;
		},
	};
}

function requireRequested(request: AgentRunRequest) {
	if (!request.requestedModel) throw new Error("expected generated requestedModel");
	return request.requestedModel;
}
function requireDetails(request: AgentRunRequest) {
	if (!request.modelDetails) throw new Error("expected generated modelDetails");
	return request.modelDetails;
}

describe("governed Cursor encoded selections", () => {
	const changes: Array<[string, (request: AgentRunRequest) => void]> = [
		[
			"legacy identity",
			request => {
				requireDetails(request).modelId = "unapproved-model";
			},
		],
		[
			"rich identity",
			request => {
				requireRequested(request).modelId = "unapproved-model";
			},
		],
		[
			"reasoning parameter",
			request => {
				requireRequested(request).parameters[0]!.value = "low";
			},
		],
		[
			"requested maxMode",
			request => {
				requireRequested(request).maxMode = true;
			},
		],
		[
			"legacy maxMode",
			request => {
				requireDetails(request).maxMode = true;
			},
		],
		[
			"unknown route parameter",
			request => {
				requireRequested(request).parameters.push(
					create(RequestedModel_ModelParameterbytesSchema, { id: "unrecognized-routing-control", value: "other" }),
				);
			},
		],
		[
			"model alternatives",
			request => {
				requireDetails(request).aliases.push("unapproved-model");
			},
		],
		[
			"Azure deployment route",
			request => {
				requireRequested(request).credentials = {
					case: "azureCredentials",
					value: create(AzureCredentialsSchema, {
						apiKey: "other-key",
						baseUrl: "https://other.openai.azure.com",
						deployment: "other-deployment",
					}),
				};
			},
		],
	];
	for (const [name, change] of changes) {
		it(`rejects altered ${name} before an HTTP/2 inference frame`, async () => {
			const fixture = await startFixture("http2");
			try {
				const result = await streamCursor(modelFor(fixture.baseUrl), context, {
					apiKey: "token",
					wireModelId: "gpt-5.6-sol-medium",
					transport: "http2",
					preserveModelSelection: true,
					preserveThinkingEffort: true,
					onPayload: payload => {
						// The provider hook receives its generated protobuf message.
						const request = payload as AgentRunRequest;
						change(request);
					},
				}).result();
				expect(fixture.requests).toHaveLength(0);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			} finally {
				await fixture.close();
			}
		});
	}

	it("rejects protobuf unknown-field model overrides without removing the fields", async () => {
		const fixture = await startFixture("http2");
		const foreign = new TextEncoder().encode("unapproved-model");
		const inject = (payload: unknown) => {
			// The provider hook receives its generated protobuf message.
			const request = payload as AgentRunRequest;
			requireRequested(request).$unknown = [{ no: 1, wireType: 2, data: Uint8Array.of(foreign.length, ...foreign) }];
		};
		try {
			const ordinary = await streamCursor(modelFor(fixture.baseUrl), context, {
				apiKey: "token",
				wireModelId: "gpt-5.6-sol-medium",
				transport: "http2",
				onPayload: inject,
			}).result();
			expect(ordinary.stopReason).toBe("stop");
			expect(fixture.requests[0]?.request.requestedModel?.modelId).toBe("unapproved-model");
			const governed = await streamCursor(modelFor(fixture.baseUrl), context, {
				apiKey: "token",
				wireModelId: "gpt-5.6-sol-medium",
				transport: "http2",
				onPayload: inject,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
			}).result();
			expect(fixture.requests).toHaveLength(1);
			expect(AIError.is(governed.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it("does not evaluate hook-owned message getters, Proxy traps, or native-byte overrides", async () => {
		const fixture = await startFixture("http2");
		let accesses = 0;
		const hooks: NonNullable<CursorOptions["onPayload"]>[] = [
			payload => {
				if (!payload || typeof payload !== "object") throw new Error("expected protobuf request");
				Object.defineProperty(payload, "requestedModel", {
					enumerable: true,
					get() {
						accesses++;
						return {};
					},
				});
			},
			payload => {
				if (!payload || typeof payload !== "object") throw new Error("expected protobuf request");
				return new Proxy(payload, {
					get(target, key, receiver) {
						accesses++;
						return Reflect.get(target, key, receiver);
					},
				});
			},
			payload => {
				if (!payload || typeof payload !== "object") throw new Error("expected protobuf request");
				// oxlint-disable-next-line unicorn/no-thenable -- Adversarial hook; this getter must never be read.
				Object.defineProperty(payload, "then", {
					get() {
						accesses++;
						return undefined;
					},
				});
				return payload;
			},
			payload => {
				// The provider hook receives its generated protobuf message.
				const request = payload as AgentRunRequest;
				if (!request.conversationState) throw new Error("expected conversation state");
				const bytes = Uint8Array.of(1, 2, 3);
				Object.defineProperty(bytes, "byteLength", {
					get() {
						accesses++;
						return 3;
					},
				});
				request.conversationState.rootPromptMessagesJson = [bytes];
			},
		];
		try {
			for (const onPayload of hooks) {
				const result = await streamCursor(modelFor(fixture.baseUrl), context, {
					apiKey: "token",
					wireModelId: "gpt-5.6-sol-medium",
					transport: "http2",
					onPayload,
					preserveModelSelection: true,
					preserveThinkingEffort: true,
				}).result();
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			}
			expect(accesses).toBe(0);
			expect(fixture.requests).toHaveLength(0);
		} finally {
			await fixture.close();
		}
	});

	it("allows reasoning parameter edits when only the model is pinned", async () => {
		const fixture = await startFixture("http2");
		try {
			const result = await streamCursor(modelFor(fixture.baseUrl), context, {
				apiKey: "token",
				wireModelId: "gpt-5.6-sol-medium",
				transport: "http2",
				preserveModelSelection: true,
				onPayload: payload => {
					// The provider hook receives its generated protobuf message.
					const request = payload as AgentRunRequest;
					requireRequested(request).parameters[0]!.value = "low";
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(fixture.requests[0]?.request.modelDetails?.modelId).toBe("gpt-5.6-sol-medium");
			expect(fixture.requests[0]?.request.requestedModel?.parameters).toEqual([
				expect.objectContaining({ id: "reasoning", value: "low" }),
			]);
		} finally {
			await fixture.close();
		}
	});
});

for (const transport of ["http2", "http1"] as const) {
	describe(`Cursor ${transport} inference attempts`, () => {
		it("admits the normalized pair and resends identical bytes without rerunning a mutable hook", async () => {
			const fixture = await startFixture(transport, ["unavailable", "success"]);
			let hooks = 0;
			let admissions = 0;
			try {
				const result = await streamCursor(modelFor(fixture.baseUrl), context, {
					apiKey: "token",
					wireModelId: "gpt-5.6-sol-medium",
					transport,
					preserveModelSelection: true,
					preserveThinkingEffort: true,
					providerRetryWait: async () => {},
					onBeforeRequest: () => {
						admissions++;
					},
					onPayload: async payload => {
						hooks++;
						// The provider hook receives its generated protobuf message.
						const request = payload as AgentRunRequest;
						request.customSystemPrompt = "harmless edit";
						return request;
					},
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "wire admitted" })]);
				expect(fixture.requests).toHaveLength(2);
				expect(fixture.requests[0]?.bytes).toEqual(fixture.requests[1]?.bytes);
				expect(fixture.requests[1]?.request.modelDetails?.modelId).toBe("gpt-5.6-sol-medium");
				expect(fixture.requests[1]?.request.requestedModel?.modelId).toBe("gpt-5.6-sol");
				expect(fixture.requests[1]?.request.requestedModel?.parameters).toEqual([
					expect.objectContaining({ id: "reasoning", value: "medium" }),
				]);
				expect(hooks).toBe(1);
				expect(admissions).toBe(2);
			} finally {
				await fixture.close();
			}
		});

		it("rechecks original authority after retry even when the hook erases caller options", async () => {
			const fixture = await startFixture(transport, ["unavailable", "success"]);
			let hooks = 0;
			let admissions = 0;
			const options: CursorOptions = {
				apiKey: "token",
				wireModelId: "gpt-5.6-sol-medium",
				transport,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				providerRetryWait: async () => {},
				onBeforeRequest: () => {
					if (++admissions > 1) throw new Error("authority revoked during retry");
				},
				onPayload: () => {
					hooks++;
					options.onBeforeRequest = () => {};
					options.preserveModelSelection = false;
					options.preserveThinkingEffort = false;
				},
			};
			try {
				const result = await streamCursor(modelFor(fixture.baseUrl), context, options).result();
				expect(fixture.requests).toHaveLength(1);
				expect(hooks).toBe(1);
				expect(admissions).toBe(2);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			} finally {
				await fixture.close();
			}
		});

		it("does not emit the first inference frame after a denied admission", async () => {
			const fixture = await startFixture(transport);
			let admissions = 0;
			try {
				const result = await streamCursor(modelFor(fixture.baseUrl), context, {
					apiKey: "token",
					wireModelId: "gpt-5.6-sol-medium",
					transport,
					preserveModelSelection: true,
					preserveThinkingEffort: true,
					onBeforeRequest: () => {
						admissions++;
						throw new Error("grant no longer exists");
					},
				}).result();
				expect(fixture.requests).toHaveLength(0);
				expect(admissions).toBe(1);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			} finally {
				await fixture.close();
			}
		});
	});
}

it("keeps the original governed selection baseline across a new checkpoint payload", async () => {
	const fixture = await startFixture("http2", ["checkpoint", "success"]);
	const model = modelFor(fixture.baseUrl);
	let hooks = 0;
	let admissions = 0;
	const options: CursorOptions = {
		apiKey: "token",
		wireModelId: "gpt-5.6-sol-medium",
		transport: "http2",
		preserveModelSelection: true,
		preserveThinkingEffort: true,
		providerRetryWait: async () => {},
		onBeforeRequest: () => {
			admissions++;
		},
		onPayload: () => {
			if (++hooks === 1) options.wireModelId = "gpt-5.6-sol-high";
		},
	};
	try {
		const result = await streamCursor(model, context, options).result();
		expect(fixture.requests).toHaveLength(1);
		expect(hooks).toBe(2);
		expect(admissions).toBe(1);
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
	} finally {
		await fixture.close();
	}
});

it("does not try the discovered model fallback for a fixed-effort request", async () => {
	const fixture = await startFixture("http2", ["not_found", "success"]);
	try {
		const result = await streamCursor(modelFor(fixture.baseUrl), context, {
			apiKey: "token",
			wireModelId: "gpt-5.6-sol-medium",
			transport: "http2",
			preserveThinkingEffort: true,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fixture.requests).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

it("admits native Cursor off and high wire routes without substituting their identities", async () => {
	const fixture = await startFixture("http2", ["success", "success"]);
	try {
		for (const wireModelId of ["gpt-5.6-sol-none", "gpt-5.6-sol-high"]) {
			const result = await streamCursor(modelFor(fixture.baseUrl), context, {
				apiKey: "token",
				wireModelId,
				transport: "http2",
				preserveModelSelection: true,
				preserveThinkingEffort: true,
			}).result();
			expect(result.stopReason).toBe("stop");
		}
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.requests[0]?.request.modelDetails?.modelId).toBe("gpt-5.6-sol-none");
		expect(fixture.requests[0]?.request.requestedModel?.parameters).toEqual([]);
		expect(fixture.requests[1]?.request.modelDetails?.modelId).toBe("gpt-5.6-sol-high");
		expect(fixture.requests[1]?.request.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "high" }),
		]);
	} finally {
		await fixture.close();
	}
});

for (const transport of ["http2", "http1"] as const) {
	it(`preserves a true caller abort from ${transport} admission without retry or inference`, async () => {
		const fixture = await startFixture(transport);
		let admissions = 0;
		try {
			const result = await streamCursor(modelFor(fixture.baseUrl), context, {
				apiKey: "token",
				wireModelId: "gpt-5.6-sol-medium",
				transport,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				onBeforeRequest: () => {
					admissions++;
					throw new AIError.AbortError("caller stopped");
				},
			}).result();
			expect(fixture.requests).toHaveLength(0);
			expect(admissions).toBe(1);
			expect(result.stopReason).toBe("aborted");
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(false);
			expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it(`does not treat a named ${transport} admission error as caller cancellation`, async () => {
		const fixture = await startFixture(transport);
		let admissions = 0;
		try {
			const result = await streamCursor(modelFor(fixture.baseUrl), context, {
				apiKey: "token",
				wireModelId: "gpt-5.6-sol-medium",
				transport,
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				onBeforeRequest: () => {
					admissions++;
					const error = new Error("caller stopped");
					error.name = "AbortError";
					throw error;
				},
			}).result();
			expect(fixture.requests).toHaveLength(0);
			expect(admissions).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(false);
		} finally {
			await fixture.close();
		}
	});
}

it("does not execute inherited JSON serializers while comparing the encoded protobuf selection", async () => {
	const fixture = await startFixture("http2");
	const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
	let serializers = 0;
	try {
		const result = await streamCursor(modelFor(fixture.baseUrl), context, {
			apiKey: "token",
			wireModelId: "gpt-5.6-sol-medium",
			transport: "http2",
			preserveModelSelection: true,
			preserveThinkingEffort: true,
			onPayload: payload => {
				// The provider hook receives its generated protobuf message.
				const request = payload as AgentRunRequest;
				requireRequested(request).modelId = "unapproved-model";
				Object.defineProperty(Object.prototype, "toJSON", {
					configurable: true,
					value() {
						serializers++;
						return {};
					},
				});
			},
		}).result();
		expect(fixture.requests).toHaveLength(0);
		expect(serializers).toBe(0);
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
	} finally {
		if (original) Object.defineProperty(Object.prototype, "toJSON", original);
		else Reflect.deleteProperty(Object.prototype, "toJSON");
		await fixture.close();
	}
});
