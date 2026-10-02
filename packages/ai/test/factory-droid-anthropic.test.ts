import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamAnthropic } from "../src/providers/anthropic";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { AssistantMessage, Message } from "../src/types";
import {
	anthropicChunks,
	type CapturedRequest,
	captureFetch,
	factoryModel,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";

describe("Factory Droid anthropic wire (Claude)", () => {
	it("does not invent effort when the registry default leaves thinking off", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			factoryModel("claude-sonnet-4-5-20250929"),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: WORKOS_TOKEN, fetch: captureFetch(captured, anthropicChunks("OK")) },
		).result();
		expect((captured[0].body.output_config as Record<string, unknown> | undefined)?.effort).toBeUndefined();
		expect(captured[0].headers["anthropic-beta"] ?? "").not.toContain("effort-2025-11-24");
		expect(captured[0].headers["anthropic-beta"] ?? "").not.toContain("interleaved-thinking");
	});

	it("sends the anthropic SDK timeout and a placeholder API key beside the bearer token", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			factoryModel("claude-opus-4-8"),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: WORKOS_TOKEN, fetch: captureFetch(captured, anthropicChunks("OK")), reasoning: Effort.High },
		).result();

		// The Anthropic SDK renders its client's 600s timeout as a header.
		expect(captured[0].headers["x-stainless-timeout"]).toBe("600");
		expect(captured[0].headers["x-api-key"]).toBe("placeholder");
	});

	it("withholds refusal fallbacks on vertex/bedrock rotations, which gate the beta themselves", async () => {
		const captured: CapturedRequest[] = [];
		const model = factoryModel("claude-fable-5");
		model.factoryDroidApiProviders = ["vertex_anthropic"];
		await streamFactoryDroid(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("OK")),
				reasoning: Effort.High,
			},
		).result();

		const request = captured[0]!;
		expect(request.headers["x-api-provider"]).toBe("vertex_anthropic");
		expect(request.body.fallbacks).toBeUndefined();
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("server-side-fallback-2026-06-01");
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("fallback-credit-2026-06-01");
	});

	it.each([
		["required", () => ({ type: "any" })],
		[{ type: "function", function: { name: "Read" } }, (toolName: string) => ({ type: "tool", name: toolName })],
	] as const)("maps caller tool choice %j onto Anthropic's tool_choice", async (toolChoice, expected) => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			factoryModel("claude-sonnet-4-5-20250929"),
			{
				messages: [{ role: "user", content: "read it", timestamp: 1 }],
				tools: [{ name: "Read", description: "Read file", parameters: type({ path: "string" }) }],
			},
			{
				apiKey: WORKOS_TOKEN,
				toolChoice,
				fetch: captureFetch(captured, anthropicChunks("OK")),
			},
		).result();
		const tools = captured[0].body.tools as Array<{ name: string }>;
		expect(captured[0].body.tool_choice).toEqual(expected(tools[0].name));
	});
});

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	content: AssistantMessage["content"],
	stamp: Pick<AssistantMessage, "provider" | "model">,
): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", ...stamp, usage, stopReason: "stop", timestamp: 1 };
}

const signed = { type: "thinking", thinking: "prior reasoning", thinkingSignature: "sig-1" } as const;
const redacted = { type: "redactedThinking", data: "opaque" } as const;

/** Conversation histories keyed by which native strip predicate they trip. */
function history(
	kind: "thinkingless" | "turn-after-user" | "thinking-led",
	stamp: Pick<AssistantMessage, "provider" | "model">,
): Message[] {
	const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
	switch (kind) {
		// No assistant turn opens with thinking.
		case "thinkingless":
			return [user("one"), assistant([{ type: "text", text: "answer" }, signed, redacted], stamp), user("two")];
		// History opens thinking-led, but the turn after the last user does not.
		case "turn-after-user":
			return [
				user("one"),
				assistant([signed, redacted, { type: "text", text: "answer" }], stamp),
				user("two"),
				{
					...assistant(
						[
							{ type: "text", text: "checking" },
							{ type: "toolCall", id: "toolu_1", name: "Read", arguments: { path: "a" } },
						],
						stamp,
					),
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "toolu_1",
					toolName: "Read",
					content: [{ type: "text", text: "file" }],
					isError: false,
					timestamp: 1,
				},
			];
		case "thinking-led":
			return [user("one"), assistant([signed, redacted, { type: "text", text: "answer" }], stamp), user("two")];
	}
}

/** Block types replayed in the wire history. */
function replayedBlockTypes(body: Record<string, unknown>): string[] {
	return (body.messages as Array<{ content: unknown }>).flatMap(message =>
		Array.isArray(message.content) ? message.content.map((block: { type: string }) => block.type) : [],
	);
}

const readTool = [{ name: "Read", description: "Read file", parameters: type({ path: "string" }) }];

describe("Factory Droid native thinking-history boundary", () => {
	it.each([
		["claude-opus-4-5-20251101", "thinkingless", Effort.High, "omitted"],
		["claude-opus-4-5-20251101", "turn-after-user", Effort.High, "omitted"],
		["claude-opus-4-5-20251101", "thinking-led", Effort.High, "enabled"],
		["claude-opus-4-8", "thinkingless", Effort.High, "adaptive"],
		["claude-opus-4-5-20251101", "thinkingless", "off", "omitted"],
	] as const)("%s with %s history at effort %s sends thinking %s", async (id, kind, reasoning, thinkingType) => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			factoryModel(id),
			{ messages: history(kind, { provider: "factory-droid", model: id }), tools: readTool },
			{
				apiKey: WORKOS_TOKEN,
				...(reasoning === "off" ? { disableReasoning: true } : { reasoning }),
				fetch: captureFetch(captured, anthropicChunks("OK")),
			},
		).result();
		const body = captured[0].body;
		expect((body.thinking as { type?: string } | undefined)?.type ?? "omitted").toBe(thinkingType);
		// Only an active budget config that the history no longer leads stops replaying thinking.
		const stripped = reasoning !== "off" && thinkingType === "omitted";
		expect(replayedBlockTypes(body).includes("thinking")).toBe(!stripped);
		expect(replayedBlockTypes(body).includes("redacted_thinking")).toBe(!stripped);
		if (stripped) expect(body.output_config).toEqual({ effort: "high" });
	});

	it("leaves direct Anthropic budget thinking and its history untouched", async () => {
		const model = buildModel({
			id: "claude-opus-4-5",
			name: "Claude Opus 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		streamAnthropic(
			model,
			{ messages: history("thinkingless", { provider: "anthropic", model: model.id }), tools: readTool },
			{
				apiKey: "sk-ant-api-test",
				signal: controller.signal,
				thinkingEnabled: true,
				thinkingBudgetTokens: 4096,
				onPayload: payload => resolve(payload as Record<string, unknown>),
			},
		);
		const payload = await promise;
		expect(payload.thinking).toMatchObject({ type: "enabled" });
		expect(replayedBlockTypes(payload)).toContain("thinking");
		expect(replayedBlockTypes(payload)).toContain("redacted_thinking");
	});
});
