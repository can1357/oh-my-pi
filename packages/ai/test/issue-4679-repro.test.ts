import { describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ModelSpec, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";

const bashTool: Tool = {
	name: "bash",
	description: "run a bash command",
	parameters: {
		type: "object",
		properties: { command: { type: "string" } },
		required: ["command"],
	} satisfies TJsonSchema,
};

const toolContext: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: 0 }],
	tools: [bashTool],
};

function anthropicSpec(baseUrl: string): ModelSpec<"anthropic-messages"> {
	return {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
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

async function captureToolParams(
	model: Model<"anthropic-messages">,
): Promise<{ tools?: Array<{ name: string; strict?: unknown }> }> {
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
	return promise;
}

describe("issue #4679 Azure Foundry Anthropic strict tools", () => {
	it.each([
		["inference", "https://example.inference.ai.azure.com/anthropic/v1"],
		["services", "https://example.services.ai.azure.com/anthropic/v1"],
	])("disables strict tools and omits structured-output beta for Azure Foundry %s routes", (_kind, baseUrl) => {
		const model = buildModel(anthropicSpec(baseUrl));

		expect(model.compat.disableStrictTools).toBe(true);
		expect(buildOAuthUtilityBetaHeader(model)).not.toContain(STRUCTURED_OUTPUTS_BETA);
	});

	it("keeps structured-output beta on direct Anthropic OAuth utility headers", () => {
		const model = buildModel(anthropicSpec("https://api.anthropic.com"));

		expect(model.compat.disableStrictTools).toBe(false);
		expect(buildOAuthUtilityBetaHeader(model)).toContain(STRUCTURED_OUTPUTS_BETA);
	});

	it("omits strict tool schemas on Azure Foundry Anthropic requests without disabling direct Anthropic", async () => {
		const azureParams = await captureToolParams(
			buildModel(anthropicSpec("https://example.services.ai.azure.com/anthropic/v1")),
		);
		const directParams = await captureToolParams(buildModel(anthropicSpec("https://api.anthropic.com")));

		const azureBashTool = azureParams.tools?.find(tool => tool.name === "bash");
		const directBashTool = directParams.tools?.find(tool => tool.name === "bash");

		expect(azureBashTool).toBeDefined();
		expect(azureBashTool?.strict).toBeUndefined();
		expect(directBashTool).toBeDefined();
		expect(directBashTool?.strict).toBe(true);
	});
});
