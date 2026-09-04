import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as grokbotCatalogAuth from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-utils";
import {
	formatGrokbotConnectTrailerError,
	streamGrokBot,
	toInferenceMessages,
	toSandImageDataUrl,
} from "../../src/providers/grokbot";
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
import { streamSimple } from "../../src/stream";
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

	test("rejects known protobuf fields with incorrect wire types", () => {
		// Field 1 as varint (`08 01`) instead of length-delimited TextPart.
		expect(() => decodeInferenceStreamResponse(Buffer.from([0x08, 0x01]))).toThrow(
			/field 1 \(textPart\) must be length-delimited/i,
		);
	});

	test("rejects nested response fields with incorrect wire types", () => {
		// textPart (field 1) length-delimited, but inner text field encoded as varint: `0a 02 08 01`
		expect(() => decodeInferenceStreamResponse(Buffer.from([0x0a, 0x02, 0x08, 0x01]))).toThrow(
			/textPart\.text must be length-delimited string/i,
		);
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
			parameters: [
				{ id: "effort", value: "low" },
				{ id: "fast", value: "true" },
			],
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

	test("defaults fast to true when the model advertises the parameter", () => {
		expect(
			resolveGrokbotRequestedModel("grok-4.6", {
				sandParameterIds: ["effort", "fast"],
			}).parameters,
		).toEqual([{ id: "fast", value: "true" }]);
		expect(
			resolveGrokbotRequestedModel("grok-4.6", {
				fast: false,
				sandParameterIds: ["effort", "fast"],
			}).parameters,
		).toEqual([{ id: "fast", value: "false" }]);
		expect(
			resolveGrokbotRequestedModel("grok-4.6", {
				sandParameterIds: ["effort"],
			}).parameters,
		).toBeUndefined();
	});

	test("falls back to discovered effort default when caller omits effort", () => {
		expect(
			resolveGrokbotRequestedModel("grok-4.6-high", {
				sandParameterIds: ["effort", "fast"],
				sandParameterDefaults: { effort: "high", fast: "false" },
				canonicalModelId: "grok-4.6",
			}),
		).toEqual({
			modelId: "grok-4.6",
			parameters: [
				{ id: "effort", value: "high" },
				{ id: "fast", value: "true" },
			],
		});
		expect(
			resolveGrokbotRequestedModel("gpt-5.6-sol", {
				sandParameterIds: ["reasoning", "context", "fast"],
				sandParameterDefaults: { reasoning: "medium", context: "272k", fast: "false" },
			}).parameters,
		).toEqual([
			{ id: "context", value: "272k" },
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "true" },
		]);
	});

	test("sets isVariantStringRepresentation for variant-string catalog rows", () => {
		expect(
			resolveGrokbotRequestedModel("variant-string-model::high", {
				sandParameterIds: ["effort"],
				sandParameterDefaults: { effort: "high" },
				canonicalModelId: "variant-string-model",
				sandVariantStringRepresentation: true,
			}),
		).toEqual({
			modelId: "variant-string-model",
			isVariantStringRepresentation: true,
			parameters: [{ id: "effort", value: "high" }],
		});
	});

	test("preserves discovered minimal and max effort on the wire", () => {
		expect(
			resolveGrokbotRequestedModel("grok-4.6", {
				effort: "minimal",
				sandParameterIds: ["effort"],
			}).parameters,
		).toEqual([{ id: "effort", value: "minimal" }]);
		expect(
			resolveGrokbotRequestedModel("grok-4.6", {
				effort: "max",
				sandParameterIds: ["effort"],
			}).parameters,
		).toEqual([{ id: "effort", value: "max" }]);
		expect(
			resolveGrokbotRequestedModel("grok-4.6", {
				effort: "minimal",
				effortMap: { minimal: "low" },
				sandParameterIds: ["effort"],
			}).parameters,
		).toEqual([{ id: "effort", value: "low" }]);
	});

	test("defaults fast to true when advertised; preserves explicit false", () => {
		const bare = resolveGrokbotRequestedModel("composer-2.5", {
			sandParameterIds: ["fast"],
		});
		expect(bare).toEqual({
			modelId: "composer-2.5",
			parameters: [{ id: "fast", value: "true" }],
		});
		const fast = resolveGrokbotRequestedModel("composer-2.5", {
			fast: true,
			sandParameterIds: ["fast"],
		});
		expect(fast.parameters).toEqual([{ id: "fast", value: "true" }]);
		const slow = resolveGrokbotRequestedModel("composer-2.5", {
			fast: false,
			sandParameterIds: ["fast"],
		});
		expect(slow.parameters).toEqual([{ id: "fast", value: "false" }]);
	});

	test("gemini flash maps effort only; sol maps reasoning+context when listed", () => {
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
			sandParameterDefaults: { context: "272k", fast: "false" },
		});
		expect(sol.parameters).toEqual([
			{ id: "context", value: "272k" },
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "true" },
		]);
	});

	test("uses discovered context default before sandMaxMode fallback", () => {
		expect(
			resolveGrokbotRequestedModel("custom-model", {
				sandParameterIds: ["context"],
				sandParameterDefaults: { context: "512k" },
				sandMaxMode: true,
			}).parameters,
		).toEqual([{ id: "context", value: "512k" }]);
	});

	test("empty sandParameterIds omit parameters even when effort/fast are set", () => {
		// Catalog fact: routers/Auto advertise no parameter ids ⇒ bare wire.
		expect(
			resolveGrokbotRequestedModel("sand-cua", {
				effort: "high",
				fast: true,
				sandParameterIds: [],
				sandMaxMode: false,
			}),
		).toEqual({ modelId: "sand-cua" });
		expect(resolveGrokbotRequestedModel("default")).toEqual({ modelId: "default" });
	});

	test("catalog sandParameterIds drive wire params regardless of model id", () => {
		// A formerly hard-coded bare id must still send params when the catalog
		// advertises them — routing policy is sandParameterIds, not a name table.
		expect(
			resolveGrokbotRequestedModel("sand-default", {
				effort: "medium",
				fast: true,
				sandParameterIds: ["effort", "fast"],
			}),
		).toEqual({
			modelId: "sand-default",
			parameters: [
				{ id: "effort", value: "medium" },
				{ id: "fast", value: "true" },
			],
		});
	});

	test("strips grokbot/ provider prefix", () => {
		expect(resolveGrokbotRequestedModel("grokbot/grok-4.6").modelId).toBe("grok-4.6");
	});

	test("emits full Anthropic sand parameter set matching AvailableModels variants", () => {
		expect(
			resolveGrokbotRequestedModel("claude-opus-5", {
				effort: "max",
				sandParameterIds: ["thinking", "context", "effort", "fast"],
			}),
		).toEqual({
			modelId: "claude-opus-5",
			parameters: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: "300k" },
				{ id: "effort", value: "max" },
				{ id: "fast", value: "false" },
			],
		});
		expect(
			resolveGrokbotRequestedModel("claude-opus-5", {
				effort: "high",
				fast: true,
				sandMaxMode: true,
				sandParameterIds: ["thinking", "context", "effort", "fast"],
			}).parameters,
		).toEqual([
			{ id: "thinking", value: "true" },
			{ id: "context", value: "1m" },
			{ id: "effort", value: "high" },
			{ id: "fast", value: "true" },
		]);
		expect(
			resolveGrokbotRequestedModel("claude-opus-5", {
				thinking: false,
				effort: "low",
				sandParameterIds: ["thinking", "context", "effort", "fast"],
			}).parameters,
		).toEqual([
			{ id: "thinking", value: "false" },
			{ id: "context", value: "300k" },
			{ id: "effort", value: "low" },
			{ id: "fast", value: "false" },
		]);
		// Discovered thinking=false must win over effort-derived true (Codex P1).
		expect(
			resolveGrokbotRequestedModel("claude-opus-5", {
				effort: "high",
				sandParameterIds: ["thinking", "context", "effort", "fast"],
				sandParameterDefaults: { thinking: "false", context: "300k", effort: "medium", fast: "false" },
			}).parameters,
		).toEqual([
			{ id: "thinking", value: "false" },
			{ id: "context", value: "300k" },
			{ id: "effort", value: "high" },
			{ id: "fast", value: "false" },
		]);
	});
});

describe("formatGrokbotConnectTrailerError", () => {
	test("surfaces Anthropic providerStatusCode when connect message is opaque", () => {
		expect(
			formatGrokbotConnectTrailerError({
				error: {
					code: "resource_exhausted",
					message: "Error",
					details: [
						{
							type: "aiserver.v1.ErrorDetails",
							debug: {
								error: "ERROR_PROVIDER_ERROR",
								details: {
									title: "Provider Error",
									detail:
										"We're having trouble connecting to the model provider. This might be temporary - please try again in a moment.",
									additionalInfo: { providerStatusCode: "400" },
								},
							},
						},
					],
				},
			}),
		).toBe(
			"Grok Bot connect error: ERROR_PROVIDER_ERROR: Provider Error: HTTP 400: We're having trouble connecting to the model provider. This might be temporary - please try again in a moment.",
		);
	});

	test("keeps a specific connect message and appends debug detail", () => {
		expect(
			formatGrokbotConnectTrailerError({
				error: {
					code: "aborted",
					message: "deadline exceeded",
					details: [
						{
							debug: {
								error: "ERROR_TIMEOUT",
								details: { title: "Timeout", detail: "upstream stalled" },
							},
						},
					],
				},
			}),
		).toBe("Grok Bot connect error: deadline exceeded (ERROR_TIMEOUT: Timeout: upstream stalled)");
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

	test("reports renewer present when AuthStorage / models.yml credential is passed", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockImplementation(async (renewalOverride?: string) => ({
			renewal: renewalOverride || "",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		}));
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const without = await formatGrokbotStatus();
		expect(without).toContain("Renewer: missing");
		const withConfigured = await formatGrokbotStatus({ renewalCredential: "yml-or-runtime-renewal" });
		expect(withConfigured).toContain("Renewer: present");
	});

	test("reports configured proxy baseUrl instead of the hard-coded default host", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const status = await formatGrokbotStatus({ baseUrl: "https://proxy.example/grokbot/" });
		expect(status).toContain("Host: https://proxy.example/grokbot");
		expect(status).not.toContain("Host: https://api2.cursor.sh");
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

	test("replays grammar tool calls with wire name and rawToolCallArgs", () => {
		const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
		const messages = toInferenceMessages({
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "c1",
							name: "edit",
							customWireName: "apply_patch",
							arguments: { input: patch },
						},
					],
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
					stopReason: "toolUse",
					timestamp: 2,
				},
			],
		});
		const assistant = messages.find(m => m.role === 2) as {
			toolCalls?: Array<{ toolCallId: string; toolName: string; args?: unknown; rawToolCallArgs?: string }>;
		};
		expect(assistant?.toolCalls).toEqual([
			{
				toolCallId: "c1",
				toolName: "apply_patch",
				rawToolCallArgs: patch,
			},
		]);
	});

	test("preserves empty-string rawToolCallArgs on the wire", () => {
		// Empty grammar completions must still set field 4 so the custom/raw
		// oneof discriminator survives history replay (|| would drop "").
		const encoded = encodeInferenceStreamRequest({
			messages: [
				{
					role: 2,
					toolCalls: [
						{
							toolCallId: "c-empty",
							toolName: "apply_patch",
							rawToolCallArgs: "",
						},
					],
				},
			],
			requestedModel: { modelId: "grok-4.5" },
		});
		const decoded = decodeInferenceStreamRequest(encoded) as unknown as {
			messages: Array<{
				toolCalls?: Array<{ toolCallId: string; toolName: string; rawToolCallArgs?: string; args?: unknown }>;
			}>;
		};
		expect(decoded.messages[0]?.toolCalls).toEqual([
			{
				toolCallId: "c-empty",
				toolName: "apply_patch",
				rawToolCallArgs: "",
			},
		]);
	});

	test("replays grammar tool results with wire name from context.tools", () => {
		const messages = toInferenceMessages({
			tools: [
				{
					name: "edit",
					description: "Apply a patch",
					parameters: {},
					customWireName: "apply_patch",
					customFormat: { syntax: "lark", definition: "start: ANY" },
				},
			],
			messages: [
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "edit",
					content: [{ type: "text", text: "patched" }],
					isError: false,
					timestamp: 3,
				},
			],
		});
		expect(messages).toEqual([
			{
				role: 3,
				toolContent: {
					parts: [
						{
							toolCallId: "c1",
							toolName: "apply_patch",
							result: "patched",
						},
					],
				},
			},
		]);
	});

	test("pairs tool results with the historical call wire name when tools change", () => {
		const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
		const messages = toInferenceMessages({
			// Current tools use hashline (no customWireName) after edit.mode switched.
			tools: [
				{
					name: "edit",
					description: "hashline edit",
					parameters: {},
					customFormat: { syntax: "lark", definition: "start: ANY" },
				},
			],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "c1",
							name: "edit",
							customWireName: "apply_patch",
							arguments: { input: patch },
						},
					],
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
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "edit",
					content: [{ type: "text", text: "patched" }],
					isError: false,
					timestamp: 3,
				},
			],
		});
		const assistant = messages.find(m => m.role === 2) as {
			toolCalls?: Array<{ toolCallId: string; toolName: string }>;
		};
		const result = messages.find(m => m.role === 3) as {
			toolContent?: { parts: Array<{ toolCallId: string; toolName: string; result: string }> };
		};
		expect(assistant?.toolCalls?.[0]?.toolName).toBe("apply_patch");
		expect(result?.toolContent?.parts[0]).toEqual({
			toolCallId: "c1",
			toolName: "apply_patch",
			result: "patched",
		});
	});

	test("replays hashline grammar calls as raw even without customWireName", () => {
		const hashline = "[src/a.ts#abcd]\n1|-old\n1|+new\n";
		const messages = toInferenceMessages({
			tools: [
				{
					name: "edit",
					description: "hashline edit",
					parameters: {},
					customFormat: { syntax: "lark", definition: "start: ANY" },
				},
			],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "c1",
							name: "edit",
							arguments: { input: hashline },
						},
					],
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
					stopReason: "toolUse",
					timestamp: 2,
				},
			],
		});
		const assistant = messages.find(m => m.role === 2) as {
			toolCalls?: Array<{ toolCallId: string; toolName: string; args?: unknown; rawToolCallArgs?: string }>;
		};
		expect(assistant?.toolCalls).toEqual([
			{
				toolCallId: "c1",
				toolName: "edit",
				rawToolCallArgs: hashline,
			},
		]);
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

	test("rejects isComplete:true tool call with JSON array args", async () => {
		mockAuth();
		const arrayArgs = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: { toolCallId: "c1", toolName: "echo", args: "[1]", isComplete: true },
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(arrayArgs, trailer)) as FetchImpl;

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/must be a JSON object/i);
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

	test("wraps grammar custom-tool raw args as { input } with customWireName", async () => {
		mockAuth();
		const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
		const complete = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "apply_patch",
					args: patch,
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(complete, trailer)) as FetchImpl;
		const grammarContext: Context = {
			messages: [{ role: "user", content: "edit", timestamp: 1 }],
			tools: [
				{
					name: "edit",
					description: "edit files",
					parameters: { type: "object" as const },
					customWireName: "apply_patch",
					customFormat: { syntax: "lark", definition: "start: ANY" },
				},
			],
		};

		const result = await streamGrokBot(model, grammarContext, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "c1",
				name: "edit",
				customWireName: "apply_patch",
				arguments: { input: patch },
			}),
		]);
	});

	test("keeps JSON-shaped grammar output as raw input rather than decoding it", async () => {
		mockAuth();
		const jsonDoc = '{"items":[{"id":1}],"ok":true}';
		const complete = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "edit",
					args: jsonDoc,
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(complete, trailer)) as FetchImpl;
		const grammarContext: Context = {
			messages: [{ role: "user", content: "edit", timestamp: 1 }],
			tools: [
				{
					name: "edit",
					description: "json grammar",
					parameters: { type: "object" as const },
					customFormat: { syntax: "lark", definition: "start: object" },
				},
			],
		};

		const result = await streamGrokBot(model, grammarContext, {
			apiKey: "renew",
			fetch: fetchImpl,
			anthropicToolsWire: "error",
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "c1",
				name: "edit",
				customWireName: "edit",
				arguments: { input: jsonDoc },
			}),
		]);
	});

	test("marks hashline grammar calls with customWireName equal to the tool name", async () => {
		mockAuth();
		const hashline = "[src/a.ts#abcd]\n1|-old\n1|+new\n";
		const complete = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "edit",
					args: hashline,
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(complete, trailer)) as FetchImpl;
		const hashlineContext: Context = {
			messages: [{ role: "user", content: "edit", timestamp: 1 }],
			tools: [
				{
					name: "edit",
					description: "hashline edit",
					parameters: { type: "object" as const },
					customFormat: { syntax: "lark", definition: "start: ANY" },
				},
			],
		};

		const result = await streamGrokBot(model, hashlineContext, {
			apiKey: "renew",
			fetch: fetchImpl,
			anthropicToolsWire: "error",
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "c1",
				name: "edit",
				customWireName: "edit",
				arguments: { input: hashline },
			}),
		]);
	});

	test("updates ToolCall.arguments on incomplete streamed chunks for live previews", async () => {
		mockAuth();
		const partial = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "echo",
					args: '{"cmd":"ls"}',
					isComplete: false,
				},
			}),
		);
		const finish = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "echo",
					args: '{"cmd":"ls","n":1}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () => connectBody(partial, finish, trailer)) as FetchImpl;

		const stream = streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl });
		let sawPartialArgs = false;
		for await (const event of stream) {
			if (event.type === "toolcall_delta" && event.partial) {
				const block = event.partial.content.find(b => b.type === "toolCall");
				if (block && block.type === "toolCall" && block.arguments.cmd === "ls") {
					sawPartialArgs = true;
				}
			}
		}
		const result = await stream.result();
		expect(sawPartialArgs).toBe(true);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "c1",
				name: "echo",
				arguments: { cmd: "ls", n: 1 },
			}),
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

	function textThenTrailer(): Uint8Array {
		const text = frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: "ok", isFinal: true } }));
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		return Buffer.concat([text, trailer]);
	}

	test("merges model.headers into the inference request", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		let captured: Record<string, string> | undefined;
		const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
			captured = init?.headers as Record<string, string>;
			return new Response(textThenTrailer(), {
				status: 200,
				headers: { "content-type": "application/connect+proto" },
			});
		}) as FetchImpl;

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("stop");
		expect(captured?.["x-proxy-api-key"]).toBe("proxy-secret");
		expect(captured?.authorization).toBe("Bearer fake-jwt");
		expect(captured?.["connect-protocol-version"]).toBe("1");
	});

	test("replaces reserved headers case-insensitively so Authorization is not comma-joined", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		let captured: Record<string, string> | undefined;
		const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
			captured = init?.headers as Record<string, string>;
			return new Response(textThenTrailer(), {
				status: 200,
				headers: { "content-type": "application/connect+proto" },
			});
		}) as FetchImpl;

		const casingModel: Model<"grokbot-sand"> = {
			...model,
			headers: { Authorization: "proxy", "Content-Type": "application/json" },
		};
		await streamGrokBot(casingModel, context, { apiKey: "renew", fetch: fetchImpl }).result();
		const authKeys = Object.keys(captured ?? {}).filter(k => k.toLowerCase() === "authorization");
		const typeKeys = Object.keys(captured ?? {}).filter(k => k.toLowerCase() === "content-type");
		expect(authKeys).toHaveLength(1);
		expect(typeKeys).toHaveLength(1);
		expect(captured?.[authKeys[0]!]).toBe("Bearer fake-jwt");
		expect(captured?.[typeKeys[0]!]).toBe("application/connect+proto");
	});

	test("rejects trailer-only and thinking-only completions with no text or tool call", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const emptyTrailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const thinkingOnly = Buffer.concat([
			frameConnectProto(
				encodeInferenceStreamResponse({
					thinkingPart: { text: "hmm", signature: "sig", isFinal: true },
				}),
			),
			emptyTrailer,
		]);

		for (const body of [emptyTrailer, thinkingOnly]) {
			const fetchImpl = (async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "application/connect+proto" },
				})) as FetchImpl;
			const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/no text or tool call/i);
		}
	});

	test("acceptEmptyResponse allows trailer-only completions", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		const emptyTrailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () =>
			new Response(emptyTrailer, {
				status: 200,
				headers: { "content-type": "application/connect+proto" },
			})) as FetchImpl;
		const result = await streamGrokBot(model, context, {
			apiKey: "renew",
			fetch: fetchImpl,
			acceptEmptyResponse: true,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	test("treats Connect unauthenticated end-stream as HTTP 401 and clears the token cache", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");
		const clearSpy = spyOn(grokbotAuth, "clearGrokbotTokenCache").mockImplementation(() => {});

		const trailer = frameConnectProto(
			Buffer.from(JSON.stringify({ error: { code: "unauthenticated", message: "jwt expired" } })),
			CONNECT_END_STREAM_FLAG,
		);
		const fetchImpl = (async () =>
			new Response(trailer, {
				status: 200,
				headers: { "content-type": "application/connect+proto" },
			})) as FetchImpl;

		const result = await streamGrokBot(model, context, { apiKey: "renew", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
		expect(result.errorMessage).toMatch(/unauthenticated|jwt expired/i);
		expect(clearSpy).toHaveBeenCalled();
	});
});

describe("grokbot disableReasoning effort floor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("disableReasoning floors effort to the model's minimum supported tier", async () => {
		spyOn(grokbotAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew",
			machineId: "machine",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotAuth, "mintGrokbotAccessToken").mockResolvedValue("fake-jwt");

		let capturedEffort: string | undefined;
		const text = frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: "ok", isFinal: true } }));
		const trailer = frameConnectProto(Buffer.alloc(0), CONNECT_END_STREAM_FLAG);
		const fetchImpl = (async () =>
			new Response(Buffer.concat([text, trailer]), {
				status: 200,
				headers: { "content-type": "application/connect+proto" },
			})) as FetchImpl;

		const model: Model<"grokbot-sand"> = buildModel({
			id: "grok-4.6",
			name: "Grok 4.6",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			sandParameterIds: ["effort", "fast"],
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_000,
		});

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "renew",
				disableReasoning: true,
				fetch: fetchImpl,
				onPayload: body => {
					const params = (body as { requestedModel?: { parameters?: Array<{ id: string; value: string }> } })
						.requestedModel?.parameters;
					capturedEffort = params?.find(p => p.id === "effort")?.value;
					return body;
				},
			},
		).result();

		expect(capturedEffort).toBe("low");
	});
});
