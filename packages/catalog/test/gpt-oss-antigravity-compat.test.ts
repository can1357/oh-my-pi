import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Context, Model, ToolCall, Usage } from "@oh-my-pi/pi-ai/types";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createGptOssSpec(provider: "google-antigravity" | "google-gemini-cli"): ModelSpec<"google-gemini-cli"> {
	return {
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
	};
}

describe("gpt-oss compat on Cloud Code Assist (Antigravity)", () => {
	it("sets supportsFunctionPartId to true on bundled google-antigravity/gpt-oss-120b", () => {
		const model = getBundledModel<"google-gemini-cli">("google-antigravity", "gpt-oss-120b");
		expect(model).toBeDefined();
		expect(model.compat.supportsFunctionPartId).toBe(true);
	});

	it("resolves supportsFunctionPartId as true via policy cascade", () => {
		const agPolicy = resolveModelPolicy(createGptOssSpec("google-antigravity"));
		expect(agPolicy.compat.supportsFunctionPartId).toBe(true);

		const cliPolicy = resolveModelPolicy(createGptOssSpec("google-gemini-cli"));
		expect(cliPolicy.compat.supportsFunctionPartId).toBe(true);
	});

	it("populates tool call id in functionCall and functionResponse for Antigravity gpt-oss", () => {
		const model = getBundledModel<"google-gemini-cli">("google-antigravity", "gpt-oss-120b");
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call_12345",
			name: "read",
			arguments: { path: "foo.ts" },
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "read foo.ts", timestamp: 1000 },
				{
					role: "assistant",
					provider: "google-antigravity",
					api: "google-gemini-cli",
					model: "gpt-oss-120b",
					content: [toolCall],
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 2000,
				},
				{
					role: "toolResult",
					toolCallId: "call_12345",
					toolName: "read",
					content: [{ type: "text", text: "file content" }],
					isError: false,
					timestamp: 3000,
				},
			],
		};

		const contents = convertMessages(model as Model<"google-gemini-cli">, context);
		const modelTurn = contents.find(c => c.role === "model");
		const userTurn = contents[contents.length - 1];

		expect(modelTurn?.parts?.[0]?.functionCall?.id).toBe("call_12345");
		expect(userTurn?.parts?.[0]?.functionResponse?.id).toBe("call_12345");
	});
});
