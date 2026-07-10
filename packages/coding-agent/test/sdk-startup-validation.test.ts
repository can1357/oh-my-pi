import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, type ExtensionFactory } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const runtimeProviderExtension: ExtensionFactory = api => {
	api.registerProvider("runtime-provider", {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "RUNTIME_PROVIDER_KEY",
		api: "openai-completions",
		models: [
			{
				id: "runtime-model",
				name: "Runtime Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8192,
			},
		],
	});
};

describe("SDK spawn selector startup validation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-sdk-spawn-validation-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function sessionOptions(settingsManager: Settings | Promise<Settings>): CreateAgentSessionOptions {
		return {
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skipPythonPreflight: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		};
	}

	it("validates the resolved settings structurally and preserves aggregated malformed-policy diagnostics", async () => {
		const mergedSettings = Promise.resolve(
			Settings.isolated({
				"subagent.modelAliases": {
					"mini-max": "provider/a",
					minimax: "provider/b",
				},
				"task.agentPolicies": {
					task: {
						tier: "ultra",
						modelPool: [""],
					},
				},
				"fusion.modelPool": [""],
			}),
		);

		const startup = createAgentSession(sessionOptions(mergedSettings));

		await expect(startup).rejects.toThrow("Spawn selector structural validation failed:");
		await expect(startup).rejects.toThrow("[normalized-collision]");
		await expect(startup).rejects.toThrow("[malformed-profile] task.agentPolicies.task.tier");
		await expect(startup).rejects.toThrow("[malformed-pool] task.agentPolicies.task.modelPool[0]");
		await expect(startup).rejects.toThrow("[malformed-pool] modelPools.fusion.modelPool[0]");
	});

	it("runs semantic validation after inline extension providers are registered", async () => {
		authStorage.setRuntimeApiKey("runtime-provider", "test-key");
		const settings = Settings.isolated({
			"task.agentPolicies": {
				task: { modelPool: ["runtime-provider/runtime-model"] },
			},
			"fusion.modelPool": ["1=runtime-provider/runtime-model"],
			"fusion.enabled": true,
			"fusion.sidekickModel": "runtime-provider/runtime-model",
			"fusion.sidekickStrongModel": "runtime-provider/runtime-model",
			"fusion.compactModel": "runtime-provider/runtime-model",
		});

		const created = await createAgentSession({
			...sessionOptions(settings),
			extensions: [runtimeProviderExtension],
		});

		expect(created.session).toBeDefined();
		expect(modelRegistry.find("runtime-provider", "runtime-model")).toBeDefined();
	});

	it("does not require configured Fusion pool selectors while Fusion is disabled", async () => {
		authStorage.setRuntimeApiKey("runtime-provider", "test-key");
		const settings = Settings.isolated({
			"task.agentPolicies": {
				task: { modelPool: ["runtime-provider/runtime-model"] },
			},
			"fusion.enabled": false,
			"fusion.modelPool": ["1=missing-fusion/model"],
		});

		const created = await createAgentSession({
			...sessionOptions(settings),
			extensions: [runtimeProviderExtension],
		});

		expect(created.session).toBeDefined();
	});

	it("fails closed with aggregated semantic diagnostics for required task and Fusion lanes", async () => {
		const settings = Settings.isolated({
			"task.agentPolicies": {
				task: { modelPool: ["missing-task/model"] },
			},
			"fusion.modelPool": ["1=missing-fusion/model"],
			"fusion.enabled": true,
		});

		const startup = createAgentSession(sessionOptions(settings));

		await expect(startup).rejects.toThrow("Spawn selector semantic validation failed:");
		await expect(startup).rejects.toThrow("[unresolved-selector] missing-task/model");
		await expect(startup).rejects.toThrow("[unresolved-selector] missing-fusion/model");
	});
});
