import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { commandcodeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const originalCommandCodeApiKey = Bun.env.COMMANDCODE_API_KEY;

// CommandCode's /models payload reports every row as owned_by "command-code",
// so fixture ids must be distinguishable only by family shape.
function commandCodeModelsPayload(): string {
	return JSON.stringify({
		data: [
			{
				id: "claude-sonnet-4-6",
				object: "model",
				owned_by: "command-code",
				name: "Claude Sonnet 4.6",
				context_length: 1_000_000,
			},
			{
				id: "gpt-5.5",
				object: "model",
				owned_by: "command-code",
				name: "GPT-5.5",
				context_length: 400_000,
			},
			{
				id: "deepseek/deepseek-v4-flash",
				object: "model",
				owned_by: "command-code",
				name: "DeepSeek V4 Flash (latest)",
				context_length: 1_000_000,
			},
		],
	});
}

afterEach(() => {
	if (originalCommandCodeApiKey === undefined) {
		delete Bun.env.COMMANDCODE_API_KEY;
	} else {
		Bun.env.COMMANDCODE_API_KEY = originalCommandCodeApiKey;
	}
	vi.restoreAllMocks();
});

describe("commandcode provider support", () => {
	test("resolves COMMANDCODE_API_KEY from environment", () => {
		Bun.env.COMMANDCODE_API_KEY = "commandcode-test-key";
		expect(getEnvApiKey("commandcode")).toBe("commandcode-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "commandcode");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("claude-sonnet-4-6");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("COMMANDCODE_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.commandcode).toBe("claude-sonnet-4-6");
	});

	test("registers Command Code in the login provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "commandcode");
		expect(provider?.name).toBe("Command Code");
	});

	test("routes Claude models to anthropic-messages and open models to chat completions", async () => {
		// Sending a Claude model to /chat/completions is a hard 400 on
		// CommandCode, so a wrong per-model api breaks every request.
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(commandCodeModelsPayload(), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const options = commandcodeModelManagerOptions({ apiKey: "commandcode-test-key", fetch: fetchMock });
		expect(options.providerId).toBe("commandcode");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.commandcode.ai/provider/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		const claude = models?.find(model => model.id === "claude-sonnet-4-6");
		expect(claude?.api).toBe("anthropic-messages");
		// The anthropic transport appends /v1/messages, so its base drops /v1.
		expect(claude?.baseUrl).toBe("https://api.commandcode.ai/provider");
		expect(claude?.contextWindow).toBe(1_000_000);
		expect(claude?.name).toBe("Claude Sonnet 4.6");

		for (const id of ["gpt-5.5", "deepseek/deepseek-v4-flash"]) {
			const model = models?.find(entry => entry.id === id);
			expect(model?.api).toBe("openai-completions");
			expect(model?.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
		}
	});
});
