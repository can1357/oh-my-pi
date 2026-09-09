import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateCommitMessage } from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return "online";
			return undefined;
		},
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("role thinking helper propagation", () => {
	it("passes smol-role thinking to commit message generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:minimal",
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix scope handling" }],
		} as never);

		const message = await generateCommitMessage(`diff --git a/x b/x\n+change\n`, registry as never, settings);
		expect(message).toBe("fix scope handling");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			reasoning: Effort.Minimal,
			maxTokens: 1024,
		});
	});

	it("keeps the commit budget reasoning-safe when the catalog disables reasoning", async () => {
		const model = { ...getModelOrThrow("claude-sonnet-4-5"), reasoning: false };
		const settings = createSettings({
			smol: `${model.provider}/${model.id}`,
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix qwen title budget" }],
		} as never);

		const message = await generateCommitMessage(`diff --git a/x b/x\n+change\n`, registry as never, settings);
		expect(message).toBe("fix qwen title budget");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			maxTokens: 1024,
		});
	});

	it("disables reasoning for title generation even when smol role has thinking", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:low",
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "<title>Investigate resolver</title>" }],
		} as never);

		const title = await generateSessionTitle("Investigate resolver", registry as never, settings);
		expect(title).toBe("Investigate resolver");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true });
	});
});
