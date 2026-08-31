import { describe, expect, it } from "bun:test";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AgentRunRequest } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";

function cursorModel(id: string): Model<"cursor-agent"> {
	return buildModel({
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	});
}

function capture(model: Model<"cursor-agent">): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(model, { messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context, {
		apiKey: "test-token",
		onPayload: payload => {
			if (payload && typeof payload === "object" && "$typeName" in payload) {
				resolve(payload as AgentRunRequest);
			} else {
				reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return promise;
}

describe("Cursor requestedModel wire shape", () => {
	it("splits a GPT reasoning-sibling slug into base id + reasoning parameter", async () => {
		const payload = await capture(cursorModel("gpt-5.4-mini-low"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.4-mini");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "low" })]);
		// modelDetails is still read server-side, so it must carry the base id too.
		expect(payload.modelDetails?.modelId).toBe("gpt-5.4-mini");
	});

	it("handles multi-segment GPT bases and the xhigh tier", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-xhigh"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("leaves Cursor-native ids untouched with no parameters", async () => {
		const payload = await capture(cursorModel("cursor-composer-2.5"));
		expect(payload.requestedModel?.modelId).toBe("cursor-composer-2.5");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});

	it("pins the Standard tier for bare composer-2.5 (#9012)", async () => {
		const payload = await capture(cursorModel("composer-2.5"));
		expect(payload.requestedModel?.modelId).toBe("composer-2.5");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "fast", value: "false" })]);
	});

	it("keeps explicit composer-2.5-fast on the Fast lane with no parameters", async () => {
		const payload = await capture(cursorModel("composer-2.5-fast"));
		expect(payload.requestedModel?.modelId).toBe("composer-2.5-fast");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});

	it("does not translate non-OpenAI siblings (Claude effort schema is undecoded)", async () => {
		const payload = await capture(cursorModel("claude-fable-5-low"));
		expect(payload.requestedModel?.modelId).toBe("claude-fable-5-low");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});
});
