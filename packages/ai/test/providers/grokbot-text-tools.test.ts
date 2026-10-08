import { afterEach, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clearGrokbotTokenCache, runWithGrokbotAuthSourceAsync } from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { streamGrokBot } from "../../src/providers/grokbot";
import {
	decodeInferenceStreamRequest,
	encodeInferenceStreamRequest,
	encodeInferenceStreamResponse,
	fieldNumbers,
	frameConnectProto,
} from "../../src/providers/grokbot/proto";
import { grokbotTextToolMessages } from "../../src/providers/grokbot/text-tools";
import type { FetchImpl, Tool } from "../../src/types";

afterEach(() => clearGrokbotTokenCache());
const tools: Tool[] = [
	{
		name: "bash",
		description: "Run a shell command",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
];
const model = buildModel({
	id: "claude-opus-5-5-medium",
	requestModelId: "claude-opus-5-5-medium",
	sandParameterIds: [],
	provider: "grokbot",
	api: "grokbot-sand",
	name: "Opus test",
	baseUrl: "https://api2.cursor.sh",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 300_000,
	maxTokens: 2048,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

interface ProbeOptions {
	text: string;
	thinking?: string;
	noTrailer?: boolean;
	toolChoiceNone?: boolean;
}
async function probe(options: ProbeOptions) {
	const requests: Array<Record<string, unknown>> = [];
	const requestFields: number[][] = [];
	const fetch: FetchImpl = async (input, init) => {
		if (String(input).endsWith("/inference-credential"))
			return Response.json({
				accessToken: "fixture-session",
				grokBotToken: "fixture-inference",
				expiresAtMs: Date.now() + 300_000,
			});
		if (!(init?.body instanceof Uint8Array)) throw new Error("Expected framed protobuf request");
		const raw = Buffer.from(init.body).subarray(5);
		requests.push(decodeInferenceStreamRequest(raw));
		requestFields.push(fieldNumbers(raw));
		const frames = [];
		if (options.thinking)
			frames.push(frameConnectProto(encodeInferenceStreamResponse({ thinkingPart: { text: options.thinking } })));
		frames.push(frameConnectProto(encodeInferenceStreamResponse({ textPart: { text: options.text } })));
		if (!options.noTrailer) frames.push(frameConnectProto(Buffer.from("{}"), 2));
		return new Response(Buffer.concat(frames), { headers: { "content-type": "application/connect+proto" } });
	};
	const results = await runWithGrokbotAuthSourceAsync(
		{
			secretsPath: "/not-present/grokbot.env",
			env: { GROKBOT_RENEWAL_CREDENTIAL: "fixture-renewal", GROKBOT_MACHINE_ID: "fixture-machine" },
		},
		async () => {
			const output = [];
			for (let i = 0; i < 2; i++) {
				const stream = streamGrokBot(
					model,
					{ messages: [{ role: "user", content: "fixture request", timestamp: 0 }], tools },
					{
						apiKey: "fixture-renewal",
						fetch,
						anthropicToolsWire: "text-tools",
						conversationId: "caller-conversation",
						toolChoice: options.toolChoiceNone ? "none" : "auto",
					},
				);
				for await (const _event of stream) {
					/* Consume the normal public stream. */
				}
				output.push(await stream.result());
			}
			return output;
		},
	);
	return { requests, requestFields, results };
}

describe("opt-in Grokbot text-tool transport", () => {
	test("omits proto tools, keeps the exact Opus route, rotates replay IDs, and promotes an advertised JSON call", async () => {
		const p = await probe({ text: '{"name":"bash","arguments":{"command":"echo fixture"}}' });
		expect(p.results[0]?.stopReason).toBe("toolUse");
		expect(
			p.results[0]?.content
				.filter(part => part.type === "toolCall")
				.map(part => ({ name: part.name, arguments: part.arguments })),
		).toEqual([{ name: "bash", arguments: { command: "echo fixture" } }]);
		expect(p.requestFields.every(fields => !fields.includes(2))).toBe(true);
		expect(p.requests[0]?.requestedModel).toMatchObject({ modelId: "claude-opus-5-5-medium" });
		expect(p.requests[0]?.conversationId).not.toBe("caller-conversation");
		expect(p.requests[0]?.conversationId).not.toBe(p.requests[1]?.conversationId);
	});

	test("thinking-only JSON and unadvertised calls never become executable client calls", async () => {
		const p = await probe({
			text: '{"name":"unadvertised","arguments":{}}',
			thinking: '{"name":"bash","arguments":{"command":"must-not-execute"}}',
		});
		expect(p.results[0]?.stopReason).toBe("stop");
		expect(p.results[0]?.content.some(part => part.type === "toolCall")).toBe(false);
	});

	test("a truncated stream cannot turn a complete-looking JSON object into a tool call", async () => {
		const p = await probe({ text: '{"name":"bash","arguments":{"command":"must-not-execute"}}', noTrailer: true });
		expect(p.results[0]?.stopReason).toBe("error");
		expect(p.results[0]?.content.some(part => part.type === "toolCall")).toBe(false);
	});

	test("explicit toolChoice none keeps JSON as ordinary text and does not inject tools", async () => {
		const p = await probe({
			text: '{"name":"bash","arguments":{"command":"must-not-execute"}}',
			toolChoiceNone: true,
		});
		expect(p.results[0]?.content.some(part => part.type === "toolCall")).toBe(false);
		expect(p.requests[0]?.conversationId).toBe("caller-conversation");
		expect(JSON.stringify(p.requests[0]?.messages)).not.toContain("JSON Schema:");
	});

	test("textual history removes native call/result fields without losing signatures, raw args, or tool images", () => {
		const messages = grokbotTextToolMessages(
			[
				{
					role: 2,
					text: "prior answer",
					toolCalls: [{ toolCallId: "call-1", toolName: "bash", rawToolCallArgs: "raw grammar input" }],
					anthropicNativeContent: "opaque-signed-payload",
				},
				{
					role: 3,
					toolContent: {
						parts: [
							{
								toolCallId: "call-1",
								toolName: "bash",
								result: "result text",
								experimentalContent: [
									{ type: "image", data: "data:image/png;base64,AA==", mimeType: "image/png" },
								],
							},
						],
					},
				},
			],
			tools,
		);
		const decoded = decodeInferenceStreamRequest(encodeInferenceStreamRequest({ messages }));
		const history = decoded.messages as Array<Record<string, unknown>>;
		expect(history[1]).not.toHaveProperty("toolCalls");
		expect(history[1]?.anthropicNativeContent).toBe("opaque-signed-payload");
		expect(history[1]?.text).toContain("raw grammar input");
		expect(history[2]?.role).toBe(1);
		expect(history[2]).not.toHaveProperty("toolContent");
		expect(JSON.stringify(history[2]?.parts)).toContain("data:image/png;base64,AA==");
		expect(JSON.stringify(history[2]?.parts)).toContain("result text");
	});
});
