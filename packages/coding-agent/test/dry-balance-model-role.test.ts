import { expect, test } from "bun:test";
import type { Api, Model, OAuthAccess } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
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
			oauth: {
				access: async () => ({ accessToken: "test-token", email: "test@example.com" }) as unknown as OAuthAccess,
			},
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

test("dry-balance samples leave no session pins in the credential store", async () => {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	try {
		const authStorage = new AuthStorage(store);
		const account = (name: string) => ({
			type: "oauth" as const,
			access: `access-${name}`,
			refresh: `refresh-${name}`,
			expires: Date.now() + 60 * 60_000,
			email: `${name}@example.com`,
		});
		await authStorage.credentials.set("acme", [account("a"), account("b")]);
		const model = fakeModel("acme", "balance-model");
		const registry: DryBalanceModelRegistry = {
			authStorage,
			getAll: () => [model],
			getAvailable: () => [model],
			getApiKey: async () => undefined,
		};
		const sessionIds = ["sample-1", "sample-2", "sample-3"];
		let next = 0;

		const summary = await runDryBalanceCommand(
			{ model: "acme/balance-model", flags: { count: sessionIds.length, concurrency: 1, json: true } },
			{
				createRuntime: async () => ({ modelRegistry: registry, settings: Settings.isolated() }),
				randomSessionId: () => sessionIds[next++] ?? "unexpected-sample",
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
			},
		);

		expect(summary.success.total).toBe(sessionIds.length);
		// A later omp process reads pins from the store; the samples must not have left any.
		const laterProcess = new AuthStorage(store);
		await laterProcess.credentials.reload();
		for (const sessionId of sessionIds) {
			expect(laterProcess.oauth.accounts("acme", sessionId).some(stored => stored.active)).toBe(false);
		}
	} finally {
		store.close();
	}
});
