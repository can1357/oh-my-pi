/**
 * Bedrock's Qwen rows arrive from upstream with `maxTokens` copied from the
 * context window (262000 against a 262144 window). A request that does not set
 * its own output budget then asks Bedrock for more than the model accepts and
 * gets a 400 back — "This model's maximum context length is 262144 tokens.
 * However, you requested 262000 output tokens" (#12089).
 *
 * AWS publishes the real caps on the model cards, and the context windows
 * already match, so only the output side is patched. These assertions run the
 * correction path (`buildModel` → `resolveModelPolicy` → catalog
 * `limits-patch`) against an upstream-shaped spec rather than the bundled
 * snapshot, so they fail if the rule is dropped even while `models.json`
 * happens to hold a corrected value.
 *
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-vl-235b-a22b.html
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html
 */
import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

/** The shape upstream hands down: maxTokens equal to the context window. */
function upstreamSpec(id: string, contextWindow: number): ModelSpec<"bedrock-converse-stream"> {
	return {
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.15, output: 1.2, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow - 144,
	};
}

describe("Bedrock Qwen output limits (#12089)", () => {
	const cases: ReadonlyArray<readonly [string, number, number]> = [
		// model id, context window, AWS-documented max output tokens
		["qwen.qwen3-next-80b-a3b", 262_144, 8_000],
		["qwen.qwen3-vl-235b-a22b", 262_144, 8_000],
		["qwen.qwen3-coder-next", 262_144, 16_000],
	];

	for (const [id, contextWindow, documentedMaxTokens] of cases) {
		test(`${id} resolves to the documented ${documentedMaxTokens}-token output cap`, () => {
			const model = buildModel(upstreamSpec(id, contextWindow));
			expect(model.maxTokens).toBe(documentedMaxTokens);
			// The context window is already correct upstream and must survive the patch.
			expect(model.contextWindow).toBe(contextWindow);
		});
	}

	test("a model with no limit rule keeps the upstream value", () => {
		// Guards the patch from being applied provider-wide: ids the KDL does not
		// name (including future additions) must pass through untouched.
		const model = buildModel(upstreamSpec("qwen.qwen3-coder-next-unlisted", 262_144));
		expect(model.maxTokens).toBe(262_144 - 144);
	});
});
