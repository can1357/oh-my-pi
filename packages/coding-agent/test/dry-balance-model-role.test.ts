import { expect, test } from "bun:test";
import { type Api, type FetchImpl, type Model, type OAuthAccess, streamSimple } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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
				accessAll: async () => [],
				accessById: async () => undefined,
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

test("dry-balance --bench retries a 401 with the same account's refreshed API key", async () => {
	const model = buildModel({
		provider: "acme",
		id: "balance-model",
		name: "balance-model",
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 4096,
		contextWindow: 128_000,
	});
	// A structured-credential provider: the bearer it sends is not the raw access token.
	const resolution = (stage: string) => ({
		ok: true as const,
		credentialId: 7,
		email: "a@example.com",
		accessToken: `${stage}-access`,
		apiKey: `${stage}-key`,
	});
	const refreshCalls: Array<{ credentialId: number; forceRefresh?: boolean }> = [];
	const registry: DryBalanceModelRegistry = {
		authStorage: {
			oauth: {
				access: async () => undefined,
				accessAll: async () => [resolution("initial")],
				accessById: async (_provider, credentialId, options) => {
					refreshCalls.push({ credentialId, forceRefresh: options?.forceRefresh });
					return resolution("refreshed");
				},
			},
		},
		getAll: () => [model],
		getAvailable: () => [model],
		getApiKey: async () => undefined,
	};
	const bearers: Array<string | undefined> = [];
	const fetch: FetchImpl = async (_url, init) => {
		const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization;
		bearers.push(bearer);
		if (bearer !== "Bearer refreshed-key") {
			return Response.json({ error: { message: "invalid api key", type: "authentication_error" } }, { status: 401 });
		}
		const chunks = [
			{ id: "cmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" } }] },
			{ id: "cmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
		return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	};

	const summary = await runDryBalanceCommand(
		{ model: "acme/balance-model", flags: { bench: true, json: true } },
		{
			createRuntime: async () => ({ modelRegistry: registry, settings: Settings.isolated() }),
			streamSimple: (streamModel, context, options) => streamSimple(streamModel, context, { ...options, fetch }),
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			stderrIsTTY: false,
		},
	);

	expect(bearers).toEqual(["Bearer initial-key", "Bearer refreshed-key"]);
	expect(refreshCalls).toEqual([{ credentialId: 7, forceRefresh: true }]);
	expect(summary.bench?.success.total).toBe(1);
});
