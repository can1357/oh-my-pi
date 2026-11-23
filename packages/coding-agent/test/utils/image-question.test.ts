import { describe, expect, it } from "bun:test";
import type { Api, completeSimple, Model } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CostCapError, CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

function makeSession(active: Model<Api>, available: Model<Api>[], settings = Settings.isolated()): ToolSession {
	return {
		settings,
		modelRegistry: {
			getAvailable: () => available,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
		getModelString: () => `${active.provider}/${active.id}`,
		getActiveModelString: () => `${active.provider}/${active.id}`,
		getActiveModel: () => active,
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

describe("resolveImageQuestionModel offline mode", () => {
	const textOnly = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
	const elsewhere = { ...makeProxyModel("elsewhere-vl"), provider: "elsewhere" };

	it("keeps the question on the active model's provider, over the vision role", () => {
		const sameProvider = makeProxyModel("qwen-vl");
		const settings = Settings.isolated({ "models.offline": true, modelRoles: { vision: "elsewhere/elsewhere-vl" } });
		const resolved = resolveImageQuestionModel(makeSession(textOnly, [textOnly, elsewhere, sameProvider], settings));
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe("myproxy/qwen-vl");
	});

	it("refuses when only another provider can see images, even one listing the active model's id", () => {
		const settings = Settings.isolated({ "models.offline": true });
		expect(() => resolveImageQuestionModel(makeSession(textOnly, [textOnly, elsewhere], settings))).toThrow(
			ToolError,
		);
		// An aggregator lists the active model under its own provider; its name still matches the active model string.
		const active = { ...makeProxyModel("claude-v"), provider: "anthropic" };
		const aggregated = { ...makeProxyModel("anthropic/claude-v"), provider: "openrouter" };
		expect(() => resolveImageQuestionModel(makeSession(active, [aggregated], settings))).toThrow(ToolError);
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

describe("askImageQuestion usage journal", () => {
	it("journals an answered question once as `image-question`, with the question and no image data", async () => {
		const model = makeProxyModel("vision");
		const sessionManager = SessionManager.inMemory();
		const base = makeSession(model, [model]);
		const session = {
			...base,
			sessionManager,
			modelRegistry: {
				...base.modelRegistry,
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			},
		} as unknown as ToolSession;
		const usage = {
			input: 12,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		};
		const completeImpl = (async () => ({
			role: "assistant",
			content: [{ type: "text", text: "A cat." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		})) as unknown as typeof completeSimple;
		const image = { resolvedPath: "/x.png", mimeType: "image/png", data: "AAAA", textNote: "", bytes: 3 };

		await askImageQuestion(
			session,
			{ model, selectedPattern: "myproxy/vision" } as ResolvedImageQuestionModel,
			image,
			"what?",
			undefined,
			completeImpl,
		);

		const journaled = sessionManager.getEntries().filter(entry => entry.type === "model_usage");
		expect(journaled).toHaveLength(1);
		expect(journaled[0]).toMatchObject({
			purpose: "image-question",
			usage,
			completion: { prompt: "what?", reply: "A cat." },
		});
		expect(sessionManager.getUsageStatistics().cost).toBe(0.02);
	});
});
