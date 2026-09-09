import { expect, test } from "bun:test";
import type { Api, Model, OAuthAccess } from "@oh-my-pi/pi-ai";
import { type DryBalanceModelRegistry, runDryBalanceCommand } from "@oh-my-pi/pi-coding-agent/cli/dry-balance-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
		maxTokens: 4096,
		contextWindow: 128_000,
	} as unknown as Model<Api>;
}

test("dry-balance resolves configured bare role names", async () => {
	const model = fakeModel("acme", "balance-model");
	const registry: DryBalanceModelRegistry = {
		authStorage: {
			getOAuthAccess: async () =>
				({ accessToken: "test-token", email: "test@example.com" }) as unknown as OAuthAccess,
		},
		getAll: () => [model],
		getAvailable: () => [model],
		getApiKey: async () => "test-token",
	};
	const settings = Settings.isolated({ modelRoles: { task: "acme/balance-model" } });

	const summary = await runDryBalanceCommand(
		{
			flags: { model: "task", count: 1, concurrency: 1, json: true },
		},
		{
			createRuntime: async () => ({ modelRegistry: registry, settings }),
			randomSessionId: () => "session-1",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
		},
	);

	expect(summary.model).toBe("acme/balance-model");
	expect(summary.success.total).toBe(1);
});
