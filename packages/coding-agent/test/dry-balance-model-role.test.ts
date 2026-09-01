import { expect, test } from "bun:test";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	OAuthAccess,
} from "@oh-my-pi/pi-ai";
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

test("dry-balance bench uses Meta minted model keys before and after refresh", async () => {
	const model = fakeModel("meta", "muse-spark-1.2");
	const observedKeys: Array<string | undefined> = [];
	const registry: DryBalanceModelRegistry = {
		authStorage: {
			getOAuthAccess: async () => undefined,
			getOAuthAccesses: async () => [
				{
					ok: true,
					accessToken: "meta-account-token",
					apiKey: "LLM|minted-key",
					credentialId: 7,
					accountId: "meta-account",
				},
			],
			forceRefreshCredentialById: async () =>
				({
					credential: {
						type: "oauth",
						access: "meta-rotated-account-token",
						refresh: "meta-refresh",
						expires: Date.now() + 3_600_000,
						apiKey: "LLM|rotated-minted-key",
						accountId: "meta-account",
					},
				}) as never,
		},
		getAll: () => [model],
		getAvailable: () => [model],
		getApiKey: async () => "unused",
	};
	const message = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 1, output: 1 },
		duration: 1,
		ttft: 1,
	} as unknown as AssistantMessage;

	const summary = await runDryBalanceCommand(
		{
			flags: { model: "meta/muse-spark-1.2", count: 1, concurrency: 1, json: true, bench: true },
		},
		{
			createRuntime: async () => ({ modelRegistry: registry, settings: Settings.isolated() }),
			randomSessionId: () => "session-1",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			streamSimple: (_model, _context, options) => {
				if (!options) throw new Error("expected stream options");
				const events = (async function* () {
					const resolver = options.apiKey as ApiKeyResolver;
					const initial = await resolver({ lastChance: false, error: undefined });
					observedKeys.push(initial);
					observedKeys.push(
						await resolver({
							lastChance: false,
							error: Object.assign(new Error("unauthorized"), { status: 401 }),
							previousKey: initial,
						}),
					);
					yield { type: "done", message } as unknown as AssistantMessageEvent;
				})();
				return Object.assign(events, { result: async () => message }) as unknown as AssistantMessageEventStream;
			},
			now: () => 1,
			stdoutIsTTY: false,
		},
	);

	expect(observedKeys).toEqual(["LLM|minted-key", "LLM|rotated-minted-key"]);
	expect(summary.bench?.success.total).toBe(1);
});
