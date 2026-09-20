import { afterEach, expect, test, vi } from "bun:test";
import type { Api, Model, OAuthAccess } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type DryBalanceModelRegistry, runDryBalanceCommand } from "@oh-my-pi/pi-coding-agent/cli/dry-balance-cli";

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

const authStorages: AuthStorage[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
});

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

test("default dry-balance runtime hydrates credential-scoped caches before selection", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	authStorages.push(authStorage);
	await authStorage.set("grokbot", {
		type: "oauth",
		access: "dry-balance-renewal",
		refresh: "dry-balance-refresh",
		expires: Date.now() + 3_600_000,
		orgId: "dry-balance-machine",
	});
	const hydrate = vi.spyOn(ModelRegistry.prototype, "hydrateCredentialScopedModelCaches");
	const loadExtensions = vi.spyOn(sdkModule, "loadCliExtensionProviders").mockResolvedValue(undefined);
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated());

	const summary = await runDryBalanceCommand(
		{
			model: "grokbot/default",
			flags: { count: 1, concurrency: 1, json: true },
		},
		{
			randomSessionId: () => "session-1",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
		},
	);

	expect(hydrate).toHaveBeenCalledTimes(1);
	expect(loadExtensions).toHaveBeenCalledTimes(1);
	expect(summary.model).toBe("grokbot/default");
	expect(summary.success.total).toBe(1);
});
