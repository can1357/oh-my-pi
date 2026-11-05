import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { type } from "@oh-my-pi/omptype";
import {
	BEDROCK_TEST_CONTEXT,
	type BedrockCapture,
	bedrockTestModel,
	capturingBedrockFetch,
	withSkippedBedrockAuth,
} from "./helpers/bedrock-stream";

const HAIKU_55 = bedrockTestModel({ id: "us.anthropic.claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true });
const OFF = { thinking: { type: "disabled" }, output_config: { effort: "low" } };

interface RequestBody {
	additionalModelRequestFields?: Record<string, unknown>;
	toolConfig?: { toolChoice?: unknown };
}

async function captureSimple(options: SimpleStreamOptions, context: Context = BEDROCK_TEST_CONTEXT) {
	const seen: BedrockCapture = {};
	await withSkippedBedrockAuth(async () => {
		await streamSimple(HAIKU_55, context, { ...options, fetch: capturingBedrockFetch(seen) }).result();
	});
	return seen.body as RequestBody;
}

describe("Bedrock Claude Haiku 5.5 thinking Off", () => {
	// Omitted thinking is adaptive on Haiku 5.5, and prefix binding must not re-add it.
	it("sends disabled thinking without binding controls when no effort is requested", async () => {
		const seen: BedrockCapture = {};
		await withSkippedBedrockAuth(async () => {
			await streamBedrock(HAIKU_55, BEDROCK_TEST_CONTEXT, { fetch: capturingBedrockFetch(seen) }).result();
		});
		expect((seen.body as RequestBody).additionalModelRequestFields).toEqual(OFF);
	});

	it.each([{ disableReasoning: true }, { forceReasoningOff: true }])("%o overrides a requested effort", async flag => {
		const body = await captureSimple({ reasoning: Effort.Low, ...flag });
		expect(body.additionalModelRequestFields).toEqual(OFF);
	});

	// Bedrock rejects thinking + forced tool_choice, but disabled thinking is no thinking.
	it("keeps a forced tool choice", async () => {
		const body = await captureSimple(
			{ disableReasoning: true, toolChoice: "any" },
			{
				...BEDROCK_TEST_CONTEXT,
				tools: [{ name: "read", description: "Read a file", parameters: type({ path: "string" }) }],
			},
		);
		expect(body.additionalModelRequestFields).toEqual(OFF);
		expect(body.toolConfig?.toolChoice).toEqual({ any: {} });
	});
});
