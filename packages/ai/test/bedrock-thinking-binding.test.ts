import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Effort, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = {
	systemPrompt: ["Use concise answers."],
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

interface CapturedPayload {
	toolConfig?: {
		tools?: unknown[];
		toolChoice?: { auto?: unknown; any?: unknown; tool?: { name: string } };
	};
	additionalModelRequestFields?: {
		thinking?: {
			type?: string;
			block_binding?: { prefix_mismatch_behavior?: string };
		};
		output_config?: { effort?: string };
		anthropic_beta?: string[];
	};
	additionalModelResponseFieldPaths?: string[];
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(
	bedrockModel: Model<"bedrock-converse-stream">,
	options: {
		toolChoice?: "any" | "auto" | "none" | { type: "tool"; name: string };
		reasoning?: Effort;
		anthropicPrefixMismatchBehavior?: "drop_block" | "error";
	} = {},
): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	const tools = options.toolChoice
		? [{ name: "test_tool", description: "test", parameters: { type: "object" } }]
		: undefined;

	void streamBedrock(
		bedrockModel,
		{ ...context, tools },
		{
			bearerToken: "test-token",
			signal: abortedSignal(),
			toolChoice: options.toolChoice,
			reasoning: options.reasoning,
			anthropicPrefixMismatchBehavior: options.anthropicPrefixMismatchBehavior,
			onPayload: payload => {
				resolve(payload as CapturedPayload);
			},
		},
	);
	return promise;
}

describe("Bedrock thinking binding controls opt-out (#15155)", () => {
	it("sends block_binding, beta, and response field paths when controls are supported (default)", async () => {
		const fableRaw = getBundledModel(
			"amazon-bedrock",
			"us.anthropic.claude-fable-5-1",
		) as Model<"bedrock-converse-stream">;
		expect(fableRaw).toBeDefined();
		const fable = buildModel(fableRaw);
		expect(fable.compat.supportsThinkingBindingControls).toBe(true);

		const payload = await capturePayload(fable);
		expect(payload.additionalModelRequestFields?.thinking?.block_binding).toEqual({
			prefix_mismatch_behavior: "drop_block",
		});
		expect(payload.additionalModelRequestFields?.anthropic_beta).toContain("thinking-binding-controls-2026-08-01");
		expect(payload.additionalModelResponseFieldPaths).toContain("/input_transformations");
	});

	it("honors caller-specified anthropicPrefixMismatchBehavior when controls are supported", async () => {
		const fableRaw = getBundledModel(
			"amazon-bedrock",
			"us.anthropic.claude-fable-5-1",
		) as Model<"bedrock-converse-stream">;
		const fable = buildModel(fableRaw);

		const payload = await capturePayload(fable, { anthropicPrefixMismatchBehavior: "error" });
		expect(payload.additionalModelRequestFields?.thinking?.block_binding).toEqual({
			prefix_mismatch_behavior: "error",
		});
	});

	it("omits block_binding, beta, and response field paths when supportsThinkingBindingControls is false", async () => {
		const fableRaw = getBundledModel(
			"amazon-bedrock",
			"us.anthropic.claude-fable-5-1",
		) as Model<"bedrock-converse-stream">;
		expect(fableRaw).toBeDefined();
		const optedOut = buildModel({
			...fableRaw,
			compat: {
				...fableRaw.compat,
				supportsThinkingBindingControls: false,
			},
		});
		expect(optedOut.compat.supportsThinkingBindingControls).toBe(false);

		const payload = await capturePayload(optedOut);
		expect(payload.additionalModelRequestFields?.thinking?.block_binding).toBeUndefined();
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
		expect(payload.additionalModelResponseFieldPaths).toBeUndefined();
	});

	it("omits wire controls even when anthropicPrefixMismatchBehavior is passed if controls are opted out", async () => {
		const fableRaw = getBundledModel(
			"amazon-bedrock",
			"us.anthropic.claude-fable-5-1",
		) as Model<"bedrock-converse-stream">;
		const optedOut = buildModel({
			...fableRaw,
			compat: {
				...fableRaw.compat,
				supportsThinkingBindingControls: false,
			},
		});

		const payload = await capturePayload(optedOut, { anthropicPrefixMismatchBehavior: "error" });
		expect(payload.additionalModelRequestFields?.thinking?.block_binding).toBeUndefined();
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
		expect(payload.additionalModelResponseFieldPaths).toBeUndefined();
	});

	it("preserves adaptive thinking and effort when reasoning is active but wire binding is opted out", async () => {
		const fableRaw = getBundledModel(
			"amazon-bedrock",
			"us.anthropic.claude-fable-5-1",
		) as Model<"bedrock-converse-stream">;
		const optedOut = buildModel({
			...fableRaw,
			compat: {
				...fableRaw.compat,
				supportsThinkingBindingControls: false,
			},
		});

		const payload = await capturePayload(optedOut, { reasoning: "high" });
		expect(payload.additionalModelRequestFields?.thinking?.type).toBe("adaptive");
		expect(payload.additionalModelRequestFields?.output_config?.effort).toBe("high");
		expect(payload.additionalModelRequestFields?.thinking?.block_binding).toBeUndefined();
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
		expect(payload.additionalModelResponseFieldPaths).toBeUndefined();
	});

	it("still downgrades forced tool choice to auto when prefixBinding is active even if wire controls are opted out", async () => {
		const fableRaw = getBundledModel(
			"amazon-bedrock",
			"us.anthropic.claude-fable-5-1",
		) as Model<"bedrock-converse-stream">;
		expect(fableRaw).toBeDefined();
		const optedOut = buildModel({
			...fableRaw,
			compat: {
				...fableRaw.compat,
				supportsThinkingBindingControls: false,
			},
		});

		const payloadAny = await capturePayload(optedOut, { toolChoice: "any" });
		expect(payloadAny.toolConfig?.toolChoice).toEqual({ auto: {} });

		const payloadNamed = await capturePayload(optedOut, {
			toolChoice: { type: "tool", name: "test_tool" },
		});
		expect(payloadNamed.toolConfig?.toolChoice).toEqual({ auto: {} });
	});

	it("does not downgrade forced tool choice on non-prefixBinding models", async () => {
		const opusRaw = getBundledModel(
			"amazon-bedrock",
			"anthropic.claude-opus-4-6-v1",
		) as Model<"bedrock-converse-stream">;
		expect(opusRaw).toBeDefined();
		const opus = buildModel(opusRaw);
		expect(opus.thinking?.prefixBinding).toBeUndefined();
		expect(opus.compat.supportsThinkingBindingControls).toBe(false);

		const payloadAny = await capturePayload(opus, { toolChoice: "any" });
		expect(payloadAny.toolConfig?.toolChoice).toEqual({ any: {} });

		const payloadNamed = await capturePayload(opus, {
			toolChoice: { type: "tool", name: "test_tool" },
		});
		expect(payloadNamed.toolConfig?.toolChoice).toEqual({ tool: { name: "test_tool" } });
	});

	it("merges sparse compat override on bundled models without dropping prompt cache settings", () => {
		const fableRaw = getBundledModel(
			"amazon-bedrock",
			"us.anthropic.claude-fable-5-1",
		) as Model<"bedrock-converse-stream">;
		const customized = buildModel({
			...fableRaw,
			compat: {
				supportsThinkingBindingControls: false,
			},
		});
		expect(customized.compat.supportsThinkingBindingControls).toBe(false);
		expect(customized.compat.promptCacheMode).toBe("explicit");
		expect(customized.compat.promptCacheMaximumCheckpoints).toBe(4);
	});
});
