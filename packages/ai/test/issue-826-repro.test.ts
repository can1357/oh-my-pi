import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const baseModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl:
		"https://us-east5-aiplatform.googleapis.com/v1/projects/example/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const bashTool: Tool = {
	name: "bash",
	description: "run a bash command",
	parameters: {
		type: "object",
		properties: { command: { type: "string" } },
		required: ["command"],
	} as unknown as Tool["parameters"],
};

const baseContext: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
	tools: [bashTool],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureParams(
	model: Model<"anthropic-messages">,
): Promise<{ tools?: Array<{ name: string; strict?: unknown }> }> {
	const { promise, resolve } = Promise.withResolvers<{ tools?: Array<{ name: string; strict?: unknown }> }>();
	void streamAnthropic(model, baseContext, {
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

describe("issue #826: Anthropic strict-tools opt-out for Vertex-style proxies", () => {
	it("preserves strict:true on allowlisted tools by default (api.anthropic.com baseline)", async () => {
		const params = await captureParams(baseModel);
		const bash = params.tools?.find(t => t.name === "bash");
		expect(bash).toBeDefined();
		expect(bash?.strict).toBe(true);
	});

	it("omits strict on tool defs when compat.disableStrictTools is set", async () => {
		const params = await captureParams(
			buildModel({
				...baseModel,
				compat: { ...baseModel.compatConfig, disableStrictTools: true },
			} as ModelSpec<"anthropic-messages">),
		);
		const bash = params.tools?.find(t => t.name === "bash");
		expect(bash).toBeDefined();
		expect(bash?.strict).toBeUndefined();
	});

	it("preserves adaptive thinking by default", async () => {
		const adaptiveModel: Model<"anthropic-messages"> = buildModel({
			...baseModel,
			id: "claude-opus-4-7",
			reasoning: true,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
			compat: baseModel.compatConfig,
		} as ModelSpec<"anthropic-messages">);
		const { promise, resolve } = Promise.withResolvers<{ thinking?: { type?: string } }>();
		void streamAnthropic(adaptiveModel, baseContext, {
			apiKey: "sk-ant-api-test",
			isOAuth: false,
			signal: abortedSignal(),
			thinkingEnabled: true,
			onPayload: payload => {
				resolve(payload as { thinking?: { type?: string } });
				return undefined;
			},
		});
		const params = await promise;
		expect(params.thinking?.type).toBe("adaptive");
	});

	it("maps adaptive thinking to enabled when compat.disableAdaptiveThinking is set", async () => {
		const adaptiveModel: Model<"anthropic-messages"> = buildModel({
			...baseModel,
			id: "claude-opus-4-7",
			reasoning: true,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
			compat: { ...baseModel.compatConfig, disableAdaptiveThinking: true },
		} as ModelSpec<"anthropic-messages">);
		const { promise, resolve } = Promise.withResolvers<{ thinking?: { type?: string; budget_tokens?: number } }>();
		void streamAnthropic(adaptiveModel, baseContext, {
			apiKey: "sk-ant-api-test",
			isOAuth: false,
			signal: abortedSignal(),
			thinkingEnabled: true,
			onPayload: payload => {
				resolve(payload as { thinking?: { type?: string; budget_tokens?: number } });
				return undefined;
			},
		});
		const params = await promise;
		expect(params.thinking?.type).toBe("enabled");
		expect(typeof params.thinking?.budget_tokens).toBe("number");
	});
});
