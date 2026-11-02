import { describe, expect, it } from "bun:test";
import type { Api, completeSimple, Model } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CostCapError, CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import {
	askImageQuestion,
	type ResolvedImageQuestionModel,
	resolveImageQuestionModel,
} from "@oh-my-pi/pi-coding-agent/utils/image-question";
import { rejectionOf } from "../helpers/rejection";

function makeProxyModel(id: string, compat?: ModelSpec["compat"]): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "myproxy",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		compat,
	} as ModelSpec);
}

function makeSession(active: Model<Api>, available: Model<Api>[]): ToolSession {
	return {
		settings: Settings.isolated(),
		modelRegistry: {
			getAvailable: () => available,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
		getModelString: () => `${active.provider}/${active.id}`,
		getActiveModelString: () => `${active.provider}/${active.id}`,
	} as unknown as ToolSession;
}

describe("resolveImageQuestionModel wire truth (#9697)", () => {
	it("skips a wire-stripped model that declares image input", () => {
		const stripped = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
		const vision = makeProxyModel("qwen-vl", { stripImageInput: false });
		const resolved = resolveImageQuestionModel(makeSession(stripped, [stripped, vision]));
		expect(resolved.model.id).toBe("qwen-vl");
	});

	it("throws instead of returning the stripped model when nothing else can see", () => {
		const stripped = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
		expect(() => resolveImageQuestionModel(makeSession(stripped, [stripped]))).toThrow(
			"Resolved model myproxy/deepseek-v4-flash does not support image input.",
		);
	});
});

describe("askImageQuestion cost cap", () => {
	it("sends no image question once the session is at its cost cap", async () => {
		const model = makeProxyModel("vision");
		const costGate = new CostGate(Settings.isolated({ "session.maxCost": 1 }), 1.2, () => {});
		const base = makeSession(model, [model]);
		const session = {
			...base,
			costGate,
			modelRegistry: {
				...base.modelRegistry,
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			},
		} as unknown as ToolSession;
		let calls = 0;
		const completeImpl = (async () => {
			calls++;
			throw new Error("should not be called");
		}) as unknown as typeof completeSimple;
		const image = { resolvedPath: "/x.png", mimeType: "image/png", data: "AAAA", textNote: "", bytes: 3 };

		const refused = await rejectionOf(
			askImageQuestion(
				session,
				{ model, selectedPattern: "myproxy/vision" } as ResolvedImageQuestionModel,
				image,
				"what?",
				undefined,
				completeImpl,
			),
		);

		expect(refused).toBeInstanceOf(CostCapError);
		expect(calls).toBe(0);
	});
});
