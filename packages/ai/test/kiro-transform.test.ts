import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { transformKiroRequest } from "@oh-my-pi/pi-ai/providers/kiro/transform";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const lookupTool = { name: "lookup", description: "Look up a path.", parameters: type({ path: "string" }) };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const zeroUsage: Usage = { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } };

function createModel(options: { thinking?: Model["thinking"]; contextWindow?: number } = {}) {
	return buildModel({
		id: "kiro-test-model",
		name: "Kiro test model",
		api: "kiro-api",
		provider: "kiro",
		baseUrl: "https://runtime.us-east-1.kiro.dev/",
		reasoning: options.thinking !== undefined,
		...(options.thinking ? { thinking: options.thinking } : {}),
		input: ["text", "image"],
		cost: zero,
		contextWindow: options.contextWindow ?? 32_000,
		maxTokens: 4_096,
	}) as Model<"kiro-api">;
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant",
		content,
		stopReason,
		api: "kiro-api",
		provider: "kiro",
		model: "kiro-test-model",
		usage: zeroUsage,
		timestamp: 1,
	} satisfies AssistantMessage;
}
const toolCalls = (ids: string[]) =>
	assistant(
		ids.map(id => ({ type: "toolCall" as const, id, name: "lookup", arguments: { path: id } })),
		"toolUse",
	);
const text = (t: string) => assistant([{ type: "text", text: t }]);
const user = (content: Extract<Message, { role: "user" }>["content"]): Message => ({
	role: "user",
	content,
	timestamp: 0,
});
const png = (data = "aGVsbG8=") => ({ type: "image" as const, data, mimeType: "image/png" });
function toolResult(
	toolCallId: string,
	content: ToolResultMessage["content"] = [{ type: "text", text: "file contents" }],
): Message {
	return { role: "toolResult", toolCallId, toolName: "lookup", content, isError: false, timestamp: 2 };
}
const transform = (messages: Message[], contextWindow?: number) =>
	transformKiroRequest(createModel({ contextWindow }), { messages }).conversationState;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
function expectOverflow(run: () => unknown) {
	try {
		run();
		expect.unreachable("expected context overflow");
	} catch (error) {
		expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(true);
	}
}

describe("Kiro request transformation", () => {
	test("serializes the system prompt, images, tools, and paired tool calls", () => {
		const context: Context = {
			systemPrompt: ["Follow the system instruction."],
			messages: [
				user("Earlier question"),
				toolCalls(["tooluse_1"]),
				toolResult("tooluse_1", [{ type: "text", text: "shot" }, png()]),
				user([
					{ type: "text", text: "Current question" },
					{ type: "image", data: "aGk=", mimeType: "image/jpeg" },
				]),
			],
			tools: [lookupTool],
		};
		const { history = [], currentMessage } = transformKiroRequest(createModel(), context).conversationState;
		const current = currentMessage.userInputMessage;
		const use = history[1]?.assistantResponseMessage?.toolUses?.[0];

		expect(history).toHaveLength(2);
		expect(history[0]?.userInputMessage?.content).toContain("Follow the system instruction.");
		expect(use?.toolUseId).toBe("tooluse_1");
		expect(current.content).toContain("Current question");
		expect(current.userInputMessageContext?.toolResults).toEqual([
			{ content: [{ text: "shot" }], status: "success", toolUseId: use!.toolUseId },
		]);
		// The tool-result image rides along with the current turn.
		expect(current.images).toEqual([
			{ format: "jpeg", source: { bytes: "aGk=" } },
			{ format: "png", source: { bytes: "aGVsbG8=" } },
		]);
		expect(current.userInputMessageContext?.tools?.[0]?.toolSpecification).toMatchObject({
			name: "lookup",
			inputSchema: { json: { type: "object", properties: { path: { type: "string" } } } },
		});
		expect(() => transform([user([{ type: "image", data: "Qk0=", mimeType: "image/bmp" }])])).toThrow(
			/Kiro does not support image type: image\/bmp/,
		);
	});

	test("pairs another model's tool ids with their results under wire-safe, unique ids", () => {
		const foreign = {
			...toolCalls(["call_A|fc_1", "call.a", "call_a"]),
			api: "openai-responses",
			provider: "openai",
			model: "gpt-x",
		} satisfies AssistantMessage;
		const { currentMessage, history = [] } = transform([
			user("Go"),
			foreign,
			toolResult("call_A|fc_R"),
			toolResult("call.a"),
			toolResult("call_a"),
		]);
		const uses = history[1]?.assistantResponseMessage?.toolUses?.map(use => use.toolUseId) ?? [];
		const results = currentMessage.userInputMessage.userInputMessageContext?.toolResults?.map(r => r.toolUseId);

		expect(new Set(uses).size).toBe(3);
		for (const id of uses) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(results).toEqual(uses);
	});

	test("substitutes the continuation prompt for empty and assistant-last turns and keeps turns alternating", () => {
		const contents = [[user(" \t\n")], [user("Start"), text("The first answer")]].map(
			messages => transform(messages).currentMessage.userInputMessage.content,
		);
		expect(contents[0]).toBe(contents[1]!);
		expect(contents[0]?.trim()).not.toBe("");

		const turns = ["t1", "t2"].flatMap(id => [user(id), toolCalls([id]), toolResult(id), text(`${id} done`)]);
		const history = transform([...turns, user("Continue")]).history ?? [];
		const uses = history.flatMap(entry => entry.assistantResponseMessage?.toolUses ?? []);
		const results = history.flatMap(entry => entry.userInputMessage?.userInputMessageContext?.toolResults ?? []);
		expect(history.map(entry => (entry.userInputMessage ? "u" : "a")).join("")).toBe("uauauaua");
		expect(results.map(result => result.toolUseId)).toEqual(uses.map(use => use.toolUseId));
	});

	test("maps adaptive effort with the output cap, GPT reasoning effort, and omits both when disabled", () => {
		const context: Context = { messages: [user("Think")] };
		const adaptive = createModel({
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.High],
				defaultLevel: Effort.Low,
				supportsDisplay: true,
			},
		});
		expect(
			transformKiroRequest(adaptive, context, {
				reasoning: Effort.Medium,
				hideThinkingSummary: true,
				maxTokens: 9_999,
			}).additionalModelRequestFields,
		).toEqual({
			thinking: { type: "adaptive", display: "omitted" },
			output_config: { effort: "low" },
			max_tokens: 4_096,
		});
		const gpt = createModel({
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High], defaultLevel: Effort.Medium },
		});
		expect(transformKiroRequest(gpt, context, { reasoning: Effort.High }).additionalModelRequestFields).toEqual({
			reasoning: { mode: "standard", effort: "high" },
		});
		expect(
			transformKiroRequest(adaptive, context, { reasoning: Effort.High, disableReasoning: true })
				.additionalModelRequestFields,
		).toBeUndefined();
	});

	test("cuts a tool result over the 800 KB service limit with an omitted-bytes marker", () => {
		const original = "é".repeat(450_000); // 900,000 UTF-8 bytes
		const state = transform(
			[user("Start"), toolCalls(["big"]), toolResult("big", [{ type: "text", text: original }])],
			1_000_000,
		);
		const result = state.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0]?.content[0]?.text;
		const kept = result!.slice(0, result!.indexOf("\n\n["));
		expect(bytes(result!)).toBeLessThanOrEqual(800_000);
		expect(bytes(kept)).toBeGreaterThan(799_000);
		expect(original.startsWith(kept)).toBe(true);
		expect(result!.slice(kept.length)).toContain("900000");
	});

	test("shrinks the oldest tool results to 25 KB until the request fits, else overflows", () => {
		const texts = ["h1", "h2", "h3", "current"].map(id => `${id}:${"x".repeat(300_000)}`);
		const messages: Message[] = ["h1", "h2", "h3"].flatMap((id, i) => [
			user(`Turn ${id}`),
			toolCalls([id]),
			toolResult(id, [{ type: "text", text: texts[i]! }]),
			text(`Done ${id}`),
		]);
		messages.push(
			user("Turn current"),
			toolCalls(["current"]),
			toolResult("current", [{ type: "text", text: texts[3]! }]),
		);

		// A 200k-token window allows 850,000 bytes: the 1.2 MB of results must shrink.
		const state = transform(messages, 200_000);
		const [h1, h2, h3] = (state.history ?? [])
			.flatMap(e => e.userInputMessage?.userInputMessageContext?.toolResults ?? [])
			.map(result => result.content[0]?.text ?? "");
		for (const [shrunk, original] of [
			[h1!, texts[0]!],
			[h2!, texts[1]!],
		]) {
			expect(bytes(shrunk)).toBeLessThanOrEqual(25_000);
			expect(original.startsWith(shrunk.slice(0, shrunk.indexOf("\n\n[")))).toBe(true);
		}
		expect(h3).toBe(texts[2]);
		expect(state.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0]?.content[0]?.text).toBe(
			texts[3],
		);

		// A 20k-token window allows 85,000 bytes: four results shrunk to 25 KB each, or a long prompt, still exceed it.
		const ids = ["r1", "r2", "r3", "r4"];
		const results = ids.map(id => toolResult(id, [{ type: "text", text: "x".repeat(100_000) }]));
		expectOverflow(() => transform([user("Start"), toolCalls(ids), ...results], 20_000));
		expectOverflow(() => transform([user("x".repeat(100_000))], 20_000));
		expectOverflow(() => transform([user([{ type: "text", text: "Describe." }, png("A".repeat(100_000))])], 20_000));
	});
});
