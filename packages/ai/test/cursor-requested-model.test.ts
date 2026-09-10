import { describe, expect, it } from "bun:test";
import { buildGrpcRequest, type CursorOptions } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type AgentRunRequest, AgentClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

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

async function capture(model: Model<"cursor-agent">, options?: CursorOptions): Promise<AgentRunRequest> {
	const { requestBytes } = await buildGrpcRequest(
		model,
		{ messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context,
		options,
		{ conversationId: "wire-test", blobStore: new Map() },
	);
	const message = fromBinary(AgentClientMessageSchema, requestBytes).message;
	if (message.case !== "runRequest") throw new Error("Expected Cursor run request");
	return message.value;
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

	it("maps the extra-high sibling to the xhigh reasoning parameter", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-extra-high"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("normalizes an off-tier sibling to the base id with no parameters", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-none"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([]);
		expect(payload.modelDetails?.modelId).toBe("gpt-5.6-sol");
	});

	it("normalizes a fast-lane off-tier sibling preserving the lane", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-none-fast"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol-fast");
		expect(payload.requestedModel?.parameters).toEqual([]);
		expect(payload.modelDetails?.modelId).toBe("gpt-5.6-sol-fast");
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

describe("Cursor auto router wire id", () => {
	function rosterAutoModel(): Model<"cursor-agent"> {
		return buildModel({
			id: "auto",
			name: "auto",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
			requestModelId: "auto",
		});
	}

	it("echoes a roster-resolved requestModelId auto verbatim (what the CLI sends)", async () => {
		const payload = await capture(rosterAutoModel());
		expect(payload.requestedModel?.modelId).toBe("auto");
		expect(payload.requestedModel?.parameters).toEqual([]);
		expect(payload.modelDetails?.modelId).toBe("auto");
	});

	it("honors an explicit caller wireModelId auto override", async () => {
		const payload = await capture(cursorModel("cursor-composer-2.5"), { wireModelId: "auto" });
		expect(payload.requestedModel?.modelId).toBe("auto");
		expect(payload.modelDetails?.modelId).toBe("auto");
	});
});
