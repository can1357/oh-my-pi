import { describe, expect, it } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function continuation(id: string, thinking?: string) {
	const model = buildModel({
		id,
		name: id,
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 64_000,
		cost,
	});
	const assistant: AssistantMessage = {
		role: "assistant",
		api: "openrouter",
		provider: "openrouter",
		model: id,
		content: [
			...(thinking === undefined ? [] : [{ type: "thinking" as const, thinking }]),
			{ type: "toolCall", id: "call_echo", name: "bash", arguments: { command: "echo 1" } },
		],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	};
	const context: Context = {
		messages: [
			{ role: "user", content: "Run echo 1", timestamp: 0 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "call_echo",
				toolName: "bash",
				content: [{ type: "text", text: "1\n" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "Continue", timestamp: 3 },
		],
	};
	const { params } = buildParams(
		model as unknown as Model<"openai-responses">,
		context,
		{ reasoning: "high" },
		undefined,
	);
	const items = params.input as Array<{
		type?: string;
		call_id?: string;
		output?: string;
		content?: Array<{ type: string; text: string }>;
	}>;
	return { items, reasoning: items.filter(item => item.type === "reasoning") };
}

describe("issue #10966: OpenRouter reasoning reconstruction", () => {
	it("does not reconstruct filtered Muse reasoning from surviving text", () => {
		const { items, reasoning } = continuation("meta/muse-spark-1.3", "need to run echo 1");
		expect(reasoning).toEqual([]);
		expect(items.find(item => item.type === "function_call")).toMatchObject({ call_id: "call_echo" });
		expect(items.find(item => item.type === "function_call_output")).toMatchObject({
			call_id: "call_echo",
			output: "1\n",
		});
	});

	it("does not replace missing Muse reasoning with a placeholder", () => {
		expect(continuation("meta/muse-spark-1.3").reasoning).toEqual([]);
	});

	it("retains reconstruction for filtered Anthropic models that allow it", () => {
		const { reasoning } = continuation("anthropic/claude-sonnet-4", "running command");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]?.content).toEqual([{ type: "reasoning_text", text: "running command" }]);
	});

	it("replays surviving DeepSeek thinking without a native signature", () => {
		const { reasoning } = continuation("deepseek/deepseek-v4-pro", "deepseek thinking trace");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]?.content).toEqual([{ type: "reasoning_text", text: "deepseek thinking trace" }]);
	});

	it("retains the required nonempty DeepSeek fallback after compaction", () => {
		const { reasoning } = continuation("deepseek/deepseek-v4-pro");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]?.content?.some(part => part.type === "reasoning_text" && part.text.trim().length > 0)).toBe(
			true,
		);
	});
});
