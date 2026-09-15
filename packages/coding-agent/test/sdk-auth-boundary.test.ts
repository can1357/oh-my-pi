/**
 * SDK auth-boundary regression: explicit subagent selectors must stay inside
 * their eligible model ladder. An authenticated parent must never become an
 * implicit fallback when an explicit cheap selector is missing or unauthed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const firstCheapSelector = "cheap-one/mimo-v2.5-pro";
const secondCheapSelector = "cheap-two/glm-4.7";
const parentSelector = "expensive-parent/claude-opus-4";

const catalog = {
	providers: {
		"cheap-one": {
			baseUrl: "https://cheap-one.example.invalid/v1",
			api: "openai-completions",
			auth: "oauth",
			models: [
				{
					id: "mimo-v2.5-pro",
					name: "MiMo v2.5 Pro",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
		},
		"cheap-two": {
			baseUrl: "https://cheap-two.example.invalid/v1",
			api: "openai-completions",
			auth: "oauth",
			models: [
				{
					id: "glm-4.7",
					name: "GLM 4.7",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
		},
		"expensive-parent": {
			baseUrl: "https://expensive-parent.example.invalid/v1",
			api: "openai-completions",
			auth: "oauth",
			models: [
				{
					id: "claude-opus-4",
					name: "Claude Opus 4",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 8_192,
				},
			],
		},
	},
};
const parentCatalog = {
	providers: {
		"expensive-parent": catalog.providers["expensive-parent"],
	},
};

describe("SDK auth boundary: explicit modelPattern", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = await TempDir.create("omp-sdk-auth-boundary-");
		authStorage = await AuthStorage.create(":memory:");
		await Bun.write(tempDir.join("models.json"), JSON.stringify(catalog));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		await tempDir.remove();
	});

	async function createSession(options: {
		modelPattern?: string | string[];
		authedProviders: string[];
		defaultModel?: string;
		staleCatalog?: boolean;
	}) {
		for (const provider of options.authedProviders) {
			authStorage.setRuntimeApiKey(provider, `${provider}-test-key`);
		}
		if (options.staleCatalog) {
			await Bun.write(tempDir.join("models.json"), JSON.stringify(parentCatalog));
		}
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.json"));
		if (options.staleCatalog) {
			expect(modelRegistry.find("cheap-one", "mimo-v2.5-pro")).toBeUndefined();
			await Bun.write(tempDir.join("models.json"), JSON.stringify(catalog));
		}
		const settings = Settings.isolated({
			"compaction.enabled": false,
			modelRoles: options.defaultModel ? { default: options.defaultModel } : {},
		});
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings,
			...(options.modelPattern === undefined
				? {}
				: {
						modelPattern: options.modelPattern,
						modelPatternAuthFallback: parentSelector,
					}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "sdk-auth-boundary-test",
		});
		sessions.push(result.session);
		return { ...result, modelRegistry };
	}

	it("returns a specific no-model result for an unknown explicit MiMo selector instead of the authed parent", async () => {
		const unknownSelector = "stale-xiaomi-token-plan-sgp/mimo-v2.5-pro";
		const { session, modelFallbackMessage } = await createSession({
			modelPattern: unknownSelector,
			authedProviders: ["expensive-parent"],
		});

		expect(session.model).toBeUndefined();
		expect(modelFallbackMessage).toBe(`Model "${unknownSelector}" not found`);
	});

	it("keeps a known but unauthenticated explicit cheap model instead of choosing the authed parent", async () => {
		const { session, modelFallbackMessage, modelRegistry } = await createSession({
			modelPattern: firstCheapSelector,
			authedProviders: ["expensive-parent"],
		});

		expect(session.model?.provider).toBe("cheap-one");
		expect(session.model?.id).toBe("mimo-v2.5-pro");
		expect(session.model).not.toBe(modelRegistry.find("expensive-parent", "claude-opus-4"));
		expect(modelRegistry.hasConfiguredAuth(session.model!)).toBe(false);
		expect(modelFallbackMessage).toBeUndefined();
	});

	it("selects an authenticated explicit cheap model exactly", async () => {
		const { session, modelFallbackMessage } = await createSession({
			modelPattern: firstCheapSelector,
			authedProviders: ["cheap-one", "expensive-parent"],
		});

		expect(session.model?.provider).toBe("cheap-one");
		expect(session.model?.id).toBe("mimo-v2.5-pro");
		expect(modelFallbackMessage).toBeUndefined();
	});

	it("refreshes a stale registry to resolve a newly configured explicit cheap model before considering the parent", async () => {
		const { session, modelFallbackMessage } = await createSession({
			modelPattern: firstCheapSelector,
			authedProviders: ["cheap-one", "expensive-parent"],
			staleCatalog: true,
		});

		expect(session.model?.provider).toBe("cheap-one");
		expect(session.model?.id).toBe("mimo-v2.5-pro");
		expect(modelFallbackMessage).toBeUndefined();
	});

	it("selects the second authenticated cheap candidate instead of the authed parent", async () => {
		const { session, modelFallbackMessage } = await createSession({
			modelPattern: [firstCheapSelector, secondCheapSelector],
			authedProviders: ["cheap-two", "expensive-parent"],
		});

		expect(session.model?.provider).toBe("cheap-two");
		expect(session.model?.id).toBe("glm-4.7");
		expect(modelFallbackMessage).toBeUndefined();
	});

	it("retains ordinary parent selection when no explicit model pattern is supplied", async () => {
		const { session, modelFallbackMessage } = await createSession({
			authedProviders: ["expensive-parent"],
			defaultModel: parentSelector,
		});

		expect(session.model?.provider).toBe("expensive-parent");
		expect(session.model?.id).toBe("claude-opus-4");
		expect(modelFallbackMessage).toBeUndefined();
	});
});
