import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as grokbotCatalogAuth from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-utils";
import { streamGrokBot, toInferenceMessages, toSandImageDataUrl } from "../../src/providers/grokbot";
import * as grokbotAuth from "../../src/providers/grokbot/auth";
import {
	createGrokbotChecksum,
	formatGrokbotStatus,
	getAccessTokenExpiryMs,
	resolveGrokbotClientVersion,
	shortenGrokbotDisplayPath,
	stampedVersionBaseOf,
} from "../../src/providers/grokbot/auth";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamRequest,
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	encodeInferenceStreamResponse,
	fieldNumbers,
	frameConnectProto,
} from "../../src/providers/grokbot/proto";
import { loginGrokbot } from "../../src/registry/grokbot";
import type { Context, FetchImpl, Model } from "../../src/types";

describe("grokbot proto", () => {
	test("round-trips InferenceStreamRequest without harness fields", () => {
		const req = {
			messages: [
				{ role: 1, text: "ping" },
				{
					role: 2,
					text: "ok",
					toolCalls: [{ toolCallId: "c1", toolName: "echo", args: { x: "y" } }],
					reasoningParts: [{ isRedacted: false, text: "think", signature: "sig-1" }],
				},
				{
					role: 3,
					toolContent: { parts: [{ toolCallId: "c1", toolName: "echo", result: "done" }] },
				},
			],
			tools: [
				{
					name: "echo",
					description: "echo",
					parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
				},
			],
			invocationId: "inv-selfcheck",
			requestedModel: resolveGrokbotRequestedModel("grok-4.6", {
				effort: "high",
				fast: true,
				sandParameterIds: ["effort", "fast"],
			}),
			conversationId: "conv-selfcheck",
		};
		const encoded = encodeInferenceStreamRequest(req);
		const decoded = decodeInferenceStreamRequest(encoded) as unknown as {
			messages: Array<{
				role: number;
				text?: string;
				toolCalls?: Array<{ args: { x: string } }>;
				reasoningParts?: Array<{ text: string; signature?: string }>;
				toolContent?: { parts: Array<{ result: string }> };
			}>;
			tools: Array<{ name: string; parameters: { type: string; required: string[] } }>;
			requestedModel: { modelId: string; maxMode?: boolean; parameters: Array<{ id: string; value: string }> };
			invocationId: string;
			conversationId: string;
		};
		expect(decoded.messages[0]!.role).toBe(1);
		expect(decoded.messages[0]!.text).toBe("ping");
		expect(decoded.messages[1]!.toolCalls![0]!.args.x).toBe("y");
		expect(decoded.messages[1]!.reasoningParts![0]!.text).toBe("think");
		expect(decoded.messages[1]!.reasoningParts![0]!.signature).toBe("sig-1");
		expect(decoded.messages[2]!.toolContent!.parts[0]!.result).toBe("done");
		expect(decoded.tools[0]!.name).toBe("echo");
		expect(decoded.tools[0]!.parameters.type).toBe("object");
		expect(decoded.tools[0]!.parameters.required[0]).toBe("x");
		expect(decoded.requestedModel.modelId).toBe("grok-4.6");
		expect(decoded.requestedModel.maxMode).toBeFalsy();
		expect(decoded.requestedModel.parameters.find(p => p.id === "effort")?.value).toBe("high");
		expect(decoded.requestedModel.parameters.find(p => p.id === "fast")?.value).toBe("true");
		expect(decoded.invocationId).toBe("inv-selfcheck");
		expect(decoded.conversationId).toBe("conv-selfcheck");

		const harness = new Set([3, 5, 9, 10, 11, 12, 13, 14, 15, 16]);
		const allowed = new Set([1, 2, 4, 6, 7, 8]);
		for (const n of fieldNumbers(encoded)) {
			expect(harness.has(n)).toBe(false);
			expect(allowed.has(n)).toBe(true);
		}
		expect(encoded.includes(Buffer.from("INFERENCE_MESSAGE_ROLE_"))).toBe(false);
	});

	test("round-trips user image parts and tool-result experimental_content", () => {
		const dataUrl = "data:image/png;base64,aaaa";
		const encoded = encodeInferenceStreamRequest({
			messages: [
				{
					role: 1,
					parts: {
						parts: [
							{ type: "text", text: "see" },
							{ type: "image", data: dataUrl, mimeType: "image/png" },
						],
					},
				},
				{
					role: 3,
					toolContent: {
						parts: [
							{
								toolCallId: "c1",
								toolName: "shot",
								result: "ok",
								experimentalContent: [{ type: "image", data: dataUrl, mimeType: "image/png" }],
							},
						],
					},
				},
			],
			requestedModel: { modelId: "grok-4.5" },
		});
		const decoded = decodeInferenceStreamRequest(encoded) as unknown as {
			messages: Array<{
				parts?: { parts: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
				toolContent?: {
					parts: Array<{
						experimentalContent?: Array<{ type: string; data?: string; mimeType?: string }>;
					}>;
				};
			}>;
		};
		expect(decoded.messages[0]!.parts!.parts[0]).toEqual({ type: "text", text: "see" });
		expect(decoded.messages[0]!.parts!.parts[1]).toEqual({
			type: "image",
			data: dataUrl,
			mimeType: "image/png",
		});
		expect(decoded.messages[1]!.toolContent!.parts[0]!.experimentalContent![0]).toEqual({
			type: "image",
			data: dataUrl,
			mimeType: "image/png",
		});
	});

	test("frames Connect envelopes with length prefix", () => {
		const payload = encodeInferenceStreamRequest({
			messages: [{ role: 1, text: "hi" }],
			requestedModel: { modelId: "grok-4.5" },
		});
		const framed = frameConnectProto(payload);
		expect(framed[0]).toBe(0);
		expect(framed.readUInt32BE(1)).toBe(payload.length);
		expect(CONNECT_END_STREAM_FLAG).toBe(0b00000010);
	});

	test("round-trips stream response parts including tools, errors, and responseInfo.errorMessage", () => {
		const textResp = decodeInferenceStreamResponse(
			encodeInferenceStreamResponse({ textPart: { text: "hi", isFinal: false } }),
		) as unknown as { textPart: { text: string } };
		expect(textResp.textPart.text).toBe("hi");
		const thinkResp = decodeInferenceStreamResponse(
			encodeInferenceStreamResponse({ thinkingPart: { text: "hmm", signature: "sig", isFinal: true } }),
		) as unknown as { thinkingPart: { text: string; signature?: string; isFinal: boolean } };
		expect(thinkResp.thinkingPart.text).toBe("hmm");
		expect(thinkResp.thinkingPart.signature).toBe("sig");
		expect(thinkResp.thinkingPart.isFinal).toBe(true);
		const toolResp = decodeInferenceStreamResponse(
			encodeInferenceStreamResponse({
				toolCallPart: { toolCallId: "c1", toolName: "echo", args: '{"a":1}', isComplete: true },
			}),
		) as unknown as { toolCallPart: { toolName: string; isComplete: boolean } };
		expect(toolResp.toolCallPart.toolName).toBe("echo");
		expect(toolResp.toolCallPart.isComplete).toBe(true);
		const errResp = decodeInferenceStreamResponse(
			encodeInferenceStreamResponse({ error: { message: "nope", code: "x" } }),
		) as unknown as { error: { message: string } };
		expect(errResp.error.message).toBe("nope");
		const infoResp = decodeInferenceStreamResponse(
			encodeInferenceStreamResponse({
				responseInfo: { id: "r1", model: "grok-4.5", errorMessage: "token limit" },
			}),
		) as unknown as { responseInfo: { id: string; errorMessage?: string } };
		expect(infoResp.responseInfo.id).toBe("r1");
		expect(infoResp.responseInfo.errorMessage).toBe("token limit");
	});

	test("rejects protobuf frames with field number zero", () => {
		expect(() => decodeInferenceStreamResponse(Buffer.from([0x00, 0x00]))).toThrow(/field number must be non-zero/i);
	});

	test("encodes stopSequences in modelConfig", () => {
		const encoded = encodeInferenceStreamRequest({
			messages: [{ role: 1, text: "hi" }],
			modelConfig: { maxTokens: 128, stopSequences: ["END"] },
			requestedModel: { modelId: "grok-4.5" },
		});
		const decoded = decodeInferenceStreamRequest(encoded) as unknown as {
			modelConfig: { maxTokens: number; stopSequences: string[] };
		};
		expect(decoded.modelConfig.maxTokens).toBe(128);
		expect(decoded.modelConfig.stopSequences).toEqual(["END"]);
		expect(fieldNumbers(encoded)).toContain(4);
	});
});

describe("grokbot requested model mapping", () => {
	test("sand-default stays bare with no maxMode or parameters", () => {
		const sand = resolveGrokbotRequestedModel("sand-default");
		expect(sand).toEqual({ modelId: "sand-default" });
	});

	test("honors effort only when sandParameterIds allow it", () => {
		const low = resolveGrokbotRequestedModel("grok-4.6", {
			effort: "low",
			sandParameterIds: ["effort", "fast"],
		});
		expect(low).toEqual({
			modelId: "grok-4.6",
			parameters: [{ id: "effort", value: "low" }],
		});
		const withFast = resolveGrokbotRequestedModel("grok-4.6", {
			effort: "xhigh",
			fast: false,
			sandParameterIds: ["effort", "fast"],
		});
		expect(withFast.parameters).toEqual([
			{ id: "effort", value: "xhigh" },
			{ id: "fast", value: "false" },
		]);
	});

	test("composer only sends fast when allowed and set", () => {
		const bare = resolveGrokbotRequestedModel("composer-2.5", {
			sandParameterIds: ["fast"],
		});
		expect(bare).toEqual({ modelId: "composer-2.5" });
		const fast = resolveGrokbotRequestedModel("composer-2.5", {
			fast: true,
			sandParameterIds: ["fast"],
		});
		expect(fast.parameters).toEqual([{ id: "fast", value: "true" }]);
	});

	test("gemini flash maps effort only; sol maps reasoning when listed", () => {
		const gemini = resolveGrokbotRequestedModel("gemini-3.7-flash", {
			effort: "high",
			fast: true,
			sandParameterIds: ["effort"],
		});
		expect(gemini.parameters).toEqual([{ id: "effort", value: "high" }]);
		const sol = resolveGrokbotRequestedModel("gpt-5.6-sol", {
			effort: "medium",
			fast: true,
			sandParameterIds: ["reasoning", "context", "fast"],
		});
		expect(sol.parameters).toEqual([
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "true" },
		]);
	});

	test("bare aliases omit maxMode parameters", () => {
		const bare = resolveGrokbotRequestedModel("sand-cua");
		expect(bare).toEqual({ modelId: "sand-cua" });
		expect(resolveGrokbotRequestedModel("default")).toEqual({ modelId: "default" });
	});

	test("strips grokbot/ provider prefix", () => {
		expect(resolveGrokbotRequestedModel("grokbot/grok-4.6").modelId).toBe("grok-4.6");
	});
});

describe("grokbot checksum", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("is deterministic and matches sand-host JS shift-wrap encoding", () => {
		const a = createGrokbotChecksum("machine-uuid", 1_700_000_000_000);
		const b = createGrokbotChecksum("machine-uuid", 1_700_000_000_000);
		expect(a).toBe(b);
		expect(a.endsWith("machine-uuid")).toBe(true);
		expect(a.length).toBeGreaterThan("machine-uuid".length);
		// Different floor(now/1e6) buckets must diverge (sand wire).
		const otherBucket = createGrokbotChecksum("machine-uuid", 1_701_000_000_000);
		expect(otherBucket).not.toBe(a);
	});

	test("shortens home-prefixed secrets paths for TUI status", () => {
		expect(shortenGrokbotDisplayPath("/Users/demo/.omp/agent/secrets/grokbot.env", "/Users/demo")).toBe(
			"~/.omp/agent/secrets/grokbot.env",
		);
	});

	test("sanitizes namespace and client version in /grokbot status", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "lab\t\x1b[31mevil\x1b[0m",
			clientVersion: `${"x".repeat(80)}\nnext-line`,
		});
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const status = await formatGrokbotStatus();
		expect(status).toContain("Namespace: lab   evil");
		expect(status).not.toContain("\x1b");
		expect(status).not.toContain("\t");
		const versionLine = status.split("\n").find(line => line.startsWith("Client version:"));
		expect(versionLine).toBeDefined();
		expect(versionLine!.includes("next-line")).toBe(false);
		expect(Bun.stringWidth(versionLine!.slice("Client version: ".length))).toBeLessThanOrEqual(
			TRUNCATE_LENGTHS.TITLE,
		);
	});
});

describe("grokbot sand-host client parity", () => {
	test("strips stamped version and applies namespace suffixes like sand-host", () => {
		expect(stampedVersionBaseOf("0.30.0-pre.16")).toBe("0.30.0");
		expect(resolveGrokbotClientVersion("prod")).toBe("0.30.0");
		expect(resolveGrokbotClientVersion("dev")).toBe("0.30.0-dev");
		expect(resolveGrokbotClientVersion("lab")).toBe("0.30.0-lab");
		expect(resolveGrokbotClientVersion("prod", "0.30.0-pre.16", "9.9.9")).toBe("9.9.9");
	});

	test("reads JWT exp when mint omits expiresAtMs", () => {
		const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
		const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_100 })).toString("base64url");
		expect(getAccessTokenExpiryMs(`${header}.${payload}.sig`)).toBe(1_700_000_100_000);
		expect(getAccessTokenExpiryMs("not-a-jwt")).toBeNull();
	});

	test("builds data URLs for sand image parts and preserves thinkingSignature on replay", () => {
		expect(toSandImageDataUrl({ data: "abc", mimeType: "image/jpeg" })).toBe("data:image/jpeg;base64,abc");
		expect(toSandImageDataUrl({ data: "data:image/png;base64,x", mimeType: "image/png" })).toBe(
			"data:image/png;base64,x",
		);
		const messages = toInferenceMessages({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", data: "qq", mimeType: "image/webp" },
					],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "sig-replay" }],
					api: "grokbot-sand",
					provider: "grokbot",
					model: "grok-4.5",
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
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "shot",
					content: [
						{ type: "text", text: "ok" },
						{ type: "image", data: "zz", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 3,
				},
			],
		});
		expect(messages[0]).toEqual({
			role: 1,
			parts: {
				parts: [
					{ type: "text", text: "look" },
					{ type: "image", data: "data:image/webp;base64,qq", mimeType: "image/webp" },
				],
			},
		});
		expect(messages[1]).toEqual({
			role: 2,
			reasoningParts: [{ isRedacted: false, text: "hmm", signature: "sig-replay" }],
		});
		expect(messages[2]).toEqual({
			role: 3,
			toolContent: {
				parts: [
					{
						toolCallId: "c1",
						toolName: "shot",
						result: "ok",
						experimentalContent: [
							{ type: "text", text: "ok" },
							{ type: "image", data: "data:image/png;base64,zz", mimeType: "image/png" },
						],
					},
				],
			},
		});
	});
});

describe("grokbot /login host-install prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("surfaces the Grok Bot system install prompt and verifies host secrets without storing a key", async () => {
		let prompted = false;
		const progress: string[] = [];
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		const secretsDisplay = shortenPath(grokbotAuth.grokbotSecretsPath());

		const result = await loginGrokbot({
			onAuth: () => {},
			onPrompt: async prompt => {
				prompted = true;
				expect(prompt.allowEmpty).toBe(true);
				expect(prompt.message).toContain("GROKBOT_RENEWAL_CREDENTIAL");
				expect(prompt.message).toContain("GROKBOT_MACHINE_ID");
				expect(prompt.message).toContain(secretsDisplay);
				expect(prompt.message).toContain("PI_CODING_AGENT_DIR");
				expect(prompt.message).not.toContain("OMP_AGENT_DIR");
				return "";
			},
			onProgress: message => {
				progress.push(message);
			},
		});

		expect(result).toBe("");
		expect(prompted).toBe(true);
		expect(progress.some(line => line.includes("Grok Bot system"))).toBe(true);
		expect(progress.some(line => /Host secrets ready/.test(line))).toBe(true);
		expect(progress.some(line => line.includes(process.env.HOME ?? "__no_home__"))).toBe(false);
	});

	test("fails when host secrets are still missing after Enter", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "",
			machineId: "",
			namespace: "prod",
			clientVersion: "0.30.0",
		});

		await expect(
			loginGrokbot({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow(/secrets missing/i);
	});
});

describe("grokbot incomplete tool calls", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const model: Model<"grokbot-sand"> = buildModel({
		id: "sand-default",
		name: "Grok Bot",
		api: "grokbot-sand",
		provider: "grokbot",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
	});
	const context: Context = { messages: [{ role: "user", content: "call", timestamp: 1 }] };

	function connectBody(...frames: Buffer[]): Response {
		return new Response(Buffer.concat(frames), {
			status: 200,
			headers: { "content-type": "application/connect+proto" },
		});
	}

	function mockAuth() {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");
	}

	test("rejects stream that ends with isComplete:false tool call", async () => {
		mockAuth();
		const incomplete = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: { toolCallId: "c1", toolName: "echo", args: '{"a":', isComplete: false },
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(incomplete, trailer)) as FetchImpl;

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/incomplete tool call/i);
		expect(result.content.some(b => b.type === "toolCall" && Object.keys(b.arguments).length === 0)).toBe(true);
	});

	test("finalizes complete tool calls as toolUse", async () => {
		mockAuth();
		const complete = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: { toolCallId: "c1", toolName: "echo", args: '{"a":1}', isComplete: true },
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(complete, trailer)) as FetchImpl;

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			expect.objectContaining({ type: "toolCall", id: "c1", name: "echo", arguments: { a: 1 } }),
		]);
	});

	test("rejects isComplete:true tool call with malformed JSON args", async () => {
		mockAuth();
		const malformed = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: { toolCallId: "c1", toolName: "echo", args: '{"a":', isComplete: true },
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(malformed, trailer)) as FetchImpl;

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/malformed JSON arguments/i);
		expect(result.content.some(b => b.type === "toolCall" && Object.keys(b.arguments).length === 0)).toBe(true);
	});

	test("correlates tool chunks when later frame supplies only toolIndex", async () => {
		mockAuth();
		const start = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "echo",
					args: '{"a":',
					isComplete: false,
					toolIndex: 0,
				},
			}),
		);
		const finish = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: { args: '{"a":1}', isComplete: true, toolIndex: 0 },
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(start, finish, trailer)) as FetchImpl;

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			expect.objectContaining({ type: "toolCall", id: "c1", name: "echo", arguments: { a: 1 } }),
		]);
	});
});

describe("grokbot request headers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const model: Model<"grokbot-sand"> = buildModel({
		id: "sand-default",
		name: "Grok Bot",
		api: "grokbot-sand",
		provider: "grokbot",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
		headers: { "x-proxy-api-key": "proxy-secret" },
	});
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

	test("merges model.headers into the inference request", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		let captured: Record<string, string> | undefined;
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
			captured = init?.headers as Record<string, string>;
			return new Response(trailer, {
				status: 200,
				headers: { "content-type": "application/connect+proto" },
			});
		}) as FetchImpl;

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("stop");
		expect(captured?.["x-proxy-api-key"]).toBe("proxy-secret");
		expect(captured?.authorization).toBe("Bearer fake-jwt");
	});
});
