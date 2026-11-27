/**
 * Bedrock's Kimi K3.1 rows arrive with `maxTokens` equal to the 1,048,576-token
 * context window. Every request then asks for the whole window, so the
 * output-budget fit lowers the cap from a local prompt estimate. A low estimate
 * makes prompt plus cap exceed the window, and Bedrock rejects the request with
 * "The task request was rejected by the target".
 *
 * The rule caps output at Moonshot's documented 131072 K3-series default
 * (https://platform.kimi.ai/docs/api/chat). This test runs the correction path
 * (`buildModel` → `resolveModelPolicy` → `limits-patch`) against an
 * upstream-shaped spec, so it fails if the rule is dropped even while
 * `models.json` holds a corrected value.
 */
import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

test("Bedrock Kimi K3.1 resolves to the 131072-token output cap and keeps its window", () => {
	const spec: ModelSpec<"bedrock-converse-stream"> = {
		id: "global.moonshotai.kimi-k3.1",
		name: "Kimi K3.1 Pro - Highspeed",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		contextWindow: 1_048_576,
		maxTokens: 1_048_576,
	};
	const model = buildModel(spec);
	expect(model.maxTokens).toBe(131_072);
	expect(model.contextWindow).toBe(1_048_576);
});
