import { describe, expect, test } from "bun:test";
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "@oh-my-pi/pi-catalog/provider-models";

/**
 * Contract: bare Anthropic Claude foundation rows from models.dev/stencil.so
 * must produce a `us-gov.<foundation-id>` Bedrock inference-profile selector.
 * GovCloud accounts expose system profiles under that geo prefix; without it,
 * `omp --model amazon-bedrock/us-gov.…` fails model resolution even though
 * AWS CLI and ARN-based selectors work.
 */
const CLAUDE_FOUNDATION_ID = "anthropic.claude-sonnet-4-5-20250929-v1:0";

const BEDROCK_CLAUDE_FIXTURE = {
	"amazon-bedrock": {
		models: {
			[CLAUDE_FOUNDATION_ID]: {
				name: "Claude Sonnet 4.5",
				tool_call: true,
				reasoning: true,
				limit: { context: 200_000, output: 64_000 },
				cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
				modalities: { input: ["text", "image"] },
			},
			// Non-Claude Bedrock model must not get a us-gov sibling from the Claude transform.
			"amazon.nova-pro-v1:0": {
				name: "Nova Pro",
				tool_call: true,
				reasoning: false,
				limit: { context: 300_000, output: 10_000 },
				cost: { input: 0.8, output: 3.2, cache_read: 0, cache_write: 0 },
				modalities: { input: ["text", "image"] },
			},
		},
	},
};

describe("Amazon Bedrock GovCloud (us-gov) catalog mapping", () => {
	test("bare Claude foundation ids emit a us-gov geo inference-profile selector", () => {
		const mapped = mapModelsDevToModels(BEDROCK_CLAUDE_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "amazon-bedrock",
		);
		const ids = mapped.map(model => model.id);

		expect(ids).toContain(`us-gov.${CLAUDE_FOUNDATION_ID}`);
		expect(ids).toContain(`eu.${CLAUDE_FOUNDATION_ID}`);

		const gov = mapped.find(model => model.id === `us-gov.${CLAUDE_FOUNDATION_ID}`);
		expect(gov).toBeDefined();
		expect(gov?.api).toBe("bedrock-converse-stream");
		expect(gov?.name).toContain("GovCloud");
	});

	test("non-Claude Bedrock models do not receive synthesized us-gov variants", () => {
		const mapped = mapModelsDevToModels(BEDROCK_CLAUDE_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "amazon-bedrock",
		);
		const ids = mapped.map(model => model.id);

		expect(ids.some(id => id.startsWith("us-gov.amazon."))).toBe(false);
		expect(ids).not.toContain("us-gov.amazon.nova-pro-v1:0");
	});
});
