import { describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ModelSpec, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";

const VERTEX_RAW_PREDICT_URL =
	"https://us-east5-aiplatform.googleapis.com/v1/projects/example/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict";

const editTool: Tool = {
	name: "edit",
	description: "edit a file",
	parameters: {
		type: "object",
		properties: { command: { type: "string" } },
		required: ["command"],
	} satisfies TJsonSchema,
};

const toolContext: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: 0 }],
	tools: [editTool],
};

function anthropicSpec(id: string, baseUrl: string): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

function buildOAuthUtilityBetaHeader(model: Model<"anthropic-messages">): string {
	const options = buildAnthropicClientOptions({
		model,
		apiKey: "oauth-token",
		isOAuth: true,
		hasTools: false,
		thinkingEnabled: false,
	});
	return options.defaultHeaders["anthropic-beta"] ?? "";
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function captureEditTool(model: Model<"anthropic-messages">): Promise<{ name: string; strict?: unknown }> {
	const { promise, resolve } = Promise.withResolvers<{ tools?: Array<{ name: string; strict?: unknown }> }>();
	void streamAnthropic(model, toolContext, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as { tools?: Array<{ name: string; strict?: unknown }> });
			return undefined;
		},
	});
	const edit = (await promise).tools?.find(tool => tool.name === "edit");
	expect(edit).toBeDefined();
	return edit as { name: string; strict?: unknown };
}

describe("Anthropic strict-tools opt-out for Vertex-style proxies", () => {
	const vertexSpec = anthropicSpec("claude-sonnet-4-5", VERTEX_RAW_PREDICT_URL);

	it("preserves strict:true on allowlisted tools by default", async () => {
		const edit = await captureEditTool(buildModel(vertexSpec));
		expect(edit.strict).toBe(true);
	});

	it("omits strict on tool defs when compat.disableStrictTools is set", async () => {
		const edit = await captureEditTool(buildModel({ ...vertexSpec, compat: { disableStrictTools: true } }));
		expect(edit.strict).toBeUndefined();
	});
});

describe("Azure Foundry Anthropic strict tools", () => {
	it.each([
		["inference", "https://example.inference.ai.azure.com/anthropic/v1"],
		["services", "https://example.services.ai.azure.com/anthropic/v1"],
	])("disables strict tools and omits structured-output beta for Azure Foundry %s routes", (_kind, baseUrl) => {
		const model = buildModel(anthropicSpec("claude-sonnet-5", baseUrl));

		expect(model.compat.disableStrictTools).toBe(true);
		expect(buildOAuthUtilityBetaHeader(model)).not.toContain(STRUCTURED_OUTPUTS_BETA);
	});

	it("keeps structured-output beta on direct Anthropic OAuth utility headers", () => {
		const model = buildModel(anthropicSpec("claude-sonnet-5", "https://api.anthropic.com"));

		expect(model.compat.disableStrictTools).toBe(false);
		expect(buildOAuthUtilityBetaHeader(model)).toContain(STRUCTURED_OUTPUTS_BETA);
	});

	it("omits strict tool schemas on Azure Foundry Anthropic requests without disabling direct Anthropic", async () => {
		const azureEditTool = await captureEditTool(
			buildModel(anthropicSpec("claude-sonnet-5", "https://example.services.ai.azure.com/anthropic/v1")),
		);
		const directEditTool = await captureEditTool(
			buildModel(anthropicSpec("claude-sonnet-5", "https://api.anthropic.com")),
		);

		expect(azureEditTool.strict).toBeUndefined();
		expect(directEditTool.strict).toBe(true);
	});
});
