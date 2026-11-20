import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { markOpenAIPriorityDowngrade } from "@oh-my-pi/pi-ai/providers/openai-shared";

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.2",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const openai = { provider: "openai" as const };

describe("markOpenAIPriorityDowngrade", () => {
	it("marks a priority request served at a lower tier", () => {
		const output = message();
		markOpenAIPriorityDowngrade(openai, output, "default", "priority");
		expect(output.disabledFeatures).toEqual(["priority"]);
	});

	it("leaves a priority request served as priority unmarked", () => {
		const output = message();
		markOpenAIPriorityDowngrade(openai, output, "priority", "priority");
		expect(output.disabledFeatures).toBeUndefined();
	});

	it("ignores turns that never asked for priority", () => {
		const output = message();
		markOpenAIPriorityDowngrade(openai, output, "default", "flex");
		expect(output.disabledFeatures).toBeUndefined();
	});

	it("stays silent when the response omits the tier echo", () => {
		const output = message();
		markOpenAIPriorityDowngrade(openai, output, undefined, "priority");
		expect(output.disabledFeatures).toBeUndefined();
	});

	it("ignores relays whose echoed tier is not OpenAI's", () => {
		const output = message();
		markOpenAIPriorityDowngrade({ provider: "openrouter" }, output, "default", "priority");
		expect(output.disabledFeatures).toBeUndefined();
	});

	it("ignores the Codex endpoint, whose tier echo is not authoritative", () => {
		// Codex answers `service_tier` with a value unrelated to what it served,
		// so marking on it reports every Codex turn as refused.
		const output = message();
		markOpenAIPriorityDowngrade({ provider: "openai-codex" }, output, "default", "priority");
		expect(output.disabledFeatures).toBeUndefined();
	});

	it("does not duplicate an existing marker", () => {
		const output = message();
		output.disabledFeatures = ["priority"];
		markOpenAIPriorityDowngrade(openai, output, "default", "priority");
		expect(output.disabledFeatures).toEqual(["priority"]);
	});
});
