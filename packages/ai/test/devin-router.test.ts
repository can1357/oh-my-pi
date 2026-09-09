import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AssignModelRequest,
	AssignModelRequestSchema,
	AssignModelResponseSchema,
	ChatMessageSource,
	type GetChatMessageRequest,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
	ModelAssignmentSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { DevinCompat } from "@oh-my-pi/pi-catalog/types";

const AUTH_PAYLOAD = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "user-jwt" }));

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

function devinModel(compat: DevinCompat, requestModelId = "adaptive"): Model<"devin-agent"> {
	return buildModel({
		id: "devin-router-test",
		name: "Devin Router Test",
		api: "devin-agent",
		provider: "devin",
		baseUrl: "https://server.codeium.com",
		requestModelId,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		compat,
	});
}

interface ChatResponseFields {
	actualModelUid?: string;
	creditCost?: number;
	committedCreditCost?: number;
	committedAcuCost?: number;
}

interface RecordedTurn {
	/** Request paths in call order, so ordering between AssignModel and chat is observable. */
	paths: string[];
	assignment?: AssignModelRequest;
	chat?: GetChatMessageRequest;
}

function decodeAssignRequest(body: RequestInit["body"]): AssignModelRequest {
	return fromBinary(AssignModelRequestSchema, new Uint8Array(body as ArrayBuffer));
}

function decodeChatRequest(body: RequestInit["body"]): GetChatMessageRequest {
	const framed = new Uint8Array(body as ArrayBuffer);
	const length = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(1, false);
	return fromBinary(GetChatMessageRequestSchema, gunzipSync(framed.subarray(5, 5 + length)));
}

/** Fake Devin edge: serves auth, a fixed model assignment, and one chat response frame. */
function fakeDevin(options: { assignment?: { assignmentJwt: string; modelUid: string }; chat?: ChatResponseFields }): {
	fetch: typeof fetch;
	recorded: RecordedTurn;
} {
	const recorded: RecordedTurn = { paths: [] };
	const chatFrame = frameConnectMessage(
		toBinary(
			GetChatMessageResponseSchema,
			create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				stopReason: StopReason.STOP_PATTERN,
				...options.chat,
			}),
		),
	);
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		recorded.paths.push(new URL(url).pathname);
		if (url.includes("GetUserJwt")) return new Response(AUTH_PAYLOAD);
		if (url.includes("AssignModel")) {
			recorded.assignment = decodeAssignRequest(init?.body);
			const response = create(AssignModelResponseSchema, {
				assignment: options.assignment ? create(ModelAssignmentSchema, options.assignment) : undefined,
			});
			return new Response(toBinary(AssignModelResponseSchema, response));
		}
		recorded.chat = decodeChatRequest(init?.body);
		return new Response(chatFrame);
	}) as typeof fetch;
	return { fetch: fetchImpl, recorded };
}

const context: Context = {
	messages: [
		{ role: "user", content: "older turn", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "devin-agent",
			provider: "devin",
			model: "devin-router-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
		{ role: "user", content: "route me", timestamp: 3 },
	],
};

describe("streamDevin router assignment", () => {
	it("assigns a concrete model before chat and forwards the assignment", async () => {
		const { fetch: fetchImpl, recorded } = fakeDevin({
			assignment: { assignmentJwt: "assign-jwt", modelUid: "claude-sonnet-4-5" },
		});

		const result = await streamDevin(devinModel({ modelRouter: true }), context, {
			apiKey: "token",
			fetch: fetchImpl,
			conversationId: "cascade-42",
		}).result();

		expect(recorded.paths).toEqual([
			"/exa.auth_pb.AuthService/GetUserJwt",
			"/exa.api_server_pb.ApiServerService/AssignModel",
			"/exa.api_server_pb.ApiServerService/GetChatMessage",
		]);
		expect(recorded.assignment?.modelRouterUid).toBe("adaptive");
		expect(recorded.assignment?.cascadeId).toBe("cascade-42");
		expect(recorded.assignment?.chatMessagePrompt).toMatchObject({
			messageId: "",
			source: ChatMessageSource.USER,
			prompt: "route me",
		});
		expect(recorded.assignment?.metadata).toMatchObject({
			ideName: "devin-cli",
			ideType: "chisel",
			extensionName: "chisel",
			extensionVersion: "3000.6.2",
			apiKey: "devin-session-token$token",
			userJwt: "",
		});
		// The router uid must never reach GetChatMessage as the chat model.
		expect(recorded.chat?.chatModelUid).toBe("claude-sonnet-4-5");
		expect(recorded.chat?.modelAssignmentJwt).toBe("assign-jwt");
		expect(recorded.chat?.cascadeId).toBe("cascade-42");
		expect(recorded.chat?.metadata).toMatchObject({ ideType: "chisel", userJwt: "user-jwt" });
		expect(result.upstreamModel).toBe("claude-sonnet-4-5");
		expect(result.stopReason).toBe("stop");
	});

	it("prefers the model the response actually ran on", async () => {
		const { fetch: fetchImpl } = fakeDevin({
			assignment: { assignmentJwt: "assign-jwt", modelUid: "claude-sonnet-4-5" },
			chat: { actualModelUid: "gpt-5-codex" },
		});

		const result = await streamDevin(devinModel({ modelRouter: true }), context, {
			apiKey: "token",
			fetch: fetchImpl,
		}).result();

		expect(result.upstreamModel).toBe("gpt-5-codex");
	});

	it("fails the turn when the assignment is incomplete instead of chatting with the router uid", async () => {
		const { fetch: fetchImpl, recorded } = fakeDevin({ assignment: { assignmentJwt: "", modelUid: "" } });

		const result = await streamDevin(devinModel({ modelRouter: true }), context, {
			apiKey: "token",
			fetch: fetchImpl,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(recorded.chat).toBeUndefined();
		expect(recorded.paths).not.toContain("/exa.api_server_pb.ApiServerService/GetChatMessage");
	});

	it("skips assignment for non-router models", async () => {
		const { fetch: fetchImpl, recorded } = fakeDevin({});

		const result = await streamDevin(devinModel({}, "claude-sonnet-4-5"), context, {
			apiKey: "token",
			fetch: fetchImpl,
			sessionId: "session-7",
		}).result();

		expect(recorded.paths).not.toContain("/exa.api_server_pb.ApiServerService/AssignModel");
		expect(recorded.chat?.chatModelUid).toBe("claude-sonnet-4-5");
		expect(recorded.chat?.modelAssignmentJwt).toBeUndefined();
		expect(recorded.chat?.cascadeId).toBe("session-7");
		expect(result.upstreamModel).toBeUndefined();
	});

	it("surfaces credit metering onto usage", async () => {
		const { fetch: fetchImpl } = fakeDevin({
			chat: { creditCost: 3, committedCreditCost: 2, committedAcuCost: 0.25 },
		});

		const result = await streamDevin(devinModel({}), context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.usage.credits).toEqual({ cost: 3, committedCost: 2, acuCost: 0.25 });
	});

	it("leaves credits unset when the response reports no billing", async () => {
		const { fetch: fetchImpl } = fakeDevin({});

		const result = await streamDevin(devinModel({}), context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.usage.credits).toBeUndefined();
	});

	it("enables parallel tool calls only when compat advertises support", async () => {
		const off = fakeDevin({});
		await streamDevin(devinModel({}), context, { apiKey: "token", fetch: off.fetch }).result();
		expect(off.recorded.chat?.disableParallelToolCalls).toBe(true);

		const on = fakeDevin({});
		await streamDevin(devinModel({ supportsParallelToolCalls: true }), context, {
			apiKey: "token",
			fetch: on.fetch,
		}).result();
		expect(on.recorded.chat?.disableParallelToolCalls).toBe(false);
	});
});
