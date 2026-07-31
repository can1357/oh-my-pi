import { afterEach, describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createAgentsHubDeps } from "../src/modes/agents-hub-deps";

const model = buildModel({
	id: "architect-model",
	name: "Architect Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
});

const extensionRoots: EffectiveExtensionRoots = {
	explicit: [],
	mode: "merge",
	configured: [],
	configuredLevel: "user",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("agents hub dependencies", () => {
	test("attributes the agent-creation architect prompt to the agent", async () => {
		const prompts: Array<{ text: string; options?: PromptOptions }> = [];
		const session = {
			prompt: async (text: string, options?: PromptOptions) => {
				prompts.push({ text, options });
				return true;
			},
			subscribe: () => () => {},
			dispose: async () => {},
			state: {
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "text",
								text: '{"identifier":"release-notes","whenToUse":"Use this agent when drafting releases","systemPrompt":"Draft release notes."}',
							},
						],
					},
				],
			},
		};
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as unknown as CreateAgentSessionResult);
		const modelRegistry = {
			authStorage: {},
			refresh: async () => {},
			getAvailable: () => [model],
		} as unknown as ModelRegistry;
		const deps = createAgentsHubDeps(
			"/tmp/agents-hub-deps-test",
			Settings.isolated(),
			modelRegistry,
			() => extensionRoots,
		);

		await deps.generateAgent("Generate a release-notes agent", () => {});

		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.options).toMatchObject({ attribution: "agent", expandPromptTemplates: false });
	});
});
