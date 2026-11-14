import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { transformKiroRequest } from "@oh-my-pi/pi-ai/providers/kiro/index";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const lookupTool = { name: "lookup", description: "Look up a path.", parameters: type({ path: "string" }) };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const zeroUsage: Usage = { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } };

function createModel(options: { reasoning?: boolean; thinking?: Model["thinking"]; contextWindow?: number } = {}) {
	return buildModel({
		id: "kiro-test-model",
		name: "Kiro test model",
		api: "kiro-api",
		provider: "kiro",
		baseUrl: "https://runtime.us-east-1.kiro.dev/",
		reasoning: options.reasoning ?? false,
		...(options.thinking ? { thinking: options.thinking } : {}),
		input: ["text", "image"],
		cost: zero,
		contextWindow: options.contextWindow ?? 32_000,
		maxTokens: 4_096,
	}) as Model<"kiro-api">;
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	const base = {
		api: "kiro-api",
		provider: "kiro",
		model: "kiro-test-model",
		usage: zeroUsage,
		timestamp: 1,
	} as const;
	return { role: "assistant", content, stopReason, ...base } satisfies AssistantMessage;
}
const toolCalls = (ids: string[], stop: AssistantMessage["stopReason"] = "toolUse") =>
	assistant(
		ids.map(id => ({ type: "toolCall" as const, id, name: "lookup", arguments: { path: id } })),
		stop,
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
) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "lookup",
		content,
		isError: false,
		timestamp: 2,
	} satisfies Message;
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
	test("serializes images, tools, paired historical tool results, and profile-safe tool ids", () => {
		const context: Context = {
			systemPrompt: ["Follow the system instruction."],
			messages: [
				user("Earlier question"),
				toolCalls(["wire/tool.id"]),
				toolResult("wire/tool.id"),
				user([
					{ type: "text", text: "Current question" },
					{ type: "image", data: "aGk=", mimeType: "image/jpeg" },
					png(),
				]),
			],
			tools: [lookupTool],
		};
		const { history = [], currentMessage } = transformKiroRequest(createModel(), context).conversationState;
		const current = currentMessage.userInputMessage;
		const use = history.find(entry => entry.assistantResponseMessage)?.assistantResponseMessage?.toolUses?.[0];
		const result = current.userInputMessageContext?.toolResults?.[0];

		expect(history[0]?.userInputMessage?.content).toContain("Follow the system instruction.");
		expect(current.content).toBe("Current question");
		expect(current.images).toEqual([
			{ format: "jpeg", source: { bytes: "aGk=" } },
			{ format: "png", source: { bytes: "aGVsbG8=" } },
		]);
		expect(current.userInputMessageContext?.tools?.[0]?.toolSpecification).toMatchObject({
			name: "lookup",
			inputSchema: { json: { type: "object", properties: { path: { type: "string" } } } },
		});
		expect(use?.toolUseId).toMatch(/^call_/);
		expect(result).toMatchObject({ status: "success", toolUseId: use?.toolUseId });
	});

	test("substitutes one continuation prompt for image-only, empty, and assistant-last turns", () => {
		const cases: Message[][] = [[user([png()])], [user(" \t\n")], [user("Start"), text("The first answer")]];
		const contents = cases.map(messages => transform(messages).currentMessage.userInputMessage.content);
		expect(new Set(contents).size).toBe(1);
		expect(contents[0]?.trim()).not.toBe("");
		expect(transform(cases[0]!).currentMessage.userInputMessage.images).toHaveLength(1);
		expect(transform(cases[2]!).history?.at(-1)?.assistantResponseMessage?.content).toBe("The first answer");
	});

	test("clamps adaptive effort and output cap, and omits reasoning when disabled", () => {
		const model = createModel({
			reasoning: true,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.High],
				defaultLevel: Effort.Low,
				supportsDisplay: true,
			},
		});
		const context: Context = { messages: [user("Think")] };
		expect(
			transformKiroRequest(model, context, { reasoning: Effort.Medium, hideThinkingSummary: true, maxTokens: 9_999 })
				.additionalModelRequestFields,
		).toEqual({
			thinking: { type: "adaptive", display: "omitted" },
			output_config: { effort: "low" },
			max_tokens: 4_096,
		});
		expect(
			transformKiroRequest(model, context, { reasoning: Effort.High, disableReasoning: true })
				.additionalModelRequestFields,
		).toBeUndefined();
	});

	test("drops aborted or unmatched tool state and rejects duplicate tool ids", () => {
		for (const messages of [
			[user("Start"), toolCalls(["gone"], "aborted"), toolResult("gone"), user("Continue")],
			[user("Start"), toolCalls(["gone"]), toolResult("orphan"), user("Continue")],
		]) {
			const state = JSON.stringify(transform(messages));
			expect(state).not.toContain("toolUses");
			expect(state).not.toContain("toolResults");
		}
		expect(() => transform([user("Start"), toolCalls(["dup"]), toolCalls(["dup"]), toolResult("dup")])).toThrow(
			/duplicate tool call id/,
		);
	});

	test("fails closed for unsupported image formats in user messages and tool results", () => {
		const bmp = { type: "image" as const, data: "Qk0=", mimeType: "image/bmp" };
		for (const messages of [[user([bmp])], [user("Start"), toolCalls(["t"]), toolResult("t", [bmp])]]) {
			expect(() => transform(messages)).toThrow(/Kiro does not support image type: image\/bmp/);
		}
	});

	test("promotes tool-result images onto the paired user input", () => {
		const state = transform([
			user("Start"),
			toolCalls(["t"]),
			toolResult("t", [{ type: "text", text: "shot" }, png()]),
		]);
		const current = state.currentMessage.userInputMessage;
		const use = state.history?.find(entry => entry.assistantResponseMessage)?.assistantResponseMessage?.toolUses?.[0];
		expect(current.userInputMessageContext?.toolResults?.[0]).toMatchObject({
			content: [{ text: "shot" }],
			toolUseId: use?.toolUseId,
		});
		expect(current.images).toEqual([{ format: "png", source: { bytes: "aGVsbG8=" } }]);
	});

	test("cuts tool results over the 800 KB limit with an omitted-bytes marker", () => {
		const original = "é".repeat(450_000); // 900,000 UTF-8 bytes
		const exact = "a".repeat(800_000);
		const state = transform(
			[
				user("Start"),
				toolCalls(["big", "exact"]),
				toolResult("big", [{ type: "text", text: original }]),
				toolResult("exact", [{ type: "text", text: exact }]),
			],
			1_000_000,
		);
		const [big, atCap] = state.currentMessage.userInputMessage.userInputMessageContext?.toolResults ?? [];
		const result = big?.content[0]?.text ?? "";
		const kept = result.slice(0, result.indexOf("\n\n["));

		expect(bytes(result)).toBeLessThanOrEqual(800_000);
		expect(bytes(kept)).toBeGreaterThan(799_000);
		expect(original.startsWith(kept)).toBe(true);
		expect(result.slice(kept.length)).toContain("900000");
		expect(atCap?.content[0]?.text).toBe(exact);
	});

	test("shrinks oldest historical tool results to 25 KB until the request fits, else overflows", () => {
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
		const historical = (state.history ?? []).flatMap(
			e => e.userInputMessage?.userInputMessageContext?.toolResults ?? [],
		);
		const [h1, h2, h3] = historical.map(result => result.content[0]?.text ?? "");
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

		// A 20k-token window allows 85,000 bytes; four results shrunk to 25 KB each still exceed it.
		const ids = ["r1", "r2", "r3", "r4"];
		const results = ids.map(id => toolResult(id, [{ type: "text", text: "x".repeat(100_000) }]));
		expectOverflow(() => transform([user("Start"), toolCalls(ids), ...results], 20_000));
	});

	test("counts the current user message text and images toward the request budget", () => {
		// A 20k-token window allows 85,000 bytes, with no history to shrink.
		expectOverflow(() => transform([user("x".repeat(100_000))], 20_000));
		expectOverflow(() => transform([user([{ type: "text", text: "Describe." }, png("A".repeat(100_000))])], 20_000));
		expect(transform([user("x".repeat(80_000))], 20_000).currentMessage.userInputMessage.content).toHaveLength(
			80_000,
		);
	});

	test("keeps the system prompt when no history user turn can carry it", () => {
		for (const messages of [[toolCalls(["t"]), toolResult("t")], []]) {
			const state = transformKiroRequest(createModel(), {
				systemPrompt: ["Follow the system instruction."],
				messages,
			}).conversationState;
			expect(state.history).toBeUndefined();
			expect(state.currentMessage.userInputMessage.content).toContain("Follow the system instruction.");
		}
	});

	test("keeps repeated historical tool turns paired and alternating", () => {
		const turns = ["t1", "t2"].flatMap(id => [user(id), toolCalls([id]), toolResult(id), text(`${id} done`)]);
		const history = transform([...turns, user("Continue")]).history ?? [];
		const uses = history.flatMap(entry => entry.assistantResponseMessage?.toolUses ?? []);
		const results = history.flatMap(entry => entry.userInputMessage?.userInputMessageContext?.toolResults ?? []);

		expect(history.map(entry => (entry.userInputMessage ? "u" : "a")).join("")).toBe("uauauaua");
		expect(uses).toHaveLength(2);
		expect(results.map(result => result.toolUseId)).toEqual(uses.map(use => use.toolUseId));
	});
});
