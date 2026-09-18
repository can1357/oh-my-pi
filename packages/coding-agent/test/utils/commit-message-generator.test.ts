import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { makeIsolationCommitMessage } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { generateCommitMessage } from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";

function createSettings(model: Model<Api>) {
	return {
		get(key: string) {
			return key === "task.isolation.commits" ? "ai" : undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("generateCommitMessage", () => {
	it("applies the startup pin before resolving a candidate model's credential", async () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!model) throw new Error("Expected bundled model claude-haiku-4-5");

		vi.spyOn(ai, "retryTransientCompletion").mockImplementation(async fn => fn(1));
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "fix: tighten the isolation runner diff filter" }],
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
		} as unknown as ModelRegistry;

		const buildCommitMessage = makeIsolationCommitMessage({
			settings: createSettings(model),
			modelRegistry: registry,
			getSessionId: () => "primary-session-1",
			applyStartupOAuthAccountPin,
		} as unknown as ToolSession);
		const commitMessage = buildCommitMessage();
		if (!commitMessage) throw new Error("Expected AI isolation commit-message generator");
		const message = await commitMessage("diff --git a/foo.ts b/foo.ts\n+ added a line\n");

		expect(message).toBe("fix: tighten the isolation runner diff filter");
		expect(applyStartupOAuthAccountPin).toHaveBeenCalledWith(model.provider, "primary-session-1");
		expect(callOrder).toEqual(["pin", "getApiKey"]);
	});

	it("falls back to normal resolution when no startup pin hook is provided", async () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!model) throw new Error("Expected bundled model claude-haiku-4-5");

		vi.spyOn(ai, "retryTransientCompletion").mockImplementation(async fn => fn(1));
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "fix: tighten the isolation runner diff filter" }],
		} as never);

		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as unknown as ModelRegistry;

		const message = await generateCommitMessage(
			"diff --git a/foo.ts b/foo.ts\n+ added a line\n",
			registry,
			createSettings(model),
			"primary-session-1",
		);

		expect(message).toBe("fix: tighten the isolation runner diff filter");
	});
});
