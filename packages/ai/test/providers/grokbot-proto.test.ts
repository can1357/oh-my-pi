import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { toInferenceMessages, toSandImageDataUrl } from "../../src/providers/grokbot";
import * as grokbotAuth from "../../src/providers/grokbot/auth";
import {
	createGrokbotChecksum,
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
import { GROKBOT_HOST_INSTALL_PROMPT, loginGrokbot } from "../../src/registry/grokbot";

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
			requestedModel: resolveGrokbotRequestedModel("grok-4.5"),
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
			requestedModel: { modelId: string; maxMode: boolean; parameters: Array<{ id: string; value: string }> };
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
		expect(decoded.requestedModel.modelId).toBe("grok-4.5");
		expect(decoded.requestedModel.maxMode).toBe(true);
		expect(decoded.requestedModel.parameters.find(p => p.id === "effort")?.value).toBe("high");
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
	test("maps sand-default to grok-4.5 with maxMode and effort/fast", () => {
		const sand = resolveGrokbotRequestedModel("sand-default");
		expect(sand.modelId).toBe("grok-4.5");
		expect(sand.maxMode).toBe(true);
		expect(sand.parameters).toEqual([
			{ id: "effort", value: "high" },
			{ id: "fast", value: "true" },
		]);
	});

	test("honors effort override for parameterized models", () => {
		const low = resolveGrokbotRequestedModel("grok-4.6", { effort: "low" });
		expect(low.parameters).toEqual([
			{ id: "effort", value: "low" },
			{ id: "fast", value: "true" },
		]);
		const xhigh = resolveGrokbotRequestedModel("grok-4.6", { effort: "xhigh", fast: false });
		expect(xhigh.parameters).toEqual([
			{ id: "effort", value: "xhigh" },
			{ id: "fast", value: "false" },
		]);
	});

	test("bare aliases omit maxMode parameters", () => {
		const bare = resolveGrokbotRequestedModel("sand-cua");
		expect(bare).toEqual({ modelId: "sand-cua" });
	});

	test("strips grokbot/ provider prefix", () => {
		expect(resolveGrokbotRequestedModel("grokbot/grok-4.6").modelId).toBe("grok-4.6");
	});
});

describe("grokbot checksum", () => {
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

	test("surfaces the sand-VM install prompt and verifies host secrets without storing a key", async () => {
		const prompts: string[] = [];
		const progress: string[] = [];
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		});

		const result = await loginGrokbot({
			onAuth: () => {},
			onPrompt: async prompt => {
				prompts.push(prompt.message);
				return "";
			},
			onProgress: message => {
				progress.push(message);
			},
		});

		expect(result).toBe("");
		expect(GROKBOT_HOST_INSTALL_PROMPT).toContain("You are in the Linux VM");
		expect(GROKBOT_HOST_INSTALL_PROMPT).toContain("GROKBOT_MACHINE_ID");
		expect(GROKBOT_HOST_INSTALL_PROMPT).toContain("chmod 600");
		expect(prompts[0]).toContain("You are in the Linux VM");
		expect(prompts[0]).toContain("Press Enter after the host secrets file exists");
		expect(progress.some(line => line.includes("sand VM"))).toBe(true);
		expect(progress.some(line => line.includes("not Cursor login"))).toBe(true);
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
