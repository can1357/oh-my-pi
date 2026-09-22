import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SpeechEnhancer } from "@oh-my-pi/pi-coding-agent/tts/speech-enhancer";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		get(path: string) {
			if (path === "modelTags") return {};
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SpeechEnhancer", () => {
	it("applies the startup pin before resolving the rewrite model's credential", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Spoken rewrite." }],
		} as never);
		const callOrder: string[] = [];
		const getApiKey = vi.fn(async () => {
			callOrder.push("getApiKey");
			return "test-key";
		});
		const applyStartupOAuthAccountPin = vi.fn((_provider: string, _sessionId: string) => {
			callOrder.push("pin");
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey,
			resolver: () => async () => "test-key",
		} as never;

		const enhancer = new SpeechEnhancer({
			settings: createSettings(model),
			registry,
			sessionId: "primary-session-1",
			applyStartupOAuthAccountPin,
		});

		const rewritten = await enhancer.rewrite("Some markdown block to speak.");

		expect(rewritten).toBe("Spoken rewrite.");
		expect(applyStartupOAuthAccountPin).toHaveBeenCalledWith(model.provider, "primary-session-1");
		expect(callOrder).toEqual(["pin", "getApiKey"]);
	});

	it("falls back to normal resolution when no startup pin hook is provided", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Spoken rewrite." }],
		} as never);
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;

		const enhancer = new SpeechEnhancer({
			settings: createSettings(model),
			registry,
			sessionId: "primary-session-1",
		});

		expect(await enhancer.rewrite("Some markdown block to speak.")).toBe("Spoken rewrite.");
	});
});
