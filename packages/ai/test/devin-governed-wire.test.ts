import { afterEach, describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AssignModelResponseSchema,
	ModelAssignmentSchema,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
	StopReason,
	type GetChatMessageRequest,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import * as AIError from "../src/error";
import { CONNECT_COMPRESSED_FLAG, CONNECT_END_STREAM_FLAG, frameConnectMessage } from "../src/providers/connect-frame";
import { streamDevin, type DevinOptions } from "../src/providers/devin";
import { Effort, type AssistantMessage, type Model } from "../src/types";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
	for (const server of servers) server.stop(true);
	servers.length = 0;
});

function wire() {
	const state = {
		authRequests: 0,
		assignmentRequests: 0,
		inference: [] as GetChatMessageRequest[],
		afterAuth: undefined as (() => void) | undefined,
		actualModelUid: "MODEL_PINNED_HIGH",
	};
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (new URL(request.url).pathname.endsWith("/GetUserJwt")) {
				state.authRequests++;
				state.afterAuth?.();
				return new Response(
					toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "loopback-native-jwt" })),
					{ headers: { "Content-Type": "application/proto" } },
				);
			}
			if (new URL(request.url).pathname.endsWith("/AssignModel")) {
				state.assignmentRequests++;
				return new Response(
					toBinary(
						AssignModelResponseSchema,
						create(AssignModelResponseSchema, {
							assignment: create(ModelAssignmentSchema, {
								modelUid: "MODEL_PINNED_HIGH",
								assignmentJwt: "loopback-assignment",
							}),
						}),
					),
					{ headers: { "Content-Type": "application/proto" } },
				);
			}
			const framed = new Uint8Array(await request.arrayBuffer());
			const size = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(1);
			const encoded = framed.subarray(5, 5 + size);
			const payload = framed[0]! & CONNECT_COMPRESSED_FLAG ? gunzipSync(encoded) : encoded;
			state.inference.push(fromBinary(GetChatMessageRequestSchema, payload));
			const response = toBinary(
				GetChatMessageResponseSchema,
				create(GetChatMessageResponseSchema, {
					messageId: "native-message",
					deltaText: "ok",
					actualModelUid: state.actualModelUid,
					stopReason: StopReason.STOP_PATTERN,
				}),
			);
			return new Response(
				Buffer.concat([
					frameConnectMessage(response),
					frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG),
				]),
				{ headers: { "Content-Type": "application/connect+proto" } },
			);
		},
	});
	servers.push(server);
	const model = buildModel({
		provider: "devin",
		id: "pinned",
		requestModelId: "MODEL_PINNED",
		name: "Pinned native UID",
		api: "devin-agent",
		baseUrl: server.url.toString(),
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.High],
			effortRouting: { high: "MODEL_PINNED_HIGH", off: "MODEL_PINNED_OFF" },
		},
		compat: { modelRouter: false },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	});
	return { model, state };
}

function request(model: Model<"devin-agent">, options: DevinOptions = {}) {
	return streamDevin(
		model,
		{ messages: [{ role: "user", content: "Say ok", timestamp: 1 }] },
		{
			apiKey: "loopback-only-key",
			preserveModelSelection: true,
			preserveThinkingEffort: true,
			reasoning: Effort.High,
			chatModelUid: "MODEL_PINNED_HIGH",
			...options,
		},
	).result();
}

function expectAdmission(message: AssistantMessage): void {
	expect(message.stopReason).toBe("error");
	expect(AIError.is(AIError.classifyMessage(message), AIError.Flag.HostAdmission)).toBe(true);
	expect(AIError.retriable(message.errorId!)).toBe(false);
}

describe("governed Devin native protobuf inference", () => {
	it("serves the admitted native effort UID with harmless prompt edits", async () => {
		const f = wire();
		let admissions = 0;
		const result = await request(f.model, {
			onBeforeRequest: () => {
				admissions++;
			},
			onPayload: async payload => {
				const nativeRequest = payload as GetChatMessageRequest;
				nativeRequest.prompt = "Harmless instructions";
				return nativeRequest;
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(
			result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join(" "),
		).toBe("ok");
		expect(f.state.inference).toHaveLength(1);
		expect(f.state.inference[0]).toMatchObject({
			chatModelUid: "MODEL_PINNED_HIGH",
			prompt: "Harmless instructions",
		});
		expect(admissions).toBe(1);
	});

	it("rejects synchronous Proxy and then-getter hook results without evaluating them", async () => {
		const f = wire();
		let reads = 0;
		const hooks: NonNullable<DevinOptions["onPayload"]>[] = [
			payload => {
				if (!payload || typeof payload !== "object") throw new Error("expected generated native request");
				return new Proxy(payload, {
					get(target, key, receiver) {
						reads++;
						return Reflect.get(target, key, receiver);
					},
				});
			},
			payload => {
				if (!payload || typeof payload !== "object") throw new Error("expected generated native request");
				// oxlint-disable-next-line unicorn/no-thenable -- Adversarial hook; this getter must never be read.
				Object.defineProperty(payload, "then", {
					get() {
						reads++;
						return undefined;
					},
				});
				return payload;
			},
		];
		for (const onPayload of hooks) {
			const result = await request(f.model, { onPayload });
			expectAdmission(result);
		}
		expect(reads).toBe(0);
		expect(f.state.inference).toHaveLength(0);
	});

	it("blocks changed encoded native model credentials or UID before inference", async () => {
		for (const field of ["chatModelUid", "modelAssignmentJwt", "metadata"] as const) {
			const f = wire();
			const result = await request(f.model, {
				onPayload: payload => {
					const value = payload as GetChatMessageRequest;
					if (field === "metadata") value.metadata!.apiKey = "other-account";
					else value[field] = "unapproved";
				},
			});
			expectAdmission(result);
			expect(f.state.inference).toHaveLength(0);
		}
	});

	it("rejects stateful protobuf controls without invoking their getters", async () => {
		const f = wire();
		let getterCalls = 0;
		const result = await request(f.model, {
			onPayload: payload => {
				Object.defineProperty(payload, "chatModelUid", {
					enumerable: true,
					get() {
						getterCalls++;
						return "unapproved";
					},
				});
			},
		});
		expectAdmission(result);
		expect(getterCalls).toBe(0);
		expect(f.state.inference).toHaveLength(0);
	});

	it("rejects unknown protobuf field smuggling before inference", async () => {
		const f = wire();
		const result = await request(f.model, {
			onPayload: payload => {
				(payload as GetChatMessageRequest).$unknown = [{ no: 1, wireType: 2, data: Uint8Array.from([0]) }];
			},
		});
		expectAdmission(result);
		expect(f.state.inference).toHaveLength(0);
	});

	it("rechecks original authority after native authentication before the inference frame", async () => {
		const f = wire();
		let allowed = true;
		f.state.afterAuth = () => {
			allowed = false;
		};
		const result = await request(f.model, {
			onBeforeRequest: () => {
				if (!allowed) throw new AIError.ModelSelectionError("Original operator revoked the model");
			},
		});
		expectAdmission(result);
		expect(f.state.authRequests).toBe(1);
		expect(f.state.inference).toHaveLength(0);
	});

	it("does not adopt an unlisted downstream model reported by the server", async () => {
		const f = wire();
		f.state.actualModelUid = "MODEL_UNLISTED";
		const result = await request(f.model);
		expectAdmission(result);
		expect(result.content).toHaveLength(0);
		expect(f.state.inference).toHaveLength(1);
	});

	it("rejects an opaque server router before authentication but retains ordinary router behavior", async () => {
		const f = wire();
		const routed = buildModel({ ...f.model, compat: { ...f.model.compat, modelRouter: true } });
		const result = await request(routed);
		expectAdmission(result);
		expect(f.state.authRequests).toBe(0);
		expect(f.state.assignmentRequests).toBe(0);
		expect(f.state.inference).toHaveLength(0);
		const ordinary = await streamDevin(
			routed,
			{ messages: [{ role: "user", content: "Say ok", timestamp: 1 }] },
			{
				apiKey: "loopback-only-key",
				reasoning: Effort.High,
				chatModelUid: "MODEL_PINNED_HIGH",
			},
		).result();
		expect(ordinary.stopReason).toBe("stop");
		expect(ordinary.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
		expect(f.state.authRequests).toBe(1);
		expect(f.state.assignmentRequests).toBe(1);
		expect(f.state.inference).toHaveLength(1);
		expect(f.state.inference[0]).toMatchObject({
			chatModelUid: "MODEL_PINNED_HIGH",
			modelAssignmentJwt: "loopback-assignment",
		});
	});
});
