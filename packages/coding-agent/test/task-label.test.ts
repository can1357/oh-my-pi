import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { generateTaskLabel, labelEchoesHandle } from "@oh-my-pi/pi-coding-agent/task/label";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return Settings.isolated({
		modelRoles: { tiny: `${model.provider}/${model.id}` },
	});
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: (kind = "chat") => (kind === "all" ? [model] : []),
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("task label generation", () => {
	it("settles when its executor cancellation signal aborts an in-flight title request", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<ai.AssistantMessage>();
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
			requestSignal = options?.signal;
			requestSignal?.addEventListener(
				"abort",
				() => response.resolve({ stopReason: "stop", content: [{ type: "text", text: "" }] } as never),
				{ once: true },
			);
			started.resolve();
			return response.promise;
		});

		const label = generateTaskLabel(
			"Investigate shutdown",
			createRegistry(model),
			createSettings(model),
			undefined,
			controller.signal,
		);
		await started.promise;
		controller.abort();

		expect(requestSignal).toBe(controller.signal);
		expect(await label).toBeNull();
	});

	it("rejects a generated label that only echoes the spawn handle", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>AuthLoader</title>" }],
		} as never);

		const echoed = await generateTaskLabel(
			"Sleep forty seconds then reply done",
			createRegistry(model),
			createSettings(model),
			"AuthLoader",
		);
		expect(echoed).toBeNull();

		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Sleep then reply done</title>" }],
		} as never);
		const labeled = await generateTaskLabel(
			"Sleep forty seconds then reply done",
			createRegistry(model),
			createSettings(model),
			"AuthLoader",
		);
		expect(labeled).toBe("Sleep then reply done");
	});

	it("treats a case-insensitive Name-N collision as an echoed handle", () => {
		expect(labelEchoesHandle("AuthLoader-3", "authloader")).toBe(true);
		expect(labelEchoesHandle("AuthLoader-3", "AuthLoader")).toBe(true);
		expect(labelEchoesHandle("AuthLoader", "authloader")).toBe(true);
		expect(labelEchoesHandle("AuthLoader-3", "Migrate users")).toBe(false);
	});

	it("applies the startup pin before resolving the label model's credential", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Fix login button</title>" }],
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

		const label = await generateTaskLabel(
			"investigate the login button crash",
			registry,
			createSettings(model),
			"task-session-1",
			undefined,
			applyStartupOAuthAccountPin,
		);

		expect(label).toBe("Fix login button");
		expect(applyStartupOAuthAccountPin).toHaveBeenCalledWith(model.provider, "task-session-1");
		expect(callOrder).toEqual(["pin", "getApiKey"]);
	});
});
