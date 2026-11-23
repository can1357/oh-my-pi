import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAppleFoundationModels } from "@oh-my-pi/pi-ai/providers/apple-foundation-models";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as natives from "@oh-my-pi/pi-natives";

const model = buildModel({
	id: "on-device",
	name: "On-device",
	api: "apple-foundation-models",
	provider: "apple",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const context: Context = { messages: [{ role: "user", content: "Count from 1 to 50.", timestamp: 0 }] };

/** Replays bridge events for every generation request. */
function bridge(events: object[]): void {
	vi.spyOn(natives, "appleFmGenerate").mockImplementation((_request, callback) => {
		for (const event of events) callback(null, JSON.stringify(event));
		return 1;
	});
}

const text = { type: "text", text: "1, 2, 3" };
const usage = { type: "usage", input: 20, cachedInput: 0, output: 5, reasoning: 0 };
const done = { type: "done" };

describe("Apple Foundation Models stop reason", () => {
	afterEach(() => vi.restoreAllMocks());

	it("reports the model's token-limit finish reason when no maxTokens was sent", async () => {
		bridge([text, usage, { type: "finish", reason: "maximumResponseTokensExceeded" }, done]);
		const result = await streamAppleFoundationModels(model, context, {}).result();
		expect(result.stopReason).toBe("length");
	});

	it("trusts a completed finish reason over the usage heuristic", async () => {
		bridge([text, usage, { type: "finish", reason: "contentCompleted" }, done]);
		const result = await streamAppleFoundationModels(model, context, { maxTokens: 5 }).result();
		expect(result.stopReason).toBe("stop");
	});

	it("falls back to the usage heuristic without a known finish reason", async () => {
		bridge([text, usage, { type: "finish", reason: "someFutureReason" }, done]);
		const result = await streamAppleFoundationModels(model, context, { maxTokens: 5 }).result();
		expect(result.stopReason).toBe("length");
	});
});
